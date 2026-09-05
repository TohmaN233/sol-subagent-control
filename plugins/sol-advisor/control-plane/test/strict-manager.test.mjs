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
import { importCoarseSkill } from '../lib/skill-import/coarse-compiler.mjs';
import { digest } from '../lib/workflow-revisions.mjs';

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

test('human recovery fences and closes a waiting Strict session with rotated audit authority', async t => {
  const f = await fixture(t, { authenticated: false }); await f.service.call('dispatch', f.args);
  const state = await f.service.call('get', { run_id: f.run.run_id });
  const adopted = await f.service.call('adopt_run', { run_id: f.run.run_id, expected_sequence: state.sequence, reason: 'Synthetic lost console', main_actor: 'human-console' }, { human: true });
  assert.deepEqual(adopted.recovery_errors, []); assert.equal(adopted.nodes.work.status, 'interrupted'); assert(f.sessions[0].closed);
  assert.equal(f.entry(f.args).status, 'stopped');
  await assert.rejects(f.service.call('strict_login', f.args, { human: true }), { code: 'RUN_AUTHORITY' });
  await assert.rejects(f.service.call('recover_strict_result', { run_id: adopted.run_id, control_token: adopted.control_token, node_id: 'work', attempt_id: f.args.attempt_id }), { code: 'STRICT_RESULT_PENDING' });
  assert.equal(f.sessions[0].calls, 0);
});

test('a durable final Strict proposal survives controller loss and reattaches without another model call', async t => {
  const f = await fixture(t); await f.service.call('dispatch', f.args); await f.entry(f.args).job;
  const final = await f.claim('final'); await f.service.call('dispatch', final); await f.entry(final).job;
  const before = await f.service.call('get', { run_id: f.run.run_id });
  const adopted = await f.service.call('adopt_run', { run_id: f.run.run_id, expected_sequence: before.sequence, reason: 'Synthetic final review recovery', main_actor: 'human-console' }, { human: true }); assert.deepEqual(adopted.recovery_errors, []);
  const restored = await f.service.call('recover_strict_result', { run_id: adopted.run_id, control_token: adopted.control_token, node_id: 'final', attempt_id: final.attempt_id });
  await f.service.call('resume', { run_id: adopted.run_id, control_token: adopted.control_token });
  const args = { ...restored.envelope, control_token: adopted.control_token };
  assert.equal((await f.service.call('collect_strict', args)).final_acceptance_required, true);
  const completed = await f.service.call('collect_strict', { ...args, accepted: true }); assert.equal(completed.status, 'succeeded');
  assert.equal(f.sessions.reduce((sum, session) => sum + session.calls, 0), 2); assert.equal(completed.nodes.final.attempts.length, 1);
});

test('Strict child service dispatch reads its pinned Pack and collects only accepted output into its parent', async t => {
  const f = await fixture(t); const childPack = await f.service.call('read', { workflow_id: 'strict-test' });
  const parentWorkflow = structuredClone(childPack.workflow); parentWorkflow.id = 'strict-parent';
  Object.assign(parentWorkflow.nodes[1], { type: 'subworkflow', executor: { kind: 'subworkflow' }, input_bindings: { task: '/inputs/task' },
    subworkflow: { workflow_id: childPack.workflow.id, revision_pin: childPack.revision_hash, output_bindings: { child_result: '/output' } } });
  await f.service.call('create', { workflow: parentWorkflow, resources: { 'pinned.txt': 'Immutable task instructions' } });
  const parent = await f.service.call('start', { workflow_id: parentWorkflow.id, workspace: f.workspace, access: 'read_only', main_actor: 'root', inputs: { task: 'Nested synthetic task' } });
  const claimFor = async (run, nodeId) => {
    const lease = await f.service.call('claim_node', { run_id: run.run_id, control_token: run.control_token, node_id: nodeId, owner: nodeId === 'final' ? 'root' : 'worker', request_id: 'claim-' + nodeId });
    return { run_id: run.run_id, control_token: run.control_token, node_id: nodeId, attempt_id: lease.attempt_id, lease_token: lease.lease_token };
  };
  const parentArgs = await claimFor(parent, 'work');
  await f.service.call('delete', { workflow_id: childPack.workflow.id, expected_revision: childPack.revision_hash });
  const child = (await f.service.call('dispatch', parentArgs)).child;
  assert.equal(f.sessions.length, 0);
  for (const nodeId of ['work', 'final']) {
    const request = await claimFor(child, nodeId); await f.service.call('dispatch', request); await f.entry(request).job;
    if (nodeId === 'final') await f.service.call('collect_strict', { ...request, accepted: true });
  }
  const collected = await f.service.call('collect_subworkflow', parentArgs);
  assert.deepEqual(collected.nodes.work.output, { child_result: { text: 'Synthetic result' } }); assert.equal(f.sessions.length, 2);
  assert(f.sessions.every(session => !session.prompt.includes(parent.control_token) && !session.prompt.includes(child.control_token)));
  const finalArgs = await claimFor(parent, 'final'); await f.service.call('dispatch', finalArgs); await f.entry(finalArgs).job;
  assert.equal((await f.service.call('collect_strict', { ...finalArgs, accepted: true })).status, 'succeeded');
});

