import { canonicalJSON, digest } from '../workflow-revisions.mjs';
import { requireValue } from '../workflow-paths.mjs';

export function importIssueId(issue) {
  const { id, ...observation } = issue;
  return digest(canonicalJSON(observation));
}
export function importReviewPacket(pack) {
  requireValue(pack.workflow.import_status, 'IMPORT_KIND', 'This Workflow was not imported from a Skill');
  return { revision_hash: pack.revision_hash,
    issues: pack.workflow.import_status.unresolved.map(issue => ({ ...issue, id: importIssueId(issue) })),
    inferences: ['nodes', 'edges'].flatMap(kind => pack.workflow[kind].filter(item => item.origin?.kind === 'inferred').map(item => ({ kind, id: item.id, origin: item.origin }))),
    requirements: pack.workflow.requirements, review_history: pack.import_report?.review_history ?? [] };
}

export async function reviewImportedDraft(store, workflowId, { expected_revision, decisions = [], inferences = [] }) {
  const pack = await store.snapshot(workflowId, expected_revision); const packet = importReviewPacket(pack);
  requireValue(Array.isArray(decisions) && Array.isArray(inferences) && decisions.length + inferences.length > 0 && decisions.length + inferences.length <= 1000, 'IMPORT_REVIEW_SCHEMA', 'Review needs bounded explicit decisions');
  const workflow = structuredClone(pack.workflow); const reviewedIssues = new Set(); const reviewedItems = new Set(); const records = [];
  function note(value) { requireValue(typeof value === 'string' && value.trim() && value.length <= 2000, 'IMPORT_REVIEW_NOTE', 'Each review decision needs a bounded reason or verification note'); return value.trim(); }
  for (const decision of decisions) {
    const issue = packet.issues.find(issue => issue.id === decision.issue_id);
    requireValue(issue && !reviewedIssues.has(issue.id) && issue.code !== 'AI_INFERENCES_REQUIRE_REVIEW' && ['resolved', 'not_required'].includes(decision.resolution), 'IMPORT_REVIEW_ISSUE', 'Select an unresolved observation exactly once; AI inferences require per-item review');
    reviewedIssues.add(issue.id); records.push({ issue_id: issue.id, observation: issue, resolution: decision.resolution, note: note(decision.note) });
    if (issue.code === 'INLINE_SKILL_REQUIRES_REVIEW') {
      const node = workflow.nodes.find(node => node.id === issue.node_id);
      requireValue(node?.origin?.kind === 'inlined_skill' && decision.resolution === 'resolved', 'IMPORT_REVIEW_ITEM', 'Inline conversion requires review of its exact converted node');
      node.origin.reviewed = true; node.origin.review = { actor: 'user', revision: pack.revision_hash, note: note(decision.note) };
    }
  }
  for (const inference of inferences) {
    requireValue(['nodes', 'edges'].includes(inference.kind), 'IMPORT_REVIEW_ITEM', 'Select a node or edge inference');
    const item = workflow[inference.kind].find(item => item.id === inference.id); const key = inference.kind + '/' + inference.id;
    requireValue(item?.origin?.kind === 'inferred' && !item.origin.reviewed && !reviewedItems.has(key), 'IMPORT_REVIEW_ITEM', 'Inference is absent, duplicated or already reviewed');
    reviewedItems.add(key); const reason = note(inference.note);
    item.origin.reviewed = true; item.origin.review = { actor: 'user', revision: pack.revision_hash, note: reason };
    records.push({ kind: inference.kind, id: inference.id, resolution: 'reviewed', note: reason });
  }
  const pendingInference = ['nodes', 'edges'].some(kind => workflow[kind].some(item => item.origin?.kind === 'inferred' && !item.origin.reviewed));
  workflow.import_status.unresolved = workflow.import_status.unresolved.filter(issue => !reviewedIssues.has(importIssueId(issue)) && (issue.code !== 'AI_INFERENCES_REQUIRE_REVIEW' || pendingInference));
  workflow.status = 'draft'; // Review never auto-publishes or broadens a requirement.
  const history = pack.import_report?.review_history ?? [];
  requireValue(history.length < 512, 'IMPORT_REVIEW_LIMIT', 'Review history exceeded its bounded revision limit');
  return store.save(workflowId, workflow, { expected_revision, import_report: { ...pack.import_report,
    review_history: [...history, { actor: 'user', source_revision: pack.revision_hash, at: new Date().toISOString(), decisions: records }] } });
}
