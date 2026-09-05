import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { ConnectorRegistry } from '../connectors/registry.mjs';
import { captureWorkspaceSnapshot, verifyWorkspaceScope } from '../connectors/scope-guard.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';
import { startConnectorSelection } from '../lib/control.mjs';
import { WorkflowService } from '../lib/workflow-service.mjs';
import { DEFAULT_CONFIG_PATH } from '../server.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fakeGrok = join(here, 'fixtures', 'fake-grok.mjs');
const fakeCursor = join(here, 'fixtures', 'fake-cursor.mjs');

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function fixture(t, { processRunningImpl = async () => false, cursorLaunchIfClosed = true, envOverrides = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sol-connectors-'));
  const workspaceInput = join(root, 'repo');
  await mkdir(workspaceInput, { recursive: true });
  const workspace = await realpath(workspaceInput);
  await execFileAsync('git', ['-C', workspace, 'init', '-q']);
  await execFileAsync('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.test']);
  await execFileAsync('git', ['-C', workspace, 'config', 'user.name', 'Fixture']);
  await writeFile(join(workspace, 'tracked.txt'), 'baseline\n');
  await writeFile(join(workspace, '.gitignore'), 'ignored-secret.txt\nignored-grok.txt\n');
  await execFileAsync('git', ['-C', workspace, 'add', 'tracked.txt', '.gitignore']);
  await execFileAsync('git', ['-C', workspace, 'commit', '-qm', 'fixture']);

  const cursorPort = await freePort();
  const configPath = join(root, 'control-plane.json');
  const config = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  for (const id of ['grok-local', 'cursor-local']) {
    const provider = config.providers.find((item) => item.id === id);
    provider.enabled = true;
    provider.config.task_timeout_ms = id === 'cursor-local' ? 5000 : 1000;
    provider.config.startup_timeout_ms = 5000;
    if (id === 'cursor-local') {
      provider.config.cdp_port = cursorPort;
      provider.config.command_timeout_ms = 3000;
      provider.config.launch_if_closed = cursorLaunchIfClosed;
    }
  }
  for (const [id, providerId, access] of [
    ['grok-readonly-advice', 'grok-local', 'read_only'],
    ['grok-bounded-change', 'grok-local', 'bounded_write'],
    ['cursor-readonly-advice', 'cursor-local', 'read_only'],
    ['cursor-bounded-change', 'cursor-local', 'bounded_write'],
  ]) {
    config.task_types.push({
      id,
      name: `Fixture ${access}`,
      enabled: true,
      description: 'Connector integration fixture.',
      route: 'delegate',
      tags: ['fixture'],
      stages: [{
        id: 'implementation', role: 'implementer', provider_id: providerId, access,
        requires_user_approval: true, template: 'Perform {{task}} under {{constraints}}. Verify with {{verification}}.',
      }],
    });
  }
  await saveConfig(config, { configPath });

  const cursorLog = join(root, 'cursor-launch.jsonl');
  const env = {
    ...process.env,
    GROK_BIN: fakeGrok,
    CURSOR_EXE: fakeCursor,
    FAKE_CURSOR_LOG: cursorLog,
    ...envOverrides,
  };
  const children = new Set();
  const spawnImpl = (command, args, options) => {
    assert.ok([fakeGrok, fakeCursor].includes(command), `unexpected fixture command: ${command}`);
    const child = spawn(process.execPath, [command, ...args], { ...options, detached: false });
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
  };
  t.after(async () => {
    const live = [...children];
    for (const child of live) {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch {}
      }
    }
    await Promise.all(live.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveWait) => setTimeout(resolveWait, 500)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }));
  });
  const registry = new ConnectorRegistry({
    configPath,
    env,
    spawnImpl,
    processRunningImpl,
  });
  await registry.initialize();
  return { root, workspace, configPath, env, registry, spawnImpl, cursorPort, cursorLog };
}

