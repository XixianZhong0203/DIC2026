// 当前草稿核查器小规模评测 runner（评测代码；不修改任何产品文件）。
//
// 驱动真实产品代码路径（src/opportunity/opportunities.mjs 的 opportunityWorkflow）：
//   /api/opportunity → /api/opportunity-source* → /api/opportunity-draft → /api/opportunity-claims (target=draft)
// 即服务器暴露的同一套草稿核查路径；模型依赖只有 complete()，请求契约与 server.mjs 一致
// （同样的 body 字段、同样的超时策略：本地 90s / 远程 18s，可用 --timeout-ms 覆盖）。
//
// 对每个配置的模型：
//   1. 接口冒烟检查（一次小请求）——接口未就绪的模型记为「待测」，不阻塞其他模型；
//   2. 按固定顺序跑全部固定案例（evaluation/draft-verification/cases.mjs），每案例全新工作流（:memory: DB）；
//   3. 按同一套评分规则计分，每项指标都记分子/分母：
//      - 问题声明提取：人工标注的问题声明中，模型抽到多少条（声明文本匹配）；
//      - 提取后判定正确：已抽到的问题声明中，产品层最终判定与人工期望判定一致多少条；
//      - 正常声明误标：已抽到的正常声明（期望 supported）中，被判为不支持（误标）多少条；
//      - 案例解析或请求失败：案例中模型输出不可解析或模型请求失败多少条。
//      补充记录（不计入主四项）：问题声明被判 supported（放行风险）、正常声明抽取覆盖。
//
// 报告记录模型名、产品代码版本（git HEAD + 脏文件 + 关键文件哈希）与样本规模（案例数/声明数）。
// 原始模型输出与 trace 写入 evaluation/draft-verification/output/（不提交仓库，留在本地）。
//
// 用法：
//   OPENAI_BASE_URL=... OPENAI_API_KEY=... node evaluation/draft-verification/run.mjs
//   node evaluation/draft-verification/run.mjs --base-url <url> --api-key-file <file>
//   node evaluation/draft-verification/run.mjs --smoke-only        # 只做接口就绪检查
//   node evaluation/draft-verification/run.mjs --model <id> ...    # 覆盖 models.json 的模型列表
//   可选：--timeout-ms <n>（默认 本地 90s / 远程 18s，与产品一致）、--max-tokens <n>（默认 2048；
//   27B 思考型部署需要更大值，如 8192，否则思考会占满预算导致正文为空）。
//
// 判定结果是数据，不是 runner 失败；runner 只在控制项失败（案例自检、端点缺失、无就绪模型）时退出 1。

import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { opportunityWorkflow } from '../../src/opportunity/opportunities.mjs';

const evalDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolvePath(evalDir, '..', '..');

// --- CLI ---
function requireArg(value, flag) {
  if (!value || value.startsWith('--')) { console.error(`缺少 ${flag} 的参数值。`); process.exit(1); }
  return value;
}
function parseArgs(argv) {
  const args = { models: [], smokeOnly: false, baseUrl: null, apiKey: null, apiKeyFile: null, timeoutMs: null, maxTokens: 2048, cases: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') args.models.push(requireArg(argv[++i], a));
    else if (a === '--cases') args.cases = requireArg(argv[++i], a);
    else if (a === '--smoke-only') args.smokeOnly = true;
    else if (a === '--base-url') args.baseUrl = requireArg(argv[++i], a);
    else if (a === '--api-key') args.apiKey = requireArg(argv[++i], a);
    else if (a === '--api-key-file') args.apiKeyFile = requireArg(argv[++i], a);
    else if (a === '--timeout-ms') args.timeoutMs = Number(requireArg(argv[++i], a));
    else if (a === '--max-tokens') args.maxTokens = Number(requireArg(argv[++i], a));
    else if (a === '--help' || a === '-h') {
      console.log('用法：node evaluation/draft-verification/run.mjs [--model <id> ...] [--base-url <url>] [--api-key-file <file>] [--timeout-ms <n>] [--cases <local.mjs>] [--smoke-only]');
      process.exit(0);
    } else throw new Error('未知参数：' + a);
  }
  return args;
}

