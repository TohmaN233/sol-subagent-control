#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createProbeWorkspace, createTempProfile, cleanupProbeWorkspace } from './create-temp-profile.mjs';
import { createProbeClient } from './app-server-probe-client.mjs';
import { inventory, skillPathKey, assertAllowedOnly, coverage } from './assertions.mjs';

// Explicit paths keep invocation reproducible and avoid shell wrappers on Windows.
const [binaryArg, workRootArg, reportArg, ...extra] = process.argv.slice(2);
assert(binaryArg && workRootArg && reportArg && !extra.length,
  'Usage: node run-app-server-probe.mjs <absolute-codex-executable> <existing-work-root> <new-report.json>');
assert(isAbsolute(binaryArg), 'Codex executable must be absolute');
const binary = await realpath(binaryArg);
const workRoot = await realpath(workRootArg);
const reportPath = resolve(reportArg);
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
assert(!version.error && version.status === 0, 'Unable to determine Codex version');
assert(/^codex-cli \d+\.\d+\.\d+/.test(version.stdout.trim()), 'Unrecognized Codex version');

async function digest(path) {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const configPaths = [...new Set([
  join(homedir(), '.codex', 'config.toml'),
  join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
])];
const before = await Promise.all(configPaths.map(digest));
const report = {
  schema_version: 1, codex_version: version.stdout.trim(), platform: process.platform,
  inference_executed: false, strict_proven: false, m1_gate: 'incomplete',
  untested: ['model implicit invocation', 'model explicit SkillRef', 'hostile filesystem/tool bypass',
    'mid-turn crash', 'plugin-provided skills', 'real user .agents/skills fixture', 'Linux/macOS live runtime'],
  profiles: [], errors: [],
};
let workspace;
const clients = [];
try {
  workspace = await createProbeWorkspace(workRoot);
  async function prepare(label, allowRepo) {
    const profile = await createTempProfile(workspace, label);
    const server = createProbeClient(binary, { home: profile.home, cwd: workspace.cwd });
    clients.push(server);
    const row = { label, initial: [], disabled_paths: [], effective: [] };
    report.profiles.push(row);
    await server.call('initialize', { clientInfo: { name: 'sol_isolation_probe', version: '0.1.0' } });
    server.initialized();
    const list = async () => inventory(await server.call('skills/list', { cwds: [workspace.cwd], forceReload: true }), workspace.cwd);
    row.initial = await list();
    for (const fixture of [workspace.repoSkill, profile.userSkill, profile.allowedSkill]) {
      assert(row.initial.some(s => skillPathKey(s.path) === skillPathKey(fixture) && s.enabled), 'Fixture not discovered and enabled');
    }
    row.scope_coverage = coverage(row.initial);
    row.allowed_path = allowRepo ? workspace.repoSkill : profile.allowedSkill;
    for (const skill of row.initial) {
      if (skillPathKey(skill.path) === skillPathKey(row.allowed_path)) continue;
      await server.call('skills/config/write', { path: skill.path, enabled: false });
      row.disabled_paths.push(skill.path);
    }
    row.effective = await list();
    assertAllowedOnly(row.effective, row.allowed_path);
    assert.deepEqual(row.effective.map(s => s.path), row.initial.map(s => s.path), 'Inventory changed while applying policy');
    row.discovery_allowlist_passed = true;
    // This is a host read, not a model tool invocation. It proves only that disabling
    // registration does not delete the source file or alter the host filesystem ACL.
    row.repo_source_host_readable = (await readFile(workspace.repoSkill, 'utf8')).includes('SHADOWED_SKILL_B');
    row.repo_source_disabled = !row.effective.find(s => skillPathKey(s.path) === skillPathKey(workspace.repoSkill)).enabled;
    return { row, list };
  }
  const attempts = await Promise.allSettled([prepare('run-a', false), prepare('run-b', true)]);
  for (const attempt of attempts) {
    if (attempt.status === 'rejected') report.errors.push(attempt.reason.message);
    else {
      assert.deepEqual(await attempt.value.list(), attempt.value.row.effective, 'Parallel policies contaminated each other');
      attempt.value.row.parallel_recheck_passed = true;
    }
  }
} catch (error) { report.errors.push(error.message); }
finally {
  const shutdown = await Promise.allSettled(clients.map(client => client.close()));
  for (const result of shutdown) if (result.status === 'rejected') report.errors.push(result.reason.message);
  const stopped = shutdown.every(result => result.status === 'fulfilled');
  report.processes_stopped = stopped;
  try {
    const after = await Promise.all(configPaths.map(digest));
    report.real_config_unchanged = JSON.stringify(before) === JSON.stringify(after);
    assert(report.real_config_unchanged, 'Real user configuration changed');
  } catch (error) { report.errors.push(error.message); }
  if (workspace && stopped) {
    try { await cleanupProbeWorkspace(workspace); report.profiles_cleaned = true; }
    catch (error) { report.errors.push(`Cleanup failed: ${error.code || error.message}`); report.profiles_cleaned = false; }
  }
  if (workspace && !report.profiles_cleaned) report.retained_root = workspace.root;
  report.profiles.sort((a, b) => a.label.localeCompare(b.label));
  report.discovery_checks_passed = report.profiles.length === 2 && report.errors.length === 0 &&
    report.profiles.every(row => row.discovery_allowlist_passed && row.parallel_recheck_passed) &&
    report.real_config_unchanged === true && report.profiles_cleaned === true;
  if (report.profiles.some(row => row.scope_coverage?.admin !== 'observed')) report.untested.push('admin scope');
  // Never overwrite a previous result or arbitrary user configuration.
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ report: reportPath, discovery_checks_passed: report.discovery_checks_passed,
    strict_proven: false, m1_gate: 'incomplete', errors: report.errors }));
  // A successful metadata probe is deliberately insufficient for the release gate.
  process.exitCode = report.discovery_checks_passed ? 0 : 1;
}
