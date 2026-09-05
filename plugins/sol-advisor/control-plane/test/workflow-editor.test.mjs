import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from './physical-tempdir.mjs';
import { join, resolve } from 'node:path';
import { WorkflowStore } from '../lib/workflow-store.mjs';
import { packDirectory } from '../lib/workflow-paths.mjs';
import { createDraft } from '../lib/workflow-schema.mjs';
import { readEditorResource, writeEditorResource, publishEditorWorkflow } from '../lib/workflow-editor.mjs';
import { canvasIssues, toCanvas, moveNode, connectNodes, removeElements, layoutGraph } from '../web-src/graph-adapter.mjs';
import { DEFAULT_CONFIG_PATH, startConsole, stopConsole } from '../server.mjs';
import { skillSourceStatus } from '../lib/skill-import/source-status.mjs';
import { digest } from '../lib/workflow-revisions.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-editor-'));
  t.after(async () => { assert(resolve(root).startsWith(resolve(tmpdir()))); await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }); });
  const store = await new WorkflowStore(join(root, 'packs')).initialize();
  const workflow = { ...createDraft('editor', 'Editor fixture'), skill_policy: { mode: 'cooperative', implicit: 'allow', ambient_allow: [], shadowed_skill_paths: [] }, finalization: { required: true, node_id: 'final' },
    nodes: [{ id: 'start', type: 'start' }, { id: 'final', type: 'agent', role: 'finalizer', executor: { kind: 'main' }, prompt_template: 'Review actual evidence', access: 'read_only', approval: { required: false }, retry: { max_attempts: 1 }, resources: ['instructions/task.md'] }, { id: 'end', type: 'end' }],
    edges: [{ id: 'a', source: 'start', target: 'final' }, { id: 'b', source: 'final', target: 'end' }] };
  const pack = await store.create(workflow, { resources: { 'instructions/task.md': 'Original\n', 'binary.bin': Buffer.from([255,0,1]) } });
  return { root, store, pack };
}
test('resource edits create CAS Draft revisions, retain binary bytes and old resources, and block dangling Ready publication', async t => {
  const { store, pack } = await fixture(t); const ref = { workflow_id: 'editor', expected_revision: pack.revision_hash, resource_path: 'instructions/task.md' };
  assert.equal((await readEditorResource(store, { workflow_id: 'editor', resource_path: 'binary.bin' })).editable, false);
  const changed = await writeEditorResource(store, { ...ref, text: 'Edited\n' });
  assert.equal(changed.workflow.status, 'draft'); assert.equal((await store.resources('editor', pack.revision_hash))['instructions/task.md'].toString(), 'Original\n');
  assert.deepEqual((await store.resources('editor', changed.revision_hash))['binary.bin'], Buffer.from([255,0,1]));
  await assert.rejects(writeEditorResource(store, { ...ref, text: 'Stale' }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(writeEditorResource(store, { ...ref, resource_path: '../escape', text: 'x' }));
  await assert.rejects(publishEditorWorkflow(store, { workflow_id: 'editor', expected_revision: changed.revision_hash }), { code: 'WORKFLOW_PUBLICATION_REVIEW' });
  const ready = await publishEditorWorkflow(store, { workflow_id: 'editor', expected_revision: changed.revision_hash, reviewed: true }); assert.equal(ready.workflow.status, 'ready');
  const removed = await writeEditorResource(store, { ...ref, expected_revision: ready.revision_hash, remove: true });
  await assert.rejects(publishEditorWorkflow(store, { workflow_id: 'editor', expected_revision: removed.revision_hash, reviewed: true }), { code: 'WORKFLOW_RESOURCE_MISSING' });
  const history = await store.revisions('editor'); assert.deepEqual(history.map(item => item.revision), [4,3,2,1]);
  await writeFile(join(packDirectory(store.root, 'editor'), 'revisions', pack.revision_hash + '.json'), '{}');
  await assert.rejects(store.revisions('editor'));
});
test('canvas view and explicit layout preserve opaque domain metadata without persisting React Flow transient state', () => {
  const workflow = { ...createDraft('roundtrip','Round trip'), extension: { retain: [1,2] }, nodes: [{ id: 'a', type: 'start', opaque: { x: true }, ui: { custom: 'preserve' } }, { id: 'b', type: 'end' }], edges: [{ id: 'ab', source: 'a', target: 'b', custom: { keep: true } }] };
  const before = structuredClone(workflow); const canvas = toCanvas(workflow); canvas.nodes[0].selected = true; canvas.nodes[0].measured = { width: 200 }; canvas.nodes[0].data.definition.opaque.x = false;
  assert.deepEqual(workflow, before); const moved = moveNode(workflow, 'a', { x: 180, y: 30 });
  assert.deepEqual(moved.nodes[0], { ...before.nodes[0], ui: { custom: 'preserve', position: { x: 180, y: 30 } } });
  assert.deepEqual(layoutGraph(moved).extension, before.extension); assert.equal(JSON.stringify(moved).includes('measured'), false);
  const connected = connectNodes(moved, 'b', 'a', 'ba'); assert.deepEqual(connected.edges[0], before.edges[0]);
  const removed = removeElements(connected, ['a']); assert.deepEqual(removed.nodes, [before.nodes[1]]); assert.deepEqual(removed.edges, []);
});
test('source update status is explicit and leaves saved revisions and pinned resources intact', async t => {
  const { root, store, pack } = await fixture(t); const path = join(root, 'SKILL.md'); await writeFile(path, 'source version one');
  const source = { ...pack, provenance: { ...pack.provenance, source_path: path, source_hash: digest('source version one') } };
  assert.equal((await skillSourceStatus(source)).entries[0].status, 'unchanged');
  await writeFile(path, 'source version two'); const changed = await skillSourceStatus(source);
  assert.equal(changed.entries[0].status, 'update_available'); assert.equal(changed.workflow_changed, false);
  assert.deepEqual(await store.snapshot('editor', pack.revision_hash), pack);
  assert.equal((await store.resources('editor', pack.revision_hash))['instructions/task.md'].toString(), 'Original\n');
  await rm(path); const missing = await skillSourceStatus(source); assert.equal(missing.entries[0].status, 'unavailable'); assert.equal(missing.entries[0].error.code, 'ENOENT');
});
test('malformed Draft canvas reports null, duplicate, missing endpoint and invalid position without altering recoverable IR', () => {
  const workflow = { nodes: [null, { id: 'a', type: 'agent', ui: { position: { x: 'invalid', y: 0 } } }, { id: 'a', type: 'end' }], edges: [null, { id: 'bad', source: 'a', target: 'missing' }] };
  const before = structuredClone(workflow); assert.equal(canvasIssues(workflow).length, 5);
  assert.throws(() => toCanvas(workflow), /nodes\[0\]/); assert.deepEqual(workflow, before);
});
test('graph console serves bundled assets with bounded CSP and keeps human publication separate from model tools', async t => {
  const { root } = await fixture(t); const consoleState = await startConsole({ configPath: join(root, 'control-plane.json'), defaultConfigPath: DEFAULT_CONFIG_PATH, open: false, port: 0 }); t.after(stopConsole);
  const base = `http://127.0.0.1:${consoleState.port}`;
  const html = await fetch(base + '/workflows'); assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy'), /script-src 'self'/); assert.match(html.headers.get('content-security-policy'), /style-src-attr 'unsafe-inline'/);
  for (const asset of ['/workflows.js','/workflows.css']) { const response = await fetch(base + asset); assert.equal(response.status, 200); assert((await response.text()).length > 1000); }
  assert.equal((await fetch(base + '/web-src/main.tsx')).status, 404);
  assert.equal((await fetch(base + '/api/workflow/publish', { method: 'POST', body: '{}' })).status, 401);
});
