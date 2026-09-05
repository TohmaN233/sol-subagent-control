import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, open, readdir, rename } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createProbeWorkspace, createTempProfile, cleanupProbeWorkspace } from '../skill-isolation/create-temp-profile.mjs';
import { createStrictSession } from '../../plugins/sol-advisor/control-plane/lib/execution/codex-session.mjs';
import { StrictSessionManager } from '../../plugins/sol-advisor/control-plane/lib/execution/strict-session-manager.mjs';
import { STRICT_INSTRUCTIONS } from '../../plugins/sol-advisor/control-plane/lib/execution/codex-profile-builder.mjs';
import { WorkflowService } from '../../plugins/sol-advisor/control-plane/lib/workflow-service.mjs';
import { loadConfig, saveConfig } from '../../plugins/sol-advisor/control-plane/lib/config.mjs';
import { importCoarseSkill } from '../../plugins/sol-advisor/control-plane/lib/skill-import/coarse-compiler.mjs';
import { digest } from '../../plugins/sol-advisor/control-plane/lib/workflow-revisions.mjs';
import { DEFAULT_CONFIG_PATH } from '../../plugins/sol-advisor/control-plane/server.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { discoverCodexSkills } from '../../plugins/sol-advisor/control-plane/lib/skill-import/codex-inventory.mjs';

