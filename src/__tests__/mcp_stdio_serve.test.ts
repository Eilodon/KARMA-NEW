import { describe, expect, test, vi, afterEach } from "vitest";

// Companion to mcp_discover_non_http.test.ts, which characterizes the low-level Server#connect()
// API's inherent 2025-era-only limitation. This file proves the fix: KARMA's actual STDIO path
// (loadStdioServerAdapter()'s serveStdio(), wired in index.ts) does not have that limitation --
// it negotiates the era per connection from the opening message's envelope and correctly reaches
// "server/discover" once a client claims a modern envelope, using the exact same
// runtime.createEphemeralServer() factory HTTP already uses. A hand-rolled fake "wire" stands in
// for a real STDIO child process, matching the {onmessage,onerror,onclose,start,close,send} shape
// serveStdio()'s `options.transport` expects (the same shape StdioServerTransport itself has) --
// no real stdin/stdout needed.

function clientMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "probe-client", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function createFakeWire() {
  const pending = new Map<string, (msg: any) => void>();
  const wire: any = {
    onmessage: undefined,
    onerror: undefined,
    onclose: undefined,
    async start() {},
    async close() {
      wire.onclose?.();
    },
    async send(message: any) {
      if (message?.id !== undefined && pending.has(String(message.id))) {
        pending.get(String(message.id))!(message);
        pending.delete(String(message.id));
      }
    },
  };
  const rpc = (body: any): Promise<any> =>
    new Promise(resolve => {
      pending.set(String(body.id), resolve);
      wire.onmessage(body);
    });
  return { wire, rpc };
}

async function createHarness() {
  vi.resetModules();
  vi.stubEnv("STORAGE_DRIVER", "memory");
  vi.stubEnv("TELEMETRY_DRIVER", "stderr");
  vi.stubEnv("MCP_SAFE_MODE", "true");
  vi.stubEnv("ENABLE_RATE_LIMIT", "false");
  vi.stubEnv("ENABLE_QUOTA", "false");
  vi.stubEnv("MCP_TASK_POLL_INTERVAL_MS", "1000");
  vi.stubEnv("MCP_IDEMPOTENCY_RESULT_TTL_SECONDS", "60");

  const { SuperMcpRuntime } = await import("../core/runtime.js");
  const { loadStdioServerAdapter } = await import("../mcp/adapter/mcp_protocol_adapter.js");
  const tools = [
    {
      name: "noop",
      description: "No-op tool so the server registers tools/list capability",
      inputSchema: {},
      allowedPhases: ["intake"],
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execution: { taskSupport: "forbidden" },
      handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    },
  ];
  const runtime = new SuperMcpRuntime("test", tools as any);
  await runtime.initialize();

  const { serveStdio } = await loadStdioServerAdapter();
  const { wire, rpc } = createFakeWire();
  const handle = serveStdio(() => runtime.createEphemeralServer(), { transport: wire });

  return {
    rpc,
    close: async () => {
      await handle.close();
      await runtime.close();
      vi.unstubAllEnvs();
    },
  };
}

describe("serveStdio() on KARMA's real ephemeral-server factory (index.ts's actual STDIO path)", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  afterEach(async () => {
    if (harness) await harness.close();
  });

  test("a modern-envelope opening message negotiates 2026-07-28 and server/discover answers, unlike connect()", async () => {
    harness = await createHarness();

    const res = await harness.rpc({
      jsonrpc: "2.0",
      id: "discover-1",
      method: "server/discover",
      params: { _meta: clientMeta() },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.supportedVersions).toContain("2026-07-28");
    expect(res.result.capabilities.extensions["io.modelcontextprotocol/tasks"]).toEqual({
      methods: ["io.karma/tasks/get", "io.karma/tasks/update", "io.karma/tasks/cancel"],
      list: false,
      pollIntervalMs: 1000,
      ttlMs: 60000,
    });
  });

  test("a legacy no-envelope initialize still negotiates 2025-11-25 on the same serveStdio() instance", async () => {
    harness = await createHarness();

    const res = await harness.rpc({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "legacy-client", version: "1.0.0" },
      },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.protocolVersion).toBe("2025-11-25");
  });
});
