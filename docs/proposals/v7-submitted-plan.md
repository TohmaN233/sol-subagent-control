# `sol-subagent-control` v7 视觉工作流升级执行计划

下面这份计划可以直接作为 Codex 的总实施路线。**执行顺序不应跳跃**：先证明 Skill 隔离，再改变数据模型；先完成无界面的运行内核，再接流程图编辑器。

当前仓库的控制模型是 `Task Type → 固定 Stage → Provider`，并且配置验证只允许空流程、单 implementation、单 review、implementation→review 四种形状。 现有 Provider 能力验证、批准门、读写能力和 connector 调用边界应继续保留，不能被新工作流运行时绕开。

---

## 一、最终产品定义

升级后的项目定义为：

> **Codex-native Visual Agent Workflow Control Plane**

它应允许用户：

1. 创建和编辑可视化 Workflow Preset。
2. 把现有 Skill 一次性导入为独立 Workflow Draft。
3. 将流程中的每一步绑定到：

   * 主 Agent；
   * Codex native subagent；
   * Cursor、Grok、ChatGPT Web、OpenAI-compatible 等 Provider；
   * 显式 SkillRef；
   * 另一个 SubWorkflow；
   * MCP Tool；
   * Human Gate。
4. 创建顺序、条件、并行、汇合和审阅流程。
5. 在严格模式下屏蔽没有出现在 Workflow 中的背景 Skill。
6. 查看每个节点的执行状态、输出、Agent 身份、写入范围、验证结果和审计记录。
7. 暂停、继续、取消或恢复 Workflow Run。

---

# 二、先冻结的架构不变量

这些规则必须先写入 ADR，并作为后续所有代码审查的硬约束。

## 1. Workflow 是一级运行对象

Workflow 不是 Skill 的可视化副本，也不是另一层 prompt。

```text
Skill Source
    ↓ 一次性导入
Workflow Draft
    ↓ 用户编辑与确认
Workflow Preset
    ↓
Workflow Run
```

从保存为 Workflow Preset 开始，Workflow 成为唯一流程真相。

---

## 2. Skill 导入是单向的

默认关系必须是：

```text
Skill ─────→ Workflow
```

不能默认存在：

```text
Skill ←────→ Workflow
```

因此：

* 不把画布修改写回原 `SKILL.md`；
* 不实时跟踪并自动合并原 Skill；
* 不在执行 Workflow 时重新读取原 Skill；
* 不偷偷把原 Skill 改成 Workflow alias。

---

## 3. 导入后的 Workflow 默认可以脱离原 Skill

Importer 必须处理 Skill 附带的：

* `SKILL.md`；
* `scripts/`；
* `references/`；
* `assets/`；
* `agents/openai.yaml`；
* 工具和 MCP 依赖。

可以复制的资源进入 Workflow Pack；不能复制的外部能力变成显式 requirement。

导入成功后，对可自包含的 Skill，应满足：

```text
原 Skill 被禁用或删除
        ↓
Workflow 仍可运行
```

---

## 4. 原 Skill 保持不变

导入不能：

* 修改原 Skill；
* 删除原 Skill；
* 全局禁用原 Skill；
* 重命名原 Skill；
* 修改其 `allow_implicit_invocation`；
* 改写用户的真实 Codex 配置。

原 Skill 平时仍可正常使用。

---

## 5. Workflow Run 默认拒绝隐式 Skill

Codex 会先看到可用 Skill 的名称、描述和路径，并可根据描述隐式选择 Skill；选择后才加载完整 `SKILL.md`。因此背景 Skill 与导入后的 Workflow 发生冲突，不是理论问题，而是真实运行边界。([OpenAI Developers][1])

默认策略固定为：

```yaml
skill_policy:
  implicit: deny
  ambient_allow: []
  shadow_imported_sources: true
```

只有以下 Skill 可以参与：

* 图中明确出现的 `SkillRef`；
* Workflow 显式声明的 ambient allowlist；
* 用户在当前 Run 中明确批准的临时 Skill。

---

## 6. 必须区分“协作式隔离”和“严格隔离”

### Cooperative isolation

当前 Codex 主线程继续作为主 Agent：

* Runtime 发出明确的 Workflow Contract；
* 主 Agent承诺不调用未授权 Skill；
* 不主动传入任何 Skill；
* 但不能声称从模型上下文中物理移除了所有 Skill。

UI 必须显示：

```text
Skill isolation: Cooperative
Background Skill visibility is not fully controlled.
```

### Strict isolation

由 Workflow Runtime 启动新的 Codex App Server 或 SDK 线程：

* 使用临时、隔离的 `CODEX_HOME`；
* 枚举所有可见 Skill；
* 在临时配置中禁用所有未授权 Skill；
* 只把显式 SkillRef 作为 Skill input 传入；
* Run 完成后销毁临时运行配置。

