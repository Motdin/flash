import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address } from '../config/registry.js';
import {
  allowlistBatch,
  allowlistTarget,
  isRetryableNonceError,
  replacementFeeMultiplierBps,
  scaleFeeForAttempt,
  summarizeAllowlistOutcomes,
} from './allowlist.js';

const TOKEN = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Address;
const TOKEN_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as Address;

const noSleep = async (): Promise<void> => {};

test('isRetryableNonceError matches nonce races but not deterministic reverts', () => {
  assert.equal(
    isRetryableNonceError(new Error('Nonce provided for the transaction is lower than the current nonce')),
    true,
  );
  assert.equal(isRetryableNonceError(new Error('Details: nonce too low: next nonce 2, tx nonce 1')), true);
  assert.equal(isRetryableNonceError(new Error('Already known')), true);
  assert.equal(isRetryableNonceError(new Error('replacement transaction underpriced')), true);

  assert.equal(isRetryableNonceError(new Error('execution reverted: Unauthorized')), false);
  assert.equal(isRetryableNonceError(new Error('insufficient funds for gas * price + value')), false);
});

test('replacement fee escalation exceeds the ~10% node replacement threshold after the first retry', () => {
  assert.equal(replacementFeeMultiplierBps(1), 10_000n, 'first attempt keeps the untouched estimate');
  assert.ok(
    replacementFeeMultiplierBps(2) >= 11_000n,
    'second attempt must clear the 10% minimum replacement bump',
  );
  assert.equal(replacementFeeMultiplierBps(2), 13_000n);
  assert.equal(replacementFeeMultiplierBps(3), 16_000n);
  assert.equal(replacementFeeMultiplierBps(0), 10_000n, 'non-positive attempts never discount');
  assert.equal(replacementFeeMultiplierBps(1, 5_000), 10_000n);
  assert.equal(replacementFeeMultiplierBps(2, 5_000), 15_000n);
});

test('scaleFeeForAttempt applies the multiplier without shrinking the fee', () => {
  const base = 13_200_000n; // 0.0132 gwei, as observed on Base
  assert.equal(scaleFeeForAttempt(base, 1), base);
  assert.equal(scaleFeeForAttempt(base, 2), (base * 13_000n) / 10_000n);
  assert.ok(scaleFeeForAttempt(base, 2) > base);
  assert.ok(scaleFeeForAttempt(base, 3) > scaleFeeForAttempt(base, 2));
});

test('send() receives the 1-based attempt number so fees can escalate on retry', async () => {
  const attemptsSeen: number[] = [];
  const outcome = await allowlistTarget({
    label: 'cbADA',
    address: TOKEN,
    isAllowed: async () => false,
    send: async (attempt) => {
      attemptsSeen.push(attempt);
      if (attempt === 1) throw new Error('replacement transaction underpriced');
      return '0xbumped';
    },
    confirm: async () => {},
    sleep: noSleep,
  });

  assert.equal(outcome.status, 'allowlisted');
  assert.equal(outcome.hash, '0xbumped');
  assert.deepEqual(attemptsSeen, [1, 2]);
});

test('already allowlisted targets cost zero transactions', async () => {
  let sendCalls = 0;
  const outcome = await allowlistTarget({
    label: 'USDC',
    address: TOKEN,
    isAllowed: async () => true,
    send: async () => {
      sendCalls += 1;
      return '0xdeadbeef';
    },
    confirm: async () => {},
  });

  assert.equal(outcome.status, 'already-allowed');
  assert.equal(outcome.attempts, 0);
  assert.equal(sendCalls, 0);
});

test('a first-attempt success is reported as allowlisted with its hash', async () => {
  const confirmed: string[] = [];
  const outcome = await allowlistTarget({
    label: 'cbXRP',
    address: TOKEN,
    isAllowed: async () => false,
    send: async () => '0xabc123',
    confirm: async (hash) => {
      confirmed.push(hash);
    },
  });

  assert.equal(outcome.status, 'allowlisted');
  assert.equal(outcome.hash, '0xabc123');
  assert.equal(outcome.attempts, 1);
  assert.deepEqual(confirmed, ['0xabc123']);
});

