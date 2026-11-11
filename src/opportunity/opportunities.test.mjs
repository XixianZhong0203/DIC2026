import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { opportunityWorkflow } from './opportunities.mjs';

const EVIDENCE = 'Friday was proposed only.';

// complete receives the parsed user JSON of the last message; claims calls carry a `mode` field.
function fixture(complete) {
  const db = new DatabaseSync(':memory:');
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const required = value => value?.trim() || fail(400, 'Required');
  const workflow = opportunityWorkflow(db, {
    complete: async messages => complete(JSON.parse(messages.at(-1).content)),
    model: 'test double', fail, required,
  });
  const call = (action, body) => workflow.mutations['/api/' + action](body);
  call('opportunity', { kind: 'lead', title: 'Delivery check', source: 'Client thread', evidence: EVIDENCE });
  const current = () => workflow.state().opportunities[0];
  return { call, current, state: workflow.state, db };
}

// A supported claim whose quote occurs verbatim in the lead evidence (E1).
const supportedClaim = text => JSON.stringify({ claims: [{
  id: '客户意向', dimension: '客户意向', text,
  items: [{ evidenceId: 'E1', stance: 'supports', quote: EVIDENCE, note: 'proposed only' }],
  missing: '', rewrite: '',
}]});

test('uncertainty blocks sending until a human records how to resolve it', async () => {
  const { call, current, state } = fixture(user => user.mode
    ? supportedClaim('Clarify the date.')
    : JSON.stringify({ status: 'supported', quote: 'Friday was confirmed.', reason: 'Friday delivery' }));
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  const analysis = JSON.parse(current().analysis);
  assert.equal(analysis.status, 'unknown');
  assert.equal(analysis.validQuote, false);
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'Could you confirm the date?' });
  const draft_id = current().draft_id;
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.throws(() => call('opportunity-review', { id, analysis_id: 'old', resolution: 'Clarify the date.' }), { status: 409 });
  call('opportunity-review', { id, analysis_id: analysis.analysisId, draft_id, resolution: 'The draft asks for clarification.' });
  call('opportunity-send', { id, draft_id });
  call('opportunity-send', { id, draft_id });
  assert.deepEqual(state().audit.slice(0, 3).map(event => event.action),
    ['simulated_send', 'approved', 'human_reviewed']);
});

test('sending with no analysis and no review is blocked, then allowed after human review', async () => {
  const { call, current, state } = fixture(user => user.mode
    ? supportedClaim('Hello')
    : JSON.stringify({ status: 'unknown' }));
  const { id } = current();
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'Hello' });
  const draft_id = current().draft_id;
  assert.throws(() => call('opportunity-send', { id, draft_id }),
    { status: 409, message: '还没有分析，也没有人工复核。请先用模型分析，或先记录人工核实结果，再批准发送。' });
  const blocked = state().audit.find(event => event.action === 'blocked');
  assert.equal(JSON.parse(blocked.detail).reason, 'no_evidence_review');
  call('opportunity-review', { id, analysis_id: null, draft_id, resolution: 'Checked the thread myself; intent is unconfirmed.' });
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
  const approved = state().audit.find(event => event.action === 'approved');
  assert.equal(JSON.parse(approved.detail).evidence, 'human_review');
});

test('a supported analysis with a verbatim quote may be sent after the draft claims pass verification', async () => {
  const { call, current, state } = fixture(user => user.mode
    ? supportedClaim('Confirming Friday.')
    : JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' }));
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  assert.equal(JSON.parse(current().analysis).validQuote, true);
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'Confirming Friday.' });
  // 直接请求发送接口也会执行核查检查：草稿尚未核查关键声明。
  assert.throws(() => call('opportunity-send', { id, draft_id: current().draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'blocked').detail).reason, 'claims_not_verified');
  await call('opportunity-claims', { id, target: 'draft', language: 'en' });
  assert.equal(current().claimsStale, false);
  call('opportunity-send', { id, draft_id: current().draft_id });
  assert.equal(current().sent, 1);
  const approved = state().audit.find(event => event.action === 'approved');
  assert.equal(JSON.parse(approved.detail).evidence, 'model_supported');
});

