// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title KarmaTimelock — 48-hour governance timelock for KARMA admin operations (P0-B).
/// @notice Wraps OpenZeppelin TimelockController with KARMA's minimum delay constant.
///         Proposers = multisig wallet (Gnosis Safe / Squads); executors = open (anyone after delay).
///         Used as the `owner` of AgentSkillRegistry so that admin operations (setCrossChainRep)
///         require multisig approval + 48h cooling-off before execution — eliminating the single-EOA
///         admin backdoor identified in the architectural audit.
contract KarmaTimelock is TimelockController {
    uint256 public constant KARMA_MIN_DELAY = 48 hours;

    /// @param proposers Addresses that can schedule operations (typically a multisig wallet).
    /// @param executors Addresses that can execute ready operations. Pass [address(0)] to allow anyone.
    constructor(
        address[] memory proposers,
        address[] memory executors
    ) TimelockController(KARMA_MIN_DELAY, proposers, executors, address(0)) {}
}
