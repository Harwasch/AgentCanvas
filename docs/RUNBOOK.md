# Bring-up runbook: Agent Hub on your machines

**This document is written for an agent running on the hub machine** (the always-on mini PC). It has shell and sudo access there. It sets the hub up end to end and stops at **[HUMAN]** checkpoints for the things only the person can do.

Branch: `claude/hub-v1`. The stubs pass 34/34 end to end, and unit tests pass 78/78. Nothing has run against the real `claude`, `codex` or `gh` yet. Phase 4 is where that happens.

## Rules for the agent (read first)

1. **Work phase by phase, in order.** A phase is done only when its **Done when** check passes. Don't skip ahead.
2. **Keep a progress log** at `~/agent-hub-bringup.md`: phase, step, command, result, open issues. If you are restarted, read it first and resume where it ends. It stays outside the repo because it contains machine names.
3. **[HUMAN] checkpoints.** Interactive logins (`claude` `/login`, `codex login`, `gh auth login`, `tailscale up`, org SSO), anything on another machine you can't reach, physical hardware, and decisions are the person's to do.
   - At a checkpoint, give the exact command(s) to run and where.
   - For device-code logins, you may start the command yourself and relay the URL and code.
   - Then wait, and verify the result yourself before continuing.
4. **sudo on this machine** is allowed for the steps that say so: the phase 1 installs, `loginctl enable-linger`, `tailscale serve`, and the `MaxSessions` edit when this machine is also a host. Ask before any other system-level change.
5. **Never:**
   - run `scripts/smoke.mjs`, `scripts/setup-test-env.sh` or `scripts/reset-test-env.sh` here (they create test users and change system git config; they are for disposable test machines only);
   - print or log secrets (tokens, credentials, `secrets.json` values) — refer to them by path;
   - set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (subscriptions only);
   - weaken auth, the CSRF checks, or the Ask Claude tiers;
   - actuate hardware outside a HIL runner the person approved;
   - push anywhere but `claude/hub-v1`, or force-push.
6. **Code changes** (expected in phases 4–5, when real CLIs differ from the stubs):
   - Make the smallest fix, in `hub/src/adapters.ts` where possible, and keep the stubs in step if a protocol changed.
   - Run `npm run build && npm test`, restart the service, and re-check.
   - Commit with a clear message and push to `claude/hub-v1`.
   - Record the result in `docs/OPEN-QUESTIONS.md` (VERIFIED, or DIFFERENT plus what the real CLI does).
7. **Stop and report to the person** when:
   - a fix would need a design change, or would touch security;
   - tests fail and the cause isn't clear;
   - a phase can't finish without them.

## Phases

| Phase | Where | Done when |
|---|---|---|
| 0 Gather facts | ask the person | The facts table is filled in your progress log |
| 1 Hub machine | here | `npm test` is green in `~/agent-hub` |
| 2 Hosts | each host | The readiness table is all ✓ |
| 3 Config, GitHub, HTTPS, service | here | The hub service is running, every host online, the PWA reachable at `https://<tailnet name>` |
| 4 First light (real Claude Code) | 1 host | Every listed item is VERIFIED or fixed |
| 5 Codex, clouds, GitHub | here + 1 host | Real Codex, cloud and PR/CI work |
| 6 Laptop and phone | the person's devices | The PWA is installed on the phone; Claude Code on the laptop can arrange the canvas |
| 7 Hardware and HIL (optional) | bench host | Devices show, and one HIL plan runs |

---

## Phase 0: gather facts

Discover what you can here: `hostname`; `tailscale status --json` for the tailnet name (if Tailscale is up); `whoami`; existing installs and logins. **[HUMAN]** Then ask the person in **one** message for the rest:

| Fact | Example |
|---|---|
| Hosts (`id`, `user@machine`, code root). Is this machine one of them? | `mini-1 = you@minipc-a ~/code` (this machine), `mini-2 = you@minipc-b ~/code` |
| Claude accounts (profile id → config dir on hosts) | `personal` → `~/.claude-personal`, `work` → `~/.claude-work` |
| ChatGPT/Codex accounts (profile id → `CODEX_HOME` on hosts) | `personal` → `~/.codex`, `work` → `~/.codex-work` |
| GitHub owners per account | `personal: [harwasch]`, `work: [<org>]` |
| First-light host | one the person can watch |
| Can you reach the other hosts with sudo? (usually no) | decides who does phase 2 there |

