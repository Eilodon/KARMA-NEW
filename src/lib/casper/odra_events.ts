import type { Address } from "viem";
import type { IndexedEvent } from "../contract.js";

/** `IndexedEvent`'s address-shaped fields are typed as viem's EVM-branded `Address`
 *  (`0x${string}`, 20 bytes) — Casper account/contract hashes are 32 bytes and don't fit that
 *  shape. Checked every consumer of these fields (`skill_indexer_runtime.ts`,
 *  `flow_reputation.ts`): all treat them as opaque, case-insensitive string identifiers
 *  (`.toLowerCase()`, map keys) — none call viem's `getAddress`/checksum validation or otherwise
 *  assume 20 bytes. A 32-byte hex string (prefixed for cosmetic consistency with the rest of the
 *  union) is safe to pass through at runtime; the cast below only papers over the type *label*,
 *  not actual behavior. If a future consumer starts doing EVM-specific validation on these
 *  fields, this cast is exactly where that would need revisiting. */
function asOpaqueAddress(hex: string): Address {
  return `0x${hex}`;
}

/** CES's own storage keys (`casper-event-standard-0.7.0/src/lib.rs`) — a dedicated dictionary and
 *  a bare named-key counter, both outside Odra's own `"state"` dictionary. */
export const EVENTS_DICT = "__events";
export const EVENTS_LENGTH_KEY = "__events_length";

/**
 * Decodes events emitted via `casper-event-standard` (CES) v1.1 — the framework Odra's
 * `#[odra::event]`/`self.env().emit_event(...)` compiles down to (confirmed in
 * `casper-event-standard-0.7.0/src/{lib,contract}.rs`, not assumed):
 *
 *   - Every event is appended to a dedicated dictionary named `"__events"` (NOT Odra's own
 *     `"state"` dictionary that `odra_storage_key.ts`/`live_client.ts`'s `readMapping` reads —
 *     CES manages its own storage, layered alongside Odra's). The dictionary item KEY is simply
 *     the event's zero-based sequential index as a decimal string (`"0"`, `"1"`, …) — no blake2b
 *     hashing, unlike Odra's Mapping/Var fields.
 *   - A separate plain named key `"__events_length"` holds a `u32` counter of how many events
 *     have been emitted so far (read/incremented by the contract on every `emit`).
 *   - Each event's stored bytes are `bytesrepr(name)` (`"event_<StructName>"`, standard
 *     u32-LE-length + utf8 string) followed by each field's own `bytesrepr` encoding, in
 *     declaration order — confirmed via `cargo +nightly expand`'s macro-derived `ToBytes` impl
 *     for `SkillRegistered` (`vec.append(&mut "event_SkillRegistered".to_bytes()?)` then each
 *     field). This is the exact same wire convention `odra_codec.ts`'s `OdraBytesReader` already
 *     decodes for Mapping/Var struct values — only the leading name string is new here.
 *
 * Confirmed end-to-end against the live deployed contract (2026-07-07, `hash-a4e8ab23…`):
 * `getEventCount()` correctly read 5 events; `getEvent()` correctly decoded real
 * `SkillRegistered` (skill_id=1, name="rwa_price_oracle", price=10000000 motes) and `BondUpdated`
 * (1 CSPR bonded) events matching `DEMO_CASPER.md`'s own recorded history exactly, and correctly
 * returned `undefined` (not a throw) for the three event types this indexer doesn't decode
 * (`GovernanceConfigured`, `JobCreated`, `ResultDelivered`) — this was real on-chain data, not a
 * mock. `__events_length` comes back as a native `CLValue::U32`, not Odra's own `List(U8)`
 * Mapping/Var wrapping (see `CasperLiveClient.getEventCount`'s comment).
 */

class EventBytesReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  private take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) {
      throw new Error(`[odra-events] buffer underrun: need ${n} byte(s) at offset ${this.pos}, have ${this.buf.length}`);
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0];
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

  u512(): bigint {
    const len = this.u8();
    const b = this.take(len);
    let v = 0n;
    for (let i = len - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(b[i]);
    return v;
  }

  bytesVec(): Uint8Array {
    return this.take(this.u32());
  }

  string(): string {
    return Buffer.from(this.bytesVec()).toString("utf8");
  }

  /** Odra `Address`: 1-byte variant tag (0 = Account, 1 = Contract) + raw 32-byte hash — same
   *  convention as `odra_codec.ts`'s reader; only the hex string is kept here (event consumers
   *  only need the address as an opaque identifier, matching Pharos's `Address` string fields). */
  addressHex(): string {
    this.u8();
    return Buffer.from(this.take(32)).toString("hex");
  }
}

/** Splits an emitted event's raw bytes into its `"event_<Name>"` name and the remaining
 *  field bytes, per the `ToBytes` layout above. */
export function readEventName(bytes: Uint8Array): { name: string; rest: Uint8Array } {
  const r = new EventBytesReader(bytes);
  const fullName = r.string();
  const name = fullName.startsWith("event_") ? fullName.slice("event_".length) : fullName;
  return { name, rest: bytes.subarray(4 + Buffer.byteLength(fullName, "utf8")) };
}

/** Decodes one CES event into KARMA's chain-agnostic `IndexedEvent` shape (`src/lib/contract.ts`)
 *  — the same union `flow_reputation.ts`/`bm25_index.ts`/`skill_indexer_runtime.ts` already
 *  consume for Pharos, so once fed real events neither needs a Casper-specific code path.
 *  `eventIndex` fills `IndexedEvent.blockNumber`: Casper has no EVM-style block-number-per-log
 *  concept for CES events, but the event's own monotonic sequential index serves the same
 *  ordering/cursor role the indexer needs it for. Returns `undefined` for event types this
 *  indexer doesn't (yet) act on — same "ignore unknown event" tolerance `contract.ts`'s own
 *  `toIndexedEvents` uses for Pharos. */
export function decodeIndexedEvent(eventIndex: number, bytes: Uint8Array): IndexedEvent | undefined {
  const { name, rest } = readEventName(bytes);
  const r = new EventBytesReader(rest);
  const blockNumber = BigInt(eventIndex);

  switch (name) {
    case "SkillRegistered": {
      const skillId = r.u64();
      const owner = r.addressHex();
      const skillName = r.string();
      const pricePerCall = r.u512();
      return { type: "SkillRegistered", blockNumber, skillId, owner: asOpaqueAddress(owner), name: skillName, pricePerCall };
    }
    case "SkillDeactivated": {
      const skillId = r.u64();
      return { type: "SkillDeactivated", blockNumber, skillId };
    }
    case "JobCompleted": {
      const jobId = r.u64();
      const provider = r.addressHex();
      const payout = r.u512();
      const newReputation = BigInt(r.u32());
      return { type: "JobCompleted", blockNumber, jobId, provider: asOpaqueAddress(provider), payout, newReputation };
    }
    case "BondUpdated": {
      const agent = r.addressHex();
      const bondedAmount = r.u512();
      const seedEligible = r.u512();
      return { type: "BondUpdated", blockNumber, agent: asOpaqueAddress(agent), bondedAmount, seedEligible };
    }
    default:
      return undefined;
  }
}
