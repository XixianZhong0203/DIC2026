// 客户交付确认流程 · 端到端验收（integration/2026-11-11 集成分支）
//
// 一条完整客户故事，覆盖本集成的四个验收维度：
//   1) 工作区隔离 —— 客户 A 已有周五交付约定；切到客户 B 再切回 A，核对聊天
//      用的是正确项目的资料；跨工作区合并旧聊天被系统提示拒绝；明确导入一条
//      资料时，副本带原工作区出处。
//   2) 决策确认与回执 —— 客户 A 提出改期：卡片展示原约定、新提议和可选时段；
//      确认后回执给出实际改了什么；客户是否同意单独表达（未确认提议记录），
//      回执不声称客户已确认。
//   3) 线索回答与草稿门槛 —— 草稿写「客户已确认改期」而资料只有提议/转述时：
//      界面指出哪句缺依据、能确认什么、下一步；发送接口拦截。
//   4) 人工复核与回执 —— 补入明确客户确认后重新核查；展开其中一条来源走人工
//      复核路径，审计只记录这条；批准当前草稿并模拟发送，核对回执；复核后新
//      增撤回记录，旧复核随来源变化失效，当前回答转为来源冲突。
//
//   node scripts/customer-delivery-acceptance.mjs            # 全部断言
//   node scripts/customer-delivery-acceptance.mjs --shots    # 附加浏览器截图（需本机 Chrome）
//
// 与既有验收脚本同一手法：临时数据目录 + 专用端口启动真实服务，模型请求打到
// 本地确定性 mock（记录每个请求，用于隔离断言）。关键界面状态用真实 UI 模块
// （dist/opportunity-ui.js + 最小假 DOM）渲染并断言文字。trace 与截图写入
// docs/evidence/（本地留档，不进版本库）。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createOpportunityUI } from '../dist/opportunity-ui.js';
import { translate } from '../dist/i18n.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4203;
const mockPort = 4204;
const cdpPort = 4399;
const base = 'http://127.0.0.1:' + port;
const A = '客户 A';
const B = '客户 B';
const wantShots = process.argv.includes('--shots');

const A_FACT = '交付约定：2026-11-13 周五 15:00 向客户 A 交付版本（双方已确认）。';
const A_PROMISE = '客户承诺：客户 A 承诺 11 月 30 日前完成签约。';

// ---------------------------------------------------------------------------
// 结果记录
// ---------------------------------------------------------------------------
const results = [];
function record(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log('  ' + status + '  ' + name + (detail ? '  · ' + detail : ''));
}
const passed = () => results.filter(r => r.status === 'PASS').length;
const failed = () => results.filter(r => r.status === 'FAIL').length;
const skipped = () => results.filter(r => r.status === 'SKIPPED').length;

// ---------------------------------------------------------------------------
// 确定性 mock 模型：记录每个请求（隔离断言打在这里），按请求类型从对应队列取
// 预设回答。队列顺序即流程顺序，多取/错取都会让后续断言失败。
// ---------------------------------------------------------------------------
const modelRequests = [];
const chatQ = [];
const assessQ = [];
const analysisQ = [];
const draftQ = [];
function take(queue, label) {
  const next = queue.shift();
  if (!next) {
    record('model queue ' + label, 'FAIL', 'unexpected request: ' + label);
    return { answer: '（模拟模型）队列意外。', facts: [], inferences: [], unknowns: [], citations: [], conflict: '', proposal: null, question: '', understood: '' };
  }
  if (next.expect) record('model request ' + label, 'PASS', next.expect);
  return next.value;
}
const mock = createServer((req, res) => {
  let payload = '';
  req.on('data', chunk => { payload += chunk; });
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url?.includes('chat/completions')) {
      res.statusCode = 404; res.end('not found'); return;
    }
    const parsed = JSON.parse(payload);
    modelRequests.push(parsed);
    const system = (parsed.messages ?? []).find(m => m.role === 'system')?.content ?? '';
    const user = (parsed.messages ?? []).find(m => m.role === 'user')?.content ?? '';
    let canned;
    if (system.includes('你是声明核查器')) {
      let mode = 'analysis';
      try { mode = JSON.parse(user).mode === 'draft' ? 'draft' : 'analysis'; } catch {}
      canned = mode === 'draft' ? take(draftQ, 'draft-claims') : take(analysisQ, 'analysis-claims');
    } else if (system.includes('Return JSON with status')) {
      canned = take(assessQ, 'assess');
    } else {
      canned = take(chatQ, 'chat');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(canned) } }] }));
  });
});
await mock.listen(mockPort, '127.0.0.1');

// ---------------------------------------------------------------------------
// 启动真实服务
// ---------------------------------------------------------------------------
const dataDir = await mkdtemp(path.join(tmpdir(), 'daymark-delivery-acceptance-'));
const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.mjs'], {
  cwd: root,
  env: { ...process.env, DAYMARK_DATA_DIR: dataDir, PORT: String(port),
    OPENAI_BASE_URL: 'http://127.0.0.1:' + mockPort + '/v1', MODEL_ID: 'mock-model', OPENAI_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });

