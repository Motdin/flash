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
