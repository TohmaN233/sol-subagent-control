import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { JsonRpcPeer } from './json-rpc-peer.mjs';
import { connectorError, publicConnectorError } from './errors.mjs';
import { captureReadOnlySnapshot, validateWorkspace, verifyReadOnlySnapshot } from './scope-guard.mjs';

const RESULT_STATES = new Set(['completed', 'failed', 'cancelled', 'scope_violation', 'abandoned']);

function defaultGrokBinary() {
  return join(homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
}

function redactDiagnostic(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]')
    .trim()
    .slice(-2048);
}

function validateInputContent(schema, content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw connectorError('INPUT_INVALID', 'input content must be an object');
  }
  const properties = schema?.properties && typeof schema.properties === 'object'
    ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const output = {};
  for (const [key, value] of Object.entries(content)) {
    const property = properties[key];
    if (!property || typeof property !== 'object') {
      throw connectorError('INPUT_INVALID', `input content contains unknown field: ${key}`);
    }
    if (property.type === 'string') {
      if (typeof value !== 'string') {
        throw connectorError('INPUT_INVALID', `input field ${key} must be a string`);
      }
      const allowed = Array.isArray(property.enum)
        ? property.enum
        : Array.isArray(property.oneOf)
          ? property.oneOf.map((option) => option?.const).filter((item) => typeof item === 'string')
          : null;
      if (allowed && !allowed.includes(value)) {
        throw connectorError('INPUT_INVALID', `input field ${key} is not one of the allowed values`);
      }
    } else if (property.type === 'number'
      && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw connectorError('INPUT_INVALID', `input field ${key} must be a finite number`);
    } else if (property.type === 'integer' && !Number.isInteger(value)) {
      throw connectorError('INPUT_INVALID', `input field ${key} must be an integer`);
    } else if (property.type === 'boolean' && typeof value !== 'boolean') {
      throw connectorError('INPUT_INVALID', `input field ${key} must be a boolean`);
    } else if (property.type === 'array') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw connectorError('INPUT_INVALID', `input field ${key} must be an array of strings`);
      }
    } else if (!['string', 'number', 'integer', 'boolean', 'array'].includes(property.type)) {
      throw connectorError('INPUT_INVALID', `input field ${key} has an unsupported type`);
    }
    output[key] = value;
  }
  for (const key of required) {
    if (!Object.hasOwn(output, key)) {
      throw connectorError('INPUT_INVALID', `input content is missing required field: ${key}`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 8 * 1024) {
    throw connectorError('INPUT_INVALID', 'input content exceeds the 8 KiB response limit');
  }
  return output;
}

function textChunk(params) {
  const update = params?.update;
  if (update?.sessionUpdate !== 'agent_message_chunk') return '';
  return update?.content?.type === 'text' && typeof update.content.text === 'string'
    ? update.content.text : '';
}

export class GrokAcpConnector {
  constructor({ store, configPath, env = process.env, spawnImpl = spawn }) {
    this.store = store;
    this.configPath = configPath;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.active = new Map();
    this.waiters = new Map();
  }

  binaryFor(provider) {
    const envName = provider.config.binary_env || 'GROK_BIN';
    const configured = String(this.env[envName] || '').trim();
    const binary = configured || defaultGrokBinary();
    return isAbsolute(binary) ? resolve(binary) : binary;
  }

  async probe(provider, { workspace } = {}) {
    const binary = this.binaryFor(provider);
    await access(binary).catch(() => {
      throw connectorError('GROK_BINARY_MISSING', `Grok binary not found: ${binary}`, {
        retryable: true,
        actionRequired: `Install Grok or set ${provider.config.binary_env || 'GROK_BIN'} before the MCP server starts.`,
      });
    });
    return {
      provider_id: provider.id,
      connector: 'grok_acp',
      state: 'available',
      ready: false,
      observed: {
        transport: 'leader_acp_stdio',
        binary_present: true,
        workspace: workspace ? await validateWorkspace(workspace) : null,
      },
      action_required: 'Start an explicitly approved read-only scenario to establish a live ACP session.',
      error: null,
    };
  }

  async start({ provider, scenario, prompt, workspace, scenarioId }) {
    if (!scenario.read_only || provider.capabilities.write) {
      throw connectorError('READ_ONLY_REQUIRED',
        'The experimental built-in Grok connector supports read-only scenarios only.');
    }
    const fullWorkspace = await validateWorkspace(workspace);
    const conflicts = await this.store.activeForWorkspace(fullWorkspace);
    if (conflicts.length > 0) {
      throw connectorError('CONNECTOR_BUSY',
        `Workspace already has an active connector task: ${conflicts[0].task_id}`,
        { actionRequired: 'Reach a terminal or explicitly abandoned state before starting overlapping work.' });
    }
    const binary = this.binaryFor(provider);
    await access(binary).catch(() => {
      throw connectorError('GROK_BINARY_MISSING', `Grok binary not found: ${binary}`);
    });
    const baseline = await captureReadOnlySnapshot(fullWorkspace);
    const task = await this.store.create({
      scenario_id: scenarioId,
      provider_id: provider.id,
      connector: 'grok_acp',
      workspace: fullWorkspace,
      read_only: true,
      allowed_paths: [],
      prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
      baseline_digest: baseline,
      deadline_at: new Date(Date.now() + provider.config.task_timeout_ms).toISOString(),
    });
    const runtimeRoot = join(dirname(this.configPath), 'grok-runtime');
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const leaderSocket = join(runtimeRoot, `leader-${task.task_id}.sock`);
    const stderrTail = [];
    let leader;
    let acp;
    let peer;
    let active = null;
    let startupError = null;
    const observeProcessError = (processName) => (error) => {
      if (active) {
        void this.#onProcessError(active, processName, error);
      } else {
        startupError = connectorError('TRANSPORT_START_FAILED',
          `${processName} process could not start: ${redactDiagnostic(error?.message || error)}`);
      }
    };
    try {
      leader = this.spawnImpl(binary, [
        'agent', 'leader', '--no-exit-on-disconnect', '--relay-on-demand', '--no-auto-update',
        '--leader-socket', leaderSocket,
      ], {
        cwd: fullWorkspace,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.env,
      });
      leader.once('error', observeProcessError('leader'));
      leader.stderr?.on('data', (chunk) => {
        stderrTail.push(redactDiagnostic(chunk));
        if (stderrTail.length > 10) stderrTail.shift();
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      if (startupError || leader.exitCode !== null) {
        throw startupError || connectorError('GROK_LEADER_START_FAILED',
          `Grok Leader exited before ACP initialization (code=${leader.exitCode})`, {
            details: { stderr_tail: stderrTail.filter(Boolean).slice(-5) },
          });
      }
      acp = this.spawnImpl(binary, [
        '--permission-mode', 'default', 'agent', '--leader', '--leader-socket', leaderSocket, 'stdio',
      ], {
        cwd: fullWorkspace,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.env,
      });
      acp.once('error', observeProcessError('acp'));
      acp.stderr?.on('data', (chunk) => {
        stderrTail.push(redactDiagnostic(chunk));
        if (stderrTail.length > 10) stderrTail.shift();
      });
      peer = new JsonRpcPeer({
        input: acp.stdout,
        output: acp.stdin,
        defaultTimeoutMs: provider.config.startup_timeout_ms,
      });
      active = {
        taskId: task.task_id,
        provider,
        scenario,
        workspace: fullWorkspace,
        baseline,
        binary,
        leaderSocket,
        leader,
        acp,
        peer,
        stderrTail,
        pendingRequest: null,
        resultText: '',
        intentionalCleanup: false,
        timeout: null,
      };
      if (startupError) throw startupError;
      this.active.set(task.task_id, active);
      peer.onNotification('session/update', (params) => this.#onSessionUpdate(active, params));
      peer.onRequest('session/request_permission', (params) => this.#onPermission(active, params));
      peer.onRequest('elicitation/create', (params) => this.#onInput(active, params));
      acp.once('exit', (code, signal) => this.#onProcessExit(active, 'acp', code, signal));
      const initialized = await peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
      }, provider.config.startup_timeout_ms);
      const created = await peer.request('session/new', {
        cwd: fullWorkspace,
        mcpServers: [],
      }, provider.config.startup_timeout_ms);
      const sessionId = String(created?.sessionId || '');
      if (!sessionId) throw connectorError('ACP_INIT_FAILED', 'Grok ACP did not return a sessionId');
      const runId = randomUUID();
      active.sessionId = sessionId;
      active.runId = runId;
      await this.store.update(task.task_id, {
        state: 'running',
        remote_identity: {
          session_id: sessionId,
          run_id: runId,
          protocol_version: initialized?.protocolVersion ?? 1,
        },
      });
      this.#signal(task.task_id);
      active.timeout = setTimeout(() => this.#timeout(active), provider.config.task_timeout_ms);
      peer.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      }, provider.config.task_timeout_ms + 60_000)
        .then((result) => this.#complete(active, result))
        .catch((error) => this.#fail(active, error));
      return this.publicTask(await this.store.get(task.task_id));
    } catch (error) {
      if (peer) peer.close(error instanceof Error ? error : new Error(String(error)));
      try { acp?.kill(); } catch {}
      try { leader?.kill(); } catch {}
      const publicError = publicConnectorError(error);
      await this.store.update(task.task_id, { state: 'failed', error: publicError }).catch(() => {});
      this.active.delete(task.task_id);
      throw error;
    }
  }

  async status(taskId, waitMs = 0) {
    let task = await this.store.get(taskId);
    if (!task) throw connectorError('TASK_NOT_FOUND', `Unknown connector task: ${taskId}`);
    const boundedWait = Math.max(0, Math.min(Number(waitMs) || 0, 25_000));
    if (boundedWait > 0 && !RESULT_STATES.has(task.state)
      && !['needs_permission', 'needs_input', 'needs_attention', 'unknown_after_restart'].includes(task.state)) {
      await this.#waitForChange(taskId, task.updated_at, boundedWait);
      task = await this.store.get(taskId);
    }
    return this.publicTask(task);
  }

  async control(taskId, args) {
    const task = await this.store.get(taskId);
    if (!task) throw connectorError('TASK_NOT_FOUND', `Unknown connector task: ${taskId}`);
    const active = this.active.get(taskId);
    const action = String(args.action || '');
    if (RESULT_STATES.has(task.state)) {
      throw connectorError('TASK_ALREADY_TERMINAL',
        `Connector task is already terminal: ${task.state}`);
    }
    if (action === 'respond_permission') {
      if (!active?.pendingRequest || active.pendingRequest.kind !== 'permission') {
        throw connectorError('PERMISSION_NOT_PENDING', 'No permission request is pending for this task');
      }
      if (args.request_id !== active.pendingRequest.requestId) {
        throw connectorError('IDENTITY_MISMATCH', 'request_id does not match the pending permission');
      }
      if (args.decision === 'cancel') {
        active.pendingRequest.resolve({ outcome: { outcome: 'cancelled' } });
      } else if (args.decision === 'select') {
        const option = active.pendingRequest.options.find((item) => item.optionId === args.option_id);
        if (!option) throw connectorError('IDENTITY_MISMATCH', 'option_id was not returned by Grok');
        active.pendingRequest.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } });
      } else {
        throw connectorError('CONTROL_ACTION_INVALID', 'permission decision must be select or cancel');
      }
      active.pendingRequest = null;
      await this.store.update(taskId, { state: 'running', pending_request: null });
      this.#signal(taskId);
      return this.publicTask(await this.store.get(taskId));
    }
    if (action === 'respond_input') {
      if (!active?.pendingRequest || active.pendingRequest.kind !== 'input') {
        throw connectorError('INPUT_NOT_PENDING', 'No input request is pending for this task');
      }
      if (args.request_id !== active.pendingRequest.requestId) {
        throw connectorError('IDENTITY_MISMATCH', 'request_id does not match the pending input');
      }
      const decision = args.decision || 'decline';
      if (!['accept', 'decline', 'cancel'].includes(decision)) {
        throw connectorError('CONTROL_ACTION_INVALID',
          'input decision must be accept, decline, or cancel');
      }
      active.pendingRequest.resolve(decision === 'accept'
        ? {
          action: 'accept',
          content: validateInputContent(active.pendingRequest.requestedSchema, args.content || {}),
        }
        : { action: decision });
      active.pendingRequest = null;
      await this.store.update(taskId, { state: 'running', pending_request: null });
      this.#signal(taskId);
      return this.publicTask(await this.store.get(taskId));
    }
    if (action === 'cancel') {
      if (args.confirm !== true) throw connectorError('CONFIRMATION_REQUIRED', 'cancel requires confirm=true');
      if (!active || !active.sessionId || !active.runId) {
        throw connectorError('CANCEL_UNCONFIRMED', 'No live exact Grok session/run is attached');
      }
      if (!String(args.expected_session_id || '').trim()
        || !String(args.expected_run_id || '').trim()) {
        throw connectorError('IDENTITY_REQUIRED',
          'cancel requires the exact expected_session_id and expected_run_id returned by start/status');
      }
      if (args.expected_session_id !== active.sessionId) {
        throw connectorError('IDENTITY_MISMATCH', 'expected_session_id does not match');
      }
      if (args.expected_run_id !== active.runId) {
        throw connectorError('IDENTITY_MISMATCH', 'expected_run_id does not match');
      }
      active.peer.notify('session/cancel', { sessionId: active.sessionId });
      await this.store.update(taskId, { state: 'cancelling' });
      this.#signal(taskId);
      return this.publicTask(await this.store.get(taskId));
    }
    if (action === 'disconnect') {
      if (args.confirm !== true) throw connectorError('CONFIRMATION_REQUIRED', 'disconnect requires confirm=true');
      if (active) await this.#cleanup(active);
      await this.store.update(taskId, {
        state: 'needs_attention',
        error: publicConnectorError(connectorError('DISCONNECTED_UNCONFIRMED',
          'The local ACP transport was disconnected without a confirmed remote terminal state.')),
      });
      this.#signal(taskId);
      return this.publicTask(await this.store.get(taskId));
    }
    if (action === 'abandon') {
      if (args.confirm !== true || args.acknowledge_may_still_run !== true || !String(args.reason || '').trim()) {
        throw connectorError('CONFIRMATION_REQUIRED',
          'abandon requires confirm=true, acknowledge_may_still_run=true, and a reason');
      }
      if (active) await this.#cleanup(active);
      await this.store.update(taskId, {
        state: 'abandoned',
        error: {
          code: 'ABANDONED_UNCONFIRMED',
          message: String(args.reason),
          retryable: false,
          action_required: 'Inspect the workspace before overlapping work; the remote process may have continued.',
        },
      });
      this.#signal(taskId);
      return this.publicTask(await this.store.get(taskId));
    }
    throw connectorError('CONTROL_ACTION_INVALID',
      'action must be respond_permission, respond_input, cancel, disconnect, or abandon');
  }

  publicTask(task) {
    if (!task) return null;
    return {
      task_id: task.task_id,
      scenario_id: task.scenario_id,
      provider_id: task.provider_id,
      connector: task.connector,
      state: task.state,
      workspace: task.workspace,
      read_only: task.read_only,
      remote_identity: task.remote_identity || {},
      pending_request: task.pending_request || null,
      created_at: task.created_at,
      updated_at: task.updated_at,
      deadline_at: task.deadline_at,
      finished_at: task.finished_at,
      terminal_evidence: task.terminal_evidence,
      scope: task.scope || null,
      result: task.result,
      error: task.error,
    };
  }

  async #onSessionUpdate(active, params) {
    const chunk = textChunk(params);
    if (!chunk) return;
    const max = active.provider.config.max_result_chars;
    active.resultText = `${active.resultText}${chunk}`.slice(-max);
  }

  #onPermission(active, params) {
    if (params?.sessionId && params.sessionId !== active.sessionId) {
      return { outcome: { outcome: 'cancelled' } };
    }
    if (active.pendingRequest) {
      throw connectorError('MULTIPLE_PENDING_REQUESTS', 'Grok issued overlapping permission/input requests');
    }
    const requestId = randomUUID();
    const options = (params.options || []).slice(0, 20).map((item) => ({
      optionId: item.optionId,
      name: item.name,
      kind: item.kind,
    }));
    return new Promise((resolve) => {
      active.pendingRequest = { kind: 'permission', requestId, options, resolve };
      this.store.update(active.taskId, {
        state: 'needs_permission',
        pending_request: {
          kind: 'permission', request_id: requestId,
          tool_title: params.toolCall?.title || 'Unnamed Grok tool call', options,
        },
      }).then(() => this.#signal(active.taskId));
    });
  }

  #onInput(active, params) {
    if (params.mode !== 'form' || params.sessionId !== active.sessionId) {
      return { action: 'decline' };
    }
    if (active.pendingRequest) {
      throw connectorError('MULTIPLE_PENDING_REQUESTS', 'Grok issued overlapping permission/input requests');
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      active.pendingRequest = {
        kind: 'input', requestId, requestedSchema: params.requestedSchema || {}, resolve,
      };
      this.store.update(active.taskId, {
        state: 'needs_input',
        pending_request: {
          kind: 'input', request_id: requestId,
          message: params.message || 'Grok needs input.',
          requested_schema: params.requestedSchema || null,
        },
      }).then(() => this.#signal(active.taskId));
    });
  }

  async #complete(active, result) {
    const current = await this.store.get(active.taskId);
    const cancelled = current?.state === 'cancelling'
      || String(result?.stopReason || '').toLowerCase().includes('cancel');
    const scope = await verifyReadOnlySnapshot(active.workspace, active.baseline);
    const state = !scope.unchanged ? 'scope_violation' : cancelled ? 'cancelled' : 'completed';
    await this.store.update(active.taskId, {
      state,
      pending_request: null,
      scope: { read_only: true, unchanged: scope.unchanged },
      terminal_evidence: {
        kind: 'acp_prompt_result',
        observed_at: new Date().toISOString(),
        stop_reason: result?.stopReason || null,
      },
      result: state === 'scope_violation' ? null : { text: active.resultText.trim(), artifact_path: null },
      error: state === 'scope_violation'
        ? publicConnectorError(connectorError('SCOPE_VIOLATION',
          'The Git workspace changed during a read-only Grok task.'))
        : null,
    });
    this.#signal(active.taskId);
    await this.#cleanup(active);
  }

  async #fail(active, error) {
    const current = await this.store.get(active.taskId);
    if (!current || RESULT_STATES.has(current.state)) return;
    const scope = await verifyReadOnlySnapshot(active.workspace, active.baseline).catch(() => null);
    const state = scope && !scope.unchanged ? 'scope_violation' : 'failed';
    await this.store.update(active.taskId, {
      state,
      scope: scope ? { read_only: true, unchanged: scope.unchanged } : null,
      error: publicConnectorError(state === 'scope_violation'
        ? connectorError('SCOPE_VIOLATION', 'The Git workspace changed during a read-only Grok task.')
        : connectorError('ACP_PROMPT_FAILED', redactDiagnostic(error instanceof Error ? error.message : error), {
          details: { stderr_tail: active.stderrTail.filter(Boolean).slice(-5) },
        })),
    });
    this.#signal(active.taskId);
    await this.#cleanup(active);
  }

  async #timeout(active) {
    const current = await this.store.get(active.taskId);
    if (!current || RESULT_STATES.has(current.state)) return;
    await this.store.update(active.taskId, {
      state: 'needs_attention',
      error: publicConnectorError(connectorError('TIMEOUT_UNCONFIRMED',
        'The Grok task exceeded its deadline without a confirmed terminal state.', {
          actionRequired: 'Inspect or cancel the exact session/run; do not resubmit automatically.',
        })),
    });
    this.#signal(active.taskId);
  }

  async #onProcessExit(active, processName, code, signal) {
    if (active.intentionalCleanup) return;
    const current = await this.store.get(active.taskId);
    if (!current || RESULT_STATES.has(current.state)) return;
    await this.store.update(active.taskId, {
      state: 'needs_attention',
      error: publicConnectorError(connectorError('TRANSPORT_EXITED',
        `${processName} process exited before a confirmed terminal state`, {
          details: { code, signal, stderr_tail: active.stderrTail.filter(Boolean).slice(-5) },
        })),
    });
    this.#signal(active.taskId);
  }

  async #onProcessError(active, processName, error) {
    if (active.intentionalCleanup) return;
    const current = await this.store.get(active.taskId);
    if (!current || RESULT_STATES.has(current.state)) return;
    await this.store.update(active.taskId, {
      state: 'needs_attention',
      error: publicConnectorError(connectorError('TRANSPORT_ERROR',
        `${processName} process error before a confirmed terminal state`, {
          details: {
            message: redactDiagnostic(error?.message || error),
            stderr_tail: active.stderrTail.filter(Boolean).slice(-5),
          },
        })),
    });
    this.#signal(active.taskId);
  }

  async #cleanup(active) {
    if (!this.active.has(active.taskId)) return;
    active.intentionalCleanup = true;
    clearTimeout(active.timeout);
    if (active.pendingRequest) {
      active.pendingRequest.resolve(active.pendingRequest.kind === 'permission'
        ? { outcome: { outcome: 'cancelled' } }
        : { action: 'cancel' });
      active.pendingRequest = null;
    }
    active.peer?.close();
    try { active.acp?.kill(); } catch {}
    try { active.leader?.kill(); } catch {}
    try {
      const killer = this.spawnImpl(active.binary,
        ['leader', '--leader-socket', active.leaderSocket, 'kill'], {
          cwd: active.workspace, stdio: 'ignore', windowsHide: true, env: this.env,
        });
      killer.unref?.();
    } catch {}
    this.active.delete(active.taskId);
  }

  async #waitForChange(taskId, observedUpdatedAt, waitMs) {
    let done;
    const waiting = new Promise((resolveWait) => {
      const timer = setTimeout(() => {
        const set = this.waiters.get(taskId);
        set?.delete(done);
        if (set?.size === 0) this.waiters.delete(taskId);
        resolveWait();
      }, waitMs);
      done = () => {
        clearTimeout(timer);
        resolveWait();
      };
      const set = this.waiters.get(taskId) || new Set();
      set.add(done);
      this.waiters.set(taskId, set);
    });
    const refreshed = await this.store.get(taskId);
    if (!refreshed || refreshed.updated_at !== observedUpdatedAt) {
      const set = this.waiters.get(taskId);
      set?.delete(done);
      if (set?.size === 0) this.waiters.delete(taskId);
      done();
    }
    await waiting;
  }

  #signal(taskId) {
    const set = this.waiters.get(taskId);
    if (!set) return;
    this.waiters.delete(taskId);
    for (const done of set) done();
  }
}
