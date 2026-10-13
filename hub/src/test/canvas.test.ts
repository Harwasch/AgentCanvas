import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.js';
import { EventBus } from '../events.js';
import { CanvasService, type CanvasCaller } from '../canvas.js';

// Only what the arrange / move / undo paths touch.
function setup() {
  const db = new Db(':memory:');
  const bus = new EventBus();
  const events: any[] = [];
  bus.on('event', (e) => events.push(e));
  const c: any = { db, bus, store: { sessions: () => [] } };
  const cv = new CanvasService(c);
  cv.report('t', {
    mode: 'columns', selected: ['a', 'b', 'c'], focusId: null,
    nodes: [
      { id: 'p', kind: 'project', title: 'P', parent: null, x: 0, y: 0, w: 400, h: 300 },
      { id: 'a', kind: 'note', title: 'A', parent: 'p', x: 500, y: 40, w: 200, h: 100 },
      { id: 'b', kind: 'note', title: 'B', parent: 'p', x: 520, y: 400, w: 300, h: 150 },
      { id: 'c', kind: 'note', title: 'C', parent: 'a', x: 900, y: 10, w: 250, h: 120 },
    ],
  });
  return { db, events, cv };
}
const claude: CanvasCaller = { kind: 'assistant', sessionId: 's1', label: 'Claude' };
const xy = (db: Db, id: string) => { const r = db.get('SELECT x, y FROM layout WHERE node_id=?', id); return r ? [r.x, r.y] : null; };

test('arrange grid packs columns by their widest node from the top-left of the group', async () => {
  const { db, cv } = setup();
  const r = await cv.call('canvas_arrange', { pattern: 'grid', columns: 2, gap: 10 }, claude);
  assert.ok(!r.isError, JSON.stringify(r));
  // a, b in row 0; c wraps under a. Column 0 is as wide as c (250), row 0 as tall as b (150).
  assert.deepEqual(xy(db, 'a'), [500, 10]);
  assert.deepEqual(xy(db, 'b'), [500 + 250 + 10, 10]);
  assert.deepEqual(xy(db, 'c'), [500, 10 + 150 + 10]);
});

test('undo restores positions that existed before and deletes ones that did not', async () => {
  const { db, cv, events } = setup();
  db.upsert('layout', { node_id: 'a', x: 1, y: 2, w: 200, h: 100, collapsed: 1 }, 'node_id');
  const r = await cv.call('canvas_move', { moves: [{ id: 'a', dx: 50, dy: 0 }], with_children: true }, claude);
  assert.ok(!r.isError);
  // offsets apply to what the browser shows (the live view), and children follow
  assert.deepEqual(xy(db, 'a'), [550, 40]);
  assert.deepEqual(xy(db, 'c'), [950, 10]);
  const batch = events.filter((e) => e.type === 'canvas.changed').pop().data.batchId;
  cv.undo(batch);
  assert.deepEqual(xy(db, 'a'), [1, 2]);
  assert.equal(xy(db, 'c'), null);
  assert.throws(() => cv.undo(batch), /already undone/);
});
