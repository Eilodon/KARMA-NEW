import { McpServer, ResourceTemplate, type Transport, createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { z } from "zod/v4";
import { ENV } from "../../config/env.js";
import { getRequestContext } from "../../security/context.js";
import { findInputRequestKeyById, globalTaskStore } from "../../core/task_store.js";
import {
  ensureTaskOwner,
  globalNativeTaskRuntime,
  MCP_TASKS_CANCEL_METHOD,
  MCP_TASKS_EXTENSION,
  MCP_TASKS_GET_METHOD,
  MCP_TASKS_UPDATE_METHOD,
  toNativeTaskResult,
} from "./task_runtime.js";
import type { ToolDefinition } from "./tool_registry.js";
import { guardJsonSchema202012, validateJsonAgainstSchema } from "./schema_guard.js";
import type { ResourceDefinition, ResourceTemplateDefinition } from "./resource_runtime.js";
import { wrapResourceRead, wrapResourceTemplateRead } from "./resource_runtime.js";
import type { PromptDefinition } from "./prompt_runtime.js";
import { wrapPromptGet } from "./prompt_runtime.js";

export type McpServerInstance = McpServer;
export type McpTransport = Transport;

type RequestHandler = (request: { params?: unknown }) => Promise<unknown>;

type StandardJsonSchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { value: unknown } | { issues: Array<{ message: string }> };
    readonly jsonSchema: {
      readonly input: () => Record<string, unknown>;
      readonly output: () => Record<string, unknown>;
    };
  };
};

function standardJsonSchema(schema: Record<string, unknown>, kind: "input" | "output"): StandardJsonSchema {
  const guarded = guardJsonSchema202012(schema, kind);
  return {
    "~standard": {
      version: 1,
      vendor: "karma-json-schema-2020-12",
      validate: (value: unknown) => {
        try {
          validateJsonAgainstSchema(guarded, value, kind);
          return { value };
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
        }
      },
      jsonSchema: {
        input: () => guarded,
        output: () => guarded,
      },
    },
  };
}

function registerToolWithExecution(
  server: McpServer,
  name: string,
  config: Record<string, unknown>,
  execution: unknown,
  handler: unknown,
): void {
  // SDK v2 beta.2 registerTool exposes execution.taskSupport ("optional" |
  // "required") as public config -- the alpha's forced-"forbidden" private
  // reflection hack is gone. taskSupport is left unset here (not "optional")
  // so the SDK never claims native task-creation eligibility for these
  // tools: KARMA still owns the whole Task lifecycle in its own adapter
  // (task_runtime.ts / task_store.ts, ADR-006 exactly-once semantics), and
  // opting a tool into SDK-native tasks is a separate, deliberate decision
  // this change does not make. The real execution metadata keeps flowing
  // through _meta / the tools/list override, same as before.
  server.registerTool(name, { ...config, _meta: { ...(config._meta as Record<string, unknown>), execution } }, handler as any);
}

function schemaForToolList(tool: ToolDefinition<unknown>, kind: "input" | "output"): Record<string, unknown> | undefined {
  if (kind === "input" && tool.inputJsonSchema) return guardJsonSchema202012(tool.inputJsonSchema, "input");
  if (kind === "output" && tool.outputSchema) return guardJsonSchema202012(tool.outputSchema, "output");
  if (kind === "input") {
    const schema = z.object(tool.inputSchema as any) as any;
    const jsonSchema = schema?.["~standard"]?.jsonSchema?.input?.({ target: "draft-2020-12" });
    return { type: "object", ...(jsonSchema || { properties: {} }) };
  }
  return undefined;
}

export function registerToolListSurface<T>(server: McpServer, tools: ToolDefinition<T>[]): void {
  setRawRequestHandler(server, "tools/list", async () => ({
    tools: tools.map(tool => {
      const inputSchema = schemaForToolList(tool as unknown as ToolDefinition<unknown>, "input") || { type: "object", properties: {} };
      const outputSchema = schemaForToolList(tool as unknown as ToolDefinition<unknown>, "output");
      return {
        name: tool.name,
        description: tool.description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        annotations: tool.annotations,
        // SDK v2 beta.2's tools/list response codec deletes a top-level
        // `execution` key from every tool entry unconditionally (own reserved
        // wire vocabulary for its native taskSupport signaling), so KARMA's
        // own execution metadata must live under _meta instead to survive
        // the wire -- same class of collision as the tasks/update rename.
        _meta: {
          schemaDialect: "https://json-schema.org/draft/2020-12/schema",
          execution: tool.execution,
          "io.modelcontextprotocol/cache": {
            ttlMs: ENV.MCP_TOOL_LIST_TTL_MS,
            cacheScope: "server",
          },
        },
      };
    }),
    _meta: {
      ttlMs: ENV.MCP_TOOL_LIST_TTL_MS,
      cacheScope: "server",
    },
  }));
}

