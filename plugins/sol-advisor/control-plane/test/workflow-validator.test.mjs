import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraft } from '../lib/workflow-schema.mjs';
import { validateWorkflowGraph } from '../lib/workflow-validator.mjs';
import { evaluateExpression, intersectBoundaries, readPointer, resolveBindings } from '../lib/workflow-bindings.mjs';

export const agent = id => ({ id, type: 'agent', executor: { kind: 'main' }, role: 'implementer', access: 'read_only', prompt_template: '{{task}}', approval: { required: false }, retry: { max_attempts: 1 }, input_bindings: {} });
export const edge = (source, target, label) => ({ id: `${source}-${target}`, source, target, ...(label ? { label } : {}) });
export function readyWorkflow(id = 'example') {
  return { ...createDraft(id, 'Example'), status: 'ready', finalization: { required: true, node_id: 'final' },
    nodes: [{ id: 'start', type: 'start' }, { ...agent('final'), role: 'finalizer' }, { id: 'end', type: 'end' }],
    edges: [edge('start', 'final'), edge('final', 'end')] };
}
function withWork() {
  const workflow = readyWorkflow(); workflow.nodes.splice(1, 0, agent('work'));
  workflow.edges = [edge('start', 'work'), edge('work', 'final'), edge('final', 'end')]; return workflow;
}
function branching(type) {
  const workflow = readyWorkflow();
  const fork = type === 'parallel' ? { id: 'fork', type, join_id: 'join' } : { id: 'fork', type, cases: [{ label: 'yes', when: { op: 'exists', args: [{ path: '/inputs/choice' }] } }], default_label: 'no' };
  workflow.nodes.splice(1, 0, fork, agent('a'), agent('b'), ...(type === 'parallel' ? [{ id: 'join', type: 'join', parallel_id: 'fork' }] : []));
  workflow.edges = [edge('start', 'fork'), edge('fork', 'a', 'yes'), edge('fork', 'b', 'no'), edge('a', type === 'parallel' ? 'join' : 'final'), edge('b', type === 'parallel' ? 'join' : 'final'), ...(type === 'parallel' ? [edge('join', 'final')] : []), edge('final', 'end')];
  return workflow;
}
const valid = (workflow, context) => assert.equal(validateWorkflowGraph(workflow, context).valid, true, JSON.stringify(validateWorkflowGraph(workflow, context).errors));
const invalid = (workflow, code, context) => assert(validateWorkflowGraph(workflow, context).errors.some(error => error.code === code), `Missing ${code}: ${JSON.stringify(validateWorkflowGraph(workflow, context))}`);

test('valid sequential, conditional and parallel graphs are deterministic and validation does not mutate inputs', () => {
  for (const workflow of [readyWorkflow(), withWork(), branching('condition'), branching('parallel')]) {
    const before = JSON.stringify(workflow); valid(workflow);
    assert.deepEqual(validateWorkflowGraph(workflow), validateWorkflowGraph(workflow));
    assert.equal(JSON.stringify(workflow), before);
  }
});

test('identity, topology and final acceptance reject each malformed graph', () => {
  const cases = [
    ['START_COUNT', w => { w.nodes.push({ id: 'start2', type: 'start' }); }],
    ['END_COUNT', w => { w.nodes = w.nodes.filter(n => n.id !== 'end'); }],
    ['NODE_DUPLICATE', w => { w.nodes.push({ ...w.nodes[0] }); }],
    ['EDGE_DUPLICATE', w => { w.edges.push({ ...w.edges[0] }); }],
    ['EDGE_ENDPOINT', w => { w.edges[0].target = 'missing'; }],
    ['UNREACHABLE', w => { w.nodes.push(agent('orphan')); }],
    ['NO_END_PATH', w => { w.edges = w.edges.filter(e => e.source !== 'final'); }],
    ['GRAPH_CYCLE', w => { w.edges.push(edge('final', 'start')); }],
    ['FINALIZER_MISSING', w => { w.finalization.node_id = 'missing'; }],
    ['FINALIZER_AUTHORITY', w => { w.nodes.find(n => n.id === 'final').executor = { kind: 'provider', provider_id: 'p' }; }],
    ['FINALIZER_BYPASS', w => { w.edges.push(edge('work', 'end')); }],
    ['FINALIZER_ORDER', w => { w.edges = [edge('start', 'final'), edge('final', 'work'), edge('work', 'end')]; }],
    ['BINDING_SOURCE', w => { w.nodes.find(n => n.id === 'work').input_bindings = { future: '/nodes/final/output/value' }; }],
    ['OUTPUT_BINDINGS', w => { w.output_bindings = { missing: '/nodes/missing/output/value' }; }],
    ['PATH_SCOPE', w => { Object.assign(w.nodes.find(n => n.id === 'work'), { access: 'bounded_write', path_scope: ['src/**'] }); }],
  ];
  for (const [code, mutate] of cases) { const workflow = withWork(); mutate(workflow); invalid(workflow, code); }
});

test('condition DSL, labels and exit correspondence are validated', () => {
  const workflow = branching('condition'); valid(workflow);
  const fork = workflow.nodes.find(n => n.id === 'fork');
  fork.cases.push({ ...fork.cases[0] }); invalid(workflow, 'CONDITION_LABEL'); fork.cases.pop();
  fork.cases[0].when = { op: 'eval', args: [{ value: 'process.exit()' }] }; invalid(workflow, 'CONDITION_DSL');
  fork.cases[0].when = { value: true };
  workflow.edges.find(e => e.source === 'fork').label = 'unknown'; invalid(workflow, 'CONDITION_EDGES');
});

