// 共享记忆保留原项目与适用范围 · 端到端验收（shared-memory 窗口）
//
// 验收标准（三条入口，全部确定性断言）：
//   1) 内部比较 —— A 项目保存一条通用谈判流程（全局共享）和一条客户 A 专属
//      折扣（A 作用域）；B 项目问「客户 A 是怎么谈的」时：
//      · /api/chat-intent 确定性判为 compare（比较措辞 + 两个工作区提及，不消耗模型）；
//      · B 的回复请求里，流程记录带 applies_to='*' 与 origin='客户 A'（原项目），
//        A 的折扣原文绝不进入 B 的上下文；trace.retrieved 同样携带两个字段。
//   2) 对外草稿 v1 —— 为 B 起草借鉴谈判流程 + 留下 [待定：B 客户折扣] 占位符
//      （占位符家族：待确认/待核实/待定/TBD…；「待定」不触发条件句扫描，
//        让拦截原因精确落在 claims_placeholders 而不是 claims_pending）：
//      流程句有依据（supported，引用线索客户原文 E1）不被拦截；
//      发送接口 409 claims_placeholders，零模拟发送。
//   3) 对外草稿 v2 —— 把受保护的 A 折扣原文逐字放进发给 B 的草稿：
//      声明核查确定性判 unknown（B 工作区没有任何来源支持该折扣）；
//      发送接口 409 claims_unresolved，零模拟发送，sent 保持 0。
//
// 测试范围声明：本回归覆盖「明确的适用范围」与「原文披露」两条线；
// 若把 A 的条款改写后泄露（非逐字原文）仍属于未覆盖缺口，不在本脚本断言。
//
//   node scripts/shared-memory-acceptance.mjs
//
// 与既有验收脚本同一手法：临时数据目录 + 专用端口（4250/4251）启动真实服务，
// 模型请求打到本地确定性 mock（记录每个请求，队列顺序即流程顺序）。trace 写入
// docs/evidence/shared-memory-acceptance-<ts>.json（本地留档，不进版本库）。

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4250;
const mockPort = 4251;
const base = 'http://127.0.0.1:' + port;
const A = '客户 A';
const B = '客户 B';

// A 项目的两条记忆：通用谈判流程（全局共享，从 A 的会话保存 → origin 捕获为 A）
// 与 A 客户专属折扣（A 作用域，适用对象显式指向 A）。
const FLOW_BODY = '通用谈判流程：先确认需求、再给方案、最后对齐商务条件。';
const FLOW_SOURCE = '客户 A 项目会议 · 11 月 12 日';
const DISC_BODY = 'A 客户专属折扣：A 客户可打八折（编号 A-DISC-8821）。';
const DISC_SOURCE = '客户 A 合同 · 11 月 10 日';
const DISC_CLAUSE = 'A 客户可打八折（编号 A-DISC-8821）'; // 受保护的原文条款
// B 侧的确定性比较问句：比较措辞 + 两个工作区全称 → ruleIntent 判 compare。
const QUESTION = '对比：客户 A 是怎么谈的？客户 B 有哪些可以借鉴？';
// 线索（B 工作区）：初始证据身份为 customer，草稿里的流程句用它做逐字支持引文。
const LEAD_EVIDENCE = '客户 B 需求会议（11 月 14 日）：客户 B 要求正式报价；'
  + '流程上沿用三步谈判法：先确认需求、再给方案、最后对齐商务条件。折扣未定。';
const LEAD_E1_QUOTE = '先确认需求、再给方案、最后对齐商务条件';
const DRAFT_V1_BODY = '我们将沿用客户 A 项目沉淀的谈判流程（通用做法）。'
  + 'B 客户折扣：[待定：B 客户折扣]。';
