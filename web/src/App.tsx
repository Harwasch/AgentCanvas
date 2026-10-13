import { useEffect, useMemo, useRef, useState } from 'react';
import { isMock } from './api';
import { Canvas } from './canvas/Canvas';
import { ShotApp } from './nodes/AppNode';
import { SessionNode, useSessionAttention } from './nodes/SessionNode';
import { disablePush, enablePush, pushEnabled, pushSupported } from './push';
import { focusNode, hub, lsSet, toast, ui, useHub, useUI, type LayoutMode, type Tab } from './store';
import { Icon, isActive, useIsPhone } from './ui';
import { AuditView } from './views/AuditView';
import { ConfirmDialog, PromoteModal, Toasts, TokenPrompt } from './views/Modals';
import { ReposView } from './views/ReposView';
import { SessionsView } from './views/SessionsView';
import { SpawnDialog } from './views/SpawnDialog';

export default function App() {
  const shot = useMemo(() => new URLSearchParams(location.search).get('shot'), []);
  const authRequired = useHub((h) => h.authRequired);
  if (shot) return <ShotView id={shot} />;
  if (authRequired) return <TokenPrompt />;
  return <Main />;
}

function ShotView({ id }: { id: string }) {
  const node = useHub((h) => h.nodes[id]);
  const ready = useHub((h) => h.ready);
  if (!ready) return null;
  if (!node) return <div data-testid="shot-missing" style={{ color: '#8A8F98', padding: 16 }}>No app node {id}</div>;
  return <ShotApp node={node} />;
}

function Main() {
  const tab = useUI((u) => u.tab);
  const ready = useHub((h) => h.ready);
  const layout = useHub((h) => h.layout);
  const phone = useIsPhone();

  // default to the saved layout once, if the user never picked a mode
  const decided = useRef(false);
  useEffect(() => {
    if (!ready || decided.current) return;
    decided.current = true;
    let pref: string | null = null;
    try { pref = localStorage.getItem('hub.layoutMode'); } catch { /* */ }
    if (!pref) ui.set({ layoutMode: Object.keys(layout).length ? 'custom' : 'columns' });
  }, [ready, layout]);

  // deep links from push notifications and publish_app previews: /?focus=<session or app node id>
  const focused = useRef(false);
  useEffect(() => {
    if (!ready || focused.current) return;
    focused.current = true;
    const id = new URLSearchParams(location.search).get('focus');
    if (id) setTimeout(() => focusNode(id, true), 50);
  }, [ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const u = ui.get();
      if (u.confirm || u.spawnOpen || u.promoteId) return;
      if (Object.keys(u.expanded).length) ui.set({ expanded: {} });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', userSelect: 'none' }}>
      <div className="view" data-testid={`view-${tab}`}>
        {tab === 'canvas' ? <Canvas /> : null}
        {tab === 'sessions' ? <SessionsView /> : null}
        {tab === 'repos' ? <ReposView /> : null}
        {tab === 'audit' ? <AuditView /> : null}
        {!ready ? <Connecting /> : null}
      </div>
      <TopBar phone={phone} />
      <TabStrip />
      {phone ? <SessionSheet /> : null}
      <SpawnDialog />
      <PromoteModal />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}

function Connecting() {
  const error = useHub((h) => h.error);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A8F98', fontSize: 13, gap: 10 }}>
      <span className="spin" />{error ? `Hub unreachable — retrying (${error})` : 'Connecting to hub…'}
    </div>
  );
}

function SessionSheet() {
  const expanded = useUI((u) => u.expanded);
  const tab = useUI((u) => u.tab);
  const sessions = useHub((h) => h.sessions);
  const id = Object.keys(expanded).reverse().find((k) => sessions[k]);
  if (!id || tab !== 'canvas') return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#15171B', paddingTop: 'env(safe-area-inset-top)' }}>
      <SessionNode id={id} mode="sheet" />
    </div>
  );
}

const LAYOUTS: [LayoutMode, string][] = [['cluster', 'Cluster'], ['columns', 'Columns'], ['custom', 'Custom']];

function LayoutSeg() {
  const mode = useUI((u) => u.layoutMode);
  return (
    <div className="seg" role="group" aria-label="Layout" data-testid="layout-seg">
      {LAYOUTS.map(([k, label]) => (
        <button key={k} className={mode === k ? 'on' : ''} onClick={() => { ui.set({ layoutMode: k, tab: 'canvas' }); lsSet('hub.layoutMode', k); }}>{label}</button>
      ))}
    </div>
  );
}

function Search({ width = 200 }: { width?: number | string }) {
  const search = useUI((u) => u.search);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#15171B', border: '1px solid #24272D', borderRadius: 8, height: 30, padding: '0 10px', width, boxSizing: 'border-box', flex: 'none' }}>
      <Icon name="search" size={14} style={{ color: '#8A8F98' }} />
      <input ref={ref} aria-label="Search" data-testid="search" placeholder="Search nodes" value={search} onChange={(e) => ui.set({ search: e.target.value, tab: 'canvas' })}
        onKeyDown={(e) => { if (e.key === 'Escape') ui.set({ search: '' }); }}
        style={{ background: 'transparent', border: 0, outline: 'none', color: '#E7E8EA', fontFamily: 'inherit', fontSize: 12.5, flex: 1, minWidth: 0 }} />
      {search ? <button className="x" aria-label="Clear search" onClick={() => ui.set({ search: '' })}><Icon name="x" size={10} /></button> : <span className="mono desk-only" style={{ fontSize: 10.5, color: '#8A8F98' }}>⌘K</span>}
    </label>
  );
}

