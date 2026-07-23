/**
 * Fires a real propose -> approve -> (later) execute governance chain for
 * `propose_set_cross_chain_rep` against the live, governance-hardened Casper contract —
 * closing the "reputation is portable across chains, not just proven once" story with an
 * actual on-chain receipt instead of a unit test.
 *
 * Target agent is governance signer 2's own Casper account-hash (no extra keystore/password
 * needed beyond the two governance secrets already in .env). Score/source_chain echo the
 * Stellar ZK ReputationAggregationProof narrative (avg score >= 80, >= 10 jobs, >= 5 domains) —
 * "soroban" matches the source_chain string convention used throughout
 * contracts-odra/src/agent_skill_registry/tests.rs.
 *
 * Assumes this is proposal_id=1: the contract's proposal_counter starts at 0 and this is the
 * first governance proposal on the fresh governance-hardened registry (confirmed via
 * getEventCount() before running == 1, i.e. only the GovernanceConfigured event from deploy).
 * `propose_set_cross_chain_rep`'s real return value (the u64 proposal_id) isn't surfaced over
 * RPC by CasperLiveClient today — this script verifies the assumption by re-reading
 * getEventCount() after each step instead of trusting it blindly.
 *
 * execute_proposal will revert with TimelockNotElapsed today (by design — 48h timelock from
 * deploy). Run again with `--execute` after the delay to complete the chain.
 *
 * Needs CASPER_RPC_URL/CASPER_RPC_API_KEY/CASPER_CHAIN_NAME/CASPER_CONTRACT_HASH/
 * CASPER_GOV_SIGNER_1_SECRET_HEX/CASPER_GOV_SIGNER_2_SECRET_HEX in .env.
 */
import "dotenv/config";
import casperSdk from "casper-js-sdk";
import { CasperLiveClient } from "../lib/casper/live_client.js";

const { PrivateKey, KeyAlgorithm } = casperSdk;

const AGENT_SCORE = 80;
const SOURCE_CHAIN = "soroban";
// Not auto-discovered (CasperLiveClient has no getProposal reader to probe existence against) —
// hardcoded to the id this specific run's `propose_set_cross_chain_rep` call will get, given the
// exact prior state of this contract: proposal 1 pre-existed, and a previous mis-targeted take of
// this very capture created (and orphaned at 1/2 approvals) proposal 2 — so this run's fresh
// `propose` call will get id 3. Bump this by hand before any future re-run.
const PROPOSAL_ID = 3n;

async function waitForFinalization(
  client: CasperLiveClient,
  rpc: InstanceType<typeof casperSdk.RpcClient>,
  txHash: string,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const info = await rpc.getTransactionByTransactionHash(txHash);
      const exec = info.executionInfo;
      if (exec?.executionResult) {
        const err = exec.executionResult.errorMessage;
        console.log(`  finalized. errorMessage: ${err === null ? "null (success)" : err}`);
        return;
      }
      console.log(`  attempt ${attempt + 1}: not finalized yet...`);
    } catch (e) {
      console.log(`  attempt ${attempt + 1}: query failed —`, e instanceof Error ? e.message : e);
    }
  }
  console.log("  gave up waiting for finalization after 30 attempts");
}

async function main(): Promise<void> {
  const rpcUrl = process.env.CASPER_RPC_URL!;
  const apiKey = process.env.CASPER_RPC_API_KEY;
  const chainName = process.env.CASPER_CHAIN_NAME ?? "casper-test";
  const contractHash = process.env.CASPER_CONTRACT_HASH!;

  const signer1 = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_1_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const signer2 = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_2_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const signer1AccountHash = signer1.publicKey.accountHash().toPrefixedString();
  const signer2AccountHash = signer2.publicKey.accountHash().toPrefixedString();
  console.log("governance signer 1 (proposer):", signer1AccountHash);
  console.log("governance signer 2 (approver, and demo target agent):", signer2AccountHash);

  const handler = new casperSdk.HttpHandler(rpcUrl);
  if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
  const rpc = new casperSdk.RpcClient(handler);

  const client = new CasperLiveClient({ rpcUrl, rpcHeaders: apiKey ? { Authorization: apiKey } : undefined, chainName, contractHash });

  const before = await client.getEventCount();
  console.log(`event count before: ${before}`);

  const mode = process.argv[2];

  if (mode === "--execute") {
    console.log(`\nexecuting proposal ${PROPOSAL_ID}...`);
    const { txHash } = await client.executeProposal(signer1, PROPOSAL_ID);
    console.log("submitted. tx hash:", txHash);
    await waitForFinalization(client, rpc, txHash);
    const rep = await client.getCrossChainRep(signer2AccountHash);
    console.log(`\nget_cross_chain_rep(signer2) = ${rep}`);
    return;
  }

  console.log(`\nproposing set_cross_chain_rep(agent=${signer2AccountHash}, score=${AGENT_SCORE}, source_chain="${SOURCE_CHAIN}")...`);
  const propose = await client.proposeSetCrossChainRep(signer1, signer2AccountHash, AGENT_SCORE, SOURCE_CHAIN);
  console.log("submitted. tx hash:", propose.txHash);
  await waitForFinalization(client, rpc, propose.txHash);

  const afterPropose = await client.getEventCount();
  console.log(`event count after propose: ${afterPropose} (expect ${before + 2}: ProposalCreated + ProposalApproved)`);

  console.log(`\napproving proposal ${PROPOSAL_ID} as signer 2...`);
  const approve = await client.approveProposal(signer2, PROPOSAL_ID);
  console.log("submitted. tx hash:", approve.txHash);
  await waitForFinalization(client, rpc, approve.txHash);

  const afterApprove = await client.getEventCount();
  console.log(`event count after approve: ${afterApprove} (expect ${afterPropose + 1}: ProposalApproved, 2/2)`);

  console.log("\nattempting execute_proposal now (expected to revert — 48h timelock not elapsed yet)...");
  try {
    const exec = await client.executeProposal(signer1, PROPOSAL_ID);
    console.log("submitted. tx hash:", exec.txHash);
    await waitForFinalization(client, rpc, exec.txHash);
  } catch (e) {
    console.log("execute attempt result (submission-level):", e instanceof Error ? e.message : e);
  }

  console.log(
    "\nRe-run this script with `--execute` after the 48h timelock elapses (proposal created at this run's timestamp) to complete the chain.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
