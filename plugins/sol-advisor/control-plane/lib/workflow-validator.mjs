import { NODE_TYPES, validateWorkflowShape } from './workflow-schema.mjs';
import { workflowId } from './workflow-paths.mjs';
import { pathBoundaries, pointerParts, validateExpression } from './workflow-bindings.mjs';
import { validateDataSchema } from './workflow-data-schema.mjs';

const EXECUTED = new Set(['agent', 'skill_ref', 'tool', 'human_gate']);
const SHA = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateWorkflowGraph(workflow, context = {}, stack = []) {
  const errors = []; const blockers = [];
  const issue = (code, message, location = {}, target = errors) => target.push({ code, message, workflow_id: workflow?.id ?? null, ...location });
  if (stack.length > 32) { issue('SUBWORKFLOW_DEPTH', 'SubWorkflow nesting limit exceeded'); return { valid: false, launch_ready: false, errors, blockers, order: [] }; }
  try { validateWorkflowShape(workflow); } catch (error) { issue(error.code ?? 'WORKFLOW_SCHEMA', error.message); return { valid: false, launch_ready: false, errors, blockers, order: [] }; }
  for (const key of ['inputs_schema', 'outputs_schema']) try { validateDataSchema(workflow[key] ?? {}); } catch (error) { issue(error.code, error.message, { field: key }); }
  const providers = new Map((context.providers ?? []).map(provider => [provider.id, provider]));
  const nodes = new Map(); const edges = new Map();
  for (const node of workflow.nodes) {
    if (!object(node)) { issue('NODE_SCHEMA', 'Node must be an object'); continue; }
    try { workflowId(node.id); } catch { issue('NODE_ID', 'Invalid node ID', { node_id: node.id }); continue; }
    if (nodes.has(node.id)) issue('NODE_DUPLICATE', 'Duplicate node ID', { node_id: node.id });
    else nodes.set(node.id, node);
    if (!NODE_TYPES.has(node.type)) issue('NODE_TYPE', 'Unsupported node type', { node_id: node.id });
    if (node.outputs_schema !== undefined) try { validateDataSchema(node.outputs_schema); } catch (error) { issue(error.code, error.message, { node_id: node.id }); }
  }
  const out = new Map([...nodes.keys()].map(id => [id, []]));
  const incoming = new Map([...nodes.keys()].map(id => [id, []]));
  for (const edge of workflow.edges) {
    if (!object(edge)) { issue('EDGE_SCHEMA', 'Edge must be an object'); continue; }
    try { workflowId(edge.id); } catch { issue('EDGE_ID', 'Invalid edge ID', { edge_id: edge.id }); continue; }
    if (edges.has(edge.id)) { issue('EDGE_DUPLICATE', 'Duplicate edge ID', { edge_id: edge.id }); continue; }
    edges.set(edge.id, edge);
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) { issue('EDGE_ENDPOINT', 'Edge endpoint does not exist', { edge_id: edge.id }); continue; }
    if (!['success', 'failure', 'always'].includes(edge.on ?? 'success')) issue('EDGE_POLICY', 'Unknown edge outcome policy', { edge_id: edge.id });
    out.get(edge.source).push(edge); incoming.get(edge.target).push(edge);
  }
  const visit = (start, links = out, stop) => {
    const seen = new Set(); const todo = [start];
    while (todo.length) {
      const id = todo.pop(); if (id === stop || seen.has(id) || !nodes.has(id)) continue;
      seen.add(id);
      for (const edge of links.get(id)) todo.push(links === out ? edge.target : edge.source);
    }
    return seen;
  };
  const starts = [...nodes.values()].filter(node => node.type === 'start');
  const ends = [...nodes.values()].filter(node => node.type === 'end');
  if (starts.length !== 1) issue('START_COUNT', 'Exactly one start node is required');
  if (!ends.length) issue('END_COUNT', 'At least one end node is required');
  const indegree = new Map([...nodes].map(([id]) => [id, incoming.get(id).length]));
  const ready = [...nodes.keys()].filter(id => !indegree.get(id)).sort(); const order = [];
  while (ready.length) {
    const id = ready.shift(); order.push(id);
    for (const edge of out.get(id)) { indegree.set(edge.target, indegree.get(edge.target) - 1); if (!indegree.get(edge.target)) { ready.push(edge.target); ready.sort(); } }
  }
  if (order.length !== nodes.size) issue('GRAPH_CYCLE', 'Workflow graphs must be acyclic');
  const reachable = starts.length === 1 ? visit(starts[0].id) : new Set();
  const toEnd = new Set(ends.flatMap(node => [...visit(node.id, incoming)]));
  for (const node of nodes.values()) {
    const location = { node_id: node.id };
    if (!reachable.has(node.id)) issue('UNREACHABLE', 'Node is unreachable from start', location);
    if (!toEnd.has(node.id)) issue('NO_END_PATH', 'Node has no path to an end', location);
    if (node.type === 'start' && (incoming.get(node.id).length || out.get(node.id).length !== 1)) issue('START_EDGES', 'Start requires exactly one outgoing and no incoming edge', location);
    if (node.type === 'end' && out.get(node.id).length) issue('END_EDGES', 'End cannot have outgoing edges', location);
    if (!['condition', 'parallel', 'end'].includes(node.type)) {
      const successes = out.get(node.id).filter(edge => ['success', 'always'].includes(edge.on ?? 'success'));
      const failures = out.get(node.id).filter(edge => ['failure', 'always'].includes(edge.on ?? 'success'));
      if (successes.length !== 1 || failures.length > 1) issue('NODE_OUTCOMES', 'Use explicit condition/parallel nodes for branching', location);
    }
    if (EXECUTED.has(node.type)) {
      const runBoundAccess = object(node.access) && node.access.binding === 'run.access' && Object.keys(node.access).length === 1 && node.executor?.kind === 'main';
      if (!['read_only', 'bounded_write'].includes(node.access) && !runBoundAccess) issue('NODE_ACCESS', 'Executed nodes need a fixed access mode or main-agent Run access binding', location);
      if (node.role === 'reviewer' && node.access !== 'read_only') issue('REVIEWER_ACCESS', 'Reviewers must be read-only', location);
      if (node.access === 'bounded_write' || runBoundAccess) {
        try {
          if (!(object(node.path_scope) && node.path_scope.binding === 'run.allowed_paths' && Object.keys(node.path_scope).length === 1)) {
            if (!pathBoundaries(node.path_scope).length) throw new Error('Empty path scope');
          }
        } catch { issue('PATH_SCOPE', 'Bounded writes require non-glob path boundaries or an explicit Run scope binding', location); }
      }
      if (!object(node.approval) || typeof node.approval.required !== 'boolean') issue('NODE_APPROVAL', 'Node approval policy must be explicit', location);
      if (!object(node.retry) || !Number.isInteger(node.retry.max_attempts) || node.retry.max_attempts < 1 || node.retry.max_attempts > 10) issue('NODE_RETRY', 'Retry limit must be between 1 and 10', location);
      const executor = node.executor;
      if (['agent', 'skill_ref'].includes(node.type) && (typeof node.role !== 'string' || !node.role.trim() || node.role.length > 64)) issue('NODE_ROLE', 'Agent role must be explicit', location);
      if (!object(executor) || !['main', 'provider', 'tool', 'human'].includes(executor.kind)) issue('EXECUTOR', 'Executed node needs a known executor', location);
      else if (executor.kind === 'provider') {
        const provider = providers.get(executor.provider_id);
        if (!provider) issue('PROVIDER_MISSING', 'Pinned Provider does not exist', location);
        else {
          if (!provider.enabled) issue('PROVIDER_DISABLED', 'Pinned Provider is disabled', location, blockers);
          if (!provider.capabilities?.read || (node.access === 'bounded_write' && !provider.capabilities?.write)) issue('PROVIDER_CAPABILITY', 'Provider capabilities do not match access', location);
          if (provider.kind === 'native_agent' && provider.config?.role && !['advisor', node.role].includes(provider.config.role)) issue('PROVIDER_ROLE', 'Native Provider role does not match node role', location);
        }
      }
      if (node.type === 'tool' && executor?.kind !== 'tool') issue('TOOL_EXECUTOR', 'Tool nodes require a tool executor', location);
      if (node.type === 'human_gate' && executor?.kind !== 'human') issue('HUMAN_EXECUTOR', 'Human gates require a human executor', location);
      if (['agent', 'skill_ref'].includes(node.type) && !['main', 'provider'].includes(executor?.kind)) issue('AGENT_EXECUTOR', 'Agent and SkillRef nodes require main or Provider execution', location);
      if (node.type === 'agent' && (typeof node.prompt_template !== 'string' || !node.prompt_template.trim())) issue('NODE_PROMPT', 'Agent requires instructions', location);
    }
    function checkPointer(pointer) {
      try {
        const parts = pointerParts(pointer);
        if (parts[0] === 'inputs') return;
        if (parts[0] !== 'nodes' || !nodes.has(parts[1]) || parts[2] !== 'output') throw new Error('Unknown binding source');
        if (parts[1] === node.id || !visit(parts[1]).has(node.id)) throw new Error('Binding must refer to an upstream producer');
      } catch (error) { issue('BINDING_SOURCE', error.message, location); }
    }
    if (node.input_bindings !== undefined && !object(node.input_bindings)) issue('BINDING_SCHEMA', 'Input bindings must be a map of JSON Pointers', location);
    else for (const pointer of Object.values(node.input_bindings ?? {})) checkPointer(pointer);
    if (node.type === 'condition') {
      const labels = new Set();
      if (!Array.isArray(node.cases) || !node.cases.length) issue('CONDITION_CASES', 'Condition needs ordered cases', location);
      for (const entry of Array.isArray(node.cases) ? node.cases : []) {
        if (!object(entry) || typeof entry.label !== 'string' || !entry.label || labels.has(entry.label)) { issue('CONDITION_LABEL', 'Case labels must be unique and nonempty', location); continue; }
        labels.add(entry.label);
        try { validateExpression(entry.when, { onPointer: checkPointer }); } catch (error) { issue('CONDITION_DSL', error.message, location); }
      }
      if (typeof node.default_label !== 'string' || !node.default_label || labels.has(node.default_label)) issue('CONDITION_DEFAULT', 'Condition needs a distinct default label', location);
      labels.add(node.default_label);
      const outgoing = out.get(node.id);
      if (outgoing.length !== labels.size || new Set(outgoing.map(edge => edge.label)).size !== labels.size || outgoing.some(edge => !labels.has(edge.label) || (edge.on ?? 'success') !== 'success')) issue('CONDITION_EDGES', 'Each condition label needs exactly one success edge', location);
    }
    if (node.type === 'skill_ref') {
      const reference = node.skill_ref;
      if (!object(reference) || typeof reference.path !== 'string' || !reference.name || !SHA.test(reference.source_hash) || !Array.isArray(reference.allowed_nested_skills)) issue('SKILL_REFERENCE', 'SkillRef needs path, name, source hash and allowed nested Skills', location);
      else {
        const skill = (context.skills ?? []).find(item => item.path === reference.path);
        if (!skill) issue('SKILL_MISSING', 'Referenced Skill does not exist', location);
        else if (skill.source_hash !== reference.source_hash || (reference.expected_version !== undefined && skill.version !== reference.expected_version)) issue('SKILL_STALE', 'Skill content/version differs from the pin', location);
      }
    }
    if (node.type === 'subworkflow') {
      const reference = node.subworkflow;
      if (!object(reference) || !reference.workflow_id || !SHA.test(reference.revision_pin)) issue('SUBWORKFLOW_REFERENCE', 'SubWorkflow requires an immutable revision pin', location);
      else {
        const key = reference.workflow_id + '@' + reference.revision_pin;
        if (reference.workflow_id === workflow.id || stack.some(item => item.split('@')[0] === reference.workflow_id)) issue('SUBWORKFLOW_CYCLE', 'Recursive SubWorkflows are not supported', location);
        else {
          const child = context.workflows?.[key];
          if (!child) issue('SUBWORKFLOW_MISSING', 'Pinned SubWorkflow revision does not exist', location);
          else {
            const checked = validateWorkflowGraph(child, context, [...stack, workflow.id + '@current']);
            if (!checked.valid) issue('SUBWORKFLOW_INVALID', 'Pinned SubWorkflow is invalid', { ...location, child_errors: checked.errors });
            for (const blocker of checked.blockers) issue('SUBWORKFLOW_BLOCKED', blocker.message, { ...location, child: key }, blockers);
          }
        }
      }
    }
  }
  for (const parallel of [...nodes.values()].filter(node => node.type === 'parallel')) {
    const location = { node_id: parallel.id };
    if (parallel.failure_policy !== undefined && !['fail_fast', 'collect'].includes(parallel.failure_policy)) issue('PARALLEL_FAILURE_POLICY', 'Parallel failure policy must be fail_fast or collect', location);
    const join = nodes.get(parallel.join_id);
    if (join?.type !== 'join' || join.parallel_id !== parallel.id) { issue('PARALLEL_JOIN', 'Parallel requires a matching Join', location); continue; }
    const branches = out.get(parallel.id);
    if (branches.length < 2 || branches.some(edge => !edge.label || edge.target === join.id || (edge.on ?? 'success') !== 'success') || new Set(branches.map(edge => edge.label)).size !== branches.length) issue('PARALLEL_BRANCHES', 'Parallel needs at least two distinct labeled branches', location);
    const sets = branches.map(edge => visit(edge.target, out, join.id));
    const all = new Set(sets.flatMap(set => [...set]));
    for (let index = 0; index < sets.length; index++) for (const id of sets[index]) {
      if (!visit(id).has(join.id) || visit(id, out, join.id).size && [...visit(id, out, join.id)].some(next => nodes.get(next).type === 'end')) issue('JOIN_BYPASS', 'Every parallel branch path must pass through its Join', { node_id: id });
      if (sets.some((set, other) => other !== index && set.has(id))) issue('BRANCH_OVERLAP', 'Branches cannot merge before their Join', { node_id: id });
      if (incoming.get(id).some(edge => !sets[index].has(edge.source) && !(edge.source === parallel.id && edge.target === branches[index].target))) issue('FOREIGN_BRANCH_ENTRY', 'An unrelated path enters this branch', { node_id: id });
    }
    if (incoming.get(join.id).some(edge => !all.has(edge.source)) || incoming.get(join.id).length < 2) issue('JOIN_FOREIGN_BRANCH', 'Join has missing or unrelated incoming branches', { node_id: join.id });
  }
  for (const join of [...nodes.values()].filter(node => node.type === 'join')) if (nodes.get(join.parallel_id)?.join_id !== join.id) issue('JOIN_PARALLEL', 'Join must belong to exactly one Parallel', { node_id: join.id });
  const finalizer = nodes.get(workflow.finalization?.node_id);
  if (workflow.finalization?.required !== true || !finalizer || finalizer.type !== 'agent') issue('FINALIZER_MISSING', 'A final acceptance agent is required');
  else {
    if (finalizer.executor?.kind !== 'main') issue('FINALIZER_AUTHORITY', 'Final acceptance belongs to the main agent', { node_id: finalizer.id });
    if (starts.length === 1 && ends.some(node => visit(starts[0].id, out, finalizer.id).has(node.id))) issue('FINALIZER_BYPASS', 'Every path to an end must pass final acceptance', { node_id: finalizer.id });
    if (out.get(finalizer.id).some(edge => nodes.get(edge.target)?.type !== 'end')) issue('FINALIZER_ORDER', 'Only termination may follow final acceptance', { node_id: finalizer.id });
  }
  if (workflow.output_bindings !== undefined && !object(workflow.output_bindings)) issue('OUTPUT_BINDINGS', 'Workflow output bindings must be a JSON Pointer map');
  else for (const [binding, pointer] of Object.entries(workflow.output_bindings ?? {})) {
    try {
      const parts = pointerParts(pointer);
      if (parts[0] !== 'inputs' && !(parts[0] === 'nodes' && nodes.has(parts[1]) && parts[2] === 'output')) throw new Error('Unknown workflow output source');
    } catch (error) { issue('OUTPUT_BINDINGS', error.message, { binding }); }
  }
  if (!object(workflow.skill_policy) || !['strict', 'cooperative'].includes(workflow.skill_policy.mode) || (workflow.skill_policy.mode === 'strict' && workflow.skill_policy.implicit !== 'deny')) issue('SKILL_POLICY', 'Workflow must declare a valid Skill policy');
  if (!object(workflow.requirements)) issue('REQUIREMENTS_SCHEMA', 'Requirements must be an object');
  else for (const kind of ['providers', 'tools', 'mcp_servers', 'executables']) {
    const required = workflow.requirements[kind];
    if (!Array.isArray(required) || required.some(id => typeof id !== 'string' || !id)) { issue('REQUIREMENTS_SCHEMA', `Requirements ${kind} must be a string array`); continue; }
    for (const id of required) {
      if (kind === 'providers') {
        if (!providers.has(id)) issue('PROVIDER_MISSING', `Required Provider does not exist: ${id}`);
        else if (!providers.get(id).enabled) issue('PROVIDER_DISABLED', `Required Provider is disabled: ${id}`, {}, blockers);
      } else if (!(context[kind] ?? []).includes(id)) issue('REQUIREMENT_UNAVAILABLE', `Required ${kind} entry is unavailable: ${id}`, { requirement: id }, blockers);
    }
  }
  if (!workflow.enabled) issue('WORKFLOW_DISABLED', 'Workflow is disabled', {}, blockers);
  if (workflow.status !== 'ready') issue('WORKFLOW_DRAFT', 'Draft Workflow cannot start', {}, blockers);
  return { valid: errors.length === 0, launch_ready: errors.length === 0 && blockers.length === 0, errors, blockers, order };
}
