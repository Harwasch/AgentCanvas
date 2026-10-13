// Small canvas nodes: note, agent-created to-do, suggestion, compute grant, agent reference chip,
// compute cluster, hardware device.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { focusNode, hub, mergeLocal, toast, useHub } from '../store';
import type { CNode, NoteData, SuggestData } from '../types';
import { Icon, ProviderBadge, computeColor, computeKey, isActive, timeAgo } from '../ui';
import { Bar, RemoveBtn, stop, useSessionTitle, type NodeMode } from './common';

// ---------------------------------------------------------------- note
function NoteNodeImpl({ id }: { id: string; mode: NodeMode }) {
  const node = useHub((h) => h.cnodes[id]) as CNode<NoteData> | undefined;
  const remote = node?.data?.text ?? '';
  const [text, setText] = useState(remote);
  const editing = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { if (!editing.current) setText(remote); }, [remote]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const by = useSessionTitle(node && node.createdBy !== 'you' ? node.createdBy : null);
  if (!node) return null;
  const onChange = (v: string) => {
    setText(v);
    editing.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api.updateCNode(id, { text: v }).then((c) => mergeLocal('cnodes', c)).catch((e) => toast(`Note not saved: ${(e as Error).message}`, 'error'))
        .finally(() => { editing.current = false; });
    }, 500);
  };
  return (
    <div data-testid="note-node" data-node-id={id}
      style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#1C1D21', border: '1px solid #34363C', borderRadius: 12, padding: '10px 12px 14px', display: 'flex', flexDirection: 'column', gap: 6, boxShadow: '0 10px 24px rgba(0,0,0,.35)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#A3A7AF" strokeWidth="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
        <span className="ell" style={{ fontSize: 11, color: '#8A8F98', flex: 1 }}>{node.data.title && node.data.title !== 'Note' ? node.data.title : by ? `Note · ${by}` : `Note · ${timeAgo(node.updatedAt)}`}</span>
        <RemoveBtn id={id} />
      </div>
      <textarea aria-label="Note text" data-testid="note-text" value={text} placeholder="Write anything…" onChange={(e) => onChange(e.target.value)}
        onPointerDown={stop} data-wheel="inner"
        style={{ flex: 1, resize: 'none', background: 'transparent', border: 0, outline: 'none', color: '#E7E8EA', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5, userSelect: 'text' }} />
    </div>
  );
}
export const NoteNode = memo(NoteNodeImpl);

// ---------------------------------------------------------------- agent-created to-do
function HTodoNodeImpl({ id }: { id: string; mode: NodeMode }) {
  const node = useHub((h) => h.cnodes[id]);
  const todo = useHub((h) => (node ? h.todos[node.data?.todoId] : undefined));
  if (!node || !todo) return null;
  const toggle = () => {
    mergeLocal('todos', { ...todo, done: !todo.done });
    api.updateTodo(todo.id, { done: !todo.done }).then((t) => mergeLocal('todos', t)).catch((e) => { mergeLocal('todos', todo); toast(`To-do not updated: ${(e as Error).message}`, 'error'); });
  };
  return (
    <div data-testid="htodo-node" data-node-id={id} data-todo-id={todo.id} data-done={todo.done ? '1' : '0'}
      style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#15171B', border: '1px solid #3A3E46', borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, opacity: todo.done ? 0.55 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.04em', color: '#0B0C0E', background: '#C9CCD2', borderRadius: 4, padding: '2px 5px' }}>TO-DO</span>
        <span style={{ fontSize: 11, color: '#8A8F98' }}>for you</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }} onPointerDown={stop}>
        <button aria-label="Toggle done" data-testid="todo-toggle" onClick={toggle}
          style={{ width: 16, height: 16, borderRadius: 5, border: '1.5px solid #5A5E67', background: todo.done ? '#C9CCD2' : 'transparent', padding: 0, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#0B0C0E' }}>
          {todo.done ? <Icon name="check" size={11} sw={3} /> : null}
        </button>
        <span className="ell" style={{ fontSize: 12.5, textDecoration: todo.done ? 'line-through' : 'none' }} title={todo.text}>{todo.text}</span>
      </div>
    </div>
  );
}
export const HTodoNode = memo(HTodoNodeImpl);

