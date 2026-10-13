// Mock hub, v2 part: projects, branches, machines, devices, canvas nodes, to-dos, grants, HIL,
// file sources and terminals. Imported only by mock.ts (lazy chunk).
import type { ApiResponse, TermSocket } from './api';
import { kindOf } from './files';
import type {
  Branch, CNode, Checkout, Device, FileSource, Grant, HilPlan, HilRun, Machine, Project, Session, Todo,
} from './types';

const now = Date.now();
const ago = (ms: number) => now - ms;

export const HEX = 'github.com/me/hexapod-robot';
export const WPT = 'github.com/work/wpt-charger';
const SHA = {
  hexMain: '8c41d07e2b9a51f3c6d2',
  hexWinch: '3f9c2e1a7b4d90c2e8f1',
  hexWinchRemote: '5aa31e8c0f4d27b72e0f',
  hexCan: 'c0f4d27e41c9a0b13d55',
  hexFerrite: 'e41c9a0d5b7f3a2c9e01',
  hexPlanOld: 'de26a41b0c9d8e7f6a5b',
  hexPlanNew: '9b1f0c2a3d4e5f60718a',
  wptMain: '9a01bc4e55d2a7f30b11',
  wptCoil: '71ce0a9b3d5f2e8c4a6d',
};

// ---------------------------------------------------------------- files
function stlFemur(): string {
  // a link: a flat bar with a round boss at each end (ASCII STL)
  const tris: number[][][] = [];
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    f.forEach((t) => tris.push(t.map((i) => v[i])));
  };
  const cyl = (cx: number, cy: number, r: number, z0: number, z1: number, n = 28) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
      const p = [cx + r * Math.cos(a), cy + r * Math.sin(a)], q = [cx + r * Math.cos(b), cy + r * Math.sin(b)];
      tris.push([[cx, cy, z1], [p[0], p[1], z1], [q[0], q[1], z1]]);
      tris.push([[cx, cy, z0], [q[0], q[1], z0], [p[0], p[1], z0]]);
      tris.push([[p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1]]);
      tris.push([[p[0], p[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]]);
    }
  };
  box(-60, -9, -5, 60, 9, 5);
  box(-40, -4, 5, 40, 4, 9);
  cyl(-60, 0, 16, -7, 7);
  cyl(60, 0, 13, -6, 6);
  cyl(-60, 0, 7, 7, 14);
  const f = (n: number) => n.toFixed(3);
  return `solid femur_link\n${tris.map((t) => `facet normal 0 0 0\n outer loop\n${t.map((p) => `  vertex ${p.map(f).join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n')}\nendsolid femur_link\n`;
}

function heatSvg(w: number, h: number, cols: number, rows: number, hue: 'amber' | 'green', title: string): string {
  const cw = w / cols, ch = (h - 30) / rows;
  let cells = '';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const d = Math.hypot((c - cols / 2) / cols, (r - rows / 2) / rows);
    const v = Math.max(0, 1 - d * 1.9);
    const col = hue === 'amber' ? `rgb(${40 + 190 * v | 0},${32 + 140 * v | 0},${20 + 50 * v | 0})` : `rgb(${30 + 120 * v | 0},${40 + 180 * v | 0},${28 + 40 * v | 0})`;
    cells += `<rect x="${(c * cw + 1).toFixed(1)}" y="${(30 + r * ch + 1).toFixed(1)}" width="${(cw - 2).toFixed(1)}" height="${(ch - 2).toFixed(1)}" rx="2" fill="${col}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#0E0F12"/><text x="4" y="18" fill="#A3A7AF" font-family="sans-serif" font-size="12">${title}</text>${cells}</svg>`;
}

const HEX_README = `# hexapod-robot

Dog-scale six-leg walking robot. Each joint is a BLDC actuator with its own FOC controller on a shared leg CAN bus.

## Repo layout
- \`SYS/\` requirements, architecture, plans, V&V
- \`HW/\` power board, leg PCBs, CAD
- \`fw/\` actuator firmware (FOC)
- \`sw/\` gait + high-level control
- \`apps/\` MCP Apps published to the hub

## Gait sweep
![Gait sweep](AI/sim/gait/gait_sweep.png)

## Status
| Subsystem | State | Owner |
|---|---|---|
| Leg actuator fw | tuning | agents |
| Winch console | preview | agents |
| Gait | research | agents |

## Build
\`\`\`sh
cd fw && cmake --preset g474
cmake --build build -j
\`\`\`
`;

const WPT_README = `# wpt-charger

85 kHz wireless power transfer pad with a PCB coil. Footprint, air gap and bus voltage are fixed by the vehicle interface.

## Repo layout
- \`HW/\` inverter, rectifier, coil
- \`SYS/\` requirements, coupling budget
- \`fea/\` FEA runs and mesh tools

## Targets
| Metric | Target | Now |
|---|---|---|
| Power | 3 kW | 2.4 kW |
| Coupling k | ≥ 0.45 | 0.41 |
`;

const PLAN_OLD = `# Actuator V&V test plan

Bench: leg actuator PCBA rev A on the leg CAN bus, flashed through the ST-LINK.

## Setup
1. Flash the firmware under test via ST-LINK.
2. Bring up \`can0\` at 1 Mbit/s on the PCAN-USB FD.
3. Hold the bench PSU at 48 V.

## Tests
| ID | Requirement | Test |
|---|---|---|
| T-01 | REQ-ACT-01 | Flash fw via ST-LINK |
| T-02 | REQ-ACT-02 | CAN heartbeat on 0x101–0x103 |
| T-03…05 | REQ-ACT-04 | Torque hold at 0 / 25 / 60 °C |
| T-06, T-07 | REQ-ACT-07 | Current loop step response, overshoot ≤ 5 % |
| T-08, T-09 | REQ-ACT-09 | Over-current trip, CAN bus-off recovery |
| T-10 | REQ-ACT-11 | Encoder index on power-up |
| T-11 | REQ-ACT-12 | Thermal derate above 55 °C |
`;
const PLAN_NEW = PLAN_OLD + `| T-12 | REQ-ACT-13 | Safe state on E-stop |\n`;

const WINCH_DOC = `# Winch console — design notes

The console drives a **simulated** winch. Two tools change state:

- \`set_speed\` — actuate tier, confirm before every call, ≤ 10 calls / min
- \`stop\` — actuate tier, **never** confirmed: stopping is the safe direction

![Speed trace](trace.svg)

## Open questions
1. Should STOP also clear the OVERLOAD latch? (currently yes)
2. Is a 12 s trace long enough to see the load oscillation?

<img src="x" onerror="alert('this must be sanitized')">
`;

const TRACE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="160" viewBox="0 0 560 160"><rect width="560" height="160" fill="#111215"/><path d="M30 20V140H550" stroke="#3A3E46" fill="none"/><path d="M30 80H550" stroke="#1E2025"/><polyline fill="none" stroke="#43D1B0" stroke-width="2" points="${Array.from({ length: 60 }, (_, i) => `${30 + i * 8.6},${80 - Math.sin(i / 5) * 40 * Math.exp(-i / 45)}`).join(' ')}"/><text x="34" y="16" fill="#8A8F98" font-family="monospace" font-size="10">speed m/s · 12 s</text></svg>`;

const CURRENT_LOOP = `#include "foc.h"

#define KP_IQ 0.42f
#define KI_IQ 310.0f

/* One step of the q-axis current PI loop (runs at 20 kHz). */
void current_loop_step(foc_t *f, float iq_ref) {
  float err = iq_ref - f->iq;
  f->integ += KI_IQ * err * f->dt;
  if (f->integ > f->vmax) f->integ = f->vmax;   // anti-windup
  if (f->integ < -f->vmax) f->integ = -f->vmax;
  f->vq = KP_IQ * err + f->integ;
}
`;

type FileMap = Record<string, string>;
const HEX_FILES: FileMap = {
  'README.md': HEX_README,
  'SYS/vv/actuator_test_plan.md': PLAN_NEW,
  'SYS/architecture/leg_actuator.md': '# Leg actuator architecture\n\nEncoder → MCU (FOC) → gate driver → 3-phase bridge → BLDC.\n\nTraces: REQ-ACT-004, REQ-ACT-011, REQ-ACT-015.\n',
  'HW/leg/femur_link.stl': '', // generated lazily
  'HW/power-rev-b/power_board.kicad_sch': '(kicad_sch (version 20231120) (generator eeschema))\n',
  'AI/sim/gait/gait_sweep.png': '',
  'docs/winch-console.md': WINCH_DOC,
  'docs/trace.svg': TRACE_SVG,
  'fw/foc/current_loop.c': CURRENT_LOOP,
  'sw/gait/planner.py': 'class GaitPlanner:\n    """Tripod and wave gaits for six legs."""\n\n    def __init__(self, gait: str = "tripod"):\n        self.gait = gait\n\n    def phase(self, leg: int) -> float:\n        return (leg % 2) * 0.5 if self.gait == "tripod" else leg / 6\n',
  'apps/winch-console/app.json': '{\n  "id": "winch-console",\n  "title": "Winch console",\n  "version": "0.3.0"\n}\n',
  'apps/leg-tuner/app.json': '{\n  "id": "leg-tuner",\n  "title": "Leg tuner",\n  "version": "0.1.0",\n  "tools": { "read_gains": { "tier": "read" } }\n}\n',
  'DOCS/datasheets/gate_driver.pdf': '%PDF-1.4\n% mock\n',
};
const WPT_FILES: FileMap = {
  'README.md': WPT_README,
  'fea/mesh.py': 'def refine(edge, h=0.2):\n    return edge.subdivide(h)\n',
  'tools/fea_sweep.py': 'import argparse\n\np = argparse.ArgumentParser()\np.add_argument("--turns")\np.add_argument("--freq", type=float)\n',
  'AI/fem/coil_field_map.png': '',
  'SYS/requirements/coupling_budget.md': '# Coupling budget\n\n| Gap | k target |\n|---|---|\n| 120 mm | ≥ 0.45 |\n| 160 mm | ≥ 0.32 |\n',
  'apps/coil-viewer/app.json': '{\n  "id": "coil-viewer",\n  "title": "Coil viewer",\n  "version": "0.2.0",\n  "tools": { "read_field": { "tier": "read" } }\n}\n',
};

let stlCache = '';
function contentOf(projectId: string, path: string, sha?: string): { body: string; type: string } | null {
  const files = projectId === WPT ? WPT_FILES : HEX_FILES;
  if (!(path in files)) return null;
  if (path.endsWith('.stl')) { stlCache ||= stlFemur(); return { body: stlCache, type: 'model/stl' }; }
  if (path === 'AI/sim/gait/gait_sweep.png') return { body: heatSvg(640, 360, 20, 9, 'amber', 'gait sweep · stride × duty factor'), type: 'image/svg+xml' };
  if (path === 'AI/fem/coil_field_map.png') return { body: heatSvg(640, 360, 16, 8, 'green', 'coil field map · 12 turns · 85 kHz'), type: 'image/svg+xml' };
  if (path === 'SYS/vv/actuator_test_plan.md' && sha && sha.startsWith(SHA.hexPlanOld.slice(0, 7))) return { body: PLAN_OLD, type: 'text/markdown' };
  const k = kindOf(path);
  return { body: files[path], type: k === 'image' ? 'image/svg+xml' : k === 'pdf' ? 'application/pdf' : 'text/plain' };
}

let projectOfCheckout: (id: string) => string = () => HEX;
const rawCache = new Map<string, string>();
export function mockRawUrl(source: FileSource, path: string, sha?: string): string {
  const pid = source.kind === 'github' ? source.projectId : projectOfCheckout(source.checkoutId);
  const key = `${pid}|${path}|${sha || ''}`;
  let u = rawCache.get(key);
  if (!u) {
    const c = contentOf(pid, path, sha);
    u = `data:${c ? c.type : 'text/plain'};charset=utf-8,${encodeURIComponent(c ? c.body : `mock: no file ${path}`)}`;
    rawCache.set(key, u);
  }
  return u;
}

// ---------------------------------------------------------------- fixtures
export function v2Fixtures(checkouts: Checkout[]) {
  projectOfCheckout = (id) => checkouts.find((c) => c.id === id)?.repo_id || HEX;
  const projects: Project[] = [
    {
      id: HEX, name: 'hexapod-robot', remoteUrl: 'git@github.com:me/hexapod-robot.git',
      gh: { owner: 'me', repo: 'hexapod-robot', account: 'personal', url: 'https://github.com/me/hexapod-robot' },
      defaultBranch: 'main', readme: HEX_README, stats: { files: 412, commits: 1284, sizeMB: 186, branches: 5, sessions: 5 },
      folders: [{ name: 'SYS', mb: 4 }, { name: 'HW', mb: 96 }, { name: 'fw', mb: 12 }, { name: 'sw', mb: 9 }, { name: 'DOCS', mb: 38 }, { name: 'AI', mb: 27 }],
      checkouts: ['co_hexapod_m1'], updatedAt: ago(14 * 60e3),
    },
    {
      id: WPT, name: 'wpt-charger', remoteUrl: 'git@github.com:work/wpt-charger.git',
      gh: { owner: 'work', repo: 'wpt-charger', account: 'work', url: 'https://github.com/work/wpt-charger' },
      defaultBranch: 'main', readme: WPT_README, stats: { files: 168, commits: 402, sizeMB: 64, branches: 2, sessions: 1 },
      folders: [{ name: 'HW', mb: 31 }, { name: 'SYS', mb: 2 }, { name: 'fea', mb: 18 }, { name: 'AI', mb: 13 }],
      checkouts: ['co_wpt_m2'], updatedAt: ago(3 * 3600e3),
    },
  ];
  const br = (p: Partial<Branch> & Pick<Branch, 'projectId' | 'name'>): Branch => ({
    id: `${p.projectId}#${p.name}`, base: null, goal: null, createdBy: 'other', checkouts: [], head: null, pushed: true, remoteSha: null,
    aheadRemote: 0, behindRemote: 0, aheadBase: 0, behindBase: 0, pr: null, ci: null, commits: [], apps: [], cloud: null, updatedAt: ago(60e3), ...p,
  });
  const branches: Branch[] = [
    br({ projectId: HEX, name: 'main', head: SHA.hexMain, remoteSha: SHA.hexMain, ci: { state: 'success', total: 6, passed: 6, failed: 0, url: 'https://github.com/me/hexapod-robot/actions' },
      commits: [{ sha: SHA.hexMain, subject: 'Merge #12: gait planner phase offsets', author: 'me', at: ago(26 * 3600e3) }] }),
    br({
      projectId: HEX, name: 'feat/winch-console', base: 'main', goal: 'Simulated winch console app: live speed trace, confirmed set_speed, one-click STOP.', createdBy: 'hub',
      checkouts: ['co_hexapod_m1'], head: SHA.hexWinch, remoteSha: SHA.hexWinchRemote, aheadRemote: 2, behindRemote: 0, aheadBase: 7, behindBase: 1,
      pr: { number: 14, title: 'Winch console app', state: 'open', url: 'https://github.com/me/hexapod-robot/pull/14', reviews: { approved: 1, changesRequested: 0, commented: 2 } },
      ci: { state: 'pending', total: 5, passed: 3, failed: 0, url: 'https://github.com/me/hexapod-robot/actions' },
      commits: [
        { sha: SHA.hexWinch, subject: 'winch: speed trace + unconfirmed STOP', author: 'Claude Code', at: ago(14 * 60e3) },
        { sha: 'a7d2e90c1b3f', subject: 'winch: set_speed behind confirm, 10/min', author: 'Claude Code', at: ago(52 * 60e3) },
        { sha: SHA.hexWinchRemote, subject: 'winch: app.json tiers', author: 'Claude Code', at: ago(3 * 3600e3) },
        { sha: '0b77c3d1e2f4', subject: 'apps: scaffold winch-console', author: 'me', at: ago(26 * 3600e3) },
      ],
      apps: [{ path: 'apps/winch-console', id: 'winch-console', title: 'Winch console' }],
    }),
    br({
      projectId: HEX, name: 'codex/can-tests', base: 'feat/winch-console', goal: 'CAN protocol conformance tests for the leg actuators.', createdBy: 'agent',
      head: null, remoteSha: SHA.hexCan, aheadBase: 3, behindBase: 0,
      pr: { number: 15, title: 'CAN conformance suite', state: 'draft', url: 'https://github.com/me/hexapod-robot/pull/15', reviews: { approved: 0, changesRequested: 1, commented: 1 } },
      ci: { state: 'failure', total: 6, passed: 4, failed: 2, url: 'https://github.com/me/hexapod-robot/actions' },
      commits: [{ sha: SHA.hexCan, subject: 'can: bus-off recovery fixture', author: 'Codex', at: ago(5 * 60e3) }, { sha: 'f1e2d3c4b5a6', subject: 'can: heartbeat tests', author: 'Codex', at: ago(30 * 60e3) }],
      cloud: { sessionId: 's_cx_cloud' },
    }),
    br({
      projectId: HEX, name: 'claude/ferrite-literature', base: 'main', createdBy: 'agent', remoteSha: SHA.hexFerrite, aheadBase: 1,
      commits: [{ sha: SHA.hexFerrite, subject: 'docs: ferrite shielding survey (draft)', author: 'Claude', at: ago(20 * 60e3) }],
      cloud: { sessionId: 's_cc_cloud' },
    }),
    br({ projectId: WPT, name: 'main', checkouts: ['co_wpt_m2'], head: SHA.wptMain, remoteSha: '1d2c3b4a5f6e', behindRemote: 1, ci: { state: 'success', total: 3, passed: 3, failed: 0, url: null } }),
    br({
      projectId: WPT, name: 'feat/coil-v3', base: 'main', goal: 'Coil v3: 12 turns, ferrite tiles under the pad, k ≥ 0.45 at 120 mm.', createdBy: 'hub',
      remoteSha: SHA.wptCoil, aheadBase: 4,
      pr: { number: 31, title: 'Coil v3', state: 'merged', url: 'https://github.com/work/wpt-charger/pull/31', reviews: { approved: 2, changesRequested: 0, commented: 0 } },
      ci: { state: 'success', total: 3, passed: 3, failed: 0, url: null },
      commits: [{ sha: SHA.wptCoil, subject: 'coil: v3 geometry + viewer app', author: 'me', at: ago(2 * 86400e3) }],
      apps: [{ path: 'apps/coil-viewer', id: 'coil-viewer', title: 'Coil viewer' }],
    }),
  ];
  const machines: Machine[] = [
    { id: 'mini-1', label: 'mini-1', kind: 'host', color: '#43D1B0', status: 'online', cpu: { pct: 37, cores: 8 }, mem: { usedMB: 22400, totalMB: 64000 }, gpu: [], load: 2.1, updatedAt: now },
    { id: 'mini-2', label: 'mini-2', kind: 'host', color: '#A6E15A', status: 'online', cpu: { pct: 81, cores: 8 }, mem: { usedMB: 41200, totalMB: 64000 }, gpu: [{ name: 'RTX 4060', utilPct: 64, memUsedMB: 5200, memTotalMB: 8188 }], load: 6.4, updatedAt: now },
    { id: 'claude-cloud', label: 'Claude cloud', kind: 'cloud', color: '#E0896B', status: 'managed', cpu: null, mem: null, gpu: [], load: null, updatedAt: now },
    { id: 'codex-cloud', label: 'Codex cloud', kind: 'cloud', color: '#A48BFA', status: 'managed', cpu: null, mem: null, gpu: [], load: null, updatedAt: now },
  ];
  const dev = (d: Partial<Device> & Pick<Device, 'id' | 'hostId' | 'title' | 'icon'>): Device => ({ parentId: null, kind: '', port: '', fw: '', status: 'connected', source: 'declared', lock: null, updatedAt: now, ...d });
  const devices: Device[] = [
    dev({ id: 'mini-1:stlink', hostId: 'mini-1', title: 'ST-LINK V3SET', icon: 'SWD', kind: 'Debug probe · SWD 24 MHz', port: '/dev/ttyACM0', fw: 'probe fw V3J15', lock: { sessionId: 's_cc_m1', since: ago(20 * 60e3) } }),
    dev({ id: 'mini-1:pcba', hostId: 'mini-1', parentId: 'mini-1:stlink', title: 'Leg actuator PCBA rev A', icon: 'DUT', kind: 'STM32G474 · bench rig #1', port: 'via ST-LINK', fw: 'fw 0.7.3-3f9c2e1', status: 'busy' }),
    dev({ id: 'mini-1:pcan', hostId: 'mini-1', title: 'PCAN-USB FD', icon: 'CAN', kind: 'USB-CAN interface', port: 'can0 · 1 Mbit/s', source: 'discovered' }),
    dev({ id: 'mini-1:canbus', hostId: 'mini-1', parentId: 'mini-1:pcan', title: 'Leg CAN bus · 3 actuators', icon: 'BUS', kind: 'IDs 0x101–0x103', port: '2.1 k frames/s', status: 'reachable' }),
    dev({ id: 'mini-2:psu', hostId: 'mini-2', title: 'Bench PSU', icon: 'LAN', kind: 'SCPI over LAN', port: '192.168.1.52', fw: '48.0 V · 2.1 A', lock: { sessionId: 's_cx_m2', since: ago(30 * 60e3) } }),
    dev({ id: 'mini-2:scope', hostId: 'mini-2', title: 'Rigol DS1054Z', icon: 'USB', kind: 'Oscilloscope · USBTMC', port: '/dev/usbtmc0', status: 'missing' }),
  ];
  const plan: HilPlan = { id: 'mini-1:actuator-vv', title: 'Actuator V&V', hostId: 'mini-1', devices: ['mini-1:stlink', 'mini-1:pcba', 'mini-1:pcan', 'mini-1:canbus'], plan: 'SYS/vv/actuator_test_plan.md', setup: ['mini-1', 'PCAN-USB FD', 'leg CAN bus', 'actuator PCBA', 'ST-LINK (flash)'] };
  const run = makeRun(plan, 'run_142', 's_cc_m1', ago(3 * 60e3));
  for (let i = 0; i < 6; i++) stepRun(run);
  // the running plan holds its devices (the ST-LINK was already the agent's)
  const took = plan.devices.filter((id) => { const d = devices.find((x) => x.id === id); if (!d || d.lock) return false; d.lock = { sessionId: run.startedBy, since: Number(run.startedAt) }; return true; });
  runLocks.set(run.id, took);
  const grants: Grant[] = [
    { id: 'g1', sessionId: 's_cx_m2', hostId: 'mini-2', resources: '1× RTX 4060 · 8 GB', purpose: 'Offload the FEA solver to the GPU', quotaGB: 24, usedGB: 7.4, status: 'active', createdAt: ago(50 * 60e3) },
    { id: 'g2', sessionId: 's_cc_m1', hostId: 'mini-2', resources: 'GPU · 4 GB', purpose: 'Render winch trace benchmarks', quotaGB: 4, usedGB: 0, status: 'requested', createdAt: ago(2 * 60e3) },
  ];
  const todos: Todo[] = [
    { id: 't1', scope: HEX, text: 'Review the winch console STOP behaviour', src: 's_cc_m1', done: false, dispatchedSessionId: null, createdAt: ago(30 * 60e3) },
    { id: 't2', scope: HEX, text: 'Write acceptance criteria for the gait planner', src: 'you', done: false, dispatchedSessionId: null, createdAt: ago(3 * 3600e3) },
    { id: 't3', scope: HEX, text: 'Order 2 oz copper sample boards', src: 's_cc_m1', done: false, dispatchedSessionId: null, createdAt: ago(20 * 60e3) },
    { id: 't4', scope: HEX, text: 'Add CAN fixture tests', src: 'you', done: false, dispatchedSessionId: 's_cx_cloud', createdAt: ago(10 * 60e3) },
    { id: 't5', scope: WPT, text: 'Check coil fixture clearances', src: 'you', done: false, dispatchedSessionId: null, createdAt: ago(5 * 3600e3) },
    { id: 't6', scope: WPT, text: 'Summarize ferrite shielding papers', src: 'you', done: true, dispatchedSessionId: 's_cc_cloud', createdAt: ago(9 * 3600e3) },
  ];
  const cn = (c: Partial<CNode> & Pick<CNode, 'id' | 'type' | 'data'>): CNode => ({ parentId: null, createdBy: 'you', createdAt: ago(3600e3), updatedAt: ago(60e3), ...c });
  const hexWinch = { kind: 'github', projectId: HEX, ref: 'feat/winch-console' } as FileSource;
  const cnodes: CNode[] = [
    cn({ id: 'todos_hex', type: 'todos', parentId: HEX, data: { title: 'To-dos · hexapod-robot', scope: HEX } }),
    cn({ id: 'todos_wpt', type: 'todos', data: { title: 'To-dos · wpt-charger', scope: WPT } }),
    cn({ id: 'htodo_t3', type: 'htodo', parentId: 's_cc_m1', createdBy: 's_cc_m1', data: { todoId: 't3' } }),
    cn({
      id: 'sug_1', type: 'suggest', parentId: 's_cc_m1', createdBy: 's_cc_m1',
      data: { title: 'Add a CAN bus-off recovery test', prompt: 'Write a HIL test that drops the leg CAN bus off and checks that STOP still lands within 50 ms.', rationale: 'STOP is untested while the bus is off — the one path that must never fail.', vendor: 'codex', hostId: 'mini-1', accountId: 'personal', branchId: `${HEX}#feat/winch-console`, status: 'open' },
    }),
    cn({
      id: 'rev_1', type: 'review', parentId: 's_cc_m1', createdBy: 's_cc_m1',
      data: {
        sessionId: 's_cc_m1', title: 'Winch console design notes', path: 'docs/winch-console.md', source: { kind: 'checkout', checkoutId: 'co_hexapod_m1' }, sha: SHA.hexWinch,
        kind: 'Markdown · 1 figure', note: 'Please check the STOP semantics before I wire this to the real winch.', promoteTo: 'docs/',
        checklist: [{ text: 'STOP is never confirmed', done: true }, { text: 'set_speed limits match app.json', done: false }, { text: 'Trace axis is labelled', done: false }],
        comments: [{ id: 'c1', author: 'agent', text: 'The trace is read_status history (120 samples at 10 Hz).', at: ago(12 * 60e3) }],
        status: 'pending',
      },
    }),
    cn({
      id: 'rev_2', type: 'review', parentId: 's_cx_m2', createdBy: 's_cx_m2',
      data: {
        sessionId: 's_cx_m2', title: 'coil_field_map.png', path: 'AI/fem/coil_field_map.png', source: { kind: 'checkout', checkoutId: 'co_wpt_m2' }, sha: SHA.wptMain,
        kind: 'Figure', note: 'Field map for 12 turns at 85 kHz — does the hot spot near the ferrite edge look plausible?', promoteTo: null,
        checklist: [{ text: 'Colour scale is labelled', done: false }, { text: 'Hot spot matches the mesh change', done: false }], comments: [], status: 'pending',
      },
    }),
    cn({ id: 'file_plan', type: 'file', parentId: `${HEX}#feat/winch-console`, data: { source: hexWinch, path: 'SYS/vv/actuator_test_plan.md', sha: SHA.hexPlanOld, kind: 'doc', newer: { sha: SHA.hexPlanNew, subject: 'vv: add T-12 E-stop safe state', at: ago(8 * 60e3) } } }),
    cn({ id: 'file_femur', type: 'file', parentId: HEX, data: { source: { kind: 'github', projectId: HEX, ref: 'main' }, path: 'HW/leg/femur_link.stl', sha: SHA.hexMain, kind: 'model3d', newer: null } }),
    cn({ id: 'file_loop', type: 'file', parentId: 's_cx_m1', data: { source: { kind: 'checkout', checkoutId: 'co_hexapod_m1' }, path: 'fw/foc/current_loop.c', sha: SHA.hexWinch, kind: 'code', newer: null } }),
    cn({ id: 'file_gait', type: 'file', data: { source: { kind: 'github', projectId: HEX, ref: 'main' }, path: 'AI/sim/gait/gait_sweep.png', sha: SHA.hexMain, kind: 'image', newer: null } }),
    cn({ id: 'note_1', type: 'note', data: { title: 'Note', text: 'Bench rig: ask before taking the PSU above 48 V.\nST-LINK is shared — release it after flashing.' } }),
    cn({ id: 'term_m1', type: 'terminal', parentId: 'mini-1', data: { hostId: 'mini-1', cwd: '~', mode: 'shell', sessionId: null, status: 'open' } }),
  ];
  return { projects, branches, machines, devices, cnodes, todos, grants, hil: { plans: [plan], runs: [run] } };
}

