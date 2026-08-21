# Sol Advisor — Configurable Subagent Control

**A qualifying primary agent runs the show. GPT-5.6 Sol is the default; GPT-5.6 Terra also qualifies, GPT-5.6 Luna does not, and reasoning must be `high`, `xhigh`, or `max`.**

This fork preserves Sol Advisor's native Codex workflow and adds a user-owned control plane plus repository-owned Cursor and Grok connectors. Sol remains the default; Terra is also allowed, Luna is rejected as the primary agent, and the root retains architecture, verification, and acceptance authority.

## What this fork changes

| Area | Upstream behavior retained | This fork adds or changes |
|---|---|---|
| Primary owner | One root owns architecture, routing, verification, and acceptance. | Sol remains default; Terra may qualify; primary reasoning must be high or above. |
| Routes | `solo`, `delegate`, `audit`, and `full`; native Luna / Max, Terra / High, and fresh Sol / High roles stay pinned. | Delegate is the ordinary default; difficult work uses full. A Task Type's route is derived from its Stage topology instead of being configured twice. |
| Configuration | Native routing remains instruction- and role-driven. | A token-protected `127.0.0.1` console manages pluggable Task Types, Stage bindings, Provider switches, approval gates, and private templates. |
| Connectors | Codex-native custom agents. | Minimal built-in Cursor CDP and Grok Leader+ACP connectors support read-only and explicitly approved bounded-write work. |
| Safety | Exact role/runtime evidence fails closed. | Writes require Provider write capability, a `bounded_write` Stage, explicit current-task approval, and non-empty `allowed_paths`; a live workspace monitor plus Git content/HEAD/index/ref/config/reflog evidence rejects scope violations. |
| External cost | Native use follows the user's Codex access. | Cursor, Grok, ChatGPT web review, and custom APIs are all disabled by default and are never called merely because they are installed. |

Cursor uses loopback CDP and one pinned Agents UI profile; Grok uses a dedicated Leader and ACP over stdio. Neither connector includes the full reference Bridge/Supervisor. Automated fixtures cover both transports. The maintained Windows baseline has also passed the live smoke steps below with Cursor 3.16.29 and Grok CLI 1.0.4; other local versions still fail closed until the same checks pass.

## Go deeper

The original author writes [**Attention Heads**](https://attentionheads.substack.com/?utm_source=github&utm_medium=readme&utm_campaign=sol-advisor) — deep, evidence-backed writing on AI, cognition, and agentic engineering. [Subscribe](https://attentionheads.substack.com/subscribe?utm_source=github&utm_medium=readme&utm_campaign=sol-advisor) for new Agentic Engineering Field Notes.

## Quick start

You need a current Codex CLI or ChatGPT desktop app with plugins enabled, GPT-5.6 Sol or Terra at high/xhigh/max reasoning, native custom-agent support, Node.js 20+, Git, and jq. Luna / Max or Terra / High access is needed only when the selected route delegates through a native role.

~~~sh
codex plugin marketplace add TohmaN233/sol-subagent-control --ref main
codex plugin add sol-advisor@sol-advisor
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "sol-advisor@sol-advisor") | .source.path')" && test -n "$plugin_dir" && test "$plugin_dir" != null && test -d "$plugin_dir" && test -f "$plugin_dir/scripts/install-agents.sh" && sh "$plugin_dir/scripts/install-agents.sh"
~~~

Start a fresh task, then use:

~~~text
Use $sol-advisor:sol-control-plane. Keep a qualifying primary agent in charge, read sanitized metadata once, declare one selective route, and verify every auxiliary claim.
~~~

The native-only workflow remains `$sol-advisor:orchestration`.

For activation semantics, one-click console scripts, configuration, and live smoke examples, read the [English usage tutorial](docs/TUTORIAL.md) or [中文使用教程](docs/TUTORIAL.zh-CN.md).

You do not need to select or manage a lane; the console stores reusable policy while the qualifying primary agent owns routing, verification, and acceptance.

The saved control-plane policy is user-global, not repository-local: it lives at `$CODEX_HOME/sol-advisor/control-plane.json`, or `~/.codex/sol-advisor/control-plane.json` when `CODEX_HOME` is unset. The console shows the active storage scope and path at the top. An explicit `SOL_CONTROL_CONFIG` path is an override for development/testing and is visibly marked; it does not replace the global policy.

If the host cannot expose the current primary model or reasoning effort, the skill gives one non-blocking reminder and continues; only an observed mismatch stops controlled delegation. Missing control tools or a denied global-config read is reported as an activation/permission error and never silently changes the selected workflow or Provider.

## Console, connector enablement, and approval

Ask Codex to open the Sol Subagent Control console. Both `cursor-local` and `grok-local`, ChatGPT web review, and custom API Providers ship disabled. Enabling a Provider does not call it; bind it to an appropriate Task Type Stage as a separate action. Every built-in connector Provider requires current-task user approval. The ChatGPT web Provider deliberately leaves its model/thinking label empty because those settings are selected in the web session, not by this control plane.

