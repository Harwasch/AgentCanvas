# Hub HTTP + event API (PWA ↔ hub)

Auth: cookie `hub_token` (HttpOnly, Secure, SameSite=Strict) or `Authorization: Bearer <hub token>`.
- `POST /login` `{ token }` (`application/json` → `200 {ok}`; `application/x-www-form-urlencoded` → `303 /`) sets the cookie. The PWA uses this.
  `GET /login?token=…` (→ `302 /`) remains for the first-run link only.
- Cookie-authenticated requests (and the `/api/events` / terminal WebSocket upgrades) are refused with **403** when `Origin` is present and is not the hub
  (`publicUrl`, or the listen address on the hub's port), or when `Sec-Fetch-Site` is present and not `same-origin`/`none`. Bearer requests skip this check.
- POST bodies must be `Content-Type: application/json` (an empty body is fine); anything else gets **415**.

Hook intake and MCP tool calls from hosts use separate, per-host tokens (see "Hosts → hub").

## Snapshot + event stream
- `GET /api/state` → `{ seq, boot, hosts[], accounts[], checkouts[], sessions[], approvals[] (pending only), nodes[] (app nodes), layout: {[nodeId]: {x,y,w,h,collapsed}}, config: { publicUrl, vapidPublicKey } }`
- `WS /api/events?since=<seq>&boot=<boot>` (same origin, cookie auth) → each frame `{ seq, type, data, ts }`.
  - The first frame is `{ seq: 0, type: "hello", data: { boot, seq, resync } }`. When `resync` is true (another hub run, or `since` is older than the replay ring), nothing is replayed, and the client reloads `/api/state`.
  - Every 25 s the hub sends `{ seq: 0, type: "keepalive" }` plus a WebSocket ping, and closes clients that did not answer the previous ping.
  - Messages are not in the snapshot: after every snapshot load, refetch `GET /api/sessions/:id/messages` for the transcripts on screen.

| type | data |
|---|---|
| `host.upsert` | Host |
| `checkout.upsert` | Checkout |
| `session.upsert` | Session |
| `message.upsert` | Message (streaming deltas re-send the same `id` with the longer `text`) |
| `approval.upsert` | Approval |
| `node.upsert` | AppNode (canvas contract: `{id, type:"app", sessionId, title, url, thumbnail, status, version, ...}`) |
| `node.remove` | `{ id }` |
| `audit.append` | Audit |
| `layout.upsert` | `{ nodeId, x, y, w, h, collapsed }` |
| `toast` | `{ text, level: "info"|"warn"|"error" }` |

## Shapes
```ts
Host     { id, label, target, color, status: "online"|"offline"|"unknown", last_seen, info: { latencyMs, uname, error? } }
Account  { id, label, color, cloud: { claudeEnvironments: {id,label}[], codexEnvironments: {id,label}[] } }
Checkout { id, host_id, path, repo_id, repoName, remote_url, branch, head, head_subject, head_time, upstream, ahead, behind,
           dirty: number, changes: {path, xy}[], apps: {dir, id, title, published: boolean, nodeId?}[], updated_at }
Session  { id, vendor: "claude"|"codex", kind: "local"|"cloud", host_id|null, account_id, checkout_id|null, cwd, branch,
           native_id, native_url, title, status: "starting"|"running"|"idle"|"waiting"|"ended"|"error"|"pending"|"ready"|"applied",
           last_event, model, effort, created_at, updated_at,
           meta: { channel?: "connected"|"disconnected", tmux?: string, hostOffline?: boolean /* host unreachable: kept, retried when it is back */,
                   cloudStatus?: string, diffSummary?: string, environment?: string, attempts?: number } }
Message  { id, session_id, seq, role: "user"|"assistant"|"tool"|"system", kind: "text"|"tool"|"command"|"reasoning"|"status", text, data, created_at }
Approval { id, session_id, source: "codex"|"claude-channel"|"claude-hook"|"app-confirm"|"canvas-action", title, detail,
           data /* app-confirm and canvas-action: expiresAt (ms) */, status: "pending"|"allow"|"deny"|"expired", created_at }
AppNode  { id, type: "app", appId, sessionId, hostId, dir, title, state: "preview"|"promoted", version, pinnedCommit, grantedVersion,
           status: "starting"|"running"|"stopped"|"error", errors: string[], url, thumbnail, updatedAt, previewOf|null,
           manifest: { id, title, version, lifecycle, tools: {[name]: {tier: "read"|"actuate", confirm, maxPerMinute}}, node: {width, height} } }
Audit    { id, ts, app_node_id, tool, tier, caller, args, allowed, reason, result }
```

## Commands
- `POST /api/sessions` `{ vendor, where: "host"|"cloud", hostId?, accountId, checkoutId?, cwd?, branch?, environment?, prompt, attempts?, model?, effort? }` → Session
- `GET  /api/sessions/:id/messages` → Message[]
- `POST /api/sessions/:id/send` `{ text }`
- `POST /api/sessions/:id/interrupt`
- `POST /api/sessions/:id/settings` `{ model?, effort? }`
- `POST /api/sessions/:id/stop`
- `POST /api/sessions/:id/refresh` (cloud: poll status now; codex cloud: fetch diff)
- `POST /api/approvals/:id` `{ decision: "allow"|"deny"|"allowSession" }`. **409** `approval already <status>` when it was decided or expired.
  **409** `no longer waiting: …` when nothing can act on the answer any more: the tool call or app call that asked has ended, Claude closed the held hook, the Codex connection that asked was lost, or the session ended. The approval is then marked `expired`.
  **409** when the Claude channel is down; the approval stays pending, and you can answer in the terminal or the native app.
- `GET  /api/checkouts/:id/files` → `{ files: {path, xy|null}[] }`; `GET /api/checkouts/:id/file?path=` → `{ path, content }`
- `POST /api/checkouts/:id/refresh`
- `POST /api/apps/publish` `{ hostId, dir, sessionId? }` → AppNode (repo-scan "unpublished app" path)
- `POST /api/apps/:id/call` `{ tool, arguments, confirmed }` → MCP `CallToolResult`, or `409 {code, reason}` when policy refuses (`undeclared|preview|not_granted|needs_confirm|rate_limited`)
- `POST /api/apps/:id/resource` `{ uri }` → MCP `resources/read` result
- `GET  /api/apps/:id/review` → `{ version, candidateCommit, appTree, dirtyFiles: string[], changes: {status: "A"|"M"|"D", path}[], files: string[], tools, lifecycle, serverFiles: {path, content, size, truncated, changed}[], reviewHash }`.
  `changes`/`dirtyFiles` list every path under the app directory that Commit & pin would commit, recursively, including untracked files. `files` is the full file list of the reviewed tree.
  `serverFiles` previews up to 60 files, changed first, each cut at 100 KB. `reviewHash` = hash of `candidateCommit` + the id of the exact tree to commit.
- `POST /api/apps/:id/promote` `{ commit: candidateCommit, grantActuate: boolean, commitDirty?: boolean, reviewHash }` → AppNode. When `dirtyFiles` is non-empty, the hub refuses unless `commitDirty:true` ("Commit & pin").
  The hub rebuilds the tree, refuses if it differs from the reviewed one ("changed since you reviewed"), commits that exact tree on top of `candidateCommit`, and pins the commit.
- `POST /api/apps/:id/message` `{ text }` → `{ ok }`. An app view's `ui/message`, sent after the user confirms in the PWA. Only for promoted apps (409 for previews). The hub prefixes the text with `[message from app "<title>" (<id>) …]`.
- `POST /api/apps/:id/reload`
- `DELETE /api/apps/:id`
- `GET  /api/apps/:id/ui?v=<version>` → the app HTML with a deny-by-default CSP header plus `sandbox allow-scripts allow-forms` (iframe `src`; the iframe is also `sandbox="allow-scripts allow-forms"`, never `allow-same-origin`)
- `GET  /api/apps/:id/thumbnail.png`
- `GET  /api/audit?node=<id>` → Audit[]
- `POST /api/layout` `{ nodeId, x, y, w?, h?, collapsed? }`
- `GET  /api/push/vapid` → `{ publicKey }`; `POST /api/push/subscribe` `{ subscription }`; `POST /api/push/test`

## Hosts → hub (host token)
Each host has its own token (`HUB_TOKEN` = `HUB_HOOK_TOKEN` in its `~/.agent-hub/hub.env`, `HMAC(hookToken, "host:<hostId>")`). The hub derives the calling host from it.
A hub-started Claude session also has `HUB_SESSION_TOKEN` (`HMAC(hookToken, "session:<hubId>")`) in its environment.
- `POST /hooks/claude` — Claude Code HTTP hooks from hub-started sessions: `Authorization: Bearer $HUB_HOOK_TOKEN`, `X-Hub-Session-Token: $HUB_SESSION_TOKEN`.
  **403** when the hook's session is on another host, or when the session was launched with a secret and the header does not match it.
- `POST /hooks/cloud` — repo hooks from vendor-cloud sessions (`Authorization: Bearer <cloud hook token>`)
- `POST /api/mcp/tools/:tool` — hub MCP tools (`publish_app`, `app_status`, `screenshot_app`, `unpublish_app`, `app_call`, …) from `hub_channel.py`.
  Body: `{ arguments, context: { hubSessionId?, hubSessionToken?, hostId?, cwd, vendor } }`. **403** when `hostId` is not the token's host, when `hubSessionId` is unknown or on another host,
  or when its secret does not match (sessions launched with one). Without `hubSessionId`, the caller is the newest Codex session on the token's host whose cwd contains `cwd`.

## PWA screenshot mode
`/?shot=<appNodeId>` renders one app node alone at its manifest size (live iframe, no LOD) and sets `data-app-ready="1"` on it once the view sent `ui/notifications/initialized`. Playwright on the hub uses it for `screenshot_app` / `publish_app` thumbnails.

---

# v2: GitHub, branches, files, and the remaining node types

## Snapshot additions (`GET /api/state`)
`projects[]`, `branches[]`, `machines[]`, `devices[]`, `cnodes[]`, `todos[]`, `grants[]`, `hil: { plans[], runs[] }`.
New event types (same `{seq,type,data,ts}` frames): `project.upsert`, `branch.upsert`, `branch.remove`, `machine.upsert`, `device.upsert`,
`cnode.upsert`, `cnode.remove`, `todo.upsert`, `todo.remove`, `grant.upsert`, `hil.upsert` (a run).

## Shapes
```ts
Project  { id /* repo id */, name, remoteUrl, gh: { owner, repo, account, url } | null, defaultBranch,
           githubError: string | null /* last poll failed: branches, PRs, CI are the last known ones */, githubAt: number | null /* last good poll */,
           readme: string /* markdown, ≤ 20 KB */, stats: { files, commits, sizeMB, branches, sessions },
           folders: { name, mb }[], checkouts: string[], updatedAt }
Branch   { id /* `${projectId}#${name}` */, projectId, name, base: string|null, goal: string|null, createdBy: "hub"|"agent"|"other",
           checkouts: string[] /* host worktrees on this branch */, head: string|null /* local head (first checkout) */,
           pushed: boolean, remoteSha: string|null, aheadRemote, behindRemote, aheadBase, behindBase,
           pr: { number, title, state: "open"|"draft"|"merged"|"closed", url, reviews: { approved, changesRequested, commented } } | null,
           ci: { state: "success"|"failure"|"pending"|"none", total, passed, failed, url: string|null } | null /* check runs + commit statuses */,
           commits: { sha, subject, author, at }[] /* last ≤ 8 on the branch */, apps: { path, id, title }[] /* found on the pushed branch */,
           cloud: { sessionId?: string } | null /* claude/* or codex result branches */, updatedAt }
