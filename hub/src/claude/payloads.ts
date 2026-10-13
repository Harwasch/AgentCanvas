// Parsing for Claude Code HTTP hook bodies and hub-channel relay lines.
// A wrong parse here is silent (an approval that never shows, a session that
// never leaves "running"), so everything is validated and normalized.

export type HookEventName = 'UserPromptSubmit' | 'PreToolUse' | 'PermissionRequest' | 'PostToolUse' | 'Stop' | 'Notification' | 'SessionEnd' | 'SubagentStop' | 'PostToolUseFailure';

export interface HookEvent {
  event: HookEventName;
  sessionId: string;
  transcriptPath?: string;
  cwd?: string;
  permissionMode?: string;
  prompt?: string;
  toolName?: string;
  toolInput?: Record<string, any>;
  toolUseId?: string;
  toolResponse?: any;
  lastAssistantMessage?: string;
  stopHookActive?: boolean;
  message?: string;
  notificationType?: string;
  raw: Record<string, any>;
}

const KNOWN = new Set<HookEventName>(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd', 'SubagentStop', 'PostToolUseFailure']);
const str = (v: any) => (typeof v === 'string' ? v : undefined);

export function parseHook(body: unknown): { ok: true; hook: HookEvent } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'hook body must be a JSON object' };
  const b = body as Record<string, any>;
  const event = b.hook_event_name;
  if (typeof event !== 'string' || !KNOWN.has(event as HookEventName)) return { ok: false, error: `unsupported hook_event_name ${JSON.stringify(event)}` };
  const sessionId = str(b.session_id);
  if (!sessionId) return { ok: false, error: 'session_id missing' };
  const h: HookEvent = {
    event: event as HookEventName,
    sessionId,
    transcriptPath: str(b.transcript_path),
    cwd: str(b.cwd),
    permissionMode: str(b.permission_mode),
    raw: b,
  };
  switch (h.event) {
    case 'UserPromptSubmit':
      h.prompt = typeof b.prompt === 'string' ? b.prompt : b.prompt == null ? '' : JSON.stringify(b.prompt);
      break;
    case 'PreToolUse':
    case 'PermissionRequest':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      h.toolName = str(b.tool_name);
      if (!h.toolName) return { ok: false, error: `${event}: tool_name missing` };
      h.toolInput = b.tool_input && typeof b.tool_input === 'object' ? b.tool_input : {};
      h.toolUseId = str(b.tool_use_id);
      if (h.event !== 'PreToolUse') h.toolResponse = b.tool_response;
      break;
    case 'Stop':
    case 'SubagentStop':
      h.stopHookActive = !!b.stop_hook_active;
      h.lastAssistantMessage = str(b.last_assistant_message);
      break;
    case 'Notification':
      h.message = str(b.message);
      h.notificationType = str(b.notification_type);
      break;
  }
  return { ok: true, hook: h };
}

/** Paths a tool call wrote to (for hot reload): Write/Edit/MultiEdit/NotebookEdit file_path, plus apply_patch-style lists. */
export function writtenPaths(h: HookEvent): string[] {
  const i = h.toolInput || {};
  const out: string[] = [];
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof i[k] === 'string') out.push(i[k]);
  if (Array.isArray(i.edits)) for (const e of i.edits) if (typeof e?.file_path === 'string') out.push(e.file_path);
  const r = h.toolResponse;
  if (r && typeof r === 'object' && typeof r.filePath === 'string') out.push(r.filePath);
  return [...new Set(out)];
}

export function permissionDecision(behavior: 'allow' | 'deny', message?: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: message || 'Denied in Agent Hub', interrupt: false },
    },
  };
}

// ---------------------------------------------------------------- channel relay
export type ChannelInbound =
  | { type: 'hello'; session: string; pid?: number }
  | { type: 'permission_request'; requestId: string; toolName: string; description: string; inputPreview: string }
  | { type: 'pong' };

