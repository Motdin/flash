import assert from 'node:assert/strict';
import test from 'node:test';
import { evmChains } from '../config/chains.js';
import type { ChainOpportunityReport } from '../morpho/dex-scanner.js';
import { computeDynamicPriorityFee, estimateExecutionNetProfitAfterGas } from './executor.js';
import { buildWhitelistCooldownKey } from './cooldown.js';
import {
  evaluateDeterministically,
  evaluateWithLlmOperator,
  isActionAllowedByMode,
  isFlashloanExecutionRequested,
  loadLlmOperatorConfig,
} from './llm-operator.js';

const baseChain = evmChains.find((c) => c.key === 'base')!;

function createMockReport(overrides?: Partial<ChainOpportunityReport>): ChainOpportunityReport {
  return {
    chain: baseChain,
    blockNumber: 50_000_000n,
    gasPriceWei: 100_000_000n, // 0.1 gwei
    gasPriceGwei: '0.1',
    nativePriceUsd: 2500,
    flashExecutor: '0x806f94258AA421b5c282B7A043149396d7c9A9D1',
    flashExecutorOwner: '0x1111111111111111111111111111111111111111',
    flashExecutorPaused: false,
    tokenWhitelists: [],
    routerWhitelists: [],
    whitelistedAssets: [],
    pendingWhitelistAssets: [],
    pendingWhitelistRouters: [],
    arbitrageCandidates: [],
    profitableCandidates: [],
    liquidationCandidates: [],
    profitableLiquidations: [],
    warnings: [],
    ...overrides,
  };
}

test('isActionAllowedByMode enforces mode boundaries including liquidation', () => {
  assert.equal(isActionAllowedByMode('EXECUTE_ARBITRAGE', 'whitelist-only'), false);
  assert.equal(isActionAllowedByMode('SYNC_WHITELIST', 'whitelist-only'), true);
  assert.equal(isActionAllowedByMode('EXECUTE_ARBITRAGE', 'arbitrage'), true);
  assert.equal(isActionAllowedByMode('EXECUTE_LIQUIDATION', 'liquidation'), true);
  assert.equal(isActionAllowedByMode('EXECUTE_FLASHLOAN', 'arbitrage'), false);
  assert.equal(isActionAllowedByMode('EXECUTE_ARBITRAGE', 'full'), true);
  assert.equal(isActionAllowedByMode('EXECUTE_LIQUIDATION', 'full'), true);
  assert.equal(isActionAllowedByMode('EXECUTE_FLASHLOAN', 'full'), true);
});

test('evaluateDeterministically holds when gas exceeds MAX_GAS_GWEI', () => {
  const report = createMockReport({
    gasPriceGwei: '120.5',
  });
  const config = loadLlmOperatorConfig({ mode: 'full', maxGasGwei: 50 });
  const decision = evaluateDeterministically(report, config);
  assert.equal(decision.action, 'HOLD');
  assert.equal(decision.riskAssessment.level, 'HIGH');
});

test('evaluateWithLlmOperator uses fast-path immediately when profitable arbitrage is found', async () => {
  const profitableCandidate = {
    id: 'base:USDC->WETH@Uniswap V3->Aerodrome($10000)',
    chain: 'base',
    loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
    loanSymbol: 'USDC',
    loanDecimals: 6,
    intermediateToken: '0x4200000000000000000000000000000000000006' as const,
    intermediateSymbol: 'WETH',
    intermediateDecimals: 18,
    firstRouter: '0x2626664c2603336E57B271c5C0b26F421741e481' as const,
    firstRouterName: 'Uniswap V3 (Base 5bps)',
    firstRouterKind: 2 as const,
    firstRouterFee: 500,
    firstRouterStable: false,
    firstRouterFactory: '0x0000000000000000000000000000000000000000' as const,
    secondRouter: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43' as const,
    secondRouterName: 'Aerodrome Volatile',
    secondRouterKind: 3 as const,
    secondRouterFee: 0,
    secondRouterStable: false,
    secondRouterFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as const,
    loanAmount: 10_000_000_000n,
    formattedLoanAmount: '10000',
    loanAmountUsd: 10_000,
    expectedIntermediateOut: 4n * 10n ** 18n,
    formattedIntermediateOut: '4',
    expectedFinalOut: 10_025_000_000n,
    formattedFinalOut: '10025',
    grossProfit: 25_000_000n,
    formattedGrossProfit: '25',
    grossProfitUsd: 25,
    estimatedGasCostUsd: 0.05,
    netProfitUsd: 24.95,
    spreadBps: 25,
    minIntermediateAmount: 3988000000000000000n,
    minFinalAmount: 10_010_000_000n,
    minProfit: 10_000_000n,
    profitable: true,
    tokensWhitelistedOnArb: true,
    routersWhitelistedOnArb: true,
    readyToExecute: true,
  };

  const report = createMockReport({
    arbitrageCandidates: [profitableCandidate],
    profitableCandidates: [profitableCandidate],
  });
  const config = loadLlmOperatorConfig({
    mode: 'full',
    minProfitUsd: 5,
    fastPathEnabled: true,
  });
  const decision = await evaluateWithLlmOperator(report, config);
  assert.equal(decision.action, 'EXECUTE_ARBITRAGE');
  assert.equal(decision.source, 'fast-path');
  assert.equal(decision.arbitragePlan?.firstRouterKind, 2);
  assert.equal(decision.arbitragePlan?.secondRouterKind, 3);
});

