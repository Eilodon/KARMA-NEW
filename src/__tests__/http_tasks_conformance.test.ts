import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod/v4";

const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

type Harness = {
  baseUrl: string;
  close: () => Promise<void>;
  rpc: (body: any, tenantId?: string) => Promise<any>;
  createExpiredTask: () => Promise<string>;
};

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function createHarness(): Promise<Harness> {
  vi.resetModules();
  vi.stubEnv("STORAGE_DRIVER", "memory");
  vi.stubEnv("TELEMETRY_DRIVER", "stderr");
  vi.stubEnv("MCP_SAFE_MODE", "true");
  vi.stubEnv("ENABLE_RATE_LIMIT", "false");
  vi.stubEnv("ENABLE_QUOTA", "false");
  vi.stubEnv("MCP_TOOL_TIMEOUT_MS", "5000");
  vi.stubEnv("MCP_IDEMPOTENCY_RESULT_TTL_SECONDS", "60");
  vi.stubEnv("MCP_IDEMPOTENCY_WORKING_TTL_SECONDS", "30");
  vi.stubEnv("MCP_IDEMPOTENCY_ERROR_TTL_SECONDS", "30");
  vi.stubEnv("MCP_TASK_POLL_INTERVAL_MS", "1000");

  const express = (await import("express")).default;
  const { SuperMcpRuntime } = await import("../core/runtime.js");
  const { protocolHeaderValidation } = await import("../middlewares/protocol_header.js");
  const { withRequestContext } = await import("../security/context.js");
  const { loadHttpServerAdapters } = await import("../mcp/adapter/mcp_protocol_adapter.js");
  const { globalTaskStore } = await import("../core/task_store.js");
  const { taskOwner } = await import("../mcp/adapter/task_runtime.js");

  const tools = [
    {
      name: "native_long",
      description: "Native task conformance test tool",
      inputSchema: {
        mode: z.enum(["quick", "input", "block"]).optional(),
        value: z.string().optional(),
      },
      inputJsonSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          mode: { enum: ["quick", "input", "block"] },
          value: { type: "string", maxLength: 100 },
        },
        additionalProperties: false,
      },
      outputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          ok: { type: "boolean" },
          value: { type: "string" },
          input: { type: "object", additionalProperties: true },
        },
        required: ["ok"],
        additionalProperties: false,
      },
      allowedPhases: ["intake"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: { taskSupport: "required" },
      securityPolicy: {
        accessesPrivateData: false,
        exposesUntrustedContent: false,
        externalCommunication: false,
        destructiveEffects: false,
      },
      handler: async (args: any, _state: any, signal?: AbortSignal, context?: any) => {
        if (args.mode === "block") {
          await new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), { once: true });
          });
        }
        if (args.mode === "input") {
          const input = await context?.requestInput?.("Need confirmation");
          return {
            content: [{ type: "text", text: "input received" }],
            structuredContent: { ok: true, input },
          };
        }
        await delay(25);
        return {
          content: [{ type: "text", text: "quick complete" }],
          structuredContent: { ok: true, value: args.value || "done" },
        };
      },
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
    const tenantId = String(req.headers["x-test-tenant"] || "tenant-a");
    const ctx = {
      tenantId,
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

  const rpc = async (body: any, tenantId = "tenant-a") => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "mcp-method": body.method,
      "x-test-tenant": tenantId,
      "x-request-id": `req-${body.id}`,
    };
    if (body.method === "tools/call") headers["mcp-name"] = body.params.name;
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return response.json();
  };

  return {
    baseUrl,
    rpc,
    createExpiredTask: async () => {
      const ctx = {
        tenantId: "tenant-a",
        userId: "user-a",
        clientId: "client-a",
        scopes: ["mcp:invoke"],
        requestId: "req-expired-direct",
        authType: "jwt" as const,
      };
      const task = await globalTaskStore.createTask({
        idempotencyKey: `expired-${Date.now()}`,
        tenantId: ctx.tenantId,
        owner: taskOwner(ctx),
        toolName: "native_long",
        ttlSeconds: 1,
      });
      return task.taskId;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => httpServer.close(err => err ? reject(err) : resolve()));
      await mcpHandler.close().catch(() => undefined);
      await runtime.close();
      vi.unstubAllEnvs();
    },
  };
}

function clientMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {
      // Spec requires each extension entry to be a capability record, not a
      // bare boolean flag -- createMcpHandler validates the _meta envelope
      // strictly (NodeStreamableHTTPServerTransport never parsed it at all).
      extensions: { [TASKS_EXTENSION]: {} },
    },
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    tracestate: "vendor=value",
    baggage: "tenant=redacted",
  };
}

async function pollUntil(rpc: Harness["rpc"], taskId: string, status: string): Promise<any> {
  let last: any;
  for (let i = 0; i < 20; i += 1) {
    last = await rpc({ jsonrpc: "2.0", id: `get-${status}-${i}`, method: "io.karma/tasks/get", params: { taskId, _meta: clientMeta() } });
    if (last.result?.status === status) return last;
    await delay(50);
  }
  return last;
}

describe("HTTP native Tasks conformance", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    if (harness) await harness.close();
  });

  test("tools/list advertises actual JSON Schema 2020-12 and task execution metadata", async () => {
    const response = await harness.rpc({
      jsonrpc: "2.0",
      id: "list-1",
      method: "tools/list",
      params: { _meta: clientMeta() },
    });

    const tool = response.result.tools.find((entry: any) => entry.name === "native_long");
    expect(tool.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(tool.inputSchema.properties.value.maxLength).toBe(100);
    expect(tool.outputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(tool.outputSchema.properties.ok.type).toBe("boolean");
    expect(tool._meta.execution.taskSupport).toBe("required");
    expect(response.result._meta.cacheScope).toBe("server");
  });

  test("server/discover on HTTP advertises io.karma/tasks/* via the SDK's own default handler", async () => {
    // "server/discover" is fully owned by the SDK on HTTP: the Server
    // constructor installs a default handler, and createMcpHandler's
    // serveModern() unconditionally re-installs it (installModernOnlyHandlers)
    // on every request, AFTER the ephemeral server is created -- so a handler
    // KARMA registers directly for this method name can never win (confirmed
    // empirically). Rather than fight that, registerDiscover (mcp_protocol_adapter.ts)
    // now contributes through the SDK's own spec-defined `capabilities.extensions`
    // record via the public registerCapabilities() API. _ondiscover's default
    // response is a pure `{...capabilities}` spread, so the io.karma/tasks
    // extension shows up automatically without any handler override. See
    // mcp_discover_non_http.test.ts for the same mechanism verified on the
    // `initialize` response (the equivalent channel for non-HTTP/STDIO
    // transports, where "server/discover" itself is unreachable regardless).
    const response = await harness.rpc({
      jsonrpc: "2.0",
      id: "discover-1",
      method: "server/discover",
      params: { _meta: clientMeta() },
    });

    expect(response.error).toBeUndefined();
    expect(response.result.supportedVersions).toContain("2026-07-28");
    expect(response.result.serverInfo.name).toBe("karma-server");
    expect(response.result.capabilities.extensions[TASKS_EXTENSION]).toEqual({
      methods: ["io.karma/tasks/get", "io.karma/tasks/update", "io.karma/tasks/cancel"],
      list: false,
      pollIntervalMs: 1000,
      ttlMs: 60000,
    });
  });

  test("tools/call returns CreateTaskResult and reconnect polling returns terminal result", async () => {
    const created = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-quick",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "quick", value: "alpha" },
        _meta: clientMeta(),
      },
    });

    expect(created.result.resultType).toBe("task");
    expect(created.result.taskId).toMatch(/^task_[0-9a-f]{16}$/);

    const completed = await pollUntil(harness.rpc, created.result.taskId, "completed");
    expect(completed.result.resultType).toBe("complete");
    expect(completed.result.result.structuredContent).toEqual({ ok: true, value: "alpha" });
  });

  test("tasks/update resumes input_required task", async () => {
    const created = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-input",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "input" },
        _meta: clientMeta(),
      },
    });

    const inputRequired = await pollUntil(harness.rpc, created.result.taskId, "input_required");
    expect(inputRequired.result.inputRequests.default.method).toBe("elicitation/create");
    const inputRequestId = inputRequired.result.inputRequests.default.inputRequestId;
    expect(inputRequestId).toMatch(/^input_/);

    const updated = await harness.rpc({
      jsonrpc: "2.0",
      id: "update-input",
      method: "io.karma/tasks/update",
      params: {
        taskId: created.result.taskId,
        inputRequestId,
        taskInputResponses: { default: { confirmed: true } },
        _meta: clientMeta(),
      },
    });
    expect(updated.result).toEqual({ resultType: "complete" });

    const completed = await pollUntil(harness.rpc, created.result.taskId, "completed");
    expect(completed.result.result.structuredContent).toEqual({ ok: true, input: { confirmed: true } });
  });


  test("tasks/update rejects early, stale, and duplicate input", async () => {
    const quick = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-early",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "quick", value: "early" },
        _meta: clientMeta(),
      },
    });

    const early = await harness.rpc({
      jsonrpc: "2.0",
      id: "update-early",
      method: "io.karma/tasks/update",
      params: {
        taskId: quick.result.taskId,
        inputRequestId: "input_early",
        taskInputResponses: { default: { confirmed: false } },
        _meta: clientMeta(),
      },
    });
    expect(early.error.message).toContain("Task is not waiting for input");

    const inputTask = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-input-rejects",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "input" },
        _meta: clientMeta(),
      },
    });

    const inputRequired = await pollUntil(harness.rpc, inputTask.result.taskId, "input_required");
    const inputRequestId = inputRequired.result.inputRequests.default.inputRequestId;

    const stale = await harness.rpc({
      jsonrpc: "2.0",
      id: "update-stale",
      method: "io.karma/tasks/update",
      params: {
        taskId: inputTask.result.taskId,
        inputRequestId: "input_stale",
        taskInputResponses: { default: { confirmed: false } },
        _meta: clientMeta(),
      },
    });
    expect(stale.error.message).toContain("Stale or unknown inputRequestId");

    const accepted = await harness.rpc({
      jsonrpc: "2.0",
      id: "update-accepted",
      method: "io.karma/tasks/update",
      params: {
        taskId: inputTask.result.taskId,
        inputRequestId,
        taskInputResponses: { default: { confirmed: true } },
        _meta: clientMeta(),
      },
    });
    expect(accepted.result).toEqual({ resultType: "complete" });

    const duplicate = await harness.rpc({
      jsonrpc: "2.0",
      id: "update-duplicate",
      method: "io.karma/tasks/update",
      params: {
        taskId: inputTask.result.taskId,
        inputRequestId,
        taskInputResponses: { default: { confirmed: "overwritten" } },
        _meta: clientMeta(),
      },
    });
    expect(duplicate.error.message).toContain("Task is not waiting for input");

    const completed = await pollUntil(harness.rpc, inputTask.result.taskId, "completed");
    expect(completed.result.result.structuredContent).toEqual({ ok: true, input: { confirmed: true } });
  });

  test("tasks/cancel cancels a running task", async () => {
    const created = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-block",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "block" },
        _meta: clientMeta(),
      },
    });

    const cancelled = await harness.rpc({
      jsonrpc: "2.0",
      id: "cancel-block",
      method: "io.karma/tasks/cancel",
      params: { taskId: created.result.taskId, reason: "test cancel", _meta: clientMeta() },
    });
    expect(cancelled.result).toEqual({ resultType: "complete" });

    const status = await pollUntil(harness.rpc, created.result.taskId, "cancelled");
    expect(status.result.status).toBe("cancelled");
    expect(status.result.cancelReason).toBe("test cancel");
  });

  test("expired task and cross-tenant reads do not leak existence", async () => {
    const expiredTaskId = await harness.createExpiredTask();
    await delay(1100);
    const expired = await harness.rpc({ jsonrpc: "2.0", id: "get-expired", method: "io.karma/tasks/get", params: { taskId: expiredTaskId, _meta: clientMeta() } });
    expect(expired.error.message).toContain("Task not found or expired");

    const created = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-tenant-a",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "quick", value: "tenant-a" },
        _meta: clientMeta(),
      },
    });
    const crossTenant = await harness.rpc(
      { jsonrpc: "2.0", id: "get-tenant-b", method: "io.karma/tasks/get", params: { taskId: created.result.taskId, _meta: clientMeta() } },
      "tenant-b",
    );
    expect(crossTenant.error.message).toContain("Task not found or expired");
  });
});
