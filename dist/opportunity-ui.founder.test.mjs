import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityUI } from './opportunity-ui.js';

// 创始人自述与证据判定的界面覆盖（与 opportunity-ui.test.mjs 独立，避免并行修改冲突）：
// 1. founder_only 状态在声明旁显示「由创始人提供，待独立核实」，并给出补证/改写/复核出路；
// 2. neutral 引文立场显示「仅相关」；
// 3. 发送被拦（claims_founder_only）在草稿区显示拦截原因标签；
// 4. 来源区说明：客户来源/创始人提供标签由用户录入，证据状态按实际支持声明的引文判定；
// 5. 初始来源身份（客户原文／外部记录、创始人陈述、来源未确认）：出处块按记录身份显示，
//    可改判（请求 opportunity-evidence-kind）；unconfirmed 状态与 claims_unconfirmed 拦截标签；
//    客户来源引文支持的声明标注「客户来源支持」。
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
      // 模拟浏览器 details 的 toggle 事件：展开/收起时触发已绑定的监听。
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
  // 初始来源身份下拉：含 unconfirmed 选项的 select（来源块里的 customer/founder 下拉没有它）。
  const originSelect = () => nodes
    .find(node => node.tag === 'select' && (node.children ?? []).some(option => option.value === 'unconfirmed'));
  const button = label => nodes.find(node => node.tag === 'button' && node.text === label);
  return { renderOne, allText, requests, originSelect, button };
}

const item = {
  id: 'o1', kind: 'lead', title: '签约线索', source: '客户线程', evidence: '客户询问了报价和交付周期。',
  evidence_kind: 'founder',
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

test('the origin block labels the recorded initial source identity and offers the re-identification control', () => {
  const { renderOne, allText, requests, originSelect, button } = harness();
  renderOne(item);
  const text = allText();
  assert.ok(text.includes('出处') && text.includes('创始人陈述') && text.includes('客户线程'),
    'the origin summary shows the recorded founder identity and the source name');
  assert.ok(text.includes('来源未确认') && text.includes('客户原文／外部记录'),
    'the identity options list all three recorded identities');
  const select = originSelect();
  assert.ok(select, 'the origin identity select is rendered');
  assert.equal(select.children.find(option => option.selected)?.value, 'founder', 'the recorded identity is preselected');
  select.value = 'customer';
  button('确认来源身份').onclick();
  assert.equal(requests.length, 1, 'changing the identity sends the re-identification request');
  assert.equal(requests[0].name, 'opportunity-evidence-kind');
  assert.equal(requests[0].data.id, 'o1');
  assert.equal(requests[0].data.evidence_kind, 'customer');
});

test('a legacy record without a recorded identity shows 来源未确认 and no request when unchanged', () => {
  const { renderOne, allText, requests, originSelect, button } = harness();
  const legacy = { ...item };
  delete legacy.evidence_kind;
  renderOne(legacy);
  assert.ok(allText().includes('出处') && allText().includes('来源未确认'),
    'a record without evidence_kind is shown as 来源未确认');
  originSelect().value = 'unconfirmed';
  button('确认来源身份').onclick();
  assert.equal(requests.length, 0, 'no request when the identity is unchanged');
});

test('an unconfirmed-source claim shows the pending-verification label without the customer-support annotation', () => {
  const { renderOne, allText } = harness();
  renderOne({ ...item, claims: { ...item.claims, claims: [{
    ...item.claims.claims[0], status: 'unconfirmed',
    items: [{
      valid: true, stance: 'supports', quote: '客户已签约', note: '身份未确认的来源只能按其所写支持声明',
      source: { id: 'E1', source: '客户线程', date: null, kind: 'unconfirmed', text: '客户已签约。' },
    }],
  }] } });
  const text = allText();
  assert.ok(text.includes('来源未确认，待核实'), 'the unconfirmed status is labelled beside the claim');
  assert.ok(text.includes('请先确认这段来源的身份') && text.includes('人工复核结论'),
    'the unconfirmed hint offers confirmation, independent evidence, rewrite, and review paths');
  assert.ok(!text.includes('客户来源支持'), 'an unconfirmed quote never gets the customer-support annotation');
});

test('a customer-supported claim is annotated with the recorded customer-source support', () => {
  const { renderOne, allText } = harness();
  renderOne({ ...item, claims: { ...item.claims, claims: [{
    ...item.claims.claims[0], status: 'supported',
    items: [{
      valid: true, stance: 'supports', quote: '合同已签署', note: '客户记录陈述了签署事实',
      source: { id: 'S2', source: '客户邮件', date: null, kind: 'customer', text: '合同已签署。' },
    }],
  }] } });
  assert.ok(allText().includes('支持 · 客户来源支持'),
    'the supported claim is annotated with 客户来源支持 from the recorded quote identity');
});

test('a blocked unconfirmed-source send shows the block reason label in the draft area', () => {
  const { renderOne, allText } = harness();
  const audit = [{ id: 9, opportunity: 'o1', action: 'blocked', time: '2026-11-11T00:00:00Z',
    detail: JSON.stringify({ action: 'send', reason: 'claims_unconfirmed' }) }];
  renderOne(item, audit);
  assert.ok(allText().includes('操作被拦截') && allText().includes('声明来源未确认'),
    'the audit block reason gets a label next to the draft');
});
