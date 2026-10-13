// stub-cloud: fakes the vendor clouds behind `claude --cloud`, `claude -p --cloud <id>`
// and `codex cloud exec|list --json|status|diff|apply`. State lives in the profile dir
// (CLAUDE_CONFIG_DIR / CODEX_HOME), as the real login does. A detached "VM" process
// fires the repo's committed .claude/settings.json HTTP hooks, as a real cloud session would.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import { home, sleep, b62, readJson, writeJson, fireHooks } from './common.mjs';

// ============================================================== Claude cloud
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const claudeStore = () => path.join(claudeDir(), 'stub-cloud', 'sessions.json');

export async function claudeCloud(argv) {
  if (!fs.existsSync(path.join(claudeDir(), '.stub-auth.json'))) {
    console.error('Error: cloud sessions require a claude.ai login');
    process.exit(1);
  }
  if (argv[1] === '__vm') return vm(argv[2], argv[3]);
  const p = argv.indexOf('-p') >= 0 ? argv.indexOf('-p') : argv.indexOf('--print');
  const ci = argv.indexOf('--cloud') >= 0 ? argv.indexOf('--cloud') : argv.indexOf('--remote');
  const fmt = argv.includes('--output-format') ? argv[argv.indexOf('--output-format') + 1] : 'text';
  const store = readJson(claudeStore(), {});
  if (p >= 0) {
    // claude -p "msg" --cloud <id> [--output-format json]
    const msg = argv[p + 1];
    let id = argv[ci + 1] || '';
    id = id.replace(/^https:\/\/claude\.ai\/code\//, '').replace(/[?#].*$/, '');
    const s = store[id];
    if (!s) {
      if (fmt === 'json') console.log(JSON.stringify({ ok: false, session_id: id, error: 'session not found' }));
      else console.error(`failed to send message to cloud session ${id}: not found`);
      process.exit(1);
    }
    s.messages.push({ role: 'user', text: msg, at: Date.now() });
    s.status = 'running';
    writeJson(claudeStore(), store);
    spawnVm(id, 'followup');
    const url = `https://claude.ai/code/${id}`;
    if (fmt === 'json') console.log(JSON.stringify({ ok: true, session_id: id, url }));
    else console.log(`Sent to cloud session.\nSession ID: ${id}\nView: ${url}?from=cli&m=0`);
    return;
  }
  // claude --cloud "task"   (must run inside a checkout)
  const task = argv[ci + 1];
  if (!task) {
    console.error('Error: --cloud needs a task description');
    process.exit(1);
  }
  let repo, branch, remote;
  try {
    repo = path.basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('Error: not a git repository');
    process.exit(1);
  }
  const id = 'session_01' + b62(22);
  const settings = readJson(path.join(process.cwd(), '.claude', 'settings.json'), {});
  store[id] = { id, task, repo, branch, remote, status: 'starting', created: Date.now(), settings, messages: [{ role: 'user', text: task, at: Date.now() }], env: 'Default' };
  writeJson(claudeStore(), store);
  console.log(`✓ Repository ${repo} @ ${branch} (${remote})`);
  console.log('✓ Environment: Default');
  console.log('✓ Cloud session created');
  console.log(`Session ID: ${id}`);
  console.log(`View: https://claude.ai/code/${id}`);
  spawnVm(id, 'start');
}

function spawnVm(id, why) {
  // the cloud environment's network secrets (configured by the user in claude.ai) are the VM's env
  const s = readJson(claudeStore(), {})[id] || {};
  const envSecrets = readJson(path.join(claudeDir(), 'stub-cloud', 'environments.json'), {})[s.env] || {};
  const c = spawn(process.execPath, ['--no-warnings', new URL('./stub-claude.mjs', import.meta.url).pathname, '--cloud', '__vm', id, why], { detached: true, stdio: 'ignore', env: { ...process.env, ...envSecrets, CLAUDE_CODE_REMOTE: 'true' } });
  c.unref();
}

/** The fake cloud VM: works for a few seconds, firing the repo's committed HTTP hooks. */
async function vm(id, why) {
  const store = readJson(claudeStore(), {});
  const s = store[id];
  if (!s) return;
  const base = { session_id: id, transcript_path: `/root/.claude/projects/-home-user-${s.repo}/${id}.jsonl`, cwd: `/home/user/${s.repo}`, permission_mode: 'default' };
  const settings = [s.settings || {}];
  const update = (patch) => {
    const st = readJson(claudeStore(), {});
    Object.assign(st[id], patch);
    writeJson(claudeStore(), st);
  };
  update({ status: 'running' });
  const last = s.messages[s.messages.length - 1];
  await fireHooks(settings, 'UserPromptSubmit', { ...base, prompt: last.text });
  await sleep(1500);
  await fireHooks(settings, 'PostToolUse', { ...base, tool_name: 'Edit', tool_input: { file_path: `/home/user/${s.repo}/README.md` }, tool_response: { filePath: `/home/user/${s.repo}/README.md` }, tool_use_id: 'toolu_' + b62(20) }, 'Edit');
  await sleep(1500);
  // results land on a pushed claude/* branch (and, for app tasks, an app the hub's repo scan finds there)
  if (why === 'start' && s.remote) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-cloud-'));
    const br = `claude/${s.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}`;
    try {
      const g = (...a) => execFileSync('git', a, { cwd: tmp, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Claude', GIT_AUTHOR_EMAIL: 'noreply@anthropic.com', GIT_COMMITTER_NAME: 'Claude', GIT_COMMITTER_EMAIL: 'noreply@anthropic.com' } });
      g('clone', '-q', '--branch', s.branch, s.remote, '.');
      g('checkout', '-q', '-b', br);
      fs.mkdirSync(path.join(tmp, 'AI', 'cloud'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'AI', 'cloud', `${id}.md`), `# Cloud session ${id}\n\nTask: ${s.task}\n\nDone in the (stub) cloud VM.\n`);
      if (/\b(app|dashboard)\b/i.test(s.task)) {
        fs.mkdirSync(path.join(tmp, 'apps', 'cloud-status'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'apps', 'cloud-status', 'app.json'), JSON.stringify({ id: 'cloud-status', title: 'Cloud status board', version: '0.1.0', ui: 'ui://cloud-status/main', uiFile: 'index.html', lifecycle: 'static' }, null, 2));
        fs.writeFileSync(path.join(tmp, 'apps', 'cloud-status', 'index.html'), '<!doctype html><body style="background:#0B0C0E;color:#E7E8EA;font:13px system-ui">Built in a cloud session.</body>');
      }
      g('add', '-A');
      g('commit', '-qm', `Cloud session ${id}: ${s.task.slice(0, 60)}`);
      g('push', '-q', 'origin', br);
      update({ resultBranch: br });
    } catch (e) {
      update({ pushError: String(e.message || e).slice(0, 300) });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const answer = why === 'start' ? `Done: worked on "${s.task.slice(0, 80)}" and pushed branch claude/${s.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}.` : `Follow-up handled: "${last.text.slice(0, 80)}".`;
  update({ status: 'idle', branchOut: `claude/${s.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`, last: answer });
  await fireHooks(settings, 'Stop', { ...base, stop_hook_active: false, last_assistant_message: answer });
}

// ============================================================== Codex cloud
const codexHome = () => process.env.CODEX_HOME || path.join(home, '.codex');
const codexStore = () => path.join(codexHome(), 'stub-cloud', 'tasks.json');

function taskStatus(t) {
  if (t.applied) return 'applied';
  const age = Date.now() - t.created;
  if (/fail|error/i.test(t.prompt) && age > 4000) return 'error';
  return age > 6000 ? 'ready' : 'pending';
}
const DIFF = (t) => `diff --git a/NOTES.md b/NOTES.md
index 3b18e51..a1c2f04 100644
--- a/NOTES.md
+++ b/NOTES.md
@@ -1,1 +1,3 @@
 - [ ] scratch note (uncommitted)
+- [x] ${t.prompt.slice(0, 60)}
+- [ ] follow-up from Codex cloud
`;
function rel(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export async function codexCloud(args) {
  if (!fs.existsSync(path.join(codexHome(), '.stub-auth.json'))) {
    console.error('Not signed in. Please run `codex login` to sign in with ChatGPT.');
    return 1;
  }
  const store = readJson(codexStore(), {});
  // clap semantics: everything after a bare `--` is positional
  const dd = args.indexOf('--');
  const opts = dd >= 0 ? args.slice(0, dd) : args;
  const flag = (n) => (opts.includes(n) ? opts[opts.indexOf(n) + 1] : undefined);
  const positional = [...opts.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--'))), ...(dd >= 0 ? args.slice(dd + 1) : [])];
  const idArg = (positional[0] || '').replace(/^https:\/\/chatgpt\.com\/codex\/tasks\//, '').replace(/[?#].*$/, '');
  const sub = args[0];
  if (sub === 'exec') {
    const env = flag('--env');
    if (!env) {
      console.error('error: the following required arguments were not provided:\n  --env <ENV_ID>');
      return 2;
    }
    const attempts = Number(flag('--attempts') || 1);
    if (!(attempts >= 1 && attempts <= 4)) {
      console.error('error: --attempts must be 1..4');
      return 2;
    }
    let branch = flag('--branch');
    if (!branch) {
      try {
        branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        branch = 'main';
      }
    }
    const prompt = positional[0];
    const id = 'task_e_' + crypto.randomBytes(16).toString('hex');
    store[id] = { id, prompt, env, branch, attempts, created: Date.now(), title: prompt.slice(0, 70) };
    writeJson(codexStore(), store);
    console.log(`https://chatgpt.com/codex/tasks/${id}`);
    return 0;
  }
  if (sub === 'list') {
    let tasks = Object.values(store).sort((a, b) => b.created - a.created);
    const env = flag('--env');
    if (env) tasks = tasks.filter((t) => t.env === env);
    const limit = Math.min(Math.max(Number(flag('--limit') || 20), 1), 20);
    const off = flag('--cursor') ? Number(Buffer.from(flag('--cursor'), 'base64url').toString()) : 0;
    const page = tasks.slice(off, off + limit);
    const cursor = off + limit < tasks.length ? Buffer.from(String(off + limit)).toString('base64url') : null;
    const rows = page.map((t) => {
      const st = taskStatus(t);
      return {
        id: t.id, url: `https://chatgpt.com/codex/tasks/${t.id}`, title: t.title, status: st, updated_at: new Date(t.created + (st === 'pending' ? 0 : 6000)).toISOString(),
        environment_id: t.env, environment_label: t.env, summary: st === 'ready' || st === 'applied' ? { files_changed: 1, lines_added: 2, lines_removed: 0 } : { files_changed: 0, lines_added: 0, lines_removed: 0 },
        is_review: false, attempt_total: t.attempts,
      };
    });
    if (args.includes('--json')) console.log(JSON.stringify({ tasks: rows, cursor }, null, 2));
    else {
      if (!rows.length) console.log('No tasks found.');
      for (const r of rows) console.log(`${r.url}\n  [${r.status.toUpperCase()}] ${r.title}\n  ${r.environment_label}  •  ${rel(Date.parse(r.updated_at))}\n  ${r.summary.files_changed ? `+${r.summary.lines_added}/-${r.summary.lines_removed} • ${r.summary.files_changed} files` : 'no diff'}\n`);
      if (cursor) console.log(`To fetch the next page, run codex cloud list --cursor='${cursor}'`);
    }
    return 0;
  }
  const t = store[idArg];
  if (['status', 'diff', 'apply'].includes(sub) && !t) {
    console.error(`Error: task ${idArg} not found`);
    return 1;
  }
  if (sub === 'status') {
    const st = taskStatus(t);
    console.log(`[${st.toUpperCase()}] ${t.title}\n${t.env}  •  ${rel(t.created)}\n${st === 'ready' || st === 'applied' ? '+2/-0 • 1 files' : 'no diff'}`);
    return st === 'ready' ? 0 : 1;
  }
  if (sub === 'diff') {
    if (taskStatus(t) === 'pending') {
      console.error(`No diff available for task ${t.id}; it may still be running.`);
      return 1;
    }
    process.stdout.write(DIFF(t));
    return 0;
  }
  if (sub === 'apply') {
    t.applied = true;
    writeJson(codexStore(), store);
    console.log(`Applied task ${t.id} locally (1 files)`);
    return 0;
  }
  console.error(`unknown cloud subcommand ${sub}`);
  return 2;
}
