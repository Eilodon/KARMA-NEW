import type { Server } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * DEBT-008 HTTP conformance — mirrors http_tasks_conformance.test.ts's harness shape. The first
 * describe block runs with MCP_SAFE_MODE=true (same convention as that file and
 * mcp_discover_non_http.test.ts), which means only the static karma://system/pattern-debt
 * resource registers; the Pharos/Casper resource templates and the agent_vetting prompt are
 * skipped (they can make live RPC calls — see runtime.ts's createServer()). That is exercised
 * directly here as the safe-mode-gating assertion, not worked around. The second describe block
 * runs with { safeMode: false } to prove the inverse at the wire level: prompts/list and
 * resources/templates/list actually declare the capability and return the real registered
 * items once safe mode is off, not just in the unit-level fakes below. The live-RPC-backed
 * read()/build() functions themselves are still covered at the unit level in
 * resource_runtime.test.ts/prompt_runtime.test.ts via fake ResourceDefinition/PromptDefinition
 * objects, so this file's job stays the wire protocol, not re-testing chain reads.
 */

type Harness = {
  baseUrl: string;
  close: () => Promise<void>;
  rpc: (body: any, extraHeaders?: Record<string, string>) => Promise<any>;
  // Only meaningful when created with { safeMode: false } — Phase 2's subscriptions/listen test
  // publishes directly onto this, standing in for what the real Pharos indexer's onResourceEvent
  // hook does in index.ts.
  mcpHandler: { notify: { resourceUpdated(uri: string): void } };
};

async function createHarness(options: { safeMode?: boolean } = {}): Promise<Harness> {
  const safeMode = options.safeMode ?? true;
  vi.resetModules();
  vi.stubEnv("STORAGE_DRIVER", "memory");
  vi.stubEnv("TELEMETRY_DRIVER", "stderr");
  vi.stubEnv("MCP_SAFE_MODE", safeMode ? "true" : "false");
  vi.stubEnv("ENABLE_RATE_LIMIT", "false");
  vi.stubEnv("ENABLE_QUOTA", "false");
  vi.stubEnv("MCP_TASK_POLL_INTERVAL_MS", "1000");
  vi.stubEnv("MCP_IDEMPOTENCY_RESULT_TTL_SECONDS", "60");

  const express = (await import("express")).default;
  const { SuperMcpRuntime } = await import("../core/runtime.js");
  const { protocolHeaderValidation } = await import("../middlewares/protocol_header.js");
  const { withRequestContext } = await import("../security/context.js");
  const { loadHttpServerAdapters } = await import("../mcp/adapter/mcp_protocol_adapter.js");

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
  const { createMcpHandler, toNodeHandler } = await loadHttpServerAdapters();
  const mcpHandler = createMcpHandler(() => runtime.createEphemeralServer(), { legacy: "reject" });
  const mcpNodeHandler = toNodeHandler(mcpHandler);

  const app = express();
  app.use(express.json());
  app.use("/mcp", protocolHeaderValidation);
  app.post("/mcp", async (req, res) => {
    const ctx = {
      tenantId: "tenant-a",
      userId: "user-a",
      clientId: "client-a",
      scopes: ["mcp:invoke"],
      requestId: String(req.headers["x-request-id"] || `req-${req.body?.id || Date.now()}`),
      authType: "jwt" as const,
    };
    await withRequestContext(ctx, async () => {
      await mcpNodeHandler(req, res, req.body);
    });
  });

  const httpServer = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("test HTTP server did not expose a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const rpc = async (body: any, extraHeaders: Record<string, string> = {}) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "mcp-method": body.method,
      "x-request-id": `req-${body.id}`,
      ...extraHeaders,
    };
    if (body.method === "resources/read" && !("mcp-name" in extraHeaders)) headers["mcp-name"] = body.params?.uri;
    if (body.method === "prompts/get" && !("mcp-name" in extraHeaders)) headers["mcp-name"] = body.params?.name;
    const response = await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    return response.json();
  };

  return {
    baseUrl,
    rpc,
    mcpHandler,
    close: async () => {
      await new Promise<void>((resolve, reject) => httpServer.close(err => err ? reject(err) : resolve()));
      await mcpHandler.close().catch(() => undefined);
      await runtime.close();
      vi.unstubAllEnvs();
    },
  };
}

