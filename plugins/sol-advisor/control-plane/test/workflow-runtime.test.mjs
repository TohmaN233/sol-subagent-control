import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, rmdir, writeFile, readFile, appendFile, rename } from 'node:fs/promises';
import { tmpdir } from './physical-tempdir.mjs';
import { join, resolve } from 'node:path';
import { WorkflowStore } from '../lib/workflow-store.mjs';
import { WorkflowRuntime } from '../lib/workflow-runtime.mjs';
import { createDraft } from '../lib/workflow-schema.mjs';
import { canonicalJSON, digest } from '../lib/workflow-revisions.mjs';
import { decodeEvents } from '../lib/workflow-events.mjs';

const agent = id => ({ id, type: 'agent', executor: { kind: 'main' }, role: 'implementer', access: 'read_only', prompt_template: '{{task}}', approval: { required: false }, retry: { max_attempts: 3 }, input_bindings: {} });
const edge = (source, target, label) => ({ id: source + '-' + target, source, target, ...(label ? { label } : {}) });
function definition(kind = 'sequential') {
  const workflow = { ...createDraft('example', 'Runtime test'), status: 'ready', finalization: { required: true, node_id: 'final' }, skill_policy: { mode: 'cooperative', implicit: 'allow', ambient_allow: [], shadowed_skill_paths: [] } };
  const controls = kind === 'sequential' ? [agent('work')] : [
    kind === 'parallel' ? { id: 'fork', type: 'parallel', join_id: 'join', failure_policy: 'collect' } : { id: 'fork', type: 'condition', cases: [{ label: 'yes', when: { op: 'eq', args: [{ path: '/inputs/choice' }, { value: true }] } }], default_label: 'no' },
    agent('a'), agent('b'), ...(kind === 'parallel' ? [{ id: 'join', type: 'join', parallel_id: 'fork' }] : []),
  ];
  workflow.nodes = [{ id: 'start', type: 'start' }, ...controls, { ...agent('final'), role: 'finalizer' }, { id: 'end', type: 'end' }];
  workflow.edges = kind === 'sequential' ? [edge('start', 'work'), edge('work', 'final'), edge('final', 'end')] : [edge('start', 'fork'), edge('fork', 'a', 'yes'), edge('fork', 'b', 'no'), edge('a', kind === 'parallel' ? 'join' : 'final'), edge('b', kind === 'parallel' ? 'join' : 'final'), ...(kind === 'parallel' ? [edge('join', 'final')] : []), edge('final', 'end')];
  return workflow;
}
async function fixture(t, workflow = definition(), options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-runtime-')); const workspace = join(root, 'workspace'); await mkdir(workspace);
  t.after(async () => { assert(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))); await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }); });
  const store = await new WorkflowStore(join(root, 'packs'), { validationContext: options.context ?? {} }).initialize();
  await store.create(workflow, { resources: { 'instructions/task.md': 'Pinned synthetic task' } });
  const runtimeOptions = { workflowStore: store, runRoot: join(root, 'runs'), ...options };
  const runtime = await new WorkflowRuntime(runtimeOptions).initialize();
  return { root, workspace, store, runtime, runtimeOptions, start: extra => runtime.start({ workflow_id: workflow.id, workspace, access: 'read_only', main_actor: 'root', ...extra }) };
}
const payload = (output = {}, extra = {}) => ({ status: 'succeeded', summary: 'Verified by synthetic executor', structured_output: output, artifacts: [], evidence: [{ check: 'fake executor', passed: true }], changed_paths: [], outside_paths: [], ...extra });
const claim = (f, run, nodeId, extra = {}) => f.runtime.claimNode(run.run_id, { node_id: nodeId, owner: 'root', request_id: 'claim-' + nodeId, control_token: run.control_token, ...extra });
const complete = (f, run, envelope, output = {}, extra = {}) => f.runtime.completeNode(run.run_id, { node_id: envelope.node_id, attempt_id: envelope.attempt_id, lease_token: envelope.lease_token, completion: payload(output, extra) });
const control = run => ({ control_token: run.control_token });