async function api(route, body) {
  const options = body === undefined ? { method: 'GET' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const response = await fetch(base + route, options);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data, error: data.error ?? null };
}
const state = async () => (await api('/api/state')).data;

function cleanup(code) {
  server.kill('SIGTERM');
  mock.close();
  return rm(dataDir, { recursive: true, force: true }).then(() => process.exit(code));
}

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(base + '/api/state')).ok; } catch {
    if (server.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
if (!up) {
  console.log('FAIL  server did not start\n' + serverLog);
  await cleanup(1);
}

console.log('\nAcceptance: 客户交付确认流程（mock 模型，确定性；集成分支 ' + 'integration/2026-11-11' + '）');

// ---------------------------------------------------------------------------
// 真实 UI 模块 + 最小假 DOM（与 review-view-walkthrough / opportunity-ui.test 同一手法）
// ---------------------------------------------------------------------------
function uiHarness(language) {
  const element = (tag, text = '', className = '') => {
    const node = { tag, text, className, children: [], open: false, listeners: {},
      get textContent() { return this.text; },
      set textContent(value) { this.text = value; },
      append(...kids) { this.children.push(...kids); },
      replaceChildren(...kids) { this.children = [...kids]; },
      setAttribute() {},
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      reportValidity() { return true; },
    };
    return node;
  };
  const elements = new Map();
  const get = id => elements.get(id) ?? (elements.set(id, element('div', '')), elements.get(id));
  const render = createOpportunityUI({
    get, t: phrase => translate(language, phrase), element,
    action: label => element('button', label), request: async () => {}, viewSource: async () => {},
    formAction: () => {}, language: () => language, createTask: () => {},
  });
  const fullText = node => (node?.text ?? '') + (node?.children ?? []).reduce(
    (text, kid) => text + fullText(kid), '');
  return { render, elements, fullText };
}
const ui = uiHarness('zh-CN');
function renderUi() {
  const snapshot = stateCache;
  ui.render(snapshot);
  return ui.fullText(ui.elements.get('opportunity-list'));
}
let stateCache = null;
async function renderUiFresh() {
  stateCache = await state();
  return renderUi();
}

const lastModel = () => modelRequests.at(-1);
const requestText = req => (req?.messages ?? []).map(m => m.content).join('\n');
const findMemory = (data, body) => (data.memory ?? []).find(item => item.body === body);
const lead = data => (data.opportunities ?? []).find(item => item.id === leadId) ?? null;

// ---------------------------------------------------------------------------
// 1) 工作区隔离：客户 A 有周五交付约定
// ---------------------------------------------------------------------------
console.log('\n1) 客户 A 工作区：周五交付约定（聊天使用正确项目的资料）');
const convA = await api('/api/conversation', { title: '客户 A 交付跟进', project: A });
record('create the A conversation', convA.ok ? 'PASS' : 'FAIL', convA.error ?? '');
const fact1 = await api('/api/memory', { kind: 'fact', scope: A, body: A_FACT, source: '客户 A 合同 · 11 月 5 日确认' });
record('save the A delivery-agreement fact', fact1.ok ? 'PASS' : 'FAIL', fact1.error ?? '');
const fact2 = await api('/api/memory', { kind: 'fact', scope: A, body: A_PROMISE, source: '客户 A 邮件 · 11 月 8 日' });
record('save the A customer promise', fact2.ok ? 'PASS' : 'FAIL', fact2.error ?? '');
let st = await state();
const fact1Id = findMemory(st, A_FACT)?.id;
const fact2Id = findMemory(st, A_PROMISE)?.id;
const task = await api('/api/task', { title: '客户 A 交付', starts: '2026-11-13T15:00', ends: '2026-11-13T16:30', memory_id: fact1Id });
record('save the Friday delivery task', task.ok ? 'PASS' : 'FAIL', task.error ?? '');
const convB = await api('/api/conversation', { title: '客户 B 跟进', project: B });
record('create the B conversation', convB.ok ? 'PASS' : 'FAIL', convB.error ?? '');

chatQ.push({
  expect: 'chat in A carries the A records',
  value: { answer: '本周交付安排：2026-11-13 周五 15:00 向客户 A 交付版本（双方已确认）。',
    facts: [{ id: fact1Id, quote: '2026-11-13 周五 15:00 向客户 A 交付版本' }],
    inferences: [], unknowns: [], citations: [fact1Id], conflict: '', proposal: null, question: '',
    understood: '核对客户 A 本周交付安排。' },
});
st = (await api('/api/chat', { text: '本周的交付安排是什么？', language: 'zh-CN', conversation_id: convA.data.conversation })).data;
const replyA = (st.messages ?? []).filter(m => m.conversation_id === convA.data.conversation).at(-1);
record('A chat reads the A workspace (trace.scope)', replyA?.review?.trace?.scope === A ? 'PASS' : 'FAIL',
  'scope=' + replyA?.review?.trace?.scope);
record('A model request carries the A records',
  requestText(lastModel()).includes(A_FACT) ? 'PASS' : 'FAIL', 'has agreement=' + requestText(lastModel()).includes(A_FACT));

chatQ.push({
  expect: 'chat in B carries no A records',
  value: { answer: '客户 B 工作区还没有保存的交付记录，无法确认交付安排。',
    facts: [], inferences: [], unknowns: [], citations: [], conflict: '', proposal: null, question: '',
    understood: '查询客户 B 工作区交付安排。' },
});
st = (await api('/api/chat', { text: '本周的交付安排是什么？', language: 'zh-CN', conversation_id: convB.data.conversation })).data;
const replyB = (st.messages ?? []).filter(m => m.conversation_id === convB.data.conversation).at(-1);
record('B chat stays in the B workspace (trace.scope)', replyB?.review?.trace?.scope === B ? 'PASS' : 'FAIL',
  'scope=' + replyB?.review?.trace?.scope);
record('B model request never carries the A records',
  !requestText(lastModel()).includes(A_FACT) && !requestText(lastModel()).includes(A_PROMISE) ? 'PASS' : 'FAIL');

console.log('\n2) 跨工作区合并/移动：系统提示');
const merge = await api('/api/conversation-merge', { id: convA.data.conversation, target: convB.data.conversation });
record('cross-workspace merge is refused', !merge.ok && merge.status === 409 && merge.error.includes('跨工作区不能直接并入') ? 'PASS' : 'FAIL',
  merge.error ?? String(merge.status));
const move = await api('/api/conversation-edit', { id: convA.data.conversation, project: B });
record('cross-workspace move of a chat with history is refused', !move.ok && move.status === 409 && move.error.includes('不能直接跨工作区移动') ? 'PASS' : 'FAIL',
  move.error ?? String(move.status));

console.log('\n3) 明确导入一条资料：副本带原工作区出处');
const importRes = await api('/api/memory-import', { record_id: fact1Id, scope: B });
const imported = findMemory(importRes.data, A_FACT);
record('explicit import succeeds and keeps provenance',
  importRes.ok && imported?.scope === B && imported.source.startsWith('来自「' + A + '」的记录 #' + fact1Id + ' · ') ? 'PASS' : 'FAIL',
  imported?.source ?? importRes.error ?? '');
chatQ.push({
  expect: 'after import, B chat sees the record with provenance',
  value: { answer: '你从客户 A 工作区带入的交付约定：2026-11-13 周五 15:00 向客户 A 交付版本。',
    facts: [], inferences: [], unknowns: [], citations: [], conflict: '', proposal: null, question: '',
    understood: '核对带入的客户 A 交付约定。' },
});
st = (await api('/api/chat', { text: '刚才带入的记录说了什么？', language: 'zh-CN', conversation_id: convB.data.conversation })).data;
record('B model request sees the imported record with its original workspace',
  requestText(lastModel()).includes(A_FACT) && requestText(lastModel()).includes('来自「' + A + '」的记录 #') ? 'PASS' : 'FAIL');
record('A chat history still absent from the B request',
  !requestText(lastModel()).includes(replyA.body) ? 'PASS' : 'FAIL');

// ---------------------------------------------------------------------------
// 4) 客户 A 提出改期：决策卡（原约定 + 新提议 + 可选时段）→ 确认 → 回执
// ---------------------------------------------------------------------------
console.log('\n4) 客户 A 提出改期：决策卡与回执');
chatQ.push({
  expect: 'chat in A surfaces the customer proposal',
  value: { answer: '客户 A 提议把交付改到 2026-11-17 15:30，这是未确认的提议；在你明确接受前，原约定仍然有效。',
    facts: [], inferences: [], unknowns: [], citations: [], conflict: '',
    proposal: { body: '客户 A 提议把交付改到 2026-11-17 15:30', message_id: null },
    question: '', understood: '把客户 A 交付改到 2026-11-17 15:30' },
});
st = (await api('/api/chat', {
  text: '客户 A 来信：希望把「客户 A 交付」从 2026-11-13 15:00 改到 2026-11-17 15:30。',
  language: 'zh-CN', conversation_id: convA.data.conversation,
})).data;
const decisionMsg = (st.messages ?? []).filter(m => m.conversation_id === convA.data.conversation).at(-1);
const card = decisionMsg?.review?.decision ?? null;
record('decision card detected on the customer proposal', card?.kind === 'reschedule' ? 'PASS' : 'FAIL',
  card?.kind ?? 'none');
record('card shows the original arrangement', card?.current?.includes('2026-11-13 15:00') ? 'PASS' : 'FAIL',
  card?.current ?? '');
record('card shows the new proposal', card?.proposal?.includes('2026-11-17 15:30') ? 'PASS' : 'FAIL',
  card?.proposal ?? '');
const optionIds = (card?.options ?? []).map(o => o.id);
record('card offers the two selectable slots (keep original / reschedule to the proposed new time)',
  ['keep', 'reschedule'].every(id => optionIds.includes(id)) ? 'PASS' : 'FAIL', optionIds.join(','));
record('the customer side stays an unconfirmed proposal',
  decisionMsg?.review?.proposal?.body?.includes('2026-11-17 15:30') ? 'PASS' : 'FAIL',
  decisionMsg?.review?.proposal?.body ?? '');

const proposalRec = await api('/api/memory', {
  kind: 'proposal', scope: A,
  body: '客户 A 提议改期至 2026-11-17 15:30（未确认：客户是否同意尚未单独表达）。',
  source: '决策卡 · 客户 A 来信（11 月 11 日）',
});
record('customer consent expressed separately as a proposal record',
  proposalRec.ok && findMemory(proposalRec.data, proposalRec.data.memory?.at(0)?.body)?.kind === 'proposal' ? 'PASS' : 'FAIL',
  proposalRec.error ?? '');

const confirm = await api('/api/decision', { message_id: decisionMsg.id, option_id: 'reschedule', confirm: true });
let cardAfter = confirm.data.messages?.find(m => m.id === decisionMsg.id)?.review?.decision;
const receipt = cardAfter?.choice?.receipt ?? '';
record('confirm applies the reschedule', cardAfter?.status === 'applied' ? 'PASS' : 'FAIL', cardAfter?.status ?? confirm.error ?? '');
record('receipt names original time, new time, and the actual result',
  receipt.includes('本地日历已更新') && receipt.includes('原 2026-11-13 15:00') && receipt.includes('新 2026-11-17 15:30') ? 'PASS' : 'FAIL',
  receipt);
record('receipt does NOT claim the customer confirmed', !receipt.includes('客户已确认') && !receipt.includes('客户已同意') ? 'PASS' : 'FAIL',
  receipt);
const taskNow = confirm.data.tasks?.find(t => t.title === '客户 A 交付');
record('the calendar task actually moved', taskNow?.starts === '2026-11-17T15:30' && taskNow?.ends === '2026-11-17T17:00' ? 'PASS' : 'FAIL',
  (taskNow?.starts ?? '') + ' → ' + (taskNow?.ends ?? ''));
const taskAuditRow = (confirm.data.taskAudit ?? []).find(r => r.action === 'updated' && JSON.parse(r.detail).via?.decision === decisionMsg.id);
record('task activity links the decision card choice', taskAuditRow ? 'PASS' : 'FAIL',
  taskAuditRow ? 'via.decision=' + JSON.parse(taskAuditRow.detail).via?.decision : 'no linked audit row');

// ---------------------------------------------------------------------------
// 5) 线索：草稿写「客户已确认改期」，资料只有提议/转述 → 界面指缺口，发送拦截
// ---------------------------------------------------------------------------
console.log('\n5) 草稿门槛：「客户已确认改期」只有提议与转述时');
let leadId = null;
const leadRes = await api('/api/opportunity', {
  kind: 'lead', title: '客户 A 交付改期跟进', source: '客户 A 交付项目',
  evidence: '原约定：2026-11-13 周五 15:00 向客户 A 交付版本。客户 A 11 月 10 日来信提议改到 2026-11-17 15:30。',
});
leadId = leadRes.data.opportunities?.[0]?.id;
record('save the lead', leadRes.ok ? 'PASS' : 'FAIL', leadRes.error ?? '');

// 证据门槛放行：材料支持「客户 A 提出了改期」（逐字引文来自线索证据），但「已确认」仍缺。
// 这样发送接口会越过证据门槛、停在草稿门槛（claims_unresolved），正好对应本维度要验收的「草稿门槛」。
assessQ.push({
  expect: 'analysis: the proposal is supported, but the confirmation is still missing',
  value: { status: 'supported', quote: '客户 A 11 月 10 日来信提议改到 2026-11-17 15:30',
    reason: '客户 A 明确提出改期意向（11 月 10 日来信）。',
    unknown: '缺少客户 A 对改期的明确确认。', conflict: '',
    clarification: '客户 A 是否确认将交付改到 2026-11-17 15:30？',
    suggestedReply: '想先确认一下：您是否确认将交付改到 2026-11-17 15:30 交付？',
  },
});
analysisQ.push({
  expect: 'analysis-target claims run after assess (proposal + hearsay: unknown)',
  value: { claims: [
    { id: '购买意向', dimension: '购买意向', text: '', items: [], missing: '缺客户 A 明确的签约意向记录。', rewrite: '客户 A 只提出改期提议，未表达签约意向。' },
    { id: '签约状态', dimension: '签约状态', text: '', items: [], missing: '缺客户 A 对改期的明确确认，现有资料只有提议。', rewrite: '改期仍是客户单方提议，尚未确认。' },
  ] },
});
const assess = await api('/api/opportunity-assess', { id: leadId, request: '客户 A 是否已确认改期交付？', language: 'zh-CN' });
record('lead analyzed (status unknown)', assess.ok ? 'PASS' : 'FAIL', assess.error ?? '');
st = await state();
let item = lead(st);
record('current answer is insufficient: says the confirmed part, the exact gap, and the next step',
  item?.answer?.situation === 'insufficient' && item.answer.confirmed.includes('提议改到 2026-11-17 15:30') &&
  item.answer.missing.includes('缺少客户 A 对改期的明确确认') && item.answer.next.length > 0 ? 'PASS' : 'FAIL',
  JSON.stringify({ s: item?.answer?.situation, c: item?.answer?.confirmed, m: item?.answer?.missing }));
{
  const text = await renderUiFresh();
  record('lead card renders the current answer with actions',
    text.includes('当前回答 · 证据不足 · 先说清缺口') && text.includes('缺少 · 缺少客户 A 对改期的明确确认。') &&
    text.includes('下一步') && text.includes('查看来源') && text.includes('补资料') ? 'PASS' : 'FAIL');
}

// 预设回答必须在触发它的调用之前入队（mock 是同步的：调用即请求模型）。
analysisQ.push({
  expect: 're-run after S1 (still just a proposal)',
  value: { claims: [
    { id: '购买意向', dimension: '购买意向', text: '', items: [], missing: '缺客户 A 明确的签约意向记录。', rewrite: '客户 A 只提出改期提议，未表达签约意向。' },
    { id: '签约状态', dimension: '签约状态', text: '', items: [], missing: '缺客户 A 对改期的明确确认，现有资料只有改期提议。', rewrite: '改期仍是客户单方提议，尚未确认。' },
  ] },
});
const srcS1 = await api('/api/opportunity-source', {
  id: leadId, name: '客户 A 来信（11 月 10 日）', date: '2026-11-10', kind: 'customer',
  text: '客户 A 来信（2026-11-10）：我们想尝试把交付改到 2026-11-17 15:30，请确认是否可行。', language: 'zh-CN',
});
record('add source S1 (the proposal letter)', srcS1.ok ? 'PASS' : 'FAIL', srcS1.error ?? '');
analysisQ.push({
  expect: 're-run after S2 (founder hearsay is not evidence)',
  value: { claims: [
    { id: '购买意向', dimension: '购买意向', text: '', items: [], missing: '缺客户 A 明确的签约意向记录。', rewrite: '客户 A 只提出改期提议，未表达签约意向。' },
    { id: '签约状态', dimension: '签约状态', text: '', items: [], missing: '缺客户 A 对改期的明确确认，现有资料只有改期提议与创始人转述。', rewrite: '改期仍是客户单方提议，尚未确认。' },
  ] },
});
const srcS2 = await api('/api/opportunity-source', {
  id: leadId, name: '创始人转述（11 月 11 日）', kind: 'founder',
  text: '创始人转述（2026-11-11）：客户 A 应该已经同意改期了，但我没有看到书面确认。', language: 'zh-CN',
});
record('add source S2 (founder hearsay)', srcS2.ok ? 'PASS' : 'FAIL', srcS2.error ?? '');

const draft = await api('/api/opportunity-draft', {
  id: leadId, recipient: 'a@client-a.test',
  body: '客户已确认改期至 2026-11-17 15:30，我们将按新时间交付。',
});
record('save the outreach draft claiming confirmation', draft.ok ? 'PASS' : 'FAIL', draft.error ?? '');
st = await state();
item = lead(st);
const draftId = item?.draft_id;
draftQ.push({
  expect: 'draft claims: the proposal and hearsay do not support "已确认"',
  value: { claims: [
    { id: '对外承诺', dimension: '对外承诺', text: '客户已确认改期至 2026-11-17 15:30', items: [],
      missing: '缺客户 A 明确确认改期的记录；现有资料只有 11 月 10 日的改期提议与创始人 11 月 11 日的转述。',
      rewrite: '客户 A 提议将交付改至 2026-11-17 15:30，是否改期仍待客户确认。' },
  ] },
});
const verifyDraft = await api('/api/opportunity-claims', { id: leadId, target: 'draft', draft_id: draftId, language: 'zh-CN' });
record('draft claim verification runs for the current draft', verifyDraft.ok ? 'PASS' : 'FAIL', verifyDraft.error ?? '');
st = await state();
item = lead(st);
record('the unsupported sentence is named: draft verification shows the gap',
  item?.claims?.target === 'draft' && item?.claims?.claims?.[0]?.text === '客户已确认改期至 2026-11-17 15:30' &&
  item.claims.claims[0].status === 'unknown' && item.claims.claims[0].missing.includes('改期提议') ? 'PASS' : 'FAIL',
  JSON.stringify({ status: item?.claims?.claims?.[0]?.status, missing: item?.claims?.claims?.[0]?.missing }));
{
  const text = await renderUiFresh();
  record('UI points at the unsupported sentence, the bounded claim, and the next step',
    text.includes('有问题的声明') && text.includes('客户已确认改期至 2026-11-17 15:30') &&
    text.includes('缺少信息 · 缺客户 A 明确确认改期的记录') &&
    text.includes('建议改写 · 客户 A 提议将交付改至 2026-11-17 15:30，是否改期仍待客户确认。') &&
    text.includes('采用改写并重新核查') ? 'PASS' : 'FAIL');
  record('approval status is not awaiting approval', text.includes('需要处理') ? 'PASS' : 'FAIL');
}
const blocked = await api('/api/opportunity-send', { id: leadId, draft_id: draftId });
record('send is blocked: the claim is unresolved', !blocked.ok && blocked.status === 409 && blocked.error.includes('对外承诺') ? 'PASS' : 'FAIL',
  blocked.error ?? String(blocked.status));
st = await state();
record('the block is audited (claims_unresolved)', (st.audit ?? []).some(r => r.action === 'blocked' && JSON.parse(r.detail).reason === 'claims_unresolved') ? 'PASS' : 'FAIL');

// ---------------------------------------------------------------------------
// 6) 补入明确客户确认 → 重新核查 → 展开一条来源走人工复核 → 批准发送 → 回执
// ---------------------------------------------------------------------------
console.log('\n6) 补入明确客户确认：重新核查、人工复核、模拟发送回执');
// S3（明确确认）入队：新增来源先重跑分析目标、最后重跑草稿目标（claims_review 保持草稿目标）。
analysisQ.push({
  expect: 're-run after S3: analysis claim now supported by S3',
  value: { claims: [
    { id: '购买意向', dimension: '购买意向', text: '', items: [], missing: '缺客户 A 明确的签约意向记录。', rewrite: '客户 A 只确认了改期，未表达签约意向。' },
    { id: '签约状态', dimension: '签约状态', text: '',
      items: [{ evidenceId: 'S3', stance: 'supports', quote: '确认改期至 2026-11-17 15:30 交付', note: '客户 A 的确认邮件明确确认了改期交付。', revises: [] }],
      missing: '', rewrite: '客户 A 已确认将交付改至 2026-11-17 15:30。' },
  ] },
});
draftQ.push({
  expect: 're-run after S3: draft claim now supported by S3',
  value: { claims: [
    { id: '对外承诺', dimension: '对外承诺', text: '客户已确认改期至 2026-11-17 15:30',
      items: [{ evidenceId: 'S3', stance: 'supports', quote: '确认改期至 2026-11-17 15:30 交付', note: '客户 A 的确认邮件支持「客户已确认改期」的说法。', revises: [] }],
      missing: '', rewrite: '' },
  ] },
});
const srcS3 = await api('/api/opportunity-source', {
  id: leadId, name: '客户 A 确认邮件（11 月 12 日）', date: '2026-11-12', kind: 'customer',
  text: '客户 A 确认邮件（2026-11-12）：确认改期至 2026-11-17 15:30 交付，按新时间执行。', language: 'zh-CN',
});
record('add source S3 (the explicit customer confirmation)', srcS3.ok ? 'PASS' : 'FAIL', srcS3.error ?? '');
st = await state();
item = lead(st);
record('adding the source re-runs verification (draft + analysis targets)',
  item?.claims?.target === 'draft' && item.claims.claims[0].status === 'supported' && !item.claimsStale ? 'PASS' : 'FAIL',
  JSON.stringify({ target: item?.claims?.target, status: item?.claims?.claims?.[0]?.status }));
record('the lead current answer updates to a bounded conclusion pointing at S3',
  item?.answer?.situation === 'sufficient' && item.answer.supporting?.map(s => s.id).join() === 'S3' &&
  item.answer.confirmed.includes('客户 A 已确认将交付改至 2026-11-17 15:30') ? 'PASS' : 'FAIL',
  JSON.stringify({ s: item?.answer?.situation, supporting: item?.answer?.supporting }));
record('the draft verification and the lead answer keep their own results',
  item?.claims?.target === 'draft' && (item.analysis_claims ?? null) !== null ? 'PASS' : 'FAIL',
  'claims.target=draft, analysis_claims copy kept');
{
  const text = await renderUiFresh();
  record('UI shows the bounded conclusion and the supporting source',
    text.includes('当前回答 · 证据充分 · 结论有边界') && text.includes('依据来源 · 客户 A 确认邮件（11 月 12 日）') ? 'PASS' : 'FAIL');
}

const view = await api('/api/opportunity-review-view', { id: leadId, source_id: 'S3' });
record('expanding S3 records the viewing action', view.ok ? 'PASS' : 'FAIL', view.error ?? '');
const analysisId = JSON.parse(lead(st).analysis)?.analysisId;
const review = await api('/api/opportunity-review', {
  id: leadId, analysis_id: analysisId, draft_id: draftId,
  resolution: '已展开 S3 来源原文并核对：客户 A 于 2026-11-12 明确确认改期，与草稿一致，可发送。',
});
st = await state();
item = lead(st);
const humanReviewed = (st.audit ?? []).find(r => r.action === 'human_reviewed');
const viewedNames = humanReviewed ? JSON.parse(humanReviewed.detail).viewedNames : null;
record('saving the review audits exactly the one opened source (S3)',
  review.ok && JSON.parse(humanReviewed.detail).viewed.join(',') === 'S3' && viewedNames?.join() === '客户 A 确认邮件（11 月 12 日）' ? 'PASS' : 'FAIL',
  'viewed=' + JSON.stringify(humanReviewed ? JSON.parse(humanReviewed.detail).viewed : null) + ' names=' + JSON.stringify(viewedNames));
record('viewing state shows the current version (S3 opened)',
  item?.reviewViewed?.viewed?.join() === 'S3' && item.reviewStale == null ? 'PASS' : 'FAIL',
  JSON.stringify(item?.reviewViewed ?? null));
{
  const text = await renderUiFresh();
  record('review area shows the current viewing state',
    text.includes('已展开来源 · 客户 A 确认邮件（11 月 12 日）') && !text.includes('尚未展开来源') ? 'PASS' : 'FAIL');
}

const sent = await api('/api/opportunity-send', { id: leadId, draft_id: draftId });
st = await state();
item = lead(st);
const approved = (st.audit ?? []).find(r => r.action === 'approved');
const simulated = (st.audit ?? []).find(r => r.action === 'simulated_send');
record('approved draft simulates the send', sent.ok && item?.sent === 1 ? 'PASS' : 'FAIL', sent.error ?? '');
record('receipt: approval + simulated send carry the current draft',
  approved && simulated && JSON.parse(approved.detail).draftId === draftId && JSON.parse(simulated.detail).draftId === draftId &&
  JSON.parse(simulated.detail).body === item.body ? 'PASS' : 'FAIL',
  'evidence=' + (approved ? JSON.parse(approved.detail).evidence : ''));

// ---------------------------------------------------------------------------
// 7) 复核后新增撤回记录：旧复核随来源变化失效，当前回答转为来源冲突
// ---------------------------------------------------------------------------
console.log('\n7) 复核后新增撤回记录：旧复核失效');
// S4（撤回、未显式 supersede）入队：S3 支持、S4 撤回，无 revises → 保持来源冲突（不静默覆盖）。
analysisQ.push({
  expect: 're-run after S4: S3 vs S4 stays a conflict (no confirmed supersession)',
  value: { claims: [
    { id: '购买意向', dimension: '购买意向', text: '', items: [], missing: '缺客户 A 明确的签约意向记录。', rewrite: '客户 A 撤回确认后，签约意向未确认。' },
    { id: '签约状态', dimension: '签约状态', text: '',
      items: [
        { evidenceId: 'S3', stance: 'supports', quote: '确认改期至 2026-11-17 15:30 交付', note: '客户 A 的确认邮件支持改期已确认。', revises: [] },
        { evidenceId: 'S4', stance: 'withdraws', quote: '撤回 11 月 12 日确认邮件中的确认', note: '客户 A 撤回了 11 月 12 日的改期确认。', revises: [] },
      ],
      missing: '需确认客户 A 撤回后是否维持原交付时间。', rewrite: '客户 A 已撤回改期确认，交付时间待重新确认。' },
  ] },
});
draftQ.push({
  expect: 're-run after S4: draft claim is a conflict',
  value: { claims: [
    { id: '对外承诺', dimension: '对外承诺', text: '客户已确认改期至 2026-11-17 15:30',
      items: [
        { evidenceId: 'S3', stance: 'supports', quote: '确认改期至 2026-11-17 15:30 交付', note: '客户 A 的确认邮件支持「客户已确认改期」。', revises: [] },
        { evidenceId: 'S4', stance: 'withdraws', quote: '撤回 11 月 12 日确认邮件中的确认', note: '客户 A 撤回了该确认。', revises: [] },
      ],
      missing: '需确认撤回后按哪个时间交付。', rewrite: '客户 A 曾确认改期，其后撤回确认，交付时间待重新确认。' },
  ] },
});
const srcS4 = await api('/api/opportunity-source', {
  id: leadId, name: '客户 A 撤回邮件（11 月 13 日）', date: '2026-11-13', kind: 'customer',
  text: '客户 A 撤回邮件（2026-11-13）：撤回 11 月 12 日确认邮件中的确认，暂不调整交付时间。', language: 'zh-CN',
});
record('add source S4 (the withdrawal, no explicit supersession)', srcS4.ok ? 'PASS' : 'FAIL', srcS4.error ?? '');
st = await state();
item = lead(st);
record('the old review expires with the source change',
  JSON.stringify(item?.reviewStale) === JSON.stringify(['source_changed']) ? 'PASS' : 'FAIL',
  JSON.stringify(item?.reviewStale ?? null));
record('the withdrawal keeps the records a conflict (no silent supersession)',
  item?.claims?.claims?.[0]?.status === 'conflict' ? 'PASS' : 'FAIL',
  JSON.stringify({ status: item?.claims?.claims?.[0]?.status }));
record('the current answer switches to the conflict case with the records to compare',
  item?.answer?.situation === 'conflict' && item.answer.compare?.map(c => c.id).join(',') === 'S3,S4' ? 'PASS' : 'FAIL',
  JSON.stringify({ s: item?.answer?.situation, compare: item?.answer?.compare?.map(c => c.id) }));
{
  const text = await renderUiFresh();
  record('UI shows the expired review and the conflicting records',
    text.includes('复核已过期') && text.includes('当前回答 · 来源冲突 · 先比较记录') &&
    text.includes('确认改期至 2026-11-17 15:30 交付') && text.includes('撤回 11 月 12 日确认邮件中的确认') ? 'PASS' : 'FAIL');
}

// ---------------------------------------------------------------------------
// 汇总 + 留档
// ---------------------------------------------------------------------------
console.log('\nSummary: ' + passed() + ' passed, ' + skipped() + ' skipped, ' + failed() + ' failed');
const summary = {
  at: new Date().toISOString(),
  branch: 'integration/2026-11-11',
  base: 'e83b8af + 046299a + f54d929 + ad08f13',
  results,
  modelRequests: modelRequests.map(req => ({
    systemHead: ((req.messages ?? []).find(m => m.role === 'system')?.content ?? '').slice(0, 60),
    userHead: ((req.messages ?? []).find(m => m.role === 'user')?.content ?? '').slice(0, 120),
  })),
};
const evidenceDir = path.join(root, 'docs', 'evidence');
await mkdir(evidenceDir, { recursive: true });
const traceFile = path.join(evidenceDir, 'customer-delivery-acceptance-' + Date.now() + '.json');
await writeFile(traceFile, JSON.stringify(summary, null, 2));
await writeFile(path.join(evidenceDir, 'customer-delivery-acceptance-server.log'), serverLog);
console.log('  trace: ' + traceFile);

// ---------------------------------------------------------------------------
// 可选：浏览器截图（headless Chrome + CDP；失败只记 SKIPPED，不影响断言结论）
// ---------------------------------------------------------------------------
async function captureScreenshots() {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!existsSync(chrome)) { record('browser screenshots', 'SKIPPED', 'Chrome not found'); return; }
  const shotsDir = path.join(evidenceDir, 'screenshots-' + Date.now());
  await mkdir(shotsDir, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'daymark-chrome-'));
  const chromeProc = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--window-size=1500,1200', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const target = async (what) => {
    for (let i = 0; i < 40; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json();
        const page = list.find(t => t.type === 'page');
        if (page) return page;
      } catch {}
      await new Promise(r => setTimeout(r, 250));
      if (chromeProc.exitCode != null) throw new Error('chrome exited');
    }
    throw new Error(what + ': no CDP page');
  };
  const wsUrl = (await target('CDP')).webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  let idSeq = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++idSeq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onerror = () => {};
  await new Promise(resolve => { ws.onopen = resolve; });
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    await send('Page.enable');
    await send('Page.navigate', { url: base + '/' });
    await sleep(3500); // 等待 /api/state 渲染
    const shot = async (name) => {
      const result = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(shotsDir, name + '.png'), Buffer.from(result.data, 'base64'));
      record('screenshot ' + name, 'PASS', shotsDir + '/' + name + '.png');
    };
    await shot('01-default-chat');
    const evalJs = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true });
    await evalJs(`(function(){var b=[...document.querySelectorAll('.chat-project-name')].find(x=>x.textContent==='${A}');b&&b.click();return !!b;})()`);
    await sleep(1200);
    await shot('02-chat-decision-card-' + A);
    await evalJs(`document.querySelector('[data-view="opportunities"]')?.click();true`);
    await sleep(1200);
    await shot('03-leads-current-answer');
    await evalJs(`document.querySelector('[data-view="delegation"]')?.click();true`);
    await sleep(1200);
    await shot('04-review-audit');
    await evalJs(`(function(){var b=[...document.querySelectorAll('.chat-project-name')].find(x=>x.textContent==='${B}');b&&b.click();return !!b;})()`);
    await sleep(1200);
    await shot('05-chat-workspace-B');
  } catch (error) {
    record('browser screenshots', 'SKIPPED', error.message);
  } finally {
    try { ws.close(); } catch {}
    // 等 Chrome 真正退出（它退出前还会往 profile 写缓存/锁文件），再清理临时 profile。
    if (chromeProc.exitCode == null) {
      chromeProc.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => chromeProc.once('exit', resolve)),
        new Promise(resolve => setTimeout(() => { try { chromeProc.kill('SIGKILL'); } catch {} resolve(); }, 3000)),
      ]);
    }
    try { await rm(profile, { recursive: true, force: true }); }
    catch { /* 临时 profile 清理尽力而为：截图已写入 docs/evidence/，不影响结论 */ }
  }
}
if (wantShots) {
  console.log('\nBrowser pass (headless Chrome)');
  await captureScreenshots();
}

const code = failed() ? 1 : 0;
if (!failed()) {
  console.log('All acceptance points passed.');
}
await cleanup(code);
