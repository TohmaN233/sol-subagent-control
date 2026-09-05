import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, rename, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from './physical-tempdir.mjs';
import { join, resolve } from 'node:path';
import { loadConfig, saveConfig, configRevision, resolveAuditPath } from '../lib/config.mjs';
import { WorkflowService } from '../lib/workflow-service.mjs';
import { ConnectorTaskStore } from '../connectors/task-store.mjs';
import { DEFAULT_CONFIG_PATH, handleRpc, startConsole, stopConsole } from '../server.mjs';
import { SkillInventory } from '../lib/skill-import/inventory.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-service-')); const workspace = join(root, 'workspace'); await mkdir(workspace);
  t.after(async () => { assert(resolve(root).startsWith(resolve(tmpdir()))); await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }); });
  const configPath = join(root, 'control-plane.json'); const config = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  if (options.configure) { options.configure(config); await saveConfig(config, { configPath }); }
  const service = new WorkflowService({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {}, ...options });
  return { root, configPath, workspace, service,
    migrate: () => service.call('migrate_v6', {}, { human: true }),
    start: () => service.call('start', { workflow_id: 'brainstorm', workspace, access: 'read_only', main_actor: 'root', inputs: { task: 'Synthetic workflow integration', context: 'Fixture only' } }),
  };
}
const control = run => ({ run_id: run.run_id, control_token: run.control_token });
const claim = (f, run, node = 'implementation') => f.service.call('claim_node', { ...control(run), node_id: node, owner: node === 'final-acceptance' ? 'root' : 'worker', request_id: 'claim-' + node });
const leaseArgs = (run, lease) => ({ ...control(run), node_id: lease.node_id, attempt_id: lease.attempt_id, lease_token: lease.lease_token });
const completion = output => ({ status: 'succeeded', summary: 'Synthetic verification', structured_output: output, artifacts: [], evidence: [{ check: 'fixture', passed: true }], changed_paths: [], outside_paths: [] });

test('human adoption rotates lost authority and resumes an unsubmitted max-one claim without charging a retry', async t => {
  const f = await fixture(t); await f.migrate(); const run = await f.start(); const old = await claim(f, run); const state = await f.service.call('get', control(run));
  const recovery = { run_id: run.run_id, expected_sequence: state.sequence, reason: 'Synthetic browser loss', main_actor: 'human-console' };
  await assert.rejects(f.service.call('adopt_run', recovery), { code: 'HUMAN_CONTROL_RECOVERY_REQUIRED' });
  await assert.rejects(f.service.call('adopt_run', { ...recovery, expected_sequence: 1 }, { human: true }), { code: 'RUN_SEQUENCE_CONFLICT' });
  const adopted = await f.service.call('adopt_run', recovery, { human: true }); assert.equal(adopted.status, 'paused'); assert.deepEqual(adopted.recovery_errors, []);
  await assert.rejects(f.service.call('pause', control(run)), { code: 'RUN_AUTHORITY' });
  await assert.rejects(f.service.call('complete_node', { ...leaseArgs(run, old), completion: completion({}) }), { code: 'LEASE_INVALID' });
  const restored = await f.service.call('recover_claim', { ...control(adopted), node_id: old.node_id, attempt_id: old.attempt_id });
  assert.notEqual(restored.envelope.lease_token, old.lease_token); assert.equal(restored.envelope.attempt_id, old.attempt_id); assert.equal(restored.retry_charged, false);
  assert.equal(restored.state.nodes[old.node_id].attempts.length, 1);
  await f.service.call('resume', control(adopted));
  assert.equal((await f.service.call('get', control(adopted))).nodes[old.node_id].status, 'claimed');
});

test('native handoff recovery preserves exact host attestation and rejects a replacement task identity', async t => {
  const f = await fixture(t); await f.migrate(); const run = await f.start(); const work = await claim(f, run); const args = leaseArgs(run, work);
  const dispatched = await f.service.call('dispatch', args); const receipt = { agent_id: 'original-native-task' };
  await f.service.call('dispatch_receipt', { ...args, request_id: dispatched.request_id, receipt }); await f.service.call('resume', { ...control(run), after_restart: true });
  await assert.rejects(f.service.call('reattach_handoff', { ...args, reconciliation: { outcome: 'completed', receipt: { agent_id: 'another-task' }, evidence: [{}] } }), { code: 'HANDOFF_RECONCILIATION_REQUIRED' });
  const restored = await f.service.call('reattach_handoff', { ...args, reconciliation: { outcome: 'completed', receipt, evidence: [{ host_tool: 'read exact task', observed: 'completed' }] } });
  assert.equal(restored.state.nodes.implementation.attempts[0].reconciliation.independently_verified, false); assert.equal(restored.state.nodes.implementation.attempts.length, 1);
  await f.service.call('resume', control(run)); await f.service.call('complete_node', { ...leaseArgs(run, restored.envelope), completion: completion({ verified: true }) });
});

