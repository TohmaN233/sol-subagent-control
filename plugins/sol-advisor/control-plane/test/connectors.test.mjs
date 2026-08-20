import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { loadConfig, saveConfig } from '../lib/config.mjs';
import { ConnectorRegistry } from '../connectors/registry.mjs';
import { startConnectorSelection } from '../lib/control.mjs';
import { DEFAULT_CONFIG_PATH } from '../server.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fakeSource = join(here, 'fixtures', 'fake-grok.mjs');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sol-grok-connector-'));
  const workspace = join(root, 'repo');
  await mkdir(workspace, { recursive: true });
  await execFileAsync('git', ['-C', workspace, 'init', '-q']);
  await execFileAsync('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.test']);
  await execFileAsync('git', ['-C', workspace, 'config', 'user.name', 'Fixture']);
  await writeFile(join(workspace, 'tracked.txt'), 'baseline\n');
  await execFileAsync('git', ['-C', workspace, 'add', 'tracked.txt']);
  await execFileAsync('git', ['-C', workspace, 'commit', '-qm', 'fixture']);
  const configPath = join(root, 'control-plane.json');
  const config = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  const provider = config.providers.find((item) => item.id === 'grok-local');
  provider.enabled = true;
  provider.config.task_timeout_ms = 1000;
  const scenario = config.scenarios.find((item) => item.id === 'grok-readonly-advice');
  scenario.enabled = true;
  await saveConfig(config, { configPath });
  const env = { ...process.env, GROK_BIN: fakeSource };
  const spawnImpl = (command, args, options) => {
    assert.equal(command, fakeSource);
    return spawn(process.execPath, [fakeSource, ...args], options);
  };
  const registry = new ConnectorRegistry({ configPath, env, spawnImpl });
  await registry.initialize();
  return { root, workspace, configPath, env, registry };
}

async function start(fx, task) {
  return startConnectorSelection({
    scenario_id: 'grok-readonly-advice',
    task,
    context: 'Fixture evidence only.',
    constraints: 'Read-only. Do not change files.',
    verification: 'Return a bounded result.',
    workspace: fx.workspace,
    user_approved: true,
  }, {
    configPath: fx.configPath,
    defaultConfigPath: DEFAULT_CONFIG_PATH,
    env: fx.env,
    registry: fx.registry,
  });
}

test('built-in Grok connector completes with exact task/session/run identity', async () => {
  const fx = await fixture();
  const started = await start(fx, 'NORMAL');
  assert.ok(['running', 'completed'].includes(started.state));
  assert.match(started.task_id, /^[0-9a-f-]{36}$/);
  assert.equal(started.remote_identity.session_id, '11111111-1111-7111-8111-111111111111');
  assert.match(started.remote_identity.run_id, /^[0-9a-f-]{36}$/);
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'completed');
  assert.equal(done.terminal_evidence.kind, 'acp_prompt_result');
  assert.equal(done.scope.unchanged, true);
  assert.match(done.result.text, /fixture result/);
});

test('permission is surfaced and only an exact returned option resumes the run', async () => {
  const fx = await fixture();
  const started = await start(fx, 'ASK_PERMISSION');
  const waiting = await fx.registry.status(started.task_id, 5000);
  assert.equal(waiting.state, 'needs_permission');
  const request = waiting.pending_request;
  await assert.rejects(
    fx.registry.control(started.task_id, {
      action: 'respond_permission', request_id: request.request_id,
      decision: 'select', option_id: 'not-returned',
    }),
    /option_id was not returned/,
  );
  await fx.registry.control(started.task_id, {
    action: 'respond_permission', request_id: request.request_id,
    decision: 'select', option_id: 'allow-once',
  });
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'completed');
  assert.match(done.result.text, /approved fixture result/);
});


test('input elicitation validates the returned schema before resuming', async () => {
  const fx = await fixture();
  const started = await start(fx, 'ASK_INPUT');
  const waiting = await fx.registry.status(started.task_id, 5000);
  assert.equal(waiting.state, 'needs_input');
  const request = waiting.pending_request;
  await assert.rejects(
    fx.registry.control(started.task_id, {
      action: 'respond_input', request_id: request.request_id,
      decision: 'accept', content: { value: 'fixture', wrong: true },
    }),
    /unknown field: wrong/,
  );
  await fx.registry.control(started.task_id, {
    action: 'respond_input', request_id: request.request_id,
    decision: 'accept', content: { value: 'fixture' },
  });
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'completed');
  assert.match(done.result.text, /approved fixture result/);
});