test('unresolved draft claims block sending until the draft is rewritten and re-verified', async () => {
  let claimsReply = user => JSON.stringify({ claims: [{
    id: '签约状态', dimension: '签约状态', text: 'We will deliver on Friday.',
    items: [], missing: '缺少客户确认交付日期的记录', rewrite: '客户尚未确认交付日期',
  }] });
  const { call, current, state } = fixture(user => user.mode
    ? claimsReply(user)
    : JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' }));
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  const draft_id = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', language: 'en' });
  assert.equal(current().claims.claims[0].status, 'unknown');
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'blocked').detail).reason, 'claims_unresolved');
  // 采用改写：保存新草稿版本后，旧核查结果过期，重新核查通过才可发送。
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '客户尚未确认交付日期' });
  const newDraft = current().draft_id;
  assert.notEqual(newDraft, draft_id);
  assert.equal(current().claimsStale, true);
  assert.throws(() => call('opportunity-send', { id, draft_id: newDraft }), { status: 409 });
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'blocked').detail).reason, 'claims_stale');
  claimsReply = user => supportedClaim('客户尚未确认交付日期');
  await call('opportunity-claims', { id, target: 'draft', language: 'en' });
  assert.equal(current().claims.claims[0].status, 'supported');
  call('opportunity-send', { id, draft_id: newDraft });
  assert.equal(current().sent, 1);
});

test('a human review recorded for the current draft allows sending; a newer draft revokes it', async () => {
  const { call, current, state } = fixture(user => user.mode
    ? JSON.stringify({ claims: [{
      id: '签约状态', dimension: '签约状态', text: 'We will deliver on Friday.',
      items: [], missing: '缺少客户确认交付日期的记录', rewrite: '客户尚未确认交付日期',
    }] })
    : JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' }));
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  const draft_id = current().draft_id;
  const analysisId = JSON.parse(current().analysis).analysisId;
  assert.throws(() => call('opportunity-review', { id, analysis_id: analysisId, draft_id: 'stale', resolution: 'x' }), { status: 409 });
  await call('opportunity-claims', { id, target: 'draft', language: 'en' });
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'blocked').detail).reason, 'claims_unresolved');
  // 针对当前草稿记录人工复核结论。
  call('opportunity-review', { id, analysis_id: analysisId, draft_id, resolution: 'Founder accepts the risk for this draft.' });
  // 但草稿换新版本后，针对旧版本的复核失效：仍被拦截。
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday. (v2)' });
  const newDraft = current().draft_id;
  assert.throws(() => call('opportunity-send', { id, draft_id: newDraft }), { status: 409 });
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'blocked').detail).reason, 'claims_stale');
  call('opportunity-review', { id, analysis_id: analysisId, draft_id: newDraft, resolution: 'Re-reviewed the new draft.' });
  call('opportunity-send', { id, draft_id: newDraft });
  assert.equal(current().sent, 1);
  const approved = state().audit.find(event => event.action === 'approved');
  assert.equal(JSON.parse(approved.detail).evidence, 'human_review');
});

