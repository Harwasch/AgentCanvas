#!/usr/bin/env node
// stub-codex: stands in for the `codex` CLI in tests (protocol per openai/codex @12cca49c).
//   codex app-server daemon start|stop|version   one JSON line on stdout
//   codex app-server --listen unix://            the daemon: WebSocket (HTTP upgrade, any path) over
//                                                $CODEX_HOME/app-server-control/app-server-control.sock,
//                                                one JSON-RPC message per text frame, no "jsonrpc" field
//   codex app-server proxy [--sock P]            pure byte relay stdio <-> socket
//   codex cloud exec|list|status|diff|apply      → stub-cloud.mjs
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { home, sleep, readJson, writeJson } from './common.mjs';

const argv = process.argv.slice(2);
const CODEX_HOME = process.env.CODEX_HOME || path.join(home, '.codex');
const SOCK = path.join(CODEX_HOME, 'app-server-control', 'app-server-control.sock');
const PIDFILE = path.join(CODEX_HOME, 'app-server-daemon', 'daemon.pid');
const VERSION = '0.130.0';
const USER_AGENT = `codex_cli_rs/${VERSION} (Linux; x86_64) stub`;

if (argv[0] === '--version') {
  console.log(`codex-cli ${VERSION} (stub)`);
  process.exit(0);
}
if (argv[0] === 'cloud' || argv[0] === 'cloud-tasks') {
  const { codexCloud } = await import('./stub-cloud.mjs');
  process.exit(await codexCloud(argv.slice(1)));
}
if (argv[0] !== 'app-server') {
  console.error('stub-codex: supported: app-server daemon start|stop, app-server --listen unix://, app-server proxy, cloud ...');
  process.exit(2);
}
if (!fs.existsSync(path.join(CODEX_HOME, '.stub-auth.json'))) {
  console.error(`Not signed in (CODEX_HOME=${CODEX_HOME}). Run codex login.`);
  process.exit(1);
}

const sub = argv[1];
if (sub === 'daemon') await daemonCmd(argv[2]);
else if (sub === 'proxy') await proxy();
else if (argv.includes('--listen')) await serve();
else {
  console.error('stub-codex: use --listen unix:// (stdio transport not stubbed)');
  process.exit(2);
}

// ----------------------------------------------------------------- daemon lifecycle
function probe(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SOCK)) return resolve(null);
    const ws = new WebSocket('ws://localhost/', { createConnection: () => net.connect(SOCK) });
    const t = setTimeout(() => {
      ws.terminate();
      resolve(null);
    }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_app_server_daemon', title: 'Codex App Server Daemon', version: VERSION }, capabilities: null } })));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.id === 1) {
        clearTimeout(t);
        ws.send(JSON.stringify({ method: 'initialized' }));
        ws.close();
        resolve(m.result);
      }
    });
    ws.on('error', () => {
      clearTimeout(t);
      resolve(null);
    });
  });
}
async function daemonCmd(cmd) {
  const base = { managedCodexPath: process.argv[1], managedCodexVersion: VERSION, socketPath: SOCK, cliVersion: VERSION, appServerVersion: VERSION };
  if (cmd === 'start' || cmd === 'bootstrap') {
    const r = await probe();
    if (r) {
      console.log(JSON.stringify({ status: 'alreadyRunning', backend: 'pid', pid: Number(readJson(PIDFILE, 0)) || undefined, ...base }));
      return;
    }
    const child = spawn(process.execPath, ['--no-warnings', process.argv[1], 'app-server', '--listen', 'unix://', '--analytics-default-enabled'], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if (await probe(500)) {
        console.log(JSON.stringify({ status: 'started', backend: 'pid', pid: child.pid, ...base }));
        return;
      }
    }
    console.error('daemon failed to become ready');
    process.exit(1);
  } else if (cmd === 'stop') {
    const pid = Number(readJson(PIDFILE, 0));
    try {
      process.kill(pid);
      console.log(JSON.stringify({ status: 'stopped', backend: 'pid', pid, ...base }));
    } catch {
      console.log(JSON.stringify({ status: 'notRunning', ...base }));
    }
  } else if (cmd === 'version') console.log(JSON.stringify({ status: (await probe()) ? 'running' : 'notRunning', ...base }));
  else {
    console.error('unknown daemon command');
    process.exit(2);
  }
}

