/**
 * TypeScript prover wrapper for ReputationAggregationProof (Stellar ZK track, T1.1).
 *
 * Agent-side library: takes a slice of the agent's job history + chosen threshold gates,
 * builds the Merkle witness, computes the per-epoch nullifier, and generates a Groth16
 * proof via snarkjs. Output is wire-ready for the Soroban verifier
 * (`reputation_aggregation_verifier::submit_proof`).
 *
 * Two concerns are deliberately separated:
 *   1. The CIRCUIT defines what's *provable* (per-tuple Merkle membership, sort order,
 *      aggregate gates). See `circuits/src/reputation_aggregation.circom`.
 *   2. THIS MODULE defines how *the agent prepares inputs*: ordering, padding, leaf hash,
 *      nullifier derivation. It is pure — same (history, secret, epoch, gates) always
 *      yields the same proof's public signals — so a prover service can be re-run
 *      independently by any auditor.
 *
 * The CIRCUIT_N = 8 / CIRCUIT_DEPTH = 8 constants MUST match the circuit's
 * `component main = ReputationAggregation(8, 8)`. Bumping the circuit shape requires a
 * coordinated bump here (and a new trusted setup ceremony — kept disjoint per
 * docs/decisions/DP-7).
 */

import { readFileSync } from "node:fs";

/** One row in the agent's reputation history (already aggregated by (provider, category)). */
export interface RepAggTuple {
  /** Issuer-assigned provider id; any field element fits BN254 scalar (< ~2^254). */
  providerId: bigint | number;
  /** Skill category id; MUST be >= 1 for real tuples (0 is the padding sentinel). */
  categoryId: number;
  /** Average score across the (provider, category) cell — integer in [0, 100]. */
  score: number;
  /** Job count under the (provider, category) cell — integer in [0, 2^16). */
  jobCount: number;
}

export interface RepAggThresholds {
  /** Required weighted-average score: sum(score*jobCount) >= minAvgScore * totalJobs. */
  minAvgScore: number;
  /** Required distinct-category breadth. */
  minDistinctCategories: number;
  /** Required minimum total job count. */
  minJobs: number;
}

export interface RepAggIdentity {
  /** Agent's private secret; same secret across epochs is fine — nullifier domain-separates. */
  agentSecret: bigint;
  /** Epoch label the proof binds to; MUST match the epoch whose root is on-chain. */
  epoch: bigint;
}

export interface RepAggInputs extends RepAggThresholds, RepAggIdentity {
  /** Real tuples (1..CIRCUIT_N). The wrapper sorts ascending by categoryId before witness gen. */
  tuples: RepAggTuple[];
}

export interface RepAggArtifacts {
  /** Path to `reputation_aggregation.wasm` (witness calculator). */
  wasmPath: string;
  /** Path to `reputation_aggregation_0001.zkey` (proving key). */
  zkeyPath: string;
}

export interface RepAggProof {
  /** Raw snarkjs Groth16 proof object. */
  proof: unknown;
  /** Public signals in circuit order: [minAvgScore, minDistinctCategories, minJobs, nullifier, epochRoot]. */
  publicSignals: string[];
  /** Per-epoch nullifier = Poseidon(agentSecret, epoch) — used as the on-chain replay key. */
  nullifier: string;
  /** Issuer-published Merkle root the proof is bound to. */
  epochRoot: string;
}

/** Circuit shape constants — MUST match circuits/src/reputation_aggregation.circom. */
export const CIRCUIT_N = 8;
export const CIRCUIT_DEPTH = 8;

/** Leaf shape: leaf = Poseidon(providerId, categoryId, score, jobCount). Exposed so an
 *  independent indexer can rebuild epochRoot from on-chain JobCompleted events without
 *  reimplementing the convention. */
export async function repAggLeaf(
  poseidon: PoseidonFn,
  F: PoseidonField,
  t: RepAggTuple,
): Promise<bigint> {
  const h = poseidon([
    BigInt(t.providerId),
    BigInt(t.categoryId),
    BigInt(t.score),
    BigInt(t.jobCount),
  ]);
  return F.toObject(h);
}

