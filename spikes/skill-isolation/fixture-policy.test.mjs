import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProbeWorkspace, createTempProfile, cleanupProbeWorkspace } from './create-temp-profile.mjs';
import { createFixturePolicy, assertFixtureRequest, assertFixtureThread, FIXTURE_INSTRUCTIONS } from './fixture-policy.mjs';

test('fixture reads cannot access an unknown path or bypass revoked permissions', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'sol-fixture-test-'));
  const workspace = await createProbeWorkspace(parent);
  try {
    const profile = await createTempProfile(workspace, 'run-a');
    const policy = await createFixturePolicy(workspace, profile);
    assert.deepEqual(policy.tools(), []);
    assert.throws(() => policy.setAllowed([join(parent, 'secret.txt')]), /Only synthetic/);
    policy.setAllowed([profile.userSkill]);
    assert.deepEqual(policy.tools()[0].inputSchema.properties.path.enum, [profile.userSkill]);
    assert(policy.read({ path: profile.userSkill }).contentItems[0].text.includes('SHADOWED_SKILL_A'));
    assert.throws(() => policy.read({ path: profile.userSkill, command: 'extra' }), /Invalid/);
    assert.throws(() => policy.read({ path: profile.allowedSkill }), /not permitted/);
    assert.throws(() => policy.assertInventory([{ path: profile.userSkill, enabled: true }, { path: profile.allowedSkill, enabled: true }]), /Non-fixture or unexpected/);
    policy.setAllowed([]);
    assert.deepEqual(policy.tools(), []);
    assert.throws(() => policy.read({ path: profile.userSkill }), /not permitted/);
  } finally {
    await cleanupProbeWorkspace(workspace);
    await rmdir(parent); // Empty directory we created; never recursive.
  }
});

test('live request policy rejects filesystem, image, agent and unexpected Skill tools', () => {
  for (const tool of [
    { type: 'function', name: 'shell_command' }, { type: 'function', name: 'view_image' },
    { type: 'namespace', name: 'multi_agent_v1', tools: [] },
    { type: 'namespace', name: 'skills', tools: [{ type: 'function', name: 'read_arbitrary_file' }] },
  ]) assert.throws(() => assertFixtureRequest({ instructions: FIXTURE_INSTRUCTIONS, tools: [tool] }));
  assert.throws(() => assertFixtureRequest({ instructions: 'ambient instructions', tools: [] }), /Unexpected base/);
  assert.throws(() => assertFixtureThread({ instructionSources: [{ path: 'AGENTS.md' }] }), /Additional/);
});