// ---------------------------------------------------------------- suggestion
function SuggestNodeImpl({ id }: { id: string; mode: NodeMode }) {
  const node = useHub((h) => h.cnodes[id]) as CNode<SuggestData> | undefined;
  const hosts = useHub((h) => h.hosts);
  const account = useHub((h) => (node ? h.accounts[node.data.accountId] : undefined));
  const by = useSessionTitle(node?.createdBy !== 'you' ? node?.createdBy : null);
  const [busy, setBusy] = useState(false);
  if (!node) return null;
  const d = node.data;
  const key = d.hostId ? d.hostId : `cloud:${d.vendor}`;
  const color = computeColor(key, hosts);
  const where = d.hostId ? hosts[d.hostId]?.label || d.hostId : d.vendor === 'claude' ? 'Claude cloud' : 'Codex cloud';
  const launch = async () => {
    setBusy(true);
    try {
      const s = await api.launchSuggestion(id);
      if (s?.id) { mergeLocal('sessions', s); setTimeout(() => focusNode(s.id), 60); }
      toast('Session starting');
    } catch (e) { toast(`Launch failed: ${(e as Error).message}`, 'error'); }
    setBusy(false);
  };
  const dismiss = async () => {
    try { await api.dismissSuggestion(id); mergeLocal('cnodes', { ...node, data: { ...d, status: 'dismissed' } }); } catch (e) { toast(`Dismiss failed: ${(e as Error).message}`, 'error'); }
  };
  return (
    <div data-testid="suggest-node" data-node-id={id} data-status={d.status}
      style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: 'rgba(21,23,27,.55)', border: '1.5px dashed #4A4E57', borderRadius: 14, padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: 6, boxShadow: '0 14px 28px rgba(0,0,0,.45)' }}>
      <div className="ell" style={{ fontSize: 11, color: '#8A8F98' }}>Suggested{by ? ` by ${by}` : ''}</div>
      <div className="ell" style={{ fontWeight: 500, color: '#C9CCD2', fontSize: 13.5 }} title={d.title}>{d.title}</div>
      {d.rationale ? <div style={{ fontSize: 11.5, color: '#8A8F98', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={d.rationale}>{d.rationale}</div> : null}
      <div className="ell" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#8A8F98' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', border: `1.5px solid ${color}`, flex: 'none' }} />
        {d.vendor === 'codex' ? 'Codex' : 'Claude Code'} · {where} · {account?.label || d.accountId}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }} onPointerDown={stop}>
        {d.status === 'launched' ? (
          <button className="b" style={{ height: 26 }} onClick={() => d.sessionId && focusNode(d.sessionId, true)}>Launched · go to agent</button>
        ) : (
          <>
            <button className="b bp" style={{ height: 26 }} disabled={busy} data-testid="suggest-launch" onClick={launch}>{busy ? 'Launching…' : 'Approve & launch'}</button>
            <button className="b ghost" style={{ height: 26 }} data-testid="suggest-dismiss" onClick={dismiss}>Dismiss</button>
          </>
        )}
      </div>
    </div>
  );
}
export const SuggestNode = memo(SuggestNodeImpl);

