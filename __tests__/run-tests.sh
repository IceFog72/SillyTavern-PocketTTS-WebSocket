#!/usr/bin/env bash
# Run PocketTTS WebSocket extension unit tests
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ST_ROOT="$(cd "$SCRIPT_DIR/../../../../../" && pwd)"
TESTS_DIR="$ST_ROOT/tests"

if [ ! -d "$TESTS_DIR/node_modules" ]; then
    echo "Installing SillyTavern test dependencies..."
    (cd "$TESTS_DIR" && npm install --silent)
fi

exec node --experimental-vm-modules "$TESTS_DIR/node_modules/.bin/jest" \
    --config "$SCRIPT_DIR/jest.config.js" \
    "$@"