// SDK v2 beta.2's Protocol#setRequestHandler 3-arg overload (method, {params,
// result?}, handler) is genuinely public: the isSpecRequestMethod gate only
// applies to the 2-arg function-only overload, so custom (non-spec) methods
// such as tasks/get, tasks/update, tasks/cancel, and server/discover register
// through documented API -- confirmed by reading the shipped SDK, which ships
// this exact pattern as its own example (`protocol.setRequestHandler('acme/search',
// { params: SearchParams }, handler)`). `result` is optional and, per the SDK's
// own docs, performs no runtime validation when supplied -- KARMA intentionally
// omits it and keeps its own manual param/result shaping in each handler below,
// so no private request-handler registry reach-around is needed anymore.
const PASSTHROUGH_PARAMS_SCHEMA = z.looseObject({});

function setRawRequestHandler(server: McpServer, method: string, handler: RequestHandler): void {
  server.server.setRequestHandler(
    method,
    { params: PASSTHROUGH_PARAMS_SCHEMA },
    (async (params: unknown) => handler({ params })) as (params: unknown) => Promise<Record<string, unknown>>,
  );
}

export function createMcpServer(version: string): McpServer {
  return new McpServer({
    name: "karma-server",
    version,
  });
}

// serveStdio() (not Server#connect()/StdioServerTransport directly) is the SDK's actual
// 2026-07-28-capable stdio entry point: it owns per-connection era negotiation from the opening
// message's envelope claim and pins one factory-built instance to whichever era it detects,
// legacy or modern -- architecturally the stdio counterpart of createMcpHandler() for HTTP, and
// takes the exact same bare `() => McpServerInstance` factory (runtime.createEphemeralServer()).
// connect() is legacy-2025-only by the SDK's own design, not a bug -- confirmed empirically in
// mcp_discover_non_http.test.ts (server/discover is permanently unreachable on a connect()'d
// instance) and here (server/discover answers correctly once served through serveStdio() instead).
export async function loadStdioServerAdapter() {
  return { serveStdio };
}

export async function loadHttpServerAdapters() {
  return {
    createMcpHandler,
    toNodeHandler,
    createMcpExpressApp,
  };
}

export function registerMcpTool<T>(
  server: McpServer,
  tool: ToolDefinition<T>,
  handler: (args: unknown, extra?: { signal?: AbortSignal }) => Promise<unknown>,
): void {
  const inputJsonSchema = tool.inputJsonSchema
    ? guardJsonSchema202012(tool.inputJsonSchema, "input")
    : undefined;
  const inputSchema = inputJsonSchema
    ? standardJsonSchema(inputJsonSchema, "input")
    : z.object(tool.inputSchema as any);

  // Deliberately NOT forwarding tool.outputSchema into the SDK's own
  // registerTool config: beta.2's validateToolOutput() unconditionally
  // validates EVERY successful (non-error, non-input-required) tools/call
  // result's structuredContent against a registered outputSchema -- but a
  // task-creation acknowledgment (toCreateTaskResult) is a fundamentally
  // different payload than the tool's eventual completed-task output, and
  // has no structuredContent of that shape to validate. KARMA already runs
  // its own, correctly-scoped output validation in runHandlerWithTimeout
  // (execution_pipeline.ts) against the REAL handler result before it is
  // ever returned or cached, so the SDK-level check is both redundant for
  // the completion path and actively wrong for the task-creation path.
  // tools/list still advertises the real outputSchema to clients via
  // registerToolListSurface's own _meta-based override below, which reads
  // tool.outputSchema directly and is unaffected by this omission.
  registerToolWithExecution(
    server,
    tool.name,
    {
      description: tool.description,
      inputSchema,
      annotations: tool.annotations,
      _meta: {
        schemaDialect: "https://json-schema.org/draft/2020-12/schema",
        "io.modelcontextprotocol/cache": {
          ttlMs: ENV.MCP_TOOL_LIST_TTL_MS,
          cacheScope: "server",
        },
      },
    },
    tool.execution,
    handler,
  );
}

