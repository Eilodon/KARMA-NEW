# Full MCP tool reference

This is the complete tool catalog for KARMA's MCP server. It's split out of `README.md` (which is
now written for the OKX.AI Genesis Hackathon specifically) so the full engineering surface stays
documented without dominating the pitch. If you're evaluating the OKX.AI submission, the tool that
matters is `get_cross_chain_trust_score` — covered in `README.md` directly. Everything below is
the rest of the server: the skill-economy core, Terminal3 identity, and the Casper Odra registry.

## KARMA skill economy (Layer 1) — `karma.tool.ts`, Pharos

| Tool | Kind | Purpose |
|---|---|---|
| `karma_health` | read | Runtime canary; RPC/contract env presence + skill-indexer health. |
| `register_skill` | write | Register a skill on-chain (name, price, endpoint, optional reputation Trust-Gate + `identityPolicy`) + BM25 upsert. |
| `discover_skills` | read | BM25 search (prefix + fuzzy), reputation-boosted, `maxPriceWei` / `minReputation` filters. |
| `create_job` | write | Idempotent escrow via `taskHash`; enforces the skill's identity + reputation gates (single path); `exists` on replay. Supports an optional third-party `evaluator` + `evaluatorFeeWei`. |
| `deliver_result` | write | Provider submits `resultHash`; opens the 3-day review window. |
| `complete_job` | write | Requester confirms; releases escrow + bumps reputation (arm's-length only — self-dealing earns no reputation). |
| `dispute_result` | write | Bond-backed: requester rejects within the window by locking a dispute bond (proportional to escrow). |
| `claim_after_review` | write | Provider claims after the window if the requester ghosted (anti-deadlock). |
| `evaluate_result` | write | Neutral evaluator approves (escrow → provider) or rejects (refund → requester). |
| `read_job` | read | Read one job's on-chain state by id; exposes `evaluator` and `evaluatorFee` fields. |
| `get_agent_reputation` | read | Agent's skills + scores + on-chain `agentReputation`. |
| `query_social_graph` | read | Job edges for an agent (as provider / requester). |
| `get_pending_balance` | read | Withdrawable balance in wei + formatted PHRS. |
| `withdraw_balance` | write | Pull released escrow to the agent's wallet. |

## Terminal3 identity & delegation (Layer 3) — `t3.tool.ts`

| Tool | Purpose |
|---|---|
| `t3_health` | Validate `T3N_NODE_URL` and load the WASM TEE component. |
| `t3_verify_identity` | Authenticate an agent (SIWE/EIP-191) → cache its `did:t3n:…`. |
| `t3_create_verified_job` | Dual-gate job: verified DID **and** on-chain reputation. |
| `t3_get_usage` | Read TEE token balance / consumption (`getUsage`). |
| `t3_get_audit_events` | Fetch the immutable TEE audit trail (`getAuditEvents`). |
| `t3_sign_job_commitment` | EIP-191 non-repudiation receipt for a job (`eip191Digest` + `compactDidFromBytes`). |
| `t3_authorize_payroll_agent` | Issue a TEE-signed, bounded, revocable delegation credential; attempt org-grant + payroll invocation. |
| `t3_revoke_payroll_authorization` | Revoke the credential entirely or narrow its function set. |

The SDK is exercised across ~23 distinct surfaces (WASM loader, `T3nClient` lifecycle, EIP-191
`GuestToHostHandler`, delegation-credential builders + custodial signer, org-data client, usage/audit
reads, standalone crypto primitives). Raw private keys never leave `KeystoreManager` — all signing
goes through viem `Account.signMessage` or the TEE-side custodial signer.

## Casper skill registry (Layer 1, Odra) — `casper.tool.ts`

The RWA-oracle flow ([DEMO_CASPER.md](../DEMO_CASPER.md)) exposed as MCP tools, not just standalone
scripts — any MCP client can drive Casper's Odra `AgentSkillRegistry` directly. Each write builds,
signs, and submits a real `casper-js-sdk` transaction (`src/lib/casper/live_client.ts`); reads query
the contract's on-chain "state" dictionary directly (`src/lib/casper/odra_storage_key.ts`). Requires
`CASPER_RPC_URL` + `KARMA_ODRA_REGISTRY` — `casper_health` reports whether they're set.

| Tool | Kind | Purpose |
|---|---|---|
| `casper_health` | read | Whether `CASPER_RPC_URL` + `KARMA_ODRA_REGISTRY` are configured. |
| `casper_register_skill` | write | Register a skill (name, price, `identityPolicy`) — real signed transaction. |
| `casper_deposit_bond` | write | Lock a Sybil-resistance capital bond. |
| `casper_create_job` | write | Create + escrow a job against a skill (payable, `amount` = price). |
| `casper_deliver_result` | write | Provider records a result hash, opens the review window. |
| `casper_confirm_completion` | write | Requester releases escrow + bumps reputation (arm's-length). |
| `casper_claim_after_review` | write | Anti-deadlock: provider claims escrow once the review window elapses with no confirm/dispute from the requester. |
| `casper_claim_refund` | write | Requester reclaims escrow (+ evaluator fee) for a job never delivered before the deadline. |
| `casper_withdraw` | write | Pull the caller's released-escrow balance (CEI pull-payment). |
| `casper_get_account_state` | read | Pending balance + reputation + bonded amount, read live from chain. |
| `casper_get_skill` | read | Read a skill's full on-chain record (owner, price, reputation, active, `isComposite`), live from chain. |
| `casper_get_job` | read | Read a job's full on-chain record (requester/provider, escrow, status, evaluator), live from chain. |
| `casper_discover_skills` | read | BM25 search over the Casper skill index (separate index from Pharos's), `maxPriceMotes`/`minReputation` filters. |
| `casper_register_composition` | write | Register a composite skill fanning escrow across 1-8 leaf skills by basis-points weight. |
| `casper_get_composition` | read | Read a skill's composition manifest (leaf ids + weights), or `isComposite=false` for a primitive. |
| `casper_create_job_with_evaluator` | write | Create a job with a neutral third-party evaluator instead of direct requester review. |
| `casper_evaluate_result` | write | The designated evaluator approves/rejects a delivered result; fee releases either way. |
| `casper_dispute_result` | write | Requester posts a bond to contest a delivered result within the review window. |
| `casper_respond_to_dispute` | write | Provider matches the bond to enter arbitration. |
| `casper_concede_dispute` | write | Provider concedes — forfeits both bonds + escrow to the requester. |
| `casper_resolve_default_concede` | write | Anyone may call once the provider's response window elapses unanswered. |
| `casper_arbitrate` | write | Arbiter-only: adjudicates a contested (both-sides-bonded) dispute — loser pays. |
| `casper_dispute_result_via_panel` | write | Like `casper_dispute_result`, but flags the job for N-of-M panel arbitration instead of the single arbiter — pays the dispute bond and the flat panel-vote fee in one transaction. Requires a panel to already be configured by governance. |
| `casper_cast_panel_vote` | write | Panel-member only — cast one vote on a panel-mode dispute; membership is checked against the panel as it stood when the dispute was posted, not against governance's current panel. Settles and pays every voter automatically once a strict majority agrees. |
| `casper_resolve_panel_default` | write | Anyone may call once the panel's voting window elapses without a majority — defaults to `ProviderAtFault` and still pays whichever arbiters did vote, so a non-participating panel can't deadlock a dispute forever. |
| `casper_get_cross_chain_rep` | read | Read an agent's cross-chain reputation attestation (0-100), live from chain. |
| `casper_get_governance_state` | read | Signers + threshold + timelock delay + arbiter + panel (members, vote threshold, per-vote fee), in one round trip, live from chain. |
| `casper_propose_set_cross_chain_rep` | write | Propose a cross-chain rep attestation (governance-signer; propose/approve/execute + timelock). |
| `casper_propose_set_arbiter` | write | Propose a new arbiter address — same governed lifecycle, no single-signer bypass. |
| `casper_propose_set_dispute_bond_bps` | write | Propose a new dispute-bond basis-points value — same governed lifecycle. |
| `casper_propose_set_arbiter_panel` | write | Propose a new N-of-M arbiter panel — odd size (3 to 9), threshold fixed at a strict majority (`panel.length / 2 + 1`), no duplicate members. Same governed lifecycle as every other propose_* tool. |
| `casper_propose_set_panel_arbiter_fee` | write | Propose the flat fee (in motes) paid to every panel member who votes on a panel-mode dispute, on top of the dispute bond. Same governed lifecycle. |
| `casper_approve_proposal` | write | Approve a pending governance proposal (governance-signer, once each). |
| `casper_execute_proposal` | write | Execute a proposal once threshold + timelock are satisfied (anyone may call). |
| `casper_cancel_proposal` | write | Cancel a pending (not yet executed) proposal (governance-signer only). |
| `casper_attest_rationale` | write | Requester commits a hash of their agent's decision rationale on-chain for a job. |
| `casper_get_rationale_hash` | read | Read back an attested rationale hash byte-for-byte, live from chain. |
| `casper_get_x402_settlement_status` | read | Check whether a submitted x402 settlement transaction confirmed or reverted. |
| `casper_deactivate_skill` | write | Skill owner deactivates one of their own skills; existing jobs/history are untouched, new jobs against it are rejected. |
| `casper_set_min_reputation` | write | Skill owner changes the minimum agent reputation required to invoke one of their own skills. |
| `casper_set_identity_policy` | write | Skill owner changes the identity-policy id required to invoke one of their own skills. |
| `casper_get_provider_jobs` | read | List every job id an agent has ever been the provider on, live from chain. |
| `casper_get_requester_jobs` | read | List every job id an agent has ever been the requester on, live from chain. |
| `casper_get_agent_skills` | read | List every skill id an agent owns, live from chain. |
| `casper_get_dispute_info` | read | Read a job's active dispute record (bond amounts + timestamp), live from chain. |
| `casper_get_proposal` | read | Read a governance proposal's full record (action, proposer, timestamp, executed/cancelled), live from chain. |

**Composability with the official Casper MCP Server:** every tool above is
`casper_snake_case` (`casper_health`, `casper_create_job`, ...).
[`msanlisavas/casper-mcp`](https://github.com/msanlisavas/casper-mcp) — the general-purpose Casper
chain-data server (87 tools, PascalCase: `GetAccountBalance`, `GetBlock`,
`BuildTransferTransaction`, wrapping CSPR.Cloud) — uses a completely different naming convention, so
the two register in the same MCP client with zero name collisions. Both run side by side with no
code changes on either side:

```json
{
  "mcpServers": {
    "karma":  { "command": "node", "args": ["/path/to/KARMA-Eilodon/dist/index.js"] },
    "casper": { "command": "casper-mcp", "args": ["--api-key", "YOUR_CSPR_CLOUD_API_KEY"] }
  }
}
```

## OKX.AI Trust Oracle (X Layer) — `trust_oracle.tool.ts`

Covered directly in `README.md` — this is the ASP built for the OKX.AI Genesis Hackathon.

| Tool | Kind | Purpose |
|---|---|---|
| `get_cross_chain_trust_score` | read | Given an `evm_address` (Pharos + X Layer share one secp256k1 key) and/or a `casper_account_hash`, reads on-chain reputation + job counts from every configured chain, averages what's available into `aggregateScore`, and reports a `note` (not a fabricated number) for any chain that's unconfigured or, for Stellar, intentionally ZK-gated. |

## Rationale Attestation (X Layer) — `rationale_attestation.tool.ts`

P2-A, ported from Casper's `casper_attest_rationale`/`casper_get_rationale_hash` (see the Casper
table above). Backed by `RationaleAttestation.sol`, a standalone sidecar deployed next to
`AgentSkillRegistry` — not a change to it, so the published, evidence-referenced registry address
never moves. It validates `jobId`/`requester` by reading the registry's existing public `jobs`
getter, which is why no function needed to be added to the live contract.

**Live on X Layer testnet:** [`0x402d0e…AAc108C1`](https://www.oklink.com/xlayer-test/address/0x402d0e956A3E2ba3936864Ba64201edBAAc108C1)
(deploy tx [`0x9097ec…f531e0`](https://www.oklink.com/xlayer-test/tx/0x9097ec2ae08a670281c67157979506653c391e14216568aedd104cf8b6f531e0)).
Verified with a real end-to-end round trip against job #1 on the live registry: `attest_rationale`
tx [`0x388c24…7dbdd8`](https://www.oklink.com/xlayer-test/tx/0x388c248a921e1f129c4f3afb798ddd8a58b9235801e6b15551fe3a02127dbdd8)
committed hash `0x325259…c65551aa`, and `get_rationale_hash` reads back that exact same hash.

| Tool | Kind | Purpose |
|---|---|---|
| `attest_rationale` | write | Requester commits a 32-byte hash of their agent's decision rationale on-chain for a job, once. Requester-only, set-once, independent of job lifecycle. |
| `get_rationale_hash` | read | Read back an attested rationale hash byte-for-byte, live from chain; `null` if never attested. |

## Composability with Onchain OS (`okx/onchainos-skills`)

Unlike the Casper composability case above, `okx/onchainos-skills` is **not** a second MCP server —
verified in-session by cloning the real repo, not assumed. It's a Claude Skill bundle (`SKILL.md`
routing files, installed for real at `.claude/skills/`, hash-pinned in `skills-lock.json`) that
teaches an agent when to shell out to a bundled Rust CLI (`onchainos`), gated behind an OKX
Agentic Wallet login before any command. There is no `onchainos` MCP server binary to add to an
`mcpServers` block the way `casper-mcp` is — so the same-shape JSON block the Casper section above
uses doesn't apply here; the honest equivalent is one agent session with both surfaces loaded at
once:

```json
{
  "mcpServers": {
    "karma": { "command": "node", "args": ["/path/to/KARMA-Eilodon/dist/index.js"] }
  }
}
```

...running in the same agent that also has `okx/onchainos-skills` installed
(`npx skills add okx/onchainos-skills --yes -a claude-code --skill '*'` — already done for this
repo, see `skills-lock.json`). The agent chains them with zero custom integration code: Onchain
OS's `okx-ai` skill routes `agent search`/`agent get-agents` (real CLI syntax, see
`.claude/skills/okx-ai/references/identity-discover.md`) to find a candidate ASP's `ownerAddress`,
then `get_cross_chain_trust_score` reads that address's cross-chain track record before the agent
decides whether to pay it — `src/scripts/demo_onchainos_composability.ts`
(`pnpm demo:onchainos <candidateEvmAddress>`) runs the live half of that pipeline end to end
(discovery is documented, not executed, since it needs the operator's own OKX wallet credentials —
see that script's header for why faking it would misrepresent the integration).
