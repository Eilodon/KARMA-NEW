// `#[odra::module(events = [...])]`'s schema-generation codegen chains one iterator per listed
// event (Chain<Chain<Chain<...>>>) to build the contract schema; past ~30 events (P4-A's panel-
// arbitration additions pushed AgentSkillRegistry over that) the resulting nested type exceeds
// rustc's default 128 query-recursion limit during layout computation (test builds only —
// `cargo check` doesn't hit this path). Raised, not worked around: no code shape avoids this
// short of removing events, which isn't the goal.
#![recursion_limit = "256"]
// Odra's `#[odra::module]` macro emits `#[cfg(odra_module)]` blocks (its WASM-vs-test gate).
// The cfg name isn't known to rustc, so the lint fires once per attribute — silenced here at
// the crate root rather than per-call site.
#![allow(unexpected_cfgs)]
// Casper entry points take primitive args directly (no nested-struct params in the ABI), so
// wider contract methods and the `#[odra::module]`/`delegate!`-generated wrappers around them
// (e.g. CEP3009's `transfer_with_authorization`) legitimately exceed clippy's default arg count.
#![allow(clippy::too_many_arguments)]
// The real Casper deploy target (wasm32-unknown-unknown) has no std runtime — pulling in
// `odra-casper-wasm-env`'s panic handler alongside `std`'s otherwise collides on the
// `panic_impl` lang item. `cargo test` (native, non-wasm32) keeps std throughout; only the
// wasm32 artifact goes no_std. `odra::prelude` re-exports the `alloc` types the contract needs.
#![cfg_attr(target_arch = "wasm32", no_std)]

//! KARMA Odra port — Casper Agentic Buildathon T9.
//!
//! Mirrors the Solidity `AgentSkillRegistry` (v4) 1-to-1 on its public surface:
//! skill lifecycle, escrow + pull-payment jobs, identity / reputation gates, and the
//! Tier-2 Sybil-resistance bond. See [`agent_skill_registry`] for the contract.
//!
//! The port preserves three invariants from the Solidity audit:
//!   * **CEI** in every fund-state mutator (effects before [`transfer_tokens`]).
//!   * **Pull-payment ledger** — providers/refundees credit a balance, then withdraw.
//!   * **Self-deal nullification** — escrow always settles, but trust signals (skill rep,
//!     totalInvocations, agent rep) do NOT count when `requester == provider`.
//!
//! Casper-specific deltas vs Solidity:
//!   * `U512` (CSPR) replaces `uint256 wei`.
//!   * Block time is in **milliseconds** (Casper convention), so every duration constant
//!     is expressed in ms — verified against the Solidity boundary tests (1h / 3d / 30d).
//!   * Reputation-bump arithmetic is saturating: `100` is a hard ceiling that matches
//!     `MAX_REPUTATION` on the Solidity side.

pub mod agent_skill_registry;
pub mod x402_settlement_token;
