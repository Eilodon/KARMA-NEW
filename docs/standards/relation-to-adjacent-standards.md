# Relation to adjacent standards

> **Status:** v1.0. Maintainer: KARMA. Companion to [`IPaymentPlugin-v1.md`](./IPaymentPlugin-v1.md)
> and [`IdentityPolicy-registry.md`](./IdentityPolicy-registry.md), whose own "Relation to
> adjacent standards" sections this page consolidates and extends with worked examples.

KARMA is not proposing a replacement for MCP, x402, or ERC-8004. It sits **across** them: MCP is
the wire format, x402 is a payment scheme, ERC-8004 is an identity pointer — none of the three,
alone or together, tells a server whether to trust a caller enough to do the job, or what happens
when the caller says the job was done wrong. KARMA is the trust layer that turns "an agent called
a tool and money moved" into "an agent with a known identity and reputation called a tool, paid
for it, and has recourse if the result is disputed."

## The three-standard triangle

| Standard | Layer it solves | What it defines | What it explicitly does **not** solve |
|---|---|---|---|
| **MCP** (Model Context Protocol) | Transport | How a client discovers and invokes a tool: schema, request/response framing, session lifecycle | Commerce (no price, no payment, no receipt) and trust (no identity check, no reputation, no dispute path) |
| **x402** (Coinbase HTTP 402 payment scheme) | Payment | How money moves for a single HTTP call: a `402 Payment Required` challenge, a signed payment payload, a facilitator that verifies and settles it | Trust — x402 verifies that a payment is valid, not that the *payer* or *payee* is trustworthy. No identity, no reputation, no dispute if the paid-for work is bad |
| **ERC-8004** (Ethereum "Trustless Agents" identity + reputation + validation registries) | Identity pointer | A registry an agent can point to: "here is my on-chain identity, here is where my reputation/validation attestations live" | Settlement — ERC-8004 does not move money, does not escrow funds, does not define a payment rail. It also does not define *how* reputation is computed or *how* a dispute is resolved, only where a resolution could be recorded |
| **KARMA** | Identity **+** reputation **+** dispute resolution, wired directly to settlement, spoken over MCP | An `IdentityPolicy` gate at the tool-call boundary, an on-chain-seeded off-chain reputation score, an escrow-and-dispute lifecycle with neutral arbitration, and an `IPaymentPlugin` interface that makes all of the above settle in the same call | — (this is the composition layer; it depends on the three above rather than competing with them) |

None of MCP, x402, or ERC-8004 is wrong or incomplete on its own terms — they're each scoped
correctly to one layer. The gap is that **no agent-to-agent transaction is safe to automate on
just one of them**: a caller can be MCP-reachable and still be a stranger with no history; a
payment can clear via x402 and the delivered work can still be garbage with no recourse; an
ERC-8004 identity pointer can resolve and still tell you nothing about whether *this* skill call
should be trusted at *this* reputation threshold. KARMA is the layer that makes those three
questions — "who is this," "can I trust them for this specific call," "what happens if they're
wrong" — answerable in the same request that invokes the tool.

## Where each standard is used, concretely, in this repo

This isn't a positioning slide — every claim below is either running code or a wired MCP tool in
this repo.

### MCP — the wire format KARMA is built on, not around

KARMA's entire skill surface (`casper_discover_skills`, `casper_create_job`,
`casper_dispute_result`, `casper_arbitrate`, …) is exposed as MCP tools via
[`src/plugins/casper.tool.ts`](../../src/plugins/casper.tool.ts) and
[`src/plugins/karma.tool.ts`](../../src/plugins/karma.tool.ts), served on
`@modelcontextprotocol/server` (see `package.json`). KARMA doesn't wrap MCP or extend its
transport — it uses MCP exactly as specified, and adds the trust/settlement layer *underneath*
individual tool calls. An MCP client talking to KARMA gets identity gating, reputation-boosted
discovery, and dispute resolution for free, without any change to the MCP protocol itself.

### x402 — one of two settlement rails KARMA's `IPaymentPlugin v1` wraps

