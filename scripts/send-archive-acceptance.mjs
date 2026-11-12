// 发送档案（send-archive 窗口）· 端到端验收
//
// 验收线：随机抽一条模拟发送，之后再改来源，仍能从旧档案还原当时的批准依据。
//   1) 准备两条可发送线索（客户 B、客户 C）：分析（逐字引文）→ 补入客户确认来源
//      → 存草稿 → 草稿声明核查通过（支持引文逐字出自来源）；
//   2) 随机抽一条：展开来源原文（来源打开记录）→ 模拟发送 → 冻结发送档案
//      （已发送项目的批准依据与批准时间取自 approved 审计——当时基于什么批准的）；
//   3) 之后再给已发送线索新增一条来源（活动核查随之重跑、活动状态变化）；
//   4) 导出旧档案：当时的草稿正文与哈希、来源快照全文、逐条声明的担保原句与理由、
//      核查模型/思考档位/提示版本、来源打开记录、批准依据与批准时间都仍是发送时刻的值；
//   5) 档案只插入不更新：改动前后的导出字节一致；未被抽中的线索没有档案、也未发送。
//
// 模型请求打到本地确定性 mock（真实服务从临时工作目录启动，src/models.mjs 替换为
// mock 目录以隔离真实端点；被测代码与工作树一致）。
//
//   node scripts/send-archive-acceptance.mjs

import { spawn } from 'node:child_process';
import { cpSync, copyFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { evidenceHash } from '../src/opportunity/claims.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4241;
const mockPort = 4242;
const base = 'http://127.0.0.1:' + port;
const sha256 = value => createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------
// 两条可发送线索的语料（phrase 逐字出自证据与确认来源；声明逐字出自草稿正文）
// ---------------------------------------------------------------------------
const FACTS = [
  {
    label: '客户 B',
    evidence: '客户 B 来信：确认 11 月 18 日 14:00 上线。',
    phrase: '确认 11 月 18 日 14:00 上线',
    sourceName: '客户 B 确认邮件（11 月 14 日）',
    sourceDate: '2026-11-14',
    sourceText: '客户 B 确认邮件（2026-11-14）：确认 11 月 18 日 14:00 上线，无异议。',
    draftBody: '确认 11 月 18 日 14:00 上线。',
    note: '客户 B 确认邮件逐字支持。',
    laterSourceText: '客户 B 补充（2026-11-15）：上线时间需要再核对，暂缓确认。',
    laterRewrite: '上线时间以重新核对结果为准，暂不作承诺。',
  },
  {
    label: '客户 C',
    evidence: '客户 C 回复：同意按 12 月 1 日交付终版。',
    phrase: '同意按 12 月 1 日交付终版',
    sourceName: '客户 C 书面确认（11 月 14 日）',
    sourceDate: '2026-11-14',
    sourceText: '客户 C 书面确认（2026-11-14）：同意按 12 月 1 日交付终版，请安排。',
    draftBody: '同意按 12 月 1 日交付终版。',
    note: '客户 C 书面确认逐字支持。',
    laterSourceText: '客户 C 补充（2026-11-15）：终版范围需要再核对，暂缓确认。',
    laterRewrite: '终版范围以重新核对结果为准，暂不作承诺。',
  },
];
const factByEvidence = text => FACTS.find(fact => text.includes(fact.evidence));
const factByDraft = body => FACTS.find(fact => fact.draftBody === body);

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
// 确定性 mock 模型：回答由请求内容确定；S2 加入后核查不再成立（发送门槛会拦）。
// ---------------------------------------------------------------------------
const modelRequests = [];
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
    let userObj = null;
    try { userObj = JSON.parse(user); } catch {}
    const sources = userObj.sources ?? [];
    const e1Text = sources.find(source => source.id === 'E1')?.text ?? userObj.evidence ?? '';
    const fact = userObj.draft ? factByDraft(userObj.draft.body) : factByEvidence(e1Text);
    let canned;
    if (!fact) {
      canned = '（模拟模型）队列意外。';
    } else if (system.includes('你是声明核查器')) {
      const mode = userObj.mode === 'draft' ? 'draft' : 'analysis';
      if (sources.length > 2) {
        // S2 加入后：活动核查重跑，声明不再有依据（missing 与 rewrite 都非空 → 状态 unknown）。
        canned = mode === 'draft'
          ? JSON.stringify({ claims: [{ id: '对外承诺', dimension: '对外承诺', text: fact.phrase, items: [],
            missing: '客户暂缓确认，时间待重新核对。', rewrite: fact.laterRewrite }] })
          : JSON.stringify({ claims: (userObj.dimensions ?? []).map(d => ({
            id: d, dimension: d, text: d, status: 'unknown', items: [],
            missing: '客户暂缓确认。', rewrite: '' })) });
      } else {
        // 来源 ID 是 lead_sources 的全局行号（各线索各自的「S1」编号不同）：
        // 支持引文落在该线索自己添加的确认来源上（非 E1 的那条）。
        const supporting = sources.find(source => source.id !== 'E1') ?? sources[0];
        canned = mode === 'draft'
          ? JSON.stringify({ claims: [{ id: '对外承诺', dimension: '对外承诺', text: fact.phrase,
            items: [{ evidenceId: supporting.id, stance: 'supports', quote: fact.phrase, note: fact.note, revises: [] }],
            missing: '', rewrite: '' }] })
          : JSON.stringify({ claims: (userObj.dimensions ?? []).map(d => ({
            id: d, dimension: d, text: d, status: 'supported',
            items: [{ evidenceId: supporting.id, stance: 'supports', quote: fact.phrase, note: '来源逐字支持。' }],
            missing: '', rewrite: '' })) });
      }
    } else if (system.includes('Return JSON with status')) {
      canned = JSON.stringify({ status: 'supported', quote: fact.phrase,
        reason: fact.label + ' 来源逐字确认。', unknown: '', conflict: '', clarification: '', suggestedReply: '' });
    } else {
      canned = '（模拟模型）已记录。';
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: canned } }] }));
  });
});
await mock.listen(mockPort, '127.0.0.1');

