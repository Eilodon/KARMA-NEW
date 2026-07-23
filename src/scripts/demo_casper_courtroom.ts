/**
 * The "courtroom" pillar, run for real: a requester disputes a delivered result, the provider
 * contests by matching the bond, and the neutral on-chain arbiter rules — loser pays. This was
 * the single biggest gap flagged in the 2026-07-07 audit ("evaluate_result/dispute_result/
 * claim_after_review are implemented + unit-tested but exercised by zero demo scripts anywhere —
 * nobody can currently watch arbitration run"). This closes it with real transactions.
 *
 * Three distinct accounts, deliberately not overlapping with the arbiter role:
 *   - arbiter   = governance signer 1 (the contract's default arbiter: `init()` sets
 *                 `arbiter = governance_signers[0]` — confirmed in agent_skill_registry.rs)
 *   - requester = governance signer 2
 *   - provider  = a freshly generated throwaway key, funded by a native CSPR transfer from
 *                 signer 1 — kept separate from both governance signers so neither party to the
 *                 dispute is also the judge.
 *
 * Verdict is `ProviderAtFault` — shows the mechanism's teeth: escrow + both bonds return to the
 * requester, and the provider's skill reputation is slashed. (`RequesterAtFault` is the mirror
 * case, exercised by contracts-odra's own unit tests already.)
 *
 * Needs CASPER_RPC_URL/CASPER_RPC_API_KEY/CASPER_CHAIN_NAME/CASPER_CONTRACT_HASH/
 * CASPER_GOV_SIGNER_1_SECRET_HEX/CASPER_GOV_SIGNER_2_SECRET_HEX in .env. Assumes
 * `demo_casper_full_job_lifecycle.ts` already ran once on this contract (skill_id=1, job_id=1
 * consumed) so this run lands on skill_id=2, job_id=2 — printed/verified below rather than
 * blindly trusted.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import casperSdk from "casper-js-sdk";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import { jsonSafe } from "../lib/serialize.js";

const { PrivateKey, KeyAlgorithm, RpcClient, HttpHandler, NativeTransferBuilder } = casperSdk;

const PRICE_PER_CALL_MOTES = 1_000_000_000n; // 1 CSPR
const DISPUTE_BOND_MOTES = 1_000_000_000n; // 10_000 bps (1x escrow) of 1 CSPR, floored at MIN_DISPUTE_BOND_MOTES anyway
// 100 CSPR: register_skill + deliver_result (plain calls, 5 CSPR ceiling each, mostly refunded) +
// respond_to_dispute (a *payable* proxy-caller session — PROXY_DEFAULT_PAYMENT_MOTES = 20 CSPR
// ceiling, held at submission time even though most refunds — see live_client.ts) + the 1 CSPR
// bond itself + margin. Two earlier attempts undershot this (15 CSPR, then 40 CSPR — see the
// postmortem in DEMO_CASPER.md's courtroom section: job_id=2 is a real, permanently-orphaned
// "Disputed" job on this contract from the first, left as-is for honesty rather than erased);
// 100 CSPR is the value that reliably completed the full chain in one take afterward.
const PROVIDER_FUNDING_MOTES = 100_000_000_000n;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function waitForFinalization(rpc: InstanceType<typeof casperSdk.RpcClient>, txHash: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const info = await rpc.getTransactionByTransactionHash(txHash);
      const exec = info.executionInfo;
      if (exec?.executionResult) {
        const err = exec.executionResult.errorMessage;
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

  const arbiterSigner = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_1_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const requester = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_2_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const providerKey = PrivateKey.generate(KeyAlgorithm.SECP256K1);
  const arbiterAccountHash = arbiterSigner.publicKey.accountHash().toPrefixedString();
  const requesterAccountHash = requester.publicKey.accountHash().toPrefixedString();
  const providerAccountHash = providerKey.publicKey.accountHash().toPrefixedString();
  console.log("arbiter (signer 1):", arbiterAccountHash);
  console.log("requester (signer 2):", requesterAccountHash);
  console.log("provider (fresh throwaway key):", providerAccountHash);
  // Throwaway testnet-only key, printed so a failed run can be resumed without losing the funded
  // account (see the 15-CSPR-undershoot postmortem below) — never do this for a key holding
  // anything of real value.
  console.log(
    "provider secret (throwaway testnet key, safe to print):",
    Buffer.from(providerKey.toBytes()).toString("hex"),
  );

  const handler = new HttpHandler(rpcUrl);
  if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
  const rpc = new RpcClient(handler);
  const client = new CasperLiveClient({ rpcUrl, rpcHeaders: apiKey ? { Authorization: apiKey } : undefined, chainName, contractHash });

  console.log("\n0. funding the fresh provider key with 100 CSPR from signer 1...");
  const transferTx = new NativeTransferBuilder()
    .from(arbiterSigner.publicKey)
    .target(providerKey.publicKey)
    .amount(PROVIDER_FUNDING_MOTES.toString())
    .id(Date.now())
    .chainName(chainName)
    .payment(100_000_000)
    .build();
  transferTx.sign(arbiterSigner);
  const transferResult = await rpc.putTransaction(transferTx);
  const transferTxHash = transferResult.transactionHash.toHex();
  console.log("  tx:", transferTxHash);
  await waitForFinalization(rpc, transferTxHash, "fund_provider");

  // Probe for the next free skill_id/job_id BEFORE writing, rather than hardcoding — this
  // script is meant to be re-runnable (e.g. for video re-takes) and the registry accumulates
  // entries from every prior run (including two real orphaned ones from earlier debugging —
  // see DEMO_CASPER.md's courtroom section for the full postmortem).
  let skillId = 1n;
  while ((await client.getSkill(skillId)) !== undefined) skillId += 1n;
  console.log(`\n1. register_skill (provider, will be skill_id=${skillId})...`);
  const reg = await client.registerSkill(providerKey, {
    name: "casper_courtroom_demo",
    description: "KARMA courtroom (dispute + arbitrate) proof-of-life on the governance-hardened Casper contract",
    mcpEndpoint: "https://demo.karma.local/mcp/courtroom",
    pricePerCallMotes: PRICE_PER_CALL_MOTES,
    minReputationToInvoke: 0,
    identityPolicy: 0,
  });
  console.log("  tx:", reg.txHash);
  await waitForFinalization(rpc, reg.txHash, "register_skill");

  let jobId = 1n;
  while ((await client.getJob(jobId)) !== undefined) jobId += 1n;
  const taskHash = sha256Hex(`KARMA casper courtroom demo task ${Date.now()}`);
  console.log(`\n2. create_job (will be job_id=${jobId}; requester escrows 1 CSPR)...`);
  const job = await client.createJob(requester, {
    skillId,
    taskHashHex: taskHash,
    deadlineSecs: 3600n,
    escrowMotes: PRICE_PER_CALL_MOTES,
  });
  console.log("  tx:", job.txHash);
  await waitForFinalization(rpc, job.txHash, "create_job");

  const resultHash = sha256Hex(`KARMA casper courtroom demo — deliberately contested result ${Date.now()}`);
  console.log("\n3. deliver_result (provider)...");
  const deliver = await client.deliverResult(providerKey, { jobId, resultHashHex: resultHash });
  console.log("  tx:", deliver.txHash);
  await waitForFinalization(rpc, deliver.txHash, "deliver_result");

  console.log("\n4. dispute_result (requester posts dispute bond)...");
  const dispute = await client.disputeResult(requester, jobId, DISPUTE_BOND_MOTES);
  console.log("  tx:", dispute.txHash);
  await waitForFinalization(rpc, dispute.txHash, "dispute_result");

  console.log("\n5. respond_to_dispute (provider matches the bond, enters arbitration)...");
  const respond = await client.respondToDispute(providerKey, jobId, DISPUTE_BOND_MOTES);
  console.log("  tx:", respond.txHash);
  await waitForFinalization(rpc, respond.txHash, "respond_to_dispute");

  console.log("\n6. arbitrate (arbiter rules ProviderAtFault)...");
  const arbitrate = await client.arbitrate(arbiterSigner, jobId, "ProviderAtFault");
  console.log("  tx:", arbitrate.txHash);
  await waitForFinalization(rpc, arbitrate.txHash, "arbitrate");

  console.log("\nverifying final state...");
  const skill = await client.getSkill(skillId);
  const finalJob = await client.getJob(jobId);
  console.log(`  getSkill(${skillId}):`, JSON.stringify(jsonSafe(skill)));
  console.log(`  getJob(${jobId}):`, JSON.stringify(jsonSafe(finalJob)));
  console.log("\n  provider account-hash (for the record):", providerAccountHash);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
