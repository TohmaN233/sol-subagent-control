# Sol Advisor — Configurable Subagent Control

**A qualifying primary agent runs the show. GPT-5.6 Sol is the default; GPT-5.6 Terra also qualifies, GPT-5.6 Luna does not, and reasoning must be high or above.**

This fork preserves Sol Advisor's native Codex workflow and adds an optional local control plane. The user maps a reusable scenario to a provider; the primary agent sees sanitized metadata first and receives only the selected prompt template.

## What this fork changes

The upstream four-route workflow, exact custom-agent roles, runtime evidence, and fail-closed verification remain intact. This fork adds or changes:

| Area | Upstream behavior retained | This fork adds or changes |
|---|---|---|
| Primary owner | One root agent owns architecture, routing, verification, and acceptance. | Sol remains the default; Terra is also allowed, Luna is rejected, and reasoning must be `high`, `xhigh`, or `max`. |
| Routing | `solo`, `delegate`, `audit`, and exceptional `full`; native Luna / Max, Terra / High, and fresh Sol / High roles remain pinned. | A user-owned scenario selects one provider without transferring final authority away from the root. |
| Configuration | Native routing is instruction- and role-driven. | A token-protected `127.0.0.1` console manages provider/scenario switches, mappings, approval gates, and templates outside the plugin cache. |
| Context | Native role prompts enter context when their route is selected. | Status exposes sanitized metadata only; resolution returns one selected compiled template rather than the whole prompt library. |
| Providers | Codex-native custom agents. | Experimental built-in read-only Grok Leader + ACP, external MCP descriptors such as Cursor, packet-only ChatGPT web review, and text-only OpenAI-compatible advisory providers. External and paid paths remain opt-in. |
| Safety and portability | Exact role pins and runtime evidence fail closed. | Provider capability checks, loopback authentication, revision-safe saves, secret-safe direct API rules, read-only connector postconditions, and Windows plus Linux verification. |

Cursor is a descriptor for a separately installed Bridge, not a bundled connection. The built-in Grok connector is read-only and requires explicit enablement and current-task approval.

## Go deeper

The original author writes [**Attention Heads**](https://attentionheads.substack.com/?utm_source=github&utm_medium=readme&utm_campaign=sol-advisor) — deep, evidence-backed writing on AI, cognition, and agentic engineering. [Subscribe](https://attentionheads.substack.com/subscribe?utm_source=github&utm_medium=readme&utm_campaign=sol-advisor) for new Agentic Engineering Field Notes.

## Quick start

You need a current Codex CLI or ChatGPT desktop app with plugins enabled, GPT-5.6 Sol (default) or Terra at high/xhigh/max reasoning, native custom-agent support, Node.js 20+, and jq. Luna never qualifies as the primary agent; Luna / Max or Terra / High access is needed only when the selected route delegates.

~~~sh
codex plugin marketplace add TohmaN233/sol-subagent-control --ref main
codex plugin add sol-advisor@sol-advisor
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "sol-advisor@sol-advisor") | .source.path')" && test -n "$plugin_dir" && test "$plugin_dir" != null && test -d "$plugin_dir" && test -f "$plugin_dir/scripts/install-agents.sh" && sh "$plugin_dir/scripts/install-agents.sh"
~~~

Start a fresh task so the native roles and control-plane tools are discovered. Use:

~~~text
Use $sol-advisor:sol-control-plane. Keep a qualifying primary agent in charge, read sanitized control metadata once, declare one selective route, resolve only the selected scenario, and verify every auxiliary claim.
~~~

The original native-only workflow remains available as `$sol-advisor:orchestration`.

## User-owned console

Ask Codex to open the Sol Subagent Control console. Its token-protected `127.0.0.1` page manages providers, scenario mappings, templates, and switches without exposing the token or prompt library in normal tool output. Configuration persists outside the plugin cache.

Native Luna, Terra, and fresh Sol review are enabled by default. The repository now
bundles an **experimental, read-only Grok Leader + ACP connector**, disabled until the
user enables and approves its scenario. Cursor remains an explicitly external Bridge
descriptor; this repository does not yet bundle a Cursor connection. ChatGPT web Pro
and custom OpenAI-compatible advisory models also remain opt-in.

The Grok connector owns task/session/run identity, permission and input gates, timeout
ambiguity, cancellation, and restart fail-closed state. It has automated fake-process
coverage but still requires desktop live smoke before any broad compatibility claim.
The root continues to check the real Git state, tests, and artifacts.

## What you do

Give the primary agent the outcome, constraints, and important repository context. You
do not need to select or manage a lane; the console stores your reusable mapping while
the primary agent records the chosen route and owns verification and acceptance.

## Routes

| Mode | Use it when | Delivery |
|---|---|---|
| `solo` | Default; risk is contained. | Root plans, implements, tests, and self-reviews. |
| `delegate` | One complete bounded task benefits from an auxiliary. | The mapped provider executes or advises; root verifies. |
| `audit` | Independent final scrutiny matters more than delegation. | Root implements; the mapped read-only reviewer audits. |
| `full` | Explicit broad or high-risk exception. | One implementation stage, root verification, then one fresh review stage. |

Solo is the default. One auxiliary is the default maximum; `full` is the explicit exception.
The primary agent emits a `SELECTIVE ROUTE` declaration before the first task tool call. It can escalate only when newly observed risk justifies it and never silently downgrades or remaps the provider.

## What happens automatically

The qualifying primary agent keeps architecture, decomposition, route selection,
parent verification, escalation decisions, and acceptance in the primary task.
Auxiliary work substitutes for root work; it does not duplicate it. Only the selected
template is compiled. When the route includes review, any correction invalidates the
old verdict.

## Updating

Upgrade the fork, reinstall the companion roles, and start a new task:

~~~sh
codex plugin marketplace upgrade sol-advisor
codex plugin add sol-advisor@sol-advisor
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "sol-advisor@sol-advisor") | .source.path')" && test -n "$plugin_dir" && test "$plugin_dir" != null && test -d "$plugin_dir" && test -f "$plugin_dir/scripts/install-agents.sh" && sh "$plugin_dir/scripts/install-agents.sh"
~~~

For exact native spawn, runtime evidence, sandbox interpretation, installer, and
maintainer verification details, read [advanced native operations](plugins/sol-advisor/skills/orchestration/references/operations.md). For the extension, read the
[control-plane architecture](plugins/sol-advisor/skills/control-plane/references/architecture.md)
and [provider contracts](plugins/sol-advisor/skills/control-plane/references/provider-contracts.md).

## Attribution

The native selective-routing core was created by Daniel McAteer and remains under the
MIT license. This fork's configurable control plane is maintained by TohmaN233.
