import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { setExpanded, toast, useHub, watchMessages } from '../store';
import type { Approval, Message, Session } from '../types';
import { openTerminal } from './MachineNode';
import { Icon, ProviderBadge, StatusPill, computeColor, computeKey, computeName, duration, timeAgo } from '../ui';

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

const MODELS: Record<string, string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5-codex', 'gpt-5', 'gpt-5-codex-mini'],
};
const EFFORTS: Record<string, string[]> = {
  claude: ['low', 'medium', 'high'],
  codex: ['minimal', 'low', 'medium', 'high'],
};
const withCur = (list: string[], cur: string | null) => (cur && !list.includes(cur) ? [cur, ...list] : list);

export const nativeLabel = (s: Session) => (s.vendor === 'claude' ? 'Open in claude.ai' : 'Open in ChatGPT');
/** where a session started outside the hub came from */
const sourceLabel = (src: unknown) => (src === 'claude-desktop' ? 'Claude app' : src === 'cli' ? 'terminal' : 'outside the hub');

/** Read-only footer of a session started outside the hub, with the take-over confirmation. */
function ExternalPanel({ s }: { s: Session }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const src = sourceLabel(s.meta?.source);
  const recentMs = Date.now() - Number(s.meta?.mtime || 0);
  const maybeOpen = s.status === 'running' || recentMs < 5 * 60_000;
  const takeover = async () => {
    setBusy(true);
    try {
      await api.takeover(s.id);
      toast('Taken over: the hub now runs this conversation');
      setAsking(false);
    } catch (e) { toast(`Take over failed: ${(e as Error).message}`, 'error'); }
    setBusy(false);
  };
  return (
    <div className="card" data-testid="external-panel" style={{ padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 8, flex: 'none' }} onPointerDown={stop}>
      <span style={{ fontSize: 12, color: '#C9CCD2', lineHeight: 1.45 }}>
        Started in the <b style={{ fontWeight: 600 }}>{src}</b>. Shown read-only: new messages appear here within about 30 s. Chat, approvals and interrupts stay in the {src}.
      </span>
      {asking ? (
        <>
          <span style={{ fontSize: 12, color: '#FFD23F', lineHeight: 1.45 }} data-testid="takeover-warning">
            Close this conversation in the {src} first. The hub resumes it with <span className="mono">claude --resume</span>; two programs writing to one conversation will corrupt it.
            {maybeOpen ? ` It was active ${timeAgo(Number(s.meta?.mtime) || s.updated_at)}, so it may still be open.` : ''}
          </span>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button className="b" style={{ height: 28 }} onClick={() => setAsking(false)} disabled={busy}>Cancel</button>
            <button className="b bp" style={{ height: 28 }} onClick={takeover} disabled={busy} data-testid="takeover-confirm">{busy ? 'Starting…' : 'It is closed, take over'}</button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="b bp" style={{ height: 28 }} onClick={() => setAsking(true)} data-testid="takeover">Take over…</button>
        </div>
      )}
    </div>
  );
}

/** seconds until a confirm-tier approval expires (the waiting tool call gives up then), ticking */
function useExpiresIn(expiresAt: unknown): number | null {
  const at = typeof expiresAt === 'number' ? expiresAt : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [at]);
  return at ? Math.max(0, Math.round((at - now) / 1000)) : null;
}

