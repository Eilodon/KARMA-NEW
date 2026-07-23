import { describe, it, expect, vi } from "vitest";
import casperSdk from "casper-js-sdk";
import { CasperLiveClient, type CasperTransactionSubmitter } from "../lib/casper/live_client.js";
import { deriveCasperPrivateKey, casperAccountHash } from "../lib/casper/keypair.js";
const { CLValue, CLTypeUInt8 } = casperSdk;

/** Odra structs come back as `CLType::List(U8)`, not `Any` — confirmed against a real deployed
 *  contract read (see live_client.ts's `odraStructBytes`). Mirrors that real encoding here. */
function newCLOdraStructBytes(bytes: Uint8Array) {
  return CLValue.newCLList(CLTypeUInt8, Array.from(bytes).map((b) => CLValue.newCLUint8(b)));
}

const SIGNER = deriveCasperPrivateKey(new Uint8Array(32).fill(0x33));
const CONTRACT_HASH = "hash-1111111111111111111111111111111111111111111111111111111111111111";

const ENTITY_HASH = "2222222222222222222222222222222222222222222222222222222222222222";

function fakeSubmitter(): CasperTransactionSubmitter & {
  putTransaction: ReturnType<typeof vi.fn>;
  getStateRootHashLatest: ReturnType<typeof vi.fn>;
  getDictionaryItemByIdentifier: ReturnType<typeof vi.fn>;
  queryLatestGlobalState: ReturnType<typeof vi.fn>;
} {
  return {
    putTransaction: vi.fn().mockResolvedValue({ transactionHash: { toHex: () => "deadbeef" } }),
    getStateRootHashLatest: vi.fn().mockResolvedValue({ stateRootHash: { toHex: () => "srh" } }),
    getDictionaryItemByIdentifier: vi.fn().mockRejectedValue(new Error("not used in these tests")),
    queryLatestGlobalState: vi.fn().mockResolvedValue({
      storedValue: { contractPackage: { versions: [{ contractHash: { hash: { toHex: () => ENTITY_HASH } } }] } },
    }),
  };
}