test('streamed output is a bounded unverified preview and only progress metadata enters the durable journal', async t => {
  const ready = deferred(); const release = deferred(); const marker = 'PREVIEW_ONLY_DO_NOT_JOURNAL_';
  t.after(() => release.resolve());
  const f = await fixture(t, { async turn(settings) {
    await settings.onOutput({ delta: marker + 'x'.repeat(40000) });
    await settings.onOutput({ delta: 'TAIL' }); ready.resolve(); await release.promise;
    return { output: 'Accepted durable result', thread_id: 'fixture-thread', turn_id: 'fixture-turn', audit: { fixture: true } };
  } });
  await f.service.call('dispatch', f.args);
  await Promise.race([ready.promise, f.entry(f.args).job.then(() => { throw new Error(JSON.stringify(f.entry(f.args).error ?? 'Turn ended before preview')); })]);
  const live = await f.service.call('strict_status', f.args);
  assert.equal(live.output_preview.text.length, 32768); assert(live.output_preview.text.endsWith('TAIL'));
  assert.equal(live.output_preview.characters, marker.length + 40004); assert.equal(live.output_preview.truncated, true);
  assert.equal(live.output_preview.verified, false); assert.equal(live.output_preview.durable, false);
  const { runtime } = await f.service.open(); const events = JSON.stringify((await runtime.runs.read(f.run.run_id)).events);
  assert(events.includes('output_progress')); assert(!events.includes(marker)); assert(!events.includes('TAIL'));
  release.resolve(); await f.entry(f.args).job;
  assert.deepEqual((await f.service.call('get', f.args)).nodes.work.output, { text: 'Accepted durable result' });
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

test('selected-Provider expansion uses durable read-only execution and applies only an accepted exact-revision Draft', async t => {
  let proposal;
  const f = await fixture(t, { turn: async settings => {
    assert.equal(settings.toolBroker.tools().some(tool => tool.name === 'write_workspace'), false);
    const packet = await settings.toolBroker.call('read_workflow_resource', { path: 'analysis/request.txt' }, 'read-plan');
    assert(JSON.parse(packet.contentItems[0].text).text.includes(proposal.source_revision));
    return { output: JSON.stringify(proposal), thread_id: 'planning-thread', turn_id: 'planning-turn', audit: {} };
  } });
  const source = join(f.root, 'expansion-source'); await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), '---\nname: plan\ndescription: planning fixture\n---\nAnalyze the task and return a result.');
  const { store } = await f.service.open(); const config = await f.service.config();
  const providers = config.providers.filter(item => item.enabled && item.kind === 'native_agent'); assert(providers.length >= 2);
  const pack = await importCoarseSkill(store, join(source, 'SKILL.md'), { id: 'source-draft', providerId: providers[0].id, role: providers[0].config.role });
  const origin = { confidence: 0.8, source_span: { resource: 'source/SKILL.md', start_line: 5, end_line: 5 } };
  proposal = { source_revision: pack.revision_hash, nodes: [{ id: 'analyze', type: 'agent', prompt_template: 'Analyze {{task}}', ...origin }],
    edges: [{ id: 'start-analyze', source: 'start', target: 'analyze', ...origin }, { id: 'analyze-final', source: 'analyze', target: 'final', ...origin }] };
  const planning = await f.service.call('create_expansion_run', { workflow_id: pack.workflow.id, revision_hash: pack.revision_hash, provider_id: providers[1].id,
    run_id: 'planning-job', workspace: f.workspace, main_actor: 'root' });
  const apply = { run_id: planning.run_id, control_token: planning.control_token, workflow_id: pack.workflow.id, expected_revision: pack.revision_hash };
  await assert.rejects(f.service.call('apply_expansion_result', apply), { code: 'EXPANSION_ACCEPTANCE_REQUIRED' });
  for (const node of ['expand', 'final']) {
    const lease = await f.service.call('claim_node', { run_id: planning.run_id, control_token: planning.control_token, node_id: node, owner: node === 'final' ? 'root' : 'planner', request_id: 'claim-' + node });
    if (node === 'expand') assert.equal(lease.provider.id, providers[1].id);
    const args = { run_id: planning.run_id, control_token: planning.control_token, node_id: node, attempt_id: lease.attempt_id, lease_token: lease.lease_token };
    await f.service.call('dispatch', args); await f.entry(args).job;
    if (node === 'final') await f.service.call('collect_strict', { ...args, accepted: true });
  }
  assert.equal(f.sessions.length, 2); assert.equal((await store.snapshot(pack.workflow.id)).revision_hash, pack.revision_hash);
  const expanded = await f.service.call('apply_expansion_result', apply);
  assert.equal(expanded.workflow.status, 'draft'); assert.equal(expanded.workflow.nodes.find(node => node.id === 'analyze').executor.provider_id, providers[0].id);
  assert(expanded.workflow.import_status.unresolved.some(item => item.code === 'AI_INFERENCES_REQUIRE_REVIEW'));
  await assert.rejects(f.service.call('apply_expansion_result', apply), { code: 'REVISION_CONFLICT' }); assert.equal(f.sessions.length, 2);
});

