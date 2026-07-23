# KARMA — Casper Agentic Buildathon demo (RWA-oracle + x402)

> Casper Agentic Buildathon submission, T13 deliverable of the internal
> stellar-casper-tracks build plan.

This document is the reproduction guide a judge can follow to see KARMA's
RWA-oracle invocation work end-to-end on Casper Testnet: an Odra-backed
`AgentSkillRegistry`, an x402 fast-lane payment via Casper's live x402
Facilitator, and a signed price feed settled by the standard escrow review window.

**Short on time?** [90-second visual walkthrough (live page)](https://eilodon.github.io/KARMA-Eilodon/media/casper-judges.html) — the same
story below, with a real captured terminal transcript instead of a wall of markdown. Or
**[watch the ~2:18 narrated video](docs/media/casper-demo-video.mp4)** — the economic loop, a
real courtroom verdict, and a real 48h-timelock rejection, captured live from the scripts in this
repo (`src/scripts/demo_casper_full_job_lifecycle.ts`, `demo_casper_courtroom.ts`,
`demo_casper_cross_chain_rep_governance.ts`).

## What predates this Buildathon, what's new in it

Stated up front: KARMA's protocol core (identity/reputation/escrow/dispute spec, the MCP
runtime) and its Pharos and Stellar implementations predate the Casper track. **Everything
below — the Odra `AgentSkillRegistry`, the Casper keystore + x402 rail, `live_client.ts`, the
29-tool `casper.tool.ts` MCP surface, the governance-hardened redeploy, every live transaction on
this page, and the LLM-reasoning demo in the next section — was built new for this Buildathon**,
inside the submission window. A pre-existing base is fine to disclose, not fine to hide.

## What this submission does (architecture)

```
Requester agent                        Provider agent + Odra registry on Casper
─────────────                          ─────────────────────────────────────────
1. discover_skills (via KARMA-MCP)     1. Skill registered on `AgentSkillRegistry`
   → rwa_price_oracle hit                 (Odra port — T9, contracts-odra/)
                                       2. Sybil-resistance bond locked (PD-007)

2. create_job(settlement_rail=x402)    3. Provider receives invocation, fetches
   → CasperX402Plugin (T11) builds        BTC/USD price, signs JSON with the
     signed payment envelope              same secp256k1 keystore key (T10)

3. POST /invoke with X-PAYMENT         4. Provider records the result hash on
   header (DER signature + payer +        Odra via `deliver_result(jobId, hash)`
   payee + amount + nonce + TTL)

4. Verify provider's signed feed +     5. CSPR escrow credited to the provider's
   call `confirm_completion`              pull-payment ledger (CEI)

5. Provider calls `withdraw` to        6. Skill reputation +5; agent reputation
   pull the CSPR escrow                   +5 (arm's-length, self-deal-safe)
```

Closes one open architectural gap in KARMA's production trust model: Pharos
was the single chain for paid jobs. Casper adds a second escrow rail AND a
live x402 fast-lane (announced with the Casper AI Toolkit) so AI agents can
settle micropayments per HTTP request, no human in the loop.

## Building blocks (everything in this repo)

| Layer | Path | Status |
|---|---|---|
| Odra `AgentSkillRegistry` port | [`contracts-odra/`](contracts-odra/) (T9) | `cargo +nightly test` 155/155 |
| Casper secp256k1 keystore adapter | [`src/lib/casper/keypair.ts`](src/lib/casper/keypair.ts) (T10) | 12/12 tests |
| x402Plugin/Casper | [`src/plugins/x402_casper.ts`](src/plugins/x402_casper.ts) (T11) | 28/28 tests — `verifyCasperExactPayload` is real ECDSA/SHA-256, not structural |
| KARMA × Casper composability demo | [`src/scripts/demo_casper_composability.ts`](src/scripts/demo_casper_composability.ts) (T12) | runs end-to-end |
| RWA-oracle registration script | [`src/scripts/register_rwa_oracle_skill.ts`](src/scripts/register_rwa_oracle_skill.ts) (T13) | dry-run by default; `--live` builds + signs + submits a real `casper-js-sdk` transaction |
| RWA-oracle e2e demo | [`src/scripts/demo_casper_e2e.ts`](src/scripts/demo_casper_e2e.ts) (T13) | runs end-to-end (offline state machine) |
| Live x402 HTTP loop | [`src/scripts/demo_casper_x402_live.ts`](src/scripts/demo_casper_x402_live.ts) (T13-live) | real local HTTP 402 → sign → verify round trip; `--live` adds the on-chain `create_job` leg |
| Real RPC client (register/deposit/create_job/deliver/confirm/withdraw + 3 live reads) | [`src/lib/casper/live_client.ts`](src/lib/casper/live_client.ts) (T13-live) | 14/14 tests — builds, signs, and submits real `casper-js-sdk` transactions; reads query the on-chain "state" dictionary directly |
| **MCP tool surface** — the RWA-oracle flow as 8 real MCP tools, not just scripts | [`src/plugins/casper.tool.ts`](src/plugins/casper.tool.ts) (T13-live) | 12/12 tests — any MCP client can call `casper_register_skill`, `casper_create_job`, `casper_get_account_state`, etc. directly |
| **LLM agent reasoning** — a real Claude call chooses among safety-checked skills and explains why, instead of a fixed formula | [`src/lib/autonomous_loop/llm_strategy.ts`](src/lib/autonomous_loop/llm_strategy.ts), [`src/scripts/demo_llm_agent_reasoning.ts`](src/scripts/demo_llm_agent_reasoning.ts) (T5.2) | 5/5 tests (fake provider, no network); real Anthropic call when `ANTHROPIC_API_KEY` is set — see next section |

## Quick start — offline orchestration (no Casper credentials needed)

This shows the FULL DATA FLOW end-to-end without touching the live network.
A judge can run it in any clean clone of the repo:

```bash
# 1. Install JS deps
pnpm install --frozen-lockfile

# 2. Compile + run the Odra contract tests (proves the port mirrors Solidity v4)
rustup toolchain install nightly --profile minimal
cargo +nightly test --manifest-path contracts-odra/Cargo.toml
# Expected: 155 passed; 0 failed.

# 3. Run the composability demo — shows the KARMA-MCP × Casper-MCP cross-server flow
pnpm exec tsx src/scripts/demo_casper_composability.ts

# 4. Run the RWA-oracle end-to-end demo — full job lifecycle (8 boxed steps)
pnpm exec tsx src/scripts/demo_casper_e2e.ts

# 5. Print the live `register_skill` recipe the deployer would run on Casper Testnet
pnpm exec tsx src/scripts/register_rwa_oracle_skill.ts
```

Expected output: the e2e demo prints 8 numbered boxes covering register →
deposit_bond → discover → create_job (x402) → fetch+sign feed → deliver_result →
confirm_completion → withdraw. The Step 4 x402 envelope and the Step 7 feed
verification are produced by REAL T10/T11 code, not stubbed.

## Agent reasoning — a real LLM inside the loop, not just deterministic code