function startScenario(fx, taskTypeId, taskText, {
  userApproved = true,
  allowedPaths,
} = {}) {
  return startConnectorSelection({
    task_type_id: taskTypeId,
    stage_id: 'implementation',
    task: taskText,
    context: 'Process/protocol fixture evidence only.',
    constraints: 'Respect the connector access boundary.',
    verification: 'Return a bounded result for Sol to verify.',
    workspace: fx.workspace,
    user_approved: userApproved,
    ...(allowedPaths ? { allowed_paths: allowedPaths } : {}),
  }, {
    configPath: fx.configPath,
    defaultConfigPath: DEFAULT_CONFIG_PATH,
    env: fx.env,
    registry: fx.registry,
  });
}

async function respondAllow(registry, taskId) {
  const waiting = await registry.status(taskId, 5000);
  assert.equal(waiting.state, 'needs_permission');
  await registry.control(taskId, {
    action: 'respond_permission',
    request_id: waiting.pending_request.request_id,
    decision: 'select',
    option_id: 'allow-once',
  });
}

test('migrated Workflow dispatches the real connector adapter and collects observed terminal evidence', async t => {
  const fx = await fixture(t);
  const service = new WorkflowService({ configPath: fx.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: fx.env, registry: fx.registry });
  await service.call('migrate_v6', {}, { human: true });
  const run = await service.call('start', { workflow_id: 'grok-readonly-advice', workspace: fx.workspace, access: 'read_only', main_actor: 'root', inputs: { task: 'WORKFLOW_E2E', verification: 'Observe exact identity and unchanged workspace' } });
  const authority = { run_id: run.run_id, control_token: run.control_token };
  await service.call('approve', { ...authority, approval_id: 'implementation:1', decision: true });
  const lease = await service.call('claim_node', { ...authority, node_id: 'implementation', owner: 'worker', request_id: 'workflow-connector-claim' });
  const request = { ...authority, node_id: lease.node_id, attempt_id: lease.attempt_id, lease_token: lease.lease_token };
  const dispatched = await service.call('dispatch', request); assert.equal(dispatched.receipt.task_id, lease.attempt_id);
  const finished = await fx.registry.status(dispatched.receipt.task_id, 5000); assert.equal(finished.state, 'completed');
  const collected = await service.call('collect_connector', request); assert.equal(collected.nodes.implementation.status, 'succeeded');
  assert.equal(collected.nodes.implementation.attempts[0].completion.evidence[0].scope.compliant, true);
  assert.equal(collected.nodes['final-acceptance'].status, 'ready'); assert.equal(collected.status, 'running');
});

test('approval-gated bounded write is rejected before connector launch when approval is missing', async (t) => {
  const fx = await fixture(t);
  for (const scenarioId of ['grok-bounded-change', 'cursor-bounded-change']) {
    await assert.rejects(
      startScenario(fx, scenarioId, 'MUST_NOT_START', {
        userApproved: false,
        allowedPaths: ['allowed/'],
      }),
      /requires explicit current-task user approval/,
    );
  }
  await assert.rejects(stat(fx.cursorLog), /ENOENT/);
});

