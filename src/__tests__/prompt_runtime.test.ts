import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod/v4";

async function importFresh() {
  vi.resetModules();
  vi.stubEnv("STORAGE_DRIVER", "memory");
  vi.stubEnv("ENABLE_RATE_LIMIT", "false");
  vi.stubEnv("ENABLE_QUOTA", "false");
  const promptRuntime = await import("../mcp/adapter/prompt_runtime.js");
  const context = await import("../security/context.js");
  return { ...promptRuntime, ...context };
}

describe("prompt_runtime — wrapPromptGet", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("calls assertInProcess, runs build() with args + request context, and returns its messages", async () => {
    const { wrapPromptGet, withRequestContext, defaultRequestContext } = await importFresh();
    let assertCalled = false;
    let receivedArgs: unknown;
    let receivedTenantId: string | undefined;

    const handler = wrapPromptGet({
      name: "test_prompt",
      title: "Test prompt",
      description: "A test prompt",
      argsSchema: { subject: z.string() },
      assertInProcess: () => { assertCalled = true; },
      build: async (args, ctx) => {
        receivedArgs = args;
        receivedTenantId = ctx.tenantId;
        return { messages: [{ role: "user", content: { type: "text", text: `Vetting ${(args as { subject: string }).subject}` } }] };
      },
    });

    const ctx = defaultRequestContext();
    const result = await withRequestContext(ctx, () => handler({ subject: "agent-alpha" }));

    expect(assertCalled).toBe(true);
    expect(receivedArgs).toEqual({ subject: "agent-alpha" });
    expect(receivedTenantId).toBe(ctx.tenantId);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: { type: "text", text: "Vetting agent-alpha" } });
  });

  test("propagates a build() rejection as a rejected promise", async () => {
    const { wrapPromptGet, withRequestContext, defaultRequestContext } = await importFresh();
    const handler = wrapPromptGet({
      name: "test_prompt_fail",
      title: "Test prompt",
      description: "A test prompt whose build() rejects",
      argsSchema: {},
      assertInProcess: () => {},
      build: async () => { throw new Error("needs at least one address"); },
    });

    await expect(
      withRequestContext(defaultRequestContext(), () => handler({})),
    ).rejects.toThrow(/needs at least one address/);
  });

  test("defaults args to {} when the client omits arguments", async () => {
    const { wrapPromptGet, withRequestContext, defaultRequestContext } = await importFresh();
    let receivedArgs: unknown = "not-called";
    const handler = wrapPromptGet({
      name: "test_prompt_no_args",
      title: "Test prompt",
      description: "A test prompt with no required args",
      argsSchema: {},
      assertInProcess: () => {},
      build: async (args) => {
        receivedArgs = args;
        return { messages: [] };
      },
    });

    await withRequestContext(defaultRequestContext(), () => handler(undefined as unknown as Record<string, unknown>));

    expect(receivedArgs).toEqual({});
  });
});
