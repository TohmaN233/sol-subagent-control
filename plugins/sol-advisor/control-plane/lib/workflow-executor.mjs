import { buildProviderAdapter, invokeOpenAICompatible } from './providers.mjs';
import { renderTemplate } from './templates.mjs';
import { requireValue } from './workflow-paths.mjs';
import { canonicalJSON, digest } from './workflow-revisions.mjs';
import { isEnvironmentDisabled } from './config.mjs';
import { controllerAttempt, reattachAttempt } from './workflow-recovery.mjs';
import { leaseToken, nodePermissions } from './workflow-execution-envelope.mjs';

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
      await this.runtime.parallelManager?.ensureNode(this.runtime, runId, args);
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
    await this.runtime.parallelManager?.ensureNode(this.runtime, runId, args);
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
    requireValue(task.task_id === attempt.id && task.provider_id === provider.id && task.stage_id === args.node_id && task.task_type_id === state.workflow_id,
      'CONNECTOR_IDENTITY', 'Connector returned a different pinned task');
    const receipt = attempt.dispatch.receipt ?? receiptIdentity(task);
    requireValue(canonicalJSON(receiptIdentity(task)) === canonicalJSON(receipt), 'CONNECTOR_IDENTITY', 'Connector remote identity differs from the committed receipt');
    await this.runtime.recordDispatchReceipt(runId, { ...args, request_id: attempt.dispatch.request_id, receipt });
    if (attempt.dispatch.cancellation_pending && ['completed','cancelled'].includes(task.state)) {
      await this.runtime.runs.mutate(runId, 'connector_control', state => {
        requireValue(state.control_hash === digest(args.control_token), 'RUN_AUTHORITY', 'Controller changed while observing cancellation');
        const current = state.nodes[args.node_id].attempts.find(item => item.id === args.attempt_id);
        current.dispatch.cancellation_pending = false; current.connector_control = { action: 'observe', phase: 'observed', state: task.state, at: new Date().toISOString() };
      });
    }
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

  async recoveryPreparation(runId, args) {
    const record = await controllerAttempt(this.runtime, runId, args);
    requireValue(record.node.status === 'interrupted', 'RECOVERY_ATTEMPT_STATE', 'Fence the old attempt before recovery');
    const config = await this.getConfig();
    requireValue(config.global.enabled && !isEnvironmentDisabled(this.env), 'CONTROL_DISABLED', 'Workflow execution is disabled');
    const provider = record.pins.providers.find(item => item.id === record.definition.executor?.provider_id);
    if (provider) {
      const current = config.providers.find(item => item.id === provider.id);
      requireValue(current?.enabled && current.capabilities.read && (nodePermissions(record.definition, record.state).access !== 'bounded_write' || current.capabilities.write), 'PROVIDER_DISABLED', 'Pinned Provider permission was revoked');
      requireValue(!current.requires_user_approval || provider.requires_user_approval, 'PROVIDER_POLICY_CHANGED', 'Provider approval requirements changed');
    }
    return { ...record, provider };
  }
  async controlConnector(runId, args) {
    const envelope = await this.runtime.execution(runId, args, { allowInactive: true });
    requireValue(envelope.provider?.kind === 'builtin_connector', 'CONNECTOR_REQUIRED', 'This node is not a connector');
    const control = args.control;
    requireValue(control && ['respond_permission','respond_input','cancel','disconnect','abandon','reconcile'].includes(control.action) && Buffer.byteLength(canonicalJSON(control)) <= 32000, 'CONNECTOR_CONTROL_SCHEMA', 'Select a bounded exact connector action');
    const record = await controllerAttempt(this.runtime, runId, args);
    if (['respond_permission','respond_input'].includes(control.action)) {
      await this.runtime.execution(runId, args);
      const config = await this.getConfig(); const provider = config.providers.find(item => item.id === envelope.provider.id);
      requireValue(config.global.enabled && !isEnvironmentDisabled(this.env) && provider?.enabled, 'PROVIDER_DISABLED', 'A disabled executor cannot receive new permission or input');
      requireValue(provider.capabilities.read && (envelope.access !== 'bounded_write' || provider.capabilities.write), 'PROVIDER_CAPABILITY', 'Provider capability was revoked before its permission/input response');
      requireValue(!provider.requires_user_approval || envelope.provider.requires_user_approval, 'PROVIDER_POLICY_CHANGED', 'Provider now requires approval absent from this Run');
    }
    const task = await this.registry.status(args.attempt_id, 0);
    const receipt = receiptIdentity(task);
    requireValue(task.task_id === args.attempt_id && task.provider_id === envelope.provider.id && task.stage_id === args.node_id && task.task_type_id === envelope.workflow_id && record.attempt.dispatch?.receipt && canonicalJSON(receipt) === canonicalJSON(record.attempt.dispatch.receipt), 'CONNECTOR_IDENTITY', 'Control target differs from the persisted exact connector');
    await this.runtime.runs.mutate(runId, 'connector_control', state => {
      requireValue(state.control_hash === record.state.control_hash, 'RUN_AUTHORITY', 'Controller changed before connector control');
      state.nodes[args.node_id].attempts.find(item => item.id === args.attempt_id).connector_control = { action: control.action, phase: 'intent', at: new Date().toISOString() };
    }, { expected_sequence: record.sequence });
    let result;
    try { result = await this.registry.control(args.attempt_id, control); }
    catch (error) {
      try { await this.runtime.runs.mutate(runId, 'connector_control', state => { state.nodes[args.node_id].attempts.find(item => item.id === args.attempt_id).connector_control = { action: control.action, phase: 'failed', code: error.code ?? 'CONNECTOR_CONTROL_FAILED' }; }); }
      catch (audit) { throw new AggregateError([error, audit], 'Connector control and audit persistence failed'); }
      throw error;
    }
    requireValue(canonicalJSON(receiptIdentity(result)) === canonicalJSON(receipt), 'CONNECTOR_IDENTITY', 'Connector control returned another remote identity');
    await this.runtime.runs.mutate(runId, 'connector_control', state => {
      const attempt = state.nodes[args.node_id].attempts.find(item => item.id === args.attempt_id);
      attempt.connector_control = { action: control.action, phase: 'observed', state: result.state, at: new Date().toISOString() };
      if (result.state === 'cancelled') attempt.dispatch.cancellation_pending = false;
    });
    return { task: result, remote_cancel_confirmed: result.state === 'cancelled' };
  }
  async cancelPendingConnectors(runId, controlToken) {
    await this.runtime.authorizeController(runId, { control_token: controlToken });
    const record = await this.runtime.runs.read(runId); const errors = [];
    for (const [nodeId, node] of Object.entries(record.state.nodes)) for (const attempt of node.attempts) if (attempt.dispatch?.cancellation_pending) {
      const definition = record.pins.root.workflow.nodes.find(item => item.id === nodeId);
      const provider = record.pins.providers.find(item => item.id === definition.executor?.provider_id);
      if (provider?.kind !== 'builtin_connector') continue;
      try {
        const task = await this.registry.status(attempt.id, 0); const receipt = receiptIdentity(task);
        requireValue(task.task_id === attempt.id && task.provider_id === provider.id && task.stage_id === nodeId && task.task_type_id === record.state.workflow_id && attempt.dispatch.receipt && canonicalJSON(receipt) === canonicalJSON(attempt.dispatch.receipt), 'CONNECTOR_IDENTITY', 'Cancellation target differs from the recorded task');
        if (['completed','cancelled'].includes(task.state)) {
          await this.runtime.runs.mutate(runId, 'connector_control', state => { const current = state.nodes[nodeId].attempts.find(item => item.id === attempt.id); current.dispatch.cancellation_pending = false; current.connector_control = { action: 'cancel', phase: 'observed', state: task.state, already_terminal: true }; });
          continue;
        }
        const identity = task.remote_identity ?? {};
        await this.controlConnector(runId, { run_id: runId, control_token: controlToken, node_id: nodeId, attempt_id: attempt.id,
          lease_token: leaseToken(controlToken, runId, nodeId, attempt.id, attempt.lease_generation ?? 0), control: { action: 'cancel', confirm: true,
            ...(identity.agent_id ? { expected_agent_id: identity.agent_id } : {}),
            ...(identity.session_id ? { expected_session_id: identity.session_id } : {}), ...(identity.run_id ? { expected_run_id: identity.run_id } : {}) } });
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw Object.assign(new AggregateError(errors, 'Some exact remote tasks have unconfirmed cancellation'), { code: 'CONNECTOR_CANCEL_INCOMPLETE' });
  }
  async reattachConnector(runId, args) {
    const record = await this.recoveryPreparation(runId, args);
    requireValue(record.provider?.kind === 'builtin_connector' && record.attempt.dispatch, 'CONNECTOR_REQUIRED', 'Reattachment requires an existing pinned connector dispatch');
    function verify(task) {
      requireValue(task.task_id === args.attempt_id && task.provider_id === record.provider.id && task.stage_id === args.node_id && task.task_type_id === record.state.workflow_id,
        'CONNECTOR_IDENTITY', 'Observed task belongs to another Run node or Provider');
      requireValue(task.remote_identity && Object.keys(task.remote_identity).length > 0, 'CONNECTOR_IDENTITY', 'Reattachment requires observed exact remote identity');
      const receipt = receiptIdentity(task);
      requireValue(!record.attempt.dispatch.receipt || canonicalJSON(record.attempt.dispatch.receipt) === canonicalJSON(receipt), 'DISPATCH_CONFLICT', 'Remote identity differs from the recorded dispatch');
      return receipt;
    }
    let task = await this.registry.status(args.attempt_id, 0); let receipt = verify(task);
    if (['unknown_after_restart','needs_attention'].includes(task.state)) {
      await this.runtime.runs.mutate(runId, 'reattach', state => {
        requireValue(state.control_hash === record.state.control_hash && state.nodes[args.node_id].status === 'interrupted', 'RECOVERY_ATTEMPT_CHANGED', 'Run authority changed before transport reconciliation');
        state.nodes[args.node_id].attempts.find(item => item.id === args.attempt_id).reconciliation = { kind: 'connector_transport_intent', receipt, resubmitted: false, at: new Date().toISOString() };
      }, { expected_sequence: record.sequence });
      // This adapter operation attaches the saved remote ID; it never starts a task.
      task = await this.registry.control(args.attempt_id, { action: 'reconcile' }); receipt = verify(task);
    }
    requireValue(['running','completed','needs_permission','needs_input'].includes(task.state), 'CONNECTOR_RECOVERY_UNCONFIRMED', 'The exact connector task is not confirmed active or completed', { remote_state: task.state });
    const attached = await reattachAttempt(this.runtime, runId, args, { kind: 'connector_exact_identity', attempt_id: args.attempt_id, dispatch_request_id: record.attempt.dispatch.request_id, receipt, remote_state: task.state });
    return { ...attached, task };
  }
}
