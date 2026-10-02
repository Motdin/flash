# EVM Smart Contracts (`FlashLoanExecutor` & `MorphoAtomicArbPOC`)

This folder contains the Solidity smart contracts, deployment scripts, pre-compiled artifacts, and Foundry test suites for the Morpho Blue toolkit:

1. **`src/FlashLoanExecutor.sol`**: Minimal, portable, zero-protocol-fee Morpho Blue flashloan executor deployed across 10 EVM chains.
2. **`src/poc/MorphoAtomicArbPOC.sol`**: Multi-DEX atomic arbitrage (`V2`, `V3_LEGACY`, `V3_ROUTER02`, `AERODROME`) and Morpho Blue liquidation executor (`onMorphoLiquidate`) with owner + delegated VPS `operator` access control.

## Compiling Contracts

You can compile both contracts either with the embedded Node.js `solc` compiler (no Foundry installation required) or with Foundry:

```bash
# Option A: Using the embedded Node.js solc compiler
cd ../tools
npm run compile:contracts

# Option B: Using Foundry
cd ../evm
forge build
forge test -vv
```

## Deploying via TypeScript CLI (Recommended)

```bash
cd ../tools

# Deploy or sync FlashLoanExecutor
npm run cli -- setup --chain base --select USDC,WETH --broadcast

# Deploy or sync MorphoAtomicArbPOC (Multi-DEX Arbitrage & Liquidation)
npm run cli -- setup-arb --chain base --select USDC,WETH --broadcast
```

## Manual Deployment via Foundry Script

```bash
export MORPHO_ADDRESS=0x...
export TOKEN_ADDRESSES=0xTokenA,0xTokenB
export ROUTER_ADDRESSES=0xRouterA,0xRouterB
export PRIVATE_KEY=0x...

# Deploy FlashLoanExecutor
forge script script/Deploy.s.sol:Deploy --rpc-url "$BASE_RPC_URL" --broadcast

# Deploy MorphoAtomicArbPOC
forge script script/Deploy.s.sol:DeployArb --rpc-url "$BASE_RPC_URL" --broadcast
```
