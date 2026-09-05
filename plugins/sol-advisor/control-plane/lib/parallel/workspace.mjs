import { join } from 'node:path';
import { nodeBranchChain, branchOwner } from './branch-planner.mjs';

export function nodeWorkspace(nodeId, state, pins) {
  const scope = pins.parallel && nodeBranchChain(pins.parallel, nodeId).at(-1);
  return scope ? join(pins.parallel.worktree_root, 'tree-' + branchOwner(state.run_id, scope.region.id, scope.branch.id)) : state.permissions.workspace;
}
