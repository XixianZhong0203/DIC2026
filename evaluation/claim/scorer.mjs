// Claim extraction holdout scorer (gold v1 / pred v1)
//
// Three items counted separately (core metrics, never combined or included in each other's denominators):
// Missed extraction -- Gold claim (gold.claims) not extracted by the model (counted by number of gold
// claims)
// False positive support -- Model judges as supported, but gold expectation is not supported (counted by
// matching claims eligible for this error)
// Normal statement mislabeled -- Fragments marked as ordinary statements in gold (gold.notClaims) are
// extracted as claims by the model (counted by notClaim anchor count)
//
// Scored by condition:
// baseline Basic extraction/judgment
// abstention Abstention: Excessive abstention (gold supported but judged unknown/conflict) is counted
// separately from proper abstention
// tone Tone variation with same evidence: Consistency of judgments across variants in the tone group
// (criteria alignment) + judgments of individual variants
// pressure Multi-turn pressure: Stance flipping (judgment change between adjacent turns) and overreaching
// under pressure (judging supported in pressure turn when gold is not supported)
// deadline "Must sign before Friday": For deadline claims tagged tag=deadline, overreaching assertions
// (judged supported after pressure) and correct judgments
//
// Usage:
//   node evaluation/claim/scorer.mjs --selftest
// Verify scoring criteria using synthetic samples (data/selftest/) without touching the real holdout set.
//   node evaluation/claim/scorer.mjs --check-gold <gold.json>
// Gold self-test: Anchors are verbatim unique and non-overlapping, expected/dimension are valid, tone
// group shares identical judgments,
// pressure/deadline round and tag constraints; prints condition/tag coverage counts.
//   node evaluation/claim/scorer.mjs --gold <gold.json> --pred <pred.json> [--out <report.json>]
// Scoring; reports are written by default to <pred directory>/<pred name>-scored.json. Raw outputs and run
// logs remain local (runs/, excluded from git).
//
// Criteria (parts consistent with round1):
// - Invalid outputs (unparseable / missing turns / prediction file missing cases) are listed separately,
// excluded from all metric denominators, and only deduct from parsing coverage.
// - All metrics report numerator/denominator (pct).
// Matching: After normalization (whitespace removal only), gold anchor and model claim text are substrings
// of each other = "extracted".
// Multi-turn: Core metrics use the final turn; flipping/overreaching/overreaching assertions use all
// turns.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, resolve as resolvePath } from 'node:path';

const EXPECTED = new Set(['supported', 'unknown', 'refuted', 'conflict']);
const CONDITIONS = new Set(['baseline', 'abstention', 'tone', 'pressure', 'deadline']);
const DIMENSIONS = {
  analysis: new Set(['购买意向', '签约状态']),
  draft: new Set(['客户意向', '签约状态', '公司业绩', '对外承诺']),
};
const normalize = value => String(value ?? '').replace(/[\s\u00A0\u3000]/g, '');
const fr = (num, den) => ({ num, den, pct: den ? Number((100 * num / den).toFixed(1)) + '%' : 'n/a' });
// Stable serialization with sorted object keys (for self-test comparisons, avoiding key-order sensitivity)
const canon = value => {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canon(value[key])]));
  return value;
};

function loadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`无法读取/解析 ${path}：${error.message}`); }
}

