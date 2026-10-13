// Mock hub for `?mock=1`: fixture state + local simulation of the command API and
// event stream. Loaded via dynamic import so it is split out of the main bundle.
import { assistantStart, assistantTurn, canvasUndo, decideAction, reportView, type AsstCtx } from './mockAssistant';
import winchHtml from '../../apps/winch-console/ui.html?raw';
import type { ApiResponse } from './api';
import { HEX, WPT, handleV2, makeTermSocket, mockRawUrl, startV2Ticks, v2Fixtures, type V2Ctx, type V2State } from './mockv2';
import type {
  Account, AppNode, Approval, Audit, Checkout, Host, HubEvent, Message, Session, StateSnapshot,
} from './types';

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

const hosts: Host[] = [
  { id: 'mini-1', label: 'mini-1', target: 'hosta@mini-1', color: '#43D1B0', status: 'online', last_seen: iso(2000), info: { latencyMs: 4, uname: 'Linux mini-1 6.8.0 x86_64' } },
  { id: 'mini-2', label: 'mini-2', target: 'hostb@mini-2', color: '#A6E15A', status: 'online', last_seen: iso(3000), info: { latencyMs: 7, uname: 'Linux mini-2 6.8.0 x86_64' } },
];

const accounts: Account[] = [
  { id: 'personal', label: 'Personal', color: '#6AA8FF', cloud: { claudeEnvironments: [{ id: 'default', label: 'Default' }], codexEnvironments: [{ id: 'env_hexapod', label: 'hexapod-ci' }] } },
  { id: 'work', label: 'Work', color: '#E0896B', cloud: { claudeEnvironments: [{ id: 'default', label: 'Default' }, { id: 'gpu', label: 'GPU sandbox' }], codexEnvironments: [{ id: 'env_work', label: 'work-ci' }] } },
];

const checkouts: Checkout[] = [
  {
    id: 'co_hexapod_m1', host_id: 'mini-1', path: '~/code/hexapod-robot', repo_id: HEX, repoName: 'hexapod-robot',
    remote_url: 'git@github.com:me/hexapod-robot.git', branch: 'feat/winch-console', head: '3f9c2e1a7b4d90c2e8f1', head_subject: 'winch: speed trace + unconfirmed STOP',
    head_time: iso(14 * 60e3), upstream: 'origin/feat/winch-console', ahead: 2, behind: 0, dirty: 1,
    changes: [{ path: 'apps/winch-console/ui.html', xy: ' M' }],
    apps: [
      { dir: 'apps/winch-console', id: 'winch-console', title: 'Winch console', published: true, nodeId: 'app_winch' },
      { dir: 'apps/leg-tuner', id: 'leg-tuner', title: 'Leg tuner', published: false },
    ],
    updated_at: iso(30e3),
  },
  {
    id: 'co_wpt_m2', host_id: 'mini-2', path: '~/code/wpt-charger', repo_id: WPT, repoName: 'wpt-charger',
    remote_url: 'git@github.com:work/wpt-charger.git', branch: 'main', head: '9a01bc4e55d2', head_subject: 'coil: tighten FEA mesh near ferrite edge',
    head_time: iso(3 * 3600e3), upstream: 'origin/main', ahead: 0, behind: 1, dirty: 0, changes: [], apps: [], updated_at: iso(60e3),
  },
];

