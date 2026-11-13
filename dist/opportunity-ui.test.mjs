import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityUI } from './opportunity-ui.js';

// 用最小假 DOM 驱动真实 UI 模块，断言人工复核表单的行为：
// 表单提交的结论必须绑定当前草稿版本；旧草稿上的复核失效后表单重新出现。
function harness() {
  const nodes = [];
  const element = (tag, text = '') => {
    const node = { tag, text, children: [], open: false, listeners: {},
      get textContent() { return this.text; },
      set textContent(value) { this.text = value; },
      append(...kids) { this.children.push(...kids); },
      replaceChildren(...kids) { this.children = [...kids]; },
      setAttribute(name, value) { this.attributes ??= {}; this.attributes[name] = value; },
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
    button.click = () => button.onclick();
    return button;
  };
  const elements = new Map();
  const get = id => elements.get(id) ?? (elements.set(id, element('div', '')), elements.get(id));
  const requests = [];
  const views = [];
  const render = createOpportunityUI({
    get, t: key => key, element, action,
    request: async (name, payload) => { requests.push({ name, payload }); },
    viewSource: async (id, sourceId) => { views.push({ id, sourceId }); },
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
  // 按 summary 文案定位可展开的 details（来源原文块、冲突来源块）。
  const detailsWith = summary => nodes.find(node =>
    node.tag === 'details' && (node.children ?? [])[0]?.text === summary);
  const auditPanel = () => elements.get('opportunity-audit');
  const auditText = () => fullText(auditPanel());
  return { render, nodes, renderOne, requests, views, reviewButton, reviewTextarea,
    submitReview, fullText, detailsWith, auditPanel, auditText };
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
  retryable: false, compare: [], supporting: [], pending: [], incomplete: [],
  ...overrides,
});
const item = overrides => ({
  id: 'o1', kind: 'lead', title: '客户线索', source: '客户邮件', evidence: '客户表示希望周五交付。',
  analysis: null, review: null, review_draft: null, draft_id: null,
  recipient: null, body: null, sent: 0, sources: [], claims: null, claimsStale: null,
  reviewStale: null, reviewViewed: { draftId: null, evidence: '', viewed: [] },
  ...overrides,
});
const sourceRow = (id, name, kind = 'customer', date = null, text = '原文。') =>
  ({ id, name, kind, date, text });

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

test('a blocked send for an uncovered high-risk clause names the gate reason in the draft editor', () => {
  const { render, nodes } = harness();
  render({
    opportunities: [item({
      draft_id: 'd1', recipient: 'client@example.test',
      body: '我们承诺下周五前完成交付，并在两周内完成上线。',
      analysis: analysis('supported', 'a1'),
      claims: { target: 'draft', at: '2026-07-10T00:00:00Z', error: null, draftId: 'd1',
        recipient: 'client@example.test', bodyHash: 'x', evidenceHash: 'y',
        warnings: [],
        draftChecks: { placeholders: [], unextracted: ['在两周内完成上线'] },
        claims: [{ id: '对外承诺', dimension: '对外承诺', text: '下周五前完成交付', status: 'supported',
          items: [], missing: '', rewrite: '', conflict: null, withdrawn: false, failedChecks: [] }] },
    })], delegation: {},
    audit: [{ id: 9, opportunity: 'o1', action: 'blocked', time: '2026-11-11T09:00:00.000Z',
      detail: JSON.stringify({ action: 'send', reason: 'claims_uncovered',
        placeholders: [], uncovered: ['在两周内完成上线'] }) }],
  });
  const blocked = find(nodes, node => node.tag === 'p' && String(node.text).startsWith('操作被拦截 · 高风险句未被覆盖'));
  assert.ok(blocked, 'the draft editor names the uncovered high-risk clause gate reason on the spot');
});

// 人工复核来源记录：复核区显示「已展开哪些来源 / 尚未展开来源」，展开来源原文时
// 记录来源 ID（服务端权威），草稿或来源变化后新复核从空的查看状态开始。

test('the review area shows that no source has been opened yet', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    sources: [sourceRow(1, '客户邮件')],
  }));
  const text = fullText(card);
  assert.ok(text.includes('尚未打开来源'), 'the review area names the empty viewing state');
  assert.ok(text.includes('展开来源原文会记录下来，保存复核时随结论写入审计。'),
    'the form explains that opened sources are recorded with the conclusion');
});

