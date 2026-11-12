import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { opportunityWorkflow } from './opportunities.mjs';
import { sha256 } from './claims.mjs';

const EVIDENCE = 'Friday was proposed only.';

// complete receives the parsed user JSON of the last message; claims calls carry a `mode` field.
// 默认把线索原文录为客户线程（customer）；leadInit 可覆盖初始来源身份与原文。
function fixture(complete, leadInit = {}) {
  const db = new DatabaseSync(':memory:');
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const required = value => value?.trim() || fail(400, 'Required');
  const workflow = opportunityWorkflow(db, {
    complete: async messages => complete(JSON.parse(messages.at(-1).content)),
    model: 'test double', fail, required,
  });
  const call = (action, body) => workflow.mutations['/api/' + action](body);
  call('opportunity', { kind: 'lead', title: 'Delivery check', source: 'Client thread', evidence: EVIDENCE,
    evidence_kind: 'customer', ...leadInit });
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

// 「当前回答」：证据不足时怎么说、怎么继续。
const unknownIntentClaims = JSON.stringify({ claims: [
  { id: '购买意向', dimension: '购买意向', text: '客户想先看案例', status: 'unknown',
    items: [], missing: '还缺客户明确的签约回复。', rewrite: '客户想先看案例，意向未确认。' },
  { id: '签约状态', dimension: '签约状态', text: '客户已签约', status: 'unknown',
    items: [], missing: '合同是否签署仍待确认。', rewrite: '尚未确认合同是否签署。' },
] });
const caseRequestAssess = JSON.stringify({ status: 'unknown', quote: 'Friday was proposed only.',
  reason: '客户只看案例，还没有签约意向。', unknown: '缺少客户明确的签约回复。', conflict: '',
  clarification: '客户是否有明确的签约意向？', suggestedReply: '可以先发案例并询问采购计划。' });

test('an evidence answer is stored after analysis: names the confirmed part, the exact gap, and the next step', async () => {
  const { call, current } = fixture(user => user.mode ? unknownIntentClaims : caseRequestAssess);
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户是否想签约？' });
  const answer = current().answer;
  assert.equal(answer.situation, 'insufficient');
  assert.equal(answer.confirmed, 'Friday was proposed only.');
  assert.match(answer.missing, /签约/);
  assert.equal(answer.next, '可以先发案例并询问采购计划。');
  assert.deepEqual(answer.supporting, []);
  assert.equal(answer.retryable, false);
});

test('a reply with explicit intent updates the answer to a bounded conclusion that points at the new source', async () => {
  let intent = false;
  const { call, current } = fixture(user => user.mode
    ? (intent ? JSON.stringify({ claims: [
        { id: '购买意向', dimension: '购买意向', text: '客户有签约意向', status: 'supported',
          items: [{ evidenceId: 'S1', stance: 'supports', quote: '我们希望尽快签约',
            note: '客户明确表示签约意向' }],
          missing: '', rewrite: '客户已明确表达签约意向。' },
        { id: '签约状态', dimension: '签约状态', text: '客户已签约', status: 'unknown',
          items: [], missing: '合同是否签署仍待确认。', rewrite: '合同是否签署仍待确认。' },
      ] }) : unknownIntentClaims)
    : caseRequestAssess);
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户是否想签约？' });
  assert.equal(current().answer.situation, 'insufficient');
  assert.equal(current().answer.supporting.length, 0);
  // 客户补来明确表达签约意向的回复：来源集合变化触发分析目标核查重跑。
  intent = true;
  await call('opportunity-source', { id, name: '客户回复', date: '2026-07-10', kind: 'customer',
    text: '客户明确表示：我们希望尽快签约。', language: 'zh' });
  const answer = current().answer;
  assert.equal(answer.situation, 'sufficient');
  assert.match(answer.confirmed, /签约意向/);
  assert.match(answer.bounds, /合同是否签署仍待确认/);
  assert.deepEqual(answer.supporting.map(source => source.id), ['S1']);
  assert.equal(answer.supporting[0].label, '客户回复');
});

test('conflicting sources produce a conflict answer that lists the records to compare', async () => {
  const { call, current } = fixture(user => {
    if (!user.mode) return caseRequestAssess;
    const count = (user.sources ?? []).length; // E1 + 已添加来源
    if (count === 1) return unknownIntentClaims;
    if (count === 2) return JSON.stringify({ claims: [
      { id: '购买意向', dimension: '购买意向', text: '客户周五签约', status: 'supported',
        items: [{ evidenceId: 'S1', stance: 'supports', quote: '周五签约', note: '客户确认周五' }],
        missing: '', rewrite: '客户确认周五签约。' },
      { id: '签约状态', dimension: '签约状态', text: '客户已签约', status: 'unknown',
        items: [], missing: '合同是否签署仍待确认。', rewrite: '尚未确认合同是否签署。' },
    ] });
    return JSON.stringify({ claims: [
      { id: '购买意向', dimension: '购买意向', text: '客户周五签约', status: 'conflict',
        items: [
          { evidenceId: 'S1', stance: 'supports', quote: '周五签约', note: '客户确认周五' },
          { evidenceId: 'S2', stance: 'refutes', quote: '改为下周一', note: '客户希望改期' },
        ],
        missing: '请确认以哪份记录为准。', rewrite: '签约日期存在冲突。' },
      { id: '签约状态', dimension: '签约状态', text: '客户已签约', status: 'unknown',
        items: [], missing: '合同是否签署仍待确认。', rewrite: '尚未确认合同是否签署。' },
    ] });
  });
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户是否想签约？' });
  await call('opportunity-source', { id, name: '客户邮件', date: '2026-07-10', kind: 'customer',
    text: '客户确认周五签约。', language: 'zh' });
  assert.equal(current().answer.situation, 'sufficient');
  await call('opportunity-source', { id, name: '客户回复', date: '2026-07-11', kind: 'customer',
    text: '客户希望改为下周一。', language: 'zh' });
  const answer = current().answer;
  assert.equal(answer.situation, 'conflict');
  assert.deepEqual(answer.compare.map(entry => entry.id), ['S1', 'S2']);
  assert.match(answer.missing, /比较/);
  assert.equal(answer.supporting.length, 0);
});

test('a failed verification stores a retryable failed answer; re-running recovers it', async () => {
  let failed = true;
  const { call, current } = fixture(user => {
    if (!user.mode) return caseRequestAssess;
    if (failed) {
      const error = new Error('HTTP 500');
      error.status = 502;
      throw error;
    }
    return unknownIntentClaims;
  });
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户是否想签约？' });
  assert.equal(current().answer.situation, 'failed');
  assert.equal(current().answer.retryable, true);
  assert.match(current().answer.next, /重试/);
  assert.deepEqual(current().answer.incomplete, ['购买意向', '签约状态']);
  failed = false;
  await call('opportunity-claims', { id, target: 'analysis', language: 'zh' });
  assert.equal(current().answer.situation, 'insufficient');
  assert.equal(current().answer.retryable, false);
});

test('the answer is stored even when the claims review targets the draft after a source is added', async () => {
  // 最近一次核查针对草稿时，来源变化仍要重跑分析目标核查，回答指向新来源。
  let intent = false;
  const { call, current } = fixture(user => {
    if (!user.mode) return caseRequestAssess;
    if (user.draft != null) return unknownIntentClaims; // 草稿目标：声明与草稿无关，保持不足
    return intent ? JSON.stringify({ claims: [
      { id: '购买意向', dimension: '购买意向', text: '客户有签约意向', status: 'supported',
        items: [{ evidenceId: 'S1', stance: 'supports', quote: '我们希望尽快签约',
          note: '客户明确表示签约意向' }],
        missing: '', rewrite: '客户已明确表达签约意向。' },
      { id: '签约状态', dimension: '签约状态', text: '客户已签约', status: 'unknown',
        items: [], missing: '合同是否签署仍待确认。', rewrite: '合同是否签署仍待确认。' },
    ] }) : unknownIntentClaims;
  });
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户是否想签约？' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '您好，案例稍后发送。' });
  await call('opportunity-claims', { id, target: 'draft', language: 'zh' });
  assert.equal(current().claims.target, 'draft');
  assert.equal(current().answer.situation, 'insufficient');
  intent = true;
  await call('opportunity-source', { id, name: '客户回复', date: '2026-07-10', kind: 'customer',
    text: '客户明确表示：我们希望尽快签约。', language: 'zh' });
  // claims_review 保持草稿目标（发送门禁语义不变）……
  assert.equal(current().claims.target, 'draft');
  // ……而「当前回答」已按新来源更新并指向 S1。
  assert.equal(current().answer.situation, 'sufficient');
  assert.deepEqual(current().answer.supporting.map(source => source.id), ['S1']);
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
    message: '以下声明仅由创始人提供，待独立核实：签约状态。请补入独立来源（如客户合同、付款或交付记录）后重新核查，或改写为有依据的说法，或逐条记录担保，再批准发送。',
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

test('a founder-only claim requires a claim-specific guarantee even after a current overall review', async () => {
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
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  const flagged = current().claims.claims[0];
  call('opportunity-claim-resolution', { id, draft_id, claim_id: flagged.id,
    text: flagged.text, reason: '已逐条核对并承担此声明。' });
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'approved').detail).evidence, 'human_guarantee');
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

// —— 初始来源身份（evidence_kind）：堵住「原文栏写客户已签约」绕过待独立核实的漏洞 ——

// 草稿模式：初始来源（E1）陈述已完成事实；客户「愿意签约」对已签署声明只算意愿（neutral）；
// 已签合同记录（customer）才算支持。引文均逐字出自来源原文。
const initialSourceDouble = user => {
  if (!user.mode) return JSON.stringify({ status: 'supported', quote: user.evidence, reason: 'explicit' });
  if (!user.draft) {
    return JSON.stringify({ claims: user.dimensions.map(dimension => ({
      id: dimension, dimension, text: dimension, status: 'unknown', items: [],
      missing: '缺少确认信息', rewrite: '尚未确认',
    })) });
  }
  const body = user.draft.body;
  const e1 = user.sources.find(source => source.id === 'E1');
  const intent = user.sources.find(source => source.kind === 'customer'
    && source.text.includes('愿意签约') && !source.text.includes('签署'));
  const contract = user.sources.find(source => source.kind === 'customer' && source.text.includes('签署合同'));
  const saysSigned = body.includes('合同已签署');
  const items = [];
  if (saysSigned && e1) items.push({ evidenceId: 'E1', stance: 'supports', quote: e1.text, note: '初始来源陈述已完成事实' });
  if (intent) items.push({ evidenceId: intent.id, stance: saysSigned ? 'neutral' : 'supports', quote: '愿意签约',
    note: saysSigned ? '只表达意愿，未陈述已签署' : '客户来源陈述了改写后的说法' });
  if (contract) items.push({ evidenceId: contract.id, stance: 'supports', quote: '签署合同', note: '客户来源记录已签署' });
  const text = saysSigned ? '合同已签署' : '愿意签约';
  return JSON.stringify({ claims: [{ id: '签约状态', dimension: '签约状态', text, items, missing: '', rewrite: '' }] });
};

test('acceptance: initial source typed as founder statement or unconfirmed blocks the send; the contract record re-verifies to supported', async () => {
  const expectations = {
    founder: { status: 'founder_only', reason: 'claims_founder_only' },
    unconfirmed: { status: 'unconfirmed', reason: 'claims_unconfirmed' },
  };
  for (const [evidenceKind, expected] of Object.entries(expectations)) {
    const { call, current, state } = fixture(initialSourceDouble, {
      title: '签约核查', source: '客户线程', evidence: '客户已签约。', evidence_kind: evidenceKind,
    });
    const { id } = current();
    await call('opportunity-assess', { id, request: '客户签约了吗？', language: 'zh-CN' });
    call('opportunity-draft', { id, recipient: 'client@example.test', body: '合同已签署。' });
    const draft_id = current().draft_id;
    await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'zh-CN' });
    assert.equal(current().claims.claims[0].status, expected.status, evidenceKind + ' initial source');
    assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 }, evidenceKind + ' initial source');
    assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason,
      expected.reason, evidenceKind + ' initial source');
    // 加入客户邮件「我们愿意签约」，仍不能确认「已签署」。
    await call('opportunity-source', { id, name: '客户邮件', date: '2026-07-02', kind: 'customer',
      text: '我们愿意签约，期待合作。', language: 'zh-CN' });
    assert.equal(current().claims.claims[0].status, expected.status, evidenceKind + ' after intent email');
    assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
    // 补入已签合同后重新核查：当前草稿有依据，进入待批准。
    await call('opportunity-source', { id, name: '合同记录', date: '2026-07-05', kind: 'customer',
      text: '客户已于 7 月 5 日签署合同。', language: 'zh-CN' });
    assert.equal(current().claims.claims[0].status, 'supported', evidenceKind + ' after contract');
    assert.equal(current().claims.claims[0].decisive.source.kind, 'customer');
    call('opportunity-send', { id, draft_id });
    assert.equal(current().sent, 1, evidenceKind + ' initial source');
    assert.equal(JSON.parse(state().audit.find(event => event.action === 'approved').detail).evidence, 'model_supported');
  }
});