// ---------------------------------------------------------------- HIL simulation
const HIL_TESTS: [string, string, string][] = [
  ['T-01', 'REQ-ACT-01', 'Flash fw 0.7.3 via ST-LINK'], ['T-02', 'REQ-ACT-02', 'CAN heartbeat on 0x101-0x103'],
  ['T-03', 'REQ-ACT-04', 'Torque hold 0 °C'], ['T-04', 'REQ-ACT-04', 'Torque hold 25 °C'], ['T-05', 'REQ-ACT-04', 'Torque hold 60 °C'],
  ['T-06', 'REQ-ACT-07', 'Current loop step response'], ['T-07', 'REQ-ACT-07', 'Overshoot ≤ 5 %'], ['T-08', 'REQ-ACT-09', 'Fault: over-current trip'],
  ['T-09', 'REQ-ACT-09', 'Fault: CAN bus-off recovery'], ['T-10', 'REQ-ACT-11', 'Encoder index on power-up'], ['T-11', 'REQ-ACT-12', 'Thermal derate above 55 °C'],
  ['T-12', 'REQ-ACT-13', 'Safe state on E-stop'],
];
let runN = 142;
function makeRun(plan: HilPlan, id: string, by: string, at: number, only?: string[]): HilRun {
  const rows = HIL_TESTS.filter(([tid]) => !only || only.includes(tid)).map(([tid, req, name]) => ({ id: tid, req, name, status: 'pending' as const, durMs: null }));
  return { id, planId: plan.id, status: 'running', pass: 0, fail: 0, left: rows.length, rows, log: [`##hil plan ${rows.length}`, 'bench: leg actuator PCBA rev A on leg CAN bus (simulated)'], startedBy: by, startedAt: at, finishedAt: null };
}
/** Advance a run by one step: finish the running row, start the next. Returns false when finished. */
function stepRun(r: HilRun): boolean {
  if (r.status !== 'running') return false;
  const cur = r.rows.findIndex((x) => x.status === 'run');
  if (cur >= 0) {
    const row = r.rows[cur];
    const fail = row.id === 'T-07';
    row.status = fail ? 'fail' : 'pass';
    row.durMs = 380 + Math.round(Math.random() * 900);
    r.log.push(fail ? `  ${row.id}: overshoot 7.9 % > 5 %` : `  ${row.id}: ok`, `##hil ${row.status} ${row.id} ${row.durMs}`);
  }
  const next = r.rows.findIndex((x) => x.status === 'pending');
  if (next >= 0) {
    r.rows[next].status = 'run';
    r.log.push(`##hil test ${r.rows[next].id} ${r.rows[next].req} ${r.rows[next].name}`, `  ${r.rows[next].id}: running ${r.rows[next].name}`);
  }
  r.pass = r.rows.filter((x) => x.status === 'pass').length;
  r.fail = r.rows.filter((x) => x.status === 'fail').length;
  r.left = r.rows.filter((x) => x.status === 'pending' || x.status === 'run').length;
  if (next < 0) { r.status = r.fail ? 'failed' : 'passed'; r.finishedAt = Date.now(); r.log.push('done'); }
  r.log = r.log.slice(-14);
  return r.status === 'running';
}