const DRAFT_V1_CLAIM_TEXT = '我们将沿用客户 A 项目沉淀的谈判流程（通用做法）';
const DRAFT_V2_BODY = '商务条件：' + DISC_CLAUSE + '，我们将把它用于 B 客户的报价。';

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
const draftQ = [];
function take(queue, label) {
  const next = queue.shift();
  if (!next) {
    record('model queue ' + label, 'FAIL', 'unexpected request: ' + label);
    return { answer: '（模拟模型）队列意外。', facts: [], inferences: [], unknowns: [],
      citations: [], conflict: '', proposal: null, question: '', understood: '' };
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
    if (system.includes('你是聊天回答的声明核查器')) {
      // 聊天回答的关键断言核查（窗口 3）：每次聊天回答后独立发起，固定返回空声明集，
      // 不消耗任何队列（chatQ 的队列项精确对应该脚本的聊天回复）。
      canned = { claims: [] };
    } else if (system.includes('你是声明核查器')) {
      let mode = 'draft';
      try { mode = JSON.parse(user).mode === 'analysis' ? 'analysis' : 'draft'; } catch {}
      if (mode === 'draft') canned = take(draftQ, 'draft-claims');
      else canned = { claims: [] };
    } else if (system.startsWith('你是 Daymark，一个帮助个人接续项目的队友')) {
      canned = take(chatQ, 'chat');
    } else {
      // 确定性流程不应触达其他模型入口（chat-intent 辅助 / 记忆提取器）；
      // 一旦触达说明流程走错了分支，回显请求头便于定位。
      record('unexpected model entry', 'FAIL', system.slice(0, 40));
      canned = { answer: '（模拟模型）意外入口。', facts: [], inferences: [], unknowns: [],
        citations: [], conflict: '', proposal: null, question: '', understood: '' };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(canned) } }] }));
  });
});
await mock.listen(mockPort, '127.0.0.1');

