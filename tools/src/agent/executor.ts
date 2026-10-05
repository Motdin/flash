import {
  createPublicClient,
  decodeEventLog,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  fallback,
  formatGwei,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseGwei,
  parseUnits,
  type Hash,
  type Hex,
} from 'viem';
import { ExecutionCooldown } from './cooldown.js';
import { estimateL1Fee, estimateOperatorFee } from 'viem/op-stack';
import { privateKeyToAccount } from 'viem/accounts';
import type { EvmChainConfig } from '../config/chains.js';
import {
  deploymentFor,
  loadDeployments,
  saveDeployments,
  type Address,
} from '../config/registry.js';
import type { ChainOpportunityReport } from '../morpho/dex-scanner.js';
import { isActionAllowedByMode, canExecuteArbitrageCandidate } from './llm-operator.js';
import type {
  ArbitrageExecutionPlan,
  LlmOperatorConfig,
  OperatorActionType,
  OperatorDecision,
} from './llm-operator.js';
import {
  awaitBundleInclusion,
  bundleTxHash,
  resolveBundleBroadcastDecision,
  resolveBundleAuthKey,
  shouldWaitForBundle,
  submitMevBundleToRelays,
} from './mev-bundle.js';

const flashLoanExecutorAbi = parseAbi([
  'function owner() view returns (address)',
  'function morpho() view returns (address)',
  'function allowedToken(address) view returns (bool)',
  'function setTokenAllowed(address,bool)',
  'function flashLoan(address,uint256)',
]);

const arbExecutorAbi = parseAbi([
  'event ArbitrageExecuted(address indexed loanToken,address indexed intermediateToken,uint256 loanAmount,uint256 profit,address indexed profitReceiver)',
  'event MultiHopArbitrageExecuted(address indexed loanToken,uint256 hopsCount,uint256 loanAmount,uint256 profit,address indexed profitReceiver)',
  'event LiquidationExecuted(address indexed borrower,address indexed loanToken,address indexed collateralToken,uint256 seizedAssets,uint256 repaidAssets,uint256 profit,address profitReceiver)',
  'function owner() view returns (address)',
  'function operator() view returns (address)',
  'function morpho() view returns (address)',
  'function allowedToken(address) view returns (bool)',
  'function allowedRouter(address) view returns (bool)',
  'function setTokenAllowed(address,bool)',
  'function setRouterAllowed(address,bool)',
  'function setRouterPreApproval(address token, address spender, uint256 amount)',
  'function batchSetRouterPreApprovals(address[] tokens, address[] spenders, uint256 amount)',
  'function executeArbitrage((address loanToken, address intermediateToken, address firstRouter, address secondRouter, uint256 loanAmount, uint256 minIntermediateAmount, uint256 minFinalAmount, uint256 minProfit, uint256 deadline, address profitReceiver) params) returns (uint256 profit)',
  'function executeMultiDexArbitrage((address loanToken, address intermediateToken, (address router, uint8 kind, uint24 fee, bool stable, address factory) firstHop, (address router, uint8 kind, uint24 fee, bool stable, address factory) secondHop, uint256 loanAmount, uint256 minIntermediateAmount, uint256 minFinalAmount, uint256 minProfit, uint256 deadline, address profitReceiver) params) returns (uint256 profit)',
  'function executeMultiHopArbitrage((address loanToken, uint256 loanAmount, ((address router, uint8 kind, uint24 fee, bool stable, address factory) hop, address tokenOut, uint256 minAmountOut)[] steps, uint256 minProfit, uint256 deadline, address profitReceiver) params) returns (uint256 profit)',
  'function executeLiquidation(((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, address borrower, uint256 seizedAssets, uint256 repaidShares, (address router, uint8 kind, uint24 fee, bool stable, address factory) collateralSwapHop, uint256 minLoanTokenOut, uint256 minProfit, uint256 deadline, address profitReceiver) params) returns (uint256 profit)',
]);

export type ExecutionOutcome = {
  action: OperatorActionType;
  chain: string;
  simulated: boolean;
  simulationSuccess: boolean;
  broadcasted: boolean;
  usedPrivateRpc?: boolean;
  mevBundleHashes?: string[];
  priorityFeeGwei?: string;
  txHashes: Hash[];
  explorerUrls: string[];
  summary: string;
  error?: string;
  timestamp: string;
  realizedGrossProfit?: string;
  simulatedGrossProfit?: string;
  executionGasCostNative?: string;
};

/**
 * Resolves private MEV-protected RPC URL (e.g. Flashbots Protect / MEV Blocker)
 * if configured for the chain, otherwise falls back to standard RPC.
 */
export function resolveBroadcastRpc(
  chainKey: string,
  defaultRpcUrl: string,
): { url: string; isPrivate: boolean } {
  const upperKey = chainKey.toUpperCase();
  const chainPrivate = process.env[`${upperKey}_PRIVATE_RPC_URL`];
  if (chainPrivate) return { url: chainPrivate, isPrivate: true };
  if (chainKey === 'ethereum' && process.env.PRIVATE_TX_RPC_URL) {
    return { url: process.env.PRIVATE_TX_RPC_URL, isPrivate: true };
  }
  return { url: defaultRpcUrl, isPrivate: false };
}

/**
 * Computes dynamic priority fee (validator bribe) from expected profit surplus
 * while preserving `minProfitUsd`.
 */
export function computeDynamicPriorityFee(params: {
  baseGasPriceWei: bigint;
  estimatedGasUnits: bigint;
  nativePriceUsd: number;
  expectedGrossProfitUsd: number;
  minProfitUsd: number;
  profitBribeBps: number;
  maxPriorityFeeGwei: number;
}): {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  priorityFeeGwei: string;
} {
  const {
    baseGasPriceWei,
    estimatedGasUnits,
    nativePriceUsd,
    expectedGrossProfitUsd,
    minProfitUsd,
    profitBribeBps,
    maxPriorityFeeGwei,
  } = params;

  const baseGasCostUsd =
    Number(formatUnits(baseGasPriceWei * estimatedGasUnits, 18)) * nativePriceUsd;
  const surplusUsd = Math.max(0, expectedGrossProfitUsd - baseGasCostUsd - minProfitUsd);
  const clampedBps = Math.max(0, Math.min(5_000, profitBribeBps));
  const bribeBudgetUsd = (surplusUsd * clampedBps) / 10_000;

  let priorityFeeWei = 0n;
  if (bribeBudgetUsd > 0 && nativePriceUsd > 0 && estimatedGasUnits > 0n) {
    const bribeNative = bribeBudgetUsd / nativePriceUsd;
    const totalBribeWei = parseUnits(bribeNative.toFixed(12) || '0', 18);
    const perGasWei = totalBribeWei / estimatedGasUnits;
    if (perGasWei > priorityFeeWei) {
      priorityFeeWei = perGasWei;
    }
  }

  const capWei = parseGwei(String(Math.max(0, maxPriorityFeeGwei)));
  if (priorityFeeWei > capWei) {
    priorityFeeWei = capWei;
  }

  const maxFeePerGas = baseGasPriceWei * 2n + priorityFeeWei;
  return {
    maxPriorityFeePerGas: priorityFeeWei,
    maxFeePerGas,
    priorityFeeGwei: formatGwei(priorityFeeWei),
  };
}