Machine  { id /* host id, or "claude-cloud" | "codex-cloud" */, label, kind: "host"|"cloud", color, status: "online"|"offline"|"managed",
           cpu: { pct, cores } | null, mem: { usedMB, totalMB } | null, gpu: { name, utilPct, memUsedMB, memTotalMB }[], load: number|null, updatedAt }
Device   { id, hostId, parentId: string|null, title, kind, icon: "SWD"|"CAN"|"USB"|"SER"|"LAN"|"DUT"|"BUS"|"SSH",
           port, fw, status: "connected"|"missing"|"reachable"|"busy"|"unknown", source: "declared"|"discovered",
           lock: { sessionId, since } | null, updatedAt }
Grant    { id, sessionId, hostId, resources, purpose, quotaGB: number|null, usedGB: number|null, status: "requested"|"active"|"revoked", createdAt }
HilPlan  { id, title, hostId, devices: string[], plan: string|null /* doc path */, setup: string[] /* chain shown as a → b → c */ }
HilRun   { id, planId, status: "running"|"passed"|"failed"|"aborted", pass, fail, left,
           rows: { id, req, name, status: "pending"|"run"|"pass"|"fail"|"skip", durMs: number|null }[], log: string[] /* tail */,
           startedBy /* "you" | session id */, startedAt, finishedAt: number|null }
