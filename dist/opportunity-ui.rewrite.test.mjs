import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityUI } from './opportunity-ui.js';

// 窗口 1 跨版本改写的界面覆盖（与 opportunity-ui.founder.test.mjs 同模式，独立文件避免并行冲突）：
// 1. same_fact 行：原句→新句 + 只有逐条担保入口（无改写/删除按钮）；
// 2. ambiguous 行：原句与新句 + 核对说明 + 「是同一事实 / 不是同一事实」按钮，
//    点击发 opportunity-claim-rewrite-review 请求（精确 payload）；
// 3. 已记录的核对结论显示决策行（改写核对已记录 · 同一事实 · 说明）；
// 4. 旧行（无 match 字段）回退到旧口径：原句仍在正文里才显示；
// 5. 审计的 claim_rewrite_reviewed 事件显示「改写核对已记录」标签。
function harness() {
  const nodes = [];
  const element = (tag, text = '') => {
    const node = { tag, text, children: [], open: false, listeners: {},
      get textContent() { return this.text; },
      set textContent(value) { this.text = value; },
      append(...kids) { this.children.push(...kids); },
      replaceChildren(...kids) { this.children = [...kids]; },
      setAttribute() {},
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      openToggle(open) { this.open = open; (this.listeners['toggle'] ?? []).forEach(fn => fn()); },
      reportValidity() { return true; },
    };
    nodes.push(node);
    return node;
  };
  const action = (label, callback) => {
    const button = element('button', label);
    button.onclick = () => callback();
    return button;
  };
  const elements = new Map();
  const get = id => elements.get(id) ?? (elements.set(id, element('div', '')), elements.get(id));
  const requests = [];
  const render = createOpportunityUI({
    get, t: key => key, element, action,
    request: async (name, data) => { requests.push({ name, data }); },
    formAction: () => {}, language: () => 'zh-CN', createTask: () => {},
  });
  const allText = () => {
    const walk = node => (node.text ?? '') + ' ' + (node.children ?? []).map(walk).join(' ');
    return nodes.map(walk).join(' ');
  };
  const renderOne = (entry, audit = []) => render({ opportunities: [entry], delegation: {}, audit });
  const button = label => nodes.find(node => node.tag === 'button' && node.text === label);
  const input = placeholder => nodes.find(node => node.tag === 'input' && node.placeholder === placeholder);
  return { renderOne, allText, requests, button, input, nodes };
}

// 上一版被标记的「合同已签署」（创始人陈述，待独立核实）；当前草稿已换成改写后的说法。
const flagClaim = {
  id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'founder_only',
  items: [{ valid: true, stance: 'supports', quote: '已签约', note: '创始人陈述已完成事实',
    source: { id: 'S1', source: '创始人记录', date: null, kind: 'founder', text: '客户已签约。' } }],
  missing: '', rewrite: '', conflict: null, withdrawn: false, failedChecks: [],
};
const baseItem = {
  id: 'o1', kind: 'lead', title: '签约线索', source: '客户线程', evidence: '客户询问了签约进展。',
  evidence_kind: 'founder',
  analysis: null, review: null, review_draft: null, reviewStale: null, reviewViewed: { draftId: 'd2', evidence: 'e2', viewed: [] },
  draft_id: 'd2', recipient: 'client@example.test', sent: 0,
  sources: [{ id: 1, name: '创始人记录', date: null, kind: 'founder', text: '客户已签约。' }],
  claims: {
    target: 'draft', at: '2026-11-13T00:00:00Z', error: null,
    claims: [{ id: '签约状态', dimension: '签约状态', text: '双方已完成签约', status: 'supported', withdrawn: false,
      items: [{ valid: true, stance: 'supports', quote: '已签约', note: '创始人陈述已完成事实',
        source: { id: 'S1', source: '创始人记录', date: null, kind: 'founder', text: '客户已签约。' } }],
      conflict: null, missing: '', rewrite: '', failedChecks: [] }],
  },
  claimsStale: false, claimResolutions: [], claimRewriteReviews: [],
};
const flagRow = {
  claimId: '签约状态', claimText: '合同已签署', text: '合同已签署',
  dimension: '签约状态', status: 'founder_only', draftId: 'd1', evidence: 'e1',
  at: '2026-11-12T00:00:00Z', firstFlaggedAt: '2026-11-12T00:00:00Z',
  active: false, current: false, sourceChanged: true,
  claim: flagClaim,
};

