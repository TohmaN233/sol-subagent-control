import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { WorkflowRunStore } from './workflow-run-store.mjs';
import { validateWorkflowGraph } from './workflow-validator.mjs';
import { canonicalJSON, digest } from './workflow-revisions.mjs';
import { noSymlinks, requireValue } from './workflow-paths.mjs';
import { pathBoundaries } from './workflow-bindings.mjs';
import { validateData } from './workflow-data-schema.mjs';
import { runPermissions, nodePermissions, approvalBinding, leaseToken, executionEnvelope } from './workflow-execution-envelope.mjs';
import { initialRunState, advanceRun, graphInfo, setOutcome, interruptActiveNodes, EXECUTOR_NODES } from './workflow-state.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
function authorize(state, token) {
  requireValue(typeof state.control_hash === 'string' && /^[a-f0-9]{64}$/.test(state.control_hash), 'RUN_STATE_CORRUPT', 'Run authority digest is invalid');
  requireValue(typeof token === 'string' && token.length <= 256 && timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(state.control_hash, 'hex')), 'RUN_AUTHORITY', 'This action requires the Run main-controller capability');
}
function attemptFor(state, nodeId, attemptId, token, { active = true } = {}) {
  const node = state.nodes[nodeId];
  const attempt = node?.attempts.find(item => item.id === attemptId);
  requireValue(attempt && typeof token === 'string' && token.length <= 256 && digest(token) === attempt.lease_hash, 'LEASE_INVALID', 'Execution lease is invalid');
  if (active) requireValue(node.active_attempt_id === attemptId && ['claimed', 'running'].includes(node.status) && ['claimed', 'running'].includes(attempt.status), 'STALE_LEASE', 'Execution lease is no longer active');
  return { node, attempt };
}
function touch(state) { state.updated_at = new Date().toISOString(); }
function publicRun(record) {
  const state = structuredClone(record.state);
  delete state.control_hash;
  for (const node of Object.values(state.nodes)) for (const attempt of node.attempts) delete attempt.lease_hash;
  return { ...state, sequence: record.sequence };
}
function completionPayload(payload) {
  requireValue(payload && payload.status === 'succeeded' && typeof payload.summary === 'string' && payload.summary.length <= 20000, 'COMPLETION_SCHEMA', 'Completion needs succeeded status and a bounded summary');
  for (const key of ['artifacts', 'evidence', 'changed_paths', 'outside_paths']) requireValue(Array.isArray(payload[key]), 'COMPLETION_SCHEMA', `Completion requires ${key}`);
  requireValue(Object.hasOwn(payload, 'structured_output') && payload.evidence.length, 'COMPLETION_EVIDENCE', 'Completion needs structured output and verification evidence');
  requireValue(Buffer.byteLength(canonicalJSON(payload)) <= 256 * 1024, 'COMPLETION_LIMIT', 'Completion output is too large; store artifacts separately');
  return JSON.parse(canonicalJSON(payload));
}

export class WorkflowRuntime {
  constructor({ workflowStore, runRoot, context = {}, strictCapability = () => false, parallelWriteCapability = () => false, supportedNodeTypes = ['agent', 'tool', 'human_gate'] }) {
    this.workflows = workflowStore; this.runs = new WorkflowRunStore(runRoot); this.context = context;
    this.strictCapability = strictCapability; this.parallelWriteCapability = parallelWriteCapability;
    this.supportedNodeTypes = new Set(supportedNodeTypes);
  }
  async initialize() { await this.runs.initialize(); return this; }