Todo     { id, scope: string|null /* project id */, text, src: "you" | string /* session id */, done: boolean,
           dispatchedSessionId: string|null, createdAt }
CNode    { id, type: "note"|"todos"|"htodo"|"suggest"|"review"|"file"|"terminal", parentId: string|null, data, createdBy: "you"|string, createdAt, updatedAt }
  note     data { title, text }
  todos    data { title, scope: projectId|null }                               // a to-do list; items are Todo rows with that scope
  htodo    data { todoId }                                                     // agent-created to-do, child of the agent's session
  suggest  data { title, prompt, rationale, vendor, hostId|null, accountId, branchId|null, status: "open"|"launched"|"dismissed", sessionId? }
  review   data { sessionId, title, path, source: FileSource, sha, kind /* "Markdown · 3 charts" */, note, promoteTo|null,
                  checklist: { text, done }[], comments: { id, author: "you"|"agent", text, at }[], status: "pending"|"approved"|"changes" }
  file     data { source: FileSource, path, sha /* pinned commit */, blob, kind: "doc"|"image"|"code"|"model3d"|"pdf"|"text"|"binary",
                  newer: { sha, subject, at } | null }
  terminal data { hostId, cwd, mode: "shell"|"agent", sessionId|null, status: "open"|"closed" }