test('cancel requires exact identity and reaches a confirmed cancelled terminal state', async () => {
  const fx = await fixture();
  const started = await start(fx, 'WAIT_FOR_CANCEL');
  await assert.rejects(
    fx.registry.control(started.task_id, {
      action: 'cancel', confirm: true,
    }),
    /requires the exact expected_session_id and expected_run_id/,
  );
  await assert.rejects(
    fx.registry.control(started.task_id, {
      action: 'cancel', confirm: true, expected_session_id: 'wrong',
      expected_run_id: started.remote_identity.run_id,
    }),
    /expected_session_id does not match/,
  );
  await fx.registry.control(started.task_id, {
    action: 'cancel', confirm: true,
    expected_session_id: started.remote_identity.session_id,
    expected_run_id: started.remote_identity.run_id,
  });
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'cancelled');
  assert.equal(done.terminal_evidence.kind, 'acp_prompt_result');
});

test('timeout is ambiguous and never auto-resubmits', async () => {
  const fx = await fixture();
  const started = await start(fx, 'HANG');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const timed = await fx.registry.status(started.task_id);
  assert.equal(timed.state, 'needs_attention');
  assert.equal(timed.error.code, 'TIMEOUT_UNCONFIRMED');
  const stored = JSON.parse(await readFile(join(fx.root, 'connector-tasks.json'), 'utf8'));
  assert.equal(stored.tasks.length, 1);
  await fx.registry.control(started.task_id, {
    action: 'abandon', confirm: true, acknowledge_may_still_run: true,
    reason: 'fixture cleanup',
  });
});

test('read-only workspace mutation produces scope_violation', async () => {
  const fx = await fixture();
  const started = await start(fx, 'WRITE_FILE');
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'scope_violation');
  assert.equal(done.error.code, 'SCOPE_VIOLATION');
  assert.equal(done.result, null);
});

test('credential-shaped stderr is redacted from connector errors', async () => {
  const fx = await fixture();
  const started = await start(fx, 'STDERR_SECRET');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const observed = await fx.registry.status(started.task_id);
  assert.ok(['failed', 'needs_attention'].includes(observed.state));
  const serialized = JSON.stringify(observed);
  assert.doesNotMatch(serialized, /fixture-secret|fixture-token/);
  assert.match(serialized, /\[redacted\]/);
  if (!['completed', 'failed', 'cancelled', 'scope_violation', 'abandoned'].includes(observed.state)) {
    await fx.registry.control(started.task_id, {
      action: 'abandon', confirm: true, acknowledge_may_still_run: true,
      reason: 'fixture cleanup',
    });
  }
});

test('restart changes a nonterminal task to unknown_after_restart without creating a duplicate', async () => {
  const fx = await fixture();
  const started = await start(fx, 'HANG');
  const restarted = new ConnectorRegistry({ configPath: fx.configPath, env: fx.env });
  await restarted.initialize();
  const recovered = await restarted.status(started.task_id);
  assert.equal(recovered.state, 'unknown_after_restart');
  assert.equal(recovered.error.code, 'UNKNOWN_AFTER_RESTART');
  const stored = JSON.parse(await readFile(join(fx.root, 'connector-tasks.json'), 'utf8'));
  assert.equal(stored.tasks.length, 1);
  await fx.registry.control(started.task_id, {
    action: 'abandon', confirm: true, acknowledge_may_still_run: true,
    reason: 'fixture cleanup',
  });
});


test('task persistence stores a prompt digest but not the prompt body', async () => {
  const fx = await fixture();
  const marker = 'PRIVATE_PROMPT_MARKER_7ca6b3';
  const started = await start(fx, `${marker} HANG`);
  const raw = await readFile(join(fx.root, 'connector-tasks.json'), 'utf8');
  assert.doesNotMatch(raw, new RegExp(marker));
  const stored = JSON.parse(raw).tasks[0];
  assert.match(stored.prompt_sha256, /^[0-9a-f]{64}$/);
  await fx.registry.control(started.task_id, {
    action: 'abandon', confirm: true, acknowledge_may_still_run: true,
    reason: 'fixture cleanup',
  });
});
