#!/usr/bin/env bash
# Builds the Swift bridge (Apple Silicon, macOS 26+, Xcode 26+) and copies it to ./bin/fm-bridge
set -euo pipefail
cd "$(dirname "$0")/../swift"
swift build -c release --arch arm64
BIN_DIR="$(swift build -c release --arch arm64 --show-bin-path)"
mkdir -p ../bin
cp "$BIN_DIR/fm-bridge" ../bin/fm-bridge
chmod +x ../bin/fm-bridge
echo "Built ../bin/fm-bridge"
"../bin/fm-bridge" --check || true
