# OKX.AI Genesis Hackathon — what's left, and who does it

Deadline: **27 July 2026, 23:59 UTC**. Everything below needs credentials, an email login, a
funded wallet, or an X/Google account this session doesn't have — so it's explicitly out of scope
for the agent and needs a human. Ordered by dependency, not importance; steps 1–3 block everything
after them.

## 1. Get X Layer testnet OKB and deploy `AgentSkillRegistry`

- [ ] Install Foundry locally if you don't have it (`curl -L https://foundry.paradigm.xyz | bash
      && foundryup`) — this could not be installed inside the session that built this pivot
      (GitHub release-API egress was policy-blocked there).
- [ ] Generate a deployer key: `cast wallet new` (or reuse an existing burner key you control).
- [ ] Fund it with testnet OKB: X Layer's faucet, linked from
      `web3.okx.com/xlayer/docs/developer/bridge/get-testnet-okb-from-faucet`.
- [ ] Deploy: `PRIVATE_KEY=0x... ./script/deploy_xlayer.sh testnet`
- [ ] Copy the printed address into `.env` as `XLAYER_CONTRACT_ADDRESS`.

## 2. Find the real X Layer USDC address and set it

`src/plugins/x402_xlayer.ts` deliberately refuses to guess a token contract address (a wrong
guess would misdirect a real payment). Before the x402 plugin can quote a price:
- [ ] Get the real USDC (not USDC.e) contract address on X Layer testnet from
      `github.com/okx/xlayer-tokenlist` or `web3.okx.com/xlayer/docs/developer/bridge/usdc-on-x-layer`.
- [ ] Set `XLAYER_USDC_TESTNET_ADDRESS` (and `XLAYER_USDC_ADDRESS` for mainnet, later) in `.env`.

## 3. OKX Developer Portal API keys + Onchain OS

- [ ] Get `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` from the OKX Developer Portal.
- [ ] In your agent CLI (Claude Code, Codex, etc. — whatever you're running KARMA's dev loop in),
      run: `npx skills add okx/onchainos-skills --yes -g`
- [ ] Log into the Agentic Wallet with your email, inside that same agent session (no seed phrase
      needed — it's TEE-custodied).

## 4. Register the ASP (this is a conversational flow, not a form)

Per `okx.ai/tutorial/asp`, registration happens by prompting your agent directly — the agent
guides the rest. Point it at this KARMA server (run `pnpm dev` first so the MCP endpoint is live)
and its `get_cross_chain_trust_score` tool:

- [ ] `Help me register an A2MCP ASP on OKX.AI using OKX Agent Identity from Onchain OS`
      — describe it as: KARMA Cross-Chain Trust Oracle, paid per call in x402 on X Layer, endpoint
      = this server's `get_cross_chain_trust_score` MCP tool.
- [ ] `Help me list my ASP on OKX.AI using Onchain OS`
- [ ] OKX review takes up to 24h — you'll be notified by email/agent. **If it hasn't been
      reviewed yet or review fails, your ASP is still usable/findable by its Agent ID** — note
      that ID down, you'll want it for the demo and the submission form either way.

## 5. Record the ≤90s demo and post to X

- [ ] Follow `docs/demo-video-script-okx.md` — it has the exact scenes, capture commands, and (if
      X Layer/OKX review isn't done yet when you record) the honest fallback framing to use
      instead of faking a live listing.
- [ ] Post on X with **#OKXAI**, demo ≤90 seconds, link to the repo.

## 6. Submit the Google Form before the deadline

- [ ] `forms.gle/mddEUagmDbyV37ws8` — ASP details + your X post link. Confirm the deadline is
      still 27/7 23:59 UTC on the official page before you submit (it moved once already, from an
      earlier 17/7 announcement).

## 7. Register as an Evaluator too (bonus mũi — OKX explicitly invites this)

Confirmed straight from `okx.ai/tutorial`: OKX.AI has a third role beyond Users/ASP — **Evaluator**
(dispute arbitrator). Each arbitration is decided by ≥5 evaluators, majority vote, weighted-random
selection by stake (≥100 OKB), 24/7 uptime required, wrong/timed-out votes get slashed, the
majority splits 5% of the bounty plus the slashed stakes. Critically, their own docs say: **"Default
Evaluator Skills ship in the box; write your own to judge sharper."** — that's a direct invitation,
not a stretch.

- [ ] Register as an Evaluator (stake ≥100 OKB — real capital at risk, decide deliberately) via
      the same conversational flow: ask your agent something like
      `Help me register as an Evaluator on OKX.AI using Onchain OS`, and let it reveal the actual
      custom-Evaluator-Skill plugin schema (not publicly documented as of this pivot — this is the
      one piece that genuinely needs the live flow to confirm, same as ASP registration did).
- [ ] Once you see that schema: wire `get_cross_chain_trust_score` in as one input signal to your
      custom Evaluator Skill's vote — e.g. weight toward the delivered-result claim when the
      provider has a clean multi-chain track record, flag for closer manual review when it
      doesn't. This reuses the Trust Oracle already built; it does not need new judgment-algorithm
      code, and it's honest about what KARMA has today (evidence-gathering, not an automated
      verdict).

## 8. Apply to Find Super Nova (verified real, independent of Genesis results)

Verified directly at `web3.okx.com/xlayer/build-x-series/supernova` (a correction to the previous
version of this checklist, which wrongly cast doubt on this — a generic web search surfaced OKX's
unrelated graduate-recruitment "Supernova" program instead of finding this page): "Got an
early-stage project? Apply anytime." Five support pillars: ecosystem access, distribution priority
into OKX Wallet/DEX/Marketplace, 1:1 mentorship with the X Layer team, VC funding-pipeline access,
media amplification. Review turnaround ~1-2 weeks, milestone-based support after that.

- [ ] Apply at `web3.okx.com/xlayer/build-x-series/supernova` — do this regardless of the Genesis
      outcome, it's explicitly not gated on hackathon results.

## 9. Seed real usage (needed for Revenue Rocket / Social Buzz, not needed for Software Utility)

This is optional and only matters if you want to also compete in the traction-based categories —
skip it if you're targeting Software Utility/Finance Copilot alone. It requires reaching out to
other people, which this session won't do on your behalf:
- [ ] Consider inviting 1-2 other Genesis builders (the analysis that prompted this checklist
      specifically suggested VETO's author — a complementary, not competing, ASP) to try the Trust
      Oracle for real, so any revenue/traction numbers in the submission are real usage, not
      self-generated calls.

---

## What's already done (no action needed)

Built, typechecked (`pnpm typecheck` clean), linted (`pnpm lint` clean), and tested
(`pnpm test` → 907/912 passed, 5 pre-existing skips unrelated to this pivot):

- `src/lib/xlayer.ts` — X Layer viem chain adapter (testnet 1952 / mainnet 196)
- `src/plugins/x402_xlayer.ts` — `IPaymentPlugin` implementation (`x402-xlayer`, `@x402/evm`)
- `src/plugins/trust_oracle.tool.ts` — `get_cross_chain_trust_score`, the ASP's actual product
- `script/deploy_xlayer.sh` — deploy wrapper (needs `forge` + funded key, see §1 above)
- `README.md` — repositioned lead section, OKX.AI fit table, updated tool/chain tables
- `docs/demo-video-script-okx.md` — the ≤90s demo script
- `.env.example` — every new env var documented, including the ones you still need to fill in
