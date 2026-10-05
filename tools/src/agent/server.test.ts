import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { startOperatorServer, renderDashboardHtml, type OperatorRuntimeState } from './server.js';
import { loadLlmOperatorConfig } from './llm-operator.js';

function state(): OperatorRuntimeState {
  return { startedAt: new Date().toISOString(), running: true, cycleRunning: false, cycleCount: 0,
    consecutiveFailures: 0, circuitBreakerTripped: false, lastCycleAt: null, nextCycleAt: null, chains: ['base'],
    intervalSec: 30, minimumUsd: 100000, arbLoanUsd: 10000,
    config: loadLlmOperatorConfig({ apiKey: 'SECRET-FIXTURE', baseUrl: 'https://secret.invalid/key', autoBroadcast: true, mode: 'dry-run' }),
    latestReports: {}, recentHistory: [], errors: [] };
}

test('all API endpoints require authentication and DTO never exposes credentials', async () => {
  const saved = process.env.OPERATOR_API_TOKEN;
  const runtime = state();
  const server = await startOperatorServer(0, { getState: () => runtime, triggerNow: async () => {},
    updateConfig: patch => Object.assign(runtime.config, patch) }, '127.0.0.1');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    for (const token of [undefined, 'TOKEN-FIXTURE']) {
      if (token === undefined) delete process.env.OPERATOR_API_TOKEN; else process.env.OPERATOR_API_TOKEN = token;
      for (const path of ['/api/status', '/api/watchlist', '/api/mode', '/api/trigger']) {
        const res = await fetch(url + path, { method: ['/api/mode','/api/trigger'].includes(path) ? 'POST' : 'GET',
          ...(path === '/api/mode' ? { body: '{"mode":"full","minProfitUsd":0}' } : {}) });
        assert.equal(res.status, 401);
        assert.ok(!(await res.text()).includes('SECRET-FIXTURE'));
      }
      assert.equal(runtime.config.mode, 'dry-run');
    }
    const res = await fetch(url + '/api/status', { headers: { Authorization: 'Bearer TOKEN-FIXTURE' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    const text = await res.text(); assert.ok(!text.includes('SECRET-FIXTURE')); assert.ok(!text.includes('secret.invalid'));
    const changed = await fetch(url + '/api/mode', { method: 'POST', headers: { Authorization: 'Bearer TOKEN-FIXTURE' }, body: '{"mode":"full"}' });
    assert.equal(changed.status, 200); assert.equal(runtime.config.mode, 'full');
    assert.ok(!(await changed.text()).includes('SECRET-FIXTURE'));
    const html = await fetch(url); assert.match(html.headers.get('content-security-policy')!, /script-src 'nonce-/);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (saved === undefined) delete process.env.OPERATOR_API_TOKEN; else process.env.OPERATOR_API_TOKEN = saved;
  }
});

test('dashboard escapes untrusted data and sends authenticated requests without storing token', async () => {
  const nodes = new Map<string, { innerHTML: string; value: string; textContent: string; addEventListener: () => void }>();
  const getNode = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', value: '', textContent: '', addEventListener() {} });
    return nodes.get(id)!;
  };
  const calls: Array<{ url: string; headers: Record<string,string> }> = [];
  const html = renderDashboardHtml('fixture-nonce');
  const script = html.match(/<script nonce="fixture-nonce">([\s\S]*?)<\/script>/)![1];
  const fixture = state();
  fixture.errors.push({ chain: 'base', message: '<img src=x onerror="alert(1)">', timestamp: new Date().toISOString() });
  const context = { document: { getElementById: getNode, activeElement: null }, console,
    setInterval: () => {}, fixture, fetch: async (url: string, options: { headers: Record<string,string> }) => {
      calls.push({ url, headers: options.headers }); return { ok: true, json: async () => fixture };
    } };
  runInNewContext(script + '\nrenderState(fixture);', context);
  assert.ok(!getNode('historyContainer').innerHTML.includes('<img'));
  assert.ok(getNode('historyContainer').innerHTML.includes('&lt;img'));
  await runInNewContext("apiToken = 'USER-TOKEN'; apiFetch('/api/status');", context);
  assert.equal(calls[0].headers.Authorization, 'Bearer USER-TOKEN');
  assert.ok(!html.includes('localStorage')); assert.ok(!html.includes('onclick='));
});