test('bounded write does not ask for extra approval when provider and stage gates are off', async (t) => {
  const fx = await fixture(t);
  const config = await loadConfig({ configPath: fx.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  const provider = config.providers.find((item) => item.id === 'grok-local');
  const stage = config.task_types.find((item) => item.id === 'grok-bounded-change').stages[0];
  provider.requires_user_approval = false;
  stage.requires_user_approval = false;
  await saveConfig(config, { configPath: fx.configPath });

  const task = await startScenario(fx, 'grok-bounded-change', 'WRITE_ALLOWED', {
    userApproved: false,
    allowedPaths: ['allowed/'],
  });
  assert.match(task.task_id, /^[0-9a-f-]{36}$/i);
});





test('registry defensively rejects an explicitly approval-gated connector start without approval', async (t) => {
  const fx = await fixture(t);
  const config = await loadConfig({ configPath: fx.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  const provider = config.providers.find((item) => item.id === 'cursor-local');
  const stage = config.task_types.find((item) => item.id === 'cursor-bounded-change').stages[0];
  const scenario = { id: stage.id, read_only: false, requires_user_approval: true };
  await assert.rejects(
    fx.registry.start({
      provider,
      stage: scenario,
      taskTypeId: 'cursor-bounded-change',
      stageId: 'implementation',
      prompt: 'MUST_NOT_START',
      workspace: fx.workspace,
      allowedPaths: ['allowed/'],
      userApproved: false,
    }),
    /requires explicit current-task user approval/,
  );
  await assert.rejects(stat(fx.cursorLog), /ENOENT/);
});

test('bounded write requires provider write capability and non-empty allowed_paths before process launch', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    startScenario(fx, 'cursor-bounded-change', 'MISSING_PATHS'),
    /require at least one workspace-relative allowed_paths/,
  );
  const config = await loadConfig({ configPath: fx.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  config.providers.find((item) => item.id === 'grok-local').capabilities.write = false;
  await assert.rejects(
    saveConfig(config, { configPath: fx.configPath }),
    /requires provider write capability/,
  );
});

test('Grok bounded write uses ACP permission and accepts only allowed paths', async (t) => {
  const fx = await fixture(t);
  const started = await startScenario(fx, 'grok-bounded-change', 'GROK_WRITE_ALLOWED', {
    allowedPaths: ['allowed/'],
  });
  await respondAllow(fx.registry, started.task_id);
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'completed');
  assert.deepEqual(done.scope.outside_paths, []);
  assert.deepEqual(done.scope.changed_paths, ['allowed/grok.txt']);
  assert.equal(await readFile(join(fx.workspace, 'allowed', 'grok.txt'), 'utf8'), 'grok allowed\n');
});

test('Grok pre-gates an outside write permission and reports scope_violation evidence', async (t) => {
  const fx = await fixture(t);
  const started = await startScenario(fx, 'grok-bounded-change', 'GROK_WRITE_OUTSIDE', {
    allowedPaths: ['allowed/'],
  });
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'scope_violation');
  assert.equal(done.error.code, 'SCOPE_VIOLATION');
  assert.equal(done.terminal_evidence.kind, 'acp_permission_denied');
  assert.equal(done.scope.prevented_attempts[0].path, 'outside-grok.txt');
  await assert.rejects(stat(join(fx.workspace, 'outside-grok.txt')), /ENOENT/);
});



test('Grok runtime monitor catches an ignored outside write that bypasses ACP permission', async (t) => {
  const fx = await fixture(t);
  const started = await startScenario(fx, 'grok-bounded-change', 'GROK_WRITE_IGNORED_DIRECT', {
    allowedPaths: ['allowed/'],
  });
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'scope_violation');
  assert.equal(done.error.code, 'SCOPE_VIOLATION');
  assert.ok(done.scope.prevented_attempts.some((attempt) => attempt.path === 'ignored-grok.txt'));
  assert.equal(await readFile(join(fx.workspace, 'ignored-grok.txt'), 'utf8'), 'grok ignored outside\n');
});

test('Grok restart reconciliation reattaches the exact session without duplicate task submission', async (t) => {
  const fx = await fixture(t);
  const started = await startScenario(fx, 'grok-readonly-advice', 'HANG');
  const restarted = new ConnectorRegistry({
    configPath: fx.configPath,
    env: fx.env,
    spawnImpl: fx.spawnImpl,
    processRunningImpl: async () => false,
  });
  await restarted.initialize();
  assert.equal((await restarted.status(started.task_id)).state, 'unknown_after_restart');
  const reconciled = await restarted.control(started.task_id, { action: 'reconcile' });
  assert.equal(reconciled.state, 'needs_attention');
  assert.equal(reconciled.error.code, 'RECOVERED_RUN_STATE_UNKNOWN');
  assert.equal(reconciled.remote_identity.session_id, started.remote_identity.session_id);
  const cancelling = await restarted.control(started.task_id, {
    action: 'cancel', confirm: true,
    expected_session_id: started.remote_identity.session_id,
    expected_run_id: started.remote_identity.run_id,
  });
  assert.equal(cancelling.state, 'cancelling');
  const stored = JSON.parse(await readFile(join(fx.root, 'connector-tasks.json'), 'utf8'));
  assert.equal(stored.tasks.length, 1);
  await restarted.control(started.task_id, {
    action: 'abandon', confirm: true, acknowledge_may_still_run: true,
    reason: 'fixture cleanup after reconciled cancellation',
  });
});

test('Cursor launches through CDP, binds exact agent identity, and completes read-only work', async (t) => {
  const fx = await fixture(t);
  const started = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_NORMAL');
  assert.equal(started.connector, 'cursor_cdp');
  assert.match(started.remote_identity.agent_id, /^local:/);
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'completed');
  assert.equal(done.scope.unchanged, true);
  assert.equal(done.terminal_evidence.kind, 'stable_cursor_reply');
  const launch = JSON.parse((await readFile(fx.cursorLog, 'utf8')).trim().split('\n')[0]);
  assert.ok(launch.args.includes(`--remote-debugging-port=${fx.cursorPort}`));
  assert.ok(launch.args.includes(`--remote-allow-origins=http://localhost:${fx.cursorPort}`));
  assert.equal(launch.workspace, fx.workspace);
});

