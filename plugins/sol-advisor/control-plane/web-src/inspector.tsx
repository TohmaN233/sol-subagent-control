import { Field, JsonField, ProviderField, Select, Details, type Json } from './shared';
export function Inspector({ workflow, selection, providers, change, select, inline }: { workflow: Json, selection: { kind: string, id: string }, providers: Json[], change: (w: Json) => void, select: (kind: string, id: string) => void, inline: () => void }) {
  const node = workflow.nodes.find((item: Json) => item.id === selection.id); const edge = workflow.edges.find((item: Json) => item.id === selection.id);
  const patch = (fields: Json) => change({ ...workflow, nodes: workflow.nodes.map((item: Json) => item.id === node.id ? { ...item, ...fields } : item) });
  const edgePatch = (fields: Json) => change({ ...workflow, edges: workflow.edges.map((item: Json) => item.id === edge.id ? { ...item, ...fields } : item) });
  return <aside className="inspector scroll"><div className="panel-heading"><h2>{selection.kind === 'node' && node ? '节点属性' : selection.kind === 'edge' && edge ? '连接属性' : 'Workflow 属性'}</h2><button onClick={() => select('workflow', '')}>全局</button></div>
    {selection.kind === 'node' && node ? <>
      <div className="muted">{node.id} · {node.type}</div>
      <Field label="名称" value={node.name ?? node.id} onChange={name => patch({ name })}/>
      {['agent','skill_ref'].includes(node.type) && <><ProviderField providers={providers} value={node.executor?.kind === 'main' ? '$main' : node.executor?.provider_id ?? ''} onChange={id => patch({ executor: id === '$main' ? { kind: 'main' } : { kind: 'provider', provider_id: id } })}/><Field label="角色" value={node.role} onChange={role => patch({ role })}/></>}
      {node.type === 'agent' && <Field label="任务指令 / 模板" value={node.prompt_template} multiline onChange={prompt_template => patch({ prompt_template })}/>}
      {node.executor && <>
        <Select label="访问权限" value={typeof node.access === 'string' ? node.access : '$run'} options={['read_only', 'bounded_write', ...(['main','subworkflow'].includes(node.executor.kind) ? [{ value: '$run', label: '继承 Run 权限' }] : [])]} onChange={access => patch({ access: access === '$run' ? { binding: 'run.access' } : access })}/>
        <JsonField label="写入路径范围（非 glob；或 Run 绑定）" value={node.path_scope ?? []} onChange={path_scope => patch({ path_scope })}/>
        <label className="check"><input type="checkbox" checked={!!node.approval?.required} onChange={e => patch({ approval: { ...node.approval, required: e.target.checked } })}/>执行前需批准</label>
        <Field label="最大尝试次数（1–10）" value={node.retry?.max_attempts} onChange={value => patch({ retry: { ...node.retry, max_attempts: Number(value) } })}/>
        <JsonField label="输入绑定（上游 JSON Pointer）" value={node.input_bindings ?? {}} onChange={input_bindings => patch({ input_bindings })}/>
        <JsonField label="输出 Schema" value={node.outputs_schema ?? {}} onChange={outputs_schema => patch({ outputs_schema })}/>
        <JsonField label="资源路径" value={node.resources ?? []} onChange={resources => patch({ resources })}/>
        <details><summary>节点 Skill 策略（只可收紧）</summary><JsonField label="留空对象表示继承" value={node.skill_policy ?? {}} onChange={value => { const next = { ...node }; if (!Object.keys(value).length) delete next.skill_policy; else next.skill_policy = value; change({ ...workflow, nodes: workflow.nodes.map((n: Json) => n.id === node.id ? next : n) }); }}/></details>
      </>}
      {node.type === 'condition' && <><JsonField label="按顺序匹配的条件 DSL" value={node.cases} onChange={cases => patch({ cases })}/><Field label="默认连接标签" value={node.default_label} onChange={default_label => patch({ default_label })}/></>}
      {node.type === 'parallel' && <><Select label="汇合节点" value={node.join_id} options={workflow.nodes.filter((n: Json) => n.type === 'join').map((n: Json) => n.id)} onChange={join_id => patch({ join_id })}/><Select label="分支失败策略" value={node.failure_policy} options={['collect','fail_fast']} onChange={failure_policy => patch({ failure_policy })}/></>}
      {node.type === 'join' && <Select label="对应并行节点" value={node.parallel_id} options={workflow.nodes.filter((n: Json) => n.type === 'parallel').map((n: Json) => n.id)} onChange={parallel_id => patch({ parallel_id })}/>}
      {node.type === 'skill_ref' && <><JsonField label="SkillRef（精确路径、名称、哈希、嵌套 pin）" value={node.skill_ref} onChange={skill_ref => patch({ skill_ref })}/><button onClick={inline}>将已保存的 SkillRef 转为 Inline Draft</button></>}
      {node.type === 'subworkflow' && <JsonField label="子 Workflow / revision_pin / output_bindings" value={node.subworkflow} onChange={subworkflow => patch({ subworkflow })}/>}
      {node.type === 'tool' && <Field label="确切 Host Tool 名称" value={node.executor.tool} onChange={tool => patch({ executor: { ...node.executor, tool } })}/>}
      {node.origin && <Details title="来源与审查记录" value={node.origin}/>}
      <button className="danger" onClick={() => { change({ ...workflow, nodes: workflow.nodes.filter((n: Json) => n.id !== node.id), edges: workflow.edges.filter((e: Json) => e.source !== node.id && e.target !== node.id) }); select('workflow', ''); }}>删除节点及相关连接</button>
    </> : selection.kind === 'edge' && edge ? <>
      <div className="muted">{edge.id}</div>
      <Select label="起点" value={edge.source} options={workflow.nodes.map((n: Json) => n.id)} onChange={source => edgePatch({ source })}/>
      <Select label="终点" value={edge.target} options={workflow.nodes.map((n: Json) => n.id)} onChange={target => edgePatch({ target })}/>
      <Field label="条件 / 分支标签" value={edge.label} onChange={label => edgePatch({ label })}/>
      <Select label="前置节点结果" value={edge.on ?? 'success'} options={['success','failure','always']} onChange={on => edgePatch({ on })}/>
      {edge.origin && <Details title="来源" value={edge.origin}/>}
      <button className="danger" onClick={() => { change({ ...workflow, edges: workflow.edges.filter((e: Json) => e.id !== edge.id) }); select('workflow',''); }}>删除连接</button>
    </> : <>
      <Field label="名称" value={workflow.name} onChange={name => change({ ...workflow, name })}/>
      <Field label="说明" value={workflow.description} multiline onChange={description => change({ ...workflow, description })}/>
      <label className="check"><input type="checkbox" checked={workflow.enabled} onChange={e => change({ ...workflow, enabled: e.target.checked })}/>允许启动此 Workflow</label>
      <Select label="隔离模式" value={workflow.skill_policy.mode} options={['strict','cooperative']} onChange={mode => change({ ...workflow, skill_policy: { ...workflow.skill_policy, mode } })}/>
      <JsonField label="完整 Skill 策略" value={workflow.skill_policy} onChange={skill_policy => change({ ...workflow, skill_policy })}/>
      <Select label="Main 最终验收节点" value={workflow.finalization.node_id} options={workflow.nodes.filter((n: Json) => n.executor?.kind === 'main').map((n: Json) => n.id)} onChange={node_id => change({ ...workflow, finalization: { required: true, node_id } })}/>
      <JsonField label="输入 Schema" value={workflow.inputs_schema} onChange={inputs_schema => change({ ...workflow, inputs_schema })}/>
      <JsonField label="输出 Schema" value={workflow.outputs_schema} onChange={outputs_schema => change({ ...workflow, outputs_schema })}/>
      <JsonField label="外部依赖要求" value={workflow.requirements} onChange={requirements => change({ ...workflow, requirements })}/>
      <JsonField label="标签" value={workflow.tags ?? []} onChange={tags => change({ ...workflow, tags })}/>
    </>}
  </aside>;
}
