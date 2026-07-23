import { ENV } from "../../config/env.js";
import type { RequestContext } from "../../security/context.js";
import type { TaskHandleRecord, TaskStatus } from "../../core/task_store.js";

export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/**
 * SDK v2 beta.2's 2026-07-28 dispatch gate hard-rejects "Method not found"
 * for ANY request whose method name is recognized by EITHER protocol era's
 * spec-method registry but absent from the negotiated era's own registry --
 * before handler lookup ever runs (confirmed by reading the shipped runtime:
 * `isSpecRequestMethod` unions the 2025 AND 2026 registries, and "tasks/get"
 * / "tasks/cancel" are still literal keys in the deprecated 2025-11-25
 * registry even though the 2026 registry dropped them). No handler
 * registration technique -- public or private -- can route around this gate,
 * so KARMA's own Tasks methods live under a karma-owned namespace that can
 * never collide with a current or future spec method name.
 */
export const MCP_TASKS_GET_METHOD = "io.karma/tasks/get";
export const MCP_TASKS_UPDATE_METHOD = "io.karma/tasks/update";
export const MCP_TASKS_CANCEL_METHOD = "io.karma/tasks/cancel";

export interface NativeTaskDescriptor {
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  pollIntervalMs: number;
  ttlMs: number;
}

export interface CreateTaskResult extends NativeTaskDescriptor {
  resultType: "task";
}

export interface NativeTaskStatusResult extends NativeTaskDescriptor {
  /**
   * Current draft Tasks SEP uses `complete` for the task-status payload returned
   * by tasks/get, even when status is still working/input_required.
   */
  resultType: "complete";
  inputRequests?: TaskInputRequests;
  result?: unknown;
  error?: string;
  cancelReason?: string;
}

export interface TaskInputRequest {
  method: string;
  params: Record<string, unknown>;
  /** Per-prompt nonce that tasks/update must echo to prevent stale or early input. */
  inputRequestId?: string;
}

export type TaskInputRequests = Record<string, TaskInputRequest>;
export type TaskInputResponses = Record<string, unknown>;

export interface TaskUpdateInput {
  taskId: string;
  inputRequestId: string;
  inputResponses: TaskInputResponses;
}

export interface TaskCancelInput {
  taskId: string;
  reason?: string;
}

export class TaskCancelledError extends Error {
  constructor(public taskId: string, public reason = "cancelled") {
    super(`Task ${taskId} was cancelled: ${reason}`);
    this.name = "TaskCancelledError";
  }
}

export interface McpTraceContext {
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
  trace_id?: string;
  span_id?: string;
}

class NativeTaskRuntime {
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly inputWaiters = new Map<string, {
    requestKey: string;
    inputRequestId: string;
    resolve: (input: unknown) => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  }>();

  register(taskId: string, controller: AbortController): () => void {
    this.activeControllers.set(taskId, controller);
    return () => {
      if (this.activeControllers.get(taskId) === controller) {
        this.activeControllers.delete(taskId);
      }
    };
  }

  cancel(taskId: string, reason = "cancelled"): boolean {
    const waiter = this.inputWaiters.get(taskId);
    if (waiter) {
      waiter.reject(new TaskCancelledError(taskId, reason));
      waiter.cleanup();
      this.inputWaiters.delete(taskId);
    }

    const controller = this.activeControllers.get(taskId);
    if (!controller) return false;
    if (!controller.signal.aborted) {
      controller.abort(new TaskCancelledError(taskId, reason));
    }
    return true;
  }

  isActive(taskId: string): boolean {
    return this.activeControllers.has(taskId);
  }

  requestInput(taskId: string, signal?: AbortSignal, requestKey = "default", inputRequestId = ""): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted", { cause: signal.reason }));
    const existing = this.inputWaiters.get(taskId);
    if (existing) {
      existing.reject(new Error(`Task ${taskId} already has a pending input request`));
      existing.cleanup();
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.inputWaiters.delete(taskId);
        reject(signal?.reason instanceof Error ? signal.reason : new TaskCancelledError(taskId));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.inputWaiters.set(taskId, {
        requestKey,
        inputRequestId,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
    });
  }

