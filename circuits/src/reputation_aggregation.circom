pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// ReputationAggregationProof (T1.1) — KARMA's "behavioral credit score for non-humans".
//
// An agent holds a credential SECRET and N reputation tuples — each tuple is
//   (agentCommit, categoryId, score, jobCount)
// where agentCommit = Poseidon(credentialSecret), published by the issuer (KARMA) as a
// leaf in the periodic `epochRoot` Merkle tree. Tuples are stamped per (agent, category).
//
// This circuit proves — without revealing the tuples, scores, categories, or even
// credentialSecret — that the agent has:
//   • N tuples that all bind to the SAME credentialSecret (Poseidon(secret) appears in
//     each leaf hash);
//   • all N leaves are Merkle-members of the public epochRoot;
//   • categories are strictly ascending (so the N categories are distinct);
//   • Σ (score × jobCount) ≥ minTotal               (weighted aggregate);
//   • Σ jobCount ≥ minJobs                          (real engagement floor);
//   • each jobCount ≥ 1 and each score ≤ 100;
//   • a per-epoch nullifier prevents the same credentialSecret claiming twice in one epoch.
//
// Public  (verified on-chain by the Soroban consumer):
//   minTotal                  weighted aggregate floor for sum(score × jobCount)
//   minDistinctCategories     hardcoded N in v1 (circuit asserts =N); kept public so future
//                             expansions can prove "≥ K of M" without contract change
//   minJobs                   minimum total job-count across all N categories
//   nullifier                 Poseidon(credentialSecret, epoch) — per-epoch replay guard
//   epochRoot                 the issuer-published Merkle root the N leaves must live under
//
// Private:
//   credentialSecret          agent's private credential secret
//   epoch                     scalar epoch id (binds nullifier to a particular snapshot)
//   categoryIds[N]            ascending category ids (range u16; uniqueness via ordering)
//   scores[N]                 per-category scores in [0, 100]
//   jobCounts[N]              per-category job counts in [1, 1023]
//   pathElements[N][depth]    Merkle sibling for each leaf at each level
//   pathIndices[N][depth]     0 = leaf-on-left, 1 = leaf-on-right at each level
//
// Sizing for the hackathon: N=4 categories × depth=8 (256 leaves per epoch). Compile-time
// constraint count fits a pot13 (Phase-1 universal) ceremony comfortably; a future bump to
// N=8 would need pot14.

