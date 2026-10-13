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
