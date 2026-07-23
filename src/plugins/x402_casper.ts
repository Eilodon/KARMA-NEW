import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import casperSdk from "casper-js-sdk";
import type { PrivateKey as CasperKeypair, Args as CasperArgs } from "casper-js-sdk";
import {
  buildDomain,
  hashTypedDataRaw,
  computeTypeHash,
  encodeAddress,
  encodeUint256,
  encodeUint64,
  encodeBytes32,
  toHex,
  fromHex,
  CASPER_DOMAIN_TYPES,
} from "@casper-ecosystem/casper-eip-712";
import { keystoreManager } from "../lib/keystore.js";
import {
  casperAccountHash,
  casperPublicKeyHex,
} from "../lib/casper/keypair.js";
import type {
  IPaymentPlugin,
  PaymentOption,
  PaymentQuote,
  PaymentReceipt,
  PaymentRequest,
} from "../lib/payment/plugin.js";
const { PublicKey, Args, CLValue, CLTypeUInt8, Key, HttpHandler, RpcClient, ContractCallBuilder } = casperSdk;

/**
 * x402Plugin/Casper (T11) — IPaymentPlugin implementation for Casper's x402 fast lane.
 *
 * Wire-compatible with the official reference (`make-software/casper-x402` +
 * `casper-ecosystem/casper-eip-712`, both named on `casper.network/ai` as the AI Toolkit's x402
 * stack), not a bespoke scheme — see `docs/rfc/2026-07-21-x402-casper-eip712-interop.md` for the
 * field-by-field research trail this implementation is built from:
 *
 *   1. secp256k1 (not ed25519) — uses the Casper keypair already derived at keystore load (T10).
 *      The official reference is curve-agnostic (`KeyAlgorithmType`); secp256k1 was never the
 *      compatibility blocker, the wire format was.
 *   2. Settlement is a real CEP-18 token — `contracts-odra/src/x402_settlement_token.rs`, a
 *      wrapped-CSPR token composed from `odra-modules`' official `Cep18`+`CEP3009` modules (not a
 *      throwaway test asset). Native CSPR is 1:1-wrapped via that contract's `deposit`.
 *   3. The signed authorization is an EIP-712 `TransferWithAuthorization` struct — domain-separated
 *      by `{name, version: "1", chain_name, contract_package_hash}` per `CEP3009`'s own construction
 *      (`odra-modules-2.8.2/src/cep3009.rs::domain_separator` — read directly, not assumed). The
 *      struct's typehash is `CEP3009`'s own HARDCODED constant — computed from the literal
 *      ERC-3009-compatible type string `"TransferWithAuthorization(address from,address
 *      to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"`, NOT from the npm
 *      package's generic `TransferAuthorizationTypes` preset (that preset's type name, field
 *      casing, and field types don't match `CEP3009`'s real struct at all — confirmed the hard
 *      way: a first cut of this file used it, produced a digest the contract never signed, and
 *      reverted on-chain with `InvalidSignature` (37003) against the real deployed
 *      `X402SettlementToken`). Hashed via `hashTypedDataRaw` (typehash + manually-concatenated
 *      field encodings, matching `CEP3009::build_authorization_message` byte-for-byte, not a
 *      type-definition-driven `hashStruct`), signed with `PrivateKey.signAndAddAlgorithmBytes`
 *      (the same method the official JS client signer uses for "sign a 32-byte EIP-712 digest").
 *   4. `from`/`to` are `bytes32` fields in the struct, but their VALUE is
 *      `keccak256(tagByte ++ accountHash32Bytes)` (tag `0x00` = Account, `0x01` = Contract/Hash —
 *      `casper_types::KeyTag`), computed via `encodeAddress` BEFORE being placed in the message —
 *      confirmed against `odra-modules`'s own `eip712::encode_address` (not guessed from the npm
 *      package's docstring alone).
 */