test('a legacy review computed on generic E1 cannot bypass the typed-source rule', async () => {
  const { call, current, state, db } = fixture(initialSourceDouble, {
    title: '旧线索', source: '客户线程', evidence: '客户已签约。', evidence_kind: 'unconfirmed',
  });
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户签约了吗？', language: 'zh-CN' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '合同已签署。' });
  const draft_id = current().draft_id;
  // 模拟旧版本核查结果：按通用 E1（kind=evidence）给出 supported，指纹不含来源身份。
  const oldReview = {
    target: 'draft', analysisId: null, draftId: draft_id, recipient: 'client@example.test',
    bodyHash: sha256('合同已签署。'), evidenceHash: sha256(JSON.stringify(['客户已签约。', []])),
    at: new Date().toISOString(), error: null,
    claims: [{
      id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'supported',
      items: [{ evidenceId: 'E1', stance: 'supports', quote: '客户已签约。', note: '旧版按通用 E1 判定',
        revises: [], source: { id: 'E1', source: '客户线程', date: null, kind: 'evidence', text: '客户已签约。' },
        valid: true, reasons: [] }],
      missing: '', rewrite: '', conflict: null, decisive: null, withdrawn: false, failedChecks: [],
    }],
  };
  db.prepare('UPDATE opportunities SET claims_review=? WHERE id=?').run(JSON.stringify(oldReview), id);
  // 来源身份纳入指纹后，旧结果立即过期，不能沿用旧判断自动放行。
  assert.equal(current().claimsStale, true);
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason, 'claims_stale');
  // 原文仍可打开、可引用：重新核查时 E1 引文仍然有效，只是按未确认身份判定。
  await call('opportunity-claims', { id, target: 'draft', language: 'zh-CN' });
  const claim = current().claims.claims[0];
  assert.equal(claim.status, 'unconfirmed');
  assert.ok(claim.items.every(entry => entry.valid), 'the E1 quote is still admissible');
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason, 'claims_unconfirmed');
  // 保留处理路径：针对当前草稿与来源记录人工复核结论后批准。
  call('opportunity-review', { id, analysis_id: JSON.parse(current().analysis).analysisId, draft_id, resolution: '已人工核对。' });
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  const flagged = current().claims.claims[0];
  call('opportunity-claim-resolution', { id, draft_id, claim_id: flagged.id,
    text: flagged.text, reason: '已逐条核对并承担此声明。' });
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'approved').detail).evidence, 'human_guarantee');
});