FileSource = { kind: "checkout", checkoutId } | { kind: "github", projectId, ref }
```
Node parents for the canvas: project ← branch (by `projectId`) ← session (by `checkout_id`'s branch) ← review/suggest/htodo/app/grant/terminal (by `parentId`/`sessionId`);
cluster ← machine ← device (by `hostId`/`parentId`) ← HIL plan (by `hostId`); `todos`/`note`/`file` cnodes may be free (`parentId:null`) or attached.
"Agent reference chips" under a machine are derived from local sessions on that host (no API).

## Commands
- `POST /api/cnodes` `{ type: "note"|"todos"|"file"|"terminal", parentId?, data }` → CNode. For `file`: `data { source, path }` (hub pins the current commit). For `terminal`: `data { hostId, cwd?, sessionId? }`.
- `POST /api/cnodes/:id` `{ data }` (shallow merge; e.g. note text, review checklist) · `DELETE /api/cnodes/:id`
- `POST /api/cnodes/:id/latest` (file/review: re-pin to the newest commit that touched the path)
- `POST /api/todos` `{ text, scope }` · `POST /api/todos/:id` `{ text?, done? }` · `DELETE /api/todos/:id`
- `POST /api/todos/:id/dispatch` `{ vendor, where, accountId, checkoutId?, branchId? }` → Session (prompt = the to-do text)
- `POST /api/suggestions/:id/launch` `{ vendor?, where?, accountId?, checkoutId? }` → Session · `POST /api/suggestions/:id/dismiss`
- `POST /api/reviews/:id/decision` `{ decision: "approve"|"changes", note? }` (sent to the agent as a message) · `POST /api/reviews/:id/comments` `{ text }`
- `GET  /api/files/list?source=<json FileSource>&q=` → `{ files: { path, kind }[] }` (≤ 2000)
- `GET  /api/files/raw?source=<json>&path=&sha=` → raw bytes with a content type (text, images, STL, PDF). Never executed; served with `CSP: sandbox`.
- `POST /api/branches` `{ projectId, checkoutId /* where to branch */, base, name, goal?, push?: boolean }` → Branch (git worktree on that host)
- `POST /api/branches/:id/refresh` · `GET /api/branches/:id/files` (same as files/list with the branch's source)
- `POST /api/devices/:id/lock` `{ sessionId | null }`
- `POST /api/grants` `{ sessionId, hostId, resources, purpose, quotaGB? }` · `POST /api/grants/:id` `{ status: "active"|"revoked" }`
- `POST /api/hil/:planId/run` · `POST /api/hil/runs/:id/abort` · `POST /api/hil/runs/:id/rerun-failed`
- `DELETE /api/terminals/:id` (closes the shell) · `WS /api/terminals/:id/ws` — client→hub JSON text frames `{type:"input", data}` | `{type:"resize", cols, rows}`;
  hub→client binary frames = raw terminal output (UTF-8). Backed by a tmux session on the host, so it survives reconnects.

## Agent tools (hub MCP) added
`request_review`, `suggest_followup`, `add_todo`, `list_devices`, `acquire_device`, `release_device`, `request_compute`, `run_on_host`, `run_hil`.

# Ask Claude and canvas tools

## Commands (hub token)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/assistant/start` | `{hostId, accountId, prompt?}` | Session (`meta.role = "assistant"`, cwd = host home, `HUB_ROLE=assistant`) |
| POST | `/api/canvas/view` | `{clientId, mode, nodes:[{id,kind,title,parent,x,y,w,h,ex}], selected, focusId, visible}` | What this browser shows; the canvas tools read the newest report |
| GET | `/api/canvas/batches` | — | Last 20 edit batches `{id, by, sessionId, summary, ids, at, undone}` |
| POST | `/api/canvas/undo/:batchId` | — | Reverts the batch: layout rows back to their previous values, created notes/files/to-dos removed, removed nodes restored |
| POST | `/api/approvals/:id` | `{decision}` | Also decides `source: "canvas-action"` approvals (confirm tier) |