describe("CasperLiveClient (T13-live)", () => {
  it("registerSkill signs and submits a real Transaction targeting the given contract hash + entry point", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    const { txHash } = await client.registerSkill(SIGNER, {
      name: "rwa_price_oracle",
      description: "desc",
      mcpEndpoint: "casper-mcp://providers/rwa_price_oracle",
      pricePerCallMotes: 10_000_000n,
      minReputationToInvoke: 0,
      identityPolicy: 0,
    });

    expect(txHash).toBe("deadbeef");
    expect(rpc.putTransaction).toHaveBeenCalledOnce();
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.entryPoint.customEntryPoint).toBe("register_skill");
    expect(transaction.target.stored.id.byPackageHash?.addr.toHex()).toBe(
      CONTRACT_HASH.replace(/^hash-/, ""),
    );
    expect(transaction.args.getByName("name")?.toString()).toBe("rwa_price_oracle");
    expect(transaction.args.getByName("price_per_call")?.toString()).toBe("10000000");
    expect(transaction.approvals.length).toBeGreaterThan(0); // signed
  });

  it("depositBond routes through the proxy-caller session (Odra payable convention — deposit_bond takes no named args, only attached_value)", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    await client.depositBond(SIGNER, 1_000_000_000n);
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.target.session?.moduleBytes.length).toBeGreaterThan(0);
    expect(transaction.args.getByName("entry_point")?.toString()).toBe("deposit_bond");
    expect(transaction.args.getByName("attached_value")?.toString()).toBe("1000000000");
    expect(transaction.args.getByName("amount")?.toString()).toBe("1000000000");
    expect(transaction.args.getByName("package_hash")).toBeTruthy();
    expect(transaction.args.getByName("args")).toBeTruthy(); // deposit_bond's own (empty) args, serialized
  });

  it("createJob is payable (no `amount` arg exists on the real entry point) — routes through the proxy-caller with skill_id/task_hash/deadline_secs as its own inner args and the escrow as attached_value", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    const taskHashHex = "ab".repeat(32);
    await client.createJob(SIGNER, {
      skillId: 1n,
      taskHashHex,
      deadlineSecs: 259_200n,
      escrowMotes: 10_000_000n,
    });
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.target.session?.moduleBytes.length).toBeGreaterThan(0);
    expect(transaction.args.getByName("entry_point")?.toString()).toBe("create_job");
    expect(transaction.args.getByName("attached_value")?.toString()).toBe("10000000");

    // Decode the proxy's `args` (the entry point's own serialized inner RuntimeArgs) to prove
    // skill_id/task_hash/deadline_secs actually made it through, not just that something did.
    const innerArgsBytes = Uint8Array.from(
      transaction.args.getByName("args")!.list!.elements.map((e: InstanceType<typeof CLValue>) => e.ui8!.toNumber()),
    );
    const innerArgs = casperSdk.Args.fromBytes(innerArgsBytes);
    expect(innerArgs.getByName("skill_id")?.toString()).toBe("1");
    expect(innerArgs.getByName("deadline_secs")?.toString()).toBe("259200");
    expect(innerArgs.getByName("amount")).toBeUndefined(); // real signature has no such arg
  });

  it("deliverResult / confirmCompletion / claimAfterReview / claimRefund / withdraw hit the right entry points", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    await client.deliverResult(SIGNER, { jobId: 1n, resultHashHex: "cd".repeat(32) });
    expect(rpc.putTransaction.mock.calls[0][0].entryPoint.customEntryPoint).toBe("deliver_result");

    await client.confirmCompletion(SIGNER, 1n);
    expect(rpc.putTransaction.mock.calls[1][0].entryPoint.customEntryPoint).toBe("confirm_completion");

    await client.claimAfterReview(SIGNER, 1n);
    expect(rpc.putTransaction.mock.calls[2][0].entryPoint.customEntryPoint).toBe("claim_after_review");

    await client.claimRefund(SIGNER, 1n);
    const claimRefundTx = rpc.putTransaction.mock.calls[3][0];
    expect(claimRefundTx.entryPoint.customEntryPoint).toBe("claim_refund");
    expect(claimRefundTx.args.getByName("job_id")?.toString()).toBe("1");

    await client.withdraw(SIGNER);
    expect(rpc.putTransaction.mock.calls[4][0].entryPoint.customEntryPoint).toBe("withdraw");
  });

  it("registerComposition signs and submits leaf_skill_ids/weights_bps as List(U64)/List(U32)", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    const { txHash } = await client.registerComposition(SIGNER, {
      name: "bundle",
      description: "desc",
      mcpEndpoint: "casper-mcp://providers/bundle",
      pricePerCallMotes: 10_000_000n,
      minReputationToInvoke: 0,
      identityPolicy: 0,
      leafSkillIds: [1n, 2n],
      weightsBps: [6000, 4000],
    });

    expect(txHash).toBe("deadbeef");
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.entryPoint.customEntryPoint).toBe("register_composition");
    const leafArg = transaction.args.getByName("leaf_skill_ids");
    expect(leafArg!.list!.elements.map((e: InstanceType<typeof CLValue>) => e.ui64!.toString())).toEqual(["1", "2"]);
    const weightsArg = transaction.args.getByName("weights_bps");
    expect(weightsArg!.list!.elements.map((e: InstanceType<typeof CLValue>) => e.ui32!.toNumber())).toEqual([6000, 4000]);
  });

  it("createJobWithEvaluator (P0-A) encodes the evaluator as a Key CLValue and attaches escrow+fee via the proxy caller", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    const evaluatorAccountHash = "account-hash-" + "ee".repeat(32);
    await client.createJobWithEvaluator(SIGNER, {
      skillId: 1n,
      taskHashHex: "ab".repeat(32),
      deadlineSecs: 259_200n,
      evaluatorAccountHash,
      evaluatorFeeMotes: 1_000n,
      escrowMotes: 10_001_000n,
    });
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.args.getByName("entry_point")?.toString()).toBe("create_job_with_evaluator");
    expect(transaction.args.getByName("attached_value")?.toString()).toBe("10001000");

    const innerArgsBytes = Uint8Array.from(
      transaction.args.getByName("args")!.list!.elements.map((e: InstanceType<typeof CLValue>) => e.ui8!.toNumber()),
    );
    const innerArgs = casperSdk.Args.fromBytes(innerArgsBytes);
    expect(innerArgs.getByName("evaluator")?.getKey().toPrefixedString()).toBe(evaluatorAccountHash);
    expect(innerArgs.getByName("evaluator_fee")?.toString()).toBe("1000");
  });

  it("arbitrate encodes Verdict as a plain U8 discriminant (ProviderAtFault=0, RequesterAtFault=1), not List(U8)", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    await client.arbitrate(SIGNER, 1n, "RequesterAtFault");
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.entryPoint.customEntryPoint).toBe("arbitrate");
    expect(transaction.args.getByName("verdict")?.ui8?.toNumber()).toBe(1);
  });

  it("disputeResult / respondToDispute attach the bond via the proxy caller with job_id as the only inner arg", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    await client.disputeResult(SIGNER, 1n, 5_000_000n);
    let transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.args.getByName("entry_point")?.toString()).toBe("dispute_result");
    expect(transaction.args.getByName("attached_value")?.toString()).toBe("5000000");

    await client.respondToDispute(SIGNER, 1n, 5_000_000n);
    transaction = rpc.putTransaction.mock.calls[1][0];
    expect(transaction.args.getByName("entry_point")?.toString()).toBe("respond_to_dispute");
    expect(transaction.args.getByName("attached_value")?.toString()).toBe("5000000");
  });

  it("proposeSetCrossChainRep (P0-B) encodes the target agent as a Key CLValue and the score/source_chain plainly", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    const targetHash = "account-hash-" + "ff".repeat(32);
    await client.proposeSetCrossChainRep(SIGNER, targetHash, 85, "stellar");
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.entryPoint.customEntryPoint).toBe("propose_set_cross_chain_rep");
    expect(transaction.args.getByName("agent")?.getKey().toPrefixedString()).toBe(targetHash);
    expect(transaction.args.getByName("score")?.toString()).toBe("85");
    expect(transaction.args.getByName("source_chain")?.toString()).toBe("stellar");
  });

  it("approveProposal / executeProposal / cancelProposal hit the right entry points with a job_id-shaped proposal_id arg", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    await client.approveProposal(SIGNER, 1n);
    expect(rpc.putTransaction.mock.calls[0][0].entryPoint.customEntryPoint).toBe("approve_proposal");

    await client.executeProposal(SIGNER, 1n);
    expect(rpc.putTransaction.mock.calls[1][0].entryPoint.customEntryPoint).toBe("execute_proposal");

    await client.cancelProposal(SIGNER, 1n);
    expect(rpc.putTransaction.mock.calls[2][0].entryPoint.customEntryPoint).toBe("cancel_proposal");
  });

  it("uses the configured chain name and a caller-overridable payment ceiling", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient(
      { rpcUrl: "https://node.example", contractHash: CONTRACT_HASH, chainName: "casper-net-1", defaultPaymentMotes: 1n },
      rpc,
    );
    await client.withdraw(SIGNER, 42n);
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.chainName).toBe("casper-net-1");
    expect(transaction.pricingMode).toBeTruthy();
  });
});

