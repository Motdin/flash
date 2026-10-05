// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlashLoanExecutor, IERC20} from "../src/FlashLoanExecutor.sol";
import {MorphoAtomicArbPOC} from "../src/poc/MorphoAtomicArbPOC.sol";

interface IForkVm {
    function createSelectFork(string calldata url) external returns (uint256 forkId);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory value);
    function prank(address sender) external;
}

interface IERC20Fork is IERC20 {
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice Read-only-RPC integration tests for current Base and Arbitrum state.
/// @dev New contracts and all state-changing calls run only in Foundry's local fork VM;
///      this suite never invokes broadcast/startBroadcast or eth_sendTransaction upstream.
contract ExecutorForkTest {
    IForkVm private constant vm = IForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant BASE_CHAIN_ID = 8453;
    uint256 private constant ARBITRUM_CHAIN_ID = 42161;
    uint256 private constant ONE_USDC = 1e6;

    address private constant BASE_MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address private constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address private constant BASE_V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;

    address private constant ARBITRUM_MORPHO = 0x6c247b1F6182318877311737BaC0844bAa518F5e;
    address private constant ARBITRUM_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address private constant ARBITRUM_V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;

    function testFork01BaseExecutorAndArbAdmin() external {
        _testChain(
            vm.envOr("BASE_FORK_RPC_URL", "https://mainnet.base.org"),
            BASE_CHAIN_ID,
            BASE_MORPHO,
            BASE_USDC,
            BASE_V2_ROUTER
        );
    }

    function testFork02ArbitrumExecutorAndArbAdmin() external {
        _testChain(
            vm.envOr("ARBITRUM_FORK_RPC_URL", "https://arb1.arbitrum.io/rpc"),
            ARBITRUM_CHAIN_ID,
            ARBITRUM_MORPHO,
            ARBITRUM_USDC,
            ARBITRUM_V2_ROUTER
        );
    }

    function _testChain(
        string memory rpcUrl,
        uint256 expectedChainId,
        address morpho,
        address token,
        address router
    ) private {
        vm.createSelectFork(rpcUrl);
        require(block.chainid == expectedChainId, "fork RPC chain ID mismatch");
        require(morpho.code.length != 0, "Morpho code missing on fork");
        require(token.code.length != 0, "USDC code missing on fork");
        require(router.code.length != 0, "V2 router code missing on fork");

        _testFlashLoanRoundTrip(morpho, token);
        _testArbExecutorAdminAndAllowlist(morpho, token, router);
    }

    function _testFlashLoanRoundTrip(address morpho, address token) private {
        uint256 providerBalanceBefore = IERC20Fork(token).balanceOf(morpho);
        require(providerBalanceBefore >= ONE_USDC, "Morpho lacks 1 USDC for fork smoke test");

        address[] memory initialTokens = new address[](1);
        initialTokens[0] = token;
        FlashLoanExecutor executor = new FlashLoanExecutor(morpho, initialTokens);

        require(executor.owner() == address(this), "FlashLoanExecutor owner mismatch");
        require(executor.morpho() == morpho, "FlashLoanExecutor Morpho mismatch");
        require(executor.allowedToken(token), "FlashLoanExecutor initial allowlist missing");
        require(!executor.paused(), "FlashLoanExecutor unexpectedly paused");

        // One USDC is borrowed and repaid entirely within the local fork simulation.
        executor.flashLoan(token, ONE_USDC);

        require(IERC20Fork(token).balanceOf(morpho) == providerBalanceBefore, "Morpho principal not restored");
        require(IERC20Fork(token).balanceOf(address(executor)) == 0, "executor retained token dust");
        require(IERC20Fork(token).allowance(address(executor), morpho) == 0, "Morpho allowance remains");
    }

    function _testArbExecutorAdminAndAllowlist(address morpho, address token, address router) private {
        address[] memory initialTokens = new address[](1);
        initialTokens[0] = token;
        address[] memory initialRouters = new address[](1);
        initialRouters[0] = router;

        MorphoAtomicArbPOC executor = new MorphoAtomicArbPOC(morpho, initialTokens, initialRouters);
        require(executor.owner() == address(this), "arb executor owner mismatch");
        require(executor.operator() == address(this), "arb executor initial operator mismatch");
        require(executor.morpho() == morpho, "arb executor Morpho mismatch");
        require(executor.allowedToken(token), "arb executor token allowlist missing");
        require(executor.allowedRouter(router), "arb executor router allowlist missing");

        address operator = address(0xBEEF);
        executor.setOperator(operator);
        require(executor.operator() == operator, "arb executor operator update failed");

        vm.prank(operator);
        executor.setTokenAllowed(token, false);
        require(!executor.allowedToken(token), "operator could not update token allowlist");

        vm.prank(operator);
        executor.setRouterAllowed(router, false);
        require(!executor.allowedRouter(router), "operator could not update router allowlist");

        vm.prank(operator);
        (bool operatorCanChangeOwner,) = address(executor).call(
            abi.encodeWithSelector(MorphoAtomicArbPOC.setOperator.selector, address(0xCAFE))
        );
        require(!operatorCanChangeOwner, "operator changed owner-controlled operator");

        vm.prank(address(0xDEAD));
        (bool unauthorizedAllowedToken,) = address(executor).call(
            abi.encodeWithSelector(MorphoAtomicArbPOC.setTokenAllowed.selector, token, true)
        );
        require(!unauthorizedAllowedToken, "unauthorized account changed token allowlist");
    }
}
