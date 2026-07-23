import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import casperSdk from "casper-js-sdk";
import type { PrivateKey as CasperPrivateKey, Transaction, Args as CasperArgs } from "casper-js-sdk";
import {
  odraMappingDictionaryKey,
  accountAddressToBytes,
  u64ToBytes,
  AGENT_SKILL_REGISTRY_FIELD_INDEX,
} from "./odra_storage_key.js";
import {
  decodeSkill,
  decodeJob,
  decodeU32,
  decodeU64,
  decodeU512,
  decodeComposition,
  decodeBytesVec,
  decodeAddress,
  decodeAddressList,
  decodeU64List,
  decodeDisputeInfo,
  decodeGovernanceProposal,
  type DecodedSkill,
  type DecodedJob,
  type DecodedComposition,
  type DecodedDisputeInfo,
  type DecodedGovernanceProposal,
  type CasperAddress,
} from "./odra_codec.js";
import { EVENTS_DICT, EVENTS_LENGTH_KEY, decodeIndexedEvent } from "./odra_events.js";
import type { IndexedEvent } from "../contract.js";
const {
  RpcClient,
  HttpHandler,
  ContractCallBuilder,
  SessionBuilder,
  Args,
  CLValue,
  CLTypeUInt8,
  CLTypeUInt64,
  CLTypeUInt32,
  CLTypeKey,
  Key,
  ParamDictionaryIdentifier,
  ParamDictionaryIdentifierContractNamedKey,
} = casperSdk;

/** Odra's generic proxy-caller session (https://odra.dev/docs/basics/native-token —
 *  "Cargo Purse" idiom): Casper has no direct account→contract token transfer, so a "payable"
 *  entry point (one that reads `self.env().attached_value()`, e.g. `deposit_bond`/`create_job`)
 *  can't be reached via a plain stored-contract-call transaction with a `U512` arg named
 *  "amount" — that arg is never read by the contract and `attached_value()` stays zero
 *  (confirmed against a real deploy: reverted with `ExecutionError::NoBond`, code 20). The
 *  proxy session creates a one-time purse, funds it, and calls the target entry point with that
 *  purse's URef under the `cargo_purse` arg the wasm-env glue actually reads. Bundled verbatim
 *  from `odra-casper-test-vm` (its `resources/proxy_caller_with_return.wasm`) — Odra ships no
 *  separate npm package for it, and building it from source isn't necessary (it's
 *  contract-agnostic, not project-specific like `karma_odra.wasm`).
 */
const PROXY_CALLER_WASM_PATH = fileURLToPath(new URL("./resources/proxy_caller_with_return.wasm", import.meta.url));

/**
 * CasperLiveClient (T13-live) — the real casper-js-sdk path `register_rwa_oracle_skill.ts`'s
 * `runLive()` deferred until a deployed contract existed. Builds a `ContractCallBuilder`
 * transaction per entry point, signs it with the caller's Casper key, submits it via
 * `RpcClient.putTransaction`, and returns the real transaction hash.
 *
 * Writes cover the six state-changing entry points the T13 RWA-oracle demo walks (register_skill,
 * deposit_bond, create_job, deliver_result, confirm_completion, withdraw). Argument shapes are
 * pinned to `contracts-odra/src/agent_skill_registry.rs`'s real signatures, not the simplified
 * `IAgentSkillRegistry` mirror in `odra_registry.ts` (that mirror predates P0-A/P0-B/P1-A and is
 * for offline demos only).
 *
 * Reads (`pendingWithdrawalsOf`, `agentReputationOf`, `bondedOf`) query the "state" dictionary
 * directly via `odra_storage_key.ts`'s derivation — Casper doesn't return a Wasm entry point's
 * return value through the RPC layer, so a getter *entry point* can't be called for a free read;
 * a global-state query against the contract's own storage is the only reliable path. The
 * dictionary-item-key formula and the field indices below are pinned by `cargo expand` against
 * the actual macro output (see `contracts-odra/README.md`), not guessed, and cross-checked in
 * `casper_odra_storage_key.test.ts` against an independent Python blake2b256 reference.
 * `get_skill` / `get_job` (compound `Skill`/`Job` structs, not a single scalar) decode the raw
 * `CLValue.any` bytes via `odra_codec.ts`, field-by-field per the structs' `bytesrepr` layout —
 * see that module's header for how the byte-level rules were confirmed, not assumed.
 *
 * The governance-state getters (`getArbiter`/`getGovernanceSigners`/`getGovernanceThreshold`/
 * `getTimelockDelayMs`) read bare `Var<T>` fields the same way — a `Var` read is a `Mapping` read
 * with an empty mapping-key byte string (see `odraMappingDictionaryKey`'s header comment) — and
 * their field indices (17/19/20/21) all exceed the legacy 0-15 encoding range, exercising
 * `odraMappingDictionaryKey`'s path-encoding branch (empirically confirmed against a real
 * `cargo +nightly expand` run, not assumed — see `odra_storage_key.ts`'s header comment).
 *
 * `claimRefund` is a seventh write, added alongside the six T13-demo writes above: the
 * requester's refund path for a job whose provider never delivered before the deadline.
 */

export interface CasperLiveClientOpts {
  rpcUrl: string;
  contractHash: string;
  chainName?: string;
  /** Gas payment ceiling in motes, per call. Overridable per-method. */
  defaultPaymentMotes?: bigint;
  /** Extra HTTP headers for every RPC call — e.g. `{ Authorization: <key> }` for hosted RPC
   *  providers (cspr.cloud) that now require an API key; the header value is passed through
   *  as-is (no "Bearer " prefix — cspr.cloud rejects that form). */
  rpcHeaders?: Record<string, string>;
}

export interface RegisterSkillInput {
  name: string;
  description: string;
  mcpEndpoint: string;
  /** CSPR motes (9 decimals), matching the Rust `price_per_call: U512`. */
  pricePerCallMotes: bigint;
  minReputationToInvoke: number;
  identityPolicy: number;
}

