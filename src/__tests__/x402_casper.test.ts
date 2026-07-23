import { Buffer } from "node:buffer";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildDomain,
  hashTypedDataRaw,
  computeTypeHash,
  encodeAddress,
  encodeUint256,
  encodeUint64,
  encodeBytes32,
  CASPER_DOMAIN_TYPES,
} from "@casper-ecosystem/casper-eip-712";
import {
  CasperX402Plugin,
  CASPER_MAINNET_CAIP2,
  CASPER_TESTNET_CAIP2,
  casperX402PaymentOption,
  convertCsprToMotes,
  verifyCasperExactPayload,
  deriveRationaleNonce,
  settleTransferWithAuthorization,
  type CasperX402SignedPayload,
} from "../plugins/x402_casper.js";
import { deriveCasperPrivateKey } from "../lib/casper/keypair.js";

const FACILITATOR = "https://x402-facilitator.casper.network";
const SECP_SEED = new Uint8Array(32).fill(0x42);
const TEST_KEYPAIR = deriveCasperPrivateKey(SECP_SEED);
const SECP_SEED_OTHER = new Uint8Array(32).fill(0x99);
const OTHER_KEYPAIR = deriveCasperPrivateKey(SECP_SEED_OTHER);

// Fake `X402SettlementToken` package hash — plugin only needs *a* consistently-used hash to
// build a stable EIP-712 domain; these tests never touch the chain.
const FAKE_TOKEN_HASH = "hash-" + "11".repeat(32);

function newPlugin(opts: ConstructorParameters<typeof CasperX402Plugin>[2] = {}) {
  return new CasperX402Plugin(FACILITATOR, () => TEST_KEYPAIR, {
    settlementTokenPackageHash: FAKE_TOKEN_HASH,
    ...opts,
  });
}

// These tests construct CasperX402Plugin instances that deliberately omit rpcUrl/
// settlementTokenPackageHash/etc to exercise the "not configured" fallback paths — a real dev
// .env (CASPER_RPC_URL, KARMA_X402_CASPER_SETTLEMENT_TOKEN, CASPER_RPC_API_KEY, CASPER_CHAIN_NAME,
// used by the live demo scripts) would otherwise leak in as env-var fallbacks and silently attempt
// real on-chain settlement mid-test. Same isolation pattern as casper_tool.test.ts.
const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.CASPER_RPC_URL;
  delete process.env.KARMA_X402_CASPER_SETTLEMENT_TOKEN;
  delete process.env.CASPER_RPC_API_KEY;
  delete process.env.CASPER_CHAIN_NAME;
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("TransferWithAuthorization typehash (T13-live)", () => {
  it("matches CEP3009's hardcoded TRANSFER_WITH_AUTHORIZATION_TYPEHASH byte-for-byte", () => {
    // odra-modules-2.8.2/src/cep3009.rs: `[0x7c, 0x7c, 0x6c, 0xdb, 0x67, 0xa1, 0x87, 0x43, 0xf4,
    // 0x9e, 0xc6, 0xfa, 0x9b, 0x35, 0xf5, 0x0d, 0x52, 0xed, 0x05, 0xcb, 0xed, 0x4c, 0xc5, 0x92,
    // 0xe1, 0x3b, 0x44, 0x50, 0x1c, 0x1a, 0x22, 0x67]` — transcribed from the Rust source, not
    // re-derived from it, so this test is the only thing standing between a typo here and a
    // digest the deployed contract will never accept (found the hard way: a first cut of this
    // plugin used the npm package's generic `TransferAuthorizationTypes` preset instead of this
    // exact ERC-3009 type string, and reverted on-chain with `InvalidSignature`).
    const RUST_TYPEHASH_HEX =
      "7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267";
    const computed = computeTypeHash(
      "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
    );
    expect(Buffer.from(computed).toString("hex")).toBe(RUST_TYPEHASH_HEX);
  });
});

describe("CasperX402Plugin metadata (T11)", () => {
  it("declares rail=x402 and the two Casper networks", () => {
    const p = newPlugin();
    expect(p.rail).toBe("x402");
    expect(p.id).toBe("x402-casper");
    expect(p.networks).toEqual([CASPER_TESTNET_CAIP2, CASPER_MAINNET_CAIP2]);
  });
});