App Server 当前提供 `skills/list`、显式 Skill input 以及按路径启用或禁用 Skill 的接口。([OpenAI Developers][2]) 它也提供线程、审批和流式事件，因此适合后续的严格模式和可视化运行面板。([OpenAI Developers][2])

**从 Skill 导入的 Workflow 默认要求 Strict isolation。**

---

## 7. 禁止用用户全局配置实现 Run 级屏蔽

不得在一次 Workflow Run 开始时修改用户真实的：

```text
~/.codex/config.toml
```

然后在结束后再恢复。

这种做法存在：

* 并发 Run 相互覆盖；
* 崩溃后无法恢复；
* 已启动线程仍持有旧 Skill 列表；
* 用户自己的配置被短暂污染；
* 跨项目副作用。

按路径启停 Skill 是持久配置能力，不适合作为共享配置上的 Run 级锁。([OpenAI Developers][3])

---

## 8. Workflow Runtime 掌握控制流

主 Agent不能自行决定跳过节点、额外调用 Skill 或改变 Provider。

必须采用：

```text
workflow_next
    ↓
Runtime 返回唯一或一组 READY 节点
    ↓
执行节点
    ↓
workflow_complete_node
    ↓
Runtime 解锁后继节点
```

Graph 是权威，Agent 是执行者。

---

## 9. 每个 Run 只有一个主 Agent 权威

可以并行启动多个高能力 Agent，但它们在并行区内仍然是 worker。

不允许：

```text
Main Agent A  ─┐
               ├─ 同时拥有最终架构权威
Main Agent B  ─┘
```

允许：

```text
                     ┌─ Terra worker
Main Agent → Parallel├─ Sol worker
                     └─ Grok worker
                            ↓
                          Join
                            ↓
                       Main Agent
                            ↓
                    Final acceptance
```

---

## 10. `agent_group` 不是底层节点类型

UI 可以提供“并行 Agent 组”快捷模板，但保存时应展开成：

```text
Parallel
├─ Agent
├─ Agent
└─ Agent
    ↓
Join
```

这样避免 `agent_group` 和普通 Graph 两套执行语义。

---

## 11. Workflow 必须区分 Draft 与 Ready

```text
draft
```

允许：

* 未解决依赖；
* 推断出来的边；
* 暂未绑定的 Provider；
* 粗粒度 instruction node；
* 用户尚未确认的 Skill 导入结果。

```text
ready
```

必须满足全部执行验证。

只有 `ready` Workflow 可以直接 Run。

---

## 12. 不允许任意表达式执行

Condition、input mapping、output mapping 不得使用：

* JavaScript `eval`；
* Python `eval`；
* 任意 shell expression；
* 动态代码字符串。

首版采用有限 DSL 和 JSON Pointer。

---

# 三、目标存储结构

不要把完整 Workflow Graph 和导入资源继续塞进当前单个 `control-plane.json`。

建议改成：

```text
$CODEX_HOME/sol-advisor/
├── control-plane.json
├── workflows/
│   └── <workflow-id>/
│       ├── workflow.json
│       ├── provenance.json
│       ├── import-report.json
│       ├── resources/
│       │   ├── scripts/
│       │   ├── references/
│       │   └── assets/
│       └── revisions/
│           └── <revision-hash>.json
├── runs/
│   └── <run-id>/
│       ├── run.json
│       ├── events.jsonl
│       ├── outputs/
│       └── artifacts/
└── runtime-profiles/
    └── <run-id>/
        └── <node-id>/
            └── 临时 CODEX_HOME
```

其中：

* `control-plane.json`：只存 global、Provider 和 store 配置；
* `workflow.json`：Workflow source of truth；
* `provenance.json`：Skill 来源与 hash；
* `import-report.json`：推断和未解决问题；
* `runs/`：可恢复的运行记录；
* `runtime-profiles/`：严格隔离临时环境，正常结束后删除。

---

# 四、Workflow IR v1

第一版 Workflow schema 建议如下。

```json
{
  "schema_version": 1,
  "id": "translation-review",
  "name": "Translation with review",
  "status": "draft",
  "revision": 1,
  "description": "",
  "tags": [],
  "inputs_schema": {},
  "outputs_schema": {},
  "skill_policy": {
    "mode": "strict",
    "implicit": "deny",
    "ambient_allow": [],
    "shadowed_skill_paths": []
  },
  "requirements": {
    "providers": [],
    "tools": [],
    "mcp_servers": [],
    "executables": []
  },
  "finalization": {
    "required": true,
    "node_id": "final-acceptance"
  },
  "nodes": [],
  "edges": []
}
```

## 节点公共字段

