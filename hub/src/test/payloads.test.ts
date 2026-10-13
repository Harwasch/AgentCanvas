import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHook, writtenPaths, permissionDecision, parseChannelLine, channelMessage, channelPermission, projectSlug, parseTranscriptLine } from '../claude/payloads.js';

const base = { session_id: '3f2a8c1e-0000-4000-8000-000000000001', transcript_path: '/h/.claude/projects/-h-code-x/3f2a.jsonl', cwd: '/h/code/x', permission_mode: 'default' };

test('UserPromptSubmit parses prompt', () => {
  const r = parseHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi from phone' });
  assert.ok(r.ok);
  assert.equal(r.ok && r.hook.prompt, 'hi from phone');
  assert.equal(r.ok && r.hook.transcriptPath, base.transcript_path);
});

test('PermissionRequest/PreToolUse/PostToolUse need tool_name', () => {
  assert.equal(parseHook({ ...base, hook_event_name: 'PermissionRequest', tool_input: {} }).ok, false);
  const r = parseHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'make flash' }, permission_suggestions: [] });
  assert.ok(r.ok && r.hook.toolInput!.command === 'make flash');
  const p = parseHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/h/code/x/apps/w/ui.html' }, tool_response: { filePath: '/h/code/x/apps/w/ui.html', type: 'create' }, tool_use_id: 'toolu_1' });
  assert.ok(p.ok);
  assert.deepEqual(p.ok && writtenPaths(p.hook), ['/h/code/x/apps/w/ui.html']);
});

test('MultiEdit paths are collected', () => {
  const p = parseHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'MultiEdit', tool_input: { file_path: '/a', edits: [{ file_path: '/b' }] } });
  assert.deepEqual(p.ok && writtenPaths(p.hook).sort(), ['/a', '/b']);
});

test('Stop parses last_assistant_message', () => {
  const r = parseHook({ ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
  assert.ok(r.ok && r.hook.lastAssistantMessage === 'done' && r.hook.stopHookActive === false);
});

test('rejects unknown events, missing session, non-objects', () => {
  assert.equal(parseHook({ ...base, hook_event_name: 'SessionStart' }).ok, false, 'SessionStart has no http hooks');
  assert.equal(parseHook({ hook_event_name: 'Stop' }).ok, false);
  assert.equal(parseHook(null).ok, false);
  assert.equal(parseHook([1]).ok, false);
});

test('permission decision JSON shape', () => {
  assert.deepEqual(permissionDecision('allow'), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const d = permissionDecision('deny', 'no');
  assert.equal(d.hookSpecificOutput.decision.behavior, 'deny');
});

test('channel permission_request: request id format [a-km-z]{5}, lowercased', () => {
  const ok = parseChannelLine({ type: 'permission_request', request_id: 'ABCDE', tool_name: 'Bash', description: 'Run shell command', input_preview: '{"command": "ls"}' });
  assert.ok(ok.ok && ok.msg.type === 'permission_request' && ok.msg.requestId === 'abcde');
  assert.equal(parseChannelLine({ type: 'permission_request', request_id: 'abcdl', tool_name: 'Bash' }).ok, false, 'l is excluded');
  assert.equal(parseChannelLine({ type: 'permission_request', request_id: 'abcd', tool_name: 'Bash' }).ok, false);
  assert.equal(parseChannelLine({ type: 'permission_request', request_id: 'abcde' }).ok, false);
  assert.equal(parseChannelLine({ type: 'bogus' }).ok, false);
  assert.ok(parseChannelLine({ type: 'hello', session: 'h1' }).ok);
});

test('channel outbound: meta keys outside [A-Za-z0-9_] are dropped (Claude would drop them silently)', () => {
  assert.deepEqual(channelMessage('hi', { from_hub: '1', 'bad-key': 'x', 'a.b': 'y' }).meta, { from_hub: '1' });
  assert.deepEqual(channelPermission('ABCDE', 'allow'), { type: 'permission', request_id: 'abcde', behavior: 'allow' });
});

test('project slug: every non-alphanumeric becomes -', () => {
  assert.equal(projectSlug('/home/user/AgentCanvas'), '-home-user-AgentCanvas');
  assert.equal(projectSlug('/Users/you/my.proj'), '-Users-you-my-proj');
});

test('transcript lines: user string, assistant blocks, tool_result, junk', () => {
  assert.deepEqual(parseTranscriptLine('{"type":"user","uuid":"u1","message":{"role":"user","content":"hello"},"timestamp":"t"}').map((x) => [x.role, x.kind, x.text]), [['user', 'text', 'hello']]);
  const a = parseTranscriptLine(JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: 't', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } }));
  assert.equal(a[0].kind, 'tool_use');
  assert.equal(a[0].data.input.command, 'ls');
  const r = parseTranscriptLine(JSON.stringify({ type: 'user', uuid: 'r1', timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] }] } }));
  assert.equal(r[0].role, 'tool');
  assert.equal(r[0].text, 'ok');
  assert.deepEqual(parseTranscriptLine('not json'), []);
  assert.deepEqual(parseTranscriptLine('{"type":"queue-operation","operation":"enqueue"}'), []);
});
