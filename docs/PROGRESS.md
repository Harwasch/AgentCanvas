# Progress: Agent Hub v1

Status: **v1 is built and passes its smoke test against the stubs** (`node scripts/smoke.mjs` → 14/14). Unit tests: 38/38. A clean checkout runs `npm ci && npm run build && npm test` green. Nothing has run against the real `claude`/`codex` binaries yet; `docs/OPEN-QUESTIONS.md` lists what to verify first.

## What works (verified by the smoke test, stubs on two SSH "hosts")

| Area | Verified |
|---|---|
| PWA | Loads over HTTPS with a self-signed cert. Manifest, an active service worker (app-shell cache plus push), login via token cookie, and a live event stream over WSS. |
| Hosts | SSH ControlMaster per host, health checks, and first-use bootstrap of `~/.agent-hub/*`. |
| Codex driver | `daemon start` then `app-server proxy` over SSH, with WebSocket JSON-RPC (no `jsonrpc` field) through the byte relay. Covers `thread/start`, `thread/list` import, `thread/resume`, `turn/start` with mid-turn `turn/steer`, `turn/interrupt`, and the approval request answered from the hub with `serverRequest/resolved`. |
| Claude driver | `claude` runs in tmux under the account's `CLAUDE_CONFIG_DIR`. The dev-channel and Remote Control prompts are answered through tmux, and the Remote Control URL is captured. The hub channel connects over an SSH relay; chat is pushed in through `notifications/claude/channel`. Approvals go through `claude/channel/permission` (with the `PermissionRequest` hook as fallback). HTTP hooks, a JSONL transcript tail, Escape to interrupt, and `/model` over tmux. |
| Sessions | One Codex thread and one Claude session started on each host from the spawn dialog. Chat, one approval per vendor and one interrupt per vendor, all from the canvas. |
| Repo panel | Branch, HEAD (sha, subject, age), dirty count and ahead/behind, from `git status --porcelain=v2 --branch` over SSH, plus the file tree and file viewer. |
| Accounts | Two profiles (personal, work), each with its own `CLAUDE_CONFIG_DIR`/`CODEX_HOME` on hosts and on the hub. |
| Cloud | A Claude cloud session started with `claude --cloud` in a per-account scratch clone; its status arrives through the repo's HTTP hooks (`/hooks/cloud`, bearer token taken from the cloud environment's secret). A Codex cloud task started with `codex cloud exec --env --attempts`; status is polled with `codex cloud list --json`, with `status`/`diff` on demand. Both show on the canvas, with native links. |
| App nodes | The agent builds `apps/winch-console` and calls `publish_app` (hub MCP tool through `hub_channel.py`). The hub validates `app.json`, starts the server over SSH stdio, reads the `ui://` resource, and checks UI origins. The node renders beside its session, and Playwright returns a screenshot to the agent. Preview blocks `set_speed` and `stop`, and the refusals are audited. **Promote** reviews the tools and code, commits and pins the reviewed files, and runs the server from a git worktree at that commit, then grants actuate. After that, `set_speed` asks for confirmation outside the iframe, `stop` is unconfirmed, and both are audited. |
| Push | VAPID-signed `aes128gcm` web pushes are sent on approvals and turn completions (checked against a fake push service). |
| Phone | 390×844: condensed chrome, no horizontal scroll, full-screen session sheet. |

Also verified manually or by unit tests:
- Hot reload: a `PostToolUse` write under `apps/<name>/` republishes the app. When the app is already promoted, it creates a `-pv` preview node beside the pinned one.
- Undeclared tools are refused.
- The rate limit is enforced (10/min on `set_speed`).
- CSP is deny-by-default.
- Level-of-detail rendering: 20 app nodes give 0 live iframes when fitted and only the on-screen ones at ≥55% zoom (subagent measured this in mock mode).
- JSON-RPC framing, hook and channel payload parsing, the `app.json` validator, actuate-tier enforcement, and porcelain parsing are unit-tested.

Screenshots: `docs/screenshots/` (desktop 1440×900, phone 390×844, repo panel, cloud, app preview blocked, confirm dialog, audit) and `smoke-result.json`.

## What remains

**Gating against the real CLIs** (in order, from the architecture doc): see `docs/OPEN-QUESTIONS.md`. The riskiest items:
- dev channel combined with `--remote-control`, and whether `server:hub` resolves from `--mcp-config`;
- `UserPromptSubmit` for Remote Control messages;
- `claude --cloud` output;
- delivery of cloud repo hooks, and which `session_id` they carry;
- Codex daemon visibility in the ChatGPT desktop app.

**Not built in v1:**
- **GitHub API per account:** PR status, and repo scan of pushed branches for vendor-cloud apps. The indexer covers local checkouts only.
- **Adopting sessions started outside the hub:**
  - listing Claude Desktop/CLI sessions from their transcripts on hosts;
  - "bring into hub" (`claude --resume <id> --remote-control`): the driver accepts a `resumeUuid`, but there is no UI;
  - Codex desktop Handoff.
- **Routines `/fire`** for named Claude cloud environments. The config has a `routineId` slot; firing is not wired.
- **App runtime:**
  - `systemd-run --user` supervision for `always-on` apps; v1 keeps them alive only while the hub runs;
  - the `http` app transport (validated but refused);
  - `runsOn` a host other than the one holding the files;
  - high-rate stream proxying.
- **Usage meters:** the design's subscription-usage bars show session counts per account instead.
- **Design features not carried over:** to-dos, docs/figures, terminals and the review queue. The hub's scope is sessions, repos and apps.
- **Hub administration UI:** hosts and accounts are added in `hub.config.json`, then the hub is restarted (see README).
- **Push delivery to a real browser push service:** the subscription flow is wired in the PWA, but only a fake push endpoint was exercised in the VM.