describe("convertCsprToMotes (T11)", () => {
  it("converts decimal CSPR into 9-decimal motes", () => {
    expect(convertCsprToMotes("0.01")).toBe("10000000"); // 0.01 CSPR × 10^9
    expect(convertCsprToMotes("1")).toBe("1");
    expect(convertCsprToMotes("1.000000001")).toBe("1000000001");
  });

  it("passes through pre-formatted smallest-unit strings unchanged", () => {
    expect(convertCsprToMotes("250000")).toBe("250000");
    expect(convertCsprToMotes("0")).toBe("0");
  });

  it("rejects more than 9 fractional digits (no silent truncation)", () => {
    expect(() => convertCsprToMotes("0.1234567890")).toThrow(/9 decimals/);
  });
});

describe("CasperX402Plugin.quote (T11)", () => {
  it("converts decimal CSPR into motes and surfaces the facilitator URL", async () => {
    const p = newPlugin();
    const q = await p.quote({
      skillId: "1",
      price: "0.01",
      asset: "",
      payTo: "account-hash-1111111111111111111111111111111111111111111111111111111111111111",
      network: CASPER_TESTNET_CAIP2,
    });
    expect(q.rail).toBe("x402");
    expect(q.network).toBe(CASPER_TESTNET_CAIP2);
    expect(q.price).toBe("10000000");
    expect(q.asset).toBe("KX402"); // default settlement-token symbol, not native CSPR
    expect(q.facilitatorUrl).toBe(FACILITATOR);
  });

  it("passes through a pre-formatted smallest-unit string", async () => {
    const p = newPlugin();
    const q = await p.quote({
      skillId: "1",
      price: "250000",
      asset: "",
      payTo: "x",
      network: CASPER_TESTNET_CAIP2,
    });
    expect(q.price).toBe("250000");
  });

  it("respects an explicit asset override", async () => {
    const p = newPlugin();
    const q = await p.quote({
      skillId: "1",
      price: "0.01",
      asset: "USDC",
      payTo: "x",
      network: CASPER_TESTNET_CAIP2,
    });
    expect(q.asset).toBe("USDC");
  });

  it("rejects an unsupported network", async () => {
    const p = newPlugin();
    await expect(
      p.quote({ skillId: "1", price: "0.01", asset: "", payTo: "x", network: "ethereum:1" }),
    ).rejects.toThrow(/unsupported network/);
  });
});

