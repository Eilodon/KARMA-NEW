import { getPatternDebtItems } from "../core/pattern_debt.js";
import type { ResourceDefinition, ResourceTemplateDefinition } from "../mcp/adapter/resource_runtime.js";

/**
 * Static system Resource (DEBT-008) — pure in-memory read, zero chain calls, always registered
 * (never gated by MCP_SAFE_MODE, unlike the Pharos/Casper resources). Mirrors the karma_pattern_debt tool.
 */
function noopAssertInProcess(): void {
  // Pure in-memory read (getPatternDebtItems) — no module-level singleton or process.env access
  // that requires the trusted in-process runtime, unlike karma.resources.ts/casper.resources.ts.
}

export function createSystemResources(): { resources: ResourceDefinition[]; templates: ResourceTemplateDefinition[] } {
  return {
    resources: [
      {
        name: "system_pattern_debt",
        uri: "karma://system/pattern-debt",
        title: "KARMA pattern-debt report",
        description:
          "Read-only report of documented pattern-debt items, implementation gates, and runtime " +
          "guards. Mirrors the karma_pattern_debt tool's default (open items only).",
        assertInProcess: noopAssertInProcess,
        read: async () => ({
          generatedBy: "karma://system/pattern-debt",
          guidance: "Documented debt only. Do not implement partial security boundaries without satisfying implementationGate.",
          items: getPatternDebtItems({ includeImplemented: false }),
        }),
      },
    ],
    templates: [],
  };
}

const systemResources = createSystemResources();
export default systemResources;
