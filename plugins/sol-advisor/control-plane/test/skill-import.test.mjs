import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSkillSnapshot, parseSkill } from '../lib/skill-import/skill-reader.mjs';
import { compileCoarseSkill, importCoarseSkill, verifyCoarseRelocation } from '../lib/skill-import/coarse-compiler.mjs';
import { WorkflowStore } from '../lib/workflow-store.mjs';
import { validateWorkflowGraph } from '../lib/workflow-validator.mjs';
import { digest, canonicalJSON } from '../lib/workflow-revisions.mjs';
import { SkillInventory } from '../lib/skill-import/inventory.mjs';
import { expansionPacket, applyExpansion } from '../lib/skill-import/semantic-expander.mjs';

async function fixture(t, body = 'Read [the guide](references/guide.md) and return a result.') {
  const root = await mkdtemp(join(tmpdir(), 'skill-import-')); t.after(() => rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }));
  const sourceRoot = join(root, 'original'); await mkdir(join(sourceRoot, 'references'), { recursive: true });
  const source = join(sourceRoot, 'SKILL.md');
  await writeFile(source, '---\nname: "Example: quoted name"\ndescription: >-\n  A folded description\n  across two lines.\nlicense: ISC\n---\n\n' + body);
  await writeFile(join(sourceRoot, 'references', 'guide.md'), 'A self-contained reference.');
  const store = await new WorkflowStore(join(root, 'packs')).initialize(); return { root, sourceRoot, source, store };
}

test('real YAML parsing preserves quoted and folded metadata and rejects duplicate keys and unsafe aliases', () => {
  assert.equal(parseSkill('---\nname: "A: B"\ndescription: >-\n  First\n  second\n---\nDo work.').metadata.description, 'First second');
  assert.throws(() => parseSkill('---\nname: a\nname: b\ndescription: test\n---\nDo work.'), { code: 'SKILL_YAML' });
  assert.throws(() => parseSkill('---\nname: a\ndescription: !unsafe test\n---\nDo work.'), { code: 'SKILL_YAML' });
});

test('coarse import is deterministic, preserves both metadata formats and survives source removal', async t => {
  const f = await fixture(t); const original = await readFile(f.source);
  await mkdir(join(f.sourceRoot, 'agents')); await writeFile(join(f.sourceRoot, 'agents', 'openai.yaml'), 'interface:\n  display_name: Example\n');
  await writeFile(join(f.sourceRoot, 'SKILL.json'), '{"name":"Example"}');
  const source = await readSkillSnapshot(f.source, { expectedSourceHash: digest(original) });
  const one = compileCoarseSkill(source, { id: 'imported', providerId: 'chosen' });
  const two = compileCoarseSkill(source, { id: 'imported', providerId: 'chosen' });
  assert.equal(canonicalJSON(one.workflow), canonicalJSON(two.workflow)); assert.equal(one.workflow.status, 'draft');
  assert.deepEqual(one.workflow.nodes.map(node => node.type), ['start', 'agent', 'agent', 'end']);
  assert.equal(one.workflow.nodes[1].executor.provider_id, 'chosen'); assert.deepEqual(Object.keys(one.provenance.metadata_files).sort(), ['SKILL.json', 'agents/openai.yaml']);
  const pack = await f.store.create(one.workflow, one); assert.deepEqual(await readFile(f.source), original);
  await rm(f.sourceRoot, { recursive: true });
  const resources = await f.store.resources('imported'); const evidence = verifyCoarseRelocation(pack, resources);
  assert.equal(evidence.source_independent, true); assert.equal(evidence.original_source_read, false); assert.equal(evidence.files_verified, 4);
  assert.equal(resources['source/SKILL.md'].toString(), original.toString());
});

test('scripts, missing references, external paths and credential resources stay observable and blocked', async t => {
  const f = await fixture(t, 'Read [missing](../outside.txt). Use C:\\private\\source.');
  await mkdir(join(f.sourceRoot, 'scripts')); await writeFile(join(f.sourceRoot, 'scripts', 'run.mjs'), 'throw new Error("IMPORT_MUST_NEVER_EXECUTE_THIS");\nconst key = process.env.REQUIRED_KEY;');
  await writeFile(join(f.sourceRoot, '.env'), 'SYNTHETIC_SECRET_VALUE=must-not-be-copied');
  const pack = await importCoarseSkill(f.store, f.source, { id: 'requirements', providerId: 'chosen' });
  assert.equal(pack.import_report.scripts_executed, 0);
  assert(pack.workflow.import_status.unresolved.some(item => item.code === 'SCRIPT_REQUIRES_REVIEW'));
  assert(pack.workflow.import_status.unresolved.some(item => item.code === 'UNRESOLVED_LOCAL_REFERENCE'));
  assert(pack.workflow.import_status.unresolved.some(item => item.code === 'CREDENTIAL_FILE_EXCLUDED'));
  const resources = await f.store.resources('requirements'); assert.equal(resources['source/.env'], undefined);
  assert.deepEqual(pack.workflow.requirements.environment, ['REQUIRED_KEY']);
  const validation = validateWorkflowGraph({ ...pack.workflow, status: 'ready' }, { providers: [{ id: 'chosen', enabled: true, capabilities: { read: true } }], tools: ['read_workflow_resource'], executables: ['node'] });
  assert(validation.blockers.some(item => item.code === 'IMPORT_UNRESOLVED'));
  assert(validation.blockers.some(item => item.requirement === 'REQUIRED_KEY'));
  assert.throws(() => verifyCoarseRelocation(pack, resources), { code: 'IMPORT_UNRESOLVED' });
});