/** Build a depth-D sparse Merkle tree of `leaves` (zero-padded to 2^D), using Poseidon(2). */
export function buildEpochTree(
  poseidon: PoseidonFn,
  F: PoseidonField,
  depth: number,
  leaves: readonly bigint[],
): { root: string; levels: string[][] } {
  const size = 2 ** depth;
  if (leaves.length > size) {
    throw new Error(`[karma:zk] too many leaves ${leaves.length} for depth ${depth} (max ${size})`);
  }
  let level: bigint[] = new Array<bigint>(size).fill(0n);
  for (let i = 0; i < leaves.length; i++) level[i] = leaves[i];
  const levels: string[][] = [level.map((x) => x.toString())];
  for (let d = 0; d < depth; d++) {
    const next: bigint[] = new Array<bigint>(level.length / 2);
    for (let i = 0; i < next.length; i++) {
      next[i] = F.toObject(poseidon([level[2 * i], level[2 * i + 1]]));
    }
    levels.push(next.map((x) => x.toString()));
    level = next;
  }
  return { root: level[0].toString(), levels };
}

/** Merkle path for the leaf at `leafIndex` against a tree returned by `buildEpochTree`. */
export function pathFor(
  levels: string[][],
  leafIndex: number,
  depth: number,
): { elements: string[]; indices: number[] } {
  const elements: string[] = [];
  const indices: number[] = [];
  let idx = leafIndex;
  for (let d = 0; d < depth; d++) {
    const isRight = idx & 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    elements.push(levels[d][siblingIdx]);
    indices.push(isRight);
    idx >>= 1;
  }
  return { elements, indices };
}

/** Stable sort of real tuples ascending by categoryId — matches the circuit's packing convention. */
function sortTuples(tuples: readonly RepAggTuple[]): RepAggTuple[] {
  return [...tuples].sort((a, b) => a.categoryId - b.categoryId);
}

/** Sanity gates the wrapper enforces BEFORE asking snarkjs — so the agent gets a clear
 *  error message instead of an opaque witness-gen failure deep in the circuit. */
function preflight(inputs: RepAggInputs): void {
  if (inputs.tuples.length === 0) throw new Error("[karma:zk] tuples is empty");
  if (inputs.tuples.length > CIRCUIT_N) {
    throw new Error(`[karma:zk] too many tuples ${inputs.tuples.length} > N=${CIRCUIT_N}`);
  }
  for (const [i, t] of inputs.tuples.entries()) {
    if (t.categoryId < 1) throw new Error(`[karma:zk] tuple[${i}].categoryId must be >= 1 (0 = padding sentinel)`);
    if (t.score < 0 || t.score > 100) throw new Error(`[karma:zk] tuple[${i}].score out of [0,100]: ${t.score}`);
    if (t.jobCount < 0 || t.jobCount >= 65536) {
      throw new Error(`[karma:zk] tuple[${i}].jobCount out of [0,2^16): ${t.jobCount}`);
    }
  }
  if (inputs.minAvgScore < 0 || inputs.minAvgScore > 100) {
    throw new Error(`[karma:zk] minAvgScore out of [0,100]: ${inputs.minAvgScore}`);
  }
  if (inputs.minDistinctCategories < 0 || inputs.minDistinctCategories > CIRCUIT_N) {
    throw new Error(`[karma:zk] minDistinctCategories out of [0,N=${CIRCUIT_N}]`);
  }
  if (inputs.minJobs < 0) throw new Error(`[karma:zk] minJobs negative: ${inputs.minJobs}`);
}

/** Marshal an RepAggInputs into the raw signal map snarkjs.wtns.calculate expects.
 *  Pure + synchronous given a poseidon — exposed so prover services can pre-build
 *  fixtures without depending on snarkjs. */
export function buildCircuitInput(
  poseidon: PoseidonFn,
  F: PoseidonField,
  inputs: RepAggInputs,
): {
  signals: Record<string, string | string[] | string[][]>;
  nullifier: string;
  epochRoot: string;
} {
  preflight(inputs);

  const sorted = sortTuples(inputs.tuples);
  const realLeaves = sorted.map((t) => {
    const h = poseidon([
      BigInt(t.providerId),
      BigInt(t.categoryId),
      BigInt(t.score),
      BigInt(t.jobCount),
    ]);
    return F.toObject(h);
  });
  const { root, levels } = buildEpochTree(poseidon, F, CIRCUIT_DEPTH, realLeaves);

  const providerId: string[] = [];
  const categoryId: string[] = [];
  const score: string[] = [];
  const jobCount: string[] = [];
  const validMask: string[] = [];
  const pathElements: string[][] = [];
  const pathIndices: string[][] = [];

  for (let i = 0; i < CIRCUIT_N; i++) {
    if (i < sorted.length) {
      const t = sorted[i];
      providerId.push(String(t.providerId));
      categoryId.push(String(t.categoryId));
      score.push(String(t.score));
      jobCount.push(String(t.jobCount));
      validMask.push("1");
      const { elements, indices } = pathFor(levels, i, CIRCUIT_DEPTH);
      pathElements.push(elements);
      pathIndices.push(indices.map(String));
    } else {
      providerId.push("0");
      categoryId.push("0");
      score.push("0");
      jobCount.push("0");
      validMask.push("0");
      pathElements.push(new Array<string>(CIRCUIT_DEPTH).fill("0"));
      pathIndices.push(new Array<string>(CIRCUIT_DEPTH).fill("0"));
    }
  }

  const nullifier = F.toObject(poseidon([inputs.agentSecret, inputs.epoch])).toString();

  return {
    signals: {
      minAvgScore: String(inputs.minAvgScore),
      minDistinctCategories: String(inputs.minDistinctCategories),
      minJobs: String(inputs.minJobs),
      nullifier,
      epochRoot: root,
      agentSecret: inputs.agentSecret.toString(),
      epoch: inputs.epoch.toString(),
      providerId,
      categoryId,
      score,
      jobCount,
      validMask,
      pathElements,
      pathIndices,
    },
    nullifier,
    epochRoot: root,
  };
}