test('expanding a source records its ID and updates the review area live', () => {
  const { renderOne, fullText, views, detailsWith } = harness();
  const card = renderOne(item({
    sources: [sourceRow(1, '客户邮件', 'customer', '2026-07-01', '客户确认周五交付。'),
      sourceRow(2, '创始人笔记', 'founder', null, '创始人记得周五已答应客户。')],
  }));
  const s1 = detailsWith('客户记录 · 2026-07-01 · 客户邮件');
  assert.ok(s1, 'the source details are expandable');
  s1.openToggle(true);
  assert.deepEqual(views, [{ id: 'o1', sourceId: 'S1' }], 'the view action is sent with the source ID');
  assert.ok(fullText(card).includes('已打开 · 客户邮件'), 'the review area lists the opened source');
  assert.ok(!fullText(card).includes('尚未打开来源'), 'the empty-state label goes away once a source is opened');
  // 引文摘录（不展示来源原文）不计为展开来源；重复展开不重复发送。
  s1.openToggle(true);
  assert.equal(views.length, 1);
});

test('the conflict source block also counts as opening that source', () => {
  const { renderOne, fullText, views, detailsWith } = harness();
  renderOne(item({
    sources: [sourceRow(1, '客户邮件'), sourceRow(2, '撤回邮件', 'customer', '2026-07-10', '撤回此前承诺。')],
    claims: { target: 'draft', at: '2026-07-10T00:00:00Z', error: null, draftId: 'd1',
      recipient: 'client@example.test', bodyHash: 'x', evidenceHash: 'y',
      claims: [{ id: '对外承诺', dimension: '对外承诺', text: '我们保证周五交付', status: 'conflict',
        items: [{ evidenceId: 'S1', stance: 'supports', quote: '确认', note: 'n', revises: [],
          source: { id: 'S1', source: '客户邮件', date: null, kind: 'customer', text: '确认周五。' }, valid: true, reasons: [] }],
        missing: '', rewrite: '', withdrawn: false, failedChecks: [],
        conflict: {
          supports: [{ evidenceId: 'S1', stance: 'supports', quote: '确认', note: 'n', revises: [],
            source: { id: 'S1', source: '客户邮件', date: null, kind: 'customer', text: '确认周五。' }, valid: true, reasons: [] }],
          opposes: [{ evidenceId: 'S2', stance: 'refutes', quote: '撤回', note: 'n', revises: [],
            source: { id: 'S2', source: '撤回邮件', date: '2026-07-10', kind: 'customer', text: '撤回此前承诺。' }, valid: true, reasons: [] }],
        } }] },
  }));
  const block = detailsWith('反驳 · 撤回邮件 · 2026-07-10');
  assert.ok(block, 'the conflict entry shows the source original');
  assert.ok(block.children.some(kid => kid.tag === 'p' && String(kid.text).includes('来源原文')));
  block.openToggle(true);
  assert.deepEqual(views, [{ id: 'o1', sourceId: 'S2' }]);
});

test('a viewing state from the server is restored after a re-render', () => {
  const { renderOne, detailsWith, fullText } = harness();
  const entry = () => item({
    sources: [sourceRow(1, '客户邮件')],
    reviewViewed: { draftId: 'd1', evidence: 'e1', viewed: ['S1'] },
  });
  renderOne(entry());
  const first = detailsWith('客户记录 · 客户邮件');
  assert.equal(first?.open, true, 'an already-opened source stays open across renders');
  const card = renderOne(entry());
  assert.ok(fullText(card).includes('已打开 · 客户邮件'), 'the opened source is still listed after a re-render');
});

test('a new draft starts a fresh viewing state; the old record stays in the audit', () => {
  const { render, auditText } = harness();
  render({
    opportunities: [item({
      draft_id: 'd1', sources: [sourceRow(1, '客户邮件')],
      reviewViewed: { draftId: 'd1', evidence: 'e1', viewed: ['S1'] },
    })], delegation: {},
    audit: [{ id: 9, opportunity: 'o1', action: 'human_reviewed', time: '2026-11-11T09:00:00.000Z',
      detail: JSON.stringify({ analysisId: null, draftId: 'd1', evidence: 'e1', viewed: ['S1'],
        viewedNames: ['客户邮件'], resolution: '已核对。' }) }],
  });
  assert.ok(auditText().includes('已打开 · 客户邮件'), 'the audit names the sources the review had opened');
  render({
    opportunities: [item({
      draft_id: 'd2', sources: [sourceRow(1, '客户邮件')],
      reviewViewed: { draftId: 'd2', evidence: 'e2', viewed: [] },
    })], delegation: {},
    audit: [{ id: 10, opportunity: 'o1', action: 'human_reviewed', time: '2026-11-11T09:30:00.000Z',
      detail: JSON.stringify({ analysisId: null, draftId: 'd2', evidence: 'e2', viewed: [],
        viewedNames: [], resolution: '重新核对新草稿。' }) }],
  });
  assert.ok(auditText().includes('尚未打开来源'), 'the fresh review is shown without the stale viewing record');
  assert.ok(!auditText().includes('已打开 · 客户邮件'), 'old opened sources are not carried into the new review');
});

