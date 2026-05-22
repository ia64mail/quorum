#!/usr/bin/env bash
set -euo pipefail

# Authenticate gh CLI with the PAT and configure git's credential helper,
# then strip the raw token from the env so the NestJS process (and by
# extension the SDK subprocess) never sees it. The credential persists at
# ~/.config/gh/hosts.yml on tmpfs — re-created from GH_TOKEN on every
# container start.
if [ -n "${GH_TOKEN:-}" ]; then
  echo "$GH_TOKEN" | gh auth login --with-token
  gh auth setup-git          # configures git credential helper → gh
  unset GH_TOKEN
  echo "gh auth: logged in, credential helper configured, GH_TOKEN unset"
else
  echo "WARN: GH_TOKEN not set — git operations requiring auth will fail" >&2
fi

# Preserve the original CMD behavior (create debug dir on tmpfs)
mkdir -p /home/quorum/.claude/debug

exec node dist/main.js
