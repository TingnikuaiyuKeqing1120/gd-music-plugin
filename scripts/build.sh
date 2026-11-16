#!/usr/bin/env bash
# Build the GD helper for this machine into bin/.
# Needs Go (see helper-src/go.mod) and, at runtime, Chrome or Edge.
set -euo pipefail
cd "$(dirname "$0")/../helper-src"
out="../bin/gd-helper"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) out="../bin/gd-helper.exe" ;;
esac
go build -trimpath -ldflags "-s -w" -o "$out" .
echo "built $out"