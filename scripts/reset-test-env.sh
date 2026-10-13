#!/usr/bin/env bash
# Reset the stub test environment to a clean state before a smoke run:
# stop agent processes on the stand-in hosts, reset the demo checkouts, clear
# stub vendor state and the hub database. Keeps users, keys, certs and config.
set -uo pipefail
HUB_USER="${HUB_USER:-${SUDO_USER:-root}}"
HUB_HOME="$(getent passwd "$HUB_USER" | cut -d: -f6)"
DATA="${HUB_DATA_DIR:-$HUB_HOME/.agent-hub}"

pkill -f "hub/dist/index.js" 2>/dev/null
for u in hosta hostb; do
  h="$(getent passwd "$u" | cut -d: -f6)"
  sudo -u "$u" tmux kill-server 2>/dev/null
  pkill -u "$u" -f "stub-codex.mjs|stub-claude.mjs|hub_channel.py|server.py" 2>/dev/null
  sudo -u "$u" bash -c "
    cd '$h' || exit 0
    rm -rf .agent-hub
    for d in .claude-personal .claude-work .codex .codex-work; do
      [ -d \"\$d\" ] && find \"\$d\" -mindepth 1 -maxdepth 1 ! -name .stub-auth.json -exec rm -rf {} +
    done
    for r in code/*; do
      [ -d \"\$r/.git\" ] || continue
      git -C \"\$r\" worktree prune
      b=\$(git -C \"\$r\" rev-parse --abbrev-ref HEAD)
      git -C \"\$r\" reset -q --hard \"origin/main\" && git -C \"\$r\" clean -qfdx
      echo '- [ ] scratch note (uncommitted)' >> \"\$r/NOTES.md\"
    done
  "
done
rm -f "$DATA"/hub.sqlite*
rm -rf "$DATA/apps" "$DATA/ssh-ctl"
for a in personal work; do
  rm -rf "$DATA/profiles/$a/claude/stub-cloud" "$DATA/profiles/$a/codex/stub-cloud" "$DATA/profiles/$a/scratch"
done
echo "test env reset"