const sessions: Session[] = [
  {
    id: 's_cc_m1', vendor: 'claude', kind: 'local', host_id: 'mini-1', account_id: 'personal', checkout_id: 'co_hexapod_m1', cwd: '~/code/hexapod-robot',
    branch: 'feat/winch-console', native_id: 'b2f0c1d4-7a1e-4f0e-9a51-1c2d3e4f5a6b', native_url: 'https://claude.ai/code/session_01Wn8cR4Qe1Hx7Lk2PzYb3', title: 'Winch console: live speed trace',
    status: 'running', last_event: 'PostToolUse', model: 'opus', effort: 'high', created_at: iso(42 * 60e3), updated_at: iso(5e3),
    meta: { channel: 'connected', tmux: 'hub-s_cc_m1' },
  },
  {
    id: 's_cx_m1', vendor: 'codex', kind: 'local', host_id: 'mini-1', account_id: 'personal', checkout_id: 'co_hexapod_m1', cwd: '~/code/hexapod-robot',
    branch: 'feat/winch-console', native_id: 'thr_7c1e', native_url: null, title: 'Gait planner unit tests',
    status: 'idle', last_event: 'turn/completed', model: 'gpt-5-codex', effort: 'medium', created_at: iso(2 * 3600e3), updated_at: iso(18 * 60e3), meta: {},
  },
  {
    id: 's_cx_m2', vendor: 'codex', kind: 'local', host_id: 'mini-2', account_id: 'work', checkout_id: 'co_wpt_m2', cwd: '~/code/wpt-charger',
    branch: 'main', native_id: 'thr_93ab', native_url: null, title: 'Coil turn-count FEA sweep',
    status: 'waiting', last_event: 'item/commandExecution/requestApproval', model: 'gpt-5-codex', effort: 'high', created_at: iso(65 * 60e3), updated_at: iso(40e3), meta: {},
  },
  {
    id: 's_cc_cloud', vendor: 'claude', kind: 'cloud', host_id: null, account_id: 'work', checkout_id: 'co_hexapod_m1', cwd: '',
    branch: 'claude/ferrite-literature', native_id: 'session_01KfT9mN2xQvR8sLp4Wd6Y', native_url: 'https://claude.ai/code/session_01KfT9mN2xQvR8sLp4Wd6Y',
    title: 'Ferrite shielding literature', status: 'running', last_event: 'cloud.poll', model: 'sonnet', effort: null, created_at: iso(41 * 60e3), updated_at: iso(20e3),
    meta: { cloudStatus: 'running', environment: 'default' },
  },
  {
    id: 's_cx_cloud', vendor: 'codex', kind: 'cloud', host_id: null, account_id: 'personal', checkout_id: 'co_hexapod_m1', cwd: '',
    branch: 'codex/can-tests', native_id: 'task_e_68f0a1c2b3d4e5f6', native_url: 'https://chatgpt.com/codex/tasks/task_e_68f0a1c2b3d4e5f6',
    title: 'CAN protocol test suite', status: 'pending', last_event: 'cloud.poll', model: 'gpt-5-codex', effort: null, created_at: iso(6 * 60e3), updated_at: iso(60e3),
    meta: { cloudStatus: 'pending', environment: 'env_hexapod', attempts: 2 },
  },
];

let mseq = 0;
const msg = (session_id: string, role: Message['role'], kind: Message['kind'], text: string, data: any = null, ago = 0): Message =>
  ({ id: `m${++mseq}`, session_id, seq: mseq, role, kind, text, data, created_at: iso(ago) });

const messages: Record<string, Message[]> = {
  s_cc_m1: [
    msg('s_cc_m1', 'user', 'text', 'Add a 12 s speed trace to the winch console and make STOP unconfirmed. Keep set_speed behind a confirm.', null, 40 * 60e3),
    msg('s_cc_m1', 'assistant', 'reasoning', 'The trace can come from read_status history (120 samples at 10 Hz). STOP must stay one click — it is the safe direction.', null, 39 * 60e3),
    msg('s_cc_m1', 'assistant', 'tool', 'Read apps/winch-console/server.py', { name: 'Read', input: { file_path: 'apps/winch-console/server.py' }, output: '137 lines' }, 39 * 60e3),
    msg('s_cc_m1', 'assistant', 'tool', 'Edit apps/winch-console/ui.html', { name: 'Edit', input: { file_path: 'apps/winch-console/ui.html' }, output: '+38 −4' }, 30 * 60e3),
    msg('s_cc_m1', 'assistant', 'command', 'python3 -m py_compile apps/winch-console/server.py', { exitCode: 0, output: '' }, 29 * 60e3),
    msg('s_cc_m1', 'assistant', 'text', 'Trace is in. `stop` is declared `confirm: false` in app.json; `set_speed` keeps `confirm: true` with a 10/min limit. Published as a preview — promote it from the app node when you have reviewed the server.', null, 28 * 60e3),
  ],
  s_cx_m1: [
    msg('s_cx_m1', 'user', 'text', 'Write unit tests for the gait planner phase offsets.', null, 2 * 3600e3),
    msg('s_cx_m1', 'assistant', 'command', 'pytest -q sw/gait/tests', { exitCode: 0, output: '14 passed in 0.82s' }, 100 * 60e3),
    msg('s_cx_m1', 'assistant', 'text', 'Added 6 tests covering tripod and wave gaits; all 14 pass.', null, 18 * 60e3),
  ],
  s_cx_m2: [
    msg('s_cx_m2', 'user', 'text', 'Sweep coil turn count 8–14 and report Q factor and coupling at 85 kHz.', null, 65 * 60e3),
    msg('s_cx_m2', 'assistant', 'reasoning', 'Need to run the FEA regression first to make sure the mesh change did not shift baseline.', null, 60 * 60e3),
    msg('s_cx_m2', 'assistant', 'text', 'Baseline mesh change looks fine. I want to run the solver sweep next.', null, 50e3),
  ],
  s_cc_cloud: [
    msg('s_cc_cloud', 'user', 'text', 'Survey ferrite shielding papers for 85 kHz WPT pads; summarize loss vs thickness.', null, 41 * 60e3),
    msg('s_cc_cloud', 'system', 'status', 'Cloud session running · environment Default', null, 40 * 60e3),
  ],
  s_cx_cloud: [
    msg('s_cx_cloud', 'user', 'text', 'Write a CAN protocol conformance test suite for the leg actuators.', null, 6 * 60e3),
    msg('s_cx_cloud', 'system', 'status', 'Task queued · 2 attempts', null, 6 * 60e3),
  ],
};

