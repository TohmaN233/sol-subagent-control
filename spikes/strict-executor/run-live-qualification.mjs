import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { open, readFile, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStrictSession } from '../../plugins/sol-advisor/control-plane/lib/execution/codex-session.mjs';
import { digest } from '../../plugins/sol-advisor/control-plane/lib/workflow-revisions.mjs';
import { createProbeWorkspace, cleanupProbeWorkspace } from '../skill-isolation/create-temp-profile.mjs';
import { sourceManifest, SYNTHETIC_PROMPT } from './source-manifest.mjs';
import { waitForManagedLogin } from '../../plugins/sol-advisor/control-plane/lib/execution/codex-managed-login.mjs';

// Synthetic-only, supported managed ChatGPT login. No copied auth files, token
// injection, workspace broker, arbitrary payload files or general model tools.
const [flag, binary, workRoot, capturePath, lifecyclePath, reportPath] = process.argv.slice(2);
assert(['--live-approved', '--remaining-dynamic-read-approved'].includes(flag)); assert.equal(process.argv.length, 8);
assert([binary, workRoot, capturePath, lifecyclePath, reportPath].every(isAbsolute));
const executableHash = digest(await readFile(binary)); const sources = await sourceManifest();
for (const [path, kind, count] of [[capturePath, 'strict-candidate-actual-app-server-local-provider', 3], [lifecyclePath, 'strict-candidate-lifecycle-actual-app-server', 7]]) {
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(evidence.kind, kind); assert.equal(evidence.executable_sha256, executableHash); assert.deepEqual(evidence.source_hashes, sources);
  assert.deepEqual(evidence.errors, []); assert.equal(evidence.cases.length, count); assert(evidence.cases.every(item => item.passed));
}
const reportFile = await open(reportPath, 'wx');
const report = { kind: 'strict-candidate-managed-auth-synthetic-live', production_qualified: false, model: 'gpt-5.6-sol', effort: 'low', executable_sha256: executableHash, source_hashes: sources, cases: [], errors: [] };
report.auth_wait_sha256 = digest(await readFile(fileURLToPath(new URL('../../plugins/sol-advisor/control-plane/lib/execution/codex-managed-login.mjs', import.meta.url))));
const paths = [...new Set([join(homedir(), '.codex', 'config.toml'), ...(process.env.CODEX_HOME ? [join(process.env.CODEX_HOME, 'config.toml')] : [])])];
const configHashes = () => Promise.all(paths.map(async path => { try { return { path, sha256: digest(await readFile(path)) }; } catch (error) { if (error.code === 'ENOENT') return { path, missing: true }; throw error; } }));
let session; let fixture; let login; let phase = 'preparing';
const server = createServer((req, res) => {
  if (req.url === '/login' && login) { res.writeHead(302, { location: login.auth_url, 'cache-control': 'no-store' }).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><title>Sol synthetic Strict qualification</title><h1>Sol synthetic Strict qualification</h1><p>Status: ${phase}</p>${login ? '<a href="/login">Continue official OpenAI managed login</a>' : ''}`);
});
try {
  report.before = await configHashes(); fixture = await createProbeWorkspace(workRoot);
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const source = fileURLToPath(new URL('../skill-isolation/fixtures/allowed-skill/SKILL.md', import.meta.url)); const bytes = await readFile(source);
  for (const name of flag === '--remaining-dynamic-read-approved' ? ['dynamic-read'] : ['denied', 'explicit', 'dynamic-read']) {
    let reads = 0;
    session = await createStrictSession({ binary, expectedBinaryHash: executableHash, parent: fixture.root, cwd: fixture.cwd, model: report.model, effort: report.effort,
      skillPolicy: { mode: 'strict', implicit: 'deny', ambient_allow: [], shadowed_skill_paths: [fixture.repoSkill] },
      allowedSkills: name === 'denied' ? [] : [{ name: 'sol-isolation-allowed', source_path: source, source_hash: digest(bytes), files: { 'SKILL.md': bytes } }],
      onToolRead: () => { reads++; },
    });
    assert.equal((await session.authentication()).authenticated, false, 'Fresh profile unexpectedly inherited authentication');
    login = await session.login(); phase = `managed-login-${name}`;
    process.stdout.write(JSON.stringify({ phase, login_page: `http://127.0.0.1:${server.address().port}/` }) + '\n');
    await waitForManagedLogin(session.client, login.login_id); login = null; phase = `executing-${name}`;
    const result = await session.turn(SYNTHETIC_PROMPT, { explicit_sources: name === 'explicit' ? [source] : [], timeout_ms: 90000 });
    const outputMatches = result.output === (name === 'denied' ? 'WORKFLOW_ONLY' : 'ALLOWED_SKILL_RESULT');
    report.cases.push({ name, passed: outputMatches && (name !== 'dynamic-read' || reads > 0), output_sha256: digest(result.output), controlled_skill_reads: reads, audit: result.audit });
    assert(outputMatches, 'Synthetic marker differs; only its hash was recorded');
    if (name === 'dynamic-read') assert(reads > 0, 'Sentinel alone cannot prove controlled reading');
    await session.close(); session = null; process.stdout.write(JSON.stringify({ phase: 'case-passed', name }) + '\n');
  }
} catch (error) { report.errors.push({ code: error.code ?? null, message: error.message }); process.exitCode = 1; }
finally {
  if (session) try { await session.close(); } catch (error) { report.errors.push({ phase: 'session-cleanup', message: error.message }); process.exitCode = 1; }
  login = null; server.closeAllConnections(); await new Promise(ok => server.close(ok));
  if (fixture) {
    report.retained_profiles = (await readdir(fixture.root)).filter(name => name.startsWith('strict-node-'));
    if (!report.retained_profiles.length) await cleanupProbeWorkspace(fixture);
    else { report.errors.push({ phase: 'cleanup', message: 'Unclosed profiles retained' }); process.exitCode = 1; }
  }
  report.after = await configHashes(); report.shared_config_unchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
  if (!report.shared_config_unchanged) process.exitCode = 1;
  await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportFile.sync(); await reportFile.close();
  process.stdout.write(JSON.stringify({ phase: 'finished', cases: report.cases.map(({ name, passed }) => ({ name, passed })), errors: report.errors, shared_config_unchanged: report.shared_config_unchanged }) + '\n');
}
