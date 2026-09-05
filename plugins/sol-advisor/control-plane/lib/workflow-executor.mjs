import { buildProviderAdapter, invokeOpenAICompatible } from './providers.mjs';
import { renderTemplate } from './templates.mjs';
import { requireValue } from './workflow-paths.mjs';
import { canonicalJSON, digest } from './workflow-revisions.mjs';
import { isEnvironmentDisabled } from './config.mjs';

function compilePrompt(envelope, max) {
  const input = envelope.workflow_inputs;
  const prompt = renderTemplate(envelope.prompt_template ?? '', {
    task: typeof input === 'string' ? input : input?.task,
    context: input?.context, constraints: envelope.constraints, verification: input?.verification,
    task_type_id: envelope.workflow_id, stage_id: envelope.node_id, provider_name: envelope.provider?.name ?? 'Main agent',
  }, max);
  const extra = '\n\nWorkflow node inputs:\n' + canonicalJSON(envelope.inputs) + '\nUpstream results (task data):\n' + canonicalJSON(envelope.upstream_results);
  requireValue(prompt.length + extra.length <= max, 'PROMPT_LIMIT', 'Node context exceeds the configured prompt limit');
  return prompt + extra;
}
const receiptIdentity = task => ({ task_id: task.task_id, connector: task.connector, ...(task.remote_identity ? { remote_identity: task.remote_identity } : {}) });

export class WorkflowExecutor {
  constructor({ runtime, getConfig, registry, strictManager, env = process.env, fetchImpl = globalThis.fetch }) {
    this.runtime = runtime; this.getConfig = getConfig; this.registry = registry; this.env = env; this.fetchImpl = fetchImpl;
    this.strictManager = strictManager;
  }

