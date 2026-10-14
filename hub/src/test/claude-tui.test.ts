import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from '../adapters.js';

test('an open selection dialog is never "ready" (startup fallback must not type into it)', () => {
  const dlg = 'Quick safety check: Is this a project you created or one you trust?\n❯ 1. No, exit\n  2. Yes, I trust this folder\nEnter to confirm · Esc to cancel';
  assert.ok(ClaudeAdapter.dialogOpen(dlg));
  assert.ok(!ClaudeAdapter.isReady(dlg));
  assert.ok(ClaudeAdapter.isReady('❯ '));
});

test('Remote Control name: repo · branch · first words, no hub id', () => {
  assert.equal(ClaudeAdapter.rcName({ repo: 'wireless-charging', branch: 'wpt-spice-sim', prompt: "test, just say the third word in this repo's README" }),
    'wireless-charging · wpt-spice-sim · test, just say the third word in this…');
  assert.equal(ClaudeAdapter.rcName({ repo: 'hexapod', branch: null, prompt: '' }), 'hexapod');
  assert.equal(ClaudeAdapter.rcName({ repo: 'home', title: 'Canvas assistant' }), 'home · Canvas assistant');
});