test('evaluateDeterministically selects SYNC_WHITELIST when pending whitelist tokens exist', () => {
  const pendingAsset = {
    symbol: 'cbBTC',
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as const,
    decimals: 8,
    usdValue: 500_000,
    priceUsd: 65_000,
    balance: 1_000_000_000n,
    formattedBalance: '10',
    allowedOnFlashExecutor: false,
    allowedOnArbExecutor: false,
    matchesPolicyTarget: true,
    needsFlashWhitelist: true,
    needsArbWhitelist: false,
  };

  const report = createMockReport({
    pendingWhitelistAssets: [pendingAsset],
  });
  const config = loadLlmOperatorConfig({ mode: 'full', whitelistAutoSync: true });
  const decision = evaluateDeterministically(report, config);
  assert.equal(decision.action, 'SYNC_WHITELIST');
  assert.equal(decision.whitelistPlan?.tokensToAllow.length, 1);
  assert.equal(decision.whitelistPlan?.tokensToAllow[0].symbol, 'cbBTC');
});

const pendingWhitelistAsset = {
  symbol: 'cbBTC',
  address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as const,
  decimals: 8,
  usdValue: 500_000,
  priceUsd: 65_000,
  balance: 1_000_000_000n,
  formattedBalance: '10',
  allowedOnFlashExecutor: false,
  allowedOnArbExecutor: false,
  matchesPolicyTarget: true,
  needsFlashWhitelist: true,
  needsArbWhitelist: false,
};

function stubLlmResponse(payload: Record<string, unknown>): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('Policy Guard overrides an LLM SYNC_WHITELIST choice when WHITELIST_AUTO_SYNC=false', async () => {
  const report = createMockReport({ pendingWhitelistAssets: [pendingWhitelistAsset] });
  const config = loadLlmOperatorConfig({
    mode: 'full',
    whitelistAutoSync: false,
    fastPathEnabled: false,
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: undefined,
  });

  const restoreFetch = stubLlmResponse({
    action: 'SYNC_WHITELIST',
    confidence: 0.95,
    reasoning: 'Sinkronkan allowlist sekarang',
  });

  try {
    const decision = await evaluateWithLlmOperator(report, config);
    assert.equal(decision.action, 'HOLD', 'operator-disabled allowlist sync must never broadcast');
    assert.match(decision.reasoning, /Policy Guard/);
  } finally {
    restoreFetch();
  }
});

test('LLM SYNC_WHITELIST is honoured when WHITELIST_AUTO_SYNC=true', async () => {
  const report = createMockReport({ pendingWhitelistAssets: [pendingWhitelistAsset] });
  const config = loadLlmOperatorConfig({
    mode: 'full',
    whitelistAutoSync: true,
    fastPathEnabled: false,
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: undefined,
  });

  const restoreFetch = stubLlmResponse({
    action: 'SYNC_WHITELIST',
    confidence: 0.95,
    reasoning: 'Sinkronkan allowlist sekarang',
  });

  try {
    const decision = await evaluateWithLlmOperator(report, config);
    assert.equal(decision.action, 'SYNC_WHITELIST');
    assert.equal(decision.whitelistPlan?.tokensToAllow[0]?.symbol, 'cbBTC');
  } finally {
    restoreFetch();
  }
});

