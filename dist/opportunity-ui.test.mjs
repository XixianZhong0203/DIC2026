import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityUI } from './opportunity-ui.js';

// 用最小假 DOM 驱动真实 UI 模块，断言人工复核表单的行为：
// 表单提交的结论必须绑定当前草稿版本；旧草稿上的复核失效后表单重新出现。
function harness() {
  const nodes = [];
  const element = (tag, text = '') => {
    const node = { tag, text, children: [],
      append(...kids) { this.children.push(...kids); },
      replaceChildren(...kids) { this.children = [...kids]; },
      setAttribute(name, value) { this.attributes ??= {}; this.attributes[name] = value; },
      reportValidity() { return true; },
    };
    nodes.push(node);
    return node;
  };
  const action = (label, callback) => {
    const button = element('button', label);
    button.onclick = () => callback();
    button.click = () => button.onclick();
    return button;
  };
  const elements = new Map();
  const get = id => elements.get(id) ?? (elements.set(id, element('div', '')), elements.get(id));
  const requests = [];
  const render = createOpportunityUI({
    get, t: key => key, element, action,
    request: async (name, payload) => { requests.push({ name, payload }); },
    formAction: () => {}, language: () => 'en', createTask: () => {},
  });
  const reviewButton = () => nodes.find(node => node.tag === 'button' && node.text === '保存核实结果');
  const reviewTextarea = () => nodes.find(node => node.tag === 'textarea'
    && node.placeholder === '记录核实结果或说明这封邮件只用于澄清');
  const submitReview = resolution => {
    reviewTextarea().value = resolution;
    reviewButton().click();
  };
  const fullText = node => (node.text ?? '') + (node.children ?? []).map(fullText).join(' ');
  // 返回本次渲染的机会卡片节点，便于断言卡片内的完整文本。
  const renderOne = entry => {
    render({ opportunities: [entry], delegation: {}, audit: [] });
    return elements.get('opportunity-list').children.at(-1);
  };
  return { render, nodes, renderOne, requests, reviewButton, reviewTextarea, submitReview, fullText };
}

function find(nodes, predicate) {
  for (const node of nodes) {
    if (predicate(node)) return node;
    const hit = find(node.children ?? [], predicate);
    if (hit) return hit;
  }
  return null;
}

const analysis = (status, analysisId, overrides = {}) => JSON.stringify({
  status, analysisId, quote: '客户表示希望周五交付。', reason: 'explicit', unknown: '',
  conflict: '', clarification: '', suggestedReply: '', raw: '',
  ...overrides,
});
const answer = overrides => ({
  situation: 'insufficient', confirmed: '客户表示想先看案例。',
  missing: '缺少客户明确的签约回复。', bounds: '', next: '可以先发案例并询问采购计划。',
  retryable: false, compare: [], supporting: [], incomplete: [],
  ...overrides,
});
const item = overrides => ({
  id: 'o1', kind: 'lead', title: '客户线索', source: '客户邮件', evidence: '客户表示希望周五交付。',
  analysis: null, review: null, review_draft: null, draft_id: null,
  recipient: null, body: null, sent: 0, sources: [], claims: null, claimsStale: null,
  reviewStale: null,
  ...overrides,
});

test('the review form submits a conclusion bound to the current draft', () => {
  const { renderOne, requests, reviewButton, submitReview } = harness();
  const draftId = 'd1';
  renderOne(item({
    draft_id: draftId, recipient: 'client@example.test', body: '周五交付。',
    analysis: analysis('unknown', 'a1'),
  }));
  assert.ok(reviewButton(), 'review form is shown for an unsupported analysis with a saved draft');
  submitReview('我已核对，先不承诺具体日期。');
  const call = requests.find(entry => entry.name === 'opportunity-review');
  assert.deepEqual(call.payload, {
    id: 'o1', analysis_id: 'a1', draft_id: draftId, resolution: '我已核对，先不承诺具体日期。',
  });
});

test('a review covering the current draft does not show the form again', () => {
  const { renderOne, reviewButton } = harness();
  renderOne(item({
    draft_id: 'd1', review: '已核实当前草稿。', review_draft: 'd1',
    analysis: analysis('supported', 'a1'),
  }));
  assert.equal(reviewButton(), undefined);
});

