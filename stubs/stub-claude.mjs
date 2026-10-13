#!/usr/bin/env node
// stub-claude: stands in for the `claude` CLI in tests.
//  Interactive (in tmux):  claude --remote-control <name> --session-id <uuid> --settings f --mcp-config f
//                                 --dangerously-load-development-channels server:hub
//    - loads MCP servers from --mcp-config; a server named in the dev-channels flag that declares
//      experimental['claude/channel'] (and did not negotiate 2026-07-28) is registered as a channel
//    - channel messages become user turns; tool approvals relay via claude/channel/permission
//    - fires HTTP hooks: UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop
//    - writes the JSONL transcript under $CLAUDE_CONFIG_DIR/projects/<slug>/<session-id>.jsonl
//    - Escape interrupts the running turn; /model and /effort work
//  Cloud: --cloud / -p --cloud <id>  → stub-cloud.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { home, expand, sleep, b62, uuid, readJson, fireHooks, slug, STUB_LIB } from './common.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--cloud') || argv.includes('--remote')) {
  const { claudeCloud } = await import('./stub-cloud.mjs');
  await claudeCloud(argv);
  process.exit(0);
}
if (argv[0] === '--version' || argv[0] === '-v') {
  console.log('2.1.296 (stub)');
  process.exit(0);
}

// ------------------------------------------------------------------ args
const opt = { channels: [], mcpConfigs: [], settings: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  const optionalValue = () => (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : undefined);
  if (a === '--remote-control' || a === '--rc') opt.rc = optionalValue() ?? '';
  else if (a === '--session-id') opt.sessionId = next();
  else if (a === '--resume' || a === '-r') opt.resume = next();
  else if (a === '--settings') opt.settings.push(next());
  else if (a === '--mcp-config') opt.mcpConfigs.push(next());
  else if (a === '--dangerously-load-development-channels') while (argv[i + 1] && !argv[i + 1].startsWith('-')) opt.channels.push(next());
  else if (a === '--model') opt.model = next();
  else if (a === '--strict-mcp-config') opt.strict = true;
}

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const cwd = process.cwd();
const sessionId = opt.resume || opt.sessionId || uuid();
const transcript = path.join(configDir, 'projects', slug(cwd), `${sessionId}.jsonl`);
let model = opt.model || 'claude-opus-5-5';
let effort = 'medium';
const permissionMode = 'default';
const out = (s = '') => process.stdout.write(s.replace(/\n/g, '\r\n') + '\r\n');

if (!fs.existsSync(path.join(configDir, '.stub-auth.json'))) {
  out(`Not logged in · run /login (CLAUDE_CONFIG_DIR=${configDir})`);
  process.exit(1);
}

// settings levels: user, project, local, --settings (hooks merge)
const settingsList = [
  readJson(path.join(configDir, 'settings.json'), {}),
  readJson(path.join(cwd, '.claude', 'settings.json'), {}),
  readJson(path.join(cwd, '.claude', 'settings.local.json'), {}),
  ...opt.settings.map((f) => readJson(expand(f), {})),
];
const hookBase = () => ({ session_id: sessionId, transcript_path: transcript, cwd, permission_mode: permissionMode });

// ------------------------------------------------------------------ transcript
let lastUuid = null;
fs.mkdirSync(path.dirname(transcript), { recursive: true });
if (fs.existsSync(transcript)) {
  const lines = fs.readFileSync(transcript, 'utf8').trim().split('\n');
  try {
    lastUuid = JSON.parse(lines[lines.length - 1]).uuid;
  } catch {}
}
function tline(type, message, extra = {}) {
  const u = uuid();
  const rec = { type, uuid: u, parentUuid: lastUuid, isSidechain: false, sessionId, timestamp: new Date().toISOString(), cwd, version: '2.1.296', gitBranch: '', userType: 'external', entrypoint: 'cli', message, ...extra };
  lastUuid = u;
  fs.appendFileSync(transcript, JSON.stringify(rec) + '\n');
  return u;
}
const msgId = () => 'msg_' + b62(24);

// ------------------------------------------------------------------ TTY input
const stdin = process.stdin;
if (stdin.isTTY) stdin.setRawMode(true);
stdin.resume();
let lineBuf = '';
let keyWaiter = null; // when set, the next submitted line / key goes here
const queue = [];
let busy = false;
let abort = null; // AbortController of running turn

