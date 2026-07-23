/**
 * Register the `rwa_price_oracle` skill on the Odra `AgentSkillRegistry` deployed to Casper
 * Testnet (T13 — RWA-oracle reference skill).
 *
 * Mode of operation:
 *   • DRY-RUN (default) — prints the exact `register_skill` invocation a deployer would issue,
 *     without touching the network. This is what the demo video records.
 *   • LIVE — set `CASPER_RPC_URL`, `KARMA_ODRA_REGISTRY` (contract package hash), and
 *     `KEYSTORE_PATH` + `KEYSTORE_PASSWORD`. The script then signs a deploy with the agent's
 *     secp256k1 key (reused via T10's `KeystoreManager.getCasperKeypair`) and submits it via
 *     `casper-client put-deploy`. Out-of-the-box this path requires the Odra contract WASM to
 *     be deployed first (`cargo odra build && casper-client put-deploy …` per
 *     `contracts-odra/README.md`), so live registration is gated by the owner.
 *
 *   pnpm exec tsx src/scripts/register_rwa_oracle_skill.ts          # dry-run
 *   pnpm exec tsx src/scripts/register_rwa_oracle_skill.ts --live   # requires the env above
 */

import { keystoreManager } from "../lib/keystore.js";
import { CasperLiveClient } from "../lib/casper/live_client.js";

const SKILL = {
  name: "rwa_price_oracle",
  description:
    "Signed real-world-asset price feed (BTC, ETH, gold). Returns a Casper-signed JSON " +
    "envelope: { feed, price, timestamp, sig }. Per Casper DoraHacks example #2.",
  // Symbolic endpoint — the orchestrator addresses it through KARMA MCP discovery, not DNS.
  mcp_endpoint: "casper-mcp://providers/rwa_price_oracle",
  // 0.01 CSPR per call, 9 decimals.
  price_per_call_motes: "10000000",
  // Trust gate stays open for the demo (0); raise via setMinReputation once seeded.
  min_reputation_to_invoke: 0,
  // Recommend T3N_VERIFIED_FRESH (2) for a real-world price feed — adversarial economics
  // benefit from a fresh-session check. Demo uses NONE (0) for one-shot reviewer reproduction.
  identity_policy: 0,
} as const;

interface RegisterArgs {
  live: boolean;
  rpcUrl?: string;
  contract?: string;
  keystorePath?: string;
}

function parseArgs(argv: string[]): RegisterArgs {
  return {
    live: argv.includes("--live"),
    rpcUrl: process.env.CASPER_RPC_URL,
    contract: process.env.KARMA_ODRA_REGISTRY,
    keystorePath: process.env.KEYSTORE_PATH,
  };
}

function box(label: string, rows: Array<[string, string]>): void {
  const maxKey = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.map(([k, v]) => `${k.padEnd(maxKey)} : ${v}`);
  const width = Math.max(label.length, ...lines.map((l) => l.length)) + 2;
  console.log("\n┌" + "─".repeat(width) + "┐");
  console.log("│ " + label.padEnd(width - 1) + "│");
  console.log("├" + "─".repeat(width) + "┤");
  for (const l of lines) console.log("│ " + l.padEnd(width - 1) + "│");
  console.log("└" + "─".repeat(width) + "┘");
}

function printDryRun(): void {
  console.log("=".repeat(80));
  console.log("rwa_price_oracle — register_skill (DRY-RUN, T13)");
  console.log("=".repeat(80));
  box("Skill payload", [
    ["name", SKILL.name],
    ["description", SKILL.description],
    ["mcp_endpoint", SKILL.mcp_endpoint],
    ["price_per_call (motes)", SKILL.price_per_call_motes],
    ["min_reputation_to_invoke", String(SKILL.min_reputation_to_invoke)],
    ["identity_policy", String(SKILL.identity_policy)],
  ]);

  console.log("\n┌── casper-client put-deploy (what would be submitted) ──");
  console.log("│ entry_point   = register_skill");
  console.log(`│ session_args  = name:String:'${SKILL.name}'`);
  console.log(`│                 description:String:'<see above>'`);
  console.log(`│                 mcp_endpoint:String:'${SKILL.mcp_endpoint}'`);
  console.log(`│                 price_per_call:U512:'${SKILL.price_per_call_motes}'`);
  console.log(`│                 min_reputation_to_invoke:U32:'${SKILL.min_reputation_to_invoke}'`);
  console.log(`│                 identity_policy:U8:'${SKILL.identity_policy}'`);
  console.log("│ payment_amount= 5000000000 (5 CSPR ceiling — adjust for live)");
  console.log("└────────────────────────────────────────────────────────");

  console.log("\n┌── Live run (owner-driven) ──");
  console.log("│ 1. Build + deploy contracts-odra/ (cargo odra build + casper-client put-deploy)");
  console.log("│ 2. Export the deployed package hash as KARMA_ODRA_REGISTRY=hash-...");
  console.log("│ 3. Set CASPER_RPC_URL + KEYSTORE_PATH (KARMA keystore with funded agent)");
  console.log("│ 4. Re-run with --live");
  console.log("└──────────────────────────────");
}

async function runLive(args: RegisterArgs): Promise<void> {
  if (!args.rpcUrl) throw new Error("[register] CASPER_RPC_URL not set");
  if (!args.contract) throw new Error("[register] KARMA_ODRA_REGISTRY (package hash) not set");
  if (!args.keystorePath) throw new Error("[register] KEYSTORE_PATH not set");
  if (!process.env.KEYSTORE_PASSWORD) throw new Error("[register] KEYSTORE_PASSWORD not set");

  await keystoreManager.load(args.keystorePath, process.env.KEYSTORE_PASSWORD);
  const agentId = process.env.KARMA_AGENT_ID ?? keystoreManager.list()[0];
  if (!agentId) throw new Error("[register] keystore has no agents loaded");
  const signer = keystoreManager.getCasperKeypair(agentId);
  const accountHash = keystoreManager.getCasperAccountHash(agentId);
  console.log(`[register] live mode — agent ${agentId} → ${accountHash}`);
  console.log(`[register] RPC: ${args.rpcUrl}`);
  console.log(`[register] contract: ${args.contract}`);

  const client = new CasperLiveClient({
    rpcUrl: args.rpcUrl,
    contractHash: args.contract,
    chainName: process.env.CASPER_CHAIN_NAME ?? "casper-test",
    rpcHeaders: process.env.CASPER_RPC_API_KEY ? { Authorization: process.env.CASPER_RPC_API_KEY } : undefined,
  });
  const { txHash } = await client.registerSkill(signer, {
    name: SKILL.name,
    description: SKILL.description,
    mcpEndpoint: SKILL.mcp_endpoint,
    pricePerCallMotes: BigInt(SKILL.price_per_call_motes),
    minReputationToInvoke: SKILL.min_reputation_to_invoke,
    identityPolicy: SKILL.identity_policy,
  });
  console.log(`[register] submitted — transaction hash: ${txHash}`);
  console.log(
    `[register] confirm on an explorer, then read the assigned skill_id from the ` +
    `SkillRegistered event or \`skill_count()\` on the contract.`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.live) {
    printDryRun();
    return;
  }
  await runLive(args);
}

main().catch((e) => {
  console.error("[register] FAIL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