test('executor event journal accepts narrow metadata under controller authority and never revives a cancelled lease', async t => {
  const f = await fixture(t); const run = await f.start(); const work = await claim(f, run, 'work');
  const args = { node_id: work.node_id, attempt_id: work.attempt_id, lease_token: work.lease_token, control_token: run.control_token,
    event: { kind: 'session_state', metadata: { status: 'auth_required' } } };
  await assert.rejects(f.runtime.recordExecutorEvent(run.run_id, { ...args, control_token: 'wrong' }), { code: 'RUN_AUTHORITY' });
  await assert.rejects(f.runtime.recordExecutorEvent(run.run_id, { ...args, event: { kind: 'codex_event', metadata: { authUrl: 'sensitive' } } }), { code: 'EXECUTOR_EVENT_SCHEMA' });
  await assert.rejects(f.runtime.recordExecutorEvent(run.run_id, { ...args, event: { kind: 'session_state', metadata: { status: { authUrl: 'sensitive' } } } }), { code: 'EXECUTOR_EVENT_SCHEMA' });
  await f.runtime.recordExecutorEvent(run.run_id, args);
  await f.runtime.cancel(run.run_id, control(run));
  await f.runtime.recordExecutorEvent(run.run_id, { ...args, event: { kind: 'session_state', metadata: { status: 'cancelled' } } });
  const state = await f.runtime.get(run.run_id); assert.equal(state.status, 'cancelled'); assert.equal(state.nodes.work.attempts[0].executor_event_count, 2);
  await assert.rejects(f.runtime.execution(run.run_id, args), { code: 'STALE_LEASE' });
});

test('concurrent local executors serialize one Run journal across runtime instances without losing events', async t => {
  const f = await fixture(t, definition('parallel')); const run = await f.start();
  const other = await new WorkflowRuntime(f.runtimeOptions).initialize();
  const [a, b] = await Promise.all(['a', 'b'].map(node => claim(f, run, node)));
  const calls = Array.from({ length: 24 }, (_, index) => {
    const lease = index % 2 ? a : b; const runtime = index % 2 ? f.runtime : other;
    return runtime.recordExecutorEvent(run.run_id, { node_id: lease.node_id, attempt_id: lease.attempt_id, lease_token: lease.lease_token, control_token: run.control_token,
      event: { kind: 'session_state', metadata: { status: 'synthetic-' + index } } });
  });
  await Promise.all(calls);
  const state = await other.get(run.run_id); assert.equal(state.nodes.a.attempts[0].executor_event_count, 12); assert.equal(state.nodes.b.attempts[0].executor_event_count, 12);
  const events = await other.events(run.run_id, control(run)); assert.equal(events.filter(event => event.kind === 'executor_event').length, 24);
});

test('journal releases sequential nodes, binds leases, rejects conflicting duplicates and requires main acceptance', async t => {
  const f = await fixture(t); const run = await f.start();
  assert.deepEqual((await f.runtime.next(run.run_id)).ready, ['work']);
  await assert.rejects(claim(f, run, 'final'), { code: 'NODE_NOT_READY' });
  await assert.rejects(claim(f, run, 'work', { control_token: 'wrong' }), { code: 'RUN_AUTHORITY' });
  await assert.rejects(claim(f, run, 'work', { owner: 'worker' }), { code: 'FINALIZER_AUTHORITY' });
  const work = await claim(f, run, 'work');
  const same = await claim(f, run, 'work'); assert.equal(same.idempotent, true); assert.equal(same.lease_token, work.lease_token);
  await assert.rejects(complete(f, run, { ...work, lease_token: 'wrong' }), { code: 'LEASE_INVALID' });
  const done = await complete(f, run, work, { value: 42 });
  assert.equal(done.nodes.work.status, 'succeeded'); assert.equal(done.nodes.final.status, 'ready');
  assert.equal((await complete(f, run, work, { value: 42 })).sequence, done.sequence);
  await assert.rejects(complete(f, run, work, { value: 43 }), { code: 'COMPLETION_CONFLICT' });
  const final = await claim(f, run, 'final');
  await assert.rejects(complete(f, run, final), { code: 'FINAL_ACCEPTANCE_REQUIRED' });
  assert.equal((await complete(f, run, final, {}, { acceptance: { accepted: true } })).status, 'succeeded');
  const publicState = await f.runtime.get(run.run_id); assert.equal(publicState.control_hash, undefined); assert.equal(publicState.nodes.work.attempts[0].lease_hash, undefined);
  const events = await f.runtime.events(run.run_id, { ...control(run), after_sequence: 1 }); assert.deepEqual(events.map(e => e.kind), ['claim', 'complete', 'claim', 'complete']);
});

