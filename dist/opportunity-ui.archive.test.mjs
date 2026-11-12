import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityUI } from './opportunity-ui.js';
import { buildSendArchive } from '../src/opportunity/archive.mjs';

// 发送档案窗口：用最小假 DOM 驱动真实 UI 模块，断言档案块的三档来源展示、
// 批准上下文、查看记录与导出链接；冻结动作只发请求，档案由服务端构建。
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
  const fullText = node => (node.text ?? '') + (node.children ?? []).map(fullText).join(' ');
  const renderOne = entry => {
    render({ opportunities: [entry], delegation: {}, audit: [] });
    return elements.get('opportunity-list').children.at(-1);
  };
  const find = (root, predicate) => {
    if (predicate(root)) return root;
    for (const child of root.children ?? []) {
      const hit = find(child, predicate);
      if (hit) return hit;
    }
    return null;
  };
  const findAll = (root, predicate) => {
    const found = predicate(root) ? [root] : [];
    return [...found, ...(root.children ?? []).flatMap(child => findAll(child, predicate))];
  };
  return { nodes, render, renderOne, requests, fullText, find, findAll, get };
}

// 用真实构建器造档案：E1（客户原文）+ S1（客户确认邮件）；
// 回答明指 S1，声明的支持引文也在 S1，查看记录展开过 S1。
function makeArchive(overrides = {}) {
  return buildSendArchive({
    opportunity: { id: 'o1', kind: 'lead', title: '客户线索', source: '客户邮件',
      evidence: '客户表示希望周五交付。', evidence_kind: 'customer', recipient: 'client@example.test',
      body: '我们确认周五交付。', draft_id: 'd1', sent: 1 },
    sourceRows: [{ id: 1, name: '客户确认邮件', date: '2026-07-10', kind: 'customer', text: '客户确认周五交付。' }],
    claims: { target: 'draft', at: '2026-07-11T00:00:00Z', error: null, draftId: 'd1',
      recipient: 'client@example.test', bodyHash: 'x', evidenceHash: 'y',
      claims: [{ id: '对外承诺', dimension: '对外承诺', text: '我们确认周五交付', status: 'supported',
        items: [{ evidenceId: 'S1', stance: 'supports', quote: '客户确认周五交付', note: '客户确认',
          revises: [], valid: true, reasons: [],
          source: { id: 'S1', source: '客户确认邮件', date: '2026-07-10', kind: 'customer', text: '客户确认周五交付。' } }],
        missing: '', rewrite: '' }] },
    analysis: { analysisId: 'a1', status: 'supported', quote: '客户表示希望周五交付。', reason: 'explicit' },
    answer: { situation: 'sufficient', confirmed: '客户确认周五交付。', missing: '', bounds: '', next: '',
      retryable: false, compare: [], supporting: [{ id: 'S1', label: '客户确认邮件' }], incomplete: [] },
    reviewViewed: { draftId: 'd1', evidence: 'e1', viewed: ['S1'] },
    viewingTrail: [{ sourceId: 'S1', name: '客户确认邮件', kind: 'customer', draftId: 'd1', evidence: 'e1',
      time: '2026-07-11T09:00:00.000Z' }],
    model: 'test double', effort: null,
    prompts: { claims: 'claims-v1', analysis: 'analysis-v1' },
    approval: { draftId: 'd1', recipient: 'client@example.test', body: '我们确认周五交付。', bodyHash: 'h',
      mode: 'approval', basis: 'model_supported', resolution: null,
      sentAt: '2026-07-11T10:00:00.000Z', sent: true },
    ...overrides,
  });
}

const item = overrides => ({
  id: 'o1', kind: 'lead', title: '客户线索', source: '客户邮件', evidence: '客户表示希望周五交付。',
  analysis: null, review: null, review_draft: null, draft_id: null,
  recipient: null, body: null, sent: 0, sources: [], claims: null, claimsStale: null,
  reviewStale: null, reviewViewed: { draftId: null, evidence: '', viewed: [] },
  ...overrides,
});

