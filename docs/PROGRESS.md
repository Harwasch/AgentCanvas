# Progress: Agent Hub v1

Status: **v1 and v2 (GitHub + every design node type) are built and pass the smoke test against the stubs** (`node scripts/smoke.mjs` → 25/25). Unit tests: 45/45. A clean checkout runs `npm ci && npm run build && npm test` green. Nothing has run against the real `claude`/`codex` binaries yet; `docs/OPEN-QUESTIONS.md` lists what to verify first.

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

## v2: GitHub and every node type (verified by the smoke test)

| Area | Verified |
|---|---|
| GitHub via `gh` (stub) | A project node per repo shows the GH account, default branch, README, stats and folders. Branch nodes show PR #18 (draft, reviews) and CI (2/3 passing, 1 pending) from `gh api`, under the account that owns the repo. |
| New branch | Created from the project node: a git worktree on mini-1, pushed to GitHub, then shown as a branch node. |
| Pushed-branch scan | A Claude cloud session pushes `claude/build-a-status-dashboard…`. The scan finds it, links it to the session, and finds `apps/cloud-status` on it. |
| Any file as a node | Quick open places nodes from a host checkout or a GitHub ref: image (decoded), markdown (rendered from GitHub), code, STL (three.js) and text. Nodes are pinned to the last commit that touched the path. After a commit the node shows "Newer version", and "Get latest" re-pins it. |
| Note and to-dos | Create, edit, toggle; "dispatch" starts a Codex session with the to-do. |
| Agent-created nodes | The stub agent writes a report and calls `request_review`, `suggest_followup` and `add_todo`. In the review node you tick the checklist, comment, and press Request changes; the decision and the comment arrive in the agent's chat. Launching the suggestion starts a session. |
| Compute cluster | Machine nodes show live CPU, memory and load (plus a simulated GPU on mini-2), the agents on each host, and the devices attached. Device nodes come from config probes and serial/CAN discovery; a lock is assigned and released from the node. |
| HIL | Run takes the plan's three device locks and streams 12 rows: 11 pass, T-07 fails. "Re-run failed" runs T-07 only, and the locks are released afterwards. |
| Compute grant | An agent calls `request_compute`. `run_on_host` is refused until you press Approve on the grant node, then runs as `hostb`. |
| Terminal | A real shell over SSH (tmux plus xterm.js): the typed `echo smoke-$((40+2)) $(whoami)` prints `smoke-42 hostb`. |

Screenshots: `docs/screenshots/v2-*.png`.

## Canvas interaction (checked in the demo build with Playwright; the smoke test still passes 25/25)

| Feature | Checked |
|---|---|
| Area select | A left-drag on empty canvas draws a box and selects the 16 nodes it touches. Dragging one of them moves all 16 by the same offset. Clicking empty canvas clears the selection. |
| Pan | A right-drag pans the canvas and opens no menu. A right-click without a drag still opens the add menu. |
| Subtree move | Shift-dragging the project moves its branch children by the same offset. A plain drag moves the project alone. |
| Resize | Dragging the corner handle grows a branch node. The size persists per collapsed/expanded state. |
| Tree layout | Each group's tree runs left → right, with curved links; groups are stacked. |

## What remains

**Gating against the real CLIs** (in order, from the architecture doc): see `docs/OPEN-QUESTIONS.md`. The riskiest items:
- dev channel combined with `--remote-control`, and whether `server:hub` resolves from `--mcp-config`;
- `UserPromptSubmit` for Remote Control messages;
- `claude --cloud` output;
- delivery of cloud repo hooks, and which `session_id` they carry;
- Codex daemon visibility in the ChatGPT desktop app.

**Not built:**
- **GitHub actions:** creating or merging PRs, and issues (out of the requested v2 scope). The GitHub polling sends no ETags or conditional requests yet.
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
- **Device locks:** they apply to hub-mediated actions only; the hub can't stop a process on the host from opening a device directly.
- **Per-process GPU usage for grants:** a grant shows the host's total GPU memory used, not just the agent's processes.
- **Hub administration UI:** hosts and accounts are added in `hub.config.json`, then the hub is restarted (see README).
- **Push delivery to a real browser push service:** the subscription flow is wired in the PWA, but only a fake push endpoint was exercised in the VM.