test('a human review expires when a source is added; the send is blocked until re-review', async () => {
  const { call, current, state } = fixture(user => user.mode
    ? supportedClaim('We will deliver on Friday.')
    : JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' }));
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  const analysisId = JSON.parse(current().analysis).analysisId;
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  const draft_id = current().draft_id;
  call('opportunity-review', { id, analysis_id: analysisId, draft_id, resolution: 'Checked the thread; the date is confirmed.' });
  assert.equal(current().reviewStale, null);
  // 客户补来撤回邮件：正文与收件人不变，来源集合变化，旧人工复核应显示为过期。
  await call('opportunity-source', { id, name: '客户撤回邮件', date: '2026-07-10', kind: 'customer',
    text: '客户表示撤回此前的交付承诺。', language: 'en' });
  assert.deepEqual(current().reviewStale, ['source_changed']);
  // 旧人工复核失效：直接请求发送也被拦。
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  // 审计按时间倒序：[0] 是最近一次拦截。
  const blocked = state().audit.filter(event => event.action === 'blocked')[0];
  assert.equal(JSON.parse(blocked.detail).reason, 'claims_not_verified');
  // 针对当前草稿与当前来源重新记录复核后，批准并模拟发送。
  call('opportunity-review', { id, analysis_id: analysisId, draft_id, resolution: 'Re-checked after the withdrawal email.' });
  assert.equal(current().reviewStale, null);
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
  const approved = state().audit.find(event => event.action === 'approved');
  assert.equal(JSON.parse(approved.detail).evidence, 'human_review');
});

test('a human review expires when the draft changes; re-review of the new version unlocks sending', async () => {
  const { call, current, state } = fixture(user => user.mode
    ? supportedClaim('We will deliver on Friday.')
    : JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' }));
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  const analysisId = JSON.parse(current().analysis).analysisId;
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  const oldDraft = current().draft_id;
  call('opportunity-review', { id, analysis_id: analysisId, draft_id: oldDraft, resolution: 'Reviewed the first draft.' });
  assert.equal(current().reviewStale, null);
  // 正文或收件人变化 → 新草稿版本 → 旧复核失效。
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday. (revised)' });
  const newDraft = current().draft_id;
  assert.notEqual(newDraft, oldDraft);
  assert.deepEqual(current().reviewStale, ['draft_changed']);
  assert.throws(() => call('opportunity-send', { id, draft_id: newDraft }), { status: 409 });
  const blocked = state().audit.filter(event => event.action === 'blocked')[0];
  assert.equal(JSON.parse(blocked.detail).reason, 'claims_not_verified');
  call('opportunity-review', { id, analysis_id: analysisId, draft_id: newDraft, resolution: 'Reviewed the revised draft.' });
  assert.equal(current().reviewStale, null);
  call('opportunity-send', { id, draft_id: newDraft });
  assert.equal(current().sent, 1);
});

test('an expired human review no longer gates the send when a fresh draft verification passes', async () => {
  const { call, current, state } = fixture(user => user.mode
    ? supportedClaim('We will deliver on Friday.')
    : JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' }));
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  const analysisId = JSON.parse(current().analysis).analysisId;
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  const draft_id = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'en' });
  call('opportunity-review', { id, analysis_id: analysisId, draft_id, resolution: 'Reviewed the current draft.' });
  assert.equal(current().reviewStale, null);
  await call('opportunity-source', { id, name: '客户补充确认', date: '2026-07-10', kind: 'customer',
    text: '客户再次确认周五交付。', language: 'en' });
  // 来源变化使复核过期，但针对当前来源的自动核查已重跑且通过：仍可由有效自动核查批准当前草稿。
  assert.deepEqual(current().reviewStale, ['source_changed']);
  assert.equal(current().claimsStale, false);
  assert.ok(current().claims.claims.every(claim => claim.status === 'supported'));
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
  const approved = state().audit.find(event => event.action === 'approved');
  assert.equal(JSON.parse(approved.detail).evidence, 'model_supported');
});

test('a review goes stale on both draft and source when both change', async () => {
  const { call, current } = fixture(user => user.mode
    ? supportedClaim('We will deliver on Friday.')
    : JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' }));
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  const analysisId = JSON.parse(current().analysis).analysisId;
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  call('opportunity-review', { id, analysis_id: analysisId, draft_id: current().draft_id, resolution: 'Reviewed.' });
  await call('opportunity-source', { id, name: '客户撤回邮件', date: '2026-07-10', kind: 'customer',
    text: '客户表示撤回此前的交付承诺。', language: 'en' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday. (revised)' });
  assert.deepEqual(current().reviewStale, ['draft_changed', 'source_changed']);
});

test('customer follow-up: a withdrawal email expires the human review; re-reviewing the rewritten draft unlocks the send', async () => {
  // 验收流程：人工复核当前草稿 → 客户补来撤回邮件（正文、收件人不变）
  // → 旧人工复核失效，直接请求发送被拦 → 按新来源改写（核查范围为空时核查放行不了）
  // → 针对当前草稿重新复核 → 批准并成功模拟发送。
  let withdrawn = false;
  const { call, current, state } = fixture(user => {
    if (!user.mode) return JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' });
    if (user.draft == null) {
      return JSON.stringify({ claims: user.dimensions.map(dimension => ({
        id: dimension, dimension, text: dimension, status: 'supported',
        items: [{ evidenceId: 'E1', stance: 'supports', quote: EVIDENCE, note: 'proposed' }],
        missing: '', rewrite: '',
      })) });
    }
    if (user.draft.body.includes('保证周五交付')) {
      if (withdrawn) {
        return JSON.stringify({ claims: [{
          id: '对外承诺', dimension: '对外承诺', text: '我们保证周五交付',
          items: [{ evidenceId: 'S1', stance: 'withdraws', quote: '撤回此前关于周五交付的承诺',
            note: '客户撤回了交付承诺', revises: ['E1'] }],
          missing: '', rewrite: '',
        }] });
      }
      return JSON.stringify({ claims: [{
        id: '对外承诺', dimension: '对外承诺', text: '我们保证周五交付',
        items: [{ evidenceId: 'E1', stance: 'supports', quote: EVIDENCE, note: '客户仅提议周五' }],
        missing: '', rewrite: '',
      }] });
    }
    return JSON.stringify({ claims: [] });
  });
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  const analysisId = JSON.parse(current().analysis).analysisId;
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '我们保证周五交付。' });
  const draft_id = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'en' });
  assert.ok(current().claims.claims.every(claim => claim.status === 'supported'));
  // 人工复核当前草稿。
  call('opportunity-review', { id, analysis_id: analysisId, draft_id, resolution: '人工复核：当前草稿已核对。' });
  assert.equal(current().reviewStale, null);
  // 客户补来撤回邮件：正文与收件人不变，来源集合变化。
  withdrawn = true;
  await call('opportunity-source', { id, name: '客户撤回邮件', date: '2026-07-10', kind: 'customer',
    text: '客户表示撤回此前关于周五交付的承诺。', language: 'en' });
  assert.deepEqual(current().reviewStale, ['source_changed'], 'the old human review is expired');
  // 自动核查已按新来源重跑：保证交付的声明被撤回 → 直接请求发送也被拦。
  assert.equal(current().claimsStale, false);
  assert.equal(current().claims.claims[0].status, 'refuted');
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason,
    'claims_unresolved');
  // 按新来源改写：新草稿没有可核查声明（实际核查范围为空），核查不能放行。
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '已收到您的撤回，请确认后续安排。' });
  const newDraft = current().draft_id;
  assert.deepEqual(current().reviewStale, ['draft_changed', 'source_changed']);
  await call('opportunity-claims', { id, target: 'draft', draft_id: newDraft, language: 'en' });
  assert.equal(current().claims.claims.length, 0);
  assert.throws(() => call('opportunity-send', { id, draft_id: newDraft }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason,
    'claims_no_claims');
  // 针对当前草稿记录新的人工复核 → 批准并成功模拟发送。
  call('opportunity-review', { id, analysis_id: analysisId, draft_id: newDraft, resolution: '复核：草稿已按撤回改写，仅用于确认后续安排。' });
  assert.equal(current().reviewStale, null);
  call('opportunity-send', { id, draft_id: newDraft });
  assert.equal(current().sent, 1);
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'approved').detail).evidence, 'human_review');
});