test('SkillRef nodes materialize only their Run-pinned source and references after the linked original disappears', async t => {
  let invoked;
  const f = await fixture(t, { turn: async settings => {
    invoked = settings; assert.equal(settings.allowedSkills.length, 1);
    assert.equal(settings.allowedSkills[0].files['reference.txt'].toString(), 'Pinned reference');
    const tools = settings.toolBroker.tools(); const resource = tools.find(tool => tool.name === 'read_workflow_resource').inputSchema.properties.path.enum.find(path => path.endsWith('/reference.txt'));
    assert.equal(JSON.parse((await settings.toolBroker.call('read_workflow_resource', { path: resource }, 'read-reference')).contentItems[0].text).text, 'Pinned reference');
    return { output: 'Skill complete', thread_id: 'skill-thread', turn_id: 'skill-turn', audit: {} };
  } });
  const source = join(f.root, 'linked-source'); await mkdir(source); const path = join(source, 'SKILL.md');
  const text = '---\nname: linked\ndescription: Linked fixture\n---\nRead [the reference](reference.txt) and apply the user task.';
  await writeFile(path, text); await writeFile(join(source, 'reference.txt'), 'Pinned reference');
  const pack = await f.service.call('read', { workflow_id: 'strict-test' }); const workflow = structuredClone(pack.workflow);
  const work = workflow.nodes.find(node => node.id === 'work'); work.type = 'skill_ref'; work.skill_ref = { path, name: 'linked', source_hash: digest(text), allowed_nested_skills: [] }; delete work.prompt_template;
  const saved = await f.service.call('save', { workflow_id: workflow.id, workflow, expected_revision: pack.revision_hash });
  const started = await f.service.call('start', { workflow_id: workflow.id, revision_hash: saved.revision_hash, workspace: f.workspace, main_actor: 'root', access: 'read_only', inputs: { task: 'Pinned Skill task' } });
  await rm(source, { recursive: true });
  const lease = await f.service.call('claim_node', { run_id: started.run_id, control_token: started.control_token, node_id: 'work', owner: 'worker', request_id: 'skill-claim' });
  const args = { run_id: started.run_id, control_token: started.control_token, node_id: 'work', attempt_id: lease.attempt_id, lease_token: lease.lease_token };
  await f.service.call('dispatch', args); await f.entry(args).job;
  assert.equal((await f.service.call('get', args)).nodes.work.status, 'succeeded'); assert.equal(invoked.allowedSkills[0].source_path, path);
  await assert.rejects(f.service.call('start', { workflow_id: workflow.id, workspace: f.workspace, main_actor: 'root', access: 'read_only' }), { code: 'ENOENT' });
});

