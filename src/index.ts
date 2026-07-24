import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { ENV } from "./config/env.js";
import { SuperMcpRuntime } from "./core/runtime.js";
import { PluginLoader } from "./core/plugin_loader.js";
import { withRequestContext } from "./security/context.js";
import { authenticateHttpRequest } from "./security/auth.js";
import { isBodyTooLargeError, isJsonRequest } from "./http/security.js";
import { createServerCard } from "./http/server_card.js";
import { protectedResourceMetadata, resourceMetadataPath } from "./http/oauth_metadata.js";
import { protocolHeaderValidation } from "./middlewares/protocol_header.js";
import { loadStdioServerAdapter, loadHttpServerAdapters } from "./mcp/adapter/mcp_protocol_adapter.js";
import { startKarmaIndexer, stopKarmaIndexer } from "./lib/skill_indexer_runtime.js";
import { startCasperIndexer, stopCasperIndexer } from "./lib/casper_indexer_runtime.js";
import { registerConfiguredPaymentPlugins } from "./lib/payment/boot.js";
import { indexedEventToResourceUris } from "./plugins/karma.resources.js";

let runtime: SuperMcpRuntime;
let mcpHandler: McpHttpHandler | undefined;
let stdioHandle: StdioServerHandle | undefined;

// Last-resort safety net (KARMA-PH1-001): a stray unhandled promise rejection from any background
// task (e.g. the on-chain indexer's watch/reconnect path) would, under Node's default, terminate
// this long-running MCP host and take every tenant down with it. The proper fix lives at each call
// site (the indexer now self-heals); this handler only logs so a single missed `.catch` somewhere
// can never silently crash the server. It deliberately does NOT exit.
process.on("unhandledRejection", (reason) => {
  console.error("[KARMA] Unhandled promise rejection (kept alive — investigate the originating path):", reason);
});