// ----------------------------------------------------------------- proxy (byte relay)
async function proxy() {
  const i = argv.indexOf('--sock');
  const p = i > 0 ? argv[i + 1] : SOCK;
  const s = net.connect(p);
  s.on('error', (e) => {
    console.error(`proxy: ${e.message}`);
    process.exit(1);
  });
  process.stdin.pipe(s);
  s.pipe(process.stdout);
  s.on('close', () => process.exit(0));
}

// ----------------------------------------------------------------- the daemon
async function serve() {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  try {
    fs.unlinkSync(SOCK);
  } catch {}
  writeJson(PIDFILE, process.pid);
  const STORE = path.join(CODEX_HOME, 'stub-threads.json');
  const stored = readJson(STORE, {}); // id -> thread (with turns)
  const loaded = new Map(); // id -> {thread, subs:Set, active, pending:Map}
  const conns = new Set();
  let reqCounter = 0;
  const now = () => Math.floor(Date.now() / 1000);
  const uuid7 = () => {
    const ms = Date.now().toString(16).padStart(12, '0');
    const r = crypto.randomBytes(10).toString('hex');
    return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${r.slice(0, 3)}-${(8 + (parseInt(r[3], 16) & 3)).toString(16)}${r.slice(4, 7)}-${r.slice(7, 19)}`;
  };
  const save = () => {
    for (const [id, l] of loaded) stored[id] = l.thread;
    writeJson(STORE, stored);
  };
  const strip = (t, withTurns) => ({ ...t, turns: withTurns ? t.turns : [] });

  const send = (c, m) => c.readyState === WebSocket.OPEN && c.send(JSON.stringify(m));
  const notifyAll = (method, params) => conns.forEach((c) => c.init && send(c, { method, params, emittedAtMs: Date.now() }));
  const notifySubs = (l, method, params) => l.subs.forEach((c) => send(c, { method, params, emittedAtMs: Date.now() }));
  const setStatus = (l, status) => {
    l.thread.status = status;
    notifyAll('thread/status/changed', { threadId: l.thread.id, status });
  };

  function newThread(params) {
    const id = uuid7();
    const t = {
      id, sessionId: id, forkedFromId: null, parentThreadId: null, preview: '', ephemeral: !!params.ephemeral, section: null, sectionEnteredAt: null,
      projectId: null, historyMode: 'paginated', modelProvider: 'openai', model: params.model || 'gpt-5.1-codex', reasoningEffort: 'medium',
      createdAt: now(), updatedAt: now(), recencyAt: null, status: { type: 'idle' }, path: null, cwd: params.cwd || home, cliVersion: VERSION,
      originator: 'codex_cli_rs', source: 'vscode', threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [],
    };
    const l = { thread: t, subs: new Set(), active: null, pending: new Map() };
    loaded.set(id, l);
    return l;
  }
  function load(id) {
    if (loaded.has(id)) return loaded.get(id);
    const t = stored[id];
    if (!t) return null;
    const l = { thread: { ...t, status: { type: 'idle' } }, subs: new Set(), active: null, pending: new Map() };
    loaded.set(id, l);
    return l;
  }
  const threadResponse = (l, withTurns) => ({
    thread: strip(l.thread, withTurns), model: l.thread.model, modelProvider: 'openai', serviceTier: null, disabledPluginIds: [], cwd: l.thread.cwd,
    instructionSources: [], approvalPolicy: 'on-request', approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: l.thread.reasoningEffort,
  });

  class RpcErr extends Error {
    constructor(code, msg) {
      super(msg);
      this.code = code;
    }
  }

  async function handle(c, m) {
    if (m.method && m.id != null) {
      try {
        if (m.method !== 'initialize' && !c.init) throw new RpcErr(-32600, 'Not initialized');
        const result = await request(c, m.method, m.params || {}, m.id);
        if (result !== undefined) send(c, { id: m.id, result });
      } catch (e) {
        send(c, { id: m.id, error: { code: e.code || -32603, message: e.message } });
      }
    } else if (m.id != null && ('result' in m || 'error' in m)) {
      // response to one of our server requests; first answer wins
      for (const l of loaded.values()) {
        const p = l.pending.get(m.id);
        if (p) {
          l.pending.delete(m.id);
          p.resolve(m.error ? { error: m.error } : m.result);
          notifySubs(l, 'serverRequest/resolved', { threadId: l.thread.id, requestId: m.id });
          return;
        }
      }
    }
  }

  async function request(c, method, p, id) {
    switch (method) {
      case 'initialize':
        if (c.init) throw new RpcErr(-32600, 'Already initialized');
        c.init = true;
        c.clientInfo = p.clientInfo;
        return { userAgent: `${p.clientInfo?.name || 'client'}/${VERSION} (Linux; x86_64) stub`, codexHome: CODEX_HOME, platformFamily: 'unix', platformOs: 'linux' };
      case 'thread/start': {
        const l = newThread(p);
        l.subs.add(c);
        save();
        setImmediate(() => notifyAll('thread/started', { thread: strip(l.thread) }));
        return threadResponse(l, false);
      }
      case 'thread/resume': {
        const l = load(p.threadId);
        if (!l) throw new RpcErr(-32600, `thread not found: ${p.threadId}`);
        l.subs.add(c);
        setImmediate(() => {
          for (const [rid, pr] of l.pending) send(c, { id: rid, method: pr.method, params: pr.params });
        });
        return { ...threadResponse(l, !p.excludeTurns), collaborationMode: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
      }
      case 'thread/read': {
        const t = loaded.get(p.threadId)?.thread || stored[p.threadId];
        if (!t) throw new RpcErr(-32600, `thread not found: ${p.threadId}`);
        return { thread: strip(t, !!p.includeTurns) };
      }
      case 'thread/list': {
        const kinds = p.sourceKinds?.length ? p.sourceKinds : ['cli', 'vscode'];
        const all = { ...stored };
        for (const [k, l] of loaded) all[k] = l.thread;
        let list = Object.values(all).filter((t) => kinds.includes(typeof t.source === 'string' ? t.source : 'unknown'));
        if (p.cwd) list = list.filter((t) => [].concat(p.cwd).includes(t.cwd));
        const key = p.sortKey === 'updated_at' ? 'updatedAt' : 'createdAt';
        list.sort((a, b) => (p.sortDirection === 'asc' ? a[key] - b[key] : b[key] - a[key]));
        const off = p.cursor ? Number(Buffer.from(p.cursor, 'base64url').toString()) : 0;
        const lim = Math.min(p.limit || 25, 100);
        const page = list.slice(off, off + lim).map((t) => ({ ...strip(t), status: loaded.has(t.id) ? loaded.get(t.id).thread.status : { type: 'notLoaded' } }));
        return { data: page, nextCursor: off + lim < list.length ? Buffer.from(String(off + lim)).toString('base64url') : null, backwardsCursor: null };
      }
      case 'thread/loaded/list':
        return { data: [...loaded.keys()], nextCursor: null };
      case 'thread/unsubscribe': {
        const l = loaded.get(p.threadId);
        if (!l) return { status: 'notLoaded' };
        return { status: l.subs.delete(c) ? 'unsubscribed' : 'notSubscribed' };
      }
      case 'turn/start': {
        const l = loaded.get(p.threadId);
        if (!l) throw new RpcErr(-32600, `thread not found: ${p.threadId}`);
        if (p.model) l.thread.model = p.model;
        if (p.effort) l.thread.reasoningEffort = p.effort;
        if (l.active) {
          l.active.steer.push(p.input);
          return { turn: turnView(l.active.turn) };
        }
        const turn = { id: uuid7(), rootTurnId: null, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null };
        turn.rootTurnId = turn.id;
        l.active = { turn, steer: [], abort: new AbortController(), onAborted: [] };
        setImmediate(() => runTurn(l, p.input || []));
        return { turn: turnView(turn) };
      }
      case 'turn/steer': {
        const l = loaded.get(p.threadId);
        if (!p.expectedTurnId) throw new RpcErr(-32600, 'expectedTurnId must not be empty');
        if (!l?.active) throw new RpcErr(-32600, 'no active turn to steer');
        if (l.active.turn.id !== p.expectedTurnId) throw new RpcErr(-32600, `expected active turn id \`${p.expectedTurnId}\` but found \`${l.active.turn.id}\``);
        l.active.steer.push(p.input);
        return { turnId: l.active.turn.id };
      }
      case 'turn/interrupt': {
        const l = loaded.get(p.threadId);
        if (!l?.active) throw new RpcErr(-32600, 'no active turn to interrupt');
        if (l.active.turn.id !== p.turnId) throw new RpcErr(-32600, `expected active turn id ${p.turnId} but found ${l.active.turn.id}`);
        // response deferred until the turn actually aborts
        l.active.onAborted.push(() => send(c, { id, result: {} }));
        l.active.abort.abort();
        return undefined;
      }
      default:
        throw new RpcErr(-32600, `Invalid request: unknown variant \`${method}\``);
    }
  }

  const turnView = (t) => ({ ...t, items: [] });
  const textOf = (input) => (input || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');

  async function runTurn(l, input) {
    const { turn, abort } = l.active;
    const T = l.thread.id;
    const U = turn.id;
    const sig = abort.signal;
    turn.startedAt = now();
    const t0 = Date.now();
    setStatus(l, { type: 'active', activeFlags: [] });
    notifySubs(l, 'turn/started', { threadId: T, turn: turnView(turn) });
    const emitItem = (item) => {
      notifySubs(l, 'item/started', { item, threadId: T, turnId: U, startedAtMs: Date.now() });
    };
    const doneItem = (item) => {
      turn.items.push(item);
      notifySubs(l, 'item/completed', { item, threadId: T, turnId: U, completedAtMs: Date.now() });
    };
    const um = { type: 'userMessage', id: uuid7(), clientId: null, content: input };
    emitItem(um);
    doneItem(um);
    const text = textOf(input);
    if (!l.thread.preview) l.thread.preview = text.slice(0, 120);
    const low = text.toLowerCase();
    let status = 'completed';
    let finalText = '';
    const wait = async (ms) => {
      await sleep(ms);
      return sig.aborted;
    };
    try {
      const r = { type: 'reasoning', id: uuid7(), summary: [], content: [] };
      emitItem(r);
      if (await wait(300)) throw 'abort';
      notifySubs(l, 'item/reasoning/summaryTextDelta', { threadId: T, turnId: U, itemId: r.id, delta: '**Planning**', summaryIndex: 0 });
      r.summary = ['**Planning**'];
      doneItem(r);

      if (/\b(run|test|install|command|build)\b/.test(low)) {
        const cmd = /install/.test(low) ? 'npm install' : 'npm test';
        const ce = { type: 'commandExecution', id: 'call_' + crypto.randomBytes(6).toString('hex'), pluginId: null, scriptPath: null, command: cmd, cwd: l.thread.cwd, processId: null, source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command: cmd }], aggregatedOutput: null, exitCode: null, durationMs: null };
        emitItem(ce);
        setStatus(l, { type: 'active', activeFlags: ['waitingOnApproval'] });
        const rid = reqCounter++;
        const params = { kind: 'command', threadId: T, turnId: U, itemId: ce.id, startedAtMs: Date.now(), approvalId: null, environmentId: null, reason: 'command requires approval', command: cmd, cwd: l.thread.cwd, commandActions: ce.commandActions, proposedExecpolicyAmendment: cmd.split(' ') };
        const answer = await new Promise((resolve) => {
          l.pending.set(rid, { method: 'item/commandExecution/requestApproval', params, resolve });
          l.subs.forEach((c) => send(c, { id: rid, method: 'item/commandExecution/requestApproval', params }));
          sig.addEventListener('abort', () => {
            if (l.pending.delete(rid)) {
              notifySubs(l, 'serverRequest/resolved', { threadId: T, requestId: rid });
              resolve({ decision: 'cancel' });
            }
          });
        });
        setStatus(l, { type: 'active', activeFlags: [] });
        const d = answer?.decision;
        if (d === 'accept' || d === 'acceptForSession' || (d && typeof d === 'object' && d.acceptWithExecpolicyAmendment)) {
          const out = 'PASS src/winch.test.ts\nPASS src/can.test.ts\n2 passed\n';
          notifySubs(l, 'item/commandExecution/outputDelta', { threadId: T, turnId: U, itemId: ce.id, delta: out });
          if (await wait(500)) throw 'abort';
          doneItem({ ...ce, status: 'completed', aggregatedOutput: out, exitCode: 0, durationMs: 500 });
          finalText = `Ran \`${cmd}\`: 2 passed.`;
        } else if (d === 'cancel') {
          doneItem({ ...ce, status: 'declined' });
          throw 'abort';
        } else {
          doneItem({ ...ce, status: answer?.error ? 'failed' : 'declined' });
          finalText = `The command \`${cmd}\` was declined, so I did not run it.`;
        }
      }
      const slow = /\b(slow|long|essay)\b/.test(low);
      const msg = { type: 'agentMessage', id: uuid7(), text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
      emitItem(msg);
      const words = (slow ? Array.from({ length: 20 }, (_, i) => `Step ${i + 1} of 20 done.`).join(' ') : finalText || `(stub ${l.thread.model}) Got it: "${text.slice(0, 160)}".`).split(' ');
      for (const w of words) {
        if (await wait(slow ? 600 : 25)) throw 'abort';
        const delta = (msg.text ? ' ' : '') + w;
        msg.text += delta;
        notifySubs(l, 'item/agentMessage/delta', { threadId: T, turnId: U, itemId: msg.id, delta });
        for (const s of l.active.steer.splice(0)) {
          const steerItem = { type: 'userMessage', id: uuid7(), clientId: null, content: s };
          emitItem(steerItem);
          doneItem(steerItem);
          msg.text += ` [steered: ${textOf(s)}]`;
        }
      }
      doneItem({ ...msg, phase: 'final_answer' });
    } catch (e) {
      if (e !== 'abort') throw e;
      status = 'interrupted';
    }
    turn.status = status;
    turn.completedAt = now();
    turn.durationMs = Date.now() - t0;
    l.thread.updatedAt = now();
    l.thread.turns.push({ ...turn, itemsView: 'full' });
    const last = turn.items.filter((i) => i.type === 'agentMessage').slice(-1);
    const aborted = l.active.onAborted;
    l.active = null;
    aborted.forEach((f) => f());
    notifySubs(l, 'turn/completed', { threadId: T, turn: { ...turn, items: status === 'completed' ? last : [], itemsView: status === 'completed' ? 'summary' : 'notLoaded' } });
    setStatus(l, { type: 'idle' });
    save();
  }

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url === '/daemon/shutdown') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\nunmanaged server');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      conns.add(ws);
      ws.on('message', (d, isBinary) => {
        if (isBinary) return;
        let m;
        try {
          m = JSON.parse(String(d));
        } catch {
          return; // dropped; connection stays open
        }
        handle(ws, m);
      });
      ws.on('close', () => {
        conns.delete(ws);
        for (const l of loaded.values()) l.subs.delete(ws);
      });
    });
  });
  const old = process.umask(0o177);
  httpServer.listen(SOCK, () => process.umask(old));
  process.on('SIGTERM', () => {
    save();
    try {
      fs.unlinkSync(SOCK);
    } catch {}
    process.exit(0);
  });
}
