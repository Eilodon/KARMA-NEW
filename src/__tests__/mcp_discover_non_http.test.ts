import { describe, expect, test, vi, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";

// DEBT-003 follow-up, corrected after switching KARMA's real STDIO wiring to serveStdio()
// (see loadStdioServerAdapter() in mcp_protocol_adapter.ts and its call site in index.ts) --
// this file no longer characterizes KARMA's actual runtime path. It is kept as a characterization
// / regression guard for the low-level Server#connect() API itself: on connect(), "server/discover"
// is permanently unreachable -- confirmed below. It is 2026-07-28-only wire vocabulary, the
// `initialize` handshake is 2025-era-only, and a connect()-based instance can never negotiate into
// the 2026-07-28 era via initialize (a client claiming protocolVersion "2026-07-28" gets negotiated
// DOWN to "2025-11-25" instead). So any handler registered for "server/discover" -- KARMA's own or
// the SDK's default -- is dead on a connect()'d instance; the request is rejected with -32601
// before dispatch even looks at the handler table. KARMA's real STDIO path (serveStdio()) does not
// have this limitation -- it correctly negotiates into 2026-07-28 per connection and answers
// "server/discover" once there, same as HTTP.
//
// registerDiscover (mcp_protocol_adapter.ts) still doesn't fight the connect()-era limitation
// characterized here: it registers the io.karma/tasks capability through the SDK's public
// registerCapabilities() API (ServerCapabilitiesSchema's first-class `extensions` record field)
// instead of overriding a handler. _oninitialize's response is `capabilities:
// this.getCapabilities()` -- the exact same object "server/discover" would have read from on HTTP
// -- so the io.karma/tasks/* method names ARE reachable on a connect()'d instance too, just via
// `initialize`'s capabilities instead of `server/discover`. This is verified below.
//
// InMemoryTransport stands in for a real STDIO child process so the test doesn't need to spawn
// one; what matters is not "STDIO" specifically but "Server#connect() rather than the
// serveStdio()/createMcpHandler() factory helpers".

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

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<string, (msg: any) => void>();
  clientTransport.onmessage = (msg: any) => {
    if (msg?.id !== undefined && pending.has(String(msg.id))) {
      pending.get(String(msg.id))!(msg);
      pending.delete(String(msg.id));
    }
  };

  await runtime.connect(serverTransport);
  await clientTransport.start();

  const rpc = (body: any): Promise<any> => new Promise(resolve => {
    pending.set(String(body.id), resolve);
    void clientTransport.send(body);
  });

  return {
    rpc,
    close: async () => {
      await clientTransport.close();
      await runtime.close();
      vi.unstubAllEnvs();
    },
  };
}

describe("server/discover on Server#connect() (non-HTTP, e.g. STDIO)", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;

  afterEach(async () => {
    if (harness) await harness.close();
  });

  test("is rejected with Method not found before any handshake", async () => {
    harness = await createHarness();

    const response = await harness.rpc({
      jsonrpc: "2.0",
      id: "discover-1",
      method: "server/discover",
      params: {},
    });

    expect(response.result).toBeUndefined();
    expect(response.error).toEqual({ code: -32601, message: "Method not found" });
  });

  test("stays rejected even after a client claims protocolVersion 2026-07-28 in initialize, because connect() negotiates the 2025-11-25 legacy era instead", async () => {
    harness = await createHarness();

    const initResponse = await harness.rpc({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    expect(initResponse.result.protocolVersion).toBe("2025-11-25");

    const response = await harness.rpc({
      jsonrpc: "2.0",
      id: "discover-1",
      method: "server/discover",
      params: {},
    });
    expect(response.result).toBeUndefined();
    expect(response.error).toEqual({ code: -32601, message: "Method not found" });
  });

  test("the io.karma/tasks extension is reachable anyway, through initialize's capabilities instead of server/discover", async () => {
    harness = await createHarness();

    const initResponse = await harness.rpc({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    expect(initResponse.error).toBeUndefined();
    expect(initResponse.result.capabilities.extensions["io.modelcontextprotocol/tasks"]).toEqual({
      methods: ["io.karma/tasks/get", "io.karma/tasks/update", "io.karma/tasks/cancel"],
      list: false,
      pollIntervalMs: 1000,
      ttlMs: 60000,
    });
  });

  // DEBT-008 follow-up: registerResource()/registerPrompt() auto-populate ServerCapabilities the
  // same way registerTool() does (verified empirically here, not assumed, per DEBT-003's own
  // discipline) -- confirmed reachable via `initialize` on this transport too. Under
  // MCP_SAFE_MODE=true, createServer() only registers the static karma://system/pattern-debt
  // resource (no Pharos/Casper resource template, no prompt -- both gated behind
  // !ENV.MCP_SAFE_MODE since they can make live RPC calls), so `resources` capability surfaces but
  // `prompts` does not.
  test("resources capability surfaces via initialize on this transport; prompts capability is absent under MCP_SAFE_MODE (no prompt registers a live-RPC-capable prompt in safe mode)", async () => {
    harness = await createHarness();

    const initResponse = await harness.rpc({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    expect(initResponse.error).toBeUndefined();
    expect(initResponse.result.capabilities.resources).toEqual({ listChanged: true });
    expect(initResponse.result.capabilities.prompts).toBeUndefined();
  });
});
