import { ENV } from "../../config/env.js";
import { StellarX402Plugin } from "../../plugins/x402_stellar.js";
import { CasperX402Plugin } from "../../plugins/x402_casper.js";
import { XLayerX402Plugin } from "../../plugins/x402_xlayer.js";
import { paymentPlugins } from "./registry.js";
import type { PaymentPluginRegistry } from "./registry.js";
import type { IPaymentPlugin } from "./plugin.js";

/**
 * Boot-time registration of x402 IPaymentPlugin implementations into `paymentPlugins`.
 *
 * Env-gated per rail (T7/T11):
 *   • KARMA_X402_STELLAR_FACILITATOR_URL  → register StellarX402Plugin
 *   • KARMA_X402_CASPER_FACILITATOR_URL   → register CasperX402Plugin
 *   • KARMA_X402_XLAYER_FACILITATOR_URL   → register XLayerX402Plugin
 *
 * Unset URL ⇒ plugin not registered ⇒ `create_job(settlement_rail:"x402")` for that network
 * fails closed with `payment_plugin_not_registered`. This keeps the escrow path the only
 * default behaviour for stock deployments while letting buildathon submissions opt-in to
 * either chain by setting one env var.
 *
 * Idempotent across hot-reloads: by default clears the registry first so re-init is safe.
 * Tests inject env + registry directly (so they don't need module-cache resets).
 */
export interface PaymentBootEnv {
  /** Stellar x402 facilitator URL. Falsy/undefined ⇒ StellarX402Plugin not registered. */
  KARMA_X402_STELLAR_FACILITATOR_URL?: string;
  /** Casper x402 facilitator URL. Falsy/undefined ⇒ CasperX402Plugin not registered. */
  KARMA_X402_CASPER_FACILITATOR_URL?: string;
  /** X Layer x402 facilitator URL (OKX Payment SDK). Falsy/undefined ⇒ XLayerX402Plugin not registered. */
  KARMA_X402_XLAYER_FACILITATOR_URL?: string;
  /** `X402SettlementToken` package hash — forwarded to `CasperX402Plugin`'s constructor options.
   *  Falsy/undefined ⇒ plugin still registers (facilitator URL gates that), but `payWithEnvelope`
   *  throws at call time until this is set. */
  KARMA_X402_CASPER_SETTLEMENT_TOKEN?: string;
}

export interface RegisterConfiguredPaymentPluginsOptions {
  /** Clear the registry before re-registering. Default true — boot is the only caller and a
   *  stale plugin would silently shadow a new one. Tests can opt out (false) to assert
   *  duplicate-id throw behaviour. */
  reset?: boolean;
  /** Env source — defaults to the singleton ENV. Override in tests with a literal object. */
  env?: PaymentBootEnv;
  /** Target registry — defaults to the process-wide `paymentPlugins`. Override in tests. */
  registry?: PaymentPluginRegistry;
}

export interface RegisteredPluginsReport {
  registered: string[];
  skipped: Array<{ id: string; reason: string }>;
}

export function registerConfiguredPaymentPlugins(
  opts: RegisterConfiguredPaymentPluginsOptions = {},
): RegisteredPluginsReport {
  const env: PaymentBootEnv = opts.env ?? ENV;
  const registry = opts.registry ?? paymentPlugins;
  if (opts.reset !== false) registry.clear();
  const registered: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  const tryRegister = (id: string, build: () => IPaymentPlugin, reason: string | null): void => {
    if (reason != null) {
      skipped.push({ id, reason });
      return;
    }
    registry.register(build());
    registered.push(id);
  };

  tryRegister(
    "x402-stellar",
    () => new StellarX402Plugin(env.KARMA_X402_STELLAR_FACILITATOR_URL ?? ""),
    env.KARMA_X402_STELLAR_FACILITATOR_URL ? null : "KARMA_X402_STELLAR_FACILITATOR_URL not set",
  );

  tryRegister(
    "x402-casper",
    () =>
      new CasperX402Plugin(env.KARMA_X402_CASPER_FACILITATOR_URL ?? "", undefined, {
        settlementTokenPackageHash: env.KARMA_X402_CASPER_SETTLEMENT_TOKEN,
      }),
    env.KARMA_X402_CASPER_FACILITATOR_URL ? null : "KARMA_X402_CASPER_FACILITATOR_URL not set",
  );

  tryRegister(
    "x402-xlayer",
    () => new XLayerX402Plugin(env.KARMA_X402_XLAYER_FACILITATOR_URL ?? ""),
    env.KARMA_X402_XLAYER_FACILITATOR_URL ? null : "KARMA_X402_XLAYER_FACILITATOR_URL not set",
  );

  return { registered, skipped };
}
