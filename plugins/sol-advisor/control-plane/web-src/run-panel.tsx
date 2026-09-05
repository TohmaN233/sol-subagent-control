import { useEffect, useState } from 'react';
import { api, Field, JsonField, Details, Status, pretty, type Json, uid } from './shared';
import { Canvas } from './canvas';
export const controllers = new Map<string, string>();
const leases = new Map<string, Json>();
export function rememberRun(run: Json) { if (run.control_token) controllers.set(run.run_id, run.control_token); return run.run_id as string; }
export function RunPanel({ runId, act, onRun }: { runId: string, act: (work: () => Promise<any>) => void, onRun: (id: string) => void }) {
  const [state, setState] = useState<Json | null>(null); const [pack, setPack] = useState<Json | null>(null); const [next, setNext] = useState<Json>({}); const [events, setEvents] = useState<Json[]>([]);
  const [nodeId, setNodeId] = useState(''); const [result, setResult] = useState<Json | null>(null); const [login, setLogin] = useState<Json | null>(null);
  const [receipt, setReceipt] = useState<Json>({}); const [completion, setCompletion] = useState<Json>({ status: 'succeeded', summary: '', structured_output: {}, artifacts: [], evidence: [], changed_paths: [], outside_paths: [] });
  const [accepted, setAccepted] = useState(false); const [merge, setMerge] = useState<Json | null>(null); const [reconciliation, setReconciliation] = useState<Json>({});
  const token = controllers.get(runId); const control = { run_id: runId, control_token: token };
  const key = runId + '/' + nodeId; const lease = leases.get(key); const args = { ...control, ...(lease ? { node_id: nodeId, attempt_id: lease.attempt_id, lease_token: lease.lease_token } : {}) };
  async function refresh() {
    const [s, n] = await Promise.all([api('get', { run_id: runId }), api('next', { run_id: runId })]); setState(s); setNext(n);
    if (controllers.has(runId)) setEvents(await api('events', { run_id: runId, control_token: controllers.get(runId), after_sequence: 0 }));
  }
  useEffect(() => { setState(null); setPack(null); setNodeId(''); setResult(null); setLogin(null); setMerge(null); setEvents([]); act(async () => { setPack(await api('run_definition', { run_id: runId })); await refresh(); }); }, [runId]);
  useEffect(() => { let stopped = false; let timer: ReturnType<typeof setTimeout>; const poll = async () => { if (stopped) return; try { await refresh(); } catch (error) { act(async () => { throw error; }); return; } if (!stopped) timer = setTimeout(poll, 2500); }; timer = setTimeout(poll, 2500); return () => { stopped = true; clearTimeout(timer); }; }, [runId, token]);
  useEffect(() => { setResult(null); setLogin(null); setAccepted(false); }, [nodeId]);
  const call = (operation: string, extra: Json = {}) => act(async () => { const value = await api(operation, { ...args, ...extra }); setResult(value); await refresh(); });
  if (!state || !pack) return <section className="detail-page">读取固定 Run…</section>;
  const current = state.nodes[nodeId]; const definition = pack.workflow.nodes.find((n: Json) => n.id === nodeId); const attempt = current?.attempts.at(-1);
  return <div className="run-workspace"><div className="run-toolbar"><strong>{pack.workflow.name}</strong><Status value={state.status}/><span className="muted">{runId} · #{state.sequence}</span><button onClick={() => act(refresh)}>刷新</button>
    {token && <><button disabled={state.status !== 'running'} onClick={() => call('pause', { reason: '用户暂停' })}>暂停</button><button disabled={state.status !== 'paused'} onClick={() => call('resume')}>继续</button><button className="danger" disabled={['succeeded','cancelled'].includes(state.status)} onClick={() => call('cancel')}>取消 Run</button></>}
  </div>
  {!token && <div className="notice">此页面只读。主控制权保存在创建 Run 的控制者中；恢复时必须显式接管并使旧租约失效。<button onClick={() => act(async () => { const adopted = await api('adopt_run', { run_id: runId, expected_sequence: state.sequence, reason: '用户在本地控制台显式接管', main_actor: 'human-console' }); rememberRun(adopted); await refresh(); })}>接管并暂停 Run</button></div>}
  <div className="run-body"><Canvas workflow={pack.workflow} runtime={state.nodes} onChange={() => {}} onSelect={(kind,id) => { if (kind === 'node') setNodeId(id); }} readOnly/>
    <aside className="inspector scroll"><h2>{nodeId || '运行详情'}</h2>{!nodeId && <p>选择节点查看状态、产物、证据及可用操作。</p>}
      <Details title="输入、范围与固定版本" value={{ inputs: state.inputs, permissions: state.permissions, revision: pack.revision_hash, finalization: pack.workflow.finalization }}/>
      {next.parent_block && <Details title="父 Run 阻塞" value={next.parent_block}/>}
      {(next.pending_approvals ?? next.approvals ?? []).map((approval: Json) => <article className="review-item" key={approval.id}><Details title="待批准的节点与范围" value={approval}/>{token && <><button onClick={() => call('approve', { approval_id: approval.id, decision: true })}>批准此范围</button><button onClick={() => call('approve', { approval_id: approval.id, decision: false })}>拒绝</button></>}</article>)}
      {(next.integration_gates ?? []).map((gate: Json | string) => { const id = typeof gate === 'string' ? gate : gate.region_id; return <button disabled={!token} key={id} onClick={() => act(async () => { await api('prepare_integration', { ...control, region_id: id }); setMerge({ region_id: id, ...(await api('review_integration', { ...control, region_id: id })) }); await refresh(); })}>审查并行合并 · {id}</button>; })}
      {merge && <article className="review-item"><h3>精确合并提案</h3><pre>{typeof merge.patch === 'string' ? merge.patch : pretty(merge)}</pre><button disabled={!token} onClick={() => call('integrate_parallel', { region_id: merge.region_id, patch_sha256: merge.patch_sha256 ?? merge.proposal?.patch_sha256, accepted: true })}>接受并应用所示补丁</button></article>}
      {current && <><Status value={current.status}/><Details title="节点输出、证据和诊断" value={current}/>
        {token && current.status === 'ready' && <button className="primary" onClick={() => act(async () => { const value = await api('claim_node', { ...control, node_id: nodeId, owner: state.main_actor, request_id: uid('claim') }); leases.set(key, value); setResult(value); await refresh(); })}>领取节点</button>}
        {token && ['interrupted','failed'].includes(current.status) && <><JsonField label="重试 / 重连证据" value={reconciliation} onChange={setReconciliation}/><button onClick={() => call('retry_node', { node_id: nodeId, reconciliation })}>显式重试（消耗预算）</button>{current.status === 'interrupted' && <button onClick={() => act(async () => { const restored = await api('reattach_connector', { ...control, node_id: nodeId, attempt_id: attempt.id }); leases.set(key, restored.envelope); setResult(restored); await refresh(); })}>核对并重连同一远程任务</button>}</>}
        {lease && token && ['claimed','running'].includes(current.status) && <>
          {!attempt?.dispatch && <button className="primary" onClick={() => call('dispatch')}>执行固定节点</button>}
          {attempt?.dispatch && <>
            {pack.workflow.skill_policy.mode === 'strict' && definition.executor.kind !== 'subworkflow' && <><button onClick={() => call('strict_status')}>读取 Strict 会话状态</button><button onClick={() => act(async () => setLogin(await api('strict_login', args)))}>获取此会话的官方登录链接</button><label className="check"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)}/>我已审查并接受主节点提案</label><button onClick={() => call('collect_strict', { accepted })}>收集固定 Strict 结果</button></>}
            {definition.executor.kind === 'subworkflow' && <><button onClick={() => call('collect_subworkflow')}>收集子 Run 验收结果</button>{attempt.child_run_id && <button onClick={() => onRun(attempt.child_run_id)}>查看子 Run</button>}</>}
            {definition.executor.kind === 'provider' && pack.workflow.skill_policy.mode === 'cooperative' && <><button onClick={() => call('reconcile_connector')}>核对 Connector 身份</button><button onClick={() => call('collect_connector')}>收集 Connector 结果</button></>}
          </>}
          {pack.workflow.skill_policy.mode === 'cooperative' && <details><summary>Host / Human 执行结果交接</summary><p>填写真实工具返回的身份、产物及验证证据。此页面不会代替 Host 启动原生子 Agent。</p><JsonField label="真实派发回执" value={receipt} onChange={setReceipt}/><button onClick={() => call('dispatch_receipt', { receipt, request_id: attempt?.dispatch?.request_id })}>记录精确回执</button><JsonField label="完成记录（需真实证据）" value={completion} onChange={setCompletion} rows={14}/><label className="check"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)}/>主控制者接受最终结果</label><button onClick={() => call('complete_node', { completion: { ...completion, ...(definition.role === 'finalizer' ? { acceptance: { accepted } } : {}) } })}>提交完成记录</button></details>}
        </>}
      </>}
      {login && <Details title="此会话登录信息" value={login}/>}
      {login && Object.entries(login).filter(([key,value]) => /url/i.test(key) && typeof value === 'string' && /^https?:\/\//.test(value)).map(([key,value]) => <a key={key} href={String(value)} target="_blank" rel="noreferrer">打开官方登录页面</a>)}
      {result && <Details title="最近一次操作结果" value={result}/>}
      {token && ['succeeded','failed','cancelled'].includes(state.status) && <button onClick={() => call('cleanup_parallel')}>清理已验收且未变化的工作树</button>}
      {state.status === 'succeeded' && pack.provenance?.kind === 'skill_expansion_job' && token && <button onClick={() => call('apply_expansion_result', { workflow_id: pack.provenance.source_workflow_id, expected_revision: pack.provenance.source_revision })}>将验收后的规划应用到源 Draft</button>}
      <Details title="运行事件（后端日志）" value={events}/>
    </aside></div></div>;
}