export function ApprovalCard({ a, vendor }: { a: Approval; vendor: string }) {
  const [busy, setBusy] = useState(false);
  const left = useExpiresIn(a.data && typeof a.data === 'object' ? a.data.expiresAt : null);
  const decide = async (d: 'allow' | 'deny' | 'allowSession') => {
    setBusy(true);
    try { await api.decide(a.id, d); } catch (e) { toast(`Decision failed: ${(e as Error).message}`, 'error'); setBusy(false); }
  };
  const reason = a.data && typeof a.data === 'object' ? (a.data.reason as string) : '';
  return (
    <div data-testid="approval-card" data-approval-id={a.id} style={{ background: '#1A1C21', border: '1px solid #FFD23F', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ background: '#FFD23F', color: '#0B0C0E', fontWeight: 700, borderRadius: 999, padding: '2px 8px', fontSize: 11 }}>Needs approval</span>
        <span style={{ fontSize: 11.5, color: '#8A8F98' }}>{a.source} · {timeAgo(a.created_at)}</span>
        {left !== null ? <span data-testid="approval-expires" style={{ fontSize: 11.5, color: left <= 30 ? '#FFB3B6' : '#8A8F98', marginLeft: 'auto' }}>{left > 0 ? `expires in ${left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : `${left}s`}` : 'expired'}</span> : null}
      </div>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{a.title}</span>
      {a.detail ? <div className="mono prose" style={{ background: '#0B0C0E', border: '1px solid #24272D', borderRadius: 8, padding: '7px 10px', fontSize: 11.5, color: '#E7E8EA' }}>{a.detail}</div> : null}
      {reason ? <span style={{ fontSize: 11.5, color: '#A3A7AF' }}>{reason}</span> : null}
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="b bp" style={{ height: 30 }} disabled={busy} data-testid="approval-allow" onClick={() => decide('allow')}>Allow</button>
        {vendor === 'codex' ? <button className="b" style={{ height: 30 }} disabled={busy} onClick={() => decide('allowSession')}>Allow for session</button> : null}
        <button className="b" style={{ height: 30 }} disabled={busy} data-testid="approval-deny" onClick={() => decide('deny')}>Deny</button>
      </div>
    </div>
  );
}

