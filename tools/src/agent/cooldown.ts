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
