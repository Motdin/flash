import assert from 'node:assert/strict';
import test from 'node:test';
import { evmChains } from '../config/chains.js';
import type { ChainOpportunityReport } from '../morpho/dex-scanner.js';
import { computeDynamicPriorityFee } from './executor.js';
import {
  evaluateDeterministically,
  evaluateWithLlmOperator,
  isActionAllowedByMode,
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
