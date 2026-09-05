import assert from 'node:assert/strict';
import { mkdir, mkdtemp, cp, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export async function createProbeWorkspace(workRoot) {
  const parent = await realpath(workRoot);
  const root = await mkdtemp(join(parent, 'skill-isolation-'));
  try {
    const cwd = join(root, 'repo');
    // A disposable repository discovery boundary. No git operations or user repo are involved.
    await mkdir(join(cwd, '.git'), { recursive: true });
    const repoRoot = join(cwd, '.agents', 'skills');
    await mkdir(repoRoot, { recursive: true });
    await cp(join(fixtures, 'conflicting-skill-b'), join(repoRoot, 'conflicting-skill-b'), { recursive: true });
    return { parent, root, cwd, repoSkill: join(repoRoot, 'conflicting-skill-b', 'SKILL.md') };
  } catch (error) {
    try { await cleanupProbeWorkspace({ parent, root }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `Probe setup and cleanup failed; retained root: ${root}`); }
    throw error;
  }
}

export async function createTempProfile(workspace, label) {
  assert(['run-a', 'run-b'].includes(label), 'Unexpected probe label');
  const home = join(workspace.root, label);
  await mkdir(home);
  for (const name of ['conflicting-skill-a', 'allowed-skill']) {
    await cp(join(fixtures, name), join(home, 'skills', name), { recursive: true });
  }
  await writeFile(join(home, 'config.toml'), 'approval_policy = "never"\nsandbox_mode = "read-only"\n');
  return {
    home,
    userSkill: join(home, 'skills', 'conflicting-skill-a', 'SKILL.md'),
    allowedSkill: join(home, 'skills', 'allowed-skill', 'SKILL.md'),
  };
}

export async function cleanupProbeWorkspace({ parent, root }) {
  assert(!(await lstat(root)).isSymbolicLink(), 'Refusing linked probe root');
  const actual = await realpath(root);
  const rel = relative(parent, actual);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Unsafe cleanup path');
  assert.equal(dirname(actual), parent, 'Probe root must be a direct child of its owned parent');
  assert(rel.startsWith('skill-isolation-'), 'Unexpected probe directory name');
  // Windows releases process cwd and file handles asynchronously after close.
  // Exhausted retries still throw and are reported as a cleanup failure.
  await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
}
