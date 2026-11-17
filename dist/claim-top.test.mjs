import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimTopTitle } from './claim-top.mjs';

// 顶部状态文案与后端口径一一对应（zh 直接返回原文，en 走 i18n 词表）。
// 这里固定任务书要求的五类顶部状态 + 空声明列表的界面文案。
const t = phrase => phrase;

test('claimTopTitle maps the pending-verification status', () => {
  assert.equal(claimTopTitle({ status: 'attention', total: 1 }, t), '有关键说法待核实');
});

test('claimTopTitle maps the all-grounded status and names the scope count', () => {
  assert.equal(claimTopTitle({ status: 'verified', total: 3 }, t), '已核查 3 条，均有依据');
  assert.equal(claimTopTitle({ status: 'verified', total: 1 }, t), '已核查 1 条，均有依据');
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
