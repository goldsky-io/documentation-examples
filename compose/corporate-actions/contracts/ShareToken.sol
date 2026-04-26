// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ShareToken
 * @notice Minimal ERC-20 representing tokenized equity shares.
 *         Pre-mints to a list of holders in the constructor.
 *
 * @dev Demo-grade: no permits, no transfer hooks, no ERC-2612.
 */
contract ShareToken {
    string public constant name = "Example Issuer Shares";
    string public constant symbol = "EIS";
    uint8  public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error LengthMismatch();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(address[] memory holders, uint256[] memory amounts) {
        if (holders.length != amounts.length) revert LengthMismatch();
        uint256 supply;
        for (uint256 i = 0; i < holders.length; i++) {
            balanceOf[holders[i]] += amounts[i];
            supply += amounts[i];
            emit Transfer(address(0), holders[i], amounts[i]);
        }
        totalSupply = supply;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a < value) revert InsufficientAllowance();
        if (a != type(uint256).max) {
            allowance[from][msg.sender] = a - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        uint256 b = balanceOf[from];
        if (b < value) revert InsufficientBalance();
        unchecked { balanceOf[from] = b - value; }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