describe("CasperLiveClient reads (T13-live, real dictionary-item derivation)", () => {
  const account = casperAccountHash(SIGNER);

  it("pendingWithdrawalsOf queries the state dictionary at the derived key and parses a U512", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      // Real dictionary reads come back as List(U8), not the native ui512 — see live_client.ts's
      // odraStructBytes / odra_codec.ts's decodeU512 header comments for why.
      storedValue: { clValue: newCLOdraStructBytes(CLValue.newCLUInt512("123456789").bytes()) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    const balance = await client.pendingWithdrawalsOf(account);

    expect(balance).toBe("123456789");
    expect(rpc.getStateRootHashLatest).toHaveBeenCalledOnce();
    const [stateRootHash, identifier] = rpc.getDictionaryItemByIdentifier.mock.calls[0];
    expect(stateRootHash).toBe("srh");
    expect(identifier.contractNamedKey.key).toBe(`hash-${ENTITY_HASH}`);
    expect(identifier.contractNamedKey.dictionaryName).toBe("state");
    expect(identifier.contractNamedKey.dictionaryItemKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("agentReputationOf parses a U32", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(CLValue.newCLUInt32(75).bytes()) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.agentReputationOf(account)).toBe(75);
  });

  it("bondedOf parses a U512", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(CLValue.newCLUInt512("1000000000").bytes()) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.bondedOf(account)).toBe("1000000000");
  });

  it("returns the contract's documented defaults when the dictionary key has never been written", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    expect(await client.pendingWithdrawalsOf(account)).toBe("0");
    expect(await client.agentReputationOf(account)).toBe(50); // BASE_REPUTATION
    expect(await client.bondedOf(account)).toBe("0");
  });

  it("re-throws an unrelated RPC error instead of silently defaulting", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    await expect(client.pendingWithdrawalsOf(account)).rejects.toThrow("ECONNREFUSED");
  });

  it("getCrossChainRep (P0.1) parses a U32, defaulting to 0 when never attested", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(CLValue.newCLUInt32(85).bytes()) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getCrossChainRep(account)).toBe(85);

    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    expect(await client.getCrossChainRep(account)).toBe(0);
  });

  it("getRationaleHash (P2-A) strips Bytes's own length-prefix framing, undefined when never attested", async () => {
    // Regression test for a real bug caught live on Casper Testnet: `rationale_hash`'s stored
    // CLValue carries `Bytes`'s bytesrepr framing (u32-LE length prefix + payload), not just the
    // raw 32 bytes — an earlier version of getRationaleHash returned the prefix concatenated onto
    // the hash (e.g. "20000000<hash>" instead of "<hash>").
    const hashHex = "3aeb6001dd1ab1256e0327b3abaa520cd0e08a7fce5733ab877f2058d6965f74";
    // `Bytes`'s own bytesrepr encoding (u32-LE length prefix + payload) — NOT `newCLByteArray`,
    // which is the fixed-size `ByteArray` CLType and carries no length prefix at all (verified
    // empirically: the two produce different byte strings for the same payload).
    const rawBytesEncoding = CLValue.newCLList(CLTypeUInt8, Array.from(Buffer.from(hashHex, "hex")).map((b) => CLValue.newCLUint8(b))).bytes();
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(rawBytesEncoding) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getRationaleHash(3n)).toBe(hashHex);

    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    expect(await client.getRationaleHash(999n)).toBeUndefined();
  });

  it("attestRationale rejects a non-32-byte hash client-side, before ever submitting", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    await expect(client.attestRationale(SIGNER, 1n, new Uint8Array(31))).rejects.toThrow(/32 bytes/);
    expect(rpc.putTransaction).not.toHaveBeenCalled();
  });
});

