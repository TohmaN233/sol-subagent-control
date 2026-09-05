import assert from 'node:assert/strict';
import { isAbsolute, normalize } from 'node:path';

export function skillPathKey(path) {
  assert.equal(typeof path, 'string', 'Skill path must be a string');
  assert(isAbsolute(path), 'Skill path must be absolute');
  const key = normalize(path);
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

export function inventory(result, cwd) {
  assert(Array.isArray(result?.data), 'Unsupported skills/list response');
  assert.equal(result.data.length, 1, 'Expected one cwd inventory');
  const entry = result.data[0];
  assert.equal(skillPathKey(entry.cwd), skillPathKey(cwd), 'Inventory cwd mismatch');
  assert.deepEqual(entry.errors, [], 'Discovery errors invalidate coverage');
  assert(Array.isArray(entry.skills), 'Unsupported skills/list skills');
  const seen = new Set();
  return entry.skills.map(({ name, path, scope, enabled }) => {
    assert.equal(typeof name, 'string');
    assert(['repo', 'user', 'admin', 'system'].includes(scope), 'Unknown skill scope');
    assert.equal(typeof enabled, 'boolean', 'Missing enabled flag');
    const key = skillPathKey(path);
    assert(!seen.has(key), 'Duplicate skill path');
    seen.add(key);
    return { name, path, scope, enabled };
  }).sort((a, b) => skillPathKey(a.path).localeCompare(skillPathKey(b.path), 'en'));
}

export function assertAllowedOnly(skills, allowedPath) {
  const enabled = skills.filter(skill => skill.enabled).map(skill => skillPathKey(skill.path));
  assert.deepEqual(enabled, [skillPathKey(allowedPath)], 'Allowlist not enforced (including missing allowed skill)');
}

export function coverage(skills) {
  return Object.fromEntries(['repo', 'user', 'admin', 'system'].map(scope => [
    scope, skills.some(skill => skill.scope === scope) ? 'observed' : 'not_observed',
  ]));
}
