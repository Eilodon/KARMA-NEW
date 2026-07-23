import { afterEach, describe, expect, test, vi } from "vitest";

async function importFresh() {
  vi.resetModules();
  vi.stubEnv("STORAGE_DRIVER", "memory");
  vi.stubEnv("ENABLE_RATE_LIMIT", "false");
  vi.stubEnv("ENABLE_QUOTA", "false");
  const resourceRuntime = await import("../mcp/adapter/resource_runtime.js");
  const context = await import("../security/context.js");
  return { ...resourceRuntime, ...context };
}

describe("resource_runtime — wrapResourceRead (static resource)", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("calls assertInProcess, runs read(), and returns a single JSON text content entry", async () => {
    const { wrapResourceRead, withRequestContext, defaultRequestContext } = await importFresh();
    let assertCalled = false;
    const handler = wrapResourceRead({
      name: "test_resource",
      uri: "karma://test/thing",
      title: "Test",
      description: "A test resource",
      assertInProcess: () => { assertCalled = true; },
      read: async () => ({ hello: "world" }),
    });

    const result = await withRequestContext(defaultRequestContext(), () => handler(new URL("karma://test/thing")));

    expect(assertCalled).toBe(true);
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe("karma://test/thing");
    expect(result.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(result.contents[0].text)).toEqual({ hello: "world" });
  });

  test("serializes bigint fields (jsonSafe) instead of crashing JSON.stringify", async () => {
    const { wrapResourceRead, withRequestContext, defaultRequestContext } = await importFresh();
    const handler = wrapResourceRead({
      name: "test_resource_bigint",
      uri: "karma://test/bigint",
      title: "Test",
      description: "A test resource with a bigint field",
      assertInProcess: () => {},
      read: async () => ({ jobId: 42n }),
    });

    const result = await withRequestContext(defaultRequestContext(), () => handler(new URL("karma://test/bigint")));

    expect(JSON.parse(result.contents[0].text)).toEqual({ jobId: "42" });
  });

  test("propagates an assertInProcess failure as a rejected promise (not a thrown sync error)", async () => {
    const { wrapResourceRead, withRequestContext, defaultRequestContext } = await importFresh();
    const handler = wrapResourceRead({
      name: "test_resource_fail",
      uri: "karma://test/fail",
      title: "Test",
      description: "A test resource that fails the in-process canary",
      assertInProcess: () => { throw new Error("not in-process"); },
      read: async () => ({}),
    });

    await expect(
      withRequestContext(defaultRequestContext(), () => handler(new URL("karma://test/fail"))),
    ).rejects.toThrow(/not in-process/);
  });

  test("propagates a read() rejection as a rejected promise", async () => {
    const { wrapResourceRead, withRequestContext, defaultRequestContext } = await importFresh();
    const handler = wrapResourceRead({
      name: "test_resource_read_fail",
      uri: "karma://test/read-fail",
      title: "Test",
      description: "A test resource whose read() rejects",
      assertInProcess: () => {},
      read: async () => { throw new Error("RPC unreachable"); },
    });

    await expect(
      withRequestContext(defaultRequestContext(), () => handler(new URL("karma://test/read-fail"))),
    ).rejects.toThrow(/RPC unreachable/);
  });
});

describe("resource_runtime — wrapResourceTemplateRead (templated resource)", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("passes the matched URI-template variables through to read()", async () => {
    const { wrapResourceTemplateRead, withRequestContext, defaultRequestContext } = await importFresh();
    let receivedVariables: unknown;
    const handler = wrapResourceTemplateRead({
      name: "test_template",
      uriTemplate: "karma://test/agents/{address}/reputation",
      title: "Test",
      description: "A test resource template",
      assertInProcess: () => {},
      read: async (variables) => {
        receivedVariables = variables;
        return { address: variables.address };
      },
    });

    const result = await withRequestContext(defaultRequestContext(), () =>
      handler(new URL("karma://test/agents/0xabc/reputation"), { address: "0xabc" }),
    );

    expect(receivedVariables).toEqual({ address: "0xabc" });
    expect(JSON.parse(result.contents[0].text)).toEqual({ address: "0xabc" });
    expect(result.contents[0].uri).toBe("karma://test/agents/0xabc/reputation");
  });
});