// ---------------------------------------------------------------- compute grant
function GrantNodeImpl({ id }: { id: string; mode: NodeMode }) {
  const g = useHub((h) => h.grants[id]);
  const host = useHub((h) => (g ? h.hosts[g.hostId] : undefined));
  const mach = useHub((h) => (g ? h.machines[g.hostId] : undefined));
  if (!g) return null;
  const color = mach?.color || host?.color || '#8A8F98';
  const pct = g.quotaGB ? ((g.usedGB || 0) / g.quotaGB) * 100 : 0;
  const set = (status: 'active' | 'revoked') => api.setGrant(g.id, status).then((x) => mergeLocal('grants', x)).catch((e) => toast(`Grant update failed: ${(e as Error).message}`, 'error'));
  const requested = g.status === 'requested';
  return (
    <div data-testid="grant-node" data-grant-id={g.id} data-status={g.status}
      style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#15171B', border: `1px solid ${requested ? '#FFD23F' : color + '55'}`, borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, boxShadow: '0 6px 18px rgba(0,0,0,.3)', opacity: g.status === 'revoked' ? 0.5 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="dot" style={{ width: 9, height: 9, background: color }} />
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>Compute access</span>
        <span style={{ fontSize: 11, color: requested ? '#FFD23F' : '#A3A7AF' }}>{g.status}</span>
      </div>
      <span className="ell" style={{ fontSize: 12, color: '#C9CCD2' }}>{mach?.label || host?.label || g.hostId} · {g.resources}</span>
      <span className="ell" style={{ fontSize: 11, color: '#8A8F98' }} title={g.purpose}>{g.purpose}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto' }} onPointerDown={stop}>
        {g.quotaGB ? <><Bar pct={pct} color={color} h={3} /><span className="mono" style={{ fontSize: 10.5, color: '#A3A7AF', whiteSpace: 'nowrap' }}>{(g.usedGB ?? 0).toFixed(1)} / {g.quotaGB} GB</span></> : <span style={{ flex: 1, fontSize: 11, color: '#6E727A' }}>no quota</span>}
        {requested ? (
          <>
            <button className="b bp" style={{ height: 22, fontSize: 11, padding: '0 7px' }} data-testid="grant-approve" onClick={() => set('active')}>Approve</button>
            <button className="b ghost" style={{ height: 22, fontSize: 11, padding: '0 6px' }} data-testid="grant-deny" onClick={() => set('revoked')}>Deny</button>
          </>
        ) : g.status === 'active' ? <button className="b ghost" style={{ height: 22, fontSize: 11, padding: '0 6px' }} data-testid="grant-revoke" onClick={() => set('revoked')}>Revoke</button> : null}
      </div>
    </div>
  );
}
export const GrantNode = memo(GrantNodeImpl);

