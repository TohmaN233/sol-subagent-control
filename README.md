# Sol Advisor — Configurable Subagent Control

**A qualifying primary agent runs the show. GPT-5.6 Sol is the default; GPT-5.6 Terra also qualifies, GPT-5.6 Luna does not, and reasoning must be `high`, `xhigh`, or `max`.**

This fork preserves Sol Advisor's native Codex workflow and adds a user-owned control plane plus repository-owned Cursor and Grok connectors. Sol remains the default; Terra is also allowed, Luna is rejected as the primary agent, and the root retains architecture, verification, and acceptance authority.

## What this fork changes

| Area | Upstream behavior retained | This fork adds or changes |
|---|---|---|
| Primary owner | One root owns architecture, routing, verification, and acceptance. | Sol remains default; Terra may qualify; primary reasoning must be high or above. |
| Routes | `solo`, `delegate`, `audit`, and exceptional `full`; native Luna / Max, Terra / High, and fresh Sol / High roles stay pinned. | A scenario selects one enabled provider without transferring final authority. |
| Configuration | Native routing remains instruction- and role-driven. | A token-protected `127.0.0.1` console manages provider/scenario switches, mappings, approval gates, and private templates. |
| Connectors | Codex-native custom agents. | Minimal built-in Cursor CDP and Grok Leader+ACP connectors support read-only and explicitly approved bounded-write work. |
| Safety | Exact role/runtime evidence fails closed. | Writes require provider write capability, a non-read-only scenario, explicit current-task approval, and non-empty `allowed_paths`; a live workspace monitor plus Git content/HEAD/index/ref/config/reflog evidence rejects scope violations. |
| External cost | Native use follows the user's Codex access. | Cursor, Grok, ChatGPT web Pro, and custom APIs are all disabled by default and are never called merely because they are installed. |

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

You do not need to select or manage a lane; the console stores reusable policy while the qualifying primary agent owns routing, verification, and acceptance.

## Console, connector enablement, and approval

Ask Codex to open the Sol Subagent Control console. Both `cursor-local` and `grok-local`, all connector scenarios, ChatGPT web Pro, and custom API providers ship disabled. Enabling a provider does not call it; enable a matching scenario as a separate action. Every built-in connector scenario requires current-task user approval.
Existing version-1 control-plane files migrate in place: user mappings and templates are preserved, while the new built-in Cursor provider and write scenarios are added disabled.

For Cursor, install and sign in to Cursor; set `CURSOR_EXE` before the plugin starts only when standard Windows/macOS locations are not found. If Cursor is already open without CDP, save and exit it normally once—the connector never force-closes it. The supported profile is explicitly pinned and fails closed when selectors or Agent identity are ambiguous.

For Grok, install and authenticate the Grok CLI; set `GROK_BIN` before plugin start when it is outside the standard location. The connector starts its own dedicated Leader and ACP child, preserves exact session/run identity, surfaces permission/input requests, and never uses approve-everything modes.

Read-only starts omit `allowed_paths`. Bounded-write starts must provide the smallest workspace-relative path list. Write access opens only when `capabilities.write=true`, `scenario.read_only=false`, and `user_approved=true`; any other combination fails before the child model receives the task. While a connector is active, recursive filesystem events outside the boundary trigger exact cancellation, including writes to Git-ignored paths. Final acceptance also compares file content plus Git HEAD, refs, semantic index, local config, and reflog, so staging or committing does not erase the evidence.

## Routes

| Mode | Use it when | Delivery |
|---|---|---|
| `solo` | Default; risk is contained. | Root plans, implements, tests, and self-reviews. |
| `delegate` | One bounded task benefits from an auxiliary. | The mapped provider executes or advises; root verifies. |
| `audit` | Independent final scrutiny matters more than delegation. | Root implements; the mapped read-only reviewer audits. |
| `full` | Explicit broad or high-risk exception. | One implementation stage, root verification, then one fresh review stage. |

Solo is the default. One auxiliary is the default maximum. The primary emits a route before the first task tool call, escalates only on newly observed risk, and never silently downgrades or remaps the provider. Auxiliary work substitutes for root work; it does not duplicate it.

## Local live smoke boundary

After pulling `main`, first enable only the provider/scenario being tested. For each connector run: (1) one read-only task and confirm Git is unchanged; (2) one bounded-write task limited to a disposable path and confirm only that path changed; (3) one long task followed by exact-identity cancellation. Record the returned `task_id` plus Cursor `agent_id` or Grok `session_id`/`run_id`. A model response alone is not success; Sol must inspect scope evidence, Git state, and the requested checks.

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
