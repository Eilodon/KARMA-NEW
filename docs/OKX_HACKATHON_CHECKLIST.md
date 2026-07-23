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

## 7. Optional, parallel, not gated on Genesis results

- [ ] **X Layer's early-stage team accelerator** — real (per X Layer's own materials: "turning
      early ideas into real products... handpicking high-potential teams"), but flag before you
      spend time on it: a plain web search for **"Find Super Nova"** mostly surfaces **OKX
      Supernova**, which is OKX's graduate/career recruitment program, not startup funding — a
      different thing wearing a similar name. I could not independently verify a "Find Super
      Nova" application URL distinct from that. Check `web3.okx.com/xlayer` directly for the
      accelerator's real application path before assuming the name/link from earlier research is
      accurate.

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
