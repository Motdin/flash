import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWhitelistCooldownKey,
  isOnExecutionCooldown,
  pruneExecutionCooldowns,
  rememberExecutionCooldown,
} from './cooldown.js';

test('execution cooldown expires and expired keys can be retried', () => {
  const originalDuration = process.env.OPERATOR_ACTION_COOLDOWN_MS;
  process.env.OPERATOR_ACTION_COOLDOWN_MS = '60000';
  try {
    const cooldowns = new Map<string, number>();
    rememberExecutionCooldown(cooldowns, 'arb:base:route', 1_000);

    assert.equal(isOnExecutionCooldown(cooldowns, 'arb:base:route', 1_001), true);
    assert.equal(isOnExecutionCooldown(cooldowns, 'arb:base:route', 61_000), false);
    assert.equal(cooldowns.has('arb:base:route'), false);
  } finally {
    if (originalDuration === undefined) delete process.env.OPERATOR_ACTION_COOLDOWN_MS;
    else process.env.OPERATOR_ACTION_COOLDOWN_MS = originalDuration;
  }
});

test('allowlist cooldown keys are order-independent and distinguish token/router targets', () => {
  const first = buildWhitelistCooldownKey(
    'Base',
    [
      { address: '0xBBBB', target: 'arb' },
      { address: '0xAAAA', target: 'flash' },
    ],
    [{ address: '0xCCCC' }],
  );
  const reordered = buildWhitelistCooldownKey(
    'base',
    [
      { address: '0xaaaa', target: 'flash' },
      { address: '0xbbbb', target: 'arb' },
    ],
    [{ address: '0xcccc' }],
  );
  const differentTarget = buildWhitelistCooldownKey(
    'base',
    [
      { address: '0xaaaa', target: 'arb' },
      { address: '0xbbbb', target: 'arb' },
    ],
    [{ address: '0xcccc' }],
  );

  assert.equal(first, reordered);
  assert.notEqual(first, differentTarget);
});

test('pruneExecutionCooldowns removes expired keys without disturbing active ones', () => {
  const cooldowns = new Map<string, number>([
    ['expired', 999],
    ['active', 1_001],
  ]);

  pruneExecutionCooldowns(cooldowns, 1_000);

  assert.deepEqual([...cooldowns.keys()], ['active']);
});
