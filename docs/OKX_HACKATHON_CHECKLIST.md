# OKX.AI Genesis Hackathon — what's left, and who does it

Deadline: **27 July 2026, 23:59 UTC**. Everything below needs credentials, an email login, a
funded wallet, or an X/Google account this session doesn't have — so it's explicitly out of scope
for the agent and needs a human.

**Strategy in one line: free tier, testnet-only, zero real money at risk, submit early.** No step
below touches mainnet value or requires staking. That's a deliberate choice, not a limitation —
see §7.

**Read this first — the eligibility rule that changes the timeline:** per the official rules
(`web3.okx.com/xlayer/build-x-series`), *"Your ASP must pass OKX AI's internal review and go live
to remain eligible. If the ASP listing is not approved or cannot go live, your hackathon submission
will be deemed invalid."* Approval isn't optional, and OKX reviews "in parallel" during the whole
window — so **§3 (register the ASP) needs to happen days before the deadline, not on 27/7**, to
leave room for a resubmission if the first review doesn't pass. Everything below is ordered so §3
can start as early as possible.

## 1. Deploy `AgentSkillRegistry` to X Layer **testnet** (free — faucet OKB only)

- [ ] Install Foundry locally if you don't have it (`curl -L https://foundry.paradigm.xyz | bash
      && foundryup`) — this could not be installed inside the session that built this pivot
      (GitHub release-API egress was policy-blocked there).
- [ ] Generate a deployer key: `cast wallet new` (or reuse an existing burner key you control —
      testnet-only, holds no real value either way).
- [ ] Fund it with **testnet** OKB (free) from X Layer's faucet:
      `web3.okx.com/xlayer/docs/developer/bridge/get-testnet-okb-from-faucet`.
- [ ] Deploy: `PRIVATE_KEY=0x... ./script/deploy_xlayer.sh testnet`
- [ ] Copy the printed address into `.env` as `XLAYER_CONTRACT_ADDRESS`.

This step is optional for the ASP listing itself (the free A2MCP tier in §3 doesn't require it) —
it's what makes the "4 chains, not 3" evidence in the README true instead of aspirational. Worth
doing, but doesn't block §2/§3 if you're short on time.

## 2. OKX Developer Portal API keys + Onchain OS + Agentic Wallet (free, no KYC)

Confirmed during research for this pivot: identity actions (create/update/activate/deactivate)
**cost nothing — OKX covers network fees** — and no OKX account or KYC is required to get started.

- [ ] Get `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` from the OKX Developer Portal.
- [ ] In your agent CLI (Claude Code, Codex, etc. — whatever you're running KARMA's dev loop in),
      run: `npx skills add okx/onchainos-skills --yes -g`
- [ ] Log into the Agentic Wallet with your email, inside that same agent session (no seed phrase,
      no deposit — it's TEE-custodied and free to create).

## 3. Register the ASP as FREE — do this early, not last-minute

Per `okx.ai/tutorial/asp`, registration happens by prompting your agent directly — the agent
guides the rest. **Register the free-endpoint form, not the x402 paid form** — it removes every
payment/settlement question (no facilitator, no OKX Payment SDK wiring, no token address to get
right) while still shipping the exact same tool. It's also just a better hackathon demo: a judge
or reviewer can call it with zero setup on their end. The paid x402 code
(`src/plugins/x402_xlayer.ts`, `@x402/evm`) is already built and tested — it's evidence of
monetization depth in the repo, it just isn't what's switched on for the live listing.

Point your agent at this KARMA server (run `pnpm dev` first so the MCP endpoint is live) and its
`get_cross_chain_trust_score` tool:

- [ ] `Help me register an A2MCP ASP on OKX.AI using OKX Agent Identity from Onchain OS` — describe
      it as: KARMA Cross-Chain Trust Oracle, **free**, endpoint = this server's
      `get_cross_chain_trust_score` MCP tool.
- [ ] `Help me list my ASP on OKX.AI using Onchain OS`
- [ ] **This is the step that gates the whole submission.** OKX review can take time — start this
      several days before 27/7, watch for the approval notice, and if it's rejected, fix and
      resubmit immediately rather than waiting. An ASP that "hasn't been reviewed yet" is fine to
      keep working on internally, but per the official rule above, it is **not** a valid hackathon
      submission until it's approved and live.

## 4. Record the ≤90s demo and post to X

- [ ] Follow `docs/demo-video-script-okx.md` — free-tier framing, one clear call, no payment step
      to explain on screen.
- [ ] Post on X with **#OKXAI**, demo ≤90 seconds, link to the repo.

## 5. Submit the Google Form before the deadline

- [ ] `forms.gle/mddEUagmDbyV37ws8` — ASP details + your X post link. Confirm the deadline is
      still 27/7 23:59 UTC on the official page before you submit (it moved once already, from an
      earlier 17/7 announcement). Only submit once §3's approval has actually landed.

## 6. Apply to Find Super Nova (verified real, independent of Genesis results, no stake)

Verified directly at `web3.okx.com/xlayer/build-x-series/supernova`: "Got an early-stage project?
Apply anytime." Five support pillars: ecosystem access, distribution priority into OKX
Wallet/DEX/Marketplace, 1:1 mentorship with the X Layer team, VC funding-pipeline access, media
amplification. Review turnaround ~1-2 weeks, milestone-based support after that. No stake, no
deposit — an application, not a financial commitment.

- [ ] Apply at `web3.okx.com/xlayer/build-x-series/supernova` — do this regardless of the Genesis
      outcome, it's explicitly not gated on hackathon results.

## 7. Deliberately not pursued: the Evaluator role

OKX.AI has a third role beyond Users/ASP — **Evaluator** (dispute arbitrator): ≥5 evaluators per
case, majority vote, weighted-random selection by **stake (≥100 OKB — real capital)**, 24/7 uptime
required, wrong/timed-out votes slashed. Their docs do explicitly invite custom logic ("write your
own [Evaluator Skill] to judge sharper"), and `get_cross_chain_trust_score` would be a genuinely
useful voting signal for one. **Not pursued for this submission on purpose** — it requires staking
real OKB, which is out of scope for a reproducible, zero-financial-risk hackathon entry. If you
want to pursue it later, independent of the hackathon deadline, it's a real opportunity — just not
one to rush into under time pressure with real capital.

## 8. Optional, and skippable: seed real usage

Only matters for the traction-based categories (Revenue Rocket, Social Buzz) — skip entirely if
targeting Software Utility/Finance Copilot. Requires reaching out to other people, which this
session won't do on your behalf, and doesn't require any payment either way since the ASP is free:
- [ ] Consider inviting 1-2 other Genesis builders to try the Trust Oracle for real, so any
      traction numbers in the submission are real usage, not self-generated calls.

## 9. Optional, later: enable the paid x402 tier

Not needed for Genesis — do this only if/when you want the ASP to actually charge per call.
- [ ] Get the real settlement-asset (USDT or USDG, confirmed — **not** USDC) contract address on
      X Layer from `github.com/okx/xlayer-tokenlist`.
- [ ] Set `XLAYER_SETTLEMENT_ASSET_TESTNET_ADDRESS` (and `_ADDRESS` for mainnet, later) in `.env`.
- [ ] Set `KARMA_X402_XLAYER_FACILITATOR_URL` once you have a real facilitator endpoint (OKX
      Payment SDK recommended).

---

## What's already done (no action needed)

Built, typechecked (`pnpm typecheck` clean), linted (`pnpm lint` clean), and tested
(`pnpm test` → 907/912 passed, 5 pre-existing skips unrelated to this pivot):

- `src/lib/xlayer.ts` — X Layer viem chain adapter (testnet 1952 / mainnet 196)
- `src/plugins/x402_xlayer.ts` — `IPaymentPlugin` implementation (`x402-xlayer`, `@x402/evm`),
  asset-agnostic (USDT/USDG, not hardcoded to USDC) — built and tested, not switched on for Genesis
- `src/plugins/trust_oracle.tool.ts` — `get_cross_chain_trust_score`, the ASP's actual product,
  registered free
- `script/deploy_xlayer.sh` — testnet deploy wrapper (needs `forge` + faucet-funded key, see §1)
- `README.md` — rewritten fully around the OKX.AI fit
- `docs/demo-video-script-okx.md` — the ≤90s demo script, free-tier framing
- `.env.example` — every new env var documented, including the ones you still need to fill in