// ---------------------------------------------------------------------------
// 启动真实服务：工作树字节级拷贝（server.mjs + src/ + dist/ + package.json），
// 仅替换 src/models.mjs 为本地 mock 目录以隔离真实模型端点。
// ---------------------------------------------------------------------------
const MOCK_MODELS = `// 测试模型目录（shared-memory 验收窗口）：单一本地 mock 模型，指向脚本启动的
// 确定性 mock 服务。替换工作树目录仅用于隔离真实端点；被测代码不受影响。
const BASE = process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:0/v1';
export const MODELS = [{ id: 'mock-model', name: 'Mock Model', base: BASE, keyEnv: 'MOCK_API_KEY', fallbackKey: 'mock', timeout: 15000, efforts: {} }];
export const modelById = id => (typeof id === 'string' && MODELS.find(entry => entry.id === id)) || null;
export const DEFAULT_MODEL_ID = 'mock-model';
export const defaultModel = () => modelById(DEFAULT_MODEL_ID) ?? MODELS[0];
export const modelKey = entry => {
  const fromEnv = entry.keyEnv ? (process.env[entry.keyEnv] ?? '').trim() : '';
  return entry.key ?? (fromEnv || entry.fallbackKey || '');
};
export const modelConfigured = entry => Boolean(entry.local || modelKey(entry));
export const conversationModel = (conv, defaultEntry) => {
  const entry = modelById(conv?.model) ?? defaultEntry;
  const effort = entry.efforts?.[conv?.effort] ? conv.effort : null;
  return { entry, effort };
};
`;
function buildWorkDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'daymark-shared-memory-'));
  cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  cpSync(path.join(root, 'dist'), path.join(dir, 'dist'), { recursive: true });
  copyFileSync(path.join(root, 'server.mjs'), path.join(dir, 'server.mjs'));
  copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  writeFileSync(path.join(dir, 'src', 'models.mjs'), MOCK_MODELS);
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir);
  return { dir, dataDir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const workDir = buildWorkDir();
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: workDir.dir,
  env: { ...process.env, DAYMARK_DATA_DIR: workDir.dataDir, PORT: String(port),
    OPENAI_BASE_URL: 'http://127.0.0.1:' + mockPort + '/v1', MODEL_ID: 'mock-model', MOCK_API_KEY: '' },
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
  return workDir.cleanup().then(() => process.exit(code));
}

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try {
    const snapshot = await (await fetch(base + '/api/state')).json().catch(() => ({}));
    // model 必须是我们注入的 mock 目录项，否则说明端口被别的服务占用（会误测别人的实例）。
    up = snapshot.model === 'mock-model' && snapshot.live === true;
  } catch {
    if (server.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
if (!up) {
  console.log('FAIL  server did not start with the mock model (port ' + port
    + ' may be taken by another instance)\n' + serverLog);
  await cleanup(1);
}

console.log('\nAcceptance: 共享记忆保留原项目与适用范围（mock 模型，确定性）');

const systemOf = req => (req?.messages ?? []).find(m => m.role === 'system')?.content ?? '';
// 窗口 3：每次聊天回答后会多出一发「关键断言核查」请求；回复内容断言必须落在
// 真正的回复请求上（system 以 Daymark 回复提示开头）。
const replyRequest = () => {
  for (let i = modelRequests.length - 1; i >= 0; i--) {
    if (systemOf(modelRequests[i]).startsWith('你是 Daymark，一个帮助个人接续项目的队友')) return modelRequests[i];
  }
  return null;
};
// 回复请求 system 的末行是「引用编号只从以下记录中选择。记录：<JSON>」：
// 用 lastIndexOf 定位（系统提示里「记录：」只出现这一次），解析出模型实际看到的记录视图。
const recordsInPrompt = req => {
  const system = systemOf(req);
  const at = system.lastIndexOf('记录：');
  if (at === -1) return null;
  try { return JSON.parse(system.slice(at + '记录：'.length).trim()); } catch { return null; }
};
const checkRequest = () => {
  for (let i = modelRequests.length - 1; i >= 0; i--) {
    if (systemOf(modelRequests[i]).includes('你是聊天回答的声明核查器')) return modelRequests[i];
  }
  return null;
};
const checkSources = req => {
  try {
    const user = (req?.messages ?? []).find(m => m.role === 'user')?.content ?? '{}';
    return JSON.parse(user).sources ?? [];
  } catch { return []; }
};
const findMemory = (data, body) => (data.memory ?? []).find(item => item.body === body);
const assistantOf = (snapshot, convId) =>
  (snapshot.messages ?? []).filter(m => m.conversation_id === convId && m.role === 'assistant').pop() ?? null;
const auditReasons = snapshot => (snapshot.audit ?? []).map(r => JSON.parse(r.detail).reason);
const hasSimulatedSend = snapshot => (snapshot.audit ?? []).some(r => r.action === 'simulated_send');

// ---------------------------------------------------------------------------
// 1) 种子：A 项目两条记忆（通用流程 → 全局共享；A 专属折扣 → A 作用域）
// ---------------------------------------------------------------------------
console.log('\n1) 种子：A 项目保存通用谈判流程（全局）与 A 客户专属折扣（A 作用域）');
const convA = await api('/api/conversation', { title: A + ' 跟进', project: A });
record('create the A conversation', convA.ok ? 'PASS' : 'FAIL', convA.error ?? '');
const aConvId = convA.data.conversation;
// 先在 A 的会话里留一条会议消息：两条记忆都从这条消息提取（message_id），
// 保存入口据此捕获原项目 origin_scope。
chatQ.push({
  expect: 'chat in A records the meeting (message for provenance)',
  value: { answer: '已记录客户 A 项目会议：三步谈判法与 A 合同折扣条款。',
    facts: [], inferences: [], unknowns: [], citations: [], conflict: '', proposal: null,
    question: '', understood: '记录客户 A 项目会议。' },
});
const chatA = await api('/api/chat', { text: FLOW_SOURCE + '：确认了' + FLOW_BODY + ' 折扣条款只适用于客户 A 合同。',
  language: 'zh-CN', conversation_id: aConvId });
let st = await state();
const userMsgA = (st.messages ?? []).filter(m => m.conversation_id === aConvId && m.role === 'user')[0] ?? null;
record('A meeting message recorded (message_id source for provenance)',
  chatA.ok && userMsgA ? 'PASS' : 'FAIL', 'message_id=' + (userMsgA?.id ?? 'none'));

const flowImpact = await api('/api/memory-impact', { kind: 'rule', scope: '*', body: FLOW_BODY, replaces: null });
const flowSave = await api('/api/memory', {
  kind: 'rule', scope: '*', body: FLOW_BODY, source: FLOW_SOURCE,
  snapshot: flowImpact.data.snapshot, review_base: null, message_id: userMsgA.id, applies_to: '*',
});
st = flowSave.data;
const flowRec = findMemory(st, FLOW_BODY);
record('save the global negotiation-flow rule (from A, applies_to=* explicit)',
  flowSave.ok && flowRec ? 'PASS' : 'FAIL', flowSave.error ?? '');
const discSave = await api('/api/memory', {
  kind: 'fact', scope: A, body: DISC_BODY, source: DISC_SOURCE,
  message_id: userMsgA.id, applies_to: A,
});
st = discSave.data;
const discRec = findMemory(st, DISC_BODY);
record('save the A-exclusive discount fact (scope=A, applies_to=A)',
  discSave.ok && discRec ? 'PASS' : 'FAIL', discSave.error ?? '');
const flowId = flowRec?.id;
record('both records capture origin_scope=A at save time (message link)',
  flowRec?.origin_scope === A && discRec?.origin_scope === A ? 'PASS' : 'FAIL',
  'flow.origin=' + JSON.stringify(flowRec?.origin_scope) + ' disc.origin=' + JSON.stringify(discRec?.origin_scope));
record('explicit applies_to values persist on the records',
  flowRec?.applies_to === '*' && discRec?.applies_to === A ? 'PASS' : 'FAIL',
  'flow.applies_to=' + JSON.stringify(flowRec?.applies_to) + ' disc.applies_to=' + JSON.stringify(discRec?.applies_to));
if (!flowSave.ok || !discSave.ok || !flowId) {
  console.log('\nSummary: ' + passed() + ' passed, ' + skipped() + ' skipped, ' + failed() + ' failed');
  await cleanup(1);
}
const convB = await api('/api/conversation', { title: B + ' 跟进', project: B });
record('create the B conversation', convB.ok ? 'PASS' : 'FAIL', convB.error ?? '');
const bConvId = convB.data.conversation;

// ---------------------------------------------------------------------------
// 2) 入口一（内部比较）：B 问「客户 A 是怎么谈的」
// ---------------------------------------------------------------------------
console.log('\n2) 入口一：B 的比较问句走确定性 compare，上下文带出处与适用对象');
const intentBefore = modelRequests.length;
const intent = await api('/api/chat-intent', { text: QUESTION, conversation_id: bConvId, language: 'zh-CN' });
record('chat-intent classifies B\'s question as compare (deterministic, no model)',
  intent.ok && intent.data.action === 'compare' && intent.data.current === B &&
  (intent.data.involved ?? []).includes(A) && (intent.data.involved ?? []).includes(B) &&
  modelRequests.length === intentBefore
    ? 'PASS' : 'FAIL',
  'action=' + intent.data.action + ' involved=' + JSON.stringify(intent.data.involved) +
  ' modelDelta=' + (modelRequests.length - intentBefore));

chatQ.push({
  expect: 'reply in B sees the global flow rule, not the A-exclusive discount',
  value: { answer: '客户 A 项目沉淀了一套通用谈判流程：先确认需求、再给方案、最后对齐商务条件；'
    + B + ' 可以借鉴这个流程，但 ' + A + ' 的折扣条款只能作为 ' + A + ' 的资料，不能当作 ' + B + ' 的事实。',
    facts: [], inferences: [], unknowns: [], citations: [flowId], conflict: '', proposal: null,
    question: '', understood: '对比 ' + A + ' 的谈判流程，供 ' + B + ' 借鉴。' },
});
const chatB = await api('/api/chat', { text: QUESTION, language: 'zh-CN', conversation_id: bConvId });
st = await state();
const replyB = assistantOf(st, bConvId);
const reqB = replyRequest();
const promptRecords = recordsInPrompt(reqB) ?? [];
const flowInPrompt = promptRecords.find(r => r.id === flowId);
record('B reply context carries the flow rule with applies_to=* and origin=A',
  chatB.ok && flowInPrompt && flowInPrompt.applies_to === '*' && flowInPrompt.origin === A ? 'PASS' : 'FAIL',
  'flow=' + JSON.stringify(flowInPrompt ?? null));
record('the A-exclusive discount never enters B\'s model context',
  !systemOf(reqB).includes('A-DISC-8821') && !promptRecords.some(r => r.body?.includes(DISC_CLAUSE)) ? 'PASS' : 'FAIL');
record('trace.retrieved keeps applies_to and origin for the evidence panel',
  replyB?.review?.trace?.retrieved?.some(r => r.id === flowId && r.applies_to === '*' && r.origin === A) ? 'PASS' : 'FAIL',
  'retrieved=' + JSON.stringify(replyB?.review?.trace?.retrieved ?? []));
record('the chat claim check verifies against the retrieved flow rule',
  checkSources(checkRequest()).some(s => s.text === FLOW_BODY) ? 'PASS' : 'FAIL',
  'sources=' + checkSources(checkRequest()).length);

// ---------------------------------------------------------------------------
// 3) 入口二（对外草稿 v1）：借鉴流程句放行，占位符拦截
// ---------------------------------------------------------------------------
console.log('\n3) 入口二：B 的对外草稿 v1 —— 流程句有依据，[待确认] 占位符被拦截');
const leadRes = await api('/api/opportunity', {
  kind: 'lead', title: B + ' 报价跟进', source: B + ' 需求会议',
  evidence: LEAD_EVIDENCE, evidence_kind: 'customer',
});
const leadId = leadRes.data.opportunities?.[0]?.id;
record('save the B lead (initial evidence identity: customer)', leadRes.ok && leadId ? 'PASS' : 'FAIL', leadRes.error ?? '');
const draft1 = await api('/api/opportunity-draft', { id: leadId, recipient: 'b@client-b.test', body: DRAFT_V1_BODY });
st = await state();
let lead = (st.opportunities ?? []).find(item => item.id === leadId) ?? null;
const draftId1 = lead?.draft_id;
record('save the outreach draft v1 (flow sentence + discount placeholder)',
  draft1.ok && draftId1 ? 'PASS' : 'FAIL', draft1.error ?? '');
draftQ.push({
  expect: 'draft v1 claims: the flow sentence is supported by the lead\'s own customer record',
  value: { claims: [
    { id: '流程', dimension: '对外承诺', text: DRAFT_V1_CLAIM_TEXT,
      items: [{ evidenceId: 'E1', stance: 'supports', quote: LEAD_E1_QUOTE,
        note: '线索的客户会议记录支持沿用既定谈判流程的做法。', revises: [] }],
      missing: '', rewrite: '' },
  ] },
});
const verify1 = await api('/api/opportunity-claims', { id: leadId, target: 'draft', draft_id: draftId1, language: 'zh-CN' });
st = await state();
lead = (st.opportunities ?? []).find(item => item.id === leadId) ?? null;
record('draft v1 verification runs and the flow sentence is supported',
  verify1.ok && lead?.claims?.claims?.[0]?.status === 'supported' ? 'PASS' : 'FAIL',
  'status=' + lead?.claims?.claims?.[0]?.status);
const send1 = await api('/api/opportunity-send', { id: leadId, draft_id: draftId1 });
st = await state();
lead = (st.opportunities ?? []).find(item => item.id === leadId) ?? null;
record('send v1 is blocked by the placeholder (409 claims_placeholders)',
  send1.status === 409 && send1.error?.includes('[待定：B 客户折扣]') &&
  auditReasons(st).includes('claims_placeholders') ? 'PASS' : 'FAIL',
  send1.error ?? ('status ' + send1.status));
record('the flow sentence itself was not the blocker (no uncovered-sentence flag)',
  !auditReasons(st).includes('claims_pending') && !auditReasons(st).includes('claims_uncovered') ? 'PASS' : 'FAIL',
  'reasons=' + JSON.stringify(auditReasons(st)));
record('zero simulated sends for v1', !hasSimulatedSend(st) && lead?.sent !== 1 ? 'PASS' : 'FAIL',
  'sent=' + JSON.stringify(lead?.sent));

// ---------------------------------------------------------------------------
// 4) 入口三（对外草稿 v2）：A 折扣原文逐字入稿 → 声明判 unknown → 拦截
// ---------------------------------------------------------------------------
console.log('\n4) 入口三：B 的对外草稿 v2 —— 受保护的 A 折扣原文逐字入稿');
const draft2 = await api('/api/opportunity-draft', { id: leadId, recipient: 'b@client-b.test', body: DRAFT_V2_BODY });
st = await state();
lead = (st.opportunities ?? []).find(item => item.id === leadId) ?? null;
const draftId2 = lead?.draft_id;
record('save the outreach draft v2 (verbatim A discount clause in the B draft)',
  draft2.ok && draftId2 && draftId2 !== draftId1 && lead?.body === DRAFT_V2_BODY ? 'PASS' : 'FAIL',
  'draftId changed=' + (draftId2 !== draftId1));
record('B\'s workspace holds no record supporting the A discount clause',
  (st.memory ?? []).every(item => item.scope !== B && item.scope !== '*' ? true : !item.body.includes('A-DISC-8821')) ? 'PASS' : 'FAIL');
draftQ.push({
  expect: 'draft v2 claims: the copied A discount clause has no support in B\'s sources',
  value: { claims: [
    { id: '折扣', dimension: '客户意向', text: DISC_CLAUSE, items: [],
      missing: B + ' 工作区内没有支持该折扣的记录；该说法逐字来自 ' + A + ' 合同（' + A + ' 专属），对 ' + B + ' 的适用性未确认。',
      rewrite: B + ' 客户折扣未定，现有资料中没有 ' + B + ' 客户确认的折扣条款。' },
  ] },
});
const verify2 = await api('/api/opportunity-claims', { id: leadId, target: 'draft', draft_id: draftId2, language: 'zh-CN' });
st = await state();
lead = (st.opportunities ?? []).find(item => item.id === leadId) ?? null;
record('draft v2 verification deterministically judges the clause unknown',
  verify2.ok && lead?.claims?.claims?.[0]?.status === 'unknown' ? 'PASS' : 'FAIL',
  'status=' + JSON.stringify(lead?.claims?.claims?.[0]?.status));
const send2 = await api('/api/opportunity-send', { id: leadId, draft_id: draftId2 });
st = await state();
lead = (st.opportunities ?? []).find(item => item.id === leadId) ?? null;
record('send v2 is blocked: the claim is unresolved (409 claims_unresolved)',
  send2.status === 409 && send2.error?.includes('客户意向') && auditReasons(st).includes('claims_unresolved') ? 'PASS' : 'FAIL',
  send2.error ?? ('status ' + send2.status));
record('zero simulated sends for v2 (sent stays 0)', !hasSimulatedSend(st) && lead?.sent === 0 ? 'PASS' : 'FAIL',
  'sent=' + JSON.stringify(lead?.sent));

// ---------------------------------------------------------------------------
// 汇总 + 留档
// ---------------------------------------------------------------------------
console.log('\nSummary: ' + passed() + ' passed, ' + skipped() + ' skipped, ' + failed() + ' failed');
const summary = {
  at: new Date().toISOString(),
  scopeNote: '覆盖明确的适用范围与原文披露；改写后泄露（非逐字）仍是未覆盖缺口。',
  results,
  modelRequests: modelRequests.map(req => ({
    systemHead: systemOf(req).slice(0, 60),
    userHead: ((req.messages ?? []).find(m => m.role === 'user')?.content ?? '').slice(0, 120),
  })),
};
const evidenceDir = path.join(root, 'docs', 'evidence');
await mkdir(evidenceDir, { recursive: true });
const traceFile = path.join(evidenceDir, 'shared-memory-acceptance-' + Date.now() + '.json');
await writeFile(traceFile, JSON.stringify(summary, null, 2));
await writeFile(path.join(evidenceDir, 'shared-memory-acceptance-server.log'), serverLog);
console.log('  trace: ' + traceFile);
await cleanup(failed() ? 1 : 0);
