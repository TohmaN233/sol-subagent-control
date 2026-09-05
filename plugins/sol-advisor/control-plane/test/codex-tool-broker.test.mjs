import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, link, symlink } from 'node:fs/promises';
import { tmpdir } from './physical-tempdir.mjs';
import { tmpdir as osTmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createCodexToolBroker } from '../lib/execution/codex-tool-broker.mjs';
import { digest } from '../lib/workflow-revisions.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-broker-'));
  t.after(() => rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }));
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'main.txt'), 'before');
  const operations = []; let active = true;
  const options = { workspace: root, access: 'bounded_write', allowedPaths: ['src'], authorize: async () => { assert(active, 'lease revoked'); }, onOperation: async event => operations.push(event) };
  return { root, options, operations, revoke: () => { active = false; } };
}
const output = result => JSON.parse(result.contentItems[0].text);

test('workspace broker performs audited CAS writes and rejects stale observations', async t => {
  const f = await fixture(t); const broker = await createCodexToolBroker(f.options);
  const read = output(await broker.call('read_workspace', { path: 'src/main.txt' }, 'read-1'));
  assert.equal(read.sha256, digest('before'));
  await broker.call('write_workspace', { path: 'src/main.txt', expected_sha256: read.sha256, text: 'after' }, 'write-1');
  assert.equal(await readFile(join(f.root, 'src', 'main.txt'), 'utf8'), 'after');
  assert.deepEqual(f.operations.map(event => event.phase), ['read', 'intent', 'committed']);
  await assert.rejects(broker.call('write_workspace', { path: 'src/main.txt', expected_sha256: read.sha256, text: 'stale' }, 'write-2'), { code: 'CODEX_TOOL_WRITE_CONFLICT' });
});

test('workspace broker blocks traversal, runtime and Skill paths, links and write scope escape', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'private')); await writeFile(join(f.root, 'private', 'secret'), 'secret');
  await link(join(f.root, 'private', 'secret'), join(f.root, 'src', 'hardlink'));
  await symlink(join(f.root, 'private'), join(f.root, 'src', 'linked-directory'), 'junction');
  for (const [name, args, code] of [
    ['read_workspace', { path: '../outside' }, 'INVALID_RESOURCE_PATH'],
    ['read_workspace', { path: '.codex/config.toml' }, 'CODEX_TOOL_PATH_DENIED'],
    ['read_workspace', { path: 'src/SKILL.md' }, 'CODEX_TOOL_PATH_DENIED'],
    ['read_workspace', { path: 'private/secret' }, 'CODEX_TOOL_PATH_DENIED'],
    ['read_workspace', { path: 'src/hardlink' }, 'CODEX_TOOL_FILE'],
    ['read_workspace', { path: 'src/linked-directory/secret' }, 'WORKFLOW_SYMLINK'],
    ['write_workspace', { path: 'out.txt', expected_sha256: null, text: 'no' }, 'CODEX_TOOL_WRITE_DENIED'],
  ]) {
    const broker = await createCodexToolBroker({ ...f.options, deniedPaths: [join(f.root, 'private')] });
    await assert.rejects(broker.call(name, args, 'denied'), { code });
  }
  const readonly = await createCodexToolBroker({ ...f.options, access: 'read_only' });
  assert(!readonly.tools().some(tool => tool.name === 'write_workspace'));
  await assert.rejects(readonly.call('write_workspace', { path: 'src/main.txt', text: 'no', expected_sha256: digest('before') }, 'denied'), { code: 'CODEX_TOOL_DENIED' });
});

test('pinned resources ignore mutable source files and do not permit arbitrary reads', async t => {
  const f = await fixture(t); const broker = await createCodexToolBroker({ ...f.options, resources: [{ path: 'references/guide.txt', bytes: 'Pinned text', sha256: digest('Pinned text') }] });
  assert.equal(output(await broker.call('read_workflow_resource', { path: 'references/guide.txt' }, 'resource')).text, 'Pinned text');
  await assert.rejects(broker.call('read_workflow_resource', { path: 'src/main.txt' }, 'denied'), { code: 'CODEX_RESOURCE_DENIED' });
});

test('Windows environment short paths retain denied-directory identity after workspace canonicalization', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'private')); await writeFile(join(f.root, 'private', 'secret'), 'do not expose');
  const alias = join(osTmpdir(), relative(tmpdir(), f.root));
  const broker = await createCodexToolBroker({ ...f.options, workspace: alias, deniedPaths: [join(alias, 'private'), join(alias, 'not-created')] });
  for (const path of ['private/secret', 'not-created/file']) await assert.rejects(broker.call('read_workspace', { path }, path), { code: 'CODEX_TOOL_PATH_DENIED' });
});

test('revoked lease and failed audit prevent writes; a post-commit audit error reports its side effect', async t => {
  const f = await fixture(t); const args = { path: 'src/main.txt', expected_sha256: digest('before'), text: 'after' };
  const rejected = await createCodexToolBroker({ ...f.options, onOperation: async () => { throw new Error('journal unavailable'); } });
  await assert.rejects(rejected.call('write_workspace', args, 'intent'), /journal unavailable/);
  assert.equal(await readFile(join(f.root, 'src', 'main.txt'), 'utf8'), 'before');
  const committed = await createCodexToolBroker({ ...f.options, onOperation: async event => { if (event.phase === 'committed') throw new Error('journal unavailable'); } });
  await assert.rejects(committed.call('write_workspace', args, 'commit'), error => error.committed === true && error.operation.after_sha256 === digest('after'));
  assert.equal(await readFile(join(f.root, 'src', 'main.txt'), 'utf8'), 'after');
  const revoked = await createCodexToolBroker(f.options); f.revoke();
  await assert.rejects(revoked.call('read_workspace', { path: 'src/main.txt' }, 'revoked'), /lease revoked/);
});

test('shutdown revokes a write waiting on its durable intent and waits for its explicit failure outcome', async t => {
  const f = await fixture(t); let releaseIntent; let observedIntent;
  const intentSeen = new Promise(resolve => { observedIntent = resolve; });
  const intentGate = new Promise(resolve => { releaseIntent = resolve; });
  const broker = await createCodexToolBroker({ ...f.options, onOperation: async event => {
    if (event.phase === 'intent') { observedIntent(); await intentGate; }
  } });
  const pending = broker.call('write_workspace', { path: 'src/main.txt', text: 'must-not-write', expected_sha256: digest('before') }, 'shutdown-write');
  const rejected = assert.rejects(pending, { code: 'CODEX_BROKER_REVOKED' });
  await intentSeen; broker.revoke(); const drained = broker.quiesce(); releaseIntent(); await rejected;
  const outcome = await drained; assert.equal(outcome.quiescent, true); assert.equal(outcome.error.code, 'CODEX_BROKER_REVOKED');
  assert.equal(await readFile(join(f.root, 'src', 'main.txt'), 'utf8'), 'before');
});