test('conditional skip and control failures persist without losing upstream completion', async t => {
  const f = await fixture(t, definition('condition')); const run = await f.start({ inputs: { choice: false } });
  assert.equal(run.nodes.a.status, 'skipped'); assert.deepEqual((await f.runtime.next(run.run_id)).ready, ['b']);
  await complete(f, run, await claim(f, run, 'b')); assert.deepEqual((await f.runtime.next(run.run_id)).ready, ['final']);
  const w = definition('condition'); w.nodes.splice(1, 0, agent('work')); w.edges = w.edges.filter(e => e.source !== 'start'); w.edges.push(edge('start', 'work'), edge('work', 'fork'));
  w.nodes.find(n => n.id === 'fork').cases[0].when = { op: 'eq', args: [{ path: '/nodes/work/output/missing' }, { value: true }] };
  const f2 = await fixture(t, w); const r2 = await f2.start();
  const result = await complete(f2, r2, await claim(f2, r2, 'work'));
  assert.equal(result.status, 'failed'); assert.equal(result.nodes.work.status, 'succeeded'); assert.equal(result.nodes.fork.status, 'failed'); assert.equal(result.nodes.fork.error.code, 'CONDITION_INPUT_MISSING');
  const restarted = await new WorkflowRuntime(f2.runtimeOptions).initialize(); assert.equal((await restarted.get(r2.run_id)).nodes.work.status, 'succeeded');
});

test('parallel collect waits for all branches and exposes failure at main acceptance', async t => {
  const f = await fixture(t, definition('parallel')); const run = await f.start();
  assert.deepEqual((await f.runtime.next(run.run_id)).ready, ['a', 'b']);
  const a = await claim(f, run, 'a'); const b = await claim(f, run, 'b');
  await f.runtime.failNode(run.run_id, { ...a, error: { code: 'SYNTHETIC', message: 'Expected failure' } });
  assert.equal((await f.runtime.get(run.run_id)).nodes.join.status, 'pending');
  const result = await complete(f, run, b);
  assert.deepEqual(result.nodes.join.output.failures, ['a']); assert.equal(result.nodes.final.status, 'ready');
  assert.equal((await complete(f, run, await claim(f, run, 'final'), {}, { acceptance: { accepted: true } })).status, 'succeeded');
});

test('parallel fail-fast fences peers, retry is explicit, old leases cannot finish', async t => {
  const w = definition('parallel'); w.nodes.find(n => n.id === 'fork').failure_policy = 'fail_fast';
  const f = await fixture(t, w); const run = await f.start(); const a = await claim(f, run, 'a'); const b = await claim(f, run, 'b');
  const result = await f.runtime.failNode(run.run_id, { ...a, error: { message: 'Failed branch' } });
  assert.equal(result.status, 'failed'); assert.equal(result.nodes.b.status, 'interrupted');
  await assert.rejects(complete(f, run, b), { code: 'STALE_LEASE' });
  await f.runtime.retryNode(run.run_id, { ...control(run), node_id: 'a' });
  await f.runtime.retryNode(run.run_id, { ...control(run), node_id: 'b' });
  const retryA = await claim(f, run, 'a', { request_id: 'retry-a' });
  assert.notEqual(retryA.attempt_id, a.attempt_id);
  await assert.rejects(complete(f, run, a), { code: 'STALE_LEASE' });
});