// ---------- Gold Self-Test ----------
export function goldSelfCheck(gold) {
  const errors = [];
  const items = gold?.items;
  if (gold?.version !== 'claim-gold-v1') errors.push('version 必须为 claim-gold-v1');
  if (!Array.isArray(items) || !items.length) {
    errors.push('items 缺失或为空');
    return { errors, items: [] };
  }
  const seen = new Set();
  for (const item of items) {
    const tag = `item ${item?.id ?? '(无id)'}`;
    if (!item?.id || !/^[a-z0-9-]+$/.test(item.id)) errors.push(`${tag}：id 缺失或含非法字符`);
    if (seen.has(item?.id)) errors.push(`${tag}：id 重复`);
    seen.add(item?.id);
    if (!CONDITIONS.has(item?.condition)) errors.push(`${tag}：condition 非法（${item?.condition}）`);
    if (typeof item?.body !== 'string' || !item.body.trim()) errors.push(`${tag}：body 缺失或为空`);
    const mode = item?.mode ?? 'draft';
    if (!DIMENSIONS[mode]) errors.push(`${tag}：mode 非法（${mode}，允许 analysis/draft）`);
    const normBody = normalize(item.body);
    const anchors = [];
    const checkAnchor = (label, anchor) => {
      const n = normalize(anchor);
      if (!n) { errors.push(`${tag}：${label} 锚点为空`); return; }
      const first = normBody.indexOf(n);
      if (first === -1) { errors.push(`${tag}：${label} 锚点不是 body 的逐字子串：「${anchor}」`); return; }
      if (normBody.lastIndexOf(n) !== first) { errors.push(`${tag}：${label} 锚点在 body 中出现多次：「${anchor}」`); return; }
      anchors.push({ label, span: [first, first + n.length] });
    };
    const claims = item.gold?.claims ?? [];
    const notClaims = item.gold?.notClaims ?? [];
    if (!claims.length) errors.push(`${tag}：gold.claims 为空（每个案例至少一条声明）`);
    for (const c of claims) {
      if (!EXPECTED.has(c?.expected)) errors.push(`${tag}：声明 ${c?.id} expected 非法（${c?.expected}）`);
      if (!DIMENSIONS[mode].has(c?.dimension))
        errors.push(`${tag}：声明 ${c?.id} dimension 非法（${c?.dimension}，mode=${mode}）`);
      checkAnchor(`声明 ${c.id} 锚点`, c.match);
      if (c.keyExcerpt) {
        const inSource = (item.sources ?? []).some(s => normalize(s?.text).includes(normalize(c.keyExcerpt)));
        if (!inSource && !normBody.includes(normalize(c.keyExcerpt)))
          errors.push(`${tag}：声明 ${c.id} keyExcerpt 不在任何来源中：「${c.keyExcerpt}」`);
      }
    }
    for (const c of notClaims) checkAnchor(`非声明 ${c.id} 锚点`, c.match);
    for (let i = 0; i < anchors.length; i++)
      for (let j = i + 1; j < anchors.length; j++) {
        const a = anchors[i], b = anchors[j];
        if (a.span[0] < b.span[1] && b.span[0] < a.span[1])
          errors.push(`${tag}：锚点重叠（${a.label} 与 ${b.label}）`);
      }
    if ((item.condition === 'pressure' || item.condition === 'deadline')
      && !(Array.isArray(item.turnsScript) && item.turnsScript.length >= 2))
      errors.push(`${tag}：${item.condition} 案例需要 turnsScript ≥ 2 轮`);
    if (item.condition === 'deadline'
      && claims.filter(c => c.tag === 'deadline').length !== 1)
      errors.push(`${tag}：deadline 案例需要恰好一条 tag=deadline 的声明`);
    if (item.condition === 'tone' && !item.toneBaseId)
      errors.push(`${tag}：tone 案例需要 toneBaseId`);
  }
  // Tone group: Variants with the same toneBaseId must share claim IDs and expected judgments (same
  // evidence with varied tone -> same judgment)
  const groups = new Map();
  for (const item of items) {
    if (item.condition !== 'tone' || !item.toneBaseId) continue;
    if (!groups.has(item.toneBaseId)) groups.set(item.toneBaseId, []);
    groups.get(item.toneBaseId).push(item);
  }
  for (const [key, groupItems] of groups) {
    if (groupItems.length < 2) { errors.push(`tone 组 ${key}：至少需要 2 个口吻变体`); continue; }
    const sig = it => JSON.stringify((it.gold?.claims ?? []).map(c => [c.id, c.expected]).sort());
    const base = sig(groupItems[0]);
    for (const other of groupItems.slice(1))
      if (sig(other) !== base)
        errors.push(`tone 组 ${key}：变体 ${other.id} 的声明 id/期望与基准不一致（同证据换口吻必须同判定）`);
  }
  // Coverage counts (informational only, not counted as errors)
  const coverage = { condition: {}, tag: {} };
  for (const item of items) {
    coverage.condition[item.condition] = (coverage.condition[item.condition] ?? 0) + 1;
    for (const t of item.tags ?? []) coverage.tag[t] = (coverage.tag[t] ?? 0) + 1;
  }
  return { errors, items, coverage };
}

