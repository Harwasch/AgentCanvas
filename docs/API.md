# Hub HTTP + event API (PWA ↔ hub)

Auth: cookie `hub_token` (set by `GET /login?token=…`, HttpOnly, Secure, SameSite=Strict) or `Authorization: Bearer <hub token>`.
Hook intake and MCP tool calls from hosts use separate tokens (see README).

## Snapshot + event stream
- `GET /api/state` → `{ seq, hosts[], accounts[], checkouts[], sessions[], approvals[] (pending only), nodes[] (app nodes), layout: {[nodeId]: {x,y,w,h,collapsed}}, config: { publicUrl, vapidPublicKey } }`
- `WS /api/events?since=<seq>` (same origin, cookie auth) → each frame `{ seq, type, data, ts }`.

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
           meta: { channel?: "connected"|"disconnected", tmux?: string, cloudStatus?: string, diffSummary?: string, environment?: string, attempts?: number } }
Message  { id, session_id, seq, role: "user"|"assistant"|"tool"|"system", kind: "text"|"tool"|"command"|"reasoning"|"status", text, data, created_at }
Approval { id, session_id, source: "codex"|"claude-channel"|"claude-hook"|"app-confirm", title, detail, data, status: "pending"|"allow"|"deny"|"expired", created_at }
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
- `POST /api/approvals/:id` `{ decision: "allow"|"deny"|"allowSession" }`
- `GET  /api/checkouts/:id/files` → `{ files: {path, xy|null}[] }`; `GET /api/checkouts/:id/file?path=` → `{ path, content }`
- `POST /api/checkouts/:id/refresh`
- `POST /api/apps/publish` `{ hostId, dir, sessionId? }` → AppNode (repo-scan "unpublished app" path)
- `POST /api/apps/:id/call` `{ tool, arguments, confirmed }` → MCP `CallToolResult`, or `409 {code, reason}` when policy refuses (`undeclared|preview|not_granted|needs_confirm|rate_limited`)
- `POST /api/apps/:id/resource` `{ uri }` → MCP `resources/read` result
- `GET  /api/apps/:id/review` → `{ version, candidateCommit, dirtyFiles: string[], tools, lifecycle, serverFiles: {path, content}[], reviewHash }`
- `POST /api/apps/:id/promote` `{ commit: candidateCommit, grantActuate: boolean, commitDirty?: boolean, reviewHash }` → AppNode. When `dirtyFiles` is non-empty the hub refuses unless `commitDirty:true` ("Commit & pin"): it commits exactly the reviewed app files (refused if `reviewHash` no longer matches) and pins that commit.
- `POST /api/apps/:id/reload`
- `DELETE /api/apps/:id`
- `GET  /api/apps/:id/ui?v=<version>` → the app HTML with a deny-by-default CSP header (iframe `src`; iframe is `sandbox="allow-scripts allow-forms"`, never `allow-same-origin`)
- `GET  /api/apps/:id/thumbnail.png`
- `GET  /api/audit?node=<id>` → Audit[]
- `POST /api/layout` `{ nodeId, x, y, w?, h?, collapsed? }`
- `GET  /api/push/vapid` → `{ publicKey }`; `POST /api/push/subscribe` `{ subscription }`; `POST /api/push/test`

## Hosts → hub (host token)
- `POST /hooks/claude` — Claude Code HTTP hooks from hub-started sessions (`Authorization: Bearer <hook token>`)
- `POST /hooks/cloud` — repo hooks from vendor-cloud sessions (`Authorization: Bearer <cloud hook token>`)
- `POST /api/mcp/tools/:tool` — hub MCP tools (`publish_app`, `app_status`, `screenshot_app`, `unpublish_app`, `app_call`) from `hub_channel.py`

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
           readme: string /* markdown, ≤ 20 KB */, stats: { files, commits, sizeMB, branches, sessions },
           folders: { name, mb }[], checkouts: string[], updatedAt }
Branch   { id /* `${projectId}#${name}` */, projectId, name, base: string|null, goal: string|null, createdBy: "hub"|"agent"|"other",
           checkouts: string[] /* host worktrees on this branch */, head: string|null /* local head (first checkout) */,
           pushed: boolean, remoteSha: string|null, aheadRemote, behindRemote, aheadBase, behindBase,
           pr: { number, title, state: "open"|"draft"|"merged"|"closed", url, reviews: { approved, changesRequested, commented } } | null,
           ci: { state: "success"|"failure"|"pending"|"none", total, passed, failed, url: string|null } | null,
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