export interface RegisterCompositionInput {
  name: string;
  description: string;
  mcpEndpoint: string;
  pricePerCallMotes: bigint;
  minReputationToInvoke: number;
  identityPolicy: number;
  /** Child skill ids (1..8) this composite fans its escrow out to. */
  leafSkillIds: bigint[];
  /** Basis-points weights, same length/order as `leafSkillIds`, must sum to 10_000. */
  weightsBps: number[];
}

export interface CreateJobInput {
  skillId: bigint;
  /** 32-byte task hash, hex-encoded (no 0x prefix). */
  taskHashHex: string;
  deadlineSecs: bigint;
  /** Escrow attached to the payable call, in motes — must equal the skill's `price_per_call`. */
  escrowMotes: bigint;
}

export interface CreateJobWithEvaluatorInput {
  skillId: bigint;
  taskHashHex: string;
  deadlineSecs: bigint;
  /** `"account-hash-<hex>"` — the neutral third party who will call `evaluateResult`. */
  evaluatorAccountHash: string;
  evaluatorFeeMotes: bigint;
  /** Attached value — must equal exactly `price_per_call + evaluatorFeeMotes`. */
  escrowMotes: bigint;
}

export interface DeliverResultInput {
  jobId: bigint;
  /** 32-byte result hash, hex-encoded (no 0x prefix). */
  resultHashHex: string;
}

const DEFAULT_PAYMENT_MOTES = 5_000_000_000n; // 5 CSPR ceiling — generous default, refund is automatic.
// Proxy-caller sessions do more work than a plain entry-point call (create a purse + two native
// transfers + the entry point itself), so they need a higher ceiling than DEFAULT_PAYMENT_MOTES.
const PROXY_DEFAULT_PAYMENT_MOTES = 20_000_000_000n; // 20 CSPR ceiling.

/** A bare `Var<T>` read's "mapping key" is the empty byte string (see `odraMappingDictionaryKey`'s
 *  header comment in `odra_storage_key.ts`) — used by the governance-state getters below, which
 *  read `Var` fields (`arbiter`, `governance_signers`, `governance_threshold`, `timelock_delay`),
 *  not `Mapping<K, V>` entries. */
const EMPTY_VAR_KEY = new Uint8Array(0);

/** casper-client / DEMO_CASPER.md conventionally write contract package hashes as
 *  `hash-<64 hex>` (or `contract-package-wasm<64 hex>`); `ContractCallBuilder.byHash()` wants the
 *  bare 64-char hex, so strip whichever prefix is present. */