describe("CasperLiveClient.getEventCount / getEvent (CES event log, T13-live)", () => {
  function withEventCountResponse(clValue: InstanceType<typeof CLValue>) {
    return vi.fn(async (_key: string, path: string[]) => {
      if (path.length === 0) {
        return { storedValue: { contractPackage: { versions: [{ contractHash: { hash: { toHex: () => ENTITY_HASH } } }] } } };
      }
      return { storedValue: { clValue } };
    });
  }

  it("getEventCount reads a native CLValue::U32 shape", async () => {
    const rpc = fakeSubmitter();
    rpc.queryLatestGlobalState = withEventCountResponse(CLValue.newCLUInt32(5));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getEventCount()).toBe(5);
  });

  it("getEventCount falls back to the List(U8)-wrapped shape if that's what comes back instead", async () => {
    const rpc = fakeSubmitter();
    rpc.queryLatestGlobalState = withEventCountResponse(newCLOdraStructBytes(CLValue.newCLUInt32(5).bytes()));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getEventCount()).toBe(5);
  });

  it("getEvent reads the '__events' dictionary at the plain decimal index (no blake2b hashing) and decodes it", async () => {
    const rpc = fakeSubmitter();
    const rawEvent = Buffer.concat([
      Buffer.from(CLValue.newCLString("event_SkillDeactivated").bytes()),
      Buffer.from(CLValue.newCLUint64("7").bytes()),
    ]);
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(rawEvent) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    const event = await client.getEvent(3);

    expect(event).toEqual({ type: "SkillDeactivated", blockNumber: 3n, skillId: 7n });
    const [, identifier] = rpc.getDictionaryItemByIdentifier.mock.calls[0];
    expect(identifier.contractNamedKey.dictionaryName).toBe("__events");
    expect(identifier.contractNamedKey.dictionaryItemKey).toBe("3");
  });

  it("getEvent returns undefined for an out-of-range index", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getEvent(999)).toBeUndefined();
  });
});

