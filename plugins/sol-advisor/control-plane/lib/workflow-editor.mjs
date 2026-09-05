import { requireValue, resourcePath } from './workflow-paths.mjs';
import { digest } from './workflow-revisions.mjs';

export async function readEditorResource(store, { workflow_id, revision_hash, resource_path }) {
  resourcePath(resource_path); const pack = await store.snapshot(workflow_id, revision_hash);
  const resource = pack.resources.find(item => item.path === resource_path); requireValue(resource, 'RESOURCE_MISSING', 'Resource does not exist in this revision');
  const bytes = (await store.resources(workflow_id, pack.revision_hash))[resource_path];
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { ...resource, encoding: 'base64', content: bytes.toString('base64'), editable: false }; }
  return { ...resource, encoding: 'utf8', content: text, editable: bytes.length <= 1024 * 1024 };
}

export async function writeEditorResource(store, { workflow_id, expected_revision, resource_path, text, remove = false }) {
  resourcePath(resource_path); requireValue(typeof remove === 'boolean' && (remove || typeof text === 'string' && Buffer.byteLength(text) <= 1024 * 1024), 'RESOURCE_EDIT_SCHEMA', 'Resource edits require bounded UTF-8 text or explicit removal');
  const pack = await store.snapshot(workflow_id, expected_revision); const resources = await store.resources(workflow_id, pack.revision_hash);
  if (remove) requireValue(Object.hasOwn(resources, resource_path), 'RESOURCE_MISSING', 'Only an existing resource can be removed');
  const before = resources[resource_path] ? digest(resources[resource_path]) : null;
  if (remove) delete resources[resource_path]; else resources[resource_path] = Buffer.from(text);
  const workflow = structuredClone(pack.workflow); workflow.status = 'draft';
  const after = remove ? null : digest(resources[resource_path]);
  if (workflow.import_status) {
    workflow.import_status.source_independent = false; workflow.import_status.relocation_evidence = null;
    workflow.import_status.unresolved.push({ code: 'RESOURCE_EDIT_REQUIRES_REVIEW', path: resource_path, before_sha256: before, after_sha256: after, origin: 'observed' });
  }
  return store.save(workflow_id, workflow, { expected_revision, resources,
    provenance: { ...pack.provenance, last_resource_edit: { source_revision: expected_revision, path: resource_path, before_sha256: before, after_sha256: after } } });
}

export async function publishEditorWorkflow(store, { workflow_id, expected_revision, reviewed }) {
  requireValue(reviewed === true, 'WORKFLOW_PUBLICATION_REVIEW', 'Ready publication requires explicit review of the exact saved revision');
  const pack = await store.snapshot(workflow_id, expected_revision); const known = new Set(pack.resources.map(item => item.path));
  for (const node of pack.workflow.nodes) requireValue((node.resources ?? []).every(path => known.has(path)), 'WORKFLOW_RESOURCE_MISSING', 'A node references a resource missing from the reviewed Pack', { node_id: node.id });
  return store.save(workflow_id, { ...pack.workflow, status: 'ready' }, { expected_revision,
    provenance: { ...pack.provenance, publication: { actor: 'user', reviewed_revision: expected_revision, at: new Date().toISOString() } } });
}
