// Acceptance flow for long-term memory save + conflict handling.
//
//   save 「默认英文、周五交付」 → new chat in the same project →
//   「这次用中文」 must NOT change the default preference →
//   a customer proposing Tuesday must NOT auto-reschedule or auto-save →
//   after the owner accepts, a new conversation retrieves the accepted rule
//   (with its original confirmation text) → scoped retrieval across projects
//   → send-like operations keep checking the current authorization.
//
//   node scripts/memory-acceptance.mjs
//
// The script starts a fresh server (temporary data dir, dedicated port) with
// the same .env as `npm start`. The deterministic API steps always run. The
// chat steps need a live model; when the model is unavailable they are
// reported as SKIPPED and the acceptance story is still verified through the
// deterministic save/review/replace routes. The full trace is written to
// docs/evidence/memory-acceptance-<timestamp>.json.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordsInScope } from '../src/memory/memory-impact.mjs';
import { GLOBAL_SCOPE } from '../src/policy/policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4197;
const base = 'http://127.0.0.1:' + port;
const PROJECT = 'DIC2026';
const OTHER_PROJECT = 'Beta';

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
const passed = () => results.filter(item => item.status === 'PASS').length;
const skipped = () => results.filter(item => item.status === 'SKIPPED').length;
const failed = () => results.filter(item => item.status === 'FAIL').length;

// Save a preference/rule through the existing pre-save review route
// (/api/memory-impact snapshot bound to /api/memory).
async function saveThroughReview(kind, scope, body, source, replaces = null) {
  const impact = await api('/api/memory-impact', { kind, scope, body, replaces });
  if (!impact.ok) return impact;
  // review_base must echo the replaces the snapshot was computed with.
  return api('/api/memory', { kind, scope, body, source, replaces,
    snapshot: impact.data.snapshot, review_base: replaces });
}

const memoryRows = data => (data.memory ?? []).map(record => ({
  id: record.id, kind: record.kind, scope: record.scope, body: record.body,
  superseded: record.superseded, replaces: record.replaces,
}));
const sameMemory = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const findMemory = (data, body) => (data.memory ?? []).find(item => item.body === body);

const englishBody = '默认英文：对外沟通默认用英文。';
const fridayBody = '周五交付：每周五向客户交付周报。';
const tuesdayBody = '周二交付：每周二向客户交付周报。';
const tuesdayProposal = '客户提议：交付从每周五改为每周二。';
const acceptSource = '用户确认：同意改到每周二交付（客户提议已接受）';

const dataDir = await mkdtemp(path.join(tmpdir(), 'daymark-acceptance-'));
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

const state0 = await api('/api/state');
const modelLive = Boolean(state0.data.live);
console.log('\nAcceptance: memory save + conflict handling' +
  (modelLive ? '\n  model: configured (chat steps run if reachable)' : '\n  model: not configured (chat steps will be SKIPPED)'));

console.log('\n1) Save through the pre-save review route');
let save = await saveThroughReview('preference', PROJECT, englishBody, '用户确认的长期偏好');
record('save 「默认英文」 preference (impact snapshot → memory)', save.ok ? 'PASS' : 'FAIL', save.error ?? '');
save = await saveThroughReview('rule', PROJECT, fridayBody, '用户确认的交付规则');
record('save 「周五交付」 rule (impact snapshot → memory)', save.ok ? 'PASS' : 'FAIL', save.error ?? '');
const stateAfterSave = (await api('/api/state')).data;
const fridayId = findMemory(stateAfterSave, fridayBody)?.id;
if (!save.ok || fridayId == null) await cleanup(1);

console.log('\n2) Scoped retrieval: project isolation + global visibility');
save = await api('/api/memory', { kind: 'fact', scope: OTHER_PROJECT, body: OTHER_PROJECT + ' 项目的交付窗口是周三。', source: '验收脚本' });
record('save a record in another project scope', save.ok ? 'PASS' : 'FAIL', save.error ?? '');
save = await saveThroughReview('preference', GLOBAL_SCOPE, '所有项目的对外文档附中文摘要。', '用户确认的全局偏好');
record('save a global (*) preference', save.ok ? 'PASS' : 'FAIL', save.error ?? '');
{
  const state = (await api('/api/state')).data;
  const active = (state.memory ?? []).filter(record => !record.superseded);
  const betaVisible = recordsInScope(active, OTHER_PROJECT);
  const projectVisible = recordsInScope(active, PROJECT);
  record('new-project view excludes other projects\' records',
    betaVisible.every(record => record.scope === OTHER_PROJECT || record.scope === GLOBAL_SCOPE) ? 'PASS' : 'FAIL');
  record('global records are visible in every project',
    betaVisible.some(record => record.scope === GLOBAL_SCOPE) ? 'PASS' : 'FAIL');
  record('project view includes its own records, not other projects\'',
    projectVisible.some(record => record.scope === PROJECT) &&
    projectVisible.every(record => record.scope !== OTHER_PROJECT) ? 'PASS' : 'FAIL');
  record('all four saved records are active in the shared store',
    active.length === 4 ? 'PASS' : 'FAIL', 'active=' + active.length);
}

