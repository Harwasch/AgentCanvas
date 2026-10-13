# Agent Hub (AgentCanvas)

One canvas for every Claude Code and Codex session on your machines and in both vendor clouds. Agent Hub is a second front end on the vendors' own session stores: every session it starts lives where the native apps already look (claude.ai Remote Control, the shared Codex daemon, the vendor clouds), so you can move between the hub and the native apps without a handoff.

```
browser (PWA) ──Tailscale──▶ hub (one Node process + SQLite on an always-on host)
                               ├─ SSH (ControlMaster) ─▶ host: claude in tmux + hub channel · codex app-server daemon
                               ├─ hooks ◀── hosts (HTTP)          └─ app MCP servers (stdio over SSH)
                               └─ claude --cloud / codex cloud (run on the hub, per account profile)
```

- `hub/`: the hub. TypeScript; `node:sqlite`; the system `ssh`; `ws`; Playwright for app screenshots; web-push. GitHub through the `gh` CLI.
- `web/`: the PWA canvas (React + Vite): manifest, plus a service worker for app-shell caching and push only.
- `host-files/hub_channel.py`: the one script the hub copies to each host. It is the channel/MCP server and relay, written against the Python 3 standard library only.
- `stubs/`: stub `claude` and `codex` CLIs that speak the real protocols, used by the smoke test.
- `apps/winch-console/`: the demo app, an MCP Apps server driving a simulated winch.
- `docs/`: `API.md` (PWA↔hub contract), `DECISIONS.md`, `OPEN-QUESTIONS.md` (real-CLI behavior still to verify), `PROGRESS.md`, `screenshots/`.

**Getting it running on your machines:** hand `docs/RUNBOOK.md` to an agent on the hub machine. It is a phase-by-phase bring-up written for the agent, with clear checkpoints for the steps only you can do (logins, other machines, hardware).

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

### Clickable demo (no hub needed)

```bash
node scripts/build-demo.mjs        # → web/dist-demo/agent-hub-demo.html: one self-contained page
```

The page runs the real PWA against the in-page mock hub (simulated hosts, agents, GitHub, devices and the winch app), so you can open it anywhere, including as a hosted page. Locally, `?mock=1` on a normal build does the same.

## Canvas controls

| Action | Mouse / trackpad | Touch |
|---|---|---|
| Select an area (multiple nodes) | Left-drag on empty canvas (Shift adds to the selection) | — |
| Select / toggle a node | Click / Shift-click | Tap |
| Pan | Right- or middle-drag, or two-finger scroll | One-finger drag |
| Zoom | Scroll wheel, pinch | Pinch |
| Move a node (or the whole selection) | Drag it | Drag it |
| Move a node with all of its child nodes | Shift-drag it | — |
| Resize a node | Drag its bottom-right corner (double-click the corner to reset) | — |
| Add menu | Right-click (no drag) | — |
| Clear the selection | Esc, or click empty canvas | Tap empty canvas |