Layout rows gain `size: {c?: [w,h], x?: [w,h]}` (user-resized, per collapsed/expanded state); `POST /api/layout` merges `size`, where `null` clears one state.

## Events

| Type | Data | PWA |
|---|---|---|
| `canvas.changed` | `{batchId, by, sessionId, summary[], ids[], moved, at}` | Glow on `ids`, Undo pill. If `moved` and an auto layout is showing, switches to Custom over that layout. |
| `canvas.undone` | `{batchId, ids}` | Pill shows "undone". |
| `canvas.ui` | `{layoutMode?, focus?, select?, by}` | Applies the layout mode, pans to the node, sets the selection. |
| `layout.upsert` | `{nodeId, removed: true}` | Saved position deleted (by undo). |

## Tools

- **Hosts:** `GET /api/mcp/tools` (host token) lists the canvas tools for the channel script. Calls go through `POST /api/mcp/tools/:tool` like the other hub tools.
- **Your own machines:** `POST /mcp` (bearer `mcpToken`) is a Streamable-HTTP MCP endpoint. It supports `initialize`, `tools/list`, `tools/call` and `ping`; notifications get 202, and responses are JSON (no SSE). `GET /mcp` returns 405. The `x-hub-client` header names the client in the audit log and the Undo pill.
- **Confirm-tier calls** create an approval (`source: "canvas-action"`, `session_id` = the calling session or `mcp:external`, `data.expiresAt`) and block for up to 150 s, below the 180 s tool-call timeout of `hub_channel.py` and Codex. If the waiting HTTP request closes first, the approval is marked `expired` right away. A denial, expiry or timeout returns `isError` to Claude, and the action never runs.
- **Audit:** every canvas tool call except the two reads is audited (`app_node_id: "canvas"`).