Record the answers in the progress log.

## Phase 1: the hub machine

The hub runs as **this user**. Everything it owns lives in `~/.agent-hub`: its SSH key, its secrets, and its own Claude, Codex and `gh` profiles. That keeps it separate from the person's everyday `~/.claude`, `~/.codex` and `~/.config/gh`. Never point the hub at those.

1. **Install what's missing.** Check each first; use sudo here.
   ```bash
   sudo apt update && sudo apt install -y git tmux python3 jq
   node -v | grep -q '^v22' || { curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs; }
   command -v gh || sudo apt install -y gh          # else use the apt repo from cli.github.com
   command -v tailscale || curl -fsSL https://tailscale.com/install.sh | sh
   command -v chromium || command -v chromium-browser || sudo apt install -y chromium-browser || sudo apt install -y chromium
   sudo loginctl enable-linger "$USER"             # the hub service keeps running when nobody is logged in
   ```
   Install Codex as the packaged npm build (`sudo npm i -g @openai/codex`), not a bare binary; the hub's cloud CLIs run here. Claude Code is presumably what you are running in; check with `claude --version`.
2. **[HUMAN] logins, if they aren't already done:**
   - `sudo tailscale up`, to join the tailnet;
   - `gh auth login`, the person's own login, so you can clone the private repo.
3. **Get the code:** `git clone -b claude/hub-v1 https://github.com/harwasch/AgentCanvas ~/agent-hub && cd ~/agent-hub && npm ci && npm run build && npm test`. Record the test summary.
4. **Hub SSH key:** `mkdir -p ~/.agent-hub/ssh && ssh-keygen -t ed25519 -f ~/.agent-hub/ssh/id_ed25519 -N '' -C agent-hub`. This is a dedicated key, not the person's `~/.ssh` key. You may show the **public** key.
5. **Chromium for app screenshots:** record its path for `screenshot.chromiumPath`.

**Done when** `npm test` is green and the key exists.

## Phase 2: hosts

**Each host needs:**
- a login user without sudo, with the hub's public key in `~/.ssh/authorized_keys`;
- `tmux`, `git` and `python3`;
- Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`) and Codex (the packaged npm build);
- one login per profile;
- `MaxSessions 64` in `/etc/ssh/sshd_config`, then `sudo systemctl reload ssh`.

**If this machine is one of the hosts:** do the installs and the `MaxSessions` edit yourself with sudo, and add the hub key to this user's own `authorized_keys`.

**[HUMAN] for other hosts:** give the person a per-host command sheet: user and key, installs, `MaxSessions`. Then the logins on every host, including this one if it is a host:
```bash
CLAUDE_CONFIG_DIR=~/.claude-personal claude    # /login, personal claude.ai
CLAUDE_CONFIG_DIR=~/.claude-work     claude    # /login, work
CODEX_HOME=~/.codex      codex login
CODEX_HOME=~/.codex-work codex login
```
(Use the profile dirs from phase 0.)

**Readiness check.** SSH to every host with `-i ~/.agent-hub/ssh/id_ed25519 -o BatchMode=yes` and build one row per host:
- ssh ok;
- tmux, git and python3 versions;
- `claude --version`, and `codex --version` (packaged install?);
- for each Claude profile, logged in? (`$CLAUDE_CONFIG_DIR/.credentials.json` exists — never read it out);
- for each Codex profile, `CODEX_HOME=… codex login status`;
- `MaxSessions` (from `sshd -T`, if readable);
- free disk.

For anything missing, give the exact fix and who does it. Install nothing on other hosts yourself.

**Done when** every row is ✓.

## Phase 3: config, GitHub, HTTPS, service

1. **[HUMAN] the hub's own profiles on this machine,** separate from the person's personal logins. Prepare and relay these:
   ```bash
   GH_CONFIG_DIR=~/.agent-hub/profiles/personal/gh gh auth login
   GH_CONFIG_DIR=~/.agent-hub/profiles/work/gh     gh auth login     # authorize org SSO if asked
   CLAUDE_CONFIG_DIR=~/.agent-hub/profiles/personal/claude claude    # /login: cloud sessions run from the hub
   CODEX_HOME=~/.agent-hub/profiles/personal/codex codex login
   ```
   Repeat for each account. Verify each with `gh auth status`, a check that the credentials file exists, and `codex login status`.
2. **Write `~/agent-hub/config/hub.config.json`** from `config/hub.config.example.json`, using the phase 0 facts:
   - `listen` `127.0.0.1:8443`, `tls: null`;
   - `publicUrl` and `hostCallbackUrl` = `https://<tailnet name>`;
   - `adapters` = `claude`, `codex`, `gh`;
   - `screenshot.chromiumPath`;
   - `hosts[]` without devices or HIL for now;
   - per account: `claude.configDir`, `codex.home`, `gh.configDir` plus `owners`, and `hub.claudeConfigDir` / `hub.codexHome` under `~/.agent-hub/profiles/<id>/`.

   Validate it with `jq .`.