stdin.on('data', (buf) => {
  for (const ch of buf.toString('utf8')) {
    if (ch === '\x1b') {
      if (abort) abort.abort();
      continue;
    }
    if (ch === '\x03') {
      out('\n(exiting)');
      shutdown();
      return;
    }
    if (ch === '\x7f' || ch === '\b') {
      lineBuf = lineBuf.slice(0, -1);
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const line = lineBuf;
      lineBuf = '';
      if (keyWaiter) {
        const w = keyWaiter;
        keyWaiter = null;
        w(line);
      } else if (line.trim()) submit(line, 'tty');
      continue;
    }
    lineBuf += ch;
    if (!stdin.isTTY) continue;
  }
});
const waitLine = () => new Promise((r) => (keyWaiter = r));

// ------------------------------------------------------------------ MCP client
const mcp = new Map(); // name -> {proc, pending, nextId, tools, channel}
function mcpServersFromConfigs() {
  const servers = {};
  for (const f of opt.mcpConfigs) Object.assign(servers, readJson(expand(f), {}).mcpServers || {});
  if (!opt.strict) Object.assign(servers, readJson(path.join(cwd, '.mcp.json'), {}).mcpServers || {});
  return servers;
}
async function startMcp(name, spec) {
  const proc = spawn(expand(spec.command), (spec.args || []).map(expand), { env: { ...process.env, ...(spec.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], cwd });
  const s = { proc, pending: new Map(), nextId: 1, tools: [], channel: false, name };
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id != null && s.pending.has(m.id)) {
        s.pending.get(m.id)(m);
        s.pending.delete(m.id);
      } else if (m.method) onMcpNotification(s, m);
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('exit', () => mcp.delete(name));
  s.send = (m) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  s.request = (method, params) =>
    new Promise((resolve) => {
      const id = s.nextId++;
      s.pending.set(id, resolve);
      s.send({ id, method, params });
    });
  mcp.set(name, s);
  // Claude Code on the v2 runtime asks for 2026-07-28; a server that negotiates it is not a channel.
  const init = await s.request('initialize', { protocolVersion: '2026-07-28', capabilities: { roots: {}, elicitation: {} }, clientInfo: { name: 'claude-code', version: '2.1.296' } });
  const r = init.result || {};
  s.send({ method: 'notifications/initialized' });
  const named = opt.channels.includes(`server:${name}`);
  s.channel = named && !!r.capabilities?.experimental?.['claude/channel'] && r.protocolVersion !== '2026-07-28';
  s.permissionRelay = s.channel && !!r.capabilities?.experimental?.['claude/channel/permission'];
  if (named && !s.channel) out(`⚠ server:${name} did not register as a channel`);
  const tl = await s.request('tools/list', {});
  s.tools = tl.result?.tools || [];
}
function onMcpNotification(s, m) {
  if (m.method === 'notifications/claude/channel' && s.channel) {
    const p = m.params || {};
    const meta = Object.entries(p.meta || {}).filter(([k]) => /^[A-Za-z0-9_]+$/.test(k)).map(([k, v]) => ` ${k}="${v}"`).join('');
    const content = `<channel source="${s.name}"${meta}>\n${p.content}\n</channel>`;
    out(`← ${s.name}: ${String(p.content).slice(0, 80)}`);
    submit(content, 'channel');
  } else if (m.method === 'notifications/claude/channel/permission' && s.permissionRelay) {
    const p = m.params || {};
    const w = permissionWaiters.get(String(p.request_id || '').toLowerCase());
    if (w) w(p.behavior === 'allow' ? 'allow' : 'deny', `channel:${s.name}`);
  }
}
const permissionWaiters = new Map();

