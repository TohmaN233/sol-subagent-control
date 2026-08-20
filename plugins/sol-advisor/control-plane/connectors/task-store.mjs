import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
    this.flushTail = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
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
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      const body = `${JSON.stringify({ version: 1, tasks: [...this.tasks.values()] }, null, 2)}\n`;
      await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600).catch(() => {});
      await rename(temporary, this.statePath);
    });
    this.flushTail = run.catch(() => {});
    return run;
  }
}