3. **Service:** create `~/.config/systemd/user/agent-hub.service`:
   ```ini
   [Unit]
   Description=Agent Hub
   After=network-online.target
   [Service]
   ExecStart=/usr/bin/node %h/agent-hub/hub/dist/index.js %h/agent-hub/config/hub.config.json
   Restart=on-failure
   [Install]
   WantedBy=default.target
   ```
   Then run `systemctl --user daemon-reload && systemctl --user enable --now agent-hub`.
4. **HTTPS:** `sudo tailscale serve --bg --https=443 http://127.0.0.1:8443`.
5. **Watch:** follow `journalctl --user -u agent-hub -f` for 60 s. Every host should go online and repos should be indexed. Fix config problems. Check that `~/.agent-hub/secrets.json` is mode 600.
6. **[HUMAN]:**
   - open `https://<tailnet name>` on the phone and laptop;
   - sign in with the hub token, read on this machine with `jq -r .hubToken ~/.agent-hub/secrets.json` (tell the person to run this; don't print it yourself);
   - on the phone, "Install app" and turn on notifications.

**Done when:**
- the service is active;
- the log shows every host online;
- `curl -s https://<tailnet name>/healthz` succeeds;
- the person confirms they can see the canvas.

## Phase 4: first light with the real Claude Code (one host)

This is where reality may differ from the stubs. Read `docs/OPEN-QUESTIONS.md` and `hub/src/adapters.ts` first.

Use the hub's API with the hub token (read it from the file into a variable; never echo it). Start a Claude session on the first-light host from the API or the PWA. Watch its TUI read-only with `tmux capture-pane -p -t <session>` over SSH.

Work through these one at a time:
- **#1:** the dev channel plus `--remote-control` together, and whether `server:hub` resolves from `--mcp-config`;
- **#8, #9, #10:** startup prompts, ready detection, scraping the Remote Control URL;
- **#5, #6:** the MCP server inherits its environment, and `hub_channel.py` negotiates its protocol;
- **#13, #14:** HTTP hooks from `--settings`, and a held `PermissionRequest`;
- **#2, #4:** `UserPromptSubmit` fires for Remote Control and channel messages;
- **#11, #12:** `/model`, `/effort`, and Escape;
- **#48, #49, #51:** `permissions.allow` for `mcp__hub__*` tools, server instructions, the hub-served tool list;
- **the per-session secret:** do hooks substitute `$HUB_SESSION_TOKEN` into the `X-Hub-Session-Token` header? If not, hook calls get 403 — fix it without weakening the check (rule 5), or stop and report.

Then from the PWA: chat, approve one tool call, interrupt one turn.

**[HUMAN]:** ask the person to watch the canvas while you do this and to confirm what they see.

**Done when** each item is recorded as VERIFIED or fixed, and chat, approval and interrupt work from the PWA.

## Phase 5: Codex, the clouds, GitHub

Same method as phase 4: record each result, fix the adapter, then build, test, restart, commit and push.

- **Codex on the first-light host:**
  - #24 `codex app-server daemon start`;
  - #25 WebSocket over `codex app-server proxy`;
  - #23 sharing the daemon with the ChatGPT desktop app (**[HUMAN]** if they use it);
  - #28, #29 approvals and `turn/interrupt`;
  - #31 the managed `[mcp_servers.hub]` block being picked up.
- **Clouds, run here with the hub profiles:**
  - #18, #19 `claude --cloud` output and follow-ups;
  - #33, #34, #35 `codex cloud exec`, `list` and `status`;
  - #20 cloud repo hooks only if the person wants `cloudCallbackUrl` (it needs a public endpoint — ask first).
- **GitHub, on the person's real repos (#40–#44):**
  - PR and CI on branch nodes, pagination, commit statuses, the pushed-branch scan;
  - watch `gh api rate_limit` per account for 30 min, and raise `githubPollIntervalSec` if usage is over 50% of the hourly limit.
- **One small real task per vendor**, in a scratch repo (ask the person which).

**Done when** Codex local, both clouds and PR/CI work, with results recorded.

## Phase 6: laptop and phone

**[HUMAN]:**
- **Ask Claude in the PWA:** open the panel, pick a host and account, select some nodes, and say "arrange these in a grid". Then "start a codex session on <host> to …" and Allow it.
- **Claude Code on the laptop:** `claude mcp add --transport http agent-hub https://<tailnet name>/mcp --header "Authorization: Bearer <mcpToken>"`. The `mcpToken` is in `~/.agent-hub/secrets.json` on the hub; the person reads it themselves.
- **Then in Claude Code on the laptop:** "Use the agent-hub tools: switch the canvas to the tree layout, arrange all session nodes in a grid, add a note summarising what each session is doing, and focus the busiest one."
- **Claude Desktop (optional):** use the stdio bridge config in the README ("Use the canvas tools from Claude Code or Claude Desktop").

If `claude mcp add` or the tool calls fail, ask the person for the error and fix `/mcp` compatibility (open question #50).

**Done when** the person confirms Ask Claude and the laptop both changed the canvas.

## Phase 7 (optional): hardware and HIL

**[HUMAN]:** ask which bench host, which devices (e.g. ST-LINK V3SET on `/dev/ttyACM0`, PCAN-USB FD as `can0`), which repo, and which existing test command.

1. **Devices:** add them to that host's `devices` with real probe commands; the exit code is the status (e.g. `st-info --probe | grep -q serial`, `ip link show can0 | grep -q UP`).
2. **HIL runner:** write `hil/run.sh` in that repo, wrapping the test command. It prints:
   - `##hil plan <n>`
   - `##hil test <id> <req> <name>`
   - `##hil pass|fail|skip <id> <ms> [reason]`

   It honours `HIL_ONLY=<ids>` for re-runs.
3. **Plan:** declare it under the host's `hil`, then restart the hub.
4. **[HUMAN]:** the person reviews `hil/run.sh` and approves it before the first run, then watches while you start one run from the canvas.
5. Fix the runner until rows stream correctly.

**Done when** devices show the right status and one plan completes with streamed results.

---

## After bring-up: when something breaks

Give the agent this:
```
Agent Hub (systemd user service, ~/agent-hub, branch claude/hub-v1) misbehaves: <what you saw, which node or
session, when>. Follow docs/RUNBOOK.md "Rules for the agent". Read the last 300 lines of
`journalctl --user -u agent-hub`, the relevant docs/OPEN-QUESTIONS.md items and docs/DECISIONS.md, reproduce
if you can, and propose the smallest fix. Show me the diff before committing.
```

**Known limits:**
- Wheel zoom with about 400+ nodes on screen is still slow.
- Each Claude session holds 2 SSH channels, which is why `MaxSessions` is raised in phase 2.
- Undo history lives in memory, so it is lost when the hub restarts.
