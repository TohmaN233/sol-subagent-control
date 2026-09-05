import { useEffect, useState } from 'react';
import { api, Field, Details, ProviderField, type Json } from './shared';
type Action = (work: () => Promise<any>) => void;
export function PackPanels({ pack, tab, saved, act, providers, openRun, workspace, setWorkspace }: { pack: Json, tab: string, saved: (p: Json) => Promise<void>, act: Action, providers: Json[], openRun: (r: Json) => void, workspace: string, setWorkspace: (value: string) => void }) {
  const [history, setHistory] = useState<Json[]>([]); const [review, setReview] = useState<Json | null>(null); const [resource, setResource] = useState<Json | null>(null);
  const [path, setPath] = useState(''); const [text, setText] = useState(''); const [note, setNote] = useState(''); const [provider, setProvider] = useState('');
  const [sources, setSources] = useState<Json | null>(null);
  useEffect(() => { setSources(null); }, [pack.revision_hash]);
  const ref = { workflow_id: pack.workflow.id, revision_hash: pack.revision_hash }; const cas = { workflow_id: pack.workflow.id, expected_revision: pack.revision_hash };
  useEffect(() => { setResource(null); setText(''); setPath(''); if (tab === 'history') act(async () => setHistory(await api('revisions', ref))); if (tab === 'review' && pack.workflow.import_status) act(async () => setReview(await api('import_review', ref))); }, [tab, pack.revision_hash]);
  return <section className="detail-page scroll">
    {tab === 'review' && <><h2>Skill 来源更新</h2><p>比较固定来源的 SKILL.md 哈希。更新提示不会修改本流程或历史 Run；需要新内容时明确重新导入或编辑 SkillRef。</p><button onClick={() => act(async () => setSources(await api('source_status', ref)))}>检查来源更新</button>{sources?.entries.map((entry: Json, index: number) => <article className="review-item" key={index}><strong>{entry.status === 'update_available' ? '有更新 · update available' : entry.status === 'unchanged' ? '来源未变化' : '来源不可用'}</strong><Details title={entry.node_id ?? '导入来源'} value={entry}/></article>)}{sources && !sources.entries.length && <p>此版本没有 Skill 来源引用。</p>}</>}
    {tab === 'resources' && <><h2>Pack 资源</h2><p className="muted">每次编辑都会创建 Draft。原始 Skill 文件保持原样；历史 Run 使用各自固定的字节。</p><div className="resource-layout"><div>{pack.resources.map((r: Json) => <button className="resource-item" key={r.path} onClick={() => act(async () => { const result = await api('read_resource', { ...ref, resource_path: r.path }); setResource(result); setPath(r.path); setText(result.encoding === 'utf8' ? result.content : ''); })}>{r.path}<small>{r.bytes} bytes</small></button>)}<button onClick={() => { setResource(null); setPath('instructions/new.md'); setText(''); }}>＋ 新建文本资源</button></div><div>
      <Field label="相对资源路径" value={path} onChange={setPath}/>
      {resource && <Details title="资源哈希与编码" value={{ ...resource, content: undefined }}/>}
      {resource && !resource.editable ? <p>此资源为二进制或超过文本编辑上限，可通过 Pack 导出保留原始内容。</p> : <><Field label="UTF-8 内容（≤ 1 MiB）" value={text} multiline onChange={setText}/><button disabled={!path} onClick={() => act(async () => saved(await api('write_resource', { ...cas, resource_path: path, text })))}>保存资源为 Draft</button></>}
      {resource && <button className="danger" onClick={() => act(async () => saved(await api('write_resource', { ...cas, resource_path: path, remove: true })))}>从新版本移除资源</button>}
    </div></div></>}
    {tab === 'history' && <><h2>不可变版本</h2><p>恢复会产生新版本，正在运行的任务继续使用其原始版本。</p>{history.map(item => <div className="history-row" key={item.revision_hash}><strong>r{item.revision} · {item.status}</strong><code>{item.revision_hash}</code><button onClick={() => act(async () => saved(await api('restore_revision', { ...cas, revision_hash: item.revision_hash })))}>恢复为新版本</button></div>)}<Details title="当前版本来源" value={pack.provenance}/></>}
    {tab === 'review' && <><h2>导入与推断审查</h2>{!pack.workflow.import_status ? <p>此 Workflow 没有导入审查事项。</p> : <>
      <Details title="完整导入报告" value={pack.import_report}/><Details title="来源独立性及外部要求" value={{ status: pack.workflow.import_status, requirements: pack.workflow.requirements }}/>
      <Field label="本次审查依据（对所选事项填写具体依据）" value={note} multiline onChange={setNote}/>
      {review?.issues.map((issue: Json) => <article className="review-item" key={issue.id}><strong>{issue.code}</strong><pre>{JSON.stringify(issue, null, 2)}</pre>{issue.code !== 'AI_INFERENCES_REQUIRE_REVIEW' && <button disabled={!note.trim()} onClick={() => act(async () => saved(await api('review_import', { ...cas, decisions: [{ issue_id: issue.id, resolution: 'resolved', note }] })))}>确认此项已处理</button>}</article>)}
      {review?.inferences.filter((item: Json) => !item.origin.reviewed).map((item: Json) => <article className="review-item" key={item.kind + item.id}><strong>{item.kind} / {item.id}</strong><Details title="推断依据" value={item.origin}/><button disabled={!note.trim()} onClick={() => act(async () => saved(await api('review_import', { ...cas, inferences: [{ kind: item.kind, id: item.id, note }] })))}>确认此项推断</button></article>)}
      <button onClick={() => act(async () => { const result = await api('verify_relocation', ref); setReview(current => ({ ...current, relocation: result })); })}>检查固定资源的迁移完整性</button>{review?.relocation && <Details title="检查结果（不等同功能执行证明）" value={review.relocation}/>}
      <h3>AI 展开为可编辑流程</h3><p>使用选定 Provider 建立只读 Strict 规划 Run；主控制者验收后，才可应用到此版本的 Draft。</p><Field label="规划 Run 的工作区绝对路径" value={workspace} onChange={setWorkspace}/><ProviderField providers={providers} value={provider} onChange={setProvider} main={false}/><button disabled={!provider || !workspace} onClick={() => act(async () => openRun(await api('create_expansion_run', { ...ref, provider_id: provider, run_id: 'expansion-' + crypto.randomUUID(), workspace, main_actor: 'human-console' })))}>建立 AI 规划 Run</button>
    </>}</>}
  </section>;
}