Layouts: **Cluster** (radial), **Columns** (top-down trees side by side), **Tree** (each group's tree runs left → right, groups stacked), **Custom** (your saved positions). Sizes you set apply in every layout; they are stored per node and per collapsed/expanded state.

## Ask Claude (agentic canvas)

**Ask Claude** (top bar), or **⌘J** for one line from anywhere, talks to one canvas-assistant conversation: a Claude session on a host and account you pick, with the hub's canvas tools. It uses your subscription, like every other session. All your devices share that conversation.

| Tier | What Claude can do | How |
|---|---|---|
| Free | `canvas_snapshot`, `hub_overview`, `canvas_move` / `canvas_arrange` / `canvas_resize`, `canvas_layout`, `canvas_focus`, `canvas_select`, `canvas_add_note`, `canvas_add_todo`, `canvas_open_file`, `canvas_remove` (notes, files, to-do lists) | Applies live; changed nodes glow; **Undo** on the pill or in the panel reverts the batch |
| Confirm | `hub_spawn_session`, `hub_send_message`, `hub_run_hil`, `hub_create_branch`, `hub_open_terminal` | The tool call waits for **Allow / Deny** in the panel (also in Needs you and web push) |
| Never | approving agents' tool calls, actuating hardware or apps | No tool exists; the assistant session is also refused `app_call`, `acquire_device`, `run_on_host`, `run_hil` |

Select nodes first and say "these"; the selection goes with the message. Agents on hosts get the same tools through the channel script.

### Use the canvas tools from Claude Code or Claude Desktop on your own machine

The hub serves the same tools at `https://<hub>/mcp` (Streamable HTTP, JSON responses), with its own bearer token: `mcpToken` in `<dataDir>/secrets.json`. That token is not the PWA token and not the host token.

```bash
# Claude Code
claude mcp add --transport http agent-hub https://hub.<tailnet>.ts.net/mcp --header "Authorization: Bearer <mcpToken>"
```

Claude Desktop's custom connectors are fetched from Anthropic's cloud, which cannot reach a tailnet. Run the stdio bridge locally instead; it is the same script the hub copies to hosts, and needs only Python 3:

```json
{ "mcpServers": { "agent-hub": {
  "command": "python3", "args": ["/path/to/AgentCanvas/host-files/hub_channel.py", "--external"],
  "env": { "HUB_MCP_URL": "https://hub.<tailnet>.ts.net/mcp", "HUB_MCP_TOKEN": "<mcpToken>" } } } }
```

Edits from those clients show up live in every open PWA, labelled with the client's name, and are undoable. Confirm-tier actions wait for you in the hub's Ask Claude panel.

## Install on a real Linux host (the always-on mini PC)

The hub runs as an ordinary user (yours). It needs no root and no API keys: every turn runs through the official `claude` and `codex` binaries, signed in with your subscriptions.

### 1. User and code

Run the hub as your own user. It keeps everything in `~/.agent-hub`: its SSH key, its secrets, and its own Claude, Codex and `gh` profiles, separate from your personal ones. On a machine other people use, a dedicated unprivileged user (`sudo adduser --disabled-password hub`) gives more isolation; the steps are the same.

```bash
git clone <this repo> ~/agent-hub && cd ~/agent-hub
npm ci && npm run build && npm test
ssh-keygen -t ed25519 -f ~/.agent-hub/ssh/id_ed25519 -N ''   # the hub's own SSH key (not your personal one)
sudo loginctl enable-linger $USER                             # keep the hub service running when you're logged out
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
5. **Raise sshd's `MaxSessions`.** The hub keeps one multiplexed SSH connection per host, and sshd allows 10 sessions (channels) on a connection by default. Each local Claude session holds 2 of them for as long as it runs (transcript tail and channel relay), each Codex account 1 (the app-server proxy), each terminal and app server 1, and short commands (repo scans, metrics, git) take one each while they run; the hub runs at most `ssh.maxExecs` (default 4) short commands per host at a time and queues the rest. With more than about 3 Claude sessions on one host the default limit is reached, and new channels fail with `channel N: open failed: administratively prohibited`; the hub logs a `WARNING <host>: sshd refused a new channel` line when it sees that. Set, in `/etc/ssh/sshd_config` on each host:
   ```
   MaxSessions 64
   ```
   then `sudo systemctl reload ssh` (or `sshd`). Tailscale SSH has no such limit.

### 3. Configure the hub

Copy `config/hub.config.example.json` to `config/hub.config.json` and edit it:

- `hosts[]`: `{ id, target: "user@minipc-a", roots: ["~/code"], color }`. `roots` are scanned for git checkouts and for `apps/*/app.json`.
- `accounts[]`: one per profile. Each has `claude.configDir` and `codex.home` (paths on the hosts), `git` identity, `gh.hostAlias`, and `hub.{claudeConfigDir,codexHome,scratchDir}` (paths on the hub for the cloud CLIs; log those in too, as in step 2.3, but on the hub).
- `accounts[].cloud.codexEnvironments`: the env ids or labels you use with `codex cloud exec --env` (take them from the `codex cloud` picker). `cloud.claudeEnvironments` lists the names shown in the spawn dialog; `claude --cloud` uses the account's default environment.
- `adapters`: the CLI binaries (see "Switching from stubs to real CLIs").
- `ssh.maxExecs` (default 4): short SSH commands run at once per host; the rest wait their turn. Long-lived channels (relays, tails, terminals, an agent's `run_on_host`) are not counted. See `MaxSessions` above.
- `retention` (days; pruned every `intervalMin`, default 60): `messagesDays` (30) keeps the messages of sessions that ended, `auditDays` (90) the audit log, `approvalsDays` (7) decided and expired approvals; sessions that ended more than `stateEndedDays` (7) ago leave the canvas and `/api/state` but stay listed in the Sessions tab ("Show older ended sessions").

**Adding a host or an account** is the same edit: add the entry, then restart the hub (`systemctl --user restart agent-hub`). Hosts appear within 30 s, and their checkouts on the next repo scan. Check SSH first with `ssh -i ~/.agent-hub/ssh/id_ed25519 user@host true`.

### GitHub (per account, on the hub)

GitHub goes through the official `gh` CLI: one config dir per account. No tokens go in hub config.

```bash
GH_CONFIG_DIR=~/.agent-hub/profiles/personal/gh gh auth login     # personal GitHub account
GH_CONFIG_DIR=~/.agent-hub/profiles/work/gh     gh auth login     # company account (authorize org SSO if required)
```

Then set each account's `gh: { "configDir": "~/.agent-hub/profiles/<id>/gh", "owners": ["<github user or org>", …] }`. A repo uses the account whose `owners` include its remote's owner.

From this the hub provides:
- PR and CI status on branch nodes;
- a scan of pushed `claude/*` and `codex/*` branches, including any apps on them;
- any file at any ref as a node.

New branches are git worktrees on the chosen host (`~/code/<repo>.worktrees/<branch>`). "Push to GitHub" uses that host's own git credentials.

### Bench hardware, HIL plans, terminals

Declare devices and hardware-in-the-loop plans per host in `hub.config.json`:

```jsonc
"devices": [ { "id": "stlink", "title": "ST-LINK V3SET", "icon": "SWD", "port": "/dev/ttyACM0", "probe": "st-info --probe | grep -q serial" },
             { "id": "pcan",   "title": "PCAN-USB FD",   "icon": "CAN", "port": "can0",         "probe": "ip link show can0 | grep -q UP" } ],
"hil":     [ { "id": "actuator-vv", "title": "Actuator V&V", "command": "./hil/run.sh", "cwd": "~/code/hexapod-robot",
               "devices": ["stlink", "pcan"], "setup": ["mini-1", "PCAN-USB FD", "leg CAN bus", "ST-LINK"] } ]
```

- **Probes:** a probe's exit code sets the device status. Serial ports and SocketCAN interfaces that aren't declared are also discovered.
- **HIL runners:** a runner prints `##hil plan <n>`, `##hil test <id> <req> <name>` and `##hil pass|fail|skip <id> <ms> [reason]`. Every other line is log output, and `HIL_ONLY=<ids>` re-runs the failed tests.
- **Device locks:** agents lock devices with `acquire_device`; you can reassign or release a lock from the device node, and your own actions are never blocked by a lock.
- **GPU metrics:** these need `nvidia-smi` on the host (`hosts[].bins.nvidiaSmi` overrides the path).
- **Terminals:** each one is a tmux session on the host, opened as its login user. Opening and closing are audited.

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

The hub will not serve plain HTTP on a non-loopback address unless `publicUrl` is https (TLS terminated in front of it). To do it anyway, for example on a trusted lab network, set `"allowInsecureHttp": true`. The hub token then crosses the network in clear text.

### 5. Run

```bash
node hub/dist/index.js config/hub.config.json
# or as a user service:
systemctl --user enable --now agent-hub   # ExecStart=/usr/bin/node %h/agent-hub/hub/dist/index.js %h/agent-hub/config/hub.config.json
loginctl enable-linger $USER               # keep it running without a login session
```

Open `https://<publicUrl>/` and paste the hub token, or use the one-time link `https://<publicUrl>/login?token=<hubToken>`. The token is in `~/.agent-hub/secrets.json` (generated on first start, along with the hook secret and the VAPID push keys). Then install the PWA from the browser menu and turn on notifications.

Each host's `~/.agent-hub/hub.env` holds a token derived for that host only, and every Claude session the hub starts gets its own secret on top. The hub rewrites `hub.env` on every host when it starts. After upgrading from a build that used one shared host token, restart Claude sessions that were already running, so their hub tool calls carry a session secret.

### Claude cloud progress hooks (optional)

Cloud sessions report back only through HTTP hooks committed in the repo's `.claude/settings.json`. That file is the `hooks` block from `scripts/seed/hexapod-robot/.claude/settings.json`, with the URL set to your `cloudCallbackUrl` + `/hooks/cloud`. Store the `cloudHookToken` from `secrets.json` as the network secret `HUB_CLOUD_HOOK_TOKEN` in the claude.ai cloud environment, and allow the hub's host in that environment's network allowlist.

## Switching from stubs to real CLIs

Every vendor CLI invocation is built and parsed in one place, `hub/src/adapters.ts`. Which binaries run is pure config:

```jsonc
"adapters": {
  "claude": { "bin": "claude", "cloudBin": "claude" },   // stubs: "/opt/agent-hub-stubs/bin/claude"
  "codex":  { "bin": "codex",  "cloudBin": "codex"  },   // stubs: "/opt/agent-hub-stubs/bin/codex"
  "gh":     { "bin": "gh" }                              // stubs: "/opt/agent-hub-stubs/bin/gh"
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