test('Run cancel fences first, forwards only exact connector identity and records confirmed remote cancellation', async t => {
  let params; let controls = 0; let state = 'running'; let service; let authority;
  const task = () => ({ task_id: params.taskId, provider_id: params.provider.id, stage_id: params.stageId, task_type_id: params.taskTypeId,
    connector: 'grok_acp', remote_identity: { session_id: 'session-original', run_id: 'remote-original' }, state });
  const registry = { async start(value) { params = value; return task(); }, async status() { return task(); }, async control(id, args) {
    controls++; assert.equal((await service.call('get', authority)).status, 'cancelled'); assert.equal(id, params.taskId); assert.equal(args.expected_session_id, 'session-original'); assert.equal(args.expected_run_id, 'remote-original'); state = 'cancelled'; return task();
  } };
  const f = await fixture(t, { registry, configure(config) { config.providers.find(p => p.id === 'grok-local').enabled = true; config.task_types.find(w => w.id === 'brainstorm').stages[0].provider_id = 'grok-local'; } }); service = f.service;
  await f.migrate(); const run = await f.start(); authority = control(run); const lease = await claim(f, run); await service.call('dispatch', leaseArgs(run, lease));
  const cancelled = await service.call('cancel', authority); assert.equal(controls, 1); assert.equal(cancelled.nodes.implementation.attempts[0].dispatch.cancellation_pending, false);
  assert.equal(cancelled.nodes.implementation.attempts[0].connector_control.state, 'cancelled');
});

test('unconfirmed cancellation remains fenced until the original remote identity is observed terminal', async t => {
  let params; let remote = 'original'; let phase = 'running';
  const task = () => ({ task_id: params.taskId, provider_id: params.provider.id, stage_id: params.stageId, task_type_id: params.taskTypeId,
    connector: 'grok_acp', remote_identity: { session_id: 'session', run_id: remote }, state: phase });
  const registry = { async start(value) { params = value; return task(); }, async status() { return task(); }, async control() { throw new Error('Synthetic remote transport lost'); } };
  const f = await fixture(t, { registry, configure(config) { config.providers.find(p => p.id === 'grok-local').enabled = true; config.task_types.find(w => w.id === 'brainstorm').stages[0].provider_id = 'grok-local'; } });
  await f.migrate(); const run = await f.start(); const lease = await claim(f, run); const args = leaseArgs(run, lease); await f.service.call('dispatch', args);
  await assert.rejects(f.service.call('cancel', control(run)), { code: 'RUN_CANCEL_INCOMPLETE' });
  const pending = () => f.service.call('get', control(run)); assert.equal((await pending()).status, 'cancelled');
  remote = 'replacement'; phase = 'completed';
  await assert.rejects(f.service.call('reconcile_connector', args), { code: 'CONNECTOR_IDENTITY' });
  assert.equal((await pending()).nodes.implementation.attempts[0].dispatch.cancellation_pending, true);
  remote = 'original'; await f.service.call('reconcile_connector', args);
  assert.equal((await pending()).nodes.implementation.attempts[0].dispatch.cancellation_pending, false);
});
test('restart reattachment verifies the exact connector and rotates its lease without resubmission or retry budget', async t => {
  let starts = 0; let reconciles = 0; let params; let phase = 'running'; let changedIdentity = false;
  const task = () => ({ task_id: params.taskId, provider_id: params.provider.id, stage_id: params.stageId, task_type_id: params.taskTypeId,
    connector: 'grok_acp', remote_identity: { session_id: changedIdentity ? 'different' : 'same', run_id: 'original-remote-run' }, state: phase,
    result: { value: 42 }, terminal_evidence: { kind: 'fixture_result' }, scope: { compliant: true, changed_paths: [], outside_paths: [] } });
  const registry = { async start(value) { starts++; params = value; return task(); }, async status(id) { assert.equal(id, params.taskId); return task(); }, async control(id, args) { assert.equal(id, params.taskId); assert.equal(args.action, 'reconcile'); reconciles++; phase = 'running'; return task(); } };
  const f = await fixture(t, { registry, configure(config) { const provider = config.providers.find(p => p.id === 'grok-local'); provider.enabled = true; config.task_types.find(w => w.id === 'brainstorm').stages[0].provider_id = provider.id; } });
  await f.migrate(); const run = await f.start(); const work = await claim(f, run); await f.service.call('dispatch', leaseArgs(run, work));
  await f.service.call('resume', { ...control(run), after_restart: true }); phase = 'unknown_after_restart';
  const args = { ...control(run), node_id: work.node_id, attempt_id: work.attempt_id };
  changedIdentity = true; await assert.rejects(f.service.call('reattach_connector', args), { code: 'DISPATCH_CONFLICT' }); assert.equal(reconciles, 0);
  changedIdentity = false; const restored = await f.service.call('reattach_connector', args); assert.equal(starts, 1); assert.equal(reconciles, 1); assert.equal(restored.state.nodes[work.node_id].attempts.length, 1);
  await assert.rejects(f.service.call('complete_node', { ...leaseArgs(run, work), completion: completion({}) }), { code: 'LEASE_INVALID' });
  await f.service.call('resume', control(run)); phase = 'completed';
  const completed = await f.service.call('collect_connector', leaseArgs(run, restored.envelope)); assert.equal(completed.nodes[work.node_id].output.value, 42); assert.equal(starts, 1);
});