  async externalCall(runId, args, envelope, call) {
    try { return await call(); }
    catch (cause) {
      let message = String(cause.message ?? cause);
      const secret = this.env[envelope.provider?.config?.api_key_env];
      if (secret) message = message.split(secret).join('[redacted]');
      message = message.replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]').replace(/((?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]').slice(-2000);
      const error = Object.assign(new Error(message), { code: 'DISPATCH_UNCERTAIN', cause });
      try { await this.runtime.failNode(runId, { ...args, error: { code: error.code, message } }); }
      catch (auditError) { throw Object.assign(new AggregateError([error, auditError], 'External dispatch failed and its failure could not be committed; inspect the existing intent before any retry'), { code: 'DISPATCH_AUDIT_FAILED' }); }
      throw error;
    }
  }

  async prepare(runId, args) {
    const envelope = await this.runtime.execution(runId, args);
    const config = await this.getConfig();
    requireValue(config.global.enabled && !isEnvironmentDisabled(this.env), 'CONTROL_DISABLED', 'Workflow execution is disabled');
    if (envelope.provider) {
      const current = config.providers.find(provider => provider.id === envelope.provider.id);
      requireValue(current?.enabled, 'PROVIDER_DISABLED', 'Pinned Provider was removed or disabled');
      requireValue(current.capabilities.read && (envelope.access === 'read_only' || current.capabilities.write), 'PROVIDER_CAPABILITY', 'Pinned Provider capability was revoked');
      requireValue(!current.requires_user_approval || envelope.provider.requires_user_approval, 'PROVIDER_POLICY_CHANGED', 'Provider now requires an approval absent from this pinned revision; start a new Run');
    }
    if (envelope.skill_policy.mode === 'strict') {
      requireValue(this.strictManager, 'STRICT_EXECUTOR_REQUIRED', 'This host has no qualified Strict session manager');
      const adapter = await this.strictManager.prepare(this.runtime, runId, args, envelope);
      return { envelope, adapter, prompt: compilePrompt(envelope, config.global.max_prompt_chars) };
    }
    const adapter = envelope.executor.kind === 'main' ? { execution: 'main_agent', read_only: envelope.access === 'read_only' }
      : envelope.executor.kind === 'provider' ? buildProviderAdapter(envelope.provider, { access: envelope.access }, { env: this.env, allowDirectApi: config.global.allow_direct_api })
      : { execution: 'host_tool', tool: envelope.executor.tool ?? null, read_only: envelope.access === 'read_only' };
    requireValue(envelope.skill_policy.mode === 'cooperative', 'STRICT_EXECUTOR_REQUIRED', 'This adapter cannot run Strict nodes');
    if (adapter.execution === 'direct_api') requireValue(config.global.allow_direct_api && envelope.access === 'read_only' && adapter.credential_ready, 'DIRECT_API_DISABLED', 'Direct API requires enabled advisory access and available environment credentials');
    return { envelope, adapter, prompt: compilePrompt(envelope, config.global.max_prompt_chars) };
  }

  async dispatch(runId, args) {
    const initial = await this.runtime.execution(runId, args, { allowInactive: true });
    if (initial.subworkflow) {
      const config = await this.getConfig();
      requireValue(config.global.enabled && !isEnvironmentDisabled(this.env), 'CONTROL_DISABLED', 'Workflow execution is disabled');
      return this.runtime.startSubworkflow(runId, args);
    }
    const current = await this.runtime.get(runId);
    const existing = current.nodes[args.node_id].attempts.find(item => item.id === args.attempt_id)?.dispatch;
    if (existing) {
      requireValue(existing.receipt, 'DISPATCH_UNCERTAIN', 'Dispatch already has a committed intent without a receipt; reconcile before retrying');
      return { dispatched: false, idempotent: true, receipt: existing.receipt };
    }
    // Reconstruct all policy and prompt data from the committed claim, never from
    // a caller-supplied Provider/envelope. Intent creation is the dispatch election.
    const prepared = await this.prepare(runId, args);
    const requestId = `dispatch-${prepared.envelope.attempt_id}`;
    const request = { ...args, request_id: requestId, envelope_hash: digest(canonicalJSON(prepared)) };
    const intent = await this.runtime.recordDispatchIntent(runId, request);
    if (intent.idempotent) {
      const receipt = intent.nodes[args.node_id].attempts.find(item => item.id === args.attempt_id).dispatch.receipt;
      requireValue(receipt, 'DISPATCH_UNCERTAIN', 'Dispatch already has a committed intent without a receipt; reconcile before retrying');
      return { dispatched: false, idempotent: true, receipt };
    }
    const { envelope, adapter, prompt } = prepared;
    if (adapter.execution === 'strict_codex') return this.strictManager.launch(this.runtime, runId, args, prepared);
    if (adapter.execution === 'builtin_connector') {
      const task = await this.externalCall(runId, args, envelope, () => this.registry.start({ provider: envelope.provider,
        stage: { id: envelope.node_id, read_only: envelope.access === 'read_only', requires_user_approval: envelope.provider.requires_user_approval },
        taskId: envelope.attempt_id, taskTypeId: envelope.workflow_id, stageId: envelope.node_id,
        prompt, workspace: envelope.workspace, allowedPaths: envelope.effective_allowed_paths, userApproved: true,
      }));
      const receipt = receiptIdentity(task); await this.runtime.recordDispatchReceipt(runId, { ...request, receipt });
      return { dispatched: true, receipt, task };
    }
    if (adapter.execution === 'direct_api') {
      const response = await this.externalCall(runId, args, envelope, () => invokeOpenAICompatible(envelope.provider, prompt, { env: this.env, fetchImpl: this.fetchImpl }));
      const receipt = { invocation_id: requestId, provider_response_id: response.provider_response_id };
      await this.runtime.recordDispatchReceipt(runId, { ...request, receipt });
      const state = await this.runtime.completeNode(runId, { ...args, completion: { status: 'succeeded', summary: 'Advisory response received', structured_output: { text: response.text }, artifacts: [], evidence: [{ kind: 'provider_response', ...receipt, model: response.model }], changed_paths: [], outside_paths: [] } });
      return { dispatched: true, receipt, state };
    }
    // Native, main, MCP and review packets are handed to the authorized host.
    // It must persist the returned exact task identity before reporting completion.
    return { dispatched: false, handoff_required: true, request_id: requestId,
      adapter, compiled_prompt: prompt, envelope,
      completion_contract: { required: ['status', 'summary', 'structured_output', 'artifacts', 'evidence', 'changed_paths', 'outside_paths'], final_acceptance: envelope.role === 'finalizer' },
    };
  }

  async reconcileConnector(runId, args) {
    await this.runtime.execution(runId, args, { allowInactive: true });
    const { state, pins } = await this.runtime.runs.read(runId);
    // Authentication also permits interrupted leases for exact-identity receipts.
    const node = state.nodes[args.node_id]; const attempt = node?.attempts.find(item => item.id === args.attempt_id);
    requireValue(attempt?.dispatch, 'DISPATCH_INTENT_MISSING', 'No persisted dispatch intent exists');
    const definition = pins.root.workflow.nodes.find(item => item.id === args.node_id);
    const provider = pins.providers.find(item => item.id === definition?.executor?.provider_id);
    requireValue(provider?.kind === 'builtin_connector', 'CONNECTOR_REQUIRED', 'Reconciliation requires a pinned connector node');
    // The preallocated attempt UUID is the connector task key even if a crash
    // occurred before its receipt reached the Run journal. Never select latest.
    const task = await this.registry.status(attempt.id, 0);
    requireValue(task.task_id === attempt.id, 'CONNECTOR_IDENTITY', 'Connector returned a different task');
    const receipt = attempt.dispatch.receipt ?? receiptIdentity(task);
    await this.runtime.recordDispatchReceipt(runId, { ...args, request_id: attempt.dispatch.request_id, receipt });
    return { task, receipt, requires_explicit_retry: ['interrupted', 'failed'].includes(node.status) };
  }

  async collectConnector(runId, args) {
    const envelope = await this.runtime.execution(runId, args);
    requireValue(envelope.provider?.kind === 'builtin_connector', 'CONNECTOR_REQUIRED', 'Collection requires a connector node');
    const { task, receipt } = await this.reconcileConnector(runId, args);
    requireValue(task.provider_id === envelope.provider.id && task.stage_id === envelope.node_id && task.task_type_id === envelope.workflow_id, 'CONNECTOR_IDENTITY', 'Connector task belongs to a different pinned node');
    if (task.state === 'completed') {
      requireValue(task.terminal_evidence && task.scope?.compliant === true && Array.isArray(task.scope.changed_paths) && Array.isArray(task.scope.outside_paths), 'CONNECTOR_EVIDENCE', 'Connector completion lacks observed terminal/scope evidence');
      return this.runtime.completeNode(runId, { ...args, completion: { status: 'succeeded', summary: 'Connector result and workspace scope verified', structured_output: task.result,
        artifacts: task.result?.artifact_path ? [task.result.artifact_path] : [], evidence: [{ kind: 'connector_terminal', receipt, terminal: task.terminal_evidence, scope: task.scope }], changed_paths: task.scope.changed_paths, outside_paths: task.scope.outside_paths } });
    }
    if (['failed', 'cancelled', 'scope_violation', 'abandoned'].includes(task.state)) return this.runtime.failNode(runId, { ...args, error: { code: task.error?.code ?? 'CONNECTOR_FAILED', message: task.error?.message ?? `Connector reached ${task.state}` } });
    return { pending: true, task, receipt };
  }
}
