import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from '../adapters.js';

test('default ~/.claude profile unsets CLAUDE_CONFIG_DIR (else Claude reads ~/.claude/.claude.json, not ~/.claude.json)', () => {
  assert.equal(ClaudeAdapter.configDirEnv('/home/h', '/home/h/.claude'), 'unset CLAUDE_CONFIG_DIR; export ');
  assert.equal(ClaudeAdapter.configDirEnv('/home/h/', '/home/h/.claude/'), 'unset CLAUDE_CONFIG_DIR; export ');
});

test('any other profile dir is exported', () => {
  assert.equal(ClaudeAdapter.configDirEnv('/home/h', '/home/h/.claude-work'), "export CLAUDE_CONFIG_DIR='/home/h/.claude-work' ");
  assert.equal(ClaudeAdapter.configDirEnv('/home/h', '/home/other/.claude'), "export CLAUDE_CONFIG_DIR='/home/other/.claude' ");
});

// panes captured from real Claude Code v2.1.296 on mini-1 during bring-up
const RULE = '─'.repeat(60);
const realIdle = [
  '  /remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_01LA4pVxWCEVDss5xVekwYnN',
  RULE, '❯ Try "how does <filepath> work?"', RULE,
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
].join('\n');
const realIdleEmpty = [RULE, '❯ ', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n');
const realTrust = [
  RULE, ' Accessing workspace:', ' /home/h/code/x',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).',
  ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel',
].join('\n');
const realDevChannel = [
  RULE, '  WARNING: Loading development channels', '  Channels: server:hub',
  '  ❯ 1. I am using this for local development', '    2. Exit', '  Enter to confirm · Esc to cancel',
].join('\n');
const realFullscreen = [RULE, '  Try the new fullscreen renderer?', '  ❯ 1. Yes, try it', '    2. Not now', '  Enter to confirm · Esc to cancel'].join('\n');

test('ready: real idle input box (with and without placeholder) and the stub prompt', () => {
  assert.ok(ClaudeAdapter.isReady(realIdle));
  assert.ok(ClaudeAdapter.isReady(realIdleEmpty));
  assert.ok(ClaudeAdapter.isReady('stub banner\n❯\n'));
});

test('not ready while a dialog is open', () => {
  for (const p of [realTrust, realDevChannel, realFullscreen]) {
    assert.ok(ClaudeAdapter.dialogOpen(p));
    assert.equal(ClaudeAdapter.isReady(p), false);
  }
});

test('startup prompts: real 2.1.296 dialogs map to the safe keys', () => {
  const match = (p: string) => ClaudeAdapter.startupPrompts.filter((s) => s.re.test(p));
  assert.deepEqual(match(realTrust).map((s) => s.keys), [['Down', 'Enter']]);
  assert.deepEqual(match(realDevChannel).map((s) => s.keys), [['Enter']]);
  assert.deepEqual(match(realFullscreen).map((s) => s.keys), [['Down', 'Enter']]);
  assert.deepEqual(match(realIdle), []);
});

test('remote control URL from the real banner', () => {
  assert.equal(ClaudeAdapter.parseRemoteControlUrl(realIdle), 'https://claude.ai/code/session_01LA4pVxWCEVDss5xVekwYnN');
});