test('service imports only a fresh actual inventory selection and prepares expansion without invoking a Provider', async t => {
  let source;
  const inventory = new SkillInventory(async () => ({ skills: [{ path: source, scope: 'user', enabled: true }], errors: [], discovered_by: 'synthetic-host-adapter' }));
  const f = await fixture(t, { capabilities: { skillInventory: inventory, context: { tools: ['read_workflow_resource'] } } }); await f.migrate();
  source = join(f.workspace, 'SKILL.md'); await writeFile(source, '---\nname: Import fixture\ndescription: Synthetic Skill\n---\nSummarize the user request.');
  const selected = (await f.service.call('skill_inventory', { workspace: f.workspace })).entries[0];
  const provider = (await f.service.config()).providers.find(item => item.enabled && item.kind === 'native_agent');
  const pack = await f.service.call('import_skill', { workspace: f.workspace, skill_id: selected.id, workflow_id: 'from-skill', provider_id: provider.id });
  assert.equal(pack.workflow.status, 'draft'); assert.equal(pack.workflow.skill_policy.mode, 'strict');
  assert.equal(pack.workflow.nodes.find(node => node.id === 'instructions').executor.provider_id, provider.id);
  const packet = await f.service.call('prepare_expansion', { workflow_id: pack.workflow.id, revision_hash: pack.revision_hash, provider_id: provider.id });
  assert.equal(packet.invoked, false); assert.equal(packet.handoff_required, true); assert.equal(packet.access, 'read_only');
  assert.equal((await f.service.call('verify_relocation', { workflow_id: pack.workflow.id, revision_hash: pack.revision_hash })).functional_execution_proven, false);
  await assert.rejects(f.service.call('review_import', { workflow_id: pack.workflow.id, expected_revision: pack.revision_hash }), { code: 'HUMAN_REVIEW_REQUIRED' });
  await writeFile(source, (await readFile(source, 'utf8')) + '\nChanged');
  await assert.rejects(f.service.call('import_skill', { workspace: f.workspace, skill_id: selected.id, workflow_id: 'stale' }), { code: 'SKILL_SELECTION_STALE' });
});

