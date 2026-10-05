import { getAddress } from 'viem';
import type { Address } from './registry.js';

export type RouterKindId = 0 | 1 | 2 | 3 | 4 | 5;
// 0 = V2
// 1 = V3_LEGACY
// 2 = V3_ROUTER02
// 3 = AERODROME / VELODROME
// 4 = CURVE (StableSwap / CryptoSwap pool)
// 5 = V3_DIRECT_POOL (Direct Uniswap V3 pool callback without SwapRouter)

export type DexRouterConfig = {
  name: string;
  address: Address;
  protocol:
    | 'uniswap-v2'
    | 'sushiswap-v2'
    | 'baseswap-v2'
    | 'camelot-v2'
    | 'uniswap-v3'
    | 'sushiswap-v3'
    | 'aerodrome'
    | 'velodrome'
    | 'curve'
    | 'v3-direct-pool'
    | 'custom-v2';
  kind: RouterKindId;
  feeBps: number;
  /**
   * For V3 routers: fee tier in hundredths of a bip (100=1bps, 500=5bps, 3000=30bps, 10000=100bps)
   * For Curve pools (kind=4): packed coin indices `((i & 0xfff) << 12) | (j & 0xfff)`
   */
  v3FeeTier?: number;
  /** For V3 routers: QuoterV2 contract address used for on-chain quoteExactInputSingle */
  quoterAddress?: Address;
  /** For Aerodrome/Velodrome: pool factory & stable flag */
  factoryAddress?: Address;
  aeroStable?: boolean;
};

/**
 * Packs Curve pool coin indices (i, j) into the 24-bit `fee` field of `SwapHop`.
 */
export function encodeCurveIndices(i: number, j: number): number {
  return ((i & 0xfff) << 12) | (j & 0xfff);
}

/**
 * Unpacks Curve pool coin indices (i, j) from the 24-bit `fee` field of `SwapHop`.
 */
export function decodeCurveIndices(packedFee: number): { i: number; j: number } {
  return {
    i: (packedFee >> 12) & 0xfff,
    j: packedFee & 0xfff,
  };
}

/**
 * Verified Multi-DEX Router Registry (V2, Uniswap V3, Aerodrome/Velodrome, Curve, Direct Pools).
 * Custom routers can also be injected via CUSTOM_DEX_ROUTERS_JSON in .env.
 */
export const DEFAULT_DEX_ROUTERS: Record<string, DexRouterConfig[]> = {
  ethereum: [
    {
      name: 'Uniswap V2',
      address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      protocol: 'uniswap-v2',
      kind: 0,
      feeBps: 30,
    },
    {
      name: 'SushiSwap V2',
      address: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
      protocol: 'sushiswap-v2',
      kind: 0,
      feeBps: 30,
    },
    {
      name: 'Uniswap V3 (5bps)',
      address: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      protocol: 'uniswap-v3',
      kind: 1,
      feeBps: 5,
      v3FeeTier: 500,
      quoterAddress: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    },
    {
      name: 'Uniswap V3 (30bps)',
      address: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      protocol: 'uniswap-v3',
      kind: 1,
      feeBps: 30,
      v3FeeTier: 3000,
      quoterAddress: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    },
  ],
  base: [
    {
      name: 'Uniswap V2 (Base)',
      address: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      protocol: 'uniswap-v2',
      kind: 0,
      feeBps: 30,
    },
    {
      name: 'SushiSwap V2 (Base)',
      address: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
      protocol: 'sushiswap-v2',
      kind: 0,
      feeBps: 30,
    },
    {
      name: 'BaseSwap V2',
      address: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
      protocol: 'baseswap-v2',
      kind: 0,
      feeBps: 25,
    },
    {
      name: 'Uniswap V3 (Base 5bps)',
      address: '0x2626664c2603336E57B271c5C0b26F421741e481',
      protocol: 'uniswap-v3',
      kind: 2,
      feeBps: 5,
      v3FeeTier: 500,
      quoterAddress: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    },
    {
      name: 'Uniswap V3 (Base 30bps)',
      address: '0x2626664c2603336E57B271c5C0b26F421741e481',
      protocol: 'uniswap-v3',
      kind: 2,
      feeBps: 30,
      v3FeeTier: 3000,
      quoterAddress: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    },
    {
      name: 'Aerodrome Volatile',
      address: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
      protocol: 'aerodrome',
      kind: 3,
      feeBps: 30,
      factoryAddress: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
      aeroStable: false,
    },
    {
      name: 'Aerodrome Stable',
      address: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
      protocol: 'aerodrome',
      kind: 3,
      feeBps: 1,
      factoryAddress: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
      aeroStable: true,
    },
  ],
  arbitrum: [
    {
      name: 'Uniswap V2 (Arbitrum)',
      address: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      protocol: 'uniswap-v2',
      kind: 0,
      feeBps: 30,
    },
    {
      name: 'SushiSwap V2 (Arbitrum)',
      address: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      protocol: 'sushiswap-v2',
      kind: 0,
      feeBps: 30,
    },
    {
      name: 'Camelot V2',
      address: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
      protocol: 'camelot-v2',
      kind: 0,
      feeBps: 30,
    },
    {
      name: 'Uniswap V3 (Arb 5bps)',
      address: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      protocol: 'uniswap-v3',
      kind: 1,
      feeBps: 5,
      v3FeeTier: 500,
      quoterAddress: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    },
    {
      name: 'Uniswap V3 (Arb 30bps)',
      address: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      protocol: 'uniswap-v3',
      kind: 1,
      feeBps: 30,
      v3FeeTier: 3000,
      quoterAddress: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    },
  ],
  optimism: [
    {
      name: 'Uniswap V2 (Optimism)',
      address: '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2',
      protocol: 'uniswap-v2',
      kind: 0,
      feeBps: 30,
    },
    {
      name: 'SushiSwap V2 (Optimism)',
      address: '0x2ABf469074dc0b54d793850807E6eb5Faf2625b1',
      protocol: 'sushiswap-v2',
      kind: 0,
      feeBps: 30,
    },
    {
      name: 'Uniswap V3 (OP 5bps)',
      address: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      protocol: 'uniswap-v3',
      kind: 1,
      feeBps: 5,
      v3FeeTier: 500,
      quoterAddress: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    },
    {
      name: 'Velodrome V2 Volatile',
      address: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858',
      protocol: 'velodrome',
      kind: 3,
      feeBps: 30,
      factoryAddress: '0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a',
      aeroStable: false,
    },
  ],
};

