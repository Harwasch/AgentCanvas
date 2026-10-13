#!/usr/bin/env bash
# Test environment for the stub smoke test (cloud VM / CI). NOT for production.
#  - two local users stand in for two hosts (mini-1 = hosta, mini-2 = hostb), reached over SSH
#  - stub vendor CLIs installed under /opt/agent-hub-stubs (stand-ins for `claude` / `codex`)
#  - demo git repos with file:// "GitHub" remotes
#  - self-signed TLS cert for the PWA
#  - writes config/hub.config.json pointing the adapters at the stubs
# Idempotent. Run as root (sudo).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HUB_USER="${HUB_USER:-${SUDO_USER:-root}}"
HUB_HOME="$(getent passwd "$HUB_USER" | cut -d: -f6)"
DATA="${HUB_DATA_DIR:-$HUB_HOME/.agent-hub}"
STUBS=/opt/agent-hub-stubs
GITSRV=/srv/agent-hub-git
NODE_BIN="$(command -v node)"
PORT="${HUB_PORT:-8443}"

need() { command -v "$1" >/dev/null 2>&1; }
if ! need sshd && [ ! -x /usr/sbin/sshd ] || ! need tmux || ! need git || ! need python3 || ! need openssl; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server openssh-client tmux git python3 openssl >/dev/null
fi

# --- users (no sudo) ---------------------------------------------------------
for u in hosta hostb; do
  id "$u" >/dev/null 2>&1 || useradd -m -s /bin/bash "$u"
done

# --- hub ssh key -------------------------------------------------------------
install -d -m 700 -o "$HUB_USER" "$DATA" "$DATA/ssh" "$DATA/tls"
[ -f "$DATA/ssh/id_ed25519" ] || sudo -u "$HUB_USER" ssh-keygen -q -t ed25519 -N '' -C agent-hub -f "$DATA/ssh/id_ed25519"
for u in hosta hostb; do
  h="$(getent passwd "$u" | cut -d: -f6)"
  install -d -m 700 -o "$u" -g "$u" "$h/.ssh"
  grep -qF "$(cut -d' ' -f2 "$DATA/ssh/id_ed25519.pub")" "$h/.ssh/authorized_keys" 2>/dev/null || cat "$DATA/ssh/id_ed25519.pub" >> "$h/.ssh/authorized_keys"
  chown "$u:$u" "$h/.ssh/authorized_keys"; chmod 600 "$h/.ssh/authorized_keys"
done