test('migrated bounded and judgment-heavy presets preserve native lanes through journaled main acceptance', async t => {
  const f = await fixture(t); const legacy = await f.service.config(); await f.migrate();
  for (const id of ['bounded-code-change', 'judgment-heavy-change']) {
    const source = legacy.task_types.find(item => item.id === id); const pack = await f.service.call('read', { workflow_id: id });
    const run = await f.service.call('start', { workflow_id: id, revision_hash: pack.revision_hash, workspace: f.workspace, access: 'bounded_write', allowed_paths: ['out.txt'], main_actor: 'root', inputs: { task: 'Synthetic host handoff verification' } });
    for (const stage of source.stages) {
      const definition = pack.workflow.nodes.find(node => node.id === stage.id);
      assert.equal(definition.executor.provider_id, stage.provider_id); assert.equal(definition.prompt_template, stage.template);
      const lease = await claim(f, run, stage.id); const args = leaseArgs(run, lease); const handoff = await f.service.call('dispatch', args);
      assert.equal(handoff.handoff_required, true); assert.equal(handoff.envelope.provider.id, stage.provider_id); assert.equal(handoff.envelope.access, stage.access);
      if (stage.role === 'reviewer') { assert.equal(handoff.envelope.access, 'read_only'); assert(Object.keys(handoff.envelope.upstream_results).includes('implementation')); }
      await f.service.call('dispatch_receipt', { ...args, request_id: handoff.request_id, receipt: { agent_id: 'synthetic-' + id + '-' + stage.id } });
      await f.service.call('complete_node', { ...args, completion: completion({ synthetic_stage: stage.id, actual_model_called: false }) });
    }
    const final = await claim(f, run, 'final-acceptance'); const args = leaseArgs(run, final);
    await assert.rejects(f.service.call('complete_node', { ...args, completion: completion({}) }), { code: 'FINAL_ACCEPTANCE_REQUIRED' });
    const accepted = await f.service.call('complete_node', { ...args, completion: { ...completion({ verified_handoff_contract: id }), acceptance: { accepted: true } } });
    assert.equal(accepted.status, 'succeeded'); assert.equal(Object.values(accepted.nodes).flatMap(node => node.attempts).length, source.stages.length + 1);
    const fresh = new WorkflowService({ configPath: f.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {} });
    const { idempotent, ...acceptedState } = accepted; assert.equal(idempotent, false);
    assert.deepEqual(await fresh.call('get', control(run)), acceptedState);
  }
});
test('service migration is human-owned; MCP executes a native handoff and main finalization with upstream results', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.call('list'), { code: 'WORKFLOW_MIGRATION_REQUIRED' });
  await assert.rejects(f.service.call('migrate_v6'), { code: 'HUMAN_CONFIGURATION_REQUIRED' });
  for (const name of ['workflow_create', 'workflow_save']) {
    const rejected = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { workflow: { status: 'ready' } } } }, { configPath: f.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {} });
    assert.equal(rejected.result.isError, true); assert.match(JSON.stringify(rejected), /HUMAN_PUBLICATION_REQUIRED|must remain Draft/);
  }
  await f.migrate(); const list = await f.service.call('list'); assert(list.some(w => w.id === 'brainstorm')); assert.doesNotMatch(JSON.stringify(list), /CONSTRAINTS AND OWNERSHIP/);
  const run = await f.start(); const work = await claim(f, run); const args = leaseArgs(run, work);
  const rpc = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workflow_dispatch', arguments: args } }, { configPath: f.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {} });
  assert.equal(rpc.result.isError, undefined); const dispatched = JSON.parse(rpc.result.content[0].text);
  assert.equal(dispatched.adapter.execution, 'native_agent'); assert.equal(dispatched.envelope.provider.id, work.provider.id);
  assert.equal(JSON.stringify(dispatched).includes(run.control_token), false);
  await assert.rejects(f.service.call('dispatch', args), { code: 'DISPATCH_UNCERTAIN' });
  await assert.rejects(f.service.call('complete_node', { ...args, completion: completion({ design: 'A' }) }), { code: 'DISPATCH_RECEIPT_REQUIRED' });
  await f.service.call('dispatch_receipt', { ...args, request_id: dispatched.request_id, receipt: { agent_id: 'fake-native-1' } });
  await f.service.call('complete_node', { ...args, completion: completion({ design: 'A' }) });
  assert.equal((await f.service.call('dispatch', args)).idempotent, true);
  const final = await claim(f, run, 'final-acceptance'); assert.equal(final.upstream_results.implementation.output.design, 'A');
  const result = await f.service.call('complete_node', { ...leaseArgs(run, final), completion: { ...completion({ accepted_design: 'A' }), acceptance: { accepted: true } } });
  assert.equal(result.status, 'succeeded');
});

