// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IPOCERC20,
    IPOCMorphoFlashLoanCallback,
    IPOCV2Router,
    IPOCAeroRouter,
    IPOCMorphoLiquidateCallback,
    MorphoMarketParams,
    MorphoAtomicArbPOC
} from "../src/poc/MorphoAtomicArbPOC.sol";

contract POCMockToken is IPOCERC20 {
    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "allowance");
        allowance[from][msg.sender] = approved - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract POCMockMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        uint256 balanceBefore = IPOCERC20(token).balanceOf(address(this));
        require(IPOCERC20(token).transfer(msg.sender, assets), "send");
        IPOCMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(assets, data);
        require(POCMockToken(token).transferFrom(msg.sender, address(this), assets), "repay");
        require(IPOCERC20(token).balanceOf(address(this)) == balanceBefore, "principal");
    }
}

contract POCMockV2Router is IPOCV2Router {
    uint256 public immutable numerator;
    uint256 public immutable denominator;

    constructor(uint256 numerator_, uint256 denominator_) {
        numerator = numerator_;
        denominator = denominator_;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(path.length == 2 && path[0] != path[1], "path");
        require(block.timestamp <= deadline, "deadline");

        uint256 amountOut = amountIn * numerator / denominator;
        require(amountOut >= amountOutMin, "min-out");
        require(POCMockToken(path[0]).transferFrom(msg.sender, address(this), amountIn), "take-in");
        require(IPOCERC20(path[1]).transfer(to, amountOut), "send-out");

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }
}

