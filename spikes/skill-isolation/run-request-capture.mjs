import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { open, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProbeWorkspace, createTempProfile, cleanupProbeWorkspace } from './create-temp-profile.mjs';
import { startSyntheticSession } from './synthetic-turns.mjs';
import { assertFixtureRequest } from './fixture-policy.mjs';

const [binary, workRoot, reportPath] = process.argv.slice(2);
assert(binary && workRoot && reportPath && process.argv.length === 5, 'Usage: node run-request-capture.mjs <absolute-codex-executable> <existing-work-root> <new-report.json>');
assert(isAbsolute(binary) && isAbsolute(workRoot) && isAbsolute(reportPath), 'Use absolute paths');
const reportFile = await open(reportPath, 'wx');
const report = { kind: 'actual-app-server-local-model-stub', strict_proven: false, m1_gate: 'incomplete', platform: process.platform, node: process.version, cases: [], requests: [] };
const hash = data => createHash('sha256').update(data).digest('hex');
const configs = [...new Set([join(homedir(), '.codex', 'config.toml'), ...(process.env.CODEX_HOME ? [join(process.env.CODEX_HOME, 'config.toml')] : [])])];
async function configHashes() {
  return Promise.all(configs.map(async path => {
    try { return { path, sha256: hash(await readFile(path)) }; }
    catch (error) { if (error.code === 'ENOENT') return { path, missing: true }; throw error; }
  }));
}
let workspace;
let profile;
let session;
let before;
let scenario;
let requestIndex = 0;
let serverError;
let signalCrashRequest;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/responses');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; assert(bytes < 256000, 'Unexpected large request'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (scenario !== 'repository-catalog') assertFixtureRequest(body);
    if (scenario === 'mid-turn-crash') {
      report.requests.push({ scenario, sequence: 1, body });
      signalCrashRequest();
      return; // Deliberately leave the stream unfinished until the test kills its own child.
    }
    const text = JSON.stringify(body.input);
    const first = requestIndex++ === 0;
    if (scenario === 'implicit-fixture' && first) {
      assert(text.includes('sol-isolation-conflict'));
      assert(!text.includes('sol-isolation-allowed'), 'Non-implicit Skill leaked into catalog');
      assert(!text.includes('SHADOWED_SKILL_A'), 'Fixture instructions leaked before loading');
    } else if (scenario === 'implicit-fixture') {
      assert(text.includes('SHADOWED_SKILL_A'), 'Dynamic fixture contents did not reach model request');
    } else if (scenario === 'denied-background') {
      assert(!text.includes('sol-isolation-conflict') && !text.includes('sol-isolation-allowed'));
      assert(!text.includes('SHADOWED_SKILL_') && !text.includes('ALLOWED_SKILL_RESULT'));
    } else if (scenario === 'explicit-allowed') {
      assert(text.includes('ALLOWED_SKILL_RESULT'));
      assert(!text.includes('sol-isolation-conflict') && !text.includes('SHADOWED_SKILL_'));
    } else if (scenario === 'repository-catalog') {
      assert.equal((text.match(/- sol-isolation-conflict:/g) ?? []).length, 2, 'Both repo and user fixtures must be visible');
    } else if (scenario === 'fresh-process-denied') {
      assert(!text.includes('sol-isolation-conflict') && !text.includes('sol-isolation-allowed'));
    } else { throw new Error('Unexpected capture scenario'); }
    report.requests.push({ scenario, sequence: requestIndex, body });
    const value = scenario === 'implicit-fixture' ? 'SHADOWED_SKILL_A' : scenario === 'explicit-allowed' ? 'ALLOWED_SKILL_RESULT' : 'WORKFLOW_ONLY';
    const item = scenario === 'implicit-fixture' && first ? {
      type: 'function_call', id: 'fc_probe', call_id: 'probe_read_a', name: 'read_probe_skill', arguments: JSON.stringify({ path: profile.userSkill }),
    } : {
      id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }],
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type, rest) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
    emit('response.created', { response: { id: 'resp_probe', object: 'response', status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id: 'resp_probe', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  } catch (error) { serverError = error; res.writeHead(500).end(); }
});
try {
  before = await configHashes();
  report.executable_sha256 = hash(await readFile(binary));
  report.fixture_source_hashes = Object.fromEntries(await Promise.all([
    'fixture-policy.mjs', 'synthetic-turns.mjs', 'turn-probe-client.mjs', 'create-temp-profile.mjs', 'assertions.mjs',
    'fixtures/conflicting-skill-a/SKILL.md', 'fixtures/conflicting-skill-b/SKILL.md',
    'fixtures/allowed-skill/SKILL.md', 'fixtures/allowed-skill/agents/openai.yaml',
  ].map(async path => [path, hash(await readFile(fileURLToPath(new URL(path, import.meta.url))))])));
  workspace = await createProbeWorkspace(resolve(workRoot));
  profile = await createTempProfile(workspace, 'run-a');
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  session = await startSyntheticSession(binary, workspace, profile, { endpoint });
  async function run(label, allowed, options) {
    scenario = label; requestIndex = 0;
    await session.setAllowed(allowed);
    const result = await session.turn(label, options);
    if (label === 'implicit-fixture') {
      assert.equal(result.output, 'SHADOWED_SKILL_A');
      assert.equal(result.reads.length, 1);
    }
    if (label === 'explicit-allowed') assert.equal(result.output, 'ALLOWED_SKILL_RESULT');
    report.cases.push(result);
  }
  await run('implicit-fixture', [profile.userSkill, profile.allowedSkill]);
  await run('denied-background', []);
  await assert.rejects(session.turn('disallowed-explicit', { explicit: true }), /Fixture not permitted/);
  report.cases.push({ label: 'disallowed-explicit', status: 'rejected-before-thread' });
  await run('explicit-allowed', [profile.allowedSkill], { explicit: true });
  await run('repository-catalog', [workspace.repoSkill, profile.userSkill, profile.allowedSkill], { repositoryEnvironment: true });
  await session.setAllowed([]);
  const changedSkill = join(profile.home, 'skills', 'new-after-policy');
  await mkdir(changedSkill);
  await writeFile(join(changedSkill, 'SKILL.md'), '---\nname: sol-new-fixture\ndescription: Synthetic discovery-change fixture.\n---\nNEW_FIXTURE\n');
  await assert.rejects(session.turn('new-skill-after-policy'), /Non-fixture or unexpected/);
  report.cases.push({ label: 'new-skill-after-policy', status: 'rejected-before-thread' });
  await session.setAllowed([]);
  scenario = 'mid-turn-crash';
  const crashRequest = new Promise(ok => { signalCrashRequest = ok; });
  const crashedTurn = session.turn(scenario).then(() => ({ completed: true }), error => ({ error }));
  let crashTimer;
  try {
    await Promise.race([crashRequest, new Promise((_, no) => { crashTimer = setTimeout(() => no(new Error('Crash request never arrived')), 15000); })]);
  } finally { clearTimeout(crashTimer); }
  await session.client.close();
  const crashResult = await crashedTurn;
  assert(crashResult.error?.message.includes('App Server exited'), 'Killed turn must report process failure');
  report.cases.push({ label: 'mid-turn-process-kill', status: 'failed-as-expected' });
  session = undefined;
  // Reopen the same profile without rewriting its persisted deny configuration.
  const { createTurnProbeClient } = await import('./turn-probe-client.mjs');
  const { inventory } = await import('./assertions.mjs');
  const restarted = createTurnProbeClient(binary, { home: profile.home, cwd: workspace.cwd });
  try {
    await restarted.call('initialize', { clientInfo: { name: 'sol_reopen_probe', version: '0.1.0' } });
    restarted.initialized();
    const skills = inventory(await restarted.call('skills/list', { cwds: [workspace.cwd], forceReload: true }), workspace.cwd);
    assert.equal(skills.filter(skill => skill.enabled).length, 0);
    report.cases.push({ label: 'deny-state-after-process-close', status: 'passed' });
  } finally { await restarted.close(); }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = (serverError ?? error).message; process.exitCode = 1;
} finally {
  const errors = [];
  if (session) try { await session.client.close(); } catch (error) { errors.push(error.message); }
  server.closeAllConnections();
  if (server.listening) await new Promise(ok => server.close(ok));
  if (workspace && !errors.length) try { await cleanupProbeWorkspace(workspace); report.profiles_cleaned = true; } catch (error) { errors.push(error.message); }
  if (before) try {
    assert.deepEqual(await configHashes(), before, 'Real configuration changed'); report.real_config_unchanged = true;
  } catch (error) { errors.push(error.message); }
  if (errors.length) { report.cleanup_errors = errors; report.status = 'failed'; process.exitCode = 1; }
  function sanitize(value) {
    if (typeof value === 'string') {
      let result = value;
      for (const [prefix, token] of [[workspace?.root, '$PROBE_ROOT'], [homedir(), '$USER_HOME']]) {
        if (!prefix) continue;
        for (const variant of new Set([prefix, prefix.replaceAll('\\', '/'), prefix.replaceAll('\\', '\\\\')])) result = result.split(variant).join(token);
      }
      return result;
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
    return value;
  }
  await reportFile.writeFile(JSON.stringify(sanitize(report), null, 2) + '\n');
  await reportFile.close();
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, requests: report.requests.length, error: report.error, strict_proven: false }));
}