/** Lazy-loaded poseidon — circomlibjs.buildPoseidon is heavy (~250ms) so we cache the
 *  initialized closure per process. */
let cachedPoseidon: { poseidon: PoseidonFn; F: PoseidonField } | null = null;
async function getPoseidon(): Promise<{ poseidon: PoseidonFn; F: PoseidonField }> {
  if (cachedPoseidon) return cachedPoseidon;
  // Dynamic import — circomlibjs is heavy, not every consumer of this module needs it.
  // circomlibjs ships without type declarations — cast the module shape once, right at the
  // import boundary, so nothing downstream touches an untyped `any`.
  // @ts-expect-error circomlibjs ships without type declarations
  const mod = (await import("circomlibjs")) as {
    buildPoseidon(): Promise<PoseidonFn & { F: PoseidonField }>;
  };
  const poseidon = await mod.buildPoseidon();
  cachedPoseidon = { poseidon, F: poseidon.F };
  return cachedPoseidon;
}

/** Generate a Groth16 proof end-to-end. Returns proof + public signals in circuit order. */
export async function generateRepAggProof(
  inputs: RepAggInputs,
  artifacts: RepAggArtifacts,
): Promise<RepAggProof> {
  const { poseidon, F } = await getPoseidon();
  const { signals, nullifier, epochRoot } = buildCircuitInput(poseidon, F, inputs);

  // Dynamic import again — snarkjs is ~2MB. It ships without first-party type declarations —
  // cast the module shape once, right at the import boundary, so nothing downstream touches an
  // untyped `any`.
  // @ts-expect-error snarkjs ships without first-party type declarations
  const snarkjs = (await import("snarkjs")) as {
    groth16: {
      fullProve(
        signals: Record<string, string | string[] | string[][]>,
        wasmPath: string,
        zkeyPath: string,
      ): Promise<{ proof: unknown; publicSignals: string[] }>;
    };
  };
  // Sanity-check the artifact paths up front so we fail with a clear error.
  for (const p of [artifacts.wasmPath, artifacts.zkeyPath]) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied artifact path, not user input
      readFileSync(p);
    } catch {
      throw new Error(`[karma:zk] artifact not readable: ${p}`);
    }
  }
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    signals,
    artifacts.wasmPath,
    artifacts.zkeyPath,
  );

  // Sanity: snarkjs returns publicSignals in the order declared by `component main { public [...] }`.
  // Asserting matches our Soroban verifier's hardcoded expectation. A mismatch here would mean the
  // circuit and verifier diverged — fail loudly, never silently.
  const expectedOrder = [
    String(inputs.minAvgScore),
    String(inputs.minDistinctCategories),
    String(inputs.minJobs),
    nullifier,
    epochRoot,
  ];
  if (JSON.stringify(publicSignals) !== JSON.stringify(expectedOrder)) {
    throw new Error(
      `[karma:zk] public-signals order mismatch — circuit and verifier disagree.\n` +
        `  got:    ${JSON.stringify(publicSignals)}\n` +
        `  expect: ${JSON.stringify(expectedOrder)}`,
    );
  }

  return { proof, publicSignals, nullifier, epochRoot };
}

// ── Minimal types for circomlibjs shapes we use (the package ships no .d.ts). ──
export type PoseidonFn = ((inputs: readonly bigint[]) => Uint8Array | bigint) & { F: PoseidonField };
export interface PoseidonField {
  toObject(x: unknown): bigint;
}
