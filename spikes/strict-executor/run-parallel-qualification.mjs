import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, open, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createProbeWorkspace, cleanupProbeWorkspace } from '../skill-isolation/create-temp-profile.mjs';
import { createStrictSession } from '../../plugins/sol-advisor/control-plane/lib/execution/codex-session.mjs';
import { StrictSessionManager } from '../../plugins/sol-advisor/control-plane/lib/execution/strict-session-manager.mjs';
import { STRICT_INSTRUCTIONS } from '../../plugins/sol-advisor/control-plane/lib/execution/codex-profile-builder.mjs';
import { WorkflowService } from '../../plugins/sol-advisor/control-plane/lib/workflow-service.mjs';
import { loadConfig, saveConfig } from '../../plugins/sol-advisor/control-plane/lib/config.mjs';
import { createDraft } from '../../plugins/sol-advisor/control-plane/lib/workflow-schema.mjs';
import { digest } from '../../plugins/sol-advisor/control-plane/lib/workflow-revisions.mjs';
import { DEFAULT_CONFIG_PATH } from '../../plugins/sol-advisor/control-plane/server.mjs';
import { sourceManifest } from './source-manifest.mjs';

const [binary, workRoot, reportPath] = process.argv.slice(2); assert(process.argv.length === 5 && [binary, workRoot, reportPath].every(isAbsolute));
const reportFile = await open(reportPath, 'wx');
const report = { kind: 'parallel-actual-app-server-local-provider', production_qualified: false, cases: [], requests: [], errors: [] };
let fixture, service, manager, run, mode, serverError, barrier;
const counts = new Map();
const configs = [...new Set([join(homedir(), '.codex', 'config.toml'), ...(process.env.CODEX_HOME ? [join(process.env.CODEX_HOME, 'config.toml')] : [])])];
async function hashes() { return Promise.all(configs.map(async path => { try { return { path, sha256: digest(await readFile(path)) }; } catch (error) { if (error.code === 'ENOENT') return { path, missing: true }; throw error; } })); }
function concurrentBarrier() {
  let release, fail, timer; const arrivals = new Map(); const waiting = new Promise((ok, reject) => { release = ok; fail = reject; });
  // A detached catch prevents an unhandled rejection before the second waiter;
  // each request still awaits and reports the same explicit barrier failure.
  void waiting.catch(() => undefined);
  return { arrivals, async arrive(node) {
    arrivals.set(node, Date.now());
    timer ??= setTimeout(() => fail(new Error('Two actual model requests did not overlap within the qualification deadline')), 20000);
    if (arrivals.size === 2) { clearTimeout(timer); release(); }
    await waiting;
  } };
}
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/responses'); const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; assert(size < 512000); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks)); const input = JSON.stringify(body.input);
    const matches = ['a', 'b', 'final'].filter(node => input.includes('PARALLEL_NODE=' + node + ';')); assert.equal(matches.length, 1);
    const node = matches[0]; const index = counts.get(node) ?? 0; counts.set(node, index + 1);
    assert.equal(body.instructions, STRICT_INSTRUCTIONS); assert(!input.includes(run.control_token) && !input.includes('SHADOWED_SKILL_'));
    const writing = mode === 'bounded_write' && node !== 'final';
    const allowed = new Set(['update_plan', 'request_user_input', 'read_workflow_resource', 'list_workspace', 'read_workspace', ...(writing ? ['write_workspace'] : [])]);
    assert(body.tools.every(tool => tool.type === 'function' && allowed.has(tool.name)));
    report.requests.push({ mode, node, index, sha256: digest(JSON.stringify(body)), tools: body.tools.map(tool => tool.name) });
    if (index === 0 && node !== 'final') await barrier.arrive(node);
    if (index > 0) assert(input.includes('PARALLEL_PINNED_RESOURCE'));
    const step = index === 0 ? { name: 'read_workflow_resource', args: { path: 'instructions.txt' } }
      : writing && index === 1 ? { name: 'write_workspace', args: { path: node + '.txt', text: 'PARALLEL_' + node.toUpperCase(), expected_sha256: null } } : null;
    const item = step ? { type: 'function_call', id: `fc_${mode}_${node}_${index}`, call_id: `call_${node}_${index}`, name: step.name, arguments: JSON.stringify(step.args) }
      : { type: 'message', id: 'msg_' + node, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"verified":true}', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit('response.created', { response: { id: 'parallel-response', status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item }); emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id: 'parallel-response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
  } catch (error) { serverError = error; res.writeHead(500).end(); }
});
try {
  report.before = await hashes(); report.executable_sha256 = digest(await readFile(binary)); report.source_hashes = await sourceManifest();
  for (const name of ['workflow-service', 'workflow-executor', 'workflow-runtime', 'workflow-run-store', 'workflow-execution-envelope', 'workflow-state', 'workflow-validator', 'workflow-pins', 'workflow-subworkflow', 'workflow-reference-schema', 'config',
    'execution/strict-session-manager', 'execution/strict-config', 'execution/codex-managed-login', 'parallel/git-worktrees', 'parallel/branch-planner', 'parallel/workspace', 'parallel/worktree-manager']) {
    const path = `../../plugins/sol-advisor/control-plane/lib/${name}.mjs`; report.source_hashes[path] = digest(await readFile(fileURLToPath(new URL(path, import.meta.url))));
  }
  report.source_hashes['run-parallel-qualification.mjs'] = digest(await readFile(fileURLToPath(import.meta.url)));
  fixture = await createProbeWorkspace(workRoot);
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const configPath = join(fixture.root, 'control-plane.json'); await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  manager = new StrictSessionManager({ configPath, getConfig: () => service.config(), sessionFactory: options => createStrictSession({ ...options, endpoint: `http://127.0.0.1:${server.address().port}/v1` }) });
  service = new WorkflowService({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, capabilities: { strictManager: manager } });
  await service.call('migrate_v6', {}, { human: true }); const config = await service.config();
  config.strict_executor = { enabled: true, codex_binary: binary, binary_sha256: report.executable_sha256 }; await saveConfig(config, { configPath });
  const provider = config.providers.find(item => item.enabled && item.kind === 'native_agent' && item.capabilities.write); assert(provider);
  const git = service.parallelManager.git; await git.initialize(); await git.git(fixture.cwd, ['init', '-b', 'main']); await git.git(fixture.cwd, ['add', '--all']); await git.git(fixture.cwd, ['commit', '-m', 'Synthetic parallel fixture']);
  const head = await git.text(fixture.cwd, ['rev-parse', 'HEAD']); const originalIndex = digest(await readFile(join(fixture.cwd, '.git', 'index')));
  for (mode of ['read_only', 'bounded_write']) {
    counts.clear(); barrier = concurrentBarrier();
    const workflow = { ...createDraft('parallel-' + mode.replace('_', '-'), 'Synthetic parallel qualification'), status: 'ready', finalization: { required: true, node_id: 'final' } };
    const agent = node => ({ id: node, type: 'agent', access: node === 'final' ? 'read_only' : mode, path_scope: node === 'final' ? [] : [node + '.txt'],
      role: node === 'final' ? 'finalizer' : provider.config.role, executor: node === 'final' ? { kind: 'main' } : { kind: 'provider', provider_id: provider.id },
      approval: { required: false }, retry: { max_attempts: 1 }, input_bindings: {}, resources: ['instructions.txt'], prompt_template: `PARALLEL_NODE=${node}; Apply {{task}} using the pinned resource.`,
      outputs_schema: { type: 'object', required: ['verified'], properties: { verified: { type: 'boolean' } }, additionalProperties: false } });
    workflow.nodes = [{ id: 'start', type: 'start' }, { id: 'fork', type: 'parallel', join_id: 'join' }, agent('a'), agent('b'), { id: 'join', type: 'join', parallel_id: 'fork' }, agent('final'), { id: 'end', type: 'end' }];
    workflow.edges = [['start', 'fork'], ['fork', 'a'], ['fork', 'b'], ['a', 'join'], ['b', 'join'], ['join', 'final'], ['final', 'end']].map(([source, target]) => ({ id: source + '-' + target, source, target, ...(source === 'fork' ? { label: target } : {}) }));
    await service.call('create', { workflow, resources: { 'instructions.txt': 'PARALLEL_PINNED_RESOURCE. Perform the synthetic bounded task.' } });
    run = await service.call('start', { workflow_id: workflow.id, workspace: fixture.cwd, main_actor: 'primary', access: mode, allowed_paths: mode === 'bounded_write' ? ['a.txt', 'b.txt'] : [], inputs: { task: 'Verify actual concurrent execution' } });
    const claim = async node => {
      const lease = await service.call('claim_node', { run_id: run.run_id, control_token: run.control_token, node_id: node, owner: node === 'final' ? 'primary' : 'worker-' + node, request_id: 'claim-' + node });
      return { run_id: run.run_id, control_token: run.control_token, node_id: node, attempt_id: lease.attempt_id, lease_token: lease.lease_token, workspace: lease.workspace };
    };
    const requests = await Promise.all(['a', 'b'].map(claim));
    if (mode === 'bounded_write') { assert.notEqual(requests[0].workspace, requests[1].workspace); assert.notEqual(requests[0].workspace, fixture.cwd); }
    await Promise.all(requests.map(args => service.call('dispatch', args)));
    await Promise.all(requests.map(args => manager.entries.get(run.run_id + '/' + args.attempt_id).job));
    for (const args of requests) assert.equal(manager.entries.get(run.run_id + '/' + args.attempt_id).error, null);
    assert.equal(serverError, undefined); assert.equal(barrier.arrivals.size, 2);
    if (mode === 'bounded_write') {
      await assert.rejects(readFile(join(fixture.cwd, 'a.txt')), { code: 'ENOENT' });
      assert.equal((await service.call('next', { run_id: run.run_id })).integration_gates.length, 1);
      const request = { run_id: run.run_id, control_token: run.control_token, region_id: 'fork' };
      const proposal = await service.call('prepare_integration', request); const review = await service.call('review_integration', request);
      assert(review.patch.includes('PARALLEL_A') && review.patch.includes('PARALLEL_B'));
      await service.call('integrate_parallel', { ...request, accepted: true, patch_sha256: proposal.patch_sha256 });
      assert.equal(await readFile(join(fixture.cwd, 'a.txt'), 'utf8'), 'PARALLEL_A'); assert.equal(await readFile(join(fixture.cwd, 'b.txt'), 'utf8'), 'PARALLEL_B');
    }
    const final = await claim('final'); await service.call('dispatch', final); await manager.entries.get(run.run_id + '/' + final.attempt_id).job;
    assert.equal(manager.entries.get(run.run_id + '/' + final.attempt_id).error, null); assert.equal(serverError, undefined);
    assert.equal((await service.call('collect_strict', { ...final, accepted: true })).status, 'succeeded');
    if (mode === 'bounded_write') assert.equal((await service.call('cleanup_parallel', { run_id: run.run_id, control_token: run.control_token })).removed.length, 2);
    assert.equal(await git.text(fixture.cwd, ['rev-parse', 'HEAD']), head); assert.equal(digest(await readFile(join(fixture.cwd, '.git', 'index'))), originalIndex);
    report.cases.push({ name: mode === 'read_only' ? 'actual-overlapping-read-only-model-requests' : 'actual-overlapping-isolated-writes-and-reviewed-integration', passed: true,
      request_arrival_gap_ms: Math.abs(barrier.arrivals.get('a') - barrier.arrivals.get('b')), shared_head_and_index_unchanged: true });
  }
  assert.deepEqual(await readdir(manager.parent), []); report.profiles_retained = [];
} catch (error) {
  report.errors.push({ code: error.code ?? null, message: error.message, ...(serverError ? { request_validation: serverError.message } : {}) }); process.exitCode = 1;
} finally {
  if (manager) try { await manager.close(); } catch (error) { report.errors.push({ phase: 'session-cleanup', message: error.message }); process.exitCode = 1; }
  if (server.listening) await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()));
  if (fixture) try { await cleanupProbeWorkspace(fixture); } catch (error) { report.errors.push({ phase: 'workspace-cleanup', message: error.message }); process.exitCode = 1; }
  report.after = await hashes(); report.shared_config_unchanged = JSON.stringify(report.before) === JSON.stringify(report.after); if (!report.shared_config_unchanged) process.exitCode = 1;
  await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportFile.sync(); await reportFile.close();
  process.stdout.write(JSON.stringify({ cases: report.cases, requests: report.requests.length, errors: report.errors, shared_config_unchanged: report.shared_config_unchanged }) + '\n');
}