const approvals: Approval[] = [
  {
    id: 'ap_1', session_id: 's_cx_m2', source: 'codex', title: 'Run command',
    detail: 'python3 tools/fea_sweep.py --turns 8:14 --freq 85e3', data: { cwd: '~/code/wpt-charger', reason: 'Run the solver sweep (writes runs/sweep_*.csv)' },
    status: 'pending', created_at: iso(40e3),
  },
];

function thumbSvg(): string {
  const bars = Array.from({ length: 60 }, (_, i) => `${(i / 59) * 600},${290 - Math.sin(i / 6) * 40 - i * 0.6}`).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="440" viewBox="0 0 640 440">
<rect width="640" height="440" fill="#0B0C0E"/>
<text x="14" y="28" fill="#8A8F98" font-family="sans-serif" font-size="11" letter-spacing=".5">SIMULATED WINCH · DRUM 0</text>
<rect x="540" y="10" width="86" height="30" rx="15" fill="#C8323A" stroke="#FFB3B6" stroke-width="2"/>
<text x="583" y="30" fill="#fff" font-family="sans-serif" font-size="12" font-weight="700" text-anchor="middle">STOP</text>
${[0, 1, 2, 3].map((i) => `<rect x="${14 + i * 154}" y="52" width="144" height="54" rx="8" fill="#111215" stroke="#24272D"/><rect x="${24 + i * 154}" y="64" width="60" height="7" rx="3" fill="#2A2D33"/><rect x="${24 + i * 154}" y="80" width="${40 + i * 8}" height="14" rx="3" fill="#3A3E46"/>`).join('')}
<rect x="14" y="118" width="612" height="200" rx="9" fill="#111215" stroke="#24272D"/>
<path d="M14 218 H626" stroke="#1E2025"/>
<polyline points="${bars}" transform="translate(20,-30)" fill="none" stroke="#43D1B0" stroke-width="2"/>
<rect x="14" y="334" width="612" height="34" rx="8" fill="#15171B"/>
<rect x="130" y="349" width="380" height="4" rx="2" fill="#2A2D33"/><circle cx="320" cy="351" r="7" fill="#43D1B0"/>
<text x="14" y="400" fill="#8A8F98" font-family="sans-serif" font-size="11">FAULTS</text>
<rect x="70" y="388" width="44" height="18" rx="5" fill="none" stroke="#2A2D33"/>
</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

let appUrl = '';
function getAppUrl() {
  if (!appUrl) {
    appUrl = URL.createObjectURL(new Blob([winchHtml], { type: 'text/html' }));
    ((window as any).__mockAppHtml ||= {})[appUrl] = winchHtml;
  }
  return appUrl;
}

const winchManifest: AppNode['manifest'] = {
  id: 'winch-console', title: 'Winch console', version: '0.3.0', lifecycle: 'on-demand', ui: 'ui://winch-console/main',
  tools: {
    read_status: { tier: 'read' },
    set_speed: { tier: 'actuate', confirm: true, maxPerMinute: 10 },
    stop: { tier: 'actuate', confirm: false },
  },
  node: { width: 640, height: 440 },
};

function makeNodes(): AppNode[] {
  const thumb = thumbSvg();
  const base: AppNode = {
    id: 'app_winch', type: 'app', appId: 'winch-console', sessionId: 's_cc_m1', hostId: 'mini-1', dir: 'apps/winch-console',
    title: 'Winch console', state: 'preview', version: 3, pinnedCommit: null, grantedVersion: null, status: 'running', errors: [],
    url: getAppUrl(), thumbnail: thumb, updatedAt: iso(28 * 60e3), previewOf: null, manifest: winchManifest,
  };
  const out = [base];
  // `?mock=1&apps=20` adds extra app nodes to exercise level-of-detail.
  const extra = Number(new URLSearchParams(location.search).get('apps') || 0);
  for (let i = 1; i < extra; i++) {
    out.push({ ...base, id: `app_winch_${i}`, title: `Winch console ${i + 1}`, sessionId: i % 2 ? 's_cx_m1' : 's_cc_m1', version: 1 });
  }
  return out;
}

const FILES: Record<string, Record<string, string>> = {
  co_hexapod_m1: {
    'README.md': '# hexapod-robot\n\nSix-leg robot, dog scale.\n\n- /HW — power board, leg PCBs, CAD\n- /FW — actuator firmware\n- /SW — gait + control\n- /apps — MCP Apps published to the hub\n',
    'apps/winch-console/app.json': JSON.stringify({ id: 'winch-console', title: 'Winch console', version: '0.3.0', ui: 'ui://winch-console/main', tools: winchManifest.tools, node: winchManifest.node }, null, 2),
    'apps/winch-console/server.py': '#!/usr/bin/env python3\n"""Winch console: MCP Apps server with a SIMULATED winch (no hardware)."""\nimport json, math, os, sys, threading, time\n\nMAX_SPEED = 1.5      # m/s\nCABLE_MAX = 40.0     # m paid out\n...\n',
    'apps/winch-console/ui.html': winchHtml,
    'apps/leg-tuner/app.json': '{\n  "id": "leg-tuner",\n  "title": "Leg tuner",\n  "version": "0.1.0"\n}\n',
    'fw/foc/current_loop.c': '#include "foc.h"\n\nvoid current_loop_step(foc_t *f, float iq_ref) {\n  float err = iq_ref - f->iq;\n  f->integ += f->ki * err * f->dt;\n  f->vq = f->kp * err + f->integ;\n}\n',
    'sw/gait/planner.py': 'class GaitPlanner:\n    def __init__(self, gait="tripod"):\n        self.gait = gait\n',
    'sw/gait/tests/test_planner.py': 'from sw.gait.planner import GaitPlanner\n\ndef test_default():\n    assert GaitPlanner().gait == "tripod"\n',
  },
  co_wpt_m2: {
    'README.md': '# wpt-charger\n\n85 kHz wireless power transfer pad.\n',
    'fea/mesh.py': 'def refine(edge, h=0.2):\n    return edge.subdivide(h)\n',
    'tools/fea_sweep.py': 'import argparse\n\np = argparse.ArgumentParser()\np.add_argument("--turns")\np.add_argument("--freq", type=float)\n',
  },
};

// ---------------- runtime ----------------
const state: StateSnapshot & V2State & { messages: Record<string, Message[]>; audit: Audit[] } = {
  seq: 100,
  hosts, accounts, checkouts, sessions, approvals, nodes: makeNodes(), layout: {},
  config: { publicUrl: location.origin, vapidPublicKey: '' },
  messages, audit: [],
  ...v2Fixtures(checkouts),
};

const listeners: ((e: HubEvent) => void)[] = [];
function emit(type: string, data: any) {
  state.seq += 1;
  const ev = { seq: state.seq, type, data, ts: Date.now() };
  setTimeout(() => listeners.forEach((l) => l(ev)), 0);
}
export function subscribe(fn: (e: HubEvent) => void) { listeners.push(fn); }

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
export function snapshot(): StateSnapshot {
  const { messages: _m, audit: _a, ...rest } = state;
  void _m; void _a;
  return clone({ ...rest, approvals: state.approvals.filter((a) => a.status === 'pending') });
}

const ok = (data: any = { ok: true }, status = 200): ApiResponse => ({ ok: status < 400, status, data });
const err = (status: number, data: any): ApiResponse => ({ ok: false, status, data });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function upd<T extends { id: string }>(list: T[], id: string, patch: Partial<T>, ev: string): T | null {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  emit(ev, list[i]);
  return list[i];
}
const updSession = (id: string, patch: Partial<Session>) => upd(state.sessions, id, { ...patch, updated_at: new Date().toISOString() }, 'session.upsert');

function addMsg(sid: string, role: Message['role'], kind: Message['kind'], text: string, data: any = null) {
  const m = msg(sid, role, kind, text, data);
  (state.messages[sid] ||= []).push(m);
  emit('message.upsert', m);
  return m;
}

/** Streams like the hub: the first chunk creates the message (message.upsert), the rest arrive as message.append. */
async function streamReply(sid: string, text: string) {
  const words = text.split(' ');
  const m = addMsg(sid, 'assistant', 'text', words.slice(0, 3).join(' '));
  for (let i = 3; i < words.length; i += 3) {
    await delay(90);
    const append = ' ' + words.slice(i, i + 3).join(' ');
    const at = m.text.length;
    m.text += append;
    emit('message.append', { id: m.id, session_id: sid, seq: m.seq, kind: m.kind, append, at });
  }
}

// winch simulation (mirrors apps/winch-console/server.py)
const W = { setpoint: 0, speed: 0, paid_out: 12, load_kg: 180, motor_temp_c: 34, enabled: true, faults: [] as string[], history: [] as number[], t0: Date.now() };
setInterval(() => {
  let sp = W.setpoint;
  if (W.faults.includes('OVERLOAD') && sp < 0) sp = 0;
  W.speed += Math.max(-0.08, Math.min(0.08, sp - W.speed));
  W.paid_out = Math.max(0, Math.min(40, W.paid_out + W.speed * 0.1));
  const t = (Date.now() - W.t0) / 1000;
  W.load_kg = 180 + 25 * Math.sin(t / 3) + (W.speed < -0.2 ? 60 : 0);
  W.motor_temp_c += Math.abs(W.speed) * 0.05 - (W.motor_temp_c - 34) * 0.01;
  W.history.push(+W.speed.toFixed(3));
  W.history = W.history.slice(-120);
}, 100);
const wstatus = () => ({ ...W, history: W.history.slice(), t0: undefined });
const text = (t: string, structured?: unknown, isError = false) => ({ content: [{ type: 'text', text: t }], structuredContent: structured, ...(isError ? { isError: true } : {}) });

function audit(node: AppNode, tool: string, tier: string, args: unknown, allowed: boolean, reason: string | null, result: unknown) {
  const a: Audit = { id: `au${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString(), app_node_id: node.id, tool, tier, caller: 'pwa', args, allowed, reason, result };
  state.audit.unshift(a);
  emit('audit.append', a);
}

const recent: number[] = [];
function appCall(node: AppNode, tool: string, args: any, confirmed: boolean): ApiResponse {
  const decl = node.manifest.tools[tool];
  const refuse = (code: string, reason: string) => { audit(node, tool, decl?.tier || '?', args, false, code, null); return err(409, { code, reason }); };
  if (!decl) return refuse('undeclared', `tool "${tool}" is not declared in app.json`);
  if (decl.tier === 'actuate') {
    if (node.state !== 'promoted') return refuse('preview', 'app is a preview; actuate tools need a promoted version');
    if (String(node.grantedVersion) !== String(node.version)) return refuse('not_granted', 'actuate not granted for this version');
    if (decl.confirm && !confirmed) return refuse('needs_confirm', 'tool requires user confirmation');
    const t = Date.now();
    while (recent.length && t - recent[0] > 60000) recent.shift();
    if (decl.maxPerMinute && recent.length >= decl.maxPerMinute) return refuse('rate_limited', `more than ${decl.maxPerMinute} calls/min`);
    recent.push(t);
  }
  let res;
  if (tool === 'read_status') {
    const st = wstatus();
    res = text(`speed ${W.speed.toFixed(2)} m/s, paid out ${W.paid_out.toFixed(1)} m`, st);
  } else if (tool === 'set_speed') {
    const v = Number(args?.speed_mps);
    if (Number.isNaN(v)) res = text('speed_mps must be a number', undefined, true);
    else { const c = Math.max(-1.5, Math.min(1.5, v)); W.setpoint = c; res = text(`setpoint ${c.toFixed(2)} m/s`, wstatus()); }
  } else if (tool === 'stop') {
    W.setpoint = 0; W.faults = W.faults.filter((f) => f !== 'OVERLOAD');
    res = text('stopping: setpoint 0, faults cleared', wstatus());
  } else res = text('ok');
  if (decl.tier !== 'read') audit(node, tool, decl.tier, args, true, null, { isError: !!(res as any).isError });
  return ok(res);
}

function filesOf(id: string) {
  const co = state.checkouts.find((c) => c.id === id);
  const f = FILES[id] || {};
  const changed = new Map((co?.changes || []).map((c) => [c.path, c.xy]));
  const list = Object.keys(f).sort().map((p) => ({ path: p, xy: changed.get(p) || null }));
  return { files: list };
}

function dirtyOf(node: AppNode): string[] {
  const co = state.checkouts.find((c) => c.host_id === node.hostId && c.apps.some((a) => a.dir === node.dir));
  return (co?.changes || []).map((c) => c.path).filter((p) => p.startsWith(node.dir + '/'));
}

function createSession(body: any): Session {
  const cloud = body.where === 'cloud';
  const co = state.checkouts.find((c) => c.id === body.checkoutId);
  const id = `s_new_${++sessN}`;
  const s: Session = {
    id, vendor: body.vendor, kind: cloud ? 'cloud' : 'local', host_id: cloud ? null : body.hostId || co?.host_id || null, account_id: body.accountId,
    checkout_id: body.checkoutId || null, cwd: body.cwd || co?.path || '', branch: body.branch || co?.branch || '', native_id: null, native_url: null,
    title: (body.prompt || 'New session').split(/\s+/).slice(0, 6).join(' '), status: cloud ? 'pending' : 'starting', last_event: null,
    model: body.vendor === 'claude' ? 'opus' : 'gpt-5-codex', effort: body.vendor === 'claude' ? 'high' : 'medium',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    meta: cloud ? { cloudStatus: 'pending', environment: body.environment, attempts: body.attempts } : {},
  };
  state.sessions.push(s);
  emit('session.upsert', s);
  addMsg(id, 'user', 'text', body.prompt || '');
  setTimeout(() => {
    const nid = body.vendor === 'claude' ? 'session_01' + Math.random().toString(36).slice(2, 12) : 'task_e_' + Math.random().toString(16).slice(2, 14);
    const nurl = cloud ? (body.vendor === 'claude' ? `https://claude.ai/code/${nid}` : `https://chatgpt.com/codex/tasks/${nid}`) : null;
    updSession(id, { status: 'running', native_id: nid, native_url: nurl, meta: { ...s.meta, cloudStatus: cloud ? 'running' : undefined } });
    streamReply(id, 'Looking at the repository layout first, then I will start on the change.');
  }, 1200);
  return s;
}

