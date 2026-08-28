#!/usr/bin/env bash
set -euo pipefail

# Scoped to what this Worker's deploy actually contains: cloudflare-worker itself, the shared
# @li/core package it imports, and web-push (served as this Worker's own Static Assets) — not
# the whole monorepo, so unrelated in-progress RN app work never blocks a Worker deploy.
if [[ -n "$(git status --porcelain -- . ../packages/core ../web-push)" ]]; then
  echo "Refusing to deploy: uncommitted changes in cloudflare-worker, packages/core, or web-push. Commit first." >&2
  exit 1
fi

SHA=$(git rev-parse --short HEAD)
MESSAGE=$(git log -1 --format=%s)
wrangler deploy --tag "$SHA" --message "$MESSAGE"
