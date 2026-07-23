export const PATTERN_DEBT_IDS = [
  "DEBT-001",
  "DEBT-002",
  "DEBT-003",
  "DEBT-004",
  "DEBT-005",
  "DEBT-006",
  "DEBT-007",
  "DEBT-008",
] as const;

export type PatternDebtId = typeof PATTERN_DEBT_IDS[number];
export type PatternDebtStatus = "open" | "monitoring" | "partially_resolved" | "implemented";
export type PatternDebtUrgency = "documented" | "monitor" | "ready_to_implement" | "release_blocking" | "resolved";

export interface PatternDebtItem {
  id: PatternDebtId;
  key: string;
  title: string;
  status: PatternDebtStatus;
  urgency: PatternDebtUrgency;
  currentControl: string;
  limitation: string;
  resolutionTrigger: string;
  implementationGate: string;
  ownerHint: string;
  runtimeGuards: string[];
  nextAction: string;
}

const ITEMS: readonly PatternDebtItem[] = [
  {
    id: "DEBT-001",
    key: "plugin-os-isolation",
    title: "Plugin OS isolation",
    status: "open",
    urgency: "release_blocking",
    currentControl: "Plugin allowlist, optional SHA-256 allowlist, capability declarations, safe mode, manifest pinning, a pluggable runner interface, currentPluginIsolationLevel=process-best-effort by default, hardened child-process lifecycle, scrubbed worker environment without PATH, expanded JS-level escape/mutation guards, optional Node permission best-effort mode, and a production fail-closed gate for non-built-in plugins unless an explicit best-effort waiver is set.",
    limitation: "Policy mode is trusted-only and rejects non-built-ins, while the external child-process runner remains a best-effort process boundary rather than a full container, Wasmtime, or microVM isolation boundary.",
    resolutionTrigger: "A production-ready container, microVM, WASM, or equivalent runner enforces OS-level filesystem, network, process, environment, CPU, memory, timeout, and artifact egress boundaries.",
    implementationGate: "Do not implement an in-process pseudo-sandbox. External isolation must enforce egress allowlist, read-only mount, process/env isolation, seccomp/AppArmor or equivalent syscall boundary, CPU/memory quotas, timeout, and artifact egress policy before it can replace policy mode or close this debt.",
    ownerHint: "runtime-security",
    runtimeGuards: [
      "MCP_PLUGIN_ISOLATION_MODE defaults to external for non-built-ins; policy mode rejects non-built-ins instead of running them in-process.",
      "External plugin workers use a scrubbed allowlisted environment without PATH, NODE_OPTIONS, npm_config_* values, or inherited CI secrets.",
      "Plugin child processes use stderr caps, single-settle promise handling, listener cleanup, timeout/abort hard-stop, and worker send-and-exit semantics.",
      "JS-level guards block worker_threads.Worker, dgram, http2, raw net.Socket, VM APIs, process.dlopen, process.kill, DNS, inspector, cluster, child_process, and expanded filesystem mutation APIs.",
      "MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true enables node-permission-best-effort only on supported built JavaScript runtimes and never claims container isolation.",
      "Plugin manifest hash is pinned after startup when MCP_PLUGIN_PIN_MANIFEST=true.",
      "NODE_ENV=production with non-built-in plugins fails unless MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX=true documents a trusted-plugin waiver.",
    ],
    nextAction: "Keep DEBT-001 open until a real container/Wasmtime/microVM runner is implemented and tested as an OS/runtime isolation boundary.",
  },
  {
    id: "DEBT-002",
    key: "crypto-erasure",
    title: "Crypto erasure",
    status: "implemented",
    urgency: "resolved",
    currentControl: "smcp:v4:kms KMS-backed per-tenant/user DEK crypto-erasure is implemented (2026-06-14) across four ITenantKeyRegistry providers (LocalKeyRegistry dev/test, VaultKeyRegistry, AwsKmsKeyRegistry, GcpKmsKeyRegistry). EncryptionService seals state as smcp:v4:kms blobs (AES-256-GCM data key wrapped by the KMS KEK, opaque kid, key version) with smcp:v3:hkdf-tenant and smcp:v2:scrypt as backward-compatible fallbacks. Two-phase scheduleErasure (immediate disable + scheduled HSM/KMS key destruction) emits a CryptoErasureReceipt; rotateKey/disableKey/auditLog complete the lifecycle and receipts persist through FileAuditStore.",
    limitation: "AWS KMS Phase-2 key destruction lags Phase-1 disable by a mandatory 7-day minimum pending-deletion window (Vault/GCP destroy on schedule); LocalKeyRegistry is dev/test only and gives no real erasure guarantee.",
    resolutionTrigger: "A deployment needs a KMS provider beyond Vault/AWS/GCP, or a zero-window erasure SLA that AWS KMS's 7-day pending-deletion window cannot meet.",
    implementationGate: "Do not claim instant key destruction on AWS KMS (honor the 7-day pending window in receipts) and do not permit KMS_PROVIDER=local for production crypto-erasure. New providers must implement the full ITenantKeyRegistry lifecycle (seal/unseal, 2-phase scheduleErasure, rotate, audit) with round-trip + erasure tests.",
    ownerHint: "storage-security",
    runtimeGuards: [
      "Redis storage requires MCP_ENCRYPTION_KEY.",
      "smcp:v4:kms blobs cannot be decrypted without a wired ITenantKeyRegistry (KMS_PROVIDER).",
      "NODE_ENV=production with MCP_REQUIRE_CRYPTO_ERASURE=true rejects KMS_PROVIDER=local and requires vault/aws-kms/gcp provider config.",
      "Two-phase erasure: Phase 1 disables the key immediately (all decrypt attempts fail), Phase 2 schedules HSM/KMS key destruction.",
      "Legacy SHA-256 KDF decrypts only when MCP_ALLOW_LEGACY_SHA256_KDF=true for migration.",
    ],
    nextAction: "Monitor provider erasure receipts in production; extend only when a new KMS provider or a stricter erasure SLA is required.",
  },
  {
    id: "DEBT-003",
    key: "native-mcp-tasks",
    title: "Native MCP Tasks",
    status: "implemented",
    urgency: "resolved",
    currentControl: "Task lifecycle is behind ITaskStore with MemoryTaskStore and RedisTaskStore; KARMA's own tasks/get, tasks/update, tasks/cancel, input_required, inputRequests, and inputResponses are exposed through the isolated src/mcp/adapter boundary. SDK is @modelcontextprotocol/server@2.0.0-beta.2. Confirmed empirically (2026-07-08, by reading the shipped runtime, not the SDK's own docs) that beta.2's 2026-07-28 era has NO native background/pollable-task primitive at all: TaskSchema/CreateTaskResultSchema/GetTaskRequestSchema/CancelTaskRequestSchema/TaskCreationParamsSchema are all marked \"@deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only\" in the shipped .d.mts, and grepping the compiled runtime for `.taskSupport` usage returns zero hits outside the tools/list advertisement path -- the field has no effect on tools/call dispatch or validation. The SEP's replacement is multi-round-trip (InputRequiredResult + the client resending the SAME request with inputResponses/requestState on a fresh id) -- a synchronous immediate-retry model, not a detached background job with an independent poll handle, so it cannot represent KARMA's actual use case (e.g. an on-chain tx confirmation that outlives the original HTTP round trip). KARMA's bespoke Tasks extension is therefore the correct, deliberate design, not a stopgap -- reconciled with the SDK's universal tools/call codec via three fixes: (1) toCreateTaskResult (task_runtime.ts) now returns a valid CallToolResult (adds a required `content` array; the SDK's CallToolResultSchema is a z.looseObject so KARMA's resultType/taskId/etc. fields still ride through as extra wire-preserved keys), because Server#_wrapHandler unconditionally validates every tools/call return value as CallToolResult|InputRequiredResult regardless of the tool's declared taskSupport; (2) registerMcpTool no longer forwards tool.outputSchema into the SDK's own registerTool config, because beta.2's validateToolOutput() unconditionally checks EVERY successful result's structuredContent against a registered outputSchema, which is correct for a tool's real completed-task output but a category error against a task-creation acknowledgment -- KARMA's own output validation in runHandlerWithTimeout (execution_pipeline.ts) already covers the real result and is unaffected, and tools/list still advertises the true outputSchema via registerToolListSurface's _meta override; (3) execution_pipeline.ts's clientSupportsNativeTasks lookup now also reads extra.mcpReq.envelope (not just mcpReq._meta), because beta.2 lifts the reserved io.modelcontextprotocol/* envelope keys (including clientCapabilities) out of _meta into a separate per-request envelope object. setRawRequestHandler's private _requestHandlers Map reach-around is GONE: it now calls the SDK's genuinely public Protocol#setRequestHandler 3-arg overload (method, {params}, handler), which the SDK's own docs ship as its sanctioned custom-method pattern and which the isSpecRequestMethod gate does not apply to.",
    limitation: "tasks/get and tasks/cancel could not keep their original method names: both are still literal keys in the deprecated-but-not-forgotten 2025-11-25 request-method registry, and beta.2's dispatch funnel hard-rejects \"Method not found\" for any method recognized by EITHER era's registry but absent from the negotiated era's -- BEFORE handler lookup runs, so no handler-registration technique (public or private) can route around it. KARMA's Tasks methods were renamed to io.karma/tasks/get, io.karma/tasks/update, io.karma/tasks/cancel (MCP_TASKS_GET_METHOD/MCP_TASKS_UPDATE_METHOD/MCP_TASKS_CANCEL_METHOD in task_runtime.ts) to permanently dodge this and any future spec-name collision -- a breaking wire-protocol rename for any external client already polling the old literal method names. Separately, the 2026-07-28 wire format now stamps `resultType:\"complete\"` onto any outbound result missing one (Server's encodeResult step), so tasks/update and tasks/cancel's empty-object acknowledgment is `{resultType:\"complete\"}` on the wire now, not `{}`. A fourth, deeper collision was found and fixed by writing end-to-end tests for a JSON-RPC method that had never actually been exercised before (only its static server_card.ts advertisement was tested): KARMA's custom \"server/discover\" handler was unreachable dead code on EVERY transport, for two different reasons (confirmed empirically in http_tasks_conformance.test.ts and mcp_discover_non_http.test.ts) -- on HTTP, createMcpHandler's serveModern() unconditionally reinstalls the SDK's own default \"server/discover\" handler (installModernOnlyHandlers) on every request, AFTER any override is created; on non-HTTP (Server#connect(), the API KARMA's STDIO path uses), \"server/discover\" is 2026-07-28-only wire vocabulary and the `initialize` handshake is 2025-era-only, so a connect()-based instance can never negotiate into the 2026-07-28 era at all (a client claiming protocolVersion \"2026-07-28\" gets negotiated DOWN to \"2025-11-25\" instead) and the request is rejected outright with -32601 before any handler is consulted. The fix does not try to win either fight: registerDiscover (mcp_protocol_adapter.ts) now registers the io.karma/tasks capability through the SDK's public registerCapabilities() API against ServerCapabilitiesSchema's first-class `extensions` record field, instead of overriding a handler. Both _ondiscover (server/discover's default handler, a pure `{...capabilities}` spread) and _oninitialize (`capabilities: this.getCapabilities()`) read from the exact same capabilities object, so the io.karma/tasks/* method names now surface automatically on whichever channel the connected client actually gets served -- server/discover on HTTP, initialize on STDIO/non-HTTP -- verified on both.",
    resolutionTrigger: "A future SDK release ships a real public, pluggable ITaskStore-equivalent for detached background jobs (not just multi-round-trip), or claims any of the io.karma/tasks/* method names, or expands the universal tools/call result codec/reserved envelope vocabulary further.",
    implementationGate: "Do not reintroduce check_task_status or isAsync. Do not reach into private SDK internals (_requestHandlers or any underscore-prefixed field) -- the public Protocol#setRequestHandler 3-arg overload covers every custom-method registration case KARMA needs. Any new KARMA-owned wire method or param key must be namespaced (io.karma/... or a KARMA-specific key name) rather than reusing an unprefixed spec-shaped name, since the SDK's reserved/deprecated-but-still-recognized vocabulary is not discoverable except by reading the shipped runtime. Before overriding a handler for ANY spec-defined method name (even a custom-params one registered via the public 3-arg overload), verify empirically on every transport KARMA actually serves (HTTP AND Server#connect()) that the override is actually reachable and stays reachable -- the SDK may own the method more completely than a single successful registration call implies (re-installation on every request, era-gated dispatch rejection before handler lookup, etc). Prefer contributing through a documented SDK extension point (e.g. registerCapabilities()'s `extensions` record) over overriding a handler for a method the SDK also serves, when one exists.",
    ownerHint: "protocol",
    runtimeGuards: [
      "src/mcp/adapter owns the SDK/protocol boundary.",
      "Tasks preserve task ownership, cancellation, TTL, and terminal result retrieval.",
      "Task IDs and ownership gates are validated before result disclosure.",
      "No bespoke polling endpoint, check_task_status, or isAsync compatibility path is exposed.",
      "setRawRequestHandler uses only the SDK's public Protocol#setRequestHandler API; no private _requestHandlers access.",
      "registerDiscover contributes io.karma/tasks via the public registerCapabilities() API rather than overriding a server/discover handler, so it is reachable on every transport (server/discover on HTTP, initialize on non-HTTP).",
    ],
    nextAction: "Monitor future SDK releases for a real pluggable background-task primitive and for further expansion of the reserved/deprecated method-name and param-key vocabulary; re-verify the io.karma/tasks/* namespace and the three tools/call reconciliation fixes against each SDK bump empirically (read the shipped runtime, do not trust its docs alone) before assuming they still hold.",
  },
  {
    id: "DEBT-004",
    key: "oauth-resource-indicator",
    title: "OAuth resource indicator enforcement",
    status: "implemented",
    urgency: "resolved",
    currentControl: "KARMA is treated as an OAuth Resource Server: JWT secret mode and OIDC JWKS mode validate issuer/audience as configured, enforce MCP_RESOURCE_URI against aud/resource claims when configured, publish protected resource metadata once, and enforce per-tool requiredScopes downstream.",
    limitation: "PKCE, TokenManager, authorization-code initiation, refresh-token rotation, and client login flows are intentionally absent because they belong to OAuth clients, not this resource server.",
    resolutionTrigger: "A future product explicitly adds a first-party OAuth client component separate from the resource server.",
    implementationGate: "Do not add TokenManager or server-side PKCE to the resource-server path. Any future OAuth client flow must be separate and tested independently.",
    ownerHint: "auth",
    runtimeGuards: [
      "HTTP transport requires explicit auth material.",
      "oidc_jwks over HTTP requires MCP_JWKS_URI plus issuer and audience.",
      "MCP_RESOURCE_URI rejects wrong-resource tokens before request context is returned.",
      "The protected resource metadata route remains /.well-known/oauth-protected-resource and is not duplicated.",
    ],
    nextAction: "Keep resource-server validation tests current; do not add PKCE/TokenManager to this server path.",
  },
  {
    id: "DEBT-005",
    key: "output-firewall-coverage",
    title: "Output firewall coverage",
    status: "partially_resolved",
    urgency: "monitor",
    currentControl: "Output firewall redacts common credentials, Luhn-valid payment cards, validated SSNs, prompt-injection markers, and sensitive values inside structuredContent through recursive non-mutating traversal with depth/node/string/cycle guards; structured-only violations still emit telemetry.",
    limitation: "PII detection remains deterministic and conservative by default; strict email/phone redaction is opt-in and no DLP/classifier backend is wired.",
    resolutionTrigger: "A sensitive deployment defines DLP policy, target entity types, confidence thresholds, latency budget, and audit requirements.",
    implementationGate: "Do not add a fake DLP adapter. Integrate a real backend only behind a measured policy boundary; tests must cover false positives, false negatives, latency timeout/fail-closed behavior, and structured-output redaction.",
    ownerHint: "data-safety",
    runtimeGuards: [
      "scanToolOutput runs before sanitizeResult and idempotency commit.",
      "Detected redactions emit output_firewall_redacted telemetry, including structuredContent-only violations.",
      "structuredContent recursive redaction preserves object/array shape and does not mutate input.",
      "Depth, node-count, per-string, total-string, and circular reference guards cap structured output traversal.",
      "MCP_OUTPUT_FIREWALL_PII_MODE defaults to credentials_only; strict mode redacts email/phone.",
    ],
    nextAction: "Keep deterministic regex/Luhn/structured coverage; add DLP only when a deployment is explicitly classified as sensitive.",
  },
  {
    id: "DEBT-006",
    key: "redis-trauma-registry",
    title: "Redis trauma registry",
    status: "implemented",
    urgency: "resolved",
    currentControl: "Memory and Redis rate limiters use bounded violation records with severity EMA and exponential backoff.",
    limitation: "Backoff policy is deterministic and conservative; it is not tuned from production incident data yet.",
    resolutionTrigger: "Production telemetry calibrates severity EMA/backoff thresholds by tenant risk tier.",
    implementationGate: "Tune only from production telemetry; do not replace bounded records with unbounded request timestamp sets.",
    ownerHint: "reliability",
    runtimeGuards: [
      "Redis rate limiter stores bounded trauma records.",
      "Exponential backoff is derived from violation_count and severity_ema.",
    ],
    nextAction: "Revisit after production traffic provides enough incident data for calibration.",
  },
  {
    id: "DEBT-007",
    key: "agent-key-erasure-boundary",
    title: "KARMA agent signing keys outside the KMS crypto-erasure boundary",
    status: "monitoring",
    urgency: "documented",
    currentControl: "KARMA agent signing keys are operator-provisioned Web3 Secret Storage v3 (scrypt+aes-128-ctr) entries in a keystore file, decrypted in-process by KeystoreManager (D-1, trusted built-in plugin). They are deliberately NOT sealed by EncryptionService / smcp:v4:kms (DEBT-002): those keys are infrastructure credentials shared by a tenant's agents, not per-tenant user state, and the `tenant` field on an entry is an authz binding (assertOwnedBy) — not a data-lifecycle owner. KeystoreManager.unload(agentId)/clear() drop decrypted viem accounts so GC can reclaim them, and graceful shutdown clears the in-memory map.",
    limitation: "The smcp:v4:kms crypto-erasure guarantee (delete a tenant ⇒ its sealed state becomes unrecoverable) does NOT extend to agent private keys: there is no tenant self-deletion flow in KARMA, and the keystore file is on disk outside KMS. viem's privateKeyToAccount also retains the key inside a closure that V8 cannot force-zero, so unload()/clear() shrink but do not provably erase the heap copy.",
    resolutionTrigger: "A deployment promises tenant-deletion crypto-erasure that must cover agent signing keys, OR adds tenant self-service agent provisioning/offboarding, OR requires guaranteed key zeroization (heap-dump / cold-boot threat in scope).",
    implementationGate: "Do not re-route agent keys through EncryptionService (wrong layer — that seals state blobs, not signing keys). True coverage needs an out-of-process signer / HSM / remote-signing KMS so the private key never enters this process, plus an offboarding runbook (remove keystore entry + unload() + rotate/abandon the on-chain key) wired to tenant lifecycle.",
    ownerHint: "key-management",
    runtimeGuards: [
      "Agent keys never leave KeystoreManager — only viem Account objects (which sign internally) are exposed.",
      "KeystoreManager runs in-process only (D-1); the canary assertInProcess blocks out-of-process execution.",
      "unload(agentId)/clear() drop decrypted accounts for offboarding and graceful shutdown.",
      "assertOwnedBy enforces tenant→agent authz before any signing account is handed out (STRIDE-S).",
    ],
    nextAction: "Keep documented until a deployment needs tenant-lifecycle key erasure or an out-of-process/HSM signer; pair any keystore-entry removal with unload() + on-chain key rotation.",
  },
  {
    id: "DEBT-008",
    key: "native-mcp-resources-prompts",
    title: "Native MCP Resources & Prompts",
    status: "partially_resolved",
    urgency: "monitor",
    currentControl:
      "resources/list, resources/templates/list, resources/read, prompts/list, and prompts/get are exposed through a dedicated adapter (src/mcp/adapter/resource_runtime.ts, prompt_runtime.ts), registered from src/mcp/adapter/mcp_protocol_adapter.ts's registerResources/registerResourceTemplates/registerPrompts and wired in src/core/runtime.ts's createServer() — not routed through PluginLoader/ToolDefinition[], since Resources/Prompts are not tools and PluginLoader's SAFE_BASENAME regex requires the literal substring '.tool.' in the filename anyway (src/plugins/*.resources.ts / *.prompts.ts are structurally invisible to it). Unlike Tools, the SDK's registerResource()/registerPrompt() already own the entire resources/prompts wire codec end-to-end (setResourceRequestHandlers/setPromptRequestHandlers, called internally) — there is no KARMA-specific codec quirk to route around the way registerToolListSurface exists for tools/list, so the registration functions are thin wrappers, not raw setRequestHandler overrides. Every resource template is keyed by a public on-chain address/hash, never a tenant-scoped agentId, so a resource read carries no tenant-ownership check by construction (see resolveAddress's own public-address-is-unauthenticated-by-design comment in karma.tool.ts) — the data returned is genuinely public regardless of caller tenant. What IS tenant-scoped is governance: because several resources make live RPC calls (unlike the Tasks extension's cheap in-memory store lookups, which skip this), every resource read and prompts/get call still goes through the same globalRateLimiter/globalQuotaManager gate a tool call does (execution_pipeline.ts's applyInvocationGovernance, now exported for reuse) before the read runs, and the JSON result still passes through scanToolOutput (output firewall) before returning — both wired in resource_runtime.ts/prompt_runtime.ts's wrapResourceRead/wrapResourceTemplateRead/wrapPromptGet. Pharos resources (karma.resources.ts) mirror get_agent_reputation/query_social_graph/get_pending_balance/read_job 1:1 via the same KarmaService calls, plus one net-new read no tool currently exposes: karma://pharos/jobs/{jobId}/dispute, backed by KarmaService.getDisputeInfo (disputeBond/providerBond/disputedAt) — found unused during this work. Casper resources (casper.resources.ts) mirror casper_get_account_state/casper_get_composition/casper_get_cross_chain_rep via CasperClientLike. The one static resource, karma://system/pattern-debt (system.resources.ts), is a pure in-memory read with no assertInProcess canary and stays registered even under MCP_SAFE_MODE; the Pharos/Casper resource templates are skipped at registration time when MCP_SAFE_MODE is true (createServer() checks ENV.MCP_SAFE_MODE before calling registerResourceTemplates), mirroring how registerTools already blocks capabilities:[\"network\"] tools — Resources have no ToolDefinition.capabilities field to piggyback on, so this needed an explicit check. The flagship Prompt, agent_vetting (karma.prompts.ts), composes Pharos reputation/social-graph plus Casper account-state/cross-chain-rep into one guided vetting workflow for a human/LLM evaluator — addressing the previously-noted 'evaluator has no vetting' narrative gap — by calling the exact same KarmaService/CasperClientLike methods the resources above use, not reimplementing them. protocol_header.ts's operationRequiresName() was extended to require Mcp-Name for resources/read and prompts/get (not just tools/call, per the spec's Standard Request Headers table), and its bodyName() now mirrors body.params.uri for resources/read specifically (a ReadResourceRequest has no params.name field at all) via a new mcpNameSourceField(method) helper — the error-message text was also generalized to interpolate the actual method instead of hardcoding 'tools/call'. Phase 2 (live push delivery, Pharos only) is now built: registerResourceSubscribeCapability (mcp_protocol_adapter.ts) declares capabilities.resources.subscribe=true, without which the SDK's honoredSubset() silently drops any subscriptions/listen resourceSubscriptions filter (verified empirically against the shipped runtime — not assumed). startKarmaIndexer (skill_indexer_runtime.ts) gained an optional onResourceEvent callback fired alongside (never inside) its existing BM25/flow-rep reconcile chain, wrapped in its own try/catch so it can never affect reconciliation; wired in index.ts to call indexedEventToResourceUris(e).forEach(uri => mcpHandler?.notify.resourceUpdated(uri)) — publishing onto the SDK's own createMcpHandler()-returned ServerEventBus, so every open subscriptions/listen SSE stream gets the push, with no bespoke pub/sub written. indexedEventToResourceUris (karma.resources.ts) is a pure, exhaustive-over-the-union, zero-extra-RPC mapping: IndexedEvent's fields already carry enough (e.g. JobCompleted.provider, ResultDisputed.requester, CrossChainRepUpdated.agent) to construct the affected URIs directly — no readJob/readSkill lookup was ever needed, contrary to an earlier, more conservative assumption made before actually reading contract.ts's full 14-member IndexedEvent union. A Pharos gap was also found and closed while wiring this: KarmaService.getCrossChainRep had no Pharos-side resource (or tool) at all — only casper_get_cross_chain_rep existed — so karma://pharos/agents/{address}/cross-chain-rep was added alongside the other Pharos templates.",
    limitation:
      "Casper dispute/governance-proposal state and karma://casper/accounts/*/cross-chain-rep have no subscribe support and cannot be built as browsable/live resources at all yet: CasperLiveClient has no enumeration method for either (no listDisputes/listProposals), and odra_events.ts's decodeIndexedEvent only decodes SkillRegistered/SkillDeactivated/JobCompleted/BondUpdated — a contract-layer view-function/event-type gap, not an MCP-layer one. T3N-backed resources (t3_get_usage/t3_get_audit_events) are withheld entirely pending DEBT-008's own Phase 0 fix landing cleanly across a full SDK-level conformance pass — see the STRIDE-S fix already applied to those two handlers in this same change (getRequestContext + keystoreManager.assertOwnedBy). Casper subscribe support is deliberately deferred, not merely unbuilt: Casper's indexer only polls (no push-watch RPC equivalent to viem's watchContractEvent exists for CES events), so a Casper subscribe would need new value-diff-cache infrastructure (which account hashes to watch, last-seen rep/bonded values to diff against) that is a materially different, larger piece of work than Pharos's real-time case — and the event payload's `agent`/`provider` address field is a bare `0x<64-hex>` opaque hash (asOpaqueAddress in odra_events.ts), not the `account-hash-<hex>` string format casper.resources.ts's `{accountHash}` template variable and casperAccountHash() actually expect, so a URI can't even be constructed from a Casper event field without a format-conversion step. Five IndexedEvent variants resolve to no resource URI at all in indexedEventToResourceUris (karma.resources.ts), each for a specific documented reason, not an oversight: SkillDeactivated/MinReputationSet carry only skillId (no owner address, so there's no cheap way to know whose reputation resource to notify without an extra RPC read that the hook deliberately avoids — see below); BondUpdated has no corresponding Pharos resource (bonded-amount is Casper-only in this design); ArbiterUpdated/DisputeBondBpsUpdated are governance-parameter changes with no resource representing them. STDIO transport gets no resources/prompts push delivery: createMcpHandler's notify/bus sugar is HTTP-specific, and KARMA's STDIO path (SuperMcpRuntime.connect(), a single persistent McpServer) is separately confirmed (DEBT-003) to be permanently stuck negotiating the legacy 2025-era initialize handshake, never able to reach the 2026-07-28 stateless era where Resources/Prompts actually live.",
    resolutionTrigger:
      "A contract-layer change adds Casper view functions for disputes/governance proposals plus their event types to odra_events.ts's decoder (and a value-diff-cache mechanism is designed for Casper's poll-only indexer), OR the T3N tenant-scoping fix is extended with a resource wrapper around t3_get_usage/t3_get_audit_events, OR a deployment needs STDIO resources/prompts support badly enough to justify building it.",
    implementationGate:
      "Do not build a dispute/governance Casper resource or an agentId-keyed resource URI (breaks the tenant-scoping-by-construction property this design relies on) without re-deriving the security analysis above. Do not add a T3N resource before confirming t3.tool.ts's assertOwnedBy fix is in place and covered by its own cross-tenant regression test (src/__tests__/t3_tool.test.ts). Any new Pharos/Casper resource or resource template MUST be skipped at registration time when MCP_SAFE_MODE is true — there is no ToolDefinition.capabilities field for resources to piggyback on, so this is an explicit check in createServer(), not automatic. Every resource read and prompts/get call MUST go through applyInvocationGovernance (rate-limit/quota) and scanToolOutput (output firewall) — do not add a new resource/prompt handler that bypasses wrapResourceRead/wrapResourceTemplateRead/wrapPromptGet. indexedEventToResourceUris MUST stay a pure, synchronous, zero-RPC function — do not add a readJob/readSkill call inside it to resolve an address for SkillDeactivated/MinReputationSet; that would turn a fire-and-forget hook into a second, unawaited RPC call racing the indexer's own serialized reconciliation chain. Any Casper subscribe implementation MUST convert the event's opaque `0x<hex>` address field to the `account-hash-<hex>` string format before constructing a URI — do not assume the two formats are interchangeable.",
    ownerHint: "protocol",
    runtimeGuards: [
      "src/mcp/adapter owns the SDK/protocol boundary for Resources/Prompts, same as Tasks (DEBT-003).",
      "Resource templates are keyed by public address/hash only, never by tenant-scoped agentId.",
      "Resource reads and prompts/get calls apply globalRateLimiter/globalQuotaManager per tenant (Tasks methods do not; this is a deliberate addition given several resources make live RPC calls).",
      "Resource and prompt outputs pass through scanToolOutput before returning, same as tool outputs.",
      "Pharos/Casper resource-template registration is skipped under MCP_SAFE_MODE; karma://system/pattern-debt stays registered (pure in-memory read).",
      "protocol_header.ts requires Mcp-Name for resources/read (mirroring params.uri) and prompts/get (mirroring params.name), not just tools/call.",
      "registerResourceSubscribeCapability declares capabilities.resources.subscribe=true — without it, honoredSubset() silently drops any subscriptions/listen resourceSubscriptions filter (verified empirically, not assumed, per DEBT-003's discipline).",
      "startKarmaIndexer's onResourceEvent hook fires alongside (never inside) the existing BM25/flow-rep reconcile chain, wrapped in its own try/catch so a throwing or slow hook can never affect reconciliation.",
      "indexedEventToResourceUris makes zero additional RPC calls — it only uses fields already present on the IndexedEvent.",
    ],
    nextAction:
      "Monitor for a Casper contract-layer view-function addition and re-verify resources/prompts capability auto-advertisement (initialize + server/discover) empirically against each SDK bump, same discipline DEBT-003 established. Re-run the official conformance suite (npx @modelcontextprotocol/conformance@alpha server --spec-version 2026-07-28) after any SDK bump to confirm resources-list/resources-read-text/resources-templates-read/prompts-list/prompts-get-simple/prompts-get-with-args/prompts-get-embedded-resource still pass. Design the Casper value-diff-cache mechanism deliberately (which accounts to watch, cache eviction, address-format conversion) rather than rushing it alongside a future, unrelated change.",
  },
] as const;

export interface PatternDebtQuery {
  includeImplemented?: boolean;
  id?: PatternDebtId;
}

export function getPatternDebtItems(query: PatternDebtQuery = {}): PatternDebtItem[] {
  return ITEMS
    .filter(item => query.includeImplemented || item.status !== "implemented")
    .filter(item => !query.id || item.id === query.id)
    .map(item => ({ ...item, runtimeGuards: [...item.runtimeGuards] }));
}

export function getPatternDebtSummary() {
  const visible = getPatternDebtItems({ includeImplemented: true });
  return {
    open: visible.filter(item => item.status === "open").length,
    monitoring: visible.filter(item => item.status === "monitoring").length,
    partiallyResolved: visible.filter(item => item.status === "partially_resolved").length,
    implemented: visible.filter(item => item.status === "implemented").length,
    activeIds: visible.filter(item => item.status !== "implemented").map(item => item.id),
  };
}

export function assertKnownPatternDebtId(id: string): asserts id is PatternDebtId {
  if (!(PATTERN_DEBT_IDS as readonly string[]).includes(id)) {
    throw new Error(`[KARMA] Unknown pattern debt id: ${id}`);
  }
}
