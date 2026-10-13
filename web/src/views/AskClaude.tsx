// Ask Claude: one canvas-assistant conversation (a Claude session on a host you pick, with the hub's
// canvas tools), shown as a docked panel (a full-screen sheet on phones) plus a ⌘J command bar that
// sends into the same conversation. Claude's canvas edits apply live; actions it wants to take
// (start sessions, message agents, run HIL…) wait here for your Allow / Deny.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ApprovalCard, MessageItem } from '../nodes/SessionNode';
import { lsSet, toast, ui, useHub, useUI, watchMessages } from '../store';
import type { Message, Session } from '../types';
import { Icon, ProviderBadge, StatusPill, isActive, useIsPhone } from '../ui';

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

/** the current canvas assistant: newest active Claude session with role=assistant (shared by all your devices) */
export function useAssistant(): Session | null {
  const sessions = useHub((h) => h.sessions);
  return useMemo(() => Object.values(sessions)
    .filter((s) => s.meta?.role === 'assistant' && isActive(s))
    .sort((a, b) => Number(new Date(b.created_at)) - Number(new Date(a.created_at)))[0] || null, [sessions]);
}

function useWhere() {
  const hosts = useHub((h) => h.hosts);
  const accounts = useHub((h) => h.accounts);
  const hostList = Object.values(hosts).sort((a, b) => a.label.localeCompare(b.label));
  const accList = Object.values(accounts);
  const [host, setHost] = useState(() => lsGet('hub.ask.host') || '');
  const [account, setAccount] = useState(() => lsGet('hub.ask.account') || '');
  const h = hosts[host] ? host : (hostList.find((x) => x.status === 'online') || hostList[0])?.id || '';
  const a = accounts[account] ? account : accList[0]?.id || '';
  return {
    hostList, accList, host: h, account: a,
    setHost: (v: string) => { setHost(v); lsSet('hub.ask.host', v); },
    setAccount: (v: string) => { setAccount(v); lsSet('hub.ask.account', v); },
  };
}

/** Selected node ids travel with the message so "these" means what you selected. */
function withContext(text: string) {
  const sel = Object.keys(ui.get().selected);
  return sel.length ? `${text}\n\n(Selected on the canvas: ${sel.slice(0, 40).join(', ')}${sel.length > 40 ? ', …' : ''})` : text;
}

async function ask(text: string, assistant: Session | null, where: { host: string; account: string }) {
  const msg = withContext(text);
  if (assistant) return api.send(assistant.id, msg);
  if (!where.host || !where.account) throw new Error('pick a host and an account first');
  return api.assistantStart({ hostId: where.host, accountId: where.account, prompt: msg });
}

export function AskPanel() {
  const open = useUI((u) => u.askOpen);
  const phone = useIsPhone();
  if (!open) return null;
  return <Panel phone={phone} />;
}

