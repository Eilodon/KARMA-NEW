#![no_std]
// Soroban entry points take primitive args directly (no nested-struct params in the ABI), so
// the `#[contractimpl]`-generated client wrapper around a wide constructor legitimately exceeds
// clippy's default arg count.
#![allow(clippy::too_many_arguments)]
//! KARMA AgentCredentialProof verifier (Stellar ZK track, T5).
//!
//! Per synthesis §5.4 this contract is a ZK verification layer + minimal job ledger,
//! NOT a full marketplace replacement. Trust gates:
//!   1. Nullifier replay guard — each per-skill nullifier may only be used once.
//!   2. Groth16 proof verification — agent's reputation ≥ skill's threshold without
//!      revealing the actual score (constraints are enforced inside the circuit).
//!   3. (Optional in this commit) x402 receipt — synthesis flow attaches an x402
//!      payment ref as evidence the requester paid the skill price. The receipt
//!      verification itself is delegated to the off-chain x402 facilitator; the
//!      contract just records the reference. Wired in T7 once the Stellar x402
//!      facilitator client is in place.
//!
//! The Groth16 pairing check runs on Stellar's **native BN254 host functions**
//! (`env.crypto().bn254()`, backed by `bn254_multi_pairing_check` / CAP-0074, shipped
//! in Protocol 25 "X-Ray"). This contract previously shipped a software Arkworks
//! (`ark-bn254` + `ark-groth16`) verifier because CAP-0074's pairing check was assumed
//! not yet available — that assumption was wrong (it landed in Protocol 25, ahead of
//! this contract's first version) and has been corrected: see `docs/decisions/DP-7`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    panic_with_error, vec, Address, BytesN, Env, Symbol, Vec,
};

// ── Errors ──────────────────────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotAdmin = 2,
    SkillNotFound = 3,
    SkillAlreadyRegistered = 4,
    NullifierReused = 5,
    InvalidProof = 6,
    InvalidVerifyingKey = 7,
    InvalidPublicInputs = 8,
    SkillRootNotSet = 9,
    JobHistoryRootMismatch = 10,
}

// ── Groth16 / BN254 types ─────────────────────────────────────────────────
// Layout mirrors Stellar's canonical `groth16_verifier` example (BLS12-381), swapped
// to the BN254 host module. Point encodings are the host's Ethereum-compatible
// uncompressed format: G1 = 64 bytes (BE(X) || BE(Y)), G2 = 128 bytes (BE(X) || BE(Y)
// where each Fp2 coordinate is BE(c1) || BE(c0)). See `soroban_sdk::crypto::bn254`.
#[contracttype]
#[derive(Clone)]
pub struct VerifyingKey {
    pub alpha: Bn254G1Affine,
    pub beta: Bn254G2Affine,
    pub gamma: Bn254G2Affine,
    pub delta: Bn254G2Affine,
    /// `ic[0]` is the constant term; `ic[1..]` pair one-to-one with public inputs.
    /// For this circuit (5 public signals) `ic.len()` MUST be 6.
    pub ic: Vec<Bn254G1Affine>,
}

#[contracttype]
#[derive(Clone)]
pub struct Groth16Proof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
}

const PUBLIC_INPUT_COUNT: u32 = 5;

// ── Storage types ───────────────────────────────────────────────────────────
#[contracttype]
#[derive(Clone)]
pub struct SkillConfig {
    pub vkey: VerifyingKey,
    pub min_reputation: u32,
    pub price_per_call: u128,  // declared cost — informational; settlement via x402/escrow
    pub owner: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct JobRecord {
    pub skill_id: u64,
    pub task_commitment: BytesN<32>,
    pub nullifier: BytesN<32>,
    pub payer: Address,
    pub created_at: u64,
    pub x402_receipt: soroban_sdk::Bytes,   // facilitator settlement reference (empty when escrow lane)
}

#[contracttype]
enum DataKey {
    Admin,
    JobCounter,
    Skill(u64),
    SkillRoot(u64),
    Nullifier(BytesN<32>),
    Job(u64),
}

// ── Events ──────────────────────────────────────────────────────────────────
// soroban-sdk 26 prefers #[contractevent] structs, but the publish() flow remains correct on
// chain — quieter `#[allow(deprecated)]` keeps the diff small while we ship the verifier; the
// migration to #[contractevent] is a no-behavior-change cleanup tracked separately.
#[allow(deprecated)]
fn event_skill_registered(env: &Env, skill_id: u64, owner: &Address) {
    env.events()
        .publish((Symbol::new(env, "skill_registered"), skill_id), owner.clone());
}
#[allow(deprecated)]
fn event_job_created(env: &Env, job_id: u64, skill_id: u64, payer: &Address) {
    env.events()
        .publish((Symbol::new(env, "job_created"), job_id, skill_id), payer.clone());
}
#[allow(deprecated)]
fn event_skill_root_set(env: &Env, skill_id: u64, root: &BytesN<32>) {
    env.events()
        .publish((Symbol::new(env, "skill_root_set"), skill_id), root.clone());
}

// ── Contract impl ───────────────────────────────────────────────────────────
#[contract]
pub struct AgentCredentialVerifier;

#[contractimpl]
impl AgentCredentialVerifier {
    /// Initialize the contract with an admin address. Idempotent: re-init reverts.
    pub fn __constructor(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::JobCounter, &0u64);
    }