test('isFlashloanExecutionRequested requires an explicit opt-in, not just mode=full', () => {
  assert.equal(isFlashloanExecutionRequested('full', false), false, 'mode=full alone must not enable flashloans');
  assert.equal(isFlashloanExecutionRequested('full', true), true);
  assert.equal(isFlashloanExecutionRequested('flashloan', false), true);
  assert.equal(isFlashloanExecutionRequested('arbitrage', false), false);
  assert.equal(isFlashloanExecutionRequested('liquidation', true), true);
});

test('Policy Guard overrides an LLM EXECUTE_FLASHLOAN choice when flashloans are not enabled', async () => {
  const flashAsset = {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
    decimals: 6,
    usdValue: 250_000,
    priceUsd: 1,
    balance: 250_000_000_000n,
    formattedBalance: '250000',
    allowedOnFlashExecutor: true,
    allowedOnArbExecutor: true,
    matchesPolicyTarget: true,
    needsFlashWhitelist: false,
    needsArbWhitelist: false,
  };
  const report = createMockReport({ whitelistedAssets: [flashAsset] });
  const config = loadLlmOperatorConfig({
    mode: 'full',
    flashloanOnWhitelist: false,
    fastPathEnabled: false,
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: undefined,
  });

  const restoreFetch = stubLlmResponse({
    action: 'EXECUTE_FLASHLOAN',
    confidence: 0.9,
    reasoning: 'Pinjam USDC untuk menguji eksekutor',
    flashloanSymbol: 'USDC',
  });

  try {
    const decision = await evaluateWithLlmOperator(report, config);
    assert.equal(decision.action, 'HOLD', 'flashloans disabled by operator must never broadcast');
    assert.match(decision.reasoning, /Policy Guard/);
    assert.equal(decision.flashloanPlan, undefined);
  } finally {
    restoreFetch();
  }
});

test('LLM cannot execute an arbitrage candidate that is still on cooldown', async () => {
  const candidate = {
    id: 'arb-cooldown',
    loanSymbol: 'USDC',
    intermediateSymbol: 'WETH',
    firstRouterName: 'Router A',
    secondRouterName: 'Router B',
    loanAmountUsd: 1_000,
    spreadBps: 25,
    grossProfitUsd: 10,
    estimatedGasCostUsd: 1,
    netProfitUsd: 9,
    profitable: true,
    readyToExecute: true,
  } as unknown as ChainOpportunityReport['profitableCandidates'][number];
  const report = createMockReport({
    arbitrageCandidates: [candidate],
    profitableCandidates: [candidate],
  });
  const config = loadLlmOperatorConfig({
    mode: 'arbitrage',
    minProfitUsd: 5,
    fastPathEnabled: false,
    baseUrl: 'http://127.0.0.1:9/v1',
  });
  const cooldowns = new Map<string, number>([['arb:arb-cooldown', Date.now() + 60_000]]);
  const restoreFetch = stubLlmResponse({
    action: 'EXECUTE_ARBITRAGE',
    candidateId: 'arb-cooldown',
    confidence: 0.95,
    reasoning: 'Jalankan kandidat yang terlihat menguntungkan',
  });

  try {
    const decision = await evaluateWithLlmOperator(report, config, cooldowns);
    assert.equal(decision.action, 'HOLD');
    assert.match(decision.reasoning, /bebas cooldown/);
  } finally {
    restoreFetch();
  }
});

test('LLM cannot execute a liquidation candidate that is still on cooldown', async () => {
  const candidate = {
    id: 'liq-cooldown',
    borrower: '0x1111111111111111111111111111111111111111',
    healthFactor: 0.99,
    marketParams: { loanSymbol: 'USDC', collateralSymbol: 'WETH' },
    repaidUsd: 1_000,
    netProfitUsd: 25,
    profitable: true,
  } as unknown as NonNullable<ChainOpportunityReport['profitableLiquidations']>[number];
  const report = createMockReport({
    liquidationCandidates: [candidate],
    profitableLiquidations: [candidate],
  });
  const config = loadLlmOperatorConfig({
    mode: 'liquidation',
    minProfitUsd: 5,
    fastPathEnabled: false,
    baseUrl: 'http://127.0.0.1:9/v1',
  });
  const cooldowns = new Map<string, number>([['liq:liq-cooldown', Date.now() + 60_000]]);
  const restoreFetch = stubLlmResponse({
    action: 'EXECUTE_LIQUIDATION',
    candidateId: 'liq-cooldown',
    confidence: 0.95,
    reasoning: 'Jalankan kandidat likuidasi',
  });

  try {
    const decision = await evaluateWithLlmOperator(report, config, cooldowns);
    assert.equal(decision.action, 'HOLD');
    assert.match(decision.reasoning, /bebas cooldown/);
  } finally {
    restoreFetch();
  }
});