// HIL runs hold their plan's device locks, as in the hub: a device locked by someone else refuses the run;
// the run takes the free ones and gives back only those when it ends.
const runLocks = new Map<string, string[]>();
function takeLocks(ctx: V2Ctx, r: HilRun, plan: HilPlan): string | null {
  const devs = plan.devices.map((id) => ctx.state.devices.find((d) => d.id === id)).filter(Boolean) as Device[];
  const held = devs.find((d) => d.lock && d.lock.sessionId !== r.startedBy);
  if (held) return `${held.title} is locked by ${held.lock!.sessionId === 'you' ? 'you' : `session ${held.lock!.sessionId}`}`;
  const taken = devs.filter((d) => !d.lock);
  taken.forEach((d) => { d.lock = { sessionId: r.startedBy, since: Date.now() }; d.updatedAt = Date.now(); ctx.emit('device.upsert', clone(d)); });
  runLocks.set(r.id, taken.map((d) => d.id));
  return null;
}
function releaseLocks(ctx: V2Ctx, r: HilRun) {
  for (const id of runLocks.get(r.id) || []) {
    const d = ctx.state.devices.find((x) => x.id === id);
    if (d && d.lock?.sessionId === r.startedBy) { d.lock = null; d.updatedAt = Date.now(); ctx.emit('device.upsert', clone(d)); }
  }
  runLocks.delete(r.id);
}