describe("CasperX402Plugin.pay (T11)", () => {
  const PAYEE = "account-hash-2222222222222222222222222222222222222222222222222222222222222222";

  it("returns a receipt with payer = derived Casper account-hash + facilitatorRef", async () => {
    const p = newPlugin();
    const receipt = await p.pay(
      { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-alpha" },
    );
    expect(receipt.rail).toBe("x402");
    expect(receipt.network).toBe(CASPER_TESTNET_CAIP2);
    expect(receipt.payer.startsWith("account-hash-")).toBe(true);
    expect(receipt.payer.slice("account-hash-".length)).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.amount).toBe("10000000");
    expect(receipt.asset).toBe("KX402");
    expect(receipt.facilitatorRef).toBe(FACILITATOR);
    // No rpcUrl configured on this plugin ⇒ signed but not settled: txHash absent, the signed
    // envelope's signature carried in `signature` instead (65 raw bytes ⇒ 130 hex chars) — not a
    // real chain hash (that's `settleOnChain`/`settleTransferWithAuthorization`'s job).
    expect(receipt.txHash).toBeUndefined();
    expect(receipt.signature).toMatch(/^[0-9a-f]{130}$/);
  });

  it("requires a settlement token to be configured before it will sign anything", async () => {
    const p = new CasperX402Plugin(FACILITATOR, () => TEST_KEYPAIR); // no settlementTokenPackageHash
    await expect(
      p.pay(
        { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: CASPER_TESTNET_CAIP2 },
        { agentId: "agent-alpha" },
      ),
    ).rejects.toThrow(/no settlement token configured/);
  });

  it("produces a signature that verifies against an independently rebuilt EIP-712 digest", async () => {
    // Lock the clock + nonce for a reproducible envelope.
    const NOW = 1_750_000_000;
    const NONCE = "ab".repeat(32);
    const p = newPlugin({ nowSecs: () => NOW, nonce: () => NONCE });
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-alpha" },
    );

    // Rebuild the digest from scratch using only the public `@casper-ecosystem/casper-eip-712`
    // API — deliberately NOT calling the plugin's own (unexported) digest builder, so this test
    // can catch a bug there too, not just in the sign/verify round-trip. Mirrors
    // `CEP3009::build_authorization_message` exactly: a fixed ERC-3009 typehash + manually
    // concatenated field encodings (NOT a type-definition-driven `hashStruct` — that was the
    // real bug an earlier version of this plugin had, confirmed by a live on-chain
    // `InvalidSignature` revert against the actually-deployed `X402SettlementToken`).
    const domain = buildDomain(
      "KARMA x402 Settlement Token",
      "1",
      "casper-test",
      FAKE_TOKEN_HASH.replace(/^hash-/, ""),
    );
    const typehash = computeTypeHash(
      "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
    );
    const encodedFrom = encodeAddress("0x00" + envelope.payload.from.replace(/^account-hash-/, ""));
    const encodedTo = encodeAddress("0x00" + envelope.payload.to.replace(/^account-hash-/, ""));
    const encodedStruct = new Uint8Array([
      ...encodedFrom,
      ...encodedTo,
      ...encodeUint256(BigInt(envelope.payload.value)),
      ...encodeUint64(envelope.payload.validAfter),
      ...encodeUint64(envelope.payload.validBefore),
      ...encodeBytes32("0x" + envelope.payload.nonce),
    ]);
    const digest = hashTypedDataRaw(domain, typehash, encodedStruct, { domainTypes: CASPER_DOMAIN_TYPES });

    const signatureBytes = Uint8Array.from(Buffer.from(envelope.signature, "hex"));
    expect(TEST_KEYPAIR.publicKey.verifySignature(digest, signatureBytes)).toBe(true);
    // A different key's public key must not verify the same signature/digest pair — casper-js-sdk
    // throws rather than returning false for a mismatched key (confirmed empirically above; see
    // the `try/catch` in `verifyCasperExactPayload` that handles this same behavior).
    expect(() => OTHER_KEYPAIR.publicKey.verifySignature(digest, signatureBytes)).toThrow();
  });

  it("rejects an unsupported network before touching the keystore", async () => {
    let calls = 0;
    const p = new CasperX402Plugin(FACILITATOR, () => {
      calls += 1;
      return TEST_KEYPAIR;
    });
    await expect(
      p.pay(
        { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: "ethereum:1" },
        { agentId: "agent-alpha" },
      ),
    ).rejects.toThrow(/unsupported network/);
    expect(calls).toBe(0); // fail-fast — no keystore access
  });

  it("propagates a not-found agent error from the lookup", async () => {
    const p = new CasperX402Plugin(
      FACILITATOR,
      () => {
        throw new Error("[KARMA] Agent not found in keystore: agent-zeta");
      },
      { settlementTokenPackageHash: FAKE_TOKEN_HASH },
    );
    await expect(
      p.pay(
        { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: CASPER_TESTNET_CAIP2 },
        { agentId: "agent-zeta" },
      ),
    ).rejects.toThrow(/not found/);
  });

  it("stamps a TTL window — validAfter = now - 60s skew grace, validBefore = validAfter + ttlSecs (default 5 min)", async () => {
    const NOW = 1_750_000_000;
    const p = newPlugin({ nowSecs: () => NOW, nonce: () => "cd".repeat(32) });
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-alpha" },
    );
    expect(envelope.payload.validAfter).toBe(NOW - 60);
    expect(envelope.payload.validBefore).toBe(NOW - 60 + 5 * 60);
  });

  it("P2-A: opts.rationale deterministically derives the nonce instead of using the random generator", async () => {
    const NOW = 1_750_000_000;
    let randomNonceCalls = 0;
    const p = newPlugin({ nowSecs: () => NOW, nonce: () => { randomNonceCalls += 1; return "ff".repeat(32); } });
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-alpha", rationale: "highest EV among eligible, rep 80 > threshold" },
    );
    expect(randomNonceCalls).toBe(0); // rationale present ⇒ random generator never called
    const expected = deriveRationaleNonce("highest EV among eligible, rep 80 > threshold", {
      from: envelope.payload.from,
      to: envelope.payload.to,
      value: envelope.payload.value,
      validAfter: envelope.payload.validAfter,
    });
    expect(envelope.payload.nonce).toBe(expected);
  });

  it("P2-A: no rationale ⇒ falls back to the random nonce generator (today's behaviour, unchanged)", async () => {
    const p = newPlugin({ nonce: () => "11".repeat(32) });
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-alpha" },
    );
    expect(envelope.payload.nonce).toBe("11".repeat(32));
  });
});