test('the audit lists each opened-source action and a review with no opened sources', () => {
  const { render, auditText, auditPanel } = harness();
  render({
    opportunities: [item({})], delegation: {},
    audit: [
      { id: 5, opportunity: 'o1', action: 'human_reviewed', time: '2026-11-11T09:30:00.000Z',
        detail: JSON.stringify({ analysisId: null, draftId: 'd1', evidence: 'e1', viewed: [],
          viewedNames: [], resolution: '未展开来源直接复核。' }) },
      { id: 4, opportunity: 'o1', action: 'review_source_viewed', time: '2026-11-11T09:20:00.000Z',
        detail: JSON.stringify({ sourceId: 'S1', name: '客户邮件', kind: 'customer', draftId: 'd1', evidence: 'e1' }) },
      { id: 3, opportunity: 'o1', action: 'human_reviewed', time: '2026-11-11T09:00:00.000Z',
        detail: JSON.stringify({ analysisId: null, draftId: 'd0', evidence: 'e0', viewed: ['S1', 'E1'],
          viewedNames: ['客户邮件', '客户邮件'], resolution: '已展开 S1 与证据原文。' }) },
      { id: 2, opportunity: 'o1', action: 'human_reviewed', time: '2026-11-11T08:00:00.000Z',
        detail: JSON.stringify({ analysisId: null, draftId: 'd0', evidence: 'e0', resolution: '旧记录（无查看状态字段）。' }) },
    ],
  });
  const text = auditText();
  assert.ok(text.includes('尚未打开来源'), 'a review without opened sources says so');
  assert.ok(text.includes('已打开 · 客户邮件、客户邮件'), 'a review lists the sources it had opened');
  assert.ok(text.includes('展开来源原文 · 客户邮件'), 'each opened-source action is auditable');
  // 功能上线前的旧记录没有 viewed 字段：只有一条（id 5）被标注「尚未打开来源」。
  const emptyNotes = [];
  const walk = node => {
    if (node.tag === 'p' && node.text === '尚未打开来源') emptyNotes.push(node);
    (node.children ?? []).forEach(walk);
  };
  (auditPanel().children ?? []).forEach(walk);
  assert.equal(emptyNotes.length, 1, 'legacy review rows without a viewing state are not mislabeled');
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

test('the answer lists founder-only and unconfirmed claims as pending verification alongside the confirmed part', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    analysis: analysis('supported', 'a1'),
    answer: answer({
      situation: 'sufficient',
      confirmed: '客户已明确表达签约意向。',
      missing: '',
      bounds: '签约状态：合同已签署（仅创始人陈述，待独立核实）',
      next: '可安排合同细节确认。',
      supporting: [{ id: 'S2', label: '客户回复' }],
      pending: [
        { dimension: '签约状态', text: '合同已签署', status: 'founder_only' },
        { dimension: '公司业绩', text: '业绩翻番', status: 'unconfirmed' },
      ],
    }),
  }));
  const text = fullText(card);
  assert.ok(text.includes('已确认 · 客户已明确表达签约意向。'), 'the confirmed intent is shown');
  assert.ok(text.includes('待核实 · 签约状态：合同已签署（由创始人提供，待独立核实）；公司业绩：业绩翻番（来源未确认，待核实）'),
    'founder-only and unconfirmed claims are listed as pending items');
  assert.ok(text.includes('结论边界 · 签约状态：合同已签署（仅创始人陈述，待独立核实）'), 'the bound names the pending step');
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

// 待处理项：声明全部 supported 之后，草稿里仍可能留着占位符或未被抽取的高风险句
// （一句里有两项承诺、模型只抽到一项）。它们要在卡片顶部明确显示「仍有待处理项」，
// 当前状态不能显示「待批准」。