// ---------------------------------------------------------------- command handling
export interface V2State {
  checkouts: Checkout[]; sessions: Session[];
  projects: Project[]; branches: Branch[]; machines: Machine[]; devices: Device[]; cnodes: CNode[]; todos: Todo[]; grants: Grant[];
  hil: { plans: HilPlan[]; runs: HilRun[] };
}
export interface V2Ctx {
  state: V2State;
  emit: (type: string, data: unknown) => void;
  createSession: (body: any) => Session;
  addMsg: (sid: string, role: 'user' | 'assistant' | 'tool' | 'system', kind: 'text' | 'tool' | 'command' | 'reasoning' | 'status', text: string, data?: unknown) => void;
  updSession: (id: string, patch: Partial<Session>) => void;
  streamReply: (sid: string, text: string) => Promise<void>;
}
const ok = (data: any = { ok: true }): ApiResponse => ({ ok: true, status: 200, data });
const err = (status: number, data: any): ApiResponse => ({ ok: false, status, data });
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
let cnN = 0;

function headFor(st: V2State, source: FileSource): string {
  if (source.kind === 'checkout') return st.checkouts.find((c) => c.id === source.checkoutId)?.head || '0000000';
  const b = st.branches.find((x) => x.id === `${source.projectId}#${source.ref}`);
  return b?.remoteSha || b?.head || '0000000';
}

