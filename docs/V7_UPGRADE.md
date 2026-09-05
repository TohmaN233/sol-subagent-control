# v0.8.0 / v7 Workflow upgrade

The plugin version is0.8.0, control-plane server/package0.5.0. Workflow IR and Run
schema are version1; user configuration becomes version7 through explicit migration.
Release gates and actual evidence are recorded in V7_RELEASE_EVIDENCE.md.

## Upgrade and first use

Install the reviewed plugin revision using the existing marketplace workflow, then
start a fresh Codex task so its new tools and skill instructions are loaded. Open
the Sol console through `sol_control_console` or the existing one-click scripts.
The default landing page is now `/workflows`; Provider settings remain at `/`.
Node20+ is required at runtime. The committed web assets require no npm install.

The bundled v6 file is deliberately retained as the migration seed and legacy
compatibility fixture. New installations and existing v6 users first see an explicit
“备份并迁移到 v7” action. It creates a v6 backup, stages all Workflow Packs and commits
one generation pointer. Repeating migration is safe. It preserves exact Provider
bindings, disabled entries, templates, optional approvals and per-Run write scopes.
No real user configuration is migrated by installing the plugin or running its tests.

After migration use `$sol-advisor:sol-control-plane` and the `workflow_*` tools.
The native-only orchestration skill remains available. The old Task Type resolve
API rejects v7 instead of executing a second mutable definition.

## 编辑与执行

1. 在流程库新建 Workflow，拖入节点或连接已有节点。点击节点配置固定 Provider、
   主 Agent、权限、路径范围、输入输出、条件、并行和子流程。复杂字段可在完整 IR 编辑。
2. 保存为 Draft，再校验、审查精确版本并发布 Ready。资源编辑也生成新 Draft；
   版本恢复产生新版本，旧版本和旧 Run 使用各自固定的字节。
3. 启动时填写绝对工作区、输入和本次最大访问范围。路径是文件或目录边界，不能使用 glob。
   Ready 表示结构有效；缺失能力、禁用 Provider、审批或执行器资格仍会阻止启动。
4. 运行视图展示真实日志状态。领取和派发就绪节点，查看审批、Provider、有效范围、
   输出和证据。Strict 实时输出是最多32K字符的临时预览，最终结果以持久化产物为准。
5. 并行写必须使用后端建立的独立 Git worktree。Join 后审阅精确补丁，再由主控制者接受。
   每条成功路径都经过 Main 最终验收，worker 的完成不会替代该决定。

Skill 导入从实际 Codex 清单选择，完整资源复制到独立 Draft。脚本、外部服务和推断疑点
必须保留为可见要求。AI 展开使用明确选定的原生 Provider，创建只读规划 Run；主控制者
验收规划结果后可应用，产生的节点和边仍需要逐项人工审查。静态迁移检查只能证明固定
资源完整，不能证明任意 Skill 可独立执行。

SkillRef 固定路径、名称、SKILL.md 哈希和明确允许的嵌套 Skill。导入审查中的“检查来源更新”
会展示 `update available` 或读取错误，不自动改写 Workflow。新内容须重新导入或编辑引用。
源文件消失不影响已经完整固定的旧 Run。来源更新检查针对 SKILL.md 字节，不承诺监控所有
外部文件；完整资源快照在 Run 启动时校验和固定。

## Execution boundaries

Strict is off by default. Its initial qualification permits only Windows x64,
Codex0.145.0, SHA-256:

`83751f15cb6a0a7b97df67752c001e3fe1c20e18ffbfec3ff63567296205eb6c`

Configure the exact executable/hash and authentication mode in “执行能力”. Managed
ChatGPT login uses the official flow in each owned temporary profile; it does not
copy shared auth files. API authentication stores only an environment-variable name.
Linux/macOS and other binary hashes reject Strict. Core Workflow/Cooperative support
and console tests are separate from Strict qualification.

The guarantee covers the verified Skill catalog, explicit Skill input, fresh thread
and controlled resource/workspace broker. It is not an OS ACL or arbitrary-shell
sandbox. Unsupported tools/scripts/admin roots fail closed. Non-native Providers
remain opt-in; there is no implicit fallback or Strict-to-Cooperative downgrade.

## Recovery and rollback

Pause stops new release and dispatch; active results remain recordable. Cancel fences
the known Run tree, then stops owned executors and supported exact connector tasks.
Unconfirmed remote stops remain visible. Browser controller tokens live in memory;
reopening a Run is read-only until explicit human adoption rotates authority and
pauses its tree. Reattach the original claim/connector/child or durable closed Strict
result, then resume. Reattachment consumes no new attempt; explicit retry does.
See [the recovery contract](V7_RECOVERY_CONTRACT.md) for exact evidence requirements.

Before rollback, stop active Runs and confirm executor shutdown. Preserve the complete
configuration directory, migration journal, generation stores and Run directories.
The human-owned `restore_v6` API takes the SHA-256 of the currently observed config,
restores `control-plane.v6.backup.json` transactionally and retains Workflow stores.
It refuses a changed current config. Rolling back does not translate v7 Run history
into legacy tasks. Do not overwrite config while executors remain active or delete
an uncertain Git-operation marker to make cleanup proceed.

Maintainer checks: `node plugins/sol-advisor/control-plane/test/run-tests.mjs`,
`npm ci --ignore-scripts` then `npm run check:web` inside the control-plane package,
both repository verify scripts, and the Windows/Linux/macOS CI matrix. Actual Codex
probes under `spikes/strict-executor` use disposable profiles and record their tested
binary/source hashes; rerun relevant qualification after changing that boundary.
