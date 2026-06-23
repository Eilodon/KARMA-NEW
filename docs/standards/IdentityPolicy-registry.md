# IdentityPolicy enum — public registry

> **Status:** DRAFT / v1.0 reference. Maintainer: KARMA.
> **Scope:** Reserved values for the on-chain `identityPolicy` field on `Skill`.
> Other identity providers can apply for a value (open a PR against this file).

## Why this registry exists

The `identityPolicy` field on a skill is the **credible commitment** that the skill
requires a verified identity to invoke. It lives on-chain so any client / indexer /
competing front-end can read it and compose on it (D1 from the
[d1-d5 tradeoff study](../superskills/plans/2026-06-23-d1-d5-tradeoff-study.md)).

The enum is a single `uint8` for cheapness + extensibility. To prevent identity-provider
fragmentation, the canonical mapping lives here. **A skill that uses an unreserved value
fails closed on the KARMA server** — `create_job` rejects with `identity_policy_unknown`
rather than risk a silent bypass.

## Reserved values

| Value | Name | Issuer | Freshness | Server-side check |
|---|---|---|---|---|
| `0` | `NONE` | — | n/a | No identity check; open access (default for new skills) |
| `1` | `T3N_VERIFIED` | Terminal3 (`did:t3n:…`) | TTL-cached (~10 min) | `identitySessions.get(agentId)` exists + address-bound + not expired |
| `2` | `T3N_VERIFIED_FRESH` | Terminal3 (`did:t3n:…`) | Fresh (≤2 min since `verifiedAt`) | as above + `Date.now() - verifiedAt ≤ SESSION_FRESH_MAX_AGE_MS` |
| `3` | *reserved* | TBD | — | — |
| `4` | *reserved* | TBD | — | — |
| `5..127` | *reserved for future issuers* | — | — | Future allocations |
| `128..255` | *vendor-private range* | local | — | NEVER deployed on shared registries; for forks only |

## Allocation process

To register a new value:

1. Open a PR against this file with:
   - The proposed integer (smallest unused in `5..127` unless you have a reason).
   - The issuer name + credential URI scheme (e.g. `did:web:`, `did:key:`, etc).
   - Freshness model (TTL / fresh / per-call re-verify).
   - The server-side check semantics (what does the KARMA-style enforcer assert?).
   - Test vectors (a session shape that should pass + 2 that should fail-closed).
2. Reference implementations should land alongside the spec PR (add to the table below).
3. Reviewers verify the issuer is real, the check is server-enforceable, and the freshness
   model is compatible with the existing tiers (i.e. policy ≥ 2 ⇒ fresh-required).

## Server-side enforcement contract

The KARMA reference implementation enforces `identityPolicy` in `create_job`:

```ts
const policy = skill.identityPolicy ?? 0;
if (policy === 0) {
  // proceed
} else if (policy === 1 || policy === 2) {
  const session = identitySessions.get(agentId);
  if (session == null || session.address.toLowerCase() !== requester.toLowerCase()) {
    return reject("identity_required");
  }
  if (policy === 2 && Date.now() - session.verifiedAt > SESSION_FRESH_MAX_AGE_MS) {
    return reject("identity_stale");
  }
} else {
  // FAIL CLOSED on any unreserved value
  return reject("identity_policy_unknown");
}
```

The **fail-closed default** is non-negotiable. A future issuer that lands on this registry
becomes server-enforceable only after every relying server upgrades. Until then, that
skill's calls are rejected as `identity_policy_unknown` — which is correct behaviour:
the server cannot enforce a policy it doesn't understand.

## Relation to adjacent standards

- **ERC-8004** (agent identity registry) — orthogonal. ERC-8004 points to *which* identity
  registry an agent uses; this enum reserves *what level* of identity is required to invoke
  a skill. Both can co-exist: a skill can require `identityPolicy = 1` *and* the agent's
  ERC-8004 record can resolve their DID for the server to look up.
- **W3C Verifiable Credentials** — a candidate for value `3` once a credential-type registry
  is agreed. The freshness model would mirror VC's `validUntil` claim.
- **DID Core / did:web** — candidates for additional values. Each issuer scheme registers
  its own server-side resolution path.

## Versioning

The enum's allocated range never shrinks. New values are added in `5..127`; the
`128..255` range is reserved for local forks (never widely deployed). A v2 of this spec
would expand to `uint16` if `127` is filled, but no v2 is planned for now.

## Cross-references

- Reserved values 0, 1, 2 are enforced today in:
  - Solidity: [`contracts/AgentSkillRegistry.sol`](../../contracts/AgentSkillRegistry.sol)
    `setIdentityPolicy` + `Skill.identityPolicy` field
  - Odra: [`contracts-odra/src/agent_skill_registry.rs`](../../contracts-odra/src/agent_skill_registry.rs)
    `IDENTITY_POLICY_*` constants
  - TypeScript: [`src/plugins/karma.tool.ts`](../../src/plugins/karma.tool.ts)
    `create_job` identity-gate block
- ADR: [`docs/superskills/adrs/2026-06-22-t3adk-terminal3-identity-gate.md`](../superskills/adrs/2026-06-22-t3adk-terminal3-identity-gate.md)
- Design rationale (D1–D3): [`docs/superskills/plans/2026-06-23-d1-d5-tradeoff-study.md`](../superskills/plans/2026-06-23-d1-d5-tradeoff-study.md)
