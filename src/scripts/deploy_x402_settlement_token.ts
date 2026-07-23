/**
 * Installs `X402SettlementToken` (contracts-odra/src/x402_settlement_token.rs) on Casper Testnet
 * — the real CEP-18 + CEP-3009 asset `x402_casper.ts`'s EIP-712 rewrite (RFC
 * docs/rfc/2026-07-21-x402-casper-eip712-interop.md §5.1-5.5) will settle against.
 *
 * Same `SessionBuilder` install pattern as `deploy_casper_governance_hardened.ts` (cspr.cloud
 * needs a custom Authorization header the casper-client CLI can't set). Signs with a keystore
 * agent's Casper key rather than a raw env-var secret — this is a one-signer utility deploy, not
 * a governance action.
 *
 * Needs CASPER_RPC_URL (defaults to the public Testnet node) + KEYSTORE_PATH/KEYSTORE_PASSWORD.
 * Prints the new contract_package_hash on success.
 *
 *   KEYSTORE_PATH=./keystore.json KEYSTORE_PASSWORD=... \
 *   pnpm exec tsx src/scripts/deploy_x402_settlement_token.ts x402-deployer
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import casperSdk from "casper-js-sdk";
import { keystoreManager } from "../lib/keystore.js";

const { RpcClient, HttpHandler, SessionBuilder, Args, CLValue } = casperSdk;

const rpcUrl = process.env.CASPER_RPC_URL ?? "https://node.testnet.casper.network/rpc";
const apiKey = process.env.CASPER_RPC_API_KEY;
const chainName = process.env.CASPER_CHAIN_NAME ?? "casper-test";

const handler = new HttpHandler(rpcUrl);
if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
const rpc = new RpcClient(handler);

const PAYMENT_MOTES = 700_000_000_000; // 700 CSPR ceiling — smaller wasm than AgentSkillRegistry's 800 CSPR one

async function main() {
  const keystorePath = process.env.KEYSTORE_PATH ?? "./keystore.json";
  const password = process.env.KEYSTORE_PASSWORD;
  if (!password) throw new Error("[deploy-x402-token] KEYSTORE_PASSWORD not set");
  const agentId = process.argv[2];
  if (!agentId) throw new Error("[deploy-x402-token] usage: deploy_x402_settlement_token.ts <agentId>");

  await keystoreManager.load(keystorePath, password);
  const signer = keystoreManager.getCasperKeypair(agentId);
  const deployerAccountHash = signer.publicKey.accountHash().toPrefixedString();
  console.log("deployer account:", deployerAccountHash);

  const wasmBytes = readFileSync(new URL("../../contracts-odra/wasm/x402_settlement_token.wasm", import.meta.url));
  console.log("wasm size:", wasmBytes.length, "bytes");

  const args = Args.fromMap({
    odra_cfg_package_hash_key_name: CLValue.newCLString("X402SettlementToken"),
    odra_cfg_allow_key_override: CLValue.newCLValueBool(false),
    odra_cfg_is_upgradable: CLValue.newCLValueBool(true),
    odra_cfg_is_upgrade: CLValue.newCLValueBool(false),
    odra_cfg_constructor: CLValue.newCLString("init"),
    chain_name: CLValue.newCLString(chainName),
  });

  const transaction = new SessionBuilder()
    .from(signer.publicKey)
    .wasm(new Uint8Array(wasmBytes))
    .installOrUpgrade()
    .runtimeArgs(args)
    .chainName(chainName)
    .payment(PAYMENT_MOTES)
    .build();
  transaction.sign(signer);

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

  console.log("\nQuery the deployer account's named_keys to find the new contract_package_hash:");
  console.log(`  deployer account: ${deployerAccountHash}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