function stripHashPrefix(hash: string): string {
  return hash.replace(/^(hash-|contract-package-wasm|contract-)/, "");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`[casper-live] odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Odra's `#[odra::odra_type]` struct/enum values come back over RPC as `CLType::List(U8)`
 *  (one CLValue::U8 element per byte) — confirmed against a real deployed contract read, not
 *  `CLType::Any` as first assumed (that assumption only ever passed against hand-built mocks). */
function odraStructBytes(clValue: InstanceType<typeof CLValue> | undefined): Uint8Array | undefined {
  if (clValue?.any) return clValue.any.bytes();
  if (clValue?.list) return Uint8Array.from(clValue.list.elements.map((e) => e.ui8!.toNumber()));
  return undefined;
}

/** `casper_types::bytesrepr::Bytes`'s `CLTyped` impl is literally `<Vec<u8>>::cl_type()` — i.e.
 *  `CLType::List(U8)`, the same encoding `odraStructBytes` reads back (confirmed in
 *  `casper-types` source, not assumed). Used for the proxy-caller's `args` field and for any
 *  entry-point arg whose Rust type is `Bytes` (e.g. `task_hash`/`result_hash` — NOT
 *  `CLValue.newCLByteArray`, which is the fixed-size `ByteArray` CLType instead). */
function bytesToCLList(bytes: Uint8Array): InstanceType<typeof CLValue> {
  return CLValue.newCLList(CLTypeUInt8, Array.from(bytes).map((b) => CLValue.newCLUint8(b)));
}

/** Odra's `Address`'s `CLTyped` impl is `CLType::Key` (`to_bytes()` delegates to
 *  `Key::from(*self).to_bytes()` — confirmed in `odra-core-2.8.1/src/address.rs`, not assumed).
 *  Accepts the same `"account-hash-<hex>"` / `"hash-<hex>"` prefixed string convention already
 *  used elsewhere in this module (`casperAccountHash()`, `casper_get_account_state`). */
function addressKeyArg(accountHashPrefixed: string): InstanceType<typeof CLValue> {
  return CLValue.newCLKey(Key.newKey(accountHashPrefixed));
}

/** `Verdict`'s `CLTyped` impl is a plain `CLType::U8` discriminant in declaration order
 *  (`ProviderAtFault = 0`, `RequesterAtFault = 1`) — confirmed via `cargo +nightly expand`, not
 *  guessed; NOT the `List(U8)` wrapping used for Mapping/Var storage reads (that's a
 *  dictionary-storage convention, unrelated to how a plain enum call arg is encoded). */
export type Verdict = "ProviderAtFault" | "RequesterAtFault";
const VERDICT_DISCRIMINANT: Record<Verdict, number> = { ProviderAtFault: 0, RequesterAtFault: 1 };

/** Minimal seam `CasperLiveClient` needs from `RpcClient` — narrow on purpose so tests can
 *  inject a fake without reproducing casper-js-sdk's real JSON-RPC response parsing. */
export interface CasperTransactionSubmitter {
  putTransaction(transaction: Transaction): Promise<{ transactionHash: { toHex(): string } }>;
  getStateRootHashLatest(): Promise<{ stateRootHash: { toHex(): string } }>;
  getDictionaryItemByIdentifier(
    stateRootHash: string | null,
    identifier: InstanceType<typeof ParamDictionaryIdentifier>,
  ): Promise<{ storedValue: { clValue?: InstanceType<typeof CLValue> } }>;
  queryLatestGlobalState(
    key: string,
    path: string[],
  ): Promise<{
    storedValue: {
      contractPackage?: { versions: Array<{ contractHash: { hash: { toHex(): string } } }> };
      clValue?: InstanceType<typeof CLValue>;
    };
  }>;
}

export class CasperLiveClient {
  private readonly rpc: CasperTransactionSubmitter;
  private readonly contractHash: string;
  private readonly chainName: string;
  private readonly defaultPaymentMotes: bigint;

  constructor(opts: CasperLiveClientOpts, rpcOverride?: CasperTransactionSubmitter) {
    if (rpcOverride) {
      this.rpc = rpcOverride;
    } else {
      const handler = new HttpHandler(opts.rpcUrl);
      if (opts.rpcHeaders) handler.setCustomHeaders(opts.rpcHeaders);
      this.rpc = new RpcClient(handler);
    }
    this.contractHash = opts.contractHash;
    this.chainName = opts.chainName ?? "casper-test";
    this.defaultPaymentMotes = opts.defaultPaymentMotes ?? DEFAULT_PAYMENT_MOTES;
  }

  /** `register_skill(name, description, mcp_endpoint, price_per_call, min_reputation_to_invoke, identity_policy) -> u64` */
  async registerSkill(
    signer: CasperPrivateKey,
    s: RegisterSkillInput,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      name: CLValue.newCLString(s.name),
      description: CLValue.newCLString(s.description),
      mcp_endpoint: CLValue.newCLString(s.mcpEndpoint),
      price_per_call: CLValue.newCLUInt512(s.pricePerCallMotes.toString()),
      min_reputation_to_invoke: CLValue.newCLUInt32(s.minReputationToInvoke),
      identity_policy: CLValue.newCLUint8(s.identityPolicy),
    });
    return this.submit(signer, "register_skill", args, paymentMotes);
  }


  /** `deactivate_skill(skill_id: u64)` — skill owner only (contract-enforced). Marks the skill
   *  inactive; `create_job`/`create_job_with_evaluator` reject an inactive skill. */
  async deactivateSkill(signer: CasperPrivateKey, skillId: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ skill_id: CLValue.newCLUint64(skillId.toString()) });
    return this.submit(signer, "deactivate_skill", args, paymentMotes);
  }

  /** `set_min_reputation(skill_id: u64, min_reputation: u32)` — skill owner only. Raises/lowers
   *  the agent-reputation floor `create_job` enforces for this skill. */
  async setMinReputation(
    signer: CasperPrivateKey,
    skillId: bigint,
    minReputation: number,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      skill_id: CLValue.newCLUint64(skillId.toString()),
      min_reputation: CLValue.newCLUInt32(minReputation),
    });
    return this.submit(signer, "set_min_reputation", args, paymentMotes);
  }

  /** `set_identity_policy(skill_id: u64, policy: u8)` — skill owner only. Same policy-id space
   *  `register_skill`'s `identity_policy` arg uses (see `docs/standards/IdentityPolicy-registry.md`). */
  async setIdentityPolicy(
    signer: CasperPrivateKey,
    skillId: bigint,
    policy: number,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      skill_id: CLValue.newCLUint64(skillId.toString()),
      policy: CLValue.newCLUint8(policy),
    });
    return this.submit(signer, "set_identity_policy", args, paymentMotes);
  }

  /** `register_composition(name, description, mcp_endpoint, price_per_call,
   *  min_reputation_to_invoke, identity_policy, leaf_skill_ids: Vec<u64>, weights_bps: Vec<u32>)
   *  -> u64` — registers the composite as a normal `Skill` entry (same id space as
   *  `register_skill`) plus a `Composition` record; on-chain validation enforces 1..=8 leaves,
   *  matching weight-vector length, weights summing to 10_000 bps, and single-level nesting
   *  (every leaf must be an existing, active, non-composite skill). */
  async registerComposition(
    signer: CasperPrivateKey,
    c: RegisterCompositionInput,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      name: CLValue.newCLString(c.name),
      description: CLValue.newCLString(c.description),
      mcp_endpoint: CLValue.newCLString(c.mcpEndpoint),
      price_per_call: CLValue.newCLUInt512(c.pricePerCallMotes.toString()),
      min_reputation_to_invoke: CLValue.newCLUInt32(c.minReputationToInvoke),
      identity_policy: CLValue.newCLUint8(c.identityPolicy),
      leaf_skill_ids: CLValue.newCLList(CLTypeUInt64, c.leafSkillIds.map((id) => CLValue.newCLUint64(id.toString()))),
      weights_bps: CLValue.newCLList(CLTypeUInt32, c.weightsBps.map((w) => CLValue.newCLUInt32(w))),
    });
    return this.submit(signer, "register_composition", args, paymentMotes);
  }

  /** `#[odra(payable)] deposit_bond()` — Odra's payable convention: attach CSPR via the `amount` runtime arg. */
  async depositBond(signer: CasperPrivateKey, amountMotes: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    // deposit_bond() takes no named args — it reads self.env().attached_value(), which only a
    // proxy-caller session (see submitPayable) can actually populate on Casper.
    return this.submitPayable(signer, "deposit_bond", Args.fromMap({}), amountMotes, paymentMotes);
  }

  /** `create_job(skill_id, task_hash: Bytes, deadline_secs) -> u64` — payable: takes no
   *  `amount`/escrow arg at all (confirmed against the deployed contract's own entry-point
   *  signature); the escrow is `self.env().attached_value()`, checked to equal exactly
   *  `skill.price_per_call` — hence `submitPayable`, not a plain `amount` runtime arg. */
  async createJob(signer: CasperPrivateKey, j: CreateJobInput, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const innerArgs = Args.fromMap({
      skill_id: CLValue.newCLUint64(j.skillId.toString()),
      task_hash: bytesToCLList(hexToBytes(j.taskHashHex)),
      deadline_secs: CLValue.newCLUint64(j.deadlineSecs.toString()),
    });
    return this.submitPayable(signer, "create_job", innerArgs, j.escrowMotes, paymentMotes);
  }

  /** `create_job_with_evaluator(skill_id, task_hash: Bytes, deadline_secs, evaluator: Address,
   *  evaluator_fee: U512) -> u64` — payable: `attached_value` must equal exactly
   *  `price_per_call + evaluator_fee` (confirmed against the Rust doc comment, not assumed). */
  async createJobWithEvaluator(
    signer: CasperPrivateKey,
    j: CreateJobWithEvaluatorInput,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const innerArgs = Args.fromMap({
      skill_id: CLValue.newCLUint64(j.skillId.toString()),
      task_hash: bytesToCLList(hexToBytes(j.taskHashHex)),
      deadline_secs: CLValue.newCLUint64(j.deadlineSecs.toString()),
      evaluator: addressKeyArg(j.evaluatorAccountHash),
      evaluator_fee: CLValue.newCLUInt512(j.evaluatorFeeMotes.toString()),
    });
    return this.submitPayable(signer, "create_job_with_evaluator", innerArgs, j.escrowMotes, paymentMotes);
  }

  /** `evaluate_result(job_id, approved: bool)` — only the job's designated evaluator may call
   *  this within the review window; the evaluator fee releases regardless of verdict. */
  async evaluateResult(
    signer: CasperPrivateKey,
    jobId: bigint,
    approved: boolean,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      job_id: CLValue.newCLUint64(jobId.toString()),
      approved: CLValue.newCLValueBool(approved),
    });
    return this.submit(signer, "evaluate_result", args, paymentMotes);
  }

  /** `#[odra(payable)] dispute_result(job_id)` — requester contests a delivered result within the
   *  review window; `attached_value` must equal exactly the required bond (bps of escrow, floored
   *  at `MIN_DISPUTE_BOND_MOTES`) — read `get_dispute_bond_bps`/the skill's `price_per_call` off
   *  `getSkill`/`getJob` to compute it, or over-estimate and let the contract revert on mismatch. */
  async disputeResult(signer: CasperPrivateKey, jobId: bigint, bondMotes: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const innerArgs = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submitPayable(signer, "dispute_result", innerArgs, bondMotes, paymentMotes);
  }

  /** `#[odra(payable)] respond_to_dispute(job_id)` — provider matches the requester's dispute
   *  bond exactly to contest (enter arbitration) within `RESPONSE_WINDOW` of the dispute. */
  async respondToDispute(signer: CasperPrivateKey, jobId: bigint, bondMotes: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const innerArgs = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submitPayable(signer, "respond_to_dispute", innerArgs, bondMotes, paymentMotes);
  }

  /** `concede_dispute(job_id)` — provider forfeits both bonds + escrow to the requester. */
  async concedeDispute(signer: CasperPrivateKey, jobId: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submit(signer, "concede_dispute", args, paymentMotes);
  }

  /** `resolve_default_concede(job_id)` — anyone may call once `RESPONSE_WINDOW` elapses with no
   *  provider response; resolves identically to `concede_dispute`. */
  async resolveDefaultConcede(signer: CasperPrivateKey, jobId: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submit(signer, "resolve_default_concede", args, paymentMotes);
  }

  /** `arbitrate(job_id, verdict: Verdict)` — arbiter-only; both sides must be bonded
   *  (`dispute_result` + `respond_to_dispute` already called). Loser pays. */
  async arbitrate(signer: CasperPrivateKey, jobId: bigint, verdict: Verdict, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      job_id: CLValue.newCLUint64(jobId.toString()),
      verdict: CLValue.newCLUint8(VERDICT_DISCRIMINANT[verdict]),
    });
    return this.submit(signer, "arbitrate", args, paymentMotes);
  }

  // ── P4-A: Panel Arbitration (N-of-M) ────────────────────────────────────────
  // `dispute_result_via_panel` is `#[odra(payable)]` (confirmed by reading the Rust source
  // directly, NOT assumed from `dispute_result`'s shape) — it collects `required_bond +
  // panel_arbiter_fee` as one combined attached value, so it goes through `submitPayable` like
  // `disputeResult`/`respondToDispute`, not `submit`. Every other panel entry point below takes
  // no CSPR and uses `submit`, same as `arbitrate`/`resolveDefaultConcede`.

  /** `propose_set_arbiter_panel(panel: Vec<Address>, threshold: u32) -> u64` — governance-signer
   *  only. Same propose/approve/execute + timelock lifecycle as `proposeSetArbiter`; the contract
   *  re-validates panel shape (odd size, `MIN_ARBITER_PANEL_SIZE..=MAX_ARBITER_PANEL_SIZE`,
   *  `threshold == panel.len() / 2 + 1`, no duplicates) at both propose time and execute time. */
  async proposeSetArbiterPanel(
    signer: CasperPrivateKey,
    panelAccountHashes: string[],
    threshold: number,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      panel: CLValue.newCLList(CLTypeKey, panelAccountHashes.map((a) => addressKeyArg(a))),
      threshold: CLValue.newCLUInt32(threshold),
    });
    return this.submit(signer, "propose_set_arbiter_panel", args, paymentMotes);
  }

  /** `propose_set_panel_arbiter_fee(fee: U512) -> u64` — governance-signer only. Flat CSPR amount
   *  every panel member earns for voting before `PANEL_VOTE_WINDOW` elapses. */
  async proposeSetPanelArbiterFee(signer: CasperPrivateKey, feeMotes: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ fee: CLValue.newCLUInt512(feeMotes.toString()) });
    return this.submit(signer, "propose_set_panel_arbiter_fee", args, paymentMotes);
  }

  /** `#[odra(payable)] dispute_result_via_panel(job_id)` — like `disputeResult`, but flags the
   *  job for N-of-M panel arbitration and snapshots the panel/threshold/fee onto the job so a
   *  later governance change can never alter an in-flight dispute's terms. `bondPlusFeeMotes`
   *  must equal exactly `required_bond + panel_arbiter_fee` (the contract's own
   *  `required_total` check) — NOT just the bond alone, unlike `disputeResult`'s `bondMotes`.
   *  Reverts `PanelNotConfigured` if no panel is set, `WrongPanelDisputeAmount` on a mismatch. */
  async disputeResultViaPanel(
    signer: CasperPrivateKey,
    jobId: bigint,
    bondPlusFeeMotes: bigint,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const innerArgs = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submitPayable(signer, "dispute_result_via_panel", innerArgs, bondPlusFeeMotes, paymentMotes);
  }

  /** `cast_panel_vote(job_id, verdict: Verdict)` — panel-member only, checked against the
   *  dispute's own `job_panel_snapshot` (never the live `arbiter_panel`). Settles automatically
   *  and pays every voter once `job_panel_threshold_snapshot` votes agree on one verdict — no
   *  separate "execute" call needed. */
  async castPanelVote(signer: CasperPrivateKey, jobId: bigint, verdict: Verdict, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      job_id: CLValue.newCLUint64(jobId.toString()),
      verdict: CLValue.newCLUint8(VERDICT_DISCRIMINANT[verdict]),
    });
    return this.submit(signer, "cast_panel_vote", args, paymentMotes);
  }

  /** `resolve_panel_default(job_id)` — anyone may call once `PANEL_VOTE_WINDOW` elapses without
   *  the panel reaching its threshold; resolves `ProviderAtFault` (same default direction as
   *  `resolveDefaultConcede`'s single-arbiter equivalent) and still pays whichever arbiters DID
   *  vote before the window closed. */
  async resolvePanelDefault(signer: CasperPrivateKey, jobId: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submit(signer, "resolve_panel_default", args, paymentMotes);
  }

  /** `deliver_result(job_id, result_hash: Bytes)` */
  async deliverResult(signer: CasperPrivateKey, d: DeliverResultInput, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      job_id: CLValue.newCLUint64(d.jobId.toString()),
      result_hash: bytesToCLList(hexToBytes(d.resultHashHex)),
    });
    return this.submit(signer, "deliver_result", args, paymentMotes);
  }

  /** `confirm_completion(job_id)` */
  async confirmCompletion(signer: CasperPrivateKey, jobId: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submit(signer, "confirm_completion", args, paymentMotes);
  }

  /** `claim_after_review(job_id)` — anti-deadlock path: the provider claims escrow once the
   *  review window has elapsed with no `confirm_completion` or `dispute_result` from the
   *  requester. Reverts `ReviewWindowOpen` while the window is still open, `NotProvider` for
   *  anyone else. Mirrors karma.tool.ts's Pharos `claimAfterReview`. */
  async claimAfterReview(signer: CasperPrivateKey, jobId: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submit(signer, "claim_after_review", args, paymentMotes);
  }

  /** `claim_refund(job_id)` — requester-only refund path for a job that was never delivered:
   *  reclaims the escrow (+ evaluator fee, if the job had one) back into `pending_withdrawals`.
   *  Reverts `NotRequester` if the caller isn't the job's requester, `NotRefundable` unless
   *  `status == Open` (a delivered/completed/refunded/disputed job can't be refunded this way —
   *  see `disputeResult`/`concedeDispute` for the delivered-but-contested path instead), and
   *  `BeforeDeadline` until `block_time > deadline`. */
  async claimRefund(signer: CasperPrivateKey, jobId: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submit(signer, "claim_refund", args, paymentMotes);
  }

  /** `withdraw()` — no args; pulls the caller's full `pending_withdrawals` balance. */
  async withdraw(signer: CasperPrivateKey, paymentMotes?: bigint): Promise<{ txHash: string }> {
    return this.submit(signer, "withdraw", Args.fromMap({}), paymentMotes);
  }

  /** Reads `pending_withdrawals[account]` (motes, as a base-10 string) directly from the
   *  "state" dictionary — 0 if the account has never been credited. */
  async pendingWithdrawalsOf(accountHashHex: string): Promise<string> {
    const clValue = await this.readMapping(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.pendingWithdrawals,
      accountAddressToBytes(accountHashHex),
    );
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU512(bytes).toString() : "0";
  }

  /** Reads `agent_rep[account]` (0-100) directly from the "state" dictionary — the contract's
   *  `BASE_REPUTATION` default (50) if the account has never invoked/completed a job. */
  async agentReputationOf(accountHashHex: string): Promise<number> {
    const clValue = await this.readMapping(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.agentRep,
      accountAddressToBytes(accountHashHex),
    );
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU32(bytes) : 50;
  }

  /** Reads `bonded_amount[account]` (motes, as a base-10 string) directly from the "state"
   *  dictionary — 0 if the account has never deposited a Tier-2 Sybil bond. */
  async bondedOf(accountHashHex: string): Promise<string> {
    const clValue = await this.readMapping(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.bondedAmount,
      accountAddressToBytes(accountHashHex),
    );
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU512(bytes).toString() : "0";
  }


  /** Reads `agent_provider_jobs[agent]` (`Mapping<Address, Vec<u64>>`, field index 6) — every
   *  job id this agent has ever been the provider on (mirrors `get_provider_jobs`). */
  async getProviderJobs(accountHashHex: string): Promise<bigint[]> {
    const clValue = await this.readMapping(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.agentProviderJobs,
      accountAddressToBytes(accountHashHex),
    );
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU64List(bytes) : [];
  }

  /** Reads `agent_requester_jobs[agent]` (`Mapping<Address, Vec<u64>>`, field index 7) — every
   *  job id this agent has ever been the requester on (mirrors `get_requester_jobs`). */
  async getRequesterJobs(accountHashHex: string): Promise<bigint[]> {
    const clValue = await this.readMapping(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.agentRequesterJobs,
      accountAddressToBytes(accountHashHex),
    );
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU64List(bytes) : [];
  }

  /** Reads `agent_skills[agent]` (`Mapping<Address, Vec<u64>>`, field index 8) — every skill id
   *  this agent owns (mirrors `get_agent_skills`). */
  async getAgentSkills(accountHashHex: string): Promise<bigint[]> {
    const clValue = await this.readMapping(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.agentSkills,
      accountAddressToBytes(accountHashHex),
    );
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU64List(bytes) : [];
  }

  /** Reads `skills[skillId]` — the full `Skill` record — decoding Odra's raw struct bytes.
   *  `undefined` if the ID was never registered. */
  async getSkill(skillId: bigint): Promise<DecodedSkill | undefined> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.skills, u64ToBytes(skillId));
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeSkill(bytes) : undefined;
  }

  /** Reads `jobs[jobId]` — the full `Job` record — decoding Odra's raw struct bytes.
   *  `undefined` if the ID was never created. */
  async getJob(jobId: bigint): Promise<DecodedJob | undefined> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.jobs, u64ToBytes(jobId));
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeJob(bytes) : undefined;
  }


  /** Reads `disputes[job_id]` (`Mapping<u64, DisputeInfo>`, field index 18, P1-A) — the bonded
   *  amounts + dispute timestamp for a job currently under dispute; `undefined` once resolved
   *  (the entry is scoped to the active-dispute window, not kept forever). Mirrors
   *  `get_dispute_info`. */
  async getDisputeInfo(jobId: bigint): Promise<DecodedDisputeInfo | undefined> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.disputes, u64ToBytes(jobId));
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeDisputeInfo(bytes) : undefined;
  }

  /** Reads `compositions[skillId]` — `undefined` if the id is a primitive skill (never composed)
   *  or doesn't exist. Same "Mapping value ⇒ List(U8)" wire shape as `getSkill`/`getJob`. */
  async getComposition(skillId: bigint): Promise<DecodedComposition | undefined> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.compositions, u64ToBytes(skillId));
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeComposition(bytes) : undefined;
  }

  /** Convenience read: `true` iff `skillId` has a `Composition` record (mirrors the contract's
   *  own `is_composite` entry point, computed off a single dictionary read rather than a second
   *  RPC round-trip). */
  async isComposite(skillId: bigint): Promise<boolean> {
    return (await this.getComposition(skillId)) !== undefined;
  }

  /** Reads `cross_chain_rep[account]` (0-100, or 0 if never attested) directly from the "state"
   *  dictionary — the P0.1 bridge value set via the propose/approve/execute governance lifecycle
   *  (`proposeSetCrossChainRep`/`approveProposal`/`executeProposal` below). */
  async getCrossChainRep(accountHashHex: string): Promise<number> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.crossChainRep, accountAddressToBytes(accountHashHex));
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU32(bytes) : 0;
  }

  /** `attest_rationale(job_id: u64, rationale_hash: Bytes)` (P2-A) — requester-only, set-once.
   *  Commits a hash of the (typically LLM-generated) decision rationale for `jobId` on-chain; see
   *  `contracts-odra/src/agent_skill_registry.rs::attest_rationale`'s own doc comment for why. */
  async attestRationale(
    signer: CasperPrivateKey,
    jobId: bigint,
    rationaleHash: Uint8Array,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    if (rationaleHash.length !== 32) {
      throw new Error(`[casper-live-client] rationale_hash must be 32 bytes, got ${rationaleHash.length}`);
    }
    const args = Args.fromMap({
      job_id: CLValue.newCLUint64(jobId.toString()),
      rationale_hash: bytesToCLList(rationaleHash),
    });
    return this.submit(signer, "attest_rationale", args, paymentMotes);
  }

  /** Reads `rationale_hash[jobId]` directly from the "state" dictionary (field index 25 — the
   *  PATH-encoding branch of `odraMappingDictionaryKey`, not the legacy one every other read here
   *  uses). `undefined` when the requester never called `attestRationale` for this job. */
  async getRationaleHash(jobId: bigint): Promise<string | undefined> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.rationaleHash, u64ToBytes(jobId));
    const raw = odraStructBytes(clValue);
    // `raw` carries `Bytes`'s own bytesrepr framing (u32-LE length prefix + payload) — decodeBytesVec
    // strips it. Confirmed the hard way against a real deployed contract read (see its own doc
    // comment): an earlier version returned the length prefix concatenated onto the hash.
    const bytes = raw ? decodeBytesVec(raw) : undefined;
    return bytes ? Buffer.from(bytes).toString("hex") : undefined;
  }

  // ── P0-B: Governance views ────────────────────────────────────────────────
  // `arbiter`/`governance_signers`/`governance_threshold`/`timelock_delay` are bare `Var<T>`
  // fields (not `Mapping<K, V>`) — `readMapping` still applies: a `Var` read is exactly a
  // `Mapping` read with an empty mapping-key byte string (see `odraMappingDictionaryKey`'s header
  // comment for why). Field indices 17/19/20/21 all exceed the legacy 0-15 range, so
  // `odraMappingDictionaryKey` takes its path-encoding branch for every one of these — confirmed
  // against `odra-core`'s `ContractEnv::index_bytes()` source, not assumed (see that function's
  // own header comment in `odra_storage_key.ts`).

  /** Reads `arbiter` (`Var<Address>`, field index 17) — the contract's current dispute-
   *  arbitration authority (mirrors the `get_arbiter` view entry point; governance-settable via
   *  `proposeSetArbiter`/`approveProposal`/`executeProposal`). `undefined` only if read before
   *  `init()` ever ran — the constructor always sets it to `governance_signers[0]`. */
  async getArbiter(): Promise<CasperAddress | undefined> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.arbiter, EMPTY_VAR_KEY);
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeAddress(bytes) : undefined;
  }

  /** Reads `governance_signers` (`Var<Vec<Address>>`, field index 19) — the full multisig signer
   *  set (mirrors `get_governance_signers`). Empty only if read before `init()` ever ran. */
  async getGovernanceSigners(): Promise<CasperAddress[]> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.governanceSigners, EMPTY_VAR_KEY);
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeAddressList(bytes) : [];
  }

  /** Reads `governance_threshold` (`Var<u32>`, field index 20) — approvals a proposal needs
   *  before `executeProposal` will accept it (mirrors `get_governance_threshold`). */
  async getGovernanceThreshold(): Promise<number> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.governanceThreshold, EMPTY_VAR_KEY);
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU32(bytes) : 0;
  }

  /** Reads `timelock_delay` (`Var<u64>`, field index 21) — milliseconds a proposal must wait,
   *  after reaching threshold approvals, before `executeProposal` will accept it (mirrors
   *  `get_timelock_delay`). */
  async getTimelockDelayMs(): Promise<bigint> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.timelockDelay, EMPTY_VAR_KEY);
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU64(bytes) : 0n;
  }

  /** Reads `arbiter_panel` (`Var<Vec<Address>>`, field index 26, P4-A) — the currently
   *  governance-set N-of-M panel (mirrors `get_arbiter_panel`). Empty until a `SetArbiterPanel`
   *  proposal has executed at least once. */
  async getArbiterPanel(): Promise<CasperAddress[]> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.arbiterPanel, EMPTY_VAR_KEY);
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeAddressList(bytes) : [];
  }

  /** Reads `panel_threshold` (`Var<u32>`, field index 27, P4-A) — votes-for-one-verdict
   *  `cast_panel_vote` needs to settle a panel-mode dispute (mirrors `get_panel_threshold`). */
  async getPanelThreshold(): Promise<number> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.panelThreshold, EMPTY_VAR_KEY);
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU32(bytes) : 0;
  }

  /** Reads `proposals[proposal_id]` (`Mapping<u64, GovernanceProposal>`, field index 23, P0-B) —
   *  a governance proposal's action, proposer, timestamp, and executed/cancelled flags. Mirrors
   *  `get_proposal`. See `decodeGovernanceProposal`'s doc comment: the `action` enum's tag
   *  encoding is not yet chain-verified, unlike the rest of this struct's fields. */
  async getProposal(proposalId: bigint): Promise<DecodedGovernanceProposal | undefined> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.proposals, u64ToBytes(proposalId));
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeGovernanceProposal(bytes) : undefined;
  }

  /** `propose_set_cross_chain_rep(agent: Address, score: u32, source_chain: String) -> u64` —
   *  governance-signer only; the proposer's own approval counts automatically. Same
   *  propose/approve/execute + 48h-timelock lifecycle gates `propose_set_arbiter`/
   *  `propose_set_dispute_bond_bps` below (P0-B: no single-signer immediate-effect path for any
   *  of the three). Returns only the broadcast tx hash — like every other write here, the
   *  resulting `proposal_id` isn't returned over RPC; read `get_cross_chain_rep`/re-derive it from
   *  the `ProposalCreated` event once tooling for that exists. */
  async proposeSetCrossChainRep(
    signer: CasperPrivateKey,
    agentAccountHash: string,
    score: number,
    sourceChain: string,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      agent: addressKeyArg(agentAccountHash),
      score: CLValue.newCLUInt32(score),
      source_chain: CLValue.newCLString(sourceChain),
    });
    return this.submit(signer, "propose_set_cross_chain_rep", args, paymentMotes);
  }

  /** `propose_set_arbiter(new_arbiter: Address) -> u64` — governance-signer only. */
  async proposeSetArbiter(signer: CasperPrivateKey, newArbiterAccountHash: string, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ new_arbiter: addressKeyArg(newArbiterAccountHash) });
    return this.submit(signer, "propose_set_arbiter", args, paymentMotes);
  }

  /** `propose_set_dispute_bond_bps(bps: u32) -> u64` — governance-signer only. */
  async proposeSetDisputeBondBps(signer: CasperPrivateKey, bps: number, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ bps: CLValue.newCLUInt32(bps) });
    return this.submit(signer, "propose_set_dispute_bond_bps", args, paymentMotes);
  }

  /** `approve_proposal(proposal_id)` — governance-signer only; each signer may approve once. */
  async approveProposal(signer: CasperPrivateKey, proposalId: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ proposal_id: CLValue.newCLUint64(proposalId.toString()) });
    return this.submit(signer, "approve_proposal", args, paymentMotes);
  }

  /** `execute_proposal(proposal_id)` — anyone may call once the approval threshold is met AND
   *  the timelock delay has elapsed since the proposal was created. */
  async executeProposal(signer: CasperPrivateKey, proposalId: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ proposal_id: CLValue.newCLUint64(proposalId.toString()) });
    return this.submit(signer, "execute_proposal", args, paymentMotes);
  }

  /** `cancel_proposal(proposal_id)` — governance-signer only; only while pending (not yet
   *  executed or already cancelled). */
  async cancelProposal(signer: CasperPrivateKey, proposalId: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ proposal_id: CLValue.newCLUint64(proposalId.toString()) });
    return this.submit(signer, "cancel_proposal", args, paymentMotes);
  }

  /** Total number of CES events emitted so far (`__events_length`) — a bare named-key `u32`
   *  counter, NOT inside Odra's own `"state"` dictionary (see `odra_events.ts`'s header comment).
   *  **Confirmed against the live deployed contract (2026-07-07)**: this comes back as a native
   *  `CLValue::U32` (`.ui32`), NOT the `List(U8)`-wrapped encoding Odra's own Mapping/Var reads
   *  use — makes sense in hindsight, since CES manages this key entirely outside Odra's storage
   *  abstraction. The `odraStructBytes`/`decodeU32` fallback below is dead code against the
   *  current contract; kept only in case a future CES/Odra version changes this. */
  async getEventCount(): Promise<number> {
    const entityKey = await this.resolveEntityHash();
    const { storedValue } = await this.rpc.queryLatestGlobalState(entityKey, [EVENTS_LENGTH_KEY]);
    const clValue = storedValue.clValue;
    if (clValue?.ui32 !== undefined) return clValue.ui32.toNumber();
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU32(bytes) : 0;
  }

  /** Reads and decodes the event at `eventIndex` (0-based, per CES's own sequential numbering)
   *  into KARMA's chain-agnostic `IndexedEvent` shape — `undefined` for an out-of-range index or
   *  an event type this indexer doesn't act on (see `odra_events.ts`). The `"__events"` dictionary
   *  item key is the plain decimal index string, not a blake2b hash (confirmed in
   *  `casper-event-standard`'s source — `storage::dictionary_put(seed, &lenght.to_string(), …)`). */
  async getEvent(eventIndex: number): Promise<IndexedEvent | undefined> {
    const entityKey = await this.resolveEntityHash();
    const { stateRootHash } = await this.rpc.getStateRootHashLatest();
    const identifier = new ParamDictionaryIdentifier(
      undefined,
      new ParamDictionaryIdentifierContractNamedKey(entityKey, EVENTS_DICT, String(eventIndex)),
    );
    try {
      const result = await this.rpc.getDictionaryItemByIdentifier(stateRootHash.toHex(), identifier);
      const bytes = odraStructBytes(result.storedValue.clValue);
      return bytes ? decodeIndexedEvent(eventIndex, bytes) : undefined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const detail = (e as { sourceErr?: { data?: string } })?.sourceErr?.data;
      if (/not found|ValueNotFound/i.test(msg) || (detail && /not found/i.test(detail))) return undefined;
      throw e;
    }
  }

  /** `this.contractHash` is the *package* hash (stable across upgrades — what
   *  `ContractCallBuilder.byPackageHash()` wants), but the "state" named key holding every
   *  Mapping/Var lives on the package's *entity* (a specific installed version), under a
   *  different hash. Resolved via `query_global_state` on the package and cached — cheap to
   *  recompute per client instance, wrong to assume it never changes across a real upgrade. */
  private entityHash: string | undefined;

  private async resolveEntityHash(): Promise<string> {
    if (this.entityHash) return this.entityHash;
    const packageKey = this.contractHash.startsWith("hash-") ? this.contractHash : `hash-${stripHashPrefix(this.contractHash)}`;
    const { storedValue } = await this.rpc.queryLatestGlobalState(packageKey, []);
    const versions = storedValue.contractPackage?.versions ?? [];
    if (versions.length === 0) {
      throw new Error(`[casper-live-client] no contract versions found for package ${packageKey}`);
    }
    const latest = versions[versions.length - 1];
    this.entityHash = `hash-${latest.contractHash.hash.toHex()}`;
    return this.entityHash;
  }

  /** Shared read path: derive the dictionary-item key, query the contract's "state" dictionary
   *  at the latest state root, and return the stored `CLValue` (undefined ⇒ key not written yet,
   *  the Casper equivalent of Solidity's zero-valued default storage slot). */
  private async readMapping(fieldIndex: number, mappingKeyBytes: Uint8Array): Promise<InstanceType<typeof CLValue> | undefined> {
    const dictionaryItemKey = odraMappingDictionaryKey(fieldIndex, mappingKeyBytes);
    const entityKey = await this.resolveEntityHash();
    const { stateRootHash } = await this.rpc.getStateRootHashLatest();
    const identifier = new ParamDictionaryIdentifier(
      undefined,
      new ParamDictionaryIdentifierContractNamedKey(entityKey, "state", dictionaryItemKey),
    );
    try {
      const result = await this.rpc.getDictionaryItemByIdentifier(stateRootHash.toHex(), identifier);
      return result.storedValue.clValue;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const detail = (e as { sourceErr?: { data?: string } })?.sourceErr?.data;
      if (/not found|ValueNotFound/i.test(msg) || (detail && /not found/i.test(detail))) return undefined;
      throw e;
    }
  }

  private async submit(
    signer: CasperPrivateKey,
    entryPoint: string,
    args: CasperArgs,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const transaction = new ContractCallBuilder()
      .from(signer.publicKey)
      .byPackageHash(stripHashPrefix(this.contractHash))
      .entryPoint(entryPoint)
      .runtimeArgs(args)
      .chainName(this.chainName)
      .payment(Number(paymentMotes ?? this.defaultPaymentMotes))
      .build();
    transaction.sign(signer);
    const result = await this.rpc.putTransaction(transaction);
    return { txHash: result.transactionHash.toHex() };
  }

  /** Calls a "payable" entry point (one that reads `self.env().attached_value()`) via Odra's
   *  proxy-caller session — see the `PROXY_CALLER_WASM_PATH` comment for why a plain
   *  `ContractCallBuilder` call can't attach CSPR. `innerArgs` are the entry point's own
   *  arguments (e.g. empty for `deposit_bond`); `attachedValueMotes` is the CSPR to transfer in,
   *  separate from `paymentMotes` (the gas ceiling, higher than a plain call's default — the
   *  proxy also creates a purse and does two native transfers). */
  private async submitPayable(
    signer: CasperPrivateKey,
    entryPoint: string,
    innerArgs: CasperArgs,
    attachedValueMotes: bigint,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const packageHashBytes = hexToBytes(stripHashPrefix(this.contractHash));
    const proxyArgs = Args.fromMap({
      package_hash: CLValue.newCLByteArray(packageHashBytes),
      entry_point: CLValue.newCLString(entryPoint),
      args: bytesToCLList(innerArgs.toBytes()),
      attached_value: CLValue.newCLUInt512(attachedValueMotes.toString()),
      amount: CLValue.newCLUInt512(attachedValueMotes.toString()),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- module-level constant path, not user input
    const wasmBytes = readFileSync(PROXY_CALLER_WASM_PATH);
    const transaction = new SessionBuilder()
      .from(signer.publicKey)
      .wasm(new Uint8Array(wasmBytes))
      .runtimeArgs(proxyArgs)
      .chainName(this.chainName)
      .payment(Number(paymentMotes ?? PROXY_DEFAULT_PAYMENT_MOTES))
      .build();
    transaction.sign(signer);
    const result = await this.rpc.putTransaction(transaction);
    return { txHash: result.transactionHash.toHex() };
  }
}
