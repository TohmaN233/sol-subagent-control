import { useEffect, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, applyNodeChanges, applyEdgeChanges, useReactFlow, type NodeProps } from '@xyflow/react';
import { toCanvas, moveNode, removeElements, connectNodes, layoutGraph } from './graph-adapter.mjs';
import { Json, Status, uid } from './shared';
export const nodeKinds = ['agent', 'condition', 'parallel', 'join', 'skill_ref', 'subworkflow', 'tool', 'human_gate', 'start', 'end'];
export function newNode(type: string, id = uid(type)): Json {
  const base: Json = { id, type, name: type };
  if (['agent', 'skill_ref', 'subworkflow', 'tool', 'human_gate'].includes(type)) Object.assign(base, { role: 'implementer', executor: { kind: 'main' }, access: 'read_only', path_scope: [], approval: { required: false }, retry: { max_attempts: 1 }, input_bindings: {}, resources: [] });
  if (type === 'agent') base.prompt_template = '说明该节点的任务、产物和验证要求。';
  if (type === 'skill_ref') base.skill_ref = { path: '', name: '', source_hash: '', allowed_nested_skills: [] };
  if (type === 'subworkflow') { base.executor = { kind: 'subworkflow' }; base.subworkflow = { workflow_id: '', revision_pin: '', output_bindings: {} }; }
  if (type === 'tool') base.executor = { kind: 'tool', tool: '' };
  if (type === 'human_gate') base.executor = { kind: 'human' };
  if (type === 'condition') { base.cases = [{ label: 'yes', when: { op: 'eq', args: [{ path: '/inputs/choice' }, { value: true }] } }]; base.default_label = 'no'; }
  if (type === 'parallel') { base.join_id = ''; base.failure_policy = 'collect'; }
  if (type === 'join') base.parallel_id = '';
  return base;
}
function WorkflowNode({ data, selected }: NodeProps) {
  const node = data.definition as Json;
  return <div className={'flow-node ' + (selected ? 'selected' : '')} title={node.id}>
    {node.type !== 'start' && <Handle type="target" position={Position.Left}/>}
    <span className="node-kind">{node.type}</span><strong>{node.name || node.id}</strong>
    <span className="node-binding">{node.executor?.provider_id ?? node.executor?.kind ?? node.id}</span>
    {data.status != null && <Status value={String(data.status)}/>}
    {node.type !== 'end' && <Handle type="source" position={Position.Right}/>}
  </div>;
}
const nodeTypes = { workflow: WorkflowNode };
function Surface({ workflow, onChange, onSelect, runtime, readOnly = false }: { workflow: Json, onChange: (w: Json) => void, onSelect: (kind: string, id: string) => void, runtime?: Json, readOnly?: boolean }) {
  const initial = toCanvas(workflow, runtime); const [nodes, setNodes] = useState<any[]>(initial.nodes); const [edges, setEdges] = useState<any[]>(initial.edges); const flow = useReactFlow();
  useEffect(() => { const graph = toCanvas(workflow, runtime); setNodes(graph.nodes); setEdges(graph.edges); }, [workflow, runtime]);
  return <div className="canvas" onDragOver={e => { if (!readOnly) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }} onDrop={e => {
    if (readOnly) return; e.preventDefault(); const kind = e.dataTransfer.getData('application/sol-node'); if (!nodeKinds.includes(kind)) return;
    const node = newNode(kind); node.ui = { position: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) }; onChange({ ...workflow, nodes: [...workflow.nodes, node] }); onSelect('node', node.id);
  }}>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.15} maxZoom={2}
      nodesDraggable={!readOnly} nodesConnectable={!readOnly} deleteKeyCode={null}
      onNodesChange={changes => setNodes(current => applyNodeChanges(changes, current))}
      onEdgesChange={changes => setEdges(current => applyEdgeChanges(changes, current))}
      onNodeDragStop={(_, node) => { if (!readOnly) onChange(moveNode(workflow, node.id, node.position)); }}
      onNodeClick={(_, node) => onSelect('node', node.id)} onEdgeClick={(_, edge) => onSelect('edge', edge.id)} onPaneClick={() => onSelect('workflow', '')}
      onConnect={connection => { if (!readOnly && connection.source && connection.target) onChange(connectNodes(workflow, connection.source, connection.target, uid('edge'))); }}>
      <Background gap={24}/><Controls showInteractive={false}/><MiniMap pannable zoomable nodeColor="#73674b"/>
    </ReactFlow>
    {!readOnly && <button className="canvas-layout" onClick={() => { onChange(layoutGraph(workflow)); requestAnimationFrame(() => flow.fitView()); }}>自动排列并记入草稿</button>}
  </div>;
}
export function Canvas(props: Parameters<typeof Surface>[0]) { return <ReactFlowProvider><Surface {...props}/></ReactFlowProvider>; }
export { removeElements };
