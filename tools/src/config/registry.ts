import { readFile, writeFile, mkdir, rmdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export type Address = `0x${string}`;

export type DeploymentRecord = {
  chainId: number;
  rpcEnv: string;
  morpho?: Address | '';
  executor?: Address | '';
  arbExecutor?: Address | '';
  status?: string;
  allowedAssets?: string[];
  allowedRouters?: string[];
  allowlistTransactions?: Record<string, string>;
  arbLiveTests?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type DeploymentRegistry = Record<string, DeploymentRecord | Record<string, unknown>>;
export type StablecoinRegistry = Record<string, Record<string, { address: Address; decimals: number }>>;

export const deploymentsPath = fileURLToPath(new URL('../../../evm/deployments.json', import.meta.url));
export const stablecoinsPath = fileURLToPath(new URL('../../../evm/stablecoins.json', import.meta.url));
export const artifactPath = fileURLToPath(
  new URL('../../../evm/out/FlashLoanExecutor.sol/FlashLoanExecutor.json', import.meta.url),
);
export const arbArtifactPath = fileURLToPath(
  new URL('../../../evm/out/MorphoAtomicArbPOC.sol/MorphoAtomicArbPOC.json', import.meta.url),
);

/** Merge only changed fields; conflicting edits fail rather than losing another writer's update. */
function mergeChanges(base: unknown, incoming: unknown, current: unknown, path = '$'): unknown {
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (equal(base, incoming)) return current;
  if (equal(base, current) || equal(incoming, current)) return incoming;
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (object(base) && object(incoming) && object(current)) {
    const result: Record<string, unknown> = { ...current };
    for (const key of new Set([...Object.keys(base), ...Object.keys(incoming)])) {
      const merged = mergeChanges(base[key], incoming[key], current[key], `${path}.${key}`);
      if (merged === undefined) delete result[key]; else result[key] = merged;
    }
    return result;
  }
  throw new Error(`Deployment registry conflict at ${path}; reload before retrying`);
}

export class DeploymentStore {
  private readonly snapshots = new WeakMap<DeploymentRegistry, DeploymentRegistry>();
  constructor(private readonly path: string) {}
  async load(): Promise<DeploymentRegistry> {
    // Atomic rename ensures readers see a complete old or new document, never a partial write.
    const value = JSON.parse(await readFile(this.path, 'utf8')) as DeploymentRegistry;
    this.snapshots.set(value, structuredClone(value));
    return value;
  }
  async save(value: DeploymentRegistry): Promise<void> {
    const base = this.snapshots.get(value);
    if (!base) throw new Error('Deployment registry must be loaded by this store before saving');
    const lock = `${this.path}.lock`;
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await mkdir(lock); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await delay(50);
      }
    }
    if (!acquired) throw new Error('Deployment registry locked; check other writers before removing stale lock');
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const current = JSON.parse(await readFile(this.path, 'utf8')) as DeploymentRegistry;
      const merged = mergeChanges(base, value, current) as DeploymentRegistry;
      await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
      this.snapshots.set(value, structuredClone(value));
    } finally {
      await unlink(temporary).catch(() => {});
      await rmdir(lock);
    }
  }
}
const deploymentStore = new DeploymentStore(deploymentsPath);
export const loadDeployments = (): Promise<DeploymentRegistry> => deploymentStore.load();

export async function loadStablecoins(): Promise<StablecoinRegistry> {
  return JSON.parse(await readFile(stablecoinsPath, 'utf8')) as StablecoinRegistry;
}

export function deploymentFor(registry: DeploymentRegistry, chainKey: string): DeploymentRecord | undefined {
  const value = registry[chainKey];
  if (!value || chainKey === '_meta' || typeof value.chainId !== 'number') return undefined;
  return value as DeploymentRecord;
}

export async function saveDeployments(registry: DeploymentRegistry): Promise<void> {
  await deploymentStore.save(registry);
}

export async function morphoForChain(chainKey: string): Promise<Address> {
  const record = deploymentFor(await loadDeployments(), chainKey);
  if (!record?.morpho) throw new Error(`Morpho deployment missing for ${chainKey}`);
  return record.morpho;
}