test('changing the initial source identity invalidates the stored verification', async () => {
  const { call, current, state } = fixture(initialSourceDouble, {
    title: '来源改判', source: '客户线程', evidence: '客户已签约。', evidence_kind: 'unconfirmed',
  });
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户签约了吗？', language: 'zh-CN' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '合同已签署。' });
  const draft_id = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'zh-CN' });
  assert.equal(current().claims.claims[0].status, 'unconfirmed');
  assert.equal(current().claimsStale, false);
  // 用户确认初始来源其实是客户原文：指纹变化，同一段原文不再沿用旧判断。
  await call('opportunity-evidence-kind', { id, evidence_kind: 'customer', language: 'zh-CN' });
  assert.equal(current().evidence_kind, 'customer');
  assert.equal(current().claimsStale, false, 'the re-run binds to the new identity');
  assert.equal(current().claims.claims[0].status, 'supported');
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
  assert.ok(state().audit.some(event => event.action === 'evidence_kind_changed'));
});

// 改判回归用的模型双：「合同已签署」声明的证据状态完全由初始来源（E1）的身份决定——
// unconfirmed → unconfirmed，founder → founder_only，customer → supported。
// 分析模式固定多一条 unknown 的购买意向，让回答停在「不足/待核实」而非「充分」。
const reidentificationDouble = user => {
  if (!user.mode) return JSON.stringify({
    status: 'unknown', quote: '客户已签约。',
    reason: '初始来源陈述签约，身份未独立确认。', unknown: '缺少独立于初始来源的签署记录。',
    conflict: '', clarification: '初始来源是客户原文还是创始人陈述？', suggestedReply: '请确认初始来源身份后继续。',
  });
  const e1 = user.sources.find(source => source.id === 'E1');
  const signingStatus = e1.kind === 'customer' ? 'supported'
    : e1.kind === 'founder' ? 'founder_only' : 'unconfirmed';
  const signing = { id: '签约状态', dimension: '签约状态', text: '合同已签署', status: signingStatus,
    items: [{ evidenceId: 'E1', stance: 'supports', quote: '客户已签约', note: '初始来源陈述已完成事实' }],
    missing: '', rewrite: '' };
  const claims = user.draft
    ? [signing]
    : [{ id: '购买意向', dimension: '购买意向', text: '客户想签约', status: 'unknown', items: [],
       missing: '还缺客户明确的签约回复。', rewrite: '客户签约意向未确认。' }, signing];
  return JSON.stringify({ claims });
};