test('a review bound to an older draft shows the form again for the new draft', () => {
  const { renderOne, requests, reviewButton, submitReview } = harness();
  renderOne(item({
    draft_id: 'd2', review: '旧草稿的复核结论。', review_draft: 'd1',
    analysis: analysis('supported', 'a1'),
  }));
  assert.ok(reviewButton(), 'the stale review does not cover the current draft');
  submitReview('已针对新版本草稿复核。');
  const call = requests.find(entry => entry.name === 'opportunity-review');
  assert.equal(call.payload.draft_id, 'd2');
});

test('a saved draft without any review shows the form so a draft-bound review can be recorded', () => {
  const { renderOne, reviewButton, submitReview, requests } = harness();
  renderOne(item({
    draft_id: 'd1', recipient: 'client@example.test', body: '周五交付。',
    analysis: analysis('supported', 'a1'),
  }));
  assert.ok(reviewButton(), 'a supported analysis alone does not record a human review');
  submitReview('创始人确认当前草稿可发送。');
  const call = requests.find(entry => entry.name === 'opportunity-review');
  assert.equal(call.payload.draft_id, 'd1');
});

test('a review without a saved draft keeps the original behavior (no form when analysis is supported)', () => {
  const { renderOne, reviewButton } = harness();
  renderOne(item({ review: '已核对线索。', review_draft: null, analysis: analysis('supported', 'a1') }));
  assert.equal(reviewButton(), undefined);
});

test('the review form still appears for an unanalyzed lead without a draft', () => {
  const { renderOne, requests, reviewButton, submitReview } = harness();
  renderOne(item({}));
  assert.ok(reviewButton(), 'unanalyzed lead still offers a human review');
  submitReview('未做模型分析，人工判断先澄清。');
  const call = requests.find(entry => entry.name === 'opportunity-review');
  assert.deepEqual(call.payload, { id: 'o1', analysis_id: null, draft_id: null, resolution: '未做模型分析，人工判断先澄清。' });
});

test('a review whose sources changed is shown as expired and the form comes back', () => {
  const { renderOne, reviewButton, submitReview, requests, fullText } = harness();
  const card = renderOne(item({
    draft_id: 'd1', review: '已核实。', review_draft: 'd1', reviewStale: ['source_changed'],
    analysis: analysis('supported', 'a1'),
  }));
  assert.ok(reviewButton(), 'the review is stale on the source version, so the form reappears');
  const text = fullText(card);
  assert.ok(text.includes('复核已过期'), 'the review note row says the review expired');
  assert.ok(text.includes('来源变了'), 'the reason says the sources changed');
  assert.ok(!text.includes('草稿变了'), 'the draft did not change');
  submitReview('已按新来源重新核实。');
  assert.equal(requests.find(entry => entry.name === 'opportunity-review').payload.draft_id, 'd1');
});

test('a legacy review without a source version prompts re-review', () => {
  const { renderOne, reviewButton, fullText } = harness();
  const card = renderOne(item({
    draft_id: 'd1', review: '旧复核记录。', review_draft: 'd1', reviewStale: ['review_unbound'],
    analysis: analysis('supported', 'a1'),
  }));
  assert.ok(reviewButton(), 'a review without a source version cannot unlock the send');
  const text = fullText(card);
  assert.ok(text.includes('复核缺少来源版本'));
  assert.ok(text.includes('复核已过期'));
});

test('a review stale in both dimensions shows both reasons', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    draft_id: 'd2', review: '旧草稿的复核结论。', review_draft: 'd1',
    reviewStale: ['draft_changed', 'source_changed'],
    analysis: analysis('supported', 'a1'),
  }));
  const text = fullText(card);
  assert.ok(text.includes('草稿变了') && text.includes('来源变了'),
    'the UI distinguishes draft changes from source changes');
});

test('an empty draft verification shows the actual (empty) scope as a warning', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    draft_id: 'd1', recipient: 'client@example.test', body: '好的，已收到。',
    analysis: analysis('supported', 'a1'),
    claims: { target: 'draft', at: '2026-07-10T00:00:00Z', claims: [], error: null,
      draftId: 'd1', recipient: 'client@example.test', bodyHash: 'x', evidenceHash: 'y' },
  }));
  const text = fullText(card);
  assert.ok(text.includes('本次核查范围'), 'the actual scope is displayed');
  assert.ok(text.includes('未提取到声明'), 'the empty scope is named');
  assert.ok(text.includes('不能视为核查通过'), 'an empty scope is not treated as passed');
});