contract MorphoAtomicArbPOCTest {
    uint256 private constant UNIT = 1e18;
    address private constant PROFIT_RECEIVER = address(0xBEEF);

    function testProfitableRoundTripRepaysAndPaysProfit() external {
        (
            POCMockToken loanToken,
            POCMockToken intermediateToken,
            POCMockMorpho morpho,
            POCMockV2Router firstRouter,
            POCMockV2Router secondRouter,
            MorphoAtomicArbPOC poc
        ) = _deployProfitableRoute();

        uint256 morphoBalanceBefore = loanToken.balanceOf(address(morpho));
        uint256 profit = poc.executeArbitrage(
            _params(
                address(loanToken), address(intermediateToken), address(firstRouter), address(secondRouter), 50 * UNIT
            )
        );

        require(profit == 100 * UNIT, "wrong profit");
        require(loanToken.balanceOf(PROFIT_RECEIVER) == 100 * UNIT, "profit not paid");
        require(loanToken.balanceOf(address(morpho)) == morphoBalanceBefore, "Morpho not repaid");
        require(loanToken.balanceOf(address(poc)) == 0, "loan-token dust");
        require(intermediateToken.balanceOf(address(poc)) == 0, "intermediate dust");
    }

    function testRevertsWhenMinimumProfitIsNotMet() external {
        (
            POCMockToken loanToken,
            POCMockToken intermediateToken,
            POCMockMorpho morpho,
            POCMockV2Router firstRouter,
            POCMockV2Router secondRouter,
            MorphoAtomicArbPOC poc
        ) = _deployProfitableRoute();

        uint256 morphoBalanceBefore = loanToken.balanceOf(address(morpho));
        MorphoAtomicArbPOC.ArbitrageParams memory params = _params(
            address(loanToken), address(intermediateToken), address(firstRouter), address(secondRouter), 101 * UNIT
        );

        (bool ok,) = address(poc).call(abi.encodeCall(poc.executeArbitrage, (params)));
        require(!ok, "unprofitable route accepted");
        require(loanToken.balanceOf(address(morpho)) == morphoBalanceBefore, "state not reverted");
        require(loanToken.balanceOf(PROFIT_RECEIVER) == 0, "profit paid on revert");
    }

    function testRejectsRouterOutsideAllowlist() external {
        (
            POCMockToken loanToken,
            POCMockToken intermediateToken,,
            POCMockV2Router firstRouter,
            POCMockV2Router secondRouter,
            MorphoAtomicArbPOC poc
        ) = _deployProfitableRoute();

        poc.setRouterAllowed(address(secondRouter), false);
        MorphoAtomicArbPOC.ArbitrageParams memory params =
            _params(address(loanToken), address(intermediateToken), address(firstRouter), address(secondRouter), 1);
        (bool ok,) = address(poc).call(abi.encodeCall(poc.executeArbitrage, (params)));
        require(!ok, "unallowed router accepted");
    }

    function testRejectsFakeCallback() external {
        (,,,,, MorphoAtomicArbPOC poc) = _deployProfitableRoute();
        (bool ok,) =
            address(poc).call(abi.encodeWithSelector(poc.onMorphoFlashLoan.selector, 1_000 * UNIT, bytes("fake")));
        require(!ok, "fake callback accepted");
    }

    function testOwnerCanDelegateOperator() external {
        (,,,,, MorphoAtomicArbPOC poc) = _deployProfitableRoute();
        address vpsOperator = address(0xCAFE);
        poc.setOperator(vpsOperator);
        require(poc.operator() == vpsOperator, "operator not updated");
    }

    function testMultiHopArbitrageAndPreApprovals() external {
        (
            POCMockToken loanToken,
            POCMockToken intermediateToken,
            POCMockMorpho morpho,
            POCMockV2Router firstRouter,
            POCMockV2Router secondRouter,
            MorphoAtomicArbPOC poc
        ) = _deployProfitableRoute();

        poc.setRouterPreApproval(address(loanToken), address(firstRouter), type(uint256).max);
        poc.setRouterPreApproval(address(intermediateToken), address(secondRouter), type(uint256).max);
        poc.setRouterPreApproval(address(loanToken), address(morpho), type(uint256).max);

        MorphoAtomicArbPOC.MultiHopStep[] memory steps = new MorphoAtomicArbPOC.MultiHopStep[](2);
        steps[0] = MorphoAtomicArbPOC.MultiHopStep({
            hop: MorphoAtomicArbPOC.SwapHop({
                router: address(firstRouter),
                kind: MorphoAtomicArbPOC.RouterKind.V2,
                fee: 0,
                stable: false,
                factory: address(0)
            }),
            tokenOut: address(intermediateToken),
            minAmountOut: 1_900 * UNIT
        });
        steps[1] = MorphoAtomicArbPOC.MultiHopStep({
            hop: MorphoAtomicArbPOC.SwapHop({
                router: address(secondRouter),
                kind: MorphoAtomicArbPOC.RouterKind.V2,
                fee: 0,
                stable: false,
                factory: address(0)
            }),
            tokenOut: address(loanToken),
            minAmountOut: 1_050 * UNIT
        });

        uint256 profit = poc.executeMultiHopArbitrage(
            MorphoAtomicArbPOC.MultiHopArbitrageParams({
                loanToken: address(loanToken),
                loanAmount: 1_000 * UNIT,
                steps: steps,
                minProfit: 50 * UNIT,
                deadline: type(uint256).max,
                profitReceiver: PROFIT_RECEIVER
            })
        );
        require(profit == 100 * UNIT, "wrong multihop profit");
    }

    function _deployProfitableRoute()
        private
        returns (
            POCMockToken loanToken,
            POCMockToken intermediateToken,
            POCMockMorpho morpho,
            POCMockV2Router firstRouter,
            POCMockV2Router secondRouter,
            MorphoAtomicArbPOC poc
        )
    {
        loanToken = new POCMockToken();
        intermediateToken = new POCMockToken();
        morpho = new POCMockMorpho();

        // 1,000 loan tokens -> 2,000 intermediate -> 1,100 loan tokens.
        firstRouter = new POCMockV2Router(2, 1);
        secondRouter = new POCMockV2Router(55, 100);

        loanToken.mint(address(morpho), 10_000 * UNIT);
        intermediateToken.mint(address(firstRouter), 20_000 * UNIT);
        loanToken.mint(address(secondRouter), 20_000 * UNIT);

        address[] memory tokens = new address[](2);
        tokens[0] = address(loanToken);
        tokens[1] = address(intermediateToken);
        address[] memory routers = new address[](2);
        routers[0] = address(firstRouter);
        routers[1] = address(secondRouter);
        poc = new MorphoAtomicArbPOC(address(morpho), tokens, routers);
    }

    function _params(
        address loanToken,
        address intermediateToken,
        address firstRouter,
        address secondRouter,
        uint256 minProfit
    ) private pure returns (MorphoAtomicArbPOC.ArbitrageParams memory params) {
        params = MorphoAtomicArbPOC.ArbitrageParams({
            loanToken: loanToken,
            intermediateToken: intermediateToken,
            firstRouter: firstRouter,
            secondRouter: secondRouter,
            loanAmount: 1_000 * UNIT,
            minIntermediateAmount: 1_900 * UNIT,
            minFinalAmount: 1_050 * UNIT,
            minProfit: minProfit,
            deadline: type(uint256).max,
            profitReceiver: PROFIT_RECEIVER
        });
    }
}