test('a transient nonce race is retried and then succeeds', async () => {
  let sendCalls = 0;
  const retries: number[] = [];
  const outcome = await allowlistTarget({
    label: 'mGLO',
    address: TOKEN,
    isAllowed: async () => false,
    send: async () => {
      sendCalls += 1;
      if (sendCalls === 1) throw new Error('nonce too low: next nonce 2, tx nonce 1');
      return '0xsecond';
    },
    confirm: async () => {},
    sleep: noSleep,
    onRetry: (attempt) => retries.push(attempt),
  });

  assert.equal(outcome.status, 'allowlisted');
  assert.equal(outcome.hash, '0xsecond');
  assert.equal(outcome.attempts, 2);
  assert.equal(sendCalls, 2);
  assert.deepEqual(retries, [1]);
});

test('does not rebroadcast when the failed attempt actually landed on-chain', async () => {
  // Simulates: the nonce error came from a lagging RPC replica, but the tx was mined anyway.
  let allowed = false;
  let sendCalls = 0;
  const outcome = await allowlistTarget({
    label: 'weETH',
    address: TOKEN,
    isAllowed: async () => allowed,
    send: async () => {
      sendCalls += 1;
      allowed = true; // the transaction lands despite the RPC reporting an error
      throw new Error('nonce too low: next nonce 5, tx nonce 4');
    },
    confirm: async () => {},
    sleep: noSleep,
  });

  assert.equal(outcome.status, 'already-allowed');
  assert.equal(sendCalls, 1, 'must not send a duplicate allowlist transaction');
});

test('deterministic failures fail fast without consuming retries', async () => {
  let sendCalls = 0;
  const outcome = await allowlistTarget({
    label: 'USR',
    address: TOKEN,
    isAllowed: async () => false,
    send: async () => {
      sendCalls += 1;
      throw new Error('execution reverted: Unauthorized');
    },
    confirm: async () => {},
    sleep: noSleep,
    attempts: 3,
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.attempts, 1);
  assert.equal(sendCalls, 1);
  assert.match(outcome.error ?? '', /Unauthorized/);
});

test('exhausting every retry reports failure with the last error', async () => {
  let sendCalls = 0;
  const outcome = await allowlistTarget({
    label: 'SOL',
    address: TOKEN,
    isAllowed: async () => false,
    send: async () => {
      sendCalls += 1;
      throw new Error('nonce too low: next nonce 9, tx nonce 8');
    },
    confirm: async () => {},
    sleep: noSleep,
    attempts: 3,
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.attempts, 3);
  assert.equal(sendCalls, 3);
});

test('a batch keeps going after a failure and summarises the result', async () => {
  const confirmed: string[] = [];
  const { outcomes, summary } = await allowlistBatch(
    [
      {
        label: 'OK-1',
        address: TOKEN,
        isAllowed: async () => false,
        send: async () => '0x1',
        confirm: async (hash) => {
          confirmed.push(hash);
        },
      },
      {
        label: 'BAD',
        address: TOKEN_B,
        isAllowed: async () => false,
        send: async () => {
          throw new Error('execution reverted: InvalidAddress');
        },
        confirm: async () => {},
      },
      {
        label: 'OK-2',
        address: TOKEN,
        isAllowed: async () => true,
        send: async () => '0x3',
        confirm: async () => {},
      },
    ],
    { sleep: noSleep },
  );

  assert.equal(outcomes.length, 3);
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ['allowlisted', 'failed', 'already-allowed'],
  );
  assert.deepEqual(confirmed, ['0x1'], 'the third target was already allowed, the batch still finished');
  assert.equal(summary.allowlisted, 1);
  assert.equal(summary.alreadyAllowed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures[0]?.label, 'BAD');
});

test('summarizeAllowlistOutcomes reports zero failures for a clean run', () => {
  const summary = summarizeAllowlistOutcomes([
    { label: 'A', address: TOKEN, status: 'allowlisted', attempts: 1 },
    { label: 'B', address: TOKEN_B, status: 'already-allowed', attempts: 0 },
  ]);

  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.failures, []);
});
