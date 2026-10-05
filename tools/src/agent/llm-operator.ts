import { buildWhitelistCooldownKey } from './cooldown.js';
import { parseUnits } from 'viem';
import type { RouterKindId } from '../config/dex-routers.js';
import type { Address } from '../config/registry.js';
import type {
  ArbitrageCandidate,
  ChainOpportunityReport,
  RouterWhitelistState,
  SwapHopStepQuote,
  TokenWhitelistState,
} from '../morpho/dex-scanner.js';
import type { LiquidationCandidate } from '../morpho/liquidation-scanner.js';

export type OperatorMode =
  | 'dry-run'
  | 'whitelist-only'
  | 'flashloan'
  | 'arbitrage'
  | 'liquidation'
  | 'full';

export type OperatorActionType =
  | 'HOLD'
  | 'SYNC_WHITELIST'
  | 'EXECUTE_ARBITRAGE'
  | 'EXECUTE_LIQUIDATION'
  | 'EXECUTE_FLASHLOAN';

export type WhitelistExecutionPlan = {
  tokensToAllow: Array<{ symbol: string; address: Address; target: 'flash' | 'arb' | 'both' }>;
  routersToAllow: Array<{ name: string; address: Address }>;
};

export type ArbitrageExecutionPlan = {
  candidateId: string;
  loanToken: Address;
  loanSymbol: string;
  loanDecimals: number;
  intermediateToken: Address;
  intermediateSymbol: string;
  firstRouter: Address;
  firstRouterName: string;
  firstRouterKind: RouterKindId;
  firstRouterFee: number;
  firstRouterStable: boolean;
  firstRouterFactory: Address;
  secondRouter: Address;
  secondRouterName: string;
  secondRouterKind: RouterKindId;
  secondRouterFee: number;
  secondRouterStable: boolean;
  secondRouterFactory: Address;
  steps?: SwapHopStepQuote[];
  isMultiHop?: boolean;
  optimalContinuousLoanUsd?: number;
  loanAmount: bigint;
  formattedLoanAmount: string;
  minIntermediateAmount: bigint;
  minFinalAmount: bigint;
  minProfit: bigint;
  expectedGrossProfitUsd: number;
  expectedNetProfitUsd: number;
  spreadBps: number;
  deadlineSeconds: number;
  autoAllowlistBeforeExec: boolean;
};

export type LiquidationExecutionPlan = {
  candidateId: string;
  marketId: `0x${string}`;
  loanToken: Address;
  loanSymbol: string;
  loanDecimals: number;
  collateralToken: Address;
  collateralSymbol: string;
  oracle: Address;
  irm: Address;
  lltv: bigint;
  borrower: Address;
  healthFactor: number;
  seizedAssets: bigint;
  formattedSeizedAssets: string;
  repaidAssets: bigint;
  formattedRepaidAssets: string;
  swapRouter: Address;
  swapRouterName: string;
  swapRouterKind: RouterKindId;
  swapRouterFee: number;
  swapRouterStable: boolean;
  swapRouterFactory: Address;
  minLoanTokenOut: bigint;
  minProfit: bigint;
  expectedGrossProfitUsd: number;
  expectedNetProfitUsd: number;
  deadlineSeconds: number;
};

export type FlashloanExecutionPlan = {
  token: Address;
  symbol: string;
  decimals: number;
  amount: bigint;
  formattedAmount: string;
  usdValue: number;
  reason: string;
};

export type OperatorDecision = {
  action: OperatorActionType;
  confidence: number;
  reasoning: string;
  chain: string;
  blockNumber: string;
  whitelistPlan?: WhitelistExecutionPlan;
  arbitragePlan?: ArbitrageExecutionPlan;
  liquidationPlan?: LiquidationExecutionPlan;
  flashloanPlan?: FlashloanExecutionPlan;
  riskAssessment: {
    level: 'LOW' | 'MEDIUM' | 'HIGH';
    checksPassed: string[];
    warnings: string[];
  };
  source: 'llm' | 'fast-path' | 'deterministic-fallback';
  model: string;
  latencyMs: number;
  timestamp: string;
};

export type LlmOperatorConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  fallbackDeterministic: boolean;
  fastPathEnabled: boolean;
  mode: OperatorMode;
  autoBroadcast: boolean;
  whitelistAutoSync: boolean;
  flashloanOnWhitelist: boolean;
  flashloanTriggerUsd: number;
  minProfitUsd: number;
  maxGasGwei: number;
  profitBribeBps: number;
  maxPriorityFeeGwei: number;
  deadlineSeconds: number;
};

