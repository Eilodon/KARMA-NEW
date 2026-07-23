# KARMA — Cross-Chain Trust Oracle for OKX.AI

> Built for the **OKX.AI Genesis Hackathon**. (Also has independent Casper/Stellar Testnet
> deployments predating this hackathon, used here as portability evidence — see
> [Live deployment](#live-deployment). Casper Buildathon judges: [DEMO_CASPER.md](DEMO_CASPER.md)
> is the dedicated doc for that submission.)

**The one-line pitch:** would you pay a stranger agent upfront? Before your agent pays another
agent on OKX.AI, it can ask KARMA one question — has this agent actually delivered before, and
where — and get a real, evidence-backed answer instead of a self-reported number.

That's `get_cross_chain_trust_score`: a **free** Agent-to-MCP (A2MCP) service on OKX.AI that reads
an agent's on-chain reputation and job/dispute history from four independently-run chains (Pharos,
X Layer, Casper, plus a note on Stellar's zero-knowledge-gated reputation) and returns one
evidence-backed answer. No signup, no payment, one call.

**Not another agent registry, and not another pre-signature checker.** Two things people building
for this track tend to reach for, and KARMA is deliberately neither: it doesn't ask "is this
transaction safe to sign right now" (that's intent-verification — a different, complementary
problem some other Genesis entrants solve well); and it isn't a from-scratch marketplace built only
for X Layer. KARMA answers "did this agent deliver last time, and can I prove it" — reading from a
reputation/escrow/dispute-arbitration kernel that already has 155 Rust + 96 Foundry tests and two
live Testnet deployments (Casper, Stellar) built *before* this hackathon existed. X Layer is the
fourth chain the same spec lands on, not the first.

---

## Fit to the OKX.AI Genesis Hackathon