test('a same_fact flag row shows the old→new sentence and only the guarantee path (no rewrite/delete)', () => {
  const row = { ...flagRow,
    match: { version: 'claim-match-v1', verdict: 'same_fact',
      candidates: [{ sentence: '双方已完成签约。', relation: 'same_fact', aspects: { signing: { old: 'completed', next: 'completed' } } }] },
    rewriteReview: null, effectiveVerdict: 'same_fact', handledBy: null, pending: true };
  const { renderOne, allText, button, input, requests } = harness();
  renderOne({ ...baseItem, body: '双方已完成签约。', previousClaims: [row], previousUnresolvedClaims: [row], carryoverClaims: [row] });
  const text = allText();
  assert.ok(text.includes('上一版声明被近义改写，仍是同一事实，原风险仍需处理。'),
    'the same_fact row carries the attention line');
  assert.ok(text.includes('原句 · 合同已签署 → 新句 · 双方已完成签约。'),
    'the old→new sentence pair is shown');
  assert.ok(!text.includes('改写并重新核查') && !text.includes('删除此句并重新核查'),
    'no rewrite/delete buttons: the old sentence is not in the body anymore');
  assert.ok(text.includes('填写') === false, 'no review note input on a same_fact row');
  assert.ok(button('我已核实并愿意承担这条说法'), 'the guarantee action is offered');
  assert.ok(input('记录担保理由'), 'the guarantee reason input is offered');
  // 填写理由后点击担保：按旧原句记录（claim_text = 旧句），接口名与 payload 精确。
  input('记录担保理由').value = '已逐条核对并承担。';
  button('我已核实并愿意承担这条说法').onclick();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { name: 'opportunity-claim-resolution',
    data: { id: 'o1', draft_id: 'd2', claim_id: '签约状态', claim_text: '合同已签署', reason: '已逐条核对并承担。' } });
  // 状态行与草稿区都提示上一版仍有未处理声明。
  assert.ok(text.includes('当前状态 · 上一版仍有未处理声明 · 1'));
});

test('an ambiguous flag row offers the founder review buttons with the exact review payload', () => {
  const row = { ...flagRow,
    match: { version: 'claim-match-v1', verdict: 'ambiguous',
      candidates: [{ sentence: '双方下周签约。', relation: 'ambiguous', aspects: { signing: { old: 'completed', next: 'unknown' } } }] },
    rewriteReview: null, effectiveVerdict: 'ambiguous', handledBy: null, pending: true };
  const { renderOne, allText, button, input, requests } = harness();
  renderOne({ ...baseItem, body: '双方下周签约。', previousClaims: [row], previousUnresolvedClaims: [row], carryoverClaims: [row] });
  const text = allText();
  assert.ok(text.includes('无法确定改写后是否仍是同一事实，请核对原句与新句后选择：'),
    'the ambiguous row asks the founder to decide');
  assert.ok(text.includes('原句 · 合同已签署 → 新句 · 双方下周签约。'), 'the candidate sentence is shown');
  assert.ok(!text.includes('上一版声明被近义改写'), 'no same_fact line on an ambiguous row');
  assert.ok(!text.includes('我已核实并愿意承担这条说法'),
    'no guarantee action before the review verdict is recorded');
  const note = input('填写核对说明');
  assert.ok(note, 'the review note input is offered');
  note.value = '下周签约即已签约的提前表述。';
  button('是同一事实（保留标记）').onclick();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { name: 'opportunity-claim-rewrite-review',
    data: { id: 'o1', draft_id: 'd2', claim_id: '签约状态', claim_text: '合同已签署',
      verdict: 'same_fact', note: '下周签约即已签约的提前表述。' } });
  button('不是同一事实（解除标记）').onclick();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].data.verdict, 'different_fact');
  assert.deepEqual(requests[1].name, 'opportunity-claim-rewrite-review');
});

