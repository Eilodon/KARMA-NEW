// End-to-end test for ReputationAggregationProof (Stellar ZK track, T1.1).
//
// Drives the same Groth16 pipeline as agent_credential but exercises the multi-tuple
// aggregation circuit: 4 leaves under one epoch root, all bound to the same credential
// secret, with a weighted threshold + an engagement floor + per-epoch nullifier.
//
// Coverage:
//   1. Happy path — 4 valid tuples, sum(score×jobCount) crosses minTotal, all categories
//      distinct (strictly ascending), all leaves under epochRoot, nullifier matches.
//   2. Negative: insufficient weighted total
//   3. Negative: non-ascending categories (uniqueness violation)
//   4. Negative: jobCount = 0 for one tuple (engagement floor violation)
//   5. Negative: wrong epochRoot
//   6. Negative: tampered nullifier
//   7. Negative: insufficient minJobs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CIRCOM = join(ROOT, "bin/circom");
const SNARKJS = join(ROOT, "node_modules/.bin/snarkjs");
const BUILD = join(ROOT, "build/rep_agg");
const CIRCUIT = join(ROOT, "src/reputation_aggregation.circom");
const N = 4;
const DEPTH = 8;
// Compiled wires = 20822 ⇒ groth16 needs 2× wires ≤ 2^POT_POWER. 41644 > 2^15 (32768) so
// pot16 (65536) is the minimum size that fits. Matches synthesis §5.3 reproducibility note.
const POT_POWER = 16;

const PTAU0 = join(BUILD, `pot${POT_POWER}_0000.ptau`);
const PTAU1 = join(BUILD, `pot${POT_POWER}_0001.ptau`);
const PTAU = join(BUILD, `pot${POT_POWER}_final.ptau`);
const R1CS = join(BUILD, "reputation_aggregation.r1cs");
const WASM = join(BUILD, "reputation_aggregation_js/reputation_aggregation.wasm");
const ZKEY = join(BUILD, "reputation_aggregation_0001.zkey");
const VKEY = join(BUILD, "verification_key.json");

function sh(label, cmd, args) {
  process.stdout.write(`[T1.1] ${label}... `);
  const t = Date.now();
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
    process.stdout.write(`OK (${Date.now() - t}ms)\n`);
  } catch (e) {
    process.stdout.write(`FAIL\n`);
    if (e.stdout) console.error(e.stdout.toString());
    if (e.stderr) console.error(e.stderr.toString());
    throw e;
  }
}

async function setupOnce() {
  if (existsSync(BUILD)) rmSync(BUILD, { recursive: true });
  mkdirSync(BUILD, { recursive: true });

  sh("compile circom", CIRCOM, [CIRCUIT, "--r1cs", "--wasm", "--sym", "-o", BUILD]);
  sh(`powersoftau new (bn128 power ${POT_POWER})`, SNARKJS, [
    "powersoftau", "new", "bn128", String(POT_POWER), PTAU0,
  ]);
  sh("powersoftau contribute", SNARKJS, [
    "powersoftau", "contribute", PTAU0, PTAU1,
    "--name=karma-rep-agg-hackathon", "-e=karma-stellar-rep-agg",
  ]);
  sh("powersoftau prepare phase2", SNARKJS, ["powersoftau", "prepare", "phase2", PTAU1, PTAU]);
  sh("groth16 setup", SNARKJS, ["groth16", "setup", R1CS, PTAU, ZKEY]);
  sh("export verification key", SNARKJS, ["zkey", "export", "verificationkey", ZKEY, VKEY]);
}

/** Build a depth-D merkle tree of zeros with `leaves` placed at the given `leafIndices`. Returns
 *  the global root + per-leaf (pathElements, pathIndices) for each leaf. Used so every test case
 *  presents an honest membership proof against ONE shared tree. */
function buildMultiLeafMerkleProofs(poseidon, F, depth, leaves, leafIndices) {
  if (leaves.length !== leafIndices.length) throw new Error("leaves vs indices length mismatch");
  const treeSize = 1 << depth;
  // Build a level-0 array of `treeSize` leaves (zeros except the placed ones).
  const ZERO = 0n;
  const level0 = new Array(treeSize).fill(ZERO);
  for (let k = 0; k < leaves.length; k++) {
    if (leafIndices[k] >= treeSize) throw new Error(`leafIndex ${leafIndices[k]} ≥ tree size ${treeSize}`);
    level0[leafIndices[k]] = leaves[k];
  }

  // Build all levels up to root.
  const levels = [level0];
  for (let lvl = 0; lvl < depth; lvl++) {
    const prev = levels[lvl];
    const next = [];
    for (let j = 0; j < prev.length; j += 2) {
      next.push(F.toObject(poseidon([prev[j], prev[j + 1]])));
    }
    levels.push(next);
  }
  const root = levels[depth][0];

  // For each leaf, walk up extracting sibling at each level.
  const proofs = leaves.map((_, k) => {
    let idx = leafIndices[k];
    const pathElements = [];
    const pathIndices = [];
    for (let lvl = 0; lvl < depth; lvl++) {
      const isRight = idx & 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      pathElements.push(levels[lvl][siblingIdx].toString());
      pathIndices.push(isRight);
      idx >>= 1;
    }
    return { pathElements, pathIndices };
  });

  return { root: root.toString(), proofs };
}

async function genWitness(input, label) {
  const inputFile = join(BUILD, `${label}.input.json`);
  const wtnsFile = join(BUILD, `${label}.witness.wtns`);
  writeFileSync(inputFile, JSON.stringify(input));
  execFileSync(SNARKJS, ["wtns", "calculate", WASM, inputFile, wtnsFile], { stdio: "pipe" });
  return wtnsFile;
}