test('re-identifying the initial source updates the lead answer and expires the draft review and viewed records', async () => {
  const { call, current, state } = fixture(reidentificationDouble, {
    title: '来源改判回归', source: '客户线程', evidence: '客户已签约。', evidence_kind: 'unconfirmed',
  });
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户签约了吗？', language: 'zh-CN' });
  const analysisId = JSON.parse(current().analysis).analysisId;
  // 已有分析与草稿，最近一次核查针对草稿（claims_review 保持草稿目标）。
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '合同已签署。' });
  const draft_id = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'zh-CN' });
  assert.equal(current().claims.target, 'draft');
  assert.equal(current().claims.claims[0].status, 'unconfirmed');
  // 旧身份下的线索回答：签约状态待核实（来源未确认）。
  assert.equal(current().answer.situation, 'insufficient');
  assert.deepEqual(current().answer.pending,
    [{ dimension: '签约状态', text: '合同已签署', status: 'unconfirmed' }]);
  // 针对当前草稿的人工复核与来源查看记录（都绑定旧证据版本）。
  call('opportunity-review', { id, analysis_id: analysisId, draft_id, resolution: '旧身份下的人工复核。' });
  assert.equal(current().reviewStale, null);
  call('opportunity-review-view', { id, source_id: 'E1' });
  assert.deepEqual(current().reviewViewed.viewed, ['E1']);
  // 改判初始来源身份为创始人陈述。
  await call('opportunity-evidence-kind', { id, evidence_kind: 'founder', language: 'zh-CN' });
  assert.equal(current().evidence_kind, 'founder');
  // 线索回答同步更新：同一声明按新身份转为「仅创始人陈述」。
  const answer = current().answer;
  assert.equal(answer.situation, 'insufficient');
  assert.deepEqual(answer.pending,
    [{ dimension: '签约状态', text: '合同已签署', status: 'founder_only' }]);
  // 草稿核查也按新身份重跑：仍是草稿目标，且绑定新证据版本。
  assert.equal(current().claims.target, 'draft');
  assert.equal(current().claimsStale, false);
  assert.equal(current().claims.claims[0].status, 'founder_only');
  // 旧人工复核与查看记录随证据版本变化失效（旧记录只留在审计历史里）。
  assert.deepEqual(current().reviewStale, ['source_changed']);
  assert.deepEqual(current().reviewViewed.viewed, []);
  assert.ok(state().audit.some(event => event.action === 'evidence_kind_changed'));
  assert.ok(state().audit.some(event => event.action === 'review_source_viewed'));
  // 旧复核不再放行：直接请求发送按新身份拦截，且没有模拟发送结果。
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason,
    'claims_founder_only');
  assert.equal(current().sent, 0);
  assert.equal(state().audit.some(event => event.action === 'simulated_send'), false);
  // 针对新证据版本重新复核后放行。
  call('opportunity-review', { id, analysis_id: analysisId, draft_id, resolution: '新身份下重新复核。' });
  assert.equal(current().reviewStale, null);
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  const flagged = current().claims.claims[0];
  call('opportunity-claim-resolution', { id, draft_id, claim_id: flagged.id,
    text: flagged.text, reason: '已逐条核对并承担此声明。' });
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'approved').detail).evidence, 'human_guarantee');
});