test('a non-empty verification lists the actual scope of checked claims', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    draft_id: 'd1', recipient: 'client@example.test', body: '我们保证周五交付。',
    analysis: analysis('supported', 'a1'),
    claims: { target: 'draft', at: '2026-07-10T00:00:00Z', error: null, draftId: 'd1',
      recipient: 'client@example.test', bodyHash: 'x', evidenceHash: 'y',
      claims: [{ id: '对外承诺', dimension: '对外承诺', text: '我们保证周五交付', status: 'supported',
        items: [], missing: '', rewrite: '', conflict: null, withdrawn: false, failedChecks: [] }] },
  }));
  const text = fullText(card);
  assert.ok(text.includes('本次核查范围'));
  assert.ok(text.includes('对外承诺：我们保证周五交付'), 'the checked claim text is listed as scope');
});

test('the current status shows an expired review instead of awaiting approval', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    draft_id: 'd1', recipient: 'client@example.test', body: '周五交付。',
    review: '已核实。', review_draft: 'd1', reviewStale: ['source_changed'],
    analysis: analysis('supported', 'a1'),
  }));
  const text = fullText(card);
  assert.ok(text.includes('复核已过期 · 来源变了'), 'approval status reflects the expired review');
  assert.ok(!text.includes('待批准'), 'an expired review does not show as awaiting approval');
});

test('a blocked send shows the block reason in the draft editor while the draft stays', () => {
  const { render, nodes } = harness();
  render({
    opportunities: [item({
      draft_id: 'd2', recipient: 'client@example.test', body: '第二版草稿（未核查）。',
    })], delegation: {},
    audit: [
      { id: 9, opportunity: 'o1', action: 'blocked', time: '2026-11-11T09:00:00.000Z',
        detail: JSON.stringify({ action: 'send', reason: 'claims_not_verified' }) },
      { id: 8, opportunity: 'o1', action: 'drafted', time: '2026-11-11T08:59:00.000Z',
        detail: JSON.stringify({ draftId: 'd2', recipient: 'client@example.test' }) },
    ],
  });
  const blocked = find(nodes, node => node.tag === 'p' && String(node.text).startsWith('操作被拦截 · 草稿声明尚未核查'));
  assert.ok(blocked, 'the draft editor shows the latest block reason on the spot');
  const draftBody = find(nodes, node => node.tag === 'textarea' && node.value === '第二版草稿（未核查）。');
  assert.ok(draftBody, 'the draft content is still present for editing');
});

// 「当前回答」：证据不足时怎么说、怎么继续。措辞由服务端 evidenceAnswer 决定，
// UI 只展示并把下一步接到卡片已有入口（查看来源 / 补资料 / 采用澄清问题，对应决策卡 view/source/draft）。
test('an insufficient answer names the confirmed part, the exact gap, and the next step', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    analysis: analysis('unknown', 'a1', { clarification: '客户是否有明确的签约意向？' }),
    answer: answer(),
  }));
  const text = fullText(card);
  assert.ok(text.includes('当前回答 · 证据不足 · 先说清缺口'), 'the situation is labeled');
  assert.ok(text.includes('已确认 · 客户表示想先看案例。'), 'what is confirmed is shown');
  assert.ok(text.includes('缺少 · 缺少客户明确的签约回复。'), 'the exact gap is shown');
  assert.ok(text.includes('下一步 · 可以先发案例并询问采购计划。'), 'an actionable next step is shown');
  for (const label of ['查看来源', '补资料', '采用澄清问题']) assert.ok(text.includes(label), 'action ' + label);
});

test('an insufficient answer without a clarification question does not offer that action', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    analysis: analysis('unknown', 'a1'),
    answer: answer(),
  }));
  const text = fullText(card);
  assert.ok(text.includes('查看来源') && text.includes('补资料'));
  assert.ok(!text.includes('采用澄清问题'), 'no clarification question means no adopt action');
});

