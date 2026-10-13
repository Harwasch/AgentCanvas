# Open questions: real-CLI behavior the stubs assume

The stubs implement each of these as listed below. Every item needs checking against the real binaries on one mini PC before the hub is trusted with it. Items marked **RISKY** are the ones the architecture doc flags. Where a fix is needed, the file to change is named.

## Claude Code

1. **RISKY — dev channel together with `--remote-control`.** The stub loads `server:hub` from `--mcp-config` and runs Remote Control in the same interactive process.
   - Unverified that `server:<name>` resolves from a `--mcp-config` file; the docs mention only `.mcp.json` and `~/.claude.json`.
   - Unverified that channels register alongside `--remote-control` (issue #82939 reports intermittent non-registration).
   - Fallback already wired: `tmux send-keys` for input and the `PermissionRequest` hook for approvals.
   - Fix point: `ClaudeAdapter.launchCommand`. If `--mcp-config` doesn't work, write the server into `$CLAUDE_CONFIG_DIR/.claude.json` instead.
2. **RISKY — `UserPromptSubmit` for Remote Control messages.** The hub assumes a prompt typed on claude.ai or the phone fires `UserPromptSubmit` in the hub-owned process. The stub has no Remote Control client, so this is completely untested. The hub only uses this hook for status ("running"); the messages themselves come from the transcript.
3. **Channel messages in the transcript.** The stub writes them as a `user` line whose content is `<channel source="hub" …>\ntext\n</channel>`, and the hub strips the tag for display. The real recording is undocumented.
4. **`UserPromptSubmit` for channel messages.** The stub fires it. The real CLI may not.
5. **MCP server environment.** The stub passes the `claude` process environment to stdio MCP servers. The hub relies on this to hand `HUB_SESSION_ID` and `HUB_SESSION_TOKEN` to `hub_channel.py`.
6. **Protocol negotiation.** `hub_channel.py` answers `initialize` with `2025-06-18` so it registers as a channel on the v2 MCP runtime, which asks for `2026-07-28`. Check that the real CLI still registers a channel that negotiates an older revision.
7. **Permission relay `request_id`.** The stub uses 5 letters `[a-km-z]`. The hub validates exactly that, so a format change would silently drop approvals (unit-tested).
8. **Startup prompts.** The stub prints the dev-channel warning ("I am using this for local development / Exit") and "Enable Remote Control? (y/n)" once per config dir. The real wording and keystrokes may differ; edit `ClaudeAdapter.startupPrompts`.
9. **Ready detection.** The stub's idle prompt is a line `❯`. The real TUI draws a box with `>`. `ClaudeAdapter.isReady` accepts both and falls back to "no known prompt for 15 s".
10. **Remote Control URL in the pane.** The stub prints `Remote Control active · <name> · https://claude.ai/code/session_…`. The hub scrapes the first `https://claude.ai/code/session_…`. The real printed text is undocumented.
11. **`/model` and `/effort` via tmux keys.** The stub accepts `/model <name>` and `/effort <level>` typed into the TUI. On the real CLI, `/model` without an argument opens a picker; the hub always passes an argument.
12. **Escape interrupts a turn.** The stub treats `\x1b` as interrupt and writes `[Request interrupted by user]`. Stop does not fire on interrupt, matching the docs.
13. **HTTP hooks from `--settings`.** The stub merges hooks from user, project, local and `--settings` files. The docs say `--settings` hooks merge; verify with real `type: "http"` hooks and the `$HUB_HOOK_TOKEN` / `$HUB_SESSION_TOKEN` header interpolation through `allowedEnvVars` (an unset variable must become an empty string).
14. **`PermissionRequest` held open.** When the channel is down the hub holds the hook response for up to 120 s (hook timeout 130 s). Verify that the real CLI waits, and that its terminal dialog stays usable meanwhile.
15. **No `SessionStart` over HTTP.** It isn't supported (command hooks only). The hub detects "ready" from the tmux pane instead. If a ready signal is needed, add a command hook that runs `curl`.
16. **Transcript path.** `$CLAUDE_CONFIG_DIR/projects/<cwd with non-alphanumerics → ->/<uuid>.jsonl`. Paths over 200 characters get an unknown hash suffix. The hub tails the computed path; the `transcript_path` from hooks would be more robust once confirmed.
16a. **`SessionEnd` over HTTP.** The hub does not register a `SessionEnd` hook, because it is unknown whether real Claude Code runs `type: "http"` hooks for it (it does not for `SessionStart`), or whether it fires on `/exit`, Ctrl-C or a crash.
    - The hub detects exits with tmux instead: `has-session` every `claudeLivenessIntervalSec`, and 1.5 s after the channel relay drops.
    - If HTTP `SessionEnd` is confirmed, add it to `HOOK_EVENTS` in `bootstrap.ts`. `onHook` already ends the session on it.
16b. **Held `PermissionRequest` and hook timeouts.** The hub assumes that when Claude gives up on a hook (after its 130 s timeout, or on exit), it closes the HTTP request; the hub then expires the approval. Verify that the real CLI closes the connection rather than leaving it open.
16c. **`tmux has-session` exit codes.** The hub treats exit 1 as "no such session" (also "no server running") and anything else, including ssh's 255, as unknown. Verify on the hosts' tmux version.
17. **Desktop visibility of daemon threads, and Claude Desktop for SSH sessions.** Untested: whether hub-started sessions appear in the Claude Desktop and mobile apps through Remote Control. Desktop's transcript location for SSH sessions is undocumented.
18. **RISKY — `claude --cloud "task"` output format.** It is undocumented, and the stub prints a checklist plus `Session ID: session_…` and `View: https://claude.ai/code/session_…`. The parser takes the first `claude.ai/code/session_…` URL or `session_…` token anywhere in stdout and stderr (`ClaudeAdapter.parseCloudStart`).
19. **`claude -p "msg" --cloud <id> --output-format json`.** The stub returns `{ok, session_id, url}`, as the docs describe.
20. **RISKY — cloud hook delivery.** The stub's cloud "VM" fires the checkout's committed `.claude/settings.json` HTTP hooks, with the Bearer token taken from the cloud environment's secret (`HUB_CLOUD_HOOK_TOKEN`). Unverified:
    - that real cloud sessions run repo HTTP hooks at all;
    - that the environment allowlist lets them reach the hub's Funnel or tunnel URL;
    - that env-var header interpolation works there;
    - which `session_id` they carry. The stub sends the `session_…` cloud id; the hub matches on it. If the real value is an inner UUID, correlation needs `$CLAUDE_CODE_REMOTE_SESSION_ID` or similar.
21. **Routines `/fire`.** Not exercised. It needs a per-routine token; the endpoint shape comes from the docs.
22. **Sessions started natively in the cloud.** These are listed only when their repo hooks reach the hub. `GET /v1/sessions` is undocumented and not used.

## Codex

23. **The daemon is shared with the ChatGPT desktop app over SSH.** The stub implements subscriber fan-out, approval replay on `thread/resume`, and first-answer-wins with `serverRequest/resolved`, following the source at openai/codex@12cca49c. Untested with the real desktop app:
    - that a hub-started thread (source `vscode`) shows in the desktop app's SSH project;
    - the desktop app's attach behavior.
24. **RISKY — `codex app-server daemon start` on hosts.** It requires a packaged CLI install; a bare binary fails. The stub prints `{"status":"started"|"alreadyRunning",…}`. The hub only checks that the command exits 0.
25. **WebSocket over `proxy`.** The hub performs the HTTP upgrade to `ws://localhost/` through the byte relay. Unverified that the real server accepts upgrades without an `Origin` header and with `perMessageDeflate` off (Origin is absent; the deflate extension isn't offered).
26. **`emittedAtMs` and the missing `jsonrpc` field.** The hub tolerates both and sends no `jsonrpc` field.
27. **Experimental fields.** The hub sends `capabilities: {experimentalApi: false}`, so the real server strips experimental fields. Nothing in the hub depends on them.
28. **Approval decisions.** The hub sends `accept`, `acceptForSession` or `decline`, and never `cancel` (which aborts the turn).
29. **`turn/interrupt` response timing.** The real server defers the response until the turn aborts. The hub waits up to 30 s.
30. **Desktop app on the Windows laptop.** It runs a private app-server, so the hub cannot drive those threads. Not modelled.
31. **`[mcp_servers.hub]` in `config.toml`.** The hub appends a managed block between markers. Unverified whether a running daemon picks up the block without a restart, and what cwd Codex starts MCP servers in (attribution falls back to host + most recent session).
32. **Codex `PostToolUse` hooks.** Not used. Hot reload for Codex comes from `fileChange` items on the event stream.
33. **`codex cloud exec`.** It prints only the task URL; the hub parses `https://chatgpt.com/codex/tasks/<id>`. Environment ids come from the `codex cloud` picker and are configured per account in `hub.config.json`; there is no list command.
34. **`codex cloud list --json`.** snake_case `{tasks:[…], cursor}`, status `pending|ready|applied|error`, at most 20 per page. The hub polls only the first page per account.
35. **`codex cloud status`.** It exits 1 unless the task is READY, so the hub doesn't treat a non-zero exit as an error.
36. **Codex cloud follow-ups.** None are possible from the CLI. The hub refuses `send` for Codex cloud tasks and points to ChatGPT.
37. **Undocumented `/wham/tasks/{id}` and `CODEX_STARTING_DIFF`.** Not used.

## MCP Apps

38. **Sandbox proxy.** The spec requires a sandbox proxy on a separate origin; the hub uses an opaque-origin sandbox instead (see DECISIONS). An app built against the official SDK should still work, because the SDK talks to `window.parent` with targetOrigin `*`. Verify with an SDK-built app.
39. **Claude Code as an MCP Apps host.** Untested whether the Claude Code CLI advertises the `io.modelcontextprotocol/ui` client capability. The hub always advertises it to app servers.

## GitHub (`gh`)

40. **`gh api` shapes.** The stub returns the GitHub REST v2022-11-28 fields the hub reads:
    - `pulls` (`head.ref`, `draft`, `merged_at`);
    - `pulls/{n}/reviews` (`state`);
    - `commits/{sha}/check-runs` (`status`, `conclusion`);
    - `commits?sha=&path=`, `compare/a...b` (`ahead_by`, `behind_by`), `git/trees?recursive=1`, and `contents` with `Accept: application/vnd.github.raw`.
    These are stable public API shapes, but the hub has only run them against the stub.
40a. **Pagination and commit statuses.** Branch and PR lists are paged with `page=N`, stopping at a page shorter than `per_page`, not by following `Link` headers. CI also reads `commits/{sha}/status` (`statuses[].state`). Both are standard REST, but the hub has only run them against the stub. Verify on a repo with more than 100 branches and one that has external commit statuses.
41. **Rate limits.** The hub polls every `githubPollIntervalSec` (default 60 s): per project, one call each for the repo, branches and PRs, plus per-branch calls for reviews, check runs and trees. Many projects or branches could hit the 5,000 requests/h limit; ETags and conditional requests are not used yet.
42. **Multiple accounts.** `GH_CONFIG_DIR` per account assumes `gh auth login` was run once per directory on the hub. Org SSO authorization (company account) is untested.
43. **Pushing new branches from hosts** uses the host's git credentials (an SSH key or the `gh` credential helper on that host). The hub doesn't provide them.
44. **Cloud result branches.** Real Claude cloud sessions push `claude/<slug>` branches. Linking a branch to its session relies on the stored `resultBranch` (the stub sets it) or on a commit message mentioning the session id, and the real CLI does neither. A reliable link may need the session's branch from claude.ai.

## Hardware and compute

45. **`nvidia-smi` query format** (`--query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`) is stable on real drivers but untested here (stub GPU). AMD and Jetson GPUs are not read.
46. **Device discovery** lists `/dev/ttyACM*`, `/dev/ttyUSB*` and `/dev/serial/by-id` names, and `ip -br link` CAN interfaces. Real probes (ST-LINK `st-info --probe`, `candump -n1`, SCPI `*IDN?`) belong in each device's configured `probe` command; untested here.
47. **Terminal pty resize** via `stty -F <client pty>` depends on the host user owning that pty (true for `ssh -tt`). tmux needs `window-size latest` (the default in tmux ≥ 3.1) so that one tmux session viewed from several browsers follows the latest resize.

## Ask Claude and canvas tools

48. **`permissions.allow` for MCP tools in a `--settings` file:** the hub writes `mcp__hub__canvas_*` / `mcp__hub__hub_*` there so canvas tools never prompt. To verify: that real Claude Code honors allow rules from `--settings` for servers loaded with `--mcp-config` (the stub does not prompt for MCP tools at all).
49. **Server `instructions` as context:** the assistant's persona and the canvas guidance travel in the MCP `initialize` result. To verify: how much of this real Claude Code puts into its system context. Fallback: an `--append-system-prompt` flag on the assistant launch.
50. **Streamable HTTP minimalism:** `/mcp` returns plain JSON, with no `Mcp-Session-Id` and no SSE. To verify: that `claude mcp add --transport http` accepts this (the spec allows a JSON response to a POST).
51. **Hub tool list fetched at `tools/list`:** the channel script asks the hub for canvas tools (10 s timeout) when Claude lists tools. To verify: whether real Claude Code tolerates that delay at startup, and whether it re-lists after `notifications/tools/list_changed` (not sent yet).