console.log('\n3) Send-like operations keep checking the current authorization');
{
  const lead = await api('/api/opportunity', {
    kind: 'lead', title: '验收脚本线索', source: '验收脚本', evidence: '客户希望接入新数据源。',
  });
  const item = (lead.data.opportunities ?? [])[0];
  if (!lead.ok || !item) record('create an opportunity for the send check', 'FAIL', lead.error ?? 'no opportunity');
  else {
    const draft = await api('/api/opportunity-draft', { id: item.id, recipient: 'client@example.com', body: '您好，关于新数据源的接入。' });
    const draftId = (draft.data.opportunities ?? [])[0]?.draft_id;
    // 复核与真实界面一致：绑定当前草稿版本（review form carries the current
    // draft id）。未绑定草稿版本的复核不能放行发送（send gate 按现行规则校验），
    // 该期望在 review-draft 绑定规则并入 main 后更新（264aef5 早于 993f91e）。
    const reviewed = await api('/api/opportunity-review', { id: item.id, analysis_id: null, draft_id: draftId, resolution: '人工核对：收件人与内容无误。' });
    if (!draft.ok || !reviewed.ok || !draftId) {
      record('send allowed while delegation is per-approval (draft + human review present)', 'FAIL',
        draft.error ?? reviewed.error ?? 'no draft id');
    } else {
      const sent = await api('/api/opportunity-send', { id: item.id, draft_id: draftId });
      record('send allowed while delegation is per-approval (draft + human review present)',
        sent.ok ? 'PASS' : 'FAIL', sent.error ?? '');
      const human = await api('/api/delegation', { action: 'send', mode: 'human' });
      record('switch send delegation to human-only', human.ok ? 'PASS' : 'FAIL', human.error ?? '');
      const blocked = await api('/api/opportunity-send', { id: item.id, draft_id: draftId });
      record('send is blocked once delegation is human-only',
        blocked.status === 409 && blocked.error === '当前授权不允许此操作。' ? 'PASS' : 'FAIL',
        blocked.error ?? ('status ' + blocked.status));
    }
  }
}

console.log('\n4) Cross-conversation chat story');
// The chat steps need a reachable model. `live` only means configured: a
// local endpoint without a running model still reports live=true, so the
// first real chat call decides what the chat steps become (PASS/FAIL/SKIPPED).
let modelUsable = modelLive;
const modelFailure = result => {
  if (result.ok) return false;
  const isModelError = /模型/.test(result.error ?? '');
  if (isModelError) modelUsable = false;
  return isModelError;
};

let chatA = null;
let lastUser = null;
if (!modelLive) {
  record('「这次用中文」 leaves the saved preference unchanged', 'SKIPPED', 'model not configured');
  record('customer Tuesday proposal does not auto-reschedule or auto-save', 'SKIPPED', 'model not configured');
  record('a new conversation retrieves the accepted rule + confirmation text', 'SKIPPED', 'model not configured');
} else {
  const conv = await api('/api/conversation', {});
  chatA = conv.data.conversation;
  const before = memoryRows((await api('/api/state')).data);

  const reply1 = await api('/api/chat', { text: '这次用中文回复我。', language: 'zh-CN', conversation_id: chatA });
  if (!reply1.ok) {
    if (modelFailure(reply1)) {
      record('「这次用中文」 leaves the saved preference unchanged', 'SKIPPED', reply1.error);
      record('customer Tuesday proposal does not auto-reschedule or auto-save', 'SKIPPED', 'model unreachable');
    } else {
      record('「这次用中文」 leaves the saved preference unchanged', 'FAIL', reply1.error ?? '');
    }
  } else {
    const after = memoryRows((await api('/api/state')).data);
    record('「这次用中文」 is a one-turn exception: long-term memory unchanged',
      sameMemory(before, after) ? 'PASS' : 'FAIL',
      sameMemory(before, after) ? 'no record created or revised' : 'memory rows changed');

    const reply2 = await api('/api/chat', {
      text: '客户来信：想把交付从周五改到每周二，帮我确认一下。', language: 'zh-CN', conversation_id: chatA,
    });
    if (!reply2.ok) {
      if (modelFailure(reply2)) record('customer Tuesday proposal does not auto-reschedule or auto-save', 'SKIPPED', reply2.error);
      else record('customer Tuesday proposal does not auto-reschedule or auto-save', 'FAIL', reply2.error ?? '');
    } else {
      const after = (await api('/api/state')).data;
      const afterRows = memoryRows(after);
      const fridayStill = findMemory(after, fridayBody)?.superseded === 0;
      record('customer Tuesday proposal does not auto-reschedule or auto-save',
        sameMemory(before, afterRows) && fridayStill ? 'PASS' : 'FAIL',
        'memory unchanged=' + sameMemory(before, afterRows) + ' friday active=' + fridayStill);
      const messages = (after.messages ?? []).filter(message => message.conversation_id === chatA);
      const proposal = messages.filter(message => message.role === 'assistant').pop()?.review?.proposal ?? null;
      if (!proposal) {
        record('save the Tuesday proposal as an unconfirmed proposal', 'SKIPPED', 'model reply did not carry a proposal field');
      } else {
        const saved = await api('/api/memory', {
          kind: 'proposal', scope: PROJECT, body: proposal.body,
          source: '项目对话 #' + (messages.filter(message => message.role === 'user').pop()?.id ?? ''),
          message_id: proposal.message_id ?? null,
        });
        const stillActive = (await api('/api/state')).data;
        const fridayStillAfter = findMemory(stillActive, fridayBody)?.superseded === 0;
        record('save the Tuesday proposal as an unconfirmed proposal; the Friday rule stays valid',
          saved.ok && fridayStillAfter ? 'PASS' : 'FAIL', saved.error ?? ('proposal: ' + proposal.body));
      }
      lastUser = messages.filter(message => message.role === 'user').at(-1) ?? null;
    }
  }
}

