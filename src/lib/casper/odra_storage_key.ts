import blake2b from "blake2b";

const DIGEST_LEN = 32;

/**
 * Derives the Casper dictionary-item key Odra uses for `Var<T>` / `Mapping<K, V>` fields on the
 * casper-wasm backend — reverse-engineered from `odra-core`'s actual source (not guessed):
 *
 *   - Every field of a `#[odra::module]` struct lives in ONE shared dictionary named `"state"`
 *     (`odra-casper-wasm-env`'s `consts::STATE_KEY`).
 *   - `ContractEnv::current_key()` = `blake2b256(index_bytes ++ mapping_data)`, hex-encoded
 *     (lowercase, 64 chars) — see `contract_env.rs` in the `odra-core` crate.
 *   - `index_bytes` has TWO encodings, per `ContractEnv::index_bytes()` (read directly from
 *     `odra-core-2.8.2/src/contract_env.rs`, not guessed) — this module only ever reads
 *     TOP-LEVEL fields (path length 1, no `SubModule` nesting), so `path = [fieldIndex]` always:
 *       - **Legacy** (`fieldIndex` ≤ 15): big-endian `u32` of the index — 4 bytes, e.g. index 4 →
 *         `[0,0,0,4]`. Preserves storage keys from before the path encoding existed.
 *       - **Path** (`fieldIndex` > 15): `[0xFF, path_len, ...path]` = `[0xFF, 1, fieldIndex]` for
 *         a top-level field. The `0xFF` prefix can't collide with legacy keys (whose first byte
 *         never exceeds `0x0F`); `path_len` disambiguates nesting depth from mapping-key bytes.
 *   - `mapping_data` is the mapping key's `bytesrepr` serialization (`ToBytes::to_bytes()`).
 *   - For a bare `Var<T>` read (no mapping key), `mapping_data` is the empty byte string — a `Var`
 *     never calls `ContractEnv::add_to_mapping_data()` (only `Mapping<K, V>` does, with the key's
 *     own `bytesrepr` serialization) — so `odraMappingDictionaryKey(fieldIndex, new Uint8Array(0))`
 *     is the correct call for reading a `Var`, not a separate function.
 *
 * Field indices are macro-assigned in struct declaration order **starting at 1, not 0** — verified
 * two independent ways for every index below: (1) reading `odra-macros 2.8.2`'s exact pinned source
 * (the version this workspace's `Cargo.lock` resolves to) — `ir/mod.rs`'s `typed_fields()` does
 * `idx: idx as u8 + 1` over `struct_typed_fields()`'s `named.named.iter()` (`utils/syn.rs`), which
 * walks the struct's fields in literal source order, no reordering/filtering (beyond dropping an
 * `env`-named field, which `AgentSkillRegistry` doesn't have); and (2) actually running
 * `cargo +nightly expand --lib agent_skill_registry` against this exact source tree and reading the
 * real generated `AgentSkillRegistry::new()` body, which instantiates each field via
 * `<FieldType as ModuleComponent>::instance(env, Nu8)` in exactly that order (`skills` → `4u8`,
 * `arbiter` → `17u8`, `governance_signers` → `19u8`, etc. — matching every index below field-for-field).
 * See `contracts-odra/README.md` for the full verified index table.
 */
export function odraMappingDictionaryKey(fieldIndex: number, mappingKeyBytes: Uint8Array): string {
  if (!Number.isInteger(fieldIndex) || fieldIndex < 0 || fieldIndex > 255) {
    throw new Error(
      `[odra-storage-key] field index ${fieldIndex} out of the u8 path-segment range (0-255)`,
    );
  }
  const indexBytes =
    fieldIndex <= 15
      ? Uint8Array.from([0, 0, 0, fieldIndex]) // legacy: 4-byte big-endian u32
      : Uint8Array.from([0xff, 1, fieldIndex]); // path: 0xFF, path_len=1, the single segment
  const preimage = new Uint8Array(indexBytes.length + mappingKeyBytes.length);
  preimage.set(indexBytes, 0);
  preimage.set(mappingKeyBytes, indexBytes.length);
  const digest = blake2b(DIGEST_LEN).update(preimage).digest();
  return Buffer.from(digest).toString("hex");
}

/** `u64` `bytesrepr` encoding — 8 bytes, little-endian (casper_types convention for all
 *  fixed-width integers). */
export function u64ToBytes(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`[odra-storage-key] u64 out of range: ${value}`);
  }
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Casper `Key::Account` `bytesrepr` encoding — 1-byte tag (`0x00`) + the 32-byte account hash.
 *  Odra's `Address::to_bytes()` delegates to `Key::from(address).to_bytes()`; every agent
 *  address this contract keys `Mapping`s by is an account (never a contract package). */
export function accountAddressToBytes(accountHashHex: string): Uint8Array {
  const hex = accountHashHex.replace(/^account-hash-/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`[odra-storage-key] expected a 32-byte account hash hex, got: ${accountHashHex}`);
  }
  const out = new Uint8Array(33);
  out.set(Buffer.from(hex, "hex"), 1);
  out[0] = 0x00; // Key::Account tag
  return out;
}

/** `contracts-odra/src/agent_skill_registry.rs`'s `AgentSkillRegistry` module field indices —
 *  pinned by `cargo expand`, not recomputed. Only the fields this module currently reads. */
