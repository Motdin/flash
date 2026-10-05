# 🤖 VPS LLM Watch Operator, Multi-DEX Executor & Telegram Controller Guide

This guide explains the architecture, configuration, and deployment of the **Autonomous VPS LLM Watch Operator & Executor** for **Morpho Blue** across EVM networks using:
- **CLI Watch Daemon** (`npm run watch` / `npm run cli -- watch`)
- **Linux Systemd Service** (`deploy/morpho-llm-operator.service`)
- **PM2 Process Manager** (`deploy/ecosystem.config.cjs`)
- **Docker & Docker Compose** (`Dockerfile` & `docker-compose.yml`)
- **Two-Way Telegram Bot Controller** (`tools/src/agent/telegram.ts`)
- **Live HTTP Control Dashboard & Health API** (`http://<vps-ip>:3000`)

---

## 1. End-to-End Execution Pipeline

On every watch cycle (`WATCH_INTERVAL_SEC`, default `30` seconds), the daemon executes the following pipeline across each chain listed in `WATCH_CHAINS`:

1. **Morpho Blue Liquidity Scan (`tools/src/morpho/scanner.ts`)**:
   - Discovers market loan and collateral assets from the Morpho GraphQL API and `evm/stablecoins.json`.
   - Reads live on-chain `balanceOf(Morpho)` via Multicall3 and validates fresh USD prices (Morpho API with DefiLlama fallback).
2. **On-Chain Whitelist Diff & Multi-DEX Quote Scan (`tools/src/morpho/dex-scanner.ts`)**:
   - Reads `allowedToken(address)` on `FlashLoanExecutor` and `allowedToken` / `allowedRouter` on `MorphoAtomicArbPOC`.
   - Identifies eligible assets and routers that are already whitelisted (`whitelistedAssets`) vs. those pending on-chain registration (`pendingWhitelistAssets` / `pendingWhitelistRouters`).
   - Quotes round-trip arbitrage swaps across **Uniswap V2 / SushiSwap V2 / BaseSwap / Camelot V2**, **Uniswap V3 (`QuoterV2` 5bps & 30bps)**, and **Aerodrome / Velodrome (Volatile & Stable pools)** across multiple loan tiers (`25%`, `100%`, `250%` of `ARB_LOAN_USD`), automatically selecting the loan size that maximizes **net USD profit after gas** (`selectOptimalArbitrageTier`).
3. **Morpho Blue Liquidation Scan (`tools/src/morpho/liquidation-scanner.ts`)**:
   - Queries borrower positions with `healthFactor < 1.0`, calculates the Morpho Blue Liquidation Incentive Factor ($\text{LIF} = \min(1.15, \frac{1}{1 - 0.3(1 - \text{lltv})})$), and evaluates collateral-to-loan DEX swap profitability.
4. **Hybrid `<1ms` Fast-Path + OpenAI-Compatible LLM Operator (`tools/src/agent/llm-operator.ts`)**:
   - **Fast-Path Execution (`FAST_PATH_ENABLED=true`)**: When a time-sensitive `EXECUTE_ARBITRAGE` or `EXECUTE_LIQUIDATION` candidate passes all hard guards (`netProfitUsd >= MIN_PROFIT_USD` and `gasPrice <= MAX_GAS_GWEI`), the sub-millisecond Fast-Path Engine triggers on-chain simulation and execution immediately without waiting for HTTP LLM latency.
   - **LLM Operator**: Evaluates the complete on-chain state via any OpenAI-compatible `/chat/completions` endpoint and returns a structured JSON decision (`HOLD`, `SYNC_WHITELIST`, `EXECUTE_ARBITRAGE`, `EXECUTE_LIQUIDATION`, or `EXECUTE_FLASHLOAN`) with confidence scores, risk assessment, and reasoning.
   - **Deterministic Fallback (`LLM_FALLBACK_DETERMINISTIC=true`)**: If the LLM API is unreachable or times out, the daemon automatically falls back to `deterministic-guard-v1` so VPS operations continue uninterrupted.
