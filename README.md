

# ⚡ EVM-LOAN-TOOLKIT — Morpho Blue Multichain Flashloan, Multi-DEX Arbitrage & Autonomous LLM Operator

A full-stack EVM toolkit for **Morpho Blue** featuring:
- **Multichain Liquidity Discovery & Verification Scanner** (Morpho GraphQL API + DefiLlama fallback + on-chain Multicall3 `balanceOf(Morpho)` verification).
- **Zero-Protocol-Fee Atomic Flashloan Executor** (`FlashLoanExecutor.sol`, deployed and live-verified across 10 EVM networks).
- **Multi-DEX Atomic Arbitrage & Liquidation Contract** (`MorphoAtomicArbPOC.sol`, supporting **Uniswap V2 / Sushi V2 / BaseSwap / Camelot V2**, **Uniswap V3 Legacy & SwapRouter02**, **Aerodrome / Velodrome**, and **Morpho Blue Liquidations**).
- **Autonomous VPS Watch Daemon & LLM Operator** (OpenAI-compatible LLM decision engine + `<1ms` Fast-Path Execution + Multi-Tier Optimal Loan Sizing + MEV-Protected RPC & Dynamic Priority Fee Bribe Calculator).
- **Two-Way Telegram Bot Controller & Real-Time Web Dashboard** for remote VPS monitoring and control.

> **Mainnet Safety Notice:** Commands running with `--broadcast` or `AUTO_BROADCAST=true` submit real on-chain transactions. Always use a dedicated hot wallet with limited funds, set `PROFIT_RECEIVER` to your cold wallet, and never commit your `.env` or private keys.

---

## ✅ Feature Matrix

| Component | Status | Details |
|---|---|---|
| Morpho Blue Liquidity Scanner | **Active** | Discovers market assets, reads live `balanceOf(Morpho)` via Multicall3, verifies fresh USD prices |
| Zero-Fee Flashloan Executor (`FlashLoanExecutor.sol`) | **Active** | Live & verified across 10 EVM chains with strict token allowlists and exact-principal repayment invariants |
| Multi-DEX Quote Scanner & Parabolic/Analytical Sizing | **Active** | Quotes V2 (`getAmountsOut`), Uniswap V3 (`QuoterV2`), Aerodrome/Velodrome, and Curve (`get_dy`) across a 5-point Golden-Section grid (`15%..300%`) + parabolic vertex interpolation & closed-form V2 reserve sizing |
| Multi-DEX, Direct Pool & Multi-Hop Arbitrage (`MorphoAtomicArbPOC.sol`) | **Active** | Supports 2-leg & N-hop triangular routes (`executeMultiHopArbitrage`) across `V2`, `V3_LEGACY`, `V3_ROUTER02`, `AERODROME`, `CURVE`, and `V3_DIRECT_POOL` with gas-saving pre-approvals (`_ensureAllowance`) |
| Morpho Blue Auto-Indexer, Watchlist & Liquidation Executor | **Active** | Auto-indexes borrowers from Morpho Blue GraphQL + on-chain `Borrow` logs, maintains a Pre-Liquidation Watchlist (`1.00 <= HF <= 1.12`), and executes `onMorphoLiquidate` |
| Event-Driven WebSocket (`wss://`) & Base Flashblocks Stream | **Active** | Real-time `watchBlockNumber` & Morpho event subscriptions (`ws-listener.ts`) including 200ms Base Flashblocks pre-confirmations |
| VPS LLM Watch Operator + `<1ms` Fast-Path Engine | **Active** | Combines sub-millisecond Fast-Path execution for profitable routes with an OpenAI-compatible LLM Operator |
| Native Flashbots / Builder Bundles & Dynamic Priority Fee | **Active** | EIP-191 signed `eth_sendBundle` fanout to Flashbots, Titan, Beaverbuild, & Rsync (`mev-bundle.ts`) + Private Tx RPCs & EIP-1559 profit-share bribes |
| Two-Way Telegram Bot Controller & Web Dashboard | **Active** | Interactive Telegram inline keyboard (`/menu`, `/status`, `/scan`, `/mode`, `/broadcast`, `/ask`) + HTTP UI on port `3000` |
| Embedded `solc` Contract Compiler | **Active** | Pre-built artifacts in `evm/out/` + `npm run compile:contracts` (no Foundry installation required on VPS) |

