import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityUI } from './opportunity-ui.js';
import { buildSendArchive } from '../src/opportunity/archive.mjs';

// Send archive window: drive the real UI module with a minimal fake DOM, assert the three-tier source
// display of the archive block, approval context, viewing history, and export links; the freeze action
// only sends requests, and the archive is built by the server.
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

// Build archives using the real builder: E1 (customer original text) + S1 (customer confirmation email);
// the answer explicitly refers to S1, the supporting citation for the claim is also in S1, and the viewing
// history has expanded S1.
function makeArchive(overrides = {}) {
  return buildSendArchive({
    opportunity: { id: 'o1', kind: 'lead', title: '客户线索', source: '客户邮件',
      evidence: '客户表示希望周五交付。', evidence_kind: 'customer', recipient: 'client@example.test',
      body: '我们确认周五交付。', draft_id: 'd1', sent: 1 },
    sourceRows: [{ id: 1, name: '客户确认邮件', date: '2026-07-10', kind: 'customer', text: '客户确认周五交付。' }],
    // Verification configuration is recorded in the verification log (the actual configuration persisted
    // at verification time), and the builder no longer receives it from ctx.
    claims: { target: 'draft', at: '2026-07-11T00:00:00Z', error: null, draftId: 'd1',
      recipient: 'client@example.test', bodyHash: 'x', evidenceHash: 'y',
      model: 'test double', effort: null,
      prompts: { claims: 'claims-v1', analysis: 'analysis-v1' },
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
  // First tier: sources provided to the model = full set of verification inputs (snapshot of all IDs,
  // including full text).
  assert.ok(text.includes('提供给模型的来源 · 2'), 'tier 1 counts every source of the verification input');
  assert.ok(text.includes('E1 · 客户邮件 · 客户记录'), 'tier 1 names the initial source entry');
  assert.ok(text.includes('S1 · 客户确认邮件 · 客户记录 · 2026-07-10'), 'tier 1 names the added source entry');
  assert.ok(text.includes('客户确认周五交付。'), 'tier 1 keeps the full source text from the snapshot');
  // Second tier: sources cited by the answer = analytical citation source (E1) + structured answer
  // explicit reference (S1).
  assert.ok(text.includes('回答引用的来源 · 2'), 'tier 2 lists the sources the answer points to');
  // Third tier: sources determined by verification to support the claim = per-claim + supporting citation
  // + per-claim guarantee reason.
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
  assert.ok(text.includes('思考档位 · 端点默认'), 'the recorded endpoint-default tier is named');
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

test('an archive from a check record without config fields shows 未记录, and integrity lines render by status', () => {
  const { renderOne, fullText } = harness();
  const legacy = makeArchive({
    // Old verification logs lack configuration fields: the builder cannot backfill them, and verification
    // is entirely null.
    claims: { target: 'draft', at: '2026-07-11T00:00:00Z', error: null, draftId: 'd1',
      recipient: 'client@example.test', bodyHash: 'x', evidenceHash: 'y', claims: [] },
  });
  assert.equal(legacy.verification.model, null, 'the builder sources config from the check record, not ctx');
  const text = fullText(renderOne(item({ archives: [legacy] })));
  assert.ok(text.includes('未记录'), 'a check record without config fields shows 未记录');
  assert.ok(!text.includes('完整性'), 'an archive without an integrity record renders no integrity line');
  const verified = fullText(renderOne(item({ archives: [{ ...legacy, integrity: { status: 'verified' } }] })));
  assert.ok(verified.includes('完整性 · 校验通过'), 'a verified archive is named');
  const mismatched = fullText(renderOne(item({ archives: [{ ...legacy, integrity: { status: 'mismatch' } }] })));
  assert.ok(mismatched.includes('完整性 · 档案内容与批准记录不一致'), 'a mismatching archive is named');
  const unrecorded = fullText(renderOne(item({ archives: [{ ...legacy, integrity: { status: 'unrecorded' } }] })));
  assert.ok(unrecorded.includes('完整性 · 无完整性记录'), 'an unrecorded archive is named');
});