The autonomous economic loop (`src/lib/autonomous_loop/loop.ts`) picks skills with a
deterministic formula: highest `expectedReturn − price`, tie-broken by reputation. That formula
is real and tested, but it cannot explain a choice or weigh anything it doesn't encode — e.g. "the
highest-EV skill here is also the newest provider with almost no track record; is that worth the
risk?" is exactly the kind of judgment call a fixed formula can't make and an LLM can.

`src/lib/autonomous_loop/llm_strategy.ts` adds that layer **without touching the safety rails**:
`filterEligible()` (the same budget/per-tx/per-hour hard caps `decide()` always used, unchanged
and still covered by `autonomous_loop.test.ts`) runs first, and only *then* does a
`ReasoningProvider` — a real Claude call via `buildAnthropicReasoningProvider` — get to choose
*among* whatever survives. If the model names a skill outside that already-safe set (hallucination)
or the API call fails, `decideWithReasoning` falls back to the exact same deterministic pick —
an LLM can upgrade the decision, never bypass the kernel that guards real money.

```bash
pnpm demo:llm-agent                                    # offline: deterministic pick only, explains how to add the LLM leg
ANTHROPIC_API_KEY=sk-ant-... pnpm demo:llm-agent        # live: a real Claude call reasons over the same candidates
```