5. **Hard On-Chain Guardrails, MEV Protection & Circuit Breaker (`tools/src/agent/executor.ts`)**:
   - Validates all token and router addresses against the verified registry (preventing LLM address hallucination).
   - Verifies native gas balance (`MIN_NATIVE_GAS_BALANCE`) and gas price cap (`MAX_GAS_GWEI`).
   - **Mandatory Simulation**: Every contract call (`setTokenAllowed`, `setRouterAllowed`, `flashLoan`, `executeArbitrage`, `executeMultiDexArbitrage`, `executeLiquidation`) must pass `publicClient.simulateContract(...)` on the latest block before signing.
   - **Dynamic Priority Fee (Bribe)**: Allocates `PROFIT_BRIBE_BPS` (default `1500` = 15% of surplus profit, capped at `MAX_PRIORITY_FEE_GWEI`) to EIP-1559 `maxPriorityFeePerGas` while preserving `minProfitUsd`.
   - **Private MEV Relay**: Routes live broadcasts through `PRIVATE_TX_RPC_URL` or `<CHAIN>_PRIVATE_RPC_URL` (e.g., Flashbots Protect / MEV Blocker) when configured.
   - **Native Bundle Path (`MEV_BUNDLE_ENABLED=true`)**: Signs the multi-hop transaction once, submits it via `eth_sendBundle`, and — only when at least one relay accepts — watches that bundled hash for `MEV_BUNDLE_WAIT_BLOCKS` (default `4`) blocks instead of re-broadcasting it publicly. If no builder includes it, the cycle reports `[MEV BUNDLE MISS]` (0 gas, no circuit-breaker strike, cooldown released so the next scan re-quotes). Chains with no configured relay keep the previous broadcast path and say so in the summary.
   - **Circuit Breaker (`MAX_CONSECUTIVE_FAILURES=3`)**: Automatically disables `autoBroadcast` if 3 consecutive simulations or broadcasts fail.

---

## 2. Environment Configuration (`tools/.env`)

Copy `tools/.env.example` to `tools/.env` and restrict file permissions:

```bash
cd tools
cp .env.example .env
chmod 600 .env
```

### Supported OpenAI-Compatible LLM Providers

- **OpenAI**:
  ```dotenv
  LLM_BASE_URL=https://api.openai.com/v1
  LLM_API_KEY=sk-...
  LLM_MODEL=gpt-4o-mini
  ```
- **OpenRouter (Claude / Gemini / DeepSeek / Llama)**:
  ```dotenv
  LLM_BASE_URL=https://openrouter.ai/api/v1
  LLM_API_KEY=sk-or-v1-...
  LLM_MODEL=openai/gpt-4o-mini
  ```
- **DeepSeek API**:
  ```dotenv
  LLM_BASE_URL=https://api.deepseek.com/v1
  LLM_API_KEY=sk-...
  LLM_MODEL=deepseek-chat
  ```
- **Groq (Ultra-Fast Inference)**:
  ```dotenv
  LLM_BASE_URL=https://api.groq.com/openai/v1
  LLM_API_KEY=gsk_...
  LLM_MODEL=llama-3.3-70b-versatile
  ```
- **Local Ollama on VPS**:
  ```dotenv
  LLM_BASE_URL=http://127.0.0.1:11434/v1
  LLM_API_KEY=ollama
  LLM_MODEL=qwen2.5:7b
  ```

### Operator Modes (`OPERATOR_MODE`)

| Mode | Whitelist Sync | Flashloan Exec | Arbitrage Exec | Liquidation Exec | On-Chain Broadcast |
|---|:---:|:---:|:---:|:---:|:---:|
| `dry-run` | Simulated | Simulated | Simulated | Simulated | Never |
| `whitelist-only` | Allowed | Blocked | Blocked | Blocked | If `AUTO_BROADCAST=true` |
| `flashloan` | Allowed | Allowed | Blocked | Blocked | If `AUTO_BROADCAST=true` |
| `arbitrage` | Allowed | Blocked | Allowed | Blocked | If `AUTO_BROADCAST=true` |
| `liquidation` | Allowed | Blocked | Blocked | Allowed | If `AUTO_BROADCAST=true` |
| `full` | Allowed | Allowed | Allowed | Allowed | If `AUTO_BROADCAST=true` |

---

## 3. Running on a Linux VPS

### Option A: Automated VPS Setup Script
```bash
./deploy/vps-setup.sh
```

### Option B: Direct CLI / Cron
```bash
cd tools
# Start continuous watch daemon + HTTP dashboard on port 3000
npm run watch

# Run a single evaluation cycle and exit
npm run cli -- watch --chains base,arbitrum --mode full --once

# Run standalone Multi-DEX arbitrage & whitelist scan
npm run cli -- arb-scan --chain base --loan-usd 10000 --min-profit-usd 5

# Run a standalone Morpho liquidation / pre-liquidation watchlist scan
npm run cli -- liq-scan --chain base --max-hf 1.05

# Read only the persisted watchlist (no RPC), e.g. from a cron job
npm run cli -- liq-scan --at-risk --json
```

