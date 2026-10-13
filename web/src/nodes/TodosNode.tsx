// TO-DOS list (scope = a project or everything unscoped), add / toggle / delete / dispatch to an agent.
import { memo, useMemo, useState } from 'react';
import { api } from '../api';
import { focusNode, hub, mergeLocal, toast, useHub } from '../store';
import type { CNode, Todo, TodosData } from '../types';
import { Icon } from '../ui';
import { Chevron, RemoveBtn, SheetBack, stop, type NodeMode } from './common';

/** Dispatch targets: vendor × (each host | cloud). */
export function useDispatchOptions() {
  const hosts = useHub((h) => h.hosts);
  return useMemo(() => {
    const hs = Object.values(hosts).sort((a, b) => a.label.localeCompare(b.label));
    const out: { v: string; label: string }[] = [];
    (['claude', 'codex'] as const).forEach((vendor) => {
      const name = vendor === 'claude' ? 'Claude Code' : 'Codex';
      hs.forEach((h) => out.push({ v: `${vendor}|${h.id}`, label: `${name} · ${h.label}${h.status !== 'online' ? ` (${h.status})` : ''}` }));
      out.push({ v: `${vendor}|cloud`, label: `${name} · ${vendor === 'claude' ? 'Claude cloud' : 'Codex cloud'}` });
    });
    return out;
  }, [hosts]);
}

export async function dispatchTodo(t: Todo, value: string) {
  const [vendor, where] = value.split('|');
  const h = hub.get();
  const proj = t.scope ? h.projects[t.scope] : undefined;
  const accountId = (proj?.gh && h.accounts[proj.gh.account] ? proj.gh.account : Object.keys(h.accounts)[0]) || '';
  const cos = Object.values(h.checkouts).filter((c) => !proj || c.repo_id === proj.id);
  const co = where === 'cloud' ? cos[0] : cos.find((c) => c.host_id === where);
  try {
    const s = await api.dispatchTodo(t.id, { vendor, where: where === 'cloud' ? 'cloud' : 'host', hostId: where === 'cloud' ? undefined : where, accountId, checkoutId: co?.id });
    if (s?.id) { mergeLocal('sessions', s); mergeLocal('todos', { ...t, dispatchedSessionId: s.id }); }
    toast('Dispatched · session starting');
  } catch (e) { toast(`Dispatch failed: ${(e as Error).message}`, 'error'); }
}

