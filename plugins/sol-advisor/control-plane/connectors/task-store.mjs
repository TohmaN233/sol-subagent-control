import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeDurableJSON } from '../lib/workflow-events.mjs';

export const TERMINAL_STATES = new Set([
  'completed', 'failed', 'cancelled', 'scope_violation', 'abandoned',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function resolveConnectorTaskPath(configPath) {
  return join(dirname(configPath), 'connector-tasks.json');
}

export class ConnectorTaskStore {
  constructor({ statePath }) {
    this.statePath = statePath;
    this.tasks = new Map();
    this.initialized = false;
    this.initializePromise = null;
    this.flushTail = Promise.resolve();
    this.persistenceError = null;
  }

  async initialize() {
    if (this.persistenceError) throw Object.assign(new Error(`Connector persistence failed; restart and reconcile: ${this.persistenceError.message}`), { code: 'CONNECTOR_STORE_FAILED', cause: this.persistenceError });
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      let parsed = { version: 1, tasks: [] };
      try {
        parsed = JSON.parse(await readFile(this.statePath, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      let changed = false;
      for (const raw of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
        const task = clone(raw);
        if (!TERMINAL_STATES.has(task.state)) {
          task.state = 'unknown_after_restart';
          task.error = {
            code: 'UNKNOWN_AFTER_RESTART',
            message: 'The connector process restarted before a terminal state was observed.',
            retryable: false,
            action_required: 'Inspect the remote session before abandoning or starting overlapping work.',
          };
          task.updated_at = new Date().toISOString();
          changed = true;
        }
        this.tasks.set(task.task_id, task);
      }
      if (changed) await this.flush();
      this.initialized = true;
    })();
    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  async create(fields) {
    await this.initialize();
    const now = new Date().toISOString();
    const task = {
      task_id: randomUUID(),
      state: 'starting',
      created_at: now,
      updated_at: now,
      finished_at: null,
      remote_identity: {},
      terminal_evidence: null,
      result: null,
      error: null,
      ...clone(fields),
    };
    if (this.tasks.has(task.task_id)) throw Object.assign(new Error(`connector task already exists: ${task.task_id}`), { code: 'TASK_ID_CONFLICT' });
    this.tasks.set(task.task_id, task);
    await this.flush();
    return clone(task);
  }

  async get(taskId) {
    await this.initialize();
    const task = this.tasks.get(String(taskId));
    return task ? clone(task) : null;
  }

  async update(taskId, patch) {
    await this.initialize();
    const current = this.tasks.get(String(taskId));
    if (!current) throw new Error(`unknown connector task: ${taskId}`);
    const next = { ...current, ...clone(patch), updated_at: new Date().toISOString() };
    if (TERMINAL_STATES.has(next.state) && !next.finished_at) next.finished_at = next.updated_at;
    this.tasks.set(String(taskId), next);
    await this.flush();
    return clone(next);
  }

  async activeForWorkspace(workspace) {
    await this.initialize();
    return [...this.tasks.values()]
      .filter((task) => task.workspace === workspace && !TERMINAL_STATES.has(task.state))
      .map(clone);
  }

  async flush() {
    const previous = this.flushTail;
    const run = previous.then(async () => {
      if (this.persistenceError) throw this.persistenceError;
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      await writeDurableJSON(this.statePath, { version: 1, tasks: [...this.tasks.values()] });
    });
    // Keep the queue settled for cleanup, but poison this instance explicitly:
    // no later read/dispatch may treat uncommitted in-memory tasks as durable.
    this.flushTail = run.then(() => {}, error => { this.persistenceError = error; });
    return run;
  }
}
