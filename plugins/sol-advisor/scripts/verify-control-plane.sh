#!/bin/sh
# Repository-local verification for the optional Sol Subagent Control extension.

set -eu

pass() { printf '%s\n' "PASS: $*"; }
fail() { printf '%s\n' "FAIL: $*" >&2; exit 1; }

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
plugin_dir=$(CDPATH= cd "$script_dir/.." && pwd) || exit 1
repo_dir=$(CDPATH= cd "$plugin_dir/../.." && pwd) || exit 1
control=$plugin_dir/control-plane
manifest=$plugin_dir/.codex-plugin/plugin.json
mcp_manifest=$plugin_dir/.mcp.json
config=$control/default-config.json
server=$control/server.mjs
skill=$plugin_dir/skills/control-plane/SKILL.md
architecture=$plugin_dir/skills/control-plane/references/architecture.md
contracts=$plugin_dir/skills/control-plane/references/provider-contracts.md
ui=$plugin_dir/skills/control-plane/agents/openai.yaml
workflow=$repo_dir/.github/workflows/verify.yml
tutorial=$repo_dir/docs/TUTORIAL.zh-CN.md

for required in \
  "$manifest" "$mcp_manifest" "$config" "$server" "$skill" "$architecture" \
  "$contracts" "$ui" "$workflow" "$tutorial" \
  "$repo_dir/docs/assets/sol-subagent-control-console.png" \
  "$repo_dir/docs/assets/sol-subagent-task-types.png" \
  "$control/package.json" \
  "$control/open-console.mjs" \
  "$control/connectors/cursor-cdp.mjs" \
  "$control/connectors/cursor-profile.mjs" \
  "$control/connectors/cdp-client.mjs" \
  "$control/connectors/websocket-client.mjs" \
  "$control/connectors/grok-acp.mjs" \
  "$control/connectors/registry.mjs" \
  "$control/connectors/scope-guard.mjs" \
  "$control/connectors/task-store.mjs" \
  "$control/lib/config.mjs" "$control/lib/control.mjs" \
  "$control/lib/providers.mjs" "$control/lib/templates.mjs" \
  "$control/test/connector-integration.test.mjs" \
  "$control/test/open-console.test.mjs" \
  "$control/test/run-tests.mjs" \
  "$control/test/fixtures/fake-cursor.mjs" \
  "$control/test/fixtures/fake-grok.mjs" \
  "$control/web/index.html" "$control/web/app.js" "$control/web/styles.css" \
  "$plugin_dir/scripts/open-control-console.cmd" \
  "$plugin_dir/scripts/open-control-console.sh"; do
  test -f "$required" || fail "required control-plane file missing: $required"
done
pass "control-plane files present"

jq empty "$manifest"
jq empty "$mcp_manifest"
jq empty "$config"
jq empty "$control/package.json"
[ "$(jq -r '.version' "$manifest")" = 0.7.1 ] || fail "native manifest version drifted"
[ "$(jq -r '.mcpServers' "$manifest")" = './.mcp.json' ] || fail "plugin manifest does not load control-plane MCP"
[ "$(jq -r '.mcpServers["sol-control-plane"].command' "$mcp_manifest")" = node ] || fail "control-plane MCP does not use node"
[ "$(jq -r '.mcpServers["sol-control-plane"].enabled' "$mcp_manifest")" = true ] || fail "control-plane MCP is disabled"
[ "$(jq -r '.mcpServers["sol-control-plane"].cwd' "$mcp_manifest")" = . ] || fail "control-plane MCP does not launch from plugin root"
[ "$(jq -r '.mcpServers["sol-control-plane"].args[0]' "$mcp_manifest")" = './control-plane/server.mjs' ] || fail "control-plane MCP entrypoint is not plugin-root relative"
jq -e '.mcpServers["sol-control-plane"].env_vars | index("CODEX_HOME") and index("USERPROFILE")' "$mcp_manifest" >/dev/null || fail "control-plane MCP does not inherit the global Codex environment"
[ "$(jq -r '.mcpServers["sol-control-plane"].default_tools_approval_mode' "$mcp_manifest")" = approve ] || fail "control-plane MCP is not approval-gated"
pass "plugin and MCP manifests are valid"

python3 - "$manifest" "$ui" <<'PY'
import json
from pathlib import Path
import sys
manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
for value in manifest["interface"]["defaultPrompt"]:
    if len(value) > 128:
        raise SystemExit(f"manifest defaultPrompt exceeds 128 characters: {len(value)}")
yaml_text = Path(sys.argv[2]).read_text(encoding="utf-8")
line = next(line for line in yaml_text.splitlines() if line.strip().startswith("default_prompt:"))
value = line.split(":", 1)[1].strip().strip('"')
if len(value) > 128:
    raise SystemExit(f"skill default_prompt exceeds 128 characters: {len(value)}")
print("default prompts fit the 128-character host cap")
PY
pass "plugin and skill prompt lengths"

