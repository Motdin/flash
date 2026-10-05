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

  assert.equal(polls.status, 'unknown');
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

import { resolveBundleAuthKey, resolveMevBundleRelays, submitMevBundleToRelays } from './mev-bundle.js';

test('blank auth uses validated fallback; malformed and zero keys are rejected', () => {
  const fixture = `0x${'11'.repeat(32)}` as const;
  assert.equal(resolveBundleAuthKey(' ', fixture), fixture);
  assert.equal(resolveBundleAuthKey(undefined, fixture), fixture);
  assert.throws(() => resolveBundleAuthKey('bad', fixture));
  assert.throws(() => resolveBundleAuthKey(`0x${'00'.repeat(32)}`, fixture));
});

test('global mainnet relays are not used for Base/Arbitrum bundles', () => {
  const saved = process.env.MEV_BUNDLE_RELAYS;
  process.env.MEV_BUNDLE_RELAYS = 'https://fixture.invalid';
  try {
    assert.deepEqual(resolveMevBundleRelays('ethereum'), ['https://fixture.invalid']);
    assert.deepEqual(resolveMevBundleRelays('base'), []);
    assert.deepEqual(resolveMevBundleRelays('arbitrum'), []);
  } finally { if (saved === undefined) delete process.env.MEV_BUNDLE_RELAYS; else process.env.MEV_BUNDLE_RELAYS = saved; }
});

test('relay acceptance requires a valid JSON-RPC bundle hash', async () => {
  const saved = globalThis.fetch;
  const submit = () => submitMevBundleToRelays({ chainKey: 'ethereum', authPrivateKey: `0x${'11'.repeat(32)}`,
    relayUrls: ['https://fixture.invalid'], bundle: { txs: ['0x00'], targetBlockNumber: 1n } });
  try {
    for (const body of ['{}', 'not JSON', '{"result":null}', '{"result":{"bundleHash":"bad"}}']) {
      globalThis.fetch = async () => new Response(body);
      assert.equal((await submit()).relaysAccepted, 0);
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { bundleHash: `0x${'ab'.repeat(32)}` } }));
    assert.equal((await submit()).relaysAccepted, 1);
  } finally { globalThis.fetch = saved; }
});

test('RPC receipt failure after target block is unknown, not a zero-gas miss', async () => {
  const result = await awaitBundleInclusion({ txHash: `0x${'ab'.repeat(32)}`, targetBlockNumber: 1n,
    getReceipt: async () => { throw new Error('RPC unavailable'); }, getBlockNumber: async () => 10n, sleep: noSleep });
  assert.equal(result.status, 'unknown');
  assert.equal(resolveBundleBroadcastDecision({ bundleEnabled: true, relaysAttempted: 1, relaysAccepted: 1, inclusion: result.status }).action, 'bundle-only');
});

test('relay submission rechecks runtime policy after signing and sends nothing when stopped', async () => {
  const { submitMevBundleToRelays } = await import('./mev-bundle.js');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected network request'); };
  try {
    const result = await submitMevBundleToRelays({
      chainKey: 'ethereum', authPrivateKey: `0x${'11'.repeat(32)}`,
      bundle: { txs: [await signFixture(1)], targetBlockNumber: 1n },
      relayUrls: ['https://relay.invalid'],
      beforeSubmit: () => { throw new Error('Broadcast cancelled: stopped'); },
    });
    assert.equal(calls, 0);
    assert.equal(result.relaysAccepted, 0);
  } finally { globalThis.fetch = originalFetch; }
});