```json
{
  "id": "implementation",
  "type": "agent",
  "label": "Implementation",
  "executor": {
    "kind": "provider",
    "provider_id": "native-terra"
  },
  "role": "implementer",
  "access": "bounded_write",
  "path_scope": ["src/**", "test/**"],
  "prompt_template": "...",
  "input_bindings": {},
  "output_schema": {},
  "approval": {
    "required": false
  },
  "retry": {
    "max_attempts": 1
  }
}
```

## v7.0 支持的节点类型

```text
start
end
agent
condition
parallel
join
skill_ref
subworkflow
tool
human_gate
```

`review` 不需要独立底层类型；它是：

```text
agent
role = reviewer
access = read_only
```

## v7.0 暂不支持

```text
无界循环
任意图环
任意 shell script node
动态生成新的节点
运行时修改 Workflow 定义
```

Loop 放到 v7.1，在核心 DAG 运行时稳定后再做。

---

# 五、严格执行顺序

---

## M0：建立冻结基线和 ADR

### 目标

在修改代码之前，把所有基本路线变成仓库内正式决策。

### 新增文件

```text
docs/V7_VISUAL_WORKFLOW_EXECUTION_PLAN.md

docs/adr/
├── 0002-workflow-is-first-class-runtime.md
├── 0003-skill-import-is-one-way.md
├── 0004-run-scoped-skill-isolation.md
├── 0005-workflow-pack-storage.md
├── 0006-single-main-agent-authority.md
└── 0007-parallel-write-isolation.md
```

### 同时记录

* 当前 main commit；
* 当前完整测试结果；
* 当前配置版本 6；
* 当前 package version；
* 当前内置 Task Type；
* 当前 Provider；
* 当前控制台截图；
* 当前配置样例。

### 通过标准

* 不改变任何运行行为；
* ADR 之间无矛盾；
* 明确列出 MVP 和 future；
* 明确写入 cooperative 不等于 strict；
* 后续 PR 不得绕过这些不变量。

---

## M1：Skill 隔离可行性探针——首个阻塞门

### 目标

在大改数据模型之前，证明“背景 Skill 不干扰 Workflow”到底可以做到什么程度。

### 新增目录

```text
spikes/skill-isolation/
├── README.md
├── fixtures/
│   ├── conflicting-skill-a/
│   ├── conflicting-skill-b/
│   └── allowed-skill/
├── run-app-server-probe.mjs
├── create-temp-profile.mjs
└── assertions.mjs
```

### 测试 Skill

`conflicting-skill-a` 包含明显哨兵指令：

```text
Whenever relevant, output SHADOWED_SKILL_A.
```

Workflow 则明确要求输出另一个结果。

### 必测场景

| 场景                            | 预期                      |
| ----------------------------- | ----------------------- |
| 普通 Codex 隐式匹配                 | 确认 Skill 可能被选中          |
| 当前线程 + Workflow Contract      | 只定义为 cooperative，不宣称硬隔离 |
| 临时 CODEX_HOME + 禁用所有非允许 Skill | 冲突 Skill 不可调用           |
| 临时环境 + 显式 SkillRef            | 只允许目标 Skill             |
| 两个并行 Run、不同 allowlist         | 两者互不污染                  |
| Run 中途崩溃                      | 用户真实配置不变                |
| Run 完成                        | 临时配置被清理                 |

Codex 会从 repo、user、admin 和 system 等多个位置发现 Skill，并允许同名 Skill 同时存在，所以探针必须覆盖多个 scope，而不能只测试 `~/.codex`。([OpenAI Developers][1])

### 禁止做法

* 直接改用户真实 config；
* 删除真实 Skill；
* 只靠 prompt 然后声称 hard isolation；
* 把 Skill 名称不同误认为没有冲突；
* 只测试显式 `$skill`，不测试 implicit invocation。

### 通过标准

至少证明：

1. 临时配置可以按路径禁用所有发现的非允许 Skill；
2. 显式允许的 Skill 仍可正常执行；
3. 两个 Run 的 Skill policy 不串线；
4. 用户配置没有字节变化；
5. 无法禁用的系统 Skill 被明确记录。

### Stop 条件

若无法对 repo/user/admin Skill 建立可靠 Run 级隔离：

* 不得宣称 Strict；
* Skill 导入功能只能停留在 Draft/编辑阶段；
* 运行时必须显示 Cooperative；
* 后续计划需要改为完整独立 workspace/profile 方案。

---

## M2：建立 Workflow Pack Store

### 目标

先建立独立工作流存储，不急着运行 Graph。

### 新增文件

```text
plugins/sol-advisor/control-plane/lib/
├── workflow-store.mjs
├── workflow-paths.mjs
├── workflow-schema.mjs
├── workflow-validator.mjs
└── workflow-revisions.mjs
```

