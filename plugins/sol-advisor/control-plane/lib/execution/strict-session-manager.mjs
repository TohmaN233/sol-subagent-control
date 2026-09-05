import { join, dirname, resolve } from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { createStrictSession } from './codex-session.mjs';
import { createCodexToolBroker } from './codex-tool-broker.mjs';
import { waitForManagedLogin } from './codex-managed-login.mjs';
import { qualifiedStrictSettings, validateStrictConfig, QUALIFIED_CODEX } from './strict-config.mjs';
import { requireValue } from '../workflow-paths.mjs';
import { canonicalJSON, digest } from '../workflow-revisions.mjs';
import { validateData } from '../workflow-data-schema.mjs';
import { isEnvironmentDisabled } from '../config.mjs';
import { inspectOrphanProfiles, stopVerifiedOrphan } from './codex-process-ownership.mjs';
import { cleanupCodexProfile } from './codex-profile-builder.mjs';

const managers = new Map();
const key = (runId, attemptId) => runId + '/' + attemptId;
const trackedEvents = new Set(['thread/started', 'turn/started', 'turn/completed', 'item/started', 'item/completed', 'error', 'account/login/completed', 'account/updated']);
const codeOf = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'STRICT_EXECUTOR_FAILED';

export function strictManagerFor(options) {
  const id = resolve(options.configPath);
  if (!managers.has(id)) managers.set(id, new StrictSessionManager(options));
  return managers.get(id);
}
export async function closeStrictManagers() {
  const results = await Promise.allSettled([...managers.values()].map(manager => manager.close()));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Strict executor shutdown requires attention');
  managers.clear();
}

