/**
 * KARMA × Casper — RWA-oracle end-to-end demo (T13).
 *
 * Walks the FULL job lifecycle the live demo will reproduce on Casper Testnet:
 *   1. Provider registers `rwa_price_oracle` on the Odra `AgentSkillRegistry`
 *   2. Provider deposits a Tier-2 Sybil bond (PD-007)
 *   3. Requester discovers the skill via KARMA MCP
 *   4. Requester invokes via x402 — CasperX402Plugin (T11) builds + signs the payment envelope
 *   5. Provider fetches a (mock) RWA feed, signs it with their Casper key
 *   6. Provider records the result hash on-chain via `deliver_result`
 *   7. Requester verifies the signed feed and confirms the job
 *   8. Provider withdraws CSPR — escrow + reputation settle
 *
 * This script is OFFLINE — it runs a state-machine model of the Odra contract while delegating
 * the cryptographic + plugin paths to REAL T10/T11 code. The chain-side rows in each box are
 * the deploys a live run would emit (entry-point + session args). Live reproduction is
 * documented in `DEMO_CASPER.md`.
 *
 *   pnpm exec tsx src/scripts/demo_casper_e2e.ts
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { Buffer } from "node:buffer";
import { CasperX402Plugin, compactToDER } from "../plugins/x402_casper.js";
import {
  deriveCasperPrivateKey,
  casperAccountHash,
  casperPublicKeyHex,
} from "../lib/casper/keypair.js";
import { OdraRegistry } from "../lib/casper/odra_registry.js";

// ── Pretty-printing ──────────────────────────────────────────────────────────────────────
function box(label: string, lines: string[]): void {
  const width = Math.max(label.length, ...lines.map((l) => l.length)) + 2;
  console.log("\n┌" + "─".repeat(width) + "┐");
  console.log("│ " + label.padEnd(width - 1) + "│");
  console.log("├" + "─".repeat(width) + "┤");
  for (const l of lines) console.log("│ " + l.padEnd(width - 1) + "│");
  console.log("└" + "─".repeat(width) + "┘");
}
function short(s: string, head = 14): string {
  return s.length > head + 6 ? `${s.slice(0, head)}...${s.slice(-6)}` : s;
}

// ── Demo ─────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("=".repeat(80));
  console.log("KARMA × Casper — RWA-oracle end-to-end demo (T13)");
  console.log("=".repeat(80));

  // Two deterministic agent keys (would come from the real keystore via T10 in production).
  const providerKp = deriveCasperPrivateKey(new Uint8Array(32).fill(0x11));
  const requesterKp = deriveCasperPrivateKey(new Uint8Array(32).fill(0x22));
  const provider = casperAccountHash(providerKp);
  const requester = casperAccountHash(requesterKp);
  const odra = new OdraRegistry();

  // ── Step 1 — provider registers `rwa_price_oracle` ──
  const PRICE = 10_000_000n; // 0.01 CSPR in motes
  const skillId = odra.register_skill(provider, {
    name: "rwa_price_oracle",
    price: PRICE,
    identityPolicy: 0,
  });
  const registeredSkill = odra.get_skill(skillId);
  box("Step 1 — register_skill (Odra deploy)", [
    "entry_point        = register_skill",
    `owner              = ${short(provider)}`,
    "name               = rwa_price_oracle",
    "price_per_call     = 10000000 motes (0.01 CSPR)",
    `skill_id (assigned)= ${skillId}`,
    `starting reputation= ${registeredSkill.rep}/100`,
  ]);

  // ── Step 2 — provider deposits a Tier-2 Sybil bond (PD-007) ──
  const BOND = 1_000_000_000n; // 1 CSPR
  odra.deposit_bond(provider, BOND);
  box("Step 2 — deposit_bond (Odra deploy, payable 1 CSPR)", [
    "entry_point        = deposit_bond",
    "attached_value     = 1000000000 motes (1 CSPR)",
    `bonded_amount      = ${odra.bonded_of(provider)} motes`,
    "seed_eligible      = same (active bond seeds flow_reputation)",
  ]);

  // ── Step 3 — requester discovers via KARMA MCP ──
  box("Step 3 — KARMA MCP discover_skills", [
    'query                = "real world asset price oracle"',
    `hit                  = skill ${skillId} (rep ${odra.get_skill(skillId).rep}/100)`,
    "payment_options[0]   = { rail: x402, network: casper:mainnet, asset: CSPR }",
    "payment_options[1]   = { rail: escrow, network: casper:mainnet, asset: CSPR }",
  ]);

  // ── Step 4 — requester invokes via x402 (REAL T11 plugin) ──
  const plugin = new CasperX402Plugin(
    "https://x402-facilitator.casper.network",
    () => requesterKp,
  );
  const receipt = await plugin.pay(
    {
      skillId: String(skillId),
      price: "0.01",
      asset: "",
      payTo: provider,
      network: "casper:mainnet",
    },
    { agentId: "agent-requester" },
  );
  if (!(await plugin.verify(receipt))) throw new Error("plugin verify rejected its own receipt");
  // Bind the x402 payload to a deterministic task hash, as create_job would on-chain.
  const taskParams = { feed: "BTC/USD", req_ts: 1_700_000_000_000 };
  const taskHash = createHash("sha256")
    .update(JSON.stringify({ requester, skillId, params: taskParams }))
    .digest("hex");
  const jobId = odra.create_job(skillId, requester, taskHash, PRICE);
  box("Step 4 — create_job(settlement_rail: x402) — T11 plugin signs the envelope", [
    "entry_point          = create_job (Odra), payable 0.01 CSPR escrow",
    `task_hash            = ${short(taskHash)}`,
    `job_id (assigned)    = ${jobId}`,
    `x402 payer           = ${short(receipt.payer)}`,
    `x402 payee           = ${short(receipt.payee)}`,
    `x402 amount          = ${receipt.amount} motes`,
    `x402 signature (hex) = ${short(receipt.signature ?? "")}`,
  ]);

  // ── Step 5 — provider fetches RWA price, signs it with the Casper key ──
  // Hard-coded "BTC/USD = 42000.50 USD @ ts 1700..." per the plan's RWA-oracle stub.
  const feed = { feed: "BTC/USD", price: "42000.50", timestamp: 1_700_000_000_500 };
  const feedCanonical = JSON.stringify(feed);
  const feedSigCompact = providerKp.sign(new TextEncoder().encode(feedCanonical));
  const feedSigDER = compactToDER(feedSigCompact);
  const feedSigHex = Buffer.from(feedSigDER).toString("hex");
  box("Step 5 — provider fetches mock RWA feed + signs", [
    `feed                = ${feed.feed}`,
    `price               = $${feed.price}`,
    `timestamp           = ${feed.timestamp}`,
    `provider_pubkey     = ${short(casperPublicKeyHex(providerKp))}`,
    `provider_sig (hex)  = ${short(feedSigHex)}`,
  ]);

  // ── Step 6 — provider calls deliver_result with the signed-feed hash ──
  const resultHash = createHash("sha256")
    .update(feedCanonical + feedSigHex)
    .digest("hex");
  odra.deliver_result(jobId, provider, resultHash);
  box("Step 6 — deliver_result (Odra deploy)", [
    "entry_point         = deliver_result",
    `job_id              = ${jobId}`,
    `result_hash         = ${short(resultHash)}`,
    "status              = Open → Delivered",
  ]);

  // ── Step 7 — requester verifies signature off-chain + confirms completion ──
  const providerPub = createPublicKey({ key: providerKp.publicKey.toPem(), format: "pem" });
  const verifiedOK = cryptoVerify("sha256", new TextEncoder().encode(feedCanonical), providerPub, feedSigDER);
  if (!verifiedOK) throw new Error("provider signature did not verify under their public key");
  odra.confirm_completion(jobId, requester);
  const completedSkill = odra.get_skill(skillId);
  box("Step 7 — requester verifies + confirm_completion (Odra deploy)", [
    "provider_sig verify = TRUE (secp256k1/SHA-256/DER under provider pubkey)",
    "entry_point         = confirm_completion",
    "status              = Delivered → Completed",
    `pending[provider]   = ${odra.pending_withdrawals_of(provider)} motes (escrow credited)`,
    `skill ${skillId} rep         = ${completedSkill.rep} (+5 from arm's-length completion)`,
    `skill ${skillId} invocations = ${completedSkill.invocations}`,
  ]);

  // ── Step 8 — provider withdraws CSPR ──
  const paid = odra.withdraw(provider);
  box("Step 8 — withdraw (Odra deploy, CEI pull-payment)", [
    "entry_point         = withdraw",
    `transfer_tokens     = ${paid} motes → provider`,
    `pending[provider]   = ${odra.pending_withdrawals_of(provider)} (zeroed before transfer — CEI)`,
  ]);

  console.log("\n┌── End-to-end summary ─────────────────────────────────────────────────────");
  console.log(`│ • register_skill           → skill_id ${skillId}`);
  console.log(`│ • deposit_bond             → 1 CSPR locked as Sybil seed`);
  console.log(`│ • create_job (x402)        → job_id ${jobId}, escrow ${PRICE} motes`);
  console.log(`│ • deliver_result           → status Delivered`);
  console.log(`│ • confirm_completion       → status Completed, escrow credited`);
  console.log(`│ • withdraw                 → 0.01 CSPR paid to provider`);
  console.log(`│ • skill reputation         → 55/100 (+5)`);
  console.log("└────────────────────────────────────────────────────────────────────────────");

  console.log("\n[demo] e2e PASS");
  console.log("[demo] next step: DEMO_CASPER.md for the live Casper Testnet reproduction.");
}

main().catch((e) => {
  console.error("[demo] FAIL:", e);
  process.exit(1);
});
