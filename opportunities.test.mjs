import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { opportunityWorkflow } from './opportunities.mjs';

function fixture(complete) {
  const db = new DatabaseSync(':memory:');
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const required = value => value?.trim() || fail(400, 'Required');
  const workflow = opportunityWorkflow(db, { complete, model: 'test double', fail, required });
  const call = (action, body) => workflow.mutations['/api/' + action](body);
  call('opportunity', { kind: 'lead', title: 'Delivery check', source: 'Client thread', evidence: 'Friday was proposed only.' });
  const current = () => workflow.state().opportunities[0];
  return { call, current, state: workflow.state };
}

test('uncertainty blocks sending until a human records how to resolve it', async () => {
  const { call, current, state } = fixture(async () => JSON.stringify({
    status: 'supported', quote: 'Friday was confirmed.', reason: 'Friday delivery',
  }));
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  const analysis = JSON.parse(current().analysis);
  assert.equal(analysis.status, 'unknown');
  assert.equal(analysis.validQuote, false);
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'Could you confirm the date?' });
  const draft_id = current().draft_id;
  assert.throws(() => call('opportunity-send', { id, draft_id }), { status: 409 });
  assert.throws(() => call('opportunity-review', { id, analysis_id: 'old', resolution: 'Clarify the date.' }), { status: 409 });
  call('opportunity-review', { id, analysis_id: analysis.analysisId, resolution: 'The draft asks for clarification.' });
  call('opportunity-send', { id, draft_id });
  call('opportunity-send', { id, draft_id });
  assert.deepEqual(state().audit.slice(0, 3).map(event => event.action),
    ['simulated_send', 'approved', 'human_reviewed']);
});

test('a failed model run records the failed case without scoring it', async () => {
  const { call, state } = fixture(async () => { throw Object.assign(new Error('HTTP 401'), { status: 502 }); });
  await call('opportunity-benchmark', { language: 'en' });
  assert.equal(state().benchmark.complete, false);
  assert.equal(state().benchmark.results[0].statusMatched, null);
  assert.equal(state().benchmark.results[0].error, 'HTTP 401');
});
