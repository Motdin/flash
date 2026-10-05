import { keccak256, stringToHex, type Hash, type Hex } from 'viem';
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

export function resolveBundleAuthKey(raw: string | undefined, fallback: Hex): Hex {
  const value = raw?.trim() || fallback;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid FLASHBOTS_AUTH_KEY');
  privateKeyToAccount(value as Hex); // reject zero/out-of-range scalar too
  return value as Hex;
}

export function resolveMevBundleRelays(chainKey: string): string[] {
  const customEnv = process.env[`${chainKey.toUpperCase()}_MEV_BUNDLE_RELAYS`]
    ?? (chainKey === 'ethereum' ? process.env.MEV_BUNDLE_RELAYS : undefined);
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

        if (typeof bundleHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(bundleHash)) {
          return { relayUrl, accepted: false, error: 'Invalid JSON-RPC bundle result (acceptance unknown)' };
        }
        return { relayUrl, accepted: true, bundleHash };
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

/**
 * The hash of the transaction carried inside the bundle.
 *
 * A signed transaction's hash is, by definition, `keccak256` over its encoded bytes — for a
 * typed (EIP-1559) transaction that encoding is `0x02 || rlp(...)`, which is exactly what
 * `walletClient.signTransaction()` returns and what gets submitted to the relay. Watching this
 * hash is therefore the only way to learn whether the *bundled* transaction landed, without
 * re-broadcasting anything to the public mempool.
 */
export function bundleTxHash(signedRawTransaction: Hex): Hash {
  return keccak256(signedRawTransaction);
}

/**
 * Whether a bundle outcome is worth waiting on instead of falling back to a public broadcast.
 *
 * `relaysAttempted === 0` means the chain has no known builder relay (`resolveMevBundleRelays`),
 * and `relaysAccepted === 0` means every relay rejected the submission; in both cases there is
 * nothing to wait for and the caller must keep the previous public path.
 */
export function shouldWaitForBundle(params: {
  bundleEnabled: boolean;
  relaysAttempted: number;
  relaysAccepted: number;
}): boolean {
  return params.bundleEnabled && params.relaysAccepted > 0;
}

export type BundleInclusionStatus = 'not-checked' | 'included-success' | 'included-reverted' | 'missed' | 'unknown';

export type BundleBroadcastAction = 'public-broadcast' | 'bundle-only' | 'abstain-zero-gas';

export type BundleBroadcastDecision = {
  action: BundleBroadcastAction;
  /** Only a real on-chain revert may count as a failure; a missed bundle cost 0 gas. */
  countAsFailure: boolean;
  reason: string;
};

/**
 * Single source of truth for what to do once a bundle has been submitted.
 *
 * The critical property is `abstain-zero-gas`: when the bundle was accepted by a relay but the
 * builder did not include it, re-broadcasting the same transaction publicly is both a leak of
 * the private route and a duplicate that can never be mined (its nonce was consumed only if the
 * bundle landed). Treating that miss as a failure would also let the watcher's circuit breaker
 * disable `autoBroadcast` after `MAX_CONSECUTIVE_FAILURES` *profitable* no-ops.
 */
export function resolveBundleBroadcastDecision(params: {
  bundleEnabled: boolean;
  relaysAttempted: number;
  relaysAccepted: number;
  inclusion: BundleInclusionStatus;
}): BundleBroadcastDecision {
  if (!params.bundleEnabled) {
    return { action: 'public-broadcast', countAsFailure: false, reason: 'MEV bundle tidak aktif' };
  }
  if (params.relaysAttempted === 0) {
    return {
      action: 'public-broadcast',
      countAsFailure: false,
      reason: 'tidak ada builder relay untuk chain ini; private RPC tetap dipakai bila dikonfigurasi',
    };
  }
  if (params.relaysAccepted === 0) {
    return {
      action: 'public-broadcast',
      countAsFailure: false,
      reason: 'semua relay menolak bundle, fallback ke broadcast publik',
    };
  }
  switch (params.inclusion) {
    case 'included-success':
      return { action: 'bundle-only', countAsFailure: false, reason: 'bundle masuk blok target' };
    case 'included-reverted':
      return {
        action: 'bundle-only',
        countAsFailure: true,
        reason: 'transaksi dalam bundle revert on-chain',
      };
    case 'missed':
      return {
        action: 'abstain-zero-gas',
        countAsFailure: false,
        reason: 'builder tidak memasukkan bundle ke blok target (0 gas terpakai)',
      };
    default:
      return {
        action: 'bundle-only',
        countAsFailure: false,
        reason: 'bundle diterima relay, status inklusi belum diperiksa',
      };
  }
}

export type BundleReceiptLite = {
  blockNumber: bigint;
  status: 'success' | 'reverted';
};

export type BundleInclusionResult =
  | { status: 'included-success' | 'included-reverted'; receipt: BundleReceiptLite; polls: number }
  | { status: 'missed'; lastSeenBlockNumber: bigint; polls: number }
  | { status: 'unknown'; lastSeenBlockNumber: bigint; polls: number };

/**
 * Waits for the bundled transaction to be mined, bounded by blocks rather than a fixed
 * wall-clock timeout.
 *
 * `waitForTransactionReceipt()` would block for ~180s when the bundle misses, stalling the watch
 * loop for minutes on a transaction that can no longer be mined. Here the deadline is
 * `targetBlockNumber + maxBlocks`, so a miss is detected within a couple of block times. Every
 * dependency is injected, which keeps this testable without a node and makes receipt-lookup
 * errors (a lagging RPC replica) non-fatal: they simply cost one more poll.
 */
export async function awaitBundleInclusion(params: {
  txHash: Hash;
  targetBlockNumber: bigint;
  maxBlocks?: number;
  pollIntervalMs?: number;
  getReceipt: (txHash: Hash) => Promise<BundleReceiptLite | null>;
  getBlockNumber: () => Promise<bigint>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BundleInclusionResult> {
  const maxBlocks = Math.max(1, Math.trunc(params.maxBlocks ?? 4));
  const pollIntervalMs = params.pollIntervalMs ?? 1_000;
  const sleep =
    params.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const deadlineBlock = params.targetBlockNumber + BigInt(maxBlocks);
  // Safety net so a node whose block number never advances cannot spin forever.
  const maxPolls = maxBlocks * Math.max(1, Math.ceil(15_000 / pollIntervalMs));
  let lastSeenBlockNumber = 0n;

  for (let poll = 1; poll <= maxPolls; poll++) {
    lastSeenBlockNumber = await params.getBlockNumber().catch(() => lastSeenBlockNumber);
    let receiptReadFailed = false;
    const receipt = await params.getReceipt(params.txHash).catch(() => { receiptReadFailed = true; return null; });
    if (receipt) {
      return {
        status: receipt.status === 'success' ? 'included-success' : 'included-reverted',
        receipt,
        polls: poll,
      };
    }
    if (lastSeenBlockNumber >= deadlineBlock) {
      return { status: receiptReadFailed ? 'unknown' : 'missed', lastSeenBlockNumber, polls: poll };
    }
    if (poll < maxPolls) await sleep(pollIntervalMs);
  }

  return { status: 'unknown', lastSeenBlockNumber, polls: maxPolls };
}
