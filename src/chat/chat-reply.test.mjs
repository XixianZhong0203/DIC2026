import test from 'node:test';
import assert from 'node:assert/strict';
import { chatReplySystem } from './chat-reply.mjs';

const ACTIVE = [
  { id: 1, kind: 'fact', scope: 'Client A', applies_to: 'Client A', source: 'Client email', body: 'Friday was confirmed.' },
];
const DECISIONS = {
  lines: ['- Confirm the move · Applied (local data changed) · User chose: Move to Friday'],
  temporary: 'Use English only for this reply.',
};

test('the English locale receives fully English chat instructions', () => {
  const system = chatReplySystem({
    language: 'en', active: ACTIVE, decisions: DECISIONS, release: 'r2', verified: true,
  });
  assert.ok(system.startsWith('You are Daymark'), 'English header');
  assert.ok(system.includes('Answer in English'), 'answer language instruction');
  assert.ok(!/[\u4e00-\u9fff]/u.test(system), 'no Chinese instruction text in the English prompt');
  for (const field of ['answer', 'facts', 'inferences', 'unknowns', 'citations', 'conflict', 'proposal', 'question', 'understood']) {
    assert.ok(system.includes(field), 'structured field ' + field);
  }
  assert.ok(system.includes('"version":"r2"') && system.includes('"verified":true'), 'release status');
  assert.ok(system.includes('"applies_to":"Client A"'), 'record provenance');
  assert.ok(system.includes('Records: ' + JSON.stringify(ACTIVE)), 'records marker and data');
  assert.ok(system.includes('Selected pending confirmation') && system.includes('One-turn exception'),
    'decision-card state rules');
  assert.ok(system.includes(DECISIONS.lines[0]) && system.includes(DECISIONS.temporary));
});

test('the Chinese locale keeps the original header, rules, and record marker', () => {
  const system = chatReplySystem({
    language: 'zh-CN', active: ACTIVE, decisions: DECISIONS, release: 'r2', verified: true,
  });
  assert.ok(system.startsWith('你是 Daymark，一个帮助个人接续项目的队友'), 'original Chinese header');
  assert.ok(system.includes('请优先使用中文回答'), 'answer language instruction');
  assert.ok(system.includes('applies_to'), 'applicability boundary');
  assert.ok(system.includes('已选待确认') && system.includes('仅本次例外'), 'decision-card state rules');
  assert.ok(system.includes('记录：' + JSON.stringify(ACTIVE)), 'records marker and data');
  assert.ok(system.includes('当前结构化发布状态：'), 'release status');
});

test('the chat prompt works without decision context', () => {
  const en = chatReplySystem({ language: 'en', active: [], release: 'r1' });
  const zh = chatReplySystem({ language: 'zh-CN', active: [], release: 'r1' });
  assert.ok(!en.includes('User choices on decision cards'));
  assert.ok(!zh.includes('用户在决策卡中的选择'));
  assert.ok(en.includes('"verified":false'));
  assert.ok(en.includes('even when unrelated to this workspace'));
  assert.ok(en.includes('Never invent memory citations'));
  assert.ok(zh.includes('即使问题与当前工作区无关'));
  assert.ok(zh.includes('不得编造记忆引用'));
});