function parseList(raw: string): string[] {
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function isAllowedHost(hostHeader: string | undefined, allowedHosts: Set<string>): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  const hostWithoutPort = host.split(":")[0];
  return allowedHosts.has(host) || allowedHosts.has(hostWithoutPort);
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

async function main() {
  // Register IPaymentPlugin implementations (P1 T7/T11) BEFORE loading karma.tool so the
  // create_job handler can resolve `paymentPlugins.resolve("x402", network)` at invoke time.
  // Each rail is env-gated — see src/lib/payment/boot.ts.
  const payments = registerConfiguredPaymentPlugins();
  if (payments.registered.length > 0) {
    console.error(`[KARMA] Payment plugins registered: ${payments.registered.join(", ")}`);
  }
  for (const s of payments.skipped) {
    console.error(`[KARMA] Payment plugin skipped: ${s.id} (${s.reason})`);
  }

  const tools = await PluginLoader.loadAll();
  runtime = new SuperMcpRuntime("1.0.0", tools);
  await runtime.initialize();
  const state = await runtime.getDefaultState();

  console.error(`[KARMA] Server Started v1.0.0`);
  console.error(`[KARMA] Tenant: ${ENV.MCP_TENANT_ID} | Project: ${ENV.MCP_PROJECT_ID}`);
  console.error(`[KARMA] Config: Transport=${ENV.TRANSPORT_DRIVER}, Storage=${ENV.STORAGE_DRIVER}, Telemetry=${ENV.TELEMETRY_DRIVER}`);
  console.error(`[KARMA] Security: Encrypted=${!!ENV.MCP_ENCRYPTION_KEY}, SafeMode=${ENV.MCP_SAFE_MODE}`);
  console.error(`[KARMA] Current Phase: ${state.phase}`);

  // P3-B: MCP_TRUST_IDENTITY_HEADERS is an advanced forwarding mode that relies
  // entirely on a trusted upstream auth gateway to inject identity headers.
  // Enabling it without a proper gateway is a critical security misconfiguration.
  if (ENV.MCP_TRUST_IDENTITY_HEADERS) {
    console.error(
      "[KARMA] WARNING: MCP_TRUST_IDENTITY_HEADERS=true — " +
      "identity headers (x-mcp-tenant-id, x-mcp-user-id, x-mcp-client-id, x-mcp-scopes) are " +
      "accepted from upstream. Only enable behind a trusted auth gateway (e.g. OAuth2 proxy, " +
      "mTLS-verified sidecar). Direct exposure will allow clients to impersonate any tenant/user."
    );
  }

  // D-5.3 fix: warn on startup so operators know they are running without DoS controls.
  if (ENV.TRANSPORT_DRIVER === "http" && (!ENV.ENABLE_RATE_LIMIT || !ENV.ENABLE_QUOTA)) {
    console.error(
      "[KARMA] WARNING: ENABLE_RATE_LIMIT and/or ENABLE_QUOTA are disabled. " +
      "Set both to true to prevent request flooding and resource exhaustion."
    );
  }

  // Start the on-chain skill indexer (backfill + live watch) so discover_skills reflects chain
  // state and karma_health can report indexer progress. Skipped in safe mode (network blocked) or
  // when no contract is configured. Failure here is non-fatal — the server still serves tools.
  if (!ENV.MCP_SAFE_MODE && process.env.PHAROS_CONTRACT_ADDRESS) {
    try {
      // DEBT-008 Phase 2: publish onto the SDK's own ServerEventBus (createMcpHandler's
      // `mcpHandler.notify`), so every open subscriptions/listen stream gets
      // notifications/resources/updated pushes. `mcpHandler` is assigned later in this same
      // function (HTTP-transport branch below) -- the `?.` guard covers both the brief startup
      // window before that assignment and the STDIO-transport case where it's never assigned at
      // all, in which case this hook harmlessly no-ops (no subscriptions/listen stream can exist
      // without an HTTP transport to begin with).
      startKarmaIndexer(undefined, undefined, (e) => {
        for (const uri of indexedEventToResourceUris(e)) mcpHandler?.notify.resourceUpdated(uri);
      });
      console.error("[KARMA] Skill event indexer started (backfill + live watch).");
    } catch (err) {
      console.error("[KARMA] Skill indexer failed to start (continuing without it):", err);
    }
  } else {
    console.error("[KARMA] Skill indexer not started (safe mode or PHAROS_CONTRACT_ADDRESS unset).");
  }

  // Casper's own discovery/reputation indexer (casper_indexer_runtime.ts) — polls the Odra
  // registry's CES event log instead of watching, since Casper has no RPC push-subscribe
  // equivalent to viem's watchContractEvent. Same non-fatal-failure and env-gating posture as the
  // Pharos indexer above; a separate BM25 index/flow-rep graph, not merged with Pharos's (chain-
  // local skill ids would collide — see casper_indexer_runtime.ts's header comment).
  if (!ENV.MCP_SAFE_MODE && process.env.CASPER_RPC_URL && process.env.KARMA_ODRA_REGISTRY) {
    try {
      const { CasperLiveClient } = await import("./lib/casper/live_client.js");
      const client = new CasperLiveClient({
        rpcUrl: process.env.CASPER_RPC_URL,
        contractHash: process.env.KARMA_ODRA_REGISTRY,
        chainName: process.env.CASPER_CHAIN_NAME,
        rpcHeaders: process.env.CASPER_RPC_API_KEY ? { Authorization: process.env.CASPER_RPC_API_KEY } : undefined,
      });
      startCasperIndexer(client);
      console.error("[KARMA] Casper skill event indexer started (backfill + poll).");
    } catch (err) {
      console.error("[KARMA] Casper indexer failed to start (continuing without it):", err);
    }
  } else {
    console.error("[KARMA] Casper indexer not started (safe mode or CASPER_RPC_URL/KARMA_ODRA_REGISTRY unset).");
  }

  if (ENV.TRANSPORT_DRIVER === "http") {
    const { createMcpHandler, toNodeHandler, createMcpExpressApp } = await loadHttpServerAdapters();
    const cors = (await import("cors")).default;
    const express = (await import("express")).default;

    const app = createMcpExpressApp();
    // legacy: "reject" matches KARMA's existing fail-closed protocol stance
    // (protocolHeaderValidation already hard-rejects compat/legacy protocol
    // modes below) -- this endpoint speaks 2026-07-28 stateless only, native
    // to the transport now instead of self-declared in server/discover.
    mcpHandler = createMcpHandler(() => runtime.createEphemeralServer(), { legacy: "reject" });
    const mcpNodeHandler = toNodeHandler(mcpHandler);
    const allowedOrigins = new Set(parseList(ENV.ALLOWED_ORIGINS));
    const allowedHosts = new Set(parseList(ENV.ALLOWED_HOSTS).map(h => h.toLowerCase()));

    app.disable("x-powered-by");

    // Health checks are registered before the Host/Origin gates below: platform health-checkers
    // (Fly's http_service.checks, Render's internal probe, k8s-style liveness/readiness probes)
    // connect over whatever internal address/interface the platform uses -- a private IPv6 (6PN)
    // address on Fly, loopback on others -- and don't send the public-facing Host header
    // ALLOWED_HOSTS expects. Confirmed via `flyctl ssh console` + `wget` against the machine's own
    // fdaa:... address: 403 Invalid Host, even though the exact same request over 127.0.0.1
    // succeeded, and even after binding HTTP_HOST to "::" fixed the earlier IPv6-unreachable
    // ("connection refused") symptom. These endpoints return no sensitive data (liveness: a static
    // version string; readiness: a storage-backend health boolean), so exempting them from
    // Host/Origin validation is standard practice for infra probes, not a meaningful attack surface.
    app.get("/health/liveness", (req, res) => { res.json({ status: "alive", version: "1.0.0" }); });
    app.get("/health/readiness", async (req, res) => {
      try {
        const healthy = await runtime.healthCheck();
        res.status(healthy ? 200 : 503).json({ status: healthy ? "ready" : "not_ready", storage: ENV.STORAGE_DRIVER });
      } catch {
        res.status(503).json({ status: "not_ready", storage: ENV.STORAGE_DRIVER });
      }
    });

    app.use((req, res, next) => {
      if (!isAllowedHost(req.headers.host, allowedHosts)) {
        res.status(403).json({ error: "Invalid Host" });
        return;
      }
      next();
    });

    // Reject disallowed Origins with a clean 403 before `cors` ever runs. The `cors` package's
    // origin callback only supports rejecting by forwarding an Error to `next(err)`, which falls
    // through to Express's default error handler -- an uncaught-looking 500 with no body -- so the
    // actual reject-with-403 decision has to happen in a plain middleware instead (matching the
    // Host check above and the SDK's own "Invalid Origin: <value>" wording for evil/DNS-rebinding
    // origins, which is enforced separately by createMcpExpressApp()).
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) {
        res.status(403).json(jsonRpcError(-32000, `Invalid Origin: ${origin}`));
        return;
      }
      next();
    });

    app.use(cors({
      origin: (origin, callback) => {
        // The reject-with-403 decision already happened above; this only controls whether CORS
        // response headers get emitted for an allowed origin. Never pass an Error here.
        callback(null, !origin || allowedOrigins.has(origin));
      }
    }));

    app.get("/.well-known/mcp.json", (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(createServerCard(tools, "1.0.0"));
    });

    app.get("/.well-known/mcp-server-card", (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(createServerCard(tools, "1.0.0"));
    });

    app.get(resourceMetadataPath(), (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(protectedResourceMetadata(tools));
    });

    app.use("/mcp", (req, res, next) => {
      const contentType = req.headers["content-type"];
      if (!isJsonRequest(req.method, Array.isArray(contentType) ? contentType[0] : contentType)) {
        res.status(415).json(jsonRpcError(-32000, "Unsupported media type. Use application/json."));
        return;
      }
      next();
    });

    app.use("/mcp", express.json({ limit: ENV.MCP_HTTP_BODY_LIMIT, type: ["application/json", "application/*+json"] }));

    app.use("/mcp", (error: any, req: any, res: any, next: any) => {
      if (isBodyTooLargeError(error)) {
        res.status(413).json(jsonRpcError(-32000, "Payload too large."));
        return;
      }
      next(error);
    });

    app.use("/mcp", async (req, res, next) => {
      try {
        (req as any).superMcpContext = await authenticateHttpRequest(req.headers);
        next();
      } catch {
        if (ENV.MCP_AUTH_MODE === "jwt" || ENV.MCP_AUTH_MODE === "oidc_jwks") {
          const forwardedProto = req.headers["x-forwarded-proto"];
          const rawProto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || req.protocol || "https";
          const proto = ["http", "https"].includes(rawProto) ? rawProto : "https";
          const forwardedHost = req.headers["x-forwarded-host"];
          const rawHost = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || req.headers.host;
          const host = isAllowedHost(rawHost, allowedHosts) ? rawHost : null;
          const metadataUrl = host ? `${proto}://${host}${resourceMetadataPath()}` : resourceMetadataPath();
          res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
        }
        res.status(401).json({ error: "Unauthorized" });
      }
    });

    // P2-B: Validate final rc2026 Mcp-Method / Mcp-Name operation headers.
    // Must run after body parse and auth so both req.body and context are available.
    app.use("/mcp", protocolHeaderValidation);

    app.post("/mcp", async (req, res) => {
      const ctx = (req as any).superMcpContext;
      await withRequestContext(ctx, async () => {
        try {
          await mcpNodeHandler(req, res, req.body);
        } catch (error) {
          console.error("[KARMA] Error handling MCP HTTP request:", error);
          if (!res.headersSent) {
            res.status(500).json(jsonRpcError(-32603, "Internal server error"));
          }
        }
      });
    });

    app.get("/mcp", (req, res) => {
      res.status(405).json(jsonRpcError(-32000, "Method not allowed in stateless HTTP mode."));
    });

    app.delete("/mcp", (req, res) => {
      res.status(405).json(jsonRpcError(-32000, "Method not allowed in stateless HTTP mode."));
    });

    const server = app.listen(ENV.HTTP_PORT, ENV.HTTP_HOST, () => {
      console.error(`[KARMA] Server listening on HTTP ${ENV.HTTP_HOST}:${ENV.HTTP_PORT} at /mcp`);
    });
    (runtime as any)._httpServer = server;
  } else {
    // serveStdio() (not runtime.connect()) is the SDK's 2026-07-28-capable stdio entry point --
    // see loadStdioServerAdapter()'s comment in mcp_protocol_adapter.ts. It negotiates the era
    // per connection from the opening message and serves both 2025-era and 2026-07-28 clients
    // correctly from the same ephemeral-server factory HTTP already uses.
    const { serveStdio } = await loadStdioServerAdapter();
    stdioHandle = serveStdio(() => runtime.createEphemeralServer());
  }

  const shutdown = async (signal: string) => {
    console.error(`\n[KARMA] Received signal ${signal}. Initiating Graceful Shutdown...`);
    try {
      if ((runtime as any)._httpServer) {
        console.error(`[KARMA] Closing HTTP Server...`);
        await new Promise<void>((resolve, reject) => {
          (runtime as any)._httpServer.close((err: unknown) => err ? reject(err instanceof Error ? err : new Error("Server close failed", { cause: err })) : resolve());
        });
      }
      if (mcpHandler) {
        await mcpHandler.close().catch(() => undefined);
      }
      if (stdioHandle) {
        await stdioHandle.close().catch(() => undefined);
      }

      stopKarmaIndexer();
      stopCasperIndexer();

      // Drop in-memory agent signing keys on shutdown (DEBT-007): shrinks the heap-exposure window
      // for the decrypted viem accounts. Best-effort (V8 can't force-zero the closure-held key).
      const { keystoreManager } = await import("./lib/keystore.js");
      keystoreManager.clear();

      const { globalTaskTracker } = await import("./core/task_tracker.js");
      globalTaskTracker.beginDraining();
      await globalTaskTracker.awaitAll(30000);
      await runtime.close();
      console.error("[KARMA] Graceful shutdown completed.");
      process.exit(0);
    } catch (err) {
      console.error("[KARMA] Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
}

main().catch((error) => {
  console.error("[KARMA] Fatal Crash:", error);
  process.exit(1);
});