export function registerDiscover(server: McpServer): void {
  // SDK v2 beta.2's "server/discover" is fully owned by the SDK on every transport where it's
  // reachable at all, and no handler KARMA installs for that method name can ever win -- confirmed
  // empirically (see http_tasks_conformance.test.ts and mcp_discover_non_http.test.ts):
  //   - HTTP: the Server constructor installs a default "server/discover" handler, and
  //     createMcpHandler's serveModern() unconditionally re-installs it (installModernOnlyHandlers)
  //     on every request, AFTER the ephemeral server (and any override) is created.
  //   - STDIO via serveStdio() (KARMA's real path, see loadStdioServerAdapter() above): a
  //     modern-era-pinned connection gets the exact same installModernOnlyHandlers() treatment as
  //     HTTP, so "server/discover" is SDK-owned there too once negotiated. A legacy-era-pinned
  //     connection (2025-era clients, still served by default) never reaches it at all --
  //     "server/discover" is 2026-07-28-only wire vocabulary.
  //   - STDIO via the low-level Server#connect() API (not KARMA's path, but characterized in
  //     mcp_discover_non_http.test.ts as a cautionary regression guard): the request is rejected
  //     outright with -32601, because connect()'s `initialize` handshake is 2025-era-only by the
  //     SDK's own design -- an instance served via bare connect() can never negotiate into the
  //     2026-07-28 era at all, regardless of what the client claims.
  //
  // Rather than fight any of those, contribute through the SDK's own spec-defined extension point
  // instead: ServerCapabilitiesSchema has a first-class `extensions` record field, and BOTH the
  // SDK's default "server/discover" handler (_ondiscover -> discoverAdvertisedCapabilities, a pure
  // `{...capabilities}` spread) and the 2025-era `initialize` response (_oninitialize ->
  // `capabilities: this.getCapabilities()`) read from the exact same capabilities object.
  // Registering the io.karma/tasks extension here makes it show up automatically in whichever one
  // the connected client actually gets served (initialize for a 2025-era client on either
  // transport, server/discover for a 2026-07-28 client on either transport) -- no handler
  // override, and no fight with the SDK, needed. The richer KARMA-specific protocol/tools metadata
  // this used to carry is still fully advertised over GET /.well-known/mcp.json (server_card.ts),
  // which the SDK never touches.
  server.server.registerCapabilities({
    extensions: {
      [MCP_TASKS_EXTENSION]: {
        methods: [MCP_TASKS_GET_METHOD, MCP_TASKS_UPDATE_METHOD, MCP_TASKS_CANCEL_METHOD],
        list: false,
        pollIntervalMs: ENV.MCP_TASK_POLL_INTERVAL_MS,
        ttlMs: ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS * 1000,
      },
    },
  });
}

