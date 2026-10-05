import { ExecutionCooldown } from './cooldown.js';
import { getAddress, parseUnits } from 'viem';
import { evmChains, type EvmChainConfig } from '../config/chains.js';
import { getRoutersForChain } from '../config/dex-routers.js';
import {
  deploymentFor,
  loadDeployments,
  loadStablecoins,
  type Address,
  type DeploymentRecord,
  type StablecoinRegistry,
} from '../config/registry.js';
import {
  evaluateArbitrageQuote,
  scanChainOpportunities,
  type ChainOpportunityReport,
  type TokenWhitelistState,
} from '../morpho/dex-scanner.js';
import {
  getAtRiskWatchlist,
  loadWatchlistFromDisk,
} from '../morpho/liquidation-scanner.js';
import { scanMorphoBalances, type ScannedAsset } from '../morpho/scanner.js';
import { color, renderTable, ui } from '../ui/index.js';
import { executeOperatorDecision } from './executor.js';
import {
  evaluateWithLlmOperator,
  loadLlmOperatorConfig,
  type LlmOperatorConfig,
  type OperatorMode,
} from './llm-operator.js';
import {
  appendAuditLog,
  sendOperatorAlert,
  type OperatorAuditEntry,
} from './logger.js';
import {
  startOperatorServer,
  type OperatorRuntimeState,
} from './server.js';
import { startTelegramBotController } from './telegram.js';
import { startMultiChainWsListeners, type WsBlockListenerHandle } from './ws-listener.js';

const PUBLIC_RPC_FALLBACKS: Record<string, string> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  base: 'https://mainnet.base.org',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://mainnet.optimism.io',
};

export type WatchDaemonOptions = {
  chains?: string[];
  intervalSec?: number;
  minimumUsd?: number;
  maxPriceAgeHours?: number;
  arbLoanUsd?: number;
  minProfitUsd?: number;
  maxSlippageBps?: number;
  mode?: OperatorMode;
  autoBroadcast?: boolean;
  whitelistAutoSync?: boolean;
  flashloanOnWhitelist?: boolean;
  targetWhitelistSymbols?: string[];
  httpPort?: number;
  once?: boolean;
  json?: boolean;
};

export function resolveChainRpc(chain: EvmChainConfig): string | undefined {
  return (
    process.env[chain.rpcEnv] ??
    chain.readRpcFallbacks?.[0] ??
    PUBLIC_RPC_FALLBACKS[chain.key]
  );
}

const KNOWN_WETH_ADDRESSES: Record<string, Address> = {
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  base: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  optimism: '0x4200000000000000000000000000000000000006',
};

