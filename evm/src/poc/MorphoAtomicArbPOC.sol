// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPOCERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

struct MorphoMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IPOCMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;

    function liquidate(
        MorphoMarketParams calldata marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256 assetsSeized, uint256 assetsRepaid);
}

interface IPOCMorphoFlashLoanCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

interface IPOCMorphoLiquidateCallback {
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external;
}

interface IPOCV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IPOCV3RouterLegacy {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IPOCV3Router02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IPOCAeroRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IPOCCurvePool {
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256 dy);
}

interface IPOCV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @notice Production-hardened Morpho Atomic Arbitrage & Liquidation Executor.
/// @dev Supports Uniswap/Sushi V2, Uniswap/Sushi V3 (Legacy & SwapRouter02),
///      Aerodrome/Velodrome, Curve StableSwap, Direct V3 Pool Swaps, Multi-Hop N-Leg paths,
///      Gas-Optimized Pre-Approvals, and atomic Morpho Blue liquidations with strict allowlists.
contract MorphoAtomicArbPOC is IPOCMorphoFlashLoanCallback, IPOCMorphoLiquidateCallback {
    enum RouterKind {
        V2,
        V3_LEGACY,
        V3_ROUTER02,
        AERODROME,
        CURVE,
        V3_DIRECT_POOL
    }

    enum CallbackMode {
        NONE,
        ARB_V2,
        ARB_MULTIDEX,
        ARB_MULTIHOP,
        LIQUIDATION
    }

    struct ArbitrageParams {
        address loanToken;
        address intermediateToken;
        address firstRouter;
        address secondRouter;
        uint256 loanAmount;
        uint256 minIntermediateAmount;
        uint256 minFinalAmount;
        uint256 minProfit;
        uint256 deadline;
        address profitReceiver;
    }

    struct SwapHop {
        address router;
        RouterKind kind;
        uint24 fee;
        bool stable;
        address factory;
    }

    struct MultiDexArbitrageParams {
        address loanToken;
        address intermediateToken;
        SwapHop firstHop;
        SwapHop secondHop;
        uint256 loanAmount;
        uint256 minIntermediateAmount;
        uint256 minFinalAmount;
        uint256 minProfit;
        uint256 deadline;
        address profitReceiver;
    }

    struct MultiHopStep {
        SwapHop hop;
        address tokenOut;
        uint256 minAmountOut;
    }

    struct MultiHopArbitrageParams {
        address loanToken;
        uint256 loanAmount;
        MultiHopStep[] steps;
        uint256 minProfit;
        uint256 deadline;
        address profitReceiver;
    }

    struct LiquidationParams {
        MorphoMarketParams marketParams;
        address borrower;
        uint256 seizedAssets;
        uint256 repaidShares;
        SwapHop collateralSwapHop;
        uint256 minLoanTokenOut;
        uint256 minProfit;
        uint256 deadline;
        address profitReceiver;
    }

    error Unauthorized();
    error Paused();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidRoute();
    error DeadlineExpired();
    error TokenNotAllowed();
    error RouterNotAllowed();
    error CallbackNotAllowed();
    error LoanStateMismatch();
    error InsufficientOutput();
    error InsufficientProfit();
    error ResidualIntermediateToken();
    error TokenCallFailed();

    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    address public immutable owner;
    address public immutable morpho;
    address public operator;
    bool public paused;

    mapping(address token => bool allowed) public allowedToken;
    mapping(address router => bool allowed) public allowedRouter;

    CallbackMode private activeMode;
    address private activeLoanToken;
    uint256 private activeLoanAmount;
    uint256 private activeBalanceBefore;
    bytes32 private activeRouteHash;
    address private activeV3PoolCallback;

    event TokenAllowanceUpdated(address indexed token, bool allowed);
    event RouterAllowanceUpdated(address indexed router, bool allowed);
    event RouterPreApprovalUpdated(address indexed token, address indexed spender, uint256 amount);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event PauseUpdated(bool paused);
    event ArbitrageExecuted(
        address indexed loanToken,
        address indexed intermediateToken,
        uint256 loanAmount,
        uint256 profit,
        address indexed profitReceiver
    );
    event MultiHopArbitrageExecuted(
        address indexed loanToken,
        uint256 hopsCount,
        uint256 loanAmount,
        uint256 profit,
        address indexed profitReceiver
    );
    event LiquidationExecuted(
        address indexed borrower,
        address indexed loanToken,
        address indexed collateralToken,
        uint256 seizedAssets,
        uint256 repaidAssets,
        uint256 profit,
        address profitReceiver
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrOperator() {
        if (msg.sender != owner && msg.sender != operator) revert Unauthorized();
        _;
    }

    constructor(address morpho_, address[] memory initialTokens, address[] memory initialRouters) {
        if (morpho_ == address(0)) revert InvalidAddress();
        owner = msg.sender;
        operator = msg.sender;
        morpho = morpho_;

        for (uint256 i; i < initialTokens.length; ++i) {
            _setTokenAllowed(initialTokens[i], true);
        }
        for (uint256 i; i < initialRouters.length; ++i) {
            _setRouterAllowed(initialRouters[i], true);
        }
    }

    /// @notice Pre-approve a whitelisted router or Morpho singleton once to eliminate SSTORE gas overhead during swaps.
    function setRouterPreApproval(address token, address spender, uint256 amount) external onlyOwnerOrOperator {
        if (!allowedToken[token]) revert TokenNotAllowed();
        if (spender != morpho && !allowedRouter[spender]) revert RouterNotAllowed();
        _forceApprove(token, spender, amount);
        emit RouterPreApprovalUpdated(token, spender, amount);
    }

    /// @notice Batch pre-approve multiple token-spender pairs in a single transaction.
    function batchSetRouterPreApprovals(
        address[] calldata tokens,
        address[] calldata spenders,
        uint256 amount
    ) external onlyOwnerOrOperator {
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            if (!allowedToken[token]) revert TokenNotAllowed();
            _forceApprove(token, morpho, amount);
            emit RouterPreApprovalUpdated(token, morpho, amount);
            for (uint256 j; j < spenders.length; ++j) {
                address spender = spenders[j];
                if (spender != morpho && !allowedRouter[spender]) revert RouterNotAllowed();
                _forceApprove(token, spender, amount);
                emit RouterPreApprovalUpdated(token, spender, amount);
            }
        }
    }

    /// @notice Borrow, execute two V2 swaps, repay Morpho, then transfer realized profit.
    function executeArbitrage(ArbitrageParams calldata params) external onlyOwnerOrOperator returns (uint256 profit) {
        if (paused) revert Paused();
        _validateV2Params(params);
        if (activeMode != CallbackMode.NONE) revert LoanStateMismatch();

        uint256 balanceBefore = IPOCERC20(params.loanToken).balanceOf(address(this));
        bytes memory callbackData = abi.encode(params);

        activeMode = CallbackMode.ARB_V2;
        activeLoanToken = params.loanToken;
        activeLoanAmount = params.loanAmount;
        activeBalanceBefore = balanceBefore;
        activeRouteHash = keccak256(callbackData);

        IPOCMorpho(morpho).flashLoan(params.loanToken, params.loanAmount, callbackData);

        if (activeMode != CallbackMode.NONE) revert LoanStateMismatch();
        profit = _settleAndTransferProfit(
            params.loanToken, balanceBefore, params.minProfit, params.profitReceiver
        );

        emit ArbitrageExecuted(
            params.loanToken, params.intermediateToken, params.loanAmount, profit, params.profitReceiver
        );
    }

    /// @notice Borrow, execute two swaps across any combination of V2, V3, Aerodrome, Curve, or Direct Pool, repay Morpho, and transfer profit.
    function executeMultiDexArbitrage(MultiDexArbitrageParams calldata params)
        external
        onlyOwnerOrOperator
        returns (uint256 profit)
    {
        if (paused) revert Paused();
        _validateMultiDexParams(params);
        if (activeMode != CallbackMode.NONE) revert LoanStateMismatch();

        uint256 balanceBefore = IPOCERC20(params.loanToken).balanceOf(address(this));
        bytes memory callbackData = abi.encode(params);

        activeMode = CallbackMode.ARB_MULTIDEX;
        activeLoanToken = params.loanToken;
        activeLoanAmount = params.loanAmount;
        activeBalanceBefore = balanceBefore;
        activeRouteHash = keccak256(callbackData);

        IPOCMorpho(morpho).flashLoan(params.loanToken, params.loanAmount, callbackData);

        if (activeMode != CallbackMode.NONE) revert LoanStateMismatch();
        profit = _settleAndTransferProfit(
            params.loanToken, balanceBefore, params.minProfit, params.profitReceiver
        );

        emit ArbitrageExecuted(
            params.loanToken, params.intermediateToken, params.loanAmount, profit, params.profitReceiver
        );
    }

    /// @notice Borrow and execute an N-hop (triangular or multi-step) atomic arbitrage cycle returning to `loanToken`.
    function executeMultiHopArbitrage(MultiHopArbitrageParams calldata params)
        external
        onlyOwnerOrOperator
        returns (uint256 profit)
    {
        if (paused) revert Paused();
        _validateMultiHopParams(params);
        if (activeMode != CallbackMode.NONE) revert LoanStateMismatch();

        uint256 balanceBefore = IPOCERC20(params.loanToken).balanceOf(address(this));
        bytes memory callbackData = abi.encode(params);

        activeMode = CallbackMode.ARB_MULTIHOP;
        activeLoanToken = params.loanToken;
        activeLoanAmount = params.loanAmount;
        activeBalanceBefore = balanceBefore;
        activeRouteHash = keccak256(callbackData);

        IPOCMorpho(morpho).flashLoan(params.loanToken, params.loanAmount, callbackData);

        if (activeMode != CallbackMode.NONE) revert LoanStateMismatch();
        profit = _settleAndTransferProfit(
            params.loanToken, balanceBefore, params.minProfit, params.profitReceiver
        );

        emit MultiHopArbitrageExecuted(
            params.loanToken, params.steps.length, params.loanAmount, profit, params.profitReceiver
        );
    }

    /// @notice Atomically liquidate an unhealthy Morpho Blue position using seized collateral swap callback.
    function executeLiquidation(LiquidationParams calldata params)
        external
        onlyOwnerOrOperator
        returns (uint256 profit)
    {
        if (paused) revert Paused();
        _validateLiquidationParams(params);
        if (activeMode != CallbackMode.NONE) revert LoanStateMismatch();

        address loanToken = params.marketParams.loanToken;
        uint256 balanceBefore = IPOCERC20(loanToken).balanceOf(address(this));
        bytes memory callbackData = abi.encode(params);

        activeMode = CallbackMode.LIQUIDATION;
        activeLoanToken = loanToken;
        activeLoanAmount = 0;
        activeBalanceBefore = balanceBefore;
        activeRouteHash = keccak256(callbackData);

        (uint256 seized, uint256 repaid) = IPOCMorpho(morpho).liquidate(
            params.marketParams,
            params.borrower,
            params.seizedAssets,
            params.repaidShares,
            callbackData
        );

        if (activeMode != CallbackMode.NONE) revert LoanStateMismatch();
        profit = _settleAndTransferProfit(loanToken, balanceBefore, params.minProfit, params.profitReceiver);

        emit LiquidationExecuted(
            params.borrower,
            loanToken,
            params.marketParams.collateralToken,
            seized,
            repaid,
            profit,
            params.profitReceiver
        );
    }

    /// @inheritdoc IPOCMorphoFlashLoanCallback
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != morpho) revert CallbackNotAllowed();
        if (
            (
                activeMode != CallbackMode.ARB_V2 && activeMode != CallbackMode.ARB_MULTIDEX
                    && activeMode != CallbackMode.ARB_MULTIHOP
            ) || assets != activeLoanAmount || keccak256(data) != activeRouteHash
        ) {
            revert LoanStateMismatch();
        }

        if (activeMode == CallbackMode.ARB_V2) {
            _handleV2Callback(assets, data);
        } else if (activeMode == CallbackMode.ARB_MULTIDEX) {
            _handleMultiDexCallback(assets, data);
        } else {
            _handleMultiHopCallback(assets, data);
        }
    }

    /// @inheritdoc IPOCMorphoLiquidateCallback
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        if (msg.sender != morpho) revert CallbackNotAllowed();
        if (activeMode != CallbackMode.LIQUIDATION || keccak256(data) != activeRouteHash) {
            revert LoanStateMismatch();
        }

        LiquidationParams memory params = abi.decode(data, (LiquidationParams));
        address loanToken = params.marketParams.loanToken;
        address collateralToken = params.marketParams.collateralToken;
        if (loanToken != activeLoanToken) revert LoanStateMismatch();
        if (block.timestamp > params.deadline) revert DeadlineExpired();

        uint256 collateralBalance = IPOCERC20(collateralToken).balanceOf(address(this));
        if (collateralBalance == 0) revert InsufficientOutput();

        _executeHop(
            params.collateralSwapHop,
            collateralToken,
            loanToken,
            collateralBalance,
            params.minLoanTokenOut,
            params.deadline
        );

        uint256 requiredFinalBalance = activeBalanceBefore + repaidAssets + params.minProfit;
        if (IPOCERC20(loanToken).balanceOf(address(this)) < requiredFinalBalance) {
            revert InsufficientProfit();
        }

        _ensureAllowance(loanToken, morpho, repaidAssets);
        _clearLoanState();
    }

    /// @notice Uniswap V3 direct pool swap callback (saves SwapRouter periphery gas overhead).
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        if (msg.sender != activeV3PoolCallback || activeV3PoolCallback == address(0)) {
            revert CallbackNotAllowed();
        }
        address tokenIn = abi.decode(data, (address));
        uint256 amountToPay = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        _safeTransfer(tokenIn, msg.sender, amountToPay);
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwnerOrOperator {
        _setTokenAllowed(token, allowed);
    }

    function setRouterAllowed(address router, bool allowed) external onlyOwnerOrOperator {
        _setRouterAllowed(router, allowed);
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        address prev = operator;
        operator = newOperator;
        emit OperatorUpdated(prev, newOperator);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseUpdated(value);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (activeMode != CallbackMode.NONE || to == address(0)) revert LoanStateMismatch();
        _safeTransfer(token, to, amount);
    }

    function _handleV2Callback(uint256 assets, bytes calldata data) private {
        ArbitrageParams memory params = abi.decode(data, (ArbitrageParams));
        if (params.loanToken != activeLoanToken || params.loanAmount != assets) revert LoanStateMismatch();
        if (block.timestamp > params.deadline) revert DeadlineExpired();

        if (IPOCERC20(params.loanToken).balanceOf(address(this)) < activeBalanceBefore + assets) {
            revert LoanStateMismatch();
        }

        uint256 intermediateBefore = IPOCERC20(params.intermediateToken).balanceOf(address(this));
        _swapV2(
            params.firstRouter,
            params.loanToken,
            params.intermediateToken,
            assets,
            params.minIntermediateAmount,
            params.deadline
        );

        uint256 intermediateAfter = IPOCERC20(params.intermediateToken).balanceOf(address(this));
        if (intermediateAfter < intermediateBefore) revert InsufficientOutput();
        uint256 intermediateAmount = intermediateAfter - intermediateBefore;
        if (intermediateAmount < params.minIntermediateAmount) revert InsufficientOutput();

        _swapV2(
            params.secondRouter,
            params.intermediateToken,
            params.loanToken,
            intermediateAmount,
            params.minFinalAmount,
            params.deadline
        );

        if (IPOCERC20(params.intermediateToken).balanceOf(address(this)) != intermediateBefore) {
            revert ResidualIntermediateToken();
        }

        if (IPOCERC20(params.loanToken).balanceOf(address(this)) < activeBalanceBefore + assets + params.minProfit) {
            revert InsufficientProfit();
        }

        _ensureAllowance(params.loanToken, morpho, assets);
        _clearLoanState();
    }

    function _handleMultiDexCallback(uint256 assets, bytes calldata data) private {
        MultiDexArbitrageParams memory params = abi.decode(data, (MultiDexArbitrageParams));
        if (params.loanToken != activeLoanToken || params.loanAmount != assets) revert LoanStateMismatch();
        if (block.timestamp > params.deadline) revert DeadlineExpired();

        if (IPOCERC20(params.loanToken).balanceOf(address(this)) < activeBalanceBefore + assets) {
            revert LoanStateMismatch();
        }

        uint256 intermediateBefore = IPOCERC20(params.intermediateToken).balanceOf(address(this));
        _executeHop(
            params.firstHop,
            params.loanToken,
            params.intermediateToken,
            assets,
            params.minIntermediateAmount,
            params.deadline
        );

        uint256 intermediateAfter = IPOCERC20(params.intermediateToken).balanceOf(address(this));
        if (intermediateAfter < intermediateBefore) revert InsufficientOutput();
        uint256 intermediateAmount = intermediateAfter - intermediateBefore;
        if (intermediateAmount < params.minIntermediateAmount) revert InsufficientOutput();

        _executeHop(
            params.secondHop,
            params.intermediateToken,
            params.loanToken,
            intermediateAmount,
            params.minFinalAmount,
            params.deadline
        );

        if (IPOCERC20(params.intermediateToken).balanceOf(address(this)) != intermediateBefore) {
            revert ResidualIntermediateToken();
        }

        if (IPOCERC20(params.loanToken).balanceOf(address(this)) < activeBalanceBefore + assets + params.minProfit) {
            revert InsufficientProfit();
        }

        _ensureAllowance(params.loanToken, morpho, assets);
        _clearLoanState();
    }

    function _handleMultiHopCallback(uint256 assets, bytes calldata data) private {
        MultiHopArbitrageParams memory params = abi.decode(data, (MultiHopArbitrageParams));
        if (params.loanToken != activeLoanToken || params.loanAmount != assets) revert LoanStateMismatch();
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (IPOCERC20(params.loanToken).balanceOf(address(this)) < activeBalanceBefore + assets) {
            revert LoanStateMismatch();
        }

        address currentTokenIn = params.loanToken;
        uint256 currentAmountIn = assets;

        for (uint256 i; i < params.steps.length; ++i) {
            MultiHopStep memory step = params.steps[i];
            uint256 outBefore = IPOCERC20(step.tokenOut).balanceOf(address(this));
            _executeHop(
                step.hop,
                currentTokenIn,
                step.tokenOut,
                currentAmountIn,
                step.minAmountOut,
                params.deadline
            );
            uint256 outAfter = IPOCERC20(step.tokenOut).balanceOf(address(this));
            if (outAfter < outBefore) revert InsufficientOutput();
            uint256 received = outAfter - outBefore;
            if (received < step.minAmountOut) revert InsufficientOutput();

            currentTokenIn = step.tokenOut;
            currentAmountIn = received;
        }

        if (IPOCERC20(params.loanToken).balanceOf(address(this)) < activeBalanceBefore + assets + params.minProfit) {
            revert InsufficientProfit();
        }

        _ensureAllowance(params.loanToken, morpho, assets);
        _clearLoanState();
    }

    function _executeHop(
        SwapHop memory hop,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) private {
        if (hop.kind == RouterKind.V2) {
            _swapV2(hop.router, tokenIn, tokenOut, amountIn, amountOutMin, deadline);
        } else if (hop.kind == RouterKind.V3_LEGACY) {
            _ensureAllowance(tokenIn, hop.router, amountIn);
            IPOCV3RouterLegacy(hop.router).exactInputSingle(
                IPOCV3RouterLegacy.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: hop.fee,
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMin,
                    sqrtPriceLimitX96: 0
                })
            );
        } else if (hop.kind == RouterKind.V3_ROUTER02) {
            _ensureAllowance(tokenIn, hop.router, amountIn);
            IPOCV3Router02(hop.router).exactInputSingle(
                IPOCV3Router02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: hop.fee,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMin,
                    sqrtPriceLimitX96: 0
                })
            );
        } else if (hop.kind == RouterKind.AERODROME) {
            IPOCAeroRouter.Route[] memory routes = new IPOCAeroRouter.Route[](1);
            routes[0] = IPOCAeroRouter.Route({
                from: tokenIn,
                to: tokenOut,
                stable: hop.stable,
                factory: hop.factory
            });
            _ensureAllowance(tokenIn, hop.router, amountIn);
            IPOCAeroRouter(hop.router).swapExactTokensForTokens(
                amountIn, amountOutMin, routes, address(this), deadline
            );
        } else if (hop.kind == RouterKind.CURVE) {
            // Curve index encoding in `hop.fee`: upper 12 bits = index i, lower 12 bits = index j
            int128 i = int128(int24(hop.fee >> 12));
            int128 j = int128(int24(hop.fee & 0xFFF));
            _ensureAllowance(tokenIn, hop.router, amountIn);
            uint256 dy = IPOCCurvePool(hop.router).exchange(i, j, amountIn, amountOutMin);
            if (dy < amountOutMin) revert InsufficientOutput();
        } else {
            // RouterKind.V3_DIRECT_POOL: call Uniswap V3 pool directly without SwapRouter
            address token0 = IPOCV3Pool(hop.router).token0();
            bool zeroForOne = tokenIn == token0;
            uint160 sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;
            activeV3PoolCallback = hop.router;
            (int256 amount0, int256 amount1) = IPOCV3Pool(hop.router).swap(
                address(this),
                zeroForOne,
                int256(amountIn),
                sqrtPriceLimitX96,
                abi.encode(tokenIn)
            );
            activeV3PoolCallback = address(0);
            uint256 received = zeroForOne ? uint256(-amount1) : uint256(-amount0);
            if (received < amountOutMin) revert InsufficientOutput();
        }
    }

    function _settleAndTransferProfit(
        address loanToken,
        uint256 balanceBefore,
        uint256 minProfit,
        address profitReceiver
    ) private returns (uint256 profit) {
        uint256 balanceAfter = IPOCERC20(loanToken).balanceOf(address(this));
        if (balanceAfter < balanceBefore) revert InsufficientProfit();
        profit = balanceAfter - balanceBefore;
        if (profit < minProfit) revert InsufficientProfit();
        if (profit != 0) _safeTransfer(loanToken, profitReceiver, profit);
    }

    function _validateV2Params(ArbitrageParams calldata params) private view {
        if (
            params.loanToken == address(0) || params.intermediateToken == address(0) || params.firstRouter == address(0)
                || params.secondRouter == address(0) || params.profitReceiver == address(0)
        ) revert InvalidAddress();
        if (params.loanAmount == 0) revert InvalidAmount();
        if (params.loanToken == params.intermediateToken || params.firstRouter == params.secondRouter) {
            revert InvalidRoute();
        }
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (!allowedToken[params.loanToken] || !allowedToken[params.intermediateToken]) {
            revert TokenNotAllowed();
        }
        if (!allowedRouter[params.firstRouter] || !allowedRouter[params.secondRouter]) {
            revert RouterNotAllowed();
        }
    }

    function _validateMultiDexParams(MultiDexArbitrageParams calldata params) private view {
        if (
            params.loanToken == address(0) || params.intermediateToken == address(0)
                || params.firstHop.router == address(0) || params.secondHop.router == address(0)
                || params.profitReceiver == address(0)
        ) revert InvalidAddress();
        if (params.loanAmount == 0) revert InvalidAmount();
        if (params.loanToken == params.intermediateToken) revert InvalidRoute();
        if (
            params.firstHop.router == params.secondHop.router
                && params.firstHop.fee == params.secondHop.fee
                && params.firstHop.kind == params.secondHop.kind
        ) revert InvalidRoute();
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (!allowedToken[params.loanToken] || !allowedToken[params.intermediateToken]) {
            revert TokenNotAllowed();
        }
        if (!allowedRouter[params.firstHop.router] || !allowedRouter[params.secondHop.router]) {
            revert RouterNotAllowed();
        }
    }

    function _validateMultiHopParams(MultiHopArbitrageParams calldata params) private view {
        if (params.loanToken == address(0) || params.profitReceiver == address(0)) revert InvalidAddress();
        if (params.loanAmount == 0) revert InvalidAmount();
        if (params.steps.length < 2 || params.steps.length > 5) revert InvalidRoute();
        if (params.steps[params.steps.length - 1].tokenOut != params.loanToken) revert InvalidRoute();
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (!allowedToken[params.loanToken]) revert TokenNotAllowed();

        for (uint256 i; i < params.steps.length; ++i) {
            MultiHopStep calldata step = params.steps[i];
            if (step.hop.router == address(0) || step.tokenOut == address(0)) revert InvalidAddress();
            if (!allowedToken[step.tokenOut]) revert TokenNotAllowed();
            if (!allowedRouter[step.hop.router]) revert RouterNotAllowed();
        }
    }

    function _validateLiquidationParams(LiquidationParams calldata params) private view {
        if (
            params.marketParams.loanToken == address(0)
                || params.marketParams.collateralToken == address(0)
                || params.borrower == address(0)
                || params.collateralSwapHop.router == address(0)
                || params.profitReceiver == address(0)
        ) revert InvalidAddress();
        if (params.seizedAssets == 0 && params.repaidShares == 0) revert InvalidAmount();
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (
            !allowedToken[params.marketParams.loanToken]
                || !allowedToken[params.marketParams.collateralToken]
        ) revert TokenNotAllowed();
        if (!allowedRouter[params.collateralSwapHop.router]) revert RouterNotAllowed();
    }

    function _swapV2(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) private {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        _ensureAllowance(tokenIn, router, amountIn);
        IPOCV2Router(router).swapExactTokensForTokens(amountIn, amountOutMin, path, address(this), deadline);
    }

    function _setTokenAllowed(address token, bool allowed) private {
        if (token == address(0)) revert InvalidAddress();
        allowedToken[token] = allowed;
        emit TokenAllowanceUpdated(token, allowed);
    }

    function _setRouterAllowed(address router, bool allowed) private {
        if (router == address(0)) revert InvalidAddress();
        allowedRouter[router] = allowed;
        emit RouterAllowanceUpdated(router, allowed);
    }

    function _clearLoanState() private {
        activeMode = CallbackMode.NONE;
        activeLoanToken = address(0);
        activeLoanAmount = 0;
        activeBalanceBefore = 0;
        activeRouteHash = bytes32(0);
        activeV3PoolCallback = address(0);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory result) = token.call(abi.encodeCall(IPOCERC20.transfer, (to, amount)));
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenCallFailed();
    }

    /// @dev Gas-optimized allowance check: skips SSTORE (`approve`) if existing allowance >= needed.
    function _ensureAllowance(address token, address spender, uint256 needed) private {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeCall(IPOCERC20.allowance, (address(this), spender)));
        if (ok && data.length >= 32) {
            uint256 current = abi.decode(data, (uint256));
            if (current >= needed) return;
        }
        _forceApprove(token, spender, type(uint256).max);
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        if (_tryApprove(token, spender, amount)) return;
        if (!_tryApprove(token, spender, 0) || !_tryApprove(token, spender, amount)) revert TokenCallFailed();
    }

    function _tryApprove(address token, address spender, uint256 amount) private returns (bool) {
        (bool success, bytes memory result) = token.call(abi.encodeCall(IPOCERC20.approve, (spender, amount)));
        return success && (result.length == 0 || (result.length == 32 && abi.decode(result, (bool))));
    }
}