export function registerNativeTaskMethods(server: McpServer): void {
  setRawRequestHandler(server, MCP_TASKS_GET_METHOD, async (request) => {
    const ctx = getRequestContext();
    const params = request.params as { taskId?: string } | undefined;
    const taskId = params?.taskId;
    if (!taskId) throw new Error("taskId is required");
    const record = ensureTaskOwner(await globalTaskStore.getTask(taskId), ctx);
    return toNativeTaskResult(record);
  });

  setRawRequestHandler(server, MCP_TASKS_UPDATE_METHOD, async (request) => {
    const ctx = getRequestContext();
    // SDK v2 beta.2 reserves the top-level params keys `inputResponses` and
    // `requestState` on every client-initiated request (protocol 2026-07-28's
    // own multi-round-trip retry vocabulary) and strips them before any
    // handler -- including custom, non-spec methods like this one -- ever
    // sees the request. KARMA's own tasks/update predates that reservation
    // and used the same wire key name, so the value must travel under a
    // KARMA-namespaced key instead. Internal naming (TaskStore, TaskRuntime)
    // is untouched -- only this wire boundary reads the renamed key.
    const params = request.params as { taskId?: string; inputRequestId?: string; taskInputResponses?: Record<string, unknown> } | undefined;
    const taskId = params?.taskId;
    if (!taskId) throw new Error("taskId is required");
    if (!params?.taskInputResponses || typeof params.taskInputResponses !== "object" || Array.isArray(params.taskInputResponses)) {
      throw new Error("taskInputResponses is required");
    }
    if (!params?.inputRequestId || typeof params.inputRequestId !== "string" || params.inputRequestId.trim().length === 0) {
      throw new Error("inputRequestId is required");
    }

    const current = ensureTaskOwner(await globalTaskStore.getTask(taskId), ctx);
    if (current.status !== "input_required" || !current.inputRequests || Object.keys(current.inputRequests).length === 0) {
      throw new Error("Task is not waiting for input");
    }

    const requestKey = findInputRequestKeyById(current.inputRequests, params.inputRequestId);
    if (!requestKey) {
      throw new Error("Stale or unknown inputRequestId");
    }

    const updatedAt = new Date().toISOString();
    const consumed = await globalTaskStore.consumeTaskInput(current.taskId, {
      inputRequestId: params.inputRequestId,
      inputResponses: params.taskInputResponses,
      metadata: {
        lastClientUpdate: {
          inputRequestId: params.inputRequestId,
          inputRequestKey: requestKey,
          inputResponseKeys: Object.keys(params.taskInputResponses),
          updatedAt,
        },
      },
    });

    if (!consumed.ok) {
      if (consumed.reason === "not_found") throw new Error("Task not found or expired");
      if (consumed.reason === "stale_input_request") throw new Error("Stale or unknown inputRequestId");
      throw new Error("Task is not waiting for input");
    }
    ensureTaskOwner(consumed.record, ctx);

    const deliveredToLocalWaiter = globalNativeTaskRuntime.provideInputResponses(
      current.taskId,
      params.inputRequestId,
      params.taskInputResponses,
    );
    if (!deliveredToLocalWaiter) {
      const latest = await globalTaskStore.getTask(current.taskId);
      if (latest) {
        await globalTaskStore.updateTask(current.taskId, {
          metadata: {
            ...(latest.metadata || {}),
            lastClientUpdate: {
              ...((latest.metadata?.lastClientUpdate || {}) as Record<string, unknown>),
              deliveredToLocalWaiter,
              storeResumeRequired: true,
            },
          },
        });
      }
    }

    return {};
  });

  setRawRequestHandler(server, MCP_TASKS_CANCEL_METHOD, async (request) => {
    const ctx = getRequestContext();
    const params = request.params as { taskId?: string; reason?: string } | undefined;
    const taskId = params?.taskId;
    if (!taskId) throw new Error("taskId is required");
    const current = ensureTaskOwner(await globalTaskStore.getTask(taskId), ctx);
    globalNativeTaskRuntime.cancel(current.taskId, params?.reason);
    ensureTaskOwner(await globalTaskStore.cancelTask(current.taskId, params?.reason), ctx);
    return {};
  });
}

// DEBT-008: Resources/Prompts registration. Unlike Tools, the SDK's own registerResource()/
// registerPrompt() already own resources/list, resources/templates/list, resources/read,
// prompts/list, and prompts/get end-to-end (setResourceRequestHandlers/setPromptRequestHandlers,
// called internally) -- there is no KARMA-specific wire-codec quirk to route around here the way
// registerToolListSurface exists for tools/list, so these are thin wrappers, not raw overrides.

export function registerResources(server: McpServer, defs: ResourceDefinition[]): void {
  for (const def of defs) {
    server.registerResource(
      def.name,
      def.uri,
      { title: def.title, description: def.description, mimeType: "application/json" },
      wrapResourceRead(def),
    );
  }
}

export function registerResourceTemplates(server: McpServer, defs: ResourceTemplateDefinition[]): void {
  for (const def of defs) {
    server.registerResource(
      def.name,
      new ResourceTemplate(def.uriTemplate, { list: undefined }),
      { title: def.title, description: def.description, mimeType: "application/json" },
      wrapResourceTemplateRead(def),
    );
  }
}

export function registerPrompts(server: McpServer, defs: PromptDefinition[]): void {
  for (const def of defs) {
    server.registerPrompt(
      def.name,
      { title: def.title, description: def.description, argsSchema: def.argsSchema },
      wrapPromptGet(def),
    );
  }
}

// DEBT-008 Phase 2: the SDK's own setResourceRequestHandlers() only ever declares
// `resources: { listChanged: true }` -- `subscribe` is never set to true anywhere in the SDK
// (confirmed by reading the shipped runtime, not assumed), so a subscriptions/listen request's
// `resourceSubscriptions` filter is silently dropped (honoredSubset() only honors it when
// capabilities.resources.subscribe is advertised) unless something explicitly registers it.
// registerCapabilities merges by key (verified: this coexists with registerDiscover's `extensions`
// and the SDK's own `listChanged`), so this only needs to run once per server instance, after at
// least one subscribe-eligible resource template is registered.
export function registerResourceSubscribeCapability(server: McpServer): void {
  server.server.registerCapabilities({ resources: { subscribe: true } });
}