/** Real CAIP-2 network ids (not the placeholder `casper:testnet` this plugin used before RFC
 *  2026-07-21's research) — matches `make-software/casper-x402`'s own `constants.ts`. */
export const CASPER_TESTNET_CAIP2 = "casper:casper-test";
export const CASPER_MAINNET_CAIP2 = "casper:casper";

const CASPER_NETWORKS: readonly string[] = [CASPER_TESTNET_CAIP2, CASPER_MAINNET_CAIP2];

const CSPR_DECIMALS = 9;
const DEFAULT_ASSET = "KX402";

/** Must match `contracts-odra/src/x402_settlement_token.rs`'s `TOKEN_NAME` exactly — it's part of
 *  the EIP-712 domain, so a mismatch here silently produces a digest the contract never signed. */
const SETTLEMENT_TOKEN_NAME = "KARMA x402 Settlement Token";
/** `CEP3009`'s hardcoded `DOMAIN_VERSION` — not configurable on the contract side, don't change. */
const DOMAIN_VERSION = "1";
/** `KeyTag::Account` (`casper-types` 6.1.0) — tags an `Address::Account` before the
 *  `encodeAddress` keccak256 step. `0x01` (`KeyTag::Hash`) would tag a contract address instead;
 *  every x402 payer/payee here is a keystore-held account, never a contract. */
const ACCOUNT_KEY_TAG = "00";

/** `CEP3009`'s own hardcoded EIP-712 typehash for `transfer_with_authorization` —
 *  `odra-modules-2.8.2/src/cep3009.rs`'s `TRANSFER_WITH_AUTHORIZATION_TYPEHASH` constant, computed
 *  from the literal ERC-3009 type string below (comment-verified in that same source file).
 *  Computing it here (rather than deriving it from a generic type-definitions object) matches how
 *  the contract itself builds it: a fixed constant, not something re-derived per call. Cross-checked
 *  byte-for-byte against the Rust constant in `src/__tests__/x402_casper.test.ts`. */
const TRANSFER_WITH_AUTHORIZATION_TYPE_STRING =
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
const TRANSFER_WITH_AUTHORIZATION_TYPEHASH = computeTypeHash(TRANSFER_WITH_AUTHORIZATION_TYPE_STRING);

/** Concatenate `Uint8Array`s — small enough not to need a dependency for it. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Signer-lookup seam — defaults to the real keystore, overridden in tests (same shape as T7). */
export type CasperKeypairLookup = (agentId: string) => CasperKeypair;

/** Convert a CSPR decimal string ("0.01") into motes ("10000000"). Pure — exported for tests +
 *  the e2e demo so callers can stamp `amount` consistently. Pre-formatted smallest-unit strings
 *  (no decimal point) pass through unchanged. */