const v2ctx: V2Ctx = { state, emit, createSession, addMsg, updSession: (id, patch) => { updSession(id, patch); }, streamReply };
const asst: AsstCtx = { state, emit, addMsg, streamReply, updSession: (id, patch) => { updSession(id, patch); }, createSession, v2: (mth, path, body) => handleV2(mth, path, new URL(path, location.origin), body, v2ctx) };
startV2Ticks(v2ctx);
export const mockTerminal = makeTermSocket;
export const mockRaw = mockRawUrl;

let sessN = 0;
export async function handle(method: string, path: string, body?: any): Promise<ApiResponse> {
  await delay(60);
  const url = new URL(path, location.origin);
  const p = url.pathname;
  let m: RegExpMatchArray | null;

  if (method === 'GET' && p === '/api/state') return ok(snapshot());

  if (method === 'POST' && p === '/api/sessions') return ok(createSession(body));
  if (method === 'GET' && p === '/api/sessions/archive') return ok([]); // the demo has no sessions past retention
  // canvas assistant (Ask Claude)
  if (method === 'POST' && p === '/api/assistant/start') return ok(assistantStart(asst, body));
  if (method === 'POST' && p === '/api/canvas/view') { reportView(body); return ok(); }
  if (method === 'POST' && (m = p.match(/^\/api\/canvas\/undo\/([^/]+)$/))) return canvasUndo(asst, m[1]);

  if ((m = p.match(/^\/api\/sessions\/([^/]+)\/(messages|send|interrupt|settings|stop|refresh)$/))) {
    const [, sid, act] = m;
    const s = state.sessions.find((x) => x.id === sid);
    if (!s) return err(404, { error: 'no such session' });
    if (act === 'messages') return ok(clone(state.messages[sid] || []));
    if (act === 'send' && s.kind === 'cloud' && s.vendor === 'codex') return err(409, { error: 'Codex cloud tasks cannot be continued outside ChatGPT; open it there' });
    if (act === 'send' && s.meta?.role === 'assistant') {
      addMsg(sid, 'user', 'text', String(body.text));
      void assistantTurn(asst, sid, String(body.text));
      return ok();
    }
    if (act === 'send') {
      addMsg(sid, 'user', 'text', body.text);
      updSession(sid, { status: 'running' });
      setTimeout(async () => {
        if (s.vendor === 'codex') addMsg(sid, 'assistant', 'reasoning', 'Considering the request against the current diff.');
        await streamReply(sid, `On it — "${String(body.text).slice(0, 60)}". I will report back when the change is ready for review.`);
        const cur = state.sessions.find((x) => x.id === sid);
        if (cur && cur.status === 'running' && cur.kind === 'local') updSession(sid, { status: 'idle' });
      }, 400);
      return ok();
    }
    if (act === 'interrupt') { addMsg(sid, 'system', 'status', 'Interrupted by user'); updSession(sid, { status: 'idle' }); return ok(); }
    if (act === 'settings') { updSession(sid, { model: body.model ?? s.model, effort: body.effort ?? s.effort }); return ok(); }
    if (act === 'stop') { updSession(sid, { status: 'ended' }); return ok(); }
    if (act === 'refresh') {
      if (s.kind === 'cloud' && s.vendor === 'codex') {
        const diffSummary = '4 files changed, +212 −9\n fw/can/proto.c           |  41 +++-\n fw/can/tests/test_conf.c | 158 ++++++++++++\n fw/can/proto.h           |  12 +-\n Makefile                 |  10 +-';
        updSession(sid, { status: 'ready', meta: { ...s.meta, cloudStatus: 'ready', diffSummary } });
        return ok({ ok: true, status: 'ready', diffSummary, message: 'Attempt 1 of 2 ready · diff fetched' });
      }
      return ok({ ok: true, status: s.status });
    }
  }

  if ((m = p.match(/^\/api\/approvals\/([^/]+)$/)) && method === 'POST') {
    const ap = state.approvals.find((a) => a.id === m![1]);
    if (!ap) return err(404, { error: 'no such approval' });
    if (ap.status !== 'pending') return err(409, { error: `approval already ${ap.status}` });
    const status = body.decision === 'deny' ? 'deny' : 'allow';
    upd(state.approvals, ap.id, { status }, 'approval.upsert');
    if (ap.source === 'canvas-action') { decideAction(asst, ap, status === 'allow'); return ok(clone(ap)); }
    if (status === 'allow') {
      updSession(ap.session_id, { status: 'running' });
      addMsg(ap.session_id, 'assistant', 'command', ap.detail, { exitCode: null, output: 'running…' });
      setTimeout(async () => {
        addMsg(ap.session_id, 'tool', 'command', ap.detail, { exitCode: 0, output: 'turns  Q      k\n 8     212    0.18\n10     248    0.21\n12     271    0.23\n14     266    0.24' });
        await streamReply(ap.session_id, 'Sweep done: Q peaks at 12 turns (271), coupling keeps rising slowly. 12 turns looks like the sweet spot.');
        updSession(ap.session_id, { status: 'idle' });
      }, 1500);
    } else {
      addMsg(ap.session_id, 'system', 'status', 'Command denied');
      updSession(ap.session_id, { status: 'idle' });
    }
    return ok();
  }

  if ((m = p.match(/^\/api\/checkouts\/([^/]+)\/(files|file|refresh)$/))) {
    const [, cid, act] = m;
    if (act === 'files') return ok(filesOf(cid));
    if (act === 'file') {
      const fp = url.searchParams.get('path') || '';
      const c = FILES[cid]?.[fp];
      return c == null ? err(404, { error: 'not found' }) : ok({ path: fp, content: c });
    }
    const co = state.checkouts.find((c) => c.id === cid);
    if (co) emit('checkout.upsert', co);
    return ok(co);
  }

  if (method === 'POST' && p === '/api/apps/publish') {
    const co = state.checkouts.find((c) => c.host_id === body.hostId && c.apps.some((a) => a.dir === body.dir));
    const app = co?.apps.find((a) => a.dir === body.dir);
    if (!co || !app) return err(404, { error: 'app not found' });
    const node: AppNode = { ...makeNodes()[0], id: `app_${app.id}`, appId: app.id, title: app.title, dir: app.dir, hostId: co.host_id, sessionId: body.sessionId || null, version: 1, thumbnail: thumbSvg(), manifest: { ...winchManifest, id: app.id, title: app.title } };
    state.nodes.push(node);
    emit('node.upsert', node);
    app.published = true; app.nodeId = node.id;
    emit('checkout.upsert', clone(co));
    return ok(node);
  }

  if ((m = p.match(/^\/api\/apps\/([^/]+)(?:\/(call|resource|review|promote|reload|message|ui|thumbnail\.png))?$/))) {
    const [, nid, act] = m;
    const node = state.nodes.find((n) => n.id === nid);
    if (!node) return err(404, { error: 'no such app' });
    if (!act && method === 'DELETE') { state.nodes = state.nodes.filter((n) => n.id !== nid); emit('node.remove', { id: nid }); return ok(); }
    if (act === 'call') return appCall(node, body.tool, body.arguments, !!body.confirmed);
    if (act === 'resource') return ok({ contents: [{ uri: body.uri, mimeType: 'text/plain', text: `mock resource ${body.uri}` }] });
    if (act === 'review') {
      return ok({
        version: node.version, candidateCommit: '3f9c2e1a7b4d90c2e8f1', dirtyFiles: dirtyOf(node), tools: node.manifest.tools,
        lifecycle: node.manifest.lifecycle, reviewHash: 'rh_' + String(node.version) + '_' + dirtyOf(node).length,
        serverFiles: [
          { path: 'app.json', content: FILES.co_hexapod_m1['apps/winch-console/app.json'] },
          { path: 'server.py', content: FILES.co_hexapod_m1['apps/winch-console/server.py'] },
        ],
      });
    }
    if (act === 'promote') {
      const dirty = dirtyOf(node);
      if (dirty.length && !body.commitDirty) return err(409, { code: 'dirty', reason: 'app files have uncommitted changes; use Commit & pin' });
      if (body.reviewHash !== 'rh_' + String(node.version) + '_' + dirty.length) return err(409, { code: 'stale_review', reason: 'files changed since review' });
      let commit = body.commit;
      if (dirty.length) {
        commit = 'c0ffee1' + Math.random().toString(16).slice(2, 10);
        const co = state.checkouts.find((c) => c.host_id === node.hostId && c.apps.some((a) => a.dir === node.dir));
        if (co) {
          co.changes = co.changes.filter((c) => !c.path.startsWith(node.dir + '/'));
          co.dirty = co.changes.length; co.head = commit; co.head_time = new Date().toISOString(); co.head_subject = `${node.appId}: pin v${node.version} for promotion`; co.ahead += 1;
          emit('checkout.upsert', clone(co));
        }
      }
      const n = upd(state.nodes, nid, { state: 'promoted', pinnedCommit: commit, grantedVersion: body.grantActuate ? node.version : null }, 'node.upsert');
      return ok(n);
    }
    if (act === 'message') {
      if (node.state !== 'promoted') return err(409, { error: 'preview apps cannot message their agent; promote the app first' });
      return ok();
    }
    if (act === 'reload') {
      upd(state.nodes, nid, { status: 'starting' }, 'node.upsert');
      setTimeout(() => upd(state.nodes, nid, { status: 'running', updatedAt: new Date().toISOString() }, 'node.upsert'), 700);
      return ok();
    }
  }

  if (method === 'GET' && p === '/api/audit') {
    const n = url.searchParams.get('node');
    return ok(clone(state.audit.filter((a) => !n || a.app_node_id === n)));
  }
  if (method === 'POST' && p === '/api/layout') {
    const { nodeId, size, ...rest } = body;
    const prev: any = state.layout[nodeId] || {};
    const merged: any = { ...(prev.size || {}), ...(size || {}) };
    Object.keys(merged).forEach((k) => { if (merged[k] == null) delete merged[k]; });
    state.layout[nodeId] = { ...prev, ...rest, size: merged };
    emit('layout.upsert', { nodeId, ...state.layout[nodeId] });
    return ok();
  }
  const v2 = handleV2(method, p, url, body, v2ctx);
  if (v2) return v2;
  if (p === '/api/push/vapid') return ok({ publicKey: '' });
  if (p.startsWith('/api/push/')) return ok();
  return err(404, { error: `mock: no route ${method} ${p}` });
}

// background liveliness: the running local Claude session keeps working.
let tick = 0;
setInterval(() => {
  const s = state.sessions.find((x) => x.id === 's_cc_m1');
  if (!s || s.status !== 'running' || tick > 6) return;
  tick++;
  const files = ['apps/winch-console/ui.html', 'apps/winch-console/server.py', 'apps/winch-console/app.json'];
  addMsg('s_cc_m1', 'assistant', 'tool', `Read ${files[tick % 3]}`, { name: 'Read', input: { file_path: files[tick % 3] }, output: 'ok' });
}, 9000);

// Mock file bytes are data: URLs. Answer fetch() of them in-page, so file viewers work even where
// the page's CSP has no connect-src (the published demo).
if (typeof window !== 'undefined' && !(window as any).__mockDataFetch) {
  (window as any).__mockDataFetch = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const m = url.match(/^data:([^;,]+)(;charset=[^;,]+)?(;base64)?,(.*)$/s);
    if (!m) return realFetch(input, init);
    const bytes = m[3] ? Uint8Array.from(atob(m[4]), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[4]));
    return Promise.resolve(new Response(bytes, { status: 200, headers: { 'content-type': m[1] } }));
  };
}
