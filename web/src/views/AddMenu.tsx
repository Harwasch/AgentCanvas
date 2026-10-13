// "+ Add" palette (free-floating nodes) and the node right-click palette.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { branchSource, launchHere } from '../nodes/BranchNode';
import { openSpawn } from '../nodes/common';
import { openTerminal } from '../nodes/MachineNode';
import { focusNode, hub, mergeLocal, toast, ui, useHub, useUI } from '../store';
import type { FileSource } from '../types';

interface Item { key: string; icon: string; label: string; testid?: string; run: () => void; sub?: boolean }

async function createNode(type: 'note' | 'todos', parentId: string | null, data: unknown) {
  try {
    const c = await api.createCNode({ type, parentId, data });
    mergeLocal('cnodes', c);
    setTimeout(() => focusNode(c.id), 80);
  } catch (e) { toast(`Could not add: ${(e as Error).message}`, 'error'); }
}

export function AddMenu() {
  const req = useUI((u) => u.addMenu);
  if (!req) return null;
  return <Palette />;
}

function Palette() {
  const req = useUI((u) => u.addMenu)!;
  const machines = useHub((h) => h.machines);
  const [termOpen, setTermOpen] = useState(false);
  const close = () => ui.set({ addMenu: null });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const hostsList = useMemo(() => Object.values(machines).filter((m) => m.kind === 'host').sort((a, b) => a.label.localeCompare(b.label)), [machines]);
  const h = hub.get();
  const pid = req.parentId || null;
  const kind = req.kind || null;
  const go = (f: () => void) => () => { close(); f(); };

  const free: Item[] = [
    { key: 'agent', icon: '◎', label: 'Agent session…', testid: 'add-agent', run: go(() => openSpawn({})) },
    { key: 'file', icon: '⇱', label: 'File…', testid: 'add-file', run: go(() => ui.set({ quickOpen: { parentId: null } })) },
    { key: 'note', icon: '✎', label: 'Note', testid: 'add-note', run: go(() => createNode('note', null, { title: 'Note', text: '' })) },
    { key: 'todos', icon: '☑', label: 'To-do list', testid: 'add-todos', run: go(() => createNode('todos', null, { title: 'To-dos', scope: null })) },
    { key: 'term', icon: '>_', label: 'Terminal on…', testid: 'add-terminal', sub: true, run: () => setTermOpen(!termOpen) },
  ];

  let items: Item[] = free;
  let title = 'New free-floating node';
  if (pid && kind) {
    const note: Item = { key: 'note', icon: '✎', label: 'Note', testid: 'add-note', run: go(() => createNode('note', pid, { title: 'Note', text: '' })) };
    items = [];
    if (kind === 'project') {
      const p = h.projects[pid];
      if (p) {
        title = p.name;
        const co = p.checkouts.find((c) => h.checkouts[c]);
        const mainB = h.branches[`${p.id}#${p.defaultBranch}`];
        const src: FileSource = mainB?.pushed || !co ? { kind: 'github', projectId: p.id, ref: p.defaultBranch } : { kind: 'checkout', checkoutId: co };
        items.push(
          { key: 'file', icon: '⇱', label: `File from ${p.defaultBranch}…`, testid: 'add-file', run: go(() => ui.set({ quickOpen: { source: src, parentId: p.id, scopeLabel: p.name } })) },
          { key: 'agent', icon: '◎', label: `Agent on ${p.defaultBranch}…`, run: go(() => openSpawn({ checkoutId: co, branch: p.defaultBranch })) },
          { key: 'branch', icon: '⑂', label: 'New branch…', run: go(() => ui.set({ branchModal: { projectId: p.id, base: p.defaultBranch, checkoutId: co } })) },
          { key: 'todos', icon: '☑', label: 'To-do list', testid: 'add-todos', run: go(() => createNode('todos', p.id, { title: `To-dos · ${p.name}`, scope: p.id })) },
          note,
        );
      }
    } else if (kind === 'branch') {
      const b = h.branches[pid];
      if (b) {
        title = b.name;
        items.push(
          { key: 'file', icon: '⇱', label: 'File from this branch…', testid: 'add-file', run: go(() => ui.set({ quickOpen: { source: branchSource(b), parentId: b.id, scopeLabel: b.name } })) },
          { key: 'agent', icon: '◎', label: 'Agent on this branch…', run: go(() => launchHere(b, h.checkouts, h.projects[b.projectId]?.checkouts || [])) },
          { key: 'sub', icon: '⑂', label: 'Sub-branch…', run: go(() => ui.set({ branchModal: { projectId: b.projectId, base: b.name, checkoutId: b.checkouts[0] || h.projects[b.projectId]?.checkouts[0] } })) },
          note,
        );
      }
    } else if (kind === 'session') {
      const s = h.sessions[pid];
      if (s) {
        title = s.title;
        if (s.kind === 'local' && s.host_id) items.push({ key: 'shell', icon: '>_', label: 'Shell here', testid: 'add-terminal', run: go(() => openTerminal(s.host_id!, { parentId: s.id, cwd: s.cwd, sessionId: s.id })) });
        items.push({ key: 'file', icon: '⇱', label: 'File…', testid: 'add-file', run: go(() => ui.set({ quickOpen: { source: s.checkout_id ? { kind: 'checkout', checkoutId: s.checkout_id } : undefined, parentId: s.id } })) }, note);
      }
    } else if (kind === 'machine') {
      const m = h.machines[pid] || h.machines[pid.replace(/^m:/, '')];
      if (m) {
        title = m.label;
        if (m.kind === 'host') items.push({ key: 'term', icon: '>_', label: `Terminal on ${m.label}`, testid: 'add-terminal', run: go(() => openTerminal(m.id)) });
        items.push({ ...note, run: go(() => createNode('note', m.id, { title: 'Note', text: '' })) });
      }
    } else {
      const c = h.cnodes[pid];
      if (c) title = c.data?.title || c.type;
      items.push(note);
      if (c && ['note', 'file', 'todos', 'terminal'].includes(c.type)) {
        items.push({ key: 'rm', icon: '×', label: 'Remove from canvas', testid: 'node-remove-menu', run: go(() => { api.deleteCNode(c.id).then(() => hub.set((s) => { const o = { ...s.cnodes }; delete o[c.id]; return { cnodes: o }; })).catch((e) => toast(String(e.message), 'error')); }) });
      }
    }
    if (!items.length) { items = free; title = 'New free-floating node'; }
  }

  const pos: React.CSSProperties = req.x != null && req.y != null
    ? { position: 'fixed', left: Math.max(8, Math.min(req.x, window.innerWidth - 256)), top: Math.max(56, Math.min(req.y, window.innerHeight - 320)) }
    : { position: 'fixed', left: 16, top: 50 };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 330 }} onPointerDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }}>
      <div data-testid="add-menu" role="menu" onPointerDown={(e) => e.stopPropagation()}
        style={{ ...pos, width: 248, background: '#15171B', border: '1px solid #3A3E46', borderRadius: 12, padding: 6, boxShadow: '0 16px 40px rgba(0,0,0,.55)', boxSizing: 'border-box' }}>
        <div className="ell" style={{ fontSize: 11, color: '#8A8F98', padding: '4px 10px 6px' }}>{title}</div>
        {items.map((it) => (
          <div key={it.key}>
            <button className="pi" role="menuitem" data-testid={it.testid} onClick={it.run}>
              <span className="mono" style={{ width: 18, color: '#8A8F98', textAlign: 'center', flex: 'none' }}>{it.icon}</span>
              <span className="ell" style={{ flex: 1 }}>{it.label}</span>
              {it.sub ? <span style={{ color: '#6E727A', fontSize: 11 }}>{termOpen ? '▾' : '▸'}</span> : null}
            </button>
            {it.sub && termOpen ? (
              <div style={{ paddingLeft: 26, display: 'flex', flexDirection: 'column' }}>
                {hostsList.map((m) => (
                  <button key={m.id} className="pi" data-testid="add-terminal-host" data-host-id={m.id} disabled={m.status === 'offline'} onClick={go(() => openTerminal(m.id))}>
                    <span className="dot" style={{ background: m.color }} />{m.label}{m.status === 'offline' ? ' (offline)' : ''}
                  </button>
                ))}
                {!hostsList.length ? <span style={{ fontSize: 11.5, color: '#6E727A', padding: '6px 10px' }}>No hosts</span> : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