**The gap, precisely stated.** OKX.AI already has real, working trust infrastructure: agent
identity built on **ERC-8004** (confirmed directly from OKX's own `okx-ai` Onchain OS skill), escrow
for A2A jobs, and dispute arbitration by ≥5 staked Evaluators (≥100 OKB each, majority vote,
weighted-random selection, wrong/timed-out votes slashed — verified at `okx.ai/tutorial`). This is
not a gap in OKX's design — it's a deliberate, sensible scope. But as one independent write-up on
OKX.AI's launch put it: *"the identity lives on OKX, the escrow lives on OKX, and the evaluators
who settle disputes are OKX's network"* — reputation earned on OKX.AI is real, but it's scoped to
OKX.AI. An agent that also works on Casper, Stellar, or Pharos carries no record of that anywhere
OKX can see. KARMA reads across that boundary: same agent identity (an EVM address is
chain-independent), reputation pulled from every chain it actually has history on.

| Category (target) | Why KARMA fits | Evidence in this repo |
|---|---|---|
| **Software Utility** | A reusable trust-lookup primitive other ASPs call before transacting — not a single consumer app | `get_cross_chain_trust_score` (`src/plugins/trust_oracle.tool.ts`) |
| **Finance Copilot** (secondary) | Counterparty risk scoring is a finance-copilot primitive — "should I let my agent pay this provider" | Same tool; `aggregateScore` is an evidence-backed risk read, not a black-box output |
| OKX ecosystem integration | Agentic Wallet, Onchain OS `okx-ai` skill (ERC-8004), X Layer, x402 (`@x402/evm`, settling in USDT/USDG — confirmed, not USDC) | `src/lib/xlayer.ts`, `src/plugins/x402_xlayer.ts`, `script/deploy_xlayer.sh` |
| Technical depth (separate from "is it live on X Layer yet") | Same escrow/dispute/reputation contract, same test suite, already proven on two other chains — X Layer is a chain *adapter*, not a rewrite | `contracts/AgentSkillRegistry.sol` (96/96 Foundry tests, unchanged) |

**Why this is easy to judge quickly:** one free tool, one call, one JSON answer with the evidence
attached (`chains: [...]`) — no payment flow to explain, no wallet funding required to try it, no
multi-step negotiation. The depth (four chains, real tests, real Testnet deployments) is there if
you look, but the demo itself is a single, simple call.

**Zero real money, on purpose.** Nothing in this submission touches mainnet value or requires
staking: X Layer work is testnet-only, the ASP is listed free (not the paid x402 tier — that code
is built and tested, just not switched on), and OKX.AI's own Evaluator role — which requires
staking ≥100 OKB in real capital — was deliberately not pursued here even though OKX's docs
explicitly invite custom Evaluator logic ("write your own to judge sharper"). That's a real,
scoped-out opportunity, not a limitation we didn't notice — see
[`docs/OKX_HACKATHON_CHECKLIST.md`](docs/OKX_HACKATHON_CHECKLIST.md) §7.

**Self-audit — one real gap, disclosed, not fixed under deadline pressure.** `aggregateScore`
(`src/plugins/trust_oracle.tool.ts`) is a plain, equal-weighted average of whichever chains return
a number. That's honest about *what data exists*, but it isn't the trust model the rest of KARMA
already uses elsewhere — single-chain reputation is computed with an EigenTrust-lite flow ranking
that decays over time and downweights thin history (see [Why the tech holds up](#why-the-tech-holds-up)).
An agent with 1 job on X Layer counts exactly as much as one with 200 jobs on Casper in today's
cross-chain average. The fix is straightforward (weight each chain's contribution by job count,
decayed) but wasn't worth rushing into untested code days before a deadline;
`jobsAsProvider`/`jobsAsRequester` are already returned per chain in the tool's output specifically
so a caller can apply that judgment themselves until the aggregate does it natively.

**Honest status on the chain adapter itself:** the X Layer chain adapter, x402 payment plugin, and
Trust Oracle tool are built, typechecked, and unit-tested (907/912 suite passing) — Foundry could
not be installed inside the sandbox that assembled this pivot (GitHub release-API egress is
policy-blocked there), so the `AgentSkillRegistry` **testnet broadcast is the next concrete step**
(`script/deploy_xlayer.sh`, needs `forge` + a faucet-funded testnet key — see the checklist §1).
Once deployed, the same tool starts returning real X Layer reads with zero code changes.

**Reused, not rebuilt.** The escrow contract, the dispute-bond arbitration, the `IPaymentPlugin`
interface, and the reputation kernel all predate this hackathon (Casper/Stellar work below). New
for OKX.AI specifically: the X Layer chain adapter, the `x402-xlayer` payment plugin, the
`get_cross_chain_trust_score` aggregation tool, and the free ASP listing itself.

Full step-by-step (what's done vs. what needs a human with real credentials): the checklist above,
[`docs/OKX_HACKATHON_CHECKLIST.md`](docs/OKX_HACKATHON_CHECKLIST.md). Demo script:
[`docs/demo-video-script-okx.md`](docs/demo-video-script-okx.md).

---

## What KARMA actually builds

Most agent projects ship a worker — one bot, one function. KARMA ships the institutions a labor
market needs underneath it, and each one has code running on-chain, not a diagram:

| Real-world institution | In KARMA | Status |
|---|---|---|
| Credit bureau, but portable | Cross-chain reputation aggregation across independent deployments | `get_cross_chain_trust_score` — new for OKX.AI |
| Credit bureau (single-chain) | On-chain reputation + EigenTrust-lite flow ranking + Sybil bond | live + tested, Casper/Pharos |
| A private CV (prove without revealing) | Two Groth16/BN254 ZK verifiers — skill gate + portfolio credential | live on-chain, Stellar |
| An escrow bank | Escrow + release on Pharos and Casper | live, both chains |
| A vending machine for machines | Per-call x402 settlement | live (Stellar, Casper), built (X Layer) |
| A courtroom — where the judge is also an agent | Dispute bond + neutral evaluator arbitration, single arbiter or an N-of-M panel | live on-chain, Casper |
| A company, not just a freelancer | Skill composition + weighted revenue split | deployed, Casper |

### Where this sits relative to adjacent standards

Not competitors — each piece solves a different layer, and none of them solve all three:

| Standard | Solves | Doesn't solve |
|---|---|---|
| MCP | Wire format — how an agent calls a tool | Commerce — no price, payment, or trust |
| x402 | Payment scheme — how money moves for a call | Trust — no identity, reputation, dispute |
| ERC-8004 | Identity + a pointer to reputation | Settlement — no escrow, no payment rail; reputation is per-deployment, not portable across independent ones |
| **KARMA** | **Identity + portable reputation + dispute resolution, wired to settlement, spoken over MCP** | — |

Not abstract for OKX.AI specifically: OKX's own `okx-ai` Onchain OS skill describes its identity
system as **ERC-8004** (register/update/search/rate — User/ASP/Evaluator). KARMA isn't proposing a
standard next to a hypothetical one — it's extending exactly the cross-deployment-portability gap
ERC-8004 leaves open, for the identity system OKX already shipped on X Layer.

Full comparison: [docs/standards/relation-to-adjacent-standards.md](docs/standards/relation-to-adjacent-standards.md).

---

## Proof it's a protocol, not a port

The same identity/reputation/escrow/dispute spec, independently implemented on four chains — this
table is the actual evidence behind "portable," not a claim on faith:

| Chain | What's live | Spec conformance | Tests |
|---|---|---|---|
| **Casper** (`contracts-odra/`) | Escrow, symmetric dispute-bond arbitration (single-arbiter live; N-of-M panel tested, pending redeploy), multisig+timelock governance, skill composition. Governance-hardened, deployed on Testnet. | `IPaymentPlugin` **v1.0 ✓** | 155 Rust tests |
| **Stellar** | Zero-knowledge reputation gating (Groth16/BN254, native host functions), settlement over x402. | `IPaymentPlugin` **v1.0 ✓** | 12 + 19 Rust tests (Soroban) |
| **Pharos** (`contracts/AgentSkillRegistry.sol`) | Escrow, review window, dispute/refund, Sybil-resistance bond, evaluator-agent arbitration, governance. The chain the spec was extracted from — and the bytecode X Layer reuses. | `IPaymentPlugin` wrapper pending (v2) | 96 Foundry tests |
| **X Layer** (`src/lib/xlayer.ts`) — OKX.AI Genesis Hackathon | Same `AgentSkillRegistry` bytecode as Pharos; `get_cross_chain_trust_score` reads it as the 4th leg. Testnet broadcast is the next step. | `IPaymentPlugin` **v1.0 ✓** (`x402-xlayer`, `@x402/evm`) | 23 Vitest, shares Pharos's 96 Foundry tests |

Deep dives: [DEMO_CASPER.md](DEMO_CASPER.md) · [DEMO_STELLAR.md](DEMO_STELLAR.md) ·
[DEMO.md](DEMO.md) (Pharos) ·
[docs/standards/reference-implementations.md](docs/standards/reference-implementations.md).

### Why the tech holds up

**Zero-knowledge reputation gating, live on Stellar.** An agent can prove "my reputation clears
skill Y's threshold" via Groth16, verified on-chain by native BN254 host functions (CAP-0074) — the
score, job history, and credential secret never leave the agent's machine. Two verifier contracts
are live on Stellar Testnet (`agent_credential_verifier`, `reputation_aggregation_verifier`) —
architecture, the soundness gaps found and fixed, and a live-captured demo:
[DEMO_STELLAR.md](DEMO_STELLAR.md).

**Reputation that resists Sybil attacks and wash trading**, not just a counter that goes up. An
arm's-length guard means dealing with yourself earns zero reputation, an EigenTrust-lite flow
ranking runs off-chain (value-weighted, decays over time), and an optional on-chain capital bond
backs it further.

**Non-repudiation and bounded authority**, on chains Terminal3 gates. Every job binds to a signed
identity receipt, and any delegated authority is TEE-signed, time-bounded, and revocable.

**A path toward becoming a standard, not just a claim of being one.** The settlement/identity/
dispute interface is drafted as a Casper Enhancement Proposal
([`CEP-0000`](docs/standards/CEP-0000-agent-skill-trust-registry.md)) covering every entry point,
event, and state transition — so any project can adopt this trust layer without running a KARMA
server.

---

## Live deployment

**X Layer** (OKX.AI Genesis Hackathon) — chain adapter + `x402-xlayer` payment plugin +
`get_cross_chain_trust_score` are built and unit-tested; the `AgentSkillRegistry` broadcast itself
is the next step (`script/deploy_xlayer.sh`, see [checklist](docs/OKX_HACKATHON_CHECKLIST.md) §1):

| | |
|---|---|
| **`AgentSkillRegistry`** | not yet broadcast — same bytecode as the Pharos deployment below |
| **X Layer testnet** | chain ID `1952`, RPC `https://testrpc.xlayer.tech` |
| **X Layer mainnet** | chain ID `196`, RPC `https://rpc.xlayer.tech` (currency OKB) |

<details>
<summary><strong>Casper, Stellar, Pharos</strong> — predate this hackathon, kept here as portability evidence</summary>

**Casper Testnet** (Odra, attestation-hardened) — full tx-by-tx evidence in [DEMO_CASPER.md](DEMO_CASPER.md):

| | |
|---|---|
| **`AgentSkillRegistry`** | [`hash-42f6945fe9ac5ab493beed468465228ecb830036e27bb2c8cac9e1736a2b5a1d`](https://testnet.cspr.live/contract-package/42f6945fe9ac5ab493beed468465228ecb830036e27bb2c8cac9e1736a2b5a1d) |
| **Governance** | real 2-of-2 multisig + 48h timelock, confirmed live from the contract's own storage |
| **Sample transactions** | 23 real, `testnet.cspr.live`-verified calls — [DEMO_CASPER.md](DEMO_CASPER.md#recorded-live-transactions) |

**Stellar Testnet** (Soroban, native BN254) — [DEMO_STELLAR.md](DEMO_STELLAR.md):

| | |
|---|---|
| **`agent_credential_verifier`** | [`CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP`](https://stellar.expert/explorer/testnet/contract/CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP) |
| **`reputation_aggregation_verifier`** | [`CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO`](https://stellar.expert/explorer/testnet/contract/CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO) |

**Pharos Atlantic** — [DEMO.md](DEMO.md):

| | |
|---|---|
| **Contract (v3)** | [`0xc6d5c146209e0833634bd33fafb9e65081b905ae`](https://atlantic.pharosscan.xyz/address/0xc6d5c146209e0833634bd33fafb9e65081b905ae) |
| **Chain ID** | `688689` (EIP-1559) · RPC `https://atlantic.dplabs-internal.com` |

</details>

---

## Quick start

### Fastest path — try the Trust Oracle, no wallet needed

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test    # 907/912 passed, 5 pre-existing skips unrelated to this pivot
```

```env
# .env — minimal, verified: this is exactly what it takes to expose the tool (nothing more)
MCP_SAFE_MODE=false
MCP_PLUGIN_ALLOWLIST=system.tool.ts,trust_oracle.tool.ts
MCP_PLUGIN_ISOLATION_MODE=policy
```

```bash
pnpm dev   # starts the MCP server (stdio); log line confirms: "Plugin loaded 'trust_oracle.tool.ts' (1/1 tools accepted)"
```

Then, from any MCP client, call `get_cross_chain_trust_score({ evm_address: "0x..." })`. With no
chain configured it still answers — every leg reports a `note` instead of failing (see
`src/__tests__/trust_oracle_tool.test.ts`, "degrades gracefully"). Add `PHAROS_*` / `XLAYER_*` /
`CASPER_*` to the same `.env` (see `.env.example`) to get real reads instead of notes.

### Full setup (all chains, keystore, on-chain demos)

- Node.js 20+, pnpm 9.15.9 (`corepack enable && corepack prepare pnpm@9.15.9 --activate`)
- [Foundry](https://book.getfoundry.sh/) (`foundryup`) only if you're running Solidity tests or
  deploying to Pharos/X Layer
- Redis 8.2.2+ only if `STORAGE_DRIVER=redis` (production)

```bash
KEYSTORE_PATH=./keystore.json KEYSTORE_PASSWORD=<min-8-chars> \
  pnpm setup:keystore agent-alpha agent-beta
```

Generates fresh keypairs (Web3 Secret Storage v3, scrypt + aes-128-ctr), writes `keystore.json`
(`0o600`), and prints each address. Full runtime reference, HTTP transport, production auth
(JWT/OIDC), Docker: [docs/RUNTIME.md](docs/RUNTIME.md). Per-chain quickstarts:
[DEMO_CASPER.md](DEMO_CASPER.md), [DEMO_STELLAR.md](DEMO_STELLAR.md), [DEMO.md](DEMO.md) (Pharos).

---

## Tools

`get_cross_chain_trust_score` is the OKX.AI submission — table and description in
[Fit to the OKX.AI Genesis Hackathon](#fit-to-the-okxai-genesis-hackathon) above. The server also
exposes the rest of the multi-chain skill economy: 14 KARMA skill-economy tools (Pharos), 8
Terminal3 identity/delegation tools, and 46 Casper Odra registry tools (skill registry,
composition, evaluator/dispute/arbitration, N-of-M panel arbitration, cross-chain-rep governance).
Full tables, kept out of this README to keep the OKX pitch focused:
[**docs/TOOLS.md**](docs/TOOLS.md).

---

## Testing

```bash
pnpm typecheck && pnpm lint && pnpm test   # 907/912 passed, 5 pre-existing skips unrelated to this pivot
```

The X Layer/OKX.AI additions (`src/lib/xlayer.ts`, `src/plugins/x402_xlayer.ts`,
`src/plugins/trust_oracle.tool.ts`) add 23 Vitest tests: plugin metadata/quote/pay/verify,
boot-time registration, and the oracle tool's graceful-degradation behavior. The 5 skipped tests
are pre-existing environment gaps unrelated to this pivot.

<details>
<summary><strong>Casper, Stellar, Pharos test suites</strong> (predate this hackathon)</summary>

```bash
cargo +nightly test --manifest-path contracts-odra/Cargo.toml   # 155/155 Rust tests, Casper
cd contracts-soroban/agent_credential_verifier && cargo test --features testutils       # 12/12
cd contracts-soroban/reputation_aggregation_verifier && cargo test --features testutils # 19/19
pnpm test:contract   # Foundry — 96/96 AgentSkillRegistry.sol tests (shared by Pharos + X Layer)
```

Casper: 155 Rust tests covering the full escrow/dispute/evaluator/composition/governance feature
set plus 4 property-based invariant tests (escrow conservation, reputation bounds — each verified
to actually catch a regression by deliberately breaking the invariant first). Stellar: both Soroban
suites include a real, non-mocked Groth16 proof verified via the native
`bn254_multi_pairing_check` host function. Full detail: [DEMO_CASPER.md](DEMO_CASPER.md) ·
[DEMO_STELLAR.md](DEMO_STELLAR.md).

</details>

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

**Team.** Solo builder — **Eilodon**, affiliated with **B.ONE**.

**Community.** [X / Twitter](https://x.com/MathEnemy) · Telegram [@HoaTrungBinh](https://t.me/HoaTrungBinh) · Discord: `mathenemy`.

**What's next, concretely:**

- **X Layer testnet broadcast** — the one concrete blocker on the OKX.AI submission
  ([checklist](docs/OKX_HACKATHON_CHECKLIST.md) §1).
- **Weight `aggregateScore` by job count / recency**, closing the self-audited gap above, instead
  of the current plain average.
- **Apply to Find Super Nova**, independent of the hackathon result
  ([checklist](docs/OKX_HACKATHON_CHECKLIST.md) §6).
- **Standardize the interface, not just this one deployment.** Pull `docs/standards/` and its
  conformance test vectors into a standalone installable package, get a second independently
  authored implementation built against it.
- **Redeploy N-of-M panel arbitration** (built, 155/155 Rust tests, landed a day after the
  currently deployed Casper contract) and run a live panel dispute.

This list is scoped to what's actually planned, not a wishlist. A mainnet timeline, funding, and a
monetization model aren't set yet — this section gets updated once they are.

---

## Security notes

- The external child-process plugin runner is best-effort hardening — not an OS/container/microVM
  sandbox; untrusted third-party plugins aren't supported in production yet.
- `karma.tool.ts` / `t3.tool.ts` / `trust_oracle.tool.ts` use in-process singletons and must run
  in-process; they throw at startup in the external worker.
- The keystore is testnet-only. Rotate `KEYSTORE_PASSWORD` (re-encrypt) if it's ever exposed;
  `keystore.json*` and `.env*` are gitignored.
- Raw private keys never leave `KeystoreManager` — signing is done by viem `Account` or the TEE.
- `src/plugins/x402_xlayer.ts` refuses to guess a settlement-token contract address (fails loud
  instead) — a wrong guess would silently misdirect a real payment.

**Found & fixed during Casper governance-hardening** (full writeup: [DEMO_CASPER.md](DEMO_CASPER.md)):
a code-level review surfaced three real gaps. Two are fixed (a governance-bypass inconsistency in
`set_arbiter`/`set_dispute_bond_bps`, and a deploy-time config gap that would have made the fix
theater). One is disclosed and still open: upgrade-token custody for the Odra contract currently
sits with a single governance signer's key, outside the multisig+timelock gate that covers
everything else — two remediation options are on the table, not resolved yet.

For auth modes, KMS-backed crypto-erasure, the output firewall, and the complete configuration
reference, see [docs/RUNTIME.md](docs/RUNTIME.md).

---

## License

See [LICENSE](LICENSE).