// --- 代码版本记录（同一版本：跨模型对比要求同一份产品代码） ---
const versionedFiles = ['src/opportunity/claims.mjs', 'src/opportunity/opportunities.mjs',
  'src/alignment/alignment.mjs', 'server.mjs',
  'evaluation/draft-verification/run.mjs', 'evaluation/draft-verification/models.json'];
function codeVersion() {
  const hash = p => createHash('sha256').update(readFileSync(join(repoRoot, p))).digest('hex').slice(0, 16);
  let gitHead = 'unknown';
  let dirtyFiles = [];
  try {
    gitHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    dirtyFiles = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map(l => l.slice(3).trim()).sort();
  } catch {}
  return { gitHead, dirtyFiles, fileHashes: Object.fromEntries([...versionedFiles.map(f => [f, hash(f)]), ...(!args.smokeOnly ? [['localCases', hash(casesPath)]] : [])]) };
}

// --- 端点与模型访问（与 server.mjs complete() 同一请求契约） ---
const args = parseArgs(process.argv.slice(2));
const casesPath = args.cases ? resolvePath(args.cases) : join(evalDir, 'cases.mjs');
if (!args.smokeOnly && !existsSync(casesPath)) {
  console.error('缺少本地案例。用 --cases <local.mjs> 指定案例模块，或用 --smoke-only 只检查端点。');
  process.exit(1);
}
const { DRAFT_CASES, CLAIM_STATS, selfCheckCases } = args.smokeOnly
  ? { DRAFT_CASES: [], CLAIM_STATS: { cases: 0, totalClaims: 0, problemClaims: 0, normalClaims: 0 }, selfCheckCases() {} }
  : await import(pathToFileURL(casesPath).href);
const baseUrl = (args.baseUrl ?? process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
let apiKey = args.apiKey ?? process.env.OPENAI_API_KEY ?? '';
if (args.apiKeyFile) apiKey = readFileSync(args.apiKeyFile, 'utf8').trim();
if (!baseUrl) {
  console.error('缺少模型端点：请设置 OPENAI_BASE_URL 或 --base-url（可选 --api-key / --api-key-file）。');
  process.exit(1);
}
const localModel = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname);
const timeoutMs = args.timeoutMs ?? (localModel ? 90000 : 18000);

function callFail(status, message) { throw Object.assign(new Error(message), { status }); }

// 产品契约的请求（模型 ID 可换；body 字段与 server.mjs 完全一致）
async function productComplete(modelId, messages) {
  const response = await fetch(baseUrl + '/chat/completions', {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(!localModel && apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model: modelId, max_tokens: args.maxTokens, messages, ...(localModel ? { response_format: { type: 'json_object' } } : {}) }),
  }).catch(() => callFail(502, '模型连接失败（超时或网络），请检查服务地址。'));
  if (!response.ok) callFail(502, `模型服务返回 HTTP ${response.status}。`);
  const result = await response.json().catch(() => null);
  const raw = result?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string' || !raw.trim()) callFail(502, '模型没有返回可核查的答复。');
  return raw;
}

// 接口冒烟检查：一次小请求，确认模型接口就绪（与生产契约分离，固定 90s 超时）
async function smoke(modelId) {
  const t0 = Date.now();
  try {
    const response = await fetch(baseUrl + '/chat/completions', {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(!localModel && apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({ model: modelId, max_tokens: 128,
        messages: [{ role: 'user', content: 'Reply with JSON only: {"status":"ok"}' }] }),
    });
    if (!response.ok) return { ok: false, ms: Date.now() - t0, error: `接口返回 HTTP ${response.status}` };
    const result = await response.json().catch(() => null);
    const raw = result?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, ms: Date.now() - t0, error: '接口未返回可读取的答复' };
    return { ok: true, ms: Date.now() - t0, raw };
  } catch (error) {
    return { ok: false, ms: Date.now() - t0, error: error.message || String(error) };
  }
}

// --- 工作流驱动（每案例全新 :memory: 工作流，互不串扰） ---
function failFn(status, message) { callFail(status, message); }
function requiredFn(value, length) {
  if (typeof value !== 'string' || !value.trim() || value.length > length) failFn(400, '请检查输入内容。');
  return value.trim();
}
function freshWorkflow(completeFn, modelLabel) {
  const db = new DatabaseSync(':memory:');
  return opportunityWorkflow(db, { complete: completeFn, model: modelLabel, fail: failFn, required: requiredFn });
}
const call = (w, route, body) => w.mutations['/api/' + route](body);