test('a legacy review without a source version prompts re-review and cannot unlock the send', async () => {
  const { call, current, state, db } = fixture(user => user.mode
    ? supportedClaim('We will deliver on Friday.')
    : JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' }));
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  const analysisId = JSON.parse(current().analysis).analysisId;
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  const draft_id = current().draft_id;
  // 旧记录：绑定草稿但没有来源版本（review_evidence 为空）。
  db.prepare('UPDATE opportunities SET review=?, review_draft=? WHERE id=?')
    .run('旧复核记录（未记录来源版本）', draft_id, id);
  assert.deepEqual(current().reviewStale, ['review_unbound']);
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  const blocked = state().audit.filter(event => event.action === 'blocked')[0];
  assert.equal(JSON.parse(blocked.detail).reason, 'claims_not_verified');
  call('opportunity-review', { id, analysis_id: analysisId, draft_id, resolution: 'Re-reviewed with the source version recorded.' });
  assert.equal(current().reviewStale, null);
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
});

test('an incomplete claim verification blocks sending until it is re-run', async () => {
  let failed = true;
  const { call, current, state } = fixture(user => {
    if (!user.mode) return JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' });
    if (failed) {
      const error = new Error('HTTP 500');
      error.status = 502;
      throw error;
    }
    return supportedClaim('We will deliver on Friday.');
  });
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  const draft_id = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', language: 'en' });
  assert.ok(current().claims.error);
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'blocked').detail).reason, 'claims_incomplete');
  failed = false;
  await call('opportunity-claims', { id, target: 'draft', language: 'en' });
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
});