function Panel({ phone }: { phone: boolean }) {
  const s = useAssistant();
  const where = useWhere();
  const msgs = useHub((h) => (s ? h.messages[s.id] : undefined));
  const approvalsMap = useHub((h) => h.approvals);
  const changes = useUI((u) => u.changes);
  const nSel = useUI((u) => Object.keys(u.selected).length);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const approvals = useMemo(() => Object.values(approvalsMap).filter((a) => a.status === 'pending' && (a.source === 'canvas-action' || a.session_id === s?.id || a.session_id === 'mcp:external')), [approvalsMap, s?.id]);
  const mine = changes.filter((c) => !s || c.sessionId === s.id || !c.sessionId).slice(0, 4);

  useEffect(() => (s ? watchMessages(s.id) : undefined), [s?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, approvals.length, mine.length]);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50); }, []);

  const close = () => { ui.set({ askOpen: false }); lsSet('hub.askOpen', '0'); };
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setText('');
    try { await ask(t, s, where); } catch (e) { toast(`Could not reach Claude: ${(e as Error).message}`, 'error'); setText(t); }
    setBusy(false);
  };
  const fresh = async () => {
    if (s) { try { await api.stop(s.id); } catch { /* already gone */ } }
  };
  const visible = (msgs || []).filter((m) => !(m.role === 'user' && m.kind === 'text' && !m.text.trim()) && !(m.kind === 'tool' && m.role === 'tool' && !(m.data as any)?.isError));
  const errs = new Set((msgs || []).filter((m) => m.role === 'tool' && (m.data as any)?.isError).map((m) => (m.data as any).toolUseId));

  return (
    <div className={`ask-panel${phone ? ' sheet' : ''}`} data-testid="ask-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
        <ProviderBadge vendor="claude" size={22} />
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>Ask Claude</span>
        {s ? <StatusPill status={s.status} /> : null}
        {s ? <button className="b ghost" style={{ height: 26 }} title="Stop this conversation and start fresh next time" data-testid="ask-new" onClick={fresh}>New</button> : null}
        <button className="x" aria-label="Close" data-testid="ask-close" onClick={close}><Icon name="x" size={12} /></button>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5, color: '#8A8F98', flex: 'none' }}>
        {s ? (
          <span className="ell">Claude on <b style={{ color: '#C9CCD2', fontWeight: 500 }}>{s.host_id}</b> · {s.account_id}{s.meta?.channel === 'connected' ? '' : ' · connecting…'}</span>
        ) : (
          <>
            <span>Runs on</span>
            <select className="sel" data-testid="ask-host" style={{ height: 26, fontSize: 11.5 }} value={where.host} onChange={(e) => where.setHost(e.target.value)}>
              {where.hostList.map((h) => <option key={h.id} value={h.id}>{h.label}{h.status !== 'online' ? ` (${h.status})` : ''}</option>)}
            </select>
            <select className="sel" data-testid="ask-account" style={{ height: 26, fontSize: 11.5 }} value={where.account} onChange={(e) => where.setAccount(e.target.value)}>
              {where.accList.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </>
        )}
      </div>

      <div ref={scrollRef} className="scroll" data-wheel="inner" style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10, userSelect: 'text', paddingRight: 2 }}>
        {!s && !visible.length ? (
          <div style={{ fontSize: 12.5, color: '#A3A7AF', lineHeight: 1.55, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>Claude can work on this canvas for you:</span>
            <span>• <b style={{ color: '#E7E8EA' }}>Right away</b> — arrange and resize nodes, switch layouts, add notes, files and to-dos. Changes glow and can be undone.</span>
            <span>• <b style={{ color: '#E7E8EA' }}>With your OK</b> — start sessions, message agents, run HIL plans, create branches, open terminals.</span>
            <span>• <b style={{ color: '#E7E8EA' }}>Never</b> — approve agents' tool calls or actuate hardware.</span>
            <span style={{ color: '#8A8F98' }}>Select nodes first and say “these”. ⌘J asks from anywhere.</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {['Arrange the selected nodes in a grid', 'Switch to the tree layout', 'Add a note summarising what each session is doing'].map((x) => (
                <button key={x} className="chip" style={{ border: '1px solid #2A2D33' }} onClick={() => { setText(x); inputRef.current?.focus(); }}>{x}</button>
              ))}
            </div>
          </div>
        ) : null}
        {visible.map((m) => <PanelMsg key={m.id} m={m} errs={errs} />)}
        {s && (s.status === 'running' || s.status === 'starting') ? <div style={{ fontSize: 11.5, color: '#8A8F98', display: 'flex', gap: 8, alignItems: 'center' }}><span className="spin" />{s.status === 'starting' ? 'Starting Claude…' : 'Working…'}</div> : null}
        {mine.map((c) => (
          <div key={c.batchId} data-testid="ask-change" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#A3A7AF', border: '1px solid #24272D', borderRadius: 9, padding: '5px 6px 5px 10px' }}>
            <Icon name="check" size={11} sw={2.4} />
            <span className="ell" style={{ flex: 1 }}>{c.undone ? 'Undone: ' : ''}{c.summary.join(' · ')}</span>
            {!c.undone ? <button className="b" style={{ height: 24, fontSize: 11 }} onClick={() => api.canvasUndo(c.batchId).catch((e) => toast(`Undo failed: ${e.message}`, 'error'))}>Undo</button> : null}
          </div>
        ))}
        {approvals.map((a) => <ApprovalCard key={a.id} a={a} vendor="claude" />)}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' }}>
        {nSel ? <span style={{ fontSize: 11, color: '#8A8F98' }}>{nSel} selected node{nSel === 1 ? '' : 's'} will be included</span> : null}
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea ref={inputRef} className="in" data-testid="ask-input" rows={2} value={text} placeholder={s ? 'Ask Claude to do something on the canvas…' : 'Ask Claude… (starts Claude on the host above)'}
            style={{ flex: 1, resize: 'none', padding: '8px 10px', lineHeight: 1.45, fontSize: 12.5, height: 58 }}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } if (e.key === 'Escape') close(); }} />
          <button className="b bp" data-testid="ask-send" style={{ height: 34 }} disabled={busy || !text.trim()} onClick={send}>{busy ? '…' : 'Send'}</button>
        </div>
      </div>
    </div>
  );
}