// Acceptance goes through the same API the memory form uses, with or without
// a model: the owner's explicit save revises the old rule and the change is
// logged in memory_decisions. With a model, the accepting chat message is linked.
const accept = await (async () => {
  const impact = await api('/api/memory-impact', { kind: 'rule', scope: PROJECT, body: tuesdayBody, replaces: fridayId });
  if (!impact.ok) return impact;
  return api('/api/memory', { kind: 'rule', scope: PROJECT, body: tuesdayBody, source: acceptSource,
    replaces: fridayId, snapshot: impact.data.snapshot, review_base: fridayId, message_id: lastUser?.id ?? null });
})();
if (!accept.ok) record('accepting the proposal replaces the old rule with a change record', 'FAIL', accept.error ?? '');
else {
  const after = (await api('/api/state')).data;
  const friday = findMemory(after, fridayBody);
  const tuesday = findMemory(after, tuesdayBody);
  const decisionRow = (after.memoryDecisions ?? []).find(row => {
    const detail = JSON.parse(row.detail);
    return detail.action === 'replace' && detail.replaced === fridayId;
  });
  record('accepting the proposal replaces the old rule with a change record',
    friday?.superseded === 1 && tuesday?.superseded === 0 && decisionRow ? 'PASS' : 'FAIL',
    'friday superseded=' + friday?.superseded + ' tuesday active=' + (tuesday?.superseded === 0) +
    ' decision log=' + Boolean(decisionRow));
  record('the accepted rule keeps the original confirmation text' +
    (lastUser ? ' and links the accepting message' : ' (message link needs a chat, skipped without a model)'),
    tuesday?.source === acceptSource && (!lastUser || tuesday?.message_id === lastUser?.id) ? 'PASS' : 'FAIL',
    'source=' + JSON.stringify(tuesday?.source) + ' message_id=' + tuesday?.message_id +
    (lastUser ? ' (accepting message #' + lastUser.id + ')' : ''));
}

if (modelLive) {
  if (modelUsable && chatA) {
    const reply3 = await api('/api/chat', {
      text: '现在默认用什么语言？交付安排是什么？', language: 'zh-CN',
    });
    if (!reply3.ok) {
      if (modelFailure(reply3)) record('a new conversation retrieves the accepted rule + confirmation text', 'SKIPPED', reply3.error);
      else record('a new conversation retrieves the accepted rule + confirmation text', 'FAIL', reply3.error ?? '');
    } else {
      const messages = (reply3.data.messages ?? []).filter(message => message.conversation_id === reply3.data.conversation);
      const answer = messages.filter(message => message.role === 'assistant').pop()?.body ?? '';
      record('a new conversation retrieves the accepted rule + confirmation text',
        answer.includes('周二') && answer.includes('英文') ? 'PASS' : 'FAIL',
        'reply: ' + answer.slice(0, 120).replace(/\s+/g, ' '));
    }
  } else {
    record('a new conversation retrieves the accepted rule + confirmation text', 'SKIPPED', 'model unreachable');
  }
}

const summary = {
  at: new Date().toISOString(), modelLive,
  results, summary: { passed: passed(), skipped: skipped(), failed: failed() },
  serverLog: serverLog.slice(-2000),
};
const evidenceDir = path.join(root, 'docs', 'evidence');
await mkdir(evidenceDir, { recursive: true });
const traceFile = path.join(evidenceDir, 'memory-acceptance-' + Date.now() + '.json');
await writeFile(traceFile, JSON.stringify(summary, null, 2));
console.log('\nSummary: ' + passed() + ' passed, ' + skipped() + ' skipped, ' + failed() + ' failed · trace: ' + traceFile);
await cleanup(failed() ? 1 : 0);
