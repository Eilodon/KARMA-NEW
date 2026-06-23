import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ReputationAggregationProof (T1.1) — TypeScript types + artifact loader.
 *
 * Mirrors the public surface of `circuits/src/reputation_aggregation.circom`. The actual prover
 * runs inside the circuits/ Node pipeline (snarkjs); this module is the typed bridge that
 * consumers (demos, MCP tools, Soroban submission scripts) use to load + reason about a
 * generated proof, without pulling snarkjs into every KARMA dependent's bundle.
 *
 * Use `loadAggregationArtifacts(buildDir, label)` after running the circuit test pipeline
 * (which produces `<label>.proof.json` + `<label>.public.json` + `verification_key.json`).
 * Use `parseAggregationPublicSignals(signals)` to recover the typed thresholds from a raw
 * 5-element signal vector.
 *
 * Public-signal convention (locked by the circuit):
 *   [ minTotal, minDistinctCategories, minJobs, nullifier, epochRoot ]
 *
 * The Soroban verifier in `contracts-soroban/agent_credential_verifier/src/lib.rs`
 * (`submit_aggregation_credential`) consumes the same vector in the same order — any drift
 * here breaks the on-chain consumer.
 */

/** A Groth16 proof in the snarkjs JSON shape. */
export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: "groth16";
  curve: "bn128";
}

/** A Groth16 verifying key in the snarkjs JSON shape. */
export interface Groth16VerifyingKey {
  protocol: "groth16";
  curve: "bn128";
  nPublic: number;
  vk_alpha_1: [string, string, string];
  vk_beta_2: [[string, string], [string, string], [string, string]];
  vk_gamma_2: [[string, string], [string, string], [string, string]];
  vk_delta_2: [[string, string], [string, string], [string, string]];
  vk_alphabeta_12: unknown;
  IC: Array<[string, string, string]>;
}

/** Typed view of the 5-element public-signal vector the aggregation circuit emits. */
export interface AggregationPublicSignals {
  /** Σ (score × jobCount) ≥ minTotal — the weighted aggregate threshold. */
  minTotal: bigint;
  /** Hardcoded N in circuit v1 (= 4). Public so a v2 "K of M" circuit keeps the same shape. */
  minDistinctCategories: bigint;
  /** Σ jobCount ≥ minJobs — engagement floor across the N categories. */
  minJobs: bigint;
  /** Poseidon(credentialSecret, epoch). Per-epoch replay key the Soroban verifier claims. */
  nullifier: string;
  /** Issuer-published Merkle root of `(agentCommit, category, score, jobCount)` leaves. */
  epochRoot: string;
}

/** Bundle of artifacts a verifier or on-chain consumer needs in one place. */
export interface AggregationArtifacts {
  proof: Groth16Proof;
  publicSignals: string[];           // raw vector — same order as the circuit's `public [...]`
  parsed: AggregationPublicSignals;  // typed view of the same data
  vk: Groth16VerifyingKey;
}

/** Pre-locked circuit constants (v1.0). Kept in sync with `reputation_aggregation.circom`. */
export const AGGREGATION_CIRCUIT_V1 = {
  /** Number of (category, score, jobCount) tuples a single proof aggregates. */
  N: 4,
  /** Merkle tree depth for the issuer-published epoch root. depth=8 ⇒ ≤ 256 leaves/epoch. */
  TREE_DEPTH: 8,
  /** Power of tau the trusted setup ceremony must satisfy. wires × 2 ≤ 2^POT_POWER. */
  POT_POWER: 16,
  /** Number of public signals — gates the Soroban consumer's `public_inputs.len()` check. */
  PUBLIC_INPUT_COUNT: 5,
} as const;

/** Field modulus of the BN254 scalar field. Signals are guaranteed to be < this. */
export const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Parse a snarkjs raw public-signal vector into the typed aggregation view. */
export function parseAggregationPublicSignals(signals: readonly string[]): AggregationPublicSignals {
  if (signals.length !== AGGREGATION_CIRCUIT_V1.PUBLIC_INPUT_COUNT) {
    throw new Error(
      `[rep-agg] expected ${AGGREGATION_CIRCUIT_V1.PUBLIC_INPUT_COUNT} public signals, got ${signals.length}`,
    );
  }
  for (const s of signals) {
    // Fail-loud on a non-decimal-string signal: snarkjs emits decimal-string field elements.
    if (!/^[0-9]+$/.test(s)) {
      throw new Error(`[rep-agg] public signal '${s}' is not a decimal string`);
    }
  }
  return {
    minTotal: BigInt(signals[0]),
    minDistinctCategories: BigInt(signals[1]),
    minJobs: BigInt(signals[2]),
    nullifier: signals[3],
    epochRoot: signals[4],
  };
}

/** Inverse of `parseAggregationPublicSignals`: marshal a typed view back into raw signals. */
export function unparseAggregationPublicSignals(p: AggregationPublicSignals): string[] {
  return [
    p.minTotal.toString(),
    p.minDistinctCategories.toString(),
    p.minJobs.toString(),
    p.nullifier,
    p.epochRoot,
  ];
}

/** Load the canonical artifact triple produced by `circuits/test/reputation_aggregation.test.mjs`.
 *  `label` matches the prefix the test used (defaults to "happy" — the always-present fixture). */
export function loadAggregationArtifacts(
  buildDir: string,
  label = "happy",
): AggregationArtifacts {
  // buildDir + filenames come from internal config / test-fixture paths, NOT user input.
  /* eslint-disable security/detect-non-literal-fs-filename */
  const proof = JSON.parse(readFileSync(join(buildDir, `${label}.proof.json`), "utf8")) as Groth16Proof;
  const publicSignals = JSON.parse(
    readFileSync(join(buildDir, `${label}.public.json`), "utf8"),
  ) as string[];
  const vk = JSON.parse(
    readFileSync(join(buildDir, "verification_key.json"), "utf8"),
  ) as Groth16VerifyingKey;
  /* eslint-enable security/detect-non-literal-fs-filename */
  return { proof, publicSignals, parsed: parseAggregationPublicSignals(publicSignals), vk };
}

/** Sanity-check the proof's JSON shape (cheap, no crypto). A full Groth16 verify needs snarkjs
 *  or the on-chain Soroban consumer — both costly to inline. This catches the obvious shape
 *  errors (missing fields, wrong protocol) without that cost. */
export function isWellFormedProof(p: unknown): p is Groth16Proof {
  if (typeof p !== "object" || p === null) return false;
  const x = p as Record<string, unknown>;
  if (x.protocol !== "groth16" || x.curve !== "bn128") return false;
  if (!Array.isArray(x.pi_a) || x.pi_a.length !== 3) return false;
  if (!Array.isArray(x.pi_b) || x.pi_b.length !== 3) return false;
  if (!Array.isArray(x.pi_c) || x.pi_c.length !== 3) return false;
  return true;
}

/** Same shape check for the verifying key — useful when a verifier loads vkey bytes from disk. */
export function isWellFormedVerifyingKey(k: unknown): k is Groth16VerifyingKey {
  if (typeof k !== "object" || k === null) return false;
  const x = k as Record<string, unknown>;
  return (
    x.protocol === "groth16" &&
    x.curve === "bn128" &&
    typeof x.nPublic === "number" &&
    Array.isArray(x.IC)
  );
}
