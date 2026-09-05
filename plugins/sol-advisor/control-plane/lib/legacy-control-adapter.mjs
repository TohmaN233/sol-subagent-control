import { requireValue } from './workflow-paths.mjs';

export function resolveLegacyWorkflowRequest(config, request) {
  if (request.workflow_id) {
    requireValue(!request.task_type_id && !request.stage_id, 'AMBIGUOUS_WORKFLOW_REQUEST', 'Use either Workflow fields or legacy Task Type/Stage fields');
    return { ...request };
  }
  const mapping = config.legacy_mapping && Object.hasOwn(config.legacy_mapping, request.task_type_id) ? config.legacy_mapping[request.task_type_id] : undefined;
  requireValue(mapping, 'LEGACY_TASK_TYPE_MISSING', 'Legacy Task Type has no migrated Workflow');
  let nodeId;
  if (request.stage_id !== undefined) {
    nodeId = Object.hasOwn(mapping.stage_nodes, request.stage_id) ? mapping.stage_nodes[request.stage_id] : undefined;
    requireValue(nodeId, 'LEGACY_STAGE_MISSING', 'Legacy Stage has no migrated node');
  }
  const { task_type_id, stage_id, ...rest } = request;
  return { ...rest, workflow_id: mapping.workflow_id, ...(nodeId ? { node_id: nodeId } : {}) };
}