describe("deriveRationaleNonce (P2-A)", () => {
  const CTX = { from: "account-hash-" + "a".repeat(64), to: "account-hash-" + "b".repeat(64), value: "1000000", validAfter: 1_750_000_000 };

  it("is deterministic — same rationale + context always produces the same nonce", () => {
    expect(deriveRationaleNonce("buy the RWA feed, rep 80", CTX)).toBe(deriveRationaleNonce("buy the RWA feed, rep 80", CTX));
  });

  it("produces a 32-byte hex string (matches the nonce field's expected size)", () => {
    const n = deriveRationaleNonce("any rationale", CTX);
    expect(n).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when the rationale text differs (same context)", () => {
    expect(deriveRationaleNonce("reason A", CTX)).not.toBe(deriveRationaleNonce("reason B", CTX));
  });

  it("differs when the context differs (same rationale) — two payments never collide on a repeated rationale string", () => {
    const a = deriveRationaleNonce("same reason", CTX);
    const b = deriveRationaleNonce("same reason", { ...CTX, validAfter: CTX.validAfter + 1 });
    expect(a).not.toBe(b);
  });
});

describe("settleTransferWithAuthorization (T13-live)", () => {
  it("builds transfer_with_authorization args using the contract's real wire arg name (`value`, not `amount`)", async () => {
    const envelope: CasperX402SignedPayload = {
      x402Version: 2,
      scheme: "exact",
      network: CASPER_TESTNET_CAIP2,
      payload: {
        from: "account-hash-" + "a".repeat(64),
        to: "account-hash-" + "b".repeat(64),
        value: "5000000",
        validAfter: 1_750_000_000,
        validBefore: 1_750_000_300,
        nonce: "cd".repeat(32),
      },
      publicKeyHex: TEST_KEYPAIR.publicKey.toHex(),
      signature: Buffer.from(TEST_KEYPAIR.sign(new Uint8Array(32))).toString("hex"),
    };
    let capturedArgs: Map<string, unknown> | undefined;
    const fakeSubmitter = {
      putTransaction: async () => ({ transactionHash: { toHex: () => "ab".repeat(32) } }),
    };
    const { txHash } = await settleTransferWithAuthorization(
      fakeSubmitter,
      (args) => {
        capturedArgs = args.args as unknown as Map<string, unknown>;
        return args;
      },
      envelope,
    );
    expect(txHash).toBe("ab".repeat(32));
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.has("value")).toBe(true);
    expect(capturedArgs!.has("amount")).toBe(false);
    expect(capturedArgs!.has("valid_after")).toBe(true);
    expect(capturedArgs!.has("valid_before")).toBe(true);
  });
});

describe("CasperX402Plugin.verify (T11)", () => {
  const baseReceipt = {
    rail: "x402" as const,
    payer: `account-hash-${"a".repeat(64)}`,
    payee: `account-hash-${"b".repeat(64)}`,
    amount: "10000000",
    asset: "KX402",
    network: CASPER_TESTNET_CAIP2,
    facilitatorRef: FACILITATOR,
  };

  it("accepts a structurally well-formed receipt", async () => {
    const p = newPlugin();
    expect(await p.verify(baseReceipt)).toBe(true);
  });

  it("rejects a non-x402 rail", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, rail: "escrow" })).toBe(false);
  });

  it("rejects an unsupported network", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, network: "ethereum:1" })).toBe(false);
  });

  it("rejects a malformed Casper payer (must be account-hash-...)", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, payer: "02deadbeef" })).toBe(false);
  });

  it("rejects empty amount or payee", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, amount: "" })).toBe(false);
    expect(await p.verify({ ...baseReceipt, payee: "" })).toBe(false);
  });
});