const [binary, workRoot, reportPath] = process.argv.slice(2);
assert(process.argv.length === 5 && [binary, workRoot, reportPath].every(isAbsolute));
const reportFile = await open(reportPath, 'wx');
const report = { kind: 'strict-manager-actual-app-server-local-provider', production_qualified: false, cases: [], requests: [], errors: [] };
let fixture, manager, service, serverError, run, source, planningNode, planningProposal, linkedResource, nestedPhase;
const counts = new Map(); const markers = new Map();
const configs = [...new Set([join(homedir(), '.codex', 'config.toml'), ...(process.env.CODEX_HOME ? [join(process.env.CODEX_HOME, 'config.toml')] : [])])];
async function hashes() { return Promise.all(configs.map(async path => { try { return { path, sha256: digest(await readFile(path)) }; } catch (error) { if (error.code === 'ENOENT') return { path, missing: true }; throw error; } })); }
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/responses'); const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; assert(size <= 512000); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks)); const input = JSON.stringify(body.input);
    const matches = [...markers].filter(([marker]) => input.includes(marker));
    if (!planningNode && !linkedResource) assert.equal(matches.length, 1); else if (planningNode) assert(input.includes('analysis/request.txt'));
    const [marker, node] = linkedResource ? ['linked-skill', 'linked-skill'] : planningNode ? [planningNode, planningNode] : matches[0]; const index = counts.get(marker) ?? 0; counts.set(marker, index + 1);
    assert.equal(body.instructions, STRICT_INSTRUCTIONS);
    assert(!input.includes(run.control_token) && !input.includes('SHADOWED_SKILL_') && !input.includes('sol-isolation-conflict'));
    const allowed = new Set(['update_plan', 'request_user_input', 'read_workflow_resource', 'list_workspace', 'read_workspace', ...(node === 'instructions' && !nestedPhase ? ['write_workspace'] : []), ...(linkedResource ? ['read_allowed_skill'] : [])]);
    assert(body.tools.every(tool => tool.type === 'function' && allowed.has(tool.name)));
    report.requests.push({ node, ...(nestedPhase ? { nested_phase: nestedPhase } : {}), index, sha256: digest(JSON.stringify(body)), tools: body.tools.map(tool => tool.name) });
    const step = index === 0 ? { name: 'read_workflow_resource', args: { path: linkedResource ?? (planningNode ? 'analysis/request.txt' : 'source/SKILL.md') } }
      : index === 1 && node === 'instructions' && !nestedPhase ? { name: 'write_workspace', args: { path: 'result.txt', text: 'MANAGER_VERIFIED', expected_sha256: null } } : null;
    if (linkedResource) { assert(input.includes('PINNED_LINKED_SOURCE')); if (index > 0) assert(input.includes('LINKED_REFERENCE_BYTES')); }
    else if (index > 0) assert(input.includes('PINNED_SOURCE_ONLY'));
    const item = step ? { type: 'function_call', id: `fc_${node}_${index}`, call_id: `call_${node}_${index}`, name: step.name, arguments: JSON.stringify(step.args) }
      : { type: 'message', id: `msg_${node}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: planningNode === 'expand' ? JSON.stringify(planningProposal) : '{"verified":true}', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit('response.created', { response: { id: 'manager-response', status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item });
    if (item.type === 'message') emit('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id: 'manager-response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
  } catch (error) { serverError = error; res.writeHead(500).end(); }
});
try {
  report.before = await hashes(); report.executable_sha256 = digest(await readFile(binary)); report.source_hashes = await sourceManifest();
  for (const path of ['strict-session-manager', 'strict-config', 'codex-managed-login']) {
    const relative = `../../plugins/sol-advisor/control-plane/lib/execution/${path}.mjs`;
    report.source_hashes[relative] = digest(await readFile(fileURLToPath(new URL(relative, import.meta.url))));
  }
  for (const name of ['workflow-service', 'workflow-executor', 'workflow-runtime', 'workflow-run-store', 'workflow-execution-envelope', 'workflow-state', 'workflow-validator', 'workflow-pins', 'workflow-subworkflow', 'workflow-reference-schema', 'workflow-events', 'config']) {
    const relative = `../../plugins/sol-advisor/control-plane/lib/${name}.mjs`;
    report.source_hashes[relative] = digest(await readFile(fileURLToPath(new URL(relative, import.meta.url))));
  }
  for (const name of ['codex-inventory', 'expansion-run', 'semantic-expander', 'metadata-reader', 'coarse-compiler', 'dependency-reader', 'review-import', 'skill-reader', 'inline-skill']) {
    const relative = `../../plugins/sol-advisor/control-plane/lib/skill-import/${name}.mjs`;
    report.source_hashes[relative] = digest(await readFile(fileURLToPath(new URL(relative, import.meta.url))));
  }
  report.source_hashes['run-manager-qualification.mjs'] = digest(await readFile(fileURLToPath(import.meta.url)));
  fixture = await createProbeWorkspace(workRoot);
  const inventoryProfile = await createTempProfile(fixture, 'run-a');
  const listed = await discoverCodexSkills(fixture.cwd, { config: { strict_executor: { codex_binary: binary, binary_sha256: report.executable_sha256 } }, env: { ...process.env, CODEX_HOME: inventoryProfile.home } });
  assert.equal(listed.errors.length, 0); assert(listed.skills.some(skill => skill.path.replaceAll('\\', '/') === inventoryProfile.allowedSkill.replaceAll('\\', '/')));
  assert(listed.skills.some(skill => skill.path.replaceAll('\\', '/') === fixture.repoSkill.replaceAll('\\', '/')));
  report.cases.push({ name: 'actual-configured-profile-inventory-without-model-or-auth', passed: true, discovered_by: listed.discovered_by, model_invocations: listed.model_invocations, skills: listed.skills.length });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const configPath = join(fixture.root, 'control-plane.json');
  await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  manager = new StrictSessionManager({ configPath, getConfig: () => service.config(),
    sessionFactory: options => createStrictSession({ ...options, endpoint: `http://127.0.0.1:${server.address().port}/v1` }) });
  service = new WorkflowService({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, capabilities: { strictManager: manager } });
  await service.call('migrate_v6', {}, { human: true });
  const config = await service.config();
  config.strict_executor = { enabled: true, codex_binary: binary, binary_sha256: report.executable_sha256 };
  await saveConfig(config, { configPath });
  const provider = config.providers.find(item => item.enabled && item.kind === 'native_agent' && item.capabilities.write); assert(provider);
  source = join(fixture.root, 'original-source'); await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), '---\nname: manager-qualification\ndescription: Synthetic manager qualification\n---\nPINNED_SOURCE_ONLY. Process the synthetic task and report verification.');
  const { store } = await service.open();
  const imported = await importCoarseSkill(store, join(source, 'SKILL.md'), { id: 'manager-fixture', providerId: provider.id, role: provider.config.role });
  assert.deepEqual(imported.workflow.import_status.unresolved, []);
  const workflow = structuredClone(imported.workflow); workflow.status = 'ready';
  for (const node of workflow.nodes.filter(node => node.type === 'agent')) {
    const marker = `MANAGER_NODE=${node.id};`; markers.set(marker, node.id);
    node.prompt_template = marker + '\n' + node.prompt_template;
    node.outputs_schema = { type: 'object', required: ['verified'], properties: { verified: { type: 'boolean' } }, additionalProperties: false };
    if (node.id === 'instructions') { node.access = 'bounded_write'; node.path_scope = ['result.txt']; }
  }
  const ready = await store.save(workflow.id, workflow, { expected_revision: imported.revision_hash });
  // The original pathname disappears before Run creation and all model dispatch.
  await rename(source, source + '-removed');
  run = await service.call('start', { workflow_id: workflow.id, revision_hash: ready.revision_hash, workspace: fixture.cwd, main_actor: 'primary', access: 'bounded_write', allowed_paths: ['result.txt'], inputs: { task: 'Verify this synthetic immutable import' } });
  for (const node of ['instructions', 'final']) {
    const lease = await service.call('claim_node', { run_id: run.run_id, control_token: run.control_token, node_id: node, owner: node === 'final' ? 'primary' : 'native-worker', request_id: 'claim-' + node });
    const args = { run_id: run.run_id, control_token: run.control_token, node_id: node, attempt_id: lease.attempt_id, lease_token: lease.lease_token };
    const dispatched = await service.call('dispatch', args); assert.equal(dispatched.dispatched, true);
    const entry = manager.entries.get(run.run_id + '/' + lease.attempt_id); await entry.job;
    assert.equal(serverError, undefined); assert.equal(entry.error, null);
    const preview = (await service.call('strict_status', args)).output_preview;
    assert.equal(preview.text, '{"verified":true}'); assert.equal(preview.verified, false); assert.equal(preview.durable, false);
    assert.equal((await service.call('dispatch', args)).idempotent, true);
    if (node === 'final') {
      assert.equal((await service.call('collect_strict', args)).final_acceptance_required, true);
      assert.notEqual((await service.call('get', args)).status, 'succeeded');
      assert.equal((await service.call('collect_strict', { ...args, accepted: true })).status, 'succeeded');
    }
    report.cases.push({ name: node === 'instructions' ? 'removed-source-pinned-read-and-bounded-write' : 'isolated-main-proposal-explicit-acceptance', passed: true,
      streaming_preview_verified: true, result_proposal: (await service.call('get', args)).nodes[node].attempts[0].result_proposal });
  }
  assert.equal(await readFile(join(fixture.cwd, 'result.txt'), 'utf8'), 'MANAGER_VERIFIED');
  const planner = config.providers.find(item => item.enabled && item.kind === 'native_agent' && item.config.model === 'gpt-5.6-sol'); assert(planner);
  const origin = { confidence: 0.8, source_span: { resource: 'source/SKILL.md', start_line: 5, end_line: 5 } };
  planningProposal = { source_revision: ready.revision_hash, nodes: [{ id: 'analyze', type: 'agent', prompt_template: 'Analyze {{task}} using the pinned source.', ...origin }],
    edges: [{ id: 'start-analyze', source: 'start', target: 'analyze', ...origin }, { id: 'analyze-final', source: 'analyze', target: 'final', ...origin }] };
  run = await service.call('create_expansion_run', { workflow_id: workflow.id, revision_hash: ready.revision_hash, provider_id: planner.id, run_id: 'synthetic-expansion', workspace: fixture.cwd, main_actor: 'primary' });
  for (const node of ['expand', 'final']) {
    planningNode = node === 'final' ? 'expansion-final' : node;
    const lease = await service.call('claim_node', { run_id: run.run_id, control_token: run.control_token, node_id: node, owner: node === 'final' ? 'primary' : 'planner', request_id: 'claim-' + node });
    const args = { run_id: run.run_id, control_token: run.control_token, node_id: node, attempt_id: lease.attempt_id, lease_token: lease.lease_token };
    if (node === 'expand') assert.equal(lease.provider.id, planner.id);
    await service.call('dispatch', args); const entry = manager.entries.get(run.run_id + '/' + lease.attempt_id); await entry.job;
    assert.equal(serverError, undefined); assert.equal(entry.error, null);
    if (node === 'final') await service.call('collect_strict', { ...args, accepted: true });
  }
  const expanded = await service.call('apply_expansion_result', { run_id: run.run_id, control_token: run.control_token, workflow_id: workflow.id, expected_revision: ready.revision_hash });
  assert.equal(expanded.workflow.status, 'draft'); assert.equal(expanded.workflow.nodes.find(node => node.id === 'analyze').executor.provider_id, provider.id);
  assert(expanded.workflow.import_status.unresolved.some(issue => issue.code === 'AI_INFERENCES_REQUIRE_REVIEW'));
  report.cases.push({ name: 'selected-provider-read-only-expansion-applies-unreviewed-draft', passed: true, planner_provider: planner.id, execution_provider_preserved: provider.id });
  planningNode = null;
  const linkedRoot = join(fixture.root, 'linked-original'); await mkdir(linkedRoot); const linkedPath = join(linkedRoot, 'SKILL.md');
  const linkedText = '---\nname: pinned-linked\ndescription: Linked Skill fixture\n---\nPINNED_LINKED_SOURCE. Read [reference](reference.txt) and report verification.';
  await writeFile(linkedPath, linkedText); await writeFile(join(linkedRoot, 'reference.txt'), 'LINKED_REFERENCE_BYTES');
  const linkedWorkflow = structuredClone(workflow); linkedWorkflow.id = 'linked-fixture';
  const linkedNode = linkedWorkflow.nodes.find(node => node.id === 'instructions');
  linkedNode.type = 'skill_ref'; linkedNode.access = 'read_only'; delete linkedNode.path_scope;
  linkedNode.skill_ref = { path: linkedPath, name: 'pinned-linked', source_hash: digest(linkedText), allowed_nested_skills: [] };
  await service.call('create', { workflow: linkedWorkflow, resources: await store.resources(workflow.id, ready.revision_hash) });
  run = await service.call('start', { workflow_id: linkedWorkflow.id, workspace: fixture.cwd, main_actor: 'primary', access: 'read_only', inputs: { task: 'Apply the linked fixture only' } });
  await rename(linkedRoot, linkedRoot + '-removed'); linkedResource = '__skill_pins__/' + digest(linkedPath) + '/reference.txt';
  const linkedLease = await service.call('claim_node', { run_id: run.run_id, control_token: run.control_token, node_id: 'instructions', owner: 'worker', request_id: 'claim-linked' });
  const linkedArgs = { run_id: run.run_id, control_token: run.control_token, node_id: 'instructions', attempt_id: linkedLease.attempt_id, lease_token: linkedLease.lease_token };
  await service.call('dispatch', linkedArgs); const linkedEntry = manager.entries.get(run.run_id + '/' + linkedLease.attempt_id); await linkedEntry.job;
  assert.equal(serverError, undefined); assert.equal(linkedEntry.error, null);
  assert.equal((await service.call('get', linkedArgs)).nodes.instructions.status, 'succeeded');
  await service.call('cancel', { run_id: run.run_id, control_token: run.control_token });
  report.cases.push({ name: 'linked-skill-explicit-pinned-injection-after-original-removal', passed: true });
  linkedResource = null; nestedPhase = 'child'; counts.clear();
  const childWorkflow = structuredClone(workflow); childWorkflow.id = 'nested-child';
  for (const node of childWorkflow.nodes.filter(node => node.type === 'agent')) { node.access = 'read_only'; delete node.path_scope; }
  const childPack = await service.call('create', { workflow: childWorkflow, resources: await store.resources(workflow.id, ready.revision_hash) });
  const parentWorkflow = structuredClone(childWorkflow); parentWorkflow.id = 'nested-parent';
  const callNode = parentWorkflow.nodes.find(node => node.id === 'instructions');
  Object.assign(callNode, { type: 'subworkflow', executor: { kind: 'subworkflow' }, input_bindings: { task: '/inputs/task' }, outputs_schema: {},
    subworkflow: { workflow_id: childWorkflow.id, revision_pin: childPack.revision_hash, output_bindings: { result: '/output' } } });
  await service.call('create', { workflow: parentWorkflow, resources: await store.resources(workflow.id, ready.revision_hash) });
  const parentRun = await service.call('start', { workflow_id: parentWorkflow.id, workspace: fixture.cwd, main_actor: 'primary', access: 'read_only', inputs: { task: 'Verify a pinned nested Workflow' } });
  await service.call('delete', { workflow_id: childWorkflow.id, expected_revision: childPack.revision_hash });
  const parentLease = await service.call('claim_node', { run_id: parentRun.run_id, control_token: parentRun.control_token, node_id: 'instructions', owner: 'primary', request_id: 'claim-child' });
  const parentArgs = { run_id: parentRun.run_id, control_token: parentRun.control_token, node_id: 'instructions', attempt_id: parentLease.attempt_id, lease_token: parentLease.lease_token };
  run = (await service.call('dispatch', parentArgs)).child;
  assert.equal((await service.call('dispatch', parentArgs)).child.run_id, run.run_id);
  for (const node of ['instructions', 'final']) {
    const lease = await service.call('claim_node', { run_id: run.run_id, control_token: run.control_token, node_id: node, owner: node === 'final' ? 'primary' : 'worker', request_id: 'claim-' + node });
    const args = { run_id: run.run_id, control_token: run.control_token, node_id: node, attempt_id: lease.attempt_id, lease_token: lease.lease_token };
    await service.call('dispatch', args); const entry = manager.entries.get(run.run_id + '/' + lease.attempt_id); await entry.job;
    assert.equal(serverError, undefined); assert.equal(entry.error, null);
    if (node === 'final') await service.call('collect_strict', { ...args, accepted: true });
  }
  const collected = await service.call('collect_subworkflow', parentArgs); assert.deepEqual(collected.nodes.instructions.output, { result: { verified: true } });
  run = parentRun; nestedPhase = 'parent'; counts.clear();
  const parentFinal = await service.call('claim_node', { run_id: run.run_id, control_token: run.control_token, node_id: 'final', owner: 'primary', request_id: 'claim-final' });
  const finalArgs = { run_id: run.run_id, control_token: run.control_token, node_id: 'final', attempt_id: parentFinal.attempt_id, lease_token: parentFinal.lease_token };
  await service.call('dispatch', finalArgs); const finalEntry = manager.entries.get(run.run_id + '/' + parentFinal.attempt_id); await finalEntry.job;
  assert.equal(serverError, undefined); assert.equal(finalEntry.error, null);
  assert.equal((await service.call('collect_strict', { ...finalArgs, accepted: true })).status, 'succeeded');
  report.cases.push({ name: 'deleted-child-pack-strict-execution-and-parent-namespaced-acceptance', passed: true });
  assert.deepEqual(await readdir(manager.parent), []); report.profiles_retained = [];
} catch (error) {
  report.errors.push({ code: error.code ?? null, message: error.message, ...(serverError ? { request_validation: serverError.message } : {}) }); process.exitCode = 1;
} finally {
  if (manager) try { await manager.close(); } catch (error) { report.errors.push({ phase: 'session-cleanup', message: error.message }); process.exitCode = 1; }
  if (server.listening) await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()));
  if (fixture) try { await cleanupProbeWorkspace(fixture); } catch (error) { report.errors.push({ phase: 'workspace-cleanup', message: error.message }); process.exitCode = 1; }
  report.after = await hashes(); report.shared_config_unchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
  if (!report.shared_config_unchanged) process.exitCode = 1;
  await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportFile.sync(); await reportFile.close();
  process.stdout.write(JSON.stringify({ cases: report.cases, requests: report.requests.length, errors: report.errors, shared_config_unchanged: report.shared_config_unchanged }) + '\n');
}
