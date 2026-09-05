import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, rename, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

test('service migration is human-owned; MCP executes a native handoff and main finalization with upstream results', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.call('list'), { code: 'WORKFLOW_MIGRATION_REQUIRED' });
  await assert.rejects(f.service.call('migrate_v6'), { code: 'HUMAN_CONFIGURATION_REQUIRED' });
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
  const registry = { async start(params) { calls++; saved = params; throw new Error('Simulated transport loss after task creation'); }, async status(taskId) { assert.equal(taskId, saved.taskId); return { task_id: taskId, connector: 'grok_acp', remote_identity: { session_id: 'session-1', run_id: 'remote-1' }, state: 'unknown_after_restart' }; } };
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