test('a mixed draft verification (one supported claim, one refuted) blocks the send with no simulated send', async () => {
  const { call, current, state } = fixture(user => {
    if (!user.mode) return JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' });
    if (!user.draft) return JSON.stringify({ claims: user.dimensions.map(dimension => ({
      id: dimension, dimension, text: dimension, status: 'unknown', items: [],
      missing: '缺少确认信息', rewrite: '尚未确认',
    })) });
    // 草稿正文含两条声明：客户意向（客户来源支持）+ 对外承诺（被客户撤回）。
    const body = user.draft.body;
    const confirmation = user.sources.find(source => source.kind === 'customer' && source.text.includes('确认采购计划'));
    const withdrawal = user.sources.find(source => source.kind === 'customer' && source.text.includes('撤回交付承诺'));
    const claims = [];
    if (body.includes('客户已确认采购计划') && confirmation) claims.push({
      id: '客户意向', dimension: '客户意向', text: '客户已确认采购计划',
      items: [{ evidenceId: confirmation.id, stance: 'supports', quote: '确认采购计划', note: '客户来源确认' }],
      missing: '', rewrite: '' });
    if (body.includes('我们保证周五交付') && withdrawal) claims.push({
      id: '对外承诺', dimension: '对外承诺', text: '我们保证周五交付',
      items: [{ evidenceId: withdrawal.id, stance: 'withdraws', quote: '撤回交付承诺', note: '客户撤回承诺' }],
      missing: '', rewrite: '' });
    return JSON.stringify({ claims });
  });
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  await call('opportunity-source', { id, name: '客户确认邮件', date: '2026-07-01', kind: 'customer',
    text: '客户确认采购计划。', language: 'en' });
  await call('opportunity-source', { id, name: '客户撤回邮件', date: '2026-07-02', kind: 'customer',
    text: '客户撤回交付承诺。', language: 'en' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '客户已确认采购计划，我们保证周五交付。' });
  const draft_id = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'en' });
  const claims = current().claims.claims;
  assert.equal(claims.length, 2);
  assert.equal(claims.find(claim => claim.text === '客户已确认采购计划').status, 'supported');
  assert.equal(claims.find(claim => claim.text === '我们保证周五交付').status, 'refuted');
  // 一条获支持、另一条被反驳：直接请求发送仍返回 409，且没有模拟发送结果。
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason,
    'claims_unresolved');
  assert.equal(current().sent, 0);
  assert.equal(state().audit.some(event => event.action === 'simulated_send'), false);
});

