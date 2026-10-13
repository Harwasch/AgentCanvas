import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePorcelainV2 } from '../repos.js';

test('porcelain v2: branch header, ahead/behind, changed/renamed/untracked/unmerged entries, spaces in paths', () => {
  const out = [
    '# branch.oid 3f9c2e1a7b0d4c5e6f708192a3b4c5d6e7f80912',
    '# branch.head feat/power-board-rev-b',
    '# branch.upstream origin/feat/power-board-rev-b',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb fw/current loop.c',
    '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 docs/new name.md\tdocs/old.md',
    'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict.txt',
    '? NOTES.md',
    '',
  ].join('\n');
  const s = parsePorcelainV2(out);
  assert.equal(s.head, '3f9c2e1a7b0d4c5e6f708192a3b4c5d6e7f80912');
  assert.equal(s.branch, 'feat/power-board-rev-b');
  assert.equal(s.upstream, 'origin/feat/power-board-rev-b');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.deepEqual(s.changes, [
    { xy: '.M', path: 'fw/current loop.c' },
    { xy: 'R.', path: 'docs/new name.md' },
    { xy: 'UU', path: 'conflict.txt' },
    { xy: '??', path: 'NOTES.md' },
  ]);
});

test('porcelain v2: initial commit and detached head', () => {
  const s = parsePorcelainV2('# branch.oid (initial)\n# branch.head (detached)\n');
  assert.equal(s.head, null);
  assert.equal(s.branch, null);
  assert.equal(s.changes.length, 0);
});
