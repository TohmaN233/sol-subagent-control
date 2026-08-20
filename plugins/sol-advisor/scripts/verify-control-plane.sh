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

for required in \
  "$manifest" "$mcp_manifest" "$config" "$server" "$skill" "$architecture" \
  "$contracts" "$ui" "$workflow" "$control/package.json" \
  "$control/lib/config.mjs" "$control/lib/control.mjs" \
  "$control/lib/providers.mjs" "$control/lib/templates.mjs" \
  "$control/web/index.html" "$control/web/app.js" "$control/web/styles.css"; do
  test -f "$required" || fail "required control-plane file missing: $required"
done
pass "control-plane files present"

jq empty "$manifest"
jq empty "$mcp_manifest"
jq empty "$config"
jq empty "$control/package.json"
[ "$(jq -r '.version' "$manifest")" = 0.6.0 ] || fail "native manifest version drifted"
[ "$(jq -r '.mcpServers' "$manifest")" = './.mcp.json' ] || fail "plugin manifest does not load control-plane MCP"
[ "$(jq -r '.mcpServers["sol-control-plane"].command' "$mcp_manifest")" = node ] || fail "control-plane MCP does not use node"
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

jq -e '.version == 1 and .global.enabled == true and .global.allow_direct_api == false' "$config" >/dev/null || fail "default global switches are unsafe"
jq -e '[.providers[] | select(.kind != "native_agent") | .enabled] | all(. == false)' "$config" >/dev/null || fail "an external provider is enabled by default"
jq -e '.providers[] | select(.id == "native-luna" and .enabled == true)' "$config" >/dev/null || fail "native Luna default missing"
jq -e '.providers[] | select(.id == "native-terra" and .enabled == true)' "$config" >/dev/null || fail "native Terra default missing"
jq -e '.providers[] | select(.id == "native-sol-reviewer" and .enabled == true)' "$config" >/dev/null || fail "native Sol reviewer default missing"
jq -e '.scenarios[] | select(.id == "bounded-code-change" and .provider_id == "native-luna" and .enabled == true)' "$config" >/dev/null || fail "bounded scenario is not mapped to native Luna"
jq -e '.scenarios[] | select(.id == "cross-review" and .provider_id == "native-sol-reviewer" and .enabled == true)' "$config" >/dev/null || fail "cross-review scenario is not mapped to native Sol"
jq -e '.scenarios[] | select(.id == "hard-path-web-advice" and .enabled == false and .requires_user_approval == true)' "$config" >/dev/null || fail "hard-path web advice is not disabled and approval-gated"
if grep -Eqi '"sk-[A-Za-z0-9_-]{20,}"' "$config"; then
  fail "default config appears to contain a credential value"
fi
jq -e '.providers[] | select(.kind == "openai_compatible") | .config.api_key_env | test("^[A-Z_][A-Z0-9_]*$")' "$config" >/dev/null || fail "API provider does not use an environment-variable name"
pass "safe native defaults and default-off external providers"

for phrase in \
  'sol_control_status' \
  'sol_control_console' \
  'sol_control_resolve' \
  'sol_control_invoke' \
  'Prompt templates, provider endpoints, credential variable names, and console tokens are never returned'; do
  grep -Fq "$phrase" "$server" || fail "server omits required contract: $phrase"
done
grep -Fq 'supports only openai_compatible providers' "$control/lib/control.mjs" || fail "direct invocation kind gate missing"
for phrase in \
  'Read metadata, not the prompt library' \
  'auto-enable an external provider' \
  'Resolve exactly the selected template' \
  'Use the hard-path web scenario only after at least one material signal' \
  'API keys remain in environment variables' \
  'Auxiliary work substitutes for root work'; do
  grep -Fq "$phrase" "$skill" || fail "control-plane skill omits: $phrase"
done
grep -Fq 'This is minimization, not a hostile-model secrecy sandbox' "$architecture" || fail "architecture overclaims template isolation"
grep -Fq 'Cursor user-selected model' "$config" || fail "Cursor model-selection boundary missing"
grep -Fq "Cursor's model is selected by the user's Cursor configuration" "$contracts" || fail "provider contracts invent Cursor per-call model selection"
pass "prompt minimization, provider boundaries, and hard-path gate documented"

node --check "$server"
for file in "$control"/lib/*.mjs "$control"/web/app.js; do
  node --check "$file"
done
node --test "$control"/test/*.test.mjs
pass "Node syntax and control-plane tests"

sh -n "$script_dir/verify-control-plane.sh"
pass "verification script syntax"

printf '%s\n' "VERIFY PASSED: Sol Subagent Control extension checks completed"