test('approval binding, denial/reapproval, human gate and pause do not release unauthorized work', async t => {
  const w = definition(); w.nodes.find(n => n.id === 'work').approval.required = true;
  const f = await fixture(t, w); const run = await f.start(); assert.equal(run.status, 'blocked');
  await assert.rejects(claim(f, run, 'work'), { code: 'NODE_NOT_READY' });
  await f.runtime.approve(run.run_id, { ...control(run), approval_id: 'work:1', decision: false });
  await assert.rejects(f.runtime.approve(run.run_id, { ...control(run), approval_id: 'work:1', decision: true }), { code: 'APPROVAL_CONFLICT' });
  await f.runtime.retryNode(run.run_id, { ...control(run), node_id: 'work' });
  await f.runtime.pause(run.run_id, control(run));
  await f.runtime.approve(run.run_id, { ...control(run), approval_id: 'work:2', decision: true });
  assert.deepEqual((await f.runtime.next(run.run_id)).ready, []);
  await f.runtime.resume(run.run_id, control(run));
  const lease = await claim(f, run, 'work'); await f.runtime.pause(run.run_id, control(run));
  const result = await complete(f, run, lease); assert.equal(result.status, 'paused'); assert.equal(result.nodes.final.status, 'pending');
  await f.runtime.resume(run.run_id, control(run)); assert.deepEqual((await f.runtime.next(run.run_id)).ready, ['final']);
  const h = definition(); Object.assign(h.nodes.find(n => n.id === 'work'), { type: 'human_gate', executor: { kind: 'human' } });
  const f2 = await fixture(t, h); const r2 = await f2.start();
  const approved = await f2.runtime.approve(r2.run_id, { ...control(r2), approval_id: 'work:1', decision: true });
  assert.equal(approved.nodes.work.status, 'succeeded'); assert.equal(approved.nodes.work.attempts.length, 0);
});

test('restart fences dispatched work; reconciliation required; cancel records pending external cancellation', async t => {
  const f = await fixture(t); const run = await f.start(); const work = await claim(f, run, 'work');
  const dispatch = { ...work, ...control(run), request_id: 'dispatch-1', envelope_hash: digest(canonicalJSON(work)) };
  await f.runtime.recordDispatchIntent(run.run_id, dispatch);
  await f.runtime.resume(run.run_id, { ...control(run), after_restart: true });
  await assert.rejects(f.runtime.resume(run.run_id, control(run)), { code: 'INTERRUPTED_NODES' });
  await assert.rejects(f.runtime.retryNode(run.run_id, { ...control(run), node_id: 'work' }), { code: 'DISPATCH_RECONCILIATION_REQUIRED' });
  const late = await f.runtime.recordDispatchReceipt(run.run_id, { ...dispatch, receipt: { task_id: 'task-1' } });
  assert.equal(late.nodes.work.attempts[0].dispatch.cancellation_pending, true);
  await assert.rejects(f.runtime.recordDispatchReceipt(run.run_id, { ...dispatch, receipt: { task_id: 'task-2' } }), { code: 'DISPATCH_CONFLICT' });
  await f.runtime.retryNode(run.run_id, { ...control(run), node_id: 'work', reconciliation: { attempt_id: work.attempt_id, dispatch_request_id: 'dispatch-1', outcome: 'terminated', evidence: ['executor confirmed task-1 terminated'] } });
  const second = await claim(f, run, 'work', { request_id: 'claim-2' });
  await f.runtime.recordDispatchIntent(run.run_id, { ...second, ...control(run), request_id: 'dispatch-2', envelope_hash: digest(canonicalJSON(second)) });
  const cancelled = await f.runtime.cancel(run.run_id, control(run)); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.nodes.work.attempts[1].dispatch.cancellation_pending, true);
  await assert.rejects(complete(f, run, second), { code: 'STALE_LEASE' });
});

test('Run pins survive preset edit/delete and reject tampered resources', async t => {
  const f = await fixture(t); const run = await f.start();
  const head = await f.store.snapshot('example'); await f.store.rename('example', 'Changed preset', head.revision_hash);
  const edited = await f.store.snapshot('example'); await f.store.delete('example', edited.revision_hash);
  const work = await claim(f, run, 'work'); assert.equal(work.workflow_revision, run.workflow_revision);
  const record = await f.runtime.runs.read(run.run_id); const object = join(f.runtime.runs.directory(run.run_id), 'objects', record.pins.resources[0].sha256);
  await writeFile(object, 'tampered'); await assert.rejects(f.runtime.get(run.run_id), { code: 'RUN_RESOURCE_CORRUPT' });
});

