import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityUI } from './opportunity-ui.js';

// 创始人自述与证据判定的界面覆盖（与 opportunity-ui.test.mjs 独立，避免并行修改冲突）：
// 1. founder_only 状态在声明旁显示「由创始人提供，待独立核实」，并给出补证/改写/复核出路；
// 2. neutral 引文立场显示「仅相关」；
// 3. 发送被拦（claims_founder_only）在草稿区显示拦截原因标签；
// 4. 来源区说明：客户来源/创始人提供标签由用户录入，证据状态按实际支持声明的引文判定。
function harness() {
  const nodes = [];
  const element = (tag, text = '') => {
    const node = { tag, text, children: [],
      append(...kids) { this.children.push(...kids); },
      replaceChildren(...kids) { this.children = [...kids]; },
      setAttribute() {}, reportValidity() { return true; },
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
  const render = createOpportunityUI({
    get, t: key => key, element, action,
    request: async () => {}, formAction: () => {}, language: () => 'zh-CN', createTask: () => {},
  });
  const allText = () => {
    const walk = node => (node.text ?? '') + ' ' + (node.children ?? []).map(walk).join(' ');
    return nodes.map(walk).join(' ');
  };
  const renderOne = (entry, audit = []) => render({ opportunities: [entry], delegation: {}, audit });
  return { renderOne, allText };
}

const item = {
  id: 'o1', kind: 'lead', title: '签约线索', source: '客户线程', evidence: '客户询问了报价和交付周期。',
  analysis: null, review: null, review_draft: null, reviewStale: null,
  draft_id: 'd1', recipient: 'client@example.test', body: '合同已签署。', sent: 0,
  sources: [
    { id: 1, name: '创始人记录', date: null, kind: 'founder', text: '客户已签约，合同生效。' },
    { id: 2, name: '客户邮件', date: null, kind: 'customer', text: '我们愿意签约，期待合作。' },
  ],
  claims: {
    target: 'draft', at: '2026-11-11T00:00:00Z', error: null,
    claims: [{
      id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'founder_only', withdrawn: false,
      items: [
        { valid: true, stance: 'supports', quote: '客户已签约', note: '创始人陈述已完成事实',
          source: { id: 'S1', source: '创始人记录', date: null, kind: 'founder', text: '客户已签约，合同生效。' } },
        { valid: true, stance: 'neutral', quote: '我们愿意签约', note: '只表达意愿，未陈述已签署',
          source: { id: 'S2', source: '客户邮件', date: null, kind: 'customer', text: '我们愿意签约，期待合作。' } },
      ],
      conflict: null, missing: '', rewrite: '', failedChecks: [],
    }],
  },
  claimsStale: false,
};

test('a founder-only claim shows the pending-independent-verification label with a resolution hint', () => {
  const { renderOne, allText } = harness();
  renderOne(item);
  const text = allText();
  assert.ok(text.includes('由创始人提供，待独立核实'), 'the founder_only status is labelled beside the claim');
  assert.ok(text.includes('仅相关'), 'the neutral stance is labelled');
  assert.ok(text.includes('补入独立来源') && text.includes('改写为有依据的说法')
    && text.includes('人工复核结论'), 'the claim offers the three resolution paths');
});

test('a blocked founder-only send shows the block reason label in the draft area', () => {
  const { renderOne, allText } = harness();
  const audit = [{ id: 9, opportunity: 'o1', action: 'blocked', time: '2026-11-11T00:00:00Z',
    detail: JSON.stringify({ action: 'send', reason: 'claims_founder_only' }) }];
  renderOne(item, audit);
  const text = allText();
  assert.ok(text.includes('操作被拦截') && text.includes('声明仅由创始人提供'),
    'the audit block reason gets a label next to the draft');
});

test('the source area states that source kind labels are user-entered', () => {
  const { renderOne, allText } = harness();
  renderOne(item);
  assert.ok(allText().includes('由你录入') && allText().includes('实际支持该声明的引文'),
    'the UI says the customer/founder label is user-entered and evidence state follows the supporting quotes');
});
