# Bring-up runbook: Agent Hub on your machines

Branch: `claude/hub-v1`. The stubs pass 34/34 end to end, and unit tests pass 78/78. Nothing has run against the real `claude`, `codex` or `gh` yet. Phase 5 is where that happens.

Each phase says **what you do** (logins, sudo, decisions) and gives a **prompt to paste** into Claude Code. Every prompt is self-contained. Run them in a Claude Code session **on the hub machine, inside the cloned repo**, because only that machine can reach your hosts. Claude cannot log in for you: every `/login`, `codex login`, `gh auth login` and `tailscale up` is yours to do.

| Phase | Where | Time | Done when |
|---|---|---|---|
| 0 Decide | you | 10 min | The table below is filled in |
| 1 Hub machine | hub box | 30 min | `npm test` is green as user `hub` |
| 2 Optional dry run | throwaway VM | 20 min | smoke 34/34 on your own hardware |
| 3 Hosts | each host | 15 min per host | The readiness table is all ✓ |
| 4 Config, GitHub, HTTPS, service | hub box | 30 min | The PWA opens at `https://<hub>.ts.net` on your phone |
| 5 First light (real CLIs) | 1 host | 1–2 h | The RISKY items are verified or fixed |
| 6 Codex daemon, clouds, GitHub | hub plus 1 host | 1 h | Codex, cloud and PR/CI work for real |
| 7 Ask Claude from your laptop | laptop | 15 min | Claude Code / Desktop can arrange the canvas |
| 8 Hardware and HIL | bench host | as needed | Devices show, and a HIL plan runs |

---

## Phase 0: decide (you)

Fill this in and keep it next to you. Every prompt below refers to it.

| Item | Your value |
|---|---|
| Hub machine (always-on Linux on your tailnet), and its tailnet name | e.g. `minipc-a` → `minipc-a.<tailnet>.ts.net` |
| Hosts (`id`, `user@machine`, code root) | e.g. `mini-1 = hub@minipc-a ~/code`, `mini-2 = hub@minipc-b ~/code` |
| Claude accounts (profiles) | e.g. `personal` → `~/.claude-personal`, `work` → `~/.claude-work` |
| ChatGPT/Codex accounts | e.g. `personal` → `~/.codex`, `work` → `~/.codex-work` |
| GitHub owners per account | e.g. `personal: [harwasch]`, `work: [<org>]` |
| First-light host | the one you can watch over SSH |

## Phase 1: the hub machine

**You (needs sudo):**
```bash
sudo apt update && sudo apt install -y git tmux python3 chromium-browser || true
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo apt install -y gh                      # or see cli.github.com for the apt repo
gh auth login                               # so you can clone the (private) repo
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
sudo adduser --disabled-password hub && sudo loginctl enable-linger hub
curl -fsSL https://claude.ai/install.sh | bash   # Claude Code for this bring-up (your own user)
```

**Prompt 1: install the hub**
```
You are on the machine that will run Agent Hub. Repo: github.com/harwasch/AgentCanvas, branch claude/hub-v1.
Read README.md ("Install on a real Linux host") and docs/RUNBOOK.md phase 1.
1. As the user `hub` (use `sudo -iu hub`), clone the repo to ~hub/agent-hub on branch claude/hub-v1,
   run `npm ci && npm run build && npm test` and show me the test summary.
2. Create the hub's SSH key at ~hub/.agent-hub/ssh/id_ed25519 (no passphrase) and print the PUBLIC key only.
3. Find a Chromium binary usable for app screenshots (system chromium, or the Playwright one) and tell me
   the path for config "screenshot.chromiumPath".
Rules: do NOT run scripts/smoke.mjs, scripts/setup-test-env.sh or scripts/reset-test-env.sh on this machine
(they create test users and change system git config; they are for throwaway VMs only). Before any sudo
command, stop and show it to me. Never print secrets.
```

## Phase 2 (optional): a dry run on a throwaway VM

This proves the build on your hardware and OS before real CLIs are involved. Use a disposable Ubuntu VM, never the hub box.

**Prompt 2**
```
This is a disposable Ubuntu VM. Clone github.com/harwasch/AgentCanvas (branch claude/hub-v1), install
Node 22, run `npm ci && npm run build && npm test`, then `sudo node scripts/smoke.mjs` (needs root; it creates
test users hosta/hostb and a local sshd setup). Report the N/N result and, for any failure, the check name,
the last 40 lines of ~/.agent-hub/smoke-hub.log and your diagnosis. Don't change code unless I ask.
```

## Phase 3: hosts (repeat per host)