test('a sufficient answer shows a bounded conclusion and points at the supporting source', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    analysis: analysis('supported', 'a1'),
    answer: answer({
      situation: 'sufficient',
      confirmed: '客户已明确表达签约意向。',
      missing: '合同是否签署仍待确认。',
      bounds: '合同是否签署仍待确认。',
      next: '可安排合同细节确认。',
      supporting: [{ id: 'S2', label: '客户回复' }],
    }),
  }));
  const text = fullText(card);
  assert.ok(text.includes('当前回答 · 证据充分 · 结论有边界'), 'the situation is labeled');
  assert.ok(text.includes('已确认 · 客户已明确表达签约意向。'), 'the confirmed part is shown');
  assert.ok(text.includes('仍缺 · 合同是否签署仍待确认。'), 'what is still missing is shown');
  assert.ok(text.includes('结论边界 · 合同是否签署仍待确认。'), 'the conclusion bound is shown');
  assert.ok(text.includes('依据来源 · 客户回复'), 'the new supporting source is pointed to');
});

test('a conflict answer lists the records to compare and withholds a conclusion', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    analysis: analysis('conflict', 'a1'),
    answer: answer({
      situation: 'conflict',
      confirmed: '',
      missing: '来源相互矛盾，先比较下列记录再下结论。',
      next: '请确认哪条记录为准。',
      compare: [
        { id: 'S1', label: '客户邮件', stance: 'supports', quote: '周五交付', text: '客户确认周五交付。' },
        { id: 'S2', label: '客户回复', stance: 'refutes', quote: '改为周二', text: '客户希望改为周二。' },
      ],
    }),
  }));
  const text = fullText(card);
  assert.ok(text.includes('当前回答 · 来源冲突 · 先比较记录'), 'the situation is labeled');
  assert.ok(text.includes('支持 · 客户邮件 · 周五交付'), 'the supporting record is listed');
  assert.ok(text.includes('反驳 · 客户回复 · 改为周二'), 'the opposing record is listed');
  assert.ok(!text.includes('结论有边界'), 'no sufficient conclusion is claimed');
});

test('a failed verification answer is retryable and its retry re-runs the analysis claims', () => {
  const { renderOne, nodes, requests, fullText } = harness();
  const card = renderOne(item({
    analysis: analysis('unknown', 'a1'),
    answer: answer({
      situation: 'failed',
      confirmed: '', missing: '', next: '模型核查失败，可重试（重新核查）。原文与来源记录不受本次失败影响。',
      retryable: true, incomplete: ['购买意向'],
    }),
  }));
  const text = fullText(card);
  assert.ok(text.includes('当前回答 · 核查失败 · 可重试'), 'the failed situation is labeled');
  assert.ok(text.includes('未完成核查 · 购买意向'), 'the incomplete claims are surfaced');
  const retry = nodes.find(node => node.tag === 'button' && node.text === '重新核查');
  assert.ok(retry, 'a retry action is offered');
  retry.click();
  assert.ok(requests.some(entry => entry.name === 'opportunity-claims'
    && entry.payload.target === 'analysis'), 'the retry re-runs the analysis-target verification');
});

test('the answer actions reuse the card entries: open sources, focus the source form, use the clarification question', () => {
  const { renderOne, nodes, fullText } = harness();
  renderOne(item({
    draft_id: 'd1', recipient: 'client@example.test', body: '草稿正文。',
    analysis: analysis('unknown', 'a1', { clarification: '客户是否有明确的签约意向？' }),
    answer: answer(),
  }));
  const sourceDetails = nodes.find(node => node.tag === 'details' && fullText(node).startsWith('来源 · '));
  assert.ok(sourceDetails, 'the source block exists');
  nodes.find(node => node.tag === 'button' && node.text === '查看来源').click();
  assert.equal(sourceDetails.open, true, 'view sources opens the source block');
  nodes.find(node => node.tag === 'button' && node.text === '补资料').click();
  assert.equal(sourceDetails.open, true, 'adding a source keeps the source block open');
  const sourceText = nodes.find(node => node.tag === 'textarea' && node.placeholder === '来源原文');
  assert.ok(sourceText, 'the source text input exists');
  nodes.find(node => node.tag === 'button' && node.text === '采用澄清问题').click();
  const body = nodes.find(node => node.tag === 'textarea' && node.placeholder === '邮件正文');
  assert.equal(body.value, '客户是否有明确的签约意向？', 'the clarification question fills the draft body');
});

test('an unanalyzed lead renders no answer block', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({}));
  assert.ok(!fullText(card).includes('当前回答'), 'no answer is claimed without an analysis');
});
