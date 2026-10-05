/** A short-lived submission lock, not a permanent blacklist of route IDs. */
export class ExecutionCooldown extends Set<string> {
  private readonly pending = new Map<string, () => Promise<boolean>>();
  private readonly expires = new Map<string, number>();
  constructor(private readonly ttlMs = 60_000, private readonly now = Date.now) {
    super();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Invalid execution cooldown');
  }
  /** Pending transactions never expire merely because receipt polling timed out. */
  markPending(key: string, confirmed: () => Promise<boolean>): void {
    this.pending.set(key, confirmed);
    this.expires.delete(key);
    super.add(key);
  }
  markConfirmed(key: string): void {
    this.pending.delete(key);
    this.add(key);
  }
  async reconcile(): Promise<void> {
    await Promise.all([...this.pending].map(async ([key, confirmed]) => {
      if (await confirmed().catch(() => false)) this.markConfirmed(key);
    }));
  }
  override has(key: string): boolean {
    this.prune();
    return super.has(key);
  }
  override add(key: string): this {
    this.prune();
    if (!this.pending.has(key)) this.expires.set(key, this.now() + this.ttlMs);
    return super.add(key);
  }
  override delete(key: string): boolean {
    this.pending.delete(key);
    this.expires.delete(key);
    return super.delete(key);
  }
  override clear(): void { this.pending.clear(); this.expires.clear(); super.clear(); }
  private prune(): void {
    const now = this.now();
    for (const [key, end] of this.expires) if (end <= now) this.delete(key);
  }
}
export type ExecutionCooldowns = Map<string, number>;

const DEFAULT_EXECUTION_COOLDOWN_MS = 60_000;

export function buildWhitelistCooldownKey(
  chainKey: string,
  tokens: ReadonlyArray<{ address: string; target: string }>,
  routers: ReadonlyArray<{ address: string }>,
): string {
  const tokenTargets = [...new Set(
    tokens.map((token) => `${token.target.toLowerCase()}:${token.address.toLowerCase()}`),
  )].sort().join(',');
  const routerAddresses = [...new Set(routers.map((router) => router.address.toLowerCase()))]
    .sort()
    .join(',');
  return `whitelist:${chainKey.toLowerCase()}:tokens=${tokenTargets}:routers=${routerAddresses}`;
}

function configuredCooldownMs(): number {
  const value = Number(process.env.OPERATOR_ACTION_COOLDOWN_MS ?? DEFAULT_EXECUTION_COOLDOWN_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_EXECUTION_COOLDOWN_MS;
}

export function isOnExecutionCooldown(
  cooldowns: ExecutionCooldowns,
  key: string,
  now = Date.now(),
): boolean {
  const expiresAt = cooldowns.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

export function rememberExecutionCooldown(
  cooldowns: ExecutionCooldowns,
  key: string,
  now = Date.now(),
): void {
  const durationMs = configuredCooldownMs();
  if (durationMs === 0) {
    cooldowns.delete(key);
    return;
  }
  cooldowns.set(key, now + durationMs);
}

export function pruneExecutionCooldowns(
  cooldowns: ExecutionCooldowns,
  now = Date.now(),
): void {
  for (const [key, expiresAt] of cooldowns) {
    if (expiresAt <= now) cooldowns.delete(key);
  }
}
