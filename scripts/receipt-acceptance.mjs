// Acceptance flow for task operation receipts (待办操作回执) and the
// outreach send-block audit refresh.
//
//   create → reschedule via a decision card → done → reopen → delete,
//   with every change (time, object, before/after, linked source, and the
//   decision-card choice) recorded in the task activity log; failed or
//   duplicated requests leave no success record. Then an unverified
//   outreach draft triggers a send block: the block reason is returned and
//   the activity log shows the blocked entry while the draft stays editable.
//
//   node scripts/receipt-acceptance.mjs
//
// The script starts a fresh server (temporary data dir, dedicated port) with
// the same .env as `npm start`. The decision-card step seeds the card through
// the real detectDecision() and the real /api/decision route; the rest uses
// the deterministic API only (no model needed).

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { detectDecision } from '../src/decision/decision.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4198;
const base = 'http://127.0.0.1:' + port;

async function api(route, body) {
  const options = body === undefined ? { method: 'GET' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const response = await fetch(base + route, options);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data, error: data.error ?? null };
}

const results = [];
function record(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log('  ' + status + '  ' + name + (detail ? '  · ' + detail : ''));
}
const taskAudit = data => data.taskAudit ?? [];
const lastTaskAudit = data => taskAudit(data)[0] ?? null;
const task = (data, id) => (data.tasks ?? []).find(row => row.id === id) ?? null;

const dataDir = await mkdtemp(path.join(tmpdir(), 'daymark-receipt-acceptance-'));
const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.mjs'], {
  cwd: root,
  env: { ...process.env, DAYMARK_DATA_DIR: dataDir, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });

function cleanup(code) {
  server.kill('SIGTERM');
  return rm(dataDir, { recursive: true, force: true }).then(() => process.exit(code));
}

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try {
    const probe = await fetch(base + '/api/state');
    up = probe.ok;
  } catch {
    if (server.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
if (!up) {
  console.log('FAIL  server did not start\n' + serverLog);
  await cleanup(1);
}

// Seed the reschedule decision card through the real detector, then let the
// real /api/decision route confirm it.
const db2 = new DatabaseSync(dataDir + '/daymark.sqlite');

console.log('\n1) Create a task linked to a source record');
const memory = await api('/api/memory', { kind: 'source', scope: 'DIC2026', body: '客户交付：2026-11-13 15:00 向客户交付版本。', source: '验收脚本' });
record('save a source record', memory.ok ? 'PASS' : 'FAIL', memory.error ?? '');
const memoryId = memory.data.memory.find(row => row.body.startsWith('客户交付'))?.id;
const created = await api('/api/task', { title: '客户交付', starts: '2026-11-13T15:00', ends: '2026-11-13T16:30', memory_id: memoryId });
record('create a task', created.ok ? 'PASS' : 'FAIL', created.error ?? '');
let state = (await api('/api/state')).data;
const taskId = state.tasks[0]?.id;
const createdRow = lastTaskAudit(state);
const createdDetail = createdRow ? JSON.parse(createdRow.detail) : null;
record('creation is recorded with before/after, linked source, and no decision link',
  createdRow?.action === 'created' && createdDetail?.before === null && createdDetail?.source === memoryId && createdDetail?.via === null ? 'PASS' : 'FAIL',
  JSON.stringify(createdDetail ?? null));

console.log('\n2) Reschedule through a decision card (seeded via the real detector)');
const conversation = await api('/api/conversation', {});
const convId = conversation.data.conversation;
const decision = detectDecision({
  question: '客户交付改到 2026-11-14 15:30',
  review: { conflict: '新时间与现有安排冲突', understood: '把客户交付改到 2026-11-14 15:30', question: '', plain: false, cited: [], facts: [] },
  tasks: state.tasks, memories: [],
});
const confirmDecision = decision?.options?.find(option => option.id === 'reschedule');
if (!confirmDecision) {
  record('decision card detected', 'FAIL', 'detectDecision returned no reschedule option: ' + JSON.stringify(decision ?? null));
  await cleanup(1);
}
record('decision card detected', 'PASS', confirmDecision.label);
const msg = db2.prepare('INSERT INTO messages(role, body, review, conversation_id) VALUES (?,?,?,?)')
  .run('assistant', '请确认改期。', JSON.stringify({
    answer: '请确认改期。', decision, evidence: 'verbatim', facts: [], inferences: [], unknowns: [], cited: [],
    conflict: '', question: '', understood: '',
  }), convId);
const messageId = Number(msg.lastInsertRowid);
const confirmed = await api('/api/decision', { message_id: messageId, option_id: 'reschedule', confirm: true });
state = confirmed.data;
const decisionRow = state.messages?.find(row => row.id === messageId);
const choice = decisionRow?.review?.decision?.choice;
const receipt = choice?.receipt ?? '';
record('confirmed reschedule returns a receipt with original and new time',
  confirmed.ok && decisionRow?.review?.decision?.status === 'applied'
  && receipt.includes('2026-11-13 15:00') && receipt.includes('2026-11-14 15:30') ? 'PASS' : 'FAIL',
  receipt);
record('the task moved to the new time',
  (task(state, taskId)?.starts === '2026-11-14T15:30' && task(state, taskId)?.ends === '2026-11-14T17:00') ? 'PASS' : 'FAIL',
  JSON.stringify(task(state, taskId) ?? null));
const rescheduledRow = taskAudit(state).find(row => JSON.parse(row.detail).via?.decision === messageId);
const rescheduledDetail = rescheduledRow ? JSON.parse(rescheduledRow.detail) : null;
record('reschedule audit row links the decision-card choice',
  rescheduledRow?.action === 'updated' && rescheduledDetail?.via?.option === 'reschedule'
  && rescheduledDetail?.before?.starts === '2026-11-13T15:00' && rescheduledDetail?.after?.starts === '2026-11-14T15:30' ? 'PASS' : 'FAIL',
  JSON.stringify(rescheduledDetail ?? null));
// Duplicate confirmation: 409 (a 409 body carries only the error), still applied, no new audit row.
const auditCountAfterConfirm = taskAudit(state).length;
const dupConfirm = await api('/api/decision', { message_id: messageId, option_id: 'reschedule', confirm: true });
state = (await api('/api/state')).data;
record('duplicate confirmation is rejected (409) without a new audit row',
  dupConfirm.status === 409 && /已确认/.test(dupConfirm.error ?? '') && taskAudit(state).length === auditCountAfterConfirm ? 'PASS' : 'FAIL',
  dupConfirm.error ?? '');
// A decision whose task revision is stale fails: the card records the failure,
// nothing is changed, and no success record is left.
const staleDecision = detectDecision({
  question: '客户交付改到 2026-11-15 10:00',
  review: { conflict: '新时间与现有安排冲突', understood: '把客户交付改到 2026-11-15 10:00', question: '', plain: false, cited: [], facts: [] },
  tasks: state.tasks, memories: [],
});
const staleOption = staleDecision?.options?.find(option => option.id === 'reschedule');
if (staleOption) staleOption.effect.payload.revision -= 1; // force the revision gate to fail
const staleMsg = db2.prepare('INSERT INTO messages(role, body, review, conversation_id) VALUES (?,?,?,?)')
  .run('assistant', '请确认改期（修订已过期）。', JSON.stringify({
    answer: '请确认改期（修订已过期）。', decision: staleDecision, evidence: 'verbatim', facts: [],
    inferences: [], unknowns: [], cited: [], conflict: '', question: '', understood: '',
  }), convId);
const staleMessageId = Number(staleMsg.lastInsertRowid);
const staleConfirm = await api('/api/decision', { message_id: staleMessageId, option_id: 'reschedule', confirm: true });
const staleRow = staleConfirm.data.messages?.find(row => row.id === staleMessageId);
const staleResult = staleRow?.review?.decision;
record('a stale confirmation refreshes the card without applying it',
  staleConfirm.ok && staleResult?.status === 'open'
  && staleResult.recheck?.stale === true && Boolean(staleResult.recheck.reason) ? 'PASS' : 'FAIL',
  staleResult?.recheck?.reason ?? '');
const staleAudit = taskAudit(staleConfirm.data).find(row => JSON.parse(row.detail).via?.decision === staleMessageId);
record('a failed confirmation leaves no task audit row',
  !staleAudit && task(staleConfirm.data, taskId)?.starts === '2026-11-14T15:30' ? 'PASS' : 'FAIL',
  'task unchanged: ' + task(staleConfirm.data, taskId)?.starts);

console.log('\n3) Direct edit: recorded with before/after; a stale duplicate is rejected');
state = (await api('/api/state')).data;
const currentTask = task(state, taskId);
const edited = await api('/api/task', {
  id: taskId, revision: currentTask.revision, title: '客户交付（已改期）',
  starts: currentTask.starts, ends: currentTask.ends, memory_id: memoryId, all_day: false, location: '', notes: '',
});
const editRow = lastTaskAudit(edited.data);
const editDetail = editRow ? JSON.parse(editRow.detail) : null;
record('direct edit is recorded with before/after and no decision link',
  edited.ok && editRow?.action === 'updated' && editDetail?.via === null
  && editDetail?.before?.title === '客户交付' && editDetail?.after?.title === '客户交付（已改期）' ? 'PASS' : 'FAIL',
  JSON.stringify(editDetail ?? null));
const auditCountAfterEdit = taskAudit(edited.data).length;
const dupEdit = await api('/api/task', {
  id: taskId, revision: currentTask.revision, title: '客户交付（重复请求）',
  starts: currentTask.starts, ends: currentTask.ends, memory_id: memoryId, all_day: false, location: '', notes: '',
});
state = (await api('/api/state')).data;
record('duplicated edit (stale revision) is rejected (409) without a new audit row',
  dupEdit.status === 409 && taskAudit(state).length === auditCountAfterEdit ? 'PASS' : 'FAIL',
  dupEdit.error ?? '');

console.log('\n4) Done, duplicate done, reopen');
const done = await api('/api/task-status', { id: taskId, done: true });
const doneRow = lastTaskAudit(done.data);
record('done is recorded', done.ok && doneRow?.action === 'done' ? 'PASS' : 'FAIL');
const auditCountAfterDone = taskAudit(done.data).length;
const dupDone = await api('/api/task-status', { id: taskId, done: true });
record('duplicate done request leaves no new audit row',
  dupDone.ok && taskAudit(dupDone.data).length === auditCountAfterDone ? 'PASS' : 'FAIL');
const reopened = await api('/api/task-status', { id: taskId, done: false });
const reopenRow = lastTaskAudit(reopened.data);
record('reopen is recorded', reopened.ok && reopenRow?.action === 'reopened' ? 'PASS' : 'FAIL');

console.log('\n5) Delete');
state = (await api('/api/state')).data;
const beforeDelete = task(state, taskId);
const deleted = await api('/api/task-delete', { id: taskId, revision: beforeDelete.revision });
const deleteRow = lastTaskAudit(deleted.data);
const deleteDetail = deleteRow ? JSON.parse(deleteRow.detail) : null;
record('delete is recorded with before snapshot and removed from the task list',
  deleted.ok && deleteRow?.action === 'deleted'
  && deleteDetail?.before?.title === '客户交付（已改期）' && !task(deleted.data, taskId) ? 'PASS' : 'FAIL',
  JSON.stringify(deleteDetail?.before ?? null));
const dupDelete = await api('/api/task-delete', { id: taskId, revision: beforeDelete.revision });
record('duplicated delete is rejected (409)', dupDelete.status === 409 ? 'PASS' : 'FAIL', dupDelete.error ?? '');

console.log('\n6) Unverified outreach draft blocks the simulated send; draft stays editable');
const lead = await api('/api/opportunity', { kind: 'lead', title: '版本交付跟进', source: '验收脚本', evidence: '客户希望周五交付。' });
const leadId = lead.data.opportunities[0]?.id;
const draftV1 = await api('/api/opportunity-draft', { id: leadId, recipient: 'client@example.test', body: '第一版草稿。' });
const v1 = (await api('/api/state')).data.opportunities.find(row => row.id === leadId).draft_id;
const review = await api('/api/opportunity-review', { id: leadId, analysis_id: null, draft_id: v1, resolution: '人工确认第一版草稿可发送。' });
const draftV2 = await api('/api/opportunity-draft', { id: leadId, recipient: 'client@example.test', body: '第二版草稿（未核查）。' });
const v2 = draftV2.data.opportunities.find(row => row.id === leadId)?.draft_id;
record('new unverified draft v2 saved (review only covers v1)',
  review.ok && draftV2.ok && v2 && v2 !== v1 ? 'PASS' : 'FAIL');
const send = await api('/api/opportunity-send', { id: leadId, draft_id: v2 });
record('send of the unverified draft is blocked (409) with the block reason',
  send.status === 409 && /尚未核查/.test(send.error ?? '') ? 'PASS' : 'FAIL', send.error ?? '');
// A 409 body carries only the error; the client refreshes state to see the
// audit entry on the spot (mirrors the request() refresh in dist/app.js).
const freshState = (await api('/api/state')).data;
record('the activity log immediately shows the blocked entry',
  freshState.audit?.[0]?.opportunity === leadId && freshState.audit?.[0]?.action === 'blocked'
  && JSON.parse(freshState.audit?.[0]?.detail ?? '{}').reason === 'claims_not_verified' ? 'PASS' : 'FAIL',
  JSON.parse(freshState.audit?.[0]?.detail ?? '{}').reason ?? '');
const leadAfter = freshState.opportunities.find(row => row.id === leadId);
record('the draft content is unchanged and still editable',
  leadAfter.body === '第二版草稿（未核查）。' && leadAfter.draft_id === v2 && !leadAfter.sent ? 'PASS' : 'FAIL',
  JSON.stringify({ body: leadAfter.body, draft_id: leadAfter.draft_id, sent: leadAfter.sent }));

db2.close();
const failed = results.filter(row => row.status === 'FAIL').length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' acceptance steps passed' + (failed ? ' — ' + failed + ' FAILED' : ''));
await cleanup(failed ? 1 : 0);
