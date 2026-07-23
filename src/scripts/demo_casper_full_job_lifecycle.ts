/**
 * Full job lifecycle on the live, governance-hardened Casper contract, end-to-end with real
 * transactions: register_skill -> deposit_bond (Tier-2 Sybil bond, PD-007) -> create_job ->
 * deliver_result -> confirm_completion -> withdraw. Closes the "6 real transactions" claim
 * README/DEMO_CASPER.md make with actual tx hashes on the NEW contract (the old evidence was
 * against the pre-governance-hardening contract).
 *
 * Uses the two governance-signer wallets already funded in .env — no extra keystore/password
 * needed. Provider = governance signer 1, requester = governance signer 2 (deliberately
 * different accounts so the self-deal guard in `settle_completion` doesn't zero reputation
 * signals — see `contracts-odra/src/agent_skill_registry.rs`).
 *
 * Needs CASPER_RPC_URL/CASPER_RPC_API_KEY/CASPER_CHAIN_NAME/CASPER_CONTRACT_HASH/
 * CASPER_GOV_SIGNER_1_SECRET_HEX/CASPER_GOV_SIGNER_2_SECRET_HEX in .env.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import casperSdk from "casper-js-sdk";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import { jsonSafe } from "../lib/serialize.js";

const { PrivateKey, KeyAlgorithm, RpcClient, HttpHandler } = casperSdk;

const PRICE_PER_CALL_MOTES = 1_000_000_000n; // 1 CSPR
const BOND_MOTES = 1_000_000_000n; // 1 CSPR Tier-2 Sybil bond

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function waitForFinalization(rpc: InstanceType<typeof casperSdk.RpcClient>, txHash: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const info = await rpc.getTransactionByTransactionHash(txHash);
      const exec = info.executionInfo;
      if (exec) {
        const err = exec.executionResult?.errorMessage;
        console.log(`  [${label}] finalized. errorMessage: ${err === null ? "null (success)" : err}`);
        return;
      }
      console.log(`  [${label}] attempt ${attempt + 1}: not finalized yet...`);
    } catch (e) {
      console.log(`  [${label}] attempt ${attempt + 1}: query failed —`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`  [${label}] gave up waiting for finalization after 30 attempts`);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.CASPER_RPC_URL!;
  const apiKey = process.env.CASPER_RPC_API_KEY;
  const chainName = process.env.CASPER_CHAIN_NAME ?? "casper-test";
  const contractHash = process.env.CASPER_CONTRACT_HASH!;

  const provider = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_1_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const requester = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_2_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const providerAccountHash = provider.publicKey.accountHash().toPrefixedString();
  const requesterAccountHash = requester.publicKey.accountHash().toPrefixedString();
  console.log("provider (signer 1):", providerAccountHash);
  console.log("requester (signer 2):", requesterAccountHash);

  const handler = new HttpHandler(rpcUrl);
  if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
  const rpc = new RpcClient(handler);
  const client = new CasperLiveClient({ rpcUrl, rpcHeaders: apiKey ? { Authorization: apiKey } : undefined, chainName, contractHash });

  // Probe for the next free skill_id BEFORE writing — the registry's own counter assigns
  // exactly this id to the next register_skill call. Re-runnable across takes: doesn't assume
  // a fresh/empty registry the way an earlier version of this script did (which broke on a
  // second run — DuplicateTaskHash on create_job, then a cascade of stale-state errors).
  let skillId = 1n;
  while ((await client.getSkill(skillId)) !== undefined) skillId += 1n;
  console.log(`\n1. register_skill (will be skill_id=${skillId})...`);
  const reg = await client.registerSkill(provider, {
    name: "casper_full_lifecycle_demo",
    description: "KARMA full job lifecycle proof-of-life on the governance-hardened Casper contract",
    mcpEndpoint: "https://demo.karma.local/mcp/full-lifecycle",
    pricePerCallMotes: PRICE_PER_CALL_MOTES,
    minReputationToInvoke: 0,
    identityPolicy: 0,
  });
  console.log("  tx:", reg.txHash);
  await waitForFinalization(rpc, reg.txHash, "register_skill");

  console.log("\n2. deposit_bond (Tier-2 Sybil bond, PD-007)...");
  const bond = await client.depositBond(provider, BOND_MOTES);
  console.log("  tx:", bond.txHash);
  await waitForFinalization(rpc, bond.txHash, "deposit_bond");

  let jobId = 1n;
  while ((await client.getJob(jobId)) !== undefined) jobId += 1n;
  const taskHash = sha256Hex(`KARMA casper full-lifecycle demo task ${Date.now()}`);
  console.log(`\n3. create_job (will be job_id=${jobId}; requester escrows 1 CSPR)...`);
  const job = await client.createJob(requester, {
    skillId,
    taskHashHex: taskHash,
    deadlineSecs: 3600n,
    escrowMotes: PRICE_PER_CALL_MOTES,
  });
  console.log("  tx:", job.txHash);
  await waitForFinalization(rpc, job.txHash, "create_job");

  const resultHash = sha256Hex(`KARMA casper full-lifecycle demo result ${Date.now()}`);
  console.log("\n4. deliver_result (provider)...");
  const deliver = await client.deliverResult(provider, { jobId, resultHashHex: resultHash });
  console.log("  tx:", deliver.txHash);
  await waitForFinalization(rpc, deliver.txHash, "deliver_result");

  console.log("\n5. confirm_completion (requester)...");
  const confirm = await client.confirmCompletion(requester, jobId);
  console.log("  tx:", confirm.txHash);
  await waitForFinalization(rpc, confirm.txHash, "confirm_completion");

  console.log("\n6. withdraw (provider pulls payout)...");
  const withdraw = await client.withdraw(provider);
  console.log("  tx:", withdraw.txHash);
  await waitForFinalization(rpc, withdraw.txHash, "withdraw");

  console.log("\nverifying final state...");
  const skill = await client.getSkill(skillId);
  const finalJob = await client.getJob(jobId);
  console.log(`  getSkill(${skillId}):`, JSON.stringify(jsonSafe(skill)));
  console.log(`  getJob(${jobId}):`, JSON.stringify(jsonSafe(finalJob)));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