function TodoCard({ t }: { t: Todo }) {
  const opts = useDispatchOptions();
  const srcSession = useHub((h) => (t.src !== 'you' ? h.sessions[t.src] : undefined));
  const disp = useHub((h) => (t.dispatchedSessionId ? h.sessions[t.dispatchedSessionId] : undefined));
  const toggle = () => {
    mergeLocal('todos', { ...t, done: !t.done });
    api.updateTodo(t.id, { done: !t.done }).then((x) => mergeLocal('todos', x)).catch((e) => { mergeLocal('todos', t); toast(`Not updated: ${(e as Error).message}`, 'error'); });
  };
  const del = () => api.deleteTodo(t.id).then(() => hub.set((s) => { const o = { ...s.todos }; delete o[t.id]; return { todos: o }; })).catch((e) => toast(`Delete failed: ${(e as Error).message}`, 'error'));
  return (
    <div className="card" data-testid="todo-item" data-todo-id={t.id} data-done={t.done ? '1' : '0'} style={{ padding: '9px 10px', display: 'flex', flexDirection: 'column', gap: 7, opacity: t.done ? 0.55 : 1, flex: 'none' }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
        <button aria-label="Toggle done" data-testid="todo-toggle" onClick={toggle}
          style={{ width: 16, height: 16, borderRadius: 5, border: '1.5px solid #5A5E67', background: t.done ? '#C9CCD2' : 'transparent', padding: 0, flex: 'none', marginTop: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#0B0C0E' }}>
          {t.done ? <Icon name="check" size={11} sw={3} /> : null}
        </button>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 12.5, lineHeight: 1.35, textDecoration: t.done ? 'line-through' : 'none', wordBreak: 'break-word' }}>{t.text}</span>
          <span className="ell" style={{ fontSize: 11, color: '#8A8F98' }}>{t.src === 'you' ? 'You' : `From ${srcSession?.title || 'an agent'}`}</span>
        </div>
        <button className="x" aria-label="Delete to-do" data-testid="todo-delete" onClick={del}><Icon name="x" size={9} /></button>
      </div>
      {(!t.done && !t.dispatchedSessionId) || t.dispatchedSessionId || srcSession ? (
        <div style={{ display: 'flex', gap: 6, paddingLeft: 25, alignItems: 'center', flexWrap: 'wrap' }}>
          {!t.done && !t.dispatchedSessionId ? (
            <select className="sel" aria-label="Dispatch to agent" data-testid="todo-dispatch" value="" onChange={(e) => { if (e.target.value) void dispatchTodo(t, e.target.value); }} style={{ maxWidth: 200 }}>
              <option value="">Dispatch to agent…</option>
              {opts.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
          ) : null}
          {t.dispatchedSessionId ? (
            <>
              <span className="ell" style={{ fontSize: 11.5, color: '#C9CCD2', display: 'inline-flex', gap: 6, alignItems: 'center', maxWidth: 170 }}>
                <span style={{ width: 9, height: 9, border: '1.5px dashed #A3A7AF', borderRadius: '50%', flex: 'none', boxSizing: 'border-box' }} />→ {disp?.title || 'agent'}
              </span>
              {disp ? <button className="b" style={{ height: 24 }} data-testid="todo-goto" onClick={() => focusNode(disp.id, true)}>Go to agent</button> : null}
            </>
          ) : srcSession ? <button className="b" style={{ height: 24 }} data-testid="todo-goto" onClick={() => focusNode(srcSession.id, true)}>Go to {srcSession.vendor === 'codex' ? 'Codex' : 'Claude'}</button> : null}
        </div>
      ) : null}
    </div>
  );
}

function TodosNodeImpl({ id, mode }: { id: string; mode: NodeMode }) {
  const node = useHub((h) => h.cnodes[id]) as CNode<TodosData> | undefined;
  const todos = useHub((h) => h.todos);
  const scopeName = useHub((h) => (node?.data?.scope ? h.projects[node.data.scope]?.name : null));
  const [draft, setDraft] = useState('');
  const scope = node?.data?.scope ?? null;
  const list = useMemo(() => Object.values(todos).filter((t) => (t.scope ?? null) === scope)
    .sort((a, b) => Number(a.done) - Number(b.done) || String(a.createdAt).localeCompare(String(b.createdAt), undefined, { numeric: true })), [todos, scope]);
  if (!node) return null;
  const open = list.filter((t) => !t.done);
  const done = list.filter((t) => t.done);
  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    try { mergeLocal('todos', await api.createTodo(text, scope)); } catch (e) { setDraft(text); toast(`Could not add: ${(e as Error).message}`, 'error'); }
  };
  const sheet = mode === 'sheet';
  const title = node.data.title && node.data.title !== 'To-dos' ? node.data.title : scopeName ? `To-dos · ${scopeName}` : 'To-dos';
  return (
    <div data-testid="todos-node" data-node-id={id}
      style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#15171B', border: sheet ? 0 : '1px solid #2A2D33', borderRadius: sheet ? 0 : 14, padding: sheet ? '12px 14px calc(12px + env(safe-area-inset-bottom))' : '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: sheet ? 'none' : '0 8px 24px rgba(0,0,0,.3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <SheetBack id={id} mode={mode} />
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C9CCD2" strokeWidth="1.8" aria-hidden="true" style={{ flex: 'none' }}><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8.5 12l2.5 2.5 4.5-5" /></svg>
        <span className="ell" style={{ fontWeight: 600, fontSize: 13.5, flex: 1 }}>{title}</span>
        <span className="mono" style={{ fontSize: 11.5, color: '#A3A7AF', flex: 'none' }}>{open.length} open</span>
        <RemoveBtn id={id} />
        <Chevron id={id} mode={mode} />
      </div>
      <div style={{ display: 'flex', gap: 6 }} onPointerDown={stop}>
        <input className="in" style={{ flex: 1 }} aria-label="New to-do" data-testid="todo-input" placeholder="Add a to-do…" value={draft}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
        <button className="b" style={{ height: 30 }} data-testid="todo-add" disabled={!draft.trim()} onClick={add}>Add</button>
      </div>
      <div className="scroll" data-wheel="inner" onPointerDown={stop} style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingRight: 2 }}>
        {[['Open', open], ['Done', done]].map(([name, items]) => (items as Todo[]).length ? (
          <div key={name as string} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="cap">{name as string} · {(items as Todo[]).length}</span>
            {(items as Todo[]).map((t) => <TodoCard key={t.id} t={t} />)}
          </div>
        ) : null)}
        {!list.length ? <span style={{ fontSize: 12, color: '#6E727A' }}>Nothing yet.</span> : null}
      </div>
    </div>
  );
}

export const TodosNode = memo(TodosNodeImpl);