function buildViemChain(chain: EvmChainConfig, rpc: string) {
  const readRpcUrls = [rpc, ...(chain.readRpcFallbacks ?? [])].filter(
    (url, index, urls) => urls.indexOf(url) === index,
  );
  return defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: {
      name: chain.nativeSymbol,
      symbol: chain.nativeSymbol,
      decimals: 18,
    },
    rpcUrls: { default: { http: readRpcUrls } },
    blockExplorers: { default: { name: chain.name, url: chain.explorer } },
  });
}

function buildReadTransport(chain: EvmChainConfig, rpc: string) {
  const urls = [rpc, ...(chain.readRpcFallbacks ?? [])].filter(
    (url, index, values) => values.indexOf(url) === index,
  );
  return urls.length === 1
    ? http(urls[0])
    : fallback(urls.map((url) => http(url)), { retryCount: 0 });
}

function getValidPrivateKey(): Hex | undefined {
  const raw = process.env.PRIVATE_KEY;
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return undefined;
  return raw as Hex;
}

/**
 * Resolves the complete set of on-chain allowlist targets (`allowedToken` + `allowedRouter`)
 * required to execute an arbitrage plan on `MorphoAtomicArbPOC`.
 *
 * A 2-hop plan only touches `loanToken`/`intermediateToken` and the first/second router, but an
 * N-hop (triangular) plan validates `allowedToken[step.tokenOut]` and `allowedRouter[step.router]`
 * for *every* hop. Whitelisting just the first/last hop therefore makes `executeMultiHopArbitrage`
 * revert with `TokenNotAllowed` / `RouterNotAllowed`. All targets are de-duplicated
 * case-insensitively (first occurrence wins) so repeated hops never emit redundant transactions.
 */
export function resolveAutoAllowlistTargets(plan: ArbitrageExecutionPlan): {
  tokens: Address[];
  routers: Address[];
} {
  const steps = plan.steps && plan.steps.length > 0 ? plan.steps : undefined;
  const tokenCandidates = steps
    ? [plan.loanToken, ...steps.map((s) => s.tokenOut)]
    : [plan.loanToken, plan.intermediateToken];
  const routerCandidates = steps
    ? steps.map((s) => s.router)
    : [plan.firstRouter, plan.secondRouter];

  const dedupe = (addresses: Address[]): Address[] => {
    const seen = new Set<string>();
    const unique: Address[] = [];
    for (const addr of addresses) {
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(addr);
    }
    return unique;
  };

  return { tokens: dedupe(tokenCandidates), routers: dedupe(routerCandidates) };
}