async function runCase(modelId, c) {
  const calls = [];
  const completeFn = async messages => {
    const t0 = Date.now();
    try {
      const raw = await productComplete(modelId, messages);
      calls.push({ model: modelId, ms: Date.now() - t0, request: messages, raw });
      return raw;
    } catch (error) {
      calls.push({ model: modelId, ms: Date.now() - t0, request: messages, error: error.message });
      throw error;
    }
  };
  const w = freshWorkflow(completeFn, modelId);
  try {
    call(w, 'opportunity', { kind: 'lead', title: `${c.id} ${c.label}`, source: c.sourceLabel,
      evidence: c.evidence, evidence_kind: c.evidence_kind });
    const id = w.state().opportunities[0].id;
    for (const s of c.sources) {
      call(w, 'opportunity-source', { id, name: s.name, date: s.date ?? null, kind: s.kind, text: s.text, language: 'zh' });
    }
    call(w, 'opportunity-draft', { id, recipient: c.recipient, body: c.body });
    const draftId = w.state().opportunities[0].draft_id;
    // mutation 无返回值：核查结果存于 opportunities.claims_review（state 解析为 claims）。
    await call(w, 'opportunity-claims', { id, target: 'draft', draft_id: draftId, language: 'zh' });
    const review = w.state().opportunities[0].claims;
    return { case: c, review, error: null, calls };
  } catch (error) {
    return { case: c, review: null, error: error.message, calls };
  }
}

// --- 评分（所有模型同一规则） ---
const norm = s => String(s ?? '').replace(/\s+/g, '');
// 声明匹配：模型抽出的声明 text（须逐字出自草稿正文）与人工标注文本，双向包含即算抽到；多条时取重叠最长。
function matchModelClaim(modelClaims, expectedText) {
  const b = norm(expectedText);
  if (!b) return null;
  let best = null;
  for (const mc of modelClaims) {
    const a = norm(mc.text);
    if (!a) continue;
    if (a === b || a.includes(b) || b.includes(a)) {
      const score = Math.min(a.length, b.length);
      if (!best || score > best.score) best = { claim: mc, score };
    }
  }
  return best ? best.claim : null;
}
// 发送门槛语义：只有 supported 可放行；refuted/unknown/conflict/founder_only/unconfirmed/incomplete 一律拦截。
const PASSING = new Set(['supported']);

function scoreCase(modelId, run) {
  const c = run.case;
  const modelClaims = run.review?.claims ?? [];
  const failed = !run.review || Boolean(run.review.error);
  const rows = c.claims.map(expected => {
    const matched = matchModelClaim(modelClaims, expected.text);
    const extracted = Boolean(matched);
    const modelStatus = extracted ? matched.status : null;
    return {
      claimId: expected.claimId, category: expected.category, dimension: expected.dimension,
      expectedText: expected.text, expectedStatus: expected.expectedStatus,
      expectedEvidence: expected.expectedEvidence, expectedQuote: expected.expectedQuote ?? null,
      expectedQuoteSource: expected.expectedQuoteSource ?? null,
      rationale: expected.rationale,
      extracted, matchedText: extracted ? matched.text : null,
      modelStatus,
      modelItems: extracted ? matched.items.map(it => ({ evidenceId: it.evidenceId, stance: it.stance,
        valid: it.valid, reasons: it.reasons, quote: it.quote })) : [],
      judgmentCorrect: extracted ? (modelStatus === expected.expectedStatus) : null,
      passed: extracted ? PASSING.has(modelStatus) : null,
    };
  });
  return {
    caseId: c.id, category: c.category, label: c.label,
    failed,
    reviewError: run.review?.error ?? (run.error ? `案例执行失败：${run.error}` : null),
    binding: run.review?.binding ?? null,
    modelCalls: run.calls.length,
    rawModelOutput: run.calls.at(-1)?.raw ?? null,
    rawModelError: run.calls.at(-1)?.error ?? null,
    modelMs: run.calls.at(-1)?.ms ?? null,
    unlistedClaims: modelClaims
      .filter(mc => !c.claims.some(e => matchModelClaim([mc], e.text)))
      .map(mc => ({ dimension: mc.dimension, text: mc.text, status: mc.status })),
    claims: rows,
  };
}