    /// Register a skill with its verifying key and trust-gate parameters.
    /// Admin-only — keeps the synthesis §5.4 "not a full marketplace" scope tight.
    pub fn register_skill(
        env: Env,
        skill_id: u64,
        vkey: VerifyingKey,
        min_reputation: u32,
        price_per_call: u128,
        owner: Address,
    ) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotAdmin));
        admin.require_auth();
        if env.storage().persistent().has(&DataKey::Skill(skill_id)) {
            panic_with_error!(&env, Error::SkillAlreadyRegistered);
        }
        // Sanity: `ic` must have exactly PUBLIC_INPUT_COUNT + 1 elements (constant term +
        // one per public signal) — fail fast at registration rather than at every create_job.
        if vkey.ic.len() != PUBLIC_INPUT_COUNT + 1 {
            panic_with_error!(&env, Error::InvalidVerifyingKey);
        }
        env.storage().persistent().set(
            &DataKey::Skill(skill_id),
            &SkillConfig { vkey, min_reputation, price_per_call, owner: owner.clone() },
        );
        event_skill_registered(&env, skill_id, &owner);
    }

    /// Publish (or overwrite) the job-history Merkle root for a skill. The issuer's
    /// off-chain credential service builds this root from its published credential
    /// leaves; `create_job` requires a proof's `jobHistoryRoot` public signal to match
    /// the currently-published root for that skill — otherwise a prover could supply a
    /// proof against a self-constructed tree that was never published by the issuer.
    /// Separate call (not part of `register_skill`) so the root can be rotated as the
    /// issuer's credential tree grows, mirroring `reputation_aggregation_verifier::set_epoch_root`.
    pub fn set_skill_root(env: Env, skill_id: u64, root: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotAdmin));
        admin.require_auth();
        env.storage().persistent().set(&DataKey::SkillRoot(skill_id), &root);
        event_skill_root_set(&env, skill_id, &root);
    }

    /// Create a job: verify the AgentCredentialProof, claim the nullifier, store the job record.
    /// `public_inputs` MUST be the 5-element vector the circuit produces:
    ///   [ skillId, minReputation, nullifier, credentialCommitment, jobHistoryRoot ]
    /// in that exact order (asserted by circuits/test/agent_credential.test.mjs), each packed
    /// as a big-endian BN254 scalar-field element (`Bn254Fr`).
    pub fn create_job(
        env: Env,
        payer: Address,
        skill_id: u64,
        task_commitment: BytesN<32>,
        proof: Groth16Proof,
        nullifier: BytesN<32>,
        public_inputs: Vec<Bn254Fr>,
        x402_receipt: soroban_sdk::Bytes,
    ) -> u64 {
        payer.require_auth();

        // 1. Nullifier replay guard — `nullifier` is per-skill, so a tampered skill_id would
        //    produce a different nullifier, breaking the circuit constraint at verify time.
        if env.storage().persistent().has(&DataKey::Nullifier(nullifier.clone())) {
            panic_with_error!(&env, Error::NullifierReused);
        }

        // 2. Look up the skill's verifying key + trust-gate parameters.
        let skill: SkillConfig = env
            .storage()
            .persistent()
            .get(&DataKey::Skill(skill_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::SkillNotFound));

        // 3. Verify the proof binds to (skill_id, min_reputation, nullifier) by comparing the
        //    contract-known public inputs against what the proof committed to.
        if public_inputs.len() != PUBLIC_INPUT_COUNT {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }
        // Element 0: skillId. Element 1: minReputation. Element 2: nullifier.
        let pi_skill = public_inputs.get(0).unwrap();
        let pi_min_rep = public_inputs.get(1).unwrap();
        let pi_nullifier = public_inputs.get(2).unwrap();
        if pi_skill != crypto::fr_from_u64(&env, skill_id) {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }
        if pi_min_rep != crypto::fr_from_u32(&env, skill.min_reputation) {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }
        if pi_nullifier != Bn254Fr::from_bytes(nullifier.clone()) {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }
        // Element 4: jobHistoryRoot — must match the currently-published root for this skill,
        // otherwise a prover could supply a proof against a tree the issuer never published.
        let pi_root = public_inputs.get(4).unwrap();
        let known_root: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::SkillRoot(skill_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::SkillRootNotSet));
        if pi_root != Bn254Fr::from_bytes(known_root) {
            panic_with_error!(&env, Error::JobHistoryRootMismatch);
        }

        // 4. Groth16 pairing check (native BN254 host functions) — the load-bearing crypto step.
        let ok = crypto::verify_groth16(&env, &skill.vkey, &proof, &public_inputs);
        if !ok {
            panic_with_error!(&env, Error::InvalidProof);
        }

        // 5. Effects: claim nullifier, mint job id, record job.
        env.storage().persistent().set(&DataKey::Nullifier(nullifier.clone()), &true);
        let job_id: u64 = env.storage().instance().get(&DataKey::JobCounter).unwrap_or(0) + 1;
        env.storage().instance().set(&DataKey::JobCounter, &job_id);
        env.storage().persistent().set(
            &DataKey::Job(job_id),
            &JobRecord {
                skill_id,
                task_commitment,
                nullifier,
                payer: payer.clone(),
                created_at: env.ledger().timestamp(),
                x402_receipt,
            },
        );
        event_job_created(&env, job_id, skill_id, &payer);
        job_id
    }

    pub fn is_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Nullifier(nullifier))
    }

    pub fn get_skill(env: Env, skill_id: u64) -> Option<SkillConfig> {
        env.storage().persistent().get(&DataKey::Skill(skill_id))
    }

    pub fn skill_root(env: Env, skill_id: u64) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::SkillRoot(skill_id))
    }

    pub fn get_job(env: Env, job_id: u64) -> Option<JobRecord> {
        env.storage().persistent().get(&DataKey::Job(job_id))
    }

    pub fn job_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::JobCounter).unwrap_or(0)
    }

    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }
}