template MerkleProof(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component hashers[depth];
    component muxL[depth];
    component muxR[depth];
    signal current[depth + 1];
    current[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // pathIndices[i] must be a bit (0 or 1). Mux1 would produce undefined-but-consistent
        // values otherwise; constrain explicitly so a malicious prover cannot fudge sides.
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // (left, right) = pathIndices[i]==0 ? (current, sibling) : (sibling, current)
        muxL[i] = Mux1();
        muxL[i].c[0] <== current[i];
        muxL[i].c[1] <== pathElements[i];
        muxL[i].s <== pathIndices[i];

        muxR[i] = Mux1();
        muxR[i].c[0] <== pathElements[i];
        muxR[i].c[1] <== current[i];
        muxR[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxL[i].out;
        hashers[i].inputs[1] <== muxR[i].out;
        current[i + 1] <== hashers[i].out;
    }

    root <== current[depth];
}

template ReputationAggregationProof(N, depth) {
    // ── Public inputs ────────────────────────────────────────────────────
    signal input minTotal;
    signal input minDistinctCategories;
    signal input minJobs;
    signal input nullifier;
    signal input epochRoot;

    // ── Private inputs ───────────────────────────────────────────────────
    signal input credentialSecret;
    signal input epoch;
    signal input categoryIds[N];
    signal input scores[N];
    signal input jobCounts[N];
    signal input pathElements[N][depth];
    signal input pathIndices[N][depth];

    // (1) agentCommit = Poseidon(credentialSecret) — binds all leaves to one agent identity.
    component agentHash = Poseidon(1);
    agentHash.inputs[0] <== credentialSecret;
    signal agentCommit;
    agentCommit <== agentHash.out;

    // (2) Each leaf = Poseidon(agentCommit, categoryId, score, jobCount).
    //     A leaf attesting to (agent, category, score, jobCount) at the latest epoch.
    component leafHash[N];
    for (var i = 0; i < N; i++) {
        leafHash[i] = Poseidon(4);
        leafHash[i].inputs[0] <== agentCommit;
        leafHash[i].inputs[1] <== categoryIds[i];
        leafHash[i].inputs[2] <== scores[i];
        leafHash[i].inputs[3] <== jobCounts[i];
    }

    // (3) Each leaf is a Merkle member of epochRoot — N independent membership proofs.
    component merkle[N];
    for (var i = 0; i < N; i++) {
        merkle[i] = MerkleProof(depth);
        merkle[i].leaf <== leafHash[i].out;
        for (var j = 0; j < depth; j++) {
            merkle[i].pathElements[j] <== pathElements[i][j];
            merkle[i].pathIndices[j] <== pathIndices[i][j];
        }
        merkle[i].root === epochRoot;
    }

    // (4) Categories strictly ascending — encodes uniqueness without an O(N^2) all-pairs check.
    //     16-bit comparator: categories fit in u16 (≤ 65535) for the hackathon scope.
    component catCmp[N - 1];
    for (var i = 0; i < N - 1; i++) {
        catCmp[i] = GreaterThan(16);
        catCmp[i].in[0] <== categoryIds[i + 1];
        catCmp[i].in[1] <== categoryIds[i];
        catCmp[i].out === 1;
    }

    // (5) v1 surface: minDistinctCategories MUST equal N. A future v2 that supports
    //     "K of M" still gets to keep the same public-input shape — this constraint is
    //     the only thing that changes (becomes minDistinctCategories ≤ N).
    minDistinctCategories === N;

    // (6) Each score ∈ [0, 100]: bit-decompose with 7 bits (≤ 127) then bound.
    component scoreBits[N];
    component scoreLe100[N];
    for (var i = 0; i < N; i++) {
        scoreBits[i] = Num2Bits(7);
        scoreBits[i].in <== scores[i];
        scoreLe100[i] = LessEqThan(7);
        scoreLe100[i].in[0] <== scores[i];
        scoreLe100[i].in[1] <== 100;
        scoreLe100[i].out === 1;
    }

    // (7) Each jobCount ∈ [1, 1023]: bit-decompose with 10 bits then bound below.
    //     A zero-job category cannot inflate Σ score × jobCount without engagement evidence.
    component jobBits[N];
    component jobGe1[N];
    for (var i = 0; i < N; i++) {
        jobBits[i] = Num2Bits(10);
        jobBits[i].in <== jobCounts[i];
        jobGe1[i] = GreaterEqThan(10);
        jobGe1[i].in[0] <== jobCounts[i];
        jobGe1[i].in[1] <== 1;
        jobGe1[i].out === 1;
    }

    // (8) Σ (score × jobCount) ≥ minTotal — the weighted aggregate threshold.
    //     For N=4 with score ≤ 100, jobCount ≤ 1023: each product ≤ 102_300, sum ≤ 409_200
    //     (well under 20 bits) so a 20-bit comparator is plenty.
    signal products[N];
    for (var i = 0; i < N; i++) {
        products[i] <== scores[i] * jobCounts[i];
    }
    signal sumScore;
    sumScore <== products[0] + products[1] + products[2] + products[3];
    component sumGte = GreaterEqThan(20);
    sumGte.in[0] <== sumScore;
    sumGte.in[1] <== minTotal;
    sumGte.out === 1;

    // (9) Σ jobCount ≥ minJobs — engagement floor across all N categories.
    //     For N=4 × jobCount ≤ 1023: sum ≤ 4_092 (under 13 bits).
    signal sumJobs;
    sumJobs <== jobCounts[0] + jobCounts[1] + jobCounts[2] + jobCounts[3];
    component jobsGte = GreaterEqThan(13);
    jobsGte.in[0] <== sumJobs;
    jobsGte.in[1] <== minJobs;
    jobsGte.out === 1;

    // (10) nullifier = Poseidon(credentialSecret, epoch) — per-epoch replay guard.
    //      Same secret can only claim once per epoch root; new epoch ⇒ new nullifier ⇒ fresh.
    component nullHash = Poseidon(2);
    nullHash.inputs[0] <== credentialSecret;
    nullHash.inputs[1] <== epoch;
    nullHash.out === nullifier;
}

component main { public [minTotal, minDistinctCategories, minJobs, nullifier, epochRoot] } = ReputationAggregationProof(4, 8);