export async function executeOperatorDecision(params: {
  decision: OperatorDecision;
  report: ChainOpportunityReport;
  config: LlmOperatorConfig;
  rpcUrl: string;
  recentExecutedKeys: Set<string>;
}): Promise<ExecutionOutcome> {
  const { decision, report, config, rpcUrl, recentExecutedKeys } = params;
  const timestamp = new Date().toISOString();

  if (decision.action === 'HOLD') {
    return {
      action: 'HOLD',
      chain: report.chain.key,
      simulated: false,
      simulationSuccess: true,
      broadcasted: false,
      txHashes: [],
      explorerUrls: [],
      summary: decision.reasoning,
      timestamp,
    };
  }

  const executionKey = decision.arbitragePlan ? `arb:${decision.arbitragePlan.candidateId}`
    : decision.liquidationPlan ? `liq:${decision.liquidationPlan.candidateId}`
    : decision.flashloanPlan ? `flashloan:${report.chain.key}:${decision.flashloanPlan.symbol}`
    : decision.whitelistPlan ? `whitelist:${report.chain.key}:${decision.whitelistPlan.tokensToAllow.map(t => t.symbol).join(',')}` : undefined;
  const forbidden = !isActionAllowedByMode(decision.action, config.mode)
    || (executionKey !== undefined && recentExecutedKeys.has(executionKey))
    || (decision.action === 'SYNC_WHITELIST' && (!config.whitelistAutoSync
      || decision.whitelistPlan?.tokensToAllow.some(t => !report.pendingWhitelistAssets.some(a => a.address.toLowerCase() === t.address.toLowerCase()))
      || decision.whitelistPlan?.routersToAllow.some(r => !report.pendingWhitelistRouters.some(a => a.address.toLowerCase() === r.address.toLowerCase()))))
    || (decision.action === 'EXECUTE_FLASHLOAN' && report.flashExecutorPaused)
    || (decision.action === 'EXECUTE_LIQUIDATION' && (report.arbExecutorPaused
      || !report.profitableLiquidations.some(c => c.id === decision.liquidationPlan?.candidateId)))
    || (decision.arbitragePlan !== undefined && !report.profitableCandidates.some(c =>
      c.id === decision.arbitragePlan!.candidateId && canExecuteArbitrageCandidate(report, config, c)));
  if (forbidden) {
    return { action: decision.action, chain: report.chain.key, simulated: false, simulationSuccess: false,
      broadcasted: false, txHashes: [], explorerUrls: [], summary: 'Policy/cooldown guard: execution refused', timestamp };
  }

  const chainConfig = buildViemChain(report.chain, rpcUrl);
  const publicClient = createPublicClient({
    chain: chainConfig,
    transport: buildReadTransport(report.chain, rpcUrl),
  });

  const shouldBroadcast = config.autoBroadcast && config.mode !== 'dry-run';
  const isOfflineSimulation = report.warnings.some((w) => w.startsWith('offline-rpc-simulation'));

  if (isOfflineSimulation && shouldBroadcast) {
    return { action: decision.action, chain: report.chain.key, simulated: false, simulationSuccess: false,
      broadcasted: false, txHashes: [], explorerUrls: [], summary: 'Synthetic/offline reports must never be broadcast', timestamp };
  }
  if (isOfflineSimulation && !shouldBroadcast) {
    if (decision.action === 'SYNC_WHITELIST' && decision.whitelistPlan) {
      const tokens = decision.whitelistPlan.tokensToAllow.map((t) => t.symbol).join(', ');
      return {
        action: 'SYNC_WHITELIST',
        chain: report.chain.key,
        simulated: false,
        simulationSuccess: false,
        broadcasted: false,
        txHashes: [],
        explorerUrls: [],
        summary: `[OFFLINE EXAMPLE — NOT VALIDATED] Rencana setTokenAllowed(${tokens}) tervalidasi di ${report.chain.name}. Hubungkan RPC aktif & set AUTO_BROADCAST=true untuk eksekusi on-chain.`,
        timestamp,
      };
    }
    if (decision.action === 'EXECUTE_ARBITRAGE' && decision.arbitragePlan) {
      const p = decision.arbitragePlan;
      return {
        action: 'EXECUTE_ARBITRAGE',
        chain: report.chain.key,
        simulated: false,
        simulationSuccess: false,
        broadcasted: false,
        txHashes: [],
        explorerUrls: [],
        summary: `[OFFLINE EXAMPLE — NOT VALIDATED] Rencana executeArbitrage(${p.formattedLoanAmount} ${p.loanSymbol} -> ${p.intermediateSymbol} via ${p.firstRouterName}->${p.secondRouterName}, est. net +$${p.expectedNetProfitUsd.toFixed(2)}) tervalidasi.`,
        timestamp,
      };
    }
    if (decision.action === 'EXECUTE_LIQUIDATION' && decision.liquidationPlan) {
      const p = decision.liquidationPlan;
      return {
        action: 'EXECUTE_LIQUIDATION',
        chain: report.chain.key,
        simulated: false,
        simulationSuccess: false,
        broadcasted: false,
        txHashes: [],
        explorerUrls: [],
        summary: `[OFFLINE EXAMPLE — NOT VALIDATED] Rencana executeLiquidation(${p.borrower.slice(0, 10)}…, repay ${p.formattedRepaidAssets} ${p.loanSymbol}, est. net +$${p.expectedNetProfitUsd.toFixed(2)}) tervalidasi.`,
        timestamp,
      };
    }
    if (decision.action === 'EXECUTE_FLASHLOAN' && decision.flashloanPlan) {
      const p = decision.flashloanPlan;
      return {
        action: 'EXECUTE_FLASHLOAN',
        chain: report.chain.key,
        simulated: false,
        simulationSuccess: false,
        broadcasted: false,
        txHashes: [],
        explorerUrls: [],
        summary: `[OFFLINE EXAMPLE — NOT VALIDATED] Rencana flashLoan(${p.formattedAmount}) pada ${report.flashExecutor} tervalidasi.`,
        timestamp,
      };
    }
  }

  const pk = getValidPrivateKey();
  const account = pk ? privateKeyToAccount(pk) : undefined;
  const broadcastRpcInfo = resolveBroadcastRpc(report.chain.key, rpcUrl);
  const walletClient =
    shouldBroadcast && account
      ? createWalletClient({
          account,
          chain: chainConfig,
          transport: http(broadcastRpcInfo.url),
        })
      : undefined;

  const txHashes: Hash[] = [];
  const explorerUrls: string[] = [];

  let realizedGrossProfit: string | undefined;
  let executionGasCostNative: string | undefined;
  const collectReceipt = (receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>) => {
    executionGasCostNative = formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18);
    const decimals = decision.arbitragePlan?.loanDecimals ?? decision.liquidationPlan?.loanDecimals;
    for (const log of receipt.logs) {
      if (!report.arbExecutor || log.address.toLowerCase() !== report.arbExecutor.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: arbExecutorAbi, data: log.data, topics: log.topics });
        if ('profit' in decoded.args && decimals !== undefined) realizedGrossProfit = formatUnits(decoded.args.profit, decimals);
      } catch { /* unrelated log */ }
    }
  };
  const waitForReceipt = async ({ hash }: { hash: Hash }) => {
    if (!txHashes.includes(hash)) {
      txHashes.push(hash);
      explorerUrls.push(`${report.chain.explorer}/tx/${hash}`);
    }
    if (executionKey) {
      if (recentExecutedKeys instanceof ExecutionCooldown) {
        recentExecutedKeys.markPending(executionKey, async () => {
          await publicClient.getTransactionReceipt({ hash });
          return true;
        });
      } else recentExecutedKeys.add(executionKey);
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    collectReceipt(receipt);
    if (executionKey && recentExecutedKeys instanceof ExecutionCooldown) recentExecutedKeys.markConfirmed(executionKey);
    return receipt;
  };

  const prepareProfitGuard = async (profit: bigint, decimals: number, loanToken: Address, estimatedGas: bigint, data: Hex) => {
    const tokenPriceUsd = report.tokenWhitelists.find(t => t.address.toLowerCase() === loanToken.toLowerCase())?.priceUsd
      ?? report.profitableLiquidations.find(c => c.marketParams.loanToken.toLowerCase() === loanToken.toLowerCase())?.marketParams.loanPriceUsd;
    if (!tokenPriceUsd || !Number.isFinite(tokenPriceUsd) || tokenPriceUsd <= 0 || report.nativePriceUsd <= 0) {
      throw new Error('Fresh token/native USD prices required for net profit validation');
    }
    const gasPrice = await publicClient.getGasPrice();
    if (gasPrice > parseGwei(String(config.maxGasGwei))) throw new Error('Latest gas exceeds MAX_GAS_GWEI');
    let extraFeeWei = 0n;
    if (report.chain.key === 'base' || report.chain.key === 'optimism') {
      const request = { account: account?.address ?? report.arbExecutorOwner!, to: report.arbExecutor!, data,
        gasPriceOracleAddress: '0x420000000000000000000000000000000000000F' as Address };
      const [l1, operator] = await Promise.all([estimateL1Fee(publicClient, request), estimateOperatorFee(publicClient, request)]);
      extraFeeWei = (l1 + operator) * 2n; // conservative reserve; these fees may change before inclusion
    } else if (!['ethereum', 'arbitrum'].includes(report.chain.key)) {
      throw new Error('No verified total transaction fee model for this chain');
    }
    // Arbitrum eth_estimateGas includes the L1 data component in gas units.
    return buildNetProfitGuard({ simulatedProfit: profit, decimals, tokenPriceUsd,
      nativePriceUsd: report.nativePriceUsd, gasPriceWei: gasPrice, estimatedGas, extraFeeWei,
      minProfitUsd: config.minProfitUsd, profitBribeBps: config.profitBribeBps,
      maxPriorityFeeGwei: config.maxPriorityFeeGwei, maxGasGwei: config.maxGasGwei });
  };

  try {
    if (await publicClient.getChainId() !== report.chain.chainId) throw new Error('Executor RPC chain mismatch');
    if (shouldBroadcast) {
      if (!account) {
        throw new Error('PRIVATE_KEY valid wajib diisi di tools/.env untuk mode broadcast');
      }
      const minNativeRaw = process.env.MIN_NATIVE_GAS_BALANCE ?? '0.001';
      const minNativeWei = parseUnits(minNativeRaw, 18);
      const nativeBalance = await publicClient.getBalance({ address: account.address });
      if (nativeBalance < minNativeWei) {
        throw new Error(
          `Saldo gas native wallet (${formatUnits(nativeBalance, 18)} ${report.chain.nativeSymbol}) di bawah batas minimum (${minNativeRaw} ${report.chain.nativeSymbol})`,
        );
      }
    }

    // 1. Handle SYNC_WHITELIST
    if (decision.action === 'SYNC_WHITELIST' && decision.whitelistPlan) {
      const plan = decision.whitelistPlan;
      const simulatedSteps: string[] = [];
      const registry = await loadDeployments();
      const record = deploymentFor(registry, report.chain.key);

      if (report.flashExecutor && report.flashExecutorOwner) {
        for (const token of plan.tokensToAllow) {
          if (token.target !== 'flash' && token.target !== 'both') continue;
          await publicClient.simulateContract({
            account: report.flashExecutorOwner,
            address: report.flashExecutor,
            abi: flashLoanExecutorAbi,
            functionName: 'setTokenAllowed',
            args: [token.address, true],
          });
          simulatedSteps.push(`FlashExecutor.setTokenAllowed(${token.symbol})`);

          if (shouldBroadcast) {
            if (!walletClient || !account) {
              throw new Error('PRIVATE_KEY valid diperlukan untuk broadcast SYNC_WHITELIST');
            }
            if (account.address.toLowerCase() !== report.flashExecutorOwner.toLowerCase()) {
              throw new Error(
                `Wallet (${account.address}) bukan owner FlashLoanExecutor (${report.flashExecutorOwner})`,
              );
            }
            const hash = await walletClient.writeContract({
              address: report.flashExecutor,
              abi: flashLoanExecutorAbi,
              functionName: 'setTokenAllowed',
              args: [token.address, true],
            });
            const receipt = await waitForReceipt({ hash });
            if (receipt.status !== 'success') {
              throw new Error(`setTokenAllowed revert untuk ${token.symbol}: ${hash}`);
            }


            if (record) {
              const allowedSet = new Set([...(record.allowedAssets ?? []), token.symbol]);
              record.allowedAssets = [...allowedSet];
              record.allowlistTransactions = {
                ...(record.allowlistTransactions ?? {}),
                [`${token.symbol}:${token.address}`]: hash,
              };
            }
          }
        }
      }

      if (report.arbExecutor && report.arbExecutorOwner) {
        for (const token of plan.tokensToAllow) {
          if (token.target !== 'arb' && token.target !== 'both') continue;
          await publicClient.simulateContract({
            account: report.arbExecutorOwner,
            address: report.arbExecutor,
            abi: arbExecutorAbi,
            functionName: 'setTokenAllowed',
            args: [token.address, true],
          });
          simulatedSteps.push(`ArbExecutor.setTokenAllowed(${token.symbol})`);

          if (shouldBroadcast && walletClient && account) {
            const hash = await walletClient.writeContract({
              address: report.arbExecutor,
              abi: arbExecutorAbi,
              functionName: 'setTokenAllowed',
              args: [token.address, true],
            });
            const receipt = await waitForReceipt({ hash });
            if (receipt.status !== 'success') {
              throw new Error(`Arb setTokenAllowed revert untuk ${token.symbol}: ${hash}`);
            }

          }
        }

        for (const router of plan.routersToAllow) {
          await publicClient.simulateContract({
            account: report.arbExecutorOwner,
            address: report.arbExecutor,
            abi: arbExecutorAbi,
            functionName: 'setRouterAllowed',
            args: [router.address, true],
          });
          simulatedSteps.push(`ArbExecutor.setRouterAllowed(${router.name})`);

          if (shouldBroadcast && walletClient && account) {
            const hash = await walletClient.writeContract({
              address: report.arbExecutor,
              abi: arbExecutorAbi,
              functionName: 'setRouterAllowed',
              args: [router.address, true],
            });
            const receipt = await waitForReceipt({ hash });
            if (receipt.status !== 'success') {
              throw new Error(`Arb setRouterAllowed revert untuk ${router.name}: ${hash}`);
            }

            if (record) {
              const routersSet = new Set([...(record.allowedRouters ?? []), router.address]);
              record.allowedRouters = [...routersSet];
            }
          }
        }
      }

      if (shouldBroadcast && record && txHashes.length > 0) {
        registry[report.chain.key] = record;
        await saveDeployments(registry);
      }

      const cooldownKey = `whitelist:${report.chain.key}:${plan.tokensToAllow.map((t) => t.symbol).join(',')}`;
      if (txHashes.length > 0) recentExecutedKeys.add(cooldownKey);

      return {
        action: 'SYNC_WHITELIST',
        chain: report.chain.key,
        simulated: true,
        simulationSuccess: true,
        broadcasted: txHashes.length > 0,
        txHashes,
        explorerUrls,
        summary: txHashes.length > 0
          ? `Berhasil broadcast ${txHashes.length} transaksi whitelist: ${simulatedSteps.join(', ')}`
          : `[SIMULATED] Validasi simulasi berhasil (${simulatedSteps.join(', ')}). Set AUTO_BROADCAST=true untuk kirim on-chain.`,
        timestamp,
      };
    }

    // 2. Handle EXECUTE_FLASHLOAN
    if (decision.action === 'EXECUTE_FLASHLOAN' && decision.flashloanPlan) {
      const plan = decision.flashloanPlan;
      if (!report.flashExecutor || !report.flashExecutorOwner) {
        throw new Error(`FlashLoanExecutor belum tersedia pada chain ${report.chain.key}`);
      }

      await publicClient.simulateContract({
        account: report.flashExecutorOwner,
        address: report.flashExecutor,
        abi: flashLoanExecutorAbi,
        functionName: 'flashLoan',
        args: [plan.token, plan.amount],
      });

      if (shouldBroadcast) {
        if (!walletClient || !account) {
          throw new Error('PRIVATE_KEY valid diperlukan untuk broadcast EXECUTE_FLASHLOAN');
        }
        if (account.address.toLowerCase() !== report.flashExecutorOwner.toLowerCase()) {
          throw new Error(
            `Wallet (${account.address}) bukan owner FlashLoanExecutor (${report.flashExecutorOwner})`,
          );
        }
        const hash = await walletClient.writeContract({
          address: report.flashExecutor,
          abi: flashLoanExecutorAbi,
          functionName: 'flashLoan',
          args: [plan.token, plan.amount],
        });
        const receipt = await waitForReceipt({ hash });
        if (receipt.status !== 'success') {
          throw new Error(`Flashloan transaksi gagal: ${hash}`);
        }


        const registry = await loadDeployments();
        const record = deploymentFor(registry, report.chain.key);
        if (record) {
          const liveTests = Array.isArray(record.liveTests) ? record.liveTests : [];
          record.liveTests = [
            ...liveTests,
            {
              token: plan.symbol,
              amount: plan.amount.toString(),
              formattedAmount: plan.formattedAmount,
              transaction: hash,
              block: Number(receipt.blockNumber),
              gasUsed: Number(receipt.gasUsed),
              status: 'success',
              operator: 'llm-watch',
            },
          ];
          registry[report.chain.key] = record;
          await saveDeployments(registry);
        }
      }

      if (txHashes.length > 0) recentExecutedKeys.add(`flashloan:${report.chain.key}:${plan.symbol}`);

      return {
        action: 'EXECUTE_FLASHLOAN',
        chain: report.chain.key,
        simulated: true,
        simulationSuccess: true,
        broadcasted: txHashes.length > 0,
        txHashes,
        explorerUrls,
        summary: txHashes.length > 0
          ? `Flashloan ${plan.formattedAmount} di ${report.chain.name} terkonfirmasi (${txHashes[0]})`
          : `[SIMULATED] Simulasi flashloan ${plan.formattedAmount} di ${report.chain.name} berhasil.`,
        timestamp,
      };
    }

    // 3. Handle EXECUTE_ARBITRAGE (Supports V2, V3, and Aerodrome)
    if (decision.action === 'EXECUTE_ARBITRAGE' && decision.arbitragePlan) {
      const plan = decision.arbitragePlan;

      if (!report.arbExecutor || !report.arbExecutorOwner) {
        return {
          action: 'EXECUTE_ARBITRAGE',
          chain: report.chain.key,
          simulated: false,
          simulationSuccess: true,
          broadcasted: false,
          txHashes: [],
          explorerUrls: [],
          summary: `[QUOTE-READY] Peluang arbitrase ${plan.loanSymbol}->${plan.intermediateSymbol} ($${plan.expectedNetProfitUsd.toFixed(2)} net, ${plan.spreadBps} bps) terdeteksi. Deploy MorphoAtomicArbPOC dengan: npm run cli -- setup-arb --chain ${report.chain.key} --broadcast`,
          timestamp,
        };
      }

      const profitReceiver = process.env.PROFIT_RECEIVER
        ? (getAddress(process.env.PROFIT_RECEIVER) as Address)
        : report.arbExecutorOwner;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + plan.deadlineSeconds);

      if (plan.autoAllowlistBeforeExec) {
        throw new Error('Allowlist belum siap: sync whitelist sesuai policy, lalu scan ulang sebelum trading');
      }

      const isMultiHop = Boolean(plan.isMultiHop && plan.steps && plan.steps.length >= 2);
      const isPureV2 = !isMultiHop && plan.firstRouterKind === 0 && plan.secondRouterKind === 0;
      const callerAccount = account?.address ?? report.arbExecutorOwner;

      let simulatedProfit = 0n;
      let estimatedGasUnits = 280_000n;
      const mevBundleHashes: string[] = [];
      let mevBundleNote: string | undefined;

      if (isMultiHop && plan.steps) {
        const multiHopStruct = {
          loanToken: plan.loanToken,
          loanAmount: plan.loanAmount,
          steps: plan.steps.map((s) => ({
            hop: {
              router: s.router,
              kind: s.kind,
              fee: s.fee,
              stable: s.stable,
              factory: s.factory,
            },
            tokenOut: s.tokenOut,
            minAmountOut: s.minAmountOut,
          })),
          minProfit: plan.minProfit,
          deadline,
          profitReceiver,
        };

        const simResult = await publicClient.simulateContract({
          account: callerAccount,
          address: report.arbExecutor,
          abi: arbExecutorAbi,
          functionName: 'executeMultiHopArbitrage',
          args: [multiHopStruct],
        });
        simulatedProfit = simResult.result;

        estimatedGasUnits = await publicClient
          .estimateContractGas({
            account: callerAccount,
            address: report.arbExecutor,
            abi: arbExecutorAbi,
            functionName: 'executeMultiHopArbitrage',
            args: [multiHopStruct],
          });

        const priorityFee = await prepareProfitGuard(simulatedProfit, plan.loanDecimals, plan.loanToken,
          estimatedGasUnits, encodeFunctionData({ abi: arbExecutorAbi, functionName: 'executeMultiHopArbitrage', args: [multiHopStruct] }));
        multiHopStruct.minProfit = priorityFee.minProfit;
        // Re-simulate the stricter guard and the exact transaction fee/limit before signing.
        simulatedProfit = (await publicClient.simulateContract({
          account: callerAccount, address: report.arbExecutor, abi: arbExecutorAbi,
          functionName: 'executeMultiHopArbitrage', args: [multiHopStruct], gas: priorityFee.gas,
          maxFeePerGas: priorityFee.maxFeePerGas, maxPriorityFeePerGas: priorityFee.maxPriorityFeePerGas,
        })).result;

        if (shouldBroadcast && walletClient && account && pk) {
          const bundleEnabled = process.env.MEV_BUNDLE_ENABLED === 'true';
          let bundledTxHash: Hash | undefined;
          let bundleMissed = false;

          if (bundleEnabled) {
            const callData = encodeFunctionData({
              abi: arbExecutorAbi,
              functionName: 'executeMultiHopArbitrage',
              args: [multiHopStruct],
            });
            const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
            const signedRawTx = await walletClient.signTransaction({
              account,
              to: report.arbExecutor,
              data: callData,
              gas: priorityFee.gas,
              maxPriorityFeePerGas: priorityFee.maxPriorityFeePerGas,
              maxFeePerGas: priorityFee.maxFeePerGas,
              nonce,
            });
            const targetBlockNumber = await publicClient.getBlockNumber({ cacheTime: 0 }) + 1n;
            const bundleSummary = await submitMevBundleToRelays({
              chainKey: report.chain.key,
              authPrivateKey: resolveBundleAuthKey(process.env.FLASHBOTS_AUTH_KEY, pk),
              bundle: {
                txs: [signedRawTx],
                targetBlockNumber,
              },
            });
            mevBundleHashes.push(...bundleSummary.bundleHashes);
            if (bundleSummary.relaysAttempted > 0 && bundleSummary.relaysAccepted === 0) {
              throw new Error('Relay submission not confirmed; public fallback suppressed to avoid leaking a possibly accepted transaction');
            }

            const bundledHash = bundleTxHash(signedRawTx);
            if (
              shouldWaitForBundle({
                bundleEnabled,
                relaysAttempted: bundleSummary.relaysAttempted,
                relaysAccepted: bundleSummary.relaysAccepted,
              })
            ) {
              // At least one builder now holds this exact signed transaction. Broadcasting it a
              // second time through a public RPC would publish the private route to the mempool —
              // which is the only thing the relay submission was meant to prevent — so the bundled
              // transaction hash is watched directly instead.
              recentExecutedKeys.add(`arb:${plan.candidateId}`);
              const inclusion = await awaitBundleInclusion({
                txHash: bundledHash,
                targetBlockNumber,
                maxBlocks: Number(process.env.MEV_BUNDLE_WAIT_BLOCKS ?? '4'),
                getReceipt: async (txHash) => {
                  const receipt = await publicClient
                    .getTransactionReceipt({ hash: txHash })
                    .catch((error: Error) => { if (error.name === 'TransactionReceiptNotFoundError') return null; throw error; });
                  if (receipt) { collectReceipt(receipt); if (!txHashes.includes(txHash)) { txHashes.push(txHash); explorerUrls.push(`${report.chain.explorer}/tx/${txHash}`); } }
                  return receipt ? { blockNumber: receipt.blockNumber, status: receipt.status } : null;
                },
                getBlockNumber: () => publicClient.getBlockNumber(),
              });
              const decision = resolveBundleBroadcastDecision({
                bundleEnabled,
                relaysAttempted: bundleSummary.relaysAttempted,
                relaysAccepted: bundleSummary.relaysAccepted,
                inclusion: inclusion.status,
              });

              if (decision.countAsFailure) {
                throw new Error(`Transaksi Multi-Hop dalam bundle MEV revert: ${bundledHash}`);
              }

              if (inclusion.status === 'unknown') {
                txHashes.push(bundledHash);
                explorerUrls.push(`${report.chain.explorer}/tx/${bundledHash}`);
                if (recentExecutedKeys instanceof ExecutionCooldown) {
                  recentExecutedKeys.markPending(`arb:${plan.candidateId}`, async () => {
                    await publicClient.getTransactionReceipt({ hash: bundledHash });
                    return true;
                  });
                }
                return { action: 'EXECUTE_ARBITRAGE', chain: report.chain.key, simulated: true,
                  simulationSuccess: true, broadcasted: true, txHashes, explorerUrls, mevBundleHashes,
                  summary: 'Bundle submitted; inclusion and gas cost unknown because receipt/block tracking was inconclusive. Public fallback suppressed.', timestamp };
              }
              if (inclusion.status === 'missed') {
                // Nothing was mined, so nothing was paid for. Re-sending the same nonce publicly
                // would leak the route and still lose the race, so the cycle simply abstains and
                // the next scan re-quotes the opportunity.
                bundleMissed = true;
                mevBundleNote =
                  `bundle target blok ${targetBlockNumber} tidak dimasukkan builder ` +
                  `(${bundleSummary.relaysAccepted} relay menerima, ${inclusion.polls} poll, ` +
                  `blok terakhir ${inclusion.lastSeenBlockNumber})`;
              } else {
                bundledTxHash = bundledHash;
                recentExecutedKeys.add(`arb:${plan.candidateId}`);
                mevBundleNote = `dieksekusi via bundle MEV di blok ${inclusion.receipt.blockNumber}`;
              }
            } else {
              // No relay is holding the transaction, so the public/private-RPC path stays in charge.
              // The wording comes from the same tested decision table as the success/miss branches.
              const fallback = resolveBundleBroadcastDecision({
                bundleEnabled,
                relaysAttempted: bundleSummary.relaysAttempted,
                relaysAccepted: bundleSummary.relaysAccepted,
                inclusion: 'not-checked',
              });
              mevBundleNote =
                `MEV bundle tidak berlaku di ${report.chain.key} ` +
                `(relay dicoba ${bundleSummary.relaysAttempted}, diterima ${bundleSummary.relaysAccepted}): ` +
                `${fallback.reason}`;
            }
          }

          if (bundledTxHash === undefined && !bundleMissed) {
            const hash = await walletClient.writeContract({
              address: report.arbExecutor,
              abi: arbExecutorAbi,
              functionName: 'executeMultiHopArbitrage',
              args: [multiHopStruct],
              gas: priorityFee.gas,
              maxPriorityFeePerGas: priorityFee.maxPriorityFeePerGas,
              maxFeePerGas: priorityFee.maxFeePerGas,
            });
            const receipt = await waitForReceipt({ hash });
            if (receipt.status !== 'success') {
              throw new Error(`Transaksi Multi-Hop arbitrase revert: ${hash}`);
            }

          }

          if (bundleMissed) {
            // Clear the cooldown registered before broadcasting so a missed bundle is retried on
            // the next cycle instead of being skipped for the rest of the daemon's life.
            recentExecutedKeys.delete(`arb:${plan.candidateId}`);
            return {
              action: 'EXECUTE_ARBITRAGE',
              chain: report.chain.key,
              simulated: true,
              simulationSuccess: true,
              broadcasted: false,
              usedPrivateRpc: broadcastRpcInfo.isPrivate,
              ...(mevBundleHashes.length > 0 ? { mevBundleHashes } : {}),
              txHashes,
              explorerUrls,
              summary:
                `[MEV BUNDLE MISS] ${mevBundleNote ?? 'Bundle arbitrase tidak masuk blok target'} — ` +
                `0 gas terpakai dan ${plan.loanSymbol}->${plan.intermediateSymbol} (~$${plan.expectedNetProfitUsd.toFixed(2)} net) ` +
                'dievaluasi ulang dengan quote segar pada siklus berikutnya.',
              timestamp,
            };
          }
        }
      } else if (isPureV2) {
        const v2Struct = {
          loanToken: plan.loanToken,
          intermediateToken: plan.intermediateToken,
          firstRouter: plan.firstRouter,
          secondRouter: plan.secondRouter,
          loanAmount: plan.loanAmount,
          minIntermediateAmount: plan.minIntermediateAmount,
          minFinalAmount: plan.minFinalAmount,
          minProfit: plan.minProfit,
          deadline,
          profitReceiver,
        };

        const simResult = await publicClient.simulateContract({
          account: callerAccount,
          address: report.arbExecutor,
          abi: arbExecutorAbi,
          functionName: 'executeArbitrage',
          args: [v2Struct],
        });
        simulatedProfit = simResult.result;

        estimatedGasUnits = await publicClient
          .estimateContractGas({
            account: callerAccount,
            address: report.arbExecutor,
            abi: arbExecutorAbi,
            functionName: 'executeArbitrage',
            args: [v2Struct],
          });

        const priorityFee = await prepareProfitGuard(simulatedProfit, plan.loanDecimals, plan.loanToken,
          estimatedGasUnits, encodeFunctionData({ abi: arbExecutorAbi, functionName: 'executeArbitrage', args: [v2Struct] }));
        v2Struct.minProfit = priorityFee.minProfit;
        // Re-simulate the stricter guard and the exact transaction fee/limit before signing.
        simulatedProfit = (await publicClient.simulateContract({
          account: callerAccount, address: report.arbExecutor, abi: arbExecutorAbi,
          functionName: 'executeArbitrage', args: [v2Struct], gas: priorityFee.gas,
          maxFeePerGas: priorityFee.maxFeePerGas, maxPriorityFeePerGas: priorityFee.maxPriorityFeePerGas,
        })).result;

        if (shouldBroadcast && walletClient && account) {
          const hash = await walletClient.writeContract({
            address: report.arbExecutor,
            abi: arbExecutorAbi,
            functionName: 'executeArbitrage',
            args: [v2Struct],
            gas: priorityFee.gas,
            maxPriorityFeePerGas: priorityFee.maxPriorityFeePerGas,
            maxFeePerGas: priorityFee.maxFeePerGas,
          });
          const receipt = await waitForReceipt({ hash });
          if (receipt.status !== 'success') {
            throw new Error(`Transaksi arbitrase revert: ${hash}`);
          }

        }
      } else {
        const multiStruct = {
          loanToken: plan.loanToken,
          intermediateToken: plan.intermediateToken,
          firstHop: {
            router: plan.firstRouter,
            kind: plan.firstRouterKind,
            fee: plan.firstRouterFee,
            stable: plan.firstRouterStable,
            factory: plan.firstRouterFactory,
          },
          secondHop: {
            router: plan.secondRouter,
            kind: plan.secondRouterKind,
            fee: plan.secondRouterFee,
            stable: plan.secondRouterStable,
            factory: plan.secondRouterFactory,
          },
          loanAmount: plan.loanAmount,
          minIntermediateAmount: plan.minIntermediateAmount,
          minFinalAmount: plan.minFinalAmount,
          minProfit: plan.minProfit,
          deadline,
          profitReceiver,
        };

        const simResult = await publicClient.simulateContract({
          account: callerAccount,
          address: report.arbExecutor,
          abi: arbExecutorAbi,
          functionName: 'executeMultiDexArbitrage',
          args: [multiStruct],
        });
        simulatedProfit = simResult.result;

        estimatedGasUnits = await publicClient
          .estimateContractGas({
            account: callerAccount,
            address: report.arbExecutor,
            abi: arbExecutorAbi,
            functionName: 'executeMultiDexArbitrage',
            args: [multiStruct],
          });

        const priorityFee = await prepareProfitGuard(simulatedProfit, plan.loanDecimals, plan.loanToken,
          estimatedGasUnits, encodeFunctionData({ abi: arbExecutorAbi, functionName: 'executeMultiDexArbitrage', args: [multiStruct] }));
        multiStruct.minProfit = priorityFee.minProfit;
        // Re-simulate the stricter guard and the exact transaction fee/limit before signing.
        simulatedProfit = (await publicClient.simulateContract({
          account: callerAccount, address: report.arbExecutor, abi: arbExecutorAbi,
          functionName: 'executeMultiDexArbitrage', args: [multiStruct], gas: priorityFee.gas,
          maxFeePerGas: priorityFee.maxFeePerGas, maxPriorityFeePerGas: priorityFee.maxPriorityFeePerGas,
        })).result;

        if (shouldBroadcast && walletClient && account) {
          const hash = await walletClient.writeContract({
            address: report.arbExecutor,
            abi: arbExecutorAbi,
            functionName: 'executeMultiDexArbitrage',
            args: [multiStruct],
            gas: priorityFee.gas,
            maxPriorityFeePerGas: priorityFee.maxPriorityFeePerGas,
            maxFeePerGas: priorityFee.maxFeePerGas,
          });
          const receipt = await waitForReceipt({ hash });
          if (receipt.status !== 'success') {
            throw new Error(`Transaksi Multi-DEX arbitrase revert: ${hash}`);
          }

        }
      }

      const formattedProfit = formatUnits(simulatedProfit, plan.loanDecimals);
      return {
        action: 'EXECUTE_ARBITRAGE',
        chain: report.chain.key,
        simulated: true,
        simulationSuccess: true,
        broadcasted: shouldBroadcast,
        usedPrivateRpc: broadcastRpcInfo.isPrivate,
        ...(mevBundleHashes.length > 0 ? { mevBundleHashes } : {}),
        txHashes,
        explorerUrls,
        realizedGrossProfit,
        simulatedGrossProfit: formattedProfit,
        executionGasCostNative,
        summary: shouldBroadcast
          ? `Arbitrase ${plan.loanSymbol}->${plan.intermediateSymbol} berhasil dieksekusi (${broadcastRpcInfo.isPrivate ? 'Private MEV RPC' : 'Standard RPC'})! Confirmed gross profit: ${realizedGrossProfit ?? 'unavailable (event missing)'} ${plan.loanSymbol}${mevBundleNote ? ` [MEV: ${mevBundleNote}]` : ''}`
          : `[SIMULATED] Simulasi arbitrase berhasil! Profit on-chain: ${formattedProfit} ${plan.loanSymbol} (~$${plan.expectedNetProfitUsd.toFixed(2)} net).`,
        timestamp,
      };
    }

    // 4. Handle EXECUTE_LIQUIDATION (Morpho Blue Atomic Liquidation)
    if (decision.action === 'EXECUTE_LIQUIDATION' && decision.liquidationPlan) {
      const plan = decision.liquidationPlan;

      if (!report.arbExecutor || !report.arbExecutorOwner) {
        return {
          action: 'EXECUTE_LIQUIDATION',
          chain: report.chain.key,
          simulated: false,
          simulationSuccess: true,
          broadcasted: false,
          txHashes: [],
          explorerUrls: [],
          summary: `[LIQUIDATION-READY] Posisi tidak sehat (HF=${plan.healthFactor}) terdeteksi untuk ${plan.borrower.slice(0, 10)}… (est. net +$${plan.expectedNetProfitUsd.toFixed(2)}). Deploy MorphoAtomicArbPOC terlebih dahulu untuk mengeksekusi.`,
          timestamp,
        };
      }

      const profitReceiver = process.env.PROFIT_RECEIVER
        ? (getAddress(process.env.PROFIT_RECEIVER) as Address)
        : report.arbExecutorOwner;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + plan.deadlineSeconds);
      const callerAccount = account?.address ?? report.arbExecutorOwner;

      const liqStruct = {
        marketParams: {
          loanToken: plan.loanToken,
          collateralToken: plan.collateralToken,
          oracle: plan.oracle,
          irm: plan.irm,
          lltv: plan.lltv,
        },
        borrower: plan.borrower,
        seizedAssets: plan.seizedAssets,
        repaidShares: 0n,
        collateralSwapHop: {
          router: plan.swapRouter,
          kind: plan.swapRouterKind,
          fee: plan.swapRouterFee,
          stable: plan.swapRouterStable,
          factory: plan.swapRouterFactory,
        },
        minLoanTokenOut: plan.minLoanTokenOut,
        minProfit: plan.minProfit,
        deadline,
        profitReceiver,
      };

      const simResult = await publicClient.simulateContract({
        account: callerAccount,
        address: report.arbExecutor,
        abi: arbExecutorAbi,
        functionName: 'executeLiquidation',
        args: [liqStruct],
      });

      let simulatedProfit = simResult.result;
      const formattedProfit = formatUnits(simulatedProfit, plan.loanDecimals);

      const gasEstimate = await publicClient.estimateContractGas({ account: callerAccount, address: report.arbExecutor,
        abi: arbExecutorAbi, functionName: 'executeLiquidation', args: [liqStruct] });
      const priorityFee = await prepareProfitGuard(simulatedProfit, plan.loanDecimals, plan.loanToken,
        gasEstimate, encodeFunctionData({ abi: arbExecutorAbi, functionName: 'executeLiquidation', args: [liqStruct] }));
      liqStruct.minProfit = priorityFee.minProfit;
      simulatedProfit = (await publicClient.simulateContract({ account: callerAccount, address: report.arbExecutor,
        abi: arbExecutorAbi, functionName: 'executeLiquidation', args: [liqStruct], gas: priorityFee.gas,
        maxFeePerGas: priorityFee.maxFeePerGas, maxPriorityFeePerGas: priorityFee.maxPriorityFeePerGas })).result;

      if (shouldBroadcast && walletClient && account) {
        const hash = await walletClient.writeContract({
          address: report.arbExecutor,
          abi: arbExecutorAbi,
          functionName: 'executeLiquidation',
          args: [liqStruct],
          gas: priorityFee.gas,
          maxPriorityFeePerGas: priorityFee.maxPriorityFeePerGas,
          maxFeePerGas: priorityFee.maxFeePerGas,
        });
        const receipt = await waitForReceipt({ hash });
        if (receipt.status !== 'success') {
          throw new Error(`Transaksi likuidasi revert: ${hash}`);
        }

      }

      return {
        action: 'EXECUTE_LIQUIDATION',
        chain: report.chain.key,
        simulated: true,
        simulationSuccess: true,
        broadcasted: shouldBroadcast,
        usedPrivateRpc: broadcastRpcInfo.isPrivate,
        priorityFeeGwei: priorityFee.priorityFeeGwei,
        txHashes,
        explorerUrls,
        realizedGrossProfit,
        simulatedGrossProfit: formattedProfit,
        executionGasCostNative,
        summary: shouldBroadcast
          ? `Likuidasi posisi ${plan.borrower.slice(0, 10)}… berhasil! Confirmed gross profit: ${realizedGrossProfit ?? 'unavailable (event missing)'} ${plan.loanSymbol}`
          : `[SIMULATED] Simulasi likuidasi berhasil! Confirmed gross profit: ${realizedGrossProfit ?? 'unavailable (event missing)'} ${plan.loanSymbol} (~$${plan.expectedNetProfitUsd.toFixed(2)} net).`,
        timestamp,
      };
    }

    return {
      action: decision.action,
      chain: report.chain.key,
      simulated: false,
      simulationSuccess: false,
      broadcasted: false,
      txHashes: [],
      explorerUrls: [],
      summary: 'Tidak ada rencana eksekusi yang valid pada keputusan.',
      timestamp,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return {
      action: decision.action,
      chain: report.chain.key,
      simulated: true,
      simulationSuccess: false,
      broadcasted: txHashes.length > 0,
      txHashes,
      explorerUrls,
      summary: `Simulasi/Eksekusi dibatalkan oleh on-chain guard: ${errMsg}`,
      error: errMsg,
      timestamp,
    };
  }
}

