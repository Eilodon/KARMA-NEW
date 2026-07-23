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

**Status: prepared and dry-run verified in a later session — the only remaining step is
funding.** An earlier session couldn't install Foundry (GitHub release-API egress was
policy-blocked there); that's not universal — a later session had `forge`/`cast` available
already, generated a deployer key, and ran a full simulation against the live testnet RPC:

```
$ PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url https://testrpc.xlayer.tech --chain-id 1952
Script ran successfully.
AgentSkillRegistry deployed at: 0xBF285628869c2EFaf6731F8503B39B7130474Cd2   (simulated address)
Estimated amount required: 0.000185185804629645 ETH
SIMULATION COMPLETE. To broadcast these transactions, add --broadcast ...
```

So: compiles, deploys-in-simulation, gas estimate is trivial (~0.0002 OKB). What's left is not a
tooling gap, it's the one thing an agent genuinely can't do — pass a faucet's human/captcha check:

- [ ] **You fund this address** with a small amount of **testnet** OKB (the simulation above
      needed ~0.0002 OKB; fund at least 0.01 for headroom) from X Layer's faucet:
      `web3.okx.com/xlayer/docs/developer/bridge/get-testnet-okb-from-faucet` →
      `0xc3BbCd6FCce48E04edb5985FE869203768bbCccd` (fresh burner key, generated via
      `cast wallet new` in-session, holds no other value, private key is in the untracked local
      `.env` — never committed).
- [ ] Tell the agent it's funded — it runs `PRIVATE_KEY=0x... ./script/deploy_xlayer.sh testnet`
      itself (same command as above, plus `--broadcast`) and reports back the deployed address.
- [ ] Agent copies the printed address into `.env` as `XLAYER_CONTRACT_ADDRESS`.

If you'd rather use your own key instead of the generated burner: `cast wallet new` (or reuse one
you control), fund it, then hand the agent `PRIVATE_KEY=0x...` directly.

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

## 7. Deliberately not pursued: registering/staking as an Evaluator (reference code now exists)

OKX.AI has a third role beyond Users/ASP — **Evaluator** (dispute arbitrator): ≥5 evaluators per
case, majority vote, weighted-random selection by **stake (≥100 OKB — real capital)**, 24/7 uptime
required, wrong/timed-out votes slashed. Their docs do explicitly invite custom logic ("write your
own [Evaluator Skill] to judge sharper"), and `get_cross_chain_trust_score` would be a genuinely
useful voting signal for one. **Registering/staking is still not pursued for this submission on
purpose** — it requires real OKB, out of scope for a reproducible, zero-financial-risk hackathon
entry. That part of the decision is unchanged and isn't a tooling limitation.

What *is* new: the "sharper judgment" signal itself, as an unregistered reference implementation —
[`src/scripts/evaluator_skill_reference.ts`](../src/scripts/evaluator_skill_reference.ts)
(`pnpm demo:evaluator-skill-reference <requesterEvmAddress> <providerEvmAddress>`). It calls
`get_cross_chain_trust_score` for both parties in a hypothetical dispute and prints a job-count-
weighted comparison (addressing the equal-weighting gap in the README self-audit, for this
illustration only — the shipped tool's `aggregateScore` is unchanged). It doesn't vote, submit, or
touch any OKX.AI contract, and registering/staking to actually use it is still the human decision
above. If you want to pursue registration later, independent of the hackathon deadline, it's a
real opportunity — just not one to rush into under time pressure with real capital.

## 8. Optional, and skippable: seed real usage

Only matters for the traction-based categories (Revenue Rocket, Social Buzz) — skip entirely if
targeting Software Utility/Finance Copilot. Requires reaching out to other people, which this
session won't do on your behalf, and doesn't require any payment either way since the ASP is free:
- [ ] Consider inviting 1-2 other Genesis builders to try the Trust Oracle for real, so any
      traction numbers in the submission are real usage, not self-generated calls.

## 9. Optional, later: enable the paid x402 tier

Not needed for Genesis — do this only if/when you want the ASP to actually charge per call. The
*code* side needs zero changes to turn on — `src/lib/payment/boot.ts` already registers
`XLayerX402Plugin` the moment `KARMA_X402_XLAYER_FACILITATOR_URL` is set, and
`x402_xlayer.ts:defaultAssetForNetwork` already reads `XLAYER_SETTLEMENT_ASSET_TESTNET_ADDRESS` /
`_ADDRESS` — this was checked in-session, both are pure env-var toggles. What's blocking is two
real-world values, and unlike §1's funding step, these aren't things an agent should guess at:
- [ ] Get the real settlement-asset (USDT or USDG, confirmed — **not** USDC) contract address on
      X Layer **testnet** from `github.com/okx/xlayer-tokenlist`. Checked in-session: that repo's
      current release only lists **mainnet** (chainId 196) addresses (`xlayer.tokenlist.json`) —
      no testnet list was found. Guessing a testnet address here is worse than leaving it unset:
      the plugin deliberately throws instead of silently misdirecting a payment
      (`x402_xlayer.ts`'s own comment explains why), so an agent should not fabricate one. Confirm
      the real testnet address directly with OKX (or from a testnet-specific source, if one
      surfaces) before setting `XLAYER_SETTLEMENT_ASSET_TESTNET_ADDRESS`.
- [ ] Set `KARMA_X402_XLAYER_FACILITATOR_URL` once you have a real facilitator endpoint (OKX
      Payment SDK recommended) — this needs an OKX Payment SDK account/credentials, the same kind
      of human/credential step as §2's API keys.
- [ ] Once both are set, restart the server — no code change needed, `boot.ts` picks them up from
      `.env` automatically alongside the free tier (they aren't mutually exclusive: the free
      listing in §3 and a paid x402-tier listing can coexist, since `get_cross_chain_trust_score`
      is the same tool either way).

---

## What's already done (no action needed)

Built, typechecked (`pnpm typecheck` clean), linted (`pnpm lint` clean), and tested
(`pnpm test` → 912/912 passed):

- `src/lib/xlayer.ts` — X Layer viem chain adapter (testnet 1952 / mainnet 196)
- `src/plugins/x402_xlayer.ts` — `IPaymentPlugin` implementation (`x402-xlayer`, `@x402/evm`),
  asset-agnostic (USDT/USDG, not hardcoded to USDC) — built and tested, not switched on for Genesis
- `src/plugins/trust_oracle.tool.ts` — `get_cross_chain_trust_score`, the ASP's actual product,
  registered free
- `script/deploy_xlayer.sh` — testnet deploy wrapper; **dry-run verified against the live testnet
  RPC in-session** (`forge` was available, no install needed) — needs only a faucet-funded key,
  see §1
- `src/scripts/evaluator_skill_reference.ts` — unregistered, unstaked reference implementation of
  an OKX.AI Evaluator signal built on `get_cross_chain_trust_score`, see §7
- `README.md` — rewritten fully around the OKX.AI fit
- `docs/demo-video-script-okx.md` — the ≤90s demo script, free-tier framing
- `.env.example` — every new env var documented, including the ones you still need to fill in