The offline run alone already shows the deterministic pick and the exact safety-filtered
candidate set; the live run prints the LLM's actual rationale next to it, and flags explicitly
whether the LLM agreed with the formula or diverged from it. The market data in the demo is
deliberately adversarial to a pure-EV formula — the highest expected-profit skill also has the
weakest reputation of the three (a brand-new, unaudited provider) — so a reasoning agent has
something real to weigh, not just a rubber stamp of whatever the formula would have picked anyway.
`src/__tests__/llm_strategy.test.ts` covers all of this — no-candidates short-circuit (the
provider is never called when there's nothing to choose from), a valid LLM pick, a hallucinated
skillId falling back, and a thrown API error falling back — entirely with a fake `ReasoningProvider`,
no network required to prove the logic is correct.

## Attestation-hardening redeploy — DONE (2026-07-21)

Adds on-chain LLM-decision attestation (P2-A: `attest_rationale`/`get_rationale_hash` — a
requester commits a hash of their agent's stated reasoning for a job; a third party holding the
plaintext independently re-hashes and compares against this on-chain value) on top of everything
the 2026-07-07 governance-hardening redeploy already proved. Storage is purely additive
(`Mapping<u64, Bytes>`, field index 25) — nothing about the existing `Job`/`Skill` schema changed.

**Current live contract: `hash-42f6945fe9ac5ab493beed468465228ecb830036e27bb2c8cac9e1736a2b5a1d`**
(supersedes `hash-29b7daebfc4fb924b340f06ea5d367d590b1ebc27f644d404738a5c5ccbad5aa`, which is now
retired — its own history is preserved below for the record, but new demos/tooling target the new
hash). Deployed via the same `deploy_casper_governance_hardened.ts` recipe (unchanged — the P2-A
feature needed no new deploy args), from a freshly-generated governance-signer-2 keypair funded by
a native transfer, with the identical security shape as before: 2 signers, threshold 2, 48h
timelock — independently verified against the contract's own storage, not just the deploy args:

```
governance_signers  = [account-hash-0daa27a3…, account-hash-d22cc952…]  (2 signers)
governance_threshold = 2
timelock_delay_ms    = 172800000  (48h)
```

**Every flow below was re-run fresh against the new contract, same-day, 23 real transactions
total** (deploy + funding + lifecycle + courtroom + governance + the new P2-A attestation demo —
see the tx tables in each section and [Recorded live transactions](#recorded-live-transactions)):

| Tx | Hash |
|---|---|
| Install deploy (attestation-hardened) | `f93aa2368b29e5d5ea8fecebd6f44e1c6e4670e825c9907ceb7d20a9586dca69` |
| Fund governance signer 2 (300 CSPR) | `2701ee9bb7f8553a61cf3359d0260ec7cb2d374bd89532c98ace27d2e4553da6` |

### P2-A: `attest_rationale` / `get_rationale_hash` — DONE live (2026-07-21)

`job_id=3`, created against `skill_id=1` (the full-lifecycle skill below). Rationale text is the
kind of plain-English justification `decideWithReasoning` (`src/lib/autonomous_loop/llm_strategy.ts`)
produces when an LLM picks a skill to invoke:

> "Chose skill #1 (casper_full_lifecycle_demo) over other eligible candidates: expected return
> 0.015 CSPR vs price 0.01 CSPR (EV +0.005), and provider reputation 55/100 clears the trust
> threshold for this budget tier. Rejected higher-EV alternative from a rep-20 provider as too
> risky for the position size."

| Step | Tx hash | Result |
|---|---|---|
| `create_job` (job_id=3) | `b873d9e83ef21f260064034e23e6df7ee544a8d8d325113a4aa7a51c1dfcb3b8` | success |
| `attest_rationale(3, sha256(rationale))` | `a6c6c23ba84a4c9d5af7ba60ca1b2bef43276f23fadaf19d9083bdc24c940c72` | success |
| `get_rationale_hash(3)` read after | — (free RPC read) | `3aeb6001dd1ab1256e0327b3abaa520cd0e08a7fce5733ab877f2058d6965f74` — byte-for-byte match with `sha256(rationale text)`, independently recomputed off-chain |
| `attest_rationale(3, …)` again (double-attest) | `96ab9e2d423b2370a8bd0f2c477d549b97b5018cdc65f9455d9e5cb2eab91d9d` | **Reverted, `errorMessage: "User error: 54"`** = `Error::RationaleAlreadyAttested`, confirmed by ordinal |
| `create_job` (job_id=4, separate job) | `f60d1c954882007e21bea94ef848328995fb10ae749004287afbdae725b5dc18` | success |
| `attest_rationale(4, …)` as the **provider**, not the requester | `6c4205a12ef4b72f8fe6fed9abb9dbbafb25b01780f4f94ce37d1578b3a45b61` | **Reverted, `errorMessage: "User error: 13"`** = `Error::NotRequester`, confirmed by ordinal |

`get_rationale_hash(4)` reads back `null` — the wrong-caller attempt really didn't write anything,
not just returned an error while mutating state.

## Governance-hardening redeploy — DONE (2026-07-07, historical — superseded by the attestation-hardened redeploy above)

A code-level review of the original contract (`hash-a4e8ab23fe6bd87c97239bbc1292a2224cb34efc4f81a6c94edf06a7794f404f`,
now superseded) found two gaps and closed both in source, then redeployed. **Current live
contract: `hash-29b7daebfc4fb924b340f06ea5d367d590b1ebc27f644d404738a5c5ccbad5aa`**
(tx `c59518d18bc5096d820a3450aa64a93c116caf7cfe3fc403a79607d7cfcb203b`), verified live via RPC:
`GovernanceConfigured` event decoded directly off-chain confirms `threshold=2`,
`timelock_delay_ms=172800000` (48h) — the real multisig+timelock, not just the deploy args as
submitted. Recipe used: `src/scripts/deploy_casper_governance_hardened.ts`.

1. **Governance inconsistency (fixed in source, needs redeploy):** `set_arbiter`/
   `set_dispute_bond_bps` used to take effect immediately behind a single `require_governance_signer()`
   check — no multisig threshold, no timelock — while `set_cross_chain_rep` already went through the
   full propose/approve/execute + 48h-timelock lifecycle. Both setters are now `propose_set_arbiter`/
   `propose_set_dispute_bond_bps`, gated by the exact same proposal lifecycle (`agent_skill_registry.rs`,
   `ProposalAction::SetArbiter`/`SetDisputeBondBps`). Verified: 131/131 Rust tests pass, wasm rebuilt
   (`./build-wasm.sh`) and its exports independently confirmed via `WebAssembly.Module.exports()` —
   `propose_set_arbiter`/`propose_set_dispute_bond_bps` present, the old `set_arbiter`/
   `set_dispute_bond_bps` entry points gone.
2. **Deploy-time governance config was effectively a single key, not a multisig:** the recipe below
   (as run for the current live deploy) used `governance_threshold: 1` with **one** signer and
   `timelock_delay_ms: "0"` — i.e. propose→execute could happen back-to-back by one signer, with no
   real delay. If the "no single-key admin risk" claim matters for judging, the *redeploy* args need
   ≥2 real independent signers, a threshold ≥2, and a non-zero `timelock_delay_ms` (e.g.
   `"172800000"` = 48h, matching `DEFAULT_TIMELOCK_DELAY` in source) — not just the code fix above.

**Recipe actually used** (`src/scripts/deploy_casper_governance_hardened.ts`, via `casper-js-sdk`'s
`SessionBuilder` directly rather than the `casper-client` CLI — same auth-header reasoning as the
original deploy, see Step 0 below):

```ts
const transaction = new SessionBuilder()
  .from(signer1.publicKey)
  .wasm(wasmBytes)
  .installOrUpgrade()          // ← REQUIRED — see gotcha below
  .runtimeArgs(Args.fromMap({
    odra_cfg_package_hash_key_name: CLValue.newCLString("AgentSkillRegistry"),
    odra_cfg_allow_key_override: CLValue.newCLValueBool(false),
    odra_cfg_is_upgradable: CLValue.newCLValueBool(true),
    odra_cfg_is_upgrade: CLValue.newCLValueBool(false),
    odra_cfg_constructor: CLValue.newCLString("init"),
    review_window_ms: CLValue.newCLUint64("259200000"),
    governance_signers: CLValue.newCLList(CLTypeKey, [
      CLValue.newCLKey(Key.newKey(signer1AccountHash)),
      CLValue.newCLKey(Key.newKey(signer2AccountHash)),
    ]),
    governance_threshold: CLValue.newCLUInt32(2),
    timelock_delay_ms: CLValue.newCLUint64("172800000"),
  }))
  .chainName("casper-test")
  .payment(800_000_000_000)
  .build();
```

**Gotcha found the hard way:** without `.installOrUpgrade()`, the deploy is submitted as a plain
session and Casper rejects it with `ApiError::NotAllowedToAddContractVersion [48]` — and the full
gas payment is still consumed on failure (no refund), so the first attempt cost ~800 CSPR for
nothing before this was caught. The second attempt (with `.installOrUpgrade()`) succeeded and
*did* refund the unused portion (~161 of 800 CSPR) — so "no refund on this network" isn't a
blanket rule, it was specific to that failure mode.

3. **Upgrade-token custody (unchanged by the code fix, still open):** Odra's install deploy writes
   an `_access_token` named key to the deploying account; whoever holds it can push a contract
   upgrade later, entirely outside the `governance_signers`/timelock gate above — a real, separate
   single-key surface (currently held by governance signer 1's key, since it doubled as the
   installing account). Two options, not mutually exclusive with the fix above: (a) move it to a
   dedicated multisig-controlled account, or (b) set `odra_cfg_is_upgradable: false` on a later
   "final" redeploy once the contract is believed feature-complete, trading future upgradability
   for a stronger "no single key, period" claim. Not resolved here — this needs a decision.

The MCP/client-side work needed to actually *use* the redeployed contract's fuller surface
(composition, evaluator/dispute/arbitration, cross-chain-rep governance) was already wired and
tested before the redeploy — see `casper.tool.ts`'s 25 tools — so `KARMA_ODRA_REGISTRY` (already
updated in `.env`) was the only thing that needed changing for all of it to go live.

## Cross-chain-rep governance chain — propose + approve DONE live, execute pending timelock (2026-07-07, re-run 2026-07-21)

> **Re-run 2026-07-21 against the attestation-hardened contract** (`hash-42f6945f…`, `proposal_id=1`
> on the fresh registry): propose → approve → attempted execute, same outcome as the original run
> below.
>
> | Step | Tx hash | Result |
> |---|---|---|
> | `propose_set_cross_chain_rep` (signer 1) | `c419cac985c43568806f36d8b46f6ab13dd0567c763c2ab93695bb6ed346577d` | success. Event count 15→17 |
> | `approve_proposal` (signer 2) | `6a648b4d03c00dd1905e5342e962cb784e9858a881c919c4e1b73a7dd3d4a81e` | success, threshold 2/2. Event count 17→18 |
> | `execute_proposal` (attempted immediately) | `7313fec0a98dc30cfec7dd120c04c0ebf405bc57f288321504095f4bb57fa6dc` | **Reverted, `errorMessage: "User error: 42"`** = `Error::TimelockNotElapsed`, confirmed by ordinal |

Fired a real `propose_set_cross_chain_rep` → `approve_proposal` chain against the governance-hardened
contract above, via `src/scripts/demo_casper_cross_chain_rep_governance.ts` — the concrete evidence
that "reputation is portable across chains via a governed multisig+timelock flow, not a single-key
override" isn't just unit-tested, it ran for real. Target agent is governance signer 2's own Casper
account-hash (no extra keystore needed); `score=80`, `source_chain="soroban"` echo the Stellar ZK
`ReputationAggregationProof` narrative (avg score ≥ 80 across ≥ 10 jobs, ≥ 5 domains).

| Step | Tx hash | Result |
|---|---|---|
| `propose_set_cross_chain_rep` (signer 1) | `1a7f2bcf7d02e5ccf4a46365586e336dc4c955927e822aa058f000e5d397e1ac` | `errorMessage: null`. Auto-approves the proposer (1/2). Event count 1→3 (`ProposalCreated` + `ProposalApproved`). |
| `approve_proposal` (signer 2) | `9cadc5dbae1111df86f3b4bbb9847dac947aef7af97bb85f62cf6d42151c2aeb` | `errorMessage: null`. Threshold met (2/2). Event count 3→4. |
| `execute_proposal` (attempted immediately) | `408563d08067a36cf4e9d6c01308dbaad4a80c62c18a4f0f03c3d5181e430d4c` | **Reverted, `errorMessage: "User error: 42"`** — `Error::TimelockNotElapsed` (`contracts-odra/src/agent_skill_registry.rs:95`), confirmed by ordinal, not guessed. `refund: 0` (failed txs don't refund on this network — same gotcha as the redeploy above). |
| `get_cross_chain_rep(signer2)` read after the failed execute | — (free RPC read) | Returns `0` — confirms the revert really did prevent the write, not just returned an error string while mutating state. |

Proposal created ~2026-07-07 15:5x UTC; the 48h timelock means `execute_proposal` can only succeed
from ~2026-07-09 15:5x UTC onward. Re-run `pnpm exec tsx src/scripts/demo_casper_cross_chain_rep_governance.ts --execute`
after that to complete the chain — it re-attempts `execute_proposal` (assumes `proposal_id=1`, the
only proposal on this fresh registry) and prints `get_cross_chain_rep(signer2)` afterward, which
should read back `80`.

## Full job lifecycle — DONE live (2026-07-07, re-run 2026-07-21)

> **Re-run 2026-07-21 against the attestation-hardened contract** (`hash-42f6945f…`, `skill_id=1`,
> `job_id=1` on the fresh registry) — same script, unmodified, one-take success:
>
> | Step | Tx hash |
> |---|---|
> | `register_skill` | `9bd9ac1157e77f5dba82f26354b1c66b7ead7ecdaa7ce45c233881dc81aee78a` |
> | `deposit_bond` | `99911584abfe2d6da2ec76a7a50cb1f5ba5b4a8baabb0025926f4f90ca70711d` |
> | `create_job` | `010ea730d530e4c4de2b51424b0e1ce2d1dad8d3793a2b006c036a8c32d7e8ae` |
> | `deliver_result` | `3393f97fb3b8333a5a50196fbf9a13a08c2d20c207da8fbb354231150bfa3e9f` |
> | `confirm_completion` | `b5cd2a178baca61fdeedfd0ca2403119e3d77362e5b6a4963510b47884e83a51` |
> | `withdraw` | `b216218ea7f78d40d7d6c720693edb59ff200a2294a6d7a3b6c8b8a71734f77f` |
>
> Final read confirms it again: `getJob(1).status == "Completed"`, `getSkill(1).reputationScore == 55`.

`src/scripts/demo_casper_full_job_lifecycle.ts` ran the whole loop — `register_skill` →
`deposit_bond` (Tier-2 Sybil bond, PD-007) → `create_job` → `deliver_result` → `confirm_completion`
→ `withdraw` — on the governance-hardened contract, provider = governance signer 1, requester =
governance signer 2 (deliberately different accounts: `settle_completion`'s self-deal guard zeroes
reputation signals when `requester == provider`). All six real transactions:

| Step | Tx hash | Result |
|---|---|---|
| `register_skill` | `ef969c711f385d5cf76419e2a8570cbbe7e620729392e879e58270ae7551b92b` | success — `skill_id=1` |
| `deposit_bond` (1 CSPR) | `53aa9dc2846250cd48bdffebb32549e98a0665ad71708337da25ba00373e46c4` | success |
| `create_job` (1 CSPR escrow) | `ed82d2cadc4e16a17070aadd9f999515750b24592c0784f779d5167270f6a08b` | success — `job_id=1` |
| `deliver_result` | `466a58760ffd644a0986a3fee1d21103f3d5de685bc0a9b1edd0a0a7e9e86aec` | success |
| `confirm_completion` | `4d9b1047e3ee03c4827e441c62d8b88dcf299c2ee22b006fc182114baf5073ac` | success |
| `withdraw` | `649949fa95ac7ccb2808df017cedbf26580a6a76d54afcdec6e78af517201639` | success |

Final on-chain read confirms it, not just the tx receipts: `getJob(1).status == "Completed"`,
`getSkill(1).reputationScore == 55` (bumped from the registration baseline), `totalInvocations == 1`.

## Courtroom (dispute + arbitrate) — DONE live (2026-07-07, re-run 2026-07-21)

> **Re-run 2026-07-21 against the attestation-hardened contract** (`hash-42f6945f…`, `skill_id=2`,
> `job_id=2` on the fresh registry) — same script, unmodified, **one-take success this time** (no
> underfunding, no duplicate task hash — the two mistakes below stayed fixed):
>
> | Step | Tx hash |
> |---|---|
> | fund throwaway provider (100 CSPR) | `3a37cdd03cba218d921589122dbcf916b9436a49a38b0f6fc8b07c5767f01f6e` |
> | `register_skill` | `10167faf6f1bcaccf6315c2fdd2c5fbe321536ddd0a32b16dd8cab6ab84fbd19` |
> | `create_job` | `277e7a312b408db253d21122cc269580b5bef12b430ea79390136599af21ff26` |
> | `deliver_result` | `d3843b7c33c13cdd4c993b145dbd1094b2bc915b0c7d1e462b33c60731e9f48c` |
> | `dispute_result` | `f40b58a43022e91de85d719ed38cefe9e48bcb15f22810b0056d156ca45c6a82` |
> | `respond_to_dispute` | `d21f7788b4a6a7325a16977cd25c304a0c015dcea133a4c3e7865414ba31c19d` |
> | `arbitrate(ProviderAtFault)` | `14f137467b597cb0c160aa93778d557ae2a0b2c657640cf08d190f55265930e9` |
>
> Final read confirms it again: `getJob(2).status == "Refunded"`, `getSkill(2).reputationScore`
> dropped `50 → 40`.

The single biggest gap the 2026-07-07 audit flagged: `evaluate_result`/`dispute_result`/
`claim_after_review`/`arbitrate` were implemented and unit-tested but **nobody had ever watched
arbitration run**. `src/scripts/demo_casper_courtroom.ts` closes it — three distinct accounts (the
contract's `init()` sets `arbiter = governance_signers[0]`, so governance signer 1 is genuinely the
neutral judge here, not a party to the dispute), a real contested delivery, and a real verdict:

- **arbiter** = governance signer 1
- **requester** = governance signer 2
- **provider** = a freshly generated throwaway testnet key, funded by a native CSPR transfer

**Honest account of what actually happened, including two real mistakes hit live** (kept here
rather than only showing the clean final run — this is testnet, and the mistakes are informative):

1. **First attempt** (`skill_id=2`, `job_id=2`): register → create_job → deliver → dispute all
   succeeded, but `respond_to_dispute` failed with `Insufficient funds` — the throwaway provider was
   funded only 15 CSPR, undershooting `respond_to_dispute`'s real cost (`PROXY_DEFAULT_PAYMENT_MOTES`
   = 20 CSPR ceiling, held at submission time, *on top of* the 1 CSPR bond itself). The follow-up
   `arbitrate` call correctly reverted with `errorMessage: "User error: 52"` = `Error::ProviderNotResponded`
   (confirmed by ordinal) — the contract correctly refused to rule on an unanswered dispute.
   **`job_id=2` is now a real, permanently-orphaned "Disputed" job on the live contract** (the
   throwaway key that could `respond_to_dispute` for it was never persisted) — it will resolve on
   its own via `resolve_default_concede` (callable by anyone) once the 3-day `RESPONSE_WINDOW`
   elapses. Left as-is rather than erased.
2. **Second attempt** (`skill_id=3`): funding was fixed to 40 CSPR, but `create_job` reverted with
   `errorMessage: "User error: 10"` = `Error::DuplicateTaskHash` — the task-hash literal was
   accidentally left identical to the first attempt's. `skill_id=3` is registered but has zero jobs
   against it.
3. **Third attempt** (`skill_id=4`, `job_id=3`) — the one that completed:

| Step | Tx hash | Result |
|---|---|---|
| fund provider (15 + 60 CSPR, two transfers) | `de143521f24ff69fa783849f0b1f5ae11aad633f0089002193fb42ccb893c6dd`, `60fdc5c7213767318b37c244bb8e91a09f47f6fa2ffc4521352fbf6a318949eb` | success |
| `register_skill` | `f6e6d5307e804691d26eb9fa66d28c9b35f3ea5205f84109b2b730061c0d9749` | success — `skill_id=4` |
| `create_job` (unique task hash this time) | `150b19e30097a07195b30c02bd89591c3ffd3527d4d97f287af911fc1bfae96e` | success — `job_id=3` |
| `deliver_result` | `c7010ea202c1db98fb15c4ce860819e7b847e1a582442fbdf97afed6625be277` | success |
| `dispute_result` (requester posts 1 CSPR bond) | `7852f1a144a6724fcf548296467423121bca340207f339bd2ba4a37523414608` | success |
| `respond_to_dispute` (provider matches the bond) | `c53ffcd35a76c90e8daf9b1cfda33fe17c4083f828193e66f7a5ab50bca4d91e` | success (after the top-up) |
| `arbitrate(ProviderAtFault)` | `0f8c64efb32e288bc13187542c5a2cb314569118eadd449a9e56fb3cd7197553` | success |

Final on-chain read: `getJob(3).status == "Refunded"` (escrow + both bonds returned to the
requester, exactly as `Verdict::ProviderAtFault` specifies) and `getSkill(4).reputationScore`
dropped `50 → 40` — the provider's reputation was really slashed for losing the dispute, live, not
in a unit test.

## Live run — Casper Testnet (owner-driven, requires funded keystore)

> ⚠️ This step is owner-driven only because it needs funded Casper Testnet credentials — a
> private key, which should only ever reach an AI session or a CI log deliberately, from someone
> authorized to spend that key's funds, never incidentally. **A real install deploy has been done
> and verified end-to-end**, three times: the original 2026-07-07 deploy (`hash-a4e8ab23…`, from
> `agent-alpha`'s keystore identity), the governance-hardening redeploy the same day
> (`hash-29b7daeb…`, from two dedicated governance-signer keys), and the attestation-hardening
> redeploy on 2026-07-21 (`hash-42f6945fe9ac5ab493beed468465228ecb830036e27bb2c8cac9e1736a2b5a1d`,
> **current live contract**, adding P2-A's `attest_rationale`/`get_rationale_hash`, same 2-of-2/48h
> governance shape) — confirmed live via the deploying account's on-chain `named_keys`
> (`AgentSkillRegistry` + `_access_token`) and, for both hardening redeploys, by directly decoding
> the contract's own governance storage, not just "the deploy tool exited 0." Several real gaps
> surfaced and got fixed along the way (see the "Governance-hardening redeploy" and
> "Attestation-hardening redeploy" sections above) — the recipe here is the corrected one.

### Step 0 — Toolchain

```bash
rustup toolchain install nightly --profile minimal   # odra-macros 2.x needs nightly
rustup component add rust-src --toolchain nightly    # needed for -Z build-std, see Step 1
rustup target add wasm32-unknown-unknown --toolchain nightly
# Casper client (used for put-deploy + query-balance) — or use casper-js-sdk's SessionBuilder
# directly (see src/lib/casper/live_client.ts), which is what was actually used for the verified
# deploy, since casper-client can't set the Authorization header cspr.cloud now requires.
cargo install casper-client
```

### Step 1 — Deploy the Odra `AgentSkillRegistry`

```bash
cd contracts-odra
./build-wasm.sh
# Writes wasm/karma_odra.wasm — see contracts-odra/README.md § "wasm32 build — how this
# actually works" for why this script, not `cargo odra build`, is the reliable path today.
# As of 2026-07 this ALSO needs target-cpu=mvp + -Z build-std=core,alloc (see the script's
# comments) — plain target-feature=-bulk-memory alone is not enough; recent rustc/LLVM still
# emits memory.copy/memory.fill for large copies even with that flag, and Casper's on-chain
# wasm engine rejects any bulk-memory instruction at preprocessing.

casper-client put-deploy \
  --node-address https://node.testnet.cspr.cloud \
  --chain-name casper-test \
  --secret-key $DEPLOYER_KEY \
  --payment-amount 800000000000 \
  --session-path ./wasm/karma_odra.wasm \
  --session-args-json '[
    {"name": "odra_cfg_package_hash_key_name", "type": "String", "value": "AgentSkillRegistry"},
    {"name": "odra_cfg_allow_key_override", "type": "Bool", "value": false},
    {"name": "odra_cfg_is_upgradable", "type": "Bool", "value": true},
    {"name": "odra_cfg_is_upgrade", "type": "Bool", "value": false},
    {"name": "odra_cfg_constructor", "type": "String", "value": "init"},
    {"name": "review_window_ms", "type": "U64", "value": "259200000"},
    {"name": "governance_signers", "type": {"List": "Key"}, "value": ["account-hash-<deployer-account-hash>"]},
    {"name": "governance_threshold", "type": "U32", "value": 1},
    {"name": "timelock_delay_ms", "type": "U64", "value": "0"}
  ]'

# Record the printed `contract_package_hash` as KARMA_ODRA_REGISTRY in .env
```

> `init()`'s real signature (`contracts-odra/src/agent_skill_registry.rs`) takes the last four
> args above — `governance_signers` seeds the P0-B multisig (at least one signer; use the
> deployer's own account-hash for a single-signer setup) and becomes the initial arbiter.
> `--session-args-json` (a file or inline JSON, per `casper-client put-deploy --help`) handles
> the `List<Key>` arg cleanly; the single-arg `--session-arg` form used in earlier drafts of this
> doc only covered `review_window_ms` and would have reverted with `InvalidGovernanceConfig`.
>
> **Three more gaps, found by actually running this (not just reading Odra's docs):**
> 1. The `odra_cfg_*` args (first five above) are mandatory for *every* Odra install deploy
>    (https://odra.dev/docs/backends/casper/#wasm-arguments) — omitting them fails with
>    `ExecutionError::MissingArg` (`"User error: 64658"` — Odra's own error space starts at
>    `65536 - 1000` for framework errors, `64536 + 122 = 64658`; this repo's own `Error` enum
>    only occupies codes 1-53, so a code in the 64500s is never this contract's own logic).
> 2. `--payment-amount 200000000000` (200 CSPR) is **not enough** — the real install consumed
>    ~579 CSPR once the args above were fixed, most likely because disabling bulk-memory (Step 1's
>    wasm note) forces slower byte-loop copies instead of the single fast instruction. Use
>    `800000000000` (800 CSPR): comfortably above the real cost, safely under this testnet's
>    `block_gas_limit` (812.5 CSPR per `chain_get_...`/`info_get_chainspec` — a single transaction
>    cannot request more than this network-wide cap; check it fresh, it's a chainspec value, not
>    a constant). Unused payment is **not refunded on this network** (`refund` was `0` even on a
>    request that used a tiny fraction of its limit), so don't set this arbitrarily high either.
> 3. `https://rpc.testnet.casper.network/rpc` (this doc's old RPC example) doesn't resolve in
>    DNS — use `https://node.testnet.cspr.cloud/rpc` instead, but as of 2026-07 it requires a
>    free API key (sign up at cspr.cloud), sent as a raw `Authorization: <key>` header (no
>    `Bearer` prefix). `casper-client` has no flag for custom headers, so the verified deploy
>    used `casper-js-sdk`'s `SessionBuilder` directly against `HttpHandler.setCustomHeaders`
>    (see `CasperLiveClientOpts.rpcHeaders` in `src/lib/casper/live_client.ts`, and
>    `CASPER_RPC_API_KEY` in `.env.example`) rather than the `casper-client` CLI shown above.

### Step 2 — Register the `rwa_price_oracle` skill

```bash
export CASPER_RPC_URL=https://node.testnet.cspr.cloud
export KARMA_ODRA_REGISTRY=hash-...                  # from Step 1
export KEYSTORE_PATH=./keystore.json
export KEYSTORE_PASSWORD=...
export KARMA_AGENT_ID=agent-alpha

pnpm exec tsx src/scripts/register_rwa_oracle_skill.ts --live
# Builds a real ContractCallBuilder transaction (register_skill, matching the Rust signature
# 1-to-1), signs it with the agent's Casper key, submits it via RpcClient.putTransaction, and
# prints the real transaction hash — no casper-client shell-out, no stub.
```

### Step 3 — Provider deposits a Tier-2 Sybil bond (PD-007)

```ts
// pnpm exec tsx (see CasperLiveClient.depositBond in src/lib/casper/live_client.ts)
const { txHash } = await client.depositBond(signer, 1_000_000_000n); // 1 CSPR bond
```

> **`deposit_bond()` takes no named args** — it reads `self.env().attached_value()`, Odra's
> "payable" convention (https://odra.dev/docs/basics/native-token). Casper has no native
> account→contract token transfer, so a plain `ContractCallBuilder` call with a `U512` arg named
> `amount` does nothing — `attached_value()` stays zero and the call reverts with
> `ExecutionError::NoBond` (verified: this is exactly what the earlier draft of this doc's
> `--payment-amount-from-purse` flag would have hit too, since `casper-client put-deploy` has no
> such flag — that recipe was never actually run). The real mechanism is Odra's **"Cargo Purse"**
> idiom: a one-time-use purse, funded by the caller, whose URef is passed as a `cargo_purse` arg;
> the wasm-side glue transfers 100% of that purse's balance into the contract and reads it back
> as `attached_value()`. Building that purse manually means either a two-transaction dance
> (create purse via the mint system contract, then call `deposit_bond` referencing it) or Odra's
> own answer to this: a generic, contract-agnostic **`proxy_caller` session** that does both in
> one deploy. `CasperLiveClient.depositBond`/`createJob` (payable) route through
> `submitPayable()`, which uses exactly that session — bundled at
> `src/lib/casper/resources/proxy_caller_with_return.wasm` (copied from `odra-casper-test-vm`'s
> `resources/`; Odra ships no separate npm/crates.io package for it, and it doesn't need building
> from source — it's generic, not project-specific like `karma_odra.wasm`). Verified end-to-end
> on testnet: `depositBond(1 CSPR)` succeeded, and `bondedOf(account)` read back `"1000000000"`.

### Step 4 — Run the live e2e (x402 fast-lane invocation)

```bash
pnpm exec tsx src/scripts/demo_casper_x402_live.ts --live
# Runs the real local HTTP 402 -> sign -> verify loop (no funded key needed for this part —
# see it work today by running it WITHOUT --live), then, with --live and Step 1-3's env vars
# set, submits a real create_job deploy via CasperLiveClient to settle the escrow on-chain.
```

> `create_job` is **also** payable (no `amount` arg exists on the real entry point — the escrow
> is `attached_value()`, checked to equal exactly the skill's `price_per_call`), so
> `CasperLiveClient.createJob` routes through the same proxy-caller session as `depositBond`
> (§Step 3). `task_hash`/`deliver_result`'s `result_hash` are Rust `Bytes` params — wire type
> `List(U8)`, not the fixed-size `ByteArray` earlier drafts of this client used (confirmed
> against the deployed contract's own entry-point signatures via `query_global_state`, not
> guessed). Verified end-to-end on testnet: `createJob` → `getJob` read back the exact
> `task_hash` + `escrowAmountMotes` + `status: "Open"`; `deliverResult` → `getJob` showed
> `status: "Delivered"` and the exact `result_hash`.

### Recorded live transactions

Real, already-confirmed calls against the **current** deployed `AgentSkillRegistry`
([`hash-42f6945fe9ac5ab493beed468465228ecb830036e27bb2c8cac9e1736a2b5a1d`](https://testnet.cspr.live/contract-package/42f6945fe9ac5ab493beed468465228ecb830036e27bb2c8cac9e1736a2b5a1d),
attestation-hardened, 2026-07-21) — not a template, these already happened and are independently
verifiable by anyone. 23 transactions total: deploy, signer funding, full lifecycle, courtroom,
governance, and the new P2-A attestation demo.

**Contract deploy** (attestation-hardened, 2026-07-21)

| Tx hash | Status |
|---|---|
| [`f93aa236…dca69`](https://testnet.cspr.live/transaction/f93aa2368b29e5d5ea8fecebd6f44e1c6e4670e825c9907ceb7d20a9586dca69) | success |
| Fund governance signer 2 (300 CSPR): [`2701ee9b…3da6`](https://testnet.cspr.live/transaction/2701ee9bb7f8553a61cf3359d0260ec7cb2d374bd89532c98ace27d2e4553da6) | success |

**Full job lifecycle** (`skill_id=1`, `job_id=1`)

| Entry point | Tx hash | Status |
|---|---|---|
| `register_skill` | [`9bd9ac11…e78a`](https://testnet.cspr.live/transaction/9bd9ac1157e77f5dba82f26354b1c66b7ead7ecdaa7ce45c233881dc81aee78a) | success |
| `deposit_bond` | [`99911584…711d`](https://testnet.cspr.live/transaction/99911584abfe2d6da2ec76a7a50cb1f5ba5b4a8baabb0025926f4f90ca70711d) | success |
| `create_job` | [`010ea730…e8ae`](https://testnet.cspr.live/transaction/010ea730d530e4c4de2b51424b0e1ce2d1dad8d3793a2b006c036a8c32d7e8ae) | success |
| `deliver_result` | [`3393f97f…3e9f`](https://testnet.cspr.live/transaction/3393f97fb3b8333a5a50196fbf9a13a08c2d20c207da8fbb354231150bfa3e9f) | success |
| `confirm_completion` | [`b5cd2a17…3a51`](https://testnet.cspr.live/transaction/b5cd2a178baca61fdeedfd0ca2403119e3d77362e5b6a4963510b47884e83a51) | success |
| `withdraw` | [`b216218e…f77f`](https://testnet.cspr.live/transaction/b216218ea7f78d40d7d6c720693edb59ff200a2294a6d7a3b6c8b8a71734f77f) | success |

**Courtroom dispute** (`skill_id=2`, `job_id=2`, verdict `ProviderAtFault`, one-take)

| Entry point | Tx hash | Status |
|---|---|---|
| fund throwaway provider | [`3a37cdd0…f6e`](https://testnet.cspr.live/transaction/3a37cdd03cba218d921589122dbcf916b9436a49a38b0f6fc8b07c5767f01f6e) | success |
| `register_skill` | [`10167faf…d19`](https://testnet.cspr.live/transaction/10167faf6f1bcaccf6315c2fdd2c5fbe321536ddd0a32b16dd8cab6ab84fbd19) | success |
| `create_job` | [`277e7a31…f26`](https://testnet.cspr.live/transaction/277e7a312b408db253d21122cc269580b5bef12b430ea79390136599af21ff26) | success |
| `deliver_result` | [`d3843b7c…48c`](https://testnet.cspr.live/transaction/d3843b7c33c13cdd4c993b145dbd1094b2bc915b0c7d1e462b33c60731e9f48c) | success |
| `dispute_result` | [`f40b58a4…a82`](https://testnet.cspr.live/transaction/f40b58a43022e91de85d719ed38cefe9e48bcb15f22810b0056d156ca45c6a82) | success |
| `respond_to_dispute` | [`d21f7788…19d`](https://testnet.cspr.live/transaction/d21f7788b4a6a7325a16977cd25c304a0c015dcea133a4c3e7865414ba31c19d) | success |
| `arbitrate(ProviderAtFault)` | [`14f13746…0e9`](https://testnet.cspr.live/transaction/14f137467b597cb0c160aa93778d557ae2a0b2c657640cf08d190f55265930e9) | success |

**Cross-chain-rep governance** (`proposal_id=1`)

| Entry point | Tx hash | Status |
|---|---|---|
| `propose_set_cross_chain_rep` | [`c419cac9…77d`](https://testnet.cspr.live/transaction/c419cac985c43568806f36d8b46f6ab13dd0567c763c2ab93695bb6ed346577d) | success |
| `approve_proposal` | [`6a648b4d…81e`](https://testnet.cspr.live/transaction/6a648b4d03c00dd1905e5342e962cb784e9858a881c919c4e1b73a7dd3d4a81e) | success |
| `execute_proposal` (too-early attempt) | [`7313fec0…6dc`](https://testnet.cspr.live/transaction/7313fec0a98dc30cfec7dd120c04c0ebf405bc57f288321504095f4bb57fa6dc) | **error, `User error: 42`** — `Error::TimelockNotElapsed`, expected/correct rejection |

**P2-A: on-chain rationale attestation** (`job_id=3` and `job_id=4`)

| Entry point | Tx hash | Status |
|---|---|---|
| `create_job` (job_id=3) | [`b873d9e8…3b8`](https://testnet.cspr.live/transaction/b873d9e83ef21f260064034e23e6df7ee544a8d8d325113a4aa7a51c1dfcb3b8) | success |
| `attest_rationale(3, …)` | [`a6c6c23b…c72`](https://testnet.cspr.live/transaction/a6c6c23ba84a4c9d5af7ba60ca1b2bef43276f23fadaf19d9083bdc24c940c72) | success |
| `attest_rationale(3, …)` again (double-attest) | [`96ab9e2d…9d`](https://testnet.cspr.live/transaction/96ab9e2d423b2370a8bd0f2c477d549b97b5018cdc65f9455d9e5cb2eab91d9d) | **error, `User error: 54`** — `Error::RationaleAlreadyAttested` |
| `create_job` (job_id=4) | [`f60d1c95…18`](https://testnet.cspr.live/transaction/f60d1c954882007e21bea94ef848328995fb10ae749004287afbdae725b5dc18) | success |
| `attest_rationale(4, …)` as non-requester | [`6c4205a1…61`](https://testnet.cspr.live/transaction/6c4205a12ef4b72f8fe6fed9abb9dbbafb25b01780f4f94ce37d1578b3a45b61) | **error, `User error: 13`** — `Error::NotRequester` |

Browse the full activity feed yourself: [testnet.cspr.live/contract-package/42f6945f…](https://testnet.cspr.live/contract-package/42f6945fe9ac5ab493beed468465228ecb830036e27bb2c8cac9e1736a2b5a1d).

### Recorded live transactions (2026-07-07, historical — superseded by the attestation-hardened contract above)

Real, already-confirmed calls against the deployed `AgentSkillRegistry`
([`hash-29b7daebfc4fb924b340f06ea5d367d590b1ebc27f644d404738a5c5ccbad5aa`](https://testnet.cspr.live/contract-package/29b7daebfc4fb924b340f06ea5d367d590b1ebc27f644d404738a5c5ccbad5aa)),
pulled from that contract's own `testnet.cspr.live` activity feed — not a template, these already
happened and are independently verifiable by anyone. Grouped by the three flows described above:

**Contract deploy** (governance-hardened redeploy, Jul 7, 2026, 10:23:06 PM GMT+7)

| Tx hash | Status |
|---|---|
| [`c59518d1…b203b`](https://testnet.cspr.live/transaction/c59518d18bc5096d820a3450aa64a93c116caf7cfe3fc403a79607d7cfcb203b) | success |

**Full job lifecycle** (register → bond → escrow → deliver → confirm → withdraw, blocks 8,427,491–496)

| Entry point | Tx hash | Status |
|---|---|---|
| `register_skill` | [`ef969c71…1b92b`](https://testnet.cspr.live/transaction/ef969c711f385d5cf76419e2a8570cbbe7e620729392e879e58270ae7551b92b) | success |
| `deposit_bond` | [`53aa9dc2…e46c4`](https://testnet.cspr.live/transaction/53aa9dc2846250cd48bdffebb32549e98a0665ad71708337da25ba00373e46c4) | success |
| `create_job` | [`ed82d2ca…6a08b`](https://testnet.cspr.live/transaction/ed82d2cadc4e16a17070aadd9f999515750b24592c0784f779d5167270f6a08b) | success |
| `deliver_result` | [`466a5876…86aec`](https://testnet.cspr.live/transaction/466a58760ffd644a0986a3fee1d21103f3d5de685bc0a9b1edd0a0a7e9e86aec) | success |
| `confirm_completion` | [`4d9b1047…073ac`](https://testnet.cspr.live/transaction/4d9b1047e3ee03c4827e441c62d8b88dcf299c2ee22b006fc182114baf5073ac) | success |
| `withdraw` | [`649949fa…01639`](https://testnet.cspr.live/transaction/649949fa95ac7ccb2808df017cedbf26580a6a76d54afcdec6e78af517201639) | success |

**Courtroom dispute** (a requester disputes a delivered result, the provider matches the bond to
contest, a neutral on-chain arbiter rules `ProviderAtFault`, blocks 8,427,961–967)

| Entry point | Tx hash | Status |
|---|---|---|
| `deliver_result` | [`970977e1…85f72`](https://testnet.cspr.live/transaction/970977e1b1ed22f23f91fd5f35e65786582432a5bf09c1d91fea3d6860d85f72) | success |
| `dispute_result` | [`d71fb230…fa0cf`](https://testnet.cspr.live/transaction/d71fb2308fc2c36503f9935d8a4f8af3df62e6e11d6b68db126b78c1b0cfa0cf) | success |
| `respond_to_dispute` | [`c423f5cf…dedf5`](https://testnet.cspr.live/transaction/c423f5cfb8f34462ba1fc3bf7472f68b0ae1986b84ccd8e020acb8c606bdedf5) | success |
| `arbitrate` (verdict: `ProviderAtFault`) | [`970c7827…5bec4`](https://testnet.cspr.live/transaction/970c782749b268b91d7650fcb899cc98375bd1696257de3f74e64cb78c05bec4) | success |

**Cross-chain-rep governance** (propose → approve → an early `execute_proposal` correctly reverts
`TimelockNotElapsed` against the real 48h clock, blocks 8,427,987–989)

| Entry point | Tx hash | Status |
|---|---|---|
| `propose_set_cross_chain_rep` | [`226bd001…a33c4`](https://testnet.cspr.live/transaction/226bd0017f4fe35e2c26c1443aca2b2bc9e4ffc56bdf253e59ca1bdac10a33c4) | success |
| `approve_proposal` | [`a5ae630a…27f14`](https://testnet.cspr.live/transaction/a5ae630aeeef37e07ef14392b2e4f78088f78507b95f0cd1b641a87c79627f14) | success |
| `execute_proposal` (too-early attempt) | [`9784de3d…4b1ec`](https://testnet.cspr.live/transaction/9784de3dee55a36a70141a45627f62d32896c7609b6dd2749fee70b12f84b1ec) | **error, `User error: 42`** — `Error::TimelockNotElapsed` (`contracts-odra/src/agent_skill_registry.rs:95`), the expected/correct rejection, not a bug |

Browse the full activity feed yourself: [testnet.cspr.live/contract-package/29b7daeb…](https://testnet.cspr.live/contract-package/29b7daebfc4fb924b340f06ea5d367d590b1ebc27f644d404738a5c5ccbad5aa).

### Expected live transactions (if you run it yourself)

Reproducing any of the above from scratch (a fresh `register_skill`/`create_job`/etc., not a
replay) will look like this:

| Step | Tool | What you'll see |
|---|---|---|
| Odra contract deploy | `casper-client put-deploy --session-path …` | contract_package_hash `hash-…` |
| register_skill | `register_rwa_oracle_skill.ts --live` | tx hash + assigned `skill_id` |
| deposit_bond | `casper-client put-deploy --entry-point deposit_bond` | tx hash + `BondUpdated` event |
| create_job (x402) | x402 facilitator settle | settle response with deploy hash |
| deliver_result | `casper-client put-deploy --entry-point deliver_result` | tx hash + `ResultDelivered` event |
| confirm_completion | `casper-client put-deploy --entry-point confirm_completion` | tx hash + `JobCompleted` event |
| withdraw | `casper-client put-deploy --entry-point withdraw` | tx hash + transfer to provider |

The offline e2e demo (`pnpm exec tsx src/scripts/demo_casper_e2e.ts`) already
prints each of these in narrated form — the live mode just lets the chain
confirm them and produce the on-chain tx hashes.

## What's verified by the on-chain side

A judge running the live mode should observe, on **Casper Testnet** alone
(no Pharos / no KARMA server):

1. The Odra registry accepts `register_skill` and assigns a `skill_id`.
2. The Sybil bond is locked and the seed-eligible amount surfaces in
   `seed_eligible_bond(agent)`.
3. The Casper x402 facilitator settles CSPR in the same HTTP round-trip as
   the `create_job` invocation.
4. The provider's signed RWA feed verifies under their public key off-chain;
   the `result_hash` recorded on Odra binds the feed to the job.
5. The escrow ALWAYS settles to the provider's pull-payment ledger after
   `confirm_completion`; reputation bumps only happen at arm's-length
   (self-deal nullification — mirrored from Solidity's audit Abductive-2).

These together are the "trust mechanism" — math + payment + escrow, no
trusted intermediary. That's the closing argument of synthesis §5 + plan §1B.

## Submission notes

- **Composability claim is structural.** Tested independently in
  `src/scripts/demo_casper_composability.ts` — the orchestrator code holds
  KARMA-MCP and Casper-MCP tool sets side by side and reasons across them
  with zero chain-specific glue. The wire format IS the integration.
- **Odra port mirrors audited Solidity invariants.** CEI before
  `transfer_tokens`, pull-payment ledger, self-deal nullification on both
  completion paths. 155 tests pin the boundary cases — happy path, ghost
  requester, dispute window, double-complete, identity policy, duplicate
  task-hash exactly-once, all 7 bond cases, evaluator and governance/timelock
  mechanics, rationale attestation, the N-of-M panel-arbitration lifecycle
  (vote tallying, fee distribution, the default-liveness backstop), the
  `X402SettlementToken` CEP-18/CEP-3009 composition, and 4 property-based
  invariant tests (escrow conservation and reputation bounds, each proven
  for both the single-arbiter and panel-arbiter paths) below.
- **x402 now speaks the official wire format, not a bespoke scheme** — see
  [`docs/rfc/2026-07-21-x402-casper-eip712-interop.md`](docs/rfc/2026-07-21-x402-casper-eip712-interop.md)
  for the full derivation. Casper's own site names
  [`make-software/casper-x402`](https://github.com/make-software/casper-x402) "the official
  reference implementation for the x402 protocol on Casper," backed by
  [`casper-ecosystem/casper-eip-712`](https://github.com/casper-ecosystem/casper-eip-712) for the
  typed-data layer. `x402_casper.ts` (T11, rewritten 2026-07-21) now signs a real EIP-712
  `TransferWithAuthorization` digest — the same hardcoded typehash `CEP3009` computes on-chain,
  cross-checked byte-for-byte in `src/__tests__/x402_casper.test.ts`, not assumed equal from
  matching source strings — against a real CEP-18 asset: `X402SettlementToken`
  (`contracts-odra/src/x402_settlement_token.rs`, composed from `odra-modules`' official
  `Cep18` + `CEP3009` submodules, not hand-rolled), **live on Casper Testnet at
  `hash-b3387d595fa53045f42b350907a68f3a0b95cc983c056fd9d71d26f776c1d310`**.
  `demo_casper_x402_settlement_live.ts` proves the full path for real: deposits CSPR into the
  token, signs a `transfer_with_authorization` authorization, submits it via
  `settleTransferWithAuthorization`, and confirms `errorMessage: null` + a real `Transfer` event
  on-chain — this caught two real bugs a unit test alone could not have (a wire-arg name
  mismatch, and a wrong typehash from a generic npm preset instead of `CEP3009`'s own hardcoded
  constant). Proving interop against the *external* hosted `make-software/casper-x402`
  facilitator (as opposed to this settlement path, which KARMA deploys and controls itself) is
  the one remaining open, non-blocking step — see the RFC's §7-§9.
- **Nightly Rust required.** `odra-macros 2.x` uses `#![feature(box_patterns)]`.
  Documented in `contracts-odra/README.md` and the plan's done-state notes.
