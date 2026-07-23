/**
 * One-shot redeploy of the Odra AgentSkillRegistry with the P0-B governance-lifecycle fix
 * (propose_set_arbiter/propose_set_dispute_bond_bps replacing the single-signer set_arbiter/
 * set_dispute_bond_bps) AND a real multisig config (2 signers, threshold 2, 48h timelock) —
 * see DEMO_CASPER.md's "Redeploy checklist" section for the full rationale.
 *
 * Uses casper-js-sdk's SessionBuilder directly (not the casper-client CLI) because cspr.cloud
 * requires a custom Authorization header the CLI can't set — same reasoning as the original
 * verified deploy (DEMO_CASPER.md Step 1 notes).
 *
 * Needs CASPER_RPC_URL/CASPER_RPC_API_KEY/CASPER_CHAIN_NAME + CASPER_GOV_SIGNER_1_SECRET_HEX/
 * CASPER_GOV_SIGNER_2_SECRET_HEX in .env. Prints the new contract_package_hash on success —
 * update KARMA_ODRA_REGISTRY/CASPER_CONTRACT_HASH to it afterward.
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import casperSdk from "casper-js-sdk";

const { RpcClient, HttpHandler, SessionBuilder, Args, CLValue, CLTypeKey, PrivateKey, KeyAlgorithm, Key } = casperSdk;

const rpcUrl = process.env.CASPER_RPC_URL!;
const apiKey = process.env.CASPER_RPC_API_KEY;
const chainName = process.env.CASPER_CHAIN_NAME ?? "casper-test";

const handler = new HttpHandler(rpcUrl);
if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
const rpc = new RpcClient(handler);

const REVIEW_WINDOW_MS = "259200000"; // 3 days — DEFAULT_REVIEW_WINDOW
const TIMELOCK_DELAY_MS = "172800000"; // 48 hours — DEFAULT_TIMELOCK_DELAY
const PAYMENT_MOTES = 800_000_000_000; // 800 CSPR ceiling (real cost ~579 CSPR per the original deploy)

async function main() {
  const signer1Secret = process.env.CASPER_GOV_SIGNER_1_SECRET_HEX!;
  const signer2Secret = process.env.CASPER_GOV_SIGNER_2_SECRET_HEX!;
  const signer1 = PrivateKey.fromHex(signer1Secret, KeyAlgorithm.SECP256K1);
  const signer2 = PrivateKey.fromHex(signer2Secret, KeyAlgorithm.SECP256K1);

  const signer1AccountHash = signer1.publicKey.accountHash().toPrefixedString();
  const signer2AccountHash = signer2.publicKey.accountHash().toPrefixedString();
  console.log("governance signer 1:", signer1AccountHash);
  console.log("governance signer 2:", signer2AccountHash);

  const wasmBytes = readFileSync(new URL("../../contracts-odra/wasm/karma_odra.wasm", import.meta.url));
  console.log("wasm size:", wasmBytes.length, "bytes");

  const governanceSigners = CLValue.newCLList(CLTypeKey, [
    CLValue.newCLKey(Key.newKey(signer1AccountHash)),
    CLValue.newCLKey(Key.newKey(signer2AccountHash)),
  ]);

  const args = Args.fromMap({
    odra_cfg_package_hash_key_name: CLValue.newCLString("AgentSkillRegistry"),
    odra_cfg_allow_key_override: CLValue.newCLValueBool(false),
    odra_cfg_is_upgradable: CLValue.newCLValueBool(true),
    odra_cfg_is_upgrade: CLValue.newCLValueBool(false),
    odra_cfg_constructor: CLValue.newCLString("init"),
    review_window_ms: CLValue.newCLUint64(REVIEW_WINDOW_MS),
    governance_signers: governanceSigners,
    governance_threshold: CLValue.newCLUInt32(2),
    timelock_delay_ms: CLValue.newCLUint64(TIMELOCK_DELAY_MS),
  });

  const transaction = new SessionBuilder()
    .from(signer1.publicKey)
    .wasm(new Uint8Array(wasmBytes))
    .installOrUpgrade()
    .runtimeArgs(args)
    .chainName(chainName)
    .payment(PAYMENT_MOTES)
    .build();
  transaction.sign(signer1);

  console.log("submitting install deploy...");
  const result = await rpc.putTransaction(transaction);
  const txHash = result.transactionHash.toHex();
  console.log("submitted. transaction hash:", txHash);

  console.log("waiting for finalization...");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const info = await rpc.getTransactionByTransactionHash(txHash);
      const exec = info.executionInfo;
      if (exec) {
        console.log("execution result:", JSON.stringify(exec, null, 2));
        break;
      }
      console.log(`  attempt ${attempt + 1}: not finalized yet...`);
    } catch (e) {
      console.log(`  attempt ${attempt + 1}: query failed —`, e instanceof Error ? e.message : e);
    }
  }

  console.log("\nNow query the deployer account's named_keys to find the new contract_package_hash:");
  console.log(`  signer1 account: ${signer1AccountHash}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
