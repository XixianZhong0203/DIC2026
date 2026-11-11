// Acceptance flow for the decision card "confirm-time recheck" (确认时重查).
//
//   原约定周五 → 客户提出周二 → 卡片预览周二空档 → 另一条待办占了周二 →
//   点旧卡确认时提示冲突，原安排保留 → 选新时间并确认本地更新。
//   另测：旧偏好卡遇到已修订的记忆时要求重新确认（重锚定后再次确认成功）。
//
//   node scripts/decision-recheck-acceptance.mjs
//
// The script starts a fresh server (temporary data dir, dedicated port) and
// drives the real /api/task, /api/memory(-impact) and /api/decision routes.
// No model is needed: the decision card is produced by the same
// detectDecision the chat pipeline uses, stored on an assistant message the
// way the pipeline does, and the confirm-time recheck runs in /api/decision.

import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDecision } from '../src/decision/decision.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4198;
const base = 'http://127.0.0.1:' + port;

const dataDir = await mkdtemp(path.join(tmpdir(), 'daymark-decision-acceptance-'));
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
  try {
    up = (await fetch(base + '/api/state')).ok;
  } catch {
    if (server.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
if (!up) {
  console.log('FAIL  server did not start\n' + serverLog);
  await cleanup(1);
}

// ---------------------------------------------------------------------------
console.log('\n1) Seed: 原约定周五（客户会议 2026-11-13 15:00→16:30）');
const conv = await api('/api/conversation', {});
if (!conv.ok) { record('create a conversation', 'FAIL', conv.error ?? ''); await cleanup(1); }
record('create a conversation', 'PASS');
const friday = await api('/api/task', {
  title: '客户会议', starts: '2026-11-13T15:00', ends: '2026-11-13T16:30',
  all_day: false, location: '', notes: '',
});
record('save the confirmed Friday meeting', friday.ok ? 'PASS' : 'FAIL', friday.error ?? '');
if (!friday.ok) await cleanup(1);

// Store an assistant message carrying the decision card, exactly the way the
// chat pipeline persists detectDecision output (review.decision).
function storeCard({ question, review, tasks, memories, scope }) {
  const decision = detectDecision({ question, review, tasks, memories, scope });
  const db = new DatabaseSync(path.join(dataDir, 'daymark.sqlite'));
  db.prepare('INSERT INTO messages(role, body, review, conversation_id) VALUES (?, ?, ?, ?)')
    .run('assistant', '请确认卡片中的选项。', JSON.stringify({
      answer: '请确认卡片中的选项。', conflict: review.conflict ?? '', understood: review.understood ?? '',
      decision,
    }), conv.data.conversation);
  const id = Number(db.prepare('SELECT id FROM messages ORDER BY id DESC LIMIT 1').get().id);
  db.close();
  return { decision, message_id: id };
}
const findCard = (state, message_id) =>
  (state.messages ?? []).find(message => message.id === message_id)?.review?.decision ?? null;

// ---------------------------------------------------------------------------
console.log('\n2) 客户提出周二 → 卡片预览周二空档');
let state = (await api('/api/state')).data;
const rescheduleCard = storeCard({
  question: '客户来信：会议想从周五改到 2026-11-17 15:30。',
  review: { understood: '把客户会议改到 2026-11-17 15:30', conflict: '' },
  tasks: state.tasks, memories: state.memory, scope: 'DIC2026',
});
let change = rescheduleCard.decision?.options?.find(option => option.id === 'reschedule') ?? null;
record('card offers the Tuesday slot with a conflict-free preview',
  rescheduleCard.decision?.kind === 'reschedule' && change?.preview.conflict === false ? 'PASS' : 'FAIL',
  change ? JSON.stringify({ starts: change.effect.payload.starts, conflict: change.preview.conflict }) : 'no reschedule option');
if (!change) await cleanup(1);

// ---------------------------------------------------------------------------
console.log('\n3) 另一条待办占了周二 → 点旧卡确认时提示冲突，原安排保留');
const tuesday = await api('/api/task', {
  title: '周二评审', starts: '2026-11-17T15:00', ends: '2026-11-17T16:00',
  all_day: false, location: '', notes: '',
});
record('another todo now occupies Tuesday 15:00→16:00', tuesday.ok ? 'PASS' : 'FAIL', tuesday.error ?? '');
if (!tuesday.ok) await cleanup(1);

let card = findCard((await api('/api/state')).data, rescheduleCard.message_id);
let confirm = await api('/api/decision', { message_id: rescheduleCard.message_id, option_id: 'reschedule', confirm: true });
card = findCard((await api('/api/state')).data, rescheduleCard.message_id);
let meeting = (await api('/api/state')).data.tasks.find(task => task.title === '客户会议');
record('confirming the stale card is paused with a specific reason',
  confirm.ok && card?.recheck?.stale === true && /周二评审/.test(card.recheck.reason) ? 'PASS' : 'FAIL',
  card?.recheck?.reason ?? (confirm.error ?? ''));
record('no write happened: the original Friday meeting is preserved',
  meeting?.starts === '2026-11-13T15:00' && meeting?.ends === '2026-11-13T16:30' && card?.status !== 'applied'
    ? 'PASS' : 'FAIL',
  meeting ? meeting.starts + ' → ' + meeting.ends + ' (status=' + card?.status + ')' : 'meeting gone');
let alt = card?.options?.find(option => option.id === 'reschedule-alt') ?? null;
record('the card is refreshed in place with updated options',
  alt && /2026-11-17T16:00/.test(alt.effect.payload.starts) && card.options.some(option => option.id === 'calendar')
    ? 'PASS' : 'FAIL',
  alt ? alt.label : 'no reschedule-alt option');
if (!alt) await cleanup(1);

// ---------------------------------------------------------------------------
console.log('\n4) 选新时间并确认 → 本地日历已更新');
confirm = await api('/api/decision', { message_id: rescheduleCard.message_id, option_id: 'reschedule-alt', confirm: true });
state = (await api('/api/state')).data;
card = findCard(state, rescheduleCard.message_id);
meeting = state.tasks.find(task => task.title === '客户会议');
record('confirming the new slot applies the local write',
  confirm.ok && card?.status === 'applied' && meeting?.starts === '2026-11-17T16:00' && meeting?.ends === '2026-11-17T17:30'
    ? 'PASS' : 'FAIL',
  confirm.error ?? (meeting ? meeting.starts + ' → ' + meeting.ends : 'meeting missing'));
record('the receipt says the local calendar was updated (not a customer confirmation)',
  /^本地日历已更新/.test(card?.choice?.receipt ?? '') && !/客户已确认/.test(card?.choice?.receipt ?? '')
    ? 'PASS' : 'FAIL',
  card?.choice?.receipt ?? '');
record('the unrelated Tuesday todo is untouched',
  state.tasks.some(task => task.title === '周二评审' && task.starts === '2026-11-17T15:00') ? 'PASS' : 'FAIL');

// ---------------------------------------------------------------------------
console.log('\n5) 旧偏好卡遇到已修订的记忆 → 要求重新确认');
const preferenceSave = (await api('/api/memory-impact', {
  kind: 'preference', scope: 'DIC2026', body: '回复客户邮件用中文', replaces: null,
})).data;
const preference = await api('/api/memory', {
  kind: 'preference', scope: 'DIC2026', body: '回复客户邮件用中文', source: '验收脚本',
  snapshot: preferenceSave.snapshot, review_base: null,
});
record('save the long-term preference', preference.ok ? 'PASS' : 'FAIL', preference.error ?? '');
if (!preference.ok) await cleanup(1);
state = (await api('/api/state')).data;
const prefId = state.memory.find(item => item.body === '回复客户邮件用中文')?.id;
const prefCard = storeCard({
  question: '以后这个客户的邮件都用英文',
  review: { conflict: '长期偏好要求用中文回复客户，与新的英文请求冲突' },
  tasks: state.tasks, memories: state.memory, scope: 'DIC2026',
});
record('the preference card anchors on the current record',
  prefCard.decision?.kind === 'preference' && prefCard.decision.anchor === prefId
    ? 'PASS' : 'FAIL',
  'anchor=' + prefCard.decision?.anchor + ' record=' + prefId);
if (prefCard.decision?.anchor !== prefId) await cleanup(1);

// The preference is revised in the meantime (a later confirmed decision).
const impact = await api('/api/memory-impact', {
  kind: 'preference', scope: 'DIC2026', body: '回复客户邮件用英文', replaces: prefId,
});
const revised = await api('/api/memory', {
  kind: 'preference', scope: 'DIC2026', body: '回复客户邮件用英文',
  source: '用户确认：改为英文（验收脚本）', replaces: prefId,
  snapshot: impact.data.snapshot, review_base: prefId,
});
record('the preference is revised later (record #N supersedes the card anchor)',
  revised.ok ? 'PASS' : 'FAIL', revised.error ?? '');
if (!revised.ok) await cleanup(1);
let after = (await api('/api/state')).data;
const revisedId = after.memory.find(item => item.body === '回复客户邮件用英文')?.id;

confirm = await api('/api/decision', {
  message_id: prefCard.message_id, option_id: 'longterm', confirm: true,
});
card = findCard((await api('/api/state')).data, prefCard.message_id);
record('confirming the old preference card is paused (anchor was revised)',
  confirm.ok && card?.status !== 'applied' && card?.recheck?.stale === true && /已被修订/.test(card.recheck.reason)
    ? 'PASS' : 'FAIL',
  card?.recheck?.reason ?? (confirm.error ?? ''));
record('the refreshed card re-anchors on the valid successor',
  card?.options?.find(option => option.id === 'longterm')?.effect.payload.replaces === revisedId
    ? 'PASS' : 'FAIL',
  'replaces=' + card?.options?.find(option => option.id === 'longterm')?.effect.payload.replaces + ' successor=' + revisedId);

confirm = await api('/api/decision', {
  message_id: prefCard.message_id, option_id: 'longterm', confirm: true,
});
after = (await api('/api/state')).data;
card = findCard(after, prefCard.message_id);
const finalRecord = after.memory.find(item => item.message_id === prefCard.message_id);
record('re-confirmation on the re-anchored card applies',
  confirm.ok && card?.status === 'applied' && finalRecord && finalRecord.superseded === 0
    ? 'PASS' : 'FAIL',
  confirm.error ?? ('record #' + (finalRecord?.id ?? '?') + ' active=' + finalRecord?.superseded === 0));
record('the receipt says the local long-term preference was updated',
  /^本地长期偏好已更新/.test(card?.choice?.receipt ?? '') ? 'PASS' : 'FAIL',
  card?.choice?.receipt ?? '');
record('the superseded chain is intact (original revised → successor revised → new record)',
  after.memory.find(item => item.id === prefId)?.superseded === 1
    && after.memory.find(item => item.id === revisedId)?.superseded === 1
    && finalRecord?.replaces === revisedId ? 'PASS' : 'FAIL');

const summary = {
  at: new Date().toISOString(),
  results,
  summary: { passed: passed(), failed: failed() },
  serverLog: serverLog.slice(-2000),
};
console.log('\nSummary: ' + passed() + ' passed, ' + failed() + ' failed\n' + JSON.stringify(summary, null, 2));
await cleanup(failed() ? 1 : 0);
