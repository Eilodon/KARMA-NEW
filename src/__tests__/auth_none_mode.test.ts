import { afterEach, describe, expect, test, vi } from "vitest";

async function importAuthWithNoneEnv() {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("TRANSPORT_DRIVER", "http");
  vi.stubEnv("MCP_AUTH_MODE", "none");
  vi.stubEnv("MCP_ALLOW_UNAUTHENTICATED_HTTP", "true");
  vi.stubEnv("ALLOWED_ORIGINS", "https://app.example.com");
  vi.stubEnv("ALLOWED_HOSTS", "app.example.com");
  vi.stubEnv("MCP_IDEMPOTENCY_RESULT_TTL_SECONDS", "3600");
  return import("../security/auth.js");
}

describe("MCP_AUTH_MODE=none authentication", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  test("accepts a request with no credentials at all and returns a public context", async () => {
    const { authenticateHttpRequest } = await importAuthWithNoneEnv();

    const ctx = await authenticateHttpRequest({ "x-request-id": "req-anon" });

    expect(ctx).toMatchObject({
      userId: "anonymous",
      clientId: "anonymous-client",
      scopes: [],
      requestId: "req-anon",
      authType: "public",
    });
  });

  test("ignores any x-api-key or Authorization header presented anyway -- still just the public identity", async () => {
    const { authenticateHttpRequest } = await importAuthWithNoneEnv();

    const ctx = await authenticateHttpRequest({
      "x-api-key": "whatever-someone-sent",
      authorization: "Bearer whatever-someone-sent",
    });

    expect(ctx.authType).toBe("public");
  });
});