// —— 逐条人工复核（per-claim review）：验收场景 ——
// 一份草稿含两条问题声明（一条仅创始人陈述、一条证据不足）：
// 只处理一条时继续拦截（审计区分已处理/未处理）；两条都处理并明确批准后模拟发送，
// 批准审计记录哪些声明由创始人担保。改写或删除后保存新草稿并重新核查，
// 修改正文、收件人或来源后，旧的逐条复核结论失效。

// 草稿目标核查按正文内容提取声明：「合同已签署」仅由创始人来源支持（founder_only），
// 「业绩翻番」证据不足（unknown）。引文逐字出自来源原文。
const twoProblemClaims = user => {
  if (!user.mode) return JSON.stringify({ status: 'unknown', quote: EVIDENCE, reason: 'Unconfirmed.' });
  if (!user.draft) {
    return JSON.stringify({ claims: user.dimensions.map(dimension => ({
      id: dimension, dimension, text: dimension, status: 'unknown', items: [],
      missing: '缺少确认信息', rewrite: '尚未确认',
    })) });
  }
  const body = user.draft.body;
  const claims = [];
  if (body.includes('合同已签署')) {
    claims.push({ id: '签约状态', dimension: '签约状态', text: '合同已签署',
      items: [{ evidenceId: 'S1', stance: 'supports', quote: '已签约', note: '创始人陈述已完成事实' }],
      missing: '', rewrite: '' });
  }
  if (body.includes('业绩翻番')) {
    claims.push({ id: '公司业绩', dimension: '公司业绩', text: '业绩翻番',
      items: [], missing: '缺少业绩数据', rewrite: '业绩稳步增长' });
  }
  return JSON.stringify({ claims });
};

test('acceptance: two problem claims — handling one keeps the send blocked; handling both unlocks it', async () => {
  const { call, current, state } = fixture(twoProblemClaims);
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户签约了吗？', language: 'zh-CN' });
  await call('opportunity-source', { id, name: '创始人记录', kind: 'founder', text: '客户已签约。', language: 'zh-CN' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '合同已签署，业绩翻番。' });
  const draft_id = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'zh-CN' });
  assert.equal(current().claims.claims.length, 2);
  assert.deepEqual(current().claims.claims.map(claim => claim.status), ['founder_only', 'unknown']);
  // 两条都没有处理：直接请求发送被拦，审计列出全部未处理声明。
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  let blocked = JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail);
  assert.equal(blocked.reason, 'claims_founder_only');
  assert.deepEqual(blocked.claims.map(claim => claim.id), ['签约状态', '公司业绩']);
  assert.deepEqual(blocked.handled, []);
  // 只处理一条（逐条担保）：另一条仍未处理 → 继续拦截。
  call('opportunity-claim-resolution', {
    id, draft_id, claim_id: '签约状态', text: '合同已签署', reason: '已核对客户邮件，愿意承担这条说法。' });
  assert.equal(current().claimResolutions.length, 1);
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  blocked = JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail);
  assert.equal(blocked.reason, 'claims_unresolved');
  assert.deepEqual(blocked.claims.map(claim => claim.id), ['公司业绩']);
  assert.deepEqual(blocked.handled, ['签约状态']);
  // 另一条改写：保存新草稿并重新核查（旧担保因草稿变化自动失效）。
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '合同已签署，业绩稳步增长。' });
  const newDraft = current().draft_id;
  assert.notEqual(newDraft, draft_id);
  assert.equal(current().claimResolutions.length, 0, 'the old guarantee no longer binds to the new draft');
  assert.throws(() => call('opportunity-send', { id, draft_id: newDraft }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason, 'claims_stale');
  await call('opportunity-claims', { id, target: 'draft', draft_id: newDraft, language: 'zh-CN' });
  assert.equal(current().claims.claims.length, 1, 'the rewritten claim is gone from the new verification');
  assert.equal(current().claims.claims[0].status, 'founder_only');
  // 仍被拦：新草稿下的担保需要重新记录。
  assert.throws(() => call('opportunity-send', { id, draft_id: newDraft }), { status: 409 });
  // 两条都已处理（一条改写删除、一条重新担保）→ 明确批准并模拟发送。
  call('opportunity-claim-resolution', {
    id, draft_id: newDraft, claim_id: '签约状态', text: '合同已签署', reason: '已核对客户邮件，愿意承担这条说法。' });
  call('opportunity-send', { id, draft_id: newDraft });
  assert.equal(current().sent, 1);
  const approved = JSON.parse(state().audit.find(event => event.action === 'approved').detail);
  assert.equal(approved.evidence, 'human_guarantee');
  assert.deepEqual(approved.guaranteedClaims, [{
    claimId: '签约状态', text: '合同已签署', dimension: '签约状态', status: 'founder_only' }]);
  assert.ok(state().audit.some(event => event.action === 'claim_guaranteed'));
});

