# Sol Subagent Control architecture

## Design objective

Keep Sol / High as the only task owner while letting the user decide, outside the
model prompt, which auxiliary provider is mapped to each reusable scenario. The
control plane is intentionally a policy and prompt compiler, not another autonomous
orchestrator.

## Four layers

1. **Sol root session**
   - owns requirements, architecture, route declaration, scope, verification, and
     acceptance;
   - sees sanitized scenario/provider metadata;
   - receives one compiled template only after selecting one scenario.
2. **User control plane**
   - stores persistent configuration under the user state directory, outside plugin
     caches;
   - exposes a token-protected loopback console bound to `127.0.0.1`;
   - is the only supported writer for provider/scenario configuration.
3. **Provider adapters**
   - native Codex role, host MCP bridge, packet-only web review, or direct
     OpenAI-compatible advisory API;
   - return typed execution contracts rather than pretending every provider is a
     native subagent.
4. **Evidence and acceptance**
   - auxiliary output is a claim;
   - Sol inspects files, task identity, diffs, tests, and artifacts before acceptance.

## Prompt privacy boundary

`sol_control_status` returns no templates, endpoints, credential-variable names, or
console tokens. It exposes only enough metadata to choose a scenario: ids, public
descriptions, route, provider mapping, kind, capabilities, enabled state, approval
state, and a short template revision fingerprint.

`sol_control_resolve` accepts one exact scenario id and interpolates only these fields:

- `{{task}}`
- `{{context}}`
- `{{constraints}}`
- `{{verification}}`
- `{{scenario_id}}`
- `{{provider_name}}`

It returns that one compiled prompt plus the mapped provider adapter. It never returns
the rest of the template library. The skill contract forbids resolving other scenarios
for comparison.

This is minimization, not a hostile-model secrecy sandbox. A local coding agent may
have broad operating-system access. The plugin therefore avoids returning the console
token during normal launch, does not expose configuration mutation as an MCP tool, and
requires the skill to leave the user configuration file untouched. Stronger separation
would require an operating-system boundary outside the plugin.

## Persistent configuration

The default path is:

~~~text
$CODEX_HOME/sol-advisor/control-plane.json
~~~

or `~/.codex/sol-advisor/control-plane.json` when `CODEX_HOME` is unset. An absolute
`SOL_CONTROL_CONFIG` overrides it. On first use the server copies the bundled defaults
with restrictive file permissions. Saves are validated, written atomically, and
revision-checked to prevent console clobbering.

A metadata-only audit log records console saves, scenario resolutions, and direct API
invocations without prompt text or response bodies.

## Switches and failure behavior

The effective route is enabled only when all relevant layers allow it:

- `SOL_CONTROL_DISABLED` is not set to a true value;
- global configuration is enabled;
- the scenario is enabled;
- the mapped provider is enabled;
- current-task approval is present when either scenario or provider requires it;
- provider capabilities match read-only or write intent;
- provider-specific preflight succeeds.

Every failure is closed. The server never changes mappings, silently substitutes a
provider, stores an API key, downgrades a route, or invokes an adjacent tool.

## Why bridges stay external

Cursor Bridge and Grok Build Supervisor already own identity, queueing, session
continuity, cancellation, permissions, and recovery. Reimplementing them inside Sol
Subagent Control would erase those safety contracts and make failures ambiguous.
Instead, the selected adapter returns the exact host tool operations and protocol name;
Sol calls the installed bridge and retains final verification.

The same principle applies to ChatGPT web Pro: the packet-first review skill remains
the browser transport and capture authority. Sol Subagent Control decides when that
lane is eligible and compiles the selected review prompt; it does not duplicate browser
automation.

## Direct custom models

The `openai_compatible` adapter is deliberately narrower than a coding-agent bridge:

- HTTPS only, except an HTTP loopback local model;
- no URL credentials, query, or fragment;
- credentials only through a named environment variable;
- sensitive headers cannot be stored in configuration;
- no redirects;
- bounded timeout and response size;
- text-only chat completion with no tools;
- read-only scenarios only.

This supports xAI/OpenRouter/Groq/DeepSeek-compatible gateways and local OpenAI-style
servers without granting them repository or shell access. Providers with richer agent
semantics should be integrated as a dedicated MCP bridge instead.

## Route model

The original exact modes remain:

- `solo`: Sol does all work;
- `delegate`: one mapped implementation or advisory auxiliary, then Sol verifies;
- `audit`: Sol implements/verifies, then one mapped read-only reviewer;
- `full`: exceptional sequential implementation and review, resolving one stage at a
  time.

One auxiliary is still the default maximum. Provider diversity is a configurable
option, not a reason to fan out by default.