---

## 🗂️ Repository Structure

```text
flash/
├── README.md
├── Dockerfile                  # Production container image for VPS deployment
├── docker-compose.yml          # One-command Docker Compose runner with healthcheck
├── deploy/
│   ├── vps-setup.sh            # Automated Ubuntu/Debian VPS bootstrap script
│   ├── ecosystem.config.cjs    # PM2 process manager configuration
│   └── morpho-llm-operator.service # Linux systemd unit file
├── docs/
│   ├── VPS-LLM-OPERATOR.md     # Complete guide for VPS LLM Operator & Telegram Bot
│   ├── CONTRACTS-AND-VAULTS.md # Morpho Blue singleton, IRM, Oracle, and Vault registry
│   ├── DEPLOYMENT-CHECK.md     # Activation gate & verification rules
│   ├── EVM-RPCS.md             # ChainList & RPC endpoint references
│   └── MORPHO-SCAN.md          # Baseline liquidity scan metrics across 10 chains
├── evm/
│   ├── src/
│   │   ├── FlashLoanExecutor.sol       # Minimal zero-fee flashloan executor
│   │   └── poc/
│   │       ├── MorphoAtomicArbPOC.sol  # Multi-DEX atomic arbitrage & liquidation executor
│   │       └── DexSwapInterfaces.sol   # Standard V2, V3, Universal, Aero, Curve, Balancer ABIs
│   ├── script/Deploy.s.sol             # Foundry deployment scripts (Deploy & DeployArb)
│   ├── test/                           # Foundry test suites
│   ├── out/                            # Pre-compiled ABI & bytecode artifacts
│   ├── deployments.json                # Multichain contract & live-test registry
│   └── stablecoins.json                # Seed token metadata per chain
└── tools/
    ├── .env.example                    # Complete environment variable template
    ├── package.json
    └── src/
        ├── cli.ts                      # Interactive & non-interactive CLI entrypoint
        ├── agent/
        │   ├── llm-operator.ts         # OpenAI-compatible LLM Operator + Fast-Path engine
        │   ├── executor.ts             # On-chain simulator, MEV priority fee calculator & broadcaster
        │   ├── mev-bundle.ts           # Native EIP-191 Flashbots / Titan / Beaverbuild bundle sender
        │   ├── ws-listener.ts          # Real-time WebSocket (wss://) block, Flashblocks & event stream
        │   ├── watcher.ts              # Continuous VPS watch daemon & circuit breaker
        │   ├── server.ts               # Real-time HTTP Dashboard, Watchlist & Health API (0.0.0.0:3000)
        │   ├── telegram.ts             # Two-way Telegram Bot controller (long-polling)
        │   └── logger.ts               # JSONL audit logger & webhook/Telegram alert sender
        ├── commands/
        │   ├── watch.ts                # Standalone VPS daemon entrypoint
        │   ├── compile-contracts.ts    # Embedded solc compiler for Solidity contracts
        │   ├── dry-run.ts              # Auditable no-broadcast loan plan generator
        │   └── status.ts               # Chain RPC configuration status checker
        ├── config/
        │   ├── chains.ts               # 10 EVM chain configurations & read RPC fallbacks
        │   ├── dex-routers.ts          # Verified V2, Uniswap V3 & Aerodrome/Velodrome routers
        │   ├── env.ts                  # .env loader
        │   └── registry.ts             # Paths & helpers for deployments.json and artifacts
        ├── morpho/
        │   ├── scanner.ts              # Morpho GraphQL + DefiLlama + Multicall3 balance scanner
        │   ├── dex-scanner.ts          # Multi-DEX quote scanner, whitelist diff & tier optimizer
        │   ├── liquidation-scanner.ts  # Morpho Blue unhealthy position & LIF calculator
        │   ├── guards.ts               # Zero-fee repayment guards
        │   └── plan.ts                 # Dry-run plan builder
        └── ui/index.ts                 # Terminal table & banner renderer
```