test('Cursor launch waits for verified identity and a usable target after CDP HTTP becomes ready', async (t) => {
  const fx = await fixture(t, { envOverrides: { FAKE_CURSOR_IDENTITY_DELAY_MS: '350' } });
  const started = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_NORMAL');
  assert.match(started.remote_identity.agent_id, /^local:/);
  assert.equal((await fx.registry.status(started.task_id, 5000)).state, 'completed');
});

test('Cursor Agents panel binds the exact composer identity exposed only after submission', async (t) => {
  const fx = await fixture(t, { envOverrides: { FAKE_CURSOR_UI_PROFILE: 'agents_panel' } });
  const started = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_NORMAL');
  assert.match(started.remote_identity.agent_id, /^local:33333333-/);
  assert.equal((await fx.registry.status(started.task_id, 5000)).state, 'completed');
});

test('Cursor Agents panel creates a fresh exact composer for each sequential task', async (t) => {
  const fx = await fixture(t, { envOverrides: { FAKE_CURSOR_UI_PROFILE: 'agents_panel' } });
  const first = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_NORMAL');
  assert.equal((await fx.registry.status(first.task_id, 5000)).state, 'completed');
  const second = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_NORMAL');
  assert.equal((await fx.registry.status(second.task_id, 5000)).state, 'completed');
  assert.notEqual(second.remote_identity.agent_id, first.remote_identity.agent_id);
});

test('Cursor bounded write completes for an allowed path and reports the observed path', async (t) => {
  const fx = await fixture(t);
  const started = await startScenario(fx, 'cursor-bounded-change', 'CURSOR_WRITE_ALLOWED', {
    allowedPaths: ['allowed/'],
  });
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'completed');
  assert.deepEqual(done.scope.changed_paths, ['allowed/cursor.txt']);
  assert.deepEqual(done.scope.outside_paths, []);
});

test('Cursor outside modification is rejected at acceptance with observable changed-path evidence', async (t) => {
  const fx = await fixture(t);
  const started = await startScenario(fx, 'cursor-bounded-change', 'CURSOR_WRITE_OUTSIDE', {
    allowedPaths: ['allowed/'],
  });
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'scope_violation');
  assert.equal(done.error.code, 'SCOPE_VIOLATION');
  assert.deepEqual(done.scope.outside_paths, ['outside.txt']);
  assert.equal(done.result, null);
});



test('Cursor runtime monitor catches ignored outside writes before Sol acceptance', async (t) => {
  const fx = await fixture(t);
  const started = await startScenario(fx, 'cursor-bounded-change', 'CURSOR_WRITE_IGNORED', {
    allowedPaths: ['allowed/'],
  });
  const done = await fx.registry.status(started.task_id, 5000);
  assert.equal(done.state, 'scope_violation');
  assert.equal(done.error.code, 'SCOPE_VIOLATION');
  assert.ok(done.scope.prevented_attempts.some((attempt) => attempt.path === 'ignored-secret.txt'));
  assert.equal(await readFile(join(fx.workspace, 'ignored-secret.txt'), 'utf8'), 'cursor ignored outside\n');
});

test('Cursor cancellation requires the exact returned agent identity', async (t) => {
  const fx = await fixture(t);
  const started = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_WAIT_CANCEL');
  await assert.rejects(
    fx.registry.control(started.task_id, {
      action: 'cancel', confirm: true, expected_agent_id: 'local:wrong',
    }),
    /expected_agent_id does not match/,
  );
  const done = await fx.registry.control(started.task_id, {
    action: 'cancel', confirm: true,
    expected_agent_id: started.remote_identity.agent_id,
  });
  assert.equal(done.state, 'cancelled');
  assert.equal(done.terminal_evidence.kind, 'exact_cursor_stop');
});

