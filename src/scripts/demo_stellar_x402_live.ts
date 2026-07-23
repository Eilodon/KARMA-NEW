/**
 * KARMA Stellar ZK + x402 — LIVE end-to-end demo (T8 follow-on, "P2").
 *
 * The real thing DEMO_STELLAR.md's architecture diagram promises: a single HTTP request
 * carrying a real ZK proof + a real x402 USDC payment, settled on Stellar Testnet, verified
 * by the live `agent_credential_verifier` contract — no mocks, no local-only simulation.
 *
 *   - Client: agent-alpha (real funded Testnet account, holds real USDC)
 *   - Provider stub: an in-process HTTP server on localhost, acting as its own x402
 *     facilitator (agent-t3n signs settlement + receives payment — a legitimate x402
 *     topology where the resource server runs its own facilitator)
 *   - Skill 43 on the live contract, with a fixture proof/nullifier committed at
 *     `fixtures/agent_credential_skill43_packed.json` (skill 42's nullifier is already
 *     spent from the earlier live evidence run — see DEMO_STELLAR.md)
 *
 * IMPORTANT — one-shot fixture: the nullifier in the committed fixture can only be
 * accepted ONCE by the live contract (replay guard). Re-running this script a second
 * time will correctly fail at create_job with NullifierReused — that's the guard working,
 * not a bug. To run it live again, either point at a not-yet-spent fixture (SKILL_ID +
 * PACKED_PATH env vars — this repo also ships a skill-44 fixture, spent by the narrated
 * demo video recording) or regenerate a fresh proof for a new skill_id (see
 * `circuits/test/agent_credential.test.mjs` for the witness-generation pattern) and
 * `register_skill` + `set_skill_root` for that id first.
 *
 *   KEYSTORE_PASSWORD=<password> pnpm exec tsx src/scripts/demo_stellar_x402_live.ts
 *   KEYSTORE_PASSWORD=<password> SKILL_ID=44 PACKED_PATH=fixtures/agent_credential_skill44_packed.json \
 *     pnpm exec tsx src/scripts/demo_stellar_x402_live.ts
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ExactStellarScheme as ClientScheme } from "@x402/stellar/exact/client";
import { ExactStellarScheme as FacilitatorScheme } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer, USDC_TESTNET_ADDRESS, STELLAR_TESTNET_CAIP2 } from "@x402/stellar";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import { keystoreManager } from "../lib/keystore.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_ID = "CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP";
const SKILL_ID = Number(process.env.SKILL_ID ?? 43);
const PACKED_PATH_RAW = process.env.PACKED_PATH ?? "fixtures/agent_credential_skill43_packed.json";
const PACKED_PATH = isAbsolute(PACKED_PATH_RAW) ? PACKED_PATH_RAW : join(HERE, PACKED_PATH_RAW);
const PORT = 4021;

type Packed = { proof: { a: string; b: string; c: string }; public_inputs: string[] };

async function main(): Promise<void> {
  const pw = process.env.KEYSTORE_PASSWORD;
  if (!pw) throw new Error("KEYSTORE_PASSWORD not set");
  await keystoreManager.load("./keystore.json", pw);

  const payerKp = keystoreManager.getStellarKeypair("agent-alpha");
  const facilitatorKp = keystoreManager.getStellarKeypair("agent-t3n");
  const payerAddress = payerKp.publicKey();
  const facilitatorAddress = facilitatorKp.publicKey();

  const clientSigner = createEd25519Signer(payerKp.secret(), STELLAR_TESTNET_CAIP2);
  const facilitatorSigner = createEd25519Signer(facilitatorKp.secret(), STELLAR_TESTNET_CAIP2);
  const clientScheme = new ClientScheme(clientSigner);
  const facilitatorScheme = new FacilitatorScheme([facilitatorSigner], { areFeesSponsored: true });

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: STELLAR_TESTNET_CAIP2,
    asset: USDC_TESTNET_ADDRESS,
    amount: "10000", // 0.001 USDC at 7 decimals
    payTo: facilitatorAddress, // KARMA runs its own facilitator — receives payment directly
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };

  const packed = JSON.parse(readFileSync(PACKED_PATH, "utf8")) as Packed;

  // ── Provider stub server ──────────────────────────────────────────────────
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/invoke") {
      res.writeHead(404).end();
      return;
    }
    const paymentHeader = req.headers["x-payment"];
    if (!paymentHeader || typeof paymentHeader !== "string") {
      console.log("[provider] no X-Payment header — issuing 402");
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          x402Version: 2,
          resource: { url: "/invoke" },
          accepts: [requirements],
        }),
      );
      return;
    }

    const paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8")) as PaymentPayload;
    console.log("[provider] X-Payment received, verifying via facilitator...");
    const verifyResult = await facilitatorScheme.verify(paymentPayload, requirements);
    if (!verifyResult.isValid) {
      console.log("[provider] verify FAILED:", verifyResult);
      res.writeHead(402, { "Content-Type": "application/json" }).end(JSON.stringify(verifyResult));
      return;
    }
    console.log("[provider] verify OK, payer =", verifyResult.payer, "— settling on-chain...");
    const settleResult = await facilitatorScheme.settle(paymentPayload, requirements);
    if (!settleResult.success) {
      console.log("[provider] settle FAILED:", settleResult);
      res.writeHead(402, { "Content-Type": "application/json" }).end(JSON.stringify(settleResult));
      return;
    }
    console.log("[provider] SETTLED on-chain, tx =", settleResult.transaction);

    const proofB64 = req.headers["x-reputation-proof"];
    const nullifierHex = req.headers["x-nullifier"];
    if (typeof proofB64 !== "string" || typeof nullifierHex !== "string") {
      res.writeHead(400).end("missing ZK proof headers");
      return;
    }
    const { proof, public_inputs } = JSON.parse(
      Buffer.from(proofB64, "base64").toString("utf8"),
    ) as Packed;
    console.log("[provider] X-Reputation-Proof received, calling create_job on-chain...");
    const publicInputsDecimal = JSON.stringify(
      public_inputs.map((h) => BigInt(`0x${h}`).toString()),
    );
    let jobOut: string;
    try {
      jobOut = execFileSync(
        "stellar",
        [
          "contract",
          "invoke",
          "--id",
          CONTRACT_ID,
          "--source-account",
          "t3n",
          "--network",
          "testnet",
          "--",
          "create_job",
          "--payer",
          facilitatorAddress,
          "--skill_id",
          String(SKILL_ID),
          "--task_commitment",
          "0000000000000000000000000000000000000000000000000000000000000000",
          "--proof",
          JSON.stringify(proof),
          "--nullifier",
          nullifierHex,
          "--public_inputs",
          publicInputsDecimal,
          "--x402_receipt",
          // The x402 receipt field just stores a reference — use the real settlement tx hash so
          // the job record links back to the actual USDC payment that unlocked it.
          /^[0-9a-fA-F]+$/.test(settleResult.transaction) ? settleResult.transaction : "00",
        ],
        { encoding: "utf8" },
      );
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      console.log("[provider] create_job FAILED:", err.stderr || err.message);
      res.writeHead(502, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: "proof verification failed", detail: err.stderr || err.message }),
      );
      return;
    }
    console.log("[provider] create_job OK:", jobOut.trim());
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        settlementTx: settleResult.transaction,
        settlementLink: `https://stellar.expert/explorer/testnet/tx/${settleResult.transaction}`,
        jobCreatedRaw: jobOut.trim(),
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  console.log(`[demo] provider stub listening on http://localhost:${PORT}/invoke`);

  // ── Client: agent-alpha ────────────────────────────────────────────────────
  console.log(`[client] agent-alpha (${payerAddress}) — step 1: probe /invoke (no payment)`);
  const probe = await fetch(`http://localhost:${PORT}/invoke`, { method: "POST" });
  if (probe.status !== 402) throw new Error(`expected 402, got ${probe.status}`);
  const paymentRequired = (await probe.json()) as { accepts: Array<typeof requirements> };
  console.log("[client] got 402 PaymentRequired, accepts[0] =", paymentRequired.accepts[0]);

  console.log("[client] step 2: sign a real x402 payment payload (Soroban auth entry)...");
  const paymentPayloadResult = await clientScheme.createPaymentPayload(2, paymentRequired.accepts[0]);
  const fullPayload = {
    x402Version: paymentPayloadResult.x402Version,
    accepted: paymentRequired.accepts[0],
    payload: paymentPayloadResult.payload,
  };
  const xPayment = Buffer.from(JSON.stringify(fullPayload)).toString("base64");

  const xReputationProof = Buffer.from(JSON.stringify(packed)).toString("base64");
  const xNullifier = packed.public_inputs[2];

  console.log("[client] step 3: POST /invoke — ONE request, payment + ZK proof together");
  const final = await fetch(`http://localhost:${PORT}/invoke`, {
    method: "POST",
    headers: {
      "X-Payment": xPayment,
      "X-Reputation-Proof": xReputationProof,
      "X-Nullifier": xNullifier,
    },
  });
  const body: unknown = await final.json();
  console.log(`[client] response ${final.status}:`, JSON.stringify(body, null, 2));

  server.close();
  process.exit(final.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[demo] FAIL:", e);
  process.exit(1);
});