---

## 🌐 Supported EVM Networks

| Network | Chain ID | Morpho Blue Singleton | `FlashLoanExecutor` Status |
|---|---:|---|---|
| **Ethereum** | `1` | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | Live & Flashloan Verified |
| **Base** | `8453` | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | Live & Flashloan Verified |
| **Arbitrum One** | `42161` | `0x6c247b1F6182318877311737BaC0844bAa518F5e` | Live & Flashloan Verified |
| **OP Mainnet** | `10` | `0xce95AfbB8EA029495c66020883F87aaE8864AF92` | Live & Flashloan Verified |
| **Robinhood Chain** | `4663` | `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010` | Live & Flashloan Verified |
| **HyperEVM** | `999` | `0x68e37dE8d93d3496ae143F2E900490f6280C57cD` | Live & Flashloan Verified |
| **Stable** | `988` | `0xa40103088A899514E3fe474cD3cc5bf811b1102e` | Live & Flashloan Verified |
| **Monad** | `143` | `0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee` | Live & Flashloan Verified |
| **Tempo** | `4217` | `0x10EE9AAC980A180dd4DcFc96C746d60B0EA88f97` | Live & Flashloan Verified |
| **Katana** | `747474` | `0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc` | Live & Flashloan Verified |

---

## 🛠️ Quick Start & Installation

### 1. Prerequisites
- **Linux / macOS / WSL2** with Git.
- **Node.js 20+ LTS** and `npm`.
- *(Optional)* **Foundry** (`forge`, `cast`, `anvil`) for running Solidity unit tests locally. Note: `tools` includes an embedded `solc` compiler (`npm run compile:contracts`), so Foundry is not strictly required on your VPS to compile or deploy contracts.

### 2. Install Dependencies & Configure `.env`

```bash
cd tools
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `tools/.env` with your RPC endpoints, wallet private key, LLM API credentials, and optional Telegram Bot token:

```dotenv
# 1. Wallet & Chain RPCs
PRIVATE_KEY=0xYOUR_64_HEX_PRIVATE_KEY
ETHEREUM_RPC_URL=https://...
BASE_RPC_URL=https://...
ARBITRUM_RPC_URL=https://...
OPTIMISM_RPC_URL=https://...

# 2. OpenAI-Compatible LLM Operator (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, vLLM)
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-YOUR_API_KEY
LLM_MODEL=gpt-4o-mini

# 3. Operator Mode & Safety Policies
# Modes: dry-run | whitelist-only | flashloan | arbitrage | liquidation | full
OPERATOR_MODE=dry-run
AUTO_BROADCAST=false
WATCH_CHAINS=base,arbitrum,ethereum
WATCH_INTERVAL_SEC=30
WATCH_HTTP_PORT=3000
FAST_PATH_ENABLED=true
ARB_LOAN_USD=10000
MIN_PROFIT_USD=5
MAX_SLIPPAGE_BPS=30
MAX_GAS_GWEI=50
PROFIT_BRIBE_BPS=1500
MAX_PRIORITY_FEE_GWEI=15

# 4. Two-Way Telegram Bot Controller (Optional)
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
TELEGRAM_CHAT_ID=987654321
```

### 3. Build, Compile Contracts & Run Tests

```bash
cd tools
npm run compile:contracts
npm run build
npm test
```

---

## 💻 CLI Reference

Run interactive mode from `tools/`:

```bash
npm run cli
```

Interactive Menu Options:
- `1 LIQUIDITY SCAN` — Scan Morpho Blue markets and verify live on-chain token balances.
- `2 EXECUTOR SETUP` — Deploy `FlashLoanExecutor` or sync token allowlists.
- `3 RUN FLASHLOAN` — Execute an atomic zero-fee flashloan.
- `4 LLM WATCH OPERATOR` — Start the autonomous VPS watch daemon & HTTP dashboard.
- `5 ARB EXECUTOR SETUP` — Deploy or sync `MorphoAtomicArbPOC` (Multi-DEX Arbitrage & Liquidation executor).

### Liquidity & Multi-DEX Opportunity Scanning

```bash
# Check configured chains and deployed executors
npm run cli -- chains