let ctxRef: V2Ctx | null = null;
export function handleV2(method: string, rawPath: string, url: URL, body: any, ctx: V2Ctx): ApiResponse | null {
  ctxRef = ctx;
  let p = rawPath;
  try { p = decodeURIComponent(rawPath); } catch { /* keep raw */ }
  const st = ctx.state;
  const emit = ctx.emit;
  let m: RegExpMatchArray | null;
  const upsertCn = (c: CNode) => { c.updatedAt = Date.now(); emit('cnode.upsert', clone(c)); return c; };

  if (method === 'POST' && p === '/api/cnodes') {
    const id = `cn_${Date.now().toString(36)}${++cnN}`;
    let data = { ...(body.data || {}) };
    if (body.type === 'file') {
      const source = data.source as FileSource;
      data = { source, path: data.path, sha: headFor(st, source), kind: kindOf(data.path), newer: null };
    } else if (body.type === 'terminal') {
      data = { hostId: data.hostId, cwd: data.cwd || '~', mode: 'shell', sessionId: data.sessionId || null, status: 'open' };
    } else if (body.type === 'note') data = { title: data.title || 'Note', text: data.text || '' };
    else if (body.type === 'todos') data = { title: data.title || 'To-dos', scope: data.scope ?? null };
    const c: CNode = { id, type: body.type, parentId: body.parentId ?? null, data, createdBy: 'you', createdAt: Date.now(), updatedAt: Date.now() };
    st.cnodes.push(c);
    upsertCn(c);
    return ok(clone(c));
  }
  if ((m = p.match(/^\/api\/cnodes\/([^/]+)(\/latest)?$/))) {
    const c = st.cnodes.find((x) => x.id === m![1]);
    if (!c) return err(404, { error: 'no such node' });
    if (method === 'DELETE') { st.cnodes = st.cnodes.filter((x) => x.id !== c.id); emit('cnode.remove', { id: c.id }); return ok(); }
    if (m[2]) {
      if (c.data.newer) { c.data = { ...c.data, sha: c.data.newer.sha, newer: null }; upsertCn(c); }
      return ok(clone(c));
    }
    c.data = { ...c.data, ...(body?.data || {}) };
    upsertCn(c);
    return ok(clone(c));
  }

  if (method === 'POST' && p === '/api/todos') {
    const t: Todo = { id: `t_${Date.now().toString(36)}`, scope: body.scope ?? null, text: body.text, src: 'you', done: false, dispatchedSessionId: null, createdAt: Date.now() };
    st.todos.push(t); emit('todo.upsert', clone(t));
    return ok(clone(t));
  }
  if ((m = p.match(/^\/api\/todos\/([^/]+)(\/dispatch)?$/))) {
    const t = st.todos.find((x) => x.id === m![1]);
    if (!t) return err(404, { error: 'no such to-do' });
    if (method === 'DELETE') { st.todos = st.todos.filter((x) => x.id !== t.id); emit('todo.remove', { id: t.id }); return ok(); }
    if (m[2]) {
      const b = body.branchId ? st.branches.find((x) => x.id === body.branchId) : null;
      const s = ctx.createSession({ ...body, prompt: t.text, branch: b?.name });
      t.dispatchedSessionId = s.id; emit('todo.upsert', clone(t));
      return ok(s);
    }
    if (body.text != null) t.text = body.text;
    if (body.done != null) t.done = !!body.done;
    emit('todo.upsert', clone(t));
    return ok(clone(t));
  }

  if ((m = p.match(/^\/api\/suggestions\/([^/]+)\/(launch|dismiss)$/))) {
    const c = st.cnodes.find((x) => x.id === m![1] && x.type === 'suggest');
    if (!c) return err(404, { error: 'no such suggestion' });
    if (m[2] === 'dismiss') { c.data = { ...c.data, status: 'dismissed' }; upsertCn(c); return ok(); }
    const d = c.data;
    const b = d.branchId ? st.branches.find((x) => x.id === d.branchId) : null;
    const co = b?.checkouts?.[0] || st.checkouts.find((x) => x.host_id === (body.hostId || d.hostId))?.id;
    const s = ctx.createSession({ vendor: body.vendor || d.vendor, where: body.where || (d.hostId ? 'host' : 'cloud'), hostId: body.hostId || d.hostId, accountId: body.accountId || d.accountId, checkoutId: body.checkoutId || co, branch: b?.name, prompt: d.prompt });
    c.data = { ...d, status: 'launched', sessionId: s.id }; upsertCn(c);
    return ok(s);
  }

  if ((m = p.match(/^\/api\/reviews\/([^/]+)\/(decision|comments)$/))) {
    const c = st.cnodes.find((x) => x.id === m![1] && x.type === 'review');
    if (!c) return err(404, { error: 'no such review' });
    const sid = c.data.sessionId as string;
    if (m[2] === 'comments') {
      c.data = { ...c.data, comments: [...c.data.comments, { id: `c${Date.now()}`, author: 'you', text: body.text, at: Date.now() }] };
      upsertCn(c);
      ctx.addMsg(sid, 'user', 'text', `Review comment on ${c.data.path}: ${body.text}`);
      setTimeout(() => {
        const cur = st.cnodes.find((x) => x.id === c.id);
        if (!cur) return;
        cur.data = { ...cur.data, comments: [...cur.data.comments, { id: `c${Date.now()}`, author: 'agent', text: 'Good point — I will address it in the next revision.', at: Date.now() }] };
        upsertCn(cur);
      }, 1500);
      return ok();
    }
    const approve = body.decision === 'approve';
    c.data = { ...c.data, status: approve ? 'approved' : 'changes' };
    upsertCn(c);
    ctx.addMsg(sid, 'user', 'text', `${approve ? 'Approved' : 'Changes requested'}: ${c.data.path}${body.note ? ` — ${body.note}` : ''}`);
    ctx.updSession(sid, { status: 'running' });
    setTimeout(async () => {
      await ctx.streamReply(sid, approve ? `Thanks — promoting ${c.data.path}${c.data.promoteTo ? ` to ${c.data.promoteTo}` : ''}.` : 'Understood, revising and I will request another review.');
      ctx.updSession(sid, { status: 'idle' });
    }, 500);
    return ok();
  }

  if (method === 'GET' && p === '/api/files/list') {
    let source: FileSource;
    try { source = JSON.parse(url.searchParams.get('source') || ''); } catch { return err(400, { error: 'bad source' }); }
    const pid = source.kind === 'github' ? source.projectId : projectOfCheckout(source.checkoutId);
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const files = Object.keys(pid === WPT ? WPT_FILES : HEX_FILES).sort()
      .filter((f) => !q || fuzzy(f.toLowerCase(), q))
      .map((path) => ({ path, kind: kindOf(path) }));
    return ok({ files });
  }

  if (method === 'POST' && p === '/api/branches') {
    const co = st.checkouts.find((c) => c.id === body.checkoutId);
    const proj = st.projects.find((x) => x.id === body.projectId);
    if (!co || !proj) return err(400, { error: 'unknown project or checkout' });
    if (!/^[\w./-]+$/.test(body.name || '') || st.branches.some((b) => b.id === `${proj.id}#${body.name}`)) return err(409, { error: 'invalid or existing branch name' });
    const wt: Checkout = { ...clone(co), id: `co_wt_${Date.now().toString(36)}`, path: `${co.path}.worktrees/${String(body.name).replace(/\//g, '-')}`, branch: body.name, ahead: 0, behind: 0, dirty: 0, changes: [], apps: [], upstream: body.push ? `origin/${body.name}` : null, updated_at: new Date().toISOString() };
    st.checkouts.push(wt);
    emit('checkout.upsert', clone(wt));
    proj.checkouts = [...proj.checkouts, wt.id];
    emit('project.upsert', clone(proj));
    const b: Branch = {
      id: `${proj.id}#${body.name}`, projectId: proj.id, name: body.name, base: body.base, goal: body.goal || null, createdBy: 'hub', checkouts: [wt.id], head: co.head,
      pushed: !!body.push, remoteSha: body.push ? co.head : null, aheadRemote: 0, behindRemote: 0, aheadBase: 0, behindBase: 0, pr: null,
      ci: body.push ? { state: 'pending', total: 3, passed: 0, failed: 0, url: null } : null, commits: [{ sha: co.head, subject: co.head_subject, author: 'me', at: Date.now() }], apps: [], cloud: null, updatedAt: Date.now(),
    };
    st.branches.push(b);
    emit('branch.upsert', clone(b));
    if (body.push) setTimeout(() => { b.ci = { state: 'success', total: 3, passed: 3, failed: 0, url: null }; emit('branch.upsert', clone(b)); }, 4000);
    return ok(clone(b));
  }
  if ((m = p.match(/^\/api\/branches\/(.+)\/(refresh|files)$/))) {
    const id = m[1];
    const b = st.branches.find((x) => x.id === id);
    if (!b) return err(404, { error: 'no such branch' });
    if (m[2] === 'refresh') { b.updatedAt = Date.now(); emit('branch.upsert', clone(b)); return ok(clone(b)); }
    return ok({ files: Object.keys(b.projectId === WPT ? WPT_FILES : HEX_FILES).map((path) => ({ path, kind: kindOf(path) })) });
  }

  if ((m = p.match(/^\/api\/devices\/([^/]+)\/lock$/))) {
    const d = st.devices.find((x) => x.id === m![1]);
    if (!d) return err(404, { error: 'no such device' });
    // as in the hub: you can always reassign or release a lock from the hub (agents cannot)
    d.lock = body.sessionId ? { sessionId: body.sessionId, since: Date.now() } : null;
    d.updatedAt = Date.now();
    emit('device.upsert', clone(d));
    return ok(clone(d));
  }

  if (method === 'POST' && p === '/api/grants') {
    // a grant you create in the hub is active at once (agents' request_compute grants start as requested)
    const g: Grant = { id: `g_${Date.now().toString(36)}`, sessionId: body.sessionId, hostId: body.hostId, resources: body.resources, purpose: body.purpose, quotaGB: body.quotaGB ?? null, usedGB: 0, status: 'active', createdAt: Date.now() };
    st.grants.push(g); emit('grant.upsert', clone(g));
    return ok(clone(g));
  }
  if ((m = p.match(/^\/api\/grants\/([^/]+)$/))) {
    const g = st.grants.find((x) => x.id === m![1]);
    if (!g) return err(404, { error: 'no such grant' });
    g.status = body.status; emit('grant.upsert', clone(g));
    return ok(clone(g));
  }

  if ((m = p.match(/^\/api\/hil\/([^/]+)\/run$/)) && method === 'POST') {
    const plan = st.hil.plans.find((x) => x.id === m![1]);
    if (!plan) return err(404, { error: 'no such plan' });
    if (st.hil.runs.some((r) => r.planId === plan.id && r.status === 'running')) return err(409, { error: 'this plan is already running' });
    const r = makeRun(plan, `run_${++runN}`, 'you', Date.now());
    const lockErr = takeLocks(ctx, r, plan);
    if (lockErr) return err(409, { error: lockErr });
    stepRun(r);
    st.hil.runs.push(r); emit('hil.upsert', clone(r));
    return ok(clone(r));
  }
  if ((m = p.match(/^\/api\/hil\/runs\/([^/]+)\/(abort|rerun-failed)$/))) {
    const r = st.hil.runs.find((x) => x.id === m![1]);
    if (!r) return err(404, { error: 'no such run' });
    if (m[2] === 'abort') {
      if (r.status === 'running') {
        r.rows.forEach((x) => { if (x.status === 'run') x.status = 'skip'; });
        r.status = 'aborted'; r.finishedAt = Date.now(); r.log = [...r.log, 'aborted by user'].slice(-14);
        r.left = r.rows.filter((x) => x.status === 'pending').length;
        releaseLocks(ctx, r);
        emit('hil.upsert', clone(r));
      }
      return ok(clone(r));
    }
    const failed = r.rows.filter((x) => x.status === 'fail').map((x) => x.id);
    if (!failed.length) return err(409, { error: 'nothing failed' });
    const plan = st.hil.plans.find((x) => x.id === r.planId)!;
    if (st.hil.runs.some((x) => x.planId === plan.id && x.status === 'running')) return err(409, { error: 'this plan is already running' });
    const nr = makeRun(plan, `run_${++runN}`, 'you', Date.now(), failed);
    const lockErr = takeLocks(ctx, nr, plan);
    if (lockErr) return err(409, { error: lockErr });
    stepRun(nr);
    st.hil.runs.push(nr); emit('hil.upsert', clone(nr));
    return ok(clone(nr));
  }

  if ((m = p.match(/^\/api\/terminals\/([^/]+)$/)) && method === 'DELETE') {
    const c = st.cnodes.find((x) => x.id === m![1]);
    if (c) { c.data = { ...c.data, status: 'closed' }; upsertCn(c); }
    terms.get(m[1])?.sockets.forEach((s) => s.close());
    return ok();
  }
  return null;
}

