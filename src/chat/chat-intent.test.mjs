import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleIntent, normalizeIntent, workspaceMentions, INTENT_ACTIONS } from './chat-intent.mjs';

const workspaces = ['客户 A', '客户 B', '客户 C'];

test('workspaceMentions excludes the current workspace from mentions', () => {
  const { mentions, mentionsAll } = workspaceMentions('对比客户 A 和客户 B 的报价', workspaces, '客户 A');
  assert.deepEqual(mentions, ['客户 B']);
  assert.deepEqual(mentionsAll, ['客户 A', '客户 B']);
});

test('explicit switch phrase + one existing workspace → switch', () => {
  const intent = ruleIntent('换个项目，帮我看客户 B 的报价', workspaces, '客户 A');
  assert.deepEqual({ action: intent.action, workspace: intent.workspace }, { action: 'switch', workspace: '客户 B' });
});

test('switch phrase without a named workspace is ambiguous (LLM decides)', () => {
  assert.equal(ruleIntent('换个项目看看', workspaces, '客户 A'), null);
});

test('two named workspaces with a switch phrase is ambiguous (LLM decides)', () => {
  assert.equal(ruleIntent('切换到客户 A 和客户 B', workspaces, ''), null);
});

test('explicit new-conversation request without other workspaces → new', () => {
  assert.equal(ruleIntent('开个新对话，帮我整理客户 A 的反馈', workspaces, '客户 A').action, 'new');
});

test('comparison phrasing with both sides named → compare, naming every side', () => {
  const intent = ruleIntent('对比客户 A 和客户 B 的报价', workspaces, '客户 A');
  assert.equal(intent.action, 'compare');
  assert.deepEqual(intent.involved, ['客户 A', '客户 B']);
});

test('a lone mention of another workspace is only a signal (LLM decides)', () => {
  assert.equal(ruleIntent('顺便问问客户 B 那边的报价', workspaces, '客户 A'), null);
});

test('ordinary follow-ups are ambiguous (LLM decides)', () => {
  assert.equal(ruleIntent('把刚才这封改成中文', workspaces, '客户 A'), null);
});

test('normalizeIntent accepts a valid switch to an existing workspace', () => {
  assert.deepEqual(
    normalizeIntent({ action: 'switch', workspace: '客户 B' }, { workspaces, current: '客户 A' }),
    { action: 'switch', workspace: '客户 B', involved: [], reason: '' },
  );
});

test('normalizeIntent rejects a switch to a workspace that does not exist', () => {
  assert.equal(normalizeIntent({ action: 'switch', workspace: '客户 D' }, { workspaces, current: '客户 A' }), null);
});

test('normalizeIntent rejects switching to the current workspace', () => {
  assert.equal(normalizeIntent({ action: 'switch', workspace: '客户 A' }, { workspaces, current: '客户 A' }), null);
});

test('normalizeIntent accepts continue and new without a workspace', () => {
  assert.deepEqual(normalizeIntent({ action: 'continue' }, { workspaces, current: '客户 A' }),
    { action: 'continue', workspace: '', involved: [], reason: '' });
  assert.deepEqual(normalizeIntent({ action: 'new', reason: '独立任务' }, { workspaces, current: '' }),
    { action: 'new', workspace: '', involved: [], reason: '独立任务' });
});

test('normalizeIntent rejects unknown actions and junk', () => {
  assert.equal(normalizeIntent({ action: 'teleport', workspace: '客户 B' }, { workspaces }), null);
  assert.equal(normalizeIntent(null, { workspaces }), null);
  assert.equal(normalizeIntent({ action: 'switch' }, { workspaces, current: '客户 A' }), null);
  assert.ok(INTENT_ACTIONS.every(action => normalizeIntent({ action }, { workspaces, current: '客户 A' }) !== null || action === 'switch'));
});
