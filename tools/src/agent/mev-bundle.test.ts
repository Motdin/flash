import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, stringToHex, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  awaitBundleInclusion,
  bundleTxHash,
  resolveBundleBroadcastDecision,
  shouldWaitForBundle,
  type BundleReceiptLite,
} from './mev-bundle.js';

const noSleep = async (): Promise<void> => {};

/** Offline-signed EIP-1559 transaction used as a golden vector for `bundleTxHash`. */
async function signFixture(nonce: number): Promise<`0x${string}`> {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  return account.signTransaction({
    chainId: 8453,
    nonce,
    to: '0x0000000000000000000000000000000000000020',
    data: stringToHex('hi'),
    gas: 21_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    type: 'eip1559',
  });
}

test('bundleTxHash is keccak256 over the signed encoding the relay receives', async () => {
  const raw = await signFixture(7);
  // Golden vector: 0x02 || rlp(...) for an EIP-1559 tx, i.e. exactly what is sent in `txs`.
  assert.equal(
    bundleTxHash(raw),
    '0xf5ebbe91ed62d3a2ea27d3d2a5e0d17b49c0bcf521b516d16d464d4ceb377a42',
  );
  assert.equal(bundleTxHash(raw), keccak256(raw));
  assert.match(bundleTxHash(raw), /^0x[0-9a-f]{64}$/);
});

test('bundleTxHash changes when only the nonce changes, so the receipt wait watches the right tx', async () => {
  assert.notEqual(await signFixture(7), await signFixture(8));
  assert.notEqual(bundleTxHash(await signFixture(7)), bundleTxHash(await signFixture(8)));
});

test('shouldWaitForBundle only waits on a relay that actually accepted the bundle', () => {
  assert.equal(shouldWaitForBundle({ bundleEnabled: false, relaysAttempted: 4, relaysAccepted: 4 }), false);
  assert.equal(shouldWaitForBundle({ bundleEnabled: true, relaysAttempted: 0, relaysAccepted: 0 }), false);
  assert.equal(shouldWaitForBundle({ bundleEnabled: true, relaysAttempted: 4, relaysAccepted: 0 }), false);
  assert.equal(shouldWaitForBundle({ bundleEnabled: true, relaysAttempted: 4, relaysAccepted: 1 }), true);
});

test('a missed bundle abstains and never counts as a failure, while a revert does', () => {
  const disabled = resolveBundleBroadcastDecision({
    bundleEnabled: false,
    relaysAttempted: 4,
    relaysAccepted: 4,
    inclusion: 'not-checked',
  });
  assert.equal(disabled.action, 'public-broadcast');

  const unsupportedChain = resolveBundleBroadcastDecision({
    bundleEnabled: true,
    relaysAttempted: 0,
    relaysAccepted: 0,
    inclusion: 'not-checked',
  });
  assert.equal(unsupportedChain.action, 'public-broadcast', 'Base & friends must not hang on a relay that does not exist');
  assert.match(unsupportedChain.reason, /tidak ada builder relay/);

  const rejected = resolveBundleBroadcastDecision({
    bundleEnabled: true,
    relaysAttempted: 4,
    relaysAccepted: 0,
    inclusion: 'not-checked',
  });
  assert.equal(rejected.action, 'public-broadcast', 'all relays rejected -> keep the public path');

  const landed = resolveBundleBroadcastDecision({
    bundleEnabled: true,
    relaysAttempted: 4,
    relaysAccepted: 3,
    inclusion: 'included-success',
  });
  assert.equal(landed.action, 'bundle-only');
  assert.equal(landed.countAsFailure, false);

  const reverted = resolveBundleBroadcastDecision({
    bundleEnabled: true,
    relaysAttempted: 4,
    relaysAccepted: 3,
    inclusion: 'included-reverted',
  });
  assert.equal(reverted.action, 'bundle-only');
  assert.equal(reverted.countAsFailure, true, 'a real on-chain revert must still reach the circuit breaker');

  const missed = resolveBundleBroadcastDecision({
    bundleEnabled: true,
    relaysAttempted: 4,
    relaysAccepted: 3,
    inclusion: 'missed',
  });
  assert.equal(missed.action, 'abstain-zero-gas', 'no public re-broadcast of a leaked private route');
  assert.equal(missed.countAsFailure, false, 'a 0-gas miss must not disable autoBroadcast');
});