test('a recorded rewrite review renders the decision line beside the flag', () => {
  const row = { ...flagRow,
    match: { version: 'claim-match-v1', verdict: 'ambiguous',
      candidates: [{ sentence: '双方下周签约。', relation: 'ambiguous', aspects: { signing: { old: 'completed', next: 'unknown' } } }] },
    rewriteReview: { claimId: '签约状态', claimText: '合同已签署', verdict: 'same_fact',
      note: '核对过客户邮件，是同一事实。', draftId: 'd2', evidence: 'e2', matchVersion: 'claim-match-v1',
      candidates: [], at: '2026-11-13T00:00:00Z' },
    effectiveVerdict: 'same_fact', handledBy: null, pending: true };
  const { renderOne, allText } = harness();
  renderOne({ ...baseItem, body: '双方下周签约。', previousClaims: [row], previousUnresolvedClaims: [row], carryoverClaims: [row] });
  const text = allText();
  assert.ok(text.includes('改写核对已记录 · 同一事实 · 核对过客户邮件，是同一事实。'),
    'the recorded verdict and note are shown');
  assert.ok(text.includes('上一版声明被近义改写，仍是同一事实，原风险仍需处理。'),
    'the effective verdict same_fact keeps the pending-risk line');
});

test('legacy rows without a match field fall back to the verbatim-in-body filter', () => {
  const legacy = { claimId: '签约状态', claimText: '合同已签署', text: '合同已签署',
    dimension: '签约状态', status: 'founder_only', draftId: 'd1', evidence: 'e1',
    at: '2026-11-12T00:00:00Z', firstFlaggedAt: '2026-11-12T00:00:00Z',
    active: true, current: false, sourceChanged: false, claim: flagClaim };
  // 原句仍在正文里（旧口径）：显示。
  const shown = harness();
  shown.renderOne({ ...baseItem, body: '张总：合同已签署。', previousClaims: [legacy], previousUnresolvedClaims: [legacy], carryoverClaims: [legacy] });
  assert.ok(shown.allText().includes('上一版仍有未处理声明'), 'a legacy row still in the body is shown');
  // 原句不在正文里且无 match 字段（旧快照）：不显示，也不计入待处理。
  const hidden = harness();
  hidden.renderOne({ ...baseItem, body: '双方下周签约。', previousClaims: [legacy], previousUnresolvedClaims: [legacy], carryoverClaims: [legacy] });
  assert.ok(!hidden.allText().includes('上一版仍有未处理声明'), 'a legacy row no longer in the body is not shown');
});

test('the claim_rewrite_reviewed audit event gets the 改写核对已记录 label', () => {
  const row = { ...flagRow,
    match: { version: 'claim-match-v1', verdict: 'same_fact',
      candidates: [{ sentence: '双方已完成签约。', relation: 'same_fact', aspects: { signing: { old: 'completed', next: 'completed' } } }] },
    rewriteReview: null, effectiveVerdict: 'same_fact', handledBy: null, pending: true };
  const audit = [{ id: 1, opportunity: 'o1', action: 'claim_rewrite_reviewed', time: '2026-11-13T00:00:00Z',
    detail: JSON.stringify({ claimId: '签约状态', claimText: '合同已签署', verdict: 'same_fact',
      note: '核对过客户邮件，是同一事实。', draftId: 'd2', evidence: 'e2', matchVersion: 'claim-match-v1', candidates: [] }) }];
  const { renderOne, allText } = harness();
  renderOne({ ...baseItem, body: '双方已完成签约。', previousClaims: [row], previousUnresolvedClaims: [row], carryoverClaims: [row] }, audit);
  assert.ok(allText().includes('改写核对已记录'), 'the new audit action has a label');
  assert.ok(!allText().includes('claim_rewrite_reviewed'), 'the raw action code is not leaked into the label');
});
