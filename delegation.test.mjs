import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { opportunityWorkflow } from './opportunities.mjs';

function fixture(complete) {
  const db = new DatabaseSync(':memory:');
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const required = (value, length) => {
    if (typeof value !== 'string' || !value.trim() || value.length > length) fail(400, '请检查输入内容。');
    return value.trim();
  };
  const workflow = opportunityWorkflow(db, { complete, model: 'test double', fail, required });
  const call = (action, body) => workflow.mutations['/api/' + action](body);
  return { call, state: workflow.state };
}

// Fixture assess: returns supported with the full evidence as quote, so the
// verbatim-quote guard admits it and the send evidence gate is satisfied.
const assessSupported = async messages => {
  const input = JSON.parse(messages.at(-1).content);
  return JSON.stringify({ status: 'supported', quote: input.evidence, reason: 'fixture: sufficient',
    unknown: '', conflict: '', clarification: '', suggestedReply: '' });
};

test('the same send action is blocked while unauthorized and completes once the mode authorizes it', async () => {
  const { call, state } = fixture(assessSupported);
  call('opportunity', { kind: 'lead', title: 'Send gate', source: 'Round 1 synthetic case',
    evidence: 'E1: Both parties explicitly accepted Friday as the delivery date.' });
  const item = () => state().opportunities[0];
  await call('opportunity-assess', { id: item().id, request: 'Can we confirm the date?', language: 'en' });
  call('opportunity-draft', { id: item().id, recipient: 'client@example.test', body: 'Draft for simulation.' });
  const draft_id = item().draft_id;

  // 反例：同一动作未授权（send 模式=human）→ 409 拦截，无效果
  call('delegation', { action: 'send', mode: 'human' });
  assert.throws(() => call('opportunity-send', { id: item().id, draft_id }), { status: 409 });
  assert.ok(state().audit.some(e => e.action === 'blocked'));
  assert.equal(item().sent, 0);

  // 正例：同一动作重新授权（send 模式=approval）→ 真正产生模拟发送
  call('delegation', { action: 'send', mode: 'approval' });
  call('opportunity-send', { id: item().id, draft_id });
  assert.equal(item().sent, 1);
  assert.deepEqual(state().audit.slice(0, 2).map(e => e.action), ['simulated_send', 'approved']);
});