test('changing the recipient expires per-claim guarantees; the body and sources still bind them', async () => {
  const { call, current, state } = fixture(twoProblemClaims);
  const { id } = current();
  await call('opportunity-source', { id, name: '创始人记录', kind: 'founder', text: '客户已签约。', language: 'zh-CN' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '合同已签署。' });
  const oldDraft = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', draft_id: oldDraft, language: 'zh-CN' });
  assert.equal(current().claims.claims[0].status, 'founder_only');
  call('opportunity-claim-resolution', { id, draft_id: oldDraft, claim_id: '签约状态', text: '合同已签署', reason: '已核实。' });
  assert.equal(current().claimResolutions.length, 1);
  // 收件人变化 → 新草稿版本 → 旧担保失效；核查也过期。
  call('opportunity-draft', { id, recipient: 'other@example.test', body: '合同已签署。' });
  const newDraft = current().draft_id;
  assert.equal(current().claimResolutions.length, 0);
  assert.throws(() => call('opportunity-send', { id, draft_id: newDraft }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason, 'claims_stale');
  await call('opportunity-claims', { id, target: 'draft', draft_id: newDraft, language: 'zh-CN' });
  assert.throws(() => call('opportunity-send', { id, draft_id: newDraft }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason, 'claims_founder_only');
  // 针对新草稿重新担保后放行。
  call('opportunity-claim-resolution', { id, draft_id: newDraft, claim_id: '签约状态', text: '合同已签署', reason: '换收件人后重新核实。' });
  call('opportunity-send', { id, draft_id: newDraft });
  assert.equal(current().sent, 1);
});

test('adding a source expires per-claim guarantees; re-guaranteeing on the new source set unlocks the send', async () => {
  const { call, current, state } = fixture(twoProblemClaims);
  const { id } = current();
  await call('opportunity-source', { id, name: '创始人记录', kind: 'founder', text: '客户已签约。', language: 'zh-CN' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '合同已签署。' });
  const draft_id = current().draft_id;
  await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'zh-CN' });
  call('opportunity-claim-resolution', { id, draft_id, claim_id: '签约状态', text: '合同已签署', reason: '已核实。' });
  assert.equal(current().claimResolutions.length, 1);
  // 来源集合变化：核查自动按新来源重跑，但旧担保绑定旧来源版本 → 失效。
  await call('opportunity-source', { id, name: '客户补充', date: '2026-07-10', kind: 'customer',
    text: '客户表示会考虑合作。', language: 'zh-CN' });
  assert.equal(current().claimsStale, false, 'the re-run is bound to the new source set');
  assert.equal(current().claimResolutions.length, 0);
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.equal(JSON.parse(state().audit.filter(event => event.action === 'blocked')[0].detail).reason, 'claims_founder_only');
  call('opportunity-claim-resolution', { id, draft_id, claim_id: '签约状态', text: '合同已签署', reason: '新来源后重新核实。' });
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
});

