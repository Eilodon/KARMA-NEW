# KARMA standards — reference implementations

> **Status:** v1.0. Maintainer: KARMA. Update whenever a new chain adapter lands.

This page lists the canonical implementations of the KARMA standards across the supported
chains. Each row links to the source file and (where applicable) the matching contract /
SDK package version.

## Settlement (`IPaymentPlugin v1`)

| Chain | Networks | Implementation | Spec conformance | SDK pinned |
|---|---|---|---|---|
| **Stellar** | `stellar:testnet`, `stellar:pubnet` | [`src/plugins/x402_stellar.ts`](../../src/plugins/x402_stellar.ts) | v1.0 ✓ | `@stellar/stellar-sdk@16.0.1` (override), `@x402/stellar@2.16.0` |
| **Casper** | `casper:testnet`, `casper:mainnet` | [`src/plugins/x402_casper.ts`](../../src/plugins/x402_casper.ts) | v1.0 ✓ | `casper-js-sdk@5.0.12` |
| **Pharos** (escrow) | `pharos:atlantic` | `create_job` escrow branch + [`contracts/AgentSkillRegistry.sol`](../../contracts/AgentSkillRegistry.sol) | wrapper pending (v2) | `viem@2.52.2` |

Boot wiring: [`src/lib/payment/boot.ts`](../../src/lib/payment/boot.ts) — env-gated
registration into `paymentPlugins`. Set `KARMA_X402_STELLAR_FACILITATOR_URL` and/or
`KARMA_X402_CASPER_FACILITATOR_URL` to enable.

## Identity policy (`IdentityPolicy` enum)

| Value | Issuer | Reference implementation |
|---|---|---|
| `0` (NONE) | — | enforced by absence-check in `create_job` |
| `1` (T3N_VERIFIED) | Terminal3 (`did:t3n:…`) | [`src/plugins/t3.tool.ts`](../../src/plugins/t3.tool.ts) + [`src/lib/identity_session.ts`](../../src/lib/identity_session.ts) |
| `2` (T3N_VERIFIED_FRESH) | Terminal3 (`did:t3n:…`) | same as above; freshness check at `create_job` |

On-chain storage:
- Solidity: `Skill.identityPolicy` (uint8) on
  [`contracts/AgentSkillRegistry.sol`](../../contracts/AgentSkillRegistry.sol)
- Odra (Casper): `Skill.identity_policy` on
  [`contracts-odra/src/agent_skill_registry.rs`](../../contracts-odra/src/agent_skill_registry.rs)

## Reputation (off-chain, decay+saturation EigenTrust-lite)

| Component | Implementation | Notes |
|---|---|---|
| Tier-0 self-deal guard | [`AgentSkillRegistry.sol:_settleCompletion`](../../contracts/AgentSkillRegistry.sol) | requester == provider → no rep change |
| Tier-1 flow reputation | [`src/lib/flow_reputation.ts`](../../src/lib/flow_reputation.ts) | EigenTrust-lite, decay 30d, value/pair-saturation |
| Tier-1 P3-lite dispute feedback | [`src/lib/flow_reputation.ts`](../../src/lib/flow_reputation.ts) (`disputes`) | Soft penalty, capped at `disputePenaltyCap` (0.9) |
| Tier-1 anti-wash (T0.2) | [`src/lib/flow_reputation.ts`](../../src/lib/flow_reputation.ts) (`concentrationCap`) | Single-payer share > 0.5 ⇒ penalty |
| Tier-2 bond seed | [`AgentSkillRegistry.sol:depositBond`](../../contracts/AgentSkillRegistry.sol) + `seedWeightFromBond` | On-chain capital → off-chain trust seed |

## Cross-chain (planned — T1.3 in the roadmap)

| Bridge direction | Status |
|---|---|
| Pharos rep → Stellar (ZK proof) | Planned (T1.3) — `ReputationAggregationProof` circuit (T1.1) + Soroban consumer |
| Pharos rep → Casper (ZK proof) | Planned (T1.3) — Odra consumer |

## Test suites (cross-chain)

| Suite | Target | Files |
|---|---|---|
| Vitest | TypeScript layer | [`src/__tests__/`](../../src/__tests__/) — 560 cases |
| Foundry | Pharos Solidity | [`test/`](../../test/) |
| Cargo (nightly) | Odra Casper | [`contracts-odra/src/agent_skill_registry/tests.rs`](../../contracts-odra/src/agent_skill_registry/tests.rs) — 32 cases |
| Cargo | Soroban verifier | [`contracts-soroban/agent_credential_verifier/src/test.rs`](../../contracts-soroban/agent_credential_verifier/src/test.rs) — 6 cases |
| snarkjs | Circom circuits | [`circuits/test/`](../../circuits/test/) |

## How to add a new chain

This is the canonical recipe for landing a new chain adapter. Estimated effort 1–2 sessions
once the chain's SDK is in `node_modules`:

1. **Pick CAIP-2 identifiers** (`<namespace>:<reference>`). Reserve them in
   [`IdentityPolicy-registry.md`](./IdentityPolicy-registry.md) if your chain has a new
   identity convention; otherwise re-use existing reserved values.
2. **Keystore adapter** under `src/lib/<chain>/keypair.ts`:
   - If chain uses secp256k1 → direct reuse of `KeystoreManager` raw key bytes.
   - If chain uses ed25519 → HKDF-derive from the secp256k1 entropy (see
     [`src/lib/stellar/keypair.ts`](../../src/lib/stellar/keypair.ts) as the pattern).
   - Other curves: derive per RFC 5869 with a chain-specific salt/info.
3. **`IPaymentPlugin` implementation** under `src/plugins/x402_<chain>.ts` if x402 is the
   rail; under `src/plugins/escrow_<chain>.ts` if the chain has its own escrow contract.
   - `quote` synchronous, no network.
   - `pay` builds + signs payment payload; receipt MUST round-trip through `verify`.
   - `verify` pure / structural.
4. **Env-gate** in `src/lib/payment/boot.ts` (add a new env var + `tryRegister` call).
5. **Tests**:
   - 4-tier `IPaymentPlugin` conformance — metadata, quote (4+ cases), pay (5+),
     verify (5+). Mirror [`src/__tests__/x402_stellar.test.ts`](../../src/__tests__/x402_stellar.test.ts).
   - Keystore round-trip — derived key + sign/verify via `node:crypto`.
6. **Update this file** with the new row + sdk pin.

## Versioning + deprecation

Reference implementations track the **spec major version**. v1.x of the spec → v1.x of
implementations. A breaking spec bump (v2) means existing implementations get a v1 alias
(deprecated for one release cycle) + a v2 implementation lands in parallel.

Deprecated implementations are NOT deleted — they ship with a `@deprecated` JSDoc tag and
a migration link. The `paymentPlugins` registry can hold both during the transition.

## Open positions

- Pharos escrow as a `IPaymentPlugin` wrapper (v2 cleanup).
- Multi-hop / composite skill revenue split (T2.1 in the roadmap).
- Subscription rail (T2.2 in the roadmap).
- Streaming payments (T2.4 in the roadmap).
- Cross-chain reputation oracle (T1.3 in the roadmap).