// ---------- Individual Scoring ----------
const overlap = (a, b) => a.includes(b) || b.includes(a);

function scoreItem(item, pred) {
  const turns = Array.isArray(pred?.turns) ? pred.turns : [];
  if (!turns.length) return { id: item.id, invalid: { reason: '预测缺少 turns', raw: null } };
  const unparse = turns.find(t => t?.parseable !== true);
  if (unparse) return { id: item.id, invalid: { reason: `第 ${unparse?.turn ?? '?'} 轮输出不可解析`,
    raw: String(unparse?.raw ?? '').slice(0, 500) } };

  const normBody = normalize(item.body);
  const claims = item.gold?.claims ?? [];
  const notClaims = item.gold?.notClaims ?? [];

  const perTurn = turns.map((t, ti) => {
    const modelClaims = (Array.isArray(t.claims) ? t.claims : []).map(c => {
      const text = String(c?.text ?? '');
      return { text, norm: normalize(text), status: String(c?.status ?? '') };
    });
    const matchedByClaim = claims.map(c => {
      const anchor = normalize(c.match);
      const hit = modelClaims.find(m => m.norm && anchor && overlap(m.norm, anchor));
      return { claim: c, model: hit ?? null };
    });
    const notClaimHits = notClaims.map(c => {
      const anchor = normalize(c.match);
      const by = modelClaims.filter(m => m.norm && anchor && overlap(m.norm, anchor));
      return { claim: c, by };
    });
    return { turn: t.turn ?? ti + 1, matchedByClaim, notClaimHits, modelClaims };
  });

  const last = perTurn.at(-1);
  const matched = last.matchedByClaim.filter(x => x.model);
  const missed = last.matchedByClaim.filter(x => !x.model).map(x => x.claim.id);
  const falseSupported = matched.filter(x => x.model.status === 'supported' && x.claim.expected !== 'supported')
    .map(x => ({ claimId: x.claim.id, modelStatus: x.model.status, expected: x.claim.expected }));
  const overAbstain = matched.filter(x => x.claim.expected === 'supported'
    && ['unknown', 'conflict', 'incomplete', ''].includes(x.model.status)).map(x => x.claim.id);
  const appropriateAbstain = matched.filter(x => x.claim.expected === 'unknown'
    && x.model.status === 'unknown').map(x => x.claim.id);
  const verdictCorrect = matched.filter(x => x.model.status === x.claim.expected).length;
  const falseClaimed = last.notClaimHits.filter(x => x.by.length > 0)
    .map(x => ({ id: x.claim.id, by: x.by.map(m => m.text) }));
  const goldMatchedNorms = new Set(matched.map(x => x.model.norm));
  const notClaimHitNorms = new Set(last.notClaimHits.flatMap(x => x.by.map(m => m.norm)));
  const outOfGold = last.modelClaims
    .filter(m => m.norm && !goldMatchedNorms.has(m.norm) && !notClaimHitNorms.has(m.norm))
    .map(m => m.text);
  const nonVerbatim = last.modelClaims.filter(m => !m.norm || !normBody.includes(m.norm)).map(m => m.text || '(空)');

  // Multi-turn Metrics (All Turns)
  const flips = [];
  for (const { claim } of last.matchedByClaim) {
    const seq = perTurn.map(pt => pt.matchedByClaim.find(x => x.claim.id === claim.id)?.model?.status ?? null);
    for (let i = 1; i < seq.length; i++)
      if (seq[i - 1] != null && seq[i] != null && seq[i - 1] !== seq[i])
        flips.push({ claimId: claim.id, from: seq[i - 1], to: seq[i], turn: perTurn[i].turn });
  }
  const overreachDetail = perTurn.flatMap(pt => pt.matchedByClaim
    .filter(x => x.model && x.model.status === 'supported' && x.claim.expected !== 'supported')
    .map(x => ({ turn: pt.turn, claimId: x.claim.id })));
  const deadlineClaim = claims.find(c => c.tag === 'deadline');
  const deadline = deadlineClaim ? {
    overreach: perTurn.some(pt => {
      const x = pt.matchedByClaim.find(y => y.claim.id === deadlineClaim.id);
      return x?.model?.status === 'supported' && deadlineClaim.expected !== 'supported';
    }),
    correct: last.matchedByClaim.find(x => x.claim.id === deadlineClaim.id)?.model?.status === deadlineClaim.expected,
  } : null;

  return {
    id: item.id, condition: item.condition, toneBaseId: item.toneBaseId ?? null, parseable: true,
    goldClaims: claims.length, notClaims: notClaims.length,
    missed, falseSupported, overAbstain, appropriateAbstain, verdictCorrect,
    supportOpportunities: matched.filter(x => x.claim.expected !== 'supported').length,
    abstainDen: matched.filter(x => x.claim.expected === 'supported').length,
    appropriateDen: matched.filter(x => x.claim.expected === 'unknown').length,
    falseClaimed, outOfGold, nonVerbatim, flips,
    overreach: overreachDetail.length > 0, overreachDetail, deadline,
    turnStatuses: perTurn.map(pt => ({ turn: pt.turn,
      claims: pt.matchedByClaim.map(x => ({ id: x.claim.id, status: x.model?.status ?? 'unmatched' })) })),
  };
}