### 必须实现

* 创建 Workflow Pack；
* 读取；
* 列表；
* 复制；
* 重命名；
* 删除；
* 保存新 revision；
* 原子写入；
* symlink 拒绝；
* 路径穿越拒绝；
* ID 验证；
* 资源大小限制；
* revision hash；
* no-clobber 语义。

### 写入方式

```text
workflow.json.tmp-<uuid>
        ↓ fsync/close
atomic rename
        ↓
workflow.json
```

整个 pack 创建则使用临时目录后原子 rename。

### 通过标准

* 并发创建同 ID 只能有一个成功；
* 损坏 JSON fail-closed；
* symlink pack 被拒绝；
* 保存失败不破坏上一版；
* revision 能恢复；
* 扫描 workflow root 不依赖易损的单独 index。

---

## M3：实现 Workflow IR 与 Graph Validator

### 目标

只完成“定义与验证”，暂不真实调用 Agent。

### Validator 必须检查

1. 恰好一个 `start`；
2. 至少一个 `end`；
3. Node ID 唯一；
4. Edge ID 唯一；
5. Edge 两端存在；
6. 所有节点可从 start 到达；
7. 所有非终止节点可到达 end；
8. v7.0 禁止 cycle；
9. Condition 的出口标签不重复；
10. Parallel 必须有对应 Join；
11. Join 不允许引用无关分支；
12. Provider 存在并启用；
13. Provider 能力与 node access 匹配；
14. bounded write 有 path scope；
15. finalization node 存在；
16. finalization node 必须由 main agent 执行；
17. SkillRef 和 SubWorkflow 引用存在；
18. SubWorkflow 不能形成递归环；
19. output binding 引用存在；
20. Condition 只能使用允许的 DSL。

### Condition DSL

只支持有限操作：

```text
eq
ne
exists
contains
in
gt
gte
lt
lte
and
or
not
```

### 通过标准

* 针对每条验证规则都有正反测试；
* Validator 不修改输入；
* 同一输入输出确定；
* 错误包含 workflow、node、edge 精确 ID；
* Draft 可保存；
* Ready 必须完整通过 executable validation。

---

## M4：v6 → v7 迁移和兼容层

### 目标

当前所有用户 Task Type 无损变成 Workflow。

### 迁移映射

#### Solo

```text
Start → Main Agent → End
```

若原 Task Type 真的是空 stages，则生成一个显式 Main Agent 节点，而不是空 Graph。

#### Delegate

```text
Start → 原 implementation Node → Final Acceptance → End
```

#### Audit

```text
Start → 原 review Node → Final Acceptance → End
```

#### Full

```text
Start
  ↓
原 implementation
  ↓
原 review
  ↓
Final Acceptance
  ↓
End
```

### 必须原样保留

* ID；
* name；
* description；
* enabled；
* tags；
* Provider binding；
* role；
* access；
* approval；
* prompt template；
  -当前 Provider 配置。

### 新增文件

```text
plugins/sol-advisor/control-plane/lib/
├── workflow-migration-v6.mjs
└── legacy-control-adapter.mjs
```

### 兼容 API

旧调用：

```text
task_type_id
stage_id
```

先继续支持，并映射到：

```text
workflow_id
node_id
```

但新 UI 不再创建旧 Task Type。

### 迁移安全

迁移前生成：

```text
control-plane.v6.backup.json
migration-v6-to-v7.jsonl
```

失败时：

* 不覆盖 v6；
* 不留下半成品 Workflow；
* 继续允许旧 runtime 只读启动；
* 明确报告哪个 Task Type 失败。

### 通过标准

* 所有内置 Task Type 迁移后语义一致；
* 自定义 Task Type 不丢模板；
* Provider 不被更换；
* approval 不被重置；
* migration 重跑幂等；
* v6 备份能恢复。

---

## M5：Workflow Scheduler 与 Run Store

### 目标

建立完全不依赖 UI 的确定性 Graph Runtime。

### 新增文件

```text
plugins/sol-advisor/control-plane/lib/
├── workflow-runtime.mjs
├── workflow-state.mjs
├── workflow-run-store.mjs
├── workflow-events.mjs
├── workflow-bindings.mjs
└── workflow-execution-envelope.mjs
```

### Node 状态

```text
pending
ready
claimed
running
succeeded
failed
blocked
skipped
cancelled
interrupted
```

### 核心操作

```text
workflow_start
workflow_get
workflow_next
workflow_claim_node
workflow_complete_node
workflow_fail_node
workflow_retry_node
workflow_cancel
workflow_resume
workflow_events
```

### 每次 claim 返回