test('known secret values are redacted with explicit Draft blockers; source bytes stay unchanged', async t => {
  const secret = 'sk-proj-' + 'x'.repeat(40); const f = await fixture(t, 'Use token ' + secret + ' in an example.');
  await writeFile(join(f.sourceRoot, 'settings.json'), '{"password":"synthetic-sensitive-value"}');
  const sourceBytes = await readFile(f.source); const pack = await importCoarseSkill(f.store, f.source, { id: 'redacted' });
  const resources = await f.store.resources('redacted');
  assert(!resources['source/SKILL.md'].toString().includes(secret));
  assert(!resources['source/settings.json'].toString().includes('synthetic-sensitive-value'));
  assert(pack.workflow.import_status.unresolved.some(item => item.code === 'CREDENTIAL_REDACTED'));
  assert.equal(pack.provenance.source_hash, digest(sourceBytes)); assert.deepEqual(await readFile(f.source), sourceBytes);
});

test('linked resources are excluded with evidence and stale selected source is rejected', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'outside')); await symlink(join(f.root, 'outside'), join(f.sourceRoot, 'linked'), 'junction');
  const snapshot = await readSkillSnapshot(f.source); assert(snapshot.problems.some(item => item.code === 'LINK_OR_SPECIAL_RESOURCE'));
  await assert.rejects(readSkillSnapshot(f.source, { expectedSourceHash: 'a'.repeat(64) }), { code: 'SKILL_SOURCE_CHANGED' });
});

test('host inventory exposes per-path read errors and stale selections cannot import changed bytes', async t => {
  const f = await fixture(t);
  const inventory = new SkillInventory(async () => ({ skills: [{ path: f.source, scope: 'user', enabled: true }, { path: join(f.sourceRoot, 'missing', 'SKILL.md'), scope: 'user', enabled: true }], errors: [] }));
  const listed = await inventory.list(f.root); assert.equal(listed.complete, false); assert.equal(listed.entries.length, 1); assert.equal(listed.errors.length, 1);
  assert.equal((await inventory.select(f.root, listed.entries[0].id)).source_hash, digest(await readFile(f.source)));
  await writeFile(f.source, (await readFile(f.source, 'utf8')) + '\nChanged');
  await assert.rejects(inventory.select(f.root, listed.entries[0].id), { code: 'SKILL_SELECTION_STALE' });
});

test('AI expansion stays Draft, pins inferences, preserves authority and retains the coarse revision on failure', async t => {
  const f = await fixture(t); const provider = { id: 'chosen', enabled: true, capabilities: { read: true } };
  const pack = await importCoarseSkill(f.store, f.source, { id: 'expanded', providerId: provider.id }); const resources = await f.store.resources('expanded');
  const packet = expansionPacket(pack, resources, provider); assert.equal(packet.access, 'read_only'); assert.equal(packet.source_revision, pack.revision_hash);
  assert.throws(() => expansionPacket(pack, resources, { ...provider, enabled: false }), { code: 'EXPANSION_PROVIDER' });
  const inference = { confidence: 0.7, source_span: { resource: 'source/SKILL.md', start_line: 9, end_line: 9 } };
  const proposal = { source_revision: pack.revision_hash, nodes: [{ id: 'step', type: 'agent', prompt_template: 'Apply the pinned guide to {{task}}', ...inference }],
    edges: [{ id: 'start-step', source: 'start', target: 'step', ...inference }, { id: 'step-final', source: 'step', target: 'final', ...inference }] };
  const invalid = structuredClone(proposal); invalid.nodes[0].access = 'bounded_write';
  await assert.rejects(applyExpansion(f.store, 'expanded', invalid, { expected_revision: pack.revision_hash, context: { providers: [provider] } }), { code: 'EXPANSION_AUTHORITY' });
  assert.equal((await f.store.snapshot('expanded')).revision_hash, pack.revision_hash);
  const next = await applyExpansion(f.store, 'expanded', proposal, { expected_revision: pack.revision_hash, context: { providers: [provider] } });
  assert.equal(next.workflow.status, 'draft'); assert.equal(next.workflow.nodes.find(node => node.id === 'step').access, 'read_only');
  assert.equal(next.workflow.nodes.find(node => node.id === 'step').executor.provider_id, provider.id);
  assert.equal(next.workflow.nodes.find(node => node.id === 'final').executor.kind, 'main');
  assert(next.workflow.import_status.unresolved.some(item => item.code === 'AI_INFERENCES_REQUIRE_REVIEW'));
  assert.equal((await f.store.snapshot('expanded', pack.revision_hash)).workflow.import_status.mode, 'coarse');
  const stale = structuredClone(proposal); stale.source_revision = 'a'.repeat(64);
  await assert.rejects(applyExpansion(f.store, 'expanded', stale, { expected_revision: next.revision_hash, context: { providers: [provider] } }), { code: 'EXPANSION_SCHEMA' });
});
