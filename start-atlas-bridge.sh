#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=${1:-$PWD}
if [ "$#" -gt 0 ]; then shift; fi
exec node "$DIR/atlas-bridge.js" --allow-root "$ROOT" --app "$DIR/atlas-v1.0.0.html" "$@"