# Scan Morpho Blue liquidity on a single chain or across multiple chains
npm run cli -- scan --chain base --min-usd 100000
npm run cli -- scan-all --chains ethereum,base,arbitrum --min-usd 100000

# Scan whitelist status + Multi-DEX (V2, V3, Aerodrome) arbitrage spreads & optimal loan tiers
npm run cli -- arb-scan --chain base --loan-usd 10000 --min-profit-usd 5
```

### Deploying & Syncing Executors

```bash
# Preview or broadcast token allowlist sync on FlashLoanExecutor
npm run cli -- setup --chain base --select USDC,WETH --plan
npm run cli -- setup --chain base --select USDC,WETH --broadcast --yes

# Deploy or sync MorphoAtomicArbPOC (Multi-DEX Arbitrage & Liquidation contract)
npm run cli -- setup-arb --chain base --select USDC,WETH --broadcast --yes
```

### Running Atomic Flashloans

```bash
# Borrow by token units or target USD value
npm run cli -- flashloan --chain base --asset WETH --amount 40
npm run cli -- flashloan --chain arbitrum --asset WETH --amount '$100000'
npm run cli -- flashloan --chain base --asset USDC --amount 100000 --broadcast --yes
```

---

## 🤖 Autonomous VPS LLM Watch Operator & Executor

The watch daemon (`npm run watch` or `npm run cli -- watch`) continuously monitors target chains and orchestrates both **Fast-Path Execution** and **LLM Operator Decision-Making**:

```bash
# Start continuous daemon + Web Dashboard on http://0.0.0.0:3000
npm run watch

# Run a single evaluation cycle (ideal for testing or cron jobs)
npm run cli -- watch --chains base,arbitrum --mode full --once

