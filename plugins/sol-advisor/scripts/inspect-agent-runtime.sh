#!/bin/sh
# Linux compatibility wrapper for the cross-platform runtime evidence inspector.

set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
exec node "$script_dir/inspect-agent-runtime.mjs" "$@"
