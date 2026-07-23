# KARMA — Cross-Chain Trust Oracle for OKX.AI

[![CI](https://github.com/Eilodon/KARMA-NEW/actions/workflows/ci.yml/badge.svg)](https://github.com/Eilodon/KARMA-NEW/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Eilodon/KARMA-NEW/actions/workflows/codeql.yml/badge.svg)](https://github.com/Eilodon/KARMA-NEW/actions/workflows/codeql.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

> Built for the **OKX.AI Genesis Hackathon**. KARMA also runs live on Casper and Stellar
> Testnet — deployments that predate this hackathon, included here as evidence the protocol is
> portable, not written for this submission alone. See [Live deployments](#live-deployments).
>
> Casper Buildathon judges: start with [DEMO_CASPER.md](DEMO_CASPER.md) instead.

## What it does

Would you send a stranger money before they've done any work for you? That's what an agent does
every time it pays another agent it has no history with.

KARMA answers one question before that payment goes out: has this agent actually delivered
before, and where? `get_cross_chain_trust_score` is a free Agent-to-MCP (A2MCP) service on
OKX.AI. Give it an address, and it reads that agent's on-chain reputation and job/dispute history
across four independently run chains — Pharos, X Layer, Casper, and Stellar — and returns one
evidence-backed answer. No signup, no payment, one call.

It isn't an agent registry, and it isn't a pre-signature checker — those solve adjacent problems
(identity, and "is this transaction safe to sign") that other Genesis entrants already cover well.
KARMA reads reputation that already exists: an identity, escrow, and dispute-arbitration kernel
with 155 Rust tests, 96 Foundry tests, and two live Testnet deployments (Casper, Stellar) that
predate this hackathon. X Layer is the fourth chain the same spec lands on, not the first.

---

## Why it fits OKX.AI Genesis

OKX.AI already ships real trust infrastructure: agent identity on ERC-8004 (per OKX's own
`okx-ai` Onchain OS skill), escrow for A2A jobs, and dispute arbitration by five or more staked
Evaluators (≥100 OKB each, majority vote, weighted-random selection, slashing for wrong or
timed-out votes — per `okx.ai/tutorial`). That's a deliberate, sensible scope, not a gap — but it
means reputation earned on OKX.AI stays scoped to OKX.AI. An agent with a track record on Casper,
Stellar, or Pharos carries no record of it anywhere OKX can see. One independent write-up on the
launch put it plainly: *"the identity lives on OKX, the escrow lives on OKX, and the evaluators
who settle disputes are OKX's network."*

KARMA reads across that boundary. The agent identity is the same EVM address on every EVM chain,
so reputation gets pulled from every chain that address actually has history on.

| Track | Why KARMA fits | Evidence |
|---|---|---|
| **Software Utility** | A reusable trust-lookup primitive other ASPs call before transacting, not a single consumer app | `get_cross_chain_trust_score` (`src/plugins/trust_oracle.tool.ts`) |
| **Finance Copilot** | Counterparty risk scoring — "should my agent pay this provider" — is a finance-copilot primitive | Same tool; `aggregateScore` is evidence-backed, not a black box |
| OKX ecosystem integration | Agentic Wallet, Onchain OS `okx-ai` skill (ERC-8004), X Layer, x402 (`@x402/evm`) | `src/lib/xlayer.ts`, `src/plugins/x402_xlayer.ts`, `script/deploy_xlayer.sh`; `okx/onchainos-skills` installed for real (`skills-lock.json`) and composed live with `get_cross_chain_trust_score` in `src/scripts/demo_onchainos_composability.ts` — see [docs/TOOLS.md](docs/TOOLS.md#composability-with-onchain-os-okxonchainos-skills) |
| Technical depth | Same escrow/dispute/reputation contract as two other live chains — X Layer is an adapter, not a rewrite | `contracts/AgentSkillRegistry.sol`, 96/96 Foundry tests, unchanged; `RationaleAttestation.sol` sidecar (P2-A, ported from Casper) adds decision-rationale attestation without touching the deployed registry |

The demo is deliberately small: one free tool, one call, one JSON answer with the evidence
attached (`chains: [...]`). No payment flow, no wallet funding, no multi-step negotiation. The
depth — four chains, real tests, real deployments — is there for a judge who wants to look
further, but trying it doesn't require that.

Nothing in this submission touches mainnet value. X Layer work is testnet-only, the ASP is listed
free rather than on the paid x402 tier, and OKX.AI's Evaluator role — which requires staking real
OKB — isn't registered. What that trades off, and why, is in
[Known limitations](#known-limitations).

---

## Live deployments

The same identity/reputation/escrow/dispute spec, independently deployed on four chains. This
table is the evidence behind "portable" — every address below is checked and verifiable.

| Chain | Contract | Tests | Notes |
|---|---|---|---|
| **X Layer** (OKX.AI Genesis) | [`0xBF28…74Cd2`](https://www.oklink.com/xlayer-test/address/0xBF285628869c2EFaf6731F8503B39B7130474Cd2) · testnet | 23 Vitest + shares Pharos's 96 Foundry | `IPaymentPlugin` v1.0 (`x402-xlayer`). Deploy tx [`0xe4f803…8b1b380`](https://www.oklink.com/xlayer-test/tx/0xe4f803add9aba71a34e995d00f5cdb849664bb35b90de3566196c25208b1b380). `get_cross_chain_trust_score` reads it live. |
| **X Layer — RationaleAttestation** (P2-A) | [`0x402d0e…AAc108C1`](https://www.oklink.com/xlayer-test/address/0x402d0e956A3E2ba3936864Ba64201edBAAc108C1) · testnet | 6 Foundry (102/102 with the shared 96) | Sidecar next to `AgentSkillRegistry` — not a change to it. Deploy tx [`0x9097ec…f531e0`](https://www.oklink.com/xlayer-test/tx/0x9097ec2ae08a670281c67157979506653c391e14216568aedd104cf8b6f531e0). Live round trip: `attest_rationale` tx [`0x388c24…7dbdd8`](https://www.oklink.com/xlayer-test/tx/0x388c248a921e1f129c4f3afb798ddd8a58b9235801e6b15551fe3a02127dbdd8) → `get_rationale_hash` reads back the identical hash. |
| **Casper** | [`hash-42f6945f…a2b5a1d`](https://testnet.cspr.live/contract-package/42f6945fe9ac5ab493beed468465228ecb830036e27bb2c8cac9e1736a2b5a1d) · testnet | 155 Rust | `IPaymentPlugin` v1.0. 2-of-2 multisig + 48h timelock governance, skill composition, dispute-bond arbitration. |
| **Stellar** | [`agent_credential_verifier`](https://stellar.expert/explorer/testnet/contract/CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP) + [`reputation_aggregation_verifier`](https://stellar.expert/explorer/testnet/contract/CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO) · testnet | 12 + 19 Rust (Soroban) | `IPaymentPlugin` v1.0. Groth16/BN254 zero-knowledge reputation gating, native host functions. |
| **Pharos** | [`0xc6d5c146…081b905ae`](https://atlantic.pharosscan.xyz/address/0xc6d5c146209e0833634bd33fafb9e65081b905ae) · Atlantic | 96 Foundry | The chain the spec was extracted from, and the bytecode X Layer reuses. `IPaymentPlugin` wrapper pending (v2). |

Chain IDs and RPCs: X Layer testnet `1952` (`testrpc.xlayer.tech`), X Layer mainnet `196`
(`rpc.xlayer.tech`, not deployed — testnet only, by design), Pharos Atlantic `688689`
(`atlantic.dplabs-internal.com`).

Deep dives: [DEMO_CASPER.md](DEMO_CASPER.md) (23 recorded live transactions) ·
[DEMO_STELLAR.md](DEMO_STELLAR.md) · [DEMO.md](DEMO.md) (Pharos) ·
[docs/standards/reference-implementations.md](docs/standards/reference-implementations.md).

---

## What KARMA actually builds

Most agent projects ship a worker: one bot, one function. KARMA ships the institutions a labor
market needs underneath it — and each one is running code on-chain, not a diagram.

| Real-world institution | In KARMA | Status |
|---|---|---|
| A credit bureau, portable across chains | Cross-chain reputation aggregation | `get_cross_chain_trust_score` |
| A credit bureau, single-chain | On-chain reputation + EigenTrust-lite flow ranking + Sybil bond | Live, Casper + Pharos |
| A private CV — prove without revealing | Two Groth16/BN254 ZK verifiers: skill gate + portfolio credential | Live on-chain, Stellar |
| An escrow bank | Escrow + release | Live, Pharos + Casper |
| A vending machine for machines | Per-call x402 settlement | Live (Stellar, Casper), built (X Layer) |
| A courtroom where the judge is also an agent | Dispute bond + neutral evaluator arbitration, single or N-of-M panel | Live on-chain, Casper |
| A company, not a freelancer | Skill composition + weighted revenue split | Deployed, Casper |

### How this relates to MCP, x402, and ERC-8004

None of these compete with KARMA — each solves one layer, and none solves all three:

| Standard | Solves | Doesn't solve |
|---|---|---|
| MCP | Wire format — how an agent calls a tool | Commerce: no price, payment, or trust |
| x402 | Payment — how money moves for a call | Trust: no identity, reputation, or dispute |
| ERC-8004 | Identity + a pointer to reputation | Settlement, and portability — reputation is per-deployment |
| **KARMA** | **Identity + portable reputation + dispute resolution, wired to settlement, spoken over MCP** | — |

This isn't abstract for OKX.AI: its own `okx-ai` Onchain OS skill describes its identity system
as ERC-8004 (register/update/search/rate, across User/ASP/Evaluator roles). KARMA extends exactly
the cross-deployment portability gap ERC-8004 leaves open, for the identity system OKX already
shipped on X Layer. Full comparison:
[docs/standards/relation-to-adjacent-standards.md](docs/standards/relation-to-adjacent-standards.md).

### Why the tech holds up

- **Zero-knowledge reputation, live on Stellar.** An agent proves "my reputation clears skill Y's
  threshold" via Groth16, verified on-chain by native BN254 host functions (CAP-0074). The score,
  job history, and credential secret never leave the agent's machine. Two verifier contracts are
  live on Stellar Testnet — architecture, the soundness gaps found and fixed, and a recorded
  demo: [DEMO_STELLAR.md](DEMO_STELLAR.md).
- **Resistant to Sybil attacks and wash trading**, not just a counter that goes up. Dealing with
  yourself earns zero reputation (an arm's-length guard); an EigenTrust-lite flow ranking runs
  off-chain, value-weighted and decaying over time; an optional on-chain capital bond backs it
  further.
- **Non-repudiation and bounded authority**, on chains Terminal3 gates. Every job binds to a
  signed identity receipt; delegated authority is TEE-signed, time-bounded, and revocable.
- **A path toward a standard, not just a claim of being one.** The identity/reputation/escrow/
  dispute interface is drafted as a Casper Enhancement Proposal
  ([CEP-0000](docs/standards/CEP-0000-agent-skill-trust-registry.md)) covering every entry point,
  event, and state transition — so another project can adopt the trust layer without running a
  KARMA server.

---

## Quick start

### Try the Trust Oracle — no wallet needed

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test    # 912/912 passing
```

```env
# .env — this is everything it takes to expose the tool
MCP_SAFE_MODE=false
MCP_PLUGIN_ALLOWLIST=system.tool.ts,trust_oracle.tool.ts
MCP_PLUGIN_ISOLATION_MODE=policy
```

```bash
pnpm dev   # starts the MCP server (stdio) — look for "Plugin loaded 'trust_oracle.tool.ts' (1/1 tools accepted)"
```

Call `get_cross_chain_trust_score({ evm_address: "0x..." })` from any MCP client. With no chain
configured it still answers — every leg reports a `note` instead of failing
(`src/__tests__/trust_oracle_tool.test.ts`, "degrades gracefully"). Add `PHAROS_*` / `XLAYER_*` /
`CASPER_*` to `.env` (see `.env.example`) for real reads instead of notes.

### Full setup — all chains, keystore, on-chain demos

- Node.js 20+, pnpm 9.15.9 (`corepack enable && corepack prepare pnpm@9.15.9 --activate`)
- [Foundry](https://book.getfoundry.sh/) (`foundryup`), only for Solidity tests or deploying to
  Pharos/X Layer
- Redis 8.2.2+, only if `STORAGE_DRIVER=redis` (production)

```bash
KEYSTORE_PATH=./keystore.json KEYSTORE_PASSWORD=<min-8-chars> \
  pnpm setup:keystore agent-alpha agent-beta
```

This generates fresh keypairs (Web3 Secret Storage v3, scrypt + aes-128-ctr), writes
`keystore.json` at `0o600`, and prints each address.

Full runtime reference, HTTP transport, production auth (JWT/OIDC), and Docker:
[docs/RUNTIME.md](docs/RUNTIME.md). Per-chain quickstarts: [DEMO_CASPER.md](DEMO_CASPER.md),
[DEMO_STELLAR.md](DEMO_STELLAR.md), [DEMO.md](DEMO.md).

---

## Tools

`get_cross_chain_trust_score` is the OKX.AI submission (see
[Why it fits OKX.AI Genesis](#why-it-fits-okxai-genesis) above). The same server also exposes the
rest of the multi-chain skill economy: 14 KARMA skill-economy tools (Pharos), 8 Terminal3
identity/delegation tools, and 46 Casper Odra registry tools (skill registry, composition,
evaluator/dispute/arbitration, N-of-M panel arbitration, cross-chain-rep governance). Full
reference, kept out of this README to keep the pitch focused:
[docs/TOOLS.md](docs/TOOLS.md).

---

## Testing

```bash
pnpm typecheck && pnpm lint && pnpm test   # 912/912 passing
```

The X Layer/OKX.AI additions (`src/lib/xlayer.ts`, `src/plugins/x402_xlayer.ts`,
`src/plugins/trust_oracle.tool.ts`) add 23 Vitest tests: plugin metadata/quote/pay/verify,
boot-time registration, and the oracle's graceful-degradation behavior.

<details>
<summary><strong>Casper, Stellar, Pharos test suites</strong> (predate this hackathon)</summary>

```bash
cargo +nightly test --manifest-path contracts-odra/Cargo.toml   # 155/155 Rust, Casper
cd contracts-soroban/agent_credential_verifier && cargo test --features testutils       # 12/12
cd contracts-soroban/reputation_aggregation_verifier && cargo test --features testutils # 19/19
pnpm test:contract   # Foundry — 96/96 AgentSkillRegistry.sol, shared by Pharos + X Layer
```

Casper's 155 Rust tests cover the full escrow/dispute/evaluator/composition/governance feature
set, plus 4 property-based invariant tests (escrow conservation, reputation bounds) — each
confirmed to actually catch a regression by deliberately breaking the invariant first. Both
Stellar/Soroban suites verify a real, non-mocked Groth16 proof through the native
`bn254_multi_pairing_check` host function. Full detail: [DEMO_CASPER.md](DEMO_CASPER.md) ·
[DEMO_STELLAR.md](DEMO_STELLAR.md).

</details>

---

## Known limitations

Disclosed here rather than left for a judge to find:

- **`aggregateScore` is an equal-weighted average**, not the decayed, history-weighted
  EigenTrust-lite model KARMA uses for single-chain reputation elsewhere — an agent with 1 job on
  X Layer currently counts the same as one with 200 jobs on Casper.
  `jobsAsProvider`/`jobsAsRequester` are already returned per chain so a caller can apply that
  judgment today; [`src/scripts/evaluator_skill_reference.ts`](src/scripts/evaluator_skill_reference.ts)
  (`pnpm demo:evaluator-skill-reference`) is a worked illustration of the job-count-weighted fix,
  kept separate from the shipped tool rather than rushed into it.
- **The paid x402 tier is built but not switched on.** `src/plugins/x402_xlayer.ts` is
  typechecked and tested; what's live is the free listing. Turning on paid calls needs a real
  settlement-asset address and a facilitator endpoint, and both resolve to **X Layer mainnet
  only** today — verified on-chain: X Layer settles in USD₮0
  (`0x779Ded0c9e1022225f8E0630b35a9b54bE713736`) or USDG
  (`0x4ae46a509F6b1D9056937BA4500cb143933D2dc8`), neither of which has a testnet deployment.
  Enabling it means real money, which this submission deliberately avoids — see
  [`docs/OKX_HACKATHON_CHECKLIST.md`](docs/OKX_HACKATHON_CHECKLIST.md) §9.
- **OKX.AI's Evaluator role isn't registered.** It requires staking ≥100 OKB in real capital to
  arbitrate disputes — out of scope for a zero-financial-risk submission. The signal an Evaluator
  could use is built as a reference implementation (same script as above): it reads
  `get_cross_chain_trust_score` and prints a comparison, but doesn't vote, submit, or touch any
  OKX.AI contract.
- **Pharos's `IPaymentPlugin` is a v2 wrapper, pending.** Escrow and settlement both work today;
  the conformance wrapper that brings it to the same v1.0 status as Stellar, Casper, and X Layer
  isn't shipped yet.

Full status on every open item: [docs/OKX_HACKATHON_CHECKLIST.md](docs/OKX_HACKATHON_CHECKLIST.md).

---

## Project layout

```text
src/
  core/          SUPER-MCP runtime core (tasks, request context, structured debt tracking)
  mcp/           protocol adapters, tool registry, transports
  middlewares/   auth, rate limit, quota, idempotency, output firewall
  storage/       fs / redis / memory drivers + encryption (v3 hkdf, v4 kms)
  plugins/
    trust_oracle.tool.ts   OKX.AI Genesis Hackathon — get_cross_chain_trust_score
    x402_xlayer.ts         IPaymentPlugin settlement rail for X Layer
    karma.tool.ts / t3.tool.ts / casper.tool.ts / x402_stellar.ts / x402_casper.ts
  lib/           KarmaService, keystore, viem clients, BM25 index, ABI, flow_reputation
    xlayer.ts        X Layer chain adapter (chainId 1952/196)
    payment/          IPaymentPlugin interface + registry
    zk/               RepAgg proof wrapper, cross-chain rep oracle, signed-TLS attestation
    stellar/ casper/  HKDF-derived keypairs; in-process Odra registry + composition tools
  scripts/       setup_keystore, deploy_contract, demos, run_autonomous_loop
  __tests__/     Vitest suites (runtime + app layer)
circuits/        Circom circuits: agent_credential, reputation_aggregation (+ snarkjs harness)
contracts/       AgentSkillRegistry.sol + KarmaTimelock.sol (Foundry — Pharos AND X Layer)
contracts-soroban/   Stellar verifiers: agent_credential, reputation_aggregation (Rust)
contracts-odra/      Casper AgentSkillRegistry + skill composition (Odra / Rust)
docs/            OKX_HACKATHON_CHECKLIST.md, demo-video-script-okx.md, TOOLS.md, RUNTIME.md,
                 standards/ (public specs), rfc/ (design discussions), media/
```

---

## Roadmap & team

**Next up:**

- Register the free ASP listing on OKX.AI — the next concrete step now that the X Layer contract
  is live ([checklist](docs/OKX_HACKATHON_CHECKLIST.md) §3).
- Weight `aggregateScore` by job count and recency, closing the gap in
  [Known limitations](#known-limitations), instead of the current plain average.
- Apply to Find Super Nova, independent of the hackathon result
  ([checklist](docs/OKX_HACKATHON_CHECKLIST.md) §6).
- Package the standard, not just this deployment: pull `docs/standards/` and its conformance test
  vectors into a standalone installable package, and get a second, independently authored
  implementation built against it.
- Redeploy N-of-M panel arbitration (built, 155/155 Rust tests) and run a live panel dispute.

A mainnet timeline, funding, and a monetization model aren't set yet — this section updates once
they are.

**Team.** Solo builder — Eilodon, affiliated with B.ONE. [X / Twitter](https://x.com/MathEnemy) ·
Telegram [@HoaTrungBinh](https://t.me/HoaTrungBinh) · Discord `mathenemy`.

---

## Security notes

- The external child-process plugin runner is best-effort hardening, not an OS/container/microVM
  sandbox — untrusted third-party plugins aren't supported in production yet.
- `karma.tool.ts`, `t3.tool.ts`, and `trust_oracle.tool.ts` use in-process singletons and must run
  in-process; they throw at startup in the external worker.
- The keystore is testnet-only. Rotate `KEYSTORE_PASSWORD` (re-encrypt) if it's ever exposed;
  `keystore.json*` and `.env*` are gitignored.
- Raw private keys never leave `KeystoreManager` — signing happens through viem's `Account` or
  the TEE.
- `src/plugins/x402_xlayer.ts` refuses to guess a settlement-token address and fails loud instead
  — a wrong guess would silently misdirect a real payment.

**Found and fixed during Casper governance-hardening** (full write-up:
[DEMO_CASPER.md](DEMO_CASPER.md)): a code-level review surfaced three gaps. Two are fixed — a
governance-bypass inconsistency in `set_arbiter`/`set_dispute_bond_bps`, and a deploy-time config
gap that would have made that fix ineffective. One is disclosed and still open: upgrade-token
custody for the Odra contract currently sits with a single governance signer's key, outside the
multisig+timelock gate that covers everything else. Two remediation options are on the table, not
yet resolved.

Auth modes, KMS-backed crypto-erasure, the output firewall, and the full configuration reference:
[docs/RUNTIME.md](docs/RUNTIME.md).

---

## License

[Apache 2.0](LICENSE).