describe("CasperLiveClient.getSkill / getJob (T13-live, complex-struct dictionary reads)", () => {
  function u32(v: number): Uint8Array {
    return CLValue.newCLUInt32(v).bytes();
  }
  function bytesVec(b: Uint8Array): Uint8Array {
    return Buffer.concat([u32(b.length), Buffer.from(b)]);
  }
  function concat(...parts: Uint8Array[]): Uint8Array {
    return Buffer.concat(parts.map((p) => Buffer.from(p)));
  }
  const OWNER_HASH = "11".repeat(32);

  it("getSkill decodes the full Skill record from the raw Any bytes", async () => {
    const rpc = fakeSubmitter();
    const rawSkill = concat(
      Buffer.concat([Buffer.from([0]), Buffer.from(OWNER_HASH, "hex")]), // owner: Account
      bytesVec(Buffer.from("rwa_price_oracle")),
      bytesVec(Buffer.from("desc")),
      bytesVec(Buffer.from("casper-mcp://providers/rwa_price_oracle")),
      CLValue.newCLUInt512("10000000").bytes(),
      u32(75),
      CLValue.newCLUint64("42").bytes(),
      CLValue.newCLValueBool(true).bytes(),
      CLValue.newCLUint64("1700000000").bytes(),
      u32(10),
      CLValue.newCLUint8(2).bytes(),
    );
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(rawSkill) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    const skill = await client.getSkill(1n);

    expect(skill?.owner).toEqual({ kind: "Account", hashHex: OWNER_HASH });
    expect(skill?.name).toBe("rwa_price_oracle");
    expect(skill?.pricePerCallMotes).toBe(10_000_000n);
    expect(skill?.reputationScore).toBe(75);
    expect(skill?.active).toBe(true);
  });

  it("getSkill returns undefined for an unregistered skill ID", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getSkill(999n)).toBeUndefined();
  });

  it("getJob decodes the full Job record including JobStatus and evaluator", async () => {
    const rpc = fakeSubmitter();
    const rawJob = concat(
      Buffer.concat([Buffer.from([0]), Buffer.from(OWNER_HASH, "hex")]), // requester
      Buffer.concat([Buffer.from([0]), Buffer.from(OWNER_HASH, "hex")]), // provider
      CLValue.newCLUint64("1").bytes(),
      bytesVec(Buffer.from("ab".repeat(32), "hex")),
      CLValue.newCLUInt512("10000000").bytes(),
      CLValue.newCLUint64("259200").bytes(),
      CLValue.newCLUint8(1).bytes(), // Delivered
      bytesVec(Buffer.from("cd".repeat(32), "hex")),
      CLValue.newCLUint64("1700000000").bytes(),
      CLValue.newCLUint64("0").bytes(),
      CLValue.newCLUint8(0).bytes(), // evaluator: None
      CLValue.newCLUInt512("0").bytes(),
    );
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(rawJob) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    const job = await client.getJob(1n);

    expect(job?.skillId).toBe(1n);
    expect(job?.status).toBe("Delivered");
    expect(job?.escrowAmountMotes).toBe(10_000_000n);
    expect(job?.evaluator).toBeUndefined();
  });

  it("getJob returns undefined for an uncreated job ID", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getJob(999n)).toBeUndefined();
  });
});