export function loadLlmOperatorConfig(overrides?: Partial<LlmOperatorConfig>): LlmOperatorConfig {
  const rawMode = (overrides?.mode ?? process.env.OPERATOR_MODE ?? 'dry-run').toLowerCase() as OperatorMode;
  const validModes: OperatorMode[] = [
    'dry-run',
    'whitelist-only',
    'flashloan',
    'arbitrage',
    'liquidation',
    'full',
  ];
  const mode: OperatorMode = validModes.includes(rawMode) ? rawMode : 'dry-run';

  return {
    baseUrl: (overrides?.baseUrl ?? process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: overrides?.apiKey ?? process.env.LLM_API_KEY,
    model: overrides?.model ?? process.env.LLM_MODEL ?? 'gpt-4o-mini',
    temperature: overrides?.temperature ?? Number(process.env.LLM_TEMPERATURE ?? '0.1'),
    timeoutMs: overrides?.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? '25000'),
    fallbackDeterministic:
      overrides?.fallbackDeterministic ??
      (process.env.LLM_FALLBACK_DETERMINISTIC !== 'false'),
    fastPathEnabled:
      overrides?.fastPathEnabled ??
      (process.env.FAST_PATH_ENABLED !== 'false'),
    mode,
    autoBroadcast:
      overrides?.autoBroadcast ??
      (process.env.AUTO_BROADCAST === 'true'),
    whitelistAutoSync:
      overrides?.whitelistAutoSync ??
      (process.env.WHITELIST_AUTO_SYNC !== 'false'),
    flashloanOnWhitelist:
      overrides?.flashloanOnWhitelist ??
      (process.env.FLASHLOAN_ON_WHITELIST === 'true'),
    flashloanTriggerUsd:
      overrides?.flashloanTriggerUsd ??
      Number(process.env.FLASHLOAN_TRIGGER_USD ?? '10000'),
    minProfitUsd:
      overrides?.minProfitUsd ??
      Number(process.env.MIN_PROFIT_USD ?? '5'),
    maxGasGwei:
      overrides?.maxGasGwei ??
      Number(process.env.MAX_GAS_GWEI ?? '50'),
    profitBribeBps:
      overrides?.profitBribeBps ??
      Number(process.env.PROFIT_BRIBE_BPS ?? '1500'),
    maxPriorityFeeGwei:
      overrides?.maxPriorityFeeGwei ??
      Number(process.env.MAX_PRIORITY_FEE_GWEI ?? '15'),
    deadlineSeconds:
      overrides?.deadlineSeconds ??
      Number(process.env.ARB_DEADLINE_SEC ?? '120'),
  };
}

/**
 * Whether the operator has explicitly opted into flashloan execution.
 *
 * Flashloans move no arbitrage profit on their own: they exist to exercise the
 * `FlashLoanExecutor` contract. Enabling them requires either `FLASHLOAN_ON_WHITELIST=true`
 * or `OPERATOR_MODE=flashloan`; `mode='full'` alone must NOT be enough, otherwise a model
 * that ignores the system prompt could trigger a flashloan the operator never enabled.
 */
export function isFlashloanExecutionRequested(
  mode: OperatorMode,
  flashloanOnWhitelist: boolean,
): boolean {
  return flashloanOnWhitelist || mode === 'flashloan';
}

export function isActionAllowedByMode(action: OperatorActionType, mode: OperatorMode): boolean {
  if (action === 'HOLD') return true;
  if (mode === 'dry-run' || mode === 'full') return true;
  if (mode === 'whitelist-only') return action === 'SYNC_WHITELIST';
  if (mode === 'flashloan') return action === 'SYNC_WHITELIST' || action === 'EXECUTE_FLASHLOAN';
  if (mode === 'arbitrage') return action === 'SYNC_WHITELIST' || action === 'EXECUTE_ARBITRAGE';
  if (mode === 'liquidation') return action === 'SYNC_WHITELIST' || action === 'EXECUTE_LIQUIDATION';
  return false;
}

function buildWhitelistPlan(
  pendingTokens: TokenWhitelistState[],
  pendingRouters: RouterWhitelistState[],
): WhitelistExecutionPlan {
  return {
    tokensToAllow: pendingTokens.slice(0, 10).map((t) => ({
      symbol: t.symbol,
      address: t.address,
      target:
        t.needsFlashWhitelist && t.needsArbWhitelist
          ? 'both'
          : t.needsArbWhitelist
            ? 'arb'
            : 'flash',
    })),
    routersToAllow: pendingRouters.slice(0, 10).map((r) => ({
      name: r.name,
      address: r.address,
    })),
  };
}

export function canExecuteArbitrageCandidate(
  report: ChainOpportunityReport, config: LlmOperatorConfig, candidate: ArbitrageCandidate,
): boolean {
  // Synchronization is its own policy-controlled action. Never spend allowlist gas
  // inside a time-sensitive trade or trade a snapshot taken before synchronization.
  return !report.arbExecutorPaused && candidate.tokensWhitelistedOnArb && candidate.routersWhitelistedOnArb;
}

export function buildArbitragePlan(
  candidate: ArbitrageCandidate,
  deadlineSeconds: number,
): ArbitrageExecutionPlan {
  return {
    candidateId: candidate.id,
    loanToken: candidate.loanToken,
    loanSymbol: candidate.loanSymbol,
    loanDecimals: candidate.loanDecimals,
    intermediateToken: candidate.intermediateToken,
    intermediateSymbol: candidate.intermediateSymbol,
    firstRouter: candidate.firstRouter,
    firstRouterName: candidate.firstRouterName,
    firstRouterKind: candidate.firstRouterKind,
    firstRouterFee: candidate.firstRouterFee,
    firstRouterStable: candidate.firstRouterStable,
    firstRouterFactory: candidate.firstRouterFactory,
    secondRouter: candidate.secondRouter,
    secondRouterName: candidate.secondRouterName,
    secondRouterKind: candidate.secondRouterKind,
    secondRouterFee: candidate.secondRouterFee,
    secondRouterStable: candidate.secondRouterStable,
    secondRouterFactory: candidate.secondRouterFactory,
    steps: candidate.steps,
    isMultiHop: candidate.isMultiHop,
    optimalContinuousLoanUsd: candidate.optimalContinuousLoanUsd,
    loanAmount: candidate.loanAmount,
    formattedLoanAmount: candidate.formattedLoanAmount,
    minIntermediateAmount: candidate.minIntermediateAmount,
    minFinalAmount: candidate.minFinalAmount,
    minProfit: candidate.minProfit,
    expectedGrossProfitUsd: candidate.grossProfitUsd,
    expectedNetProfitUsd: candidate.netProfitUsd,
    spreadBps: candidate.spreadBps,
    deadlineSeconds,
    autoAllowlistBeforeExec: !candidate.tokensWhitelistedOnArb || !candidate.routersWhitelistedOnArb,
  };
}

