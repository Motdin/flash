import type { Address } from '../config/registry.js';

export type AllowlistStatus = 'allowlisted' | 'already-allowed' | 'failed';

export type AllowlistOutcome = {
  label: string;
  address: Address;
  status: AllowlistStatus;
  hash?: string;
  error?: string;
  attempts: number;
};

export type AllowlistTarget = {
  /** Human-readable name used in logs and the final summary. */
  label: string;
  address: Address;
  /** Reads current on-chain allowlist state (`allowedToken` / `allowedRouter`). */
  isAllowed: () => Promise<boolean>;
  /**
   * Broadcasts the allowlist transaction. Receives the 1-based attempt number so callers can
   * escalate the gas price on retries — a node rejects a same-nonce resend unless it carries a
   * sufficient fee bump ("replacement transaction underpriced").
   */
  send: (attempt: number) => Promise<string>;
  /** Waits for the receipt and throws when the transaction reverted. */
  confirm: (hash: string) => Promise<void>;
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Detects the nonce race errors that appear when several allowlist transactions are sent
 * back-to-back through a load-balanced public RPC: a replica that has not yet observed the
 * previous transaction answers `eth_getTransactionCount` with a stale value, so viem reuses a
 * nonce that is already mined. These are transient and safe to retry after re-reading state.
 *
 * Deterministic failures (reverts, insufficient funds, unauthorized sender) are NOT retryable.
 */
export function isRetryableNonceError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes('nonce too low') ||
    message.includes('nonce provided for the transaction is lower') ||
    message.includes('already known') ||
    message.includes('replacement transaction underpriced') ||
    message.includes('nonce has already been used')
  );
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split('\n')[0]?.trim().slice(0, 300) ?? 'unknown error';
}

/**
 * Multiplier applied to the estimated gas price on retry `attempt`, expressed in basis points.
 * The first attempt uses the untouched estimate (10_000 = 1.00x); every subsequent attempt adds
 * `stepBps` so the transaction can displace the previously submitted one at the same nonce.
 *
 * Ethereum nodes require a replacement to be at least ~10% more expensive, so the default step of
 * 30% clears that threshold with margin while remaining negligible in absolute terms on Base and
 * Arbitrum (fractions of a cent per allowlist transaction).
 */
export function replacementFeeMultiplierBps(attempt: number, stepBps = 3_000): bigint {
  const retries = BigInt(Math.max(0, Math.trunc(attempt) - 1));
  return 10_000n + retries * BigInt(stepBps);
}

/** Scales a wei-denominated fee by the escalation multiplier for the given attempt. */
export function scaleFeeForAttempt(wei: bigint, attempt: number, stepBps = 3_000): bigint {
  return (wei * replacementFeeMultiplierBps(attempt, stepBps)) / 10_000n;
}

/**
 * Allowlists a single token/router with nonce-race resilience.
 *
 * Ordering guarantees that make this safe to retry:
 * 1. `isAllowed()` is checked first, so an already-allowlisted target costs zero transactions.
 * 2. After a retryable nonce error the chain is re-read before resending. If an earlier attempt
 *    actually landed, the target is reported as `already-allowed` instead of broadcasting a
 *    duplicate (allowlisting is idempotent, but duplicate transactions still burn gas).
 * 3. Only retryable nonce errors consume an attempt; a revert fails fast with the real reason.
 */
export async function allowlistTarget(target: AllowlistTarget): Promise<AllowlistOutcome> {
  const attemptsAllowed = Math.max(1, target.attempts ?? 3);
  const retryDelayMs = target.retryDelayMs ?? 2_000;
  const sleep = target.sleep ?? defaultSleep;
  const base = { label: target.label, address: target.address };

  try {
    if (await target.isAllowed()) return { ...base, status: 'already-allowed', attempts: 0 };
  } catch (error) {
    return { ...base, status: 'failed', error: describeError(error), attempts: 0 };
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
    try {
      const hash = await target.send(attempt);
      await target.confirm(hash);
      return { ...base, status: 'allowlisted', hash, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryableNonceError(error)) {
        return { ...base, status: 'failed', error: describeError(error), attempts: attempt };
      }
      target.onRetry?.(attempt, error);
      if (attempt === attemptsAllowed) break;
      await sleep(retryDelayMs);
      // An earlier attempt may have been mined even though the RPC reported a nonce error.
      try {
        if (await target.isAllowed()) return { ...base, status: 'already-allowed', attempts: attempt };
      } catch (error) {
        return { ...base, status: 'failed', error: describeError(error), attempts: attempt };
      }
    }
  }

  return { ...base, status: 'failed', error: describeError(lastError), attempts: attemptsAllowed };
}

export type AllowlistSummary = {
  allowlisted: number;
  alreadyAllowed: number;
  failed: number;
  failures: AllowlistOutcome[];
};

export function summarizeAllowlistOutcomes(outcomes: AllowlistOutcome[]): AllowlistSummary {
  const failures = outcomes.filter((outcome) => outcome.status === 'failed');
  return {
    allowlisted: outcomes.filter((outcome) => outcome.status === 'allowlisted').length,
    alreadyAllowed: outcomes.filter((outcome) => outcome.status === 'already-allowed').length,
    failed: failures.length,
    failures,
  };
}

/**
 * Runs a batch of allowlist targets sequentially so each transaction is confirmed before the
 * next nonce is requested. A failure never aborts the batch: remaining targets are still
 * attempted and the caller receives a summary to decide whether a follow-up run is needed.
 */
export async function allowlistBatch(
  targets: AllowlistTarget[],
  options: { onOutcome?: (outcome: AllowlistOutcome) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ outcomes: AllowlistOutcome[]; summary: AllowlistSummary }> {
  const outcomes: AllowlistOutcome[] = [];
  for (const target of targets) {
    const outcome = await allowlistTarget(options.sleep ? { ...target, sleep: options.sleep } : target);
    outcomes.push(outcome);
    options.onOutcome?.(outcome);
  }
  return { outcomes, summary: summarizeAllowlistOutcomes(outcomes) };
}