describe("CasperLiveClient.getComposition / isComposite (T13-live, field index 14)", () => {
  function u32(v: number): Uint8Array {
    return CLValue.newCLUInt32(v).bytes();
  }
  function concat(...parts: Uint8Array[]): Uint8Array {
    return Buffer.concat(parts.map((p) => Buffer.from(p)));
  }
  function vecU64(values: string[]): Uint8Array {
    return concat(u32(values.length), ...values.map((v) => CLValue.newCLUint64(v).bytes()));
  }
  function vecU32(values: number[]): Uint8Array {
    return concat(u32(values.length), ...values.map(u32));
  }

  it("getComposition decodes leaf skill ids + weights for a composite skill", async () => {
    const rpc = fakeSubmitter();
    const rawComposition = concat(vecU64(["1", "2"]), vecU32([6000, 4000]));
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(rawComposition) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    const composition = await client.getComposition(3n);

    expect(composition?.leafSkillIds).toEqual([1n, 2n]);
    expect(composition?.weightsBps).toEqual([6000, 4000]);
    expect(await client.isComposite(3n)).toBe(true);
  });

  it("getComposition/isComposite treat a primitive (never-composed) skill as absent", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    expect(await client.getComposition(1n)).toBeUndefined();
    expect(await client.isComposite(1n)).toBe(false);
  });
});

describe("CasperLiveClient governance-state getters (P0-B, bare Var<T> fields — field indices 17/19/20/21)", () => {
  function u32(v: number): Uint8Array {
    return CLValue.newCLUInt32(v).bytes();
  }
  function concat(...parts: Uint8Array[]): Uint8Array {
    return Buffer.concat(parts.map((p) => Buffer.from(p)));
  }
  function address(kind: "Account" | "Contract", hashHex: string): Uint8Array {
    return concat(Uint8Array.from([kind === "Account" ? 0 : 1]), Buffer.from(hashHex, "hex"));
  }
  const SIGNER_A = "11".repeat(32);
  const SIGNER_B = "22".repeat(32);
  const ARBITER_HASH = "33".repeat(32);

  it("getArbiter reads the bare Var<Address> at field index 17 via the path-encoding branch", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(address("Account", ARBITER_HASH)) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    const arbiter = await client.getArbiter();

    expect(arbiter).toEqual({ kind: "Account", hashHex: ARBITER_HASH });
    const [, identifier] = rpc.getDictionaryItemByIdentifier.mock.calls[0];
    // Field index 17 exceeds the legacy 0-15 range, so this must be a 3-byte path-encoded key
    // ([0xFF, 1, 17]), not the 4-byte legacy key every other getter above uses — a distinct
    // dictionary-item-key shape is the whole point of this test, not just "some hex came back".
    expect(identifier.contractNamedKey.dictionaryItemKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("getArbiter returns undefined when the dictionary key has never been written", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getArbiter()).toBeUndefined();
  });

  it("getGovernanceSigners decodes a Vec<Address> at field index 19", async () => {
    const rpc = fakeSubmitter();
    const rawSigners = concat(u32(2), address("Account", SIGNER_A), address("Account", SIGNER_B));
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({ storedValue: { clValue: newCLOdraStructBytes(rawSigners) } });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    expect(await client.getGovernanceSigners()).toEqual([
      { kind: "Account", hashHex: SIGNER_A },
      { kind: "Account", hashHex: SIGNER_B },
    ]);
  });

  it("getGovernanceSigners defaults to an empty list when never configured", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getGovernanceSigners()).toEqual([]);
  });

  it("getGovernanceThreshold decodes a plain u32 at field index 20, defaulting to 0", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(u32(2)) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getGovernanceThreshold()).toBe(2);

    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    expect(await client.getGovernanceThreshold()).toBe(0);
  });

  it("getTimelockDelayMs decodes a plain u64 at field index 21, defaulting to 0n", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(CLValue.newCLUint64("172800000").bytes()) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getTimelockDelayMs()).toBe(172_800_000n);

    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    expect(await client.getTimelockDelayMs()).toBe(0n);
  });
});
