import { describe, it, expect } from "vitest";
import casperSdk from "casper-js-sdk";
import { readEventName, decodeIndexedEvent } from "../lib/casper/odra_events.js";

const { CLValue } = casperSdk;

/** Same test-only byte builders as `casper_odra_codec.test.ts` — primitives taken from
 *  `casper-js-sdk`'s own encoders, not a second hand-rolled copy of the same assumptions. */
function str(s: string): Uint8Array {
  return CLValue.newCLString(s).bytes();
}
function u512(v: string): Uint8Array {
  return CLValue.newCLUInt512(v).bytes();
}
function u32(v: number): Uint8Array {
  return CLValue.newCLUInt32(v).bytes();
}
function u64(v: string): Uint8Array {
  return CLValue.newCLUint64(v).bytes();
}
function address(hashHex: string): Uint8Array {
  return Buffer.concat([Buffer.from([0]), Buffer.from(hashHex, "hex")]); // Account tag
}
function concat(...parts: Uint8Array[]): Uint8Array {
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}
/** `"event_<Name>".to_bytes()` — the CES name prefix every emitted event's bytes start with. */
function eventName(name: string): Uint8Array {
  return str(`event_${name}`);
}

const OWNER_HASH = "11".repeat(32);

describe("readEventName", () => {
  it("splits the event_<Name> prefix from the remaining field bytes", () => {
    const bytes = concat(eventName("SkillDeactivated"), u64("7"));
    const { name, rest } = readEventName(bytes);
    expect(name).toBe("SkillDeactivated");
    expect(Buffer.from(rest).toString("hex")).toBe(Buffer.from(u64("7")).toString("hex"));
  });
});

describe("decodeIndexedEvent", () => {
  it("decodes SkillRegistered in Rust field order (skill_id, owner, name, price_per_call)", () => {
    const bytes = concat(eventName("SkillRegistered"), u64("1"), address(OWNER_HASH), str("rwa_price_oracle"), u512("10000000"));
    const event = decodeIndexedEvent(0, bytes);
    expect(event).toEqual({
      type: "SkillRegistered",
      blockNumber: 0n,
      skillId: 1n,
      owner: `0x${OWNER_HASH}`,
      name: "rwa_price_oracle",
      pricePerCall: 10_000_000n,
    });
  });

  it("decodes SkillDeactivated (just skill_id)", () => {
    const bytes = concat(eventName("SkillDeactivated"), u64("7"));
    const event = decodeIndexedEvent(3, bytes);
    expect(event).toEqual({ type: "SkillDeactivated", blockNumber: 3n, skillId: 7n });
  });

  it("decodes JobCompleted (job_id, provider, payout, new_reputation)", () => {
    const bytes = concat(eventName("JobCompleted"), u64("2"), address(OWNER_HASH), u512("10000000"), u32(75));
    const event = decodeIndexedEvent(5, bytes);
    expect(event).toEqual({
      type: "JobCompleted",
      blockNumber: 5n,
      jobId: 2n,
      provider: `0x${OWNER_HASH}`,
      payout: 10_000_000n,
      newReputation: 75n,
    });
  });

  it("decodes BondUpdated (agent, bonded_amount, seed_eligible)", () => {
    const bytes = concat(eventName("BondUpdated"), address(OWNER_HASH), u512("1000000000"), u512("5"));
    const event = decodeIndexedEvent(9, bytes);
    expect(event).toEqual({
      type: "BondUpdated",
      blockNumber: 9n,
      agent: `0x${OWNER_HASH}`,
      bondedAmount: 1_000_000_000n,
      seedEligible: 5n,
    });
  });

  it("returns undefined for an event type this indexer doesn't act on, instead of throwing", () => {
    const bytes = concat(eventName("ArbiterUpdated"), address(OWNER_HASH), address(OWNER_HASH));
    expect(decodeIndexedEvent(0, bytes)).toBeUndefined();
  });
});