test('claim resolutions are validated against the current draft review; supported claims cannot be guaranteed', async () => {
  const claimsDouble = user => {
    if (!user.mode) return JSON.stringify({ status: 'unknown' });
    if (!user.draft) {
      return JSON.stringify({ claims: user.dimensions.map(dimension => ({
        id: dimension, dimension, text: dimension, status: 'unknown', items: [],
        missing: '缺少确认信息', rewrite: '尚未确认',
      })) });
    }
    const claims = [];
    if (user.draft.body.includes('客户已签约')) {
      claims.push({ id: '签约状态', dimension: '签约状态', text: '客户已签约',
        items: [], missing: '缺少合同记录', rewrite: '尚未确认签约' });
    }
    if (user.draft.body.includes('业绩翻番')) {
      claims.push({ id: '公司业绩', dimension: '公司业绩', text: '业绩翻番',
        items: [], missing: '缺少业绩数据', rewrite: '业绩稳步增长' });
    }
    if (user.draft.body.includes('交付日期')) {
      claims.push({ id: '对外承诺', dimension: '对外承诺', text: '交付日期待确认',
        items: [{ evidenceId: 'E1', stance: 'supports', quote: EVIDENCE, note: '原文即证据' }],
        missing: '', rewrite: '' });
    }
    return JSON.stringify({ claims });
  };
  const { call, current, state } = fixture(claimsDouble);
  const { id } = current();
  // 还没有草稿。
  assert.throws(() => call('opportunity-claim-resolution',
    { id, claim_id: 'x', text: 'x', reason: 'y' }), { status: 409, message: '还没有已保存的草稿。' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '客户已签约，业绩翻番，交付日期待确认。' });
  const draft_id = current().draft_id;
  // 草稿声明尚未核查。
  assert.throws(() => call('opportunity-claim-resolution',
    { id, draft_id, claim_id: '签约状态', text: '客户已签约', reason: 'x' }),
    { status: 409, message: '草稿声明尚未核查，请先核查关键声明。' });
  await call('opportunity-claims', { id, target: 'draft', draft_id, language: 'en' });
  const byStatus = new Map(current().claims.claims.map(claim => [claim.id, claim.status]));
  assert.equal(byStatus.get('签约状态'), 'unknown');
  assert.equal(byStatus.get('公司业绩'), 'unknown');
  assert.equal(byStatus.get('对外承诺'), 'supported');
  // 过期草稿版本。
  assert.throws(() => call('opportunity-claim-resolution',
    { id, draft_id: 'stale', claim_id: '签约状态', text: '客户已签约', reason: 'x' }), { status: 409 });
  // 声明不在当前核查的被标记声明中（原句对不上）。
  assert.throws(() => call('opportunity-claim-resolution',
    { id, draft_id, claim_id: '公司业绩', text: '不存在的说法', reason: 'x' }),
    { status: 409, message: '这条声明不在当前核查的被标记声明中，请刷新后重试。' });
  // 核查已通过的声明不需要担保。
  assert.throws(() => call('opportunity-claim-resolution',
    { id, draft_id, claim_id: '对外承诺', text: '交付日期待确认', reason: 'x' }),
    { status: 409, message: '这条声明不在当前核查的被标记声明中，请刷新后重试。' });
  // 理由必填。
  assert.throws(() => call('opportunity-claim-resolution',
    { id, draft_id, claim_id: '公司业绩', text: '业绩翻番', reason: '' }), { status: 400 });
  // 两条被标记声明都担保后，即使没有分析、没有整体人工复核，也可批准发送。
  call('opportunity-claim-resolution', { id, draft_id, claim_id: '签约状态', text: '客户已签约', reason: '已核实。' });
  call('opportunity-claim-resolution', { id, draft_id, claim_id: '公司业绩', text: '业绩翻番', reason: '已核实。' });
  assert.equal(current().claimResolutions.length, 2);
  call('opportunity-send', { id, draft_id });
  assert.equal(current().sent, 1);
  const approved = JSON.parse(state().audit.find(event => event.action === 'approved').detail);
  assert.equal(approved.evidence, 'human_guarantee');
  assert.deepEqual(approved.guaranteedClaims.map(claim => claim.claimId), ['签约状态', '公司业绩']);
  // 草稿再变化：旧绑定自然失效，空范围按 claims_no_claims 处理（此处只验证担保清空）。
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'x' });
  await call('opportunity-claims', { id, target: 'draft', draft_id: current().draft_id, language: 'en' });
  assert.equal(current().claims.claims.length, 0, 'empty scope after rewrite');
  assert.equal(current().claimResolutions.length, 0, 'old binding expired with the new draft');
});
