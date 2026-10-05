# Morpho Tools — TypeScript CLI, Multi-DEX Scanner & Autonomous LLM Operator

TypeScript toolkit for scanning Morpho Blue liquidity, quoting Multi-DEX (V2, Uniswap V3, Aerodrome/Velodrome) arbitrage spreads, scanning Morpho Blue liquidations, deploying/syncing executor contracts, and running an **Autonomous VPS LLM Watch Operator & Executor** with a **Two-Way Telegram Bot Controller** and **Live Web Dashboard**.

## Source Structure

```text
src/
├── cli.ts                      interactive & non-interactive CLI entrypoint
├── agent/
│   ├── llm-operator.ts         OpenAI-compatible LLM decision engine + <1ms Fast-Path engine
│   ├── llm-operator.test.ts    unit tests for LLM operator, fast-path, and mode guards
│   ├── executor.ts             on-chain simulator, MEV priority fee calculator & broadcaster
│   ├── watcher.ts              continuous VPS watch daemon & circuit breaker
│   ├── server.ts               HTTP Health API & Live Operator Dashboard (0.0.0.0:3000)
│   ├── telegram.ts             two-way Telegram Bot controller (long-polling + inline buttons)
│   ├── telegram.test.ts        unit tests for Telegram command parser & authorization guard
│   └── logger.ts               JSONL audit logger + Telegram/Webhook alert sender
├── commands/
│   ├── compile-contracts.ts    embedded solc compiler for Solidity contracts
│   ├── dry-run.ts              auditable no-broadcast plan generator
│   ├── status.ts               RPC configuration status checker
│   └── watch.ts                standalone VPS daemon entrypoint (npm run watch / npm run agent)
├── config/
│   ├── chains.ts               chain metadata & RPC environment variable mappings
│   ├── dex-routers.ts          verified V2, Uniswap V3, and Aerodrome/Velodrome routers
│   ├── env.ts                  tools/.env loader
│   └── registry.ts             deployment, token, and contract artifact paths
├── morpho/
│   ├── scanner.ts              Morpho GraphQL discovery + Multicall3 on-chain balance scanner
│   ├── scanner.test.ts         USD threshold tests
│   ├── dex-scanner.ts          whitelist diff checker, Multi-DEX quoter & loan tier optimizer
│   ├── dex-scanner.test.ts     unit tests for Multi-DEX quotes, slippage & optimal sizing
│   ├── liquidation-scanner.ts  Morpho Blue unhealthy position & LIF calculator
│   ├── plan.ts                 auditable Morpho no-op flashloan plan
│   └── guards.ts               exact-principal repayment guards
└── ui/
    └── index.ts                terminal table & banner renderer
```

## Common Commands

```bash
# Interactive menu
npm run cli

# Check configured chains & executors
npm run cli -- chains

# Scan Morpho Blue liquidity across all configured chains
npm run cli -- scan-all --min-usd 100000

# Scan Multi-DEX arbitrage quotes & whitelist status on a chain
npm run cli -- arb-scan --chain base --loan-usd 10000 --min-profit-usd 5

# Scan Morpho Blue liquidation candidates + pre-liquidation watchlist on a chain
npm run cli -- liq-scan --chain base --max-hf 1.05 --min-profit-usd 5

# Read the persisted at-risk watchlist only (no RPC/quote scan, safe for cron)
npm run cli -- liq-scan --at-risk [--chain base] [--json]

# Compile Solidity contracts using the embedded solc compiler
npm run compile:contracts

# Start the continuous VPS LLM Watch Daemon + HTTP Dashboard (0.0.0.0:3000)
npm run watch

# Run TypeScript typecheck & unit tests
npm run build
npm test
```

## Security & Secrets

- Store RPC URLs, `PRIVATE_KEY`, `LLM_API_KEY`, and `TELEGRAM_BOT_TOKEN` exclusively in `tools/.env` (`chmod 600 .env`).
- Never commit private keys or API secrets to `deployments.json`, command history, logs, or documentation.

### Safety and upgrade notes

- Set a strong `OPERATOR_API_TOKEN` before using the dashboard. Every `/api/*` route now
  requires `Authorization: Bearer …`, including status/watchlist reads. An empty token
  denies API access. Enter the token in the dashboard; it stays in page memory, not
  local storage. Use HTTPS or an SSH tunnel outside localhost. Public status DTOs omit
  LLM credentials and endpoint URLs.
- Trading never auto-whitelists. `WHITELIST_AUTO_SYNC=true` permits a separate admin
  action; a subsequent fresh scan must confirm all tokens/routers are allowed.
- Live trades re-simulate with a minimum profit that reserves the signed gas limit and
  maximum gas price, plus estimated rollup fees. Currently the fee models support
  Ethereum, Base/Optimism and Arbitrum; unverified models fail closed. Fee reserves and
  simulations are not guarantees of inclusion or profit under changing chain state.
- Liquidation discovery is only a source of borrower IDs. Candidates require current
  on-chain market/oracle/debt data (after transient interest accrual), fresh USD prices,
  and an actual collateral-to-loan quote. Stale watchlist entries expire after five minutes.
- Custom V3 routers need `quoterAddress`; Aerodrome needs `factoryAddress` and the correct
  `aeroStable`; Curve needs `curveCoins` matching its encoded index direction. Only the
  `exchange(int128,int128,uint256,uint256)` Curve interface is supported. Invalid
  adapters fail closed rather than being treated as V2.
- `EXECUTION_COOLDOWN_MS` defaults to 60000. Simulations and pre-submission failures do
  not lock routes. Public pending transactions remain locked until receipt reconciliation,
  including after receipt timeouts. Locks are process-local: do not run multiple trading
  instances for the same wallet, and inspect pending nonces before restarting.
- Relay acceptance requires a valid bundle hash. A configured relay attempt without
  confirmed acceptance does not fall back publicly. Stalled block tracking/receipt RPC
  errors are **unknown**, not proof of zero gas spent. Unknown accepted bundles retain
  their route lock; check the chain before restarting to clear an unresolved lock.
  `MEV_BUNDLE_RELAYS` applies only to Ethereum; use `<CHAIN>_MEV_BUNDLE_RELAYS` elsewhere.
- Transaction hashes are retained before receipt waits. `realizedGrossProfit` comes from
  executor receipt events; `simulatedGrossProfit` is only a simulation.
  `executionGasCostNative` is receipt execution gas, not total net P&L or all L2 charges.
- `SIMULATION_OFFLINE_FALLBACK=false` is the default. Opt-in synthetic examples are
  explicitly unvalidated and can never be broadcast.
- **Both Solidity executors changed and require new deployments.** Existing deployed
  bytecode does not receive these fixes. Deployment commands compile current sources
  before reading artifacts. Deploy deliberately, verify addresses/allowlists, then
  update the registry before enabling live trading. No automatic migration is performed.
- Docker uses port 3000 inside the container; change `WATCH_HOST_PORT` for the host.

Local validation: `npm run build`, `npm test`, `npm run compile:contracts`, and
`npm audit` from `tools/`; `forge test` from `evm/` for local EVM regression tests.
These tests use mocks and do not replace a live-chain fork/integration review.