test('an outdated draft version cannot be approved', async () => {
  const { call, current } = fixture(user => user.mode
    ? supportedClaim('v1')
    : JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' }));
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'v1' });
  const oldDraft = current().draft_id;
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'v2' });
  assert.notEqual(current().draft_id, oldDraft);
  assert.throws(() => call('opportunity-send', { id, draft_id: oldDraft }),
    { status: 409, message: '草稿已变更，请重新核对后确认。' });
  assert.equal(current().sent, 0);
});

test('a failed model run records the failed case without scoring it', async () => {
  const { call, state } = fixture(async () => { throw Object.assign(new Error('HTTP 401'), { status: 502 }); });
  await call('opportunity-benchmark', { language: 'en' });
  assert.equal(state().benchmark.complete, false);
  assert.equal(state().benchmark.results[0].statusMatched, null);
  assert.equal(state().benchmark.results[0].error, 'HTTP 401');
});

// —— 创始人自述与证据判定：验收场景 ——
// 创始人说「已签约」，客户邮件只说「愿意签」；草稿写「合同已签署」时，
// 声明为「由创始人提供，待独立核实」，直接发送被拦；补入已签合同记录后重新核查
// 有依据（supported），进入待批准；改写与针对当前草稿的人工复核是另外两条出路。
// 草稿模式下按草稿正文与来源集返回声明（引文逐字出自来源原文）。
const signingDouble = user => {
  // 分析本身有依据（引文逐字出自线索原文），发送门槛交由草稿声明核查判定。
  if (!user.mode) return JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' });
  if (!user.draft) {
    return JSON.stringify({ claims: user.dimensions.map(dimension => ({
      id: dimension, dimension, text: dimension, status: 'unknown', items: [],
      missing: '缺少确认信息', rewrite: '尚未确认',
    })) });
  }
  const body = user.draft.body;
  const founder = user.sources.find(source => source.kind === 'founder');
  const intent = user.sources.find(source => source.kind === 'customer'
    && source.text.includes('愿意签约') && !source.text.includes('签署'));
  const contract = user.sources.find(source => source.kind === 'customer' && source.text.includes('签署合同'));
  const saysSigned = body.includes('合同已签署');
  const items = [];
  if (saysSigned) {
    if (founder) items.push({ evidenceId: founder.id, stance: 'supports', quote: '已签约', note: '创始人陈述已完成事实' });
    if (intent) items.push({ evidenceId: intent.id, stance: 'neutral', quote: '愿意签约', note: '只表达意愿，未陈述已签署' });
  }
  if (contract) items.push({ evidenceId: contract.id, stance: 'supports', quote: '签署合同', note: '客户来源记录已签署' });
  if (intent && body.includes('愿意签约')) items.push({ evidenceId: intent.id, stance: 'supports', quote: '愿意签约', note: '客户来源陈述了改写后的说法' });
  const text = saysSigned ? '合同已签署' : '愿意签约';
  return JSON.stringify({ claims: [{ id: '签约状态', dimension: '签约状态', text, items, missing: '', rewrite: '' }] });
};

