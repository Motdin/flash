import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentStore } from '../config/registry.js';

test('registry merges independent stale updates and rejects conflicting writes atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flash-registry-'));
  try {
    const path = join(dir, 'deployments.json');
    await writeFile(path, JSON.stringify({ base: { chainId: 8453, executor: 'old', status: 'old' } }));
    const first = new DeploymentStore(path), second = new DeploymentStore(path);
    const a = await first.load(), b = await second.load();
    a.base.executor = 'new'; b.base.status = 'ready';
    await Promise.all([first.save(a), second.save(b)]);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { base: { chainId: 8453, executor: 'new', status: 'ready' } });
    const c = await first.load(), d = await second.load();
    c.base.executor = 'one'; d.base.executor = 'two';
    await first.save(c);
    await assert.rejects(second.save(d), /conflict/);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).base.executor, 'one');
    await assert.rejects(first.save({}), /loaded/);
    assert.deepEqual(await readdir(dir), ['deployments.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