test('Cursor timeout remains unconfirmed and restart reconcile reuses the exact agent', async (t) => {
  const fx = await fixture(t);
  const config = await loadConfig({ configPath: fx.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  config.providers.find((item) => item.id === 'cursor-local').config.task_timeout_ms = 1000;
  await saveConfig(config, { configPath: fx.configPath });
  const started = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_HANG');
  await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
  assert.equal((await fx.registry.status(started.task_id)).error.code, 'TIMEOUT_UNCONFIRMED');
  const restarted = new ConnectorRegistry({
    configPath: fx.configPath,
    env: fx.env,
    spawnImpl: fx.spawnImpl,
    processRunningImpl: async () => false,
  });
  await restarted.initialize();
  assert.equal((await restarted.status(started.task_id)).state, 'unknown_after_restart');
  const reconciled = await restarted.control(started.task_id, { action: 'reconcile' });
  assert.equal(reconciled.state, 'running');
  assert.equal(reconciled.remote_identity.agent_id, started.remote_identity.agent_id);
  const cancelled = await restarted.control(started.task_id, {
    action: 'cancel', confirm: true,
    expected_agent_id: started.remote_identity.agent_id,
  });
  assert.equal(cancelled.state, 'cancelled');
  const stored = JSON.parse(await readFile(join(fx.root, 'connector-tasks.json'), 'utf8'));
  assert.equal(stored.tasks.length, 1);
});

test('Cursor Agents panel restart reconcile reattaches the exact visible composer without history', async (t) => {
  const fx = await fixture(t, { envOverrides: { FAKE_CURSOR_UI_PROFILE: 'agents_panel' } });
  const config = await loadConfig({ configPath: fx.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  config.providers.find((item) => item.id === 'cursor-local').config.task_timeout_ms = 1000;
  await saveConfig(config, { configPath: fx.configPath });
  const started = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_HANG');
  await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
  assert.equal((await fx.registry.status(started.task_id)).error.code, 'TIMEOUT_UNCONFIRMED');

  const restarted = new ConnectorRegistry({
    configPath: fx.configPath,
    env: fx.env,
    spawnImpl: fx.spawnImpl,
    processRunningImpl: async () => false,
  });
  await restarted.initialize();
  const reconciled = await restarted.control(started.task_id, { action: 'reconcile' });
  assert.equal(reconciled.state, 'running');
  assert.equal(reconciled.remote_identity.agent_id, started.remote_identity.agent_id);
  assert.equal(reconciled.remote_identity.ui_flavor, 'agents_panel');
  const cancelled = await restarted.control(started.task_id, {
    action: 'cancel', confirm: true,
    expected_agent_id: started.remote_identity.agent_id,
  });
  assert.equal(cancelled.state, 'cancelled');
});

test('Cursor transport loss redacts credential-shaped process diagnostics', async (t) => {
  const fx = await fixture(t);
  const started = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_STDERR_SECRET');
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  const observed = await fx.registry.status(started.task_id);
  assert.equal(observed.state, 'needs_attention');
  assert.equal(observed.error.code, 'TRANSPORT_LOST');
  const serialized = JSON.stringify(observed);
  assert.doesNotMatch(serialized, /cursor-secret|cursor-token/);
  assert.match(serialized, /\[redacted\]/);
  await fx.registry.control(started.task_id, {
    action: 'abandon', confirm: true, acknowledge_may_still_run: true,
    reason: 'fixture cleanup',
  });
});


test('Cursor reuses an already attached verified CDP process without launching a second process', async (t) => {
  const fx = await fixture(t);
  const first = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_NORMAL');
  assert.equal((await fx.registry.status(first.task_id, 5000)).state, 'completed');
  const second = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_NORMAL');
  assert.equal((await fx.registry.status(second.task_id, 5000)).state, 'completed');
  assert.notEqual(first.remote_identity.agent_id, second.remote_identity.agent_id);
  const launches = (await readFile(fx.cursorLog, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(launches.length, 1);
});

test('Cursor launch_if_closed=false fails before process launch', async (t) => {
  const fx = await fixture(t, { cursorLaunchIfClosed: false });
  await assert.rejects(
    startScenario(fx, 'cursor-readonly-advice', 'CURSOR_NORMAL'),
    /configured not to launch it automatically/,
  );
  await assert.rejects(stat(fx.cursorLog), /ENOENT/);
});

test('Cursor already running without CDP is never force-closed or relaunched', async (t) => {
  const fx = await fixture(t, { processRunningImpl: async () => true });
  await assert.rejects(
    startScenario(fx, 'cursor-readonly-advice', 'CURSOR_NORMAL'),
    /already running without the required CDP port/,
  );
  await assert.rejects(stat(fx.cursorLog), /ENOENT/);
});


test('Grok Leader process loss becomes an explicit needs_attention state', async (t) => {
  const fx = await fixture(t, { envOverrides: { FAKE_GROK_LEADER_EXIT_MS: '500' } });
  const started = await startScenario(fx, 'grok-readonly-advice', 'HANG');
  const attention = await fx.registry.status(started.task_id, 5000);
  assert.equal(attention.state, 'needs_attention');
  assert.equal(attention.error.code, 'TRANSPORT_EXITED');
  assert.match(attention.error.message, /leader process exited/);
  await fx.registry.control(started.task_id, {
    action: 'abandon', confirm: true, acknowledge_may_still_run: true,
    reason: 'fixture cleanup after Leader loss',
  });
});




test('scope guard rejects a direct commit even when changed files are otherwise allowed', async (t) => {
  const fx = await fixture(t);
  const baseline = await captureWorkspaceSnapshot(fx.workspace);
  await writeFile(join(fx.workspace, 'tracked.txt'), 'committed by submodel\n');
  await execFileAsync('git', ['-C', fx.workspace, 'add', 'tracked.txt']);
  await execFileAsync('git', ['-C', fx.workspace, 'commit', '-qm', 'submodel commit']);
  const scope = await verifyWorkspaceScope(fx.workspace, baseline, {
    readOnly: false,
    allowedPaths: ['tracked.txt'],
  });
  assert.equal(scope.compliant, false);
  assert.ok(scope.metadata_changes.includes('<git-head>'));
  assert.ok(scope.metadata_changes.includes('<git-reflog>'));
  assert.notEqual(scope.baseline_digest, scope.observed_digest);
});

test('allowed_paths rejects escape, absolute, glob, and whole-workspace boundaries before launch', async (t) => {
  const fx = await fixture(t);
  const invalid = [
    ['../escape'],
    [fx.workspace],
    ['src/*.js'],
    ['.'],
  ];
  for (const allowedPaths of invalid) {
    await assert.rejects(
      startScenario(fx, 'cursor-bounded-change', 'MUST_NOT_START', { allowedPaths }),
      /allowed path|allowed_paths|workspace-relative|must not contain a glob|entire workspace/i,
    );
  }
  await assert.rejects(stat(fx.cursorLog), /ENOENT/);
});


test('connector probe is non-dispatching and workspace-aware for both providers', async (t) => {
  const fx = await fixture(t);
  const config = await loadConfig({ configPath: fx.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  const grok = await fx.registry.probe(config.providers.find((provider) => provider.id === 'grok-local'), {
    workspace: fx.workspace,
  });
  assert.equal(grok.connector, 'grok_acp');
  assert.equal(grok.state, 'available');
  assert.equal(grok.ready, false);
  const cursorBefore = await fx.registry.probe(config.providers.find((provider) => provider.id === 'cursor-local'), {});
  assert.equal(cursorBefore.connector, 'cursor_cdp');
  assert.equal(cursorBefore.state, 'available');
  assert.equal(cursorBefore.ready, false);
  await assert.rejects(stat(fx.cursorLog), /ENOENT/);

  const started = await startScenario(fx, 'cursor-readonly-advice', 'CURSOR_NORMAL');
  assert.equal((await fx.registry.status(started.task_id, 5000)).state, 'completed');
  const cursorReady = await fx.registry.probe(config.providers.find((provider) => provider.id === 'cursor-local'), {
    workspace: fx.workspace,
  });
  assert.equal(cursorReady.state, 'ready');
  assert.equal(cursorReady.ready, true);
  assert.equal(cursorReady.observed.workspace, fx.workspace);
});
