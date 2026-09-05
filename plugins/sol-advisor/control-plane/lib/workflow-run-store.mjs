import { mkdir, lstat, readFile, open, rename, rm, readdir } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowStore, syncDirectory } from './workflow-store.mjs';
import { insideRoot, noSymlinks, requireValue, workflowId } from './workflow-paths.mjs';
import { canonicalJSON, digest, LIMITS } from './workflow-revisions.mjs';
import { appendEvent, readEvents, replayEvents, statePatch, recoverEventTail, writeDurableJSON } from './workflow-events.mjs';

export class WorkflowRunStore {
  constructor(root) {
    requireValue(isAbsolute(root), 'ABSOLUTE_PATH_REQUIRED', 'Run store root must be absolute');
    this.root = resolve(root); this.writer = new WorkflowStore(this.root);
  }
  async initialize() { await this.writer.initialize(); return this; }
  directory(id) { return join(this.root, `run-${workflowId(id)}.run`); }

  async create(id, pins, blobs, state) {
    const pinsHash = digest(canonicalJSON(pins));
    requireValue(state.run_id === id && state.pins_hash === pinsHash, 'RUN_IDENTITY', 'Initial state does not match its pinned inputs');
    requireValue(Buffer.byteLength(canonicalJSON(pins)) <= 16 * 1024 * 1024, 'RUN_PINS_LIMIT', 'Pinned metadata is too large');
    requireValue(Array.isArray(pins.resources) && pins.resources.length <= LIMITS.files, 'RUN_RESOURCE', 'Run needs a bounded resource manifest');
    for (const resource of pins.resources) {
      const bytes = blobs.get(resource.sha256);
      requireValue(bytes && bytes.length === resource.bytes && digest(bytes) === resource.sha256, 'RUN_RESOURCE', 'Every pinned resource must have verified bytes before publication');
    }
    return this.writer.withWriter(async () => {
      const destination = this.directory(id);
      try { await lstat(destination); throw Object.assign(new Error('Run already exists'), { code: 'RUN_EXISTS' }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temporary = insideRoot(this.root, join(this.root, '.pending', randomUUID()));
      await noSymlinks(join(this.root, '.pending')); await mkdir(temporary);
      try {
        await mkdir(join(temporary, 'objects'));
        let total = 0;
        for (const [hash, value] of blobs) {
          const bytes = Buffer.from(value); total += bytes.length;
          requireValue(/^[a-f0-9]{64}$/.test(hash) && digest(bytes) === hash && bytes.length <= LIMITS.resource && total <= 256 * 1024 * 1024, 'RUN_RESOURCE', 'Invalid or oversized pinned resource');
          const file = await open(join(temporary, 'objects', hash), 'wx', 0o600);
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        }
        await writeDurableJSON(join(temporary, 'pins.json'), pins);
        const event = await appendEvent(join(temporary, 'events.jsonl'), [], 'started', { state });
        await writeDurableJSON(join(temporary, 'run.json'), { sequence: 1, event_hash: event.hash, state });
        await syncDirectory(join(temporary, 'objects')); await syncDirectory(temporary);
        await rename(temporary, destination); await syncDirectory(this.root);
        return { state: structuredClone(state), pins: structuredClone(pins), sequence: 1, events: [event] };
      } catch (error) {
        try { await noSymlinks(temporary); await rm(insideRoot(this.root, temporary), { recursive: true, maxRetries: 3, retryDelay: 100 }); }
        catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Run creation and staging cleanup failed'); }
        throw error;
      }
    });
  }

  async read(id) {
    const root = this.directory(id); await noSymlinks(root);
    const { events } = await readEvents(join(root, 'events.jsonl'));
    const state = replayEvents(events);
    requireValue(state.run_id === id, 'RUN_IDENTITY', 'Run journal identity mismatch');
    const pinPath = join(root, 'pins.json'); await noSymlinks(pinPath);
    const pinInfo = await lstat(pinPath);
    requireValue(pinInfo.isFile() && pinInfo.size <= 16 * 1024 * 1024, 'RUN_PINS_LIMIT', 'Pinned metadata must be a bounded regular file');
    const pinBytes = await readFile(pinPath);
    requireValue(pinBytes.length <= 16 * 1024 * 1024, 'RUN_PINS_LIMIT', 'Pinned metadata grew beyond limit');
    const pins = JSON.parse(pinBytes.toString('utf8'));
    requireValue(digest(canonicalJSON(pins)) === state.pins_hash, 'RUN_PINS_CORRUPT', 'Run pins differ from the committed start');
    for (const resource of pins.resources ?? []) {
      requireValue(/^[a-f0-9]{64}$/.test(resource.sha256), 'RUN_RESOURCE', 'Invalid resource digest');
      const path = join(root, 'objects', resource.sha256); await noSymlinks(path);
      const info = await lstat(path);
      requireValue(info.isFile() && info.size <= LIMITS.resource, 'RUN_RESOURCE', 'Pinned resource must be a bounded regular file');
      const bytes = await readFile(path);
      requireValue(bytes.length === resource.bytes && digest(bytes) === resource.sha256, 'RUN_RESOURCE_CORRUPT', 'Pinned resource is missing or modified');
    }
    return { state, pins, events, sequence: events.length };
  }

  async mutate(id, kind, mutate, { expected_sequence } = {}) {
    const root = this.directory(id);
    return new WorkflowStore(root).withWriter(async () => {
      const current = await this.read(id);
      if (expected_sequence !== undefined) requireValue(current.sequence === expected_sequence, 'RUN_SEQUENCE_CONFLICT', 'Run changed since it was read');
      const next = structuredClone(current.state);
      const result = await mutate(next, current.pins, current);
      requireValue(next.run_id === id && next.pins_hash === current.state.pins_hash, 'RUN_IDENTITY', 'A transition cannot change Run identity/pins');
      const patch = statePatch(current.state, next);
      if (Object.values(patch).every(values => !Object.keys(values).length)) return { ...current, result, idempotent: true };
      const event = await appendEvent(join(root, 'events.jsonl'), current.events, kind, { patch });
      try { await writeDurableJSON(join(root, 'run.json'), { sequence: event.sequence, event_hash: event.hash, state: next }); }
      catch (error) { throw Object.assign(new Error(`Transition committed, but Run cache update failed: ${error.message}`), { code: 'RUN_CACHE_WRITE_FAILED', committed: true, sequence: event.sequence, cause: error }); }
      return { state: next, pins: current.pins, sequence: event.sequence, result, events: [...current.events, event] };
    });
  }

  async recover(id, repairState = () => {}, authorizeRecovery = () => {}) {
    const root = this.directory(id); const writer = new WorkflowStore(root);
    const owner = await writer.inspectWriter();
    if (owner) await writer.recoverWriter(owner.token); // Only a confirmed absent owner can be recovered.
    return writer.withWriter(async () => {
      const committed = await readEvents(join(root, 'events.jsonl'), { allowTornTail: true });
      await authorizeRecovery(replayEvents(committed.events));
      const repaired = await recoverEventTail(join(root, 'events.jsonl'));
      const current = await this.read(id); const next = structuredClone(current.state);
      await repairState(next, current.pins);
      const patch = statePatch(current.state, next);
      let event = current.events.at(-1);
      if (repaired.recovered || Object.values(patch).some(value => Object.keys(value).length)) {
        event = await appendEvent(join(root, 'events.jsonl'), current.events, 'recover', { patch, journal_recovery: repaired.recovered });
      }
      await writeDurableJSON(join(root, 'run.json'), { sequence: event.sequence, event_hash: event.hash, state: next });
      return { state: next, pins: current.pins, sequence: event.sequence };
    });
  }

  async list() {
    await noSymlinks(this.root); const runs = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (['.pending', '.trash', '.writer.lock', '.recovery.lock'].includes(entry.name)) { await noSymlinks(join(this.root, entry.name)); continue; }
      requireValue(entry.isDirectory() && !entry.isSymbolicLink() && /^run-.+\.run$/.test(entry.name), 'RUN_STORE_ENTRY', 'Unexpected Run store entry');
      const { state, sequence } = await this.read(entry.name.slice(4, -4));
      runs.push({ run_id: state.run_id, workflow_id: state.workflow_id, status: state.status, sequence });
    }
    return runs.sort((a, b) => a.run_id < b.run_id ? -1 : 1);
  }
}