jq -e '.version == 3 and .global.enabled == true and .global.allow_direct_api == false and (.scenarios | not)' "$config" >/dev/null || fail "default global switches or schema are unsafe"
jq -e '[.providers[] | select(.kind != "native_agent") | .enabled] | all(. == false)' "$config" >/dev/null || fail "a non-native provider is enabled by default"
jq -e '.providers[] | select(.id == "native-luna" and .enabled == true)' "$config" >/dev/null || fail "native Luna default missing"
jq -e '.providers[] | select(.id == "native-terra" and .enabled == true)' "$config" >/dev/null || fail "native Terra default missing"
jq -e '.providers[] | select(.id == "native-sol-reviewer" and .enabled == true)' "$config" >/dev/null || fail "native Sol reviewer default missing"
jq -e '.providers[] | select(.id == "cursor-local" and .kind == "builtin_connector" and .enabled == false and .requires_user_approval == true and .capabilities.write == true and .config.connector == "cursor_cdp" and .config.transport == "cdp_ui")' "$config" >/dev/null || fail "built-in Cursor default is missing or unsafe"
jq -e '.providers[] | select(.id == "grok-local" and .kind == "builtin_connector" and .enabled == false and .requires_user_approval == true and .capabilities.write == true and .config.connector == "grok_acp" and .config.transport == "leader_acp_stdio")' "$config" >/dev/null || fail "built-in Grok default is missing or unsafe"
jq -e '[.task_types[] | select((.id + " " + .name + " " + .description + " " + (.tags | join(" "))) | test("cursor|grok|chatgpt|luna|terra|openai"; "i"))] | length == 0' "$config" >/dev/null || fail "default Task Type metadata is Provider-specific"
jq -e 'all(.task_types[]; (.route == "solo" and (.stages|length)==0) or (.route == "delegate" and (.stages|length)==1 and .stages[0].id=="implementation" and .stages[0].role=="implementer") or (.route == "audit" and (.stages|length)==1 and .stages[0].id=="review" and .stages[0].role=="reviewer") or (.route == "full" and (.stages|length)==2 and .stages[0].id=="implementation" and .stages[1].id=="review"))' "$config" >/dev/null || fail "Task Type route topology is invalid"
if grep -Eqi '"sk-[A-Za-z0-9_-]{20,}"' "$config"; then fail "default config appears to contain a credential value"; fi
jq -e '.providers[] | select(.kind == "openai_compatible") | .config.api_key_env | test("^[A-Z_][A-Z0-9_]*$")' "$config" >/dev/null || fail "API provider does not use an environment-variable name"
pass "safe Provider defaults and model-independent Task Types"

for phrase in \
  'sol_control_status' \
  'sol_control_console' \
  'sol_control_resolve' \
  'sol_connector_probe' \
  'sol_connector_start' \
  'sol_connector_status' \
  'sol_connector_control' \
  'Prompt templates, provider endpoints, credential variable names, and console tokens are never returned'; do
  grep -Fq "$phrase" "$server" || fail "server omits required contract: $phrase"
done
for phrase in \
  'Read metadata, not the prompt library' \
  'Write access opens only when all three facts are true' \
  'Unified built-in connector contract' \
  'Built-in Cursor connector' \
  'Built-in Grok connector' \
  'Use hard-path web advice only after a real signal' \
  'Auxiliary work substitutes for root work'; do
  grep -Fq "$phrase" "$skill" || fail "control-plane skill omits: $phrase"
done
for phrase in \
  'This is minimization, not a hostile-model secrecy sandbox' \
  'Minimal Cursor connection' \
  'Minimal Grok connection' \
  'unknown_after_restart' \
  'prevented_attempts'; do
  grep -Fq "$phrase" "$architecture" || fail "architecture omits: $phrase"
done
for phrase in \
  'builtin_connector`: Cursor CDP' \
  'builtin_connector`: Grok ACP' \
  'expected_agent_id' \
  'expected_session_id' \
  'outside_paths'; do
  grep -Fq "$phrase" "$contracts" || fail "provider contracts omit: $phrase"
done
grep -Fq 'windows-latest' "$workflow" || fail "CI does not cover Windows"
grep -Fq 'ubuntu-latest' "$workflow" || fail "CI does not cover Linux"
grep -Fq 'connector-protocol-' "$workflow" || fail "CI does not expose connector protocol matrix"
pass "prompt minimization, connector contracts, and dual-platform CI documented"

node --check "$server"
node --check "$control/open-console.mjs"
for file in "$control"/lib/*.mjs "$control"/connectors/*.mjs "$control"/web/app.js; do
  node --check "$file"
done
node "$control/test/run-tests.mjs"
pass "Node syntax and control-plane tests"

sh -n "$script_dir/verify-control-plane.sh"
pass "verification script syntax"

printf '%s\n' "VERIFY PASSED: Sol Subagent Control extension checks completed"