describe("casperX402PaymentOption (T11)", () => {
  it("defaults to testnet / KX402", () => {
    expect(casperX402PaymentOption()).toEqual({
      rail: "x402",
      network: CASPER_TESTNET_CAIP2,
      asset: "KX402",
    });
  });

  it("respects the network override", () => {
    expect(casperX402PaymentOption(CASPER_MAINNET_CAIP2).network).toBe(CASPER_MAINNET_CAIP2);
  });
});

describe("payWithEnvelope + verifyCasperExactPayload — real crypto verification (T13-live)", () => {
  const verifyOpts = { settlementTokenPackageHash: FAKE_TOKEN_HASH };

  it("a freshly signed envelope verifies against the payee + network it was built for", async () => {
    const p = newPlugin();
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    expect(
      verifyCasperExactPayload(envelope, {
        ...verifyOpts,
        expectedPayee: envelope.payload.to,
        expectedNetwork: CASPER_TESTNET_CAIP2,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const p = newPlugin();
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    const tampered: CasperX402SignedPayload = {
      ...envelope,
      payload: { ...envelope.payload, value: "999999999" },
    };
    expect(verifyCasperExactPayload(tampered, verifyOpts)).toEqual({ ok: false, reason: "invalid signature" });
  });

  it("rejects a signature from a different key than the claimed publicKeyHex", async () => {
    const p = newPlugin();
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    const other = new CasperX402Plugin(FACILITATOR, () => OTHER_KEYPAIR, {
      settlementTokenPackageHash: FAKE_TOKEN_HASH,
    });
    const { envelope: otherEnvelope } = await other.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-b" },
    );
    const forged: CasperX402SignedPayload = { ...envelope, signature: otherEnvelope.signature };
    expect(verifyCasperExactPayload(forged, verifyOpts)).toEqual({ ok: false, reason: "invalid signature" });
  });

  it("rejects an expired envelope", async () => {
    const p = newPlugin({ nowSecs: () => 1_000, ttlSecs: 500 });
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    expect(verifyCasperExactPayload(envelope, { ...verifyOpts, nowSecs: 2_000 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects an envelope not yet valid", async () => {
    const p = newPlugin({ nowSecs: () => 10_000 });
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    expect(verifyCasperExactPayload(envelope, { ...verifyOpts, nowSecs: 0 })).toEqual({
      ok: false,
      reason: "not yet valid",
    });
  });

  it("rejects a payee mismatch", async () => {
    const p = newPlugin();
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    expect(
      verifyCasperExactPayload(envelope, { ...verifyOpts, expectedPayee: "account-hash-" + "ff".repeat(32) }),
    ).toEqual({ ok: false, reason: "payee mismatch" });
  });

  it("fails closed when no settlement token is configured to verify against", async () => {
    const p = newPlugin();
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    expect(verifyCasperExactPayload(envelope, {})).toEqual({
      ok: false,
      reason: "no settlement token configured to verify against",
    });
  });
});

describe("CasperX402SignedPayload shape (T11)", () => {
  it("is the type the demo flow stamps on `PAYMENT-SIGNATURE`", () => {
    // Compile-time check that the exported type covers the documented wire shape.
    const sample: CasperX402SignedPayload = {
      x402Version: 2,
      scheme: "exact",
      network: CASPER_TESTNET_CAIP2,
      payload: {
        from: "account-hash-0",
        to: "account-hash-1",
        value: "1",
        validAfter: 0,
        validBefore: 1,
        nonce: "00".repeat(32),
      },
      publicKeyHex: "02".repeat(34),
      signature: "01" + "de".repeat(64),
    };
    expect(sample.x402Version).toBe(2);
  });
});
