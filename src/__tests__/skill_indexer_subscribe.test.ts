import { afterEach, describe, expect, it, vi } from "vitest";
import type { IndexedEvent } from "../lib/contract.js";

// Isolated from skill_indexer_runtime.test.ts (which never touches contract.js) so this file's
// vi.mock of contract.js can't interact with that suite's assumptions or module-level state.
const capturedOnEvent: Array<(e: IndexedEvent) => void> = [];

vi.mock("../lib/contract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/contract.js")>();
  return {
    ...actual,
    startSkillIndexer: vi.fn((onEvent: (e: IndexedEvent) => void) => {
      capturedOnEvent.push(onEvent);
      return {
        health: () => ({ watching: true, lastIndexedBlock: 0 }),
        stop: () => {},
      };
    }),
  };
});

describe("startKarmaIndexer — onResourceEvent (DEBT-008 Phase 2)", () => {
  afterEach(async () => {
    const { stopKarmaIndexer } = await import("../lib/skill_indexer_runtime.js");
    stopKarmaIndexer();
    capturedOnEvent.length = 0;
    vi.clearAllMocks();
  });

  it("fires onResourceEvent alongside the reconcile chain, with the raw event", async () => {
    const { startKarmaIndexer } = await import("../lib/skill_indexer_runtime.js");
    const onResourceEvent = vi.fn();
    const svc = { readSkill: vi.fn(), readJob: vi.fn(), indexUpsert: vi.fn(), indexDiscard: vi.fn() } as any;

    startKarmaIndexer(svc, 0n, onResourceEvent);
    expect(capturedOnEvent).toHaveLength(1);

    const event: IndexedEvent = { type: "SkillDeactivated", blockNumber: 1n, skillId: 7n };
    capturedOnEvent[0](event);

    expect(onResourceEvent).toHaveBeenCalledWith(event);
  });

  it("swallows a throwing onResourceEvent instead of letting it escape into the watcher", async () => {
    const { startKarmaIndexer } = await import("../lib/skill_indexer_runtime.js");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onResourceEvent = vi.fn(() => { throw new Error("hook exploded"); });
    const svc = { readSkill: vi.fn(), readJob: vi.fn(), indexUpsert: vi.fn(), indexDiscard: vi.fn() } as any;

    startKarmaIndexer(svc, 0n, onResourceEvent);
    const event: IndexedEvent = { type: "SkillDeactivated", blockNumber: 1n, skillId: 7n };

    expect(() => capturedOnEvent[0](event)).not.toThrow();
    expect(onResourceEvent).toHaveBeenCalledWith(event);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("onResourceEvent hook failed"), expect.any(Error));
    consoleError.mockRestore();
  });

  it("is a no-op when onResourceEvent is omitted (backward compatible with existing callers)", async () => {
    const { startKarmaIndexer } = await import("../lib/skill_indexer_runtime.js");
    const svc = { readSkill: vi.fn(), readJob: vi.fn(), indexUpsert: vi.fn(), indexDiscard: vi.fn() } as any;

    startKarmaIndexer(svc, 0n);
    const event: IndexedEvent = { type: "SkillDeactivated", blockNumber: 1n, skillId: 7n };

    expect(() => capturedOnEvent[0](event)).not.toThrow();
  });
});