/** Reserve the full signed gas budget, not the stale scanner's nominal 280k units. */
export function buildNetProfitGuard(params: {
  simulatedProfit: bigint; decimals: number; tokenPriceUsd: number; nativePriceUsd: number;
  gasPriceWei: bigint; estimatedGas: bigint; extraFeeWei: bigint; minProfitUsd: number;
  profitBribeBps: number; maxPriorityFeeGwei: number; maxGasGwei: number;
}) {
  for (const value of [params.tokenPriceUsd, params.nativePriceUsd, params.minProfitUsd, params.maxGasGwei,
    params.profitBribeBps, params.maxPriorityFeeGwei]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid profit/fee input');
  }
  if (params.tokenPriceUsd <= 0 || params.nativePriceUsd <= 0 || params.estimatedGas <= 0n || params.extraFeeWei < 0n) throw new Error('Missing price/gas estimate');
  const gas = (params.estimatedGas * 150n + 99n) / 100n;
  const grossUsd = Number(formatUnits(params.simulatedProfit, params.decimals)) * params.tokenPriceUsd;
  const fee = computeDynamicPriorityFee({ baseGasPriceWei: params.gasPriceWei, estimatedGasUnits: gas,
    nativePriceUsd: params.nativePriceUsd, expectedGrossProfitUsd: grossUsd,
    minProfitUsd: params.minProfitUsd + Number(formatUnits(params.extraFeeWei, 18)) * params.nativePriceUsd,
    profitBribeBps: params.profitBribeBps, maxPriorityFeeGwei: params.maxPriorityFeeGwei });
  const cap = parseGwei(String(params.maxGasGwei));
  const maxFeePerGas = fee.maxFeePerGas < cap ? fee.maxFeePerGas : cap;
  if (maxFeePerGas < params.gasPriceWei + fee.maxPriorityFeePerGas) throw new Error('Fee cap too low for current gas and priority fee');
  const feeUsd = Number(formatUnits(gas * maxFeePerGas + params.extraFeeWei, 18)) * params.nativePriceUsd;
  const minProfit = parseUnits(((params.minProfitUsd + feeUsd) / params.tokenPriceUsd).toFixed(params.decimals), params.decimals) + 1n;
  if (!Number.isFinite(grossUsd) || params.simulatedProfit < minProfit) throw new Error('Latest simulation does not cover net profit plus total fee reserve');
  return { ...fee, maxFeePerGas, gas, minProfit, feeReserveUsd: feeUsd };
}