// ---------------------------------------------------------------- agent reference chip (under a machine)
function AgentRefImpl({ id }: { id: string; mode: NodeMode }) {
  const s = useHub((h) => h.sessions[id]);
  const hosts = useHub((h) => h.hosts);
  if (!s) return null;
  const color = computeColor(computeKey(s), hosts);
  const loud = s.status === 'waiting';
  return (
    <button data-testid="agentref-node" data-session-id={s.id} onPointerDown={stop} onClick={() => focusNode(s.id, true)} title={`Go to ${s.title}`}
      style={{ width: '100%', height: '100%', boxSizing: 'border-box', textAlign: 'left', color: '#E7E8EA', background: '#121418', border: `1px solid ${loud ? '#FFD23F' : color + '66'}`, borderRadius: 999, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
      <ProviderBadge vendor={s.vendor} size={17} />
      <span className="ell" style={{ fontSize: 12, flex: 1 }}>{s.title || '(untitled)'}</span>
      <span style={{ fontSize: 10.5, color: loud ? '#FFD23F' : '#8A8F98', whiteSpace: 'nowrap' }}>{s.status}</span>
    </button>
  );
}
export const AgentRefNode = memo(AgentRefImpl);

// ---------------------------------------------------------------- compute cluster
function ClusterNodeImpl(_: { id: string; mode: NodeMode }) {
  const machines = useHub((h) => h.machines);
  const devices = useHub((h) => h.devices);
  const plans = useHub((h) => h.hilPlans);
  const list = Object.values(machines);
  const hostsOn = list.filter((m) => m.kind === 'host' && m.status === 'online').length;
  const hostsAll = list.filter((m) => m.kind === 'host').length;
  const clouds = list.filter((m) => m.kind === 'cloud').length;
  const devs = Object.values(devices);
  const nPlans = Object.keys(plans).length;
  return (
    <div data-testid="cluster-node" style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#15171B', border: '1px solid #2A2D33', borderRadius: 16, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#C9CCD2" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01" /></svg>
        <span style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>Compute surfaces</span>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>{list.map((m) => <span key={m.id} className="dot" title={`${m.label} · ${m.status}`} style={{ width: 9, height: 9, background: m.color, opacity: m.status === 'offline' ? 0.35 : 1 }} />)}</div>
      <div className="ell" style={{ fontSize: 12, color: '#8A8F98' }}>{hostsOn}/{hostsAll} hosts online · {clouds} cloud{clouds === 1 ? '' : 's'} · {devs.length} device{devs.length === 1 ? '' : 's'}{nPlans ? ` · ${nPlans} HIL plan${nPlans > 1 ? 's' : ''}` : ''}</div>
    </div>
  );
}
export const ClusterNode = memo(ClusterNodeImpl);

// ---------------------------------------------------------------- hardware device
const DEV_STATUS: Record<string, [string, string]> = {
  connected: ['#43D1B0', '#C9CCD2'], reachable: ['#6AA8FF', '#C9CCD2'], busy: ['#FFD23F', '#FFD23F'], missing: ['transparent', '#FFB3B6'], unknown: ['#5A5E67', '#8A8F98'],
};
function DeviceNodeImpl({ id }: { id: string; mode: NodeMode }) {
  const d = useHub((h) => h.devices[id]);
  const sessions = useHub((h) => h.sessions);
  const hosts = useHub((h) => h.hosts);
  const lockSession = d?.lock ? sessions[d.lock.sessionId] : undefined;
  const candidates = useMemo(() => Object.values(sessions).filter((s) => isActive(s) && s.kind === 'local' && s.host_id === d?.hostId), [sessions, d?.hostId]);
  if (!d) return null;
  const [dot, fg] = DEV_STATUS[d.status] || DEV_STATUS.unknown;
  const lockColor = lockSession ? computeColor(computeKey(lockSession), hosts) : d.lock ? '#E7E8EA' : '#8A8F98';
  const lock = (sid: string | null) => {
    const prev = hub.get().devices[d.id];
    hub.set((s) => ({ devices: { ...s.devices, [d.id]: { ...d, lock: sid ? { sessionId: sid, since: Date.now() } : null } } }));
    api.lockDevice(d.id, sid).catch((e) => { hub.set((s) => ({ devices: { ...s.devices, [d.id]: prev } })); toast(`Lock failed: ${(e as Error).message}`, 'error'); });
  };
  return (
    <div data-testid="device-node" data-device-id={d.id} data-status={d.status} data-locked={d.lock ? '1' : '0'}
      style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#111215', border: `1px solid ${d.lock ? lockColor + '66' : d.status === 'missing' ? '#5A3236' : '#2A2D33'}`, borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 5, boxShadow: '0 6px 18px rgba(0,0,0,.3)', opacity: d.status === 'missing' ? 0.7 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span className="mono" style={{ fontSize: 11, color: '#0B0C0E', background: '#A3A7AF', borderRadius: 4, padding: '1px 5px', flex: 'none' }}>{d.icon}</span>
        <span className="ell" style={{ fontWeight: 600, fontSize: 13, flex: 1 }} title={d.title}>{d.title}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: fg, flex: 'none' }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, border: '1px solid #8A8F98', boxSizing: 'border-box' }} />{d.status}</span>
      </div>
      <span className="ell" style={{ fontSize: 11.5, color: '#A3A7AF' }}>{d.kind}{d.source === 'discovered' ? ' · discovered' : ''}</span>
      <span className="mono ell" style={{ fontSize: 11, color: '#8A8F98' }}>{[d.port, d.fw].filter(Boolean).join(' · ') || '—'}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 'auto', minWidth: 0 }} onPointerDown={stop}>
        {d.lock ? (
          <button className="lnk" data-testid="device-lock-chip" onClick={() => lockSession && focusNode(lockSession.id, true)} title={lockSession ? `Go to ${lockSession.title}` : undefined}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#C9CCD2', border: `1px solid ${lockColor}66`, borderRadius: 999, padding: '1px 8px', background: 'transparent', minWidth: 0, flex: 1, overflow: 'hidden' }}>
            <span className="dot" style={{ width: 6, height: 6, background: lockColor }} /><span className="ell">in use · {d.lock.sessionId === 'you' ? 'you' : lockSession?.title || d.lock.sessionId}</span>
          </button>
        ) : <span style={{ fontSize: 11, color: '#8A8F98', flex: 1 }}>free</span>}
        <select className="sel" data-testid="device-lock" aria-label="Lock to session" value={d.lock?.sessionId || ''} style={{ height: 22, fontSize: 11, maxWidth: d.lock ? 96 : 150, flex: 'none' }}
          onChange={(e) => lock(e.target.value || null)}>
          <option value="">{d.lock ? 'Release' : 'Lock to session…'}</option>
          <option value="you">You</option>
          {candidates.map((s) => <option key={s.id} value={s.id}>{s.title || s.id}</option>)}
          {d.lock && d.lock.sessionId !== 'you' && !candidates.some((s) => s.id === d.lock!.sessionId) ? <option value={d.lock.sessionId}>{lockSession?.title || d.lock.sessionId}</option> : null}
        </select>
      </div>
    </div>
  );
}
export const DeviceNode = memo(DeviceNodeImpl);