function useAccountCounts() {
  const accounts = useHub((h) => h.accounts);
  const sessions = useHub((h) => h.sessions);
  return useMemo(() => Object.values(accounts).map((a) => {
    const mine = Object.values(sessions).filter((s) => s.account_id === a.id && isActive(s));
    return { a, total: mine.length, claude: mine.filter((s) => s.vendor === 'claude').length, codex: mine.filter((s) => s.vendor === 'codex').length, running: mine.filter((s) => s.status === 'running').length };
  }), [accounts, sessions]);
}

function AccountChips({ onClick, active }: { onClick: () => void; active: boolean }) {
  const counts = useAccountCounts();
  return (
    <button onClick={onClick} aria-label="Accounts and settings" data-testid="account-chips"
      style={{ background: active ? '#1A1C21' : 'transparent', border: '1px solid #24272D', borderRadius: 9, height: 36, padding: '0 10px', display: 'flex', gap: 14, alignItems: 'center', color: '#E7E8EA', flex: 'none' }}>
      {counts.map(({ a, total, running }) => (
        <span key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 58, textAlign: 'left' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#A3A7AF', lineHeight: 1 }}><span className="dot" style={{ width: 6, height: 6, background: a.color }} /><span style={{ flex: 1 }}>{a.label}</span><span className="mono" style={{ color: '#E7E8EA' }}>{total}</span></span>
          <span style={{ height: 3, background: '#24272D', borderRadius: 2, overflow: 'hidden', display: 'block' }}><span style={{ display: 'block', height: 3, width: total ? `${Math.max(12, (running / total) * 100)}%` : 0, background: a.color }} /></span>
        </span>
      ))}
      {!counts.length ? <span style={{ fontSize: 11.5, color: '#8A8F98' }}>Accounts</span> : null}
    </button>
  );
}

function SettingsPanel({ phone }: { phone: boolean }) {
  const counts = useAccountCounts();
  const connected = useHub((h) => h.connected);
  const vapid = useHub((h) => h.config.vapidPublicKey);
  const [push, setPush] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushEnabled().then(setPush); }, []);
  const toggle = async () => {
    setBusy(true);
    try {
      if (push) { await disablePush(); setPush(false); toast('Notifications off'); }
      else { await enablePush(vapid); setPush(true); toast('Notifications on for this device'); }
    } catch (e) { toast((e as Error).message, 'error'); }
    setBusy(false);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {phone ? (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, borderBottom: '1px solid #24272D' }}>
          <Search width="100%" />
          <LayoutSeg />
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid #24272D' }}>
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>Accounts</span>
        <span style={{ fontSize: 11, color: '#8A8F98', display: 'inline-flex', gap: 6, alignItems: 'center' }}><span className="dot" style={{ width: 7, height: 7, background: isMock() ? '#A48BFA' : connected ? '#43D1B0' : '#E5484D' }} />{isMock() ? 'mock data' : connected ? 'live' : 'reconnecting'}</span>
      </div>
      {counts.map(({ a, total, claude, codex, running }) => (
        <div key={a.id} style={{ padding: '10px 14px', borderBottom: '1px solid #1E2025', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="dot" style={{ background: a.color }} /><span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{a.label}</span><span className="mono" style={{ fontSize: 11.5, color: '#A3A7AF' }}>{total} active · {running} running</span></div>
          <span style={{ fontSize: 11.5, color: '#8A8F98' }}>Claude Code {claude} · Codex {codex}</span>
          <span style={{ fontSize: 11, color: '#6E727A' }}>Cloud envs: {[...(a.cloud?.claudeEnvironments || []).map((e) => `claude/${e.label}`), ...(a.cloud?.codexEnvironments || []).map((e) => `codex/${e.label}`)].join(', ') || 'none'}</span>
        </div>
      ))}
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="bell" size={14} style={{ color: '#A3A7AF' }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 12.5 }}>Notifications</span>
          <span style={{ fontSize: 11, color: '#8A8F98' }}>{pushSupported() ? 'Push when an agent needs you' : 'Not supported in this browser'}</span>
        </div>
        <button role="switch" aria-checked={!!push} data-testid="push-toggle" disabled={busy || !pushSupported()} onClick={toggle}
          style={{ width: 38, height: 22, borderRadius: 999, border: '1px solid #3A3E46', background: push ? '#E7E8EA' : '#1A1C21', position: 'relative', padding: 0 }}>
          <span style={{ position: 'absolute', top: 2, left: push ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: push ? '#0B0C0E' : '#8A8F98', transition: 'left .15s' }} />
        </button>
      </div>
    </div>
  );
}