test('a draft review with pending items surfaces them at the top and withholds awaiting-approval', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    draft_id: 'd1', recipient: 'client@example.test', body: '我们承诺下周五前完成交付，并在两周内完成上线。',
    analysis: analysis('supported', 'a1'),
    claims: { target: 'draft', at: '2026-07-10T00:00:00Z', error: null, draftId: 'd1',
      recipient: 'client@example.test', bodyHash: 'x', evidenceHash: 'y',
      warnings: [],
      draftChecks: { placeholders: ['[待确认：金额]'], unextracted: ['在两周内完成上线'] },
      claims: [{ id: '对外承诺', dimension: '对外承诺', text: '下周五前完成交付', status: 'supported',
        items: [], missing: '', rewrite: '', conflict: null, withdrawn: false, failedChecks: [] }] },
  }));
  const text = fullText(card);
  assert.ok(text.includes('仍有待处理项 · 2'), 'the pending count is named at the top of the card');
  assert.ok(text.includes('未被抽取的高风险句 · 在两周内完成上线'), 'the unextracted clause is listed');
  assert.ok(text.includes('占位符未处理 · [待确认：金额]'), 'the placeholder is listed');
  assert.ok(text.includes('当前状态 · 仍有待处理项 · 2'), 'the status line says pending items remain, with the count');
  assert.ok(!text.includes('当前状态 · 待批准'), 'pending items are not shown as awaiting approval');
});

test('a clean draft review without pending items stays awaiting approval', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    draft_id: 'd1', recipient: 'client@example.test', body: '我们下周五前完成交付。',
    analysis: analysis('supported', 'a1'),
    claims: { target: 'draft', at: '2026-07-10T00:00:00Z', error: null, draftId: 'd1',
      recipient: 'client@example.test', bodyHash: 'x', evidenceHash: 'y',
      warnings: [],
      draftChecks: { placeholders: [], unextracted: [] },
      claims: [{ id: '对外承诺', dimension: '对外承诺', text: '下周五前完成交付', status: 'supported',
        items: [], missing: '', rewrite: '', conflict: null, withdrawn: false, failedChecks: [] }] },
  }));
  const text = fullText(card);
  assert.ok(text.includes('当前状态 · 待批准'), 'no pending items means awaiting approval');
  assert.ok(!text.includes('仍有待处理项'), 'the pending label does not appear');
});

test('an earlier flagged statement remains visible and can be guaranteed on the current draft', async () => {
  const { renderOne, fullText, requests } = harness();
  const card = renderOne(item({
    draft_id: 'd2', recipient: 'client@example.test', body: '您好。合同已签署。',
    review: '整体复核结论', review_draft: 'd2', claimEvidenceHash: 'current-evidence',
    previousUnresolvedClaims: [{ id: 'signing', text: '合同已签署', status: 'unknown', dimension: '签约状态' }],
  }));
  assert.match(fullText(card), /上一版仍有未处理声明/);
  assert.match(fullText(card), /合同已签署/);
  assert.equal(find([card], node => node.text === '批准已保存版本并模拟发送'), null);
  const reason = find([card], node => node.placeholder === '记录担保理由');
  reason.value = '已核对新草稿和当前来源。';
  await find([card], node => node.text === '我已核实并愿意承担这条说法').click();
  assert.deepEqual(requests.at(-1), { name: 'opportunity-claim-resolution', payload: {
    id: 'o1', draft_id: 'd2', claim_id: 'signing', text: '合同已签署',
    reason: reason.value, evidence_hash: 'current-evidence',
  } });
});

test('the saved draft shows the restricted excerpt and hides approval for an unauthorized recipient', () => {
  const { renderOne, fullText } = harness();
  const card = renderOne(item({
    draft_id: 'd2', recipient: 'b@example.test', body: '报价为人民币八万元。',
    review: '已人工复核', review_draft: 'd2',
    disclosureConflicts: [{ sourceName: '客户 A 报价', excerpt: '报价为人民币八万元。' }],
  }));
  assert.match(fullText(card), /客户 A 报价 · b@example.test · 报价为人民币八万元。/);
  assert.match(fullText(card), /当前收件人无权收到草稿中的受限内容/);
  assert.equal(find([card], node => node.text === '批准已保存版本并模拟发送'), null);
});