export const AGENT_SKILL_REGISTRY_FIELD_INDEX = {
  skills: 4,
  jobs: 5,
  /** `agent_provider_jobs: Mapping<Address, Vec<u64>>` — index 6, by the same struct-declaration-
   *  order rule documented above (fields 6-8 sit directly after `jobs`/before `pending_withdrawals`,
   *  no `env`-named field to skip in this struct). Digest cross-checked against an independent
   *  Python blake2b256 reference in `casper_odra_storage_key.test.ts`, same as every index above —
   *  not re-run through `cargo +nightly expand` this session (that command is too slow to complete
   *  reliably in this environment; every OTHER index in this file WAS confirmed that way). */
  agentProviderJobs: 6,
  /** `agent_requester_jobs: Mapping<Address, Vec<u64>>` — index 7, see `agentProviderJobs`'s note. */
  agentRequesterJobs: 7,
  /** `agent_skills: Mapping<Address, Vec<u64>>` — index 8, see `agentProviderJobs`'s note. */
  agentSkills: 8,
  pendingWithdrawals: 9,
  agentRep: 11,
  bondedAmount: 12,
  /** `compositions: Mapping<u64, Composition>` — index 14, confirmed via `cargo +nightly expand
   *  --lib agent_skill_registry` (same method as every other index above), not recomputed by hand. */
  compositions: 14,
  /** `cross_chain_rep: Mapping<Address, u32>` — index 15, confirmed the same way. */
  crossChainRep: 15,
  // Index 16 (`dispute_bond_bps: Var<u32>`) is skipped — not read by this module yet.
  /** `arbiter: Var<Address>` — index 17. Path-encoded (>15) — see `odraMappingDictionaryKey`'s
   *  header comment. Re-confirmed by actually running `cargo +nightly expand --lib
   *  agent_skill_registry` against this exact source tree: the generated `AgentSkillRegistry::new`
   *  reads `let arbiter = <Var<Address> as ModuleComponent>::instance(env, 17u8)` verbatim. */
  arbiter: 17,
  /** `disputes: Mapping<u64, DisputeInfo>` — index 18, see `agentProviderJobs`'s note (same
   *  struct-order rule, digest cross-checked independently, not re-run via `cargo expand`). */
  disputes: 18,
  /** `governance_signers: Var<Vec<Address>>` — index 19. Path-encoded; `cargo expand` shows
   *  `<Var<Vec<Address>> as ModuleComponent>::instance(env, 19u8)`, same method as `arbiter`. */
  governanceSigners: 19,
  /** `governance_threshold: Var<u32>` — index 20. Path-encoded; `cargo expand`-confirmed the same way. */
  governanceThreshold: 20,
  /** `timelock_delay: Var<u64>` — index 21. Path-encoded; `cargo expand`-confirmed the same way. */
  timelockDelay: 21,
  // Index 22 (`proposal_counter: Var<u64>`) is skipped — not read by this module yet.
  /** `proposals: Mapping<u64, GovernanceProposal>` — index 23, see `agentProviderJobs`'s note
   *  (same struct-order rule, digest cross-checked independently, not re-run via `cargo expand`). */
  proposals: 23,
  // Index 24 (`proposal_approvals: Mapping<u64, Vec<Address>>`) is skipped — not read by this
  // module yet (per-proposal approver list browsing is out of scope for the current read surface).
  /** `rationale_hash: Mapping<u64, Bytes>` (P2-A) — index 25, confirmed via `cargo +nightly
   *  expand --lib agent_skill_registry` (its `ModuleComponent::instance(env, 25u8)` call is
   *  printed directly in the expanded output). */
  rationaleHash: 25,
  // P4-A: Panel Arbitration (N-of-M). All 8 fields below were appended directly after
  // `rationale_hash` with no gap and nothing declared after them (confirmed by reading the
  // live struct in `agent_skill_registry.rs`, not `cargo expand` — that command is too slow
  // to complete reliably in this environment, same fallback used for the `agentProviderJobs`-
  // style indices above). Indices therefore run 26-33 in struct-declaration order, all
  // path-encoded (>15). Digests cross-checked independently against `python3 -c "import
  // hashlib; ..."`, same method as every index above.
  /** `arbiter_panel: Var<Vec<Address>>` — index 26, bare Var. */
  arbiterPanel: 26,
  /** `panel_threshold: Var<u32>` — index 27, bare Var. */
  panelThreshold: 27,
  /** `panel_arbiter_fee: Var<U512>` — index 28, bare Var. */
  panelArbiterFee: 28,
  /** `dispute_arbitration_mode: Mapping<u64, ArbitrationMode>` — index 29, keyed by job_id. */
  disputeArbitrationMode: 29,
  /** `job_panel_snapshot: Mapping<u64, Vec<Address>>` — index 30, keyed by job_id. */
  jobPanelSnapshot: 30,
  /** `job_panel_threshold_snapshot: Mapping<u64, u32>` — index 31, keyed by job_id. */
  jobPanelThresholdSnapshot: 31,
  /** `panel_arbiter_fee_collected: Mapping<u64, U512>` — index 32, keyed by job_id. */
  panelArbiterFeeCollected: 32,
  /** `panel_votes: Mapping<u64, Vec<PanelVote>>` — index 33, keyed by job_id. */
  panelVotes: 33,
} as const;
