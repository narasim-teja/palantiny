#!/usr/bin/env bash
# Builds the sensor as a signed .app. macOS only reveals Wi-Fi names to a real app
# bundle holding Location permission, so a bare CLI binary is not enough.
#
# The deployment target is explicit because this toolchain can default to a macOS
# version newer than the running system, which makes LaunchServices refuse the app.
#
# Skips the rebuild when nothing changed: ad-hoc signatures change with the binary,
# and a new signature can make macOS ask for permissions again.
set -euo pipefail
cd "$(dirname "$0")"

APP="build/palantiny-sensor.app"
BIN="$APP/Contents/MacOS/palantiny-sensor"

if [[ -x "$BIN" && "$BIN" -nt main.swift && "$BIN" -nt Info.plist ]]; then
  echo "sensor: up to date"
  exit 0
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -target "$(uname -m)-apple-macos14.0" main.swift -o "$BIN"
codesign --force --sign - --identifier dev.palantiny.sensor "$APP"
echo "sensor: built $APP"