contract POCMockLiquidator {
    function liquidate(MorphoMarketParams calldata market, address, uint256 seized, uint256, bytes calldata data)
        external returns (uint256, uint256)
    {
        uint256 repay = seized;
        require(POCMockToken(market.collateralToken).transfer(msg.sender, seized), "collateral");
        IPOCMorphoLiquidateCallback(msg.sender).onMorphoLiquidate(repay, data);
        require(POCMockToken(market.loanToken).transferFrom(msg.sender, address(this), repay), "repayment");
        return (seized, repay);
    }
}
contract POCMockAeroRouter is IPOCAeroRouter {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] calldata routes, address to, uint256)
        external returns (uint256[] memory amounts)
    {
        uint256 amountOut = routes[0].stable ? amountIn * 55 / 100 : amountIn * 2;
        require(amountOut >= amountOutMin, "min-out");
        POCMockToken(routes[0].from).transferFrom(msg.sender, address(this), amountIn);
        POCMockToken(routes[0].to).transfer(to, amountOut);
        amounts = new uint256[](2); amounts[0] = amountIn; amounts[1] = amountOut;
    }
}
contract AtomicArbRegressionTest {
    function testLiquidationPreservesPrefundedCollateral() external { _liquidation(11, 10, true); }
    function testPrefundedCollateralCannotSubsidizeUnprofitableLiquidation() external { _liquidation(9, 10, false); }
    function _liquidation(uint256 n, uint256 d, bool shouldSucceed) private {
        POCMockToken loan = new POCMockToken();
        POCMockToken collateral = new POCMockToken();
        POCMockLiquidator morpho = new POCMockLiquidator();
        POCMockV2Router router = new POCMockV2Router(n, d);
        address[] memory tokens = new address[](2); tokens[0] = address(loan); tokens[1] = address(collateral);
        address[] memory routers = new address[](1); routers[0] = address(router);
        MorphoAtomicArbPOC executor = new MorphoAtomicArbPOC(address(morpho), tokens, routers);
        collateral.mint(address(morpho), 100e18);
        collateral.mint(address(executor), 50e18);
        loan.mint(address(router), 1000e18);
        MorphoAtomicArbPOC.LiquidationParams memory params = MorphoAtomicArbPOC.LiquidationParams({
            marketParams: MorphoMarketParams(address(loan), address(collateral), address(1), address(2), 86e16),
            borrower: address(3), seizedAssets: 100e18, repaidShares: 0,
            collateralSwapHop: MorphoAtomicArbPOC.SwapHop(address(router), MorphoAtomicArbPOC.RouterKind.V2, 0, false, address(0)),
            minLoanTokenOut: 1, minProfit: 1, deadline: type(uint256).max, profitReceiver: address(0xBEEF)
        });
        (bool ok,) = address(executor).call(abi.encodeCall(executor.executeLiquidation, (params)));
        require(ok == shouldSucceed, "profit guard");
        require(collateral.balanceOf(address(executor)) == 50e18, "prefunded collateral spent");
        if (ok) {
            require(loan.balanceOf(address(morpho)) == 100e18, "repayment");
            require(loan.balanceOf(address(0xBEEF)) == 10e18, "realized profit");
        }
    }
    function testSameAeroRouterDifferentPoolTypesAreValid() external {
        POCMockToken loan = new POCMockToken();
        POCMockToken intermediate = new POCMockToken();
        POCMockMorpho morpho = new POCMockMorpho();
        POCMockAeroRouter router = new POCMockAeroRouter();
        address[] memory tokens = new address[](2); tokens[0] = address(loan); tokens[1] = address(intermediate);
        address[] memory routers = new address[](1); routers[0] = address(router);
        MorphoAtomicArbPOC executor = new MorphoAtomicArbPOC(address(morpho), tokens, routers);
        loan.mint(address(morpho), 1000e18);
        loan.mint(address(router), 2000e18);
        intermediate.mint(address(router), 2000e18);
        uint256 profit = executor.executeMultiDexArbitrage(MorphoAtomicArbPOC.MultiDexArbitrageParams({
            loanToken: address(loan), intermediateToken: address(intermediate),
            firstHop: MorphoAtomicArbPOC.SwapHop(address(router), MorphoAtomicArbPOC.RouterKind.AERODROME, 0, false, address(1)),
            secondHop: MorphoAtomicArbPOC.SwapHop(address(router), MorphoAtomicArbPOC.RouterKind.AERODROME, 0, true, address(1)),
            loanAmount: 1000e18, minIntermediateAmount: 1900e18, minFinalAmount: 1050e18,
            minProfit: 50e18, deadline: type(uint256).max, profitReceiver: address(0xBEEF)
        }));
        require(profit == 100e18, "stable/volatile route");
    }
}

