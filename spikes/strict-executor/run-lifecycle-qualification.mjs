import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, open, access, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createStrictSession } from '../../plugins/sol-advisor/control-plane/lib/execution/codex-session.mjs';
import { createCodexToolBroker } from '../../plugins/sol-advisor/control-plane/lib/execution/codex-tool-broker.mjs';
import { cleanupCodexProfile, STRICT_INSTRUCTIONS } from '../../plugins/sol-advisor/control-plane/lib/execution/codex-profile-builder.mjs';
import { inspectOrphanProfiles, stopVerifiedOrphan } from '../../plugins/sol-advisor/control-plane/lib/execution/codex-process-ownership.mjs';
import { digest } from '../../plugins/sol-advisor/control-plane/lib/workflow-revisions.mjs';
import { createProbeWorkspace, cleanupProbeWorkspace } from '../skill-isolation/create-temp-profile.mjs';
import { sourceManifest } from './source-manifest.mjs';

const [binary, workRoot, reportPath] = process.argv.slice(2);
assert(process.argv.length === 5 && [binary, workRoot, reportPath].every(isAbsolute));
const reportFile = await open(reportPath, 'wx');
const report = { kind: 'strict-candidate-lifecycle-actual-app-server', production_qualified: false, cases: [], requests: [], errors: [] };
const jobs = new Map(); const sessions = new Set(); let fixture; let serverError; let endpoint;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/responses'); const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; assert(length <= 512000); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks)); const input = JSON.stringify(body.input);
    const found = [...jobs].filter(([id]) => input.includes(`QUALIFICATION_CASE=${id};`)); assert.equal(found.length, 1);
    const [id, job] = found[0]; const index = job.requests++;
    if (job.expectUnknown && index > 0) {
      const outputs = body.input.filter(item => item.type === 'function_call_output');
      assert(outputs.some(item => /unknown|unsupported|unrecognized/i.test(JSON.stringify(item.output)) && JSON.stringify(item.output).includes('read_workspace')), 'App Server did not return an explicit unsupported-tool error');
      job.unknownRefused = true;
    }
    assert.equal(body.instructions, STRICT_INSTRUCTIONS);
    assert(!input.includes('SHADOWED_SKILL_') && !input.includes('sol-isolation-conflict'));
    for (const tool of body.tools) assert(tool.type === 'function' && ['read_allowed_skill', 'update_plan', 'request_user_input', ...(job.toolNames ?? [])].includes(tool.name));
    if (job.allowed) assert(input.includes('ALLOWED_SKILL_RESULT')); else assert(!input.includes('ALLOWED_SKILL_RESULT'));
    report.requests.push({ case: id, index, sha256: digest(JSON.stringify(body)), tools: body.tools.map(tool => tool.name) });
    if (job.onRequest) await job.onRequest(index);
    if (job.crash) { res.destroy(); return; }
    const step = job.steps?.[index];
    const item = step ? { type: 'function_call', id: `fc_${id}_${index}`, call_id: `call_${id}_${index}`, name: step.name, arguments: JSON.stringify(step.args) }
      : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'LIFECYCLE_COMPLETE', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit('response.created', { response: { id: 'lifecycle-response', status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item }); emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id: 'lifecycle-response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
  } catch (error) { serverError = error; res.writeHead(500).end(); }
});
async function close(session) { await session.close(); sessions.delete(session); }
const gone = async path => { await assert.rejects(access(path), { code: 'ENOENT' }); };
let options; let allowedSkill;
async function start(id, extra = {}, job = {}) {
  const session = await createStrictSession({ ...options, ...extra }); sessions.add(session);
  jobs.set(id, { requests: 0, ...job }); return session;
}
const turn = (session, id, explicit = []) => session.turn(`QUALIFICATION_CASE=${id}; Execute only this synthetic case.`, { explicit_sources: explicit, timeout_ms: 15000 });
async function addSkill(home, name) {
  const directory = join(home, 'skills', name); await mkdir(directory);
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Changed catalog fixture\n---\nCATALOG_CHANGED`);
}
try {
  fixture = await createProbeWorkspace(workRoot); report.executable_sha256 = digest(await readFile(binary));
  report.source_hashes = await sourceManifest();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); }); endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  options = { binary, expectedBinaryHash: report.executable_sha256, parent: fixture.root, cwd: fixture.cwd, endpoint,
    model: 'gpt-5.6-sol', effort: 'low', skillPolicy: { mode: 'strict', implicit: 'deny', ambient_allow: [], shadowed_skill_paths: [fixture.repoSkill] } };
  const source = fileURLToPath(new URL('../skill-isolation/fixtures/allowed-skill/SKILL.md', import.meta.url)); const bytes = await readFile(source);
  allowedSkill = { name: 'sol-isolation-allowed', source_path: source, source_hash: digest(bytes), files: { 'SKILL.md': bytes } };

  const before = await start('catalog-before'); await addSkill(before.profile.home, 'new-before');
  await assert.rejects(turn(before, 'catalog-before'), { code: 'SKILL_ISOLATION_FAILED' }); assert.equal(jobs.get('catalog-before').requests, 0); await close(before);
  report.cases.push({ name: 'catalog-change-before-turn', passed: true, requests: 0 });

  const middle = await start('catalog-middle'); jobs.get('catalog-middle').onRequest = () => addSkill(middle.profile.home, 'new-middle');
  await assert.rejects(turn(middle, 'catalog-middle'), { code: 'SKILL_ISOLATION_FAILED' }); await gone(middle.profile.home); sessions.delete(middle);
  report.cases.push({ name: 'catalog-change-during-turn', passed: true });

  const pair = await Promise.all([start('concurrent-allowed', { allowedSkills: [allowedSkill] }, { allowed: true }), start('concurrent-denied')]);
  assert.notEqual(pair[0].profile.home, pair[1].profile.home);
  const results = await Promise.all([turn(pair[0], 'concurrent-allowed', [source]), turn(pair[1], 'concurrent-denied')]);
  assert(results.every(result => result.output === 'LIFECYCLE_COMPLETE')); await Promise.all(pair.map(close));
  report.cases.push({ name: 'concurrent-distinct-policies', passed: true });

  await mkdir(join(fixture.cwd, 'artifact')); await writeFile(join(fixture.cwd, 'artifact', 'result.txt'), 'BEFORE');
  const operations = [];
  const actualBroker = await createCodexToolBroker({ workspace: fixture.cwd, access: 'bounded_write', allowedPaths: ['artifact'], resources: [{ path: 'guide.txt', bytes: 'PINNED_RESOURCE', sha256: digest('PINNED_RESOURCE') }], authorize: async () => {}, onOperation: async event => operations.push(event) });
  const files = await start('broker', { toolBroker: actualBroker }, { toolNames: actualBroker.tools().map(tool => tool.name), steps: [
    { name: 'read_workflow_resource', args: { path: 'guide.txt' } },
    { name: 'read_workspace', args: { path: 'artifact/result.txt' } },
    { name: 'write_workspace', args: { path: 'artifact/result.txt', expected_sha256: digest('BEFORE'), text: 'AFTER' } },
  ] });
  assert.equal((await turn(files, 'broker')).output, 'LIFECYCLE_COMPLETE');
  assert.equal(await readFile(join(fixture.cwd, 'artifact', 'result.txt'), 'utf8'), 'AFTER');
  assert.deepEqual(operations.map(event => event.phase), ['read', 'read', 'intent', 'committed']); await close(files);
  report.cases.push({ name: 'actual-resource-read-workspace-read-and-write', passed: true, operations });

  const denied = await start('tool-denied', {}, { expectUnknown: true, steps: [{ name: 'read_workspace', args: { path: '../outside' } }] });
  await turn(denied, 'tool-denied'); assert.equal(jobs.get('tool-denied').unknownRefused, true); await close(denied);
  report.cases.push({ name: 'unadvertised-tool-rejected-by-app-server', passed: true });

  const crash = await start('process-crash', {}, { crash: true }); jobs.get('process-crash').onRequest = () => { process.kill(crash.client.pid); };
  await assert.rejects(turn(crash, 'process-crash'), /exited|closed|App Server/); await gone(crash.profile.home); sessions.delete(crash);
  report.cases.push({ name: 'app-server-process-crash', passed: true });

  // Kill a separate owner process while its actual App Server is alive. Its
  // ownership record, rather than a PID-only kill, drives orphan reconciliation.
  const helper = spawn(process.execPath, [fileURLToPath(new URL('./session-owner-fixture.mjs', import.meta.url))], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let helperErrors = 0; helper.stderr.on('data', chunk => { helperErrors += chunk.length; });
  const exited = new Promise(resolve => helper.once('close', resolve));
  const ready = new Promise((ok, fail) => {
    const timer = setTimeout(() => { helper.kill(); fail(new Error('Owner fixture preparation timeout')); }, 15000);
    helper.once('message', message => { clearTimeout(timer); message.error ? fail(new Error(message.error)) : ok(message); });
    helper.once('error', error => { clearTimeout(timer); fail(error); });
    helper.once('exit', code => { clearTimeout(timer); fail(new Error(`Owner fixture exited before ready: ${code}; stderr_bytes=${helperErrors}`)); });
  });
  helper.send(options); const owned = await ready; helper.kill(); await exited;
  const records = await inspectOrphanProfiles(fixture.root); const orphan = records.find(record => record.home === owned.home);
  assert.equal(orphan?.status, 'orphan', JSON.stringify(records)); await stopVerifiedOrphan(orphan);
  await cleanupCodexProfile({ parent: fixture.root, home: orphan.home, owner_token: orphan.token }); await gone(orphan.home);
  report.cases.push({ name: 'owner-process-crash-and-verified-orphan-cleanup', passed: true });
  assert.equal(serverError, undefined);
} catch (error) { report.errors.push({ code: error.code ?? null, message: error.message, ...(serverError ? { request_validation: serverError.message } : {}) }); process.exitCode = 1; }
finally {
  for (const session of sessions) try { await close(session); } catch (error) { report.errors.push({ phase: 'cleanup', message: error.message }); process.exitCode = 1; }
  server.closeAllConnections(); await new Promise(ok => server.close(ok));
  if (fixture) {
    report.retained_profiles = (await readdir(fixture.root)).filter(name => name.startsWith('strict-node-'));
    if (report.retained_profiles.length) { report.errors.push({ phase: 'cleanup', message: 'Unreconciled profiles retained' }); process.exitCode = 1; }
    else await cleanupProbeWorkspace(fixture);
  }
  await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportFile.sync(); await reportFile.close();
  process.stdout.write(JSON.stringify({ cases: report.cases, requests: report.requests.length, errors: report.errors, retained_profiles: report.retained_profiles }) + '\n');
}