**You, on each host:**
1. Make or choose a login user without sudo, and append the hub's public key (from Prompt 1) to its `~/.ssh/authorized_keys`.
2. Install `tmux git python3`. Then install Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`) and Codex (the npm or brew package, not a bare binary).
3. Log in once per profile. These are interactive and only you can do them:
   ```bash
   CLAUDE_CONFIG_DIR=~/.claude-personal claude    # /login, personal claude.ai
   CLAUDE_CONFIG_DIR=~/.claude-work     claude    # /login, work
   CODEX_HOME=~/.codex      codex login
   CODEX_HOME=~/.codex-work codex login
   ```
   Do not set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
4. In `/etc/ssh/sshd_config` set `MaxSessions 64`, then `sudo systemctl reload ssh`.

**Prompt 3: host readiness check**
```
Agent Hub is installed at ~hub/agent-hub on this machine (hub's SSH key: ~hub/.agent-hub/ssh/id_ed25519).
My hosts are: <paste the hosts row from the phase-0 table>. My profiles: <paste the account rows>.
As user `hub`, SSH to each host with that key (BatchMode=yes) and build a readiness table, one row per host:
ssh ok · tmux version · git · python3 version · `claude --version` · `codex --version` (and whether it is a
packaged install) · for each Claude profile: logged in? (check `$CLAUDE_CONFIG_DIR/.credentials.json` exists or
`claude` reports auth — never print credential contents) · for each Codex profile: `CODEX_HOME=... codex login status`
· `sshd -T | grep -i maxsessions` (if readable) · free disk in ~. Mark anything missing with the exact command
I should run on that host. Do not install or change anything on the hosts yourself.
```

## Phase 4: config, GitHub, HTTPS, service

**You:** log `gh` in once per account on the hub box, as user `hub`:
```bash
sudo -iu hub
GH_CONFIG_DIR=~/.agent-hub/profiles/personal/gh gh auth login
GH_CONFIG_DIR=~/.agent-hub/profiles/work/gh     gh auth login     # authorize org SSO if asked
CLAUDE_CONFIG_DIR=~/.agent-hub/profiles/personal/claude claude    # /login: the cloud CLIs run on the hub
CODEX_HOME=~/.agent-hub/profiles/personal/codex codex login
```

**Prompt 4: configure and start**
```
In ~hub/agent-hub (as user hub), create config/hub.config.json from config/hub.config.example.json for:
<paste your full phase-0 table>. Hub tailnet name: <minipc-a.xxx.ts.net>. Use listen 127.0.0.1:8443, tls null,
publicUrl/hostCallbackUrl = https://<tailnet name>, adapters = real binaries ("claude", "codex", "gh"),
screenshot.chromiumPath = <path from prompt 1>, per-account gh.configDir + owners, hub.claudeConfigDir /
hub.codexHome under ~/.agent-hub/profiles/<id>/. Leave devices/hil empty for now.
Validate the JSON, then:
1. Write a systemd user unit ~hub/.config/systemd/user/agent-hub.service (ExecStart=/usr/bin/node
   %h/agent-hub/hub/dist/index.js %h/agent-hub/config/hub.config.json, Restart=on-failure), enable and start it.
2. Show me the exact `tailscale serve --bg --https=443 http://127.0.0.1:8443` command to run (needs sudo; I run it).
3. Tail the hub log for 60 s: confirm every host goes online and repos are indexed; report problems with fixes.
4. Tell me where the hub token is (~hub/.agent-hub/secrets.json, key hubToken) WITHOUT printing it.
```

**You:** run the `tailscale serve` command. Then open `https://<hub>.ts.net` on your phone, sign in with the hub token, choose "Install app", and turn on notifications.

## Phase 5: first light with the real CLIs (one host)

This is where reality may differ from the stubs. `docs/OPEN-QUESTIONS.md` lists every assumption. Take the RISKY ones first.

**Prompt 5: verify the Claude gating questions**
```
Agent Hub runs as a systemd user service for user `hub` (repo ~hub/agent-hub, branch claude/hub-v1, log via
journalctl --user -u agent-hub). It now drives REAL Claude Code on host <first-light host>.
Read docs/OPEN-QUESTIONS.md and hub/src/adapters.ts. Work through these items against the real CLI, one at a
time, using the hub's API (token in ~hub/.agent-hub/secrets.json; don't print it) and by attaching to the tmux
session on the host read-only (`tmux capture-pane`) to see what the TUI shows:
#1 dev channel + --remote-control together, and whether server:hub resolves from --mcp-config;
#8/#9/#10 startup prompts, ready detection, Remote Control URL scrape;
#5/#6 MCP env passthrough and protocol negotiation of host-files/hub_channel.py;
#13/#14 HTTP hooks from --settings and a held PermissionRequest;
#2/#4 UserPromptSubmit for Remote Control and channel messages; #11/#12 /model, /effort, Escape;
#48/#49/#51 permissions.allow for mcp__hub__* tools, server instructions, hub tool list;
plus the per-session token: do Claude hooks substitute $HUB_SESSION_TOKEN into the X-Hub-Session-Token header?
For each: record VERIFIED / DIFFERENT (what the real CLI does) in docs/OPEN-QUESTIONS.md. Where different,
fix it inside hub/src/adapters.ts (or the smallest place possible), keep the stubs in step if the protocol
changed, run `npm run build && npm test`, restart the service, re-check. Commit each fix to claude/hub-v1 and push.
Stop and ask me before anything that needs my login or sudo, and before any change to the security tiers.
```

## Phase 6: Codex daemon, the clouds, GitHub

**Prompt 6**
```
Same setup as before (Agent Hub service as user hub, branch claude/hub-v1). Verify against the real tools,
recording results in docs/OPEN-QUESTIONS.md and fixing adapters where needed (build, test, restart, commit, push):
Codex: #24 `codex app-server daemon start` on <host>, #25 WebSocket over `codex app-server proxy`, #23 the
daemon shared with the ChatGPT desktop app, #28/#29 approvals and turn/interrupt, #31 the managed
[mcp_servers.hub] block being picked up.
Clouds (run on the hub with the hub profiles): #18/#19 `claude --cloud` output and follow-ups, #20 cloud repo
hooks (only if I enable cloudCallbackUrl), #33/#34/#35 codex cloud exec/list/status.
GitHub: #40–#44 with my real repos — PR + CI on branch nodes, pagination, commit statuses, pushed-branch scan,
and watch GitHub rate-limit headroom for 30 min (`gh api rate_limit` per account); tune githubPollIntervalSec
if usage > 50% of the hourly limit.
Start one small real task per vendor in a scratch repo, approve one tool call from the hub, interrupt one turn.
```

## Phase 7: Ask Claude, and the canvas from your laptop

- **In the PWA:** open Ask Claude, pick a host and account, select some nodes, and say "arrange these in a grid". Then try "start a codex session on <host> to …" and Allow it.
- **Claude Code on your laptop:** `claude mcp add --transport http agent-hub https://<hub>.ts.net/mcp --header "Authorization: Bearer <mcpToken>"`. The `mcpToken` is in `secrets.json`.
- **Claude Desktop:** use the stdio bridge config from the README ("Use the canvas tools from Claude Code or Claude Desktop").

**Prompt 7 (paste into Claude Code on your laptop, after `claude mcp add`)**
```
Use the agent-hub MCP tools. Call canvas_snapshot and hub_overview, then: switch the canvas to the tree
layout, arrange all session nodes in a grid, add a note above them summarising what each session is doing,
and focus the busiest one. Tell me what you changed; I'll check it live on the canvas and may press Undo.
```
If this fails, open question #50 is the likely cause (whether `claude mcp add --transport http` accepts the hub's plain-JSON endpoint). Paste the error into a hub-machine session with: "Fix /mcp compatibility per docs/OPEN-QUESTIONS.md #50".

## Phase 8: hardware and HIL (bench host)

**Prompt 8**
```
On host <bench host> I have: <list devices: e.g. ST-LINK V3SET on /dev/ttyACM0, PCAN-USB FD as can0>.
Add them to that host's "devices" in ~hub/agent-hub/config/hub.config.json with real probe commands (exit code =
status; e.g. `st-info --probe | grep -q serial`, `ip link show can0 | grep -q UP`). Then write a HIL runner
script in my repo <repo path> (hil/run.sh) that wraps my existing test command <command> and prints the hub
protocol: `##hil plan <n>`, `##hil test <id> <req> <name>`, `##hil pass|fail|skip <id> <ms> [reason]`, honoring
HIL_ONLY=<ids> for re-runs (see README "Bench hardware, HIL plans, terminals"). Declare the plan in "hil",
restart the hub, start one run from the canvas with me watching, and fix the runner until rows stream correctly.
Never actuate hardware outside the runner I approve.
```

---

## When something breaks

**Prompt: triage**
```
Agent Hub (user hub, ~hub/agent-hub, branch claude/hub-v1) misbehaves: <what you saw, which node/session, time>.
Read the last 300 lines of `journalctl --user -u agent-hub`, the relevant docs/OPEN-QUESTIONS.md items and
docs/DECISIONS.md, reproduce if you can, and propose the smallest fix. Show me the diff before committing.
```

**Known limits:**
- Wheel zoom with about 400+ nodes on screen is still slow.
- Each Claude session holds 2 SSH channels, so set `MaxSessions` (phase 3).
- Undo history lives in memory, so it is lost when the hub restarts.