// ------------------------------------------------------------------ tools
async function useTool(name, input, signal, needsPermission, description) {
  const toolUseId = 'toolu_' + b62(24);
  tline('assistant', { id: msgId(), type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: toolUseId, name, input }], stop_reason: 'tool_use' });
  const pre = await fireHooks(settingsList, 'PreToolUse', { ...hookBase(), tool_name: name, tool_input: input, tool_use_id: toolUseId }, name);
  let decision = pre.map((o) => o?.hookSpecificOutput?.permissionDecision).find(Boolean);
  if (decision === 'deny') return toolResult(toolUseId, name, input, 'Denied by PreToolUse hook', true);
  if (needsPermission && decision !== 'allow') {
    const verdict = await askPermission(name, input, description, signal);
    if (verdict !== 'allow') return toolResult(toolUseId, name, input, `Permission to use ${name} was denied`, true);
  }
  if (signal.aborted) return null;
  let result;
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    const s = mcp.get(server);
    const r = s ? await s.request('tools/call', { name: tool, arguments: input }) : { error: { message: 'server not connected' } };
    result = r.error ? { text: r.error.message, isError: true } : { text: (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!r.result?.isError };
  } else if (name === 'Write') {
    fs.mkdirSync(path.dirname(input.file_path), { recursive: true });
    fs.writeFileSync(input.file_path, input.content);
    result = { text: `File created successfully at: ${input.file_path}`, response: { filePath: input.file_path, type: 'create' } };
  } else if (name === 'Bash') {
    await sleep(800);
    result = { text: `$ ${input.command}\n12 passed, 0 failed (stub)` };
  } else result = { text: 'ok' };
  return toolResult(toolUseId, name, input, result.text, result.isError, result.response);
}
async function toolResult(toolUseId, name, input, text, isError = false, response) {
  tline('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) }] }, { toolUseResult: response || { stdout: text } });
  await fireHooks(settingsList, isError ? 'PostToolUseFailure' : 'PostToolUse', { ...hookBase(), tool_name: name, tool_input: input, tool_response: response || { stdout: text }, tool_use_id: toolUseId }, name);
  out(`  ⎿ ${text.split('\n')[0].slice(0, 100)}`);
  return { text, isError };
}

async function askPermission(name, input, description, signal) {
  // PermissionRequest hooks first; a decision there skips the dialog
  const hr = await fireHooks(settingsList, 'PermissionRequest', { ...hookBase(), tool_name: name, tool_input: input, permission_suggestions: [] }, name);
  const d = hr.map((o) => o?.hookSpecificOutput?.decision?.behavior).find(Boolean);
  if (d) {
    out(`  (permission ${d} by hook)`);
    return d;
  }
  // dialog: terminal + channel relay, first answer wins
  const requestId = Array.from({ length: 5 }, () => 'abcdefghijkmnopqrstuvwxyz'[Math.floor(Math.random() * 25)]).join('');
  out(`╭ Allow ${name}? ${description}\n│ ${JSON.stringify(input).slice(0, 120)}\n╰ 1. Yes   2. No  (y/n)`);
  for (const s of mcp.values())
    if (s.permissionRelay)
      s.send({ method: 'notifications/claude/channel/permission_request', params: { request_id: requestId, tool_name: name, description, input_preview: JSON.stringify(input) } });
  return new Promise((resolve) => {
    const done = (v, by) => {
      permissionWaiters.delete(requestId);
      if (keyWaiter === kw) keyWaiter = null;
      out(`  → ${v} (${by})`);
      resolve(v);
    };
    permissionWaiters.set(requestId, done);
    const kw = (line) => done(/^(y|yes|1)$/i.test(line.trim()) ? 'allow' : 'deny', 'terminal');
    keyWaiter = kw;
    signal.addEventListener('abort', () => done('deny', 'interrupted'));
  });
}

// ------------------------------------------------------------------ turns
function submit(text, source) {
  queue.push({ text, source });
  pump();
}
async function pump() {
  if (busy) return;
  const next = queue.shift();
  if (!next) return;
  busy = true;
  abort = new AbortController();
  try {
    await turn(next.text, abort.signal);
  } catch (e) {
    out(`error: ${e.message}`);
  }
  abort = null;
  busy = false;
  out('');
  out('❯ ');
  pump();
}

async function say(text, signal) {
  if (signal.aborted) return false;
  tline('assistant', { id: msgId(), type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn' });
  out(`⏺ ${text}`);
  return true;
}

async function turn(text, signal) {
  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.trim().split(/\s+/);
    if (cmd === '/model') {
      model = rest[0] || model;
      out(`Set model to ${model}`);
    } else if (cmd === '/effort') {
      effort = rest[0] || effort;
      out(`Set effort level to ${effort}`);
    } else if (cmd === '/exit') shutdown();
    else out(`Unknown command ${cmd}`);
    tline('system', undefined, { subtype: 'local_command', content: `${cmd} ${rest.join(' ')}`.trim(), message: undefined });
    return;
  }
  out(`> ${text.split('\n').join(' ').slice(0, 120)}`);
  const ups = await fireHooks(settingsList, 'UserPromptSubmit', { ...hookBase(), prompt: text });
  if (ups.some((o) => o?.decision === 'block')) {
    out('  (prompt blocked by hook)');
    return;
  }
  tline('user', { role: 'user', content: text }, { origin: { kind: 'human' } });
  const body = text.replace(/<\/?channel[^>]*>/g, '').trim();
  const low = body.toLowerCase();
  await sleep(400);
  let last = '';
  const interrupted = async () => {
    tline('user', { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] });
    out('  ⎿ Interrupted · What should Claude do instead?');
  };

  if (/winch/.test(low) && /(build|app|console)/.test(low)) {
    await say(`I'll build the simulated winch console as an MCP App under apps/winch-console/ and publish it to the hub.`, signal);
    const src = path.join(STUB_LIB, 'demo-apps', 'winch-console');
    for (const f of fs.readdirSync(src)) {
      if (signal.aborted) return interrupted();
      await useTool('Write', { file_path: path.join(cwd, 'apps', 'winch-console', f), content: fs.readFileSync(path.join(src, f), 'utf8') }, signal, false);
    }
    const r = await useTool('mcp__hub__publish_app', { path: 'apps/winch-console' }, signal, false);
    last = r && !r.isError ? `Published the winch console. ${r.text.split('\n')[0]}` : `publish_app failed: ${r?.text}`;
    await say(last, signal);
  } else if (/\b(run|test|bash|command|flash)\b/.test(low)) {
    await say('Running the test suite.', signal);
    const r = await useTool('Bash', { command: 'make test', description: 'Run the test suite' }, signal, true, 'Run the test suite');
    if (signal.aborted || !r) return interrupted();
    last = r.isError ? 'The command was not approved, so I did not run it.' : 'Tests pass: 12 passed, 0 failed.';
    await say(last, signal);
  } else if (/\b(slow|long|essay|think)\b/.test(low)) {
    for (let i = 1; i <= 15; i++) {
      await sleep(1000);
      if (signal.aborted) return interrupted();
      await say(`Working through step ${i} of 15…`, signal);
    }
    last = 'Finished the long task.';
    await say(last, signal);
  } else {
    last = `(stub ${model}, effort ${effort}) You said: "${body.slice(0, 200)}". On it.`;
    await say(last, signal);
  }
  if (signal.aborted) return interrupted();
  await fireHooks(settingsList, 'Stop', { ...hookBase(), stop_hook_active: false, last_assistant_message: last });
}

// ------------------------------------------------------------------ startup
async function confirmOnce(marker, text) {
  if (fs.existsSync(path.join(configDir, marker))) return;
  out(text);
  const ans = await waitLine();
  if (/^(2|n|no|exit)$/i.test(ans.trim())) {
    out('Exiting.');
    process.exit(0);
  }
  fs.writeFileSync(path.join(configDir, marker), new Date().toISOString());
}

function shutdown() {
  for (const s of mcp.values()) s.proc.kill();
  if (stdin.isTTY) stdin.setRawMode(false);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

if (opt.channels.length)
  await confirmOnce('.stub-devchannels-accepted', 'WARNING: Loading development channels\n\n--dangerously-load-development-channels is for local channel development only.\nChannel servers can inject messages that Claude acts on.\n\n❯ 1. I am using this for local development\n  2. Exit\n\nEnter to confirm');
if (opt.rc !== undefined) await confirmOnce('.stub-rc-enabled', 'Enable Remote Control? (y/n)');

out(`✻ Claude Code 2.1.296 (stub)   model ${model}   ${cwd}`);
for (const [name, spec] of Object.entries(mcpServersFromConfigs())) {
  try {
    await startMcp(name, spec);
  } catch (e) {
    out(`MCP ${name} failed: ${e.message}`);
  }
}
for (const s of mcp.values())
  if (s.channel) out(`Channels (experimental) messages from server:${s.name} inject directly in this session · restart without --dangerously-load-development-channels to stop`);
if (opt.rc !== undefined) {
  const rcId = 'session_01' + Buffer.from(sessionId.replace(/-/g, ''), 'hex').toString('base64url').replace(/[-_]/g, 'x').slice(0, 22);
  out(`Remote Control active · ${opt.rc || 'unnamed'} · https://claude.ai/code/${rcId}`);
}
if (opt.resume) out(`Resumed session ${sessionId}`);
out('❯ ');