export function buildLiquidationPlan(
  candidate: LiquidationCandidate,
  deadlineSeconds: number,
): LiquidationExecutionPlan {
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;
  return {
    candidateId: candidate.id,
    marketId: candidate.marketParams.marketId,
    loanToken: candidate.marketParams.loanToken,
    loanSymbol: candidate.marketParams.loanSymbol,
    loanDecimals: candidate.marketParams.loanDecimals,
    collateralToken: candidate.marketParams.collateralToken,
    collateralSymbol: candidate.marketParams.collateralSymbol,
    oracle: candidate.marketParams.oracle,
    irm: candidate.marketParams.irm,
    lltv: candidate.marketParams.lltv,
    borrower: candidate.borrower,
    healthFactor: candidate.healthFactor,
    seizedAssets: candidate.seizedAssets,
    formattedSeizedAssets: candidate.formattedSeizedAssets,
    repaidAssets: candidate.repaidAssets,
    formattedRepaidAssets: candidate.formattedRepaidAssets,
    swapRouter: candidate.swapRouter.address,
    swapRouterName: candidate.swapRouter.name,
    swapRouterKind: candidate.swapRouter.kind ?? 0,
    swapRouterFee: candidate.swapRouter.v3FeeTier ?? 0,
    swapRouterStable: Boolean(candidate.swapRouter.aeroStable),
    swapRouterFactory: candidate.swapRouter.factoryAddress ?? ZERO_ADDR,
    minLoanTokenOut: candidate.minLoanTokenOut,
    minProfit: candidate.minProfit,
    expectedGrossProfitUsd: candidate.grossProfitUsd,
    expectedNetProfitUsd: candidate.netProfitUsd,
    deadlineSeconds,
  };
}

function buildFlashloanPlan(
  asset: TokenWhitelistState,
  targetUsd: number,
  reason: string,
): FlashloanExecutionPlan | undefined {
  if (asset.balance <= 0n) return undefined;
  let amount = asset.balance;
  if (asset.priceUsd && asset.priceUsd > 0 && targetUsd > 0) {
    const tokens = targetUsd / asset.priceUsd;
    const precision = Math.min(asset.decimals, 8);
    const formatted = tokens.toFixed(precision) || '1';
    try {
      const parsed = parseUnits(formatted, asset.decimals);
      if (parsed > 0n && parsed <= asset.balance) {
        amount = parsed;
      }
    } catch {
      amount = asset.balance;
    }
  }
  const numericAmount = Number(amount) / 10 ** asset.decimals;
  const usdValue = numericAmount * (asset.priceUsd ?? 0);
  return {
    token: asset.address,
    symbol: asset.symbol,
    decimals: asset.decimals,
    amount,
    formattedAmount: `${numericAmount.toFixed(Math.min(asset.decimals, 6))} ${asset.symbol}`,
    usdValue,
    reason,
  };
}

/**
 * Deterministic sub-millisecond rule engine used both for Fast-Path Execution
 * and as a safety fallback when LLM API is offline.
 */
