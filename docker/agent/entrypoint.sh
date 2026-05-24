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

# First-boot repo clone — idempotent via .git check.
# REPO_URL is injected from docker-compose env; clone authenticates via the
# gh credential helper configured above.
if [ ! -d /var/agent-repo/.git ]; then
  echo "First boot: cloning $REPO_URL into /var/agent-repo/"
  git clone "$REPO_URL" /var/agent-repo/
else
  echo "Repo already present at /var/agent-repo/"
fi

# Free all branch refs for worktree use — a regular clone checks out the
# default branch (main), so `git worktree add ... main` would fail with
# "fatal: 'main' is already checked out at '/var/agent-repo'".
# Detaching HEAD releases all branch refs while keeping the working tree
# and .git structure intact. Safe when HEAD is already detached (no-op).
# Runs on EVERY boot, not just first-boot — git fetch or other operations
# could leave HEAD on a branch after a restart.
cd /var/agent-repo && git checkout --detach && cd /app
echo "HEAD detached — branch refs freed for worktree use"

# Seed the code-review plugin into the agent's tmpfs ~/.claude/plugins on every
# boot. Source: the in-repo docker/plugins/code-review/ via the cloned base repo.
# Target path mirrors the moderator's installed cache layout so CC CLI's plugin
# resolver finds it the same way it does on the moderator. Without this,
# `Skill {"skill":"code-review:code-review"}` silently fails on agents and the
# /code-review pipeline never runs — see ticket #29.
# Uses global scope (not project) so the plugin is available regardless of SDK
# cwd under worktrees — see ticket #11 and architect design notes.
PLUGIN_SRC=/var/agent-repo/docker/plugins/code-review
PLUGIN_DIR=/home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown
if [ -d "$PLUGIN_SRC" ]; then
  mkdir -p "$PLUGIN_DIR"
  cp -r "$PLUGIN_SRC/." "$PLUGIN_DIR/"
  NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  cat > /home/quorum/.claude/plugins/installed_plugins.json <<EOF
{
  "version": 2,
  "plugins": {
    "code-review@claude-plugins-official": [
      {
        "scope": "global",
        "installPath": "$PLUGIN_DIR",
        "version": "unknown",
        "installedAt": "$NOW",
        "lastUpdated": "$NOW"
      }
    ]
  }
}
EOF
  echo "code-review plugin installed for agent session (global scope)"
else
  echo "WARN: $PLUGIN_SRC not found — /code-review skill will not be available" >&2
fi

# Clean orphan worktree tracking entries from prior SIGKILL/OOM.
# With tmpfs-backed worktrees, the files are already gone on restart —
# prune only cleans the stale tracking metadata in .git/worktrees/.
cd /var/agent-repo && git worktree prune && cd /app
echo "git worktree prune complete"

exec node dist/main.js
