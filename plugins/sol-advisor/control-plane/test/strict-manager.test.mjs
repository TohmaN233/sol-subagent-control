import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkflowService } from '../lib/workflow-service.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';
import { createDraft } from '../lib/workflow-schema.mjs';
import { StrictSessionManager } from '../lib/execution/strict-session-manager.mjs';
import { validateStrictConfig, qualifiedStrictSettings } from '../lib/execution/strict-config.mjs';
import { DEFAULT_CONFIG_PATH } from '../server.mjs';
import { randomUUID } from 'node:crypto';
import { processIdentity } from '../lib/execution/codex-process-ownership.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'strict-manager-')); const workspace = join(root, 'workspace'); await mkdir(workspace);
  const configPath = join(root, 'control-plane.json'); let service; const sessions = [];
  await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  const manager = new StrictSessionManager({ configPath, getConfig: () => service.config(), env: {},
    qualify: async config => validateStrictConfig(config.strict_executor),
    sessionFactory: async settings => {
      if (options.preparing) await options.preparing();
      const stopped = deferred(); const session = { settings, calls: 0, closed: false, client: { events: [] },
        async authentication() { return { authenticated: options.authenticated !== false }; },
        async turn(prompt) {
          session.calls++; session.prompt = prompt;
          if (options.turn) return options.turn(settings, session, stopped.promise);
          const resource = await settings.toolBroker.call('read_workflow_resource', { path: 'pinned.txt' }, 'resource-read');
          assert.equal(JSON.parse(resource.contentItems[0].text).text, 'Immutable task instructions');
          return { output: 'Synthetic result', thread_id: 'fixture-thread', turn_id: 'fixture-turn', audit: { fixture: true } };
        },
        async close() { session.closed = true; settings.toolBroker.revoke(); stopped.resolve(); },
      }; sessions.push(session);
      await settings.onProfilePrepared({ home: join(root, 'fake-profile'), binary_sha256: 'a'.repeat(64) });
      return session;
    },
  });
  service = new WorkflowService({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {}, capabilities: { strictManager: manager } });
  await service.call('migrate_v6', {}, { human: true });
  const config = await service.config(); config.strict_executor = validateStrictConfig({ enabled: true, codex_binary: join(root, 'never-executed'), binary_sha256: 'a'.repeat(64) });
  await saveConfig(config, { configPath });
  const provider = config.providers.find(item => item.enabled && item.kind === 'native_agent');
  const workflow = { ...createDraft('strict-test', 'Strict manager test'), status: 'ready', finalization: { required: true, node_id: 'final' } };
  const common = { type: 'agent', access: options.write ? 'bounded_write' : 'read_only', ...(options.write ? { path_scope: ['out.txt'] } : {}), approval: { required: false }, retry: { max_attempts: 1 }, input_bindings: {}, prompt_template: '{{task}}', resources: ['pinned.txt'] };
  workflow.nodes = [{ id: 'start', type: 'start' }, { ...common, id: 'work', role: provider.config.role, executor: { kind: 'provider', provider_id: provider.id }, ...(options.schema ? { outputs_schema: options.schema } : {}) },
    { ...common, id: 'final', role: 'finalizer', access: 'read_only', executor: { kind: 'main' } }, { id: 'end', type: 'end' }];
  workflow.edges = [['start', 'work'], ['work', 'final'], ['final', 'end']].map(([source, target]) => ({ id: source + '-' + target, source, target }));
  await service.call('create', { workflow, resources: { 'pinned.txt': 'Immutable task instructions' } });
  const run = await service.call('start', { workflow_id: workflow.id, workspace, access: options.write ? 'bounded_write' : 'read_only', ...(options.write ? { allowed_paths: ['out.txt'] } : {}), main_actor: 'root', inputs: { task: 'Synthetic only' } });
  const claim = async (node = 'work') => {
    const lease = await service.call('claim_node', { run_id: run.run_id, control_token: run.control_token, node_id: node, owner: node === 'final' ? 'root' : 'worker', request_id: 'claim-' + node });
    return { run_id: run.run_id, control_token: run.control_token, node_id: node, attempt_id: lease.attempt_id, lease_token: lease.lease_token };
  };
  const args = await claim();
  const entry = args => manager.entries.get(args.run_id + '/' + args.attempt_id);
  t.after(async () => { await manager.close(); assert(resolve(root).startsWith(resolve(tmpdir()))); await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }); });
  return { root, workspace, configPath, service, manager, sessions, run, claim, args, entry };
}

