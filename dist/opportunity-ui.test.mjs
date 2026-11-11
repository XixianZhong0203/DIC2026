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
  const renderOne = entry => render({ opportunities: [entry], delegation: {}, audit: [] });
  return { renderOne, render, nodes, requests, reviewButton, reviewTextarea, submitReview };
}

function find(nodes, predicate) {
  for (const node of nodes) {
    if (predicate(node)) return node;
    const hit = find(node.children ?? [], predicate);
    if (hit) return hit;
  }
  return null;
}

const analysis = (status, analysisId) => JSON.stringify({
  status, analysisId, quote: '客户表示希望周五交付。', reason: 'explicit', unknown: '',
  conflict: '', clarification: '', suggestedReply: '', raw: '',
});
const item = overrides => ({
  id: 'o1', kind: 'lead', title: '客户线索', source: '客户邮件', evidence: '客户表示希望周五交付。',
  analysis: null, review: null, review_draft: null, draft_id: null,
  recipient: null, body: null, sent: 0, sources: [], claims: null, claimsStale: null,
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
