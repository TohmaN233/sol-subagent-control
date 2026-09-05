// Domain objects remain authoritative. React Flow's measurements and selection
// state never become workflow fields. Layout changes are explicit user edits.
export function canvasIssues(workflow) {
  const issues = []; const nodes = new Set(); const edges = new Set();
  if (!Array.isArray(workflow?.nodes) || !Array.isArray(workflow?.edges)) return ['nodes 和 edges 必须是数组'];
  for (const [index, node] of workflow.nodes.entries()) {
    if (!node || typeof node.id !== 'string' || !node.id || typeof node.type !== 'string' || nodes.has(node.id)) { issues.push(`nodes[${index}] 缺少唯一 ID 或类型`); continue; }
    nodes.add(node.id);
    if (node.ui?.position && (!Number.isFinite(node.ui.position.x) || !Number.isFinite(node.ui.position.y))) issues.push(`nodes[${index}] 的坐标必须是有限数字`);
  }
  for (const [index, edge] of workflow.edges.entries()) {
    if (!edge || typeof edge.id !== 'string' || !edge.id || edges.has(edge.id) || !nodes.has(edge.source) || !nodes.has(edge.target)) { issues.push(`edges[${index}] 缺少唯一 ID 或有效端点`); continue; }
    edges.add(edge.id);
  }
  return issues;
}
export function toCanvas(workflow, runtime = {}) {
  const issues = canvasIssues(workflow); if (issues.length) throw new Error(issues.join('\n'));
  const displayLayout = layoutGraph(workflow);
  return {
    nodes: workflow.nodes.map((node, index) => ({ id: node.id, type: 'workflow',
      position: node.ui?.position ?? displayLayout.nodes[index].ui.position,
      data: { definition: structuredClone(node), status: runtime[node.id]?.status ?? null } })),
    edges: workflow.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target,
      label: [edge.label, edge.on && edge.on !== 'success' ? edge.on : ''].filter(Boolean).join(' · '),
      data: { definition: structuredClone(edge) } })),
  };
}
export function moveNode(workflow, id, position) {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('Invalid canvas position');
  return { ...workflow, nodes: workflow.nodes.map(node => node.id === id ? { ...node, ui: { ...node.ui, position: { x: position.x, y: position.y } } } : node) };
}
export function removeElements(workflow, nodeIds, edgeIds = []) {
  return { ...workflow, nodes: workflow.nodes.filter(node => !nodeIds.includes(node.id)),
    edges: workflow.edges.filter(edge => !edgeIds.includes(edge.id) && !nodeIds.includes(edge.source) && !nodeIds.includes(edge.target)) };
}
export function connectNodes(workflow, source, target, id) {
  if (!workflow.nodes.some(node => node.id === source) || !workflow.nodes.some(node => node.id === target)) throw new Error('Connection endpoint missing');
  return { ...workflow, edges: [...workflow.edges, { id, source, target, on: 'success' }] };
}
export function layoutGraph(workflow) {
  const ranks = new Map(workflow.nodes.map(node => [node.id, 0]));
  // Bounded even for an invalid cyclic Draft; the backend supplies diagnostics.
  for (let i = 0; i < workflow.nodes.length; i++) {
    let changed = false;
    for (const edge of workflow.edges) if (ranks.has(edge.source) && ranks.has(edge.target)) {
      const rank = Math.min(workflow.nodes.length, ranks.get(edge.source) + 1);
      if (rank > ranks.get(edge.target)) { ranks.set(edge.target, rank); changed = true; }
    }
    if (!changed) break;
  }
  const rows = new Map();
  return { ...workflow, nodes: workflow.nodes.map(node => {
    const rank = ranks.get(node.id); const row = rows.get(rank) ?? 0; rows.set(rank, row + 1);
    return { ...node, ui: { ...node.ui, position: { x: 50 + rank * 270, y: 70 + row * 160 } } };
  }) };
}