export const REQUEST_ID_RE = /^[a-km-z]{5}$/;

export function parseChannelLine(m: unknown): { ok: true; msg: ChannelInbound } | { ok: false; error: string } {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'not an object' };
  const o = m as Record<string, any>;
  switch (o.type) {
    case 'hello':
      if (typeof o.session !== 'string') return { ok: false, error: 'hello without session' };
      return { ok: true, msg: { type: 'hello', session: o.session, pid: typeof o.pid === 'number' ? o.pid : undefined } };
    case 'pong':
      return { ok: true, msg: { type: 'pong' } };
    case 'permission_request': {
      const id = typeof o.request_id === 'string' ? o.request_id.toLowerCase() : '';
      if (!REQUEST_ID_RE.test(id)) return { ok: false, error: `bad request_id ${JSON.stringify(o.request_id)}` };
      if (typeof o.tool_name !== 'string' || !o.tool_name) return { ok: false, error: 'permission_request without tool_name' };
      return {
        ok: true,
        msg: {
          type: 'permission_request', requestId: id, toolName: o.tool_name,
          description: typeof o.description === 'string' ? o.description : '',
          inputPreview: typeof o.input_preview === 'string' ? o.input_preview : o.input_preview == null ? '' : JSON.stringify(o.input_preview),
        },
      };
    }
    default:
      return { ok: false, error: `unknown channel message type ${JSON.stringify(o.type)}` };
  }
}

/** Outbound relay lines (hub → channel). meta keys must be [A-Za-z0-9_] or Claude drops them silently. */
export function channelMessage(content: string, meta: Record<string, string> = {}) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (/^[A-Za-z0-9_]+$/.test(k)) clean[k] = String(v);
  return { type: 'message', content, meta: clean };
}
export function channelPermission(requestId: string, behavior: 'allow' | 'deny') {
  return { type: 'permission', request_id: requestId.toLowerCase(), behavior };
}

/** Claude's per-project transcript dir: cwd with every non-alphanumeric char replaced by '-'. */
export function projectSlug(cwd: string): string {
  const s = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return s.length > 200 ? s.slice(0, 200) : s; // >200 adds a hash suffix in the real CLI (algorithm unknown)
}

// ---------------------------------------------------------------- transcript
export interface TranscriptItem {
  uuid: string;
  role: 'user' | 'assistant' | 'tool';
  kind: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text: string;
  data?: any;
  ts: string;
}

/** One JSONL transcript line → zero or more display items. Unknown line types are skipped. */
export function parseTranscriptLine(line: string): TranscriptItem[] {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (!o || (o.type !== 'user' && o.type !== 'assistant') || !o.message) return [];
  const ts = o.timestamp || new Date().toISOString();
  const uuid = String(o.uuid || '');
  const c = o.message.content;
  if (o.type === 'user' && typeof c === 'string') return [{ uuid, role: 'user', kind: 'text', text: c, ts }];
  if (!Array.isArray(c)) return [];
  const out: TranscriptItem[] = [];
  c.forEach((b: any, i: number) => {
    const id = c.length > 1 ? `${uuid}:${i}` : uuid;
    if (b?.type === 'text') out.push({ uuid: id, role: o.type === 'user' ? 'user' : 'assistant', kind: 'text', text: String(b.text ?? ''), ts });
    else if (b?.type === 'thinking') out.push({ uuid: id, role: 'assistant', kind: 'thinking', text: String(b.thinking ?? ''), ts });
    else if (b?.type === 'tool_use') out.push({ uuid: id, role: 'assistant', kind: 'tool_use', text: b.name, data: { id: b.id, name: b.name, input: b.input }, ts });
    else if (b?.type === 'tool_result') {
      const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x?.text ?? '').join('\n') : '';
      out.push({ uuid: id, role: 'tool', kind: 'tool_result', text: t, data: { toolUseId: b.tool_use_id, isError: !!b.is_error }, ts });
    }
  });
  return out;
}
