import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceAnswer, SITUATIONS } from './answer.mjs';

// A "want case study" clue: purchase intent not supported -> insufficient evidence, state the gap and next
// steps.
const onlyCaseRequest = (overrides = {}) => ({
  status: 'unknown',
  error: null,
  quote: '客户表示想先看案例。',
  reason: '请求查看案例不构成购买意向。',
  unknown: '缺少客户明确的签约回复。',
  conflict: '',
  clarification: '客户是否有明确的签约意向？',
  suggestedReply: '可以先发案例并询问采购计划。',
  claims: [
    { id: '购买意向', dimension: '购买意向', text: '客户有购买意向', status: 'unknown',
      items: [], missing: '需要确认客户是否已明确签约意向。', rewrite: '' },
    { id: '签约状态', dimension: '签约状态', text: '客户已签约', status: 'unknown',
      items: [], missing: '需要确认合同是否已签署。', rewrite: '' },
  ],
  sources: [{ id: 'E1', name: '客户线程', kind: 'evidence', text: '客户表示想先看案例。' }],
  ...overrides,
});

test('situation vocabulary is the four bounded cases', () => {
  assert.deepEqual(SITUATIONS, ['sufficient', 'insufficient', 'conflict', 'failed']);
});

test('insufficient: only a case request → names the gap and an actionable next step', () => {
  const answer = evidenceAnswer(onlyCaseRequest());
  assert.equal(answer.situation, 'insufficient');
  assert.match(answer.confirmed, /案例/); // Confirmed: wants case study
  assert.match(answer.missing, /签约/);    // Missing: explicit signing response
  assert.equal(answer.next, '可以先发案例并询问采购计划。'); // Next step: actionable
  assert.deepEqual(answer.supporting, []);
  assert.deepEqual(answer.compare, []);
  assert.equal(answer.retryable, false);
});

test('insufficient falls back to the claim gap when the analysis unknown is empty', () => {
  const answer = evidenceAnswer(onlyCaseRequest({ unknown: '' }));
  assert.equal(answer.situation, 'insufficient');
  assert.match(answer.missing, /签约意向/); // Missing from claims
});

test('sufficient: a supported intent gives a bounded conclusion and points at the new source', () => {
  const answer = evidenceAnswer(onlyCaseRequest({
    status: 'supported',
    quote: '客户明确表示希望签约。',
    unknown: '',
    suggestedReply: '可安排合同细节确认。',
    claims: [
      { id: '购买意向', dimension: '购买意向', text: '客户已明确表达签约意向', status: 'supported',
        items: [{ evidenceId: 'S2', stance: 'supports', quote: '希望签约',
          source: { id: 'S2', source: '客户回复', kind: 'customer', text: '客户明确表示希望签约。' } }],
        missing: '', rewrite: '已明确表达签约意向。' },
      { id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'unknown',
        items: [], missing: '合同是否签署仍待确认。', rewrite: '' },
    ],
    sources: [
      { id: 'E1', name: '客户线程', kind: 'evidence', text: '客户表示想先看案例。' },
      { id: 'S2', name: '客户回复', kind: 'customer', text: '客户明确表示希望签约。' },
    ],
  }));
  assert.equal(answer.situation, 'sufficient');
  assert.match(answer.confirmed, /签约意向/); // Confirmed: explicitly expressed signing intent
  assert.match(answer.bounds, /合同是否签署仍待确认/); // Boundary: which step remains unconfirmed
  assert.deepEqual(answer.supporting.map(source => source.id), ['S2']); // Points to newly added source
  assert.equal(answer.retryable, false);
});

// Mixed case: the customer has explicitly expressed signing intent (supported by customer source), but
// "contract signed" is only stated by the founder.
// The response must provide both the confirmed intent and the unverified signing status, rather than
// merging the signing status into the confirmed items.
test('mixed case: confirmed intent plus a founder-only signing claim → pending verification is listed', () => {
  const answer = evidenceAnswer(onlyCaseRequest({
    status: 'supported',
    quote: '客户明确表示希望签约。',
    unknown: '',
    suggestedReply: '可安排合同细节确认。',
    claims: [
      { id: '购买意向', dimension: '购买意向', text: '客户已明确表达签约意向', status: 'supported',
        items: [{ evidenceId: 'S2', stance: 'supports', quote: '希望签约',
          source: { id: 'S2', source: '客户回复', kind: 'customer', text: '客户明确表示希望签约。' } }],
        missing: '', rewrite: '已明确表达签约意向。' },
      { id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'founder_only',
        items: [{ evidenceId: 'S1', stance: 'supports', quote: '已签约',
          source: { id: 'S1', source: '创始人记录', kind: 'founder', text: '客户已签约。' } }],
        missing: '', rewrite: '仅创始人陈述合同已签署。' },
    ],
    sources: [
      { id: 'E1', name: '客户线程', kind: 'evidence', text: '客户表示想先看案例。' },
      { id: 'S1', name: '创始人记录', kind: 'founder', text: '客户已签约。' },
      { id: 'S2', name: '客户回复', kind: 'customer', text: '客户明确表示希望签约。' },
    ],
  }));
  assert.equal(answer.situation, 'sufficient');
  assert.match(answer.confirmed, /签约意向/); // Confirmed: explicitly expressed signing intent
  assert.deepEqual(answer.pending, [
    { dimension: '签约状态', text: '合同已签署', status: 'founder_only' },
  ]);
  assert.match(answer.bounds, /合同已签署/); // Boundary: unverified signing status
  assert.match(answer.bounds, /待独立核实/);
  assert.deepEqual(answer.supporting.map(source => source.id), ['S2']); // Based solely on customer source
});

