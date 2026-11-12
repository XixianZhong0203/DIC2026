// Acceptance flow for the evidence answer（证据不足时怎么说、怎么继续）.
//
//   验收场景（同一条线索：客户「想看案例」）：
//     1) 先只有「想看案例」→ 当前回答必须是：已确认什么 / 缺少哪条信息 / 下一步可以怎么做
//        （具体缺口 + 可操作建议），而不是笼统的「证据不足」。
//     2) 补来一条明确表达签约意向的回复 → 系统更新结论（有边界的明确结论），并指向新增来源。
//     5) 混合案例（另一条线索）：客户已明确表达签约意向（客户来源支持），
//        但「合同已签约」只有创始人陈述 → 回答同时显示已确认的意向与待核实的签署状态
//        （pending 列出 founder_only 声明，依据来源不指向创始人陈述）。
//   另加两个情形：来源相互矛盾（展示需要比较的记录，不擅自下结论）；模型核查失败（可重试）。
//
//   node scripts/evidence-answer-acceptance.mjs
//
// The script starts a deterministic OpenAI-compatible mock model (no Ollama
// needed) plus a fresh Daymark server (temporary data dir, dedicated ports),
// and drives the real /api/opportunity, /api/opportunity-assess,
// /api/opportunity-source, /api/opportunity-claims and /api/state routes.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPort = 4197;
const modelPort = 4297;
const base = 'http://127.0.0.1:' + serverPort;

// ---------------------------------------------------------------------------
// Deterministic mock model (OpenAI-compatible /v1/chat/completions).
// Two call shapes exist in the lead flow:
//   assess  — user JSON has { request, evidence, source }
//   claims  — user JSON has { mode, dimensions, claims, sources }
// mockFailMode lets the script force one verification failure (and its retry)
// by flipping a flag in this process.
let mockFailMode = false;
const intentText = '客户明确表示：我们希望尽快签约。';
const contradictionText = '客户希望改为下周一。';
const founderSignedText = '客户已签约。';
function unknownClaims() {
  return JSON.stringify({ claims: [
    { id: '购买意向', dimension: '购买意向', text: '客户想先看案例', status: 'unknown',
      items: [], missing: '还缺客户明确的签约回复。', rewrite: '客户想先看案例，意向未确认。' },
    { id: '签约状态', dimension: '签约状态', text: '客户已签约', status: 'unknown',
      items: [], missing: '合同是否签署仍待确认。', rewrite: '尚未确认合同是否签署。' },
  ] });
}
function mockReply(input) {
  if (input.mode === 'analysis') {
    if (mockFailMode) return '模型服务内部错误（验收脚本强制失败）。';
    const sources = input.sources ?? [];
    const intent = sources.find(source => source.text?.includes('希望尽快签约'));
    const contradiction = sources.find(source => source.text?.includes('希望改为下周一'));
    const founderSigned = sources.find(source => source.kind === 'founder' && source.text?.includes('已签约'));
    if (intent && contradiction) {
      // 同一声明同时被两条来源支持又反驳 → 核查判为来源冲突（conflict 带双方原文）。
      return JSON.stringify({ claims: [
        { id: '购买意向', dimension: '购买意向', text: '客户有签约意向', status: 'conflict',
          items: [
            { evidenceId: intent.id, stance: 'supports', quote: '我们希望尽快签约', note: '客户明确表达签约意向' },
            { evidenceId: contradiction.id, stance: 'refutes', quote: '希望改为下周一', note: '客户希望改期，与签约意向冲突' },
          ],
          missing: '请确认以哪条记录为准。', rewrite: '' },
        { id: '签约状态', dimension: '签约状态', text: '客户已签约', status: 'unknown',
          items: [], missing: '合同是否签署仍待确认。', rewrite: '尚未确认合同是否签署。' },
      ] });
    }
    if (intent && founderSigned) {
      // 混合案例：意向由客户来源支持，签署状态只有创始人陈述（核查器按来源身份判 founder_only）。
      return JSON.stringify({ claims: [
        { id: '购买意向', dimension: '购买意向', text: '客户有签约意向', status: 'supported',
          items: [{ evidenceId: intent.id, stance: 'supports', quote: '我们希望尽快签约',
            note: '客户明确表示签约意向' }],
          missing: '', rewrite: '客户已明确表达签约意向。' },
        { id: '签约状态', dimension: '签约状态', text: '客户已签约', status: 'founder_only',
          items: [{ evidenceId: founderSigned.id, stance: 'supports', quote: '客户已签约',
            note: '创始人陈述已完成事实' }],
          missing: '', rewrite: '仅创始人陈述合同已签署。' },
      ] });
    }
    if (intent) {
      return JSON.stringify({ claims: [
        { id: '购买意向', dimension: '购买意向', text: '客户有签约意向', status: 'supported',
          items: [{ evidenceId: intent.id, stance: 'supports', quote: '我们希望尽快签约',
            note: '客户明确表示签约意向' }],
          missing: '', rewrite: '客户已明确表达签约意向。' },
        { id: '签约状态', dimension: '签约状态', text: '客户已签约', status: 'unknown',
          items: [], missing: '合同是否签署仍待确认。', rewrite: '合同是否签署仍待确认。' },
      ] });
    }
    return unknownClaims();
  }
  if (input.mode === 'draft') return JSON.stringify({ claims: [] });
  // assess：「想看案例」不构成签约意向 → unknown，缺口与下一步都写具体。
  return JSON.stringify({
    status: 'unknown', quote: '想先看案例',
    reason: '客户表示想先看案例；请求查看案例不构成购买意向。',
    unknown: '缺少客户明确的签约回复。', conflict: '',
    clarification: '客户是否有明确的签约意向？',
    suggestedReply: '可以先发案例并询问采购计划。',
  });
}