test('dispatch rechecks disabled/revoked Provider and environment switches with no intent or substitute', async t => {
  const f = await fixture(t); await f.migrate(); const run = await f.start(); const work = await claim(f, run); const args = leaseArgs(run, work);
  const config = await f.service.config(); const provider = config.providers.find(p => p.id === work.provider.id); provider.enabled = false;
  await saveConfig(config, { configPath: f.configPath });
  await assert.rejects(f.service.call('dispatch', args), { code: 'PROVIDER_DISABLED' });
  assert.equal((await f.service.call('get', control(run))).nodes.implementation.attempts[0].dispatch, null);
  provider.enabled = true; await saveConfig(config, { configPath: f.configPath });
  f.service.env.SOL_CONTROL_DISABLED = '1'; await assert.rejects(f.service.call('dispatch', args), { code: 'CONTROL_DISABLED' });
  assert.equal((await f.service.call('get', control(run))).nodes.implementation.status, 'claimed');
});

test('API dispatch is advisory, records identity/output, and duplicate calls cannot invoke it twice', async t => {
  let calls = 0; let body;
  const f = await fixture(t, { configure(config) {
    config.global.allow_direct_api = true; const provider = config.providers.find(p => p.id === 'custom-openai-compatible'); provider.enabled = true; provider.config.auth_type = 'none';
    config.task_types.find(w => w.id === 'brainstorm').stages[0].provider_id = provider.id;
  }, fetchImpl: async (_url, request) => { calls++; body = JSON.parse(request.body); return new Response(JSON.stringify({ id: 'synthetic-response', choices: [{ message: { content: 'Advice' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  await f.migrate(); const run = await f.start(); const work = await claim(f, run); const args = leaseArgs(run, work);
  const result = await f.service.call('dispatch', args); assert.equal(calls, 1); assert.equal(body.tools, undefined); assert.equal(result.state.nodes.implementation.output.text, 'Advice');
  assert.equal(result.receipt.provider_response_id, 'synthetic-response'); await f.service.call('dispatch', args); assert.equal(calls, 1);
});

test('connector task identity is allocated before start and recovered exactly after receipt loss', async t => {
  let calls = 0; let saved;
  const registry = { async start(params) { calls++; saved = params; throw new Error('Simulated transport loss after task creation'); }, async status(taskId) { assert.equal(taskId, saved.taskId); return { task_id: taskId, provider_id: saved.provider.id, stage_id: saved.stageId, task_type_id: saved.taskTypeId, connector: 'grok_acp', remote_identity: { session_id: 'session-1', run_id: 'remote-1' }, state: 'unknown_after_restart' }; } };
  const f = await fixture(t, { registry, configure(config) { const p = config.providers.find(p => p.id === 'grok-local'); p.enabled = true; config.task_types.find(w => w.id === 'brainstorm').stages[0].provider_id = p.id; } });
  await f.migrate(); const run = await f.start(); const work = await claim(f, run); const args = leaseArgs(run, work);
  await assert.rejects(f.service.call('dispatch', args), /Simulated transport loss/); assert.equal(saved.taskId, work.attempt_id); assert.deepEqual(saved.allowedPaths, []);
  await assert.rejects(f.service.call('dispatch', args), { code: 'DISPATCH_UNCERTAIN' }); assert.equal(calls, 1);
  const reconciled = await f.service.call('reconcile_connector', args); assert.equal(reconciled.receipt.remote_identity.session_id, 'session-1'); assert.equal(calls, 1);
  await assert.rejects(f.service.call('reconcile_connector', { ...args, control_token: 'wrong' }), { code: 'RUN_AUTHORITY' });
});

test('authenticated console migrates and validates graph; config save cannot replace migration identity', async t => {
  const f = await fixture(t); const state = await startConsole({ configPath: f.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, open: false }); t.after(stopConsole);
  const url = `http://127.0.0.1:${state.port}/api/workflow/migrate_v6`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: '{}' }); assert.equal(response.status, 200);
  const config = await f.service.config(); assert.equal(config.version, 7); const revision = configRevision(config); config.workflow_store.relative_path = 'other-store';
  await assert.rejects(saveConfig(config, { configPath: f.configPath, expectedRevision: revision }), /cannot replace/);
  const valid = await fetch(`http://127.0.0.1:${state.port}/api/workflow/list`, { method: 'POST', headers: { authorization: `Bearer ${state.token}` }, body: '{}' }); assert.equal(valid.status, 200); assert((await valid.json()).length > 0);
  await stopConsole();
});

test('connector persistence failure poisons in-memory state and duplicate IDs cannot overwrite tasks', async t => {
  const f = await fixture(t); const path = join(f.root, 'tasks.json'); const store = new ConnectorTaskStore({ statePath: path });
  await store.create({ task_id: 'synthetic-task', state: 'completed' });
  await assert.rejects(store.create({ task_id: 'synthetic-task' }), { code: 'TASK_ID_CONFLICT' });
  await rename(path, path + '.saved'); await mkdir(path);
  await assert.rejects(store.create({ task_id: 'uncommitted-task' }));
  await assert.rejects(store.get('uncommitted-task'), { code: 'CONNECTOR_STORE_FAILED' });
  assert.equal(JSON.parse(await readFile(path + '.saved', 'utf8')).tasks.length, 1);
});

test('two overlapping dispatch requests elect exactly one local sender', { timeout: 10000 }, async t => {
  let entered; const entering = new Promise(resolve => { entered = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const f = await fixture(t, { configure(config) {
    config.global.allow_direct_api = true; const p = config.providers.find(p => p.id === 'custom-openai-compatible'); p.enabled = true; p.config.auth_type = 'none'; config.task_types.find(w => w.id === 'brainstorm').stages[0].provider_id = p.id;
  }, fetchImpl: async () => { calls++; entered(); await gate; return new Response(JSON.stringify({ id: 'one-response', choices: [{ message: { content: 'Once' } }] })); } });
  await f.migrate(); const run = await f.start(); const args = leaseArgs(run, await claim(f, run));
  const first = f.service.call('dispatch', args); await entering;
  try { await assert.rejects(f.service.call('dispatch', args), { code: 'DISPATCH_UNCERTAIN' }); assert.equal(calls, 1); }
  finally { release(); }
  await first; assert.equal(calls, 1);
});

test('console config save reports committed state when audit persistence fails', async t => {
  const f = await fixture(t); const console = await startConsole({ configPath: f.configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, open: false }); t.after(stopConsole);
  const auditPath = resolveAuditPath(f.configPath); await rename(auditPath, auditPath + '.saved'); await mkdir(auditPath);
  const config = await f.service.config(); const revision = configRevision(config); config.global.console_title = 'Committed title';
  const response = await fetch(`http://127.0.0.1:${console.port}/api/config`, { method: 'PUT', headers: { authorization: `Bearer ${console.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ config, expected_revision: revision }) });
  assert.equal(response.status, 400); const error = await response.json(); assert.equal(error.code, 'AUDIT_WRITE_FAILED'); assert.equal(error.committed, true);
  assert.equal((await f.service.config()).global.console_title, 'Committed title'); await stopConsole();
});

test('connector collection requires exact node identity and independently observed scope evidence', async t => {
  let saved; let observedScope = null;
  const task = () => ({ task_id: saved.taskId, task_type_id: saved.taskTypeId, stage_id: saved.stageId, provider_id: saved.provider.id, connector: 'grok_acp', remote_identity: { session_id: 'session-1', run_id: 'remote-1' }, state: 'completed', result: { text: 'Verified' }, terminal_evidence: { kind: 'acp_prompt_result' }, scope: observedScope });
  const registry = { async start(params) { saved = params; return task(); }, async status(id) { assert.equal(id, saved.taskId); return task(); } };
  const f = await fixture(t, { registry, configure(config) { const p = config.providers.find(p => p.id === 'grok-local'); p.enabled = true; config.task_types.find(w => w.id === 'brainstorm').stages[0].provider_id = p.id; } });
  await f.migrate(); const run = await f.start(); const work = await claim(f, run); const args = leaseArgs(run, work);
  await f.service.call('dispatch', args);
  await assert.rejects(f.service.call('collect_connector', args), { code: 'CONNECTOR_EVIDENCE' });
  observedScope = { compliant: true, changed_paths: [], outside_paths: [], observed_digest: 'synthetic-observation' };
  const result = await f.service.call('collect_connector', args); assert.equal(result.nodes.implementation.status, 'succeeded'); assert.equal(result.nodes['final-acceptance'].status, 'ready');
});
