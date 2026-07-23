# KARMA — OKX.AI Genesis Hackathon Demo Script (X post, #OKXAI)

**Hard limit: 90 seconds.** OKX's submission rule (okx.ai/tutorial/asp step 3) — the X post is
timed, not a suggestion. Cut ruthlessly; the golden rule below still applies.

**Format:** live terminal capture (real output, real addresses) + voiceover + burned-in captions.
Vertical or square crop plays better in an X feed than the widescreen T3ADK cut
(`docs/demo-video-script.md`) — record at 1080×1350 or 1080×1080 if your capture tool supports it,
1920×1080 letterboxed is an acceptable fallback.

**Golden rule (same as every KARMA demo):** everything on screen is real and reproducible. No
mocked output, no faked success. If X Layer isn't broadcast yet at record time, say so on screen —
see **Appendix C** for the exact honest framing to use either way.

---

## One-line pitch (cold open + X post caption)

> **Before your agent pays another agent on OKX.AI, ask KARMA if it kept its word last time —
> real on-chain reputation across four chains, not a self-reported number.**

X post caption (under 280 chars, include the demo link + tag):
> Built a Trust Oracle ASP for @okx.ai's agent marketplace: one call aggregates an agent's real
> on-chain reputation + dispute history across Pharos, X Layer, Casper (Stellar too, ZK-gated by
> design). #OKXAI [demo video] [github link]

---

## Scene-by-scene (target cuts, ~90s total)

### COLD OPEN — the gap (0:00–0:10)

- **ON SCREEN:** black → one line of text.
- **VOICEOVER:** "OKX.AI lets agents pay each other and arbitrate disputes. But arbitration needs
  a track record to arbitrate against. Before the job starts — how do you know?"
- **CAPTION:** `OKX.AI has escrow + arbitration. It doesn't have reputation. KARMA does.`
- **WOW BEAT:** the gap lands in one breath.

---

### SCENE 1 — the ASP, live on the marketplace (0:10–0:20)

- **ON SCREEN:** okx.ai marketplace listing for the KARMA Trust Oracle (once registered — see
  Appendix C if not live yet at record time).
- **VOICEOVER:** "This is KARMA's Trust Oracle — registered as an A2MCP Agent Service Provider,
  priced per call in x402 on X Layer."
- **CAPTION:** `A2MCP ASP · x402 on X Layer · get_cross_chain_trust_score`

---

### SCENE 2 — FLAGSHIP: one call, four chains (0:20–0:55)

- **ON SCREEN:** terminal. Call `get_cross_chain_trust_score` with a real `evm_address` (and a
  `casper_account_hash` if you have one bonded). Let the JSON scroll, then hold on the
  `aggregateScore` + `chains` array.
- **VOICEOVER:** "One call reads an agent's real reputation and job history from Pharos, from X
  Layer, from Casper — and reports it honestly when a chain isn't configured, or when Stellar's
  reputation is intentionally zero-knowledge-gated instead of public. This isn't a self-reported
  score. It's read straight from each chain's own contract state."
- **CAPTION:** `get_cross_chain_trust_score → real reads, 4 chains, evidence not opinion`
- **WOW BEAT:** the `aggregateScore` number appears next to the per-chain evidence array — freeze
  1.5s. This is the 90-second version's centerpiece.

---

### SCENE 3 — it's not new, it's proven (0:55–1:15)

- **ON SCREEN:** fast-cut: `contracts/AgentSkillRegistry.sol` test output (`96 passed`), then the
  Casper Testnet explorer (real tx), then — if broadcast by record time — the X Layer testnet
  explorer for the same contract.
- **VOICEOVER:** "The reputation kernel underneath isn't new for this hackathon — it's already
  live on Casper and Stellar, real transactions, real disputes, real arbitration. X Layer is the
  fourth chain the same contract runs on, not a rewrite."
- **CAPTION:** `Same contract. Same tests. Casper + Stellar live today, X Layer the 4th adapter.`

---

### CLOSE (1:15–1:30)

- **ON SCREEN:** one-line pitch + GitHub URL + `#OKXAI`.
- **VOICEOVER:** "KARMA: the trust layer OKX.AI's agent economy is missing. Built on a protocol
  that already runs on three other chains."
- **CAPTION:** `github.com/Eilodon/KARMA-New · #OKXAI`

---

## Appendix A — Capture commands (exact, reproducible)

**The flagship call (Scene 2) — works today, offline-safe fallback included:**
```bash
# Direct tool call via any MCP client connected to this server, e.g.:
#   get_cross_chain_trust_score({ evm_address: "0x..." })
# Or drive it from a small script/REPL importing trustOracleTools directly for the capture —
# see src/__tests__/trust_oracle_tool.test.ts for the exact call shape.
pnpm dev   # start the MCP server, then call the tool from your MCP client of choice
```

**Proof shots:**
```bash
pnpm test:contract   # Foundry — 96/96 AgentSkillRegistry tests (same contract Pharos + X Layer run)
pnpm test            # Vitest — 907/912 passed, 5 skipped (incl. 23 new X Layer/oracle tests)
```

**X Layer explorer cutaway (once deployed):** `https://www.oklink.com/xlayer-test/address/<XLAYER_CONTRACT_ADDRESS>`

**Casper explorer cutaway (already live):** `https://testnet.cspr.live/contract-package/42f6945fe9ac5ab493beed468465228ecb830036e27bb2c8cac9e1736a2b5a1d`

---

## Appendix B — If the OKX.AI marketplace listing isn't approved yet at record time

OKX's review can take up to 24h (okx.ai/tutorial/asp). If Scene 1's live listing isn't there yet:
cut Scene 1 to the registration *prompt* instead (`Help me register an A2MCP ASP on OKX.AI using
OKX Agent Identity from Onchain OS`) and caption it `submitted for review` — do not screenshot or
fake an approved listing. Per the hackathon's own rule, an ASP that hasn't passed review yet is
still findable by Agent ID, so show that ID on screen instead.

---

## Appendix C — Honesty guardrails (read before recording)

Same discipline as every other KARMA demo script — judges (and this project's own track record)
punish overclaiming more than they punish an honest gap:

1. **If X Layer isn't broadcast yet:** do NOT show a fake explorer page or a fabricated contract
   address. Say it plainly on screen: `X Layer: chain adapter built, testnet broadcast pending —
   see script/deploy_xlayer.sh`. Lead Scene 3 with Casper/Stellar (both real today) instead, and
   frame X Layer as "the adapter that already works against Pharos's identical contract" — true,
   verifiable, and still a strong claim.
2. **If a chain isn't configured in the environment you're recording in:** let
   `get_cross_chain_trust_score` show its real `note` field (e.g. `"XLAYER_CONTRACT_ADDRESS not
   configured"`) on screen instead of cutting away from it. The graceful-degradation behavior IS
   the honesty story — it's covered by its own test
   (`src/__tests__/trust_oracle_tool.test.ts`, "degrades gracefully when no chain is configured").
3. Keep real addresses/tx hashes on screen (testnet only, no real-value secrets exposed) —
   authenticity is the point, same as every KARMA demo before this one.
4. Numbers to state, all current and verifiable at time of writing: **96/96 Foundry tests**
   (`AgentSkillRegistry.sol`, shared by Pharos + X Layer), **907/912 Vitest** (5 pre-existing
   skips, unrelated to this pivot), **4 chains** in the reputation kernel (Casper + Stellar live,
   Pharos live, X Layer adapter built).