export function evaluateDeterministically(
  report: ChainOpportunityReport,
  config: LlmOperatorConfig,
  recentExecutedKeys: Set<string> = new Set(),
  fallbackReason?: string,
  isFastPath = false,
): OperatorDecision {
  const startTime = Date.now();
  const currentGasGwei = Number(report.gasPriceGwei);
  const checksPassed: string[] = [];
  const warnings: string[] = [...report.warnings];
  if (fallbackReason) warnings.push(`Deterministic mode: ${fallbackReason}`);
  const sourceLabel = isFastPath ? 'fast-path' : 'deterministic-fallback';

  if (currentGasGwei > config.maxGasGwei) {
    warnings.push(`Gas price ${currentGasGwei.toFixed(2)} gwei melebihi batas MAX_GAS_GWEI (${config.maxGasGwei} gwei)`);
    return {
      action: 'HOLD',
      confidence: 0.99,
      reasoning: `Menahan eksekusi karena gas price saat ini (${currentGasGwei.toFixed(2)} gwei) melebihi batas keamanan (${config.maxGasGwei} gwei).`,
      chain: report.chain.key,
      blockNumber: report.blockNumber.toString(),
      riskAssessment: { level: 'HIGH', checksPassed, warnings },
      source: sourceLabel,
      model: isFastPath ? 'fast-path-engine-v2' : 'deterministic-guard-v1',
      latencyMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }
  checksPassed.push(`gas_ok (${currentGasGwei.toFixed(3)} <= ${config.maxGasGwei} gwei)`);

  // Priority 1: Profitable Morpho Blue Liquidation
  const bestLiquidation = (report.profitableLiquidations ?? []).find(
    (liq) =>
      isActionAllowedByMode('EXECUTE_LIQUIDATION', config.mode) && !report.arbExecutorPaused &&
      liq.netProfitUsd >= config.minProfitUsd &&
      !recentExecutedKeys.has(`liq:${liq.id}`),
  );

  // Priority 2: Profitable Multi-DEX Arbitrage
  const bestArbitrage = report.profitableCandidates.find(
    (cand) =>
      isActionAllowedByMode('EXECUTE_ARBITRAGE', config.mode) && canExecuteArbitrageCandidate(report, config, cand) &&
      cand.netProfitUsd >= config.minProfitUsd &&
      !recentExecutedKeys.has(`arb:${cand.id}`),
  );

  // Choose whichever yields higher net profit between Liquidation and Arbitrage
  if (
    bestLiquidation &&
    isActionAllowedByMode('EXECUTE_LIQUIDATION', config.mode) &&
    (!bestArbitrage || bestLiquidation.netProfitUsd >= bestArbitrage.netProfitUsd)
  ) {
    checksPassed.push(
      `liquidation_hf_under_1 (${bestLiquidation.healthFactor})`,
      `net_profit_verified ($${bestLiquidation.netProfitUsd.toFixed(2)})`,
    );
    return {
      action: 'EXECUTE_LIQUIDATION',
      confidence: 0.96,
      reasoning: `Ditemukan posisi Morpho Blue tidak sehat (HF=${bestLiquidation.healthFactor}) untuk peminjam ${bestLiquidation.borrower.slice(0, 10)}… di ${report.chain.name}. Likuidasi ${bestLiquidation.formattedRepaidAssets} ${bestLiquidation.marketParams.loanSymbol} -> sita ${bestLiquidation.formattedSeizedAssets} ${bestLiquidation.marketParams.collateralSymbol} via ${bestLiquidation.swapRouter.name}. Estimasi profit bersih $${bestLiquidation.netProfitUsd.toFixed(2)}.`,
      chain: report.chain.key,
      blockNumber: report.blockNumber.toString(),
      liquidationPlan: buildLiquidationPlan(bestLiquidation, config.deadlineSeconds),
      riskAssessment: { level: 'LOW', checksPassed, warnings },
      source: sourceLabel,
      model: isFastPath ? 'fast-path-engine-v2' : 'deterministic-guard-v1',
      latencyMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  if (bestArbitrage && isActionAllowedByMode('EXECUTE_ARBITRAGE', config.mode)) {
    checksPassed.push(
      `profit_verified ($${bestArbitrage.netProfitUsd.toFixed(2)} >= $${config.minProfitUsd})`,
      `spread_positive (${bestArbitrage.spreadBps} bps)`,
      `optimal_tier ($${Math.round(bestArbitrage.loanAmountUsd).toLocaleString('en-US')})`,
    );
    return {
      action: 'EXECUTE_ARBITRAGE',
      confidence: 0.94,
      reasoning: `Ditemukan peluang profit arbitrase optimal pada ${report.chain.name}: pinjam ${bestArbitrage.formattedLoanAmount} ${bestArbitrage.loanSymbol} ($${Math.round(bestArbitrage.loanAmountUsd).toLocaleString('en-US')}) -> swap ke ${bestArbitrage.intermediateSymbol} di ${bestArbitrage.firstRouterName} -> kembali ke ${bestArbitrage.loanSymbol} di ${bestArbitrage.secondRouterName}. Estimasi profit bersih $${bestArbitrage.netProfitUsd.toFixed(2)} (${bestArbitrage.spreadBps} bps) setelah gas $${bestArbitrage.estimatedGasCostUsd.toFixed(4)}.`,
      chain: report.chain.key,
      blockNumber: report.blockNumber.toString(),
      arbitragePlan: buildArbitragePlan(bestArbitrage, config.deadlineSeconds),
      riskAssessment: {
        level: bestArbitrage.readyToExecute ? 'LOW' : 'MEDIUM',
        checksPassed,
        warnings,
      },
      source: sourceLabel,
      model: isFastPath ? 'fast-path-engine-v2' : 'deterministic-guard-v1',
      latencyMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  // Priority 3: Pending Whitelist Sync (Token or Router)
  const hasPendingWhitelist =
    report.pendingWhitelistAssets.length > 0 || report.pendingWhitelistRouters.length > 0;
  const pendingPlan = buildWhitelistPlan(report.pendingWhitelistAssets, report.pendingWhitelistRouters);
  const whitelistCooldownKey = buildWhitelistCooldownKey(report.chain.key, pendingPlan.tokensToAllow, pendingPlan.routersToAllow);

  if (
    config.whitelistAutoSync &&
    hasPendingWhitelist &&
    isActionAllowedByMode('SYNC_WHITELIST', config.mode) &&
    !recentExecutedKeys.has(whitelistCooldownKey)
  ) {
    const tokenSymbols = report.pendingWhitelistAssets.map((a) => a.symbol).join(', ');
    const routerNames = report.pendingWhitelistRouters.map((r) => r.name).join(', ');
    checksPassed.push('pending_whitelist_detected', 'executor_verified');
    return {
      action: 'SYNC_WHITELIST',
      confidence: 0.95,
      reasoning: `Ditemukan aset/router memenuhi syarat di ${report.chain.name} yang belum di-whitelist on-chain` +
        (tokenSymbols ? ` [Tokens: ${tokenSymbols}]` : '') +
        (routerNames ? ` [Routers: ${routerNames}]` : '') +
        `. Menjalankan sinkronisasi allowlist otomatis.`,
      chain: report.chain.key,
      blockNumber: report.blockNumber.toString(),
      whitelistPlan: buildWhitelistPlan(report.pendingWhitelistAssets, report.pendingWhitelistRouters),
      riskAssessment: { level: 'LOW', checksPassed, warnings },
      source: sourceLabel,
      model: isFastPath ? 'fast-path-engine-v2' : 'deterministic-guard-v1',
      latencyMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  // Priority 4: Flashloan Execution when whitelisted asset is active and trigger is enabled
  const readyWhitelistedAsset = report.whitelistedAssets.find(
    (asset) =>
      asset.allowedOnFlashExecutor &&
      asset.balance > 0n &&
      !recentExecutedKeys.has(`flashloan:${report.chain.key}:${asset.symbol}`),
  );

  if (
    isFlashloanExecutionRequested(config.mode, config.flashloanOnWhitelist) &&
    readyWhitelistedAsset &&
    report.flashExecutor &&
    !report.flashExecutorPaused &&
    isActionAllowedByMode('EXECUTE_FLASHLOAN', config.mode)
  ) {
    const plan = buildFlashloanPlan(
      readyWhitelistedAsset,
      config.flashloanTriggerUsd,
      `Aset ${readyWhitelistedAsset.symbol} sudah masuk whitelist aktif di ${report.chain.name} dengan likuiditas $${Math.floor(readyWhitelistedAsset.usdValue ?? 0).toLocaleString('en-US')}`,
    );
    if (plan) {
      checksPassed.push('asset_whitelisted_on_chain', 'morpho_liquidity_sufficient');
      return {
        action: 'EXECUTE_FLASHLOAN',
        confidence: 0.9,
        reasoning: `Aset ${readyWhitelistedAsset.symbol} terdeteksi dalam whitelist aktif FlashLoanExecutor di ${report.chain.name} dan memiliki likuiditas memadai (${readyWhitelistedAsset.formattedBalance} ${readyWhitelistedAsset.symbol}). Mengeksekusi zero-fee atomic flashloan sebesar ${plan.formattedAmount}.`,
        chain: report.chain.key,
        blockNumber: report.blockNumber.toString(),
        flashloanPlan: plan,
        riskAssessment: { level: 'LOW', checksPassed, warnings },
        source: sourceLabel,
        model: isFastPath ? 'fast-path-engine-v2' : 'deterministic-guard-v1',
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  const topCandidate = report.arbitrageCandidates[0];
  const topSpreadNote = topCandidate
    ? `Rute terbaik saat ini ${topCandidate.loanSymbol}->${topCandidate.intermediateSymbol} (${topCandidate.firstRouterName}->${topCandidate.secondRouterName}, tier $${Math.round(topCandidate.loanAmountUsd).toLocaleString('en-US')}) memiliki spread ${topCandidate.spreadBps} bps dan estimasi net $${topCandidate.netProfitUsd.toFixed(2)} (target min $${config.minProfitUsd}).`
    : 'Belum ada pasangan rute DEX yang menghasilkan profit positif.';

  return {
    action: 'HOLD',
    confidence: 0.95,
    reasoning: `Memantau ${report.chain.name} di block ${report.blockNumber}: ${report.whitelistedAssets.length} aset sudah whitelist, ${report.pendingWhitelistAssets.length} pending whitelist, ${(report.profitableLiquidations ?? []).length} likuidasi. ${topSpreadNote}`,
    chain: report.chain.key,
    blockNumber: report.blockNumber.toString(),
    riskAssessment: { level: 'LOW', checksPassed, warnings },
    source: sourceLabel,
    model: isFastPath ? 'fast-path-engine-v2' : 'deterministic-guard-v1',
    latencyMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  };
}

function extractJsonObject(rawText: string): Record<string, unknown> {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('Respons LLM tidak mengandung JSON object yang valid');
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
}

/**
 * Evaluates chain state using Fast-Path (<1ms) when immediate profit is detected
 * and `fastPathEnabled=true`, otherwise queries the OpenAI-compatible LLM Operator.
 */
export async function evaluateWithLlmOperator(
  report: ChainOpportunityReport,
  config: LlmOperatorConfig,
  recentExecutedKeys: Set<string> = new Set(),
): Promise<OperatorDecision> {
  const startTime = Date.now();

  // Fast-Path Check: If a time-sensitive profitable arbitrage or liquidation is ready
  // and fastPathEnabled is true, execute immediately without waiting for LLM HTTP latency!
  if (config.fastPathEnabled) {
    const fastDecision = evaluateDeterministically(
      report,
      config,
      recentExecutedKeys,
      undefined,
      true,
    );
    if (
      fastDecision.action === 'EXECUTE_ARBITRAGE' ||
      fastDecision.action === 'EXECUTE_LIQUIDATION'
    ) {
      return fastDecision;
    }
  }

  if (!config.apiKey && !config.baseUrl.includes('127.0.0.1') && !config.baseUrl.includes('localhost')) {
    if (config.fallbackDeterministic) {
      return evaluateDeterministically(report, config, recentExecutedKeys, 'LLM_API_KEY belum dikonfigurasi');
    }
    throw new Error('LLM_API_KEY wajib diisi untuk mode operator LLM');
  }

  report = { ...report,
    profitableCandidates: report.profitableCandidates.filter(c =>
      !recentExecutedKeys.has(`arb:${c.id}`) && canExecuteArbitrageCandidate(report, config, c)),
    profitableLiquidations: (report.profitableLiquidations ?? []).filter(c =>
      !report.arbExecutorPaused && !recentExecutedKeys.has(`liq:${c.id}`)),
    whitelistedAssets: report.whitelistedAssets.filter(a =>
      !report.flashExecutorPaused && !recentExecutedKeys.has(`flashloan:${report.chain.key}:${a.symbol}`)),
  };

  const stateSummary = {
    chain: {
      key: report.chain.key,
      name: report.chain.name,
      chainId: report.chain.chainId,
      blockNumber: report.blockNumber.toString(),
      gasPriceGwei: Number(report.gasPriceGwei),
      maxGasGwei: config.maxGasGwei,
      nativePriceUsd: report.nativePriceUsd,
    },
    operatorConfig: {
      mode: config.mode,
      autoBroadcast: config.autoBroadcast,
      whitelistAutoSync: config.whitelistAutoSync,
      flashloanOnWhitelist: config.flashloanOnWhitelist,
      flashloanTriggerUsd: config.flashloanTriggerUsd,
      minProfitUsd: config.minProfitUsd,
    },
    executors: {
      flashExecutor: report.flashExecutor ?? null,
      flashExecutorPaused: report.flashExecutorPaused ?? false,
      arbExecutor: report.arbExecutor ?? null,
      arbExecutorPaused: report.arbExecutorPaused ?? false,
    },
    whitelistedAssets: report.whitelistedAssets.map((a) => ({
      symbol: a.symbol,
      address: a.address,
      formattedBalance: a.formattedBalance,
      usdValue: Math.round(a.usdValue ?? 0),
      allowedOnFlashExecutor: a.allowedOnFlashExecutor,
      allowedOnArbExecutor: a.allowedOnArbExecutor,
      onCooldown: recentExecutedKeys.has(`flashloan:${report.chain.key}:${a.symbol}`),
    })),
    pendingWhitelistAssets: report.pendingWhitelistAssets.map((a) => ({
      symbol: a.symbol,
      address: a.address,
      usdValue: Math.round(a.usdValue ?? 0),
      needsFlashWhitelist: a.needsFlashWhitelist,
      needsArbWhitelist: a.needsArbWhitelist,
    })),
    pendingWhitelistRouters: report.pendingWhitelistRouters.map((r) => ({
      name: r.name,
      address: r.address,
      protocol: r.protocol,
    })),
    topArbitrageCandidates: report.arbitrageCandidates.slice(0, 8).map((c) => ({
      id: c.id,
      loanSymbol: c.loanSymbol,
      intermediateSymbol: c.intermediateSymbol,
      firstRouterName: c.firstRouterName,
      secondRouterName: c.secondRouterName,
      loanAmountUsd: Number(c.loanAmountUsd.toFixed(2)),
      spreadBps: c.spreadBps,
      grossProfitUsd: Number(c.grossProfitUsd.toFixed(4)),
      estimatedGasCostUsd: Number(c.estimatedGasCostUsd.toFixed(4)),
      netProfitUsd: Number(c.netProfitUsd.toFixed(4)),
      profitable: c.profitable,
      readyToExecute: c.readyToExecute,
      onCooldown: recentExecutedKeys.has(`arb:${c.id}`),
    })),
    liquidationCandidates: (report.liquidationCandidates ?? []).slice(0, 5).map((l) => ({
      id: l.id,
      borrower: l.borrower,
      healthFactor: l.healthFactor,
      loanSymbol: l.marketParams.loanSymbol,
      collateralSymbol: l.marketParams.collateralSymbol,
      repaidUsd: Number(l.repaidUsd.toFixed(2)),
      netProfitUsd: Number(l.netProfitUsd.toFixed(4)),
      profitable: l.profitable,
      onCooldown: recentExecutedKeys.has(`liq:${l.id}`),
    })),
  };

  const systemPrompt = `Anda adalah LLM Operator Watch & Executor untuk Morpho Blue Flashloan, Multi-DEX Arbitrage, & Liquidation di VPS.
Tugas Anda adalah menganalisis snapshot on-chain terbaru dan memilih TEPAT SATU aksi dalam format JSON murni:
- "EXECUTE_LIQUIDATION": Pilih jika ada kandidat di liquidationCandidates dengan profitable=true, netProfitUsd >= minProfitUsd, onCooldown=false, gasPriceGwei <= maxGasGwei, dan diizinkan oleh mode (${config.mode}). Cantumkan "candidateId".
- "EXECUTE_ARBITRAGE": Pilih jika ada kandidat di topArbitrageCandidates dengan profitable=true, netProfitUsd >= minProfitUsd, onCooldown=false, gasPriceGwei <= maxGasGwei, dan diizinkan oleh mode (${config.mode}). Cantumkan "candidateId".
- "SYNC_WHITELIST": Pilih jika pendingWhitelistAssets atau pendingWhitelistRouters tidak kosong, whitelistAutoSync=true, gasPriceGwei <= maxGasGwei, dan diizinkan oleh mode.
- "EXECUTE_FLASHLOAN": Pilih jika ada aset di whitelistedAssets dengan allowedOnFlashExecutor=true, onCooldown=false, (flashloanOnWhitelist=true atau mode="flashloan"), gasPriceGwei <= maxGasGwei. Cantumkan "flashloanSymbol".
- "HOLD": Pilih jika tidak ada kondisi di atas yang terpenuhi atau gas terlalu mahal.

Format output WAJIB JSON object tanpa markdown tambahan:
{
  "action": "HOLD" | "SYNC_WHITELIST" | "EXECUTE_ARBITRAGE" | "EXECUTE_LIQUIDATION" | "EXECUTE_FLASHLOAN",
  "confidence": 0.95,
  "reasoning": "Penjelasan singkat dan jelas dalam Bahasa Indonesia",
  "candidateId": "isi id kandidat arbitrase/likuidasi jika relevan, selain itu null",
  "flashloanSymbol": "isi simbol token jika action=EXECUTE_FLASHLOAN, selain itu null",
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "checksPassed": ["daftar validasi yang lolos"],
  "warnings": ["daftar peringatan jika ada"]
}`;

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (config.apiKey) {
      headers.authorization = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(stateSummary) },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`LLM HTTP ${response.status}: ${errBody.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawContent = data.choices?.[0]?.message?.content;
    if (!rawContent) throw new Error('Respons LLM kosong');

    const parsed = extractJsonObject(rawContent);
    const rawAction = String(parsed.action ?? 'HOLD').toUpperCase() as OperatorActionType;
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.85)));
    const reasoning = String(parsed.reasoning ?? 'Keputusan dievaluasi oleh operator LLM.');
    const riskLevelRaw = String(parsed.riskLevel ?? 'LOW').toUpperCase();
    const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' =
      riskLevelRaw === 'HIGH' || riskLevelRaw === 'MEDIUM' ? riskLevelRaw : 'LOW';
    const checksPassed = Array.isArray(parsed.checksPassed)
      ? parsed.checksPassed.map(String)
      : [];
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.map(String)
      : [...report.warnings];

    const currentGasGwei = Number(report.gasPriceGwei);
    if (currentGasGwei > config.maxGasGwei && rawAction !== 'HOLD') {
      return {
        action: 'HOLD',
        confidence: 1,
        reasoning: `[Guard Override] LLM menyarankan ${rawAction}, tetapi gas (${currentGasGwei.toFixed(2)} gwei) > MAX_GAS_GWEI (${config.maxGasGwei} gwei).`,
        chain: report.chain.key,
        blockNumber: report.blockNumber.toString(),
        riskAssessment: {
          level: 'HIGH',
          checksPassed,
          warnings: [...warnings, 'Gas price cap exceeded'],
        },
        source: 'llm',
        model: config.model,
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    if (!isActionAllowedByMode(rawAction, config.mode)) {
      return {
        action: 'HOLD',
        confidence,
        reasoning: `[Mode Guard] LLM memilih ${rawAction} (${reasoning}), namun mode aktif adalah '${config.mode}'.`,
        chain: report.chain.key,
        blockNumber: report.blockNumber.toString(),
        riskAssessment: { level: riskLevel, checksPassed, warnings },
        source: 'llm',
        model: config.model,
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    if (rawAction === 'EXECUTE_LIQUIDATION') {
      const requestedId = parsed.candidateId ? String(parsed.candidateId) : undefined;
      const liqCandidate =
        (report.profitableLiquidations ?? []).find((l) => l.id === requestedId) ??
        (report.profitableLiquidations ?? []).find((l) => l.netProfitUsd >= config.minProfitUsd);

      if (!liqCandidate || liqCandidate.netProfitUsd < config.minProfitUsd) {
        return {
          action: 'HOLD',
          confidence,
          reasoning: `[Guard Override] LLM memilih EXECUTE_LIQUIDATION namun tidak ada posisi yang memenuhi minProfitUsd ($${config.minProfitUsd}).`,
          chain: report.chain.key,
          blockNumber: report.blockNumber.toString(),
          riskAssessment: { level: 'MEDIUM', checksPassed, warnings },
          source: 'llm',
          model: config.model,
          latencyMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        action: 'EXECUTE_LIQUIDATION',
        confidence,
        reasoning,
        chain: report.chain.key,
        blockNumber: report.blockNumber.toString(),
        liquidationPlan: buildLiquidationPlan(liqCandidate, config.deadlineSeconds),
        riskAssessment: { level: riskLevel, checksPassed, warnings },
        source: 'llm',
        model: config.model,
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    if (rawAction === 'EXECUTE_ARBITRAGE') {
      const requestedId = parsed.candidateId ? String(parsed.candidateId) : undefined;
      const candidate =
        report.profitableCandidates.find((c) => c.id === requestedId) ??
        report.profitableCandidates.find((c) => c.netProfitUsd >= config.minProfitUsd);

      if (!candidate || candidate.netProfitUsd < config.minProfitUsd) {
        return {
          action: 'HOLD',
          confidence,
          reasoning: `[Guard Override] LLM memilih EXECUTE_ARBITRAGE tetapi tidak ada kandidat on-chain yang memenuhi minProfitUsd ($${config.minProfitUsd}). Catatan LLM: ${reasoning}`,
          chain: report.chain.key,
          blockNumber: report.blockNumber.toString(),
          riskAssessment: {
            level: 'MEDIUM',
            checksPassed,
            warnings: [...warnings, 'Arbitrage candidate did not pass hard profit guard'],
          },
          source: 'llm',
          model: config.model,
          latencyMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        action: 'EXECUTE_ARBITRAGE',
        confidence,
        reasoning,
        chain: report.chain.key,
        blockNumber: report.blockNumber.toString(),
        arbitragePlan: buildArbitragePlan(candidate, config.deadlineSeconds),
        riskAssessment: { level: riskLevel, checksPassed, warnings },
        source: 'llm',
        model: config.model,
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    if (rawAction === 'SYNC_WHITELIST') {
      if (
        report.pendingWhitelistAssets.length === 0 &&
        report.pendingWhitelistRouters.length === 0
      ) {
        return {
          action: 'HOLD',
          confidence,
          reasoning: `[Guard Override] Semua aset/router sudah ter-whitelist. Catatan LLM: ${reasoning}`,
          chain: report.chain.key,
          blockNumber: report.blockNumber.toString(),
          riskAssessment: { level: 'LOW', checksPassed, warnings },
          source: 'llm',
          model: config.model,
          latencyMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      // Policy Guard: `WHITELIST_AUTO_SYNC=false` must be enforced here too. The system prompt
      // only *asks* the model to consider this flag, so without a hard check a model that
      // ignores it could broadcast allowlist transactions the operator explicitly disabled.
      const pendingPlan = buildWhitelistPlan(report.pendingWhitelistAssets, report.pendingWhitelistRouters);
      if (!config.whitelistAutoSync || recentExecutedKeys.has(buildWhitelistCooldownKey(report.chain.key, pendingPlan.tokensToAllow, pendingPlan.routersToAllow))) {
        return {
          action: 'HOLD',
          confidence,
          reasoning: `[Policy Guard] LLM memilih SYNC_WHITELIST namun WHITELIST_AUTO_SYNC=false. Whitelist harus disinkronkan manual (npm run cli -- setup-arb --select all --broadcast). Catatan LLM: ${reasoning}`,
          chain: report.chain.key,
          blockNumber: report.blockNumber.toString(),
          riskAssessment: {
            level: 'MEDIUM',
            checksPassed,
            warnings: [...warnings, 'whitelistAutoSync disabled by operator'],
          },
          source: 'llm',
          model: config.model,
          latencyMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        action: 'SYNC_WHITELIST',
        confidence,
        reasoning,
        chain: report.chain.key,
        blockNumber: report.blockNumber.toString(),
        whitelistPlan: buildWhitelistPlan(report.pendingWhitelistAssets, report.pendingWhitelistRouters),
        riskAssessment: { level: riskLevel, checksPassed, warnings },
        source: 'llm',
        model: config.model,
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    if (rawAction === 'EXECUTE_FLASHLOAN') {
      // Policy Guard: mirror the deterministic engine's opt-in requirement. Without this,
      // `mode='full'` alone would let a model that ignores the system prompt trigger a
      // flashloan the operator never enabled — which reverts whenever the executing wallet is
      // not the FlashLoanExecutor owner, failing the cycle on every iteration.
      if (!isFlashloanExecutionRequested(config.mode, config.flashloanOnWhitelist)) {
        return {
          action: 'HOLD',
          confidence,
          reasoning: `[Policy Guard] LLM memilih EXECUTE_FLASHLOAN namun flashloan tidak diaktifkan operator (FLASHLOAN_ON_WHITELIST=false dan mode bukan 'flashloan'). Catatan LLM: ${reasoning}`,
          chain: report.chain.key,
          blockNumber: report.blockNumber.toString(),
          riskAssessment: {
            level: 'MEDIUM',
            checksPassed,
            warnings: [...warnings, 'flashloan execution not enabled by operator'],
          },
          source: 'llm',
          model: config.model,
          latencyMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      const requestedSymbol = parsed.flashloanSymbol ? String(parsed.flashloanSymbol).toUpperCase() : undefined;
      const asset =
        report.whitelistedAssets.find(
          (a) => a.allowedOnFlashExecutor && a.symbol.toUpperCase() === requestedSymbol,
        ) ??
        report.whitelistedAssets.find((a) => a.allowedOnFlashExecutor && a.balance > 0n);

      if (!asset) {
        return {
          action: 'HOLD',
          confidence,
          reasoning: `[Guard Override] LLM memilih EXECUTE_FLASHLOAN namun belum ada aset yang di-whitelist di FlashLoanExecutor. Catatan LLM: ${reasoning}`,
          chain: report.chain.key,
          blockNumber: report.blockNumber.toString(),
          riskAssessment: { level: 'MEDIUM', checksPassed, warnings },
          source: 'llm',
          model: config.model,
          latencyMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      const plan = buildFlashloanPlan(asset, config.flashloanTriggerUsd, reasoning);
      if (!plan) {
        return {
          action: 'HOLD',
          confidence,
          reasoning: `[Guard Override] Saldo aset ${asset.symbol} tidak mencukupi untuk flashloan.`,
          chain: report.chain.key,
          blockNumber: report.blockNumber.toString(),
          riskAssessment: { level: 'MEDIUM', checksPassed, warnings },
          source: 'llm',
          model: config.model,
          latencyMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        action: 'EXECUTE_FLASHLOAN',
        confidence,
        reasoning,
        chain: report.chain.key,
        blockNumber: report.blockNumber.toString(),
        flashloanPlan: plan,
        riskAssessment: { level: riskLevel, checksPassed, warnings },
        source: 'llm',
        model: config.model,
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      action: 'HOLD',
      confidence,
      reasoning,
      chain: report.chain.key,
      blockNumber: report.blockNumber.toString(),
      riskAssessment: { level: riskLevel, checksPassed, warnings },
      source: 'llm',
      model: config.model,
      latencyMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (config.fallbackDeterministic) {
      return evaluateDeterministically(report, config, recentExecutedKeys, `LLM error (${errMsg})`);
    }
    throw error;
  }
}