  async start({ workflow_id, revision_hash, inputs = {}, workspace, access, allowed_paths = [], constraints = {}, main_actor, require_approval = false, run_id = randomUUID() }) {
    requireValue(typeof main_actor === 'string' && main_actor.length > 0 && main_actor.length <= 256, 'MAIN_ACTOR', 'Run requires one main actor');
    requireValue(typeof require_approval === 'boolean', 'RUN_APPROVAL', 'Run approval policy must be boolean');
    const root = await this.workflows.snapshot(workflow_id, revision_hash);
    validateData(inputs, root.workflow.inputs_schema);
    const checked = validateWorkflowGraph(root.workflow, this.context);
    requireValue(checked.launch_ready, 'WORKFLOW_LAUNCH_BLOCKED', 'Workflow cannot start in the current environment', { validation: checked });
    for (const node of root.workflow.nodes) if (EXECUTOR_NODES.has(node.type)) requireValue(this.supportedNodeTypes.has(node.type), 'EXECUTOR_UNSUPPORTED', `Node type has no qualified executor: ${node.type}`, { node_id: node.id });
    if (root.workflow.skill_policy.mode === 'strict') requireValue(await this.strictCapability(root), 'STRICT_UNAVAILABLE', 'No qualified Strict executor is available; imported Workflows cannot silently downgrade');
    const permissions = runPermissions({ workspace, access, allowed_paths }); await noSymlinks(permissions.workspace);
    const providerIds = new Set(root.workflow.nodes.filter(node => node.executor?.kind === 'provider').map(node => node.executor.provider_id));
    const providers = (this.context.providers ?? []).filter(provider => providerIds.has(provider.id));
    const resources = await this.workflows.resources(workflow_id, root.revision_hash);
    const blobs = new Map(root.resources.map(resource => [resource.sha256, resources[resource.path]]));
    const pins = { schema_version: 1, root, providers: structuredClone(providers), resources: root.resources.map(({ sha256, bytes }) => ({ sha256, bytes })) };
    const controlToken = randomBytes(32).toString('hex');
    const state = initialRunState({ runId: run_id, pinsHash: digest(canonicalJSON(pins)), pins, inputs: structuredClone(inputs), permissions, constraints: structuredClone(constraints), controlHash: digest(controlToken), mainActor: main_actor, requireApproval: require_approval });
    const graph = graphInfo(root.workflow);
    for (const node of root.workflow.nodes) if (EXECUTOR_NODES.has(node.type)) {
      const effective = nodePermissions(node, state);
      if (effective.access === 'bounded_write' && graph.regions.some(region => region.members.has(node.id))) requireValue(await this.parallelWriteCapability(node, root), 'PARALLEL_WRITE_UNAVAILABLE', 'Parallel write nodes require isolated worktrees and an integration gate');
    }
    advanceRun(state, pins);
    const created = await this.runs.create(run_id, pins, blobs, state);
    return { ...publicRun(created), control_token: controlToken };
  }

  async get(runId) { return publicRun(await this.runs.read(runId)); }
  async next(runId) {
    const { state, pins, sequence } = await this.runs.read(runId);
    return {
      run_id: runId, status: state.status, sequence,
      ready: state.status === 'running' ? graphInfo(pins.root.workflow).order.filter(id => state.nodes[id].status === 'ready') : [],
      approvals: Object.values(state.approvals).filter(approval => approval.status === 'pending'),
    };
  }

  async claimNode(runId, { node_id, owner, request_id, control_token, expected_sequence }) {
    requireValue(typeof request_id === 'string' && request_id.length > 0 && request_id.length <= 128, 'CLAIM_REQUEST_ID', 'Claim needs a stable request ID');
    requireValue(typeof owner === 'string' && owner.length > 0 && owner.length <= 256, 'CLAIM_OWNER', 'Claim needs an executor owner');
    const result = await this.runs.mutate(runId, 'claim', (state, pins) => {
      authorize(state, control_token);
      const definition = pins.root.workflow.nodes.find(node => node.id === node_id); const node = state.nodes[node_id];
      requireValue(definition && node, 'NODE_MISSING', 'Workflow node does not exist');
      if (definition.executor?.kind === 'main') requireValue(owner === state.main_actor, 'FINALIZER_AUTHORITY', 'Main-agent nodes cannot be claimed by a worker');
      const existing = node.attempts.find(attempt => attempt.claim_request_id === request_id);
      if (existing) {
        requireValue(existing.owner === owner && node.active_attempt_id === existing.id && ['claimed', 'running'].includes(existing.status), 'CLAIM_CONFLICT', 'Claim request refers to a different or closed executor');
        return executionEnvelope(definition, state, pins, existing, leaseToken(control_token, runId, node_id, existing.id), join(this.runs.directory(runId), 'objects'));
      }
      requireValue(state.status === 'running' && node.status === 'ready', 'NODE_NOT_READY', 'Only a ready node in an active Run may be claimed');
      const approval = approvalBinding(definition, state, pins);
      if (approval.required) requireValue(state.approvals[node.approval_id]?.status === 'approved' && state.approvals[node.approval_id].binding_hash === approval.hash, 'APPROVAL_REQUIRED', 'Exact node approval is required before claim');
      const id = randomUUID(); const token = leaseToken(control_token, runId, node_id, id);
      const attempt = { id, owner, claim_request_id: request_id, lease_hash: digest(token), status: 'claimed', dispatch: null, completion_hash: null, reconciliation: null };
      const envelope = executionEnvelope(definition, state, pins, attempt, token, join(this.runs.directory(runId), 'objects'));
      node.attempts.push(attempt); node.active_attempt_id = id; node.status = 'claimed'; touch(state);
      return envelope;
    }, { expected_sequence });
    return { ...result.result, sequence: result.sequence, idempotent: result.idempotent ?? false };
  }