```json
{
  "run_id": "...",
  "workflow_id": "...",
  "workflow_revision": "...",
  "node_id": "...",
  "attempt_id": "...",
  "lease_token": "...",
  "executor": {},
  "inputs": {},
  "constraints": {},
  "skill_policy": {},
  "effective_allowed_paths": []
}
```

### 完成节点必须提交

```json
{
  "lease_token": "...",
  "status": "succeeded",
  "summary": "...",
  "structured_output": {},
  "artifacts": [],
  "evidence": [],
  "changed_paths": [],
  "outside_paths": []
}
```

### 必须保证

* stale lease 不能完成节点；
* 重复 completion 幂等；
* ready set 顺序确定；
* Run 重启后可恢复；
* running 节点重启后进入 interrupted；
* 不自动假装成功；
* Node 失败按边策略传播；
* cancelled Run 不能重新释放节点；
* finalizer 前不能标记整个 Run 完成。

### 通过标准

使用 fake executors 完成：

* 顺序流程；
* condition；
* parallel + join；
* 节点失败；
* retry；
* cancel；
* crash/resume；
* stale completion；
* duplicate completion；
* finalization gate。

---

## M6：接入现有 Provider 和主 Agent

### 目标

让 Graph 使用当前已经存在的 Provider 层。

### 不重写的部分

继续复用：

* Provider registry；
* `buildProviderAdapter`；
* connector registry；
* OpenAI-compatible 调用；
* approval；
* capability validation；
* allowed paths；
* audit。

### 新增执行适配器

```text
plugins/sol-advisor/control-plane/lib/execution/
├── main-agent-executor.mjs
├── native-agent-executor.mjs
├── connector-executor.mjs
├── web-review-executor.mjs
└── openai-compatible-executor.mjs
```

### 执行规则

#### Main Agent Node

Cooperative 模式下：

```text
Runtime 返回 execution envelope
当前 Codex执行
当前 Codex提交 completion
```

#### Native Agent Node

返回固定 agent type、model、effort 和 sandbox，不允许主 Agent临时替换。

#### Connector Node

继续走现有 Cursor/Grok task identity 和 status API。

#### Direct API

继续限制为 advisory/read-only。

### 写权限计算

```text
effective_allowed_paths
=
Run 当前批准的 allowed_paths
∩
Workflow Node path_scope
∩
Provider capability
```

任何一层为空：

```text
fail closed
```

### 通过标准

* 被禁用 Provider 不能调用；
* read-only Provider 不能执行写节点；
* bounded-write 没有当前 Run 授权时失败；
* 不允许 silent fallback；
* Provider 返回的完成声明必须由 Runtime 再验证；
* v6 兼容调用产生相同 Provider 选择。

---

## M7：Strict Codex Runtime Adapter

### 目标

把 M1 探针升级成正式的 Run 级隔离执行器。

### 新增文件

```text
plugins/sol-advisor/control-plane/lib/execution/
├── codex-app-server-client.mjs
├── codex-profile-builder.mjs
├── codex-skill-policy.mjs
├── codex-event-adapter.mjs
└── codex-runtime-cleanup.mjs
```

### 首选集成

本地以 `stdio` 启动 App Server，不依赖实验性的远程 WebSocket。

App Server 能创建、恢复和 fork thread，并流式提供 turn/item 事件。([OpenAI Developers][2])

### 每个严格节点的步骤

1. 调用 `skills/list` 获取当前 workspace 可见 Skill；
2. 计算：

   * allow set；
   * shadow set；
   * deny set；
3. 创建临时 `CODEX_HOME`；
4. 写入临时 config：

   * 禁用所有 deny Skill path；
   * 只保留允许能力；
5. 启动新 App Server；
6. 创建 thread；
7. 设置 cwd、sandbox、approval；
8. 若是 SkillRef，把 Skill 作为显式 input item；
9. 执行 node；
10. 转换 streamed events；
11. 保存结果；
12. 终止子进程；
13. 删除临时 profile；
14. 只保留审计 hash。

### 必须记录

```text
discovered_skills
allowed_skills
shadowed_skills
disabled_skills
uncontrolled_system_skills
skill_input_items
profile_hash
Codex version
App Server schema version
```

### 通过标准

* 冲突 Skill 哨兵不会出现；
* 显式 SkillRef 能出现预期结果；
* 当前用户配置完全不变；
* 两个 Strict Run 互不影响；
* 子进程异常时 profile 能回收；
* 不支持的 Codex/App Server schema fail-closed；
* Strict 不可用时不能静默降为 Cooperative。

---

## M8：Skill Inventory 与安全导入

### 目标

实现：

```text
Skill → Workflow Draft
```

### 新增文件

```text
plugins/sol-advisor/control-plane/lib/skill-import/
├── inventory.mjs
├── skill-reader.mjs
├── static-parser.mjs
├── coarse-compiler.mjs
├── semantic-expander.mjs
├── workflow-compiler.mjs
├── resource-vendor.mjs
├── dependency-reader.mjs
├── provenance.mjs
└── import-validator.mjs
```

