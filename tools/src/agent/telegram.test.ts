import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLlmOperatorConfig } from './llm-operator.js';
import type { OperatorRuntimeState } from './server.js';
import {
  handleTelegramCommand,
  isTelegramAuthorized,
  parseTelegramCommand,
} from './telegram.js';

function createMockRuntimeState(): OperatorRuntimeState {
  return {
    startedAt: new Date(Date.now() - 125_000).toISOString(),
    running: true,
    cycleRunning: false,
    cycleCount: 4,
    consecutiveFailures: 0,
    circuitBreakerTripped: false,
    lastCycleAt: new Date().toISOString(),
    nextCycleAt: new Date(Date.now() + 30_000).toISOString(),
    chains: ['base', 'arbitrum'],
    intervalSec: 30,
    minimumUsd: 100_000,
    arbLoanUsd: 10_000,
    config: loadLlmOperatorConfig({ mode: 'dry-run', autoBroadcast: false, minProfitUsd: 5 }),
    latestReports: {},
    recentHistory: [],
    errors: [],
  };
}

test('parseTelegramCommand handles slash commands, bot mentions, and free text', () => {
  assert.deepEqual(parseTelegramCommand('/status'), { command: 'status', arg: '' });
  assert.deepEqual(parseTelegramCommand('/mode@MorphoBot full'), {
    command: 'mode',
    arg: 'full',
  });
  assert.deepEqual(parseTelegramCommand('kenapa belum profit?'), {
    command: 'ask',
    arg: 'kenapa belum profit?',
  });
});

test('isTelegramAuthorized strictly checks chat ID and admin IDs', () => {
  assert.equal(isTelegramAuthorized(12345, 999, '12345', ''), true);
  assert.equal(isTelegramAuthorized(77777, 888, '12345', '888,999'), true);
  assert.equal(isTelegramAuthorized(77777, 555, '12345', '888,999'), false);
  assert.equal(isTelegramAuthorized(12345, 999, '', ''), false);
});

test('handleTelegramCommand updates mode, broadcast, and minProfitUsd accurately', async () => {
  const state = createMockRuntimeState();
  let triggered = 0;

  const handlers = {
    getState: () => state,
    triggerNow: async () => {
      triggered += 1;
    },
    updateConfig: (patch: {
      mode?: typeof state.config.mode;
      autoBroadcast?: boolean;
      minProfitUsd?: number;
      resetCircuitBreaker?: boolean;
    }) => {
      if (patch.mode) state.config.mode = patch.mode;
      if (patch.autoBroadcast !== undefined) state.config.autoBroadcast = patch.autoBroadcast;
      if (patch.minProfitUsd !== undefined) state.config.minProfitUsd = patch.minProfitUsd;
      if (patch.resetCircuitBreaker) state.circuitBreakerTripped = false;
    },
  };

  const modeRes = await handleTelegramCommand('/mode full', handlers);
  assert.equal(state.config.mode, 'full');
  assert.match(modeRes.reply, /full/);

  const bcastRes = await handleTelegramCommand('/broadcast on', handlers);
  assert.equal(state.config.autoBroadcast, true);
  assert.match(bcastRes.reply, /LIVE BROADCAST DIAKTIFKAN/);

  const profitRes = await handleTelegramCommand('/profit 15.5', handlers);
  assert.equal(state.config.minProfitUsd, 15.5);
  assert.match(profitRes.reply, /\$15\.50/);

  const scanRes = await handleTelegramCommand('/scan', handlers);
  assert.equal(triggered, 1);
  assert.match(scanRes.reply, /Siklus scan & evaluasi LLM selesai/);
});
