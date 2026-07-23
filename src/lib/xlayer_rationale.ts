import type { Account, Address } from "viem";
import { rationaleAttestationAbi } from "./abi.js";
import { getPublicClient, getWalletClient } from "./xlayer.js";
import { runBoundedWrite, type WriteOutcome } from "./contract.js";

/**
 * X Layer read/write surface for RationaleAttestation.sol — the P2-A sidecar contract deployed
 * next to AgentSkillRegistry (see contracts/RationaleAttestation.sol for why it's a separate
 * contract/address rather than a change to the live registry). Shares xlayer.ts's public/wallet
 * client singletons — same chain, same RPC — but reads a distinct env var for its own address
 * since it's a distinct deployment.
 */

/** Deployed RationaleAttestation address on X Layer from env; throws if not yet deployed. */
export function getRationaleAttestationAddress(): `0x${string}` {
  const addr = process.env.XLAYER_RATIONALE_ATTESTATION_ADDRESS;
  if (!addr) {
    throw new Error(
      "[KARMA] XLAYER_RATIONALE_ATTESTATION_ADDRESS not set — deploy RationaleAttestation to X " +
        "Layer first (forge create contracts/RationaleAttestation.sol:RationaleAttestation " +
        "--constructor-args $XLAYER_CONTRACT_ADDRESS).",
    );
  }
  return addr as `0x${string}`;
}

function read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return getPublicClient().readContract({
    address: getRationaleAttestationAddress(),
    abi: rationaleAttestationAbi,
    functionName,
    args,
  } as never) as Promise<T>;
}

const RECEIPT_TIMEOUT_MS = 300_000;

/** Bounded write against RationaleAttestation — same broadcast-once/receipt-timeout policy as
 *  xlayer.ts's writeContractBounded (runBoundedWrite, shared so the two contracts can't drift
 *  on retry/idempotency semantics). */
export async function writeRationaleAttestationBounded(
  account: Account,
  call: { functionName: string; args: readonly unknown[] },
  timeoutMs: number = RECEIPT_TIMEOUT_MS,
): Promise<WriteOutcome> {
  const publicClient = getPublicClient();
  const walletClient = getWalletClient(account);
  const address = getRationaleAttestationAddress();
  return runBoundedWrite(
    {
      simulate: async () => {
        const { request } = await publicClient.simulateContract({
          address,
          abi: rationaleAttestationAbi,
          functionName: call.functionName,
          args: call.args,
          account,
        } as never);
        return { request };
      },
      write: (request) => walletClient.writeContract(request as never),
      waitReceipt: (hash, t) => publicClient.waitForTransactionReceipt({ hash, timeout: t }),
    },
    timeoutMs,
  );
}

export function attestRationale(
  account: Account,
  p: { jobId: bigint; rationaleHash: `0x${string}` },
): Promise<WriteOutcome> {
  return writeRationaleAttestationBounded(account, {
    functionName: "attestRationale",
    args: [p.jobId, p.rationaleHash],
  });
}

export function getRationaleHash(jobId: bigint): Promise<`0x${string}`> {
  return read<`0x${string}`>("getRationaleHash", [jobId]);
}

export const xLayerRationaleReads = {
  getRationaleHash,
  getRegistry: (): Promise<Address> => read("registry", []),
};
