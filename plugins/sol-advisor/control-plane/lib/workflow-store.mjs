import { open, readFile, lstat, readdir, mkdir, rename, unlink, rm, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { ensureDirectory, noSymlinks, packDirectory, insideRoot, requireValue, workflowId } from './workflow-paths.mjs';
import { canonicalJSON, digest, LIMITS, prepareResources, revisionHash, validateManifest } from './workflow-revisions.mjs';
import { validateWorkflowShape } from './workflow-schema.mjs';
import { validateWorkflowGraph } from './workflow-validator.mjs';

export async function syncDirectory(path) {
  // Windows does not provide portable directory fsync through Node. File fsync and
  // atomic rename give process-crash consistency; power-loss durability is not claimed.
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(path, bytes) {
  await noSymlinks(dirname(path));
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

async function readBounded(path, max) {
  await noSymlinks(path);
  const info = await lstat(path);
  requireValue(info.isFile() && info.size <= max, 'WORKFLOW_FILE_LIMIT', `Invalid or oversized store file: ${path}`);
  const data = await readFile(path);
  requireValue(data.length <= max, 'WORKFLOW_FILE_LIMIT', 'Store file grew during read');
  return data;
}

export class WorkflowStore {
  constructor(root, { validationContext = {} } = {}) {
    requireValue(isAbsolute(root), 'ABSOLUTE_PATH_REQUIRED', 'Workflow store root must be absolute');
    this.root = resolve(root);
    this.validationContext = validationContext;
  }

  async initialize() {
    await ensureDirectory(this.root);
    for (const name of ['.pending', '.trash']) await ensureDirectory(join(this.root, name));
    return this;
  }

  async withWriter(action) {
    await noSymlinks(this.root);
    try {
      await lstat(join(this.root, '.recovery.lock'));
      throw Object.assign(new Error('Writer recovery is in progress or requires inspection'), { code: 'WORKFLOW_STORE_BUSY' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lock = join(this.root, '.writer.lock');
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(new Error('Workflow store has a writer or interrupted transaction; inspect the lock before recovery'), { code: 'WORKFLOW_STORE_BUSY' });
      throw error;
    }
    const token = randomUUID();
    let result; let failure;
    try {
      await handle.writeFile(canonicalJSON({ pid: process.pid, token, created_at: new Date().toISOString() }));
      await handle.sync();
      result = await action();
    } catch (error) { failure = error; }
    const cleanup = [];
    try { await handle.close(); } catch (error) { cleanup.push(error); }
    try {
      const owner = JSON.parse(await readBounded(lock, 4096));
      requireValue(owner.token === token, 'LOCK_OWNERSHIP', 'Writer lock ownership changed');
      await unlink(lock);
    } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], 'Store transaction/lock cleanup failed');
    if (failure) throw failure;
    return result;
  }

  async inspectWriter() {
    try { return JSON.parse(await readBounded(join(this.root, '.writer.lock'), 4096)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async recoverWriter(expectedToken) {
    const recovery = join(this.root, '.recovery.lock');
    await noSymlinks(this.root);
    await mkdir(recovery); // Only one recovery operation may move a stale lock.
    let result; let failure;
    try {
      const owner = await this.inspectWriter();
      requireValue(owner && owner.token === expectedToken && Number.isInteger(owner.pid) && owner.pid > 0, 'LOCK_OWNERSHIP', 'Recovery requires the inspected owner token');
      let absent = false;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') absent = true; else throw error; }
      requireValue(absent, 'WRITER_ACTIVE', 'Lock owner is still alive; no automatic takeover');
      await ensureDirectory(join(this.root, '.trash'));
      const retained = join(this.root, '.trash', `writer-${randomUUID()}.json`);
      await rename(join(this.root, '.writer.lock'), retained);
      await syncDirectory(this.root);
      result = { recovered: true, retained_at: retained };
    } catch (error) { failure = error; }
    try { await rmdir(recovery); }
    catch (error) { throw new AggregateError([...(failure ? [failure] : []), error], 'Recovery cleanup failed'); }
    if (failure) throw failure;
    return result;
  }

  validate(workflow) {
    validateWorkflowShape(workflow);
    if (workflow.status === 'ready') {
      const result = validateWorkflowGraph(workflow, this.validationContext);
      requireValue(result.valid, 'WORKFLOW_NOT_READY', 'Workflow failed structural validation', { validation: result });
      requireValue(!result.blockers.some(item => ['IMPORT_UNRESOLVED', 'AI_INFERENCE_UNREVIEWED', 'INLINE_SKILL_UNREVIEWED'].includes(item.code)), 'WORKFLOW_REVIEW_REQUIRED', 'Imported observations and inferred instructions require review before Ready', { validation: result });
    }
  }

  async snapshot(id, revision) {
    const pack = packDirectory(this.root, id);
    await noSymlinks(pack);
    let document;
    if (revision !== undefined) {
      requireValue(/^[a-f0-9]{64}$/.test(revision), 'INVALID_REVISION', 'Revision must be a SHA-256 digest');
      document = { ...JSON.parse(await readBounded(join(pack, 'revisions', revision + '.json'), LIMITS.definition * 2)), revision_hash: revision };
    } else document = JSON.parse(await readBounded(join(pack, 'workflow.json'), LIMITS.definition * 2));
    const { revision_hash, ...snapshot } = document;
    validateWorkflowShape(snapshot.workflow);
    requireValue(snapshot.workflow.id === id && Number.isSafeInteger(snapshot.workflow.revision) && snapshot.workflow.revision > 0, 'WORKFLOW_ID_MISMATCH', 'Pack identity or revision number is invalid');
    validateManifest(snapshot.resources);
    requireValue(revisionHash(snapshot) === revision_hash, 'REVISION_CORRUPT', 'Workflow revision hash mismatch');
    for (const resource of snapshot.resources) {
      const bytes = await readBounded(join(pack, 'objects', resource.sha256), LIMITS.resource);
      requireValue(bytes.length === resource.bytes && digest(bytes) === resource.sha256, 'RESOURCE_CORRUPT', `Resource content hash mismatch: ${resource.path}`);
    }
    return document;
  }

  async resources(id, revision) {
    const snapshot = await this.snapshot(id, revision);
    const resources = Object.create(null);
    for (const item of snapshot.resources) {
      const bytes = await readBounded(join(packDirectory(this.root, id), 'objects', item.sha256), LIMITS.resource);
      requireValue(bytes.length === item.bytes && digest(bytes) === item.sha256, 'RESOURCE_CORRUPT', 'Resource changed during export');
      resources[item.path] = bytes;
    }
    return resources;
  }

  async revisions(id) {
    const directory = join(packDirectory(this.root, id), 'revisions'); await noSymlinks(directory);
    const entries = await readdir(directory, { withFileTypes: true }); requireValue(entries.length <= 10000, 'REVISION_HISTORY_LIMIT', 'Revision history exceeds its bounded listing limit');
    const history = [];
    for (const entry of entries) {
      requireValue(entry.isFile() && !entry.isSymbolicLink() && /^[a-f0-9]{64}\.json$/.test(entry.name), 'REVISION_HISTORY_ENTRY', 'Unexpected revision history entry');
      const hash = entry.name.slice(0, -5); const snapshot = JSON.parse(await readBounded(join(directory, entry.name), LIMITS.definition * 2));
      requireValue(revisionHash(snapshot) === hash && snapshot.workflow.id === id, 'REVISION_CORRUPT', 'Revision history identity differs');
      validateWorkflowShape(snapshot.workflow);
      history.push({ revision_hash: hash, revision: snapshot.workflow.revision, name: snapshot.workflow.name, status: snapshot.workflow.status, resources: snapshot.resources.length });
    }
    return history.sort((a, b) => b.revision - a.revision || a.revision_hash.localeCompare(b.revision_hash));
  }

  async list() {
    await noSymlinks(this.root);
    const result = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (['.writer.lock', '.recovery.lock', '.pending', '.trash'].includes(entry.name)) { await noSymlinks(join(this.root, entry.name)); continue; }
      requireValue(entry.isDirectory() && !entry.isSymbolicLink() && /^wf-.+\.pack$/.test(entry.name), 'UNKNOWN_STORE_ENTRY', `Unexpected store entry: ${entry.name}`);
      const id = workflowId(entry.name.slice(3, -5));
      result.push(await this.snapshot(id));
    }
    return result.sort((a, b) => a.workflow.id < b.workflow.id ? -1 : 1);
  }

  async persistSnapshot(pack, snapshot, blobs) {
    const revision_hash = revisionHash(snapshot);
    for (const [hash, bytes] of blobs) {
      const path = join(pack, 'objects', hash);
      try { await writeExclusive(path, bytes); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        requireValue(digest(await readBounded(path, LIMITS.resource)) === hash, 'RESOURCE_CORRUPT', 'Existing object is corrupt');
      }
    }
    const revisionPath = join(pack, 'revisions', revision_hash + '.json');
    const encoded = canonicalJSON(snapshot);
    requireValue(Buffer.byteLength(encoded) <= LIMITS.definition * 2, 'WORKFLOW_SIZE', 'Workflow snapshot exceeds size limit');
    try { await writeExclusive(revisionPath, encoded); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      requireValue((await readBounded(revisionPath, LIMITS.definition * 2)).toString() === encoded, 'REVISION_CORRUPT', 'Existing immutable revision differs');
    }
    await syncDirectory(join(pack, 'objects'));
    await syncDirectory(join(pack, 'revisions'));
    return { ...snapshot, revision_hash };
  }

  async create(workflow, { resources = {}, provenance = {}, import_report = {} } = {}) {
    const next = JSON.parse(canonicalJSON({ ...workflow, revision: 1 }));
    this.validate(next);
    const { manifest, blobs } = prepareResources(resources);
    const snapshot = JSON.parse(canonicalJSON({ workflow: next, resources: manifest, provenance, import_report }));
    return this.withWriter(async () => {
      const destination = packDirectory(this.root, next.id);
      try { await lstat(destination); throw Object.assign(new Error('Workflow already exists'), { code: 'WORKFLOW_EXISTS' }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temporary = insideRoot(this.root, join(this.root, '.pending', randomUUID()));
      await noSymlinks(dirname(temporary));
      await mkdir(temporary);
      try {
        await mkdir(join(temporary, 'objects')); await mkdir(join(temporary, 'revisions'));
        const document = await this.persistSnapshot(temporary, snapshot, blobs);
        await writeExclusive(join(temporary, 'workflow.json'), canonicalJSON(document));
        await syncDirectory(temporary);
        await rename(temporary, destination);
        await syncDirectory(this.root);
        return document;
      } catch (error) {
        try {
          await noSymlinks(temporary);
          await rm(insideRoot(this.root, temporary), { recursive: true, maxRetries: 3, retryDelay: 50 });
        } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Create and staging cleanup failed');
        }
        throw error;
      }
    });
  }

  async save(id, workflow, { expected_revision, resources, provenance, import_report } = {}) {
    workflow = JSON.parse(canonicalJSON(workflow));
    if (provenance !== undefined) provenance = JSON.parse(canonicalJSON(provenance));
    if (import_report !== undefined) import_report = JSON.parse(canonicalJSON(import_report));
    const preparedResources = resources === undefined ? undefined : prepareResources(resources);
    requireValue(expected_revision, 'REVISION_REQUIRED', 'Save requires the previously read revision hash');
    requireValue(workflow.id === id, 'WORKFLOW_ID_MISMATCH', 'Save cannot change Workflow ID');
    this.validate(workflow);
    return this.withWriter(async () => {
      const previous = await this.snapshot(id);
      requireValue(previous.revision_hash === expected_revision, 'REVISION_CONFLICT', 'Workflow changed since it was read');
      const resourceData = preparedResources ?? { manifest: previous.resources, blobs: new Map() };
      const snapshot = {
        workflow: { ...workflow, revision: previous.workflow.revision + 1 }, resources: resourceData.manifest,
        provenance: provenance ?? previous.provenance, import_report: import_report ?? previous.import_report,
      };
      const pack = packDirectory(this.root, id);
      const document = await this.persistSnapshot(pack, snapshot, resourceData.blobs);
      const temporary = join(pack, 'workflow.json.tmp-' + randomUUID());
      try {
        await writeExclusive(temporary, canonicalJSON(document));
        await noSymlinks(join(pack, 'workflow.json'));
        await rename(temporary, join(pack, 'workflow.json'));
        await syncDirectory(pack);
        return document;
      } catch (error) {
        try { await unlink(temporary); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Save and temporary-file cleanup failed'); }
        throw error;
      }
    });
  }

  async rename(id, name, expected_revision) {
    const previous = await this.snapshot(id);
    return this.save(id, { ...previous.workflow, name }, { expected_revision });
  }

  async duplicate(id, nextId, name, revision) {
    const source = await this.snapshot(id, revision);
    return this.create({ ...source.workflow, id: workflowId(nextId), name }, {
      resources: await this.resources(id, source.revision_hash), provenance: source.provenance, import_report: source.import_report,
    });
  }

  async restore(id, revision, expected_revision) {
    const previous = await this.snapshot(id, revision);
    return this.save(id, previous.workflow, {
      expected_revision, resources: await this.resources(id, revision),
      provenance: previous.provenance, import_report: previous.import_report,
    });
  }

  async delete(id, expected_revision) {
    return this.withWriter(async () => {
      const previous = await this.snapshot(id);
      requireValue(expected_revision === previous.revision_hash, 'REVISION_CONFLICT', 'Delete requires the current revision hash');
      const trash = join(this.root, '.trash', `${workflowId(id)}-${randomUUID()}`);
      await noSymlinks(dirname(trash));
      await rename(packDirectory(this.root, id), trash);
      await syncDirectory(this.root); await syncDirectory(dirname(trash));
      return { id, deleted: true, retained_at: trash };
    });
  }
}
