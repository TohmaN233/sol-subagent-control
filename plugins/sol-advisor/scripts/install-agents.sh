#!/bin/sh
# Linux compatibility wrapper for the cross-platform native-role installer.

set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
exec node "$script_dir/install-agents.mjs" "$@"
