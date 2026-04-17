#!/usr/bin/env bash
# Re-sync vendored Codex schemas from the codex-src submodule.
#
# Why vendor instead of symlink: codex-src is a git submodule pinned to a
# specific upstream commit. Symlinking means the validator stops working
# the moment a contributor hasn't checked out the submodule. Vendoring
# makes the validator self-contained, and running this script produces a
# reviewable diff when upstream drifts.
#
# Run from anywhere:
#   bash testing/codex-validator/schemas/update.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
SRC="$REPO_ROOT/codex-src/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json"
DST="$SCRIPT_DIR/codex-v2.schemas.json"

if [[ ! -f "$SRC" ]]; then
  echo "error: upstream schema not found at $SRC" >&2
  echo "hint: git submodule update --init codex-src" >&2
  exit 1
fi

cp "$SRC" "$DST"
echo "vendored $(basename "$DST") from codex-src"
