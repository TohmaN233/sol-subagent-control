import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from './physical-tempdir.mjs';
import { join, resolve } from 'node:path';
import { buildCodexProfile, cleanupCodexProfile, isolatedEnvironment } from '../lib/execution/codex-profile-builder.mjs';
import { createSkillPolicy, skillPathKey } from '../lib/execution/codex-skill-policy.mjs';
import { digest } from '../lib/workflow-revisions.mjs';

async function fixture(t, { profile = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'strict-execution-')); const binary = join(root, 'fixture-binary'); await writeFile(binary, 'Synthetic never-executed binary');
  t.after(async () => { assert(resolve(root).startsWith(resolve(tmpdir()))); await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }); });
  const options = { parent: root, binary, expectedBinaryHash: digest(await readFile(binary)), model: 'synthetic-model', effort: 'low', modelMetadata: { slug: 'synthetic-model', supported_reasoning_levels: [{ effort: 'low' }] } };
  if (!profile) {
    const home = join(root, 'catalog-fixture'); await mkdir(join(home, 'skills'), { recursive: true });
    return { root, options, profile: { home } };
  }
  if (!['win32', 'linux'].includes(process.platform)) {
    await assert.rejects(buildCodexProfile(options), { code: 'PROCESS_IDENTITY_UNSUPPORTED' });
    return null; // The unsupported platform's refusal was actually asserted.
  }
  return { root, options, profile: await buildCodexProfile(options) };
}
const strict = { mode: 'strict', implicit: 'deny', shadowed_skill_paths: [], ambient_allow: [] };
const skillText = '---\nname: allowed\ndescription: Synthetic fixture\n---\nALLOWED_SENTINEL';
function metadataClient(cwd, skills) {
  return { async call(method, args) {
    if (method === 'skills/list') return { data: [{ cwd, errors: [], skills: structuredClone(skills) }] };
    assert.equal(method, 'skills/config/write'); const found = skills.find(skill => skillPathKey(skill.path) === skillPathKey(args.path)); assert(found); found.enabled = args.enabled; return {};
  } };
}

test('Strict profile fails closed on unsupported ownership or changed binary and strips inherited overrides', async t => {
  const f = await fixture(t); if (!f) return; const env = isolatedEnvironment({ PATH: 'fixture-path', USERPROFILE: 'fixture-user', CODEX_HOME: 'shared', CODEX_CONFIG: 'untrusted', OPENAI_API_KEY: 'sensitive', SOL_CONTROL_DISABLED: '1' }, f.profile.home);
  assert.equal(env.CODEX_HOME, f.profile.home); assert.equal(env.CODEX_CONFIG, undefined); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.PATH, 'fixture-path');
  await writeFile(f.options.binary, 'Changed binary'); await assert.rejects(buildCodexProfile(f.options), { code: 'CODEX_BINARY_CHANGED' });
  await assert.rejects(cleanupCodexProfile({ ...f.profile, owner_token: 'wrong' }), { code: 'PROFILE_OWNER' });
  await cleanupCodexProfile(f.profile);
});

test('Strict catalog enforcement is by path, explicit injection is separate, and policy changes invalidate launch', async t => {
  const f = await fixture(t, { profile: false }); const source = join(f.root, 'source', 'SKILL.md'); const cwd = join(f.root, 'workspace'); await mkdir(cwd);
  const policy = await createSkillPolicy({ home: f.profile.home, cwd, skillPolicy: strict, allowed: [{ source_path: source, source_hash: digest(skillText), name: 'allowed', files: { 'SKILL.md': skillText, 'references/example.txt': 'Owned resource' } }] });
  const input = policy.explicitInputs([source])[0];
  const disallowed = join(cwd, '.agents', 'skills', 'same-name', 'SKILL.md');
  const skills = [{ name: 'allowed', path: disallowed, scope: 'repo', enabled: true }, { name: 'allowed', path: input.path, scope: 'user', enabled: true }];
  const client = metadataClient(cwd, skills); const audit = await policy.apply(client); assert.deepEqual(audit.disabled_skills, [disallowed]);
  assert.equal(policy.read({ path: input.path }).contentItems[0].text, skillText);
  assert.throws(() => policy.read({ path: disallowed }), { code: 'SKILL_READ_DENIED' });
  assert.throws(() => policy.explicitInputs([disallowed]), { code: 'SKILL_INJECTION_DENIED' });
  skills.push({ name: 'new', path: join(cwd, 'new', 'SKILL.md'), scope: 'repo', enabled: true });
  await assert.rejects(policy.verify(client), { code: 'SKILL_ISOLATION_FAILED' }); skills.pop();
  await chmod(input.path, 0o600); await writeFile(input.path, 'Changed owned snapshot'); await assert.rejects(policy.verify(client), { code: 'SKILL_PIN_CHANGED' });
});

test('unqualified administrative scope, shadowed source and unpinned ambient grant fail closed', async t => {
  const f = await fixture(t, { profile: false }); const source = join(f.root, 'SKILL.md');
  await assert.rejects(createSkillPolicy({ home: f.profile.home, cwd: f.root, skillPolicy: { ...strict, shadowed_skill_paths: [source] }, allowed: [{ source_path: source, source_hash: digest(skillText), name: 'allowed', files: { 'SKILL.md': skillText } }] }), { code: 'SKILL_SHADOWED' });
  await assert.rejects(createSkillPolicy({ home: f.profile.home, cwd: f.root, skillPolicy: { ...strict, ambient_allow: [source] } }), { code: 'SKILL_ALLOW_UNPINNED' });
  const policy = await createSkillPolicy({ home: f.profile.home, cwd: f.root, skillPolicy: strict });
  await assert.rejects(policy.apply(metadataClient(f.root, [{ name: 'admin', path: source, scope: 'admin', enabled: true }])), { code: 'SKILL_SCOPE_UNQUALIFIED' });
  assert.deepEqual(policy.tools(), []);
});
