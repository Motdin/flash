// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlashLoanExecutor, IERC20} from "../src/FlashLoanExecutor.sol";

contract MockToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        require(IERC20(token).transfer(msg.sender, assets), "send");
        (bool ok,) = msg.sender.call(abi.encodeWithSignature("onMorphoFlashLoan(uint256,bytes)", assets, data));
        require(ok, "callback");
        require(MockToken(token).transferFrom(msg.sender, address(this), assets), "repay");
    }
}

contract FlashLoanExecutorTest {
    function testExactRepayment() external {
        MockToken token = new MockToken();
        MockMorpho morpho = new MockMorpho();
        FlashLoanExecutor executor = new FlashLoanExecutor(address(morpho), _one(address(token)));
        token.mint(address(morpho), 100e6);
        executor.flashLoan(address(token), 100e6);
        require(token.balanceOf(address(morpho)) == 100e6, "not repaid");
        require(token.balanceOf(address(executor)) == 0, "dust");
        require(token.allowance(address(executor), address(morpho)) == 0, "allowance remains");
    }

    function testRejectsUnallowedToken() external {
        MockToken token = new MockToken();
        MockMorpho morpho = new MockMorpho();
        FlashLoanExecutor executor = new FlashLoanExecutor(address(morpho), new address[](0));
        (bool ok,) = address(executor).call(abi.encodeWithSelector(executor.flashLoan.selector, address(token), 1e6));
        require(!ok, "allowed unexpectedly");
    }

    function testRejectsZeroAmount() external {
        MockToken token = new MockToken();
        MockMorpho morpho = new MockMorpho();
        FlashLoanExecutor executor = new FlashLoanExecutor(address(morpho), _one(address(token)));
        (bool ok,) = address(executor).call(abi.encodeWithSelector(executor.flashLoan.selector, address(token), 0));
        require(!ok, "zero amount accepted");
    }

    function testPauseBlocksLoan() external {
        MockToken token = new MockToken();
        MockMorpho morpho = new MockMorpho();
        FlashLoanExecutor executor = new FlashLoanExecutor(address(morpho), _one(address(token)));
        executor.setPaused(true);
        (bool ok,) = address(executor).call(abi.encodeWithSelector(executor.flashLoan.selector, address(token), 1e6));
        require(!ok, "paused loan accepted");
    }

    function testRejectsFakeCallback() external {
        MockToken token = new MockToken();
        MockMorpho morpho = new MockMorpho();
        FlashLoanExecutor executor = new FlashLoanExecutor(address(morpho), _one(address(token)));
        (bool ok,) = address(executor)
            .call(abi.encodeWithSignature("onMorphoFlashLoan(uint256,bytes)", 1e6, abi.encode(address(token), 1e6)));
        require(!ok, "fake callback accepted");
    }

    function _one(address token) private pure returns (address[] memory result) {
        result = new address[](1);
        result[0] = token;
    }
}

contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 value) external { balanceOf[to] += value; }
    function approve(address spender, uint256 value) external {
        require(value == 0 || allowance[msg.sender][spender] == 0, "zero-first");
        allowance[msg.sender][spender] = value;
    }
    function transfer(address to, uint256 value) external {
        balanceOf[msg.sender] -= value; balanceOf[to] += value;
    }
    function transferFrom(address from, address to, uint256 value) external {
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value; balanceOf[to] += value;
    }
}
contract NoReturnMorpho {
    function flashLoan(address token, uint256 amount, bytes calldata data) external {
        NoReturnToken(token).transfer(msg.sender, amount);
        FlashLoanExecutor(msg.sender).onMorphoFlashLoan(amount, data);
        NoReturnToken(token).transferFrom(msg.sender, address(this), amount);
    }
}
contract FlashLoanOptionalReturnTest {
    function testNoReturnTokenRepaymentAndRescue() external {
        NoReturnToken token = new NoReturnToken();
        NoReturnMorpho morpho = new NoReturnMorpho();
        address[] memory tokens = new address[](1); tokens[0] = address(token);
        FlashLoanExecutor executor = new FlashLoanExecutor(address(morpho), tokens);
        token.mint(address(morpho), 1000);
        executor.flashLoan(address(token), 100);
        executor.flashLoan(address(token), 100);
        require(token.balanceOf(address(morpho)) == 1000, "repayment");
        require(token.allowance(address(executor), address(morpho)) == 0, "allowance");
        token.mint(address(executor), 50);
        executor.rescueToken(address(token), address(this), 50);
        require(token.balanceOf(address(this)) == 50, "rescue");
    }
}
