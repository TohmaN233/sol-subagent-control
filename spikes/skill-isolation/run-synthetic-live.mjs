import assert from 'node:assert/strict';
import { open, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProbeWorkspace, createTempProfile, cleanupProbeWorkspace } from './create-temp-profile.mjs';
import { startSyntheticSession, PROBE_MODEL } from './synthetic-turns.mjs';

// Explicit opt-in only. Review the payload and obtain authorization before using this entry point.
const [flag, binary, workRoot, capturePath, reportPath, loginPath] = process.argv.slice(2);
assert.equal(flag, '--live-approved', 'Live testing requires prior payload/destination approval');
assert.equal(process.argv.length, 8, 'Usage: node run-synthetic-live.mjs --live-approved <codex-exe> <work-root> <passed-capture.json> <new-report.json> <new-login.json>');
for (const path of [binary, workRoot, capturePath, reportPath, loginPath]) assert(isAbsolute(path), 'Use absolute paths');
const hash = data => createHash('sha256').update(data).digest('hex');
const capture = JSON.parse(await readFile(capturePath, 'utf8'));
assert.equal(capture.kind, 'actual-app-server-local-model-stub');
assert.equal(capture.status, 'passed', 'Offline request capture must pass first');
assert.equal(capture.executable_sha256, hash(await readFile(binary)), 'Runtime changed since request capture');
const sources = [
  'fixture-policy.mjs', 'synthetic-turns.mjs', 'turn-probe-client.mjs', 'create-temp-profile.mjs', 'assertions.mjs',
  'fixtures/conflicting-skill-a/SKILL.md', 'fixtures/conflicting-skill-b/SKILL.md',
  'fixtures/allowed-skill/SKILL.md', 'fixtures/allowed-skill/agents/openai.yaml',
];
assert.deepEqual(Object.keys(capture.fixture_source_hashes).sort(), [...sources].sort(), 'Incomplete source evidence');
for (const path of sources) assert.equal(capture.fixture_source_hashes[path], hash(await readFile(fileURLToPath(new URL(path, import.meta.url)))), `Probe source changed: ${path}`);
const reportFile = await open(reportPath, 'wx');
const report = { kind: 'managed-auth-synthetic-live', model: PROBE_MODEL, strict_proven: false, m1_gate: 'incomplete', cases: [], executable_sha256: capture.executable_sha256 };
const configPaths = [...new Set([join(homedir(), '.codex', 'config.toml'), ...(process.env.CODEX_HOME ? [join(process.env.CODEX_HOME, 'config.toml')] : [])])];
async function configHashes() {
  return Promise.all(configPaths.map(async path => {
    try { return hash(await readFile(path)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
}
let workspace;
let session;
let pendingLogin;
let loginFileCreated = false;
let before;
try {
  before = await configHashes();
  workspace = await createProbeWorkspace(workRoot);
  const profile = await createTempProfile(workspace, 'run-a');
  session = await startSyntheticSession(binary, workspace, profile, { live: true });
  // Before auth or turns, allow only synthetic user fixtures. No source Skills are copied.
  await session.setAllowed([profile.userSkill, profile.allowedSkill]);
  const account = await session.client.call('account/read', { refreshToken: false });
  assert.equal(account.account, null, 'Unexpected credentials in fresh profile');
  const login = await session.client.call('account/login/start', { type: 'chatgpt' });
  pendingLogin = login.loginId;
  assert.equal(new URL(login.authUrl).hostname, 'auth.openai.com', 'Unexpected authentication destination');
  await writeFile(loginPath, JSON.stringify({ authUrl: login.authUrl, loginId: pendingLogin }), { flag: 'wx' });
  loginFileCreated = true;
  console.log(JSON.stringify({ phase: 'managed-login-required', login_file: loginPath }));
  const auth = await session.client.waitFor(event => event.method === 'account/login/completed' && event.params.loginId === pendingLogin, { timeout: 600000 });
  pendingLogin = undefined;
  if (!auth.params.success) {
    report.auth_failure = String(auth.params.error).includes('Token exchange failed') ? 'token_exchange_failed' : 'managed_login_failed';
    throw new Error(report.auth_failure);
  }
  console.log(JSON.stringify({ phase: 'managed-login-completed' }));
  const cases = [
    ['implicit-fixture', [profile.userSkill, profile.allowedSkill], {}, 'SHADOWED_SKILL_A'],
    ['denied-background', [], {}, 'WORKFLOW_ONLY'],
    ['explicit-allowed', [profile.allowedSkill], { explicit: true }, 'ALLOWED_SKILL_RESULT'],
  ];
  for (const [label, allowed, options, expected] of cases) {
    await session.setAllowed(allowed);
    const result = await session.turn(label, options);
    report.cases.push({ label, status: result.status, output_matches: result.output === expected, output_sha256: hash(result.output), fixture_read_count: result.reads.length, item_types: result.item_types });
    assert.equal(result.output, expected, `Unexpected ${label} output; hash recorded`);
    if (label === 'implicit-fixture') assert(result.reads.length > 0, 'Sentinel alone cannot prove implicit fixture loading');
    console.log(JSON.stringify({ phase: 'case-passed', label }));
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
  const errors = [];
  if (pendingLogin) try { await session.client.call('account/login/cancel', { loginId: pendingLogin }); } catch (error) { errors.push(error.message); }
  let closed = !session;
  if (session) try { await session.client.close(); closed = true; } catch (error) { errors.push(error.message); }
  if (workspace && closed) try { await cleanupProbeWorkspace(workspace); report.profiles_cleaned = true; } catch (error) { errors.push(error.message); }
  if (loginFileCreated) try { await rm(loginPath); } catch (error) { errors.push(error.message); }
  if (before) try { assert.deepEqual(await configHashes(), before, 'Real configuration changed'); report.real_config_unchanged = true; } catch (error) { errors.push(error.message); }
  if (errors.length) { report.cleanup_errors = errors; report.status = 'failed'; process.exitCode = 1; }
  await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n');
  await reportFile.close();
  console.log(JSON.stringify({ phase: 'finished', status: report.status, error: report.error, strict_proven: false }));
}
