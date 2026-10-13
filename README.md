# Agent Hub (AgentCanvas)

One canvas for every Claude Code and Codex session on your machines and in both vendor clouds. Agent Hub is a second front end on the vendors' own session stores: every session it starts lives where the native apps already look (claude.ai Remote Control, the shared Codex daemon, the vendor clouds), so you can move between the hub and the native apps without a handoff.

```
browser (PWA) ──Tailscale──▶ hub (one Node process + SQLite on an always-on host)
                               ├─ SSH (ControlMaster) ─▶ host: claude in tmux + hub channel · codex app-server daemon
                               ├─ hooks ◀── hosts (HTTP)          └─ app MCP servers (stdio over SSH)
                               └─ claude --cloud / codex cloud (run on the hub, per account profile)
```

- `hub/`: the hub. TypeScript; `node:sqlite`; the system `ssh`; `ws`; Playwright for app screenshots; web-push.
- `web/`: the PWA canvas (React + Vite): manifest, plus a service worker for app-shell caching and push only.
- `host-files/hub_channel.py`: the one script the hub copies to each host. It is the channel/MCP server and relay, written against the Python 3 standard library only.
- `stubs/`: stub `claude` and `codex` CLIs that speak the real protocols, used by the smoke test.
- `apps/winch-console/`: the demo app, an MCP Apps server driving a simulated winch.
- `docs/`: `API.md` (PWA↔hub contract), `DECISIONS.md`, `OPEN-QUESTIONS.md` (real-CLI behavior still to verify), `PROGRESS.md`, `screenshots/`.

## Build and test

```bash
npm ci
npm run build          # hub (tsc) + web (vite)
npm test               # unit tests: JSON-RPC framing, hook/channel payloads, app.json validator, actuate tiers
```

Requires Node ≥ 22.13 (for `node:sqlite`), OpenSSH client, and git. App screenshots need Chromium; set `screenshot.chromiumPath`, or run `npx playwright-core install chromium` and leave it empty.

### Smoke test against the stubs (a throwaway VM or CI box, as root)

```bash
sudo bash scripts/setup-test-env.sh   # users hosta/hostb + sshd + keys + TLS + stub CLIs + demo repos + config/hub.config.json
node scripts/smoke.mjs                # resets state, starts the hub, drives the PWA with Playwright
```

`setup-test-env.sh` creates two local users as stand-in hosts, so do not run it on a machine you care about.

## Install on a real Linux host (the always-on mini PC)

The hub runs as an ordinary user. It needs no root and no API keys: every turn runs through the official `claude` and `codex` binaries, signed in with your subscriptions.

### 1. User and code

```bash
sudo adduser --disabled-password hub          # the hub's own user; no sudo
sudo -iu hub
git clone <this repo> agent-hub && cd agent-hub
npm ci && npm run build && npm test
ssh-keygen -t ed25519 -f ~/.agent-hub/ssh/id_ed25519 -N ''   # the hub's SSH key
```

### 2. Hosts (each mini PC, cloud VM, GPU node, laptop WSL2)

Each host needs only the vendor CLIs, `tmux`, `git` and `python3`. Nothing of ours is installed there; the hub copies `~/.agent-hub/{hub_channel.py,hub.env,claude-settings.json,mcp.json}` on first use and adds a marked `[mcp_servers.hub]` block to each Codex `config.toml`.

1. Create (or reuse) a login user without sudo, and add the hub's public key to its `~/.ssh/authorized_keys`. With Tailscale SSH, allow the hub's node in your tailnet ACLs instead.
2. Install the CLIs:
   - Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
   - Codex: the packaged npm or brew install. `codex app-server daemon start` refuses a bare binary.
3. **Log in once per account profile.** Each account is a profile with its own `CLAUDE_CONFIG_DIR` and `CODEX_HOME`:
   ```bash
   CLAUDE_CONFIG_DIR=~/.claude-personal claude      # /login with the personal claude.ai account
   CLAUDE_CONFIG_DIR=~/.claude-work     claude      # /login with the company account
   CODEX_HOME=~/.codex      codex login             # main ChatGPT account (the desktop app attaches to ~/.codex)
   CODEX_HOME=~/.codex-work codex login
   ```
   Subscription logins only. Do not set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; the hub has no API-key code path, and Remote Control and channels require claude.ai auth.
4. Optional: in each Claude profile, set `"remoteControlAtStartup": true` in `settings.json`. The hub passes `--remote-control` anyway. It answers the one-time Remote Control prompt and the dev-channel warning through tmux on the first launch per host and profile. Disable that with `"autoAnswerStartupPrompts": false`.