const fr = (num, den) => ({ num, den, pct: den ? Number((100 * num / den).toFixed(1)) + '%' : 'n/a' });

function modelMetrics(casesScored) {
  const problem = [];
  const normal = [];
  let failedCases = 0;
  for (const cs of casesScored) {
    if (cs.failed) failedCases++;
    for (const row of cs.claims) (row.category === 'normal' ? normal : problem).push({ cs, row });
  }
  const problemExtracted = problem.filter(p => p.row.extracted);
  const normalExtracted = normal.filter(p => p.row.extracted);
  return {
    sample: { cases: casesScored.length, problemClaims: problem.length, normalClaims: normal.length,
      totalClaims: problem.length + normal.length },
    metrics: {
      '问题声明提取': fr(problemExtracted.length, problem.length),
      '提取后判定正确': fr(problemExtracted.filter(p => p.row.judgmentCorrect === true).length, problemExtracted.length),
      '正常声明误标': fr(normalExtracted.filter(p => p.row.modelStatus !== 'supported').length, normalExtracted.length),
      '案例解析或请求失败': fr(failedCases, casesScored.length),
      '补充·问题声明被判supported(放行风险)': fr(problemExtracted.filter(p => p.row.passed === true).length, problemExtracted.length),
      '补充·正常声明抽取覆盖': fr(normalExtracted.length, normal.length),
    },
    membership: {
      '问题声明提取': { 分母: problem.map(p => p.row.claimId), 分子: problemExtracted.map(p => p.row.claimId) },
      '提取后判定正确': { 分母: problemExtracted.map(p => p.row.claimId),
        分子: problemExtracted.filter(p => p.row.judgmentCorrect === true).map(p => p.row.claimId) },
      '正常声明误标': { 分母: normalExtracted.map(p => p.row.claimId),
        分子: normalExtracted.filter(p => p.row.modelStatus !== 'supported').map(p => p.row.claimId) },
      '案例解析或请求失败': { 分母: casesScored.map(c => c.caseId), 分子: casesScored.filter(c => c.failed).map(c => c.caseId) },
    },
  };
}

// --- 报告与控制台 ---
function printTable(title, headers, rows) {
  console.log(`\n### ${title}`);
  console.log('| ' + headers.join(' | ') + ' |');
  console.log('|' + headers.map(() => '---').join('|') + '|');
  for (const r of rows) console.log('| ' + r.join(' | ') + ' |');
}
const frStr = f => `${f.num}/${f.den} (${f.pct})`;

