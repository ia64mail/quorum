#!/usr/bin/env bash
set -euo pipefail

# Authenticate gh CLI with the PAT and configure git's credential helper,
# then strip the raw token from the env so the NestJS process (and by
# extension the SDK subprocess) never sees it. The credential persists at
# ~/.config/gh/hosts.yml on tmpfs — re-created from GH_TOKEN on every
# container start.
if [ -n "${GH_TOKEN:-}" ]; then
  # gh refuses to persist credentials while GH_TOKEN is in env (it treats the
  # env var as authoritative). Capture, unset, then pipe — otherwise gh exits
  # non-zero and `set -euo pipefail` aborts the entrypoint.
  _token="$GH_TOKEN"
  unset GH_TOKEN
  echo "$_token" | gh auth login --with-token
  unset _token
  # gh auth setup-git writes the credential helper to ~/.gitconfig by default,
  # but the rootfs is read_only. Redirect git's global config to a tmpfs path
  # declared in x-base-security so the write succeeds. The export propagates
  # to descendant processes (NestJS, InvocationHandler git ops) automatically.
  mkdir -p /home/quorum/.config/git
  export GIT_CONFIG_GLOBAL=/home/quorum/.config/git/config
  gh auth setup-git          # configures git credential helper → gh
  echo "gh auth: logged in, credential helper configured, GH_TOKEN unset"
else
  echo "WARN: GH_TOKEN not set — git operations requiring auth will fail" >&2
fi

# Preserve the original CMD behavior (create debug dir on tmpfs)
mkdir -p /home/quorum/.claude/debug

exec node dist/main.js