function fuzzy(s: string, q: string) {
  if (s.includes(q)) return true;
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i >= q.length;
}

// ---------------------------------------------------------------- background
export function startV2Ticks(ctx: V2Ctx) {
  ctxRef = ctx;
  setInterval(() => {
    const st = ctx.state;
    st.machines.forEach((mc) => {
      if (!mc.cpu) return;
      mc.cpu = { ...mc.cpu, pct: Math.max(3, Math.min(99, Math.round(mc.cpu.pct + (Math.random() - 0.5) * 14))) };
      if (mc.mem) mc.mem = { ...mc.mem, usedMB: Math.max(4000, Math.min(mc.mem.totalMB, mc.mem.usedMB + Math.round((Math.random() - 0.5) * 800))) };
      mc.gpu = mc.gpu.map((g) => ({ ...g, utilPct: Math.max(0, Math.min(100, Math.round(g.utilPct + (Math.random() - 0.5) * 18))) }));
      mc.load = mc.load == null ? null : +(Math.max(0.1, mc.load + (Math.random() - 0.5) * 0.6)).toFixed(2);
      mc.updatedAt = Date.now();
      ctx.emit('machine.upsert', clone(mc));
    });
    const g = st.grants.find((x) => x.status === 'active' && x.quotaGB);
    if (g && g.usedGB != null && g.quotaGB) { g.usedGB = Math.min(g.quotaGB, +(g.usedGB + 0.1).toFixed(1)); ctx.emit('grant.upsert', clone(g)); }
  }, 2500);
  setInterval(() => {
    ctx.state.hil.runs.forEach((r) => {
      if (r.status !== 'running') return;
      if (!stepRun(r)) releaseLocks(ctx, r);
      ctx.emit('hil.upsert', clone(r));
    });
  }, 1600);
}

