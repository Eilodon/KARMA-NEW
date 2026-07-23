import { describe, it, expect } from "vitest";
import {
  odraMappingDictionaryKey,
  u64ToBytes,
  accountAddressToBytes,
  AGENT_SKILL_REGISTRY_FIELD_INDEX,
} from "../lib/casper/odra_storage_key.js";

describe("odraMappingDictionaryKey (T13-live, verified against cargo-expand + an independent blake2b256 reference)", () => {
  it("matches an independently computed blake2b256 digest for skills[1] (field index 4, u64 key)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0,0,0,4]) + (1).to_bytes(8,'little'), digest_size=32).hexdigest())"
    const key = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.skills, u64ToBytes(1n));
    expect(key).toBe("1d4c5faba44ae8638dfbc992e8dc85840358a59b5d94830913b71366260cfc77");
    expect(key).toHaveLength(64);
  });

  it("matches an independently computed blake2b256 digest for pendingWithdrawals[account 0x11...] (field index 9, Address key)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0,0,0,9]) + bytes([0]) + bytes([0x11]*32), digest_size=32).hexdigest())"
    const accountHash = "11".repeat(32);
    const key = odraMappingDictionaryKey(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.pendingWithdrawals,
      accountAddressToBytes(accountHash),
    );
    expect(key).toBe("6a963b89254897196fc139e40d0500d62fbcb4f31c2999dc09dadc3cf6cdd1c1");
    expect(key).toHaveLength(64);
  });

  it("is deterministic and distinct per field index (same mapping key, different field)", () => {
    const keyBytes = u64ToBytes(7n);
    const a = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.skills, keyBytes);
    const b = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.jobs, keyBytes);
    expect(a).not.toBe(b);
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.skills, keyBytes)).toBe(a);
  });

  it("rejects a field index outside the u8 path-segment range", () => {
    expect(() => odraMappingDictionaryKey(256, u64ToBytes(1n))).toThrow(/out of the u8 path-segment range/);
    expect(() => odraMappingDictionaryKey(-1, u64ToBytes(1n))).toThrow(/out of the u8 path-segment range/);
  });

  it("matches an independently computed blake2b256 digest for rationaleHash[job 1] (field index 25 — PATH encoding, > 15)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0xFF, 1, 25]) + (1).to_bytes(8,'little'), digest_size=32).hexdigest())"
    // [0xFF, path_len=1, field_index=25] per odra-core-2.8.2's ContractEnv::index_bytes()
    // (contract_env.rs), read directly — not guessed. See the doc comment above
    // odraMappingDictionaryKey for the full derivation.
    const key = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.rationaleHash, u64ToBytes(1n));
    expect(key).toBe("34514907fcda0f101182c6e5e8f75fac6d30e323abad9fd6ed0da15e566839f1");
    expect(key).toHaveLength(64);
  });

  it("PATH encoding is distinct per field index (no collision between 16 and 25 at the same mapping key)", () => {
    const keyBytes = u64ToBytes(1n);
    const a = odraMappingDictionaryKey(16, keyBytes);
    const b = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.rationaleHash, keyBytes);
    expect(a).not.toBe(b);
  });

  it("LEGACY and PATH encodings never collide (index 15 vs 16, same mapping key)", () => {
    const keyBytes = u64ToBytes(1n);
    const legacy = odraMappingDictionaryKey(15, keyBytes);
    const path = odraMappingDictionaryKey(16, keyBytes);
    expect(legacy).not.toBe(path);
  });
});

describe("odraMappingDictionaryKey — path encoding (field index > 15, e.g. governance Var fields)", () => {
  it("matches an independently computed blake2b256 digest for arbiter (field index 17, bare Var — empty mapping key)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0xFF, 1, 17]), digest_size=32).hexdigest())"
    const key = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.arbiter, new Uint8Array(0));
    expect(key).toBe("e03974949cd5ee7cdb49b3c16b0c9a304d858c494596d78510665cffedbdd21a");
    expect(key).toHaveLength(64);
  });

  it("matches independently computed digests for governance_signers/governance_threshold/timelock_delay (field indices 19/20/21, bare Var)", () => {
    // Expected values cross-checked with: python3 -c "import hashlib;
    //   [print(hashlib.blake2b(bytes([0xFF, 1, i]), digest_size=32).hexdigest()) for i in (19, 20, 21)]"
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.governanceSigners, new Uint8Array(0))).toBe(
      "d654a4665a10758bd6e5f072eb18a16842929d141e9feb907c4653055fc86360",
    );
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.governanceThreshold, new Uint8Array(0))).toBe(
      "2a622520fed358fda17491ea1e2fc59c26a30c8d5a4f0974a1818fa125f91249",
    );
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.timelockDelay, new Uint8Array(0))).toBe(
      "fb91768eb3b35051d92f2260fbb6a7162184f4ced25c27a4c63e32d647d8c867",
    );
  });

  it("is distinct from a legacy-range key even when the raw index bytes might otherwise look similar", () => {
    const pathKey = odraMappingDictionaryKey(17, new Uint8Array(0));
    const legacyKey = odraMappingDictionaryKey(15, new Uint8Array(0));
    expect(pathKey).not.toBe(legacyKey);
  });
});