test('Strict settings are opt-in, reject secrets/unknown fields and never turn arbitrary hashes into capability', async () => {
  assert.equal(validateStrictConfig().enabled, false);
  assert.throws(() => validateStrictConfig({ authentication: { api_key: 'secret' } }), { code: 'STRICT_CONFIG' });
  assert.throws(() => validateStrictConfig({ enabled: true }), { code: 'STRICT_CONFIG' });
  assert.throws(() => validateStrictConfig({ main_model: 'gpt-5.6-luna' }), { code: 'STRICT_CONFIG' });
  await assert.rejects(qualifiedStrictSettings({ strict_executor: { enabled: true, codex_binary: resolve('fake.exe'), binary_sha256: 'a'.repeat(64) } }), { code: 'STRICT_EXECUTOR_UNQUALIFIED' });
});

test('Strict dispatch runs pinned resources exactly once and keeps final acceptance in the main controller', async t => {
  const f = await fixture(t); const dispatched = await f.service.call('dispatch', f.args);
  assert.equal(dispatched.dispatched, true); await f.entry(f.args).job;
  assert.equal((await f.service.call('strict_status', f.args)).status, 'succeeded');
  assert.equal(f.sessions[0].prompt.includes(f.run.control_token), false); assert.equal(f.sessions[0].closed, true);
  assert.equal((await f.service.call('dispatch', f.args)).idempotent, true); assert.equal(f.sessions[0].calls, 1);
  const final = await f.claim('final'); await f.service.call('dispatch', final); await f.entry(final).job;
  const proposed = await f.service.call('collect_strict', final); assert.equal(proposed.final_acceptance_required, true);
  assert.notEqual((await f.service.call('get', f.args)).status, 'succeeded');
  await assert.rejects(f.service.call('collect_strict', { ...final, control_token: 'wrong', accepted: true }), { code: 'RUN_AUTHORITY' });
  assert.equal((await f.service.call('collect_strict', { ...final, accepted: true })).status, 'succeeded');
  assert.equal((await f.service.call('collect_strict', { ...final, accepted: true })).idempotent, true);
});

test('pending managed authentication exposes status without URLs or dispatching a model; cancellation closes it', async t => {
  const f = await fixture(t, { authenticated: false }); await f.service.call('dispatch', f.args);
  assert.equal((await f.service.call('strict_status', f.args)).status, 'auth_required'); assert.equal(f.sessions[0].calls, 0);
  await assert.rejects(f.service.call('strict_login', f.args), { code: 'HUMAN_AUTHENTICATION_REQUIRED' });
  const cancelled = await f.service.call('cancel', f.args); assert.equal(cancelled.status, 'cancelled');
  assert.equal(f.sessions[0].closed, true); assert.equal(cancelled.nodes.work.attempts[0].dispatch.cancellation_pending, false);
});

test('cancellation fences a pending model write before reporting its local session stopped', async t => {
  const entered = deferred(); let writeError;
  const f = await fixture(t, { write: true, turn: async (settings, _session, stopped) => {
    entered.resolve(); await stopped;
    try { await settings.toolBroker.call('write_workspace', { path: 'out.txt', text: 'Late write', expected_sha256: null }, 'late-write'); }
    catch (error) { writeError = error; throw error; }
  } });
  await f.service.call('dispatch', f.args); await entered.promise;
  const state = await f.service.call('cancel', f.args);
  assert.equal(state.status, 'cancelled'); assert.equal(writeError.code, 'CODEX_BROKER_REVOKED');
  await assert.rejects(readFile(join(f.workspace, 'out.txt')), { code: 'ENOENT' });
});

test('pause permits an already running node to finish, while schema violations fail explicitly', async t => {
  const entered = deferred(); const released = deferred();
  const f = await fixture(t, { turn: async () => { entered.resolve(); await released.promise; return { output: 'Finished', thread_id: 't', turn_id: 'u', audit: {} }; } });
  await f.service.call('dispatch', f.args); await entered.promise; await f.service.call('pause', f.args); released.resolve(); await f.entry(f.args).job;
  const state = await f.service.call('get', f.args); assert.equal(state.status, 'paused'); assert.equal(state.nodes.work.status, 'succeeded');
  const bad = await fixture(t, { schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } });
  await bad.service.call('dispatch', bad.args); await bad.entry(bad.args).job;
  assert.equal((await bad.service.call('get', bad.args)).nodes.work.error.code, 'STRICT_OUTPUT_JSON');
});

