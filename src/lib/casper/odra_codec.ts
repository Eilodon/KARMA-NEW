/**
 * Decoders for `#[odra::odra_type]` struct/enum values read back off-chain (T13-live).
 *
 * Odra serializes these via `casper_types::bytesrepr::ToBytes`/`FromBytes` — the same
 * convention used natively by every Casper CLValue — and a `Mapping<K, V>` dictionary read
 * comes back as `CLType::List(U8)` (one `CLValue::U8` per byte), confirmed against a real
 * deployed contract read. That's true for *every* value type Odra stores this way, not just
 * contract-defined structs — `decodeU32`/`decodeU512` below decode a plain `u32`/`U512`
 * Mapping value from the exact same wire shape, not the native `CLValue.ui32`/`.ui512` a
 * hand-built mock would suggest. Field layout below is pinned to
 * `contracts-odra/src/agent_skill_registry.rs`'s `Skill`/`Job`/`JobStatus` definitions, in
 * declaration order — reordering those Rust fields without updating this file will silently
 * desync the two. Byte-level rules (string = u32-LE length + utf8; U512 = u8 length + LE
 * magnitude; Option = 1-byte tag; enum-without-data = u8 discriminant in declaration order)
 * were confirmed empirically against this repo's pinned `casper-js-sdk` version, not assumed.
 */

export type CasperAddressKind = "Account" | "Contract";

export interface CasperAddress {
  kind: CasperAddressKind;
  hashHex: string;
}

export type DecodedJobStatus = "Open" | "Delivered" | "Completed" | "Refunded" | "Disputed";

const JOB_STATUS_VARIANTS: readonly DecodedJobStatus[] = [
  "Open",
  "Delivered",
  "Completed",
  "Refunded",
  "Disputed",
];

export interface DecodedSkill {
  owner: CasperAddress;
  name: string;
  description: string;
  mcpEndpoint: string;
  pricePerCallMotes: bigint;
  reputationScore: number;
  totalInvocations: bigint;
  active: boolean;
  registeredAt: bigint;
  minReputationToInvoke: number;
  identityPolicy: number;
}

export interface DecodedJob {
  requester: CasperAddress;
  provider: CasperAddress;
  skillId: bigint;
  taskHash: Uint8Array;
  escrowAmountMotes: bigint;
  deadline: bigint;
  status: DecodedJobStatus;
  resultHash: Uint8Array;
  createdAt: bigint;
  completedAt: bigint;
  evaluator: CasperAddress | undefined;
  evaluatorFeeMotes: bigint;
}

