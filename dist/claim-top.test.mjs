import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimTopTitle } from './claim-top.mjs';
import { translate } from './i18n.js';

// Top status text corresponds one-to-one with backend wording (zh returns the original text directly, en
// uses the i18n dictionary).
// Here we fix the five types of top statuses required by the task specification plus the UI text for an
// empty statement list.
const t = phrase => phrase;

test('claimTopTitle maps the pending-verification status', () => {
  assert.equal(claimTopTitle({ status: 'attention', total: 1 }, t), '有关键说法待核实');
});

test('claimTopTitle maps the all-grounded status and names the scope count', () => {
  assert.equal(claimTopTitle({ status: 'verified', total: 3 }, t),
    '已抽取并核查 3 条关键断言，均有依据；覆盖范围仅限已抽取的关键断言');
  assert.equal(claimTopTitle({ status: 'verified', total: 1 }, t),
    '已抽取并核查 1 条关键断言，均有依据；覆盖范围仅限已抽取的关键断言');
});

// The all-grounded top status must say what was extracted and checked and explicitly limit coverage to the
// extracted claims — in English and in Chinese (English-first UI uses the real dictionary).
test('the all-grounded top status states the extraction, the check, and the coverage limit in English', () => {
  const en = phrase => translate('en', phrase);
  const text = claimTopTitle({ status: 'verified', total: 2 }, en);
  assert.match(text, /Extracted and verified 2 key claims, all grounded/);
  assert.match(text, /coverage is limited to the extracted claims/i);
});

test('the all-grounded top status states the extraction, the check, and the coverage limit in Chinese', () => {
  const text = claimTopTitle({ status: 'verified', total: 2 }, t);
  assert.match(text, /已抽取并核查 2 条关键断言，均有依据/);
  assert.match(text, /覆盖范围仅限已抽取的关键断言/);
});

test('claimTopTitle maps the source-conflict status', () => {
  assert.equal(claimTopTitle({ status: 'conflict', total: 1 }, t), '发现证据冲突');
});

test('claimTopTitle maps the failed status', () => {
  assert.equal(claimTopTitle({ status: 'failed', total: 0 }, t), '核查失败');
});

test('claimTopTitle maps the empty-claims status to the required phrase', () => {
  assert.equal(claimTopTitle({ status: 'none', total: 0 }, t), '本轮未抽取到可核查声明');
});

test('claimTopTitle maps the refuted status', () => {
  assert.equal(claimTopTitle({ status: 'refuted', total: 1 }, t), '证据反驳');
});

test('claimTopTitle falls back safely for an unknown status', () => {
  assert.equal(claimTopTitle({ status: 'mystery', total: 0 }, t), '核查失败');
  assert.equal(claimTopTitle(null, t), '核查失败');
});