describe("odraMappingDictionaryKey — new P0/P1-A/P0-B read-surface field indices (6/7/8 legacy, 18/23 path)", () => {
  it("matches an independently computed blake2b256 digest for agent_provider_jobs[account 0x11...] (field index 6, Address key)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0,0,0,6]) + bytes([0]) + bytes([0x11]*32), digest_size=32).hexdigest())"
    const key = odraMappingDictionaryKey(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.agentProviderJobs,
      accountAddressToBytes("11".repeat(32)),
    );
    expect(key).toBe("5c4a7c314c20ef818b3f8488a647194440df6d51edc0d782bee60944dd561af2");
  });

  it("matches an independently computed blake2b256 digest for agent_requester_jobs[account 0x11...] (field index 7, Address key)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0,0,0,7]) + bytes([0]) + bytes([0x11]*32), digest_size=32).hexdigest())"
    const key = odraMappingDictionaryKey(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.agentRequesterJobs,
      accountAddressToBytes("11".repeat(32)),
    );
    expect(key).toBe("45dc6fb0cda5281c69432620f8ed7abc702415753f624dd70122c16471d17532");
  });

  it("matches an independently computed blake2b256 digest for agent_skills[account 0x11...] (field index 8, Address key)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0,0,0,8]) + bytes([0]) + bytes([0x11]*32), digest_size=32).hexdigest())"
    const key = odraMappingDictionaryKey(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.agentSkills,
      accountAddressToBytes("11".repeat(32)),
    );
    expect(key).toBe("42385848026076b14fc232ce61a04e00d8781e8d5a1c50e1a85b93fb27b21687");
  });

  it("matches an independently computed blake2b256 digest for disputes[job 1] (field index 18 — PATH encoding, > 15)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0xFF, 1, 18]) + (1).to_bytes(8,'little'), digest_size=32).hexdigest())"
    const key = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.disputes, u64ToBytes(1n));
    expect(key).toBe("b11c31085d88e28e343c4b7c1e6c04f82f1e4ea0f60ec7125c996535d56534c6");
  });

  it("matches an independently computed blake2b256 digest for proposals[1] (field index 23 — PATH encoding, > 15)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0xFF, 1, 23]) + (1).to_bytes(8,'little'), digest_size=32).hexdigest())"
    const key = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.proposals, u64ToBytes(1n));
    expect(key).toBe("612e562559334932e0687a7d2770850a2cbd7144cfce4cb1d8938e7e302d21da");
  });
});

describe("odraMappingDictionaryKey — P4-A panel-arbitration field indices (26-33, all PATH-encoded)", () => {
  it("matches independently computed digests for the three bare-Var panel fields (arbiterPanel/panelThreshold/panelArbiterFee, indices 26/27/28)", () => {
    // Expected values cross-checked with: python3 -c "import hashlib;
    //   [print(hashlib.blake2b(bytes([0xFF, 1, i]), digest_size=32).hexdigest()) for i in (26, 27, 28)]"
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.arbiterPanel, new Uint8Array(0))).toBe(
      "c5cc4d4f43bf73e577e5b8defe5cd20f65c50284fbd3a543742dac01097edefc",
    );
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.panelThreshold, new Uint8Array(0))).toBe(
      "ebe3b6cddf4de00ec0d7bd268a67aca51bb0d76eadacc7675e993e6b50e2eb62",
    );
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.panelArbiterFee, new Uint8Array(0))).toBe(
      "8ff0124e9441620a3c166673d2dc2e3af9c093c6384faa990210c9743c7237c0",
    );
  });

  it("matches independently computed digests for the five job-keyed panel Mapping fields (indices 29-33) at job 1", () => {
    // Expected values cross-checked with: python3 -c "import hashlib;
    //   job1 = (1).to_bytes(8,'little')
    //   [print(hashlib.blake2b(bytes([0xFF, 1, i]) + job1, digest_size=32).hexdigest()) for i in (29,30,31,32,33)]"
    const job1 = u64ToBytes(1n);
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.disputeArbitrationMode, job1)).toBe(
      "b9d3e9a15639c55669184e8099ebf09870253bf6371873a9ba9acda1ed94f0d4",
    );
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.jobPanelSnapshot, job1)).toBe(
      "5b3d4945e04d6524c9628e5b20106550544d5c7a60e0fa9dc2baca0bb03b13e0",
    );
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.jobPanelThresholdSnapshot, job1)).toBe(
      "7cb7bcea82aba4ab29ca4cd5c23d5fc8100a5a1258aa6ec78592844c58a2b003",
    );
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.panelArbiterFeeCollected, job1)).toBe(
      "97a3c0d9062bd2f17981c13ac91ddb20bbd0b3c030b4a069a45d5adc6d5b49e1",
    );
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.panelVotes, job1)).toBe(
      "1f6461771ae57bf421776f3705fe56ddc53207f157aaf95e834d49b347b906bc",
    );
  });
});

describe("u64ToBytes", () => {
  it("encodes little-endian, 8 bytes", () => {
    expect(Buffer.from(u64ToBytes(1n)).toString("hex")).toBe("0100000000000000");
    expect(Buffer.from(u64ToBytes(0x0102030405060708n)).toString("hex")).toBe("0807060504030201");
  });

  it("rejects out-of-range values", () => {
    expect(() => u64ToBytes(-1n)).toThrow(/out of range/);
    expect(() => u64ToBytes(2n ** 64n)).toThrow(/out of range/);
  });
});

describe("accountAddressToBytes", () => {
  it("prefixes the Key::Account tag (0x00) to the raw 32-byte hash", () => {
    const bytes = accountAddressToBytes("account-hash-" + "22".repeat(32));
    expect(bytes.length).toBe(33);
    expect(bytes[0]).toBe(0x00);
    expect(Buffer.from(bytes.slice(1)).toString("hex")).toBe("22".repeat(32));
  });

  it("accepts a bare hex hash without the account-hash- prefix", () => {
    const bytes = accountAddressToBytes("33".repeat(32));
    expect(bytes[0]).toBe(0x00);
  });

  it("rejects a malformed hash", () => {
    expect(() => accountAddressToBytes("not-hex")).toThrow(/expected a 32-byte/);
  });
});