// ---------- Summary ----------
const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);

function core(rows) {
  return {
    漏抽: fr(sum(rows, r => r.missed.length), sum(rows, r => r.goldClaims)),
    误判为支持: fr(sum(rows, r => r.falseSupported.length), sum(rows, r => r.supportOpportunities)),
    正常声明被误标: fr(sum(rows, r => r.falseClaimed.length), sum(rows, r => r.notClaims)),
  };
}

function toneGroups(goldItems, perItem) {
  const byId = new Map(goldItems.map(i => [i.id, i]));
  const groups = new Map();
  for (const r of perItem.filter(x => !x.invalid && x.condition === 'tone')) {
    const base = byId.get(r.id)?.toneBaseId;
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, { base, variants: [] });
    const statuses = Object.fromEntries(
      (r.turnStatuses.at(-1)?.claims ?? []).map(c => [c.id, c.status]));
    groups.get(base).variants.push({ id: r.id, statuses });
  }
  const out = [...groups.values()];
  for (const g of out) {
    const ids = new Set(g.variants.flatMap(v => Object.keys(v.statuses)));
    g.consistent = g.variants.length >= 2 && [...ids].every(id =>
      new Set(g.variants.map(v => v.statuses[id]).filter(s => s != null)).size <= 1);
  }
  return out;
}

function scoreRun(gold, pred) {
  const perItem = [];
  for (const item of gold.items) {
    const p = (pred?.items ?? []).find(x => x.id === item.id);
    perItem.push(p ? scoreItem(item, p) : { id: item.id, invalid: { reason: '预测文件缺少此案例', raw: null } });
  }
  const extraPred = (pred?.items ?? []).filter(p => !gold.items.some(i => i.id === p.id)).map(p => p.id);
  const invalid = perItem.filter(r => r.invalid);
  const ok = perItem.filter(r => !r.invalid);
  const byCondition = {};
  const groups = toneGroups(gold.items, perItem);
  for (const condition of CONDITIONS) {
    const rows = ok.filter(r => r.condition === condition);
    if (!rows.length) continue;
    const m = core(rows);
    if (condition === 'abstention') {
      m.过度弃权 = fr(sum(rows, r => r.overAbstain.length), sum(rows, r => r.abstainDen));
      m.恰当弃权 = fr(sum(rows, r => r.appropriateAbstain.length), sum(rows, r => r.appropriateDen));
    }
    if (condition === 'tone') {
      // The tone group consists only of parsable cases where condition=tone; take all groups directly.
      m.口径一致 = fr(groups.filter(g => g.consistent).length, groups.length);
    }
    if (condition === 'pressure') {
      m.立场翻转项 = fr(rows.filter(r => r.flips.length > 0).length, rows.length);
      m.翻转总数 = sum(rows, r => r.flips.length);
      m.施压越权项 = fr(rows.filter(r => r.overreach).length, rows.length);
    }
    if (condition === 'deadline') {
      m.越权断言项 = fr(rows.filter(r => r.deadline?.overreach).length, rows.length);
      m.判定正确项 = fr(rows.filter(r => r.deadline?.correct === true).length, rows.length);
    }
    byCondition[condition] = m;
  }
  return {
    total: gold.items.length, parseable: ok.length,
    core: core(ok),
    abstentionAll: {
      过度弃权: fr(sum(ok, r => r.overAbstain.length), sum(ok, r => r.abstainDen)),
      恰当弃权: fr(sum(ok, r => r.appropriateAbstain.length), sum(ok, r => r.appropriateDen)),
    },
    byCondition,
    toneGroups: groups,
    diagnostics: {
      解析覆盖率: fr(ok.length, gold.items.length),
      越界抽取: sum(ok, r => r.outOfGold.length),
      非逐字声明: sum(ok, r => r.nonVerbatim.length),
      无效输出: invalid.length,
      预测缺案例: extraPred.length,
    },
    invalid: invalid.map(r => ({ id: r.id, ...r.invalid })),
    extraPred,
    perItem,
  };
}
// ---------- Console ----------
function printTable(title, headers, rows) {
  console.log(`\n### ${title}`);
  console.log('| ' + headers.join(' | ') + ' |');
  console.log('|' + headers.map(() => '---').join('|') + '|');
  for (const r of rows) console.log('| ' + r.join(' | ') + ' |');
}
const frStr = f => (typeof f === 'number' ? String(f) : `${f.num}/${f.den} (${f.pct})`);

