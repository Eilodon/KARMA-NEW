# DP-7 — ZK framework: Circom + snarkjs (NOT Noir + Barretenberg)

**Status:** Decided · 2026-06-24 · **Amended 2026-07-01** (see below) · **Amended 2026-07-21** (Casper scope note, see "When to revisit" item 4)
**Scope:** All ZK circuits in this repo (AgentCredentialProof T4, ReputationAggregationProof T1.1, JobCommitmentProof T1.2, cross-chain rep oracle T1.3). This decision is about circuit/proving-system choice, not verifier placement — see item 4 below for why Casper isn't a verifier target today.
**Reverses:** Roadmap §B.T1 framework recommendation.

## Amendment — 2026-07-01: the "BN254 native" claim below was wrong

Point 2 below claimed CAP-0074 didn't cover the Groth16 pairing check yet, and the
"When to revisit" list treated `bn254_pairing` as not-yet-shipped. Both are false —
verified directly against [CAP-0074](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md)
(shipped in Protocol 25 "X-Ray", *ahead of* this decision's 2026-06-24 date) and the
`soroban-sdk` 26 source (`env.crypto().bn254()` exposes `g1_add`, `g1_mul`,
`pairing_check` — backed by the host's `bn254_multi_pairing_check`). Both
`agent_credential_verifier` and `reputation_aggregation_verifier` have since been
migrated off the software Arkworks path described below onto these native host
functions (no `ark-*` dependency remains in either contract). The **Circom + snarkjs
+ Groth16-over-BN254 choice itself still stands** — only the *on-chain verifier's*
implementation changed, from software pairing to native host calls. Left the
original text below unedited (struck through where superseded) so the reasoning
trail stays honest about what was known when.

## Decision

Continue using **Circom 2 + snarkjs (Groth16 over BN254)**. Do not migrate to Noir +
Barretenberg for the hackathon window or for the immediate post-hackathon roadmap.

## Why the roadmap recommendation does not apply

The roadmap's argument for Noir reduced to three claims. Each fails on inspection of
what is already in this repo:

1. **"Noir is TypeScript-native, Circom requires external service."**
   False. `snarkjs.groth16.fullProve(input, wasm, zkey)` runs in Node and in the
   browser via WASM, with zero external service. The existing
   `circuits/test/agent_credential.test.mjs` exercises exactly this path.
   `@noir-lang/noir_js` does the same thing for ACIR — same shape, not a capability
   gap.

2. **"BN254 native on Soroban / EVM."**
   ~~The verifier we already shipped hardcodes Arkworks `Bn254 + Groth16`.~~
   **Superseded by the 2026-07-01 amendment above** — the verifier now runs the
   pairing check on native `env.crypto().bn254()` host functions (CAP-0074), not
   Arkworks. The point stands regardless: `snarkjs zkey export` output packs
   directly into the native BN254 byte layout (big-endian coordinates), so this
   was never a real blocker either way. Barretenberg's default output is
   UltraHonk, **not** Groth16-compatible with this verifier — switching backends
   means rewriting the verifier contract
   from scratch.

3. **"Cleaner syntax, easier to audit."**
   True in isolation, irrelevant here. The existing AgentCredentialProof circuit
   is 122 lines and already audited-by-eye. RepAggProof reuses Poseidon + Merkle
   from `circomlib` — same building blocks the auditor already validated.

## Costs of switching (rejected)

- **Verifier rewrite:** Arkworks Groth16 → Barretenberg UltraHonk verifier on
  Soroban. New Cargo deps, new vkey/proof format, new tests, new gas profile.
  Estimated 3-5 sessions. Pre-hackathon = unaffordable.
- **Toolchain re-bootstrap:** `circuits/scripts/install-toolchain.sh` works.
  Re-doing it for `nargo` + `bb` adds a second toolchain to CI without removing
  the first (T4 already shipped).
- **Audit surface doubled:** auditor must learn ACIR + Barretenberg in addition
  to Circom + snarkjs. Reduces, not increases, review velocity.
- **Trusted-setup story split:** Groth16 needs per-circuit ptau-derived zkey.
  We have that ceremony in place. Switching to a Plonk-family system (UltraHonk)
  changes the ceremony story mid-stream — fine if you're starting fresh, costly
  if you've already shipped one circuit under the old story.

## Constraints this commits us to

- **Per-circuit trusted setup.** Each new circuit (RepAgg, JobCommitment) gets
  its own zkey. Documented testnet (single-contributor) vs mainnet (multi-party)
  distinction stays as-is from T4.
- **Groth16-only at the verifier.** Plonk-family proofs are not interchangeable.
  If we add a non-Groth16 circuit later, it gets its own verifier contract — but
  we have no such circuit in the roadmap before T5.
- **Circom 2.1+ + circomlib Poseidon.** Locks us to circomlibjs' Poseidon
  parameters at the prover side. Already true for T4; not a new constraint.

## When to revisit

Revisit Noir/Barretenberg if any of these become true:

1. ~~Stellar's `rs-soroban-env` ships native `bn254_pairing` host functions~~ —
   **already true** (CAP-0074 `bn254_multi_pairing_check`, Protocol 25; both
   verifiers migrated to it, see 2026-07-01 amendment above). The live
   condition going forward: revisit Noir/Barretenberg only if the cost model
   comes to favor UltraHonk over native-BN254 Groth16 in-contract — no
   evidence of that yet, and native Groth16 is now the cheaper of the two
   (no in-contract EC arithmetic at all).
2. We need recursion (proof-of-proof) for the cross-chain rep oracle (T1.3).
   Groth16-on-BN254 supports recursion but the tooling story in snarkjs is
   weaker than Aztec's. T1.3 first cut can avoid recursion (off-chain prover
   bundles a single big proof per epoch); revisit only if that becomes a
   bottleneck.
3. Audit feedback explicitly cites Circom's verbose syntax as a finding. Has
   not happened.
4. **(Added 2026-07-21) Casper ships a native pairing-friendly-curve host function equivalent to
   Soroban's CAP-0074.** Checked directly: `contracts-odra/Cargo.toml` has zero crypto crates
   beyond what `odra`/`odra-modules` already pull in for EIP-712 (no `ark-*`, no `bn254`, no
   pairing library of any kind), and nothing in Casper's own external-FFI surface (the
   `casper_*` host functions enumerated in the whitepaper) exposes pairing or elliptic-curve
   precompiles. This is a **deliberate scope gap, not an oversight**: cross-chain reputation on
   Casper today is a *governed attestation* (`propose_set_cross_chain_rep`, gated by the same
   multisig+timelock as every other governance parameter — see
   `agent_skill_registry.rs:1166`'s own comment: *"Odra cannot verify Soroban Groth16 proofs
   directly"*), not a verified ZK proof. A Casper-side Groth16 verifier is possible without a
   native pairing host function — a pure-Rust/WASM implementation (e.g. `ark-groth16` compiled to
   `wasm32-unknown-unknown`) — but this repo has never prototyped one, and the gas cost of
   software pairing arithmetic inside a metered Casper contract is unmeasured and could plausibly
   exceed the network's per-transaction gas ceiling (observed as tight even for ordinary contract
   deploys — see `DEMO_CASPER.md`'s Step 1 gas notes). Revisit this item if either (a) Casper
   ships a native pairing host function, or (b) a time-boxed spike measures the real gas cost of a
   software Groth16 verifier on Casper and finds it practical.

## Decision check-list (what we'll actually do for T1.1)

- [x] Keep `circuits/package.json` deps (`circomlib`, `circomlibjs`, `snarkjs`).
- [x] Add `circuits/src/reputation_aggregation.circom` following the
  AgentCredentialProof pattern (Poseidon for hashes, MerkleProof template
  reuse).
- [x] Reuse `circuits/scripts/install-toolchain.sh` ptau (2^14 if the constraint
  count grows beyond 2^12 — measure first).
- [x] Verifier: extend `agent_credential_verifier` contract with a
  `register_rep_agg_skill` + `submit_rep_proof` pair, OR ship a sibling
  `reputation_aggregation_verifier` contract — pick whichever keeps the
  existing T5 verifier unchanged. (Sibling contract wins on isolation; pick
  that.)
