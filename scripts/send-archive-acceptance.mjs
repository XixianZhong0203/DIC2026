// Send archive (send-archive window) · End-to-end acceptance
//
// Acceptance line: randomly select a lead for simulated sending, then modify sources afterwards; verify
// that the approval basis at the time of sending can still be restored from the old archive.
// 1) Prepare two sendable leads (Client B, Client C): Analysis (verbatim citations) -> Add client
// confirmation source
// -> Save draft -> Draft declaration passes verification (supports verbatim citations from sources);
// 2) Randomly select one: Expand source original text (source open log) -> Simulate send -> Freeze send
// archive
// (Approval basis and approval time for sent items are taken from the approved audit—what it was approved
// on at the time);
// 3) Afterwards, add a new source to the sent lead (activity verification reruns accordingly, activity
// status changes);
// 4) Export old archive: draft body and hash at the time, full source snapshot text, guaranteed original
// sentences and reasons for each claim,
// verification model/thinking tier/prompt version, source open log, approval basis and approval time
// remain the values at the time of sending;
// Export reports integrity via X-Archive-Integrity header (verified);
// 5) Archive is insert-only: exported bytes before and after changes are identical; unselected leads have
// no archive and are not sent;
// 6) Integrity: archive digest binds to stored bytes — tamper with archive body -> mismatch (export still
// returns 200 for evidence retention,
// state syncs reported), restore original bytes -> verified;
// 7) Switch to a different model configuration (second server shares the same data directory, default
// model ID changed to mock-model-2):
// New verification records and new archives record the new model, while the model information of old
// archives retains the value at the time of verification (no backfilling).
//
// Model requests hit the local deterministic mock (real service starts from a temporary working directory,
// src/models.mjs is replaced with the mock directory to isolate real endpoints; tested code is consistent
// with the working tree).
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
import { evidenceHash, CLAIMS_PROMPT_VERSION } from '../src/opportunity/claims.mjs';
import { ANALYSIS_PROMPT_VERSION } from '../src/opportunity/opportunities.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4241;
const mockPort = 4242;
const base = 'http://127.0.0.1:' + port;
const sha256 = value => createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------
// Corpus for two sendable leads (phrases are verbatim from evidence and confirmation sources; claims are
// verbatim from the draft body).
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
// Result record
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
// Deterministic mock model: responses are determined by the request content; after S2 is added,
// verification no longer holds (sending gate blocks it).
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
        // After S2 is added: activity verification reruns, claims no longer have basis (both missing and
        // rewrite are non-empty -> status unknown).
        canned = mode === 'draft'
          ? JSON.stringify({ claims: [{ id: '对外承诺', dimension: '对外承诺', text: fact.phrase, items: [],
            missing: '客户暂缓确认，时间待重新核对。', rewrite: fact.laterRewrite }] })
          : JSON.stringify({ claims: (userObj.dimensions ?? []).map(d => ({
            id: d, dimension: d, text: d, status: 'unknown', items: [],
            missing: '客户暂缓确认。', rewrite: '' })) });
      } else {
        // The source ID is the global row number in lead_sources (each lead has its own 'S1' numbering):
        // Supports citations falling on the confirmed source added by the lead itself (the one that is not
        // E1).
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
    } else if (/Return JSON with status|只返回 JSON 对象，字段 status/.test(system)) {
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
// Temporary working directory: byte-level copy of the work tree (server.mjs + src/ + package.json),
// replacing only
// src/models.mjs with the local mock directory; the tested profile/dispatch code is completely identical
// to the work tree.
// ---------------------------------------------------------------------------
const MOCK_MODELS = `// 测试模型目录（send-archive 验收窗口）：单一本地 mock 模型，指向脚本启动的
// Deterministic mock provider. The temporary checkout isolates real endpoints. The code under test is unchanged.
const BASE = process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:0/v1';
export const MODELS = [{ id: '%ID%', name: 'Mock Model', base: BASE, keyEnv: 'MOCK_API_KEY', fallbackKey: 'mock', timeout: 15000, efforts: {} }];
export const modelById = id => (typeof id === 'string' && MODELS.find(entry => entry.id === id)) || null;
export const DEFAULT_MODEL_ID = '%ID%';
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
const mockModelsFile = id => MOCK_MODELS.replaceAll('%ID%', id);
const workDir = await mkdtemp(path.join(tmpdir(), 'daymark-send-archive-'));
await mkdir(path.join(workDir, 'src'), { recursive: true });
cpSync(path.join(root, 'src'), path.join(workDir, 'src'), { recursive: true });
copyFileSync(path.join(root, 'server.mjs'), path.join(workDir, 'server.mjs'));
copyFileSync(path.join(root, 'package.json'), path.join(workDir, 'package.json'));
writeFileSync(path.join(workDir, 'src', 'models.mjs'), mockModelsFile('mock-model'));
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

const apiFor = origin => async (route, body) => {
  const options = body === undefined ? { method: 'GET' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const response = await fetch(origin + route, options);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data, error: data.error ?? null };
};
const api = apiFor(base);
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
// 1) Prepare two dispatchable leads
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
// 2) Randomly pick one: expand source (open record) -> simulate dispatch -> freeze profile
// ---------------------------------------------------------------------------
console.log('\n2) 随机抽一条模拟发送并冻结档案');
const picked = FACTS[Math.floor(Math.random() * FACTS.length)];
const other = FACTS.find(fact => fact !== picked);
record('pick one lead at random for the simulated send', 'PASS',
  picked.label + ' picked, ' + other.label + ' left alone');
let pickedItem = leadOf(st, picked.label);
// Source ID is the global row number of lead_sources: take the lead's own confirmed source (the only one
// before dispatch).
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
// 3) Export profile (keep a backup before changes), then modify the source
// ---------------------------------------------------------------------------
console.log('\n3) 导出档案，然后修改来源');
const exportBefore = await fetch(base + '/api/opportunity-archive/' + archiveId);
const exportBeforeText = await exportBefore.text();
record('export serves the stored archive with a download name',
  exportBefore.ok && exportBefore.headers.get('content-disposition') ===
    'attachment; filename="daymark-send-archive-' + archiveId + '.json"' ? 'PASS' : 'FAIL',
  exportBefore.headers.get('content-disposition') ?? String(exportBefore.status));

// Modify source afterwards: add a new (different) source to the dispatched lead -> rerun activity
// verification, activity status changes.
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
// 4) Restore old profile to the approval basis at that time
// ---------------------------------------------------------------------------
console.log('\n4) 旧档案还原当时的批准依据');
const exportAfter = await fetch(base + '/api/opportunity-archive/' + archiveId);
const exportAfterText = await exportAfter.text();
const archive = JSON.parse(exportAfterText);
record('the stored row is byte-identical after the source change (insert-only)',
  exportAfter.ok && exportBeforeText === exportAfterText ? 'PASS' : 'FAIL');
record('the export verifies integrity against the recorded digest',
  exportAfter.headers.get('x-archive-integrity') === 'verified' ? 'PASS' : 'FAIL',
  'header=' + exportAfter.headers.get('x-archive-integrity'));
record('the live check record stores the actual config at check time',
  live?.claims?.model === 'mock-model' && live?.claims?.effort === null &&
  live?.claims?.prompts?.claims === CLAIMS_PROMPT_VERSION && live?.claims?.prompts?.analysis === ANALYSIS_PROMPT_VERSION ? 'PASS' : 'FAIL',
  'model=' + live?.claims?.model + ' effort=' + live?.claims?.effort + ' prompts=' + JSON.stringify(live?.claims?.prompts));
record('the state surfaces the archive integrity',
  leadOf(st, picked.label)?.archives?.[0]?.integrity?.status === 'verified' ? 'PASS' : 'FAIL');
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
  archive.verification.prompts?.claims === CLAIMS_PROMPT_VERSION && archive.verification.prompts?.analysis === ANALYSIS_PROMPT_VERSION ? 'PASS' : 'FAIL',
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
// 5) Integrity: tampering with the profile is detected (mismatch, export still returns 200 for evidence);
// restore original bytes -> verified
// ---------------------------------------------------------------------------
console.log('\n5) 篡改档案 → mismatch；恢复原字节 → verified');
const { DatabaseSync } = await import('node:sqlite');
const tempDb = new DatabaseSync(path.join(dataDir, 'daymark.sqlite'));
const tampered = exportBeforeText + '（篡改）';
tempDb.prepare('UPDATE opportunity_archives SET archive=? WHERE id=?').run(tampered, archiveId);
const exportTampered = await fetch(base + '/api/opportunity-archive/' + archiveId);
const exportTamperedText = await exportTampered.text();
record('tampering the stored archive is detected as a mismatch (still served for forensics)',
  exportTampered.ok && exportTamperedText === tampered &&
  exportTampered.headers.get('x-archive-integrity') === 'mismatch' ? 'PASS' : 'FAIL',
  'header=' + exportTampered.headers.get('x-archive-integrity'));
st = await state();
record('the mismatch is surfaced in the state',
  leadOf(st, picked.label)?.archives?.[0]?.integrity?.status === 'mismatch' ? 'PASS' : 'FAIL');
tempDb.prepare('UPDATE opportunity_archives SET archive=? WHERE id=?').run(exportBeforeText, archiveId);
tempDb.close();
const exportRestored = await fetch(base + '/api/opportunity-archive/' + archiveId);
record('restoring the original bytes restores the verified status',
  (await exportRestored.text()) === exportBeforeText &&
  exportRestored.headers.get('x-archive-integrity') === 'verified' ? 'PASS' : 'FAIL');

// ---------------------------------------------------------------------------
// 6) Switch to a different model configuration (second server, same DB and mock, default model ID changed
// to mock-model-2):
// New verification record and new profile record the new model; model information in the old profile
// retains the value at the verification moment.
// ---------------------------------------------------------------------------
console.log('\n6) 换用不同模型配置：新档案记新配置，旧档案保持核查时刻的记录');
server.kill('SIGTERM');
const port2 = 4243;
const base2 = 'http://127.0.0.1:' + port2;
const workDir2 = await mkdtemp(path.join(tmpdir(), 'daymark-send-archive-model2-'));
await mkdir(path.join(workDir2, 'src'), { recursive: true });
cpSync(path.join(root, 'src'), path.join(workDir2, 'src'), { recursive: true });
copyFileSync(path.join(root, 'server.mjs'), path.join(workDir2, 'server.mjs'));
copyFileSync(path.join(root, 'package.json'), path.join(workDir2, 'package.json'));
writeFileSync(path.join(workDir2, 'src', 'models.mjs'), mockModelsFile('mock-model-2'));
// Same data directory (shared DB and old profile), same mock service: only the default model ID changes -
// simulating a model configuration change.
const server2 = spawn(process.execPath, ['server.mjs'], {
  cwd: workDir2,
  env: { ...process.env, PORT: String(port2), DAYMARK_DATA_DIR: dataDir,
    OPENAI_BASE_URL: 'http://127.0.0.1:' + mockPort + '/v1', MOCK_API_KEY: 'mock' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const api2 = apiFor(base2);
let up2 = false;
for (let i = 0; i < 100 && !up2; i++) {
  try { up2 = (await fetch(base2 + '/api/state')).ok; } catch {
    if (server2.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
record('a second server runs with a different default model (mock-model-2)', up2 ? 'PASS' : 'FAIL');
const otherId = leadIds[other.label];
// Unselected leads: save the same body text again -> new draft version (mock matches by body text,
// re-verification still passes);
// New verification record is saved to the database with the new configuration.
const redrafted = await api2('/api/opportunity-draft', {
  id: otherId, recipient: other.label.replace(/[^a-z]/gi, '').toLowerCase() + '@client.test', body: other.draftBody,
});
record('a new draft is saved under the changed config', redrafted.ok ? 'PASS' : 'FAIL', redrafted.error ?? '');
let st2 = (await api2('/api/state')).data;
const rechecked = await api2('/api/opportunity-claims', {
  id: otherId, target: 'draft', draft_id: leadOf(st2, other.label)?.draft_id, language: 'zh-CN',
});
record('re-verification passes under the new config', rechecked.ok ? 'PASS' : 'FAIL', rechecked.error ?? '');
st2 = (await api2('/api/state')).data;
record('the new check record stores the new model config',
  leadOf(st2, other.label)?.claims?.model === 'mock-model-2' &&
  leadOf(st2, other.label)?.claims?.effort === null ? 'PASS' : 'FAIL',
  'model=' + leadOf(st2, other.label)?.claims?.model);
const frozen2 = await api2('/api/opportunity-archive', { id: otherId });
const archiveId2 = frozen2.data?.archive;
record('freezing under the new config stores a new archive', frozen2.ok && Boolean(archiveId2) ? 'PASS' : 'FAIL',
  String(frozen2.error ?? archiveId2));
const export2 = await fetch(base2 + '/api/opportunity-archive/' + archiveId2);
const archive2 = JSON.parse(await export2.text());
record('the new archive records the new model config',
  archive2.verification?.model === 'mock-model-2' ? 'PASS' : 'FAIL', 'model=' + archive2.verification?.model);
const exportOld = await fetch(base2 + '/api/opportunity-archive/' + archiveId);
const archiveOld = JSON.parse(await exportOld.text());
record('the old archive keeps the model recorded at its check time',
  archiveOld.verification?.model === 'mock-model' &&
  exportOld.headers.get('x-archive-integrity') === 'verified' ? 'PASS' : 'FAIL',
  'model=' + archiveOld.verification?.model + ' integrity=' + exportOld.headers.get('x-archive-integrity'));
server2.kill('SIGTERM');
await rm(workDir2, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Summary + Archiving
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
