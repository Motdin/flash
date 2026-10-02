import { createPublicClient, parseAbiItem, webSocket } from 'viem';
import type { EvmChainConfig } from '../config/chains.js';
import type { Address } from '../config/registry.js';

const CHAIN_WSS_ENV_KEYS: Record<string, string[]> = {
  ethereum: ['ETH_WSS_URL', 'ETHEREUM_WSS_URL'],
  base: ['BASE_FLASHBLOCKS_WSS_URL', 'BASE_WSS_URL'],
  arbitrum: ['ARB_WSS_URL', 'ARBITRUM_WSS_URL'],
  optimism: ['OP_WSS_URL', 'OPTIMISM_WSS_URL'],
};

const MORPHO_BLUE_SINGLETON = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;

const morphoBorrowEvent = parseAbiItem(
  'event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)',
);

export type ChainWsStatus = {
  chain: string;
  wssUrlConfigured: boolean;
  connected: boolean;
  isFlashblocks: boolean;
  blocksReceived: number;
  eventsReceived: number;
  lastBlockNumber?: string;
  lastEventAt?: string;
  lastError?: string;
};

export type WsBlockListenerHandle = {
  stop: () => void;
  getStatuses: () => Record<string, ChainWsStatus>;
};

export function resolveChainWssUrl(chainKey: string): {
  wssUrl?: string;
  isFlashblocks: boolean;
} {
  const keys = CHAIN_WSS_ENV_KEYS[chainKey] ?? [`${chainKey.toUpperCase()}_WSS_URL`];
  for (const envKey of keys) {
    const val = process.env[envKey]?.trim();
    if (val && (val.startsWith('wss://') || val.startsWith('ws://'))) {
      return {
        wssUrl: val,
        isFlashblocks: envKey === 'BASE_FLASHBLOCKS_WSS_URL' || val.includes('flashblocks'),
      };
    }
  }
  return { wssUrl: undefined, isFlashblocks: false };
}

/**
 * Starts event-driven WebSocket (`wss://`) listeners for real-time block headers
 * and Morpho Blue events across configured chains. Triggers `onChainEvent(chainKey, reason)`
 * with per-chain debounce protection.
 */
export function startMultiChainWsListeners(params: {
  chains: EvmChainConfig[];
  minTriggerIntervalMs?: number;
  onChainTrigger: (chain: EvmChainConfig, triggerSource: string, blockNumber?: bigint) => void;
}): WsBlockListenerHandle {
  const {
    chains,
    minTriggerIntervalMs = Number(process.env.MIN_WS_TRIGGER_INTERVAL_MS ?? '1500'),
    onChainTrigger,
  } = params;

  const statuses: Record<string, ChainWsStatus> = {};
  const unwatchers: Array<() => void> = [];
  const lastTriggeredMap = new Map<string, number>();

  for (const chain of chains) {
    const { wssUrl, isFlashblocks } = resolveChainWssUrl(chain.key);
    statuses[chain.key] = {
      chain: chain.key,
      wssUrlConfigured: Boolean(wssUrl),
      connected: false,
      isFlashblocks,
      blocksReceived: 0,
      eventsReceived: 0,
    };

    if (!wssUrl) continue;

    try {
      const wsClient = createPublicClient({
        transport: webSocket(wssUrl, {
          reconnect: {
            attempts: 10,
            delay: 2_000,
          },
          timeout: 10_000,
        }),
      });

      const maybeTrigger = (source: string, blockNumber?: bigint) => {
        const now = Date.now();
        const prev = lastTriggeredMap.get(chain.key) ?? 0;
        if (now - prev < minTriggerIntervalMs) return;
        lastTriggeredMap.set(chain.key, now);
        onChainTrigger(chain, source, blockNumber);
      };

      const unwatchBlocks = wsClient.watchBlockNumber({
        emitOnBegin: false,
        onBlockNumber: (blockNumber) => {
          const st = statuses[chain.key];
          st.connected = true;
          st.blocksReceived += 1;
          st.lastBlockNumber = blockNumber.toString();
          st.lastEventAt = new Date().toISOString();
          maybeTrigger(isFlashblocks ? 'flashblock' : 'new-block', blockNumber);
        },
        onError: (err) => {
          const st = statuses[chain.key];
          st.connected = false;
          st.lastError = err instanceof Error ? err.message : String(err);
        },
      });
      unwatchers.push(unwatchBlocks);

      const unwatchMorpho = wsClient.watchEvent({
        address: MORPHO_BLUE_SINGLETON,
        event: morphoBorrowEvent,
        onLogs: (logs) => {
          if (logs.length === 0) return;
          const st = statuses[chain.key];
          st.connected = true;
          st.eventsReceived += logs.length;
          st.lastEventAt = new Date().toISOString();
          maybeTrigger('morpho-borrow-event', logs[0].blockNumber ?? undefined);
        },
        onError: () => {
          // Non-fatal if eth_subscribe logs is restricted on basic WSS endpoint
        },
      });
      unwatchers.push(unwatchMorpho);
    } catch (err) {
      statuses[chain.key].lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    stop: () => {
      for (const unwatch of unwatchers) {
        try {
          unwatch();
        } catch {
          // Ignore close errors
        }
      }
    },
    getStatuses: () => statuses,
  };
}