test('acceptance: founder says signed while the customer only says willing — blocked until the signed-contract record is added', async () => {
  const { call, current, state } = fixture(signingDouble);
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户签约了吗？', language: 'zh-CN' });
  // 创始人说「已签约」，客户邮件只说「愿意签」。
  await call('opportunity-source', { id, name: '创始人记录', date: null, kind: 'founder', text: '客户已签约。', language: 'zh-CN' });
  await call('opportunity-source', { id, name: '客户邮件', date: '2026-07-02', kind: 'customer',
    text: '我们愿意签约，期待合作。', language: 'zh-CN' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '合同已签署。' });
  const draft_id = current().draft_id;
  // 核查：唯一支持引文来自创始人来源 → 「由创始人提供，待独立核实」。
  await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'zh-CN' });
  assert.equal(current().claimsStale, false);
  assert.equal(current().claims.claims[0].status, 'founder_only');
  // 直接请求发送也被拦。
  assert.throws(() => call('opportunity-send', { id, draft_id }), {
    status: 409,
    message: '以下声明仅由创始人提供，待独立核实：签约状态。请补入独立来源（如客户合同、付款或交付记录）后重新核查，或改写为有依据的说法，或针对当前草稿与来源记录人工复核结论，再批准发送。',
  });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason, 'claims_founder_only');
  // 补入已签合同记录：来源变化自动重新核查 → 有依据（supported），进入待批准。
  await call('opportunity-source', { id, name: '合同记录', date: '2026-07-05', kind: 'customer',
    text: '客户已于 7 月 5 日签署合同。', language: 'zh-CN' });
  assert.equal(current().claimsStale, false);
  assert.equal(current().claims.claims[0].status, 'supported');
  assert.equal(current().claims.claims[0].decisive.source.kind, 'customer');
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'approved').detail).evidence, 'model_supported');
});

test('a founder-only claim may be released by a review bound to the current draft and sources', async () => {
  const { call, current, state } = fixture(signingDouble);
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户签约了吗？', language: 'zh-CN' });
  const analysisId = JSON.parse(current().analysis).analysisId;
  await call('opportunity-source', { id, name: '创始人记录', date: null, kind: 'founder', text: '客户已签约。', language: 'zh-CN' });
  await call('opportunity-source', { id, name: '客户邮件', date: '2026-07-02', kind: 'customer',
    text: '我们愿意签约，期待合作。', language: 'zh-CN' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '合同已签署。' });
  const draft_id = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'zh-CN' });
  assert.equal(current().claims.claims[0].status, 'founder_only');
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason, 'claims_founder_only');
  // 针对当前草稿与当前来源记录人工复核结论 → 批准并发送。
  call('opportunity-review', { id, analysis_id: analysisId, draft_id, resolution: '已人工核对，此版本可发送。' });
  assert.equal(current().reviewStale, null);
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'approved').detail).evidence, 'human_review');
});

test('a founder-only claim may be released by rewriting to an evidence-grounded statement and re-verifying', async () => {
  const { call, current, state } = fixture(signingDouble);
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户签约了吗？', language: 'zh-CN' });
  await call('opportunity-source', { id, name: '创始人记录', date: null, kind: 'founder', text: '客户已签约。', language: 'zh-CN' });
  await call('opportunity-source', { id, name: '客户邮件', date: '2026-07-02', kind: 'customer',
    text: '我们愿意签约，期待合作。', language: 'zh-CN' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '合同已签署。' });
  const draft_id = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'zh-CN' });
  assert.equal(current().claims.claims[0].status, 'founder_only');
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason, 'claims_founder_only');
  // 改写为有依据的说法（客户意愿有客户来源支持），重新核查。
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '客户已表示愿意签约。' });
  const newDraft = current().draft_id;
  assert.notEqual(newDraft, draft_id);
  assert.equal(current().claimsStale, true);
  assert.throws(() => call('opportunity-send', { id, draft_id: newDraft }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason, 'claims_stale');
  await call('opportunity-claims', { id, target: 'draft', draft_id: newDraft, language: 'zh-CN' });
  const claim = current().claims.claims[0];
  assert.equal(claim.status, 'supported');
  assert.equal(claim.decisive.source.kind, 'customer');
  call('opportunity-send', { id, draft_id: newDraft });
  assert.equal(current().sent, 1);
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'approved').detail).evidence, 'model_supported');
});
