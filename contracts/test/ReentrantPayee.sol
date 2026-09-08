// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISourcePayouts {
    function claim(bytes32 sourceId) external;
}

/// @dev A registered payee that tries to re-enter `claim` from its receive
/// hook. Exists only to prove the withdrawable balance is zeroed before the
/// transfer, so a second entry cannot be paid twice.
contract ReentrantPayee {
    ISourcePayouts public immutable target;
    bytes32 public sourceId;
    uint256 public entries;
    bool public reenterFailed;

    constructor(ISourcePayouts target_) {
        target = target_;
    }

    function arm(bytes32 sourceId_) external {
        sourceId = sourceId_;
    }

    function attack() external {
        target.claim(sourceId);
    }

    receive() external payable {
        entries += 1;
        if (entries == 1) {
            // Should revert with NothingToClaim. Swallow it so the outer claim
            // still succeeds and the test can assert on the accounting rather
            // than on a bubbled revert.
            try target.claim(sourceId) {
                // Re-entry succeeded, which would be the bug.
            } catch {
                reenterFailed = true;
            }
        }
    }
}