test('a durable result survives completion failure and can be collected without another invocation or retry', async t => {
  const entered = deferred(); const released = deferred();
  const f = await fixture(t, { turn: async () => { entered.resolve(); await released.promise; return { output: 'Preserved', thread_id: 't', turn_id: 'u', audit: {} }; } });
  await f.service.call('dispatch', f.args); await entered.promise;
  f.entry(f.args).runtime.completeNode = async () => { throw Object.assign(new Error('Synthetic commit fault'), { code: 'SYNTHETIC_COMMIT_FAULT' }); };
  released.resolve(); await f.entry(f.args).job;
  assert.equal((await f.service.call('strict_status', f.args)).status, 'result_commit_failed');
  const state = await f.service.call('collect_strict', f.args); assert.equal(state.nodes.work.status, 'succeeded');
  assert.equal(state.nodes.work.attempts.length, 1); assert.equal(f.sessions[0].calls, 1);
  const proposal = state.nodes.work.attempts[0].result_proposal;
  await writeFile(join(f.entry(f.args).runtime.runs.directory(f.run.run_id), proposal.artifact), '{}');
  await assert.rejects(f.service.call('collect_strict', f.args), { code: 'EXECUTOR_RESULT_CORRUPT' });
});

test('cancelling during session preparation waits for that owned preparation to settle', async t => {
  const entered = deferred(); const released = deferred();
  const f = await fixture(t, { preparing: async () => { entered.resolve(); await released.promise; } });
  const dispatch = f.service.call('dispatch', f.args); const dispatchFailure = assert.rejects(dispatch, { code: 'STRICT_SESSION_STOPPED' });
  await entered.promise; const stopping = deferred(); const originalStop = f.manager.stopRun.bind(f.manager);
  f.manager.stopRun = id => { stopping.resolve(); return originalStop(id); };
  const cancel = f.service.call('cancel', f.args); const completed = Promise.all([dispatchFailure, cancel]);
  // Fence publication is observed before permitting session setup to return.
  await stopping.promise;
  try { assert.equal((await f.service.call('get', f.args)).status, 'cancelled'); } finally { released.resolve(); }
  const results = await completed; assert.equal(results[1].status, 'cancelled'); assert.equal(f.sessions[0].closed, true);
  assert.equal(f.sessions[0].calls, 0);
});

test('orphan cleanup selects exact Run/node/attempt ownership and refuses a live owner', async t => {
  const f = await fixture(t, { authenticated: false }); await f.service.call('dispatch', f.args);
  await f.service.call('cancel', f.args); await mkdir(f.manager.parent, { recursive: true });
  const active = join(f.manager.parent, 'strict-node-active'); const orphan = join(f.manager.parent, 'strict-node-orphan'); const other = join(f.manager.parent, 'strict-node-other');
  const identity = await processIdentity(process.pid);
  for (const home of [active, orphan, other]) {
    await mkdir(home);
    const parentIdentity = home === active ? identity : { pid: 999999999, started: 'synthetic-dead-parent', executable: process.execPath };
    await writeFile(join(home, 'owner.json'), JSON.stringify({ schema_version: 1, token: randomUUID(), parent_pid: parentIdentity.pid, parent_identity: parentIdentity, child_pid: null,
      owner: { run_id: home === other ? 'another-run' : f.run.run_id, node_id: f.args.node_id, attempt_id: f.args.attempt_id } }));
  }
  const result = await f.service.call('cleanup_strict_orphans', f.args);
  assert.deepEqual(result.cleaned, [orphan]); assert(result.blocked.some(item => item.home === active && item.code === 'PROFILE_OWNER_ACTIVE'));
  assert.equal(result.resubmitted, false); await assert.rejects(readFile(join(orphan, 'owner.json')), { code: 'ENOENT' });
  assert(await readFile(join(other, 'owner.json'))); assert(await readFile(join(active, 'owner.json')));
});
