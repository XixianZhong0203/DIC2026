// Window 3 - Key assertion verification for chat responses - End-to-end acceptance
//
// After each chat response, Daymark compares the key decision-influencing statements in the response
// (customer intent / signing / quotation / delivery) item by item with the "actual records retrieved in
// this round", and flags assertions lacking basis next to the response:
// Insufficient evidence / Source conflict / Verification failed / Grounded, and provides verbatim quotes
// along with source text entry points.
// Verification does not modify the response and does not block the sending path; failures are only
// recorded in claimCheck.error.
//
// Core acceptance (task specification scenarios):
// Source says only "willing to sign" while response says "contract signed" -> even with a real verbatim
// quote attached, the "signing" conclusion is still flagged as "Insufficient evidence · Pending
// confirmation";
// Adding a signed contract record and asking again -> the same statement changes to "Grounded", pointing
// to that record;
// Adding a conflicting record (customer temporarily delays signing, contract not signed) -> changes to
// "Source conflict", with source texts from both sides comparable.
// Additional acceptance: verification requests indeed carry the records retrieved in this round;
// verification failure (model output unparseable) does not drop the response;
// Session and model selection remain unchanged (trace.attemptedModel / claimCheck.model).
//
// Usage:
// node scripts/chat-claims-acceptance.mjs # All assertions, exit code 0/1
//
// Same approach as existing acceptance scripts: temporary directory + dedicated port to start the real
// service (byte-level copy of working tree, replacing only src/models.mjs with the local mock directory to
// isolate real model endpoints), model requests hit the local deterministic mock (response queue /
// verification queue separated, extra or incorrect fetches are recorded as FAIL).

import { spawn } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4473;
const MOCK_PORT = 4497;
const BASE = 'http://127.0.0.1:' + PORT;
const PROJECT = '客户 A';

// ---------------------------------------------------------------------------
// Preset corpus
// ---------------------------------------------------------------------------
const REC_INTENT = '客户表示愿意签约，期待合同文本。';
const REC_CONTRACT = '2026-11-12 双方已签署合同，合同文本已归档。';
const REC_CONFLICT = '客户暂缓签约。合同未签署。需重新评估。';
// The response deliberately states "willing to sign" as "contract signed" -- acceptance assertion:
// verification must flag this unsupported statement.
const ANSWER = '客户愿意签约；合同已签署。';

const checkClaim = (items, missing, rewrite) => JSON.stringify({ claims: [{
  id: '签约', dimension: '签约', text: '合同已签署', items, missing, rewrite,
}] });
const item = (evidenceId, stance, quote, note) => ({ evidenceId, stance, quote, note, revises: [] });

// ---------------------------------------------------------------------------
// Deterministic mock model: chat responses and key assertion verifications are separated into two queues
// (queue order = process order, extra or incorrect fetches are recorded as FAIL); verification requests
// are routed by prompt prefix and never consume the response queue.
// ---------------------------------------------------------------------------
const chatQ = [];
const checkQ = [];
const modelRequests = [];
function makeMock() {
  const take = (queue, label) => {
    const next = queue.shift();
    if (next == null) record('mock model queue ' + label, 'FAIL', 'unexpected request: ' + label);
    return next;
  };
  const server = createServer((req, res) => {
    let payload = '';
    req.on('data', chunk => { payload += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.includes('chat/completions')) {
        res.statusCode = 404; res.end('not found'); return;
      }
      const parsed = JSON.parse(payload);
      modelRequests.push(parsed);
      const system = (parsed.messages ?? []).find(m => m.role === 'system')?.content ?? '';
      let canned;
      if (system.includes('你是聊天回答的声明核查器')) {
        canned = take(checkQ, 'chat-claims') ?? '{"claims":[]}';
      } else {
        canned = take(chatQ, 'chat') ?? '{"answer":"（模拟模型）队列意外。"}';
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: typeof canned === 'string' ? canned : JSON.stringify(canned) } }] }));
    });
  });
  server.listen(MOCK_PORT, '127.0.0.1');
  return { close: () => new Promise(resolve => server.close(resolve)), };
}

