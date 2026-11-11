// Acceptance flow for decision-card CONFIRM EXECUTION (决策确认与实际结果一致):
// one valid confirmation per card applies the change exactly once, and the
// receipt always describes the write that actually happened.
//
//   1) 日历改期：选择（已选待确认）→ 确认（已应用，回执=原时间/新时间/实际结果）→ 重试 409；
//   2) 长期偏好更新：确认一次写入一次（修订链完整，回执=新记录）→ 重试 409；
//   3) 双击/两标签页并发确认（task 与 memory 两条路径）：一次有效变更 + 对应回执；
//   4) 写入成功但回执保存失败：从既有记录（task_audit / memory 行）恢复回执，不重复写入；
//   5) 旧卡因日历冲突暂缓：不写入，卡片刷新且「当前实际生效」= 实际安排，重确认只写一次；
//   6) 旧卡因规则修订暂缓：重锚定到现行版本，后续回答以实际生效偏好为准；
//   7) 失败状态：写入报错=确认失败（无写入），卡片仍可用其他选项。
//
//   node scripts/decision-confirm-acceptance.mjs
//
// The script starts a fresh server (temporary data dir, dedicated port) and
// drives the real /api/task, /api/memory(-impact) and /api/decision routes.
// No model is needed: cards are produced by the same detectDecision the chat
// pipeline uses and stored on assistant messages the way the pipeline does.

import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDecision, buildDecision, decisionContext, DECISION_MEMORY_SOURCE } from '../src/decision/decision.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4199;
const base = 'http://127.0.0.1:' + port;

const dataDir = await mkdtemp(path.join(tmpdir(), 'daymark-confirm-acceptance-'));
const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.mjs'], {
  cwd: root,
  env: { ...process.env, DAYMARK_DATA_DIR: dataDir, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });

const results = [];
function record(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log('  ' + status + '  ' + name + (detail ? '  · ' + detail : ''));
}
const passed = () => results.filter(item => item.status === 'PASS').length;
const failed = () => results.filter(item => item.status === 'FAIL').length;

async function api(route, body) {
  const options = body === undefined ? { method: 'GET' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const response = await fetch(base + route, options);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data, error: data.error ?? null };
}

