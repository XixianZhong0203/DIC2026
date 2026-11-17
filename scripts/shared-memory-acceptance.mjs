// Shared memory retains original project and applicable scope · End-to-end acceptance (shared-memory
// window)
//
// Acceptance criteria (three entry points, all deterministic assertions):
// 1) Internal comparison - Project A saves a general negotiation process (globally shared) and a client
// A-exclusive
// discount (A scope); when Project B asks 'How was client A negotiated?':
// · /api/chat-intent is deterministically judged as compare (comparison wording + two workspaces
// mentioned, no model consumed);
// · In B's response request, the process record carries applies_to='*' and origin='client A' (original
// project),
// and the raw text of A's discount never enters B's context; trace.retrieved also carries both fields.
// 2) External draft v1 - Draft for B borrowing the negotiation process + leaving [Pending: B client
// discount] placeholder
// (placeholder family: to be confirmed / to be verified / pending / TBD...; 'pending' does not trigger
// conditional clause scanning,
// allowing the interception reason to fall precisely on claims_placeholders instead of claims_pending):
// Process sentences have evidence (supported, referencing lead client original text E1) and are not
// intercepted;
// Dispatch interface returns 409 claims_placeholders, zero simulated dispatches.
// 3) External draft v2 - Put the protected A discount raw text verbatim into the draft sent to B:
// Claim verification deterministically judges as unknown (workspace B has no sources supporting the
// discount);
// Dispatch interface returns 409 claims_unresolved, zero simulated dispatches, sent remains 0.
//
// Test scope declaration: This regression covers two lines: 'explicit applicable scope' and 'original text
// disclosure';
// if A's terms are paraphrased and leaked (non-verbatim original text), it is still an uncovered gap and
// is not asserted in this script.
//
//   node scripts/shared-memory-acceptance.mjs
//
// Same approach as existing acceptance scripts: temporary data directory + dedicated ports (4250/4251) to
// start the real service, model requests sent to local deterministic mock (records each request, queue
// order matches process order). Trace written to docs/evidence/shared-memory-acceptance-<ts>.json (local
// archive, not tracked in git).

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

// Two memories of Project A: general negotiation process (globally shared, saved from A's session ->
// captured as origin A) and A-client exclusive discount (A-scoped, target explicitly points to A).
const FLOW_BODY = '通用谈判流程：先确认需求、再给方案、最后对齐商务条件。';
const FLOW_SOURCE = '客户 A 项目会议 · 11 月 12 日';
const DISC_BODY = 'A 客户专属折扣：A 客户可打八折（编号 A-DISC-8821）。';
const DISC_SOURCE = '客户 A 合同 · 11 月 10 日';
const DISC_CLAUSE = 'A 客户可打八折（编号 A-DISC-8821）'; // Protected original text clause. Deterministic comparison question on B side: comparison phrasing + full
// names of both workspaces -> ruleIntent judges as compare.
const QUESTION = '对比：客户 A 是怎么谈的？客户 B 有哪些可以借鉴？';
// Clue (Workspace B): Initial evidence identity is customer, process sentences in draft use it as verbatim
// supporting citation.
const LEAD_EVIDENCE = '客户 B 需求会议（11 月 14 日）：客户 B 要求正式报价；'
  + '流程上沿用三步谈判法：先确认需求、再给方案、最后对齐商务条件。折扣未定。';
const LEAD_E1_QUOTE = '先确认需求、再给方案、最后对齐商务条件';
const DRAFT_V1_BODY = '我们将沿用客户 A 项目沉淀的谈判流程（通用做法）。'
  + 'B 客户折扣：[待定：B 客户折扣]。';
const DRAFT_V1_CLAIM_TEXT = '我们将沿用客户 A 项目沉淀的谈判流程（通用做法）';
const DRAFT_V2_BODY = '商务条件：' + DISC_CLAUSE + '，我们将把它用于 B 客户的报价。';

// ---------------------------------------------------------------------------
// Result recording
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
// Deterministic mock model: records each request (isolation assertions hit here), pops preset responses
// from corresponding queues by request type. Queue order matches process order; extra/wrong pops will fail
// subsequent assertions.
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
      // Key assertion check for chat responses (Window 3): initiated independently after each chat
      // response, fixed to return empty statement set without consuming any queues (chatQ queue items
      // precisely correspond to this script's chat replies).
      canned = { claims: [] };
    } else if (system.includes('你是声明核查器')) {
      let mode = 'draft';
      try { mode = JSON.parse(user).mode === 'analysis' ? 'analysis' : 'draft'; } catch {}
      if (mode === 'draft') canned = take(draftQ, 'draft-claims');
      else canned = { claims: [] };
    } else if (system.startsWith('你是 Daymark，一个帮助个人接续项目的队友')) {
      canned = take(chatQ, 'chat');
    } else {
      // Deterministic process should not reach other model endpoints (chat-intent auxiliary / memory
      // extractor); if reached, it indicates the process took the wrong branch, echo request headers for
      // easy troubleshooting.
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
// Start real service: byte-level copy of work tree (server.mjs + src/ + dist/ + package.json), only
// replacing src/models.mjs with local mock directory to isolate real model endpoints.
// ---------------------------------------------------------------------------
const MOCK_MODELS = `// 测试模型目录（shared-memory 验收窗口）：单一本地 mock 模型，指向脚本启动的
// Deterministic mock provider. The temporary checkout isolates real endpoints. The code under test is unchanged.
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
    // model must be our injected mock directory item, otherwise it indicates the port is occupied by
    // another service (which would mis-test someone else's instance).
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
// Window 3: an extra "key assertion check" request occurs after each chat response; reply content
// assertions must land on the true reply request (system starts with Daymark reply prompt header).
const replyRequest = () => {
  for (let i = modelRequests.length - 1; i >= 0; i--) {
    if (systemOf(modelRequests[i]).startsWith('你是 Daymark，一个帮助个人接续项目的队友')) return modelRequests[i];
  }
  return null;
};
// The last line of the reply request system is "Citation IDs only select from the following records.
// Records: <JSON>": use lastIndexOf to locate ("Records:" appears only once in system prompt), parse out
// the record view actually seen by the model.
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
// 1) Seed: Two memories of Project A (General process -> globally shared; A-exclusive discount ->
// A-scoped)
// ---------------------------------------------------------------------------
console.log('\n1) 种子：A 项目保存通用谈判流程（全局）与 A 客户专属折扣（A 作用域）');
const convA = await api('/api/conversation', { title: A + ' 跟进', project: A });
record('create the A conversation', convA.ok ? 'PASS' : 'FAIL', convA.error ?? '');
const aConvId = convA.data.conversation;
// First leave a meeting message in A's session: both memories extracted from this message (message_id),
// save entry captures original project origin_scope accordingly.
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
// 2) Entry One (Internal comparison): B asks "How was client A negotiated?"
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
// 3) Entry Two (External draft v1): process sentences from reference allowed, placeholder intercepted
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
// 4) Entry 3 (external draft v2): A discount original text verbatim drafting -> declare judgment unknown
// -> intercept
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
// Aggregate + archive
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
