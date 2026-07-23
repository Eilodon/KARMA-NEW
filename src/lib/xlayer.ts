import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  getAddress,
  type Account,
  type Address,
} from "viem";
import { agentSkillRegistryAbi } from "./abi.js";
import { runBoundedWrite, type WriteOutcome } from "./contract.js";

/**
 * X Layer (OKX's EVM L2) viem clients for the AgentSkillRegistry — the fourth chain adapter,
 * built for the OKX.AI Genesis Hackathon. Same contract, same ABI, same `IPaymentPlugin`/
 * `KarmaService` shape as Pharos (src/lib/contract.ts) — this file only differs in network
 * config, deliberately kept separate rather than parameterizing contract.ts (matches the
 * existing per-chain-file convention: src/lib/casper/, src/lib/stellar/, this file).
 *
 * Network info (chainlist.org/chain/196, web3.okx.com/xlayer/docs): mainnet chainId 196,
 * testnet chainId 1952. Gas token is OKB; the Agentic Wallet sponsors gas on X Layer for
 * agent-initiated calls, but a self-funded deployer key still needs testnet OKB to deploy
 * AgentSkillRegistry itself (see script/deploy_xlayer.sh).
 */

const RPC_URL = process.env.XLAYER_RPC_URL ?? "https://testrpc.xlayer.tech";
const CHAIN_ID = Number(process.env.XLAYER_CHAIN_ID ?? 1952);
const POLL_INTERVAL_MS = process.env.XLAYER_POLL_INTERVAL_MS
  ? Number(process.env.XLAYER_POLL_INTERVAL_MS)
  : undefined;

export const xLayer = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 196 ? "X Layer" : "X Layer Testnet",
  nativeCurrency: { decimals: 18, name: "OKB", symbol: "OKB" },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const transport = http(RPC_URL, { batch: { batchSize: 100 } });

function makePublicClient() {
  return createPublicClient({ chain: xLayer, transport, pollingInterval: POLL_INTERVAL_MS });
}

let _publicClient: ReturnType<typeof makePublicClient> | undefined;
/** Shared read client (singleton — safe only in-process, matches contract.ts's D-1 convention). */
export function getPublicClient() {
  if (!_publicClient) _publicClient = makePublicClient();
  return _publicClient;
}

export function getWalletClient(account: Account) {
  return createWalletClient({ account, chain: xLayer, transport, pollingInterval: POLL_INTERVAL_MS });
}

/** Deployed AgentSkillRegistry address on X Layer from env; throws if not yet deployed. */
export function getContractAddress(): `0x${string}` {
  const addr = process.env.XLAYER_CONTRACT_ADDRESS;
  if (!addr) {
    throw new Error(
      "[KARMA] XLAYER_CONTRACT_ADDRESS not set — deploy AgentSkillRegistry to X Layer first (script/deploy_xlayer.sh).",
    );
  }
  return getAddress(addr);
}

const RECEIPT_TIMEOUT_MS = 300_000;

function read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return getPublicClient().readContract({
    address: getContractAddress(),
    abi: agentSkillRegistryAbi,
    functionName,
    args,
  } as never) as Promise<T>;
}

/** Bounded write against the X Layer AgentSkillRegistry — same broadcast-once/receipt-timeout
 *  policy as Pharos (`runBoundedWrite`, imported from contract.ts so the two chains can't drift
 *  on retry/idempotency semantics). */
export async function writeContractBounded(
  account: Account,
  call: { functionName: string; args: readonly unknown[]; value?: bigint },
  timeoutMs: number = RECEIPT_TIMEOUT_MS,
): Promise<WriteOutcome> {
  const publicClient = getPublicClient();
  const walletClient = getWalletClient(account);
  const address = getContractAddress();
  return runBoundedWrite(
    {
      simulate: async () => {
        const { request } = await publicClient.simulateContract({
          address,
          abi: agentSkillRegistryAbi,
          functionName: call.functionName,
          args: call.args,
          value: call.value,
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

/**
 * Narrow read surface the cross-chain Trust Oracle tool (src/plugins/trust_oracle.tool.ts) needs
 * from X Layer. Deliberately not the full `KarmaService` interface (src/lib/karma_service.ts) —
 * this ASP's product is reputation/dispute lookups, not a second full skill-registry MCP surface;
 * `registerSkill` + `setCrossChainRep` are the only writes, used once to list the Trust Oracle
 * itself on-chain and to attest aggregated cross-chain scores back to X Layer.
 */
export const xLayerReads = {
  getAgentReputation: async (addr: Address): Promise<number> => Number(await read<bigint>("agentReputation", [addr])),
  getCrossChainRep: (addr: Address): Promise<bigint> => read("crossChainRep", [addr]),
  getAgentSkills: (addr: Address): Promise<readonly bigint[]> => read("getAgentSkills", [addr]),
  getProviderJobs: (addr: Address): Promise<readonly bigint[]> => read("getProviderJobs", [addr]),
  getRequesterJobs: (addr: Address): Promise<readonly bigint[]> => read("getRequesterJobs", [addr]),
  getDisputeInfo: async (
    jobId: bigint,
  ): Promise<{ disputeBond: bigint; providerBond: bigint; disputedAt: bigint }> => {
    const t = await read<readonly [bigint, bigint, bigint]>("disputes", [jobId]);
    return { disputeBond: t[0], providerBond: t[1], disputedAt: t[2] };
  },
  getOwner: (): Promise<Address> => read("owner", []),
};

export function registerSkill(
  account: Account,
  p: {
    name: string;
    description: string;
    mcpEndpoint: string;
    pricePerCall: bigint;
    minReputationToInvoke: bigint;
    identityPolicy: number;
  },
): Promise<WriteOutcome> {
  return writeContractBounded(account, {
    functionName: "registerSkill",
    args: [p.name, p.description, p.mcpEndpoint, p.pricePerCall, p.minReputationToInvoke, p.identityPolicy],
  });
}

/** Owner-only: attest an aggregated cross-chain reputation score back onto X Layer (P0-B path,
 *  same event `CrossChainRepUpdated` the Pharos deployment already emits). */
export function setCrossChainRep(
  account: Account,
  p: { agent: Address; score: bigint; sourceChain: string },
): Promise<WriteOutcome> {
  return writeContractBounded(account, {
    functionName: "setCrossChainRep",
    args: [p.agent, p.score, p.sourceChain],
  });
}
