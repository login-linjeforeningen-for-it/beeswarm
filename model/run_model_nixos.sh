#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if [ -z "${IN_NIX_SHELL:-}" ]; then
    export IN_NIX_SHELL=1
    exec nix-shell -p git cmake wget curl file lsof nodejs python3Packages.huggingface-hub --run "$0"
fi

exec "$SCRIPT_DIR/run_model_common.sh" nix
