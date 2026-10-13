#!/usr/bin/env bash
# Reset the stub test environment to a clean state before a smoke run:
# stop agent processes on the stand-in hosts, reset the demo checkouts, clear
# stub vendor state and the hub database. Keeps users, keys, certs and config.
set -uo pipefail
HUB_USER="${HUB_USER:-${SUDO_USER:-root}}"
HUB_HOME="$(getent passwd "$HUB_USER" | cut -d: -f6)"
DATA="${HUB_DATA_DIR:-$HUB_HOME/.agent-hub}"

pkill -f "^[^ ]*node .*hub/dist/index.js" 2>/dev/null
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
# "GitHub" remotes: keep main and the two feature branches (reset to main), drop everything pushed since
for r in /srv/agent-hub-git/*.git; do
  [ -d "$r" ] || continue
  git --git-dir "$r" for-each-ref --format='%(refname:short)' refs/heads | while read -r b; do
    case "$b" in main) ;; feat/winch-console|feat/coil-sweep) git --git-dir "$r" update-ref "refs/heads/$b" refs/heads/main ;; *) git --git-dir "$r" update-ref -d "refs/heads/$b" ;; esac
  done
done
for u in hosta hostb; do
  h="$(getent passwd "$u" | cut -d: -f6)"
  rm -rf "$h"/code/*.worktrees
  for r in "$h"/code/*/; do sudo -u "$u" git -C "$r" worktree prune 2>/dev/null; sudo -u "$u" git -C "$r" fetch -q --prune origin 2>/dev/null; done
  rm -f "$h/.sim/gpu-load"
done
rm -f "$DATA"/hub.sqlite*
rm -rf "$DATA/apps" "$DATA/ssh-ctl"
for a in personal work; do
  rm -rf "$DATA/profiles/$a/claude/stub-cloud" "$DATA/profiles/$a/codex/stub-cloud" "$DATA/profiles/$a/scratch"
done
echo "test env reset"
