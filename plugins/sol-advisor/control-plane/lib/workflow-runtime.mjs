import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { WorkflowRunStore } from './workflow-run-store.mjs';
import { validateWorkflowGraph } from './workflow-validator.mjs';
import { canonicalJSON, digest } from './workflow-revisions.mjs';
import { noSymlinks, requireValue } from './workflow-paths.mjs';
import { pathBoundaries, resolveBindings } from './workflow-bindings.mjs';
import { validateData } from './workflow-data-schema.mjs';
import { runPermissions, nodePermissions, approvalBinding, leaseToken, executionEnvelope } from './workflow-execution-envelope.mjs';
import { initialRunState, advanceRun, graphInfo, setOutcome, interruptActiveNodes, EXECUTOR_NODES } from './workflow-state.mjs';
import { resolveWorkflowPins } from './workflow-pins.mjs';
import { childIdentity, childPermissions, validateChildClosure } from './workflow-subworkflow.mjs';
import { planParallelBranches } from './parallel/branch-planner.mjs';

const CHILD_COMPLETION = Symbol('verified child completion');

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
  constructor({ workflowStore, runRoot, context = {}, strictCapability = () => false, parallelWriteCapability = () => false, parallelManager, supportedNodeTypes = ['agent', 'skill_ref', 'tool', 'human_gate', 'subworkflow'] }) {
    this.workflows = workflowStore; this.runs = new WorkflowRunStore(runRoot); this.context = context;
    this.strictCapability = strictCapability; this.parallelWriteCapability = parallelWriteCapability;
    this.parallelManager = parallelManager;
    this.supportedNodeTypes = new Set(supportedNodeTypes);
  }
  async initialize() { await this.runs.initialize(); return this; }

  async assertAncestors(pins, { allowPaused = false } = {}) {
    let current = pins; let depth = 0;
    while (current.parent) {
      requireValue(++depth <= 32, 'SUBWORKFLOW_DEPTH', 'Invalid Run ancestry');
      const link = current.parent; const parent = await this.runs.read(link.run_id);
      const node = parent.state.nodes[link.node_id]; const attempt = node?.attempts.find(item => item.id === link.attempt_id);
      requireValue(parent.state.pins_hash === link.pins_hash && attempt?.child_run_id && attempt.child_run_id === current.child_run_id && node.active_attempt_id === attempt.id && ['claimed', 'running'].includes(node.status) && ['claimed', 'running'].includes(attempt.status), 'PARENT_LEASE_INACTIVE', 'The parent node no longer authorizes this child Run');
      requireValue(parent.state.status === 'running' || allowPaused && parent.state.status === 'paused', 'PARENT_RUN_INACTIVE', 'The parent Run blocks this child operation', { parent_run_id: link.run_id, parent_status: parent.state.status });
      current = parent.pins;
    }
  }

  async transition(runId, kind, mutate, options = {}, { allowPaused = false } = {}) {
    return this.runs.mutate(runId, kind, async (state, pins, current) => {
      await this.assertAncestors(pins, { allowPaused });
      return mutate(state, pins, current);
    }, options);
  }

  async start({ workflow_id, revision_hash, inputs = {}, workspace, access, allowed_paths = [], constraints = {}, main_actor, require_approval = false, run_id = randomUUID() }) {
    requireValue(typeof main_actor === 'string' && main_actor.length > 0 && main_actor.length <= 256, 'MAIN_ACTOR', 'Run requires one main actor');
    requireValue(typeof require_approval === 'boolean', 'RUN_APPROVAL', 'Run approval policy must be boolean');
    const root = await this.workflows.snapshot(workflow_id, revision_hash);
    validateData(inputs, root.workflow.inputs_schema);
    requireValue(root.workflow.status === 'ready' && root.workflow.enabled, 'WORKFLOW_LAUNCH_BLOCKED', 'Only enabled Ready Workflows may resolve execution dependencies', { validation: validateWorkflowGraph(root.workflow, this.context) });
    const closure = await resolveWorkflowPins(this.workflows, root);
    const checked = validateWorkflowGraph(root.workflow, { ...this.context, ...closure.context });
    requireValue(checked.launch_ready, 'WORKFLOW_LAUNCH_BLOCKED', 'Workflow cannot start in the current environment', { validation: checked });
    for (const pack of closure.packs) for (const node of pack.workflow.nodes) if (EXECUTOR_NODES.has(node.type)) requireValue(this.supportedNodeTypes.has(node.type), 'EXECUTOR_UNSUPPORTED', `Node type has no qualified executor: ${node.type}`, { node_id: node.id });
    for (const skill of closure.skills) {
      requireValue(!skill.observations.length, 'SKILL_DEPENDENCY_UNRESOLVED', 'Linked Skill dependencies need review or inlining before execution', { path: skill.path, observations: skill.observations });
      for (const [kind, names] of Object.entries(skill.requirements)) if (kind !== 'providers') requireValue(names.every(name => (this.context[kind] ?? []).includes(name)), 'SKILL_REQUIREMENT_UNAVAILABLE', 'Linked Skill requires an unavailable executor capability', { path: skill.path, kind, requirements: names });
    }
    const permissions = runPermissions({ workspace, access, allowed_paths }); await noSymlinks(permissions.workspace);
    const providerIds = new Set(closure.provider_ids);
    const providers = (this.context.providers ?? []).filter(provider => providerIds.has(provider.id));
    for (const pack of closure.packs) if (pack.workflow.skill_policy.mode === 'strict') requireValue(await this.strictCapability(pack, { skills: closure.skills, providers }), 'STRICT_UNAVAILABLE', 'No qualified Strict executor is available; imported Workflows cannot silently downgrade');
    const blobs = closure.blobs;
    const pins = { schema_version: 1, root, providers: structuredClone(providers), children: closure.children, skills: closure.skills, resources: closure.resources };
    const controlToken = randomBytes(32).toString('hex');
    const state = initialRunState({ runId: run_id, pinsHash: digest(canonicalJSON(pins)), pins, inputs: structuredClone(inputs), permissions, constraints: structuredClone(constraints), controlHash: digest(controlToken), mainActor: main_actor, requireApproval: require_approval });
    const scopes = validateChildClosure(pins, state);
    for (const scope of scopes) {
      const graph = graphInfo(scope.pack.workflow);
      for (const node of scope.pack.workflow.nodes) if (EXECUTOR_NODES.has(node.type)) {
        const effective = nodePermissions(node, scope.state);
        if (effective.access === 'bounded_write' && graph.regions.some(region => region.members.has(node.id))) requireValue(this.parallelManager || await this.parallelWriteCapability(node, scope.pack), 'PARALLEL_WRITE_UNAVAILABLE', 'Parallel write nodes require isolated worktrees and an integration gate');
      }
    }
    if (this.parallelManager) {
      const parallel = await this.parallelManager.preflight(root.workflow, permissions, scopes);
      if (parallel) { pins.parallel = parallel; state.pins_hash = digest(canonicalJSON(pins)); }
    }
    advanceRun(state, pins);
    const created = await this.runs.create(run_id, pins, blobs, state);
    return { ...publicRun(created), control_token: controlToken };
  }

  async get(runId) { return publicRun(await this.runs.read(runId)); }

  async startSubworkflow(runId, args) {
    const envelope = await this.execution(runId, args);
    requireValue(envelope.subworkflow && envelope.executor.kind === 'subworkflow', 'SUBWORKFLOW_NODE_REQUIRED', 'This node is not a SubWorkflow');
    const identity = childIdentity(runId, args.node_id, args.attempt_id, args.control_token);
    const requestId = 'subworkflow-' + args.attempt_id;
    // The stable child identity is journaled before creating its Run directory.
    // A crash between these writes is reconciled by reopening this exact ID.
    await this.transition(runId, 'child_intent', state => {
      authorize(state, args.control_token); const { attempt } = attemptFor(state, args.node_id, args.attempt_id, args.lease_token);
      requireValue(state.status === 'running', 'RUN_NOT_RUNNING', 'Parent must be running to start a child');
      requireValue(!attempt.dispatch || attempt.child_run_id === identity.run_id && attempt.dispatch.request_id === requestId, 'DISPATCH_CONFLICT', 'Parent attempt has a different dispatch');
      if (!attempt.dispatch) {
        attempt.child_run_id = identity.run_id;
        attempt.dispatch = { request_id: requestId, envelope_hash: digest(canonicalJSON(envelope)), phase: 'intent', receipt: null, cancellation_pending: false }; touch(state);
      }
    });
    const result = await this.transition(runId, 'child_started', async (state, pins) => {
      authorize(state, args.control_token); const { node, attempt } = attemptFor(state, args.node_id, args.attempt_id, args.lease_token);
      requireValue(state.status === 'running', 'RUN_NOT_RUNNING', 'Parent was paused or cancelled before child creation');
      const definition = pins.root.workflow.nodes.find(item => item.id === args.node_id);
      const child = pins.children[definition.subworkflow.workflow_id + '@' + definition.subworkflow.revision_pin];
      const inherited = childPermissions(definition, state, pins, child);
      inherited.permissions.workspace = envelope.workspace;
      validateData(envelope.inputs, child.workflow.inputs_schema);
      const childPins = { ...pins, root: child, inherited_policy: inherited.policy, child_run_id: identity.run_id,
        parent: { run_id: runId, node_id: args.node_id, attempt_id: args.attempt_id, pins_hash: state.pins_hash } };
      if (pins.parallel) childPins.parallel = { ...pins.parallel, ...planParallelBranches(child.workflow, { permissions: inherited.permissions }) };
      const childState = initialRunState({ runId: identity.run_id, pinsHash: digest(canonicalJSON(childPins)), pins: childPins,
        inputs: structuredClone(envelope.inputs), permissions: inherited.permissions, constraints: structuredClone(state.constraints),
        controlHash: digest(identity.control_token), mainActor: state.main_actor, requireApproval: inherited.require_approval });
      let existing;
      // Only absence of the directory is a creation signal. A damaged existing
      // child is never replaced or treated as a fresh execution.
      try { await noSymlinks(this.runs.directory(identity.run_id)); existing = await this.runs.read(identity.run_id); }
      catch (error) {
        if (error.code !== 'ENOENT' || error.path !== this.runs.directory(identity.run_id)) throw error;
      }
      if (existing) {
        requireValue(existing.state.pins_hash === childState.pins_hash && existing.state.control_hash === childState.control_hash && canonicalJSON(existing.state.inputs) === canonicalJSON(childState.inputs) && canonicalJSON(existing.state.permissions) === canonicalJSON(childState.permissions), 'CHILD_RUN_CONFLICT', 'Existing child Run differs from its exact parent dispatch');
      } else {
        const blobs = new Map();
        for (const resource of pins.resources) blobs.set(resource.sha256, await readFile(join(this.runs.directory(runId), 'objects', resource.sha256)));
        advanceRun(childState, childPins); existing = await this.runs.create(identity.run_id, childPins, blobs, childState);
      }
      const acknowledged = attempt.dispatch.phase === 'acknowledged';
      if (!acknowledged) {
        attempt.dispatch.phase = 'acknowledged'; attempt.dispatch.receipt = { task_id: identity.run_id, child_run_id: identity.run_id };
        node.status = 'running'; attempt.status = 'running'; touch(state);
      }
      return { child: { ...publicRun(existing), control_token: identity.control_token }, acknowledged };
    });
    return { dispatched: !result.result.acknowledged, idempotent: result.result.acknowledged, receipt: { task_id: identity.run_id, child_run_id: identity.run_id }, child: result.result.child };
  }

  async collectSubworkflow(runId, args) {
    const envelope = await this.execution(runId, args, { allowInactive: true });
    requireValue(envelope.subworkflow, 'SUBWORKFLOW_NODE_REQUIRED', 'This node is not a SubWorkflow');
    const identity = childIdentity(runId, args.node_id, args.attempt_id, args.control_token);
    const parent = await this.runs.read(runId); const attempt = parent.state.nodes[args.node_id].attempts.find(item => item.id === args.attempt_id);
    requireValue(attempt.child_run_id === identity.run_id && attempt.dispatch?.receipt?.child_run_id === identity.run_id, 'CHILD_DISPATCH_REQUIRED', 'Child collection requires its acknowledged exact identity');
    const child = await this.runs.read(identity.run_id);
    requireValue(child.pins.parent?.run_id === runId && child.pins.parent.attempt_id === args.attempt_id, 'CHILD_RUN_CONFLICT', 'Child ancestry does not match this parent attempt');
    if (['failed', 'cancelled'].includes(child.state.status)) return this.failNode(runId, { ...args, error: { code: 'CHILD_RUN_FAILED', message: `Child ${identity.run_id} is ${child.state.status}: ${child.state.error?.message ?? 'No accepted output'}` } });
    requireValue(child.state.status === 'succeeded', 'CHILD_ACCEPTANCE_REQUIRED', 'Child Run must finish with explicit main acceptance before collection');
    const completions = Object.values(child.state.nodes).flatMap(node => node.attempts.flatMap(attempt => attempt.completion ? [attempt.completion] : []));
    return this.completeNode(runId, { ...args, completion: { status: 'succeeded', summary: 'Collected accepted child Workflow output',
      structured_output: resolveBindings(envelope.subworkflow.output_bindings, { output: child.state.output }),
      artifacts: [{ kind: 'child_run', run_id: identity.run_id }], evidence: [{ kind: 'accepted_child_run', run_id: identity.run_id, sequence: child.sequence, event_hash: child.events.at(-1).hash, pins_hash: child.state.pins_hash }],
      changed_paths: [...new Set(completions.flatMap(item => item.changed_paths))], outside_paths: [...new Set(completions.flatMap(item => item.outside_paths))] } }, CHILD_COMPLETION);
  }

  async cancelTree(runId, args, onFenced = () => {}) {
    const state = await this.cancel(runId, args); const ids = [runId]; const errors = [];
    onFenced(runId, args.control_token);
    for (const [nodeId, node] of Object.entries(state.nodes)) for (const attempt of node.attempts) if (attempt.child_run_id) {
      try {
        const identity = childIdentity(runId, nodeId, attempt.id, args.control_token);
        requireValue(identity.run_id === attempt.child_run_id, 'CHILD_RUN_CONFLICT', 'Child identity does not match its parent'); ids.push(identity.run_id);
        let child;
        try { await noSymlinks(this.runs.directory(identity.run_id)); child = await this.get(identity.run_id); }
        catch (error) { if (error.code !== 'ENOENT' || error.path !== this.runs.directory(identity.run_id)) throw error; continue; }
        if (child.status !== 'succeeded') ids.push(...await this.cancelTree(identity.run_id, identity, onFenced));
      } catch (error) { ids.push(...(error.fenced_run_ids ?? [])); errors.push(error); }
    }
    const fenced = [...new Set(ids)];
    if (errors.length) throw Object.assign(new AggregateError(errors, 'Parent was fenced but some child cancellation journals could not be updated'), { code: 'CHILD_CANCELLATION_INCOMPLETE', fenced_run_ids: fenced });
    return fenced;
  }
  async authorizeController(runId, { control_token }) {
    const record = await this.runs.read(runId); authorize(record.state, control_token); return publicRun(record);
  }
  async recordExecutorEvent(runId, { node_id, attempt_id, lease_token, control_token, event }) {
    const fields = {
      codex_event: ['method', 'thread_id', 'turn_id', 'item_type', 'status'],
      tool_operation: ['call_id', 'tool', 'path', 'phase', 'sha256', 'before_sha256', 'after_sha256', 'entries'],
      profile_owned: ['home', 'executable_sha256', 'pid'],
      session_state: ['status', 'code'],
      result_proposed: ['artifact', 'sha256', 'final_acceptance_required'],
      skill_read: ['call_id', 'path'],
      output_progress: ['characters', 'retained_characters', 'truncated'],
    };
    requireValue(event && Object.hasOwn(fields, event.kind) && event.metadata && Object.keys(event.metadata).every(key => fields[event.kind].includes(key)) &&
      Object.values(event.metadata).every(value => value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 4096 || Number.isSafeInteger(value)) &&
      Buffer.byteLength(canonicalJSON(event)) <= 32000,
      'EXECUTOR_EVENT_SCHEMA', 'Executor events accept bounded metadata only, never raw auth/model payloads');
    const result = await this.runs.mutate(runId, 'executor_event', state => {
      authorize(state, control_token);
      // Late shutdown metadata may document an already fenced attempt; it never
      // changes its lease or makes further execution permissible.
      const { attempt } = attemptFor(state, node_id, attempt_id, lease_token, { active: false });
      attempt.executor_event_count = (attempt.executor_event_count ?? 0) + 1;
      attempt.executor_events = [...(attempt.executor_events ?? []).slice(-63), { sequence: attempt.executor_event_count, ...structuredClone(event) }];
      if (event.kind === 'result_proposed') {
        requireValue(/^[a-f0-9]{64}$/.test(event.metadata.sha256) && event.metadata.artifact === `executor-${attempt_id}-${event.metadata.sha256}.json`, 'EXECUTOR_RESULT_ID', 'Result metadata must identify this exact attempt artifact');
        requireValue(!attempt.result_proposal || canonicalJSON(attempt.result_proposal) === canonicalJSON(event.metadata), 'EXECUTOR_RESULT_CONFLICT', 'Attempt already has a different result proposal');
        attempt.result_proposal = structuredClone(event.metadata);
      }
      if (event.kind === 'session_state' && event.metadata.status === 'closed' && attempt.dispatch) attempt.dispatch.cancellation_pending = false;
      touch(state);
    });
    return { sequence: result.sequence };
  }
  async execution(runId, { node_id, attempt_id, lease_token, control_token }, { allowInactive = false, allowPaused = false } = {}) {
    const { state, pins } = await this.runs.read(runId); authorize(state, control_token);
    if (!allowInactive) await this.assertAncestors(pins, { allowPaused });
    const { attempt } = attemptFor(state, node_id, attempt_id, lease_token, { active: !allowInactive });
    requireValue(allowInactive || state.status === 'running' || allowPaused && state.status === 'paused', 'RUN_NOT_RUNNING', 'Run must be running before dispatch');
    const node = pins.root.workflow.nodes.find(item => item.id === node_id);
    return executionEnvelope(node, state, pins, attempt, lease_token, join(this.runs.directory(runId), 'objects'));
  }
  async next(runId) {
    const { state, pins, sequence } = await this.runs.read(runId);
    let parentBlock = null;
    try { await this.assertAncestors(pins); } catch (error) { if (!['PARENT_RUN_INACTIVE', 'PARENT_LEASE_INACTIVE'].includes(error.code)) throw error; parentBlock = { code: error.code, message: error.message }; }
    return {
      run_id: runId, status: state.status, sequence,
      parent_block: parentBlock,
      ready: state.status === 'running' && !parentBlock ? graphInfo(pins.root.workflow).order.filter(id => state.nodes[id].status === 'ready') : [],
      approvals: Object.values(state.approvals).filter(approval => approval.status === 'pending'),
      integration_gates: (pins.parallel?.regions ?? []).filter(region => region.isolated && state.nodes[region.join_id].status === 'blocked').map(region => ({ region_id: region.id, join_id: region.join_id, phase: state.parallel?.[region.id]?.phase ?? 'not_prepared', proposal: state.parallel?.[region.id]?.proposal ?? null, error: state.parallel?.[region.id]?.error ?? null })),
    };
  }

  async claimNode(runId, { node_id, owner, request_id, control_token, expected_sequence }) {
    requireValue(typeof request_id === 'string' && request_id.length > 0 && request_id.length <= 128, 'CLAIM_REQUEST_ID', 'Claim needs a stable request ID');
    requireValue(typeof owner === 'string' && owner.length > 0 && owner.length <= 256, 'CLAIM_OWNER', 'Claim needs an executor owner');
    const result = await this.transition(runId, 'claim', (state, pins) => {
      authorize(state, control_token);
      const definition = pins.root.workflow.nodes.find(node => node.id === node_id); const node = state.nodes[node_id];
      requireValue(definition && node, 'NODE_MISSING', 'Workflow node does not exist');
      if (definition.executor?.kind === 'main') requireValue(owner === state.main_actor, 'FINALIZER_AUTHORITY', 'Main-agent nodes cannot be claimed by a worker');
      const existing = node.attempts.find(attempt => attempt.claim_request_id === request_id);
      if (existing) {
        requireValue(existing.owner === owner && node.active_attempt_id === existing.id && ['claimed', 'running'].includes(existing.status), 'CLAIM_CONFLICT', 'Claim request refers to a different or closed executor');
        return executionEnvelope(definition, state, pins, existing, leaseToken(control_token, runId, node_id, existing.id, existing.lease_generation ?? 0), join(this.runs.directory(runId), 'objects'));
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

  async completeNode(runId, { node_id, attempt_id, lease_token, completion }, authority) {
    const payload = completionPayload(completion); const fingerprint = digest(canonicalJSON(payload));
    const result = await this.transition(runId, 'complete', (state, pins) => {
      const found = attemptFor(state, node_id, attempt_id, lease_token, { active: false });
      if (found.attempt.completion_hash) {
        requireValue(found.attempt.completion_hash === fingerprint, 'COMPLETION_CONFLICT', 'Duplicate completion differs from committed output'); return;
      }
      const { node, attempt } = attemptFor(state, node_id, attempt_id, lease_token);
      requireValue(!['cancelled', 'succeeded'].includes(state.status), 'RUN_TERMINAL', 'Run cannot accept this completion');
      const definition = pins.root.workflow.nodes.find(item => item.id === node_id);
      requireValue(definition.type !== 'subworkflow' || authority === CHILD_COMPLETION, 'CHILD_ACCEPTANCE_REQUIRED', 'SubWorkflow output must be collected from its exact accepted child Run');
      validateData(payload.structured_output, definition.outputs_schema);
      if (definition.executor?.kind === 'provider') requireValue(attempt.dispatch?.receipt, 'DISPATCH_RECEIPT_REQUIRED', 'Provider completion requires a persisted exact task identity');
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
    }, {}, { allowPaused: true });
    return { ...publicRun(result), idempotent: result.idempotent ?? false };
  }

  async failNode(runId, { node_id, attempt_id, lease_token, error }) {
    requireValue(error && typeof error.message === 'string' && error.message.length <= 20000, 'FAILURE_SCHEMA', 'Failure needs a bounded diagnostic message');
    const result = await this.transition(runId, 'fail', (state, pins) => {
      const { node, attempt } = attemptFor(state, node_id, attempt_id, lease_token);
      node.error = { code: typeof error.code === 'string' ? error.code : 'EXECUTOR_FAILED', message: error.message };
      attempt.status = 'failed'; attempt.error = node.error;
      setOutcome(state, graphInfo(pins.root.workflow), node_id, 'failed');
      if (state.status === 'failed') interruptActiveNodes(state, 'Another node failed without a recovery edge');
      else advanceRun(state, pins);
      touch(state);
    }, {}, { allowPaused: true });
    return publicRun(result);
  }

  async retryNode(runId, { node_id, control_token, reconciliation }) {
    const result = await this.transition(runId, 'retry', async (state, pins) => {
      authorize(state, control_token);
      requireValue(!['cancelled', 'succeeded', 'paused'].includes(state.status), 'RUN_TERMINAL', 'Run cannot release a retry in its current state');
      const node = state.nodes[node_id]; const graph = graphInfo(pins.root.workflow); const definition = graph.nodes.get(node_id);
      requireValue(node && ['failed', 'interrupted', 'blocked'].includes(node.status), 'NODE_RETRY_STATE', 'Only a failed, interrupted or blocked node can be retried');
      requireValue(node.attempts.length < definition.retry.max_attempts, 'RETRY_LIMIT', 'Node exhausted its pinned attempt limit');
      const previous = node.attempts.at(-1);
      if (previous?.child_run_id) {
        const child = await this.runs.read(previous.child_run_id);
        requireValue(TERMINAL.has(child.state.status), 'CHILD_RECONCILIATION_REQUIRED', 'The previous child Run must be terminal before a new attempt can start');
      }
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
    const result = await this.transition(runId, 'approve', (state, pins) => {
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
    const result = await this.transition(runId, 'resume', (state, pins) => {
      authorize(state, control_token);
      requireValue(['paused', 'blocked', 'interrupted'].includes(state.status), 'RUN_RESUME_STATE', 'Run is not paused, blocked or interrupted');
      requireValue(!state.control_recovery?.errors?.length, 'CONTROL_RECOVERY_INCOMPLETE', 'Resolve the recorded recovery/cleanup errors before resuming');
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
    const result = await this.transition(runId, 'dispatch_intent', state => {
      authorize(state, control_token); const { attempt } = attemptFor(state, node_id, attempt_id, lease_token);
      if (attempt.dispatch) { requireValue(attempt.dispatch.request_id === request_id && attempt.dispatch.envelope_hash === envelope_hash, 'DISPATCH_CONFLICT', 'Attempt already has a different dispatch intent'); return; }
      requireValue(state.status === 'running', 'RUN_NOT_RUNNING', 'Paused or terminal Runs cannot dispatch new external work');
      attempt.dispatch = { request_id, envelope_hash, phase: 'intent', receipt: null, cancellation_pending: false }; touch(state);
    });
    return { ...publicRun(result), idempotent: result.idempotent ?? false };
  }

  async recordDispatchReceipt(runId, { node_id, attempt_id, lease_token, request_id, receipt, control_token }) {
    const serialized = canonicalJSON(receipt);
    requireValue(receipt && typeof receipt === 'object' && !Array.isArray(receipt) && Buffer.byteLength(serialized) <= 16000 && !/"[^"\n]*(?:password|cookie|authorization|api_key|access_token|refresh_token)[^"\n]*"\s*:/i.test(serialized), 'DISPATCH_RECEIPT', 'Receipt must contain bounded task identity metadata without credentials');
    requireValue(['task_id', 'thread_id', 'agent_id', 'invocation_id', 'main_actor', 'tool_call_id'].some(key => typeof receipt[key] === 'string' && receipt[key].length > 0 && receipt[key].length <= 256), 'DISPATCH_IDENTITY_REQUIRED', 'Receipt requires a concrete task, agent, invocation or tool-call identity');
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