  async completeNode(runId, { node_id, attempt_id, lease_token, completion }) {
    const payload = completionPayload(completion); const fingerprint = digest(canonicalJSON(payload));
    const result = await this.runs.mutate(runId, 'complete', (state, pins) => {
      const found = attemptFor(state, node_id, attempt_id, lease_token, { active: false });
      if (found.attempt.completion_hash) {
        requireValue(found.attempt.completion_hash === fingerprint, 'COMPLETION_CONFLICT', 'Duplicate completion differs from committed output'); return;
      }
      const { node, attempt } = attemptFor(state, node_id, attempt_id, lease_token);
      requireValue(!['cancelled', 'succeeded'].includes(state.status), 'RUN_TERMINAL', 'Run cannot accept this completion');
      const definition = pins.root.workflow.nodes.find(item => item.id === node_id);
      validateData(payload.structured_output, definition.outputs_schema);
      const permission = nodePermissions(definition, state);
      requireValue(!payload.outside_paths.length, 'SCOPE_VIOLATION', 'Completion reports writes outside the permitted scope');
      const changed = pathBoundaries(payload.changed_paths);
      requireValue(permission.access === 'bounded_write' || !changed.length, 'SCOPE_VIOLATION', 'Read-only node reports filesystem changes');
      const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
      requireValue(changed.every(path => permission.allowed_paths.some(root => key(path) === key(root) || key(path).startsWith(key(root) + '/'))), 'SCOPE_VIOLATION', 'Changed paths exceed the exact execution envelope');
      if (node_id === pins.root.workflow.finalization.node_id) requireValue(definition.executor.kind === 'main' && attempt.owner === state.main_actor && payload.acceptance?.accepted === true, 'FINAL_ACCEPTANCE_REQUIRED', 'Finalization requires explicit main-agent acceptance');
      node.output = payload.structured_output; node.error = null;
      attempt.status = 'succeeded'; attempt.completion_hash = fingerprint; attempt.completion = payload;
      setOutcome(state, graphInfo(pins.root.workflow), node_id, 'succeeded');
      advanceRun(state, pins); touch(state);
    });
    return { ...publicRun(result), idempotent: result.idempotent ?? false };
  }

  async failNode(runId, { node_id, attempt_id, lease_token, error }) {
    requireValue(error && typeof error.message === 'string' && error.message.length <= 20000, 'FAILURE_SCHEMA', 'Failure needs a bounded diagnostic message');
    const result = await this.runs.mutate(runId, 'fail', (state, pins) => {
      const { node, attempt } = attemptFor(state, node_id, attempt_id, lease_token);
      node.error = { code: typeof error.code === 'string' ? error.code : 'EXECUTOR_FAILED', message: error.message };
      attempt.status = 'failed'; attempt.error = node.error;
      setOutcome(state, graphInfo(pins.root.workflow), node_id, 'failed');
      if (state.status === 'failed') interruptActiveNodes(state, 'Another node failed without a recovery edge');
      else advanceRun(state, pins);
      touch(state);
    });
    return publicRun(result);
  }