test('LLM cannot repeat a whitelist sync while the same targets are on cooldown', async () => {
  const report = createMockReport({ pendingWhitelistAssets: [pendingWhitelistAsset] });
  const config = loadLlmOperatorConfig({
    mode: 'full',
    whitelistAutoSync: true,
    fastPathEnabled: false,
    baseUrl: 'http://127.0.0.1:9/v1',
  });
  const key = buildWhitelistCooldownKey(
    'base',
    [{ address: pendingWhitelistAsset.address, target: 'flash' }],
    [],
  );
  const cooldowns = new Map<string, number>([[key, Date.now() + 60_000]]);
  const restoreFetch = stubLlmResponse({
    action: 'SYNC_WHITELIST',
    confidence: 0.95,
    reasoning: 'Sinkronkan token kembali',
  });

  try {
    const decision = await evaluateWithLlmOperator(report, config, cooldowns);
    assert.equal(decision.action, 'HOLD');
    assert.match(decision.reasoning, /masih dalam cooldown/);
  } finally {
    restoreFetch();
  }
});

test('LLM cannot trigger a flashloan for an asset on cooldown', async () => {
  const flashAsset = {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
    decimals: 6,
    usdValue: 250_000,
    priceUsd: 1,
    balance: 250_000_000_000n,
    formattedBalance: '250000',
    allowedOnFlashExecutor: true,
    allowedOnArbExecutor: true,
    matchesPolicyTarget: true,
    needsFlashWhitelist: false,
    needsArbWhitelist: false,
  };
  const report = createMockReport({ whitelistedAssets: [flashAsset] });
  const config = loadLlmOperatorConfig({
    mode: 'flashloan',
    flashloanOnWhitelist: true,
    fastPathEnabled: false,
    baseUrl: 'http://127.0.0.1:9/v1',
  });
  const cooldowns = new Map<string, number>([
    [`flashloan:base:${flashAsset.symbol}`, Date.now() + 60_000],
  ]);
  const restoreFetch = stubLlmResponse({
    action: 'EXECUTE_FLASHLOAN',
    flashloanSymbol: 'USDC',
    confidence: 0.9,
    reasoning: 'Flashloan testing',
  });

  try {
    const decision = await evaluateWithLlmOperator(report, config, cooldowns);
    assert.equal(decision.action, 'HOLD');
    assert.equal(decision.flashloanPlan, undefined);
  } finally {
    restoreFetch();
  }
});

test('computeDynamicPriorityFee allocates profit bribe while respecting cap', () => {
  const fee = computeDynamicPriorityFee({
    baseGasPriceWei: 1_000_000_000n, // 1 gwei
    estimatedGasUnits: 280_000n,
    nativePriceUsd: 2500,
    expectedGrossProfitUsd: 50,
    minProfitUsd: 10,
    profitBribeBps: 2000, // 20% of surplus
    maxPriorityFeeGwei: 15,
  });

  assert.ok(fee.maxPriorityFeePerGas > 10_000_000n);
  assert.ok(fee.maxFeePerGas > fee.maxPriorityFeePerGas);
});


test('live execution gas guard rejects a quote whose net profit falls below the configured minimum', () => {
  assert.throws(
    () => estimateExecutionNetProfitAfterGas({
      expectedGrossProfitUsd: 50,
      minimumProfitUsd: 5,
      maxFeePerGas: 202_000_000_000n,
      estimatedGasUnits: 280_000n,
      nativePriceUsd: 2_500,
    }),
    /Net-profit guard/,
  );

  const safe = estimateExecutionNetProfitAfterGas({
    expectedGrossProfitUsd: 500,
    minimumProfitUsd: 5,
    maxFeePerGas: 202_000_000_000n,
    estimatedGasUnits: 280_000n,
    nativePriceUsd: 2_500,
  });
  assert.ok(safe.estimatedNetProfitUsd >= 5);
  assert.ok(safe.gasCostUsd > 80, 'cost includes a 20% gas estimate margin');
});
