// Domain objects remain authoritative. React Flow's measurements and selection
// state never become workflow fields. Layout changes are explicit user edits.
export function toCanvas(workflow, runtime = {}) {
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