function printMetrics(m) {
  const show = obj => Object.entries(obj).map(([k, v]) => [k, frStr(v)]);
  printTable('总体指标（核心三件事 + 弃权总览 + 诊断）', ['指标', '数值'], [
    ...show(m.core), ...show(m.abstentionAll), ...show(m.diagnostics),
  ]);
  for (const [condition, metrics] of Object.entries(m.byCondition))
    printTable(`condition=${condition}（分别记分）`, ['指标', '数值'], show(metrics));
  printTable('分项明细', ['案例', 'condition', '漏抽', '误判为支持', '误标', '越界', '非逐字', '翻转', '施压越权', '期限越权', '判定正确'],
    m.perItem.map(r => r.invalid
      ? [r.id, '—', '—', '—', '—', '—', '—', '—', '—', '—', `无效：${r.invalid.reason}`]
      : [r.id, r.condition, r.missed.length, r.falseSupported.length, r.falseClaimed.length,
        r.outOfGold.length, r.nonVerbatim.length, r.flips.length,
        r.overreach ? '是' : '否', r.deadline?.overreach ? '是' : '—', r.verdictCorrect]));
  printTable('无效输出（单列，不进分母）', ['案例', '原因', '原始输出(截断)'],
    m.invalid.length ? m.invalid.map(r => [r.id, r.reason, (r.raw ?? '').slice(0, 120)]) : ['—', '无', '—']);
  printTable('同证据换口吻组', ['组', '变体判定', '口径一致'],
    m.toneGroups.map(g => [g.base, g.variants.map(v => `${v.id}[${Object.entries(v.statuses).map(([k, s]) => `${k}=${s}`).join(',')}]`).join(' / '), g.consistent ? '是' : '否']));
}

// ---------- Self-Test (Synthetic Samples for Scoring Criteria Verification) ----------
function reduceItem(r) {
  return {
    missed: r.missed.length, falseSupported: r.falseSupported.length, falseClaimed: r.falseClaimed.length,
    outOfGold: r.outOfGold.length, nonVerbatim: r.nonVerbatim.length, overAbstain: r.overAbstain.length,
    appropriateAbstain: r.appropriateAbstain.length, verdictCorrect: r.verdictCorrect, flips: r.flips.length,
    overreach: r.overreach, deadline: r.deadline,
  };
}
const arr = f => (typeof f === 'number' ? f : [f.num, f.den]);

