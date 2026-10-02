import { keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const DEFAULT_MAINNET_BUILDERS = [
  'https://relay.flashbots.net',
  'https://rpc.titanbuilder.xyz',
  'https://rpc.beaverbuild.org',
  'https://rsync-builder.xyz',
];

export type MevBundleParams = {
  /** Signed raw transaction hex strings (optional target mempool tx followed by searcher signed tx) */
  txs: Hex[];
  /** Target block number for inclusion */
  targetBlockNumber: bigint;
  /** Optional minimum block timestamp */
  minTimestamp?: number;
  /** Optional maximum block timestamp */
  maxTimestamp?: number;
  /** Optional list of tx hashes allowed to revert inside the bundle */
  revertingTxHashes?: Hex[];
};

export type MevBundleRelayResult = {
  relayUrl: string;
  accepted: boolean;
  bundleHash?: string;
  error?: string;
};

export type MevBundleSubmissionSummary = {
  targetBlockHex: Hex;
  relaysAttempted: number;
  relaysAccepted: number;
  bundleHashes: string[];
  results: MevBundleRelayResult[];
};

export function formatBlockNumberHex(blockNumber: bigint): Hex {
  return `0x${blockNumber.toString(16)}` as Hex;
}

/**
 * Generates the official EIP-191 `X-Flashbots-Signature` header (`<address>:<signature>`)
 * over the `keccak256` hash of the JSON-RPC body string.
 */
export async function buildFlashbotsSignatureHeader(
  authPrivateKey: Hex,
  rawJsonBody: string,
): Promise<{ signerAddress: Hex; headerValue: string }> {
  const account = privateKeyToAccount(authPrivateKey);
  const bodyHash = keccak256(stringToHex(rawJsonBody));
  const signature = await account.signMessage({ message: bodyHash });
  return {
    signerAddress: account.address,
    headerValue: `${account.address}:${signature}`,
  };
}

export function resolveMevBundleRelays(chainKey: string): string[] {
  const customEnv = process.env.MEV_BUNDLE_RELAYS;
  if (customEnv && customEnv.trim().length > 0) {
    return customEnv
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
  }
  if (chainKey === 'ethereum') {
    return DEFAULT_MAINNET_BUILDERS;
  }
  return [];
}

export function buildMevBundleRpcPayload(
  method: 'eth_sendBundle' | 'eth_callBundle',
  params: MevBundleParams,
): string {
  const bundleObj: Record<string, unknown> = {
    txs: params.txs,
    blockNumber: formatBlockNumberHex(params.targetBlockNumber),
  };
  if (params.minTimestamp !== undefined) bundleObj.minTimestamp = params.minTimestamp;
  if (params.maxTimestamp !== undefined) bundleObj.maxTimestamp = params.maxTimestamp;
  if (params.revertingTxHashes && params.revertingTxHashes.length > 0) {
    bundleObj.revertingTxHashes = params.revertingTxHashes;
  }
  if (method === 'eth_callBundle') {
    bundleObj.stateBlockNumber = 'latest';
  }

  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: [bundleObj],
  });
}

/**
 * Submits an atomic transaction bundle (`eth_sendBundle`) to Flashbots, Titan, Beaverbuild,
 * and/or custom MEV relays concurrently. If the bundle does not land or reverts, it costs 0 gas.
 */
export async function submitMevBundleToRelays(params: {
  chainKey: string;
  authPrivateKey: Hex;
  bundle: MevBundleParams;
  relayUrls?: string[];
  timeoutMs?: number;
}): Promise<MevBundleSubmissionSummary> {
  const {
    chainKey,
    authPrivateKey,
    bundle,
    relayUrls = resolveMevBundleRelays(chainKey),
    timeoutMs = 6_000,
  } = params;

  const targetBlockHex = formatBlockNumberHex(bundle.targetBlockNumber);
  if (relayUrls.length === 0 || bundle.txs.length === 0) {
    return {
      targetBlockHex,
      relaysAttempted: 0,
      relaysAccepted: 0,
      bundleHashes: [],
      results: [],
    };
  }

  const rawBody = buildMevBundleRpcPayload('eth_sendBundle', bundle);
  const { headerValue } = await buildFlashbotsSignatureHeader(authPrivateKey, rawBody);

  const results = await Promise.all(
    relayUrls.map(async (relayUrl): Promise<MevBundleRelayResult> => {
      try {
        const res = await fetch(relayUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Flashbots-Signature': headerValue,
          },
          body: rawBody,
          signal: AbortSignal.timeout(timeoutMs),
        });

        const parsed = (await res.json().catch(() => ({}))) as {
          result?: { bundleHash?: string } | string;
          error?: { message?: string };
        };

        if (!res.ok || parsed.error) {
          return {
            relayUrl,
            accepted: false,
            error: parsed.error?.message ?? `HTTP ${res.status}`,
          };
        }

        const bundleHash =
          typeof parsed.result === 'string'
            ? parsed.result
            : parsed.result?.bundleHash;

        return {
          relayUrl,
          accepted: true,
          bundleHash,
        };
      } catch (err) {
        return {
          relayUrl,
          accepted: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const accepted = results.filter((r) => r.accepted);
  const bundleHashes = [
    ...new Set(accepted.map((r) => r.bundleHash).filter((h): h is string => Boolean(h))),
  ];

  return {
    targetBlockHex,
    relaysAttempted: results.length,
    relaysAccepted: accepted.length,
    bundleHashes,
    results,
  };
}