class OdraBytesReader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  private take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) {
      throw new Error(
        `[odra-codec] buffer underrun: need ${n} byte(s) at offset ${this.pos}, have ${this.buf.length}`,
      );
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0];
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u32(): number {
    const b = this.take(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  u64(): bigint {
    const b = this.take(8);
    let v = 0n;
    for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(b[i]);
    return v;
  }

  /** Casper's variable-length big-number encoding: 1-byte length prefix + that many LE bytes. */
  u512(): bigint {
    const len = this.u8();
    const b = this.take(len);
    let v = 0n;
    for (let i = len - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(b[i]);
    return v;
  }

  /** `Vec<u8>` / `casper_types::bytesrepr::Bytes`: u32-LE length prefix + raw bytes. */
  bytesVec(): Uint8Array {
    return this.take(this.u32());
  }

  /** `Vec<u64>`: u32-LE length prefix + that many 8-byte-LE elements (standard bytesrepr
   *  `Vec<T>::to_bytes()` — length prefix, then each element's own encoding back-to-back). */
  vecU64(): bigint[] {
    const len = this.u32();
    const out: bigint[] = [];
    for (let i = 0; i < len; i += 1) out.push(this.u64());
    return out;
  }

  /** `Vec<u32>`: u32-LE length prefix + that many 4-byte-LE elements. */
  vecU32(): number[] {
    const len = this.u32();
    const out: number[] = [];
    for (let i = 0; i < len; i += 1) out.push(this.u32());
    return out;
  }

  string(): string {
    return Buffer.from(this.bytesVec()).toString("utf8");
  }

  /** Odra `Address`: 1-byte variant tag (0 = Account, 1 = Contract) + raw 32-byte hash. */
  address(): CasperAddress {
    const tag = this.u8();
    const hash = this.take(32);
    return { kind: tag === 0 ? "Account" : "Contract", hashHex: Buffer.from(hash).toString("hex") };
  }

  option<T>(inner: () => T): T | undefined {
    return this.u8() === 0 ? undefined : inner();
  }

  /** `Vec<Address>`: u32-LE length prefix + that many `address()`-shaped elements (1-byte tag +
   *  32-byte hash each) back-to-back — standard bytesrepr `Vec<T>::to_bytes()`, same as
   *  `vecU64`/`vecU32` above. */
  vecAddress(): CasperAddress[] {
    const len = this.u32();
    const out: CasperAddress[] = [];
    for (let i = 0; i < len; i += 1) out.push(this.address());
    return out;
  }

  jobStatus(): DecodedJobStatus {
    const tag = this.u8();
    const status = JOB_STATUS_VARIANTS[tag];
    if (status === undefined) {
      throw new Error(`[odra-codec] unknown JobStatus discriminant: ${tag}`);
    }
    return status;
  }
}

/** Decodes a `Skill` struct's raw on-chain bytes (see `contracts-odra/src/agent_skill_registry.rs`). */
export function decodeSkill(bytes: Uint8Array): DecodedSkill {
  const r = new OdraBytesReader(bytes);
  return {
    owner: r.address(),
    name: r.string(),
    description: r.string(),
    mcpEndpoint: r.string(),
    pricePerCallMotes: r.u512(),
    reputationScore: r.u32(),
    totalInvocations: r.u64(),
    active: r.bool(),
    registeredAt: r.u64(),
    minReputationToInvoke: r.u32(),
    identityPolicy: r.u8(),
  };
}

/** Decodes a `Job` struct's raw on-chain bytes (see `contracts-odra/src/agent_skill_registry.rs`). */
export function decodeJob(bytes: Uint8Array): DecodedJob {
  const r = new OdraBytesReader(bytes);
  return {
    requester: r.address(),
    provider: r.address(),
    skillId: r.u64(),
    taskHash: r.bytesVec(),
    escrowAmountMotes: r.u512(),
    deadline: r.u64(),
    status: r.jobStatus(),
    resultHash: r.bytesVec(),
    createdAt: r.u64(),
    completedAt: r.u64(),
    evaluator: r.option(() => r.address()),
    evaluatorFeeMotes: r.u512(),
  };
}

export interface DecodedComposition {
  leafSkillIds: bigint[];
  weightsBps: number[];
}

/** Decodes a `Composition` struct's raw on-chain bytes (`{ leaf_skill_ids: Vec<u64>,
 *  weights_bps: Vec<u32> }` — see `contracts-odra/src/agent_skill_registry.rs`). Stored under the
 *  `compositions` mapping (field index 14); absent entry ⇒ the skill id is a primitive, not a
 *  composite (see `CasperLiveClient.getComposition`/`isComposite`). */
export function decodeComposition(bytes: Uint8Array): DecodedComposition {
  const r = new OdraBytesReader(bytes);
  return { leafSkillIds: r.vecU64(), weightsBps: r.vecU32() };
}

/** Decodes a plain `u32` `Mapping`/`Var` value's raw bytes (e.g. `agent_rep[account]`) — same
 *  `List(U8)` wrapping as compound structs, not a native `CLValue.ui32` (confirmed against a
 *  real deployed contract read: `bonded_amount`/`agent_rep` come back exactly like `Skill`/`Job`
 *  bytes, not as their "native" CLType — the Mapping storage layer is byte-uniform regardless
 *  of the Rust value type it holds). */
export function decodeU32(bytes: Uint8Array): number {
  return new OdraBytesReader(bytes).u32();
}

/** Decodes a plain `U512` `Mapping`/`Var` value's raw bytes (e.g. `bonded_amount[account]`,
 *  `pending_withdrawals[account]`) — see `decodeU32`'s note; same reasoning applies. */
export function decodeU512(bytes: Uint8Array): bigint {
  return new OdraBytesReader(bytes).u512();
}

/** Decodes a plain `Bytes` (`casper_types::bytesrepr::Bytes`) `Mapping` value's raw bytes — e.g.
 *  `rationale_hash[job_id]` (P2-A). Confirmed the hard way against a real deployed contract read:
 *  the stored value carries `Bytes`'s own bytesrepr framing (u32-LE length prefix + raw bytes),
 *  NOT just the raw hash — an earlier version of `getRationaleHash` skipped this and returned the
 *  length prefix concatenated onto the front of every hash. */
export function decodeBytesVec(bytes: Uint8Array): Uint8Array {
  return new OdraBytesReader(bytes).bytesVec();
}

/** Decodes a plain `u64` `Mapping`/`Var` value's raw bytes (e.g. `timelock_delay`) — see
 *  `decodeU32`'s note; same `List(U8)`-wrapped reasoning applies. */
export function decodeU64(bytes: Uint8Array): bigint {
  return new OdraBytesReader(bytes).u64();
}

/** Decodes a plain `Address` `Var` value's raw bytes (e.g. `arbiter`) — see `decodeU32`'s note;
 *  same `List(U8)`-wrapped reasoning applies. */
export function decodeAddress(bytes: Uint8Array): CasperAddress {
  return new OdraBytesReader(bytes).address();
}

/** Decodes a `Vec<Address>` `Var` value's raw bytes (e.g. `governance_signers`) — see
 *  `decodeU32`'s note; same `List(U8)`-wrapped reasoning applies. */
export function decodeAddressList(bytes: Uint8Array): CasperAddress[] {
  return new OdraBytesReader(bytes).vecAddress();
}


/** Decodes a `Vec<u64>` `Mapping` value's raw bytes (e.g. `agent_provider_jobs[account]`,
 *  `agent_requester_jobs[account]`, `agent_skills[account]`) — see `decodeU32`'s note; same
 *  `List(U8)`-wrapped reasoning applies. */
export function decodeU64List(bytes: Uint8Array): bigint[] {
  return new OdraBytesReader(bytes).vecU64();
}

export interface DecodedDisputeInfo {
  disputeBondMotes: bigint;
  providerBondMotes: bigint;
  disputedAt: bigint;
}

/** Decodes a `DisputeInfo` struct's raw on-chain bytes (`{ dispute_bond: U512, provider_bond:
 *  U512, disputed_at: u64 }`, P1-A — see `contracts-odra/src/agent_skill_registry.rs`). Stored
 *  under the `disputes` mapping (field index 18). */
export function decodeDisputeInfo(bytes: Uint8Array): DecodedDisputeInfo {
  const r = new OdraBytesReader(bytes);
  return { disputeBondMotes: r.u512(), providerBondMotes: r.u512(), disputedAt: r.u64() };
}

export type DecodedProposalAction =
  | { kind: "SetCrossChainRep"; agent: CasperAddress; score: number; sourceChain: string }
  | { kind: "SetArbiter"; newArbiter: CasperAddress }
  | { kind: "SetDisputeBondBps"; bps: number };

export interface DecodedGovernanceProposal {
  action: DecodedProposalAction;
  proposer: CasperAddress;
  proposedAt: bigint;
  executed: boolean;
  cancelled: boolean;
}

/** Decodes a `GovernanceProposal` struct's raw on-chain bytes (P0-B — see
 *  `contracts-odra/src/agent_skill_registry.rs`). Stored under the `proposals` mapping (field
 *  index 23).
 *
 *  `action: ProposalAction` is a data-carrying enum; decoded here as a u8 discriminant (variant
 *  declaration order: 0 = SetCrossChainRep, 1 = SetArbiter, 2 = SetDisputeBondBps) followed by
 *  that variant's fields in declaration order — the standard `casper_types` derive-macro
 *  convention for enums (the same shape `Key`/`CLType`/`Transform` use). Unlike every other
 *  decoder in this file, THIS specific shape has not yet been confirmed against a real deployed
 *  contract read (no proposal has been read back through this path in this repo so far) — the
 *  struct fields (`proposer`/`proposed_at`/`executed`/`cancelled`) follow the same
 *  empirically-confirmed sequential-field convention as `decodeSkill`/`decodeJob`, but the enum
 *  tag itself is inferred from the derive macro's documented behavior, not independently
 *  chain-verified. If a live `casper_get_proposal` call ever comes back looking wrong, check here
 *  first. */
export function decodeGovernanceProposal(bytes: Uint8Array): DecodedGovernanceProposal {
  const r = new OdraBytesReader(bytes);
  const tag = r.u8();
  let action: DecodedProposalAction;
  if (tag === 0) {
    action = { kind: "SetCrossChainRep", agent: r.address(), score: r.u32(), sourceChain: r.string() };
  } else if (tag === 1) {
    action = { kind: "SetArbiter", newArbiter: r.address() };
  } else if (tag === 2) {
    action = { kind: "SetDisputeBondBps", bps: r.u32() };
  } else {
    throw new Error(`[odra-codec] unknown ProposalAction discriminant: ${tag}`);
  }
  return {
    action,
    proposer: r.address(),
    proposedAt: r.u64(),
    executed: r.bool(),
    cancelled: r.bool(),
  };
}