### Option C: PM2 Process Manager
```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.cjs
pm2 logs morpho-llm-operator
pm2 save
pm2 startup
```

### Option D: Linux Systemd Service
```bash
sudo cp deploy/morpho-llm-operator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morpho-llm-operator
sudo journalctl -u morpho-llm-operator -f
```

### Option E: Docker & Docker Compose
```bash
docker compose up -d --build
docker compose logs -f
```

### Viewing & Interacting with the CLI on a VPS
1. **Interactive Menu via SSH** (can be opened anytime even while the background daemon runs):
   ```bash
   cd ~/flash/tools
   npm run cli
   ```
2. **Stream Live Daemon CLI Tables**:
   - **PM2:** `pm2 logs morpho-llm-operator --lines 100` or `pm2 monit`
   - **Systemd:** `sudo journalctl -u morpho-llm-operator -f -n 100`
   - **Docker:** `docker compose logs -f` (or `docker compose exec morpho-llm-operator npm run cli`)
3. **SSH Port Forwarding for the Web Dashboard (`Port 3000`)**:
   ```bash
   ssh -L 3000:127.0.0.1:3000 user@YOUR_VPS_IP
   # Open http://localhost:3000 in your local browser
   ```

---

## 4. HTTP Status API & Live Web Dashboard

When `WATCH_HTTP_PORT=3000` (default), the built-in server binds to `0.0.0.0:3000`:

- **`GET /`**: Real-time dark-mode Web Dashboard displaying Morpho liquidity, contract allowlist status, Multi-DEX arbitrage spreads, and LLM Operator reasoning history.
- **`GET /health`**: Lightweight JSON health check for Docker, systemd, or Uptime Kuma.
- **`GET /api/status`**: Complete runtime state (including `wsStatuses` and `atRiskWatchlist`), chain reports, and audit log history in JSON.
- **`GET /api/watchlist`**: Returns the auto-indexed Morpho Blue Pre-Liquidation Watchlist (`1.00 <= healthFactor <= 1.12`) across all monitored chains (supports optional `?chain=base` filter).
- **`POST /api/trigger`**: Triggers an immediate scan and evaluation cycle.
- **`POST /api/mode`**: Dynamically updates `mode`, `autoBroadcast`, or `minProfitUsd` at runtime.
  - Note: Enabling `autoBroadcast: true` over HTTP requires `OPERATOR_API_TOKEN` to be set in `tools/.env` and passed via `Authorization: Bearer <token>`.

---

## 5. Two-Way Telegram Bot Controller (`tools/src/agent/telegram.ts`)

By setting `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `tools/.env`, the daemon activates a two-way Telegram Bot Controller using outbound `getUpdates` long-polling (no webhook domain, SSL certificate, or inbound firewall port needed).

### Setup Steps
1. Create a bot on Telegram via **[@BotFather](https://t.me/BotFather)** and copy the token.
2. Obtain your numeric Telegram Chat ID / User ID (e.g., via `@userinfobot`).
3. Add both to `tools/.env`:
   ```dotenv
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
   TELEGRAM_CHAT_ID=987654321
   TELEGRAM_ADMIN_IDS=
   ```
4. Only messages and button clicks originating from `TELEGRAM_CHAT_ID` or `TELEGRAM_ADMIN_IDS` are authorized; all other users are ignored.

### Supported Telegram Commands
- `/menu` or `/start` — Displays the interactive inline keyboard control panel.
- `/status` — Shows daemon health, active mode, circuit breaker status, LLM model, uptime, and latest decision.
- `/scan` or `/trigger` — Runs an immediate scan and LLM evaluation cycle.
- `/whitelist` — Shows whitelisted vs. pending allowlist assets across all monitored chains.
- `/arb` or `/quotes` — Lists top Multi-DEX arbitrage spreads, gas estimates, and net USD profit.
- `/history` — Shows the last 5 LLM Operator decisions and execution summaries.
- `/mode <dry-run|whitelist-only|flashloan|arbitrage|liquidation|full>` — Changes operator mode on the fly.
- `/broadcast on` or `/broadcast off` — Enables or disables live on-chain transaction broadcasting (and resets the circuit breaker).
- `/profit <usd>` — Updates the minimum net USD profit threshold (e.g., `/profit 15`).
- `/ask <question>` *(or any plain-text message)* — Chat directly with the LLM Operator with full context of live on-chain data.
