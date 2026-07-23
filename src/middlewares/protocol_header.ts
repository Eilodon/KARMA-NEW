/**
 * P2-B: Protocol operation-header validation middleware.
 *
 * Placement in the request pipeline (HTTP /mcp only):
 *   content-type check → body parse → auth → **this** → route handler
 *
 * Behaviour:
 *
 *   Final branch supports rc2026 only.
 *   Mcp-Method is REQUIRED; absent → -32020 (HeaderMismatch).
 *   Named operations that carry body.params.name (currently tools/call) also
 *   REQUIRE Mcp-Name; absent → -32020 (HeaderMismatch).
 *   When Mcp-Method / Mcp-Name are present they must match body.method /
 *   body.params.name.
 *
 * Header name lookup is case-insensitive because Express normalises all
 * incoming header names to lower-case before exposing them on req.headers.
 */

import type { NextFunction, Request, Response } from "express";


// ── helpers ──────────────────────────────────────────────────────────────────

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/**
 * Mcp-Method / Mcp-Name are single-valued operation headers. Repeated header
 * lines or comma-joined values are rejected instead of silently taking the
 * first token, because accepting ambiguous operation metadata can let an
 * intermediary/client smuggle a different method/name than the JSON-RPC body.
 */
function singleHeaderValue(raw: string | string[] | undefined, label: string): { value?: string; error?: string } {
  if (raw === undefined) return {};
  if (Array.isArray(raw)) {
    return { error: `Header mismatch: ${label} header must be single-valued; repeated header values are not allowed.` };
  }
  if (raw.includes(",")) {
    return { error: `Header mismatch: ${label} header must be single-valued; comma-joined values are not allowed.` };
  }
  const value = raw.trim();
  if (!value) {
    return { error: `Header mismatch: ${label} header must not be empty.` };
  }
  return { value };
}

function requestBodyObject(body: unknown): Record<string, unknown> | undefined {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : undefined;
}

function bodyMethod(body: unknown): string | undefined {
  const method = requestBodyObject(body)?.method;
  return typeof method === "string" ? method : undefined;
}

// Per the spec's Standard Request Headers table, Mcp-Name mirrors body.params.name for
// tools/call and prompts/get, but body.params.uri for resources/read (a ReadResourceRequest has
// no params.name field at all).
function mcpNameSourceField(method: string | undefined): "name" | "uri" {
  return method === "resources/read" ? "uri" : "name";
}

function bodyName(body: unknown, method: string | undefined): string | undefined {
  const params = requestBodyObject(body)?.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return undefined;
  const value = (params as Record<string, unknown>)[mcpNameSourceField(method)];
  return typeof value === "string" ? value : undefined;
}

function operationRequiresName(method: string | undefined): boolean {
  // Per the spec: Mcp-Name is required for tools/call, resources/read, and prompts/get.
  return method === "tools/call" || method === "resources/read" || method === "prompts/get";
}

// ── middleware ────────────────────────────────────────────────────────────────

export function protocolHeaderValidation(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const methodHeader = singleHeaderValue(req.headers["mcp-method"], "Mcp-Method");
  const nameHeader = singleHeaderValue(req.headers["mcp-name"], "Mcp-Name");
  const mcpMethod = methodHeader.value;
  const mcpName = nameHeader.value;
  const method = bodyMethod(req.body);
  const name = bodyName(req.body, method);

  if (methodHeader.error) {
    res.status(400).json(jsonRpcError(-32020, methodHeader.error));
    return;
  }

  if (nameHeader.error) {
    res.status(400).json(jsonRpcError(-32020, nameHeader.error));
    return;
  }

  // rc2026 strict: Mcp-Method is mandatory on every request.
  if (mcpMethod === undefined) {
    res
      .status(400)
      .json(jsonRpcError(-32020, "Header mismatch: Mcp-Method header is required in rc2026 mode."));
    return;
  }

  // rc2026 strict: named operations must include Mcp-Name as well.
  if (operationRequiresName(method) && mcpName === undefined) {
    res
      .status(400)
      .json(jsonRpcError(-32020, `Header mismatch: Mcp-Name header is required for ${method} in rc2026 mode.`));
    return;
  }

  // Body is already parsed at this point (express.json middleware ran first).
  // If an operation header is supplied, the corresponding body field must be
  // present and equal. Treat a missing/non-string body field as invalid rather
  // than silently passing a spoofable operation header downstream.
  if (mcpMethod !== undefined && mcpMethod !== method) {
    res
      .status(400)
      .json(
        jsonRpcError(
          -32020,
          method === undefined
            ? `Header mismatch: Mcp-Method header '${mcpMethod}' cannot be validated because body method is missing or non-string.`
            : `Header mismatch: Mcp-Method header '${mcpMethod}' does not match body method '${method}'.`,
        ),
      );
    return;
  }

  if (mcpName !== undefined && mcpName !== name) {
    const sourceField = mcpNameSourceField(method);
    res
      .status(400)
      .json(
        jsonRpcError(
          -32020,
          name === undefined
            ? `Header mismatch: Mcp-Name header '${mcpName}' cannot be validated because body params.${sourceField} is missing or non-string.`
            : `Header mismatch: Mcp-Name header '${mcpName}' does not match body params.${sourceField} '${name}'.`,
        ),
      );
    return;
  }

  next();
}