`StellarX402Plugin` ([`src/plugins/x402_stellar.ts`](../../src/plugins/x402_stellar.ts)) and
`CasperX402Plugin` ([`src/plugins/x402_casper.ts`](../../src/plugins/x402_casper.ts)) both
implement the 3-method `IPaymentPlugin` interface (`quote` / `pay` / `verify`) on top of real
x402 facilitators (`@x402/core@2.16.0`, `@x402/stellar@2.16.0` — see `package.json`). The
`IPaymentPlugin` receipt's `txHash` carries the actual signed x402 payment envelope per the
Coinbase "exact" scheme — see
[`IPaymentPlugin-v1.md#x402-wire-format-compatibility`](./IPaymentPlugin-v1.md#x402-wire-format-compatibility).
KARMA does not reimplement or fork x402; it treats it as one pluggable `SettlementRail` value
(`"x402" | "escrow"`) alongside native escrow (Pharos, Casper), so a caller can pay per-call over
x402 *and* still get KARMA's identity gate and reputation check on the same request.

### ERC-8004 — the identity-pointer layer KARMA's `IdentityPolicy` sits next to

`IdentityPolicy` values (`0` NONE, `1` T3N_VERIFIED, `2` T3N_VERIFIED_FRESH — see
[`IdentityPolicy-registry.md`](./IdentityPolicy-registry.md)) currently resolve through the
Terminal3 Agent Auth SDK (`did:t3n:…`), not an ERC-8004 registry — but the enum was designed so
the two can co-exist: a skill can require `identityPolicy = 1` *and* separately point to an
ERC-8004 record for the requester's on-chain identity resolution. `IdentityPolicy` answers *what
level of proof is required to call this skill*; ERC-8004 would answer *where to look up that
proof*. They're orthogonal by design, not because ERC-8004 support is missing — a future issuer
value could resolve via ERC-8004 exactly the way `1`/`2` resolve via Terminal3 today.

### The part none of the three cover — dispute resolution — is live on Casper

This is the clearest gap in the triangle: none of MCP, x402, or ERC-8004 defines what happens when
a payer says the delivered work was wrong. KARMA's answer is a symmetric dispute-bond lifecycle
implemented directly in the `AgentSkillRegistry` Odra contract
([`contracts-odra/src/agent_skill_registry.rs`](../../contracts-odra/src/agent_skill_registry.rs)):
a requester posts a dispute bond (`ResultDisputed`), the provider matches it to contest
(`DisputeResponsePosted`) or concedes (`DisputeConceded`), and a neutral on-chain arbiter — a
distinct account from both parties — rules via `DisputeArbitrated`, which actually moves escrow
and actually slashes reputation. This ran for real on Casper Testnet on 2026-07-07: a requester
disputed a delivered result, the provider matched the bond, and the arbiter ruled
`ProviderAtFault` — reputation dropped `50 → 40` and escrow was refunded on-chain, not simulated
(full tx-by-tx evidence in [`DEMO_CASPER.md`](../../DEMO_CASPER.md#courtroom-dispute--arbitrate--done-live-2026-07-07)).
Every step of that lifecycle — `casper_dispute_result`, `casper_respond_to_dispute`,
`casper_concede_dispute`, `casper_arbitrate` — is an MCP tool
([`src/plugins/casper.tool.ts`](../../src/plugins/casper.tool.ts)), so the dispute is not a
side-channel process outside the protocol; it's invoked the same way the job itself was invoked.

## Worked example: one call, three standards, one trust layer

An agent calling a paid Casper skill through KARMA in a single MCP round-trip exercises all three
adjacent standards plus the layer none of them cover:

1. **MCP** — the caller discovers the skill via `casper_discover_skills` (BM25, reputation-boosted)
   and invokes `casper_create_job` — standard MCP tool call, no protocol extension.
2. **Identity** — `create_job` checks the skill's `identityPolicy`. If it's `1`/`2`, the caller
   must present a valid Terminal3 `did:t3n:…` receipt; a future ERC-8004-issued identity could
   satisfy the same gate without changing the call shape.
3. **Reputation** — skill discovery and the minimum-reputation gate both read the off-chain
   EigenTrust-lite score seeded from the on-chain bond (`seedWeightFromBond`,
   [`reference-implementations.md`](./reference-implementations.md)) — nothing ERC-8004 defines,
   since ERC-8004 only points at *where* attestations live, not how they're scored.
4. **Settlement** — payment clears via `CasperX402Plugin`, a real x402 facilitator round-trip,
   receipt verified structurally through `IPaymentPlugin.verify`.
5. **Recourse** — if the requester disputes the delivered result, `casper_dispute_result` /
   `casper_arbitrate` run the on-chain dispute-bond lifecycle above — the one piece no adjacent
   standard defines at all.

Steps 2, 3, and 5 are KARMA. Steps 1 and 4 are MCP and x402, used as specified, not replaced.

## Summary

- **Don't build a fourth standard that competes with MCP, x402, or ERC-8004.** Each is correctly
  scoped to its layer, and KARMA's `IPaymentPlugin`/`IdentityPolicy` interfaces are designed to
  wrap and interoperate with them, not fork them (see the "Relation to adjacent standards"
  sections in [`IPaymentPlugin-v1.md`](./IPaymentPlugin-v1.md#relation-to-adjacent-standards) and
  [`IdentityPolicy-registry.md`](./IdentityPolicy-registry.md#relation-to-adjacent-standards)).
- **Do fill the gap all three leave open together**: none of them, alone or combined, answers
  "should this specific call be trusted at this specific threshold" or "what happens if the
  delivered work is disputed." KARMA answers both, on-chain, and exposes the answer as ordinary
  MCP tool calls.