// ---------------------------------------------------------------- terminals (fake tmux shell)
const enc = new TextEncoder();
interface TermState { history: string; line: string; sockets: Set<FakeSock> }
const terms = new Map<string, TermState>();

class FakeSock implements TermSocket {
  binaryType: BinaryType = 'arraybuffer';
  readyState = 0;
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  constructor(private id: string, private t: TermState, private prompt: () => string) {
    setTimeout(() => {
      const c = ctxRef?.state.cnodes.find((x) => x.id === id);
      if (!c || c.data.status === 'closed') { this.readyState = 3; this.onclose?.(); return; }
      this.readyState = 1;
      t.sockets.add(this);
      this.onopen?.();
      if (!t.history) {
        const host = c.data.hostId;
        t.history = `\x1b[2m[tmux hub-term ${id} on ${host} · mock shell]\x1b[0m\r\n` + (c.data.sessionId ? `\x1b[2mshell in the worktree of session ${c.data.sessionId}\x1b[0m\r\n` : '') + prompt();
      }
      this.push(t.history);
    }, 120);
  }
  private push(s: string) { this.onmessage?.({ data: enc.encode(s).buffer }); }
  send(data: string) {
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type !== 'input') return;
    const t = this.t;
    let out = '';
    for (const ch of String(msg.data)) {
      if (ch === '\r') {
        out += '\r\n' + runCmd(this.id, t.line.trim()) + this.prompt();
        t.line = '';
      } else if (ch === '\x7f') {
        if (t.line) { t.line = t.line.slice(0, -1); out += '\b \b'; }
      } else if (ch === '\x03') { out += '^C\r\n' + this.prompt(); t.line = ''; }
      else if (ch >= ' ') { t.line += ch; out += ch; }
    }
    if (!out) return;
    t.history = (t.history + out).slice(-20000);
    t.sockets.forEach((s) => s.push(out));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.t.sockets.delete(this);
    setTimeout(() => this.onclose?.(), 0);
  }
}