test('the archive block renders the three source tiers from the stored snapshot', () => {
  const { renderOne, fullText } = harness();
  const arch = makeArchive();
  const card = renderOne(item({ archives: [arch] }));
  const text = fullText(card);
  assert.ok(text.includes('发送档案 · 1'), 'the block names the archive count');
  // 第一档：提供给模型的来源 = 核查输入全集（快照全部 ID，含全文）。
  assert.ok(text.includes('提供给模型的来源 · 2'), 'tier 1 counts every source of the verification input');
  assert.ok(text.includes('E1 · 客户邮件 · 客户记录'), 'tier 1 names the initial source entry');
  assert.ok(text.includes('S1 · 客户确认邮件 · 客户记录 · 2026-07-10'), 'tier 1 names the added source entry');
  assert.ok(text.includes('客户确认周五交付。'), 'tier 1 keeps the full source text from the snapshot');
  // 第二档：回答引用的来源 = 分析引文所出（E1）+ 结构化回答明指（S1）。
  assert.ok(text.includes('回答引用的来源 · 2'), 'tier 2 lists the sources the answer points to');
  // 第三档：核查判定支持该声明的来源（逐条声明 + 支持引文 + 逐条担保理由）。
  assert.ok(text.includes('核查判定支持该声明的来源'), 'tier 3 names the verification-support tier');
  assert.ok(text.includes('对外承诺 · 我们确认周五交付 · 支持'), 'tier 3 names the claim and its verdict');
  assert.ok(text.includes('S1 · 客户确认邮件 · 客户确认周五交付'), 'tier 3 names the supporting source of the claim');
  assert.ok(text.includes('逐条担保理由'), 'the per-claim justification section is listed');
  assert.ok(text.includes('支持 · S1'), 'each justification item shows stance and evidence id');
});

test('the archive entry shows the approval context, the viewing record, and the export link', () => {
  const { renderOne, fullText, find } = harness();
  const arch = makeArchive();
  const card = renderOne(item({ archives: [arch] }));
  const text = fullText(card);
  assert.ok(text.includes('批准依据 · 声明核查通过'), 'the approval basis is named');
  assert.ok(text.includes('收件人 · client@example.test'), 'the approved recipient is named');
  assert.ok(text.includes('草稿正文'), 'the draft body is embedded');
  assert.ok(text.includes('已发送'), 'the sent state is named');
  assert.ok(text.includes('核查模型 · test double'), 'the verification model is recorded');
  assert.ok(text.includes('提示版本 · claims-v1 / analysis-v1'), 'the prompt versions are recorded');
  assert.ok(text.includes('查看记录 · 已展开来源 · 客户确认邮件'), 'the viewing record is named');
  const link = find(card, node => node.tag === 'a');
  assert.ok(link, 'an export link is rendered');
  assert.equal(link.href, '/api/opportunity-archive/' + arch.archiveId, 'the link targets the stored archive');
  assert.equal(link.download, 'daymark-send-archive-' + arch.archiveId + '.json', 'the download name names the archive');
});

test('an item without archives names the empty state and the freeze action sends the freeze request', () => {
  const { renderOne, fullText, requests, find } = harness();
  const card = renderOne(item({}));
  assert.ok(fullText(card).includes('还没有发送档案'), 'the empty state is named');
  const freeze = find(card, node => node.tag === 'button' && node.text === '冻结当前状态为发送档案');
  assert.ok(freeze, 'the freeze action is offered');
  freeze.click();
  assert.deepEqual(requests, [{ name: 'opportunity-archive', payload: { id: 'o1' } }],
    'freezing only sends the request; the server builds the archive');
});

test('each frozen archive renders separately with its own basis and export link', () => {
  const { renderOne, fullText, findAll } = harness();
  const pending = makeArchive({
    approval: { draftId: 'd1', recipient: 'client@example.test', body: '我们确认周五交付。', bodyHash: 'h',
      mode: 'approval', basis: 'pending', resolution: null,
      sentAt: '2026-07-11T09:00:00.000Z', sent: false },
  });
  const sent = makeArchive();
  assert.notEqual(pending.archiveId, sent.archiveId);
  const card = renderOne(item({ archives: [pending, sent] }));
  const text = fullText(card);
  assert.ok(text.includes('发送档案 · 2'), 'both archives are counted');
  assert.ok(text.includes('批准依据 · 未达发送门槛'), 'the unsent archive is labeled by its gate state');
  assert.ok(text.includes('批准依据 · 声明核查通过'), 'the sent archive is labeled by its approval basis');
  const links = findAll(card, node => node.tag === 'a');
  assert.equal(links.length, 2, 'each archive has its own export link');
  const hrefs = new Set(links.map(link => link.href));
  assert.ok(hrefs.has('/api/opportunity-archive/' + pending.archiveId));
  assert.ok(hrefs.has('/api/opportunity-archive/' + sent.archiveId));
});
