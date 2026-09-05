import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory, assertAllowedOnly, coverage } from './assertions.mjs';
import { createProbeWorkspace, createTempProfile, cleanupProbeWorkspace } from './create-temp-profile.mjs';

const cwd = resolve('fixture');
const allowed = resolve('fixture', 'allowed', 'SKILL.md');
const denied = resolve('fixture', 'denied', 'SKILL.md');
const skill = (path, enabled, scope = 'repo') => ({ name: 'same-name', path, enabled, scope });
const response = skills => ({ data: [{ cwd, skills, errors: [] }] });

test('allowlist is by path, and the allowed skill must still be present and enabled', () => {
  assertAllowedOnly(inventory(response([skill(allowed, true), skill(denied, false)]), cwd), allowed);
  assert.throws(() => assertAllowedOnly([skill(allowed, false)], allowed));
  assert.throws(() => assertAllowedOnly([], allowed));
  assert.throws(() => assertAllowedOnly([skill(allowed, true), skill(denied, true)], allowed));
});

test('inventory rejects incomplete, ambiguous, erroneous, and wrong-cwd responses', () => {
  for (const result of [{}, { data: [] }, response([skill(allowed, undefined)]),
    response([skill(allowed, true), skill(allowed, false)]), response([skill('relative', true)]),
    response([skill(allowed, true, 'unknown')]),
    { data: [{ cwd, skills: [], errors: [{ message: 'unreadable' }] }] }]) {
    assert.throws(() => inventory(result, cwd));
  }
  assert.throws(() => inventory(response([]), resolve('another-cwd')));
});

test('unobserved scopes are not reported as passing', () => {
  assert.deepEqual(coverage([skill(allowed, true)]), {
    repo: 'observed', user: 'not_observed', admin: 'not_observed', system: 'not_observed',
  });
});

test('temporary profiles use separate homes and reject linked cleanup targets', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'sol-probe-test-'));
  const workspace = await createProbeWorkspace(parent);
  const a = await createTempProfile(workspace, 'run-a');
  const b = await createTempProfile(workspace, 'run-b');
  assert.notEqual(a.home, b.home);
  await assert.rejects(createTempProfile(workspace, '../outside'));
  const target = join(parent, 'target');
  const link = join(parent, 'skill-isolation-linked');
  await mkdir(target);
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(cleanupProbeWorkspace({ parent, root: link }), /linked probe root/);
  } finally {
    await cleanupProbeWorkspace(workspace);
    // Resolve and verify the generated test root before recursive deletion on Windows.
    const actual = await realpath(parent);
    assert.equal(dirname(actual), await realpath(tmpdir()));
    assert(basename(actual).startsWith('sol-probe-test-'));
    await rm(parent, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});
