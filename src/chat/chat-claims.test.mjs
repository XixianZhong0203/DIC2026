import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_CLAIM_DIMENSIONS, CHAT_CLAIMS_PROMPT_VERSION, chatClaimSources, chatClaimMessages,
} from './chat-claims.mjs';
import { parseClaimReport, verifyClaims } from '../opportunity/claims.mjs';

const ANSWER = '客户愿意签约；合同已签署。';

const RECORDS = [
  { id: 1, kind: 'source', scope: '客户 A', source: '客户邮件', body: '客户表示愿意签约，期待合同文本。' },
  { id: 2, kind: 'source', scope: '客户 A', source: '合同归档', body: '2026-11-12 双方已签署合同，合同文本已归档。' },
  { id: 3, kind: 'source', scope: '客户 A', source: '客户回复', body: '客户暂缓签约。合同未签署。需重新评估。' },
];
const SOURCES = chatClaimSources(RECORDS);

const item = (evidenceId, stance, quote, note) => ({ evidenceId, stance, quote, note, revises: [] });
const claim = (over) => ({
  id: '签约', dimension: '签约', text: '合同已签署', items: [], missing: '', rewrite: '', ...over,
});
// 聊天核查的调用口径：声明文本必须逐字出自回答，来源身份为 workspace。
const verify = (parsedClaims, records = RECORDS) => verifyClaims(
  parseClaimReport(JSON.stringify({ claims: parsedClaims }), { mode: 'chat' }).claims,
  chatClaimSources(records), { body: ANSWER, identity: 'workspace' });

test('the four decision-relevant dimensions are fixed', () => {
  assert.deepEqual(CHAT_CLAIM_DIMENSIONS, ['客户意向', '签约', '报价', '交付']);
  assert.equal(CHAT_CLAIMS_PROMPT_VERSION, 'chat-claims-v1');
});

test('chatClaimSources maps memory rows to verification sources', () => {
  assert.deepEqual(SOURCES, [
    { id: '1', name: '客户邮件', kind: 'source', text: '客户表示愿意签约，期待合同文本。' },
    { id: '2', name: '合同归档', kind: 'source', text: '2026-11-12 双方已签署合同，合同文本已归档。' },
    { id: '3', name: '客户回复', kind: 'source', text: '客户暂缓签约。合同未签署。需重新评估。' },
  ]);
});

test('the chat-check prompt is routed apart from the lead/draft verifier', () => {
  const [systemMsg, userMsg] = chatClaimMessages({ answer: ANSWER, sources: SOURCES });
  const system = systemMsg.content;
  const parsed = JSON.parse(userMsg.content);
  assert.equal(system.startsWith('你是聊天回答的声明核查器'), true);
  // 既有验收 mock 与 evaluation/round2.mjs 按这两个开头路由线索/草稿核查器；
  // 聊天核查不得被它们误判（提示刻意不共用开头）。
  assert.ok(!system.includes('你是声明核查器'), 'zh prompt must not start like the lead verifier');
  assert.ok(!system.includes('claim verifier'), 'zh prompt must not contain the English routing phrase');
  assert.deepEqual(parsed, { mode: 'chat', dimensions: CHAT_CLAIM_DIMENSIONS, answer: ANSWER, sources: SOURCES });

  const en = chatClaimMessages({ answer: ANSWER, sources: SOURCES, language: 'en' });
  assert.equal(en[0].content.startsWith('You are a verifier for chat answers'), true);
  assert.ok(!en[0].content.includes('claim verifier'));
  assert.ok(!en[0].content.includes('你是声明核查器'));
});

test('intent-only quote stays neutral: signing claim is unknown despite a valid verbatim quote', () => {
  const [result] = verify([claim({
    items: [item('1', 'neutral', '愿意签约', '客户只表达意愿，未陈述已签署。')],
    missing: '缺少已签署合同的记录。', rewrite: '客户愿意签约，合同是否签署尚未确认。',
  })]);
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.failedChecks, []);
  assert.equal(result.missing, '缺少已签署合同的记录。');
});

test('a verbatim signed-contract quote is grounded under workspace identity', () => {
  const [result] = verify([claim({
    items: [
      item('1', 'neutral', '愿意签约', '客户表达签约意愿。'),
      item('2', 'supports', '双方已签署合同', '合同归档记录陈述已签署。'),
    ],
  })]);
  assert.equal(result.status, 'supported');
  assert.equal(result.decisive.source.id, '2');
});

test('workspace identity overrides founder-only support (identity contrast)', () => {
  const founder = [{ id: 4, kind: 'founder', scope: '客户 A', source: '创始人记录', body: '创始人记录：合同已签署。' }];
  const items = [item('4', 'supports', '合同已签署', '创始人记录陈述已签署。')];
  const workspace = verifyClaims(
    parseClaimReport(JSON.stringify({ claims: [claim({ items }) ] }), { mode: 'chat' }).claims,
    chatClaimSources(founder), { body: ANSWER, identity: 'workspace' })[0];
  assert.equal(workspace.status, 'supported');
  const lead = verifyClaims(
    parseClaimReport(JSON.stringify({ claims: [claim({ items }) ] }), { mode: 'chat' }).claims,
    chatClaimSources(founder), { body: ANSWER })[0];
  assert.equal(lead.status, 'founder_only');
});

test('a support and a refutation without confirmed supersession keep the conflict', () => {
  const [result] = verify([claim({
    items: [
      item('2', 'supports', '双方已签署合同', '合同归档记录陈述已签署。'),
      item('3', 'refutes', '合同未签署', '客户回复称合同未签署。'),
    ],
    missing: '需确认以哪条记录为准。',
  })]);
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflict.supports.length, 1);
  assert.equal(result.conflict.opposes.length, 1);
});

test('a claim that is not verbatim in the answer is incomplete', () => {
  const [result] = verify([claim({
    text: '合同已经签署',
    items: [item('2', 'supports', '双方已签署合同', '合同归档记录。')],
    missing: '缺少已签署合同的记录。', rewrite: '客户愿意签约。',
  })]);
  assert.equal(result.status, 'incomplete');
  assert.ok(result.failedChecks.some(check => check.reason === 'claim_not_in_draft'));
});

test('a claim cut out of a negated sentence is incomplete', () => {
  const negated = '下周不会签署合同。';
  const [result] = verifyClaims(
    parseClaimReport(JSON.stringify({ claims: [claim({ text: '签署合同' })] }), { mode: 'chat' }).claims,
    SOURCES, { body: negated, identity: 'workspace' });
  assert.equal(result.status, 'incomplete');
  assert.ok(result.failedChecks.some(check => check.reason === 'truncated_negation'));
});

test('a quote that is not in the source text is incomplete', () => {
  const [result] = verify([claim({
    items: [item('2', 'supports', '合同已经签署完毕', '归档记录。')],
    missing: '缺少已签署合同的记录。', rewrite: '客户愿意签约。',
  })]);
  assert.equal(result.status, 'incomplete');
  assert.ok(result.failedChecks.some(check => check.reason === 'quote_not_found'));
});

test('chat mode skips the analysis expectIds check and reports parse failures', () => {
  assert.deepEqual(parseClaimReport('{"claims":[]}', { mode: 'chat' }), { claims: [], warnings: [] });
  assert.throws(() => parseClaimReport('{"claims":[]}', { mode: 'analysis', expectIds: ['签约'] }),
    (error) => error.reason === 'field_conflict' && error.message === '缺少声明 签约');
  assert.throws(() => parseClaimReport('this is not JSON', { mode: 'chat' }),
    (error) => error.reason === 'parse_failed');
});