// ---------------------------------------------------------------------------
// 临时工作目录：工作树字节级拷贝（server.mjs + src/ + package.json），仅替换
// src/models.mjs 为本地 mock 目录；被测档案/发送代码与工作树完全一致。
// ---------------------------------------------------------------------------
const MOCK_MODELS = `// 测试模型目录（send-archive 验收窗口）：单一本地 mock 模型，指向脚本启动的
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
const workDir = await mkdtemp(path.join(tmpdir(), 'daymark-send-archive-'));
await mkdir(path.join(workDir, 'src'), { recursive: true });
cpSync(path.join(root, 'src'), path.join(workDir, 'src'), { recursive: true });
copyFileSync(path.join(root, 'server.mjs'), path.join(workDir, 'server.mjs'));
copyFileSync(path.join(root, 'package.json'), path.join(workDir, 'package.json'));
writeFileSync(path.join(workDir, 'src', 'models.mjs'), MOCK_MODELS);
const dataDir = path.join(workDir, 'data');
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: workDir,
  env: { ...process.env, PORT: String(port), DAYMARK_DATA_DIR: dataDir,
    OPENAI_BASE_URL: 'http://127.0.0.1:' + mockPort + '/v1', MOCK_API_KEY: 'mock' },
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
const leadOf = (snapshot, label) => (snapshot.opportunities ?? []).find(item => item.title === label + ' 交付跟进');

function cleanup(code) {
  server.kill('SIGTERM');
  mock.close();
  return rm(workDir, { recursive: true, force: true }).then(() => process.exit(code));
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

console.log('\nAcceptance: 发送档案（mock 模型，确定性）——随机抽一条模拟发送，再改来源，旧档案还原批准依据');

// ---------------------------------------------------------------------------
// 1) 准备两条可发送线索
// ---------------------------------------------------------------------------
console.log('\n1) 两条可发送线索（分析 + 客户确认来源 + 草稿 + 声明核查通过）');
const leadIds = {};
for (const fact of FACTS) {
  const created = await api('/api/opportunity', {
    kind: 'lead', title: fact.label + ' 交付跟进', source: fact.label + ' 线程',
    evidence: fact.evidence, evidence_kind: 'customer',
  });
  leadIds[fact.label] = created.data.opportunities?.[0]?.id;
  record('save the ' + fact.label + ' lead', created.ok ? 'PASS' : 'FAIL', created.error ?? '');
  const assessed = await api('/api/opportunity-assess', { id: leadIds[fact.label], request: fact.label + ' 是否已确认？', language: 'zh-CN' });
  record(fact.label + ' analyzed (supported, verbatim quote)', assessed.ok ? 'PASS' : 'FAIL', assessed.error ?? '');
  const added = await api('/api/opportunity-source', {
    id: leadIds[fact.label], name: fact.sourceName, date: fact.sourceDate, kind: 'customer', text: fact.sourceText, language: 'zh-CN',
  });
  record('add the ' + fact.label + ' confirmation source (S1)', added.ok ? 'PASS' : 'FAIL', added.error ?? '');
  const drafted = await api('/api/opportunity-draft', {
    id: leadIds[fact.label], recipient: fact.label.replace(/[^a-z]/gi, '').toLowerCase() + '@client.test', body: fact.draftBody,
  });
  record('save the ' + fact.label + ' draft', drafted.ok ? 'PASS' : 'FAIL', drafted.error ?? '');
  let snapshot = await state();
  const verified = await api('/api/opportunity-claims', {
    id: leadIds[fact.label], target: 'draft', draft_id: leadOf(snapshot, fact.label)?.draft_id, language: 'zh-CN',
  });
  record('draft claims verified for the ' + fact.label + ' draft', verified.ok ? 'PASS' : 'FAIL', verified.error ?? '');
}
let st = await state();
for (const fact of FACTS) {
  const item = leadOf(st, fact.label);
  record(fact.label + ' draft verification passes with the verbatim support',
    item?.claims?.target === 'draft' && item.claims.claims[0]?.status === 'supported' && !item.claimsStale ? 'PASS' : 'FAIL',
    JSON.stringify({ status: item?.claims?.claims?.[0]?.status, stale: item?.claimsStale }));
}

// ---------------------------------------------------------------------------
// 2) 随机抽一条：展开来源（打开记录）→ 模拟发送 → 冻结档案
// ---------------------------------------------------------------------------
console.log('\n2) 随机抽一条模拟发送并冻结档案');
const picked = FACTS[Math.floor(Math.random() * FACTS.length)];
const other = FACTS.find(fact => fact !== picked);
record('pick one lead at random for the simulated send', 'PASS',
  picked.label + ' picked, ' + other.label + ' left alone');
let pickedItem = leadOf(st, picked.label);
// 来源 ID 是 lead_sources 的全局行号：取该线索自己的确认来源（发送前唯一一条）。
const s1 = 'S' + (pickedItem.sources ?? []).at(-1)?.id;
const viewed = await api('/api/opportunity-review-view', { id: leadIds[picked.label], source_id: s1 });
record('expanding the source records the viewing action', viewed.ok ? 'PASS' : 'FAIL', viewed.error ?? '');
const sent = await api('/api/opportunity-send', { id: leadIds[picked.label], draft_id: pickedItem.draft_id });
record('the picked lead simulates the send', sent.ok ? 'PASS' : 'FAIL', sent.error ?? '');
st = await state();
record('the send is audited (approved + simulated_send)',
  (st.audit ?? []).filter(r => r.opportunity === leadIds[picked.label] && ['approved', 'simulated_send'].includes(r.action)).length === 2 ? 'PASS' : 'FAIL');
const frozen = await api('/api/opportunity-archive', { id: leadIds[picked.label] });
const archiveId = frozen.data?.archive;
record('freezing stores the send archive', frozen.ok && Boolean(archiveId) ? 'PASS' : 'FAIL', String(frozen.error ?? archiveId));
st = await state();
const archivedItem = leadOf(st, picked.label);
record('state carries the archive for the sent lead',
  archivedItem?.archives?.length === 1 && archivedItem.archives[0].archiveId === archiveId ? 'PASS' : 'FAIL',
  JSON.stringify(archivedItem?.archives?.map(archive => archive.archiveId)));

// ---------------------------------------------------------------------------
// 3) 导出档案（改动前留底），之后再改来源
// ---------------------------------------------------------------------------
console.log('\n3) 导出档案，然后修改来源');
const exportBefore = await fetch(base + '/api/opportunity-archive/' + archiveId);
const exportBeforeText = await exportBefore.text();
record('export serves the stored archive with a download name',
  exportBefore.ok && exportBefore.headers.get('content-disposition') ===
    'attachment; filename="daymark-send-archive-' + archiveId + '.json"' ? 'PASS' : 'FAIL',
  exportBefore.headers.get('content-disposition') ?? String(exportBefore.status));

// 之后再改来源：给已发送线索新增一条（不同的）来源 → 活动核查重跑、活动状态变化。
const changed = await api('/api/opportunity-source', {
  id: leadIds[picked.label], name: picked.label + ' 补充（11 月 15 日）', date: '2026-11-15',
  kind: 'customer', text: picked.laterSourceText, language: 'zh-CN',
});
record('a new source is added after the send', changed.ok ? 'PASS' : 'FAIL', changed.error ?? '');
st = await state();
const live = leadOf(st, picked.label);
record('the live verification re-runs and no longer holds',
  live?.claims?.claims?.[0]?.status === 'unknown' ? 'PASS' : 'FAIL',
  'live claim status=' + live?.claims?.claims?.[0]?.status + ', evidence set changed');

// ---------------------------------------------------------------------------
// 4) 旧档案还原当时的批准依据
// ---------------------------------------------------------------------------
console.log('\n4) 旧档案还原当时的批准依据');
const exportAfter = await fetch(base + '/api/opportunity-archive/' + archiveId);
const exportAfterText = await exportAfter.text();
const archive = JSON.parse(exportAfterText);
record('the stored row is byte-identical after the source change (insert-only)',
  exportAfter.ok && exportBeforeText === exportAfterText ? 'PASS' : 'FAIL');
record('the approved draft body and hash survive the source change',
  archive.approval.body === picked.draftBody && archive.approval.bodyHash === sha256(picked.draftBody) ? 'PASS' : 'FAIL',
  'recipient=' + archive.approval.recipient);
record('the source snapshot keeps the original sources only (full text)',
  archive.sources.length === 2 && archive.sources[0].text === picked.evidence &&
  archive.sources[1].text === picked.sourceText && !exportAfterText.includes('暂缓确认') ? 'PASS' : 'FAIL',
  'sources=' + archive.sources.map(source => source.id).join(','));
record('tier 1: the sources provided to the model at verification time',
  JSON.stringify(archive.sourcesProvidedToModel) === JSON.stringify(['E1', s1]) ? 'PASS' : 'FAIL',
  JSON.stringify(archive.sourcesProvidedToModel));
const claim = archive.claims?.[0] ?? {};
record('the claim verdict keeps its supporting quote and justification (担保原句和理由)',
  claim.status === 'supported' && claim.items?.[0]?.quote === picked.phrase &&
  claim.items?.[0]?.note === picked.note && claim.items?.[0]?.valid === true &&
  claim.supportingSources?.[0]?.id === s1 && claim.supportingSources[0].quote === picked.phrase ? 'PASS' : 'FAIL',
  'status=' + claim.status + ' quote=' + claim.items?.[0]?.quote);
record('the verification model, thinking level, and prompt versions are recorded',
  archive.verification.model === 'mock-model' && archive.verification.effort === null &&
  archive.verification.prompts?.claims === 'claims-v1' && archive.verification.prompts?.analysis === 'analysis-v1' ? 'PASS' : 'FAIL',
  'model=' + archive.verification.model + ' prompts=' + JSON.stringify(archive.verification.prompts));
record('the verification binding points at the old draft + old source set',
  archive.verification.draftId === pickedItem.draft_id &&
  archive.verification.bodyHash === sha256(picked.draftBody) &&
  archive.verification.evidenceHash && archive.verification.evidenceHash !==
    evidenceHash(live, live.sources) ? 'PASS' : 'FAIL',
  'evidenceHash differs from the live set=' + archive.verification.evidenceHash !== evidenceHash(live, live.sources));
const approved = (st.audit ?? []).find(r => r.opportunity === leadIds[picked.label] && r.action === 'approved');
record('the approval basis and approval time are taken from the approval moment',
  archive.approval.basis === 'model_supported' && archive.sent === true &&
  archive.sentAt === approved?.time ? 'PASS' : 'FAIL',
  'basis=' + archive.approval.basis + ' sentAt=' + archive.sentAt);
record('the source viewing record is embedded in the archive',
  JSON.stringify(archive.viewing?.viewed) === JSON.stringify([s1]) &&
  archive.viewing?.viewedNames?.join() === picked.sourceName &&
  archive.viewing?.records?.length === 1 && archive.viewing.records[0].sourceId === s1 &&
  typeof archive.viewing.records[0].time === 'string' ? 'PASS' : 'FAIL',
  'viewedNames=' + JSON.stringify(archive.viewing?.viewedNames));
record('the un-picked lead has no archive and was not sent',
  leadOf(st, other.label)?.archives?.length === 0 && leadOf(st, other.label)?.sent === 0 ? 'PASS' : 'FAIL');

// ---------------------------------------------------------------------------
// 汇总 + 留档
// ---------------------------------------------------------------------------
console.log('\nSummary: ' + passed() + ' passed, ' + skipped() + ' skipped, ' + failed() + ' failed');
const summary = {
  at: new Date().toISOString(),
  picked: picked.label,
  results,
  modelRequests: modelRequests.length,
};
const evidenceDir = path.join(root, 'docs', 'evidence');
await mkdir(evidenceDir, { recursive: true });
const traceFile = path.join(evidenceDir, 'send-archive-acceptance-' + Date.now() + '.json');
await writeFile(traceFile, JSON.stringify(summary, null, 2));
await writeFile(path.join(evidenceDir, 'send-archive-acceptance-server.log'), serverLog);
console.log('  trace: ' + traceFile);

const code = failed() ? 1 : 0;
if (!failed()) console.log('All acceptance points passed.');
await cleanup(code);