async function proveAndVerify(input, label) {
  const wtns = await genWitness(input, label);
  const proofFile = join(BUILD, `${label}.proof.json`);
  const publicFile = join(BUILD, `${label}.public.json`);
  execFileSync(SNARKJS, ["groth16", "prove", ZKEY, wtns, proofFile, publicFile], { stdio: "pipe" });
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  const publicSignals = JSON.parse(readFileSync(publicFile, "utf8"));
  const vk = JSON.parse(readFileSync(VKEY, "utf8"));
  return { proof, publicSignals, vk };
}

async function main() {
  await setupOnce();

  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // ── Witness fixtures ──────────────────────────────────────────────
  const credentialSecret = 9988776655443322n;
  const agentCommit = F.toObject(poseidon([credentialSecret]));
  const epoch = 42n;
  const nullifier = F.toObject(poseidon([credentialSecret, epoch])).toString();

  // 4 distinct categories (strictly ascending), scores + jobCounts that comfortably clear
  // both thresholds: sum(score × jobCount) = 80×10 + 75×8 + 90×6 + 85×4 = 800+600+540+340 = 2280;
  // sum(jobCount) = 28.
  const categoryIds = [1n, 2n, 7n, 13n];
  const scores       = [80n, 75n, 90n, 85n];
  const jobCounts    = [10n, 8n, 6n, 4n];

  // Compute leaf hashes off-circuit (Poseidon4(agentCommit, cat, score, jobCount)).
  const leaves = categoryIds.map((cat, i) =>
    F.toObject(poseidon([agentCommit, cat, scores[i], jobCounts[i]])),
  );

  // Place the 4 leaves at the first 4 indices of a 256-leaf tree; the rest are zeros.
  const leafIndices = [0, 1, 2, 3];
  const { root, proofs } = buildMultiLeafMerkleProofs(poseidon, F, DEPTH, leaves, leafIndices);

  const minTotal = 1500n;
  const minDistinctCategories = 4n; // hardcoded N
  const minJobs = 20n;

  // ── 1) Happy path ─────────────────────────────────────────────────
  const happyInput = {
    minTotal: minTotal.toString(),
    minDistinctCategories: minDistinctCategories.toString(),
    minJobs: minJobs.toString(),
    nullifier,
    epochRoot: root,
    credentialSecret: credentialSecret.toString(),
    epoch: epoch.toString(),
    categoryIds: categoryIds.map(String),
    scores: scores.map(String),
    jobCounts: jobCounts.map(String),
    pathElements: proofs.map((p) => p.pathElements),
    pathIndices: proofs.map((p) => p.pathIndices.map(String)),
  };

  process.stdout.write("[T1.1] happy path: prove + verify... ");
  const { proof, publicSignals, vk } = await proveAndVerify(happyInput, "happy");
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  process.stdout.write(ok ? "OK\n" : "FAIL\n");
  if (!ok) process.exit(1);
  console.log(`        public signals: ${publicSignals.join(", ")}`);

  const expectedOrder = [
    minTotal.toString(),
    minDistinctCategories.toString(),
    minJobs.toString(),
    nullifier,
    root,
  ];
  if (JSON.stringify(publicSignals) !== JSON.stringify(expectedOrder)) {
    console.error("FAIL: publicSignals order mismatch");
    console.error("  got:    ", publicSignals);
    console.error("  expect: ", expectedOrder);
    process.exit(1);
  }
  console.log("[T1.1] public-signals order matches the Soroban verifier convention");

  // ── 2) Negative: insufficient weighted total (claim ≥ 5000 vs actual 2280) ─
  try {
    await genWitness({ ...happyInput, minTotal: "5000" }, "low_total");
    console.error("FAIL: insufficient weighted total was accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative low-weighted-total: rejected ✓");
  }

  // ── 3) Negative: non-ascending categories (3rd ≤ 2nd) ─
  try {
    await genWitness({ ...happyInput, categoryIds: ["1", "2", "2", "13"] }, "non_asc");
    console.error("FAIL: non-ascending categories accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative non-ascending categories: rejected ✓");
  }

  // ── 4) Negative: a jobCount of 0 (engagement floor violation) ─
  try {
    await genWitness({ ...happyInput, jobCounts: ["10", "8", "0", "4"] }, "zero_jobs");
    console.error("FAIL: zero-jobCount accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative zero-jobCount in one tuple: rejected ✓");
  }

  // ── 5) Negative: wrong epochRoot ─
  try {
    await genWitness({ ...happyInput, epochRoot: "12345" }, "bad_root");
    console.error("FAIL: wrong epochRoot accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative wrong-epochRoot: rejected ✓");
  }

  // ── 6) Negative: tampered nullifier ─
  try {
    await genWitness({ ...happyInput, nullifier: "999" }, "bad_null");
    console.error("FAIL: tampered nullifier accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative tampered nullifier: rejected ✓");
  }

  // ── 7) Negative: insufficient minJobs (claim ≥ 100 vs actual 28) ─
  try {
    await genWitness({ ...happyInput, minJobs: "100" }, "low_jobs");
    console.error("FAIL: insufficient minJobs accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative insufficient-minJobs: rejected ✓");
  }

  // ── 8) Verifier-side: tampered public signal on a valid proof MUST be rejected ─
  process.stdout.write("[T1.1] verifier rejects tampered public input... ");
  const tampered = [...publicSignals];
  tampered[0] = "0"; // claim minTotal = 0
  const okBad = await snarkjs.groth16.verify(vk, tampered, proof);
  process.stdout.write(!okBad ? "OK\n" : "FAIL\n");
  if (okBad) process.exit(1);

  console.log("[T1.1] PASS — ReputationAggregationProof end-to-end");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
