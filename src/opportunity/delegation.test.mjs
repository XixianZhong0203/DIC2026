import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { opportunityWorkflow } from './opportunities.mjs';

const EVIDENCE = 'E1: Both parties explicitly accepted Friday as the delivery date.';

// complete receives the parsed user JSON of the last message; claims calls carry a `mode` field.
function fixture(complete) {
  const db = new DatabaseSync(':memory:');
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const required = (value, length) => {
    if (typeof value !== 'string' || !value.trim() || value.length > length) fail(400, '请检查输入内容。');
    return value.trim();
  };
  const workflow = opportunityWorkflow(db, {
    complete: async messages => complete(JSON.parse(messages.at(-1).content)),
    model: 'test double', fail, required,
  });
  const call = (action, body) => workflow.mutations['/api/' + action](body);
  return { call, state: workflow.state };
}

// A supported claim whose quote occurs verbatim in the lead evidence (E1).
const supportedClaim = text => JSON.stringify({ claims: [{
  id: 'delivery', dimension: '对外承诺', text,
  items: [{ evidenceId: 'E1', stance: 'supports', quote: EVIDENCE, note: 'explicit acceptance' }],
  missing: '', rewrite: '',
}]});

test('the same send action is blocked while unauthorized and completes once the mode authorizes it', async () => {
  const { call, state } = fixture(user => user.mode
    ? supportedClaim('We can deliver on Friday.')
    : JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'fixture: sufficient',
      unknown: '', conflict: '', clarification: '', suggestedReply: '' }));
  call('opportunity', { kind: 'lead', title: 'Send gate', source: 'Round 1 synthetic case', evidence: EVIDENCE,
    evidence_kind: 'customer' });
  const item = () => state().opportunities[0];
  const id = item().id;
  await call('opportunity-assess', { id, request: 'Can we confirm the date?', language: 'en' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We can deliver on Friday.' });
  const draft_id = item().draft_id;

  // 逐次审批模式下（send 默认 approval）：当前草稿缺少核查或人工复核时返回 409
  assert.throws(() => call('opportunity-send', { id, draft_id }),
    { status: 409, message: '草稿声明尚未核查。请先核查关键声明，或针对当前草稿记录人工复核结论。' });
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'blocked').detail).reason, 'claims_not_verified');

  // 先满足当前版本的核查条件：草稿声明全部支持，且结果绑定当前草稿版本
  await call('opportunity-claims', { id, target: 'draft', language: 'en' });
  assert.equal(item().claimsStale, false);

  // 反例：同一动作未授权（send 模式=human）→ 409 拦截。核查条件已满足，
  // 所以拦截原因只能是授权模式本身——这正是委托模式要测的行为。
  call('delegation', { action: 'send', mode: 'human' });
  assert.throws(() => call('opportunity-send', { id, draft_id }),
    { status: 409, message: '当前授权不允许此操作。' });
  const blocked = state().audit.find(event => JSON.parse(event.detail).mode === 'human');
  assert.ok(blocked);
  assert.equal(item().sent, 0);

  // 正例：同一动作重新授权（send 模式=approval）→ 由用户批准当前草稿，真正产生模拟发送
  call('delegation', { action: 'send', mode: 'approval' });
  call('opportunity-send', { id, draft_id });
  assert.equal(item().sent, 1);
  const approved = state().audit.find(event => event.action === 'approved');
  assert.equal(JSON.parse(approved.detail).evidence, 'model_supported');
});