### 导入分成两个明确模式

#### A. Safe coarse import

不调用 LLM。

生成：

```text
Start
  ↓
Agent Instruction Node
  ↓
Final Acceptance
  ↓
End
```

完整 Skill instructions 被 snapshot 到 Workflow Pack。

优点：

* 任意 Skill 都能导入；
* 不虚构控制流；
* 无额外模型成本；
* 结果确定。

#### B. AI-expand draft

在 coarse import 基础上，由用户指定的只读 Provider 分解为：

* steps；
* decisions；
* branches；
* parallel candidates；
* tools；
* scripts；
* references；
* human gates；
* expected outputs。

结果仍然是 `draft`，不能直接运行。

### Importer 不得执行 Skill script

导入阶段只能：

* 读取；
* hash；
* 复制；
* 分析。

不得为了“判断脚本做什么”直接运行第三方脚本。

### 资源处理

#### Inline

小段 instruction 放入 node prompt。

#### Vendor

复制：

```text
scripts/
references/
assets/
```

每个文件记录 hash。

#### Requirement

外部依赖转成：

```yaml
requirements:
  executables:
    - git
  mcp_servers:
    - github
  environment:
    - SOME_ENV_NAME
```

不得复制 secret value。

### 安全边界

* 拒绝越出 Skill root 的路径；
* 默认拒绝 symlink，或解析后确认 target 仍位于允许 root；
* 拒绝 device file；
* 文件数、单文件大小、总大小有限制；
* binary assets 单独标记；
* 不存 token、cookie、password；
* source license 和 source hash 写入 provenance。

### 推断标记

每个 AI 拆出的节点或边保存：

```json
{
  "origin": "inferred",
  "confidence": 0.76,
  "source_span": "..."
}
```

UI 用虚线或警告显示。

### 通过标准

* 任意合法 Skill 至少能 coarse import；
* 原 Skill 不发生变化；
* 删除原 Skill 后 coarse Workflow 仍可运行；
* scripts/references/assets hash 完整；
* 缺 external requirement 时 Run 前失败；
* AI expansion 失败时 coarse draft 仍保留；
* source 更新不会自动改 Workflow。

---

## M9：SkillRef 与 SubWorkflow

### 目标

实现“插拔”。

## SkillRef 两种模式

### Linked

```text
Workflow → SkillRef → 外部 Skill
```

运行时依赖原 Skill。

必须保存：

* Skill path；
* name；
* source hash；
* expected version；
* allowed nested skills；
* strict skill policy。

### Inlined

用户点击：

```text
Expand / Inline Skill
```

将 SkillRef 转成可编辑 Subgraph，并把依赖资源放入 Workflow Pack。

完成后：

```text
SkillRef dependency = 0
```

## SubWorkflow

必须保存：

```text
workflow_id
revision_pin
input_bindings
output_bindings
```

### 继承规则

子 Workflow：

* 可以收窄 Skill allowlist；
* 不能扩大父级 Skill allowlist；
* 可以收窄 allowed paths；
* 不能扩大父级 allowed paths；
* 可以要求更严格 approval；
* 不能取消父级 approval；
* 输出进入自己的 namespace。

### 通过标准

* missing SkillRef fail-closed；
* source hash 改变时显示 stale；
* revision pin 不匹配时阻止执行；
* Inline 后关闭源 Skill仍可运行；
* SubWorkflow cycle 被拒绝；
* Child 不能提升权限。

---

## M10：并行执行与写入隔离

### 目标

支持真正的多 Agent 并行，但不允许共享目录竞态。

## 第一阶段：只读并行

允许：

```text
Parallel
├─ Reviewer A / read-only
├─ Reviewer B / read-only
└─ Reviewer C / read-only
        ↓
Join: all_success
```

先只实现：

```text
join_policy = all_success
```

后续再加：

```text
all_settled
first_success
quorum
judge
best_of_n
```

## 第二阶段：有界写并行

**禁止两个 Agent 同时写同一 working tree。**

每个写分支必须：

1. 从同一 base commit 创建独立 worktree；
2. 设置独立 allowed paths；
3. 执行；
4. 验证 diff；
5. 检查 outside paths；
6. 到 Join 后进入 integration gate；
7. 由主 Agent或专门 integrator 合并；
8. 冲突时 fail-closed。

### 新增文件

```text
plugins/sol-advisor/control-plane/lib/parallel/
├── branch-planner.mjs
├── worktree-manager.mjs
├── ownership-checker.mjs
├── merge-gate.mjs
└── join-policies.mjs
```

### 预启动检查

若两个并行写节点的 path scope 可能重叠：

