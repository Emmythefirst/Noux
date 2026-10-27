#!/bin/sh
# Container entrypoint: one image, several apps. Pick the app with the APP env var (default: api).
# Avoids relying on a platform "Docker Command" field (quoting there is platform-specific).
set -e
APP="${APP:-api}"
case "$APP" in
  api|demo-merchant) ;;
  *) echo "unknown APP '$APP' (expected: api | demo-merchant)" >&2; exit 2 ;;
esac
cd "/app/apps/$APP"
exec ./node_modules/.bin/tsx src/server.ts
