import type { ZodType } from "zod/v4";
import type { RequestContext } from "../../security/context.js";
import { getRequestContext } from "../../security/context.js";
import { applyInvocationGovernance, toClientError } from "./execution_pipeline.js";

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface PromptResult {
  // Index signature required to structurally satisfy the SDK's prompt-callback return type.
  [x: string]: unknown;
  messages: PromptMessage[];
}

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  argsSchema: Record<string, ZodType>;
  assertInProcess: () => void;
  /** `ctx.tenantId` is only load-bearing when a prompt argument resolves through a tenant-scoped
   *  agentId (e.g. a future T3N ingredient) — arguments keyed by public address/hash need it only
   *  for the rate-limit/quota gate below, same as resource reads. */
  build: (args: Record<string, unknown>, ctx: RequestContext) => Promise<PromptResult>;
}

/** Same assertInProcess + rate-limit/quota gate as tool handlers and resource reads — prompts/get
 *  can trigger the same live RPC reads a resource read or tool call would. */
export function wrapPromptGet(def: PromptDefinition): (args: Record<string, unknown>) => Promise<PromptResult> {
  return async (args) => {
    try {
      def.assertInProcess();
      const ctx = getRequestContext();
      await applyInvocationGovernance(def.name, ctx.tenantId, ctx.requestId);
      return await def.build(args ?? {}, ctx);
    } catch (error) {
      throw toClientError(error);
    }
  };
}
