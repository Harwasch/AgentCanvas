# Decisions and conflicts (one line each)

Precedence: the build prompt > `architecture.md` (behavior) > `AgentCanvas.html` (look and interaction).

- **PWA scope:** the client is a thin PWA: manifest plus a service worker that only caches the app shell and handles web push (prompt override).
- **App iframe isolation:** apps load from the hub's own host in `sandbox="allow-scripts allow-forms"` without `allow-same-origin` (an opaque origin), with no `app-<id>.hub.<tailnet>` subdomains (prompt override of the doc's "own origin").
- **MCP Apps sandbox proxy:** the spec requires web hosts to use a separate-origin sandbox proxy. We skip the proxy layer; the opaque-origin sandbox plus a deny-by-default CSP response header provides the same isolation (follows from the override above).
- **CSP:** the app UI is served at `/api/apps/:id/ui` with the header `default-src 'none'`, inline script/style only, and `connect-src`/`img-src` limited to the origins declared in `app.json`.
- **Stack:** hub is Node 22 + TypeScript, compiled with `tsc`. SQLite is the built-in `node:sqlite` (no native module). The PWA is React 18 + Vite with no UI library.
- **SSH:** the system `ssh` binary with ControlMaster/ControlPersist (one multiplexed connection per host). Files are copied with `cat >` over that connection rather than `scp` (same effect, one code path).
- **Channel transport:** the hub channel MCP server listens on a 0600 unix socket on the host (`~/.agent-hub/run/<hubId>.sock`). The hub reaches it with `hub_channel.py relay <id>` over SSH, so the channel is SSH-only and only the hub can write to it.
- **Hub tool calls from hosts:** `publish_app` and the other hub tools go from `hub_channel.py` to the hub over HTTPS (`/api/mcp/tools/:tool`, that host's own token), the same path hooks use.
- **Codex tool-call attribution:** Codex passes no session id to MCP servers, so hub tool calls from Codex are matched to the most recently active Codex session on the token's host whose cwd contains the caller's cwd (host-level identity).
- **Host-side runtime:** the channel/MCP script is Python 3 standard library. Python 3 ships on every Linux host and in WSL2, whereas Node may be absent when Claude Code uses the native installer.
- **Claude launch flags:** hooks come from `--settings ~/.agent-hub/claude-settings.json` and the hub MCP server from `--mcp-config ~/.agent-hub/mcp.json`. The hub never edits the user's `~/.claude.json` or `settings.json`.
- **Secrets on hosts:** tokens live in `~/.agent-hub/hub.env` (0600), which the tmux command sources, never on the command line. The channel script reads the same file.
- **PermissionRequest hook:** when the channel is connected the hook returns no decision, so the dialog relays through the channel. When it is down, the hub holds the hook open for up to 120 s and answers from the PWA (the doc's fallback).
- **Approvals answered elsewhere:** a Claude approval still pending when PostToolUse or Stop arrives is marked `expired` (answered in the terminal or native app). Codex uses `serverRequest/resolved`.
- **Startup prompts:** the dev-channel warning, the one-time Remote Control prompt and the workspace trust prompt are answered through tmux by regex in `ClaudeAdapter.startupPrompts`. Turn this off with `autoAnswerStartupPrompts: false`.
- **Claude session identity:** the hub id (`cc-…`) is the tmux session name and the prefix of the Remote Control name (`<hubId> · <repo>`). `--session-id <uuid>` pins the native id, which maps hooks to rows.
- **Native URLs:** a Claude session's URL is scraped from the tmux pane. Codex local threads have no documented deep link, so the hub shows a hint instead of a URL.
- **Codex thread import:** on connect the hub calls `thread/list` (default cli+vscode sources) and lists those threads as sessions. It subscribes (`thread/resume`) only when a session is opened or driven.
- **Codex model/effort:** these are per-turn overrides applied on the next `turn/start`. A message sent mid-turn uses `turn/steer` with `expectedTurnId`.
- **Cloud CLI location:** cloud CLIs run on the hub under per-account `hub.claudeConfigDir`/`hub.codexHome`, in a scratch clone per repo per account (doc). Clones come from the checkout's remote URL.
- **Claude cloud environments:** `claude --cloud` uses the account's default environment. Named environments need routines (`/fire`); the config has a `routineId` slot, but firing is not wired in v1 (no API in the VM).
- **Cloud hooks for sessions started elsewhere:** a cloud hook for an unknown session creates a row, which covers natively started cloud sessions on repos with hub hooks. Its account defaults to the first configured account.
- **App lifecycle:** `on-demand` servers start on publish, on a tool call or on a UI request, and stop after 15 min idle. `always-on` restarts on crash while the hub runs. True systemd `--user` supervision is not used in v1.
- **App transport:** `server.transport: "http"` passes validation, but v1 refuses to run it (stdio over SSH only).
- **`runsOn`:** v1 runs the server where the app files are (the session host) and warns if `runsOn` names another host.
- **Static apps:** an app without a server needs `uiFile` (relative HTML path). It is a manifest addition, because a UI-only app has no server to serve `ui://`.
- **Undeclared tools:** a server tool missing from `app.json` produces a publish warning, and every call to it is refused.
- **Promotion:** promotion pins `HEAD` and runs the server from a detached `git worktree` at that commit (`~/.agent-hub/pins/…`). Later edits to the working tree create a `<id>-pv` preview node beside the pinned one.
- **Commit & pin:** if the app directory has uncommitted changes, Promote can commit them under the session account's git identity. The review hash covers everything that commit would contain (see Security), so nothing can change between review and pin.
- **Actuate grant:** the grant is tied to the node version. Reloading a promoted node restarts the same pinned commit and carries the grant forward; anything else needs a new review.
- **Agent tool calls:** agents call app tools through an extra hub tool `app_call`, which goes through the same policy. A confirm-tier tool raises a hub approval that a human must answer. The doc lists four hub tools; this is the fifth.
- **Audit scope:** the audit records every actuate call, every refusal, every agent or app call, and promote/grant events. The node's own read-tier polling from the UI is not recorded, to keep the log readable.
- **Screenshots:** Playwright on the hub opens the PWA's `/?shot=<id>` mode and screenshots the node as rendered, so the agent sees what the user sees.
- **Push:** VAPID keys are generated on first start into `secrets.json`. Every push is also sent as a `toast` event on the stream, so open PWAs see it.
- **Account usage meters:** the design's subscription-usage meters show live session counts per account instead. The hub has no real usage source (`/usage` scraping is out of scope).
- **Branch:** work is pushed to `claude/hub-v1` as the prompt asks, not to the session's default branch.
- **Test hosts:** users `hosta` (mini-1) and `hostb` (mini-2) on localhost stand in for the two mini PCs. Stub CLIs live in `/opt/agent-hub-stubs` and are selected purely by `adapters.*.bin` in the config.
- **Self-signed TLS and the PWA:** browsers refuse to register a service worker (and so push) on an untrusted certificate. With `tls: {cert, key}` the device has to trust the CA. `tailscale serve` avoids this, and the smoke test runs Chromium with `--ignore-certificate-errors`.

## v2 (GitHub + all node types)
- **GitHub access:** through the official `gh` CLI under a per-account `GH_CONFIG_DIR` on the hub (`accounts[].gh.{configDir, owners}`), behind `GitHubAdapter`. A repo maps to the account whose `owners` include the remote's owner. No tokens are stored in hub config.
- **GitHub scope (per request):**
  - PR and CI status on branch nodes;
  - a scan of pushed branches (`claude/*`, `codex/*`, open-PR heads, hub-created) including `apps/*/app.json` on them;
  - new branches as branch nodes;
  - any file at any ref as a node.
  - Creating or merging PRs and issues are not in scope.
- **Which branches become nodes:** the default branch, branches checked out on any host, hub-created branches, open-PR heads, and `claude/*`/`codex/*` result branches. Not every remote branch, which would flood the canvas.
- **New branch:** a `git worktree` on the chosen host at `<parent>/<repo>.worktrees/<branch-slug>`, so agents can work branches in parallel. "Push to GitHub" pushes with the host's own git credentials. The base and goal are stored in the hub (`branch_meta`).
- **Cloud result branches:** a `claude/*` branch is linked to its cloud session by the stored `resultBranch`, or else by a commit subject that mentions the session id (heuristic).
- **File pins:** a file node pins the last commit that touched the path. Uncommitted files pin to `worktree`, which always shows the current bytes. The hub polls for newer commits on the path and shows "Newer version · Get latest".
- **Raw file serving:** repo files are served by `/api/files/raw` with `Content-Security-Policy: sandbox`, so an HTML or SVG file from a repo can never run as a hub-origin document.
- **Reviews:** a review is a hub node an agent creates with `request_review`. Approve or Request changes sends the decision, the checklist state and your comments back to the agent session as a message. The agent does any promotion itself.
- **Suggestions:** suggestions and agent-created to-dos come from agent tools (`suggest_followup`, `add_todo`). Launching a suggestion spawns a session with the agent's prompt; vendor and host can be overridden.
- **To-dos:** to-do lists are hub-stored and scoped to a project or global. "Dispatch to agent" spawns a session with the to-do text as the prompt.
- **Machines:** metrics come from `/proc/stat` deltas, `/proc/meminfo`, `/proc/loadavg` and `nvidia-smi --query-gpu …` over SSH every `metricsIntervalSec`. The two vendor clouds appear as "managed" machines.
- **Devices:** devices are declared per host in config, with a `probe` command (exit 0 = connected), plus discovered serial (`/dev/ttyACM*`, `/dev/ttyUSB*`, `/dev/serial/by-id`) and SocketCAN interfaces. A discovered device that disappears shows as missing.
- **Device locks** keep agents from colliding:
  - an agent must hold the lock (`acquire_device`) of every device an app declares (`app.json` `devices`) before actuate calls;
  - HIL runs take their plan's locks for their duration;
  - **you are never blocked by a lock**, so STOP always goes through, and the audit records the override;
  - the hub cannot stop a process on the host from opening a device directly; locks govern hub-mediated actions only;
  - a session that ends releases its locks.
- **Compute grants:**
  - an agent asks with `request_compute`; you approve on the grant node;
  - `run_on_host` then runs commands on that host as its login user, audited;
  - "used" is the host's total GPU memory, not per-process usage.
- **HIL protocol:** plans are declared per host. The runner prints the hub HIL line protocol (`##hil plan|test|pass|fail|skip`). "Re-run failed" passes `HIL_ONLY=<ids>`. A run started by an agent reports back to it as a message.
- **Terminals:** each terminal is a tmux session on the host. Every browser view is a tmux client over `ssh -tt`, and resizes run `stty` on that client's pty. Opening and closing a terminal are audited, but keystrokes are not. The WebSocket requires the hub cookie and a same-origin `Origin`. "Agent pane" mode attaches to a Claude session's own tmux.
- **Test env remotes:** remotes are `https://github.com/agent-hub-test|agent-hub-corp/<repo>` mapped to the local bare repos with a system `url.insteadOf`. The indexer reads `remote.origin.url` as configured, not the expanded value. The stub `gh` answers from those bare repos plus a PR/CI fixture file.
- **Canvas input:** the design pans with a left-drag, and the user asked for left-drag to select an area instead. Left-drag on empty canvas now draws a selection box; right- or middle-drag pans. A right-click without a drag still opens the add menu, on release, so a right-drag never opens it. Touch keeps one-finger pan.
- **Branch hierarchy:** every branch node is a direct child of its project, with an edge; a stacked branch shows its base on the node instead of nesting under the base branch.
- **Node sizes:** a resize stores `[w, h]` per node for the current state (collapsed or expanded), in a new `layout.sz` column. Auto layouts re-flow around it, and phones ignore it.
- **Ask Claude:** the canvas assistant is an ordinary Claude session (tmux, Remote Control, channel) started in the host's home directory with `HUB_ROLE=assistant`. It is not an artifact and needs no API key. It is hidden from the canvas graph; the panel is its home. The newest active assistant session is shared by every device.
- **Canvas positions:** the PWA computes layout in the browser, so each open view reports its node boxes and selection to the hub (debounced 0.7 s). The tools act on the newest report. Claude's moves are saved layout rows; seeing them needs Custom mode, so the PWA switches to Custom and keeps the auto layout that was showing as its base. That means nothing else moves.
- **Tiers are enforced by the hub, not Claude Code:** canvas tools are pre-allowed in the hub's Claude settings (`permissions.allow`), so they never prompt in the terminal. Confirm-tier tools block on a hub approval instead, which also works for external clients that have no hub permission relay.
- **Undo** reverts a batch: one caller's edits within 8 s of each other. Undo is held in memory, so a hub restart drops it; the saved layout itself persists.
- **External MCP** uses a separate `mcpToken`, never the PWA or host token. Claude Desktop goes through the stdio bridge (`hub_channel.py --external`), because Desktop's remote connectors are reached from Anthropic's cloud, which cannot see a tailnet.

## Security
- **Shell commands:** every value interpolated into a remote shell command goes through `q()`/`rpath()`. Branch names and bases must match a strict ref pattern (`validRef`: no leading `-`, `..`, revision syntax or shell characters) in `POST /api/branches`, `hub_create_branch` and `createBranch`. `tmux send-keys -l` gets `--`, terminals honour `bins.tmux`, and `server.env` names must be shell identifiers (manifest and runtime). The Codex cloud prompt is passed after `--`.
- **Cookie CSRF:** `SameSite=Strict` still sends the cookie from same-site origins (another localhost port, a sibling host), so every cookie-authenticated request and the `/api/events` and terminal socket upgrades must have no `Origin` or the hub's own (`publicUrl`, or the listen address on the hub's port), and no `Sec-Fetch-Site` other than `same-origin`/`none` (403). Bearer requests are not ambient and skip this.
- **JSON bodies:** a POST body is parsed only when its content type is exactly `application/json`; any other non-empty body gets 415, so a cross-site form can never produce a JSON body.
- **Per-host tokens:** each host's `hub.env` holds its own token, `HMAC(hookToken, "host:<id>")`. The hub maps the token back to the host and ignores (or refuses, if it disagrees) the `hostId` in the body. Nothing new is stored; the shared `hookToken` itself is no longer accepted from hosts. `hub.env` is re-copied to every host when the hub starts.
- **Per-session secret:** a Claude session started by the hub gets `HUB_SESSION_TOKEN = HMAC(hookToken, "session:<hubId>")` through a 0600 file the launch shell sources and deletes (never a command line). `hub_channel.py` sends it with `hubSessionId`, and hooks send it as `X-Hub-Session-Token` (through `allowedEnvVars`). The hub accepts a session only if its host is the token's host and, for sessions launched with a secret, the secret matches. Claude sessions started before this change keep host-level identity until restarted.
- **App actuate confirm:** the dialog focuses Cancel, and Run stays disabled for 600 ms after it opens. A key press or a click that began earlier never confirms, so typing in the app cannot confirm a hardware action.
- **Commit & pin:** the review builds the exact tree Promote would commit (HEAD plus the app directory's tracked changes, deletions and untracked files, recursively) in a throwaway index. `reviewHash` binds that tree id to the base commit, and the review lists every changed path. Promote rebuilds the tree right before committing, refuses if it differs, and commits that tree object with `commit-tree`/`update-ref`, so nothing unreviewed can be added in between.
- **App → agent messages:** `ui/message` works only for promoted apps, after a confirm in the PWA, through `POST /api/apps/:id/message`. The hub prefixes the text so the agent sees it came from the app.
- **App UI document:** `/api/apps/:id/ui` also sends CSP `sandbox allow-scripts allow-forms`, so opened top-level it still runs in an opaque origin, never the hub's.
- **Screenshots:** Chromium keeps its sandbox and drops it (with a log line) only when the hub runs as root. Sizes requested by agents are clamped to 200–2400 px.
- **Login:** the PWA signs in with `POST /login` (JSON body), so the token never appears in a URL or the history. `GET /login?token=` stays for the documented first-run link.
- **Plain HTTP:** the hub refuses to start with `tls: null`, a non-https `publicUrl` and a non-loopback listen address, unless the config sets `allowInsecureHttp: true`.
- **Robustness:** spawned ssh children and their pipes have error listeners (EPIPE is logged, not thrown), writes check `writable`, JSON-RPC and WebSocket message handlers catch per-message errors, and unhandled rejections are logged. An uncaught EPIPE/ECONNRESET is logged and ignored; any other uncaught exception is logged and the hub exits non-zero.

## Reliability
- **Confirm window:** confirm-tier canvas approvals wait 150 s and app confirms 120 s, both below the 180 s tool-call timeout of `hub_channel.py` and Codex's `tool_timeout_sec`; the card shows a countdown (`data.expiresAt`).
- **Abandoned calls:** `/api/mcp/tools/:tool` and `/mcp` pass an abort signal that fires when the waiting HTTP request closes before the reply; its approval is marked `expired` and the action never runs.
- **No live waiter → 409:** `POST /api/approvals/:id` answers 409 "no longer waiting" (and expires the row) when the tool call, held hook, or Codex connection behind an approval is gone. Channel approvals stay answerable while their session lives.
- **Restart:** on start the hub expires pending approvals whose waiter lived in the old process (canvas-action, app-confirm, claude-hook, codex) and channel approvals of ended sessions. A dropped Codex connection expires its pending approvals; the daemon re-sends them on reconnect.
- **Held hook responses:** the router has a `HELD` return value, so a held `PermissionRequest` response is really held. Before, it was answered `{ok:true}` at once. The approval expires if Claude closes the request.
- **Session liveness:** whether a Claude session is alive is tmux's own answer (`has-session` exit 0 = alive, 1 = gone), asked in one ssh exec per host. An ssh failure is "unknown": the session is kept (`last_event: host offline`, `meta.hostOffline`), not ended, and its device locks stay.
- **Exit detection:** `SessionEnd` is not relied on (HTTP support unverified, see OPEN-QUESTIONS). The hub checks tmux every `claudeLivenessIntervalSec` (default 60 s), and 1.5 s after a channel relay drops, which follows `/exit` or a crash within seconds. A gone session is ended, its links closed, its approvals expired and its locks released.
- **Host back online:** the health check's offline → online transition re-runs Claude and Codex recovery for that host.
- **Event stream:** the socket's first frame is `hello {boot, seq, resync}`. The client resyncs when the hub restarted (new `boot`) or the replay ring no longer covers its `since`. The hub sends a `keepalive` frame plus a ping every 25 s and drops clients that miss a pong.
- **PWA reconnect:** every snapshot load refetches the transcripts on screen (expanded nodes, phone sheet, Ask panel), replacing them after a hub restart, because messages are not in the snapshot. Becoming visible, `online` and `pageshow` reconnect at once with a fresh backoff. 60 s without a frame counts as a dead socket.
- **GitHub failures:** if a list call fails, the last known remote branches, PRs, CI and apps are kept; nothing is deleted. The project carries `githubError` and `githubAt` (last good poll), and the project node says "GitHub unreachable · as of …".
- **GitHub pagination:** branches and open PRs are paged with `page=N` up to a cap (1,000 branches, 500 open PRs; recently closed PRs, one page of 50). `gh api --paginate` is not used because it cannot be capped per refresh.
- **GitHub caching:** app lists (tree + `app.json` reads) and remote-only commit lists are cached by remote sha, because a sha's tree never changes.
- **CI:** CI state merges check runs with the combined commit status (`commits/{sha}/status`); `failure`/`error` count as failed.
- **Repo scans:** a scan triggers a project refresh only when the checkout's head, branch, upstream, dirty count or ahead/behind changed. GitHub otherwise refreshes on `githubPollIntervalSec`.
- **Canvas drags:** dragging a node in an auto layout switches to Custom over that layout, as Claude's moves do, so the position persists. Drag and resize state is read from refs and always cleared when the gesture ends.

## Performance
- **Streamed text is sent as deltas:** the first delta of a message is a `message.upsert`; later ones are coalesced per message (100 ms) into `message.append {id, session_id, seq, kind, append, at}`. The hub keeps the streaming text in memory, writes it at most every 500 ms and on completion, and flushes before any read. `at` makes appends idempotent; a gap or an unknown message makes the PWA refetch that transcript.
- **Command output tail:** only the last 64 KB of a command's output is kept, in SQLite and on the wire, behind `…truncated…`; `data.outputLen` counts everything received. More than 64 KB in one window is sent as `reset: true` with the kept tail.
- **Unchanged messages:** an upsert that changes nothing (a replayed transcript line, a resumed Codex thread) is not written or published.
- **Replay ring:** at most 2,000 events and 8 MB; each event is serialized once on publish and those bytes are sent to every client and replay. A `since` older than the ring gets `hello {resync: true}`.
- **Claude transcript tail:** the number of transcript lines read is kept in session meta (`tLines`, saved quietly every 2 s), and a reattach runs `tail -n +<tLines+1> -F`, so it does not replay the whole file.
- **Canvas node wrappers:** each node is a memoized wrapper with primitive props (box, opacity, expanded, phone). It reads its own selection, glow and session ring from the stores; checkout nodes read their own rows. The canvas hands wrappers one stable callback object.
- **Drag without React:** pointer moves never set React state. A drag moves the nodes with a running Web Animation whose keyframes are replaced on each move. A running transform animation is composited with assumed overlap, so a move neither repaints nor re-layerizes the page; an inline transform would, every frame. Edges touching the moved nodes are hidden and drawn as copies in an overlay that is held by its own animation and has fixed paint bounds. The result is committed once, on pointerup. Resize sets the box size directly. `.world` pointer-events, the cursor and the marquee are set through refs.
- **Camera layers:** the dot grid is its own layer, moved by transform; its spacing is repainted only when the zoom band changes. During a pan, pinch or wheel burst, the world and the grid are held by running animations the same way, and they go back to inline transforms (re-rastered at the final zoom) 200 ms after the gesture.
- **Graph rebuilds:** the graph is rebuilt from a structural key (ids, parents, kinds and the fields that change node sizes: status waiting/active, expanded, readme, app size…), cached per store collection. A grant usage tick, a machine metric or a session's `last_event` does not rebuild the graph and layout.
- **Running ring:** a static conic gradient on an oversized child rotated by a CSS transform animation (compositor only), clipped to the band by its parent's mask. The ring and halo animations are removed (not paused: a running animation keeps a compositor layer) when the node is off-screen (IntersectionObserver) or the zoom is below `LIVE_ZOOM`; spinners stop below `LIVE_ZOOM` too.
- **STL viewer:** renders on demand: on OrbitControls `change` (also while damping settles), on resize, wireframe and reset. It no longer renders 60 frames a second while idle.
- **View reports:** sent 0.7 s after any change (camera included), skipped when the payload equals the last one sent, not sent while the page is hidden, and sent once with `pageVisible: false` on hiding (keepalive) and again when the page is shown or gains or loses focus. The hub's tools use the visible page's report, then the focused one, then the newest.
- **SQLite statements:** prepared once per SQL text and reused (LRU of 256).
- **Grant events:** a metrics tick republishes a grant only when its `usedGB` changed.
- **Retention:** pruned hourly. Messages of sessions ended more than 30 days ago, audit rows older than 90 days, and decided or expired approvals older than 7 days are deleted (`retention.*`). Sessions ended more than 7 days ago leave `/api/state` and the canvas; `GET /api/sessions/archive` lists them for the Sessions tab.
- **SSH channels:** one ControlMaster per host shares sshd's `MaxSessions` (default 10). Short execs go through a per-host limiter (`ssh.maxExecs`, default 4; the rest queue in order). An agent's `run_on_host` bypasses the limiter so it cannot starve health checks. Long-lived channels (relay, tail, proxy, terminals) are not limited. The README recommends `MaxSessions 64`, and the hub logs a warning when sshd refuses a channel. Merging each Claude session's tail and relay into one channel would need a multiplexing helper on the host, so it was not done; the cost is documented.
- **Bundle:** the mock hub is imported only when `import.meta.env.DEV` or `VITE_DEMO=1`, so a production build contains no mock chunk; `?mock=1` still works in `vite dev` and the demo build. The service worker drops cached `/assets/` files that the current `index.html` (and the chunks it imports) no longer reference, whenever a new `index.html` arrives. `sw.js` itself does not change between builds. The demo page has a viewport meta and a charset.

### Measurements (before → after)
Hub bench: the Codex driver → store → bus path in-process (file-backed SQLite). It streams a 2 MB command output (1,024 × 2 KB deltas) and a 200 KB agent message (5,000 × 40 B deltas), with arrival spread over time. PWA: the demo build in headless Chromium at 1440×900, with `playwright-core`. React commits were counted through the devtools hook and `NodeView` renders by a temporary counter. Frame times are rAF intervals during 60 pointer moves at 4× CPU throttle (CDP `Emulation.setCPUThrottlingRate`). Idle CPU is the CDP `Performance.getMetrics` `TaskDuration` delta over 10 s. "441 nodes" is the demo plus 400 injected notes. The demo itself always has timers running: a 100 ms winch simulation and machine and HIL ticks.

| What | Before | After |
|---|---|---|
| Stream bench: events / bytes published | 6,027 / 1,506 MB | 15 / 0.6 MB |
| Stream bench: replay ring / peak RSS / wall time | 247 MB / 1,922 MB / 33.8 s | 0.63 MB / 106 MB / 1.9 s |
| Stream bench: command output stored | 2,049 KB | 64 KB (+ marker) |
| Node drag, 41 nodes: React commits / NodeView renders per move | 1.17 / 45.1 | 0.08 / 0 (the commits come from demo timers) |
| Node drag, 41 nodes: frame p50 / p95 / max | 16.7 / 33.4 / 66.7 ms | 16.7 / 16.7 / 16.8 ms |
| Node drag, 441 nodes: commits / NodeView renders per move | 1.95 / 749.7 | 0.13 / 0 |
| Node drag, 441 nodes: frame p50 / p95 / max | 33.4 / 483.4 / 550 ms | 16.7 / 16.8 / 450 ms |
| Right-drag pan, 41 / 441 nodes: frame p50 / p95 | 50 / 67 ms; 500 / 633 ms | 16.7 / 16.8 ms; 16.7 / 383 ms |
| Wheel zoom, 41 / 441 nodes: frame p50 / p95 | 16.7 / 50 ms; 33 / 567 ms | 16.7 / 16.8 ms; 33 / 483 ms |
| Idle, 2 running sessions, fitted (z 0.13): main thread | 127 ms/s (60 style recalcs/s) | 24 ms/s (14/s) |
| Idle, zoomed to a running session (z 1) | 112 ms/s (60 recalcs/s) | 30 ms/s (19/s) |
| Idle, one live (expanded) STL node | 672 ms/s | 24 ms/s |
| View POSTs per 15 s idle / after a pan | 7 / 0 (stale) | 0 / 1 |
| Graph rebuilds per 10 s idle | 6 | 0 |
| Production bundle: mock chunk | 67.6 KB emitted | not emitted |

At 441 nodes, every repaint anywhere still costs one layerization of the whole canvas, about 100 ms unthrottled (Chromium's cost grows with the number of paint chunks). The remaining long frames come from demo ticks and, when zooming, from the zoom label. Drag and pan avoid it. Level-of-detail rendering or culling for far-out zoom would be the next step.
