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

  // Under sequential approval mode (send defaults to approval): returns 409 when the current draft lacks
  // verification or manual review.
  assert.throws(() => call('opportunity-send', { id, draft_id }),
    { status: 409, message: '草稿声明尚未核查。请先核查关键声明，或针对当前草稿记录人工复核结论。' });
  assert.equal(JSON.parse(state().audit.find(event => event.action === 'blocked').detail).reason, 'claims_not_verified');

  // First satisfy the verification conditions of the current version: draft declarations are fully
  // supported, and results are bound to the current draft version.
  await call('opportunity-claims', { id, target: 'draft', language: 'en' });
  assert.equal(item().claimsStale, false);

  // Counterexample: Same action unauthorized (send mode = human) -> 409 blocked. Verification conditions
  // are already met, so the block reason can only be the authorization mode itself - exactly the behavior
  // the delegation mode tests.
  call('delegation', { action: 'send', mode: 'human' });
  assert.throws(() => call('opportunity-send', { id, draft_id }),
    { status: 409, message: '当前授权不允许此操作。' });
  const blocked = state().audit.find(event => JSON.parse(event.detail).mode === 'human');
  assert.ok(blocked);
  assert.equal(item().sent, 0);

  // Positive example: Same action re-authorized (send mode = approval) -> User approves current draft,
  // genuinely triggering simulated send.
  call('delegation', { action: 'send', mode: 'approval' });
  call('opportunity-send', { id, draft_id });
  assert.equal(item().sent, 1);
  const approved = state().audit.find(event => event.action === 'approved');
  assert.equal(JSON.parse(approved.detail).evidence, 'model_supported');
});
