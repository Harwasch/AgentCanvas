// MODAL: new branch (git worktree on a host, optionally pushed to GitHub).
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { focusNode, mergeLocal, toast, ui, useHub, useUI } from '../store';
import { Icon, shortSha } from '../ui';

export function BranchModal() {
  const req = useUI((u) => u.branchModal);
  if (!req) return null;
  return <BranchForm />;
}

const VALID = /^(?!\/|.*\/\/|.*\.\.|.*\/$|.*\.lock$)[A-Za-z0-9._\-/]+$/;

function BranchForm() {
  const req = useUI((u) => u.branchModal)!;
  const project = useHub((h) => h.projects[req.projectId]);
  const checkouts = useHub((h) => h.checkouts);
  const hosts = useHub((h) => h.hosts);
  const branches = useHub((h) => h.branches);
  const cos = useMemo(() => Object.values(checkouts).filter((c) => c.repo_id === req.projectId)
    .sort((a, b) => a.host_id.localeCompare(b.host_id) || a.path.localeCompare(b.path)), [checkouts, req.projectId]);
  const [name, setName] = useState('');
  const [base, setBase] = useState(req.base);
  const [where, setWhere] = useState(req.checkoutId && checkouts[req.checkoutId] ? req.checkoutId : cos[0]?.id || '');
  const [goal, setGoal] = useState('');
  const [push, setPush] = useState(!!project?.gh);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); // set synchronously: a second Enter before the re-render must not create the branch twice
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const baseBranch = branches[`${req.projectId}#${base}`];
  const baseSha = baseBranch?.head || baseBranch?.remoteSha || (checkouts[where]?.branch === base ? checkouts[where]?.head : null);
  const exists = !!branches[`${req.projectId}#${name.trim()}`];
  const nameOk = VALID.test(name.trim()) && !exists;
  const ok = nameOk && !!base.trim() && !!where && !busy;
  const close = () => ui.set({ branchModal: null });
  const hint = !name.trim() ? 'Branch names: letters, digits, “-”, “_”, “.”, “/”.' : exists ? 'A branch with that name already exists.' : !nameOk ? 'Not a valid git branch name.' : !where ? 'No checkout of this repo on any host — clone it first.' : `Creates a git worktree on ${hosts[checkouts[where]?.host_id]?.label || 'the host'}${push ? ' and pushes it to GitHub' : ''}.`;

  const submit = async () => {
    if (!ok || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const b = await api.createBranch({ projectId: req.projectId, checkoutId: where, base: base.trim(), name: name.trim(), goal: goal.trim() || undefined, push });
      mergeLocal('branches', b);
      close();
      toast(`Branch ${b.name} created`);
      setTimeout(() => focusNode(b.id), 80);
    } catch (e) { toast(`Could not create the branch: ${(e as Error).message}`, 'error'); busyRef.current = false; setBusy(false); }
  };
  // one key handler for the whole dialog: Enter in the name field, or Ctrl/⌘+Enter anywhere
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const t = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || t.dataset.enterSubmits) { e.preventDefault(); void submit(); }
  };

  return (
    <div className="modal-back" onPointerDown={close}>
      <div className="modal" role="dialog" aria-label="New branch" data-testid="branch-modal" onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="branch" size={16} sw={1.8} style={{ color: '#C9CCD2' }} />
          <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>New branch · {project?.name || req.projectId}</span>
          <button className="x" aria-label="Close" onClick={close}><Icon name="x" size={12} /></button>
        </div>
        <span style={{ fontSize: 12, color: '#A3A7AF', marginTop: -8, lineHeight: 1.45 }}>A branch is its own worktree on a host, so agents on it never step on each other.</span>
        <label className="field">Branch name
          <input ref={ref} className="in mono" data-testid="branch-name" style={{ height: 36, fontSize: 13.5 }} aria-label="Branch name" value={name} onChange={(e) => setName(e.target.value)}
            data-enter-submits="1" placeholder="feat/short-description" />
        </label>
        <div className="grid2">
          <label className="field">From (base)
            <input className="in mono" data-testid="branch-base" list="branch-base-list" value={base} onChange={(e) => setBase(e.target.value)} />
            <datalist id="branch-base-list">
              {Object.values(branches).filter((b) => b.projectId === req.projectId).map((b) => <option key={b.id} value={b.name} />)}
            </datalist>
          </label>
          <label className="field">Where (worktree from)
            <select className="sel mono" data-testid="branch-where" value={where} onChange={(e) => setWhere(e.target.value)}>
              {!cos.length ? <option value="">(no checkout)</option> : null}
              {cos.map((c) => <option key={c.id} value={c.id}>{hosts[c.host_id]?.label || c.host_id} · {c.path}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#A3A7AF', marginTop: -4 }}>
          From <span className="mono" style={{ color: '#E7E8EA', border: '1px solid #3A3E46', borderRadius: 6, padding: '1px 7px' }}>{base || '—'}</span>
          {baseSha ? <span className="mono" style={{ fontSize: 11, color: '#6E727A' }}>@ {shortSha(baseSha)}</span> : null}
        </div>
        <label className="field">Branch goal (optional)
          <textarea className="in" data-testid="branch-goal" style={{ height: 64, padding: '8px 10px', resize: 'none', lineHeight: 1.45 }} aria-label="Branch goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should this branch deliver before it merges?" />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: project?.gh ? '#C9CCD2' : '#6E727A' }}>
          <input type="checkbox" data-testid="branch-push" checked={push} disabled={!project?.gh} onChange={(e) => setPush(e.target.checked)} style={{ accentColor: '#E7E8EA' }} />
          Push to GitHub{project?.gh ? ` (${project.gh.owner}/${project.gh.repo})` : ' — no GitHub remote'}
        </label>
        <span style={{ fontSize: 11.5, color: name.trim() && !nameOk ? '#FFB3B6' : '#8A8F98' }}>{hint}</span>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="b" style={{ height: 32 }} onClick={close}>Cancel</button>
          <button className="b bp" style={{ height: 32, opacity: ok ? 1 : 0.5 }} disabled={!ok} data-testid="branch-submit" onClick={submit}>{busy ? 'Creating…' : 'Create branch'}</button>
        </div>
      </div>
    </div>
  );
}