  provideInputResponses(taskId: string, inputRequestId: string, inputResponses: TaskInputResponses): boolean {
    const waiter = this.inputWaiters.get(taskId);
    if (!waiter || waiter.inputRequestId !== inputRequestId) return false;
    waiter.resolve(Object.prototype.hasOwnProperty.call(inputResponses, waiter.requestKey)
      ? inputResponses[waiter.requestKey]
      : inputResponses);
    waiter.cleanup();
    this.inputWaiters.delete(taskId);
    return true;
  }
}

export const globalNativeTaskRuntime = new NativeTaskRuntime();

function metaObject(args: unknown): Record<string, unknown> | undefined {
  return args !== null && typeof args === "object"
     
    ? (args as Record<string, unknown>)["_meta"] as Record<string, unknown> | undefined
    : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function declaresExtension(value: unknown): boolean {
  if (Array.isArray(value)) return value.includes(MCP_TASKS_EXTENSION);
  const obj = objectValue(value);
  return Boolean(obj?.[MCP_TASKS_EXTENSION]);
}

export function taskOwner(ctx: RequestContext): string {
  return `${ctx.tenantId}:${ctx.clientId}:${ctx.userId}`;
}

export function clientSupportsNativeTasks(args: unknown): boolean {
  const meta = metaObject(args);
  if (!meta) return false;

  const candidates = [
    meta.supportedExtensions,
    meta.extensions,
    meta.capabilities,
    objectValue(meta["io.modelcontextprotocol/clientCapabilities"])?.extensions,
    objectValue(meta["io.modelcontextprotocol/clientCapabilities"])?.capabilities,
  ];

  return candidates.some(declaresExtension);
}

export function extractMcpTraceContext(args: unknown): McpTraceContext {
  const meta = metaObject(args);
  const traceparent = typeof meta?.traceparent === "string" ? meta.traceparent : undefined;
  const tracestate = typeof meta?.tracestate === "string" ? meta.tracestate : undefined;
  const baggage = typeof meta?.baggage === "string" ? meta.baggage : undefined;
  const match = traceparent?.match(/^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i);
  return {
    traceparent,
    tracestate,
    baggage,
    trace_id: match?.[1],
    span_id: match?.[2],
  };
}

export function toTaskDescriptor(record: TaskHandleRecord): NativeTaskDescriptor {
  return {
    taskId: record.taskId,
    status: record.status,
    createdAt: record.createdAt,
    lastUpdatedAt: record.updatedAt,
    pollIntervalMs: ENV.MCP_TASK_POLL_INTERVAL_MS,
    ttlMs: Math.max(0, record.expiresAt - Date.now()),
  };
}

function defaultInputRequests(record: TaskHandleRecord): TaskInputRequests | undefined {
  return record.inputRequests;
}

/**
 * SDK v2 beta.2 unconditionally validates every tools/call handler's return
 * value as CallToolResult | InputRequiredResult (Server#_wrapHandler calls
 * codec.validateResult for "tools/call" regardless of the tool's declared
 * execution.taskSupport -- confirmed empirically by reading the shipped
 * runtime: taskSupport has zero effect on result validation, it is a
 * tools/list-only advertisement). CallToolResultSchema requires `content`
 * and is built with `z.looseObject`, so KARMA's own resultType:"task" +
 * descriptor fields survive as extra wire-preserved keys once `content`
 * satisfies the SDK's one hard requirement.
 */
export function toCreateTaskResult(record: TaskHandleRecord): CreateTaskResult & { content: Array<{ type: "text"; text: string }> } {
  const descriptor = toTaskDescriptor(record);
  return {
    content: [{ type: "text", text: `Task ${descriptor.taskId} created (status: ${descriptor.status})` }],
    resultType: "task",
    ...descriptor,
  };
}

export function toNativeTaskResult(record: TaskHandleRecord): NativeTaskStatusResult {
  const base: NativeTaskStatusResult = {
    resultType: "complete",
    ...toTaskDescriptor(record),
    result: record.result,
    error: record.error,
    cancelReason: record.cancelReason,
  };
  const inputRequests = defaultInputRequests(record);
  if (inputRequests && record.status === "input_required") {
    base.inputRequests = inputRequests;
  }
  return base;
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function taskNotFoundError(): Error {
  const error = new Error("Task not found or expired");
  error.name = "TaskNotFoundError";
  return error;
}

export function ensureTaskOwner(record: TaskHandleRecord | null, ctx: RequestContext): TaskHandleRecord {
  if (!record || record.tenantId !== ctx.tenantId || record.owner !== taskOwner(ctx)) {
    throw taskNotFoundError();
  }
  return record;
}
