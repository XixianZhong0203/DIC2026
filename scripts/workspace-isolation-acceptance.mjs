// Acceptance flow for cross-workspace context isolation.
//
//   two workspaces with different quote rules (Alpha: 八折, Beta: 原价) →
//   a cross-workspace merge of a session with history is refused →
//   a cross-workspace move of a session with history is refused →
//   the target workspace's replies never see the old chat's quotes,
//   customer promises or decision cards (asserted on the model request) →
//   same-workspace merge still works →
//   explicit record import copies a record into the target workspace while
//   keeping its original workspace and source, and the model sees it there.
//
//   node scripts/workspace-isolation-acceptance.mjs
//
// The script starts a fresh server (temporary data dir, dedicated port)
// wired to a deterministic mock model on a local port, so every step runs
// without a live model. The isolation proof is checked where it actually
// happens: on the model request itself (system records + history). The
// trace is written to docs/evidence/workspace-isolation-acceptance-<ts>.json.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4198;
const mockPort = 4201;
const base = 'http://127.0.0.1:' + port;
const ALPHA = 'Alpha 项目';
const BETA = 'Beta 项目';

const alphaRuleBody = '报价规则：Alpha 项目的所有报价按八折计算。';
const betaRuleBody = '报价规则：Beta 项目的所有报价按原价，不打折。';
const alphaPromiseBody = '客户承诺：11 月 30 日前签约，额外赠送三个月服务。';
const globalPrefBody = '所有项目的对外文档附中文摘要。';

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

// A rule/preference save goes through the pre-save review route, exactly
// like the memory form does (/api/memory-impact snapshot bound to /api/memory).
async function saveThroughReview(kind, scope, body, source, replaces = null) {
  const impact = await api('/api/memory-impact', { kind, scope, body, replaces });
  if (!impact.ok) return impact;
  return api('/api/memory', { kind, scope, body, source, replaces,
    snapshot: impact.data.snapshot, review_base: replaces });
}
const findMemory = (data, body) => (data.memory ?? []).find(item => item.body === body);

// ---------------------------------------------------------------------------
// Mock model: records every request and answers from a per-step canned queue,
// so the whole flow is deterministic and the isolation proof can be asserted
// on the request the server actually builds for the model.
// ---------------------------------------------------------------------------
const modelRequests = [];
let cannedQueue = [];
const cannedPlain = {
  answer: '（模拟模型）已按当前工作区记录作答。',
  facts: [], inferences: [], unknowns: [], citations: [],
  conflict: '', proposal: null, question: '', understood: '核对当前工作区记录。',
};
// The Alpha chat: the conflict makes the server attach a preference decision
// card to the reply — the card must stay with Alpha, never reach Beta.
const cannedAlpha = {
  answer: 'Alpha 项目的报价按八折计算；客户承诺 11 月 30 日前签约额外赠送三个月服务。',
  facts: [], inferences: [], unknowns: [], citations: [],
  conflict: '用户说 Alpha 报价要按原价，与已确认的八折报价规则冲突。',
  proposal: null, question: '', understood: '核对 Alpha 项目报价与客户承诺。',
};
const mock = createServer((req, res) => {
  let payload = '';
  req.on('data', chunk => { payload += chunk; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(payload);
      modelRequests.push(parsed);
      const canned = cannedQueue.length ? cannedQueue.shift() : cannedPlain;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(canned) } }] }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
});
await mock.listen(mockPort, '127.0.0.1');

const dataDir = await mkdtemp(path.join(tmpdir(), 'daymark-isolation-'));
const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.mjs'], {
  cwd: root,
  env: { ...process.env, DAYMARK_DATA_DIR: dataDir, PORT: String(port),
    OPENAI_BASE_URL: 'http://127.0.0.1:' + mockPort + '/v1', MODEL_ID: 'mock-model', OPENAI_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });

function cleanup(code) {
  server.kill('SIGTERM');
  mock.close();
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
console.log('\nAcceptance: cross-workspace context isolation (mock model, deterministic)');

const systemOf = req => (req?.messages ?? []).find(message => message.role === 'system')?.content ?? '';
const restOf = req => (req?.messages ?? []).filter(message => message.role !== 'system').map(message => message.content).join('\n');
const messagesOf = (state, id) => (state.messages ?? []).filter(message => message.conversation_id === id);
const assistantOf = (state, id) => messagesOf(state, id).filter(message => message.role === 'assistant').pop() ?? null;

console.log('\n1) Seed two workspaces with different quote rules');
let save = await saveThroughReview('rule', ALPHA, alphaRuleBody, 'Alpha 项目会议 · 用户确认');
record('save the Alpha quote rule (八折)', save.ok ? 'PASS' : 'FAIL', save.error ?? '');
save = await saveThroughReview('rule', BETA, betaRuleBody, 'Beta 项目会议 · 用户确认');
record('save the Beta quote rule (原价)', save.ok ? 'PASS' : 'FAIL', save.error ?? '');
save = await api('/api/memory', { kind: 'fact', scope: ALPHA, body: alphaPromiseBody, source: 'Alpha 客户邮件 · 11 月 10 日' });
record('save the Alpha customer promise (fact)', save.ok ? 'PASS' : 'FAIL', save.error ?? '');
save = await saveThroughReview('preference', '*', globalPrefBody, '用户确认的全局偏好');
record('save a global (*) preference', save.ok ? 'PASS' : 'FAIL', save.error ?? '');
let state = (await api('/api/state')).data;
const alphaRuleId = findMemory(state, alphaRuleBody)?.id;
const globalPrefId = findMemory(state, globalPrefBody)?.id;
if (!save.ok || !alphaRuleId || !globalPrefId) await cleanup(1);

const convA = (await api('/api/conversation', { project: ALPHA })).data.conversation;
const convB = (await api('/api/conversation', { project: BETA })).data.conversation;

console.log('\n2) A chat in Alpha, with its quote, promise and a decision card');
cannedQueue = [cannedAlpha];
const chatA = await api('/api/chat', { text: 'Alpha 项目的报价规则是什么？客户承诺过什么？', language: 'zh-CN', conversation_id: convA });
state = (await api('/api/state')).data;
const alphaAssistant = assistantOf(state, convA);
record('Alpha reply recorded (message pair + decision card on its own history)',
  chatA.ok && alphaAssistant?.review?.decision ? 'PASS' : 'FAIL',
  'decision=' + JSON.stringify(alphaAssistant?.review?.decision?.kind ?? null) + ' messages=' + messagesOf(state, convA).length);

console.log('\n3) Cross-workspace merge and move are refused');
const merge = await api('/api/conversation-merge', { id: convA, target: convB });
record('cross-workspace merge is refused', merge.status === 409 ? 'PASS' : 'FAIL',
  merge.error ?? ('status ' + merge.status));
const move = await api('/api/conversation-edit', { id: convA, project: BETA });
record('cross-workspace move of a session with history is refused', move.status === 409 ? 'PASS' : 'FAIL',
  move.error ?? ('status ' + move.status));
state = (await api('/api/state')).data;
const alphaConv = (state.conversations ?? []).find(item => item.id === convA);
record('Alpha keeps its workspace and full history after the refused attempts',
  alphaConv?.project === ALPHA && messagesOf(state, convA).length === 2 ? 'PASS' : 'FAIL',
  'project=' + JSON.stringify(alphaConv?.project) + ' messages=' + messagesOf(state, convA).length);
record('the Beta conversation received no history', messagesOf(state, convB).length === 0 ? 'PASS' : 'FAIL',
  'messages=' + messagesOf(state, convB).length);
record('no Alpha quote/promise record exists in the Beta scope',
  (state.memory ?? []).filter(item => item.scope === BETA).every(item => !item.body.includes('八折') && !item.body.includes('赠送三个月'))
    ? 'PASS' : 'FAIL');

console.log('\n4) Beta replies never see Alpha quotes, promises or decision cards');
modelRequests.length = 0;
cannedQueue = [cannedPlain];
const chatB = await api('/api/chat', { text: 'Beta 项目的报价规则是什么？', language: 'zh-CN', conversation_id: convB });
state = (await api('/api/state')).data;
const betaAssistant = assistantOf(state, convB);
const req1 = modelRequests.at(-1);
record('Beta reply request retrieves no Alpha records',
  chatB.ok && !systemOf(req1).includes('八折') && !systemOf(req1).includes('赠送三个月') ? 'PASS' : 'FAIL',
  'system has alpha rule=' + systemOf(req1).includes('八折') + ' alpha promise=' + systemOf(req1).includes('赠送三个月'));
record('the Beta reply request keeps the Beta rule', systemOf(req1).includes('原价') ? 'PASS' : 'FAIL');
record('the Beta reply history carries no Alpha chat text (quotes/promises/decision cards)',
  !restOf(req1).includes('客户承诺过什么') && !restOf(req1).includes('八折') ? 'PASS' : 'FAIL',
  'history=' + JSON.stringify(restOf(req1).slice(0, 120)));
record('the Beta reply trace reads the Beta scope', betaAssistant?.review?.trace?.scope === BETA ? 'PASS' : 'FAIL',
  'scope=' + JSON.stringify(betaAssistant?.review?.trace?.scope));

console.log('\n5) Same-workspace merge still works');
const convA2 = (await api('/api/conversation', { project: ALPHA })).data.conversation;
cannedQueue = [cannedPlain];
const chatA2 = await api('/api/chat', { text: 'Alpha 项目下一步做什么？', language: 'zh-CN', conversation_id: convA2 });
state = (await api('/api/state')).data;
const a2Count = messagesOf(state, convA2).length;
const merged = await api('/api/conversation-merge', { id: convA2, target: convA });
state = (await api('/api/state')).data;
record('same-workspace merge moves the history and drops the source session',
  chatA2.ok && merged.ok && !(state.conversations ?? []).some(item => item.id === convA2) &&
  messagesOf(state, convA).length === 2 + a2Count ? 'PASS' : 'FAIL',
  'merged=' + merged.ok + ' alpha messages=' + messagesOf(state, convA).length);
const sameMove = await api('/api/conversation-edit', { id: convA, project: ALPHA });
record('a same-workspace move is still allowed', sameMove.ok ? 'PASS' : 'FAIL', sameMove.error ?? '');
const convEmpty = (await api('/api/conversation', { project: ALPHA })).data.conversation;
const emptyMove = await api('/api/conversation-edit', { id: convEmpty, project: BETA });
state = (await api('/api/state')).data;
record('a session without messages can change workspace',
  emptyMove.ok && (state.conversations ?? []).find(item => item.id === convEmpty)?.project === BETA ? 'PASS' : 'FAIL');

console.log('\n6) Explicit record import keeps the original workspace and source');
const imp = await api('/api/memory-import', { record_id: alphaRuleId, scope: BETA });
state = imp.data;
const imported = (state.memory ?? []).find(item => item.id === imp.data.imported);
record('import copies the Alpha rule into Beta with full provenance',
  imp.ok && imported?.scope === BETA && imported?.kind === 'rule' && imported?.body === alphaRuleBody &&
  imported?.source === '来自「' + ALPHA + '」的记录 #' + alphaRuleId + ' · ' + 'Alpha 项目会议 · 用户确认'
    ? 'PASS' : 'FAIL', 'source=' + JSON.stringify(imported?.source));
const alphaStill = (state.memory ?? []).find(item => item.id === alphaRuleId);
record('the original record stays in Alpha and is not superseded',
  alphaStill?.scope === ALPHA && alphaStill?.superseded === 0 ? 'PASS' : 'FAIL',
  'scope=' + JSON.stringify(alphaStill?.scope) + ' superseded=' + alphaStill?.superseded);
const again = await api('/api/memory-import', { record_id: alphaRuleId, scope: BETA });
record('re-importing the same record is idempotent',
  again.ok && again.data.already === true && again.data.imported === imp.data.imported ? 'PASS' : 'FAIL');
const sameScope = await api('/api/memory-import', { record_id: alphaRuleId, scope: ALPHA });
record('importing into the record\'s own workspace is refused', sameScope.status === 400 ? 'PASS' : 'FAIL',
  sameScope.error ?? ('status ' + sameScope.status));
const globalImp = await api('/api/memory-import', { record_id: globalPrefId, scope: BETA });
record('importing a global record is refused (visible everywhere)', globalImp.status === 400 ? 'PASS' : 'FAIL',
  globalImp.error ?? ('status ' + globalImp.status));
const globalTarget = await api('/api/memory-import', { record_id: alphaRuleId, scope: ' * ' });
const afterGlobalTarget = (await api('/api/state')).data;
record('project records cannot be imported into global memory',
  globalTarget.status === 400 && globalTarget.error === '不能将项目记录带入全局范围。' &&
    !afterGlobalTarget.memory.some(item => item.scope === '*' && item.body === alphaRuleBody)
    ? 'PASS' : 'FAIL', globalTarget.error ?? '');

const missing = await api('/api/memory-import', { record_id: 99999, scope: BETA });
record('importing a missing record is refused', missing.status === 404 ? 'PASS' : 'FAIL');

console.log('\n7) The imported record reaches the Beta model with its provenance');
modelRequests.length = 0;
cannedQueue = [cannedPlain];
const chatB2 = await api('/api/chat', { text: '现在 Beta 项目对外报价怎么算？', language: 'zh-CN', conversation_id: convB });
const req2 = modelRequests.at(-1);
record('the Beta reply sees the imported rule and its original workspace/source',
  chatB2.ok && systemOf(req2).includes('八折') && systemOf(req2).includes('来自「' + ALPHA + '」的记录') ? 'PASS' : 'FAIL',
  'has rule=' + systemOf(req2).includes('八折') + ' provenance=' + systemOf(req2).includes('来自「' + ALPHA + '」的记录'));
record('still no Alpha chat history in the Beta request',
  !restOf(req2).includes('客户承诺过什么') && !restOf(req2).includes('赠送三个月') ? 'PASS' : 'FAIL');

console.log('\n8) Reserved project names and Chinese delivery retrieval');
const beforeRejected = modelRequests.length;
const invalidCreate = await api('/api/conversation', { project: ' * ' });
const invalidMove = await api('/api/conversation-edit', { id: convB, project: '*' });
const invalidChat = await api('/api/chat', { project: '*', text: '交付安排', language: 'zh-CN' });
record('the wildcard cannot create, move or start a conversation',
  [invalidCreate, invalidMove, invalidChat].every(result => result.status === 400) &&
    modelRequests.length === beforeRejected ? 'PASS' : 'FAIL');
const legacy = (await api('/api/conversation', { project: ALPHA })).data.conversation;
const database = new DatabaseSync(path.join(dataDir, 'daymark.sqlite'));
database.prepare('UPDATE conversations SET project = ? WHERE id = ?').run('*', legacy);
database.close();
const legacyChat = await api('/api/chat', { conversation_id: legacy, text: '交付安排', language: 'zh-CN' });
const legacyIntent = await api('/api/chat-intent', { conversation_id: legacy, text: '交付安排', language: 'zh-CN' });
const legacyCandidates = await api('/api/memory-candidates', { conversation_id: legacy, language: 'zh-CN' });
const legacyState = (await api('/api/state')).data;
record('legacy wildcard chats cannot send stored context to a model',
  [legacyChat, legacyIntent, legacyCandidates].every(result => result.status === 409) &&
    !legacyState.workspaces.includes('*') && modelRequests.length === beforeRejected ? 'PASS' : 'FAIL');

const alphaDelivery = '交付安排：客户周三收货，地址在松园。';
const betaDelivery = '交付安排：客户周五收货，地址在竹园。';
const alphaSaved = await api('/api/memory', { kind: 'fact', scope: ALPHA, body: alphaDelivery, source: '客户甲邮件' });
const betaSaved = await api('/api/memory', { kind: 'fact', scope: BETA, body: betaDelivery, source: '客户乙邮件' });
const deliveryChat = await api('/api/chat', {
  conversation_id: convB, text: '客户的交付安排是什么？', language: 'zh-CN',
});
const deliveryPrompt = systemOf(modelRequests.at(-1));
record('Chinese retrieval includes Beta delivery and excludes the similar Alpha record',
  alphaSaved.ok && betaSaved.ok && deliveryChat.ok &&
    deliveryPrompt.includes(betaDelivery) && !deliveryPrompt.includes(alphaDelivery) ? 'PASS' : 'FAIL');

const summary = {
  at: new Date().toISOString(), modelLive: true,
  results, summary: { passed: passed(), skipped: skipped(), failed: failed() },
  serverLog: serverLog.slice(-2000),
};
const evidenceDir = path.join(root, 'docs', 'evidence');
await mkdir(evidenceDir, { recursive: true });
const traceFile = path.join(evidenceDir, 'workspace-isolation-acceptance-' + Date.now() + '.json');
await writeFile(traceFile, JSON.stringify(summary, null, 2));
console.log('\nSummary: ' + passed() + ' passed, ' + skipped() + ' skipped, ' + failed() + ' failed · trace: ' + traceFile);
await cleanup(failed() ? 1 : 0);