test('committed journal survives cache write failure; stale CAS and torn/corrupt journal fail closed', async t => {
  const f = await fixture(t); const run = await f.start(); const directory = f.runtime.runs.directory(run.run_id); const cache = join(directory, 'run.json');
  await rename(cache, cache + '.saved'); await mkdir(cache);
  await assert.rejects(claim(f, run, 'work'), error => error.code === 'RUN_CACHE_WRITE_FAILED' && error.committed === true);
  const repeated = await claim(f, run, 'work'); assert.equal(repeated.idempotent, true); assert.equal((await f.runtime.get(run.run_id)).nodes.work.status, 'claimed');
  await rmdir(cache); await rename(cache + '.saved', cache);
  await assert.rejects(claim(f, run, 'work', { expected_sequence: 1 }), { code: 'RUN_SEQUENCE_CONFLICT' });
  const journal = join(directory, 'events.jsonl'); await appendFile(journal, '{"uncommitted":');
  await assert.rejects(f.runtime.get(run.run_id), { code: 'RUN_JOURNAL_TORN' });
  const beforeUnauthorizedRecovery = await readFile(journal);
  await assert.rejects(f.runtime.resume(run.run_id, { control_token: 'wrong', after_restart: true }), { code: 'RUN_AUTHORITY' });
  assert.deepEqual(await readFile(journal), beforeUnauthorizedRecovery);
  const recovered = await f.runtime.resume(run.run_id, { ...control(run), after_restart: true }); assert.equal(recovered.nodes.work.status, 'interrupted');
  const validBytes = await readFile(journal); const decoded = decodeEvents(validBytes); assert.equal(decoded.events.at(-1).kind, 'recover');
  await writeFile(journal, validBytes.toString().replace('"kind":"claim"', '"kind":"pause"'));
  await assert.rejects(f.runtime.resume(run.run_id, { ...control(run), after_restart: true }), { code: 'RUN_JOURNAL_CORRUPT' });
});

test('Strict and parallel writes fail closed; serial write scope narrows Run authorization', async t => {
  const w = definition(); w.skill_policy.mode = 'strict'; w.skill_policy.implicit = 'deny';
  const f = await fixture(t, w); await assert.rejects(f.start(), { code: 'STRICT_UNAVAILABLE' });
  const parallel = definition('parallel'); Object.assign(parallel.nodes.find(n => n.id === 'a'), { access: 'bounded_write', path_scope: ['src'] });
  const f2 = await fixture(t, parallel); await assert.rejects(f2.start({ access: 'bounded_write', allowed_paths: ['src'] }), { code: 'PARALLEL_WRITE_UNAVAILABLE' });
  const serial = definition(); Object.assign(serial.nodes.find(n => n.id === 'work'), { access: 'bounded_write', path_scope: ['src'] });
  const f3 = await fixture(t, serial); await assert.rejects(f3.start(), { code: 'NODE_WRITE_UNAUTHORIZED' });
  const r3 = await f3.start({ access: 'bounded_write', allowed_paths: ['src/lib'] }); const lease = await claim(f3, r3, 'work'); assert.deepEqual(lease.effective_allowed_paths, ['src/lib']);
  await assert.rejects(complete(f3, r3, lease, {}, { changed_paths: ['src/other.js'] }), { code: 'SCOPE_VIOLATION' });
  assert.equal((await complete(f3, r3, lease, {}, { changed_paths: ['src/lib/a.js'] })).nodes.work.status, 'succeeded');
});

test('input and output contracts validate actual data, bind final output and reject unsupported schemas', async t => {
  const w = definition();
  w.inputs_schema = { type: 'object', properties: { task: { type: 'string', minLength: 1 } }, required: ['task'], additionalProperties: false };
  w.nodes.find(n => n.id === 'work').outputs_schema = { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 1 } } };
  w.output_bindings = { count: '/nodes/work/output/count' }; w.outputs_schema = { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } };
  const f = await fixture(t, w); await assert.rejects(f.start(), { code: 'DATA_INVALID' });
  const run = await f.start({ inputs: { task: 'Synthetic task' } }); const work = await claim(f, run, 'work');
  await assert.rejects(complete(f, run, work, { count: 0.5 }), { code: 'DATA_INVALID' });
  await complete(f, run, work, { count: 3 });
  const result = await complete(f, run, await claim(f, run, 'final'), {}, { acceptance: { accepted: true } }); assert.deepEqual(result.output, { count: 3 });
  const bad = definition(); bad.inputs_schema = { type: 'object', patternProperties: {} };
  await assert.rejects(f.store.save('example', bad, { expected_revision: (await f.store.snapshot('example')).revision_hash }), error => error.code === 'WORKFLOW_NOT_READY');
});