// ── Crypto helpers ──────────────────────────────────────────────────────────
mod crypto {
    use super::*;

    /// Groth16 verification via Stellar's native BN254 host functions
    /// (`env.crypto().bn254()`, CAP-0074 `bn254_multi_pairing_check`).
    /// Same equation as the canonical BLS12-381 `groth16_verifier` example, over BN254:
    ///   e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
    pub(super) fn verify_groth16(
        env: &Env,
        vk: &VerifyingKey,
        proof: &Groth16Proof,
        public_inputs: &Vec<Bn254Fr>,
    ) -> bool {
        let bn254 = env.crypto().bn254();
        if public_inputs.len() + 1 != vk.ic.len() {
            return false;
        }
        let mut vk_x = vk.ic.get(0).unwrap();
        for i in 0..public_inputs.len() {
            let s = public_inputs.get(i).unwrap();
            let v = vk.ic.get(i + 1).unwrap();
            let prod = bn254.g1_mul(&v, &s);
            vk_x = bn254.g1_add(&vk_x, &prod);
        }
        let neg_a = -proof.a.clone();
        let vp1 = vec![env, neg_a, vk.alpha.clone(), vk_x, proof.c.clone()];
        let vp2 = vec![env, proof.b.clone(), vk.beta.clone(), vk.gamma.clone(), vk.delta.clone()];
        bn254.pairing_check(vp1, vp2)
    }

    /// Packs a `u64` into a big-endian `Bn254Fr` (upper 24 bytes zero) — the encoding the
    /// off-chain prover uses for scalar public signals like `skillId`.
    pub(super) fn fr_from_u64(env: &Env, v: u64) -> Bn254Fr {
        let mut buf = [0u8; 32];
        buf[24..32].copy_from_slice(&v.to_be_bytes());
        Bn254Fr::from_bytes(soroban_sdk::BytesN::from_array(env, &buf))
    }

    /// Packs a `u32` into a big-endian `Bn254Fr` (upper 28 bytes zero).
    pub(super) fn fr_from_u32(env: &Env, v: u32) -> Bn254Fr {
        fr_from_u64(env, v as u64)
    }
}

#[cfg(test)]
mod test;
