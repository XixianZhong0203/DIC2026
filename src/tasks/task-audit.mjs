// Task action receipts (待办操作留痕).
//
// Code ownership (aligned with the server window): this module owns the
// task_audit table, before/after snapshots, the linked-source field, and the
// decision-card linkage. server.mjs calls `record` inside the same
// transaction as the task change, so a failed or duplicated request never
// leaves a success record: task change and audit row commit or roll back
// together.

export const TASK_ACTIONS = ['created', 'updated', 'done', 'reopened', 'deleted'];

const SNAP_FIELDS = ['title', 'starts', 'ends', 'memory_id', 'all_day', 'location', 'notes'];

// Compact before/after snapshot of the fields the owner can change.
export function taskSnapshot(row) {
  if (!row) return null;
  const out = {};
  for (const key of SNAP_FIELDS) if (row[key] != null) out[key] = row[key];
  if (row.done != null) out.done = Number(row.done);
  if (row.deleted != null) out.deleted = Number(row.deleted);
  return out;
}

// The decision-card choice that triggered the operation, or null.
// Only the decision message id is required; the rest is cosmetic context.
export function normalizeVia(via) {
  if (!via || typeof via !== 'object' || !Number.isSafeInteger(via.decision)) return null;
  return {
    decision: via.decision,
    option: typeof via.option === 'string' && via.option ? via.option.slice(0, 40) : null,
    option_label: typeof via.option_label === 'string' ? via.option_label.slice(0, 200) : null,
    at: typeof via.at === 'string' ? via.at.slice(0, 40) : null,
  };
}

// Receipt shown on the decision card after a confirmed task effect:
// original time, new time, and the actual result.
export function changeReceipt(action, before, after) {
  const time = value => String(value).replace('T', ' ');
  if (!after) return '操作未生效，请刷新后重试';
  if (action === 'created') return '待办已创建 · ' + after.title + ' · ' + time(after.starts) + ' → ' + time(after.ends);
  if (action === 'done') return '待办已完成 · ' + after.title;
  if (action === 'reopened') return '待办已重新打开 · ' + after.title;
  if (action === 'deleted') return '待办已删除 · ' + (before?.title ?? after.title);
  const rescheduled = before && (before.starts !== after.starts || before.ends !== after.ends);
  return '事件已更新 · ' + after.title +
    (rescheduled
      ? ' · 原 ' + time(before.starts) + ' → ' + time(before.ends) + ' · 新 ' + time(after.starts) + ' → ' + time(after.ends)
      : ' · ' + time(after.starts) + ' → ' + time(after.ends));
}

export function createTaskAudit(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_audit (
    id INTEGER PRIMARY KEY, task INTEGER, action TEXT NOT NULL, time TEXT NOT NULL, detail TEXT NOT NULL
  )`);
  // Called inside the caller's transaction (see server.mjs task routes).
  const record = (row, action, before, via) => db.prepare('INSERT INTO task_audit(task, action, time, detail) VALUES (?,?,?,?)')
    .run(Number.isSafeInteger(row?.id) ? row.id : null, action, new Date().toISOString(),
      JSON.stringify({ before: taskSnapshot(before), after: taskSnapshot(row),
        source: row?.memory_id ?? before?.memory_id ?? null, via: normalizeVia(via) }));
  const list = (limit = 100) => db.prepare('SELECT * FROM task_audit ORDER BY id DESC LIMIT ?').all(Number(limit) || 100);
  return { record, list };
}