# --- sshd --------------------------------------------------------------------
mkdir -p /run/sshd
[ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -A
if ! pgrep -x sshd >/dev/null; then /usr/sbin/sshd; fi

# --- TLS (self-signed; replace with `tailscale serve` in production) -----------
if [ ! -f "$DATA/tls/cert.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$DATA/tls/key.pem" -out "$DATA/tls/cert.pem" 2>/dev/null
  chown -R "$HUB_USER" "$DATA/tls"; chmod 600 "$DATA/tls/key.pem"
fi

# --- stub vendor CLIs ----------------------------------------------------------
rm -rf "$STUBS"; mkdir -p "$STUBS/bin" "$STUBS/lib"
cp -r "$REPO/stubs/." "$STUBS/lib/"
mkdir -p "$STUBS/lib/demo-apps" && cp -r "$REPO/apps/." "$STUBS/lib/demo-apps/"
mkdir -p "$STUBS/lib/node_modules"
cp -r "$REPO/node_modules/ws" "$STUBS/lib/node_modules/"
cat > "$STUBS/bin/claude" <<EOF
#!/bin/sh
exec "$NODE_BIN" --no-warnings "$STUBS/lib/stub-claude.mjs" "\$@"
EOF
cat > "$STUBS/bin/codex" <<EOF
#!/bin/sh
exec "$NODE_BIN" --no-warnings "$STUBS/lib/stub-codex.mjs" "\$@"
EOF
chmod -R a+rX "$STUBS"; chmod 755 "$STUBS/bin/"*
chmod a+rx "$(dirname "$NODE_BIN")" "$NODE_BIN"

# --- demo repos with file:// remotes -----------------------------------------
mkdir -p "$GITSRV"
mkrepo() { # name, seed-dir
  local name="$1"
  if [ ! -d "$GITSRV/$name.git" ]; then
    local tmp; tmp="$(mktemp -d)"
    git -C "$tmp" init -q -b main
    cp -r "$REPO/scripts/seed/$name/." "$tmp/"
    git -C "$tmp" add -A
    git -C "$tmp" -c user.name=seed -c user.email=seed@example.com commit -qm "Initial import of $name"
    git clone -q --bare "$tmp" "$GITSRV/$name.git"
    rm -rf "$tmp"
  fi
}
mkrepo hexapod-robot
mkrepo wpt-charger
chmod -R a+rX "$GITSRV"
git config --system --add safe.directory '*' 2>/dev/null || true

clone_for() { # user repo branch
  local u="$1" name="$2" br="$3" h; h="$(getent passwd "$u" | cut -d: -f6)"
  if [ ! -d "$h/code/$name/.git" ]; then
    sudo -u "$u" mkdir -p "$h/code"
    sudo -u "$u" git clone -q "file://$GITSRV/$name.git" "$h/code/$name"
    sudo -u "$u" git -C "$h/code/$name" checkout -q -b "$br"
    sudo -u "$u" git -C "$h/code/$name" config user.name "$u"
    sudo -u "$u" git -C "$h/code/$name" config user.email "$u@example.com"
    echo "- [ ] scratch note (uncommitted)" | sudo -u "$u" tee -a "$h/code/$name/NOTES.md" >/dev/null
  fi
}
clone_for hosta hexapod-robot feat/winch-console
clone_for hostb wpt-charger feat/coil-sweep

# --- per-account vendor profile dirs on hosts (stub "logins") ------------------
for u in hosta hostb; do
  h="$(getent passwd "$u" | cut -d: -f6)"
  for d in .claude-personal .claude-work .codex .codex-work; do
    sudo -u "$u" mkdir -p "$h/$d"
  done
  echo '{"stubLogin":"personal"}' | sudo -u "$u" tee "$h/.claude-personal/.stub-auth.json" "$h/.codex/.stub-auth.json" >/dev/null
  echo '{"stubLogin":"work"}' | sudo -u "$u" tee "$h/.claude-work/.stub-auth.json" "$h/.codex-work/.stub-auth.json" >/dev/null
done
# hub-side profiles for cloud adapters (stub "logins")
for a in personal work; do
  install -d -o "$HUB_USER" "$DATA/profiles/$a/claude" "$DATA/profiles/$a/codex" "$DATA/profiles/$a/scratch"
  echo "{\"stubLogin\":\"$a\"}" > "$DATA/profiles/$a/claude/.stub-auth.json"
  echo "{\"stubLogin\":\"$a\"}" > "$DATA/profiles/$a/codex/.stub-auth.json"
done

# --- hub config --------------------------------------------------------------
mkdir -p "$REPO/config"
cat > "$REPO/config/hub.config.json" <<EOF
{
  "listen": { "host": "0.0.0.0", "port": $PORT },
  "publicUrl": "https://localhost:$PORT",
  "hostCallbackUrl": "https://localhost:$PORT",
  "cloudCallbackUrl": "https://localhost:$PORT",
  "tls": { "cert": "$DATA/tls/cert.pem", "key": "$DATA/tls/key.pem", "ca": "$DATA/tls/cert.pem" },
  "dataDir": "$DATA",
  "adapters": {
    "claude": { "bin": "$STUBS/bin/claude", "cloudBin": "$STUBS/bin/claude" },
    "codex":  { "bin": "$STUBS/bin/codex",  "cloudBin": "$STUBS/bin/codex" }
  },
  "ssh": { "bin": "ssh", "identityFile": "$DATA/ssh/id_ed25519" },
  "hosts": [
    { "id": "mini-1", "label": "mini-1", "target": "hosta@localhost", "color": "#43D1B0", "roots": ["~/code"] },
    { "id": "mini-2", "label": "mini-2", "target": "hostb@localhost", "color": "#A6E15A", "roots": ["~/code"] }
  ],
  "accounts": [
    { "id": "personal", "label": "Personal", "color": "#6AA8FF",
      "claude": { "configDir": "~/.claude-personal" }, "codex": { "home": "~/.codex" },
      "git": { "name": "Personal", "email": "me@example.com" }, "gh": { "hostAlias": "github.com-personal" },
      "hub": { "claudeConfigDir": "$DATA/profiles/personal/claude", "codexHome": "$DATA/profiles/personal/codex", "scratchDir": "$DATA/profiles/personal/scratch" },
      "cloud": { "claudeEnvironments": [{ "id": "default", "label": "Default" }], "codexEnvironments": [{ "id": "env_hexapod", "label": "hexapod-ci" }] } },
    { "id": "work", "label": "Work", "color": "#E0896B",
      "claude": { "configDir": "~/.claude-work" }, "codex": { "home": "~/.codex-work" },
      "git": { "name": "Work", "email": "me@company.example" }, "gh": { "hostAlias": "github.com-work" },
      "hub": { "claudeConfigDir": "$DATA/profiles/work/claude", "codexHome": "$DATA/profiles/work/codex", "scratchDir": "$DATA/profiles/work/scratch" },
      "cloud": { "claudeEnvironments": [{ "id": "default", "label": "Default" }], "codexEnvironments": [{ "id": "env_work", "label": "work-ci" }] } }
  ],
  "screenshot": { "chromiumPath": "$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)" },
  "repoIndexIntervalSec": 30,
  "cloudPollIntervalSec": 3
}
EOF
chown "$HUB_USER" "$REPO/config/hub.config.json"
echo "test env ready: hosts hosta@localhost, hostb@localhost; config at config/hub.config.json"