// ---------------------------------------------------------------------------
// Temporary working directory: byte-level copy of the working tree, replacing only src/models.mjs with the
// local mock directory.
// ---------------------------------------------------------------------------
const MOCK_MODELS = `// 测试模型目录（chat-claims 验收窗口）：单一本地 mock 模型，指向脚本启动的
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
  const dir = mkdtempSync(path.join(tmpdir(), 'daymark-chat-claims-'));
  cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  cpSync(path.join(root, 'dist'), path.join(dir, 'dist'), { recursive: true });
  copyFileSync(path.join(root, 'server.mjs'), path.join(dir, 'server.mjs'));
  copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  writeFileSync(path.join(dir, 'src', 'models.mjs'), MOCK_MODELS);
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir);
  return { dir, dataDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Result recording + client
// ---------------------------------------------------------------------------
const results = [];
function record(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log('  ' + status + '  ' + name + (detail ? '  · ' + detail : ''));
}
const passed = () => results.filter(r => r.status === 'PASS').length;
const failed = () => results.filter(r => r.status === 'FAIL').length;

async function api(route, body) {
  const options = body === undefined ? { method: 'GET' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const response = await fetch(BASE + route, options);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data, error: data.error ?? null };
}
const state = async () => (await api('/api/state')).data;
const lastAssistant = (snapshot, conversationId) =>
  (snapshot.messages ?? []).filter(m => m.conversation_id === conversationId && m.role === 'assistant').at(-1);
const checkRequest = () => {
  for (let i = modelRequests.length - 1; i >= 0; i--) {
    const system = (modelRequests[i].messages ?? []).find(m => m.role === 'system')?.content ?? '';
    if (system.includes('你是聊天回答的声明核查器')) return modelRequests[i];
  }
  return null;
};
const userJson = req => { try { return JSON.parse((req?.messages ?? []).find(m => m.role === 'user')?.content ?? '{}'); } catch { return {}; } };

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const mock = makeMock();
const workDir = buildWorkDir();
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: workDir.dir,
  env: { ...process.env, DAYMARK_DATA_DIR: workDir.dataDir, PORT: String(PORT),
    OPENAI_BASE_URL: 'http://127.0.0.1:' + MOCK_PORT + '/v1', MODEL_ID: 'mock-model', MOCK_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });

const cleanup = code => {
  server.kill('SIGTERM');
  mock.close().then(() => {
    workDir.cleanup();
    process.exit(code);
  });
};

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(BASE + '/api/state')).ok; } catch {
    if (server.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
if (!up) {
  console.log('FAIL  server did not start（若提示端口占用，检查是否有残留 Daymark 进程）\n' + serverLog);
  cleanup(1);
}

console.log('\nAcceptance: 聊天回答的关键断言核查（mock 模型，确定性）');

const conv = (await api('/api/conversation', { title: '客户 A 签约跟进', project: PROJECT })).data.conversation;
const intentRec = await api('/api/memory', { kind: 'source', scope: PROJECT, body: REC_INTENT, source: '客户邮件' });
record('save the intent record (客户愿意签约)', intentRec.ok ? 'PASS' : 'FAIL', intentRec.error ?? '');
const rec1Id = (await state()).memory.find(r => r.body === REC_INTENT)?.id;

// ---------------------------------------------------------------------------
// 1) Core acceptance: source says only "willing to sign", response says "contract signed" -> signing
// assertion pending confirmation
// ---------------------------------------------------------------------------
console.log('\n1) 来源只说「愿意签约」，回答却说「合同已签署」');
chatQ.push({ answer: ANSWER, facts: [{ id: rec1Id, quote: '愿意签约' }], inferences: [], unknowns: [],
  citations: [rec1Id], conflict: '', proposal: null, question: '', understood: '核对客户签约进展。' });
checkQ.push(checkClaim(
  [item(String(rec1Id), 'neutral', '愿意签约', '客户只表达意愿，未陈述已签署。')],
  '缺少已签署合同的记录。', '客户愿意签约，合同是否签署尚未确认。'));
let r = await api('/api/chat', { text: '客户签约进展如何？', language: 'zh-CN', conversation_id: conv });
record('chat replies while the claim check runs', r.ok ? 'PASS' : 'FAIL', r.error ?? '');
let st = await state();
let reply = lastAssistant(st, conv);
record('the reply is stored verbatim (the check never rewrites it)',
  reply?.body === ANSWER ? 'PASS' : 'FAIL', reply?.body ?? '');
record('verbatim quotes still count as verbatim evidence', reply?.review?.evidence === 'verbatim' ? 'PASS' : 'FAIL',
  'evidence=' + reply?.review?.evidence);
record('the signing claim is marked pending despite a valid verbatim quote',
  reply?.review?.claimCheck?.claims?.[0]?.status === 'unknown' ? 'PASS' : 'FAIL',
  JSON.stringify(reply?.review?.claimCheck?.claims?.map(c => ({ status: c.status, dimension: c.dimension }))));
record('the neutral intent quote is recorded (intent is not a completed fact)',
  reply?.review?.claimCheck?.claims?.[0]?.items?.[0]?.stance === 'neutral' ? 'PASS' : 'FAIL',
  JSON.stringify(reply?.review?.claimCheck?.claims?.[0]?.items ?? []));
record('the check records its prompt version and model',
  reply?.review?.claimCheck?.prompt === 'chat-claims-v1' && reply?.review?.claimCheck?.model === 'mock-model' ? 'PASS' : 'FAIL',
  'prompt=' + reply?.review?.claimCheck?.prompt + ' model=' + reply?.review?.claimCheck?.model);
// Verify that the request actually carries the records retrieved in this round (sources in the user JSON).
const check1 = checkRequest();
const check1Sources = userJson(check1)?.sources ?? [];
record('the check request carries the records retrieved this round',
  check1Sources.some(s => s.text === REC_INTENT) ? 'PASS' : 'FAIL',
  'sources=' + check1Sources.map(s => s.id + ':' + s.text.slice(0, 12)).join(' '));
record('the check request checks the exact answer text',
  userJson(check1)?.answer === ANSWER && userJson(check1)?.mode === 'chat' ? 'PASS' : 'FAIL');

// ---------------------------------------------------------------------------
// 2) Supplement with signed contract records -> Convert the same statement to "supported", pointing to the
// record
// ---------------------------------------------------------------------------
console.log('\n2) 补入已签署合同记录');
const contractRec = await api('/api/memory', { kind: 'source', scope: PROJECT, body: REC_CONTRACT, source: '合同归档' });
record('save the signed-contract record', contractRec.ok ? 'PASS' : 'FAIL', contractRec.error ?? '');
const rec2Id = (await state()).memory.find(r => r.body === REC_CONTRACT)?.id;
chatQ.push({ answer: ANSWER, facts: [{ id: rec1Id, quote: '愿意签约' }], inferences: [], unknowns: [],
  citations: [rec1Id], conflict: '', proposal: null, question: '', understood: '核对客户签约进展。' });
checkQ.push(checkClaim(
  [
    item(String(rec1Id), 'neutral', '愿意签约', '客户表达签约意愿。'),
    item(String(rec2Id), 'supports', '双方已签署合同', '合同归档记录陈述已签署。'),
  ], '', ''));
r = await api('/api/chat', { text: '客户签约和合同进展如何？', language: 'zh-CN', conversation_id: conv });
record('second chat runs with the new record retrieved', r.ok ? 'PASS' : 'FAIL', r.error ?? '');
st = await state();
reply = lastAssistant(st, conv);
record('the same claim is now grounded (有依据)',
  reply?.review?.claimCheck?.claims?.[0]?.status === 'supported' ? 'PASS' : 'FAIL',
  JSON.stringify(reply?.review?.claimCheck?.claims?.map(c => c.status)));
record('the grounded verdict points at the contract record',
  reply?.review?.claimCheck?.claims?.[0]?.decisive?.source?.id === String(rec2Id) ? 'PASS' : 'FAIL',
  'decisive=' + reply?.review?.claimCheck?.claims?.[0]?.decisive?.source?.id);
record('retrieval kept both records in the trace',
  (reply?.review?.trace?.retrieved ?? []).map(x => x.id).join(',') === [rec1Id, rec2Id].sort((a, b) => a - b).join(',')
    ? 'PASS' : 'FAIL', JSON.stringify(reply?.review?.trace?.retrieved ?? []));

// ---------------------------------------------------------------------------
// 3) Supplement with contrary records -> "Source conflict", original texts from both sides can be compared
// ---------------------------------------------------------------------------
console.log('\n3) 补入相反记录：客户暂缓签约');
const conflictRec = await api('/api/memory', { kind: 'source', scope: PROJECT, body: REC_CONFLICT, source: '客户回复' });
record('save the conflicting record', conflictRec.ok ? 'PASS' : 'FAIL', conflictRec.error ?? '');
const rec3Id = (await state()).memory.find(r => r.body === REC_CONFLICT)?.id;
chatQ.push({ answer: ANSWER, facts: [{ id: rec1Id, quote: '愿意签约' }], inferences: [], unknowns: [],
  citations: [rec1Id], conflict: '', proposal: null, question: '', understood: '核对客户签约进展。' });
checkQ.push(checkClaim(
  [
    item(String(rec2Id), 'supports', '双方已签署合同', '合同归档记录陈述已签署。'),
    item(String(rec3Id), 'refutes', '合同未签署', '客户回复称合同未签署。'),
  ], '需确认以哪条记录为准。', ''));
r = await api('/api/chat', { text: '合同和签约现在到底什么情况？', language: 'zh-CN', conversation_id: conv });
record('third chat retrieves all three records', r.ok ? 'PASS' : 'FAIL', r.error ?? '');
st = await state();
reply = lastAssistant(st, conv);
record('the claim becomes a source conflict (not a silent conclusion)',
  reply?.review?.claimCheck?.claims?.[0]?.status === 'conflict' ? 'PASS' : 'FAIL',
  JSON.stringify(reply?.review?.claimCheck?.claims?.map(c => c.status)));
record('both sides are kept for comparison',
  reply?.review?.claimCheck?.claims?.[0]?.conflict?.supports?.length === 1
    && reply?.review?.claimCheck?.claims?.[0]?.conflict?.opposes?.length === 1 ? 'PASS' : 'FAIL',
  JSON.stringify(reply?.review?.claimCheck?.claims?.[0]?.conflict ?? {}));

// ---------------------------------------------------------------------------
// 4) Verification failure is non-blocking: model output cannot be parsed -> claimCheck.error=parse_failed,
// answer is stored as usual
// ---------------------------------------------------------------------------
console.log('\n4) 核查失败不阻塞回答');
chatQ.push({ answer: ANSWER, facts: [{ id: rec1Id, quote: '愿意签约' }], inferences: [], unknowns: [],
  citations: [rec1Id], conflict: '', proposal: null, question: '', understood: '核对客户签约进展。' });
checkQ.push('this is not JSON');
r = await api('/api/chat', { text: '客户签约进展如何？', language: 'zh-CN', conversation_id: conv });
record('the reply still lands when the check fails to parse', r.ok ? 'PASS' : 'FAIL', r.error ?? '');
st = await state();
reply = lastAssistant(st, conv);
record('the failure is recorded as parse_failed',
  reply?.review?.claimCheck?.error === 'parse_failed' ? 'PASS' : 'FAIL',
  'error=' + reply?.review?.claimCheck?.error + ' claims=' + JSON.stringify(reply?.review?.claimCheck?.claims ?? null));
record('the stored answer is unchanged', reply?.body === ANSWER ? 'PASS' : 'FAIL');

// ---------------------------------------------------------------------------
// 5) Retain session and model selection
// ---------------------------------------------------------------------------
console.log('\n5) 会话与模型选择保持不变');
st = await state();
const conversation = (st.conversations ?? []).find(c => c.id === conv);
record('the conversation keeps its workspace and model',
  conversation?.project === PROJECT && conversation?.model === 'mock-model' ? 'PASS' : 'FAIL',
  'project=' + conversation?.project + ' model=' + conversation?.model);
record('the reply trace keeps the attempted model and retrieved records',
  lastAssistant(st, conv)?.review?.trace?.attemptedModel === 'mock-model'
    && (lastAssistant(st, conv)?.review?.trace?.retrieved ?? []).length > 0 ? 'PASS' : 'FAIL');
record('exactly two model calls per chat (reply + check), no extras',
  modelRequests.length === 8 ? 'PASS' : 'FAIL', 'model requests=' + modelRequests.length);

// ---------------------------------------------------------------------------
console.log('\nSummary: ' + passed() + ' passed, ' + failed() + ' failed · '
  + (failed() ? 'FAIL' : 'All acceptance points passed.'));
await cleanup(failed() ? 1 : 0);