// Injected factories are trusted in-process test seams, never JSON/MCP options.
export class StrictSessionManager {
  constructor({ configPath, getConfig, env = process.env, sessionFactory = createStrictSession, qualify = qualifiedStrictSettings }) {
    this.configPath = resolve(configPath); this.getConfig = getConfig; this.env = env;
    this.sessionFactory = sessionFactory; this.qualify = qualify; this.entries = new Map();
    this.parent = join(dirname(this.configPath), 'strict-profiles');
  }
  async capability(pack, providers) {
    const settings = await this.qualify(await this.getConfig(), this.env);
    requireValue(pack.workflow.skill_policy.mode === 'strict' && !pack.workflow.skill_policy.ambient_allow.length, 'STRICT_SKILL_PIN_UNAVAILABLE', 'Ambient Skill allowances need immutable executor pins');
    for (const node of pack.workflow.nodes) {
      if (!['start', 'end', 'condition', 'parallel', 'join', 'human_gate'].includes(node.type)) {
        requireValue(node.type === 'agent' && (node.executor?.kind === 'main' || node.executor?.kind === 'provider' && providers.find(provider => provider.id === node.executor.provider_id)?.kind === 'native_agent'), 'STRICT_NODE_UNSUPPORTED', 'Strict execution currently requires native agent nodes or main finalization');
      }
      requireValue((node.resources ?? []).every(path => pack.resources.some(resource => resource.path === path && resource.bytes <= 1024 * 1024)), 'STRICT_RESOURCE_UNAVAILABLE', 'Node resource is missing or exceeds the qualified text broker limit');
    }
    return settings;
  }
  async prepare(runtime, runId, args, envelope) {
    const { pins } = await runtime.runs.read(runId);
    const settings = await this.capability(pins.root, pins.providers);
    const main = envelope.executor.kind === 'main';
    return { execution: 'strict_codex', model: main ? settings.main_model : envelope.provider.config.model,
      effort: main ? settings.main_reasoning_effort : envelope.provider.config.reasoning_effort,
      executable_sha256: settings.binary_sha256, settings_sha256: digest(canonicalJSON(settings)),
      final_acceptance_required: main && envelope.role === 'finalizer', qualification: QUALIFIED_CODEX };
  }
  async launch(runtime, runId, args, { envelope, adapter, prompt }) {
    const id = key(runId, args.attempt_id);
    requireValue(!this.entries.has(id), 'STRICT_SESSION_EXISTS', 'An exact local execution already owns this attempt');
    const entry = { runtime, runId, args: { ...args }, envelope, adapter, prompt, status: 'preparing', session: null, error: null, job: null,
      writes: new Set(), stopping: false, journal: Promise.resolve(), timer: null };
    let preparationSettled; entry.preparation = new Promise(resolve => { preparationSettled = resolve; });
    this.entries.set(id, entry);
    const event = (kind, metadata) => {
      const next = entry.journal.then(() => runtime.recordExecutorEvent(runId, { ...args, event: { kind, metadata } }));
      entry.journal = next; return next;
    };
    entry.event = event;
    entry.authorize = async () => {
      requireValue(!entry.stopping, 'STRICT_SESSION_STOPPED', 'Local executor permission was revoked');
      await runtime.execution(runId, args, { allowPaused: entry.status === 'running' });
      const config = await this.getConfig();
      requireValue(config.global.enabled && !isEnvironmentDisabled(this.env), 'CONTROL_DISABLED', 'Workflow execution was disabled');
      requireValue(digest(canonicalJSON(validateStrictConfig(config.strict_executor))) === adapter.settings_sha256, 'STRICT_CONFIG_CHANGED', 'Strict executor settings changed during the attempt');
      if (envelope.provider) {
        const current = config.providers.find(provider => provider.id === envelope.provider.id);
        requireValue(current?.enabled && current.capabilities.read && (envelope.access === 'read_only' || current.capabilities.write), 'PROVIDER_DISABLED', 'Provider permission was revoked');
        requireValue(!current.requires_user_approval || envelope.provider.requires_user_approval, 'PROVIDER_POLICY_CHANGED', 'Provider now requires a new approval');
      }
    };
    try {
      await entry.authorize();
      const settings = validateStrictConfig((await this.getConfig()).strict_executor);
      const { pins } = await runtime.runs.read(runId);
      const resources = await Promise.all(envelope.resources.map(async path => {
        const pin = pins.root.resources.find(item => item.path === path);
        requireValue(pin, 'STRICT_RESOURCE_UNAVAILABLE', 'Node resource is not pinned');
        return { path, sha256: pin.sha256, bytes: await readFile(join(envelope.resources_root, pin.sha256)) };
      }));
      entry.broker = await createCodexToolBroker({ workspace: envelope.workspace, access: envelope.access, allowedPaths: envelope.effective_allowed_paths,
        deniedPaths: [this.configPath, runtime.workflows.root, runtime.runs.root, join(dirname(this.configPath), 'workflow-expansion-jobs'), this.parent], resources, authorize: entry.authorize,
        onOperation: async metadata => { await event('tool_operation', metadata); if (metadata.tool === 'write_workspace' && metadata.phase === 'committed') entry.writes.add(metadata.path); },
      });
      entry.session = await this.sessionFactory({ parent: this.parent, owner: { run_id: runId, node_id: args.node_id, attempt_id: args.attempt_id },
        binary: settings.codex_binary, expectedBinaryHash: settings.binary_sha256, model: adapter.model, effort: adapter.effort,
        cwd: envelope.workspace, env: this.env, skillPolicy: envelope.skill_policy, toolBroker: entry.broker, authorize: entry.authorize,
        onProfilePrepared: profile => event('profile_owned', { home: profile.home, executable_sha256: profile.binary_sha256 }),
        onEvent: metadata => trackedEvents.has(metadata.method) ? event('codex_event', metadata) : undefined,
        onToolRead: metadata => event('skill_read', metadata),
      });
      await entry.authorize();
      const receipt = { invocation_id: `strict-${args.attempt_id}`, executor: 'codex-app-server', executable_sha256: settings.binary_sha256 };
      await runtime.recordDispatchReceipt(runId, { ...args, request_id: `dispatch-${args.attempt_id}`, receipt });
      if (settings.authentication.mode === 'environment_api_key') await entry.session.login({ apiKeyEnv: settings.authentication.api_key_env });
      const authenticated = (await entry.session.authentication()).authenticated;
      entry.status = authenticated ? 'ready' : 'auth_required';
      await event('session_state', { status: entry.status });
      if (authenticated) this.start(entry);
      else {
        entry.timer = setTimeout(() => { entry.job = this.fail(entry, Object.assign(new Error('Managed login deadline expired'), { code: 'CODEX_LOGIN_TIMEOUT' })); }, 600000);
        entry.timer.unref?.();
      }
      return { dispatched: true, receipt, session: this.view(entry) };
    } catch (error) {
      await this.fail(entry, error); throw entry.failure;
    } finally { preparationSettled(); }
  }
  view(entry) { return { status: entry.status, error: entry.error, run_id: entry.runId, node_id: entry.args.node_id, attempt_id: entry.args.attempt_id, final_acceptance_required: entry.adapter.final_acceptance_required }; }
  async find(runtime, runId, args) {
    await runtime.execution(runId, args, { allowInactive: true });
    const entry = this.entries.get(key(runId, args.attempt_id));
    requireValue(entry && entry.args.node_id === args.node_id, 'STRICT_SESSION_UNAVAILABLE', 'Exact local session is absent; inspect its durable receipt/result and reconcile ownership before retry');
    return entry;
  }
  start(entry) {
    requireValue(!entry.job && !entry.stopping, 'STRICT_SESSION_BUSY', 'A node model turn cannot be submitted twice');
    clearTimeout(entry.timer); entry.status = 'running';
    entry.job = this.execute(entry).then(() => this.view(entry), error => this.fail(entry, error));
  }
  async execute(entry) {
    await entry.authorize(); await entry.event('session_state', { status: 'running' });
    const schema = entry.envelope.outputs_schema;
    const structured = Object.keys(schema).length > 0;
    const prompt = entry.prompt + (structured ? '\nReturn only a JSON value matching this output schema: ' + canonicalJSON(schema) : '');
    const result = await entry.session.turn(prompt, { timeout_ms: 600000 });
    let output;
    if (structured) {
      try { output = JSON.parse(result.output); } catch { throw Object.assign(new Error('Model result is not the required JSON value'), { code: 'STRICT_OUTPUT_JSON' }); }
    } else output = { text: result.output };
    validateData(output, schema);
    await entry.session.close(); await entry.event('session_state', { status: 'closed' });
    await entry.authorize();
    const completion = { status: 'succeeded', summary: 'Isolated node result and broker operations recorded', structured_output: output,
      artifacts: [], evidence: [{ kind: 'strict_codex_result', thread_id: result.thread_id, turn_id: result.turn_id, audit: result.audit }],
      changed_paths: [...entry.writes].sort(), outside_paths: [] };
    const saved = await entry.runtime.runs.saveExecutorResult(entry.runId, entry.args.attempt_id, completion);
    await entry.event('result_proposed', { ...saved, final_acceptance_required: entry.adapter.final_acceptance_required });
    entry.resultSaved = true;
    entry.status = entry.adapter.final_acceptance_required ? 'awaiting_main_acceptance' : 'result_ready';
    if (!entry.adapter.final_acceptance_required) {
      await entry.runtime.completeNode(entry.runId, { ...entry.args, completion }); entry.status = 'succeeded';
    }
  }
  async fail(entry, cause) {
    entry.stopping = true; clearTimeout(entry.timer); entry.broker?.revoke();
    const failures = [cause];
    try { if (entry.session) { await entry.session.close(); await entry.event('session_state', { status: 'closed' }); } }
    catch (error) { failures.push(error); }
    const code = codeOf(cause);
    try {
      const state = await entry.runtime.get(entry.runId);
      if (!entry.resultSaved && state.nodes[entry.args.node_id].active_attempt_id === entry.args.attempt_id && ['claimed', 'running'].includes(state.nodes[entry.args.node_id].status))
        await entry.runtime.failNode(entry.runId, { ...entry.args, error: { code, message: 'Strict executor failed; inspect recorded lifecycle and operation evidence' } });
      await entry.event('session_state', { status: 'failed', code });
    } catch (error) { failures.push(error); }
    entry.status = failures.length === 1 ? entry.resultSaved ? 'result_commit_failed' : 'failed' : 'audit_or_cleanup_failed';
    entry.error = { code, secondary_codes: failures.slice(1).map(codeOf) };
    entry.failure = failures.length === 1 ? cause : Object.assign(new AggregateError(failures, 'Strict execution and audit/cleanup failed'), { code: 'STRICT_FAILURE_INCOMPLETE' });
    // Background failures become an explicit observable outcome, never a dropped rejection.
    return this.view(entry);
  }
  async login(runtime, runId, args) {
    const entry = await this.find(runtime, runId, args); await entry.authorize();
    requireValue(entry.status === 'auth_required' && !entry.job, 'STRICT_LOGIN_STATE', 'This exact session is not awaiting managed login');
    clearTimeout(entry.timer); entry.status = 'auth_pending'; const after = entry.session.client.events.length;
    let login;
    try { login = await entry.session.login(); await entry.event('session_state', { status: entry.status }); }
    catch (error) { await this.fail(entry, error); throw entry.failure; }
    entry.job = waitForManagedLogin(entry.session.client, login.login_id, { after }).then(async () => {
      await entry.authorize(); entry.status = 'ready'; entry.job = null; this.start(entry); return this.view(entry);
    }).catch(error => this.fail(entry, error));
    // Human-authenticated console only. Never return this through a worker MCP tool.
    return { ...this.view(entry), auth_url: login.auth_url };
  }
  async status(runtime, runId, args) { return this.view(await this.find(runtime, runId, args)); }
  async cleanupOrphans(runtime, runId, args) {
    await runtime.execution(runId, args, { allowInactive: true });
    const state = await runtime.get(runId);
    requireValue(!['claimed', 'running'].includes(state.nodes[args.node_id].status), 'STRICT_RECOVERY_ACTIVE', 'Fence the interrupted attempt before orphan cleanup');
    const cleaned = []; const blocked = [];
    let records;
    try { records = await inspectOrphanProfiles(this.parent); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { cleaned, blocked }; }
    for (const record of records) {
      if (record.status === 'blocked') { blocked.push({ home: record.home, code: record.code }); continue; }
      const ownerPath = join(record.home, 'owner.json'); const stat = await lstat(ownerPath);
      requireValue(stat.isFile() && stat.size <= 64000, 'PROFILE_OWNER', 'Profile ownership record must be bounded');
      const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
      if (owner.owner?.run_id !== runId || owner.owner?.node_id !== args.node_id || owner.owner?.attempt_id !== args.attempt_id) continue;
      if (record.status === 'active') { blocked.push({ home: record.home, code: 'PROFILE_OWNER_ACTIVE' }); continue; }
      await stopVerifiedOrphan(record);
      await cleanupCodexProfile({ parent: this.parent, home: record.home, owner_token: record.token });
      await runtime.recordExecutorEvent(runId, { ...args, event: { kind: 'session_state', metadata: { status: 'closed' } } });
      cleaned.push(record.home);
    }
    return { cleaned, blocked, resubmitted: false };
  }
  async collect(runtime, runId, args) {
    const envelope = await runtime.execution(runId, args, { allowInactive: true });
    const state = await runtime.get(runId); const attempt = state.nodes[args.node_id].attempts.find(item => item.id === args.attempt_id);
    requireValue(attempt.result_proposal, 'STRICT_RESULT_PENDING', 'No durable result proposal exists for this attempt');
    const completion = await runtime.runs.readExecutorResult(runId, args.attempt_id, attempt.result_proposal.sha256);
    if (envelope.role === 'finalizer') {
      if (args.accepted !== true) return { final_acceptance_required: true, completion };
      completion.acceptance = { accepted: true };
    }
    return runtime.completeNode(runId, { ...args, completion });
  }
  async stopRun(runId) {
    const results = await Promise.allSettled([...this.entries.values()].filter(entry => entry.runId === runId).map(entry => this.stop(entry)));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Some Strict sessions did not shut down cleanly');
  }
  async stop(entry) {
    entry.stopping = true; clearTimeout(entry.timer); entry.broker?.revoke();
    let timer;
    try {
      await Promise.race([entry.preparation, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Strict setup is still stopping; cancellation remains pending'), { code: 'STRICT_SETUP_STOP_PENDING' })), 5000); })]);
    } finally { clearTimeout(timer); }
    if (entry.session) { await entry.session.close(); await entry.event('session_state', { status: 'closed' }); }
    if (entry.job) await entry.job;
    entry.status = 'stopped';
  }
  async close() { for (const entry of this.entries.values()) await this.stop(entry); }
}