function runCmd(id: string, cmd: string): string {
  const c = ctxRef?.state.cnodes.find((x) => x.id === id);
  const host = c?.data.hostId || 'host';
  const nl = (s: string) => s.replace(/\n/g, '\r\n') + (s ? '\r\n' : '');
  if (!cmd) return '';
  const [bin, ...args] = cmd.split(/\s+/);
  switch (bin) {
    case 'ls': return nl('README.md  SYS  HW  fw  sw  apps  AI  DOCS');
    case 'pwd': return nl(c?.data.cwd || '~');
    case 'whoami': return nl(host === 'mini-2' ? 'hostb' : 'hosta');
    case 'hostname': return nl(host);
    case 'uptime': return nl(' 10:42:07 up 12 days,  3:14,  1 user,  load average: 2.10, 1.94, 1.88');
    case 'git': return args[0] === 'status' ? nl('On branch feat/winch-console\nChanges not staged for commit:\n  modified:   apps/winch-console/ui.html') : nl(`git ${args.join(' ')}: ok (mock)`);
    case 'nvidia-smi': return host === 'mini-2' ? nl('| 0  RTX 4060   64%   5200MiB / 8188MiB |') : nl('NVIDIA-SMI has failed: no devices were found');
    case 'echo': return nl(args.join(' '));
    case 'clear': return '\x1b[2J\x1b[H';
    default: return nl(`${bin}: command not found (mock shell)`);
  }
}

export function makeTermSocket(id: string): TermSocket {
  let t = terms.get(id);
  if (!t) { t = { history: '', line: '', sockets: new Set() }; terms.set(id, t); }
  const prompt = () => {
    const c = ctxRef?.state.cnodes.find((x) => x.id === id);
    const host = c?.data.hostId || 'host';
    const user = host === 'mini-2' ? 'hostb' : 'hosta';
    return `\x1b[32m${user}@${host}\x1b[0m:\x1b[34m${c?.data.cwd || '~'}\x1b[0m$ `;
  };
  return new FakeSock(id, t, prompt);
}
