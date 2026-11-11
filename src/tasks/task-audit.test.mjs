import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTaskAudit, changeReceipt, normalizeVia, taskSnapshot, auditForDecision } from './task-audit.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, starts TEXT NOT NULL, ends TEXT NOT NULL,
    memory_id INTEGER, all_day INTEGER NOT NULL DEFAULT 0, location TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
  )`);
  const audit = createTaskAudit(db);
  const task = (id, title, starts, ends, extra = {}) => {
    db.prepare('INSERT INTO tasks(id, title, starts, ends, memory_id, done) VALUES (?,?,?,?,?,?)')
      .run(id, title, starts, ends, extra.memory_id ?? null, extra.done ?? 0);
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  };
  const insert = (title, starts, ends, memory_id = null) => {
    const result = db.prepare('INSERT INTO tasks(title, starts, ends, memory_id) VALUES (?,?,?,?)')
      .run(title, starts, ends, memory_id);
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(result.lastInsertRowid));
  };
  return { db, audit, task, insert };
}

test('snapshots keep only the editable fields plus done/deleted', () => {
  const snapshot = taskSnapshot({
    id: 1, title: '交付', starts: '2026-11-13T15:00', ends: '2026-11-13T16:30',
    memory_id: 4, all_day: 0, location: '', notes: '', done: 1, deleted: 0, revision: 2,
  });
  assert.deepEqual(snapshot, {
    title: '交付', starts: '2026-11-13T15:00', ends: '2026-11-13T16:30',
    memory_id: 4, all_day: 0, location: '', notes: '', done: 1, deleted: 0,
  });
  assert.equal(taskSnapshot(null), null);
});

test('normalizeVia keeps only a decision-card choice', () => {
  assert.equal(normalizeVia(null), null);
  assert.equal(normalizeVia({}), null);
  assert.equal(normalizeVia({ decision: '12' }), null);
  assert.deepEqual(normalizeVia({ decision: 12, option: 'reschedule', option_label: '改到 15:30', at: '2026-11-11T09:00:00.000Z' }),
    { decision: 12, option: 'reschedule', option_label: '改到 15:30', at: '2026-11-11T09:00:00.000Z' });
  assert.equal(normalizeVia({ decision: 12, option: 7, option_label: [], at: 9 }).option, null);
});

test('changeReceipt shows original time, new time, and the actual result', () => {
  const before = { title: '交付', starts: '2026-11-13T15:00', ends: '2026-11-13T16:30' };
  const after = { title: '交付', starts: '2026-11-14T15:30', ends: '2026-11-14T17:00' };
  const receipt = changeReceipt('updated', before, after);
  assert.match(receipt, /事件已更新 · 交付/);
  assert.match(receipt, /原 2026-11-13 15:00 → 2026-11-13 16:30/);
  assert.match(receipt, /新 2026-11-14 15:30 → 2026-11-14 17:00/);
  assert.equal(changeReceipt('done', before, { title: '交付' }), '待办已完成 · 交付');
  assert.equal(changeReceipt('reopened', before, { title: '交付' }), '待办已重新打开 · 交付');
  assert.equal(changeReceipt('deleted', before, { title: '交付' }), '待办已删除 · 交付');
  assert.match(changeReceipt('created', null, after), /待办已创建 · 交付/);
  assert.equal(changeReceipt('updated', before, null), '操作未生效，请刷新后重试');
  // An edit that does not move the time has no 原/新 contrast.
  assert.equal(changeReceipt('updated', before, { ...before, notes: '补充备注' }),
    '事件已更新 · 交付 · 2026-11-13 15:00 → 2026-11-13 16:30');
});

test('every task change records time, object, before/after, and the linked source', () => {
  const { db, audit, task, insert } = fixture();
  const created = insert('客户交付', '2026-11-13T15:00', '2026-11-13T16:30', 4);
  audit.record(created, 'created', null, null);
  db.prepare('UPDATE tasks SET starts = ?, ends = ? WHERE id = ?').run('2026-11-14T15:30', '2026-11-14T17:00', created.id);
  audit.record(db.prepare('SELECT * FROM tasks WHERE id = ?').get(created.id), 'updated', created,
    { decision: 12, option: 'reschedule', option_label: '改到 2026-11-14 15:30 → 2026-11-14 17:00', at: '2026-11-11T09:00:00.000Z' });
  db.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(created.id);
  audit.record(db.prepare('SELECT * FROM tasks WHERE id = ?').get(created.id), 'done', created, null);
  db.prepare('UPDATE tasks SET deleted = 1 WHERE id = ?').run(created.id);
  audit.record(db.prepare('SELECT * FROM tasks WHERE id = ?').get(created.id), 'deleted', created, null);

  const rows = audit.list();
  assert.deepEqual(rows.map(row => row.action), ['deleted', 'done', 'updated', 'created']); // newest first
  for (const row of rows) assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(row.time));
  for (const row of rows) assert.equal(row.task, created.id);
  const details = rows.map(row => JSON.parse(row.detail));
  assert.equal(details[3].before, null);
  assert.equal(details[3].after.title, '客户交付');
  assert.equal(details[3].source, 4);
  assert.equal(details[3].via, null);
  assert.equal(details[2].before.starts, '2026-11-13T15:00');
  assert.equal(details[2].after.starts, '2026-11-14T15:30');
  assert.deepEqual(details[2].via, {
    decision: 12, option: 'reschedule', option_label: '改到 2026-11-14 15:30 → 2026-11-14 17:00', at: '2026-11-11T09:00:00.000Z',
  });
  assert.equal(details[1].before.done, 0);
  assert.equal(details[1].after.done, 1);
  assert.equal(details[0].after.deleted, 1);
});

test('a rolled-back transaction leaves no audit row (failed request)', () => {
  const { db, audit, insert } = fixture();
  const row = insert('客户交付', '2026-11-13T15:00', '2026-11-13T16:30');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE tasks SET starts = ? WHERE id = ?').run('2026-11-14T15:30', row.id);
    audit.record(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id), 'updated', row, null);
    db.exec('ROLLBACK'); // simulated failure: nothing is committed
  } finally {
    // no-op; kept so the rollback above cannot be accidentally deleted
  }
  assert.equal(audit.list().length, 0);
  assert.equal(db.prepare('SELECT starts FROM tasks WHERE id = ?').get(row.id).starts, '2026-11-13T15:00');
});

test('duplicate request: a status change that changes nothing is not recorded', () => {
  // The route-level idempotency contract: task-status compares first.
  const { db, audit, task } = fixture();
  const row = task(1, '客户交付', '2026-11-13T15:00', '2026-11-13T16:30', { done: 1 });
  const before = row;
  const next = 1;
  if (Number(before.done) !== next) {
    db.prepare('UPDATE tasks SET done = ? WHERE id = ?').run(next, row.id);
    audit.record(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id), 'done', before, null);
  }
  assert.equal(audit.list().length, 0, 'an already-done task stays quiet on a duplicate request');
});

test('auditForDecision returns only this card\'s writes, newest first, with their snapshots', () => {
  const { db, audit, task } = fixture();
  const row = task(1, '客户交付', '2026-11-13T15:00', '2026-11-13T16:30');
  // A direct edit (no decision link) and another card's write must not be returned.
  db.prepare('UPDATE tasks SET starts = ? WHERE id = ?').run('2026-11-13T16:00', row.id);
  audit.record(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id), 'updated', row, null);
  db.prepare('UPDATE tasks SET starts = ? WHERE id = ?').run('2026-11-14T15:30', row.id);
  audit.record(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id), 'updated', row,
    { decision: 99, option: 'reschedule', option_label: '别的卡', at: '2026-11-11T08:00:00.000Z' });
  const beforeThird = db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id); // still 2026-11-14T15:30
  db.prepare('UPDATE tasks SET starts = ? WHERE id = ?').run('2026-11-14T16:00', row.id);
  audit.record(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id), 'updated', beforeThird,
    { decision: 12, option: 'reschedule', option_label: '改到 16:00', at: '2026-11-11T09:00:00.000Z' });

  const rows = auditForDecision(db, 12);
  assert.equal(rows.length, 1, 'only the rows linked to decision #12');
  assert.equal(rows[0].action, 'updated');
  assert.equal(rows[0].via.option, 'reschedule');
  assert.equal(rows[0].before.starts, '2026-11-14T15:30');
  assert.equal(rows[0].after.starts, '2026-11-14T16:00');
  assert.deepEqual(auditForDecision(db, 7), []);
  assert.equal(auditForDecision(db, 99).length, 1);
});
