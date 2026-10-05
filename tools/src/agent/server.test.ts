import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { loadLlmOperatorConfig } from './llm-operator.js';
import type { OperatorRuntimeState } from './server.js';
import { startOperatorServer } from './server.js';

test('operator HTTP API redacts LLM key and fails closed without an API token', async () => {
  const originalToken = process.env.OPERATOR_API_TOKEN;
  delete process.env.OPERATOR_API_TOKEN;

  const state: OperatorRuntimeState = {
    startedAt: new Date().toISOString(),
    running: true,
    cycleRunning: false,
    cycleCount: 0,
    consecutiveFailures: 0,
    circuitBreakerTripped: false,
    lastCycleAt: null,
    nextCycleAt: null,
    chains: ['base'],
    intervalSec: 30,
    minimumUsd: 100_000,
    arbLoanUsd: 10_000,
    config: loadLlmOperatorConfig({ apiKey: 'test-llm-secret', mode: 'dry-run' }),
    latestReports: {},
    recentHistory: [],
    errors: [],
  };
  let triggerCount = 0;
  const server = await startOperatorServer(0, {
    getState: () => state,
    triggerNow: async () => { triggerCount += 1; },
    updateConfig: (patch) => Object.assign(state.config, patch),
  }, '127.0.0.1');

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const statusRes = await fetch(`${baseUrl}/api/status`);
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.headers.get('access-control-allow-origin'), null);
    const status = await statusRes.json() as { config: Record<string, unknown>; apiControlsAvailable: boolean };
    assert.equal(status.config.apiKey, undefined);
    assert.equal(status.config.apiKeyConfigured, true);
    assert.equal(status.apiControlsAvailable, false);

    const triggerRes = await fetch(`${baseUrl}/api/trigger`, { method: 'POST' });
    assert.equal(triggerRes.status, 401);
    assert.equal(triggerCount, 0);

    const modeRes = await fetch(`${baseUrl}/api/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'full', minProfitUsd: 0 }),
    });
    assert.equal(modeRes.status, 401);
    assert.equal(state.config.mode, 'dry-run');

    process.env.OPERATOR_API_TOKEN = 'operator-test-token';
    const authorizedRes = await fetch(`${baseUrl}/api/mode`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer operator-test-token',
      },
      body: JSON.stringify({ mode: 'liquidation', minProfitUsd: 7 }),
    });
    assert.equal(authorizedRes.status, 200);
    const updated = await authorizedRes.json() as { config: Record<string, unknown> };
    assert.equal(updated.config.apiKey, undefined);
    assert.equal(updated.config.apiKeyConfigured, true);
    assert.equal(state.config.mode, 'liquidation');
    assert.equal(state.config.minProfitUsd, 7);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (originalToken === undefined) delete process.env.OPERATOR_API_TOKEN;
    else process.env.OPERATOR_API_TOKEN = originalToken;
  }
});