function buildOfflineRegistryReport(params: {
  chain: EvmChainConfig;
  record: DeploymentRecord;
  stablecoins: StablecoinRegistry;
  arbLoanUsd: number;
  minProfitUsd: number;
  maxSlippageBps: number;
  rpcWarning: string;
}): ChainOpportunityReport {
  const { chain, record, stablecoins, arbLoanUsd, minProfitUsd, maxSlippageBps, rpcWarning } = params;
  const nowSec = Math.floor(Date.now() / 1000);
  const flashExecutor = record.executor ? (getAddress(record.executor) as Address) : undefined;
  const arbExecutor = record.arbExecutor ? (getAddress(record.arbExecutor) as Address) : undefined;
  const allowedSymbols = new Set((record.allowedAssets ?? []).map((s) => s.toUpperCase()));

  const chainStables = stablecoins[chain.key] ?? {};
  const syntheticAssets: ScannedAsset[] = [];

  for (const [symbol, meta] of Object.entries(chainStables)) {
    const addr = getAddress(meta.address) as Address;
    const balance = parseUnits('1500000', meta.decimals);
    syntheticAssets.push({
      address: addr,
      symbol,
      decimals: meta.decimals,
      balance,
      formattedBalance: '1500000',
      priceUsd: 1.0,
      priceTimestamp: nowSec,
      priceSource: 'morpho-api',
      usdValue: 1_500_000,
      eligible: true,
      sources: ['local-stablecoin-registry'],
    });
  }

  const wethAddress = KNOWN_WETH_ADDRESSES[chain.key];
  if (wethAddress) {
    syntheticAssets.push({
      address: wethAddress,
      symbol: 'WETH',
      decimals: 18,
      balance: parseUnits('600', 18),
      formattedBalance: '600',
      priceUsd: 2500.0,
      priceTimestamp: nowSec,
      priceSource: 'morpho-api',
      usdValue: 1_500_000,
      eligible: true,
      sources: ['morpho-market-loan'],
    });
  }

  const tokenWhitelists: TokenWhitelistState[] = syntheticAssets.map((asset) => {
    const allowedOnFlash = allowedSymbols.has(asset.symbol.toUpperCase());
    return {
      symbol: asset.symbol,
      address: asset.address,
      decimals: asset.decimals,
      usdValue: asset.usdValue,
      priceUsd: asset.priceUsd,
      balance: asset.balance,
      formattedBalance: asset.formattedBalance,
      allowedOnFlashExecutor: allowedOnFlash,
      allowedOnArbExecutor: allowedOnFlash,
      matchesPolicyTarget: true,
      needsFlashWhitelist: Boolean(flashExecutor && !allowedOnFlash),
      needsArbWhitelist: Boolean(arbExecutor && !allowedOnFlash),
    };
  });

  const routers = getRoutersForChain(chain.key);
  const routerWhitelists = routers.map((r) => ({
    name: r.name,
    address: r.address,
    protocol: r.protocol,
    kind: r.kind,
    feeBps: r.feeBps,
    hasBytecode: true,
    allowedOnArbExecutor: Boolean(arbExecutor),
    needsArbWhitelist: false,
  }));

  const arbitrageCandidates = [];
  if (routers.length >= 2 && syntheticAssets.length >= 2) {
    const loanAsset = syntheticAssets[0];
    const interAsset = syntheticAssets[1];
    const v3OrAeroRouter = routers.find((r) => r.kind !== 0) ?? routers[1];
    const loanAmount = parseUnits(String(Math.round(arbLoanUsd)), loanAsset.decimals);
    const interAmount = parseUnits(String((arbLoanUsd / (interAsset.priceUsd ?? 2500)).toFixed(6)), interAsset.decimals);
    // Simulate a realistic 18 bps positive spread across V3/Aerodrome -> V2 and -12 bps on reverse
    const finalPositive = (loanAmount * 10_018n) / 10_000n;
    const finalNegative = (loanAmount * 9_988n) / 10_000n;
    const gasUsd = chain.key === 'ethereum' ? 2.4 : 0.03;

    arbitrageCandidates.push(
      evaluateArbitrageQuote({
        chainKey: chain.key,
        loanAsset,
        intermediateAsset: interAsset,
        firstRouter: v3OrAeroRouter,
        secondRouter: routers[0],
        loanAmount,
        loanAmountUsd: arbLoanUsd,
        intermediateOut: interAmount,
        finalOut: finalPositive,
        gasCostUsd: gasUsd,
        minProfitUsd,
        maxSlippageBps,
        tokensWhitelistedOnArb: true,
        routersWhitelistedOnArb: true,
      }),
      evaluateArbitrageQuote({
        chainKey: chain.key,
        loanAsset,
        intermediateAsset: interAsset,
        firstRouter: routers[0],
        secondRouter: v3OrAeroRouter,
        loanAmount,
        loanAmountUsd: arbLoanUsd,
        intermediateOut: interAmount,
        finalOut: finalNegative,
        gasCostUsd: gasUsd,
        minProfitUsd,
        maxSlippageBps,
        tokensWhitelistedOnArb: true,
        routersWhitelistedOnArb: true,
      }),
    );
    arbitrageCandidates.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  }

  return {
    chain,
    blockNumber: BigInt(Number(record.deploymentBlock ?? 50_000_000) + 120),
    gasPriceWei: chain.key === 'ethereum' ? 8_000_000_000n : 20_000_000n,
    gasPriceGwei: chain.key === 'ethereum' ? '8.0' : '0.02',
    nativePriceUsd: 2500,
    flashExecutor,
    flashExecutorOwner: '0x1111111111111111111111111111111111111111',
    flashExecutorPaused: false,
    arbExecutor,
    arbExecutorOwner: '0x1111111111111111111111111111111111111111',
    arbExecutorPaused: false,
    tokenWhitelists,
    routerWhitelists,
    whitelistedAssets: tokenWhitelists.filter((t) => t.allowedOnFlashExecutor),
    pendingWhitelistAssets: tokenWhitelists.filter((t) => t.needsFlashWhitelist || t.needsArbWhitelist),
    pendingWhitelistRouters: [],
    arbitrageCandidates,
    profitableCandidates: arbitrageCandidates.filter((c) => c.profitable),
    liquidationCandidates: [],
    profitableLiquidations: [],
    warnings: [`offline-rpc-simulation: ${rpcWarning.split('\n')[0]}`],
  };
}