contract POCMockLegacyCurve {
    POCMockToken private immutable tokenIn;
    POCMockToken private immutable tokenOut;
    constructor(POCMockToken a, POCMockToken b) { tokenIn = a; tokenOut = b; }
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external {
        require(i == 0 && j == 1 && dx * 2 >= minDy, "indices/output");
        tokenIn.transferFrom(msg.sender, address(this), dx);
        tokenOut.transfer(msg.sender, dx * 2);
        // Old StableSwap pools deliberately have no return data.
    }
}
contract LegacyCurveRegressionTest {
    function testCurveExchangeWithoutReturnData() external {
        POCMockToken a = new POCMockToken(); POCMockToken b = new POCMockToken();
        POCMockMorpho morpho = new POCMockMorpho();
        POCMockLegacyCurve curve = new POCMockLegacyCurve(a, b);
        POCMockV2Router second = new POCMockV2Router(55, 100);
        address[] memory tokens = new address[](2); tokens[0] = address(a); tokens[1] = address(b);
        address[] memory routers = new address[](2); routers[0] = address(curve); routers[1] = address(second);
        MorphoAtomicArbPOC executor = new MorphoAtomicArbPOC(address(morpho), tokens, routers);
        a.mint(address(morpho), 1000e18); b.mint(address(curve), 2000e18); a.mint(address(second), 2000e18);
        uint256 profit = executor.executeMultiDexArbitrage(MorphoAtomicArbPOC.MultiDexArbitrageParams({
            loanToken: address(a), intermediateToken: address(b),
            firstHop: MorphoAtomicArbPOC.SwapHop(address(curve), MorphoAtomicArbPOC.RouterKind.CURVE, 1, false, address(0)),
            secondHop: MorphoAtomicArbPOC.SwapHop(address(second), MorphoAtomicArbPOC.RouterKind.V2, 0, false, address(0)),
            loanAmount: 1000e18, minIntermediateAmount: 1900e18, minFinalAmount: 1050e18,
            minProfit: 50e18, deadline: type(uint256).max, profitReceiver: address(0xBEEF)
        }));
        require(profit == 100e18, "curve optional return");
    }
}