// --- main ---
async function main() {
  selfCheckCases();
  const modelsJson = JSON.parse(readFileSync(join(evalDir, 'models.json'), 'utf8'));
  const modelList = args.models.length
    ? args.models.map(id => ({ id, group: 'specified' }))
    : [...modelsJson.primary.map(id => ({ id, group: 'primary' })),
      ...modelsJson.supplementary.map(id => ({ id, group: 'supplementary' }))];

  const cv = codeVersion();
  const at = new Date().toISOString();
  const results = [];
  const completed = [];

  for (const m of modelList) {
    console.log(`\n===== 模型 ${m.id}（${m.group}）接口检查 =====`);
    const s = await smoke(m.id);
    console.log(s.ok ? `接口就绪（${s.ms}ms）` : `接口未就绪：${s.error}`);
    if (!s.ok) {
      results.push({ model: m.id, group: m.group, status: '待测', smoke: s,
        note: '接口未就绪。案例、评分规则与 runner 已就绪；接口恢复后用同一命令重跑即可，判定结果不受此前其他模型影响。' });
      continue;
    }
    if (args.smokeOnly) {
      results.push({ model: m.id, group: m.group, status: '接口就绪（smoke-only，未跑案例）', smoke: s });
      continue;
    }
    console.log(`运行 ${m.id}：${CLAIM_STATS.cases} 案例 / ${CLAIM_STATS.totalClaims} 声明（问题 ${CLAIM_STATS.problemClaims} / 正常 ${CLAIM_STATS.normalClaims}）`);
    const scored = [];
    for (const c of DRAFT_CASES) {
      console.log(`  … ${c.id} ${c.label}`);
      const run = await runCase(m.id, c);
      const cs = scoreCase(m.id, run);
      scored.push(cs);
      if (cs.failed) console.log(`    ⚠ 案例失败：${cs.reviewError}`);
      for (const row of cs.claims) {
        console.log(`    ${row.claimId} 期望 ${row.expectedStatus} → ${row.extracted ? `已抽取，判定 ${row.modelStatus}${row.judgmentCorrect ? '（对）' : '（误）'}` : '未抽取'}`);
      }
    }
    const mm = modelMetrics(scored);
    completed.push(m.id);
    results.push({ model: m.id, group: m.group, status: 'completed', smoke: s,
      finishedAt: new Date().toISOString(), sample: mm.sample, metrics: mm.metrics,
      membership: mm.membership, cases: scored });
  }

  const report = {
    kind: 'draft-verification-eval-v1',
    at,
    endpoint: { baseUrl, localModel, timeoutMs, maxTokens: args.maxTokens, note: '请求契约与 server.mjs complete() 一致（max_tokens 按部署调整：27B 思考型部署需要更大预算，否则输出被思考占用、正文为空）；API key 不记录。' },
    codeVersion: cv,
    sample: CLAIM_STATS,
    scoring: {
      language: 'zh',
      '问题声明提取': '人工标注的问题声明（编造/夸大/过时/与来源矛盾/仅创始人自述）中，模型抽出的声明文本（逐字出自草稿正文）与标注文本双向包含（空白归一）即算抽到；多条取重叠最长。',
      '提取后判定正确': '已抽到的问题声明中，产品层最终判定（确定性守卫之后的 status）与人工 expectedStatus 完全一致的比例。',
      '正常声明误标': '已抽到的正常声明（期望 supported）中，最终判定不是 supported 的比例（误标）。',
      '案例解析或请求失败': 'review.error 非空（模型请求失败，或输出 JSON 解析失败 / 字段冲突）的案例数；该案例的声明在提取指标中计未抽到，不进判定指标分母。',
      '可放行状态': '只有 supported 可自动放行；refuted/unknown/conflict/founder_only/unconfirmed/incomplete 均被发送门槛拦截。',
      补充指标: '「问题声明被判supported(放行风险)」：已抽到的问题声明中最终判定为 supported 的条数（安全漏洞口径）；「正常声明抽取覆盖」：已抽到的正常声明条数/全部正常声明。',
    },
    models: results,
  };

  const outDir = join(evalDir, 'output');
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `draft-verification-${at.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));

  console.log(`\n===== 草稿核查器小规模评测（代码版本 git ${cv.gitHead}${cv.dirtyFiles.length ? '，工作区有未提交改动：' + cv.dirtyFiles.join(', ') : ''}）=====`);
  console.log(`样本：${CLAIM_STATS.cases} 案例 / ${CLAIM_STATS.totalClaims} 声明（问题 ${CLAIM_STATS.problemClaims} / 正常 ${CLAIM_STATS.normalClaims}）；评分语言 zh；端点 ${baseUrl}${localModel ? '（本地）' : '（远程）'}`);
  for (const r of results) {
    if (r.status === '待测') {
      console.log(`\n### 模型 ${r.model}：待测（接口未就绪：${r.smoke.error}）`);
      continue;
    }
    if (args.smokeOnly) { console.log(`\n### 模型 ${r.model}：接口就绪（smoke ${r.smoke.ms}ms，未跑案例）`); continue; }
    console.log(`\n### 模型 ${r.model}（${r.group}）`);
    printTable('指标（分子/分母）', ['指标', '数值'],
      Object.entries(r.metrics).map(([k, v]) => [k, frStr(v)]));
    printTable('案例明细', ['案例', '声明', '类别', '期望判定', '抽取', '模型判定', '判对', '放行?'],
      r.cases.flatMap(cs => cs.claims.map(row => [
        cs.caseId, row.claimId, row.category, row.expectedStatus,
        String(row.extracted), row.modelStatus ?? '—', row.judgmentCorrect === null ? '—' : String(row.judgmentCorrect),
        row.passed === null ? '—' : String(row.passed)])));
  }
  console.log(`\n原始输出与 trace 已保存：${file}`);
  console.log(completed.length ? `完成模型：${completed.join('、')}` : '没有就绪模型可跑（全部待测）。');
}

main().catch(error => { console.error('RUNNER 控制项失败：', error.message); process.exit(1); });
