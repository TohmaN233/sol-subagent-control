import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = dirname(testDir);
const pluginDir = dirname(scriptsDir);
const installer = join(scriptsDir, 'install-agents.mjs');
const runtimeInspector = join(scriptsDir, 'inspect-agent-runtime.mjs');
const templatesDir = join(pluginDir, 'agents');
const orchestrationSkill = join(pluginDir, 'skills', 'orchestration', 'SKILL.md');
const operationsReference = join(pluginDir, 'skills', 'orchestration', 'references', 'operations.md');
const roleFiles = [
  'sol-advisor-luna-implementer.toml',
  'sol-advisor-terra-implementer.toml',
  'sol-advisor-sol-reviewer.toml',
];

function runNode(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env },
  });
}

test('installs and checks exact native roles without a shell', async (t) => {
  const targetDir = await mkdtemp(join(tmpdir(), 'sol-advisor-native-install-'));
  t.after(() => rm(targetDir, { recursive: true, force: true }));

  const install = runNode(installer, ['--target-dir', targetDir]);
  assert.equal(install.status, 0, install.stderr);

  for (const roleFile of roleFiles) {
    const [expected, actual] = await Promise.all([
      readFile(join(templatesDir, roleFile)),
      readFile(join(targetDir, roleFile)),
    ]);
    assert.deepEqual(actual, expected, roleFile);
  }

  const check = runNode(installer, ['--target-dir', targetDir, '--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /CHECK PASSED/);
});

test('selective checks ignore unselected conflicts and explicit mismatches fail', async (t) => {
  const targetDir = await mkdtemp(join(tmpdir(), 'sol-advisor-native-conflict-'));
  t.after(() => rm(targetDir, { recursive: true, force: true }));
  assert.equal(runNode(installer, ['--target-dir', targetDir]).status, 0);

  const terraFile = join(targetDir, 'sol-advisor-terra-implementer.toml');
  await writeFile(terraFile, 'user-modified-terra\n', 'utf8');

  const selected = runNode(installer, [
    '--target-dir', targetDir,
    '--check-role', 'luna',
    '--check-role', 'sol',
  ]);
  assert.equal(selected.status, 0, selected.stderr);

  const mismatch = runNode(installer, ['--target-dir', targetDir, '--check-role', 'terra']);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /Terra template is conflict/);

  const reinstall = runNode(installer, ['--target-dir', targetDir]);
  assert.equal(reinstall.status, 1);
  assert.equal(await readFile(terraFile, 'utf8'), 'user-modified-terra\n');
});

test('emits allowlisted runtime evidence without shell or jq', async (t) => {
  const sessionsDir = await mkdtemp(join(tmpdir(), 'sol-advisor-runtime-'));
  t.after(() => rm(sessionsDir, { recursive: true, force: true }));
  const nestedDir = join(sessionsDir, '2026', '08', '21');
  await mkdir(nestedDir, { recursive: true });
  const threadId = '12345678-1234-4abc-8def-1234567890ab';
  const rollout = [
    {
      type: 'session_meta',
      payload: {
        id: threadId,
        parent_thread_id: '00000000-0000-7000-8000-000000000000',
        agent_role: 'sol_advisor_luna_implementer',
        agent_path: '/fixture',
        model_provider: 'openai',
        ignored_secret: 'must-not-leak',
      },
    },
    {
      type: 'turn_context',
      payload: {
        model: 'gpt-5.6-luna',
        effort: 'max',
        sandbox_policy: { type: 'workspace-write', ignored: true },
        permission_profile: { type: 'managed' },
        cwd: '/fixture',
        ignored_prompt: 'must-not-leak',
      },
    },
  ];
  await writeFile(
    join(nestedDir, `rollout-fixture-${threadId}.jsonl`),
    `${rollout.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );

  const result = runNode(runtimeInspector, ['--sessions-dir', sessionsDir, threadId]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    thread_id: threadId,
    parent_thread_id: '00000000-0000-7000-8000-000000000000',
    agent_role: 'sol_advisor_luna_implementer',
    agent_path: '/fixture',
    model_provider: 'openai',
    model: 'gpt-5.6-luna',
    effort: 'max',
    sandbox_policy_type: 'workspace-write',
    permission_profile_type: 'managed',
    cwd: '/fixture',
  });
  assert.doesNotMatch(result.stdout, /must-not-leak/);
});

test('documents unavailable validation as non-blocking and explicit mismatch as blocking', async () => {
  const contract = `${await readFile(orchestrationSkill, 'utf8')}\n${await readFile(operationsReference, 'utf8')}`;
  assert.match(contract, /ROLE VALIDATION UNAVAILABLE/);
  assert.match(contract, /continue the task/i);
  assert.match(contract, /must not claim.*verified/i);
  assert.match(contract, /explicit.*mismatch.*stop/i);
});