  async retryNode(runId, { node_id, control_token, reconciliation }) {
    const result = await this.runs.mutate(runId, 'retry', (state, pins) => {
      authorize(state, control_token);
      requireValue(!['cancelled', 'succeeded', 'paused'].includes(state.status), 'RUN_TERMINAL', 'Run cannot release a retry in its current state');
      const node = state.nodes[node_id]; const graph = graphInfo(pins.root.workflow); const definition = graph.nodes.get(node_id);
      requireValue(node && ['failed', 'interrupted', 'blocked'].includes(node.status), 'NODE_RETRY_STATE', 'Only a failed, interrupted or blocked node can be retried');
      requireValue(node.attempts.length < definition.retry.max_attempts, 'RETRY_LIMIT', 'Node exhausted its pinned attempt limit');
      const previous = node.attempts.at(-1);
      if (previous?.dispatch) {
        requireValue(reconciliation?.attempt_id === previous.id && reconciliation.dispatch_request_id === previous.dispatch.request_id && ['not_started', 'terminated', 'explicit_retry'].includes(reconciliation.outcome) && Array.isArray(reconciliation.evidence) && reconciliation.evidence.length, 'DISPATCH_RECONCILIATION_REQUIRED', 'Uncertain external work must be reconciled or explicitly retried with evidence');
        previous.reconciliation = structuredClone(reconciliation);
      }
      for (const descendant of graph.visit(node_id)) {
        if (descendant === node_id) continue;
        requireValue(!['claimed', 'running', 'succeeded'].includes(state.nodes[descendant].status), 'RETRY_DOWNSTREAM_STARTED', 'Cannot replay an ancestor after downstream execution started');
        state.nodes[descendant].status = 'pending'; state.nodes[descendant].approval_id = null;
        for (const edge of graph.out.get(descendant)) state.edges[edge.id] = 'pending';
      }
      node.status = 'pending'; node.output = null; node.error = null; node.failure_handled = false; node.approval_id = null; node.active_attempt_id = null;
      for (const edge of graph.out.get(node_id)) state.edges[edge.id] = 'pending';
      state.status = 'running'; state.error = null; advanceRun(state, pins); touch(state);
    });
    return publicRun(result);
  }

  async approve(runId, { approval_id, decision, control_token }) {
    requireValue(typeof decision === 'boolean', 'APPROVAL_DECISION', 'Approval decision must be boolean');
    const result = await this.runs.mutate(runId, 'approve', (state, pins) => {
      authorize(state, control_token); requireValue(!TERMINAL.has(state.status), 'RUN_TERMINAL', 'Terminal Run approvals cannot change');
      const approval = Object.hasOwn(state.approvals, approval_id) ? state.approvals[approval_id] : undefined;
      requireValue(approval, 'APPROVAL_MISSING', 'Approval request does not exist');
      if (approval.status !== 'pending') { requireValue(approval.decision === decision, 'APPROVAL_CONFLICT', 'Approval already has a different decision'); return; }
      approval.decision = decision; approval.status = decision ? 'approved' : 'denied';
      const node = state.nodes[approval.node_id]; const definition = pins.root.workflow.nodes.find(item => item.id === approval.node_id);
      requireValue(approval.binding_hash === approvalBinding(definition, state, pins).hash, 'APPROVAL_BINDING_CHANGED', 'Approval scope changed');
      if (decision) {
        if (state.status === 'blocked') state.status = 'running';
        if (definition.type === 'human_gate') { node.output = { approved: true }; setOutcome(state, graphInfo(pins.root.workflow), approval.node_id, 'succeeded'); }
        else node.status = 'pending';
        advanceRun(state, pins);
      }
      touch(state);
    });
    return publicRun(result);
  }

  async pause(runId, { control_token, reason = 'Paused by main controller' }) {
    const result = await this.runs.mutate(runId, 'pause', state => {
      authorize(state, control_token); requireValue(!TERMINAL.has(state.status), 'RUN_TERMINAL', 'Terminal Run cannot pause');
      state.status = 'paused'; state.pause_reason = String(reason).slice(0, 2000); touch(state);
    });
    return publicRun(result);
  }

  async resume(runId, { control_token, after_restart = false }) {
    if (after_restart) {
      const result = await this.runs.recover(runId, state => {
        authorize(state, control_token);
        if (!TERMINAL.has(state.status)) { interruptActiveNodes(state, 'Executor ownership must be reconciled after restart'); state.status = 'interrupted'; touch(state); }
      }, state => authorize(state, control_token));
      return publicRun(result);
    }
    const result = await this.runs.mutate(runId, 'resume', (state, pins) => {
      authorize(state, control_token);
      requireValue(['paused', 'blocked', 'interrupted'].includes(state.status), 'RUN_RESUME_STATE', 'Run is not paused, blocked or interrupted');
      requireValue(!Object.values(state.nodes).some(node => node.status === 'interrupted'), 'INTERRUPTED_NODES', 'Interrupted nodes require explicit reconciliation/retry');
      state.status = 'running'; state.pause_reason = null; advanceRun(state, pins); touch(state);
    });
    return publicRun(result);
  }