const model = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const parsed = JSON.parse(body || '{}');
    const userMessage = (parsed.messages ?? []).at(-1)?.content ?? '{}';
    let input = {};
    try { input = JSON.parse(userMessage); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: mockReply(input) } }] }));
  });
});
try {
  await new Promise((resolve, reject) => model.listen(modelPort, '127.0.0.1', resolve).on('error', reject));
} catch (error) {
  console.log('FAIL  mock model port ' + modelPort + ' is taken by another instance: ' + error.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
const dataDir = await mkdtemp(path.join(tmpdir(), 'daymark-evidence-answer-'));
const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    DAYMARK_DATA_DIR: dataDir,
    PORT: String(serverPort),
    OPENAI_BASE_URL: 'http://127.0.0.1:' + modelPort + '/v1',
    MODEL_ID: 'deterministic-mock',
  },
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
const cleanup = code => {
  server.kill('SIGTERM');
  model.close();
  return rm(dataDir, { recursive: true, force: true }).then(() => process.exit(code));
};

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try {
    const state = await (await fetch(base + '/api/state')).json().catch(() => ({}));
    // model 必须是我们注入的确定性模型，否则说明端口被别的服务占用（会误测别人的实例）。
    up = state.model === 'deterministic-mock' && state.live === true;
  } catch {
    if (server.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
if (!up) {
  console.log('FAIL  server did not start with the deterministic mock model (port ' + serverPort
    + ' may be taken by another instance)\n' + serverLog);
  await cleanup(1);
}
const leadByTitle = async title =>
  (await api('/api/state')).data.opportunities.find(item => item.title === title);

// ---------------------------------------------------------------------------
console.log('\n1) 线索：客户「想看案例」（仅此一条记录）');
const captured = await api('/api/opportunity', {
  kind: 'lead', title: '新客户：想先看案例', source: '客户线程',
  evidence: '客户表示想先看案例。',
});
if (!captured.ok) { record('create the lead', 'FAIL', captured.error ?? ''); await cleanup(1); }
record('create the lead', 'PASS');
const leadTitle = '新客户：想先看案例';
const id = (await api('/api/state')).data.opportunities.find(item => item.title === leadTitle).id;
const assessed = await api('/api/opportunity-assess', { id, request: '客户是否想签约？', language: 'zh-CN' });
record('assess the lead with the model', assessed.ok ? 'PASS' : 'FAIL', assessed.error ?? '');
if (!assessed.ok) await cleanup(1);

const a1 = (await leadByTitle(leadTitle)).answer;
record('the first answer is INSUFFICIENT, not a generic refusal',
  a1?.situation === 'insufficient' ? 'PASS' : 'FAIL',
  a1 ? 'situation=' + a1.situation : 'no answer stored');
record('it says what is confirmed (the case request)',
  a1?.confirmed?.includes('案例') ? 'PASS' : 'FAIL', a1?.confirmed ?? '');
record('it names the exact missing information (the signing reply)',
  /签约/.test(a1?.missing ?? '') ? 'PASS' : 'FAIL', a1?.missing ?? '');
record('it gives an actionable next step (send cases + ask about the purchase plan)',
  /案例/.test(a1?.next ?? '') && /采购计划/.test(a1?.next ?? '') ? 'PASS' : 'FAIL', a1?.next ?? '');
record('no supporting source is claimed for an unsupported conclusion',
  a1 && a1.supporting.length === 0 ? 'PASS' : 'FAIL');

// ---------------------------------------------------------------------------
console.log('\n2) 补来一条明确表达签约意向的回复');
const reply = await api('/api/opportunity-source', {
  id, name: '客户回复', date: '2026-07-10', kind: 'customer', text: intentText, language: 'zh-CN',
});
record('save the reply with explicit signing intent', reply.ok ? 'PASS' : 'FAIL', reply.error ?? '');
if (!reply.ok) await cleanup(1);

const a2 = (await leadByTitle(leadTitle)).answer;
record('the answer is updated to a SUFFICIENT, bounded conclusion',
  a2?.situation === 'sufficient' ? 'PASS' : 'FAIL',
  a2 ? 'situation=' + a2.situation : 'no answer');
record('confirmed: the signing intent is explicit',
  /签约意向/.test(a2?.confirmed ?? '') ? 'PASS' : 'FAIL', a2?.confirmed ?? '');
record('bounded: which step is still unconfirmed (the signed contract)',
  /合同是否签署仍待确认/.test(a2?.bounds ?? '') ? 'PASS' : 'FAIL', a2?.bounds ?? '');
record('the conclusion points at the newly added source',
  a2?.supporting?.some(source => source.id === 'S1' && /客户回复/.test(source.label)) ? 'PASS' : 'FAIL',
  JSON.stringify(a2?.supporting ?? []));
record('the stored analysis itself is unchanged (the answer, not the model output, was updated)',
  JSON.parse((await leadByTitle(leadTitle)).analysis).status === 'unknown' ? 'PASS' : 'FAIL');

// ---------------------------------------------------------------------------
console.log('\n3) 再补来一条相互矛盾的记录（来源冲突）');
const contradictory = await api('/api/opportunity-source', {
  id, name: '客户邮件', date: '2026-07-11', kind: 'customer', text: contradictionText, language: 'zh-CN',
});
record('save the contradictory record', contradictory.ok ? 'PASS' : 'FAIL', contradictory.error ?? '');
if (!contradictory.ok) await cleanup(1);
const a3 = (await leadByTitle(leadTitle)).answer;
record('the answer is now a CONFLICT, not a conclusion',
  a3?.situation === 'conflict' ? 'PASS' : 'FAIL', a3 ? 'situation=' + a3.situation : 'no answer');
record('the conflicting records to compare are shown (both sides)',
  a3?.compare?.length === 2 ? 'PASS' : 'FAIL', JSON.stringify((a3?.compare ?? []).map(entry => entry.id)));
record('the conflict answer does not claim a conclusion',
  a3 && a3.confirmed === '' ? 'PASS' : 'FAIL', a3?.confirmed ?? '');

// ---------------------------------------------------------------------------
console.log('\n4) 模型核查失败 → 可重试（另一条线索）');
const captured2 = await api('/api/opportunity', {
  kind: 'lead', title: '第二条线索', source: '客户线程', evidence: '客户表示想先看案例。',
});
record('create the second lead', captured2.ok ? 'PASS' : 'FAIL', captured2.error ?? '');
if (!captured2.ok) await cleanup(1);
const id2 = (await api('/api/state')).data.opportunities.find(item => item.title === '第二条线索').id;
mockFailMode = true;
const assessed2 = await api('/api/opportunity-assess', { id: id2, request: '客户是否想签约？', language: 'zh-CN' });
mockFailMode = false;
record('assess runs (the model call itself succeeds)', assessed2.ok ? 'PASS' : 'FAIL', assessed2.error ?? '');
const a4 = (await leadByTitle('第二条线索')).answer;
record('the failed verification is marked failed and RETRYABLE',
  a4?.situation === 'failed' && a4.retryable === true ? 'PASS' : 'FAIL',
  a4 ? 'situation=' + a4.situation + ' retryable=' + a4.retryable : 'no answer');
record('the failed answer does not claim a conclusion',
  a4 && a4.confirmed === '' ? 'PASS' : 'FAIL', a4?.confirmed ?? '');
const rechecked = await api('/api/opportunity-claims', { id: id2, target: 'analysis', language: 'zh-CN' });
record('the retry re-runs the analysis-target verification', rechecked.ok ? 'PASS' : 'FAIL', rechecked.error ?? '');
const a5 = (await leadByTitle('第二条线索')).answer;
record('after the retry the answer recovers to a usable state',
  a5?.situation === 'insufficient' && a5.retryable === false ? 'PASS' : 'FAIL',
  a5 ? 'situation=' + a5.situation : 'no answer');

// ---------------------------------------------------------------------------
console.log('\n5) 混合案例：明确签约意向（客户来源）+「合同已签约」只有创始人陈述');
const captured3 = await api('/api/opportunity', {
  kind: 'lead', title: '第三条线索：意向与创始人称已签约', source: '客户线程',
  evidence: '客户表示想先看案例。',
});
record('create the third lead', captured3.ok ? 'PASS' : 'FAIL', captured3.error ?? '');
if (!captured3.ok) await cleanup(1);
const mixedTitle = '第三条线索：意向与创始人称已签约';
const id3 = (await api('/api/state')).data.opportunities.find(item => item.title === mixedTitle).id;
const assessed3 = await api('/api/opportunity-assess', { id: id3, request: '客户是否想签约？', language: 'zh-CN' });
record('assess the mixed lead', assessed3.ok ? 'PASS' : 'FAIL', assessed3.error ?? '');
if (!assessed3.ok) await cleanup(1);
const intentSource = await api('/api/opportunity-source', {
  id: id3, name: '客户回复', date: '2026-07-10', kind: 'customer', text: intentText, language: 'zh-CN',
});
const founderSource = await api('/api/opportunity-source', {
  id: id3, name: '创始人记录', date: null, kind: 'founder', text: founderSignedText, language: 'zh-CN',
});
record('save the explicit intent (customer) and the signing statement (founder)',
  intentSource.ok && founderSource.ok ? 'PASS' : 'FAIL',
  intentSource.error ?? founderSource.error ?? '');
if (!intentSource.ok || !founderSource.ok) await cleanup(1);
const a6 = (await leadByTitle(mixedTitle)).answer;
record('the answer is SUFFICIENT and confirms the explicit intent',
  a6?.situation === 'sufficient' && /签约意向/.test(a6?.confirmed ?? '') ? 'PASS' : 'FAIL',
  a6 ? 'situation=' + a6.situation + ' confirmed=' + a6.confirmed : 'no answer');
record('the founder-only signing claim is listed as pending verification, not confirmed',
  a6?.pending?.some(entry => entry.status === 'founder_only') ? 'PASS' : 'FAIL',
  JSON.stringify(a6?.pending ?? []));
record('the pending item carries the dimension and the claim text',
  a6?.pending?.some(entry => entry.dimension === '签约状态' && entry.text === '客户已签约') ? 'PASS' : 'FAIL',
  JSON.stringify(a6?.pending ?? []));
record('the bounds name the unverified signing step as pending independent verification',
  /签署|签约/.test(a6?.bounds ?? '') && /待独立核实/.test(a6?.bounds ?? '') ? 'PASS' : 'FAIL',
  a6?.bounds ?? '');
record('supporting sources point at the customer source, not the founder statement',
  a6?.supporting?.length === 1 && /客户回复/.test(a6?.supporting?.[0]?.label ?? '') ? 'PASS' : 'FAIL',
  JSON.stringify(a6?.supporting ?? []));

const summary = {
  at: new Date().toISOString(),
  results,
  summary: { passed: passed(), failed: failed() },
  answers: { first: a1, afterIntent: a2, conflict: a3, failed: a4, recovered: a5, mixed: a6 },
};
console.log('\nSummary: ' + passed() + ' passed, ' + failed() + ' failed\n' + JSON.stringify(summary, null, 2));
await cleanup(failed() ? 1 : 0);
