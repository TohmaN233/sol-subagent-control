import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_CONFIG_PATH, startConsole, stopConsole } from '../server.mjs';

test('loopback console requires token and revision-checks saves', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sol-control-console-'));
  const configPath = join(dir, 'control-plane.json');
  const state = await startConsole({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, open: false });
  t.after(stopConsole);
  const base = `http://127.0.0.1:${state.port}`;

  const unauthorized = await fetch(`${base}/api/config`);
  assert.equal(unauthorized.status, 401);

  const headers = { authorization: `Bearer ${state.token}` };
  const loadedResponse = await fetch(`${base}/api/config`, { headers });
  assert.equal(loadedResponse.status, 200);
  const loaded = await loadedResponse.json();
  assert.ok(loaded.config.scenarios[0].template.includes('{{task}}'));

  loaded.config.global.enabled = false;
  const savedResponse = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ config: loaded.config, expected_revision: loaded.revision }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.config.global.enabled, false);

  const staleResponse = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ config: loaded.config, expected_revision: loaded.revision }),
  });
  assert.equal(staleResponse.status, 409);
});