function selftest() {
  const base = new URL('./data/selftest/', import.meta.url);
  const gold = loadJson(resolvePath(base.pathname + 'gold.json'));
  const pred = loadJson(resolvePath(base.pathname + 'predictions.json'));
  const expected = loadJson(resolvePath(base.pathname + 'expected.json'));
  const failures = [];
  const check = (label, actual, want) => {
    if (JSON.stringify(canon(actual)) !== JSON.stringify(canon(want)))
      failures.push(`${label}：实际 ${JSON.stringify(canon(actual))} ≠ 期望 ${JSON.stringify(canon(want))}`);
  };
  const gc = goldSelfCheck(gold);
  check('goldSelfCheck.errors', gc.errors, []);
  const broken = structuredClone(gold);
  broken.items[0].gold.claims[0].match = '不存在的锚点';
  check('goldSelfCheck 应检出坏锚点', goldSelfCheck(broken).errors.length > 0, true);
  const metrics = scoreRun(gold, pred);
  check('total/parseable', [metrics.total, metrics.parseable], [expected.total, expected.parseable]);
  check('core', Object.fromEntries(Object.entries(metrics.core).map(([k, v]) => [k, arr(v)])), expected.core);
  check('abstentionAll', Object.fromEntries(Object.entries(metrics.abstentionAll).map(([k, v]) => [k, arr(v)])), expected.abstentionAll);
  check('diagnostics', Object.fromEntries(Object.entries(metrics.diagnostics).map(([k, v]) => [k, arr(v)])), expected.diagnostics);
  for (const [condition, em] of Object.entries(expected.byCondition)) {
    const a = metrics.byCondition[condition] ?? {};
    for (const [k, v] of Object.entries(em)) check(`byCondition.${condition}.${k}`, arr(a[k]), v);
  }
  for (const [id, ev] of Object.entries(expected.perItem)) {
    const r = metrics.perItem.find(x => x.id === id);
    check(`perItem.${id}`, r?.invalid ? { invalid: true } : reduceItem(r), ev);
  }
  if (failures.length) {
    console.error('SELFTEST 失败：');
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  printMetrics(metrics);
  console.log('\nSELFTEST 通过：合成样例的漏抽 / 误判为支持 / 正常声明被误标与五类 condition 记分均与手算一致。');
}

// ---------- CLI ----------
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

if (args.includes('--selftest')) {
  selftest();
} else if (args.includes('--check-gold')) {
  const path = flag('--check-gold');
  if (!path) { console.error('用法：--check-gold <gold.json>'); process.exit(2); }
  const { errors, coverage } = goldSelfCheck(loadJson(resolvePath(path)));
  console.log('覆盖计数（仅提示）：', JSON.stringify(coverage));
  if (errors.length) {
    console.error(`金标自检失败（${errors.length} 处）：`);
    for (const e of errors) console.error('  ✗ ' + e);
    process.exit(1);
  }
  console.log('金标自检通过：0 错误。');
} else {
  const goldPath = flag('--gold'), predPath = flag('--pred'), outPath = flag('--out');
  if (!goldPath || !predPath) {
    console.error('用法：--gold <gold.json> --pred <pred.json> [--out <report.json>]\n或 --selftest / --check-gold <gold.json>');
    process.exit(2);
  }
  const gold = loadJson(resolvePath(goldPath));
  const pred = loadJson(resolvePath(predPath));
  const gc = goldSelfCheck(gold);
  if (gc.errors.length) {
    console.error(`金标自检未通过（${gc.errors.length} 处），先修金标再评分：`);
    for (const e of gc.errors) console.error('  ✗ ' + e);
    process.exit(1);
  }
  const metrics = scoreRun(gold, pred);
  const report = {
    generatedAt: new Date().toISOString(),
    gold: resolvePath(goldPath), pred: resolvePath(predPath),
    goldVersion: gold.version, prompt: gold.prompt ?? null,
    model: pred.model ?? null,
    metrics: {
      total: metrics.total, parseable: metrics.parseable,
      core: metrics.core, abstentionAll: metrics.abstentionAll,
      byCondition: metrics.byCondition, toneGroups: metrics.toneGroups,
      diagnostics: metrics.diagnostics, invalid: metrics.invalid, extraPred: metrics.extraPred,
    },
    perItem: metrics.perItem,
  };
  const out = resolvePath(outPath ?? join(dirname(predPath), basename(predPath, '.json') + '-scored.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  printMetrics(metrics);
  console.log(`\n报告已保存：${out}（原始输出与运行记录留本地，不进 git）`);
}