  async cancel(runId, { control_token }) {
    const result = await this.runs.mutate(runId, 'cancel', state => {
      authorize(state, control_token); if (state.status === 'cancelled') return;
      requireValue(state.status !== 'succeeded', 'RUN_TERMINAL', 'Completed Run cannot be cancelled');
      state.status = 'cancelled';
      for (const node of Object.values(state.nodes)) if (!['succeeded', 'failed', 'skipped'].includes(node.status)) {
        node.status = 'cancelled';
        const attempt = node.attempts.find(item => item.id === node.active_attempt_id);
        if (attempt) { attempt.status = 'cancelled'; if (attempt.dispatch) attempt.dispatch.cancellation_pending = true; }
      }
      for (const id of Object.keys(state.edges)) if (state.edges[id] === 'pending') state.edges[id] = 'skipped';
      touch(state);
    });
    return publicRun(result);
  }

  async recordDispatchIntent(runId, { node_id, attempt_id, lease_token, request_id, envelope_hash, control_token }) {
    requireValue(typeof request_id === 'string' && request_id && request_id.length <= 128 && /^[a-f0-9]{64}$/.test(envelope_hash), 'DISPATCH_INTENT', 'Dispatch requires a stable request ID and envelope fingerprint');
    const result = await this.runs.mutate(runId, 'dispatch_intent', state => {
      authorize(state, control_token); const { attempt } = attemptFor(state, node_id, attempt_id, lease_token);
      if (attempt.dispatch) { requireValue(attempt.dispatch.request_id === request_id && attempt.dispatch.envelope_hash === envelope_hash, 'DISPATCH_CONFLICT', 'Attempt already has a different dispatch intent'); return; }
      requireValue(state.status === 'running', 'RUN_NOT_RUNNING', 'Paused or terminal Runs cannot dispatch new external work');
      attempt.dispatch = { request_id, envelope_hash, phase: 'intent', receipt: null, cancellation_pending: false }; touch(state);
    });
    return publicRun(result);
  }

  async recordDispatchReceipt(runId, { node_id, attempt_id, lease_token, request_id, receipt, control_token }) {
    const serialized = canonicalJSON(receipt);
    requireValue(receipt && typeof receipt === 'object' && !Array.isArray(receipt) && Buffer.byteLength(serialized) <= 16000 && !/"[^"\n]*(?:password|cookie|authorization|api_key|access_token|refresh_token)[^"\n]*"\s*:/i.test(serialized), 'DISPATCH_RECEIPT', 'Receipt must contain bounded task identity metadata without credentials');
    const result = await this.runs.mutate(runId, 'dispatch_receipt', state => {
      authorize(state, control_token); const { node, attempt } = attemptFor(state, node_id, attempt_id, lease_token, { active: false });
      requireValue(attempt.dispatch?.request_id === request_id, 'DISPATCH_INTENT_MISSING', 'Receipt does not match a persisted dispatch intent');
      if (attempt.dispatch.receipt) { requireValue(canonicalJSON(attempt.dispatch.receipt) === serialized, 'DISPATCH_CONFLICT', 'Receipt differs from the exact previously recorded task'); return; }
      attempt.dispatch.receipt = structuredClone(receipt); attempt.dispatch.phase = 'acknowledged';
      if (node.active_attempt_id === attempt_id && node.status === 'claimed') { node.status = 'running'; attempt.status = 'running'; }
      else attempt.dispatch.cancellation_pending = true;
      touch(state);
    });
    return publicRun(result);
  }

  async events(runId, { after_sequence = 0, control_token }) {
    const record = await this.runs.read(runId); authorize(record.state, control_token);
    requireValue(Number.isInteger(after_sequence) && after_sequence >= 0, 'EVENT_CURSOR', 'Event cursor must be a nonnegative sequence');
    return record.events.filter(event => event.sequence > after_sequence).map(event => ({ sequence: event.sequence, kind: event.kind, at: event.at, hash: event.hash, node_ids: Object.keys(event.payload.patch?.nodes ?? {}), run_status: event.payload.patch?.fields.status ?? event.payload.state?.status ?? null }));
  }
}