const SEL_RE = /\n*\(Selected on the canvas: ([^)]*)\)\s*$/;
/** Compact transcript for the panel: tool calls as one-liners, the selection context as a chip. */
function PanelMsg({ m, errs }: { m: Message; errs: Set<string> }) {
  const d = (m.data || {}) as any;
  if (m.kind === 'tool' && d.name) {
    const name = String(d.name).replace(/^mcp__hub__/, '');
    const failed = d.id && errs.has(d.id);
    const arg = d.input && typeof d.input === 'object' ? Object.entries(d.input).map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : typeof v === 'object' ? '…' : String(v).slice(0, 40)}`).join(' · ') : '';
    return (
      <div data-testid="msg" data-role="tool" style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 11.5, color: failed ? '#FFB3B6' : '#8A8F98', minWidth: 0 }}>
        <span className="mono" style={{ fontSize: 10.5, color: '#0B0C0E', background: failed ? '#FFB3B6' : name.startsWith('hub_') ? '#FFD23F' : '#A3A7AF', borderRadius: 4, padding: '1px 5px', flex: 'none' }}>{name}</span>
        <span className="ell mono" style={{ fontSize: 10.5 }}>{arg}</span>
      </div>
    );
  }
  if (m.kind === 'tool' && m.role === 'tool') return <div data-testid="msg" data-role="tool" className="ell mono" style={{ fontSize: 10.5, color: '#FFB3B6' }}>⚠ {m.text}</div>;
  if (m.role === 'user' && m.kind === 'text') {
    const sel = m.text.match(SEL_RE);
    const n = sel ? sel[1].split(',').filter((x) => x.trim()).length : 0;
    return (
      <div style={{ alignSelf: 'flex-end', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, maxWidth: '88%' }}>
        <MessageItem m={{ ...m, text: m.text.replace(SEL_RE, '') }} />
        {n ? <span style={{ fontSize: 10.5, color: '#8A8F98' }} title={sel![1]}>with {n} selected node{n === 1 ? '' : 's'}</span> : null}
      </div>
    );
  }
  return <MessageItem m={m} />;
}

/** ⌘J: one line to Claude, from anywhere; it goes into the same conversation as the panel. */
export function AskBar() {
  const open = useUI((u) => u.askBar);
  const s = useAssistant();
  const where = useWhere();
  const nSel = useUI((u) => Object.keys(u.selected).length);
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setText(''); setTimeout(() => ref.current?.focus(), 20); } }, [open]);
  if (!open) return null;
  const close = () => ui.set({ askBar: false });
  const go = async () => {
    const t = text.trim();
    if (!t) return;
    close();
    try {
      await ask(t, s, where);
      toast(s ? 'Sent to Claude' : `Starting Claude on ${where.host}…`);
    } catch (e) { toast(`Could not reach Claude: ${(e as Error).message}`, 'error'); ui.set({ askOpen: true }); }
  };
  return (
    <div className="modal-back" style={{ paddingTop: 110, background: 'rgba(5,6,8,.35)' }} onPointerDown={close}>
      <div className="askbar" data-testid="ask-bar" onPointerDown={(e) => e.stopPropagation()}>
        <ProviderBadge vendor="claude" size={20} />
        <input ref={ref} className="in" data-testid="ask-bar-input" value={text} onChange={(e) => setText(e.target.value)}
          placeholder={nSel ? `Ask Claude about the ${nSel} selected node${nSel === 1 ? '' : 's'}…` : 'Ask Claude to do something on the canvas…'}
          onKeyDown={(e) => { if (e.key === 'Enter') void go(); if (e.key === 'Escape') close(); }}
          style={{ flex: 1, height: 36, fontSize: 14, border: 0, background: 'transparent' }} />
        <span className="mono desk-only" style={{ fontSize: 10.5, color: '#6E727A' }}>{s ? `→ ${s.host_id}` : `starts on ${where.host || '—'}`}</span>
        <button className="b ghost" style={{ height: 28 }} title="Open the conversation" onClick={() => { close(); ui.set({ askOpen: true }); lsSet('hub.askOpen', '1'); }}>Panel</button>
      </div>
    </div>
  );
}

/** Top-bar button: opens the panel; a dot shows Claude is working or waiting on you. */
export function AskButton({ phone }: { phone: boolean }) {
  const s = useAssistant();
  const open = useUI((u) => u.askOpen);
  const approvals = useHub((h) => h.approvals);
  const waiting = Object.values(approvals).some((a) => a.status === 'pending' && (a.source === 'canvas-action' || (s && a.session_id === s.id)));
  const dot = waiting ? '#FFD23F' : s && (s.status === 'running' || s.status === 'starting') ? '#E0896B' : null;
  return (
    <button className={`b${open ? ' on' : ''}`} data-testid="ask-button" title="Ask Claude (⌘J for a quick instruction)" style={{ height: 30, flex: 'none', position: 'relative', ...(open ? { background: '#24272D' } : {}) }}
      onClick={() => { const v = !ui.get().askOpen; ui.set({ askOpen: v }); lsSet('hub.askOpen', v ? '1' : '0'); }}>
      <ProviderBadge vendor="claude" size={16} />{phone ? null : 'Ask Claude'}
      {dot ? <span className="dot" style={{ position: 'absolute', top: -2, right: -2, background: dot, boxShadow: `0 0 8px ${dot}` }} /> : null}
    </button>
  );
}