test('Inline converts a linked node to an independently runnable Draft without changing its Provider or paths', async t => {
  const f = await fixture(t, { turn: async settings => {
    assert.deepEqual(settings.allowedSkills, []);
    const resource = await settings.toolBroker.call('read_workflow_resource', { path: 'inline/work/root/reference.txt' }, 'inlined-reference');
    assert.equal(JSON.parse(resource.contentItems[0].text).text, 'Independent reference');
    return { output: 'Inlined result', thread_id: 'inline-thread', turn_id: 'inline-turn', audit: {} };
  } });
  const source = join(f.root, 'inline-source'); await mkdir(source); const path = join(source, 'SKILL.md');
  const text = '---\nname: inline-me\ndescription: Inline fixture\n---\nRead [reference](reference.txt) and apply the task.';
  await writeFile(path, text); await writeFile(join(source, 'reference.txt'), 'Independent reference');
  const pack = await f.service.call('read', { workflow_id: 'strict-test' }); const workflow = structuredClone(pack.workflow); const work = workflow.nodes.find(node => node.id === 'work');
  work.type = 'skill_ref'; work.skill_ref = { path, name: 'inline-me', source_hash: digest(text), allowed_nested_skills: [] };
  const linked = await f.service.call('save', { workflow_id: workflow.id, workflow, expected_revision: pack.revision_hash });
  const inlined = await f.service.call('inline_skill', { workflow_id: workflow.id, node_id: 'work', expected_revision: linked.revision_hash });
  assert.equal(inlined.workflow.status, 'draft'); assert.equal(inlined.workflow.nodes.find(node => node.id === 'work').skill_ref, undefined);
  assert.deepEqual(inlined.workflow.nodes.find(node => node.id === 'work').executor, work.executor);
  await rm(source, { recursive: true });
  const review = await f.service.call('import_review', { workflow_id: workflow.id });
  const reviewed = await f.service.call('review_import', { workflow_id: workflow.id, expected_revision: inlined.revision_hash,
    decisions: review.issues.map(issue => ({ issue_id: issue.id, resolution: 'resolved', note: 'Verified the copied instruction and reference mapping' })) }, { human: true });
  await f.service.call('save', { workflow_id: workflow.id, workflow: { ...reviewed.workflow, status: 'ready' }, expected_revision: reviewed.revision_hash });
  const started = await f.service.call('start', { workflow_id: workflow.id, workspace: f.workspace, access: 'read_only', main_actor: 'root', inputs: { task: 'Run the inlined fixture' } });
  const lease = await f.service.call('claim_node', { run_id: started.run_id, control_token: started.control_token, node_id: 'work', owner: 'worker', request_id: 'inline-claim' });
  const args = { run_id: started.run_id, control_token: started.control_token, node_id: 'work', attempt_id: lease.attempt_id, lease_token: lease.lease_token };
  await f.service.call('dispatch', args); await f.entry(args).job; assert.equal((await f.service.call('get', args)).nodes.work.status, 'succeeded');
});