function printCycleReport(
  report: ChainOpportunityReport,
  entry: OperatorAuditEntry,
): void {
  const { decision, outcome } = entry;
  ui.section(
    `${report.chain.name.toUpperCase()} • BLOCK ${report.blockNumber} • GAS ${Number(report.gasPriceGwei).toFixed(3)} GWEI`,
  );

  console.log(
    `${color.dim('Whitelisted:')} ${color.green(report.whitelistedAssets.map((a) => a.symbol).join(', ') || 'none')}  ` +
      `${color.dim('Pending Whitelist:')} ${color.yellow(report.pendingWhitelistAssets.map((a) => a.symbol).join(', ') || 'none')}`,
  );

  if (report.arbitrageCandidates.length > 0) {
    console.log(
      renderTable(
        [
          { title: 'ROUTE' },
          { title: 'DEX A -> DEX B' },
          { title: 'LOAN USD', align: 'right' },
          { title: 'SPREAD', align: 'right' },
          { title: 'GAS USD', align: 'right' },
          { title: 'NET USD', align: 'right' },
          { title: 'STATUS' },
        ],
        report.arbitrageCandidates.slice(0, 5).map((cand) => [
          color.yellow(`${cand.loanSymbol}->${cand.intermediateSymbol}`),
          color.cyan(`${cand.firstRouterName} -> ${cand.secondRouterName}`),
          color.white(`$${Math.round(cand.loanAmountUsd).toLocaleString('en-US')}`),
          cand.spreadBps >= 0
            ? color.green(`+${cand.spreadBps} bps`)
            : color.dim(`${cand.spreadBps} bps`),
          color.dim(`$${cand.estimatedGasCostUsd.toFixed(4)}`),
          cand.profitable
            ? color.bold(color.green(`+$${cand.netProfitUsd.toFixed(2)}`))
            : color.dim(`$${cand.netProfitUsd.toFixed(2)}`),
          cand.profitable ? color.green('PROFITABLE') : color.dim('MONITOR'),
        ]),
      ),
    );
  } else {
    console.log(color.dim('Tidak ada pasangan rute DEX V2 yang dievaluasi pada chain ini.'));
  }

  const actionColor =
    decision.action === 'EXECUTE_ARBITRAGE'
      ? color.green
      : decision.action === 'SYNC_WHITELIST'
        ? color.cyan
        : decision.action === 'EXECUTE_FLASHLOAN'
          ? color.magenta
          : color.yellow;

  console.log(
    `\n${color.bold('LLM Decision:')} ${actionColor(decision.action)} ` +
      `${color.dim(`(${decision.source} • model=${decision.model} • conf=${(decision.confidence * 100).toFixed(0)}% • ${decision.latencyMs}ms)`)}`,
  );
  console.log(`${color.dim('Reasoning:')} ${color.white(decision.reasoning)}`);
  console.log(
    `${color.dim('Outcome:')} ${
      outcome.simulationSuccess ? color.green(outcome.summary) : color.red(outcome.summary)
    }`,
  );
  for (const url of outcome.explorerUrls) {
    console.log(`${color.green('✓ TX:')} ${color.cyan(url)}`);
  }
}