/** Parses a Streamable-HTTP `subscriptions/listen` SSE response body — `event: message\ndata:
 *  {...}\n\n` frames — into JSON-RPC messages, one per resolved `next()` call. */
function sseMessageReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<any> {
      for (;;) {
        const frameEnd = buffer.indexOf("\n\n");
        if (frameEnd !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const dataLine = frame.split("\n").find(line => line.startsWith("data: "));
          if (dataLine) return JSON.parse(dataLine.slice("data: ".length));
          continue; // a bare keepalive comment frame (": keepalive") — skip and keep reading
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream ended before a data frame arrived");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

function clientMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

describe("HTTP Resources/Prompts conformance (DEBT-008)", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.close();
  });

  test("resources/list surfaces only the static karma://system/pattern-debt resource under MCP_SAFE_MODE", async () => {
    harness = await createHarness();
    const res = await harness.rpc({ jsonrpc: "2.0", id: 1, method: "resources/list", params: { _meta: clientMeta() } });

    expect(res.error).toBeUndefined();
    expect(res.result.resources).toHaveLength(1);
    expect(res.result.resources[0]).toMatchObject({ name: "system_pattern_debt", title: "KARMA pattern-debt report" });
  });

  test("resources/templates/list is empty under MCP_SAFE_MODE (Pharos/Casper templates make live RPC calls)", async () => {
    harness = await createHarness();
    const res = await harness.rpc({ jsonrpc: "2.0", id: 2, method: "resources/templates/list", params: { _meta: clientMeta() } });

    expect(res.error).toBeUndefined();
    expect(res.result.resourceTemplates).toEqual([]);
  });

  test("prompts/list is Method-not-found under MCP_SAFE_MODE — no prompt ever registers, so the SDK never declares the prompts capability at all (not merely an empty list)", async () => {
    harness = await createHarness();
    const res = await harness.rpc({ jsonrpc: "2.0", id: 3, method: "prompts/list", params: { _meta: clientMeta() } });

    expect(res.result).toBeUndefined();
    expect(res.error).toEqual({ code: -32601, message: "Method not found" });
  });

  test("resources/read returns the pattern-debt report as JSON text content", async () => {
    harness = await createHarness();
    const res = await harness.rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: "karma://system/pattern-debt", _meta: clientMeta() },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.contents).toHaveLength(1);
    expect(res.result.contents[0].uri).toBe("karma://system/pattern-debt");
    expect(res.result.contents[0].mimeType).toBe("application/json");
    const parsed = JSON.parse(res.result.contents[0].text);
    expect(parsed.generatedBy).toBe("karma://system/pattern-debt");
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  test("missing Mcp-Name on resources/read is rejected with -32020 and mentions the actual method", async () => {
    harness = await createHarness();
    // harness.rpc() auto-fills Mcp-Name for resources/read, so this one request is built by hand
    // to genuinely omit the header (not send an empty value, which is a different validation branch).
    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "mcp-method": "resources/read",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: "karma://system/pattern-debt", _meta: clientMeta() },
      }),
    });
    const res = await response.json();

    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(-32020);
    expect(res.error.message).toMatch(/resources\/read/);
  });

  test("Mcp-Name mirrors body.params.uri for resources/read — a mismatched value is rejected", async () => {
    harness = await createHarness();
    const res = await harness.rpc(
      { jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "karma://system/pattern-debt", _meta: clientMeta() } },
      { "mcp-name": "karma://system/something-else" },
    );

    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(-32020);
    expect(res.error.message).toContain("does not match body params.uri");
  });

  test("prompts/get under MCP_SAFE_MODE returns a clean Method-not-found JSON-RPC error, not a crash (prompts capability was never declared)", async () => {
    harness = await createHarness();
    const res = await harness.rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "prompts/get",
      params: { name: "agent_vetting", _meta: clientMeta() },
    });

    expect(res.result).toBeUndefined();
    expect(res.error).toEqual({ code: -32601, message: "Method not found" });
  });
});