test('an unconfirmed-identity claim is listed as pending verification in an insufficient answer', () => {
  const answer = evidenceAnswer(onlyCaseRequest({
    claims: [
      { id: '购买意向', dimension: '购买意向', text: '客户想签约', status: 'unknown',
        items: [], missing: '还缺客户明确的签约回复。', rewrite: '' },
      { id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'unconfirmed',
        items: [{ evidenceId: 'E1', stance: 'supports', quote: '客户已签约',
          source: { id: 'E1', source: '客户线程', kind: 'unconfirmed', text: '客户已签约。' } }],
        missing: '', rewrite: '' },
    ],
  }));
  assert.equal(answer.situation, 'insufficient');
  assert.deepEqual(answer.pending, [
    { dimension: '签约状态', text: '合同已签署', status: 'unconfirmed' },
  ]);
  assert.deepEqual(answer.supporting, []); // Unconfirmed sources do not constitute evidence
});

test('conflict: shows the records that must be compared and withholds a conclusion', () => {
  const answer = evidenceAnswer(onlyCaseRequest({
    status: 'conflict',
    conflict: '交付日期两份记录不一致。',
    claims: [
      { id: '签约状态', dimension: '签约状态', text: '周五交付', status: 'conflict',
        items: [], missing: '', rewrite: '',
        conflict: {
          supports: [{ valid: true, stance: 'supports', quote: '周五交付',
            source: { id: 'S1', source: '客户邮件', kind: 'customer', text: '客户确认周五交付。' } }],
          opposes: [{ valid: true, stance: 'refutes', quote: '改为周二',
            source: { id: 'S2', source: '客户回复', kind: 'customer', text: '客户希望改为周二。' } }],
        } },
    ],
  }));
  assert.equal(answer.situation, 'conflict');
  assert.equal(answer.compare.length, 2);
  assert.deepEqual(answer.compare.map(entry => entry.id), ['S1', 'S2']);
  assert.match(answer.missing, /比较/);
  assert.equal(answer.supporting.length, 0); // Do not point to any "supporting" source in case of conflict
});

test('failed: a verification error is retryable and does not claim a conclusion', () => {
  const answer = evidenceAnswer(onlyCaseRequest({
    error: '模型请求失败',
    claims: [
      { id: '购买意向', dimension: '购买意向', text: '', status: 'incomplete',
        items: [], missing: '', rewrite: '', failedChecks: [{ reason: 'request_failed' }] },
    ],
  }));
  assert.equal(answer.situation, 'failed');
  assert.equal(answer.retryable, true);
  assert.match(answer.next, /重试/);
  assert.equal(answer.confirmed, '');
  assert.deepEqual(answer.incomplete, ['购买意向']);
});

test('failed takes precedence over a stored status', () => {
  const answer = evidenceAnswer(onlyCaseRequest({ status: 'supported', error: 'HTTP 502' }));
  assert.equal(answer.situation, 'failed');
});

test('conflict takes precedence over a supported claim in another dimension', () => {
  const answer = evidenceAnswer(onlyCaseRequest({
    status: 'supported',
    claims: [
      { id: '购买意向', dimension: '购买意向', text: '有签约意向', status: 'supported',
        items: [{ evidenceId: 'S2', stance: 'supports', quote: 'x',
          source: { id: 'S2', source: 's', kind: 'customer', text: 'x' } }],
        missing: '', rewrite: '有签约意向。' },
      { id: '签约状态', dimension: '签约状态', text: '周五交付', status: 'conflict',
        items: [], missing: '', rewrite: '',
        conflict: {
          supports: [{ valid: true, stance: 'supports', quote: 'a', source: { id: 'S1', source: 'a', kind: 'customer', text: 'a' } }],
          opposes: [{ valid: true, stance: 'refutes', quote: 'b', source: { id: 'S2', source: 'b', kind: 'customer', text: 'b' } }],
        } },
    ],
  }));
  assert.equal(answer.situation, 'conflict');
  assert.equal(answer.compare.length, 2);
});

test('an empty bundle is treated as insufficient, not as a pass', () => {
  const answer = evidenceAnswer({});
  assert.equal(answer.situation, 'insufficient');
  assert.equal(answer.supporting.length, 0);
});

test('incomplete claims are surfaced, never silently dropped', () => {
  const answer = evidenceAnswer(onlyCaseRequest({
    claims: [
      { id: '购买意向', dimension: '购买意向', text: '', status: 'incomplete',
        items: [], missing: '', rewrite: '', failedChecks: [{ reason: 'field_conflict' }] },
    ],
  }));
  assert.equal(answer.situation, 'insufficient');
  assert.deepEqual(answer.incomplete, ['购买意向']);
});