test('parallel joins forbid missing pair, early merges, unrelated branch entry and bypass', () => {
  for (const [code, mutate] of [
    ['PARALLEL_JOIN', w => { w.nodes.find(n => n.id === 'fork').join_id = 'final'; }],
    ['JOIN_PARALLEL', w => { w.nodes.find(n => n.id === 'join').parallel_id = 'missing'; }],
    ['JOIN_BYPASS', w => { w.edges.push(edge('a', 'end')); }],
    ['BRANCH_OVERLAP', w => { w.edges.push(edge('a', 'b')); }],
    ['JOIN_FOREIGN_BRANCH', w => { w.edges.push(edge('start', 'join')); }],
  ]) { const workflow = branching('parallel'); mutate(workflow); invalid(workflow, code); }
});

test('disabled Provider is structurally valid but launch blocked; binding and capabilities are preserved', () => {
  const workflow = withWork(); const worker = workflow.nodes.find(n => n.id === 'work');
  Object.assign(worker, { executor: { kind: 'provider', provider_id: 'p' }, access: 'bounded_write', path_scope: { binding: 'run.allowed_paths' } });
  const provider = { id: 'p', kind: 'native_agent', enabled: false, capabilities: { read: true, write: true }, config: { role: 'implementer' } };
  const context = { providers: [provider] }; valid(workflow, context);
  assert.equal(validateWorkflowGraph(workflow, context).launch_ready, false);
  assert(validateWorkflowGraph(workflow, context).blockers.some(b => b.code === 'PROVIDER_DISABLED'));
  invalid(workflow, 'PROVIDER_MISSING');
  provider.capabilities.write = false; invalid(workflow, 'PROVIDER_CAPABILITY', context);
  provider.capabilities.write = true; provider.config.role = 'reviewer'; invalid(workflow, 'PROVIDER_ROLE', context);
});

test('Skill references detect missing and stale sources', () => {
  const workflow = withWork(); const worker = workflow.nodes.find(n => n.id === 'work');
  workflow.skill_policy.mode = 'strict'; workflow.skill_policy.implicit = 'deny';
  worker.type = 'skill_ref'; worker.skill_ref = { path: '/synthetic/SKILL.md', name: 'synthetic', source_hash: 'a'.repeat(64), expected_version: '1', allowed_nested_skills: [] };
  const context = { skills: [{ path: worker.skill_ref.path, source_hash: worker.skill_ref.source_hash, version: '1' }] };
  valid(workflow, context); invalid(workflow, 'SKILL_MISSING');
  context.skills[0].source_hash = 'b'.repeat(64); invalid(workflow, 'SKILL_STALE', context);
});

test('SubWorkflow references require pinned existence and reject recursive paths', () => {
  const workflow = withWork(); const worker = workflow.nodes.find(n => n.id === 'work');
  worker.type = 'subworkflow'; worker.executor = { kind: 'subworkflow' }; worker.subworkflow = { workflow_id: 'child', revision_pin: 'a'.repeat(64), output_bindings: { result: '/output' } };
  const child = readyWorkflow('child');
  const context = { workflows: { ['child@' + 'a'.repeat(64)]: child } };
  valid(workflow, context); invalid(workflow, 'SUBWORKFLOW_MISSING');
  const childWorker = { id: 'recursive', type: 'subworkflow', subworkflow: { workflow_id: workflow.id, revision_pin: 'b'.repeat(64) } };
  child.nodes.splice(1, 0, childWorker); child.edges = [edge('start', 'recursive'), edge('recursive', 'final'), edge('final', 'end')];
  invalid(workflow, 'SUBWORKFLOW_INVALID', context);
  const error = validateWorkflowGraph(workflow, context).errors.find(e => e.code === 'SUBWORKFLOW_INVALID');
  assert(error.child_errors.some(e => e.code === 'SUBWORKFLOW_CYCLE'));
});

test('finite condition language has typed comparisons, JSON Pointer and short-circuit guards', () => {
  const literal = value => ({ value }); const expr = (op, ...args) => ({ op, args });
  for (const [op, a, b] of [['eq', 1, 1], ['ne', 1, '1'], ['contains', [1, 2], 2], ['contains', 'abcd', 'bc'], ['in', 2, [1, 2]], ['gt', 2, 1], ['gte', 2, 2], ['lt', 1, 2], ['lte', 1, 1]]) assert.equal(evaluateExpression(expr(op, literal(a), literal(b)), {}), true);
  const optional = expr('and', expr('exists', { path: '/absent' }), expr('eq', { path: '/absent' }, literal(1)));
  assert.equal(evaluateExpression(optional, {}), false);
  assert.equal(evaluateExpression(expr('or', literal(true), expr('eq', { path: '/absent' }, literal(1))), {}), true);
  assert.equal(evaluateExpression(expr('not', literal(false)), {}), true);
  assert.throws(() => evaluateExpression(expr('gt', literal('2'), literal(1)), {}), { code: 'CONDITION_TYPE' });
  assert.deepEqual(readPointer({ 'a/b': { '~': 3 } }, '/a~1b/~0'), { found: true, value: 3 });
  assert.throws(() => resolveBindings({ result: '/missing' }, {}), { code: 'BINDING_MISSING' });
  assert.deepEqual(intersectBoundaries(['src', 'README.md'], ['src/lib', 'README.md', 'other']), ['README.md', 'src/lib']);
});
