import { isAbsolute } from 'node:path';
import { createHmac } from 'node:crypto';
import { requireValue } from './workflow-paths.mjs';
import { intersectBoundaries, pathBoundaries, resolveBindings } from './workflow-bindings.mjs';
import { digest, canonicalJSON } from './workflow-revisions.mjs';
import { skillPathKey } from './execution/codex-skill-policy.mjs';
import { effectiveSkillPolicy } from './workflow-reference-schema.mjs';
import { nodeWorkspace } from './parallel/workspace.mjs';

export function runPermissions({ workspace, access, allowed_paths = [] }) {
  requireValue(typeof workspace === 'string' && isAbsolute(workspace), 'RUN_WORKSPACE', 'Run workspace must be absolute');
  requireValue(['read_only', 'bounded_write'].includes(access), 'RUN_ACCESS', 'Run access must be explicitly read-only or bounded-write');
  const paths = pathBoundaries(allowed_paths);
  requireValue(access !== 'bounded_write' || paths.length, 'RUN_PATHS', 'Write access needs concrete current-Run path boundaries');
  return { workspace, access, allowed_paths: paths };
}

export function nodePermissions(node, state) {
  const access = typeof node.access === 'object' ? state.permissions.access : node.access;
  requireValue(['read_only', 'bounded_write'].includes(access), 'NODE_ACCESS', 'Node has no resolved access mode');
  if (access === 'read_only') return { access, allowed_paths: [] };
  requireValue(state.permissions.access === 'bounded_write', 'NODE_WRITE_UNAUTHORIZED', 'Node requests write access outside this Run authorization');
  const requested = Array.isArray(node.path_scope) ? node.path_scope : state.permissions.allowed_paths;
  const paths = intersectBoundaries(state.permissions.allowed_paths, requested);
  requireValue(paths.length, 'NODE_PATHS_EMPTY', 'Node path scope has no intersection with Run permissions');
  return { access, allowed_paths: paths };
}

export function bindingContext(state) {
  return { inputs: state.inputs, nodes: Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => [id, { output: node.output }])) };
}

export function approvalBinding(node, state, pins, attemptNumber = state.nodes[node.id].attempts.length + 1) {
  const provider = node.executor?.kind === 'provider' ? pins.providers.find(item => item.id === node.executor.provider_id) : null;
  const permissions = nodePermissions(node, state);
  return {
    required: Boolean(node.approval.required || provider?.requires_user_approval || state.require_approval),
    hash: digest(canonicalJSON({ revision: state.workflow_revision, node_id: node.id, attempt: attemptNumber, provider, permissions, skill_policy: effectiveSkillPolicy(pins.inherited_policy ?? pins.root.workflow.skill_policy, node.skill_policy), subworkflow: node.subworkflow ?? null })),
  };
}

export function leaseToken(controlToken, runId, nodeId, attemptId, generation = 0) {
  return createHmac('sha256', controlToken).update([runId, nodeId, attemptId, ...(generation ? ['generation', String(generation)] : [])].join('\0')).digest('hex');
}

export function executionEnvelope(node, state, pins, attempt, token, resourcesRoot) {
  const permissions = nodePermissions(node, state);
  const ancestors = new Set(); const queue = [node.id];
  while (queue.length) {
    const target = queue.pop();
    for (const edge of pins.root.workflow.edges.filter(edge => edge.target === target)) if (!ancestors.has(edge.source)) { ancestors.add(edge.source); queue.push(edge.source); }
  }
  const skillPolicy = effectiveSkillPolicy(pins.inherited_policy ?? pins.root.workflow.skill_policy, node.skill_policy);
  const skillPaths = [...skillPolicy.ambient_allow, ...(node.skill_ref ? [node.skill_ref.path, ...node.skill_ref.allowed_nested_skills.map(item => item.path)] : [])];
  const allowedSkills = [...new Set(skillPaths.map(skillPathKey))].map(path => {
    requireValue(!skillPolicy.shadowed_skill_paths.some(shadow => skillPathKey(shadow) === path), 'SKILL_POLICY_CONFLICT', 'Explicit or ambient Skill allowance conflicts with a shadowed source');
    const pin = (pins.skills ?? []).find(skill => skillPathKey(skill.path) === path);
    requireValue(pin, 'SKILL_ALLOW_UNPINNED', 'Node allowance has no immutable Run snapshot'); return structuredClone(pin);
  });
  return {
    run_id: state.run_id, workflow_id: state.workflow_id, workflow_revision: state.workflow_revision,
    node_id: node.id, attempt_id: attempt.id, lease_token: token, executor: structuredClone(node.executor),
    provider: node.executor.kind === 'provider' ? structuredClone(pins.providers.find(item => item.id === node.executor.provider_id)) : null,
    role: node.role ?? null, access: permissions.access, workspace: nodeWorkspace(node.id, state, pins),
    inputs: resolveBindings(node.input_bindings ?? {}, bindingContext(state)), workflow_inputs: structuredClone(state.inputs),
    upstream_results: Object.fromEntries([...ancestors].sort().filter(id => ['succeeded', 'failed'].includes(state.nodes[id].status)).map(id => [id, { status: state.nodes[id].status, output: structuredClone(state.nodes[id].output), error: structuredClone(state.nodes[id].error) }])),
    constraints: structuredClone(state.constraints), prompt_template: node.prompt_template ?? (node.type === 'skill_ref' ? 'Apply the explicitly pinned Skill to {{task}}. Read its references only from the mapped pinned resources.' : null),
    resources: structuredClone(node.resources ?? []), outputs_schema: structuredClone(node.outputs_schema ?? {}),
    skill_policy: skillPolicy, skill_ref: structuredClone(node.skill_ref ?? null),
    subworkflow: structuredClone(node.subworkflow ?? null),
    allowed_skills: allowedSkills,
    effective_allowed_paths: permissions.allowed_paths, resources_root: resourcesRoot,
  };
}
