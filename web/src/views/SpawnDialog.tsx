// "+ Add" → launch a session (design MODAL "launch agent").
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { focusNode, hub, toast, ui, useHub, useUI } from '../store';
import type { Vendor } from '../types';
import { Icon, ProviderBadge } from '../ui';

export function SpawnDialog() {
  const open = useUI((u) => u.spawnOpen);
  if (!open) return null;
  return <SpawnForm />;
}

function SpawnForm() {
  const preset = useUI((u) => u.spawnPreset);
  const hosts = useHub((h) => h.hosts);
  const accounts = useHub((h) => h.accounts);
  const checkouts = useHub((h) => h.checkouts);
  const hostList = useMemo(() => Object.values(hosts).sort((a, b) => a.label.localeCompare(b.label)), [hosts]);
  const accList = useMemo(() => Object.values(accounts), [accounts]);
  const presetCo = preset?.checkoutId ? checkouts[preset.checkoutId] : undefined;

  const [vendor, setVendor] = useState<Vendor>('claude');
  const [where, setWhere] = useState<string>(presetCo?.host_id || hostList[0]?.id || 'cloud');
  const [accountId, setAccountId] = useState(accList[0]?.id || '');
  const [checkoutId, setCheckoutId] = useState(presetCo?.id || '');
  const [branch, setBranch] = useState(presetCo?.branch || '');
  const [env, setEnv] = useState('');
  const [prompt, setPrompt] = useState('');
  const [attempts, setAttempts] = useState(1);
  const [openNative, setOpenNative] = useState(false);
  const [busy, setBusy] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const cloud = where === 'cloud';

  const coOptions = useMemo(() => {
    const list = Object.values(checkouts).filter((c) => cloud || c.host_id === where);
    // cloud: one entry per repo is enough
    if (cloud) {
      const seen = new Set<string>();
      return list.filter((c) => (seen.has(c.repo_id) ? false : (seen.add(c.repo_id), true)));
    }
    return list;
  }, [checkouts, where, cloud]);

  useEffect(() => { promptRef.current?.focus(); }, []);
  // keep checkout valid for the chosen place
  useEffect(() => {
    if (checkoutId && !coOptions.find((c) => c.id === checkoutId)) {
      const same = coOptions.find((c) => c.repo_id === checkouts[checkoutId]?.repo_id);
      setCheckoutId(same?.id || coOptions[0]?.id || '');
    } else if (!checkoutId && coOptions[0]) setCheckoutId(coOptions[0].id);
  }, [coOptions, checkoutId, checkouts, cloud]);
  useEffect(() => { const c = checkouts[checkoutId]; if (c) setBranch(c.branch || ''); }, [checkoutId, checkouts]);
  const envs = useMemo(() => {
    const a = accounts[accountId];
    if (!a) return [];
    return (vendor === 'claude' ? a.cloud?.claudeEnvironments : a.cloud?.codexEnvironments) || [];
  }, [accounts, accountId, vendor]);
  useEffect(() => { if (!envs.find((e) => e.id === env)) setEnv(envs[0]?.id || ''); }, [envs, env]);

  const close = () => ui.set({ spawnOpen: false, spawnPreset: null });
  // cloud sessions need a repo (checkout) and Codex cloud needs an environment
  const canSubmit = !!prompt.trim() && !!accountId && !busy && (cloud ? !!checkoutId && (vendor !== 'codex' || !!env) : !!where);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    // open the tab synchronously (popup blockers), navigate it once native_url is known
    const win = openNative ? window.open('about:blank', '_blank') : null;
    const co = checkouts[checkoutId];
    try {
      const s = await api.createSession({
        vendor, where: cloud ? 'cloud' : 'host', hostId: cloud ? undefined : where, accountId,
        checkoutId: checkoutId || undefined, cwd: cloud ? undefined : co ? co.path : '~', branch: branch || undefined,
        environment: cloud ? env || undefined : undefined, prompt: prompt.trim(),
        attempts: cloud && vendor === 'codex' ? attempts : undefined,
      });
      close();
      if (s && s.id) {
        hub.set((h) => ({ sessions: { ...h.sessions, [s.id]: { ...(h.sessions[s.id] || {}), ...s } } }));
        setTimeout(() => focusNode(s.id), 50);
        if (win) {
          const go = (url: string) => { try { win.location.href = url; } catch { window.open(url, '_blank', 'noopener'); } };
          if (s.native_url) go(s.native_url);
          else {
            const t0 = Date.now();
            const unsub = hub.subscribe(() => {
              const cur = hub.get().sessions[s.id];
              if (cur?.native_url) { unsub(); go(cur.native_url); }
              else if (Date.now() - t0 > 180000) { unsub(); try { win.close(); } catch { /* */ } }
            });
          }
        }
      }
      toast('Session starting');
    } catch (e) {
      if (win) try { win.close(); } catch { /* */ }
      toast(`Could not start: ${(e as Error).message}`, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onPointerDown={close}>
      <div className="modal" role="dialog" aria-label="Launch agent" data-testid="spawn-dialog" onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ProviderBadge vendor={vendor} />
          <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>Launch agent</span>
          <button className="x" aria-label="Close" onClick={close}><Icon name="x" size={12} /></button>
        </div>
        <span style={{ fontSize: 12, color: '#A3A7AF', marginTop: -8, lineHeight: 1.45 }}>Starts a {vendor === 'claude' ? 'Claude Code' : 'Codex'} session {cloud ? 'in the vendor cloud' : `on ${hosts[where]?.label || where}`}. It appears on the canvas and in the native app.</span>

        <div className="grid2">
          <label className="field">Agent
            <select className="sel" data-testid="spawn-vendor" value={vendor} onChange={(e) => setVendor(e.target.value as Vendor)}>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label className="field">Where
            <select className="sel" data-testid="spawn-where" value={where} onChange={(e) => setWhere(e.target.value)}>
              {hostList.map((h) => <option key={h.id} value={h.id}>{h.label}{h.status !== 'online' ? ` (${h.status})` : ''}</option>)}
              <option value="cloud">{vendor === 'claude' ? 'Claude cloud' : 'Codex cloud'}</option>
            </select>
          </label>
          <label className="field">Account
            <select className="sel" data-testid="spawn-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accList.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
          <label className="field">Repo / checkout
            <select className="sel mono" data-testid="spawn-checkout" value={checkoutId} onChange={(e) => setCheckoutId(e.target.value)}>
              {!coOptions.length ? <option value="">{cloud ? '(no repo indexed)' : '(none · home dir)'}</option> : null}
              {coOptions.map((c) => <option key={c.id} value={c.id}>{c.repoName}{cloud ? '' : ` · ${c.path}`}</option>)}
            </select>
          </label>
          <label className="field">Branch
            <input className="in mono" data-testid="spawn-branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/short-description" />
          </label>
          {cloud ? (
            <label className="field">Environment
              <select className="sel" data-testid="spawn-env" value={env} onChange={(e) => setEnv(e.target.value)}>
                {envs.length ? envs.map((x) => <option key={x.id} value={x.id}>{x.label}</option>) : <option value="">(none configured)</option>}
              </select>
            </label>
          ) : <div />}
        </div>

        <label className="field">Prompt
          <textarea ref={promptRef} className="in" data-testid="spawn-prompt" aria-label="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do?" style={{ height: 120, padding: '10px 12px', resize: 'vertical', lineHeight: 1.5, fontSize: 13 }} />
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {cloud && vendor === 'codex' ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#8A8F98' }}>Attempts
              <select className="sel" data-testid="spawn-attempts" value={attempts} onChange={(e) => setAttempts(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          ) : null}
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#C9CCD2' }}>
            <input type="checkbox" checked={openNative} onChange={(e) => setOpenNative(e.target.checked)} data-testid="spawn-open-native" style={{ accentColor: '#E7E8EA' }} />
            Open in native app when started
          </label>
          <span style={{ flex: 1 }} />
          <span className="desk-only" style={{ fontSize: 11, color: '#6E727A' }}>⌘/Ctrl-Enter to start</span>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="b" style={{ height: 32 }} onClick={close}>Cancel</button>
          <button className="b bp" style={{ height: 32, opacity: canSubmit ? 1 : 0.5 }} disabled={!canSubmit} onClick={submit} data-testid="spawn-submit">{busy ? 'Starting…' : 'Start session'}</button>
        </div>
      </div>
    </div>
  );
}
