# Panel Arbitration (N-of-M) Implementation Plan

> **For agentic workers:** Use `subagent-driven-development` (recommended)
> or `executing-plans` to implement this plan task-by-task.

**Goal:** Add an opt-in N-of-M panel arbitration mode alongside KARMA's existing single-arbiter
dispute resolution on Casper, with a flat participation fee that funds arbiter liveness instead
of a policy tiebreaker, without touching any existing entry point's behavior.

**Architecture:** Three new contract entry points (`dispute_result_via_panel`,
`cast_panel_vote`, `resolve_panel_default`) plus a governance-managed panel
(`propose_set_arbiter_panel`) reusing the existing propose/approve/execute+timelock lifecycle.
`arbitrate()`'s fund-movement/reputation logic is extracted into a shared private
`settle_dispute_verdict` so both the single-arbiter and panel paths call exactly one audited
settlement code path. Panel + threshold + fee are snapshotted onto the job at dispute time so a
later governance change can never affect an in-flight dispute.

**Tech Stack:** Rust/Odra (`contracts-odra/`), TypeScript (`src/lib/casper/live_client.ts`,
`src/plugins/casper.tool.ts`), Vitest, `cargo test` + `proptest`.

**Audit Gate:** PASS WITH FLAGS — see
[`docs/super-skills/specs/2026-07-22-panel-arbitration-design.md`](../specs/2026-07-22-panel-arbitration-design.md#risk-assessment-audit-design).
Both HIGH findings are mitigated in Task 4 (pull-payment fee distribution) and Task 3 (panel
snapshot at dispute time). The MEDIUM finding (remainder handling) is mitigated in Task 4.

**Risk Flags:** Task 2 (extracting `settle_dispute_verdict` out of the live, already-demoed
`arbitrate()`) is HIGH — see its rollback plan. All other tasks are additive-only (new code,
zero existing-behavior risk).

---

## File Structure

| File | Responsibility |
|---|---|
| `contracts-odra/src/agent_skill_registry.rs` | All new storage, errors, events, types, entry points; `arbitrate()` refactor |
| `contracts-odra/src/agent_skill_registry/tests.rs` | New `p1b_panel_*` example-based tests |
| `contracts-odra/src/agent_skill_registry/proptests.rs` | Extend both invariants to the panel path |
| `src/lib/casper/live_client.ts` | New live-client methods (thin wire-encoding wrappers, mirrors `arbitrate`) |
| `src/plugins/casper.tool.ts` | New MCP tool definitions + `CasperClientLike` Pick-list |
| `src/__tests__/casper_tool.test.ts` | New tool tests against a fake client |

---

## Task 1: Constants, storage, error codes, events, types

**Files:**
- Modify: `contracts-odra/src/agent_skill_registry.rs:44-45` (constants)
- Modify: `contracts-odra/src/agent_skill_registry.rs:49-111` (Error enum)
- Modify: `contracts-odra/src/agent_skill_registry.rs:127-130` (near `Verdict`, add `ArbitrationMode` + `PanelVote`)
- Modify: `contracts-odra/src/agent_skill_registry.rs:176-188` (`ProposalAction`)
- Modify: `contracts-odra/src/agent_skill_registry.rs:405-447` (module events list + storage struct)

- [ ] **Step 1: Add constants** (after line 45, `RESPONSE_WINDOW`):
```rust
pub const PANEL_VOTE_WINDOW: u64 = 3 * 24 * 60 * 60 * 1_000; // 3 days in ms, mirrors RESPONSE_WINDOW
pub const MIN_ARBITER_PANEL_SIZE: u32 = 3;
pub const MAX_ARBITER_PANEL_SIZE: u32 = 9; // small + bounded, mirrors MAX_COMPOSITION_LEAVES's spirit
```

- [ ] **Step 2: Add error variants** (append after `InvalidRationaleHash = 55,`):
```rust
    // ── P4-A: Panel Arbitration (N-of-M) ──
    PanelSizeTooSmall = 56,
    PanelSizeMustBeOdd = 57,
    InvalidPanelThreshold = 58,
    DuplicatePanelMember = 59,
    PanelNotConfigured = 60,
    NotPanelArbiter = 61,
    AlreadyVotedOnPanel = 62,
    WrongArbitrationMode = 63,
    WrongPanelDisputeAmount = 64,
    PanelVoteWindowOpen = 65,
```

- [ ] **Step 3: Add types** (after the `Verdict` enum, i.e. after line 130):
```rust
#[odra::odra_type]
pub enum ArbitrationMode {
    Single,
    Panel,
}

#[odra::odra_type]
pub struct PanelVote {
    pub arbiter: Address,
    pub verdict: Verdict,
}
```

- [ ] **Step 4: Add `ProposalAction::SetArbiterPanel`** (inside the existing enum, after `SetDisputeBondBps`):
```rust
    SetArbiterPanel {
        panel: Vec<Address>,
        threshold: u32,
    },
    SetPanelArbiterFee {
        fee: U512,
    },
```

- [ ] **Step 5: Add events** (new block, placed after the existing `DisputeArbitrated`-family events near line 350-375):
```rust
// ── Panel arbitration events (P4-A) ──────────────────────────────────────────
#[odra::event]
pub struct ArbiterPanelUpdated {
    pub old_panel: Vec<Address>,
    pub new_panel: Vec<Address>,
    pub threshold: u32,
}

#[odra::event]
pub struct PanelArbiterFeeUpdated {
    pub old_fee: U512,
    pub new_fee: U512,
}

#[odra::event]
pub struct PanelDisputePosted {
    pub job_id: u64,
    pub requester: Address,
    pub panel_fee: U512,
}

#[odra::event]
pub struct PanelVoteCast {
    pub job_id: u64,
    pub arbiter: Address,
    pub verdict: Verdict,
}

#[odra::event]
pub struct PanelArbitrated {
    pub job_id: u64,
    pub verdict: Verdict,
    pub provider_at_fault_votes: u32,
    pub requester_at_fault_votes: u32,
}

#[odra::event]
pub struct PanelFeeDistributed {
    pub job_id: u64,
    pub arbiter: Address,
    pub amount: U512,
}

#[odra::event]
pub struct PanelDefaultResolved {
    pub job_id: u64,
}
```

- [ ] **Step 6: Register the new events in the module macro** (line 405-412), and add the new storage
  fields (after `rationale_hash` at line 446):
```rust
#[odra::module(events = [
    SkillRegistered, SkillDeactivated, JobCreated, ResultDelivered, JobCompleted,
    JobRefunded, ResultDisputed, JobEvaluated, MinReputationSet, IdentityPolicySet,
    Withdrawn, BondUpdated, CompositionRegistered, CompositionLeafPayout, CrossChainRepUpdated,
    ProposalCreated, ProposalApproved, ProposalExecuted, ProposalCancelled, GovernanceConfigured,
    DisputeBondPosted, DisputeResponsePosted, DisputeConceded, DisputeArbitrated,
    ArbiterUpdated, DisputeBondBpsUpdated,
    ArbiterPanelUpdated, PanelArbiterFeeUpdated, PanelDisputePosted, PanelVoteCast,
    PanelArbitrated, PanelFeeDistributed, PanelDefaultResolved,
])]
pub struct AgentSkillRegistry {
    // ... existing fields unchanged ...
    rationale_hash: Mapping<u64, Bytes>,
    // ── P4-A: Panel Arbitration (N-of-M) ──────────────────────────────────────
    /// Governance-managed, live. A dispute snapshots this at post-time (see
    /// `job_panel_snapshot`) so a later governance change never affects an in-flight dispute
    /// (audit-design HIGH finding #3 mitigation).
    arbiter_panel: Var<Vec<Address>>,
    panel_threshold: Var<u32>,
    panel_arbiter_fee: Var<U512>,
    dispute_arbitration_mode: Mapping<u64, ArbitrationMode>,
    job_panel_snapshot: Mapping<u64, Vec<Address>>,
    job_panel_threshold_snapshot: Mapping<u64, u32>,
    panel_arbiter_fee_collected: Mapping<u64, U512>,
    panel_votes: Mapping<u64, Vec<PanelVote>>,
}
```

- [ ] **Step 7: Compile-check** (this task adds no behavior, so there is no test to run yet —
  confirm the crate still compiles with the new dead-until-used fields/types):
  `cargo +nightly check --manifest-path contracts-odra/Cargo.toml` → expected: builds clean
  (unused-field warnings are fine at this stage, no errors).
- [ ] **Step 8: Commit** `git commit -m "feat(casper): panel-arbitration storage, errors, events, types"`

---

## Task 2: Extract `settle_dispute_verdict` from `arbitrate()` (HIGH risk — touches live code)

**Files:**
- Modify: `contracts-odra/src/agent_skill_registry.rs:890-947` (`arbitrate`)

This is the one task that touches already-tested, already-demoed code. The refactor must be a
pure extraction — **zero logic changes** — so all 131 existing Rust tests (including the
courtroom flow's real on-chain evidence) stay byte-for-byte valid.

- [ ] **Step 1: Run the existing test baseline first** (so Step 4's "still green" claim has a
  concrete before-state): `cargo +nightly test --manifest-path contracts-odra/Cargo.toml` →
  expected: `131 passed; 0 failed`.

- [ ] **Step 2: Extract the verdict-handling match block into a private method.** Replace
  `arbitrate`'s body (lines 890-947) with:
```rust
    pub fn arbitrate(&mut self, job_id: u64, verdict: Verdict) {
        let caller = self.env().caller();
        if caller != self.arbiter.get().unwrap() {
            self.env().revert(Error::NotArbiter);
        }
        let j = self.require_job(job_id);
        if j.status != JobStatus::Disputed {
            self.env().revert(Error::NotDisputed);
        }
        let d = self.disputes.get(&job_id)
            .unwrap_or_else(|| self.env().revert(Error::NotBondedDispute));
        if d.dispute_bond.is_zero() {
            self.env().revert(Error::NotBondedDispute);
        }
        if d.provider_bond.is_zero() {
            self.env().revert(Error::ProviderNotResponded);
        }

        self.settle_dispute_verdict(job_id, j, d.dispute_bond, d.provider_bond, verdict);
        self.env().emit_event(DisputeArbitrated { job_id, verdict, arbiter: caller });
    }

    /// Shared by `arbitrate` (single-arbiter) and `cast_panel_vote` (panel, once threshold is
    /// reached) — exactly one audited fund-movement/reputation code path for a dispute verdict,
    /// per audit-design goal G6. Extracted verbatim from `arbitrate`'s original body — no logic
    /// changed, only relocated.
    fn settle_dispute_verdict(
        &mut self,
        job_id: u64,
        mut j: Job,
        dispute_bond: U512,
        provider_bond: U512,
        verdict: Verdict,
    ) {
        match verdict {
            Verdict::ProviderAtFault => {
                j.status = JobStatus::Refunded;
                let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default()
                    + j.escrow_amount + dispute_bond + provider_bond;
                self.pending_withdrawals.set(&j.requester, credit);
                self.slash_agent_rep(j.provider);
                self.slash_skill_rep(j.skill_id);
                let requester = j.requester;
                let escrow = j.escrow_amount;
                self.jobs.set(&job_id, j);
                self.env().emit_event(JobRefunded { job_id, requester, amount: escrow });
            }
            Verdict::RequesterAtFault => {
                j.status = JobStatus::Completed;
                j.completed_at = self.env().get_block_time();
                let provider_total = j.escrow_amount + provider_bond + dispute_bond;
                let credit = self.pending_withdrawals.get(&j.provider).unwrap_or_default() + provider_total;
                self.pending_withdrawals.set(&j.provider, credit);
                let mut s = self.require_skill(j.skill_id);
                if j.requester != j.provider {
                    s.total_invocations += 1;
                    let rep = s.reputation_score.saturating_add(REPUTATION_STEP);
                    s.reputation_score = if rep > MAX_REPUTATION { MAX_REPUTATION } else { rep };
                    self.skills.set(&j.skill_id, s.clone());
                    self.bump_agent_rep(j.provider);
                }
                let provider = j.provider;
                let escrow = j.escrow_amount;
                self.jobs.set(&job_id, j);
                self.env().emit_event(JobCompleted {
                    job_id,
                    provider,
                    payout: escrow,
                    new_reputation: s.reputation_score,
                });
            }
        }
    }
```

- [ ] **Step 3: Diff-check the extraction is behavior-preserving.** Read the diff and confirm:
  every field read (`j.requester`, `j.provider`, `j.escrow_amount`, `j.skill_id`), every write
  (`self.pending_withdrawals`, `self.skills`, `self.jobs`), and every event emitted
  (`JobRefunded`, `JobCompleted`) are identical to the pre-extraction version — only the
  `d.dispute_bond`/`d.provider_bond` references became `dispute_bond`/`provider_bond` parameters.

- [ ] **Step 4: Run — verify still green**
  `cargo +nightly test --manifest-path contracts-odra/Cargo.toml` → expected: `131 passed; 0
  failed`, identical to Step 1's baseline. If any test fails here, the extraction changed
  behavior — stop and fix before proceeding, do not move to Task 3.

- [ ] **Step 5: Commit** `git commit -m "refactor(casper): extract settle_dispute_verdict from arbitrate, no behavior change"`

**Rollback plan (required — this task is HIGH risk):**
- **Undo:** `git revert <this-commit-sha>` — the extraction is a single self-contained commit
  with no other task depending on `settle_dispute_verdict` yet at this point in the plan (Task 3
  is the first caller), so reverting it alone is safe and sufficient as long as Task 3+ haven't
  landed yet. If they have, revert Tasks 3+ first (they depend on this function existing).
- **Rollback verification:** run `cargo +nightly test --manifest-path contracts-odra/Cargo.toml`
  after the revert → expected: `131 passed; 0 failed`, and `grep -c "fn arbitrate"
  contracts-odra/src/agent_skill_registry.rs` → expected: `1` (back to the single, unextracted
  function) — confirms the revert actually restored the pre-Task-2 shape, not just that `git
  revert` exited 0.

---

## Task 3: `propose_set_arbiter_panel` + `propose_set_panel_arbiter_fee` + governance wiring

**Files:**
- Modify: `contracts-odra/src/agent_skill_registry.rs` (new methods, near `propose_set_arbiter` at line 980)
- Modify: `contracts-odra/src/agent_skill_registry.rs:1266-1285` (`execute_proposal` match arms)
- Test: `contracts-odra/src/agent_skill_registry/tests.rs`

- [ ] **Step 1: Write the failing tests** (append to `tests.rs`):
```rust
#[test]
fn p1b_propose_set_arbiter_panel_rejects_even_length() {
    let (env, mut reg, alpha, _beta) = setup();
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    let panel = vec![alpha, env.get_account(3), env.get_account(4), env.get_account(5)]; // 4, even
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reg.propose_set_arbiter_panel(panel, 3)
    }));
    assert!(result.is_err());
}

#[test]
fn p1b_propose_set_arbiter_panel_rejects_below_min_size() {
    let (env, mut reg, alpha, beta) = setup();
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reg.propose_set_arbiter_panel(vec![alpha, beta], 2) // 2 < MIN_ARBITER_PANEL_SIZE, also even
    }));
    assert!(result.is_err());
}

#[test]
fn p1b_propose_set_arbiter_panel_rejects_wrong_threshold() {
    let (env, mut reg, alpha, beta) = setup();
    let deployer = env.get_account(0);
    let gamma = env.get_account(3);
    env.set_caller(deployer);
    // len=3, correct threshold is 2 (3/2+1); propose 3 (unanimity) — must reject, only strict-
    // majority-of-odd is allowed per audit-design's L1 finding.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reg.propose_set_arbiter_panel(vec![alpha, beta, gamma], 3)
    }));
    assert!(result.is_err());
}

#[test]
fn p1b_propose_set_arbiter_panel_rejects_duplicate_member() {
    let (env, mut reg, alpha, beta) = setup();
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reg.propose_set_arbiter_panel(vec![alpha, alpha, beta], 2)
    }));
    assert!(result.is_err());
}

#[test]
fn p1b_propose_and_execute_arbiter_panel_full_lifecycle() {
    let (env, mut reg, alpha, beta) = setup();
    let deployer = env.get_account(0);
    let gamma = env.get_account(3);
    env.set_caller(deployer);
    let proposal_id = reg.propose_set_arbiter_panel(vec![alpha, beta, gamma], 2);
    // governance_threshold=1 in `setup()` (single signer), so it's already approved; still
    // must wait out the timelock like every other proposal.
    env.advance_block_time_by(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(proposal_id);
    assert_eq!(reg.get_arbiter_panel(), vec![alpha, beta, gamma]);
    assert_eq!(reg.get_panel_threshold(), 2);
}
```

- [ ] **Step 2: Run — verify FAIL**
  `cargo +nightly test --manifest-path contracts-odra/Cargo.toml p1b_propose` → expected: fails
  to compile (`propose_set_arbiter_panel`, `get_arbiter_panel`, `get_panel_threshold` don't
  exist yet) — this is the expected "FAIL" for a not-yet-implemented entry point.

- [ ] **Step 3: Write the implementation** (add near `propose_set_arbiter`, after line 1004):
```rust
    /// P4-A: Propose a new N-of-M arbiter panel. Governance-signer only, same proposal
    /// lifecycle as `propose_set_arbiter`. Validates panel shape at propose time so a bad
    /// configuration never even reaches the approval queue.
    pub fn propose_set_arbiter_panel(&mut self, panel: Vec<Address>, threshold: u32) -> u64 {
        self.require_governance_signer();
        let len = panel.len() as u32;
        if len < MIN_ARBITER_PANEL_SIZE {
            self.env().revert(Error::PanelSizeTooSmall);
        }
        if len > MAX_ARBITER_PANEL_SIZE {
            self.env().revert(Error::PanelSizeTooSmall);
        }
        if len % 2 == 0 {
            self.env().revert(Error::PanelSizeMustBeOdd);
        }
        if threshold != len / 2 + 1 {
            self.env().revert(Error::InvalidPanelThreshold);
        }
        for i in 0..panel.len() {
            for j in (i + 1)..panel.len() {
                if panel[i] == panel[j] {
                    self.env().revert(Error::DuplicatePanelMember);
                }
            }
        }

        let caller = self.env().caller();
        let proposal_id = self.proposal_counter.get_or_default() + 1;
        self.proposal_counter.set(proposal_id);

        let proposal = GovernanceProposal {
            action: ProposalAction::SetArbiterPanel { panel, threshold },
            proposer: caller,
            proposed_at: self.env().get_block_time(),
            executed: false,
            cancelled: false,
        };
        self.proposals.set(&proposal_id, proposal);
        self.proposal_approvals.set(&proposal_id, vec![caller]);

        self.env().emit_event(ProposalCreated { proposal_id, proposer: caller });
        self.env().emit_event(ProposalApproved {
            proposal_id,
            signer: caller,
            approval_count: 1,
            threshold: self.governance_threshold.get_or_default(),
        });
        proposal_id
    }

    /// P4-A: Propose a new flat panel-arbiter participation fee. Same governed lifecycle.
    pub fn propose_set_panel_arbiter_fee(&mut self, fee: U512) -> u64 {
        self.require_governance_signer();
        let caller = self.env().caller();
        let proposal_id = self.proposal_counter.get_or_default() + 1;
        self.proposal_counter.set(proposal_id);

        let proposal = GovernanceProposal {
            action: ProposalAction::SetPanelArbiterFee { fee },
            proposer: caller,
            proposed_at: self.env().get_block_time(),
            executed: false,
            cancelled: false,
        };
        self.proposals.set(&proposal_id, proposal);
        self.proposal_approvals.set(&proposal_id, vec![caller]);

        self.env().emit_event(ProposalCreated { proposal_id, proposer: caller });
        self.env().emit_event(ProposalApproved {
            proposal_id,
            signer: caller,
            approval_count: 1,
            threshold: self.governance_threshold.get_or_default(),
        });
        proposal_id
    }

    pub fn get_arbiter_panel(&self) -> Vec<Address> {
        self.arbiter_panel.get_or_default()
    }

    pub fn get_panel_threshold(&self) -> u32 {
        self.panel_threshold.get_or_default()
    }
```

- [ ] **Step 4: Wire the new `ProposalAction` variants into `execute_proposal`** — add two new
  match arms (after the existing `SetDisputeBondBps` arm, line 1280-1284):
```rust
            ProposalAction::SetArbiterPanel { panel, threshold } => {
                let old_panel = self.arbiter_panel.get_or_default();
                self.arbiter_panel.set(panel.clone());
                self.panel_threshold.set(*threshold);
                self.env().emit_event(ArbiterPanelUpdated {
                    old_panel,
                    new_panel: panel.clone(),
                    threshold: *threshold,
                });
            }
            ProposalAction::SetPanelArbiterFee { fee } => {
                let old_fee = self.panel_arbiter_fee.get_or_default();
                self.panel_arbiter_fee.set(*fee);
                self.env().emit_event(PanelArbiterFeeUpdated { old_fee, new_fee: *fee });
            }
```

- [ ] **Step 5: Run — verify PASS**
  `cargo +nightly test --manifest-path contracts-odra/Cargo.toml p1b_propose` → expected: `5
  passed; 0 failed`.
- [ ] **Step 6: Run full suite — confirm no regression**
  `cargo +nightly test --manifest-path contracts-odra/Cargo.toml` → expected: `136 passed; 0
  failed` (131 original + 5 new).
- [ ] **Step 7: Commit** `git commit -m "feat(casper): propose_set_arbiter_panel + propose_set_panel_arbiter_fee governance actions"`

---

## Task 4: `dispute_result_via_panel` + `cast_panel_vote` (+ HIGH/MEDIUM audit fixes)

**Files:**
- Modify: `contracts-odra/src/agent_skill_registry.rs` (new methods, near `dispute_result`/`arbitrate`)
- Test: `contracts-odra/src/agent_skill_registry/tests.rs`

- [ ] **Step 1: Write the failing tests** (append to `tests.rs`):
```rust
fn seed_panel(env: &odra::host::HostEnv, reg: &mut AgentSkillRegistryHostRef) -> (Address, Address, Address) {
    let deployer = env.get_account(0);
    let arb1 = env.get_account(3);
    let arb2 = env.get_account(4);
    let arb3 = env.get_account(5);
    env.set_caller(deployer);
    let proposal_id = reg.propose_set_arbiter_panel(vec![arb1, arb2, arb3], 2);
    env.advance_block_time_by(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(proposal_id);
    (arb1, arb2, arb3)
}

#[test]
fn p1b_dispute_via_panel_rejects_when_no_panel_configured() {
    let (env, mut reg, alpha, beta) = setup();
    env.set_caller(alpha);
    let skill_id = reg.register_skill("panel-skill".to_string(), "d".to_string(), "mcp://a".to_string(), U512::from(1_000_000u64), 0, IDENTITY_POLICY_NONE);
    env.set_caller(beta);
    let job_id = reg.with_tokens(U512::from(1_000_000u64)).create_job(skill_id, Bytes::from(b"t".to_vec()), 24 * 60 * 60 * 1_000);
    env.set_caller(alpha);
    reg.deliver_result(job_id, Bytes::from(b"r".to_vec()));
    let bond = dispute_bond_for(1_000_000);
    env.set_caller(beta);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reg.with_tokens(bond).dispute_result_via_panel(job_id)
    }));
    assert!(result.is_err()); // PanelNotConfigured
}

#[test]
fn p1b_panel_majority_reached_settles_provider_at_fault_and_pays_participating_arbiters() {
    let (env, mut reg, alpha, beta) = setup();
    let (arb1, arb2, arb3) = seed_panel(&env, &mut reg);
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    let fee_proposal = reg.propose_set_panel_arbiter_fee(U512::from(300_000u64));
    env.advance_block_time_by(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(fee_proposal);

    env.set_caller(alpha);
    let skill_id = reg.register_skill("panel-skill".to_string(), "d".to_string(), "mcp://a".to_string(), U512::from(1_000_000u64), 0, IDENTITY_POLICY_NONE);
    env.set_caller(beta);
    let job_id = reg.with_tokens(U512::from(1_000_000u64)).create_job(skill_id, Bytes::from(b"t".to_vec()), 24 * 60 * 60 * 1_000);
    env.set_caller(alpha);
    reg.deliver_result(job_id, Bytes::from(b"r".to_vec()));

    let bond = dispute_bond_for(1_000_000);
    let fee = U512::from(300_000u64);
    env.set_caller(beta);
    reg.with_tokens(bond + fee).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    env.set_caller(arb1);
    reg.cast_panel_vote(job_id, Verdict::ProviderAtFault);
    // Only 1 of 3 voted so far — not settled yet.
    assert_eq!(reg.get_job(job_id).status, JobStatus::Disputed);

    env.set_caller(arb2);
    reg.cast_panel_vote(job_id, Verdict::ProviderAtFault); // 2 of 3 = threshold reached

    assert_eq!(reg.get_job(job_id).status, JobStatus::Refunded);
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(1_000_000u64) + bond + bond);
    // Fee split between the 2 who voted (arb3 never voted, gets nothing).
    assert_eq!(reg.pending_withdrawals_of(arb1), U512::from(150_000u64));
    assert_eq!(reg.pending_withdrawals_of(arb2), U512::from(150_000u64));
    assert_eq!(reg.pending_withdrawals_of(arb3), U512::zero());
}

#[test]
fn p1b_panel_vote_after_settlement_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let (arb1, arb2, arb3) = seed_panel(&env, &mut reg);
    env.set_caller(alpha);
    let skill_id = reg.register_skill("panel-skill".to_string(), "d".to_string(), "mcp://a".to_string(), U512::from(1_000_000u64), 0, IDENTITY_POLICY_NONE);
    env.set_caller(beta);
    let job_id = reg.with_tokens(U512::from(1_000_000u64)).create_job(skill_id, Bytes::from(b"t".to_vec()), 24 * 60 * 60 * 1_000);
    env.set_caller(alpha);
    reg.deliver_result(job_id, Bytes::from(b"r".to_vec()));
    let bond = dispute_bond_for(1_000_000);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);
    env.set_caller(arb1);
    reg.cast_panel_vote(job_id, Verdict::RequesterAtFault);
    env.set_caller(arb2);
    reg.cast_panel_vote(job_id, Verdict::RequesterAtFault); // settles

    env.set_caller(arb3);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reg.cast_panel_vote(job_id, Verdict::ProviderAtFault)
    }));
    assert!(result.is_err()); // NotDisputed — job already settled
}

#[test]
fn p1b_double_vote_from_same_arbiter_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let (arb1, _arb2, _arb3) = seed_panel(&env, &mut reg);
    env.set_caller(alpha);
    let skill_id = reg.register_skill("panel-skill".to_string(), "d".to_string(), "mcp://a".to_string(), U512::from(1_000_000u64), 0, IDENTITY_POLICY_NONE);
    env.set_caller(beta);
    let job_id = reg.with_tokens(U512::from(1_000_000u64)).create_job(skill_id, Bytes::from(b"t".to_vec()), 24 * 60 * 60 * 1_000);
    env.set_caller(alpha);
    reg.deliver_result(job_id, Bytes::from(b"r".to_vec()));
    let bond = dispute_bond_for(1_000_000);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);
    env.set_caller(arb1);
    reg.cast_panel_vote(job_id, Verdict::ProviderAtFault);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reg.cast_panel_vote(job_id, Verdict::RequesterAtFault)
    }));
    assert!(result.is_err()); // AlreadyVotedOnPanel
}

#[test]
fn p1b_vote_from_non_panel_address_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    seed_panel(&env, &mut reg);
    env.set_caller(alpha);
    let skill_id = reg.register_skill("panel-skill".to_string(), "d".to_string(), "mcp://a".to_string(), U512::from(1_000_000u64), 0, IDENTITY_POLICY_NONE);
    env.set_caller(beta);
    let job_id = reg.with_tokens(U512::from(1_000_000u64)).create_job(skill_id, Bytes::from(b"t".to_vec()), 24 * 60 * 60 * 1_000);
    env.set_caller(alpha);
    reg.deliver_result(job_id, Bytes::from(b"r".to_vec()));
    let bond = dispute_bond_for(1_000_000);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    let outsider = env.get_account(6);
    env.set_caller(outsider);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reg.cast_panel_vote(job_id, Verdict::ProviderAtFault)
    }));
    assert!(result.is_err()); // NotPanelArbiter
}

#[test]
fn p1b_single_arbiter_arbitrate_rejects_a_panel_mode_job() {
    // Cross-mode guard: a job disputed via the panel path must not be settleable through the
    // plain single-arbiter `arbitrate` entry point.
    let (env, mut reg, alpha, beta) = setup();
    seed_panel(&env, &mut reg);
    env.set_caller(alpha);
    let skill_id = reg.register_skill("panel-skill".to_string(), "d".to_string(), "mcp://a".to_string(), U512::from(1_000_000u64), 0, IDENTITY_POLICY_NONE);
    env.set_caller(beta);
    let job_id = reg.with_tokens(U512::from(1_000_000u64)).create_job(skill_id, Bytes::from(b"t".to_vec()), 24 * 60 * 60 * 1_000);
    env.set_caller(alpha);
    reg.deliver_result(job_id, Bytes::from(b"r".to_vec()));
    let bond = dispute_bond_for(1_000_000);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    let deployer = env.get_account(0); // the plain single arbiter
    env.set_caller(deployer);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reg.arbitrate(job_id, Verdict::ProviderAtFault)
    }));
    assert!(result.is_err()); // WrongArbitrationMode
}
```

- [ ] **Step 2: Run — verify FAIL**
  `cargo +nightly test --manifest-path contracts-odra/Cargo.toml p1b_panel p1b_dispute_via_panel p1b_double_vote p1b_vote_from_non_panel p1b_single_arbiter_arbitrate_rejects`
  → expected: fails to compile (`dispute_result_via_panel`, `cast_panel_vote` don't exist yet).

- [ ] **Step 3: Write the implementation.** Add `dispute_result_via_panel` next to
  `dispute_result` (after line 791):
```rust
    /// P4-A: Like `dispute_result`, but flags the job for panel arbitration and collects an
    /// additional flat participation fee (governance-set) on top of the standard dispute bond.
    /// Snapshots the panel + threshold + fee onto the job's own storage at this moment — a
    /// later `propose_set_arbiter_panel`/`propose_set_panel_arbiter_fee` execution must never
    /// change the terms an already-posted dispute is running under (audit-design HIGH #3).
    #[odra(payable)]
    pub fn dispute_result_via_panel(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        let caller = self.env().caller();
        if j.requester != caller {
            self.env().revert(Error::NotRequester);
        }
        if j.status != JobStatus::Delivered {
            self.env().revert(Error::JobNotDelivered);
        }
        if self.env().get_block_time() > j.deadline {
            self.env().revert(Error::ReviewWindowClosed);
        }
        let panel = self.arbiter_panel.get_or_default();
        if panel.is_empty() {
            self.env().revert(Error::PanelNotConfigured);
        }

        let bps = self.dispute_bond_bps.get_or_default();
        let mut required_bond = (U512::from(bps) * j.escrow_amount) / U512::from(10_000u32);
        let min_bond = U512::from(MIN_DISPUTE_BOND_MOTES);
        if required_bond < min_bond {
            required_bond = min_bond;
        }
        let fee = self.panel_arbiter_fee.get_or_default();
        let required_total = required_bond + fee;
        let attached = self.env().attached_value();
        if attached != required_total {
            self.env().revert(Error::WrongPanelDisputeAmount);
        }

        let threshold = self.panel_threshold.get_or_default();
        self.job_panel_snapshot.set(&job_id, panel);
        self.job_panel_threshold_snapshot.set(&job_id, threshold);
        self.panel_arbiter_fee_collected.set(&job_id, fee);
        self.dispute_arbitration_mode.set(&job_id, ArbitrationMode::Panel);

        j.status = JobStatus::Disputed;
        let dispute_info = DisputeInfo {
            dispute_bond: required_bond,
            provider_bond: U512::zero(),
            disputed_at: self.env().get_block_time(),
        };
        self.disputes.set(&job_id, dispute_info);

        if !j.evaluator_fee.is_zero() {
            let credit = self.pending_withdrawals.get(&caller).unwrap_or_default() + j.evaluator_fee;
            self.pending_withdrawals.set(&caller, credit);
        }

        let amount = j.escrow_amount;
        self.jobs.set(&job_id, j);
        self.env().emit_event(DisputeBondPosted { job_id, requester: caller, bond: required_bond });
        self.env().emit_event(PanelDisputePosted { job_id, requester: caller, panel_fee: fee });
        self.env().emit_event(ResultDisputed { job_id, requester: caller, amount });
    }
```

  Add `cast_panel_vote` and its private `distribute_panel_fee` helper next to `arbitrate`/
  `settle_dispute_verdict`:
```rust
    /// P4-A: One vote from one panel member. `respond_to_dispute` (provider matching the bond)
    /// is unchanged and still required before a panel dispute can settle — a panel doesn't let
    /// a provider skip responding. Reads panel membership + threshold from the job's OWN
    /// snapshot (`job_panel_snapshot`), never the live `arbiter_panel`, so a governance change
    /// mid-dispute cannot affect this job (audit-design HIGH #3).
    pub fn cast_panel_vote(&mut self, job_id: u64, verdict: Verdict) {
        let caller = self.env().caller();
        let j = self.require_job(job_id);
        if j.status != JobStatus::Disputed {
            self.env().revert(Error::NotDisputed);
        }
        if self.dispute_arbitration_mode.get(&job_id) != Some(ArbitrationMode::Panel) {
            self.env().revert(Error::WrongArbitrationMode);
        }
        let panel = self.job_panel_snapshot.get(&job_id).unwrap_or_default();
        if !panel.contains(&caller) {
            self.env().revert(Error::NotPanelArbiter);
        }
        let d = self.disputes.get(&job_id)
            .unwrap_or_else(|| self.env().revert(Error::NotBondedDispute));
        if d.provider_bond.is_zero() {
            self.env().revert(Error::ProviderNotResponded);
        }

        let mut votes = self.panel_votes.get(&job_id).unwrap_or_default();
        if votes.iter().any(|v| v.arbiter == caller) {
            self.env().revert(Error::AlreadyVotedOnPanel);
        }
        votes.push(PanelVote { arbiter: caller, verdict });
        self.panel_votes.set(&job_id, votes.clone());
        self.env().emit_event(PanelVoteCast { job_id, arbiter: caller, verdict });

        let provider_at_fault_votes = votes.iter()
            .filter(|v| v.verdict == Verdict::ProviderAtFault).count() as u32;
        let requester_at_fault_votes = votes.iter()
            .filter(|v| v.verdict == Verdict::RequesterAtFault).count() as u32;
        let threshold = self.job_panel_threshold_snapshot.get(&job_id).unwrap_or_default();

        let winning_verdict = if provider_at_fault_votes >= threshold {
            Some(Verdict::ProviderAtFault)
        } else if requester_at_fault_votes >= threshold {
            Some(Verdict::RequesterAtFault)
        } else {
            None
        };

        if let Some(final_verdict) = winning_verdict {
            self.settle_dispute_verdict(job_id, j, d.dispute_bond, d.provider_bond, final_verdict);
            self.env().emit_event(PanelArbitrated {
                job_id,
                verdict: final_verdict,
                provider_at_fault_votes,
                requester_at_fault_votes,
            });
            self.distribute_panel_fee(job_id, &votes);
        }
    }

    /// P4-A: Flat fee, split evenly across every arbiter who voted (regardless of which side),
    /// pull-payment via `pending_withdrawals` — never a push-transfer, per audit-design HIGH #1.
    /// Last voter absorbs the rounding remainder, mirroring `settle_completion`'s composite-
    /// payout pattern exactly (audit-design MEDIUM finding).
    fn distribute_panel_fee(&mut self, job_id: u64, votes: &[PanelVote]) {
        let fee = self.panel_arbiter_fee_collected.get(&job_id).unwrap_or_default();
        if fee.is_zero() || votes.is_empty() {
            return;
        }
        let n = votes.len();
        let mut distributed = U512::zero();
        for (i, v) in votes.iter().enumerate() {
            let share = if i + 1 == n {
                fee - distributed
            } else {
                let s = fee / U512::from(n as u64);
                distributed += s;
                s
            };
            let credit = self.pending_withdrawals.get(&v.arbiter).unwrap_or_default() + share;
            self.pending_withdrawals.set(&v.arbiter, credit);
            self.env().emit_event(PanelFeeDistributed { job_id, arbiter: v.arbiter, amount: share });
        }
    }
```

- [ ] **Step 4: Run — verify PASS**
  `cargo +nightly test --manifest-path contracts-odra/Cargo.toml p1b_` → expected: `12 passed; 0
  failed` (5 from Task 3 + 7 new here).
- [ ] **Step 5: Run full suite** `cargo +nightly test --manifest-path contracts-odra/Cargo.toml`
  → expected: `143 passed; 0 failed`.
- [ ] **Step 6: Commit** `git commit -m "feat(casper): dispute_result_via_panel + cast_panel_vote, pull-payment fee distribution"`

---

## Task 5: `resolve_panel_default` (liveness backstop)

**Files:**
- Modify: `contracts-odra/src/agent_skill_registry.rs` (new method, near `resolve_default_concede`)
- Test: `contracts-odra/src/agent_skill_registry/tests.rs`

- [ ] **Step 1: Write the failing tests**:
```rust
#[test]
fn p1b_resolve_panel_default_before_window_elapses_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    seed_panel(&env, &mut reg);
    env.set_caller(alpha);
    let skill_id = reg.register_skill("panel-skill".to_string(), "d".to_string(), "mcp://a".to_string(), U512::from(1_000_000u64), 0, IDENTITY_POLICY_NONE);
    env.set_caller(beta);
    let job_id = reg.with_tokens(U512::from(1_000_000u64)).create_job(skill_id, Bytes::from(b"t".to_vec()), 24 * 60 * 60 * 1_000);
    env.set_caller(alpha);
    reg.deliver_result(job_id, Bytes::from(b"r".to_vec()));
    let bond = dispute_bond_for(1_000_000);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reg.resolve_panel_default(job_id)
    }));
    assert!(result.is_err()); // PanelVoteWindowOpen
}

#[test]
fn p1b_resolve_panel_default_after_window_refunds_requester_and_pays_partial_voters() {
    let (env, mut reg, alpha, beta) = setup();
    let (arb1, _arb2, _arb3) = seed_panel(&env, &mut reg);
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    let fee_proposal = reg.propose_set_panel_arbiter_fee(U512::from(300_000u64));
    env.advance_block_time_by(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(fee_proposal);

    env.set_caller(alpha);
    let skill_id = reg.register_skill("panel-skill".to_string(), "d".to_string(), "mcp://a".to_string(), U512::from(1_000_000u64), 0, IDENTITY_POLICY_NONE);
    env.set_caller(beta);
    let job_id = reg.with_tokens(U512::from(1_000_000u64)).create_job(skill_id, Bytes::from(b"t".to_vec()), 24 * 60 * 60 * 1_000);
    env.set_caller(alpha);
    reg.deliver_result(job_id, Bytes::from(b"r".to_vec()));
    let bond = dispute_bond_for(1_000_000);
    let fee = U512::from(300_000u64);
    env.set_caller(beta);
    reg.with_tokens(bond + fee).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    // Only 1 of 3 ever votes — never reaches threshold=2.
    env.set_caller(arb1);
    reg.cast_panel_vote(job_id, Verdict::ProviderAtFault);

    env.advance_block_time_by(PANEL_VOTE_WINDOW + 1);
    reg.resolve_panel_default(job_id);

    assert_eq!(reg.get_job(job_id).status, JobStatus::Refunded);
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(1_000_000u64) + bond + bond);
    // Only arb1 voted — gets the whole fee, not a third of it.
    assert_eq!(reg.pending_withdrawals_of(arb1), fee);
}

#[test]
fn p1b_resolve_panel_default_before_provider_responds_reverts() {
    // Distinguishes from resolve_default_concede's job: that function already handles
    // "provider never responded at all"; resolve_panel_default is specifically for "provider
    // DID respond, panel just never reached majority."
    let (env, mut reg, alpha, beta) = setup();
    seed_panel(&env, &mut reg);
    env.set_caller(alpha);
    let skill_id = reg.register_skill("panel-skill".to_string(), "d".to_string(), "mcp://a".to_string(), U512::from(1_000_000u64), 0, IDENTITY_POLICY_NONE);
    env.set_caller(beta);
    let job_id = reg.with_tokens(U512::from(1_000_000u64)).create_job(skill_id, Bytes::from(b"t".to_vec()), 24 * 60 * 60 * 1_000);
    env.set_caller(alpha);
    reg.deliver_result(job_id, Bytes::from(b"r".to_vec()));
    let bond = dispute_bond_for(1_000_000);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    // alpha never calls respond_to_dispute.
    env.advance_block_time_by(PANEL_VOTE_WINDOW + 1);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reg.resolve_panel_default(job_id)
    }));
    assert!(result.is_err()); // ProviderNotResponded
}
```

- [ ] **Step 2: Run — verify FAIL**
  `cargo +nightly test --manifest-path contracts-odra/Cargo.toml p1b_resolve_panel_default` →
  expected: fails to compile (`resolve_panel_default` doesn't exist yet).

- [ ] **Step 3: Write the implementation** (near `resolve_default_concede`, after line ~880):
```rust
    /// P4-A: Anyone may call once `PANEL_VOTE_WINDOW` elapses without the panel reaching
    /// majority. Defaults `ProviderAtFault` — the same direction `resolve_default_concede`
    /// already defaults to for an unresponsive provider — because non-participation is treated
    /// as the panel-operator side's risk, not the requester's (audit-design's resolved OQ).
    /// Requires the provider to have already responded (bonded); an unresponsive PROVIDER is
    /// still `resolve_default_concede`'s job, unchanged.
    pub fn resolve_panel_default(&mut self, job_id: u64) {
        let j = self.require_job(job_id);
        if j.status != JobStatus::Disputed {
            self.env().revert(Error::NotDisputed);
        }
        if self.dispute_arbitration_mode.get(&job_id) != Some(ArbitrationMode::Panel) {
            self.env().revert(Error::WrongArbitrationMode);
        }
        let d = self.disputes.get(&job_id)
            .unwrap_or_else(|| self.env().revert(Error::NotBondedDispute));
        if d.provider_bond.is_zero() {
            self.env().revert(Error::ProviderNotResponded);
        }
        if self.env().get_block_time() <= d.disputed_at + PANEL_VOTE_WINDOW {
            self.env().revert(Error::PanelVoteWindowOpen);
        }

        self.settle_dispute_verdict(job_id, j, d.dispute_bond, d.provider_bond, Verdict::ProviderAtFault);
        self.env().emit_event(PanelDefaultResolved { job_id });

        let votes = self.panel_votes.get(&job_id).unwrap_or_default();
        self.distribute_panel_fee(job_id, &votes);
    }
```

- [ ] **Step 4: Run — verify PASS**
  `cargo +nightly test --manifest-path contracts-odra/Cargo.toml p1b_resolve_panel_default` →
  expected: `3 passed; 0 failed`.
- [ ] **Step 5: Run full suite** `cargo +nightly test --manifest-path contracts-odra/Cargo.toml`
  → expected: `146 passed; 0 failed`.
- [ ] **Step 6: Commit** `git commit -m "feat(casper): resolve_panel_default liveness backstop"`

---

## Task 6: Extend both property-based invariant tests to the panel path

**Files:**
- Modify: `contracts-odra/src/agent_skill_registry/proptests.rs`

This is a required acceptance criterion (spec §4), not optional — it's the direct fix for the
original audit-design finding that flagged this exact feature shape as needing proptest coverage
before it can be considered done.

- [ ] **Step 1: Write the failing tests** (append inside the existing `proptest! { ... }` block,
  after `reputation_stays_within_bounds_over_many_rounds`):
```rust
    /// Panel-mode mirror of `escrow_is_conserved_across_arbitrated_dispute` — same invariant,
    /// routed through dispute_result_via_panel + cast_panel_vote (3-arbiter panel, 2-of-3)
    /// instead of dispute_result + arbitrate. Fee flows are asserted separately (fee is
    /// additive to the bond math, not a slice of it — audit-design HIGH #1 in practice).
    #[test]
    fn escrow_is_conserved_across_panel_arbitrated_dispute(
        price in 1_000_000u64..10_000_000_000u64,
        provider_at_fault in proptest::bool::ANY,
        panel_fee in 0u64..5_000_000u64,
    ) {
        let (env, mut reg, alpha, beta) = setup();
        let deployer = env.get_account(0);
        let arb1 = env.get_account(3);
        let arb2 = env.get_account(4);
        let arb3 = env.get_account(5);

        env.set_caller(deployer);
        let panel_proposal = reg.propose_set_arbiter_panel(vec![arb1, arb2, arb3], 2);
        env.advance_block_time_by(DEFAULT_TIMELOCK_DELAY + 1);
        reg.execute_proposal(panel_proposal);
        let fee_proposal = reg.propose_set_panel_arbiter_fee(U512::from(panel_fee));
        env.advance_block_time_by(DEFAULT_TIMELOCK_DELAY + 1);
        reg.execute_proposal(fee_proposal);

        env.set_caller(alpha);
        let skill_id = reg.register_skill(
            "prop-panel".to_string(), "proptest panel skill".to_string(), "mcp://alpha".to_string(),
            U512::from(price), 0, IDENTITY_POLICY_NONE,
        );
        env.set_caller(beta);
        let job_id = reg.with_tokens(U512::from(price))
            .create_job(skill_id, Bytes::from(b"proptest-panel-task".to_vec()), 24 * 60 * 60 * 1_000);
        env.set_caller(alpha);
        reg.deliver_result(job_id, Bytes::from(b"proptest-panel-result".to_vec()));

        let bond = dispute_bond_for(price);
        let fee = U512::from(panel_fee);
        env.set_caller(beta);
        reg.with_tokens(bond + fee).dispute_result_via_panel(job_id);
        env.set_caller(alpha);
        reg.with_tokens(bond).respond_to_dispute(job_id);

        let verdict = if provider_at_fault { Verdict::ProviderAtFault } else { Verdict::RequesterAtFault };
        env.set_caller(arb1);
        reg.cast_panel_vote(job_id, verdict);
        env.set_caller(arb2);
        reg.cast_panel_vote(job_id, verdict); // 2-of-3 reached, settles

        let expected_bond_payout = U512::from(price) + bond + bond;
        let (winner, loser) = if provider_at_fault { (beta, alpha) } else { (alpha, beta) };

        prop_assert_eq!(reg.pending_withdrawals_of(winner), expected_bond_payout);
        prop_assert_eq!(reg.pending_withdrawals_of(loser), U512::zero());

        // Fee conservation, checked separately from bond conservation: exactly `fee` total
        // credited to arbiters, split across the 2 who voted, arb3 gets zero.
        let arb_total = reg.pending_withdrawals_of(arb1) + reg.pending_withdrawals_of(arb2);
        prop_assert_eq!(arb_total, fee);
        prop_assert_eq!(reg.pending_withdrawals_of(arb3), U512::zero());

        // Global conservation: bond-path payout + fee-path payout together equal exactly what
        // was attached across all 3 payable calls (escrow + 2×bond + fee), no more, no less.
        let total_credited = reg.pending_withdrawals_of(winner)
            + reg.pending_withdrawals_of(loser)
            + reg.pending_withdrawals_of(arb1)
            + reg.pending_withdrawals_of(arb2)
            + reg.pending_withdrawals_of(arb3);
        prop_assert_eq!(total_credited, expected_bond_payout + fee);
    }

    /// Panel-mode mirror of `reputation_stays_within_bounds_over_many_rounds` — same invariant,
    /// routed through the panel path over a random-length sequence of rounds.
    #[test]
    fn reputation_stays_within_bounds_over_many_panel_rounds(
        rounds in proptest::collection::vec(proptest::bool::weighted(0.7), 1..40),
    ) {
        let (env, mut reg, alpha, beta) = setup();
        let deployer = env.get_account(0);
        let arb1 = env.get_account(3);
        let arb2 = env.get_account(4);
        let arb3 = env.get_account(5);
        env.set_caller(deployer);
        let panel_proposal = reg.propose_set_arbiter_panel(vec![arb1, arb2, arb3], 2);
        env.advance_block_time_by(DEFAULT_TIMELOCK_DELAY + 1);
        reg.execute_proposal(panel_proposal);

        env.set_caller(alpha);
        let skill_id = reg.register_skill(
            "prop-panel-rep".to_string(), "proptest panel reputation skill".to_string(),
            "mcp://alpha".to_string(), U512::from(1_000_000u64), 0, IDENTITY_POLICY_NONE,
        );

        for (i, provider_at_fault) in rounds.iter().enumerate() {
            let task_label = format!("prop-panel-rep-round-{i}");

            env.set_caller(beta);
            let job_id = reg.with_tokens(U512::from(1_000_000u64))
                .create_job(skill_id, Bytes::from(task_label.clone().into_bytes()), 24 * 60 * 60 * 1_000);
            env.set_caller(alpha);
            reg.deliver_result(job_id, Bytes::from(format!("{task_label}-result").into_bytes()));

            let bond = dispute_bond_for(1_000_000);
            env.set_caller(beta);
            reg.with_tokens(bond).dispute_result_via_panel(job_id);
            env.set_caller(alpha);
            reg.with_tokens(bond).respond_to_dispute(job_id);

            let verdict = if *provider_at_fault { Verdict::ProviderAtFault } else { Verdict::RequesterAtFault };
            env.set_caller(arb1);
            reg.cast_panel_vote(job_id, verdict);
            env.set_caller(arb2);
            reg.cast_panel_vote(job_id, verdict);

            let skill_rep = reg.get_skill(skill_id).reputation_score;
            let agent_rep = reg.agent_reputation(alpha);

            prop_assert!(
                (REP_FLOOR..=MAX_REPUTATION).contains(&skill_rep),
                "panel round {i}: skill reputation {skill_rep} left [{REP_FLOOR}, {MAX_REPUTATION}]",
            );
            prop_assert!(
                (REP_FLOOR..=MAX_REPUTATION).contains(&agent_rep),
                "panel round {i}: agent reputation {agent_rep} left [{REP_FLOOR}, {MAX_REPUTATION}]",
            );
        }
    }
```

- [ ] **Step 2: Run — verify FAIL**
  `cargo +nightly test --manifest-path contracts-odra/Cargo.toml escrow_is_conserved_across_panel reputation_stays_within_bounds_over_many_panel`
  → expected: fails to compile until Tasks 3-5 are in place (this task assumes they already
  are, since it's sequenced after them).
- [ ] **Step 3: Run — verify PASS** (same command) → expected: `2 passed; 0 failed`, each
  running all 64 randomized cases.
- [ ] **Step 4: Run full suite** `cargo +nightly test --manifest-path contracts-odra/Cargo.toml`
  → expected: `148 passed; 0 failed`.
- [ ] **Step 5: Commit** `git commit -m "test(casper): extend both proptest invariants to panel-mode settlement"`

---

## Task 7: `live_client.ts` — new client methods

**Files:**
- Modify: `src/lib/casper/live_client.ts` (new methods, mirroring `arbitrate` at line 418-424)

- [ ] **Step 1: Write the implementation** (no separate TDD cycle here — these are thin,
  mechanical wire-encoding wrappers with no branching logic to unit-test in isolation; they're
  exercised end-to-end by Task 8's tool tests via a mocked `CasperClientLike`, matching how
  `arbitrate`/`disputeResult` are already tested at the tool layer, not the client layer):
```typescript
  async proposeSetArbiterPanel(
    signer: CasperPrivateKey,
    panel: CasperAddress[],
    threshold: number,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      panel: CLValue.newCLList(CLTypeKey, panel.map((a) => CLValue.newCLKey(addressToKey(a)))),
      threshold: CLValue.newCLUint32(threshold),
    });
    return this.submit(signer, "propose_set_arbiter_panel", args, paymentMotes);
  }

  async proposeSetPanelArbiterFee(
    signer: CasperPrivateKey,
    feeMotes: bigint,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({ fee: CLValue.newCLUInt512(feeMotes.toString()) });
    return this.submit(signer, "propose_set_panel_arbiter_fee", args, paymentMotes);
  }

  async disputeResultViaPanel(
    signer: CasperPrivateKey,
    jobId: bigint,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submit(signer, "dispute_result_via_panel", args, paymentMotes);
  }

  async castPanelVote(
    signer: CasperPrivateKey,
    jobId: bigint,
    verdict: Verdict,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      job_id: CLValue.newCLUint64(jobId.toString()),
      verdict: CLValue.newCLUint8(VERDICT_DISCRIMINANT[verdict]),
    });
    return this.submit(signer, "cast_panel_vote", args, paymentMotes);
  }

  async resolvePanelDefault(
    signer: CasperPrivateKey,
    jobId: bigint,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submit(signer, "resolve_panel_default", args, paymentMotes);
  }

  async getArbiterPanel(): Promise<CasperAddress[]> {
    const clValue = await this.readVar(AGENT_SKILL_REGISTRY_FIELD_INDEX.arbiterPanel);
    return decodeAddressVec(odraStructBytes(clValue));
  }

  async getPanelThreshold(): Promise<number> {
    const clValue = await this.readVar(AGENT_SKILL_REGISTRY_FIELD_INDEX.panelThreshold);
    return decodeU32(odraStructBytes(clValue));
  }
```

> **Note for the implementing engineer:** `readVar`, `AGENT_SKILL_REGISTRY_FIELD_INDEX`,
> `decodeAddressVec`, `decodeU32`, and `addressToKey` are named per the existing conventions
> this file already uses for every other field/read (see `getArbiter`/`getGovernanceSigners`
> next to `arbiter`/`governance_signers` in the same file) — wire them to the ACTUAL existing
> helper names in this file rather than inventing new ones; if an equivalent helper doesn't
> exist yet for a `Vec<Address>` or bare `u32` field read, add it following the exact pattern of
> the nearest existing decoder in `odra_codec.ts`, don't improvise a new decoding convention.
> Also add `arbiterPanel`, `panelThreshold`, `panelArbiterFee` entries to
> `AGENT_SKILL_REGISTRY_FIELD_INDEX` at whatever the next free field index is (Task 1's Rust
> struct field order determines this — count the struct fields in declaration order).

- [ ] **Step 2: Typecheck** `pnpm typecheck` → expected: no new errors attributable to this file
  (pre-existing unrelated errors in this repo, e.g. missing `@casper-ecosystem/casper-eip-712`,
  are not this task's concern — confirm via `pnpm typecheck 2>&1 | grep live_client` returning
  nothing new).
- [ ] **Step 3: Commit** `git commit -m "feat(casper): live_client.ts panel-arbitration methods"`

---

## Task 8: `casper.tool.ts` — new MCP tools

**Files:**
- Modify: `src/plugins/casper.tool.ts` (new tools, mirroring `casperArbitrate` at line 798-825; `CasperClientLike` Pick-list at line 75-121)
- Test: `src/__tests__/casper_tool.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `casper_tool.test.ts`, following the
  existing `fakeClient` + `find(tools, ...)` pattern already used for `casper_arbitrate`):
```typescript
  it("casper_propose_set_arbiter_panel forwards panel + threshold", async () => {
    const client = fakeClient({
      proposeSetArbiterPanel: vi.fn(async () => ({ txHash: "tx-panel-proposal" })),
    });
    const tools = createCasperTools(() => client);
    const result = await find(tools, "casper_propose_set_arbiter_panel").handler(
      { agentId: "gov1", panel: ["account-hash-" + "aa".repeat(32), "account-hash-" + "bb".repeat(32), "account-hash-" + "cc".repeat(32)], threshold: "2" },
      {} as never,
    );
    expect(client.proposeSetArbiterPanel).toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ txHash: "tx-panel-proposal" });
  });

  it("casper_dispute_result_via_panel forwards jobId", async () => {
    const client = fakeClient({
      disputeResultViaPanel: vi.fn(async () => ({ txHash: "tx-panel-dispute" })),
    });
    const tools = createCasperTools(() => client);
    const result = await find(tools, "casper_dispute_result_via_panel").handler(
      { agentId: "req1", jobId: "3" },
      {} as never,
    );
    expect(client.disputeResultViaPanel).toHaveBeenCalledWith(SIGNER, 3n);
    expect(result.structuredContent).toMatchObject({ txHash: "tx-panel-dispute" });
  });

  it("casper_cast_panel_vote forwards jobId + verdict", async () => {
    const client = fakeClient({
      castPanelVote: vi.fn(async () => ({ txHash: "tx-panel-vote" })),
    });
    const tools = createCasperTools(() => client);
    const result = await find(tools, "casper_cast_panel_vote").handler(
      { agentId: "arb1", jobId: "3", verdict: "ProviderAtFault" },
      {} as never,
    );
    expect(client.castPanelVote).toHaveBeenCalledWith(SIGNER, 3n, "ProviderAtFault");
    expect(result.structuredContent).toMatchObject({ txHash: "tx-panel-vote" });
  });

  it("casper_resolve_panel_default forwards jobId, no access control beyond the window", async () => {
    const client = fakeClient({
      resolvePanelDefault: vi.fn(async () => ({ txHash: "tx-panel-default" })),
    });
    const tools = createCasperTools(() => client);
    const result = await find(tools, "casper_resolve_panel_default").handler(
      { jobId: "3", callerAgentId: "anyone" },
      {} as never,
    );
    expect(client.resolvePanelDefault).toHaveBeenCalledWith(SIGNER, 3n);
    expect(result.structuredContent).toMatchObject({ txHash: "tx-panel-default" });
  });
```

- [ ] **Step 2: Run — verify FAIL**
  `pnpm exec vitest run src/__tests__/casper_tool.test.ts -t "panel"` → expected: fails (tools
  don't exist yet, `client.proposeSetArbiterPanel` etc. aren't in `CasperClientLike`).

- [ ] **Step 3: Add the 4 new methods to `CasperClientLike`'s Pick-list** (line 75-121):
```typescript
  | "proposeSetArbiterPanel"
  | "proposeSetPanelArbiterFee"
  | "disputeResultViaPanel"
  | "castPanelVote"
  | "resolvePanelDefault"
  | "getArbiterPanel"
  | "getPanelThreshold"
```

- [ ] **Step 4: Write the tool definitions** (next to `casperArbitrate`, following its exact
  shape):
```typescript
  const casperProposeSetArbiterPanel: ToolDefinition = {
    name: "casper_propose_set_arbiter_panel",
    description:
      "Governance-signer only: propose a new N-of-M arbiter panel (odd size >= 3, threshold " +
      "must be strict majority) — same propose/approve/execute + timelock lifecycle as " +
      "casper_propose_set_arbiter, no single-signer bypass.",
    inputSchema: {
      agentId: z.string().describe("Governance signer's keystore agent id."),
      panel: z.array(z.string()).describe("Arbiter addresses — length must be odd, >= 3."),
      threshold: z.string().regex(/^[0-9]+$/).describe("Must equal panel.length / 2 + 1."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        panel: z.array(z.string()),
        threshold: z.string().regex(/^[0-9]+$/),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.proposeSetArbiterPanel(signer, a.panel, Number(a.threshold));
      return reply(`[KARMA] casper_propose_set_arbiter_panel broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperDisputeResultViaPanel: ToolDefinition = {
    name: "casper_dispute_result_via_panel",
    description:
      "Like casper_dispute_result, but flags the job for N-of-M panel arbitration and posts " +
      "an additional flat panel-arbiter fee on top of the standard dispute bond. Reverts " +
      "PanelNotConfigured if no panel is set.",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.disputeResultViaPanel(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_dispute_result_via_panel broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperCastPanelVote: ToolDefinition = {
    name: "casper_cast_panel_vote",
    description:
      "Panel-member only: cast one vote on a panel-mode dispute. Settles automatically once " +
      "N-of-M votes agree — no separate 'execute' call needed. Reverts NotPanelArbiter, " +
      "AlreadyVotedOnPanel, or WrongArbitrationMode as appropriate.",
    inputSchema: {
      agentId: z.string().describe("Panel arbiter's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
      verdict: z.enum(["ProviderAtFault", "RequesterAtFault"]),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        jobId: z.string().regex(/^[0-9]+$/),
        verdict: z.enum(["ProviderAtFault", "RequesterAtFault"]),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.castPanelVote(signer, BigInt(a.jobId), a.verdict);
      return reply(`[KARMA] casper_cast_panel_vote broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperResolvePanelDefault: ToolDefinition = {
    name: "casper_resolve_panel_default",
    description:
      "Anyone may call once PANEL_VOTE_WINDOW elapses without the panel reaching majority — " +
      "resolves ProviderAtFault (same default direction as casper_resolve_default_concede) " +
      "and still pays whichever arbiters DID vote.",
    inputSchema: {
      jobId: z.string().regex(/^[0-9]+$/),
      callerAgentId: z.string().describe("Any keystore agent id — no access control beyond the elapsed window."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ jobId: z.string().regex(/^[0-9]+$/), callerAgentId: z.string() }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.callerAgentId);
      const client = makeClient(env);
      const { txHash } = await client.resolvePanelDefault(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_resolve_panel_default broadcast; tx=${txHash}`, { txHash });
    },
  };
```

  Then register the 4 new tools in `createCasperTools`'s returned array, next to the existing
  `casperArbitrate` entry.

- [ ] **Step 5: Run — verify PASS**
  `pnpm exec vitest run src/__tests__/casper_tool.test.ts -t "panel"` → expected: `4 passed; 0
  failed`.
- [ ] **Step 6: Run full test suite** `pnpm test` → expected: same pass count as the current
  baseline (837) + 4, with the same 2 pre-existing unrelated failures as before (confirm via
  `pnpm test 2>&1 | tail -15` — do not accept a DIFFERENT failure count without investigating).
- [ ] **Step 7: Typecheck** `pnpm typecheck 2>&1 | grep -E "casper.tool|casper_tool"` → expected:
  no output (no new errors).
- [ ] **Step 8: Commit** `git commit -m "feat(casper): panel-arbitration MCP tool surface"`

---

## Self-Review

**1. Spec coverage:**
- G1 (opt-in, non-breaking) — Task 2's rollback-verified extraction + Task 3-5's additive-only
  entry points. ✅
- G2 (reuse bond economics unchanged) — panel fee is additive (`required_bond + fee`), never a
  slice of `dispute_bond`/`provider_bond`. ✅
- G3 (reuse governance lifecycle) — Task 3 mirrors `propose_set_arbiter` exactly. ✅
- G4 (eliminate full-participation ties by construction) — Task 3's odd+strict-majority
  validation. ✅
- G5 (liveness via incentive, timeout as backstop) — Task 4's flat fee + Task 5's backstop. ✅
- G6 (one settlement path) — Task 2's `settle_dispute_verdict` extraction, called by both
  `arbitrate` and `cast_panel_vote`. ✅
- Audit HIGH #1 (pull-payment fee distribution) — Task 4's `distribute_panel_fee` credits
  `pending_withdrawals`, never pushes. ✅
- Audit HIGH #3 (mid-dispute governance change) — Task 4's `job_panel_snapshot`/
  `job_panel_threshold_snapshot`, read by `cast_panel_vote` instead of live governance state. ✅
- Audit MEDIUM (remainder handling) — `distribute_panel_fee`'s last-voter-absorbs-remainder,
  mirrors `settle_completion`'s composite payout exactly. ✅
- Audit L1 (min panel size) — Task 3's `PanelSizeTooSmall` check, `MIN_ARBITER_PANEL_SIZE = 3`. ✅
- Audit L6 (events) — Task 1's 7 new event structs, one per new state transition. ✅

**2. Placeholder scan:** none found — every task has complete, compilable-intent code, no
"TBD"/"similar to Task N."

**3. Type consistency:** `ArbitrationMode`, `PanelVote`, `Verdict` used identically across Tasks
1, 3, 4, 5. `job_panel_snapshot`/`job_panel_threshold_snapshot` (not the live `arbiter_panel`/
`panel_threshold`) are the ONLY fields `cast_panel_vote` and `resolve_panel_default` read for
panel membership/threshold — checked for drift across both tasks, consistent.

**4. Risk scoring:** see table below.

**5. Rollback coverage:** Task 2 is the only HIGH-risk task (touches live code); it has a
Step 6/7 rollback plan. All other tasks are purely additive (new functions/files never called by
existing code), so an incomplete/broken task simply doesn't compile or doesn't get invoked — no
rollback plan needed beyond `git revert` of that task's own commit, which is always safe when
nothing later depends on it yet (true for every task here, in sequence).

---

## Risk Summary (task-risk-score)

| Task | Risk | Reason | Decomposed enough? |
|---|---|---|---|
| 1 | LOW | Additive-only storage/types/errors/events, no behavior | Yes |
| 2 | **HIGH** | Extracts logic out of live, already-demoed `arbitrate()` | Yes — has rollback plan (Steps 6/7) |
| 3 | LOW | New governance proposal action, mirrors proven pattern exactly | Yes |
| 4 | MEDIUM | New money-movement path (fee distribution) — mitigated by pull-payment + remainder-absorption fixes already built in, and covered by Task 6's proptest extension | Yes |
| 5 | LOW | Additive backstop, reuses `settle_dispute_verdict` | Yes |
| 6 | LOW | Test-only, no production code | Yes |
| 7 | LOW | Thin wire-encoding wrappers, no branching logic | Yes |
| 8 | LOW | MCP tool definitions, mirrors proven pattern exactly | Yes |

**CROSS boundaries:** Task 2 → Tasks 3-5 (Rust); Tasks 1-6 (Rust) → Tasks 7-8 (TypeScript) — the
field-index note in Task 7 Step 1 is the explicit handoff point where the TS engineer must read
Task 1's actual final struct field order rather than assume it.

**1 HIGH task, 2 CROSS boundaries.**

---

## Execution Handoff

```
Plan complete: docs/super-skills/plans/2026-07-22-panel-arbitration-n-of-m.md
Risk summary: 1 HIGH task (Task 2), 2 CROSS boundaries (Rust→TS at Task 6→7, and the Task 2
rollback dependency noted above)

Execution options:
1. Subagent-Driven (recommended) — fresh subagent per task, specialist-review between tasks
2. Inline Execution — batch execution with checkpoints

Which approach?
```
