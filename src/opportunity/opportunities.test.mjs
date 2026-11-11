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

// 人工复核来源记录：展开来源原文时记下来源 ID；保存复核时把已展开来源、草稿 ID、
// 来源版本与结论写入审计；草稿或来源变化后新复核从空的查看状态开始。
test('a review audit records exactly the sources opened; stale views never carry into a new review', async () => {
  const { call, state } = fixture(user => JSON.stringify({ status: 'supported' }));
  const { id } = state().opportunities[0];
  const lead = () => state().opportunities.find(row => row.id === id);
  await call('opportunity-source', { id, name: '客户邮件', date: '2026-07-01', kind: 'customer', text: '客户确认周五交付。' });
  await call('opportunity-source', { id, name: '创始人笔记', kind: 'founder', text: '创始人记得已向客户承诺周五。' });
  // 尚未展开任何来源。
  assert.equal(lead().reviewViewed.viewed.length, 0);
  // 展开 S1 与 E1（不展开 S2）。
  call('opportunity-review-view', { id, source_id: 'S1' });
  call('opportunity-review-view', { id, source_id: 'E1' });
  assert.deepEqual(lead().reviewViewed.viewed, ['S1', 'E1']);
  // 重复展开不重复写入。
  call('opportunity-review-view', { id, source_id: 'S1' });
  assert.equal(state().audit.filter(event => event.action === 'review_source_viewed').length, 2);
  // 不属于当前线索的来源被拒（本线索没有 S9；另一条线索的来源也不属于这条线索）。
  assert.throws(() => call('opportunity-review-view', { id, source_id: 'S9' }), { status: 400 });
  call('opportunity', { kind: 'lead', title: '另一条线索', source: '另一会话', evidence: '其他证据。' });
  const otherId = state().opportunities[0].id;
  await call('opportunity-source', { id: otherId, name: '另一来源', kind: 'customer', text: '其他原文。' });
  const otherSourceId = 'S' + state().opportunities[0].sources[0].id;
  assert.throws(() => call('opportunity-review-view', { id, source_id: otherSourceId }), { status: 400 });
  // 保存复核：审计只包含已展开的来源，并带草稿 ID、来源版本与结论。
  call('opportunity-review', { id, analysis_id: null, draft_id: null, resolution: '读了客户邮件与证据原文，日期仍未确认。' });
  const detail = JSON.parse(state().audit.find(event => event.action === 'human_reviewed').detail);
  assert.deepEqual(detail.viewed, ['S1', 'E1']);
  assert.deepEqual(detail.viewedNames, ['客户邮件', 'Client thread']);
  assert.equal(detail.draftId, null);
  assert.equal(typeof detail.evidence, 'string');
  assert.equal(detail.evidence.length, 64);
  assert.equal(detail.resolution, '读了客户邮件与证据原文，日期仍未确认。');
  // 更换草稿：查看状态从空开始，旧复核留在历史里。
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  assert.deepEqual(lead().reviewViewed.viewed, []);
  assert.deepEqual(lead().reviewStale, ['draft_changed']);
  call('opportunity-review', { id, analysis_id: null, draft_id: lead().draft_id, resolution: '重新核对了新草稿。' });
  let reviews = state().audit.filter(event => event.action === 'human_reviewed');
  assert.equal(reviews.length, 2);
  assert.deepEqual(JSON.parse(reviews[0].detail).viewed, [], 'the new review starts from a fresh viewing state');
  assert.deepEqual(JSON.parse(reviews[1].detail).viewed, ['S1', 'E1'], 'the old review keeps its own record in history');
  // 加入新来源：查看状态再次重置，旧查看记录不会出现在新复核上。
  call('opportunity-review-view', { id, source_id: 'S1' });
  await call('opportunity-source', { id, name: '客户撤回邮件', date: '2026-07-10', kind: 'customer', text: '客户撤回。' });
  assert.deepEqual(lead().reviewViewed.viewed, []);
  call('opportunity-review', { id, analysis_id: null, draft_id: lead().draft_id, resolution: '按新来源重新核对，未展开来源。' });
  reviews = state().audit.filter(event => event.action === 'human_reviewed');
  assert.deepEqual(JSON.parse(reviews[0].detail).viewed, [], 'no expanded sources under the new evidence set');
  assert.deepEqual(JSON.parse(reviews[1].detail).viewed, [], 'the previous new-draft review is not reattributed');
  // 在新绑定下展开 S1 再保存：新记录只包含本次展开。
  call('opportunity-review-view', { id, source_id: 'S1' });
  call('opportunity-review', { id, analysis_id: null, draft_id: lead().draft_id, resolution: '按新来源重新核对，已展开 S1 查看。' });
  reviews = state().audit.filter(event => event.action === 'human_reviewed');
  assert.deepEqual(JSON.parse(reviews[0].detail).viewed, ['S1']);
  // 审计保留全部查看动作（S1、E1；更换草稿后 S1；加入新来源后 S1）。
  assert.equal(state().audit.filter(event => event.action === 'review_source_viewed').length, 4);
});