function NeedsYou() {
  const list = useSessionAttention();
  const idx = useRef(0);
  const n = list.length;
  const go = () => {
    if (!n) { toast('Nothing needs you right now'); return; }
    const item = list[idx.current % n];
    idx.current = (idx.current + 1) % n;
    focusNode(item.sessionId, true);
  };
  return (
    <button className="b" data-testid="needs-you" onClick={go}
      style={{ height: 30, background: n ? '#E7E8EA' : '#1A1C21', color: n ? '#0B0C0E' : '#A3A7AF', borderColor: n ? '#E7E8EA' : '#2A2D33', fontWeight: 500, flex: 'none' }}>
      Needs you · {n}
    </button>
  );
}

function TopBar({ phone }: { phone: boolean }) {
  const [pop, setPop] = useState(false);
  useEffect(() => {
    if (!pop) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.('[data-popover]')) setPop(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [pop]);
  return (
    <div className="topbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 'none' }}>
        <Icon name="logo" size={20} sw={1.6} />
        <span style={{ fontWeight: 600, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{phone ? 'Hub' : 'Agent Canvas'}</span>
      </div>
      <button className="b" style={{ height: 30, marginLeft: phone ? 2 : 8, flex: 'none' }} data-testid="add-button" onClick={() => ui.set({ spawnOpen: true, spawnPreset: null })}>
        <Icon name="plus" size={13} sw={2.2} />Add
      </button>
      {!phone ? <LayoutSeg /> : null}
      <div style={{ flex: 1 }} />
      {!phone ? <Search /> : null}
      <div style={{ position: 'relative', flex: 'none' }} data-popover="1">
        {phone ? (
          <button className="b" style={{ height: 30, width: 34, padding: 0, justifyContent: 'center' }} aria-label="Menu" data-testid="menu-button" onClick={() => setPop(!pop)}><Icon name="menu" /></button>
        ) : <AccountChips onClick={() => setPop(!pop)} active={pop} />}
        {pop ? (
          <div className="popover scroll" data-testid="settings-popover" style={phone ? { position: 'fixed', left: 12, right: 12, top: 56, maxHeight: 'calc(100vh - 80px)', overflow: 'auto' } : { right: 0, top: 42, width: 360, maxHeight: 'calc(100vh - 80px)', overflow: 'auto' }}>
            <SettingsPanel phone={phone} />
          </div>
        ) : null}
      </div>
      <NeedsYou />
    </div>
  );
}

const TABS: { id: Tab; name: string; icon: string }[] = [
  { id: 'canvas', name: 'Canvas', icon: '■' },
  { id: 'sessions', name: 'Sessions', icon: '◎' },
  { id: 'repos', name: 'Repos', icon: '⌥' },
  { id: 'audit', name: 'Audit', icon: '✓' },
];

function TabStrip() {
  const tab = useUI((u) => u.tab);
  const sessions = useHub((h) => h.sessions);
  const connected = useHub((h) => h.connected);
  const focusId = useUI((u) => u.focusId);
  const active = useMemo(() => Object.values(sessions).filter(isActive).length, [sessions]);
  const focusTitle = useHub((h) => (focusId ? h.sessions[focusId]?.title || h.nodes[focusId]?.title || h.checkouts[focusId]?.repoName : null));
  return (
    <div className="tabstrip noscrollbar" role="tablist">
      {TABS.map((t) => {
        const on = t.id === tab;
        return (
          <button key={t.id} role="tab" aria-selected={on} className="tab" data-testid={`tab-${t.id}`} onClick={() => ui.set({ tab: t.id })}
            style={{ background: on ? '#0B0C0E' : 'transparent', color: on ? '#FFFFFF' : '#A3A7AF', boxShadow: on ? 'inset 0 2px 0 #E7E8EA' : 'none', border: 0 }}>
            <span className="mono" style={{ fontSize: 10.5, color: '#6E727A' }}>{t.icon}</span>{t.name}
            {t.id === 'sessions' ? <span className="mono" style={{ fontSize: 10.5, color: '#0B0C0E', background: '#C9CCD2', borderRadius: 999, padding: '0 6px' }}>{active}</span> : null}
          </button>
        );
      })}
      <div style={{ flex: 1, minWidth: 12 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8A8F98', height: 34, fontSize: 12, whiteSpace: 'nowrap', flex: 'none' }}>
        {tab === 'canvas' && focusTitle ? <span className="desk-only" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>· focused on <span style={{ color: '#E7E8EA', maxWidth: 240 }} className="ell">{focusTitle}</span></span> : null}
        {!isMock() ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span className="dot" style={{ width: 7, height: 7, background: connected ? '#43D1B0' : '#E5484D' }} />{connected ? 'live' : 'offline'}</span>
          : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span className="dot" style={{ width: 7, height: 7, background: '#A48BFA' }} />mock</span>}
      </div>
    </div>
  );
}

// keep `hub` referenced for debugging from the console
(window as unknown as { __hub?: typeof hub }).__hub = hub;
