import type { RequestContext } from "../../security/context.js";
import { getRequestContext } from "../../security/context.js";
import { jsonSafe } from "../../lib/serialize.js";
import { scanToolOutput } from "../../middlewares/output_firewall.js";
import { applyInvocationGovernance, toClientError } from "./execution_pipeline.js";

/**
 * Resources are read-only, URI-addressable views over the same on-chain/in-memory state the
 * existing `get_*`/`read_*` tools already expose — see DEBT-008. Every template here is keyed by
 * a public address/hash, never a tenant-scoped agentId, so a resource read carries no
 * tenant-ownership check by construction (the data is genuinely public regardless of caller).
 * What IS tenant-scoped is *governance*: several of these reads hit a live RPC, so — unlike the
 * native Tasks methods (registerNativeTaskMethods), which are cheap in-memory store lookups and
 * skip this — every resource read here still goes through the same rate-limit/quota gate as a
 * tool call, and its JSON output still passes through the output firewall before returning.
 */

export type ResourceVariables = Record<string, string | string[]>;

export interface ResourceDefinition {
  name: string;
  uri: string;
  title: string;
  description: string;
  assertInProcess: () => void;
  read: () => Promise<Record<string, unknown>>;
}

export interface ResourceTemplateDefinition {
  name: string;
  uriTemplate: string;
  title: string;
  description: string;
  assertInProcess: () => void;
  read: (variables: ResourceVariables, ctx: RequestContext) => Promise<Record<string, unknown>>;
}

export interface ReadResourceResult {
  // Index signature required to structurally satisfy the SDK's ReadResourceCallback/
  // ReadResourceTemplateCallback return type (a union that includes an indexed object shape).
  [x: string]: unknown;
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

async function governResourceRead(resourceName: string): Promise<RequestContext> {
  const ctx = getRequestContext();
  await applyInvocationGovernance(resourceName, ctx.tenantId, ctx.requestId);
  return ctx;
}

function toReadResourceResult(uri: string, data: Record<string, unknown>): ReadResourceResult {
  const firewalled = scanToolOutput({ content: [{ type: "text", text: JSON.stringify(jsonSafe(data)) }] });
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: firewalled.result.content[0]?.text ?? "{}",
    }],
  };
}

/** Wraps a static resource's `read()` with the same assertInProcess + rate-limit/quota + output-firewall gate every tool handler already has. */
export function wrapResourceRead(def: ResourceDefinition): (uri: URL) => Promise<ReadResourceResult> {
  return async (uri) => {
    try {
      def.assertInProcess();
      await governResourceRead(def.name);
      const data = await def.read();
      return toReadResourceResult(uri.href, data);
    } catch (error) {
      throw toClientError(error);
    }
  };
}

/** Same gate as wrapResourceRead, for a templated resource — the URI's matched variables are handed to `read()`. */
export function wrapResourceTemplateRead(
  def: ResourceTemplateDefinition,
): (uri: URL, variables: ResourceVariables) => Promise<ReadResourceResult> {
  return async (uri, variables) => {
    try {
      def.assertInProcess();
      const ctx = await governResourceRead(def.name);
      const data = await def.read(variables, ctx);
      return toReadResourceResult(uri.href, data);
    } catch (error) {
      throw toClientError(error);
    }
  };
}