# Run in live production mode with automatic on-chain broadcast after simulation passes
npm run cli -- watch --chains base,arbitrum --mode full --interval 15 --broadcast
```

### How the Hybrid Fast-Path + LLM Architecture Works

1. **Multichain Liquidity & Whitelist Scan**:
   - Reads live ERC-20 balances held by the Morpho Blue singleton contract via Multicall3 and checks `allowedToken` / `allowedRouter` states on `FlashLoanExecutor` and `MorphoAtomicArbPOC`.
2. **Multi-DEX Quote & Optimal Loan Sizing**:
   - Quotes round-trip swaps across **Uniswap V2 / SushiSwap V2 / BaseSwap / Camelot V2**, **Uniswap V3 (`QuoterV2` 5bps & 30bps)**, and **Aerodrome / Velodrome** across multiple loan tiers (`25%`, `100%`, `250%` of `ARB_LOAN_USD`), selecting the loan size that maximizes **net USD profit after gas**.
3. **Morpho Blue Liquidation Scan**:
   - Queries borrower positions with `healthFactor < 1.0`, computes the Morpho Blue Liquidation Incentive Factor ($\text{LIF} = \min(1.15, \frac{1}{1 - 0.3(1 - \text{lltv})})$), and evaluates collateral-to-loan swap profitability.
4. **Sub-Millisecond Fast-Path + OpenAI-Compatible LLM Operator**:
   - When `FAST_PATH_ENABLED=true` and a profitable arbitrage or liquidation opportunity passes all deterministic guards (`netProfitUsd >= MIN_PROFIT_USD` and `gasPrice <= MAX_GAS_GWEI`), the **Fast-Path Engine** triggers simulation and execution in **`<1ms`** without waiting for HTTP LLM latency.
   - For whitelist synchronization (`SYNC_WHITELIST`), flashloan verification (`EXECUTE_FLASHLOAN`), market monitoring (`HOLD`), and interactive Q&A, the **LLM Operator** evaluates the structured on-chain JSON state and returns an auditable decision with confidence scores and reasoning.
   - If the LLM API is unreachable or rate-limited, `LLM_FALLBACK_DETERMINISTIC=true` seamlessly falls back to the deterministic rule engine so the VPS daemon never halts.
5. **Mandatory On-Chain Simulation, MEV Protection & Circuit Breaker**:
   - Every transaction must pass `publicClient.simulateContract(...)` on the latest block before signing.
   - Supports private broadcast endpoints (`PRIVATE_TX_RPC_URL` / `ETHEREUM_PRIVATE_RPC_URL`) and dynamic EIP-1559 priority fees (`PROFIT_BRIBE_BPS`).
   - If `MAX_CONSECUTIVE_FAILURES` (default `3`) simulations or broadcasts fail in a row, the **Circuit Breaker** automatically trips and disables `autoBroadcast` to protect wallet gas.

---

## 📱 Two-Way Telegram Bot Controller

Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `tools/.env` to receive instant execution alerts **and** control your VPS daemon directly from Telegram (uses outbound `getUpdates` long-polling—no SSL certificate, domain, or open inbound port required):

| Command / Inline Button | Description |
|---|---|
| `/menu` or `/start` | Opens the interactive inline keyboard control panel |
| `/status` | Displays daemon status, active mode, circuit breaker state, LLM model, uptime, and last decision |
| `/scan` or `/trigger` | Triggers an immediate multichain scan & LLM evaluation cycle |
| `/whitelist` | Lists whitelisted vs. pending allowlist tokens per chain |
| `/arb` or `/quotes` | Displays top Multi-DEX arbitrage spreads, gas estimates, and net USD profit |
| `/history` | Shows the 5 most recent operator decisions and execution outcomes |
| `/mode <mode>` | Switches operator mode (`dry-run`, `whitelist-only`, `flashloan`, `arbitrage`, `liquidation`, `full`) |
| `/broadcast on` / `off` | Enables or disables live on-chain transaction broadcasting (and resets the circuit breaker) |
| `/profit <usd>` | Updates `MIN_PROFIT_USD` dynamically (e.g., `/profit 15`) |
| `/ask <question>` | Ask the LLM Operator any question about live on-chain conditions in natural language |

---

## 🚀 Deploying to a VPS (Systemd, PM2, Docker)

### Option 1: Automated VPS Bootstrap Script (Ubuntu / Debian)
```bash
./deploy/vps-setup.sh
```

### Option 2: PM2 Process Manager
```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.cjs
pm2 logs morpho-llm-operator
pm2 save && pm2 startup
```

### Option 3: Linux Systemd Service
```bash
sudo cp deploy/morpho-llm-operator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morpho-llm-operator
sudo journalctl -u morpho-llm-operator -f
```

### Option 4: Docker & Docker Compose
```bash
docker compose up -d --build
docker compose logs -f
```

### Viewing & Interacting with the CLI on a VPS

1. **Interactive CLI Menu via SSH** (can be run at any time even while the background watch daemon is running):
   ```bash
   cd ~/flash/tools
   npm run cli
   ```
2. **Stream Live Daemon CLI Tables in Background Mode**:
   - **PM2:** `pm2 logs morpho-llm-operator --lines 100` or `pm2 monit`
   - **Systemd:** `sudo journalctl -u morpho-llm-operator -f -n 100`
   - **Docker:** `docker compose logs -f` (or `docker compose exec morpho-llm-operator npm run cli`)
3. **Persistent Interactive Terminal with `tmux`**:
   ```bash
   tmux new -s flash
   cd ~/flash/tools && npm run watch
   # Detach with: Ctrl+B then D
   # Re-attach anytime with: tmux attach -t flash
   ```
4. **Securely View the Live Web Dashboard (`Port 3000`) via SSH Tunnel**:
   ```bash
   ssh -L 3000:127.0.0.1:3000 user@YOUR_VPS_IP
   # Then open http://localhost:3000 in your local browser
   ```

Full VPS & Operator documentation is available in [`docs/VPS-LLM-OPERATOR.md`](docs/VPS-LLM-OPERATOR.md).

---

## 📜 Smart Contracts Overview

### 1. `FlashLoanExecutor.sol` (`evm/src/FlashLoanExecutor.sol`)
Minimal, zero-protocol-fee Morpho Blue flashloan executor deployed across 10 EVM networks:
- `flashLoan(address token, uint256 assets)`: Borrows `assets` from Morpho Blue, verifies callback authenticity and token allowlist, approves exact principal repayment, and enforces `balanceAfter == balanceBefore`.
- `setTokenAllowed(address token, bool allowed)` / `setPaused(bool value)` / `rescueToken(...)`: Owner-only administrative controls.

### 2. `MorphoAtomicArbPOC.sol` (`evm/src/poc/MorphoAtomicArbPOC.sol`)
Multi-DEX atomic arbitrage and liquidation executor with owner + delegated VPS `operator` access control (`onlyOwnerOrOperator`):
- `executeArbitrage(ArbitrageParams)`: Classic 2-hop V2-compatible atomic flashloan arbitrage.
- `executeMultiDexArbitrage(MultiDexArbitrageParams)`: Cross-DEX atomic flashloan arbitrage supporting `RouterKind.V2` (`0`), `RouterKind.V3_LEGACY` (`1`), `RouterKind.V3_ROUTER02` (`2`), `RouterKind.AERODROME` (`3`), `RouterKind.CURVE` (`4`), and `RouterKind.V3_DIRECT_POOL` (`5`).
- `executeMultiHopArbitrage(MultiHopArbitrageParams)`: Arbitrary N-hop (triangular or multi-step, 2 to 5 hops) atomic flashloan arbitrage returning to `loanToken`.
- `executeLiquidation(LiquidationParams)`: Atomic Morpho Blue liquidation (`IMorpho.liquidate` + `onMorphoLiquidate`) that swaps seized collateral into the loan token, repays Morpho, enforces `profit >= minProfit`, and transfers realized profit to `profitReceiver`.
- `setRouterPreApproval` & `batchSetRouterPreApprovals` + `_ensureAllowance`: Skips redundant ERC-20 `approve()` `SSTORE` operations during flashloan execution when allowance is already sufficient, saving ~25,000–50,000 gas per transaction.
- `uniswapV3SwapCallback`: Enables direct swaps against Uniswap V3 liquidity pools (`RouterKind.V3_DIRECT_POOL`) without paying periphery router overhead.
- `setOperator(address newOperator)`: Allows the contract `owner` (cold wallet) to authorize a dedicated VPS hot wallet as `operator`.

---

## 📚 Additional Documentation

- [`docs/VPS-LLM-OPERATOR.md`](docs/VPS-LLM-OPERATOR.md) — VPS Daemon, LLM Operator, Telegram Bot & HTTP API Guide
- [`docs/CONTRACTS-AND-VAULTS.md`](docs/CONTRACTS-AND-VAULTS.md) — Official Morpho Blue Singleton, IRM, Oracle & Vault Addresses
- [`docs/DEPLOYMENT-CHECK.md`](docs/DEPLOYMENT-CHECK.md) — Mainnet Readiness & Verification Policy
- [`docs/MORPHO-SCAN.md`](docs/MORPHO-SCAN.md) — Multichain Liquidity Scan Baseline
- [`evm/poc/DEX-SWAP-ABI-MAP.md`](evm/poc/DEX-SWAP-ABI-MAP.md) — DEX Router ABI Reference (V2, V3, Universal Router, Aerodrome, Balancer, Curve)

---

## 💸 Donate

If this project helped your research or operations, you can support development at:

- **BTC:** `bc1pe5eee5eq34czkp2c08uqrdd8d296h8mf04fttwl53aw9pz9n6d0qkmukzm`
- **ETH:** `0xE022E11cA86eFd2Aaa75A482B431738b2f45b3d5`
- **SOL:** `GmkNNLK6dVPAoT3YdbKUXNbANEfHTaEL7NGAsvABZCQJ`