```text
PARALLEL_WRITE_SCOPE_OVERLAP
```

除非它们明确进入不同 worktree 且有后续 merge gate。

### 通过标准

* 只读并行真实并发；
* shared-tree write 被拒绝；
* disjoint worktree writes 可执行；
* outside paths 非空即失败；
* merge conflict 不自动选择一边；
* 一个分支失败时不接受整个 Run；
* Main Agent保留最终合并与验收权。

---

## M11：React Flow 可视化编辑器

### 目标

在运行内核稳定后接 UI。

不要直接重写当前整个控制台。保留 Provider 设置页，新增 Workflow 工作区。

### 建议目录

```text
plugins/sol-advisor/control-plane/
├── web-src/
│   ├── main.tsx
│   ├── app/
│   ├── workflow/
│   │   ├── WorkflowCanvas.tsx
│   │   ├── WorkflowSidebar.tsx
│   │   ├── NodeInspector.tsx
│   │   ├── EdgeInspector.tsx
│   │   ├── ValidationPanel.tsx
│   │   ├── ImportSkillDialog.tsx
│   │   └── RunPanel.tsx
│   └── nodes/
└── web/
    └── 编译后的静态资产
```

### 构建策略

* 源码使用 React + TypeScript + React Flow；
* CI 构建静态资产；
* 插件发行包包含编译结果；
* 用户安装插件后不需要本地执行 `npm install`；
* CI 检查 committed dist 与源码一致。

### 首版 UI 必须支持

* Workflow 列表；
* 新建、复制、删除；
* Skill 导入；
* 拖放节点；
* 连接边；
* Provider selector；
* role、access、path scope；
* approval；
* Skill policy；
* condition editor；
* parallel/join；
* validation；
* Draft/Ready；
* revision；
* source provenance；
* Run；
* live status；
* cancel；
* resume；
* output 和 evidence 查看。

### 节点颜色不能代表唯一语义

状态必须同时有：

* 图标；
* 文字；
* ARIA label；
* tooltip。

### 首版不做

* 自然语言直接修改 Graph；
* Workflow→Skill 导出；
* 实时多人协作；
* 自动布局后的强制保存；
* 自定义 JS 节点。

### 通过标准

* UI 创建的 Graph 与直接 JSON 创建的 Graph 完全等价；
* 保存、关闭、重开无语义变化；
* invalid Graph 不能标记 Ready；
* source Skill 不被修改；
* 并行与 Join 在图上关系清楚；
* Run 状态来自 Runtime，不由前端自行猜测。

---

## M12：运行追踪、审批和恢复

### 目标

完成真正可用的运行控制台。

### 实时事件

```text
run_started
node_ready
node_claimed
node_started
node_output_delta
approval_requested
approval_resolved
node_completed
node_failed
join_waiting
run_blocked
run_completed
run_cancelled
```

### UI 必须显示

* 当前节点；
* 并行中的节点；
* Agent/Provider；
* attempt；
* elapsed events；
* read/write access；
* effective allowed paths；
* Skill allow/deny；
* approval；
* diff；
* verification；
* error；
* retry；
* residual risk。

### 恢复规则

* 已成功节点不重跑；
* interrupted 节点必须显式 retry；
* 外部 connector task 若仍存在，先重新查询真实状态；
* 无法确认身份连续性时不得接受旧结果；
* Workflow revision 改变后，旧 Run 不能直接继续；
* source Skill 更新不影响已开始 Run。

### 通过标准

* 进程重启后状态一致；
* approval 不丢；
* cancel 能传播到可取消 Provider；
* 无法取消时明确标记；
* Run history 不泄露 secret；
* event log 可以重建最终 Run 状态。

---

## M13：端到端门禁、文档和发布

### 必测 E2E 场景

#### 1. 旧 bounded-code-change

```text
v6 Task Type
    ↓ migrate
v7 Workflow
    ↓ run
相同 Provider、权限与模板
```

#### 2. 旧 judgment-heavy

```text
Terra implementation
    ↓
Sol read-only review
    ↓
Main final acceptance
```

#### 3. Skill coarse import

```text
导入 Skill
    ↓
禁用/删除源 Skill
    ↓
Strict Run 成功
```

#### 4. 冲突 Skill

后台 Skill 要求输出：

```text
SHADOWED_SKILL_SENTINEL
```

Workflow 要求另一行为。

Strict Run 中：

* 哨兵不得出现；
* Skill policy 日志显示它被禁用；
* 用户真实配置无变化。

#### 5. 显式 SkillRef

只有图中的 SkillRef 可执行。

#### 6. Skill source update

* 检测 hash 变化；
* 显示 update available；
* 不自动修改 Workflow；
* 旧 Run 不受影响。

#### 7. Parallel read-only