export function MessageItem({ m }: { m: Message }) {
  const [open, setOpen] = useState(false);
  if (m.role === 'user' && m.kind === 'text') {
    return <div data-testid="msg" data-role="user" className="prose" style={{ alignSelf: 'flex-end', maxWidth: '85%', background: '#1A1C21', border: '1px solid #24272D', borderRadius: 12, padding: '8px 12px', lineHeight: 1.5, fontSize: 12.5 }}>{m.text}</div>;
  }
  if (m.kind === 'reasoning') {
    return <div data-testid="msg" data-role={m.role} className="prose" style={{ lineHeight: 1.5, fontSize: 12, color: '#8A8F98', fontStyle: 'italic', borderLeft: '2px solid #2A2D33', paddingLeft: 10 }}>{m.text}</div>;
  }
  if (m.kind === 'status' || m.role === 'system') {
    return <div data-testid="msg" data-role={m.role} style={{ alignSelf: 'center', fontSize: 11, color: '#6E727A', display: 'flex', gap: 6, alignItems: 'center' }}><span style={{ width: 16, height: 1, background: '#2A2D33' }} />{m.text}<span style={{ width: 16, height: 1, background: '#2A2D33' }} /></div>;
  }
  if (m.kind === 'tool' || m.kind === 'command') {
    const d = (m.data || {}) as any;
    const label = m.kind === 'command' ? '$' : (d.name || 'tool');
    const out = d.output != null ? String(d.output) : d.input ? JSON.stringify(d.input, null, 2) : '';
    const meta = m.kind === 'command' ? (d.exitCode == null ? 'running' : `exit ${d.exitCode}`) : '';
    return (
      <div data-testid="msg" data-role={m.role} className="card" style={{ overflow: 'hidden', flex: 'none' }}>
        <button onClick={() => setOpen(!open)} style={{ width: '100%', background: 'transparent', border: 0, color: '#E7E8EA', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', textAlign: 'left' }}>
          <span className="mono" style={{ fontSize: 10.5, color: '#0B0C0E', background: '#A3A7AF', borderRadius: 4, padding: '1px 5px', flex: 'none' }}>{label}</span>
          <span className="mono ell" style={{ fontSize: 11.5, flex: 1 }}>{m.text}</span>
          <span style={{ fontSize: 11, color: d.exitCode ? '#FFB3B6' : '#8A8F98', flex: 'none' }}>{meta}</span>
        </button>
        {open && out ? <div className="mono scroll" style={{ borderTop: '1px solid #24272D', padding: '8px 10px', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre', overflow: 'auto', maxHeight: 220, color: '#C9CCD2' }}>{out}</div> : null}
      </div>
    );
  }
  return <div data-testid="msg" data-role={m.role} className="prose" style={{ lineHeight: 1.55, fontSize: 12.5, color: '#D5D7DB' }}>{m.text}</div>;
}

export type SessionMode = 'collapsed' | 'expanded' | 'sheet';

function SessionNodeImpl({ id, mode }: { id: string; mode: SessionMode }) {
  const s = useHub((h) => h.sessions[id]);
  const hosts = useHub((h) => h.hosts);
  const account = useHub((h) => (s ? h.accounts[s.account_id] : undefined));
  const approvalsMap = useHub((h) => h.approvals);
  const msgs = useHub((h) => h.messages[id]);
  const [text, setText] = useState('');
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const big = mode !== 'collapsed';

  const approvals = useMemo(() => Object.values(approvalsMap).filter((a) => a.session_id === id && a.status === 'pending'), [approvalsMap, id]);

  // loaded while open, and again after every reconnect (messages are not in the snapshot)
  useEffect(() => (big ? watchMessages(id) : undefined), [big, id]);

  // stick to bottom when new messages arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, approvals.length, big, diff]);

  useEffect(() => {
    const onReply = (e: Event) => { if ((e as CustomEvent).detail === id) setTimeout(() => inputRef.current?.focus(), 60); };
    window.addEventListener('hub:reply', onReply);
    return () => window.removeEventListener('hub:reply', onReply);
  }, [id]);

  if (!s) return null;
  const key = computeKey(s);
  const color = computeColor(key, hosts);
  const waiting = s.status === 'waiting' || approvals.length > 0;
  const running = s.status === 'running';
  const cloud = s.kind === 'cloud';
  const ext = !!s.meta?.external;

  const reply = () => {
    if (mode === 'collapsed') setExpanded(id, true);
    window.dispatchEvent(new CustomEvent('hub:reply', { detail: id }));
  };
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    try { await api.send(id, t); } catch (e) { toast(`Send failed: ${(e as Error).message}`, 'error'); setText(t); }
  };
  const interrupt = async () => { try { await api.interrupt(id); } catch (e) { toast(`Interrupt failed: ${(e as Error).message}`, 'error'); } };
  const stopSession = async () => { try { await api.stop(id); } catch (e) { toast(`Stop failed: ${(e as Error).message}`, 'error'); } };
  const settings = async (patch: { model?: string; effort?: string }) => { try { await api.settings(id, patch); } catch (e) { toast(`Settings failed: ${(e as Error).message}`, 'error'); } };
  const fetchDiff = async () => {
    setBusy(true);
    try {
      const r = await api.refresh(id);
      setDiff((r && (r.diffSummary || r.message)) || 'Refreshed');
      if (mode === 'collapsed') setExpanded(id, true);
    } catch (e) { toast(`Refresh failed: ${(e as Error).message}`, 'error'); }
    setBusy(false);
  };
  const toggle = () => {
    if (mode === 'sheet') setExpanded(id, false);
    else setExpanded(id, mode === 'collapsed');
  };

  const border = waiting ? '#FFD23F' : color + (running ? '33' : '55');
  const diffText = diff && s.meta?.diffSummary && diff !== s.meta.diffSummary ? `${diff}\n\n${s.meta.diffSummary}` : (s.meta?.diffSummary || diff);

  return (
    <div
      data-testid={mode === 'sheet' ? 'session-sheet' : 'session-node'}
      data-session-id={s.id}
      data-vendor={s.vendor}
      data-status={s.status}
      data-kind={s.kind}
      style={{
        position: 'relative', height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#15171B',
        borderRadius: mode === 'sheet' ? 0 : 14, padding: mode === 'sheet' ? '12px 14px calc(12px + env(safe-area-inset-bottom))' : '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 8, border: mode === 'sheet' ? 0 : `${waiting ? 2 : 1}px solid ${border}`,
        boxShadow: '0 8px 24px rgba(0,0,0,.3)', opacity: s.status === 'ended' && mode === 'collapsed' ? 0.45 : 1,
      }}
    >
      {waiting ? (
        <div style={{ margin: '-12px -14px 2px', padding: '6px 8px 6px 12px', background: '#FFD23F', color: '#0B0C0E', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid #E0B520', flex: 'none' }} onPointerDown={stop}>
          <Icon name="bell" size={13} sw={2.2} />
          <span className="ell" style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>{approvals.length ? `Has a question · ${approvals.length} approval${approvals.length > 1 ? 's' : ''}` : 'Has a question'}</span>
          <button onClick={reply} style={{ height: 24, borderRadius: 7, border: 0, padding: '0 9px', fontSize: 11.5, fontWeight: 600, background: '#0B0C0E', color: '#FFD23F' }}>Reply</button>
          {big ? null : (
            <button onClick={stopSession} aria-label="End session" title="End session" style={{ width: 26, height: 24, borderRadius: 7, border: 0, background: 'transparent', color: 'inherit', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="x" size={13} sw={2.4} /></button>
          )}
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none', minWidth: 0 }}>
        {mode === 'sheet' ? <button className="b ghost" style={{ width: 30, padding: 0, justifyContent: 'center' }} aria-label="Back to canvas" onClick={toggle}><Icon name="back" /></button> : null}
        <ProviderBadge vendor={s.vendor} />
        <span className="ell" style={{ fontWeight: 500, fontSize: 14, flex: 1 }} title={s.title}>{s.title || '(untitled session)'}</span>
        {big ? (
          <>
            <span className="desk-only" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#C9CCD2', border: `1px solid ${color}55`, borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap' }}>
              <span className="dot" style={{ width: 7, height: 7, background: color }} />{computeName(key, hosts)} · {account?.label || s.account_id}
            </span>
            {s.native_url ? <a className="b lnk" style={{ height: 26 }} href={s.native_url} target="_blank" rel="noopener noreferrer" onPointerDown={stop} data-testid="native-link">{nativeLabel(s)} <Icon name="ext" size={11} /></a> : null}
            {!cloud && s.host_id ? <button className="b" style={{ height: 26 }} onPointerDown={stop} data-testid="session-shell" title="Open a shell in this session's working directory"
              onClick={() => openTerminal(s.host_id!, { parentId: s.id, cwd: s.cwd, sessionId: s.id })}><span className="mono" style={{ fontSize: 10.5 }}>&gt;_</span>Shell here</button> : null}
            {!cloud && !ext ? <button className="b" style={{ height: 26 }} onPointerDown={stop} onClick={interrupt} data-testid="chat-interrupt">Interrupt</button> : null}
            <button className="b desk-only" style={{ height: 26 }} onPointerDown={stop} onClick={stopSession} disabled={s.status === 'ended'} title={ext ? 'Remove from the canvas (the conversation itself is untouched)' : undefined}>{ext ? 'Hide' : 'Stop'}</button>
          </>
        ) : null}
        {mode !== 'sheet' ? (
          <button className="b ghost" style={{ width: 26, height: 26, padding: 0, justifyContent: 'center', flex: 'none' }} aria-label={big ? 'Collapse session' : 'Expand session'} data-testid="node-expand" onPointerDown={stop} onClick={toggle}>
            <Icon name="chev" style={{ transform: `rotate(${big ? 180 : 0}deg)`, transition: 'transform .2s' }} />
          </button>
        ) : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#A3A7AF', minWidth: 0, flex: 'none' }}>
        <span className="dot" style={{ background: color }} />
        <span style={{ color: '#E7E8EA', whiteSpace: 'nowrap' }}>{computeName(key, hosts)}</span><span>·</span>
        <span style={{ whiteSpace: 'nowrap' }}>{account?.label || s.account_id}</span>
        {s.branch ? <><span>·</span><span className="mono ell" style={{ fontSize: 11 }}>{s.branch}</span></> : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flex: 'none', minWidth: 0 }}>
        <StatusPill status={waiting ? 'waiting' : s.status} onClick={ext ? undefined : reply} />
        {ext ? <span className="ell" data-testid="external-badge" title="Started outside the hub; take it over to continue it here" style={{ color: '#8A8F98', fontSize: 11.5, border: '1px solid #2A2D33', borderRadius: 999, padding: '1px 7px' }}>read-only · {sourceLabel(s.meta?.source)}</span> : null}
        {cloud ? <span className="ell" style={{ color: '#8A8F98', fontSize: 11.5 }}>cloud {s.meta?.cloudStatus || s.status}{s.meta?.environment ? ` · env ${s.meta.environment}` : ''}{s.meta?.attempts ? ` · ${s.meta.attempts}×` : ''}</span> : null}
        <span className="mono ell" style={{ color: '#8A8F98', fontSize: 11.5, marginLeft: 'auto' }}>{[s.model, s.effort].filter(Boolean).join(' · ') || '—'}{big ? '' : ` · ${duration(s.created_at)}`}</span>
      </div>

      {!big ? (
        approvals.length ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }} onPointerDown={stop}>
            <span className="mono ell" style={{ fontSize: 11, color: '#C9CCD2', flex: 1 }} title={approvals[0].detail}>{approvals[0].detail || approvals[0].title}</span>
            <button className="b bp" style={{ height: 24 }} data-testid="approval-allow" onClick={() => api.decide(approvals[0].id, 'allow').catch((e) => toast(String(e.message), 'error'))}>Allow</button>
            <button className="b" style={{ height: 24 }} data-testid="approval-deny" onClick={() => api.decide(approvals[0].id, 'deny').catch((e) => toast(String(e.message), 'error'))}>Deny</button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 'auto', minWidth: 0 }}>
            <span style={{ flex: 1, height: 3, background: '#24272D', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
              <span style={{ position: 'absolute', inset: 0, width: running ? '40%' : s.status === 'ended' ? '100%' : '0%', background: color, borderRadius: 3, animation: running ? 'none' : undefined }} />
            </span>
            {cloud && s.vendor === 'codex' ? <button className="b ghost" style={{ height: 22, fontSize: 11, padding: '0 6px' }} onPointerDown={stop} disabled={busy} onClick={fetchDiff}>Diff</button> : null}
            {!cloud && s.host_id ? <button className="b ghost" style={{ height: 22, fontSize: 11, padding: '0 6px' }} onPointerDown={stop} data-testid="session-shell" title="Shell here" onClick={() => openTerminal(s.host_id!, { parentId: s.id, cwd: s.cwd, sessionId: s.id })}><span className="mono">&gt;_</span>Shell</button> : null}
            {s.native_url ? <a className="b ghost lnk" style={{ height: 22, fontSize: 11, padding: '0 6px' }} href={s.native_url} target="_blank" rel="noopener noreferrer" onPointerDown={stop}>{nativeLabel(s)} ↗</a> : <span style={{ fontSize: 11, color: '#6E727A' }}>{timeAgo(s.updated_at)}</span>}
          </div>
        )
      ) : null}

      {big ? (
        <>
          {cloud ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: '#A3A7AF', flex: 'none' }} onPointerDown={stop}>
              <span className="cap">Cloud</span>
              <span>status <b style={{ color: '#E7E8EA', fontWeight: 500 }}>{s.meta?.cloudStatus || s.status}</b></span>
              {s.meta?.environment ? <span>· environment <span className="mono" style={{ color: '#E7E8EA' }}>{s.meta.environment}</span></span> : null}
              {s.meta?.attempts ? <span>· {s.meta.attempts} attempts</span> : null}
              <span style={{ flex: 1 }} />
              {s.vendor === 'codex' ? <button className="b" style={{ height: 26 }} disabled={busy} onClick={fetchDiff} data-testid="cloud-diff">{busy ? 'Fetching…' : 'Diff'}</button> : <button className="b" style={{ height: 26 }} disabled={busy} onClick={fetchDiff}>Refresh</button>}
            </div>
          ) : null}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', borderTop: '1px solid #24272D', paddingTop: 10 }} onPointerDown={stop}>
            <div ref={scrollRef} className="scroll" data-wheel="inner" style={{ flex: 1, minWidth: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 4, userSelect: 'text' }}>
              {(msgs || []).map((m) => <MessageItem key={m.id} m={m} />)}
              {!msgs ? <span style={{ fontSize: 12, color: '#8A8F98' }}>Loading transcript…</span> : null}
              {diffText ? (
                <div className="card" style={{ padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' }}>
                  <span className="cap">Diff summary</span>
                  <div className="mono prose" style={{ fontSize: 11.5, color: '#C9CCD2', lineHeight: 1.55 }}>{diffText}</div>
                </div>
              ) : null}
              {approvals.map((a) => <ApprovalCard key={a.id} a={a} vendor={s.vendor} />)}
            </div>
          </div>
          {ext ? <ExternalPanel s={s} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' }} onPointerDown={stop}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', background: '#0E0F12', border: '1px solid #2A2D33', borderRadius: 12, padding: '6px 6px 6px 10px' }}>
              <textarea
                ref={inputRef}
                data-testid="chat-input"
                aria-label="Message the agent"
                placeholder={cloud ? 'Follow-up message…' : 'Message the agent…'}
                value={text}
                rows={1}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
                style={{ flex: 1, minWidth: 0, background: 'transparent', border: 0, outline: 'none', color: '#E7E8EA', fontFamily: 'inherit', fontSize: 12.5, resize: 'none', lineHeight: 1.5, padding: '4px 0', maxHeight: 120 }}
              />
              <button className="b bp" style={{ height: 28 }} onClick={send} disabled={!text.trim()} data-testid="chat-send">Send</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: '#8A8F98' }}>Model</span>
              <select className="sel mono" aria-label="Model" data-testid="session-model" value={s.model || ''} onChange={(e) => settings({ model: e.target.value })}>
                {withCur(MODELS[s.vendor] || [], s.model).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <span style={{ fontSize: 11, color: '#8A8F98' }}>Effort</span>
              <select className="sel" aria-label="Effort" data-testid="session-effort" value={s.effort || ''} onChange={(e) => settings({ effort: e.target.value })}>
                {!s.effort ? <option value="">default</option> : null}
                {withCur(EFFORTS[s.vendor] || [], s.effort).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: '#6E727A' }}>{s.kind === 'local' && s.meta?.channel ? `channel ${s.meta.channel} · ` : ''}{timeAgo(s.updated_at)}</span>
            </div>
          </div>
          )}
        </>
      ) : null}
    </div>
  );
}

export const SessionNode = memo(SessionNodeImpl);

export function useSessionAttention() {
  const sessions = useHub((h) => h.sessions);
  const approvals = useHub((h) => h.approvals);
  const cnodes = useHub((h) => h.cnodes);
  const grants = useHub((h) => h.grants);
  return useMemo(() => {
    const list: { id: string; kind: 'session' | 'review' | 'grant' | 'assistant'; approvalId?: string }[] = [];
    const seen = new Set<string>();
    // the canvas assistant (and external Claude clients) ask in the Ask Claude panel
    const isAsk = (sid: string) => sid === 'mcp:external' || sessions[sid]?.meta?.role === 'assistant';
    Object.values(approvals).filter((a) => a.status === 'pending').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).forEach((a) => {
      if (isAsk(a.session_id) || a.source === 'canvas-action') { if (!seen.has('assistant')) { seen.add('assistant'); list.push({ id: 'assistant', kind: 'assistant', approvalId: a.id }); } return; }
      if (sessions[a.session_id] && !seen.has(a.session_id)) { seen.add(a.session_id); list.push({ id: a.session_id, kind: 'session', approvalId: a.id }); }
    });
    Object.values(sessions).filter((s) => s.status === 'waiting' && !seen.has(s.id) && s.meta?.role !== 'assistant').forEach((s) => { seen.add(s.id); list.push({ id: s.id, kind: 'session' }); });
    Object.values(cnodes).filter((c) => c.type === 'review' && c.data?.status === 'pending').forEach((c) => list.push({ id: c.id, kind: 'review' }));
    Object.values(grants).filter((g) => g.status === 'requested').forEach((g) => list.push({ id: g.id, kind: 'grant' }));
    return list;
  }, [sessions, approvals, cnodes, grants]);
}