test('awaitBundleInclusion returns as soon as the receipt shows up', async () => {
  const receipts: Array<BundleReceiptLite | null> = [null, { blockNumber: 101n, status: 'success' }];
  const result = await awaitBundleInclusion({
    txHash: `0x${'ab'.repeat(32)}` as Hash,
    targetBlockNumber: 100n,
    maxBlocks: 4,
    getReceipt: async () => receipts.shift() ?? null,
    getBlockNumber: async () => 100n,
    sleep: noSleep,
  });

  assert.equal(result.status, 'included-success');
  assert.equal(result.polls, 2);
  if (result.status === 'included-success') assert.equal(result.receipt.blockNumber, 101n);
});

test('awaitBundleInclusion maps a reverted receipt so the failure is reported honestly', async () => {
  const result = await awaitBundleInclusion({
    txHash: `0x${'cd'.repeat(32)}` as Hash,
    targetBlockNumber: 500n,
    getReceipt: async () => ({ blockNumber: 501n, status: 'reverted' }),
    getBlockNumber: async () => 501n,
    sleep: noSleep,
  });

  assert.equal(result.status, 'included-reverted');
});

test('awaitBundleInclusion gives up after the block deadline instead of hanging for minutes', async () => {
  let block = 100n;
  const result = await awaitBundleInclusion({
    txHash: `0x${'ef'.repeat(32)}` as Hash,
    targetBlockNumber: 100n,
    maxBlocks: 2,
    getReceipt: async () => null,
    getBlockNumber: async () => (block += 1n),
    sleep: noSleep,
  });

  assert.equal(result.status, 'missed');
  assert.equal(result.polls, 2, 'polls stop at target+maxBlocks, not at the ~180s viem default');
  if (result.status === 'missed') assert.equal(result.lastSeenBlockNumber, 102n);
});

test('a failing receipt lookup costs one poll instead of aborting the wait', async () => {
  let calls = 0;
  const result = await awaitBundleInclusion({
    txHash: `0x${'12'.repeat(32)}` as Hash,
    targetBlockNumber: 200n,
    maxBlocks: 8,
    getReceipt: async () => {
      calls += 1;
      if (calls === 1) throw new Error('RPC returned 502');
      return { blockNumber: 201n, status: 'success' };
    },
    getBlockNumber: async () => 200n,
    sleep: noSleep,
  });

  assert.equal(result.status, 'included-success');
  assert.equal(result.polls, 2);
});

test('awaitBundleInclusion is bounded even when the node never advances its block number', async () => {
  const polls = await awaitBundleInclusion({
    txHash: `0x${'34'.repeat(32)}` as Hash,
    targetBlockNumber: 1n,
    maxBlocks: 2,
    pollIntervalMs: 1_000,
    getReceipt: async () => null,
    getBlockNumber: async () => 1n,
    sleep: noSleep,
  });

  assert.equal(polls.status, 'missed');
  assert.equal(polls.polls, 30, 'maxBlocks * ceil(15s / pollIntervalMs) caps the loop');
});

test('maxBlocks below one is clamped so a misconfigured env cannot skip the wait entirely', async () => {
  const result = await awaitBundleInclusion({
    txHash: `0x${'56'.repeat(32)}` as Hash,
    targetBlockNumber: 10n,
    maxBlocks: 0,
    getReceipt: async () => null,
    getBlockNumber: async () => 9_999n,
    sleep: noSleep,
  });

  assert.equal(result.status, 'missed');
  assert.equal(result.polls, 1);
});
