# Morpho Multi-DEX Atomic Arbitrage & Liquidation Executor (`MorphoAtomicArbPOC`)

`src/poc/MorphoAtomicArbPOC.sol` implements atomic zero-fee Morpho Blue flashloan arbitrage across multiple DEX architectures (2-leg and N-hop triangular paths) as well as atomic Morpho Blue liquidations:

```text
1. Multi-DEX & Multi-Hop Arbitrage Flow:
   owner / operator
     -> Morpho.flashLoan(loanToken, loanAmount)
     -> Hop 1..N (V2 / V3 / Aerodrome / Curve / Direct V3 Pool):
          loanToken -> token1 -> ... -> loanToken
     -> Verify minAmountOut at each step and finalBalance >= balanceBefore + loanAmount + minProfit
     -> Ensure allowance to Morpho (skips SSTORE if pre-approved)
     -> Transfer realized profit to profitReceiver

2. Atomic Liquidation Flow:
   owner / operator
     -> Morpho.liquidate(marketParams, borrower, seizedAssets, repaidShares, callbackData)
     -> onMorphoLiquidate(repaidAssets, data):
          Swap seized collateralToken -> loanToken via allowed router
          Verify finalBalance >= balanceBefore + repaidAssets + minProfit
          Ensure allowance of repaidAssets to Morpho
     -> Transfer realized liquidation profit to profitReceiver
```

## Supported Router Kinds (`RouterKind` Enum)

| Enum Value | ID | Supported Protocols | Execution Method |
|---|---:|---|---|
| `RouterKind.V2` | `0` | Uniswap V2, SushiSwap V2, BaseSwap V2, Camelot V2 | `swapExactTokensForTokens(amountIn, amountOutMin, path, address(this), deadline)` |
| `RouterKind.V3_LEGACY` | `1` | Uniswap V3 SwapRouter, SushiSwap V3 | `exactInputSingle` (with `deadline` in struct & `uint24 fee`) |
| `RouterKind.V3_ROUTER02` | `2` | Uniswap SwapRouter02 (Base / L2 deployments) | `exactInputSingle` (without `deadline` in struct & `uint24 fee`) |
| `RouterKind.AERODROME` | `3` | Aerodrome (Base), Velodrome V2 (Optimism) | `swapExactTokensForTokens(amountIn, amountOutMin, Route[], address(this), deadline)` |
| `RouterKind.CURVE` | `4` | Curve StableSwap / CryptoSwap Pools | `exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)` (indices `i, j` packed in `hop.fee`) |
| `RouterKind.V3_DIRECT_POOL` | `5` | Direct Uniswap V3 Liquidity Pools (No Router) | `pool.swap(...)` + `uniswapV3SwapCallback` |

## Gas Optimization & Security Invariants

- **Gas-Saving Pre-Approvals (`setRouterPreApproval` / `batchSetRouterPreApprovals` / `_ensureAllowance`)**: Checks existing ERC-20 `allowance(address(this), spender)` via `staticcall` and skips the expensive `approve()` `SSTORE` during flashloan callbacks when allowance is already `>= needed`.
- **Direct V3 Pool Swaps (`uniswapV3SwapCallback`)**: Bypasses periphery router contracts when `RouterKind.V3_DIRECT_POOL` is selected, verifying `msg.sender == activeV3PoolCallback`.
- **Access Control (`onlyOwnerOrOperator`)**: Only `owner` or the delegated VPS `operator` (`setOperator(address)`) can initiate arbitrage/liquidations or update allowlists. Only `owner` can change the `operator`, pause the contract, or rescue tokens.
- **Callback Authenticity**: `onMorphoFlashLoan` and `onMorphoLiquidate` strictly require `msg.sender == morpho`, an active callback mode (`ARB_V2`, `ARB_MULTIDEX`, `ARB_MULTIHOP`, or `LIQUIDATION`), and a matching `keccak256(data) == activeRouteHash`.
- **Explicit Allowlists**: Every token and router/pool must be explicitly enabled in `allowedToken` and `allowedRouter`.
- **Zero Residual & Strict Profit Check**: Reverts with `InsufficientProfit` if the final loan token balance does not cover both full Morpho repayment and `minProfit`.