多个 reviewer 并行后 Join。

#### 8. Parallel bounded write

独立 worktree、无越权、成功 merge。

#### 9. Overlapping write

预启动失败。

#### 10. Crash/resume

不重复完成节点，不丢审计。

#### 11. UI round-trip

Graph 保存重开后完全一致。

#### 12. Missing capability

缺 Provider、Skill、MCP、executable 时全部 fail-closed。

---

# 六、建议的 PR/提交序列

每一个 PR 都必须单独通过，不能把全部内容堆成一个不可审查的大提交。

| PR    | 内容                              | 合并门                  |
| ----- | ------------------------------- | -------------------- |
| PR-01 | ADR、基线、总计划                      | 只改文档                 |
| PR-02 | Skill isolation spike           | Strict 可行性结论明确       |
| PR-03 | Workflow Store + IR + Validator | 无执行功能                |
| PR-04 | v6→v7 migration + compatibility | 所有旧预设语义一致            |
| PR-05 | Scheduler + Run Store           | fake executor 全通过    |
| PR-06 | 现有 Provider execution adapters  | 不允许 silent fallback  |
| PR-07 | Strict App Server adapter       | 冲突 Skill 测试通过        |
| PR-08 | Skill inventory + coarse import | 源 Skill 不再是依赖        |
| PR-09 | AI expansion + provenance       | 结果仍为 Draft           |
| PR-10 | SkillRef + SubWorkflow          | 权限只可收窄               |
| PR-11 | Read-only parallel + Join       | 并发状态正确               |
| PR-12 | Worktree write parallel         | shared-tree write 禁止 |
| PR-13 | React Flow editor               | Graph round-trip 通过  |
| PR-14 | Run UI、events、resume            | 崩溃恢复通过               |
| PR-15 | 文档、跨平台、发布门禁                     | 最终全量验收               |

---

# 七、每个 PR 的通用审查要求

每个完成提交都必须附带：

```text
1. STATED GOAL
2. FILES CHANGED
3. SCHEMA OR CONTRACT CHANGES
4. MIGRATION IMPACT
5. SECURITY BOUNDARY
6. TEST COMMANDS
7. ACTUAL TEST OUTPUT
8. REAL DIFF SUMMARY
9. KNOWN LIMITATIONS
10. ROLLBACK METHOD
```

审阅顺序：

```text
实现 Agent
    ↓
独立只读 Reviewer
    ↓
修复阻塞项
    ↓
主 Agent复验
    ↓
合并
```

Reviewer 不能修自己的 findings。

---

# 八、明确禁止提前实现的内容

在核心运行时稳定前，不做：

1. Skill ↔ Workflow 双向同步；
2. 自动改写原 Skill；
3. 自动生成大量 thin alias Skill；
4. 自然语言任意重画 Graph；
5. 无界 Loop；
6. 动态 Graph 自修改；
7. arbitrary code node；
8. shared working tree 并行写；
9. 运行时修改用户全局 Skill 状态；
10. 隐式 Provider fallback；
11. 隐式 Skill fallback；
12. 自动接受 AI 拆解后的 Workflow；
13. 未经用户检查就执行第三方 Skill script；
14. Cooperative 模式冒充 Strict；
15. 前端绕过后端 Validator。

---

# 九、最终 Definition of Done

整个升级只有同时满足以下条件，才算完成：

* v6 用户配置能够安全、幂等迁移；
* 原来的 Task Type 行为没有丢失；
* 用户可以创建和编辑 Workflow Graph；
* 每个执行节点可以绑定主 Agent或固定 Provider；
* 多个 worker Agent 可以并行；
* 主 Agent始终拥有最终验收权；
* 任意 Skill 至少可以被 coarse import；
* AI expansion 的不确定部分对用户可见；
* 导入不会修改原 Skill；
* 自包含 Workflow 在原 Skill 消失后仍能运行；
* Strict Run 中未授权背景 Skill 被真实隔离；
* Cooperative Run 不虚假宣称隔离；
* SkillRef 只在显式节点中开启；
* SubWorkflow 不能扩大权限；
* 并行写使用独立 worktree；
* 所有写操作继续受当前 Run 的 allowed paths 限制；
* Scheduler 可暂停、恢复、取消；
* stale lease 和重复 completion 不会破坏状态；
* UI 只是 Workflow IR 的编辑器，不是第二个真相来源；
* 每次 Run 都有完整身份、权限、Skill policy、diff 和验证审计；
* Windows、Linux、macOS 的核心测试和控制台启动均通过。

**最先应该实际执行的是 PR-01 和 PR-02。特别是 PR-02 必须先证明 Strict Skill isolation；在它通过以前，不应开始承诺“导入 Skill 后背景 Skill 绝不会干扰”的正式产品行为。**