describe("HTTP Resources/Prompts conformance — MCP_SAFE_MODE=false (DEBT-008)", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.close();
  });

  test("prompts/list declares the prompts capability and returns agent_vetting once MCP_SAFE_MODE is off", async () => {
    harness = await createHarness({ safeMode: false });
    const res = await harness.rpc({ jsonrpc: "2.0", id: 20, method: "prompts/list", params: { _meta: clientMeta() } });

    expect(res.error).toBeUndefined();
    expect(res.result.prompts).toHaveLength(1);
    expect(res.result.prompts[0]).toMatchObject({
      name: "agent_vetting",
      title: "Vet an agent before entrusting it with a job",
    });
    expect(res.result.prompts[0].arguments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "pharosAddress", required: false }),
        expect.objectContaining({ name: "casperAccountHash", required: false }),
      ]),
    );
  });

  test("resources/templates/list returns the Pharos and Casper templates once MCP_SAFE_MODE is off", async () => {
    harness = await createHarness({ safeMode: false });
    const res = await harness.rpc({ jsonrpc: "2.0", id: 21, method: "resources/templates/list", params: { _meta: clientMeta() } });

    expect(res.error).toBeUndefined();
    expect(res.result.resourceTemplates.length).toBeGreaterThan(0);
    expect(res.result.resourceTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "pharos_job", uriTemplate: "karma://pharos/jobs/{jobId}" }),
        expect.objectContaining({ name: "casper_account_state", uriTemplate: "karma://casper/accounts/{accountHash}/state" }),
      ]),
    );
  });
});

describe("HTTP subscriptions/listen push delivery (DEBT-008 Phase 2)", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.close();
  });

  test("a subscriptions/listen stream receives notifications/resources/updated after mcpHandler.notify.resourceUpdated(uri) — the exact call index.ts's onResourceEvent hook makes", async () => {
    harness = await createHarness({ safeMode: false });
    const uri = "karma://pharos/jobs/42";

    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "mcp-method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "subscriptions/listen",
        params: { notifications: { resourceSubscriptions: [uri] }, _meta: clientMeta() },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = sseMessageReader(response.body!);

    // First frame: the ack, reflecting the honored filter back (proves registerResourceSubscribeCapability
    // actually made capabilities.resources.subscribe=true visible — without it, honoredSubset() would
    // drop resourceSubscriptions and this would come back empty).
    const ack = await reader.next();
    expect(ack.method).toBe("notifications/subscriptions/acknowledged");
    expect(ack.params.notifications).toEqual({ resourceSubscriptions: [uri] });

    // Simulate what the real Pharos indexer's onResourceEvent hook does in index.ts (see
    // src/index.ts and karma.resources.ts's indexedEventToResourceUris).
    harness.mcpHandler.notify.resourceUpdated(uri);

    const update = await reader.next();
    expect(update.method).toBe("notifications/resources/updated");
    expect(update.params.uri).toBe(uri);

    await reader.cancel();
  });

  test("a subscriptions/listen stream does NOT receive an update for a URI it did not subscribe to", async () => {
    harness = await createHarness({ safeMode: false });

    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "mcp-method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "subscriptions/listen",
        params: { notifications: { resourceSubscriptions: ["karma://pharos/jobs/42"] }, _meta: clientMeta() },
      }),
    });
    const reader = sseMessageReader(response.body!);
    await reader.next(); // ack

    harness.mcpHandler.notify.resourceUpdated("karma://pharos/jobs/999"); // different URI, not subscribed
    harness.mcpHandler.notify.resourceUpdated("karma://pharos/jobs/42"); // the one actually subscribed

    const update = await reader.next();
    expect(update.method).toBe("notifications/resources/updated");
    expect(update.params.uri).toBe("karma://pharos/jobs/42"); // the filtered-out one never arrived first

    await reader.cancel();
  });
});
