import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceAnswer, SITUATIONS } from './answer.mjs';

// 一份「想看案例」的线索：购买意向未支持 → 证据不足，说清缺口与下一步。
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
  assert.match(answer.confirmed, /案例/); // 已确认：想看案例
  assert.match(answer.missing, /签约/);    // 缺：明确的签约回复
  assert.equal(answer.next, '可以先发案例并询问采购计划。'); // 下一步：可操作
  assert.deepEqual(answer.supporting, []);
  assert.deepEqual(answer.compare, []);
  assert.equal(answer.retryable, false);
});

test('insufficient falls back to the claim gap when the analysis unknown is empty', () => {
  const answer = evidenceAnswer(onlyCaseRequest({ unknown: '' }));
  assert.equal(answer.situation, 'insufficient');
  assert.match(answer.missing, /签约意向/); // 来自声明的 missing
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
  assert.match(answer.confirmed, /签约意向/); // 已确认：明确表达签约意向
  assert.match(answer.bounds, /合同是否签署仍待确认/); // 边界：哪一步仍未确认
  assert.deepEqual(answer.supporting.map(source => source.id), ['S2']); // 指向新增来源
  assert.equal(answer.retryable, false);
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
  assert.equal(answer.supporting.length, 0); // 冲突时不指向任何“支持”来源
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