function cleanup(code) {
  server.kill('SIGTERM');
  return rm(dataDir, { recursive: true, force: true }).then(() => process.exit(code));
}

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  if (server.exitCode != null) break; // our own server died (e.g. port in use)
  try {
    up = (await fetch(base + '/api/state')).ok;
  } catch {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
if (!up) {
  console.log('FAIL  server did not start\n' + serverLog);
  await cleanup(1);
}

// Store an assistant message carrying a decision card, exactly the way the
// chat pipeline persists detectDecision output (review.decision).
function storeCard(state, decision, conversationId) {
  const db = new DatabaseSync(path.join(dataDir, 'daymark.sqlite'));
  db.prepare('INSERT INTO messages(role, body, review, conversation_id) VALUES (?, ?, ?, ?)')
    .run('assistant', '请确认卡片中的选项。', JSON.stringify({
      answer: '请确认卡片中的选项。', conflict: '', understood: '',
      decision,
    }), conversationId);
  const id = Number(db.prepare('SELECT id FROM messages ORDER BY id DESC LIMIT 1').get().id);
  db.close();
  return { decision, message_id: id };
}
const findCard = (state, messageId) =>
  (state.messages ?? []).find(message => message.id === messageId)?.review?.decision ?? null;
const auditRowsFor = (state, messageId) =>
  (state.taskAudit ?? []).filter(row => JSON.parse(row.detail).via?.decision === messageId);
const memoryRowsFor = (state, messageId) =>
  (state.memory ?? []).filter(row => row.message_id === messageId);

const conv = await api('/api/conversation', {});
const convId = conv.data.conversation;
if (!conv.ok) { record('create a conversation', 'FAIL', conv.error ?? ''); await cleanup(1); }
record('create a conversation', 'PASS');

// ---------------------------------------------------------------------------
console.log('\n1) 日历改期：已选待确认 → 已应用（回执=实际写入）→ 重试 409');
const meeting = await api('/api/task', {
  title: '客户会议', starts: '2026-11-13T15:00', ends: '2026-11-13T16:30',
  all_day: false, location: '', notes: '',
});
record('save the confirmed Friday meeting', meeting.ok ? 'PASS' : 'FAIL', meeting.error ?? '');
let state = (await api('/api/state')).data;
const meetingId = state.tasks.find(task => task.title === '客户会议')?.id;
let card = storeCard(state, detectDecision({
  question: '客户来信：会议想从周五改到 2026-11-14 15:30。',
  review: { understood: '把客户会议改到 2026-11-14 15:30', conflict: '' },
  tasks: state.tasks, memories: state.memory, scope: 'DIC2026',
}), convId);
record('reschedule card detected', card.decision?.kind === 'reschedule' ? 'PASS' : 'FAIL',
  JSON.stringify(card.decision?.options?.map(option => option.id) ?? null));

let select = await api('/api/decision', { message_id: card.message_id, option_id: 'reschedule' });
let cardAfterSelect = findCard((await api('/api/state')).data, card.message_id);
record('a selection alone is 已选待确认: recorded, nothing written',
  select.ok && cardAfterSelect?.status === 'choosing' && cardAfterSelect?.choice?.option_id === 'reschedule'
  && cardAfterSelect?.choice?.receipt === '' && auditRowsFor((await api('/api/state')).data, card.message_id).length === 0
  ? 'PASS' : 'FAIL',
  'status=' + cardAfterSelect?.status + ' receipt=' + JSON.stringify(cardAfterSelect?.choice?.receipt ?? null));

let confirm = await api('/api/decision', { message_id: card.message_id, option_id: 'reschedule', confirm: true });
state = (await api('/api/state')).data;
let appliedCard = findCard(state, card.message_id);
const meetingAfter = state.tasks.find(task => task.id === meetingId);
record('the confirm applies once and is 已应用',
  confirm.ok && appliedCard?.status === 'applied'
  && meetingAfter?.starts === '2026-11-14T15:30' && meetingAfter?.ends === '2026-11-14T17:00'
  ? 'PASS' : 'FAIL',
  'status=' + appliedCard?.status + ' meeting=' + (meetingAfter ? meetingAfter.starts + ' → ' + meetingAfter.ends : 'missing'));
record('the receipt is the actual write result (original + new time)',
  appliedCard?.choice?.option_id === 'reschedule'
  && appliedCard?.choice?.receipt.startsWith('本地日历已更新')
  && /原 2026-11-13 15:00 → 2026-11-13 16:30/.test(appliedCard?.choice?.receipt ?? '')
  && /新 2026-11-14 15:30 → 2026-11-14 17:00/.test(appliedCard?.choice?.receipt ?? '')
  ? 'PASS' : 'FAIL',
  appliedCard?.choice?.receipt ?? '');
const auditCount1 = auditRowsFor(state, card.message_id).length;
record('exactly one audit row links the card choice to the write',
  auditCount1 === 1 && auditRowsFor(state, card.message_id)[0].action === 'updated' ? 'PASS' : 'FAIL',
  'rows=' + auditCount1);
let retry = await api('/api/decision', { message_id: card.message_id, option_id: 'reschedule', confirm: true });
state = (await api('/api/state')).data;
record('a retried confirm is 409 (已应用 is terminal) and writes nothing again',
  retry.status === 409 && /已确认/.test(retry.error ?? '') && auditRowsFor(state, card.message_id).length === auditCount1
  && state.tasks.find(task => task.id === meetingId)?.revision === meetingAfter?.revision
  ? 'PASS' : 'FAIL',
  retry.error ?? ('rows=' + auditRowsFor(state, card.message_id).length));

// ---------------------------------------------------------------------------
console.log('\n2) 长期偏好更新：一次确认一次写入（修订链完整，回执=新记录）→ 重试 409');
const prefSave = await api('/api/memory-impact', {
  kind: 'preference', scope: 'DIC2026', body: '回复客户邮件用中文', replaces: null,
});
const pref = await api('/api/memory', {
  kind: 'preference', scope: 'DIC2026', body: '回复客户邮件用中文', source: '验收脚本',
  snapshot: prefSave.data.snapshot, review_base: null,
});
record('save the long-term preference', pref.ok ? 'PASS' : 'FAIL', pref.error ?? '');
if (!pref.ok) await cleanup(1);
state = (await api('/api/state')).data;
const anchorId = state.memory.find(item => item.body === '回复客户邮件用中文')?.id;
card = storeCard(state, detectDecision({
  question: '以后这个客户的邮件都用英文',
  review: { conflict: '长期偏好要求用中文回复客户，与新的英文请求冲突' },
  tasks: state.tasks, memories: state.memory, scope: 'DIC2026',
}), convId);
record('preference card detected and anchored',
  card.decision?.kind === 'preference' && card.decision?.anchor === anchorId ? 'PASS' : 'FAIL',
  'anchor=' + card.decision?.anchor + ' record=' + anchorId);
const memoryBefore2 = state.memory.length;
confirm = await api('/api/decision', { message_id: card.message_id, option_id: 'longterm', confirm: true });
state = (await api('/api/state')).data;
appliedCard = findCard(state, card.message_id);
const newRecord = memoryRowsFor(state, card.message_id)[0];
record('the confirm applies once and is 已应用',
  confirm.ok && appliedCard?.status === 'applied' && newRecord && newRecord.superseded === 0
  ? 'PASS' : 'FAIL',
  'status=' + appliedCard?.status + ' record=#' + (newRecord?.id ?? '?'));
record('exactly one memory row was written (no duplicate)',
  (state.memory.length - memoryBefore2) === 1 && newRecord?.replaces === anchorId
  ? 'PASS' : 'FAIL',
  'rows for card=' + memoryRowsFor(state, card.message_id).length + ' replaces=' + (newRecord?.replaces ?? null));
record('the receipt is the actual write result (revised anchor + new record)',
  /^本地长期偏好已更新 · 修订 #\d+ · 新记录 #\d+/.test(appliedCard?.choice?.receipt ?? '')
  && appliedCard?.choice?.receipt.endsWith('#' + newRecord.id)
  ? 'PASS' : 'FAIL',
  appliedCard?.choice?.receipt ?? '');
retry = await api('/api/decision', { message_id: card.message_id, option_id: 'longterm', confirm: true });
state = (await api('/api/state')).data;
record('a retried confirm is 409 and writes no second record',
  retry.status === 409 && memoryRowsFor(state, card.message_id).length === 1
  ? 'PASS' : 'FAIL',
  retry.error ?? ('rows=' + memoryRowsFor(state, card.message_id).length));

// ---------------------------------------------------------------------------
console.log('\n3a) 并发确认（双击/两个标签页）· 日历改期：一次有效变更 + 对应回执');
const meeting2 = await api('/api/task', {
  title: '交付评审', starts: '2026-11-13T10:00', ends: '2026-11-13T11:00',
  all_day: false, location: '', notes: '',
});
record('save a second meeting for the concurrency test', meeting2.ok ? 'PASS' : 'FAIL', meeting2.error ?? '');
state = (await api('/api/state')).data;
const meeting2Id = state.tasks.find(task => task.title === '交付评审')?.id;
card = storeCard(state, detectDecision({
  question: '交付评审挪到 2026-11-14 10:30。',
  review: { understood: '把交付评审改到 2026-11-14 10:30', conflict: '' },
  tasks: state.tasks, memories: state.memory, scope: 'DIC2026',
}), convId);
const revisionBefore3 = state.tasks.find(task => task.id === meeting2Id)?.revision;
const concurrent3 = await Promise.all([
  api('/api/decision', { message_id: card.message_id, option_id: 'reschedule', confirm: true }),
  api('/api/decision', { message_id: card.message_id, option_id: 'reschedule', confirm: true }),
]);
state = (await api('/api/state')).data;
appliedCard = findCard(state, card.message_id);
const meeting2After = state.tasks.find(task => task.id === meeting2Id);
const statuses3 = concurrent3.map(item => item.status).sort();
record('two simultaneous confirms: one applies, the other is 409 (no double write)',
  JSON.stringify(statuses3) === JSON.stringify([200, 409]) && appliedCard?.status === 'applied'
  ? 'PASS' : 'FAIL',
  'statuses=' + JSON.stringify(statuses3) + ' card=' + appliedCard?.status);
record('exactly one revision bump and one audit row for the card',
  (meeting2After?.revision ?? 0) === (revisionBefore3 ?? 0) + 1 && auditRowsFor(state, card.message_id).length === 1
  ? 'PASS' : 'FAIL',
  'revision ' + revisionBefore3 + ' → ' + (meeting2After?.revision ?? '?') + ' rows=' + auditRowsFor(state, card.message_id).length);
record('the receipt matches the single actual change',
  meeting2After?.starts === '2026-11-14T10:30' && meeting2After?.ends === '2026-11-14T11:30'
  && /本地日历已更新/.test(appliedCard?.choice?.receipt ?? '')
  && /新 2026-11-14 10:30 → 2026-11-14 11:30/.test(appliedCard?.choice?.receipt ?? '')
  ? 'PASS' : 'FAIL',
  appliedCard?.choice?.receipt ?? '');

console.log('\n3b) 并发确认（两个标签页）· 长期偏好更新：一次有效变更 + 对应回执');
const pref2Save = await api('/api/memory-impact', {
  kind: 'rule', scope: 'DIC2026', body: '周报使用数据看板模板', replaces: null,
});
const pref2 = await api('/api/memory', {
  kind: 'rule', scope: 'DIC2026', body: '周报使用数据看板模板', source: '验收脚本',
  snapshot: pref2Save.data.snapshot, review_base: null,
});
record('save a second preference (rule) for the concurrency test', pref2.ok ? 'PASS' : 'FAIL', pref2.error ?? '');
if (!pref2.ok) await cleanup(1);
state = (await api('/api/state')).data;
const anchor2Id = state.memory.find(item => item.body === '周报使用数据看板模板')?.id;
card = storeCard(state, detectDecision({
  question: '周报以后改用简报，不用数据看板了',
  review: { conflict: '长期规则要求周报用数据看板模板，与新的简报要求冲突' },
  tasks: state.tasks, memories: state.memory, scope: 'DIC2026',
}), convId);
record('the rule card anchors on the data-dashboard rule',
  card.decision?.kind === 'preference' && card.decision?.anchor === anchor2Id ? 'PASS' : 'FAIL',
  'anchor=' + card.decision?.anchor + ' record=' + anchor2Id);
const memoryCountBefore4 = state.memory.length;
const concurrent4 = await Promise.all([
  api('/api/decision', { message_id: card.message_id, option_id: 'longterm', confirm: true }),
  api('/api/decision', { message_id: card.message_id, option_id: 'longterm', confirm: true }),
]);
state = (await api('/api/state')).data;
appliedCard = findCard(state, card.message_id);
const newRecord4 = memoryRowsFor(state, card.message_id)[0];
const statuses4 = concurrent4.map(item => item.status).sort();
record('two simultaneous confirms: one applies, the other is 409 (no duplicate record)',
  JSON.stringify(statuses4) === JSON.stringify([200, 409]) && appliedCard?.status === 'applied'
  && (state.memory.length - memoryCountBefore4) === 1 && newRecord4?.replaces === anchor2Id
  ? 'PASS' : 'FAIL',
  'statuses=' + JSON.stringify(statuses4) + ' rows=' + memoryRowsFor(state, card.message_id).length);
record('the receipt is the single actual write (revised rule + new record)',
  /^本地长期偏好已更新 · 修订 #\d+ · 新记录 #\d+/.test(appliedCard?.choice?.receipt ?? '')
  && appliedCard?.choice?.receipt.endsWith('#' + newRecord4?.id)
  ? 'PASS' : 'FAIL',
  appliedCard?.choice?.receipt ?? '');

// ---------------------------------------------------------------------------
console.log('\n4a) 写入成功但回执保存失败 · 日历改期：从 task_audit 恢复回执，不重复写入');
const meeting3 = await api('/api/task', {
  title: '版本发布', starts: '2026-11-13T09:00', ends: '2026-11-13T10:00',
  all_day: false, location: '', notes: '',
});
record('save a third meeting for the receipt-loss test', meeting3.ok ? 'PASS' : 'FAIL', meeting3.error ?? '');
state = (await api('/api/state')).data;
const meeting3Id = state.tasks.find(task => task.title === '版本发布')?.id;
card = storeCard(state, detectDecision({
  question: '版本发布提前到 2026-11-12 14:00。',
  review: { understood: '把版本发布改到 2026-11-12 14:00', conflict: '' },
  tasks: state.tasks, memories: state.memory, scope: 'DIC2026',
}), convId);
// Simulate: the confirm's write committed through /api/task (audit row kept)
// but saving the receipt on the card failed — the card is still open.
const write3 = await api('/api/task', {
  id: meeting3Id, revision: state.tasks.find(task => task.id === meeting3Id).revision,
  title: '版本发布', starts: '2026-11-12T14:00', ends: '2026-11-12T15:00',
  memory_id: null, all_day: false, location: '', notes: '',
  via: { decision: card.message_id, option: 'reschedule', option_label: '改到 2026-11-12 14:00', at: new Date().toISOString() },
});
const lostReceiptCard = findCard((await api('/api/state')).data, card.message_id);
record('write committed through the real route, card receipt still missing',
  write3.ok && lostReceiptCard?.status !== 'applied' && lostReceiptCard?.choice == null
  && auditRowsFor((await api('/api/state')).data, card.message_id).length === 1
  ? 'PASS' : 'FAIL',
  'card status=' + lostReceiptCard?.status + ' audit rows=' + auditRowsFor((await api('/api/state')).data, card.message_id).length);
const revisionBefore4a = state.tasks.find(task => task.id === meeting3Id)?.revision;
confirm = await api('/api/decision', { message_id: card.message_id, option_id: 'reschedule', confirm: true });
state = (await api('/api/state')).data;
appliedCard = findCard(state, card.message_id);
const meeting3After = state.tasks.find(task => task.id === meeting3Id);
record('the next confirm recovers: 已应用, no second write',
  confirm.ok && appliedCard?.status === 'applied'
  && (meeting3After?.revision ?? 0) === revisionBefore4a + 1
  && auditRowsFor(state, card.message_id).length === 1
  ? 'PASS' : 'FAIL',
  'revision ' + revisionBefore4a + ' → ' + (meeting3After?.revision ?? '?') + ' rows=' + auditRowsFor(state, card.message_id).length);
record('the recovered receipt is the actual committed change',
  /本地日历已更新/.test(appliedCard?.choice?.receipt ?? '')
  && /原 2026-11-13 09:00 → 2026-11-13 10:00/.test(appliedCard?.choice?.receipt ?? '')
  && /新 2026-11-12 14:00 → 2026-11-12 15:00/.test(appliedCard?.choice?.receipt ?? '')
  ? 'PASS' : 'FAIL',
  appliedCard?.choice?.receipt ?? '');

console.log('\n4b) 写入成功但回执保存失败 · 长期偏好更新：从 memory 行恢复回执，不重复写入');
state = (await api('/api/state')).data;
const anchor4bSave = await api('/api/memory-impact', {
  kind: 'preference', scope: 'DIC2026', body: '会议记录同步到团队空间', replaces: null,
});
const anchor4bPref = await api('/api/memory', {
  kind: 'preference', scope: 'DIC2026', body: '会议记录同步到团队空间', source: '验收脚本',
  snapshot: anchor4bSave.data.snapshot, review_base: null,
});
record('save a preference for the receipt-loss test', anchor4bPref.ok ? 'PASS' : 'FAIL', anchor4bPref.error ?? '');
if (!anchor4bPref.ok) await cleanup(1);
state = (await api('/api/state')).data;
const anchor4b = state.memory.find(item => item.body === '会议记录同步到团队空间');
card = storeCard(state, buildDecision({
  kind: 'preference', title: '长期偏好冲突',
  current: '当前生效的长期偏好：#' + anchor4b.id + ' ' + anchor4b.body,
  reason: '长期偏好要求会议记录同步到团队空间，与新的本地保存要求冲突',
  proposal: '以后会议记录只存本地',
  records: [{ id: anchor4b.id, kind: anchor4b.kind, source: anchor4b.source, body: anchor4b.body }],
  anchor: anchor4b.id,
  options: [{ id: 'longterm', label: '更新长期偏好', effect: { kind: 'memory', payload: {
    kind: anchor4b.kind, scope: 'DIC2026', body: '以后会议记录只存本地',
    source: DECISION_MEMORY_SOURCE, replaces: anchor4b.id,
  } } }],
}), convId);
// Simulate the committed write (message_id + decision-card source kept) whose
// receipt save then failed: the card is still open.
const impact4b = await api('/api/memory-impact', {
  kind: anchor4b.kind, scope: 'DIC2026', body: '以后会议记录只存本地', replaces: anchor4b.id,
});
const memoryCountBefore4b = (await api('/api/state')).data.memory.length;
const lostWrite4b = await api('/api/memory', {
  kind: anchor4b.kind, scope: 'DIC2026', body: '以后会议记录只存本地',
  source: DECISION_MEMORY_SOURCE, replaces: anchor4b.id,
  snapshot: impact4b.data.snapshot, review_base: anchor4b.id, message_id: card.message_id,
});
record('write committed through the real route, card receipt still missing',
  lostWrite4b.ok && memoryRowsFor((await api('/api/state')).data, card.message_id).length === 1
  && findCard((await api('/api/state')).data, card.message_id)?.status !== 'applied'
  ? 'PASS' : 'FAIL',
  'rows=' + memoryRowsFor((await api('/api/state')).data, card.message_id).length);
confirm = await api('/api/decision', { message_id: card.message_id, option_id: 'longterm', confirm: true });
state = (await api('/api/state')).data;
appliedCard = findCard(state, card.message_id);
record('the next confirm recovers: 已应用, no second record',
  confirm.ok && appliedCard?.status === 'applied'
  && (state.memory.length - memoryCountBefore4b) === 1 && memoryRowsFor(state, card.message_id).length === 1
  ? 'PASS' : 'FAIL',
  'rows for card=' + memoryRowsFor(state, card.message_id).length);
record('the recovered receipt is the actual committed record',
  /^本地长期偏好已更新 · 修订 #\d+ · 新记录 #\d+/.test(appliedCard?.choice?.receipt ?? '')
  && appliedCard?.choice?.receipt.endsWith('#' + memoryRowsFor(state, card.message_id)[0].id)
  ? 'PASS' : 'FAIL',
  appliedCard?.choice?.receipt ?? '');

// ---------------------------------------------------------------------------
console.log('\n5) 旧卡因日历冲突暂缓：不写入，「当前实际生效」= 实际安排，重确认只写一次');
const meeting5 = await api('/api/task', {
  title: '方案评审', starts: '2026-11-13T13:00', ends: '2026-11-13T14:00',
  all_day: false, location: '', notes: '',
});
record('save a fourth meeting for the pause test', meeting5.ok ? 'PASS' : 'FAIL', meeting5.error ?? '');
state = (await api('/api/state')).data;
const meeting5Id = state.tasks.find(task => task.title === '方案评审')?.id;
card = storeCard(state, detectDecision({
  question: '方案评审改到 2026-11-14 09:00。',
  review: { understood: '把方案评审改到 2026-11-14 09:00', conflict: '' },
  tasks: state.tasks, memories: state.memory, scope: 'DIC2026',
}), convId);
// Another todo now occupies the proposed slot (calendar conflict).
const blocker = await api('/api/task', {
  title: '客户电话', starts: '2026-11-14T08:30', ends: '2026-11-14T09:30',
  all_day: false, location: '', notes: '',
});
record('a new todo occupies the proposed slot', blocker.ok ? 'PASS' : 'FAIL', blocker.error ?? '');
confirm = await api('/api/decision', { message_id: card.message_id, option_id: 'reschedule', confirm: true });
state = (await api('/api/state')).data;
appliedCard = findCard(state, card.message_id);
const meeting5After = state.tasks.find(task => task.id === meeting5Id);
record('the confirm is 暂缓: nothing written, card refreshed in place',
  confirm.ok && appliedCard?.status !== 'applied' && appliedCard?.recheck?.stale === true
  && /客户电话/.test(appliedCard?.recheck?.reason ?? '')
  && meeting5After?.starts === '2026-11-13T13:00' && auditRowsFor(state, card.message_id).length === 0
  ? 'PASS' : 'FAIL',
  appliedCard?.recheck?.reason ?? (confirm.error ?? ''));
record('the paused card states what is actually in force (live arrangement)',
  appliedCard?.current === '当前安排：方案评审 · 2026-11-13 13:00 → 2026-11-13 14:00' ? 'PASS' : 'FAIL',
  appliedCard?.current ?? '');
const followup5 = decisionContext(state.messages.filter(message => message.id === card.message_id));
record('a follow-up context line says 暂缓未生效 and the actually effective arrangement',
  followup5?.lines?.length === 1
  && /暂缓未生效/.test(followup5.lines[0])
  && /本地数据未变更，当前实际生效：当前安排：方案评审 · 2026-11-13 13:00 → 2026-11-13 14:00/.test(followup5.lines[0])
  ? 'PASS' : 'FAIL',
  followup5?.lines?.[0] ?? 'no line');
const alt5 = appliedCard?.options?.find(option => option.id === 'reschedule-alt');
record('the refreshed card offers a concrete free slot',
  alt5 && alt5.effect?.payload?.starts === '2026-11-14T09:30' && alt5.effect?.payload?.ends === '2026-11-14T10:30'
  && alt5.preview?.conflict === false
  ? 'PASS' : 'FAIL',
  alt5 ? alt5.label + ' conflict=' + alt5.preview?.conflict : 'no reschedule-alt option');
confirm = await api('/api/decision', { message_id: card.message_id, option_id: 'reschedule-alt', confirm: true });
state = (await api('/api/state')).data;
appliedCard = findCard(state, card.message_id);
const meeting5Final = state.tasks.find(task => task.id === meeting5Id);
record('re-confirming the new slot applies exactly once',
  confirm.ok && appliedCard?.status === 'applied' && appliedCard?.recheck == null
  && meeting5Final?.starts === '2026-11-14T09:30' && meeting5Final?.ends === '2026-11-14T10:30'
  && auditRowsFor(state, card.message_id).length === 1
  ? 'PASS' : 'FAIL',
  'meeting=' + (meeting5Final ? meeting5Final.starts + ' → ' + meeting5Final.ends : 'missing')
  + ' rows=' + auditRowsFor(state, card.message_id).length);
record('that receipt is the single actual change (the paused attempt left no record)',
  /本地日历已更新/.test(appliedCard?.choice?.receipt ?? '')
  && /新 2026-11-14 09:30 → 2026-11-14 10:30/.test(appliedCard?.choice?.receipt ?? '')
  ? 'PASS' : 'FAIL',
  appliedCard?.choice?.receipt ?? '');

// ---------------------------------------------------------------------------
console.log('\n6) 旧卡因规则修订暂缓：重锚定到现行版本，后续回答以实际生效偏好为准');
state = (await api('/api/state')).data;
// A fresh, deterministic rule anchor (the 周报 rule was superseded in 3b).
const rule6Save = await api('/api/memory-impact', {
  kind: 'rule', scope: 'DIC2026', body: '对外文档附中文摘要', replaces: null,
});
const rule6 = await api('/api/memory', {
  kind: 'rule', scope: 'DIC2026', body: '对外文档附中文摘要', source: '验收脚本',
  snapshot: rule6Save.data.snapshot, review_base: null,
});
record('save a rule for the revision-pause test', rule6.ok ? 'PASS' : 'FAIL', rule6.error ?? '');
if (!rule6.ok) await cleanup(1);
state = (await api('/api/state')).data;
const anchor6 = state.memory.find(item => item.body === '对外文档附中文摘要' && item.superseded === 0);
// The old card is generated against the rule while it is still valid.
const cardBody6 = '对外文档改附英文摘要';
card = storeCard(state, buildDecision({
  kind: 'preference', title: '长期偏好冲突',
  current: '当前生效的长期偏好：#' + anchor6.id + ' ' + anchor6.body,
  reason: '长期规则要求对外文档附中文摘要，与新的英文摘要要求冲突',
  proposal: cardBody6,
  records: [{ id: anchor6.id, kind: anchor6.kind, source: anchor6.source, body: anchor6.body }],
  anchor: anchor6.id,
  options: [
    { id: 'once', label: '仅本次',
      consequence: '该请求只在本对话中记为本次例外，长期偏好不变。',
      preview: { text: cardBody6 }, effect: { kind: 'temporary', payload: { text: cardBody6 } } },
    { id: 'longterm', label: '更新长期偏好',
      consequence: '将修订记录 #' + anchor6.id + '，新偏好长期生效。',
      preview: { replaces: anchor6.id, impact: [] },
      effect: { kind: 'memory', payload: {
        kind: 'rule', scope: 'DIC2026', body: cardBody6,
        source: DECISION_MEMORY_SOURCE, replaces: anchor6.id,
      } } },
  ],
}), convId);
record('an old card is generated against the 对外文档附中文摘要 rule',
  card.decision?.anchor === anchor6.id ? 'PASS' : 'FAIL',
  'anchor=' + card.decision?.anchor + ' record=' + (anchor6?.id ?? '?'));
// The rule is revised in the meantime (a later confirmed decision).
const impact6 = await api('/api/memory-impact', {
  kind: 'rule', scope: 'DIC2026', body: '对外文档附中文摘要（修订版）', replaces: anchor6.id,
});
const revision6 = await api('/api/memory', {
  kind: 'rule', scope: 'DIC2026', body: '对外文档附中文摘要（修订版）',
  source: '用户确认：修订对外文档摘要规则（验收脚本）', replaces: anchor6.id,
  snapshot: impact6.data.snapshot, review_base: anchor6.id,
});
record('the rule is revised later (successor supersedes the card anchor)',
  revision6.ok ? 'PASS' : 'FAIL', revision6.error ?? '');
if (!revision6.ok) await cleanup(1);
state = (await api('/api/state')).data;
const successor6 = state.memory.find(item => item.body === '对外文档附中文摘要（修订版）');
confirm = await api('/api/decision', { message_id: card.message_id, option_id: 'longterm', confirm: true });
state = (await api('/api/state')).data;
appliedCard = findCard(state, card.message_id);
record('confirming the old card is 暂缓 (anchor was revised), nothing written',
  confirm.ok && appliedCard?.status !== 'applied' && appliedCard?.recheck?.stale === true
  && /已被修订/.test(appliedCard?.recheck?.reason ?? '')
  && memoryRowsFor(state, card.message_id).length === 0
  ? 'PASS' : 'FAIL',
  appliedCard?.recheck?.reason ?? (confirm.error ?? ''));
record('the paused card states the actually effective rule (the successor)',
  appliedCard?.current === '当前生效的长期偏好：#' + successor6?.id + ' ' + successor6?.body
  ? 'PASS' : 'FAIL',
  appliedCard?.current ?? '');
const followup6 = decisionContext(state.messages.filter(message => message.id === card.message_id));
record('a follow-up context line says 暂缓未生效 and the actually effective preference',
  followup6?.lines?.length === 1
  && /暂缓未生效/.test(followup6.lines[0])
  && /当前实际生效：当前生效的长期偏好：#\d+ 对外文档附中文摘要（修订版）/.test(followup6.lines[0])
  ? 'PASS' : 'FAIL',
  followup6?.lines?.[0] ?? 'no line');
const reAnchored6 = appliedCard?.options?.find(option => option.id === 'longterm');
record('the refreshed card re-anchors on the valid successor',
  reAnchored6?.effect?.payload?.replaces === successor6?.id ? 'PASS' : 'FAIL',
  'replaces=' + reAnchored6?.effect?.payload?.replaces + ' successor=' + (successor6?.id ?? '?'));
const memoryCountBefore6 = state.memory.length;
confirm = await api('/api/decision', { message_id: card.message_id, option_id: 'longterm', confirm: true });
state = (await api('/api/state')).data;
appliedCard = findCard(state, card.message_id);
const finalRecord6 = memoryRowsFor(state, card.message_id)[0];
record('re-confirmation applies exactly once, revising the successor',
  confirm.ok && appliedCard?.status === 'applied'
  && (state.memory.length - memoryCountBefore6) === 1
  && finalRecord6?.replaces === successor6?.id && finalRecord6?.superseded === 0
  ? 'PASS' : 'FAIL',
  confirm.error ?? ('record=#' + (finalRecord6?.id ?? '?') + ' replaces=' + (finalRecord6?.replaces ?? '?')));

// ---------------------------------------------------------------------------
console.log('\n7) 失败状态：写入报错 = 确认失败（无写入），卡片仍可用其他选项');
state = (await api('/api/state')).data;
const meeting7 = state.tasks.find(task => task.title === '客户会议');
// A hand-built card whose task effect carries an invalid time window: the
// recheck passes (state unchanged) but the write itself is rejected.
const badCard = storeCard(state, buildDecision({
  kind: 'reschedule', title: '确认改期 "客户会议"',
  current: '当前安排：' + meeting7.title + ' · ' + meeting7.starts + ' → ' + meeting7.ends,
  reason: '用户提到了新的时间，请确认是否调整安排。',
  records: [],
  options: [
    { id: 'reschedule', label: '改到 2026-11-15 15:30',
      effect: { kind: 'task', payload: {
        id: meeting7.id, revision: meeting7.revision, title: meeting7.title,
        starts: '2026-11-15T15:30', ends: '2026-11-15T14:00', // invalid: ends before starts
        memory_id: null, all_day: false, location: meeting7.location, notes: meeting7.notes,
      } } },
    { id: 'keep', label: '保持原时间', effect: { kind: 'view', payload: { calendar: '2026-11-15' } } },
  ],
}), convId);
const revisionBefore7 = meeting7.revision;
confirm = await api('/api/decision', { message_id: badCard.message_id, option_id: 'reschedule', confirm: true });
state = (await api('/api/state')).data;
appliedCard = findCard(state, badCard.message_id);
record('a rejected write is 确认失败: card records the error, nothing written',
  confirm.ok && appliedCard?.status === 'failed'
  && appliedCard?.choice?.option_id === 'reschedule'
  && /请选择有效的开始和结束时间/.test(appliedCard?.choice?.receipt ?? '')
  && state.tasks.find(task => task.id === meeting7.id)?.revision === revisionBefore7
  && auditRowsFor(state, badCard.message_id).length === 0
  ? 'PASS' : 'FAIL',
  'status=' + appliedCard?.status + ' receipt=' + (appliedCard?.choice?.receipt ?? ''));
const followup7 = decisionContext(state.messages.filter(message => message.id === badCard.message_id));
record('a follow-up context line says 确认失败 and that local data is unchanged',
  followup7?.lines?.length === 1 && /确认失败（本地数据未变更）/.test(followup7.lines[0])
  ? 'PASS' : 'FAIL',
  followup7?.lines?.[0] ?? 'no line');
confirm = await api('/api/decision', { message_id: badCard.message_id, option_id: 'keep', confirm: true });
state = (await api('/api/state')).data;
appliedCard = findCard(state, badCard.message_id);
record('the failed card stays usable: another option confirms normally',
  confirm.ok && appliedCard?.status === 'applied'
  && appliedCard?.choice?.option_id === 'keep'
  && appliedCard?.choice?.receipt === '已确认查看，本地数据未变更'
  ? 'PASS' : 'FAIL',
  'status=' + appliedCard?.status + ' receipt=' + (appliedCard?.choice?.receipt ?? ''));

const summary = {
  at: new Date().toISOString(),
  results,
  summary: { passed: passed(), failed: failed() },
  serverLog: serverLog.slice(-2000),
};
console.log('\nSummary: ' + passed() + ' passed, ' + failed() + ' failed\n' + JSON.stringify(summary, null, 2));
await cleanup(failed() ? 1 : 0);
