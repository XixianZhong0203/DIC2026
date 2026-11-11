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
  return { call, current, state: workflow.state };
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