export async function runWatchDaemon(options: WatchDaemonOptions = {}): Promise<void> {
  const intervalSec =
    options.intervalSec ?? Number(process.env.WATCH_INTERVAL_SEC ?? '30');
  const minimumUsd =
    options.minimumUsd ?? Number(process.env.MIN_LIQUIDITY_USD ?? '100000');
  const maxPriceAgeHours =
    options.maxPriceAgeHours ?? Number(process.env.MAX_PRICE_AGE_HOURS ?? '24');
  const arbLoanUsd =
    options.arbLoanUsd ?? Number(process.env.ARB_LOAN_USD ?? '10000');
  const maxSlippageBps =
    options.maxSlippageBps ?? Number(process.env.MAX_SLIPPAGE_BPS ?? '30');
  const httpPort =
    options.httpPort !== undefined
      ? options.httpPort
      : Number(process.env.WATCH_HTTP_PORT ?? '3000');

  const targetWhitelistSymbols =
    options.targetWhitelistSymbols ??
    (process.env.WHITELIST_TARGETS
      ? process.env.WHITELIST_TARGETS.split(',').map((s) => s.trim()).filter(Boolean)
      : []);

  const llmConfig: LlmOperatorConfig = loadLlmOperatorConfig({
    mode: options.mode,
    autoBroadcast: options.autoBroadcast,
    whitelistAutoSync: options.whitelistAutoSync,
    flashloanOnWhitelist: options.flashloanOnWhitelist,
    minProfitUsd: options.minProfitUsd,
  });

  const requestedChainKeys =
    options.chains?.length
      ? options.chains
      : process.env.WATCH_CHAINS
        ? process.env.WATCH_CHAINS.split(',').map((s) => s.trim()).filter(Boolean)
        : ['base', 'arbitrum', 'ethereum'];

  const selectedChains = evmChains.filter(
    (c) => requestedChainKeys.includes(c.key) || requestedChainKeys.includes(String(c.chainId)),
  );
  if (selectedChains.length === 0) {
    throw new Error(`Tidak ada chain valid untuk diawasi dari daftar: ${requestedChainKeys.join(', ')}`);
  }

  const maxConsecutiveFailures = Number(process.env.MAX_CONSECUTIVE_FAILURES ?? '3');
  const recentExecutedKeys = new ExecutionCooldown(Number(process.env.EXECUTION_COOLDOWN_MS ?? '60000'));
  const runtimeState: OperatorRuntimeState = {
    startedAt: new Date().toISOString(),
    running: true,
    cycleRunning: false,
    cycleCount: 0,
    consecutiveFailures: 0,
    circuitBreakerTripped: false,
    lastCycleAt: null,
    nextCycleAt: null,
    chains: selectedChains.map((c) => c.key),
    intervalSec,
    minimumUsd,
    arbLoanUsd,
    config: llmConfig,
    latestReports: {},
    recentHistory: [],
    errors: [],
  };

  const executeSingleCycle = async (): Promise<void> => {
    if (runtimeState.cycleRunning) return;
    runtimeState.cycleRunning = true;
    runtimeState.cycleCount += 1;
    const cycleNum = runtimeState.cycleCount;

    try {
      const [deployments, stablecoins] = await Promise.all([
        loadDeployments(),
        loadStablecoins(),
      ]);

      await recentExecutedKeys.reconcile();
      for (const chain of selectedChains) {
        if (!runtimeState.running) break;
        const record = deploymentFor(deployments, chain.key);
        const rpc = resolveChainRpc(chain);
        if (!record?.morpho || !rpc) {
          runtimeState.errors.unshift({
            chain: chain.key,
            message: !record?.morpho ? 'Morpho address belum terdaftar' : `${chain.rpcEnv} belum diisi`,
            timestamp: new Date().toISOString(),
          });
          runtimeState.errors = runtimeState.errors.slice(0, 30);
          continue;
        }

        try {
          const morphoAddr = getAddress(record.morpho) as Address;
          const flashExecutor = record.executor
            ? (getAddress(record.executor) as Address)
            : undefined;
          const arbExecutor = record.arbExecutor
            ? (getAddress(record.arbExecutor) as Address)
            : undefined;

          let report: ChainOpportunityReport;
          try {
            const scanResult = await scanMorphoBalances({
              chain,
              morpho: morphoAddr,
              rpcUrl: rpc,
              stablecoins,
              minimumUsd,
              maxPriceAgeHours,
            });

            report = await scanChainOpportunities({
              chain,
              rpcUrl: rpc,
              assets: scanResult.assets,
              flashExecutor,
              arbExecutor,
              targetWhitelistSymbols,
              arbLoanUsd,
              minProfitUsd: runtimeState.config.minProfitUsd,
              maxSlippageBps,
            });
          } catch (rpcErr) {
            if (
              runtimeState.config.autoBroadcast ||
              process.env.SIMULATION_OFFLINE_FALLBACK !== 'true'
            ) {
              throw rpcErr;
            }
            const rpcWarning = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
            report = buildOfflineRegistryReport({
              chain,
              record,
              stablecoins,
              arbLoanUsd,
              minProfitUsd: runtimeState.config.minProfitUsd,
              maxSlippageBps,
              rpcWarning,
            });
          }

          runtimeState.latestReports[chain.key] = report;

          const decision = await evaluateWithLlmOperator(
            report,
            runtimeState.config,
            recentExecutedKeys,
          );

          const outcome = await executeOperatorDecision({
            decision,
            report,
            config: runtimeState.config,
            rpcUrl: rpc,
            recentExecutedKeys,
          });

          if (outcome.simulated) {
            if (!outcome.simulationSuccess) {
              runtimeState.consecutiveFailures += 1;
              if (
                runtimeState.consecutiveFailures >= maxConsecutiveFailures &&
                runtimeState.config.autoBroadcast
              ) {
                runtimeState.config.autoBroadcast = false;
                runtimeState.circuitBreakerTripped = true;
                ui.warning(
                  `[CIRCUIT BREAKER] ${runtimeState.consecutiveFailures} kegagalan simulasi/eksekusi berturut-turut! AUTO_BROADCAST dinonaktifkan otomatis demi keamanan gas.`,
                );
              }
            } else {
              runtimeState.consecutiveFailures = 0;
            }
          }

          const topRoute = report.arbitrageCandidates[0];
          const auditEntry: OperatorAuditEntry = {
            cycle: cycleNum,
            chain: chain.key,
            blockNumber: report.blockNumber.toString(),
            gasPriceGwei: report.gasPriceGwei,
            whitelistedCount: report.whitelistedAssets.length,
            pendingWhitelistCount:
              report.pendingWhitelistAssets.length + report.pendingWhitelistRouters.length,
            profitableRoutesCount: report.profitableCandidates.length,
            bestRouteSummary: topRoute
              ? `${topRoute.loanSymbol}->${topRoute.intermediateSymbol} (${topRoute.spreadBps} bps, net $${topRoute.netProfitUsd.toFixed(2)})`
              : undefined,
            decision,
            outcome,
            timestamp: new Date().toISOString(),
          };

          runtimeState.recentHistory.unshift(auditEntry);
          runtimeState.recentHistory = runtimeState.recentHistory.slice(0, 50);

          await appendAuditLog(auditEntry);
          await sendOperatorAlert(auditEntry);

          if (!options.json) {
            printCycleReport(report, auditEntry);
          }
        } catch (chainErr) {
          const msg = chainErr instanceof Error ? chainErr.message : String(chainErr);
          runtimeState.errors.unshift({
            chain: chain.key,
            message: msg,
            timestamp: new Date().toISOString(),
          });
          runtimeState.errors = runtimeState.errors.slice(0, 30);
          if (!options.json) {
            ui.warning(`[${chain.key}] Gagal siklus watch: ${msg}`);
          }
        }
      }
    } finally {
      runtimeState.cycleRunning = false;
      runtimeState.lastCycleAt = new Date().toISOString();
      runtimeState.nextCycleAt = new Date(Date.now() + intervalSec * 1000).toISOString();
    }
  };

  const applyConfigPatch = (
    patch: Partial<{
      mode: OperatorMode;
      autoBroadcast: boolean;
      minProfitUsd: number;
      resetCircuitBreaker: boolean;
    }>,
  ): void => {
    if (patch.mode) runtimeState.config.mode = patch.mode;
    if (patch.autoBroadcast !== undefined) {
      runtimeState.config.autoBroadcast = patch.autoBroadcast;
    }
    if (patch.minProfitUsd !== undefined) {
      runtimeState.config.minProfitUsd = patch.minProfitUsd;
    }
    if (patch.resetCircuitBreaker) {
      runtimeState.circuitBreakerTripped = false;
      runtimeState.consecutiveFailures = 0;
    }
  };

  await loadWatchlistFromDisk();

  let httpServer: Awaited<ReturnType<typeof startOperatorServer>> | undefined;
  if (!options.once && httpPort > 0) {
    try {
      httpServer = await startOperatorServer(httpPort, {
        getState: () => {
          runtimeState.atRiskWatchlist = getAtRiskWatchlist();
          if (wsListener) runtimeState.wsStatuses = wsListener.getStatuses();
          return runtimeState;
        },
        triggerNow: () => executeSingleCycle(),
        updateConfig: applyConfigPatch,
      });
      if (!options.json) {
        ui.success(
          `VPS Operator HTTP Dashboard & Health API aktif di ${color.cyan(`http://0.0.0.0:${httpPort}`)}`,
        );
      }
    } catch (err) {
      if (!options.json) {
        ui.warning(
          `HTTP server pada port ${httpPort} dilewati: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  let wsListener: WsBlockListenerHandle | undefined;
  if (!options.once && process.env.WSS_STREAM_ENABLED !== 'false') {
    wsListener = startMultiChainWsListeners({
      chains: selectedChains,
      morphoAddresses: Object.fromEntries(Object.entries(await loadDeployments())
        .filter(([, value]) => typeof value.morpho === 'string' && value.morpho)
        .map(([key, value]) => [key, value.morpho as Address])),
      onChainTrigger: (_chain, _source) => {
        if (!runtimeState.cycleRunning && runtimeState.running) {
          void executeSingleCycle().catch(err => { ui.warning(`Watch cycle: ${String(err)}`); });
        }
      },
    });
    runtimeState.wsStatuses = wsListener.getStatuses();
    const configuredWsChains = Object.values(runtimeState.wsStatuses)
      .filter((s) => s.wssUrlConfigured)
      .map((s) => s.chain);
    if (configuredWsChains.length > 0 && !options.json) {
      ui.success(
        `Event-Driven WebSocket Block/Event Listener aktif untuk: ${color.cyan(configuredWsChains.join(', '))}`,
      );
    }
  }

  let tgController: { stop: () => void } | undefined;
  if (!options.once && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    tgController = startTelegramBotController({
      getState: () => runtimeState,
      triggerNow: () => executeSingleCycle(),
      updateConfig: applyConfigPatch,
    });
    if (!options.json) {
      ui.success('Telegram Two-Way Bot Controller aktif (menerima perintah /menu, /status, /scan, /mode, /broadcast, /ask)');
    }
  }

  if (!options.json) {
    ui.info(
      `Memulai LLM Watch Operator [mode=${color.magenta(runtimeState.config.mode)}, broadcast=${
        runtimeState.config.autoBroadcast ? color.red('LIVE') : color.yellow('SIMULATION')
      }, model=${color.cyan(runtimeState.config.model)}, chains=${color.yellow(
        selectedChains.map((c) => c.key).join(','),
      )}]`,
    );
  }

  if (options.once) {
    await executeSingleCycle();
    if (options.json) {
      console.log(
        JSON.stringify(
          runtimeState,
          (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
          2,
        ),
      );
    }
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  let wakeSleep: (() => void) | undefined;
  const shutdown = (signal: string): void => {
    if (!runtimeState.running) return;
    runtimeState.running = false;
    if (!options.json) {
      ui.info(`Menerima sinyal ${signal}, menghentikan VPS LLM Operator dengan aman...`);
    }
    if (timer) clearTimeout(timer);
    wakeSleep?.();
    if (wsListener) {
      wsListener.stop();
    }
    if (httpServer) {
      httpServer.close();
    }
    if (tgController) {
      tgController.stop();
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Run initial cycle in background so HTTP server responds immediately, then schedule loop
  await executeSingleCycle();

  while (runtimeState.running) {
    await new Promise<void>((resolve) => {
      wakeSleep = resolve;
      timer = setTimeout(resolve, intervalSec * 1000);
    });
    if (!runtimeState.running) break;
    await executeSingleCycle();
  }
}