The console also ships with seven model-independent Task Type presets: bounded code change,
judgment-heavy change, cross-review, brainstorm, repository analysis, implementation with
independent review, and hard-path external review. They are an editable starting configuration,
not a closed catalog. A user can use a preset as-is, remove it, add it again from the bundled
preset library, duplicate and customize it, or create a blank Task Type. Provider selection lives
inside each Stage, so the same Task Type can be remapped to a native agent, Cursor, Grok, or
another compatible Provider without creating a model-named task category.
Existing version-1 and version-2 control-plane files migrate in place to version 3. Generic policy and custom templates are preserved; untouched disabled Cursor/Grok-specific task presets are removed because model choice now belongs to Stage configuration. Ambiguous legacy `full` routes migrate disabled for manual review.

Native Provider cards expose Model and Reasoning effort as normal form controls instead of requiring JSON edits. Supported effort choices are `low`, `medium`, `high`, `xhigh`, `max`, and Codex `ultra`; the form stays synchronized with the adapter JSON.

For Cursor, install and sign in to Cursor; set `CURSOR_EXE` before the plugin starts only when standard Windows/macOS locations are not found. If Cursor is already open without CDP, save and exit it normally once—the connector never force-closes it. The supported profile is explicitly pinned and fails closed when selectors or Agent identity are ambiguous.

For Grok, install and authenticate the Grok CLI; set `GROK_BIN` before plugin start when it is outside the standard location. The connector starts its own dedicated Leader and ACP child, preserves exact session/run identity, surfaces permission/input requests, and never uses approve-everything modes.

Read-only Stages omit `allowed_paths`. Bounded-write Stages must provide the smallest workspace-relative path list. Write access opens only when `capabilities.write=true`, `stage.access=bounded_write`, and `user_approved=true`; any other combination fails before the child model receives the task. While a connector is active, recursive filesystem events outside the boundary trigger exact cancellation, including writes to Git-ignored paths. Final acceptance also compares file content plus Git HEAD, refs, semantic index, local config, and reflog, so staging or committing does not erase the evidence.

## Task Type, Stage, and Provider boundary

- A **Task Type** is a pluggable workflow definition with a model-independent description, tags, and prompt semantics.
- A **Stage** is an ordered implementation or review lane inside that Task Type. It owns access and approval policy.
- A **Provider** is a model/transport adapter. Provider-specific safety and connection rules stay in the adapter.

Route topology is derived from Stages: no Stages means `solo`, implementation means `delegate`, review means `audit`, and implementation followed by review means `full`. The console no longer exposes a separate Route selector. New Task Types default to delegate; enable an independent review Stage for difficult work to produce full. Each Stage has exactly one Provider pinned by the user. Sol may choose a matching enabled Task Type, but it may not choose among Providers, substitute one, or auto-fallback.

On upgrade, a legacy judgment-heavy preset with the standard task identity is migrated to the full two-Stage workflow while preserving its customized implementation Provider, access, approval, and template. A Task Type whose task semantics were customized remains user-owned and is not migrated.

## Routes

| Mode | Use it when | Delivery |
|---|---|---|
| `solo` | The user explicitly requests primary-only work. | Root plans, implements, tests, and self-reviews. Never use this as an activation-error fallback. |
| `delegate` | Default for light or ordinary bounded work. | The pinned implementation Provider executes or advises; root verifies. |
| `audit` | Independent final scrutiny matters more than delegation. | Root implements; the pinned read-only review Provider audits. |
| `full` | Difficult, broad, or high-risk work. | One implementation stage, root verification, then one fresh review stage. |

Delegate is the default. Difficult work uses full. The primary emits a route before the first task tool call, escalates only on newly observed risk, and never silently downgrades or remaps the Provider. Missing control tools are an activation error, not a valid solo route. Auxiliary work substitutes for root work; it does not duplicate it.

## Local live smoke boundary

After pulling `main`, first enable only the Provider being tested and pin it to one disposable test Task Type Stage. For each connector run: (1) one read-only task and confirm Git is unchanged; (2) one bounded-write task limited to a disposable path and confirm only that path changed; (3) one long task followed by exact-identity cancellation. Record the returned `task_id` plus Cursor `agent_id` or Grok `session_id`/`run_id`. A model response alone is not success; Sol must inspect scope evidence, Git state, and the requested checks.

The repository CI does not prove the user's actual Cursor UI version, login state, Grok installation, authentication, or desktop behavior. On 2026-08-20, the maintained Windows baseline passed read-only, bounded-write, and exact-cancel tests with Cursor 3.16.29 and Grok CLI 1.0.4. Treat that as a known-good baseline, not a guarantee for another installation; rerun the six checks after either desktop tool changes.

## Updating

~~~sh
codex plugin marketplace upgrade sol-advisor
codex plugin add sol-advisor@sol-advisor
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "sol-advisor@sol-advisor") | .source.path')" && test -n "$plugin_dir" && test "$plugin_dir" != null && test -d "$plugin_dir" && test -f "$plugin_dir/scripts/install-agents.sh" && sh "$plugin_dir/scripts/install-agents.sh"
~~~

For exact native spawn, runtime evidence, sandbox interpretation, installer, and maintainer verification, read [advanced native operations](plugins/sol-advisor/skills/orchestration/references/operations.md). For connector states and trust boundaries, read the [control-plane architecture](plugins/sol-advisor/skills/control-plane/references/architecture.md) and [provider contracts](plugins/sol-advisor/skills/control-plane/references/provider-contracts.md).

## Attribution

The native selective-routing core was created by Daniel McAteer under the MIT license. This fork's configurable control plane and minimal connectors are maintained by TohmaN233.