export function convertCsprToMotes(price: string): string {
  if (!price.includes(".")) return price;
  const [intPart, fracRaw = ""] = price.split(".");
  if (fracRaw.length > CSPR_DECIMALS) {
    throw new Error(`[x402-casper] CSPR has ${CSPR_DECIMALS} decimals; got ${fracRaw.length} (${price})`);
  }
  const frac = fracRaw.padEnd(CSPR_DECIMALS, "0");
  const combined = `${intPart}${frac}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

/** Convert a 64-byte compact secp256k1 signature into DER — kept for callers that still need it
 *  (e.g. `demo_casper_e2e.ts`'s unrelated RWA price-feed signature); no longer part of the x402
 *  payment envelope's own signing path (that's EIP-712 + `signAndAddAlgorithmBytes` now). */
export function compactToDER(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) throw new Error(`[x402-casper] expected 64-byte compact sig, got ${sig.length}`);
  const r = sig.slice(0, 32);
  const s = sig.slice(32, 64);
  const asAsn1Int = (n: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < n.length - 1 && n[i] === 0) i += 1;
    const t = n.slice(i);
    return t[0] & 0x80 ? Uint8Array.from([0x00, ...t]) : t;
  };
  const rE = asAsn1Int(r);
  const sE = asAsn1Int(s);
  const body = Uint8Array.from([0x02, rE.length, ...rE, 0x02, sE.length, ...sE]);
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** `casper-hash-<hex>` → the bare 64-hex-char account hash `encodeAddress` expects to tag. Accepts
 *  with or without the `account-hash-` prefix `casperAccountHash()` returns. */
function bareAccountHashHex(prefixed: string): string {
  return prefixed.replace(/^account-hash-/, "");
}

/** EIP-712 `bytes32` encoding of a Casper account address: `keccak256(0x00 ++ accountHash)`.
 *  NOT the raw account hash — `TransferAuthorization.from`/`.to` are typed `bytes32` (pass-through
 *  in the EIP-712 encoder), so the tag+keccak256 step has to happen here, on the caller's side,
 *  exactly like `CEP3009`'s own `eip712::encode_address` does on-chain before it ever reaches the
 *  "bytes32" struct-field encoding. */
export function encodeCasperAccountForEip712(accountHashPrefixed: string): string {
  return toHex(encodeAddress("0x" + ACCOUNT_KEY_TAG + bareAccountHashHex(accountHashPrefixed)));
}

/** Wire-format "exact" payment authorization — the EIP-712-signed struct, matching
 *  `make-software/casper-x402`'s `ExactCasperAuthorization` field names/units exactly
 *  (`validAfter`/`validBefore` in **seconds**, not this plugin's old milliseconds). */
export interface CasperExactAuthorization {
  /** Payer account-hash, `account-hash-<hex>` prefixed (display form — the signed struct itself
   *  carries the EIP-712-encoded form, see `encodeCasperAccountForEip712`). */
  from: string;
  to: string;
  /** Atomic token amount (settlement-token units, 9 decimals — motes-equivalent), decimal string. */
  value: string;
  /** Unix seconds — authorization not valid at or before this instant. */
  validAfter: number;
  /** Unix seconds — authorization expires at or after this instant. */
  validBefore: number;
  /** 32-byte hex nonce (random per `pay()` call), no `0x` prefix. */
  nonce: string;
}

/** Signed payload — what travels in the `PAYMENT-SIGNATURE` header to the resource server /
 *  facilitator. `x402Version: 2` matches the official reference's current wire version. */
export interface CasperX402SignedPayload {
  x402Version: 2;
  scheme: "exact";
  network: string;
  payload: CasperExactAuthorization;
  publicKeyHex: string;
  /** 65-byte Casper-native signature (`[1 algorithm byte | 64 raw bytes]`) over the EIP-712
   *  digest, hex string. NOT DER — the official reference's on-chain verifier expects this exact
   *  tagged form (`casper_types::PublicKey`-paired `verify_signature`), not an ASN.1 envelope. */
  signature: string;
}

/** Random hex nonce. Exposed for tests / determinism overrides. */
export function makeNonce(rng: () => Uint8Array = () => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}): string {
  return Buffer.from(rng()).toString("hex");
}

/** P2-A (fast-lane variant): a deterministic 32-byte nonce derived from an LLM/agent's decision
 *  rationale, for when a payment has no `AgentSkillRegistry` job to hang `attest_rationale` off
 *  (this plugin's payWithEnvelope IS the whole transaction — there's no job id). Repurposes
 *  CEP-3009's `nonce` field — already an arbitrary 32 bytes from the contract's perspective, and
 *  already recorded verbatim in the on-chain transaction args once settled — as a public,
 *  independently-checkable commitment to WHY the payment was made, with ZERO changes to the
 *  official CEP-3009 interface (a bespoke extra field would reopen exactly the interop gap RFC
 *  2026-07-21 closed). `context` folds in the payment's own from/to/value/validAfter alongside
 *  the rationale text so two byte-identical rationale strings for two DIFFERENT payments still
 *  produce distinct nonces — the only thing a bare `hash(rationale)` would collide on is the
 *  exact same rationale, payer, payee, value, and second, which `CEP3009`'s own per-authorizer
 *  nonce-reuse check (`authorization_state`) would reject as a replay anyway. */
export function deriveRationaleNonce(
  rationale: string,
  context: { from: string; to: string; value: string; validAfter: number },
): string {
  return createHash("sha256")
    .update(rationale)
    .update(context.from)
    .update(context.to)
    .update(context.value)
    .update(String(context.validAfter))
    .digest("hex");
}

export interface CasperX402PluginOptions {
  /** TTL for a built payment payload, in seconds. Defaults to 5 min, the de-facto x402 ceiling. */
  ttlSecs?: number;
  /** Nonce generator — override in tests for determinism. */
  nonce?: () => string;
  /** Clock (unix seconds) — override in tests. */
  nowSecs?: () => number;
  /** `X402SettlementToken` contract package hash (`hash-<hex>` or bare hex), the EIP-712 domain's
   *  `contract_package_hash` and the token `transfer_with_authorization` is submitted against.
   *  Falls back to `KARMA_X402_CASPER_SETTLEMENT_TOKEN` env var; required to actually settle
   *  on-chain (signing still works without it — only `settleTransferWithAuthorization` needs it). */
  settlementTokenPackageHash?: string;
  /** Casper node RPC URL. Falls back to `CASPER_RPC_URL` env var (same var the escrow-rail tools
   *  use, see `casper.tool.ts`'s `requireCasperEnv`). Unset ⇒ `payWithEnvelope` signs the
   *  authorization but does NOT submit it on-chain (today's behaviour) — `receipt.txHash` stays
   *  absent and `receipt.signature` carries the off-chain authorization instead. */
  rpcUrl?: string;
  /** CAIP-2 chain name stamped on the settlement transaction. Falls back to `CASPER_CHAIN_NAME`
   *  env var, then `"casper-test"` — must match the deployed token's own `init(chain_name)`. */
  chainName?: string;
  /** Casper `Authorization` header for the RPC node (CSPR.cloud-style gated endpoints). Falls
   *  back to `CASPER_RPC_API_KEY` env var. */
  rpcApiKey?: string;
  /** Payment (gas) ceiling in motes for the settlement transaction itself — distinct from the
   *  `value` being transferred. Default matches the value proven against the live deployed
   *  contract in `demo_casper_x402_settlement_live.ts` (5 CSPR; `transfer_with_authorization`'s
   *  real cost is far lower, this is a ceiling, unused gas is refunded). */
  settlementPaymentMotes?: string;
}

export class CasperX402Plugin implements IPaymentPlugin {
  readonly id = "x402-casper";
  readonly rail = "x402" as const;
  readonly networks = CASPER_NETWORKS;
  private readonly lookup: CasperKeypairLookup;
  private readonly ttlSecs: number;
  private readonly nonce: () => string;
  private readonly nowSecs: () => number;
  private readonly settlementTokenPackageHash?: string;
  private readonly rpcUrl?: string;
  private readonly chainName: string;
  private readonly rpcApiKey?: string;
  private readonly settlementPaymentMotes: string;

  constructor(
    private readonly facilitatorUrl: string,
    lookup: CasperKeypairLookup = (agentId) => keystoreManager.getCasperKeypair(agentId),
    opts: CasperX402PluginOptions = {},
  ) {
    this.lookup = lookup;
    this.ttlSecs = opts.ttlSecs ?? 5 * 60;
    this.nonce = opts.nonce ?? makeNonce;
    this.nowSecs = opts.nowSecs ?? (() => Math.floor(Date.now() / 1000));
    this.settlementTokenPackageHash =
      opts.settlementTokenPackageHash ?? process.env.KARMA_X402_CASPER_SETTLEMENT_TOKEN;
    this.rpcUrl = opts.rpcUrl ?? process.env.CASPER_RPC_URL;
    this.chainName = opts.chainName ?? process.env.CASPER_CHAIN_NAME ?? "casper-test";
    this.rpcApiKey = opts.rpcApiKey ?? process.env.CASPER_RPC_API_KEY;
    this.settlementPaymentMotes = opts.settlementPaymentMotes ?? "5000000000";
  }

  async quote(req: PaymentRequest): Promise<PaymentQuote> {
    if (!this.networks.includes(req.network)) {
      throw new Error(`[x402-casper] unsupported network ${req.network}`);
    }
    return {
      rail: this.rail,
      network: req.network,
      asset: req.asset || DEFAULT_ASSET,
      price: convertCsprToMotes(req.price),
      facilitatorUrl: this.facilitatorUrl,
    };
  }

  async pay(req: PaymentRequest, opts: { agentId: string }): Promise<PaymentReceipt> {
    return (await this.payWithEnvelope(req, opts)).receipt;
  }

  /**
   * Same as `pay()`, but also returns the full signed envelope — `PaymentReceipt` (the shared
   * `IPaymentPlugin` shape) only carries `signature` through `txHash`, dropping `validAfter` /
   * `validBefore` / `nonce`, so a resource server can't reconstruct the authorization from a
   * receipt alone. Callers that need to actually verify the payment (not just self-check its
   * shape) — e.g. the `PAYMENT-SIGNATURE` header a provider receives — want this method instead.
   */
  async payWithEnvelope(
    req: PaymentRequest,
    opts: {
      agentId: string;
      /** P2-A: an LLM/agent's plain-English reason for making this payment. When set, the nonce
       *  is deterministically derived from it (`deriveRationaleNonce`) instead of random — a
       *  third party holding this same string can independently recompute the nonce and confirm
       *  it matches what actually got submitted on-chain (see settleOnChain /
       *  settleTransferWithAuthorization). Purely a KARMA-side commitment scheme; never sent to
       *  the facilitator or the contract as its own field. */
      rationale?: string;
    },
  ): Promise<{ receipt: PaymentReceipt; envelope: CasperX402SignedPayload }> {
    if (!this.networks.includes(req.network)) {
      throw new Error(`[x402-casper] unsupported network ${req.network}`);
    }
    if (!this.settlementTokenPackageHash) {
      throw new Error(
        "[x402-casper] no settlement token configured — set KARMA_X402_CASPER_SETTLEMENT_TOKEN " +
          "or pass settlementTokenPackageHash (see contracts-odra/src/x402_settlement_token.rs)",
      );
    }
    const keypair = this.lookup(opts.agentId);
    const payer = casperAccountHash(keypair);
    const pubHex = casperPublicKeyHex(keypair);
    const amount = convertCsprToMotes(req.price);

    const validAfter = this.nowSecs() - 60; // 60s clock-skew grace, mirrors the official client's -10min (scaled to this plugin's shorter default TTL)
    const validBefore = validAfter + this.ttlSecs;
    const nonceHex = opts.rationale
      ? deriveRationaleNonce(opts.rationale, { from: payer, to: req.payTo, value: amount, validAfter })
      : this.nonce();

    const { digest } = buildTransferAuthorizationDigest({
      settlementTokenPackageHash: this.settlementTokenPackageHash,
      from: payer,
      to: req.payTo,
      value: amount,
      validAfter,
      validBefore,
      nonceHex,
    });

    const signature = keypair.signAndAddAlgorithmBytes(digest);

    const payload: CasperExactAuthorization = {
      from: payer,
      to: req.payTo,
      value: amount,
      validAfter,
      validBefore,
      nonce: nonceHex,
    };
    const signedEnvelope: CasperX402SignedPayload = {
      x402Version: 2,
      scheme: "exact",
      network: req.network,
      payload,
      publicKeyHex: pubHex,
      signature: Buffer.from(signature).toString("hex"),
    };
    const receipt: PaymentReceipt = {
      rail: this.rail,
      payer,
      payee: req.payTo,
      amount,
      asset: req.asset || DEFAULT_ASSET,
      network: req.network,
      facilitatorRef: this.facilitatorUrl,
      // Off-chain authorization signature — NOT a chain hash. Superseded by a real `txHash`
      // below when `rpcUrl` is configured and settlement succeeds.
      signature: signedEnvelope.signature,
    };

    if (this.rpcUrl) {
      try {
        receipt.txHash = await this.settleOnChain(keypair, signedEnvelope);
      } catch (err) {
        receipt.settlementError = err instanceof Error ? err.message : String(err);
      }
    }

    return { receipt, envelope: signedEnvelope };
  }

  /** Builds + signs + broadcasts the real `transfer_with_authorization` call against the
   *  deployed `X402SettlementToken` — the same call `settleTransferWithAuthorization` (the
   *  free function below) makes, wired here so `payWithEnvelope` can self-relay without every
   *  caller having to wire an `RpcClient` + transaction builder by hand. Self-relayed by the
   *  SAME keypair that signed the authorization (proven safe in
   *  `demo_casper_x402_settlement_live.ts` — the signature, not the tx's outer signer, is what
   *  authorizes the transfer, so any account, including the payer's own, may submit it). Returns
   *  only once the transaction is BROADCAST, not once a block confirms it — mirrors the escrow
   *  rail's own "pending until confirmed" contract (see `casper_get_x402_settlement_status` to
   *  poll for the real outcome). */
  private async settleOnChain(
    keypair: CasperKeypair,
    envelope: CasperX402SignedPayload,
  ): Promise<string> {
    if (!this.rpcUrl) throw new Error("[x402-casper] settleOnChain called without rpcUrl configured");
    const handler = new HttpHandler(this.rpcUrl);
    if (this.rpcApiKey) handler.setCustomHeaders({ Authorization: this.rpcApiKey });
    const rpc = new RpcClient(handler);
    const bareTokenHash = bareHash(this.settlementTokenPackageHash!);
    const chainName = this.chainName;
    const paymentMotes = this.settlementPaymentMotes;
    const { txHash } = await settleTransferWithAuthorization(
      rpc,
      (args) => {
        const tx = new ContractCallBuilder()
          .from(keypair.publicKey)
          .byPackageHash(bareTokenHash)
          .entryPoint("transfer_with_authorization")
          .runtimeArgs(args)
          .chainName(chainName)
          .payment(Number(paymentMotes))
          .build();
        tx.sign(keypair);
        return tx;
      },
      envelope,
    );
    return txHash;
  }

  /** Structural self-check only (shared `IPaymentPlugin` contract — receipts from every chain
   *  round-trip through this). Does NOT verify the cryptographic signature: `PaymentReceipt`
   *  doesn't carry `validAfter`/`validBefore`/`nonce`, so there's nothing to re-derive the
   *  authorization from. A resource server verifying a real `PAYMENT-SIGNATURE` header should use
   *  `verifyCasperExactPayload` against the full envelope instead. */
  async verify(receipt: PaymentReceipt): Promise<boolean> {
    if (receipt.rail !== this.rail) return false;
    if (!this.networks.includes(receipt.network)) return false;
    if (!receipt.payer.startsWith("account-hash-")) return false;
    if (!receipt.payee || !receipt.amount) return false;
    return true;
  }
}

export type CasperExactPayloadVerdict = { ok: true } | { ok: false; reason: string };

/** Rebuilds the exact EIP-712 digest a `payWithEnvelope` call signed, given the settlement
 *  token's package hash and the authorization fields. Shared by the signer (`payWithEnvelope`)
 *  and the verifier (`verifyCasperExactPayload`) so the two can never drift.
 *
 *  Mirrors `CEP3009::build_authorization_message` field-for-field (typehash ++ from ++ to ++
 *  value ++ valid_after ++ valid_before ++ nonce, concatenated raw — NOT a type-definition-driven
 *  `hashStruct`), since that's how the contract itself builds it. */
function buildTransferAuthorizationDigest(args: {
  settlementTokenPackageHash: string;
  from: string;
  to: string;
  value: string;
  validAfter: number;
  validBefore: number;
  nonceHex: string;
}): { digest: Uint8Array } {
  const domain = buildDomain(
    SETTLEMENT_TOKEN_NAME,
    DOMAIN_VERSION,
    domainChainName,
    bareHash(args.settlementTokenPackageHash),
  );
  const encodedStruct = concatBytes(
    fromHex(encodeCasperAccountForEip712(args.from)),
    fromHex(encodeCasperAccountForEip712(args.to)),
    encodeUint256(BigInt(args.value)),
    encodeUint64(args.validAfter),
    encodeUint64(args.validBefore),
    encodeBytes32("0x" + args.nonceHex),
  );
  const digest = hashTypedDataRaw(domain, TRANSFER_WITH_AUTHORIZATION_TYPEHASH, encodedStruct, {
    domainTypes: CASPER_DOMAIN_TYPES,
  });
  return { digest };
}

/** `hash-<hex>` / `contract-package-wasm<hex>` → bare 64-char hex, matching `contract_package_hash`'s
 *  raw-bytes32 domain encoding (NOT run through `encodeAddress` — confirmed against
 *  `odra-modules`'s `domain_separator`, which uses `contract_address.value()` directly). */
function bareHash(hash: string): string {
  return hash.replace(/^(hash-|contract-package-wasm|contract-)/, "");
}

/** `CEP3009`'s domain `chain_name` — the CAIP-2 chain id set on `X402SettlementToken::init`.
 *  Fixed per deployment (this plugin only ever runs against one deployed settlement token), so
 *  it's a constant rather than a per-call parameter. Matches the chain the demo/deploy scripts
 *  actually initialized the contract with. */
const domainChainName = process.env.CASPER_CHAIN_NAME ?? "casper-test";

/**
 * The real, cryptographic check a resource server (or a self-hosted facilitator, same pattern
 * DEMO_STELLAR.md's provider stub uses for the Stellar rail) runs against a received
 * `PAYMENT-SIGNATURE` envelope: signature validity, expiry window, and (optionally) the expected
 * payee. Pure — no network calls.
 */
export function verifyCasperExactPayload(
  envelope: CasperX402SignedPayload,
  opts: { expectedPayee?: string; expectedNetwork?: string; nowSecs?: number; settlementTokenPackageHash?: string } = {},
): CasperExactPayloadVerdict {
  const nowSecs = opts.nowSecs ?? Math.floor(Date.now() / 1000);
  const settlementTokenPackageHash = opts.settlementTokenPackageHash ?? process.env.KARMA_X402_CASPER_SETTLEMENT_TOKEN;
  if (envelope.scheme !== "exact") return { ok: false, reason: "unsupported scheme" };
  if (opts.expectedNetwork && envelope.network !== opts.expectedNetwork) {
    return { ok: false, reason: "network mismatch" };
  }
  if (opts.expectedPayee && envelope.payload.to !== opts.expectedPayee) {
    return { ok: false, reason: "payee mismatch" };
  }
  if (nowSecs <= envelope.payload.validAfter) return { ok: false, reason: "not yet valid" };
  if (nowSecs >= envelope.payload.validBefore) return { ok: false, reason: "expired" };
  if (!settlementTokenPackageHash) return { ok: false, reason: "no settlement token configured to verify against" };

  const { digest } = buildTransferAuthorizationDigest({
    settlementTokenPackageHash,
    from: envelope.payload.from,
    to: envelope.payload.to,
    value: envelope.payload.value,
    validAfter: envelope.payload.validAfter,
    validBefore: envelope.payload.validBefore,
    nonceHex: envelope.payload.nonce,
  });
  let pubKey: InstanceType<typeof PublicKey>;
  let validSig: boolean;
  try {
    pubKey = PublicKey.fromHex(envelope.publicKeyHex);
    const signatureBytes = Uint8Array.from(Buffer.from(envelope.signature, "hex"));
    // casper-js-sdk's `verifySignature` THROWS ("invalid signature") on a mismatched
    // signature/digest/key rather than returning false — confirmed empirically, not assumed
    // from its (misleading) `boolean` return type.
    validSig = pubKey.verifySignature(digest, signatureBytes);
  } catch {
    return { ok: false, reason: "invalid signature" };
  }
  if (!validSig) return { ok: false, reason: "invalid signature" };
  const derivedPayer = pubKey.accountHash().toPrefixedString();
  if (derivedPayer !== envelope.payload.from) return { ok: false, reason: "signature does not match declared payer" };
  return { ok: true };
}

/**
 * Submits the verified authorization on-chain — the settlement step `payWithEnvelope` deliberately
 * doesn't do (signing and settling are different responsibilities; a facilitator settles, a payer
 * signs). Calls `X402SettlementToken::transfer_with_authorization` directly with the same
 * `submitPayable`/`submit` pattern `live_client.ts` uses for every other Odra entry point — any
 * account may relay (the signature, not the caller, authorizes the transfer).
 *
 * Not gated on the official `make-software/casper-x402` facilitator being live: KARMA settles
 * against its own deployed `X402SettlementToken` directly, which is what actually proves
 * "real EIP-712 signing + real on-chain settlement," independent of a third-party service's
 * uptime (see RFC 2026-07-21 §7/§8).
 */
export async function settleTransferWithAuthorization(
  submitter: { putTransaction(tx: unknown): Promise<{ transactionHash: { toHex(): string } }> },
  buildTransaction: (args: CasperArgs) => unknown,
  envelope: CasperX402SignedPayload,
): Promise<{ txHash: string }> {
  const args = Args.fromMap({
    from: CLValue.newCLKey(Key.newKey(envelope.payload.from)),
    to: CLValue.newCLKey(Key.newKey(envelope.payload.to)),
    // Matches `transfer_with_authorization`'s real Rust parameter name (`value: U256`, per
    // `contracts-odra/src/x402_settlement_token.rs`'s `delegate!` block) — NOT `amount`.
    // Confirmed the hard way: an earlier `amount` here reverted on-chain with Odra's
    // `MissingArg` (code 64658 = 64536 + 122), since Odra's arg binding is exact-name-matched.
    value: CLValue.newCLUInt256(envelope.payload.value),
    valid_after: CLValue.newCLUint64(envelope.payload.validAfter.toString()),
    valid_before: CLValue.newCLUint64(envelope.payload.validBefore.toString()),
    nonce: CLValue.newCLList(CLTypeUInt8, Array.from(fromHex(envelope.payload.nonce)).map((b) => CLValue.newCLUint8(b))),
    public_key: CLValue.newCLPublicKey(PublicKey.fromHex(envelope.publicKeyHex)),
    signature: CLValue.newCLList(
      CLTypeUInt8,
      Array.from(Buffer.from(envelope.signature, "hex")).map((b) => CLValue.newCLUint8(b)),
    ),
  });
  const tx = buildTransaction(args);
  const result = await submitter.putTransaction(tx);
  return { txHash: result.transactionHash.toHex() };
}

/** Recommended payment option entry for a Casper-friendly skill's `register_skill` payload. */
export function casperX402PaymentOption(network: string = CASPER_TESTNET_CAIP2): PaymentOption {
  return {
    rail: "x402",
    network,
    asset: DEFAULT_ASSET,
  };
}
