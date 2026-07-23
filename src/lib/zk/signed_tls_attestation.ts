/**
 * KARMA-signed TLS attestation (Casper RWA-oracle, T1.4 fallback per DP-2).
 *
 * Pragmatic substitute for live zk-TLS until tlsnotary ships a pure-Node prover (see
 * `docs/decisions/DP-2-zk-tls-framework.md` for the trade-off). Trust model: consumers
 * trust that KARMA's well-known signing key has not been compromised AND that the
 * KARMA-operated proxy honestly forwards the upstream response. Both assumptions are
 * weaker than a tlsnotary attestation; both are honestly disclosed.
 *
 * What the attestation binds:
 *   url           — the exact HTTPS URL fetched
 *   certSha256    — SHA256 of the peer certificate's DER bytes (cert pinning surface)
 *   bodySha256    — SHA256 of the raw response body
 *   body          — the full response body (utf8); consumers re-hash to detect MITM
 *   fetchedAt     — Unix-ms timestamp recorded by the prover at response-end
 *   signature     — ed25519 over `attestationDigest(...)` (see below)
 *   signerPubkey  — Stellar G-address shape (the canonical KARMA ed25519 pubkey)
 *
 * Verification is the inverse:
 *   1. Re-hash the body, compare against bodySha256 — catches mid-transit tamper.
 *   2. (Optionally) pin certSha256 against an expected fingerprint.
 *   3. Recompute attestationDigest from declared fields, verify signature.
 *
 * What the attestation DOES NOT bind:
 *   - The full TLS transcript (that's what zk-TLS would add — see DP-2 for the upgrade path).
 *   - The TLS handshake's session keys (so a future-leaked KARMA pubkey cannot retroactively
 *     impersonate a fetched response; the body is bound to the URL+cert+timestamp).
 */

import { createHash } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { URL } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";

export interface SignedAttestation {
  url: string;
  certSha256: string;
  bodySha256: string;
  body: string;
  fetchedAt: number;
  signature: string;
  signerPubkey: string;
}

/** Fields signed by the attestation. Body is included by-hash, not by-value, so the digest
 *  is fixed-size and the signature stays small regardless of response size. */
export interface AttestationFields {
  url: string;
  certSha256: string;
  bodySha256: string;
  fetchedAt: number;
}

/** Canonical digest the ed25519 signature commits to. Deterministic for fixed inputs so
 *  any auditor can recompute it independently of this library. */
export function attestationDigest(fields: AttestationFields): Buffer {
  // Canonical JSON ordering — keys sorted so an auditor's re-serialization matches.
  const canon = JSON.stringify({
    bodySha256: fields.bodySha256,
    certSha256: fields.certSha256,
    fetchedAt: fields.fetchedAt,
    url: fields.url,
  });
  return createHash("sha256").update(canon).digest();
}

/** Sign an already-fetched (url, certSha256, body, fetchedAt) tuple. Exposed for tests and
 *  for callers that want to do the HTTPS fetch via their own client. */
export function signAttestation(
  fields: AttestationFields & { body: string },
  signer: Keypair,
): SignedAttestation {
  const digest = attestationDigest(fields);
  const sig = signer.sign(digest);
  return {
    url: fields.url,
    certSha256: fields.certSha256,
    bodySha256: fields.bodySha256,
    body: fields.body,
    fetchedAt: fields.fetchedAt,
    signature: sig.toString("base64"),
    signerPubkey: signer.publicKey(),
  };
}

/** Verify an attestation against an optionally-pinned signer pubkey. Returns false on ANY
 *  validation failure (untrusted signer, body hash mismatch, signature mismatch). Never
 *  throws — callers branch on the boolean. */
export function verifyAttestation(
  env: SignedAttestation,
  opts: { expectedPubkey?: string; expectedCertSha256?: string } = {},
): boolean {
  if (opts.expectedPubkey && env.signerPubkey !== opts.expectedPubkey) return false;
  if (opts.expectedCertSha256 && env.certSha256 !== opts.expectedCertSha256) return false;

  const bodyHash = createHash("sha256").update(env.body).digest("hex");
  if (bodyHash !== env.bodySha256) return false;

  const digest = attestationDigest({
    url: env.url,
    certSha256: env.certSha256,
    bodySha256: env.bodySha256,
    fetchedAt: env.fetchedAt,
  });
  const sig = Buffer.from(env.signature, "base64");
  try {
    const kp = Keypair.fromPublicKey(env.signerPubkey);
    return kp.verify(digest, sig);
  } catch {
    return false;
  }
}

export interface FetchAndAttestOptions {
  /** Override default 10s HTTP timeout. */
  timeoutMs?: number;
  /** Optional extra headers; Host + User-Agent are always set. */
  headers?: Record<string, string>;
}

/** Live HTTPS fetch + immediate attestation. Captures the peer certificate's DER bytes
 *  via Node's `tls.TLSSocket.getPeerCertificate({raw: true})` so the cert fingerprint is
 *  bound into the digest BEFORE the body is signed. */
export async function fetchAndAttest(
  url: string,
  signer: Keypair,
  opts: FetchAndAttestOptions = {},
): Promise<SignedAttestation> {
  const u = new URL(url);
  if (u.protocol !== "https:") {
    throw new Error(`[karma:zk-tls] only https:// is attestable, got ${u.protocol}`);
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return await new Promise<SignedAttestation>((resolve, reject) => {
    let certSha256 = "";
    const reqOpts: RequestOptions = {
      method: "GET",
      hostname: u.hostname,
      port: u.port || 443,
      path: (u.pathname || "/") + (u.search || ""),
      headers: { Host: u.hostname, "User-Agent": "KARMA-signed-tls/1", ...(opts.headers || {}) },
      timeout: timeoutMs,
    };
    const req = httpsRequest(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const bodySha256 = createHash("sha256").update(body).digest("hex");
        const fetchedAt = Date.now();
        if (!certSha256) {
          reject(new Error("[karma:zk-tls] failed to capture peer certificate"));
          return;
        }
        resolve(signAttestation({ url, certSha256, bodySha256, body, fetchedAt }, signer));
      });
      res.on("error", reject);
    });
    req.on("socket", (sock) => {
      // `tls.TLSSocket` extends `Socket`; the `secureConnect` event fires once the TLS
      // handshake completes and the peer cert is available.
      sock.on("secureConnect", () => {
        // `as any` — getPeerCertificate is not exposed on the base Socket type.
        const cert = (sock as unknown as { getPeerCertificate(detailed?: boolean): { raw?: Buffer } })
          .getPeerCertificate(true);
        if (cert && cert.raw) {
          certSha256 = createHash("sha256").update(cert.raw).digest("hex");
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`[karma:zk-tls] timeout ${timeoutMs}ms fetching ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}