### 3. Configure the hub

Copy `config/hub.config.example.json` to `config/hub.config.json` and edit it:

- `hosts[]`: `{ id, target: "user@minipc-a", roots: ["~/code"], color }`. `roots` are scanned for git checkouts and for `apps/*/app.json`.
- `accounts[]`: one per profile. Each has `claude.configDir` and `codex.home` (paths on the hosts), `git` identity, `gh.hostAlias`, and `hub.{claudeConfigDir,codexHome,scratchDir}` (paths on the hub for the cloud CLIs; log those in too, as in step 2.3, but on the hub).
- `accounts[].cloud.codexEnvironments`: the env ids or labels you use with `codex cloud exec --env` (take them from the `codex cloud` picker). `cloud.claudeEnvironments` lists the names shown in the spawn dialog; `claude --cloud` uses the account's default environment.
- `adapters`: the CLI binaries (see "Switching from stubs to real CLIs").

**Adding a host or an account** is the same edit: add the entry, then restart the hub (`systemctl --user restart agent-hub`). Hosts appear within 30 s, and their checkouts on the next repo scan. Check SSH first with `ssh -i ~/.agent-hub/ssh/id_ed25519 user@host true`.

### 4. HTTPS with `tailscale serve`

Let Tailscale terminate TLS and keep the hub on localhost:

```jsonc
"listen": { "host": "127.0.0.1", "port": 8443 },
"tls": null,
"publicUrl": "https://minipc-a.<tailnet>.ts.net",
"hostCallbackUrl": "https://minipc-a.<tailnet>.ts.net",   // hosts POST hooks + hub tool calls here
"cloudCallbackUrl": "https://minipc-a.<tailnet>.ts.net"   // only if cloud repo hooks should reach the hub (Funnel/tunnel)
```

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8443
```

A self-signed certificate also works (`tls: {cert, key, ca}`): the hub copies `ca` to the hosts, and `hub_channel.py` plus the Claude hooks trust it (`HUB_CA_FILE` and `NODE_EXTRA_CA_CERTS` in `~/.agent-hub/hub.env`).

### 5. Run

```bash
node hub/dist/index.js config/hub.config.json
# or as a user service:
systemctl --user enable --now agent-hub   # ExecStart=/usr/bin/node %h/agent-hub/hub/dist/index.js %h/agent-hub/config/hub.config.json
loginctl enable-linger hub                 # keep it running without a login session
```

Open `https://<publicUrl>/login?token=<hubToken>`. The token is in `~/.agent-hub/secrets.json` (generated on first start, along with the hook tokens and the VAPID push keys). Then install the PWA from the browser menu and turn on notifications.

### Claude cloud progress hooks (optional)

Cloud sessions report back only through HTTP hooks committed in the repo's `.claude/settings.json`. That file is the `hooks` block from `scripts/seed/hexapod-robot/.claude/settings.json`, with the URL set to your `cloudCallbackUrl` + `/hooks/cloud`. Store the `cloudHookToken` from `secrets.json` as the network secret `HUB_CLOUD_HOOK_TOKEN` in the claude.ai cloud environment, and allow the hub's host in that environment's network allowlist.

## Switching from stubs to real CLIs

Every vendor CLI invocation is built and parsed in one place, `hub/src/adapters.ts`. Which binaries run is pure config:

```jsonc
"adapters": {
  "claude": { "bin": "claude", "cloudBin": "claude" },   // stubs: "/opt/agent-hub-stubs/bin/claude"
  "codex":  { "bin": "codex",  "cloudBin": "codex"  }    // stubs: "/opt/agent-hub-stubs/bin/codex"
}
```

- `bin` is resolved on each host (per-host override: `hosts[].bins.{claude,codex,python,git,tmux}`).
- `cloudBin` runs on the hub.

After switching, work through the gating tests in `docs/OPEN-QUESTIONS.md` on one host first. That file lists every real-CLI behavior the stubs assumed.

## Security model (short)

- Only the PWA (hub token, an HttpOnly + Secure + SameSite=Strict cookie) can drive sessions.
- Hosts use a separate hook token, and cloud hooks a third token scoped to `/hooks/cloud`.
- The channel socket is 0600 inside a 0700 directory and reachable only over the hub's SSH connection.
- App UIs run in `sandbox="allow-scripts allow-forms"` iframes, without same-origin, under a deny-by-default CSP. Every tool call goes through the hub, which applies tiers (`read` and `actuate`), confirm, a rate limit, and an audit with the caller.
- Apps always start read-only; only you can promote an app and grant it actuate, and only in the hub. Interlocks belong in the device-side server; the E-stop stays physical.