export function getRoutersForChain(
  chainKey: string,
  extraRouters?: Array<{
    name?: string;
    address: string;
    feeBps?: number;
    kind?: RouterKindId;
    v3FeeTier?: number;
    quoterAddress?: string;
  }>,
): DexRouterConfig[] {
  const byKey = new Map<string, DexRouterConfig>();

  for (const router of DEFAULT_DEX_ROUTERS[chainKey] ?? []) {
    const normalized = getAddress(router.address) as Address;
    const uniqueKey = `${normalized.toLowerCase()}:${router.kind}:${router.v3FeeTier ?? 0}:${router.aeroStable ? 1 : 0}`;
    byKey.set(uniqueKey, {
      ...router,
      address: normalized,
      ...(router.quoterAddress ? { quoterAddress: getAddress(router.quoterAddress) as Address } : {}),
      ...(router.factoryAddress ? { factoryAddress: getAddress(router.factoryAddress) as Address } : {}),
    });
  }

  const rawEnv = process.env.CUSTOM_DEX_ROUTERS_JSON;
  if (rawEnv) {
    try {
      const parsed = JSON.parse(rawEnv) as Record<
        string,
        Array<{
          name?: string;
          address: string;
          feeBps?: number;
          kind?: RouterKindId;
          v3FeeTier?: number;
          quoterAddress?: string;
        }>
      >;
      for (const item of parsed[chainKey] ?? []) {
        const normalized = getAddress(item.address) as Address;
        const uniqueKey = `${normalized.toLowerCase()}:${item.kind ?? 0}:${item.v3FeeTier ?? 0}:0`;
        byKey.set(uniqueKey, {
          name: item.name ?? `CustomRouter(${normalized.slice(0, 8)})`,
          address: normalized,
          protocol: item.kind === 4 ? 'curve' : item.kind === 5 ? 'v3-direct-pool' : 'custom-v2',
          kind: item.kind ?? 0,
          feeBps: item.feeBps ?? 30,
          ...(item.v3FeeTier !== undefined ? { v3FeeTier: item.v3FeeTier } : {}),
          ...(item.quoterAddress ? { quoterAddress: getAddress(item.quoterAddress) as Address } : {}),
        });
      }
    } catch {
      // Ignore malformed custom router JSON
    }
  }

  for (const item of extraRouters ?? []) {
    const normalized = getAddress(item.address) as Address;
    const uniqueKey = `${normalized.toLowerCase()}:${item.kind ?? 0}:${item.v3FeeTier ?? 0}:0`;
    byKey.set(uniqueKey, {
      name: item.name ?? `CustomRouter(${normalized.slice(0, 8)})`,
      address: normalized,
      protocol: item.kind === 4 ? 'curve' : item.kind === 5 ? 'v3-direct-pool' : 'custom-v2',
      kind: item.kind ?? 0,
      feeBps: item.feeBps ?? 30,
      ...(item.v3FeeTier !== undefined ? { v3FeeTier: item.v3FeeTier } : {}),
      ...(item.quoterAddress ? { quoterAddress: getAddress(item.quoterAddress) as Address } : {}),
    });
  }

  return [...byKey.values()];
}
