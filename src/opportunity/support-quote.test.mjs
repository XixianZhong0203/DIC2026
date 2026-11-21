import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyClaims } from './claims.mjs';
import { coverageScan } from './coverage.mjs';

const resolve = (text, quote, sourceText = quote) => verifyClaims([{ id: 'signing', dimension: 'signing', text,
  items: [{ evidenceId: 'S1', stance: 'supports', quote, note: 'Synthetic support assertion.' }], missing: '', rewrite: '',
}], [{ id: 'S1', kind: 'customer', source: 'Synthetic customer email', text: sourceText }], { body: text })[0];

test('verbatim signing excerpts cannot upgrade intent, negation, questions or a different document', () => {
  const claim = 'The customer has signed the contract.';
  for (const quote of ['contract', 'The customer is interested.', 'The customer has not signed the contract yet.', 'The customer signed the NDA.', 'I would love to sign, but legal says no.', 'If the contract is signed, delivery can start.']) {
    const result = resolve(claim, quote);
    assert.notEqual(result.status, 'supported', quote);
    assert.ok(result.failedChecks.length, quote);
  }
  assert.notEqual(resolve(claim, 'signed', 'The customer signed the NDA.').status, 'supported');
  assert.notEqual(resolve(claim, 'signed the contract', 'Has the customer signed the contract?').status, 'supported');
  assert.notEqual(resolve('客户已经签约', '客户已经签约', '客户已经签约了吗？还没有。').status, 'supported');
  assert.notEqual(resolve('合同已签署', '客户愿意签约。').status, 'supported');
});

test('aligned positive and negative signing statements remain usable', () => {
  for (const quote of ['The customer signed the contract.', 'The customer has not signed the contract.', '客户已经签约。', '客户尚未签约。', 'The customer signed the NDA.', 'The customer not only signed but also delivered.']) {
    assert.equal(resolve(quote, quote).status, 'supported', quote);
  }
});

test('coverage flags quantities, currencies and certifications without flagging ordinary greetings', () => {
  for (const body of ['We migrated 120 legacy databases.', 'We save $500,000 annually.', 'We onboarded 500 new users.', 'We support over 500 integrations.', 'We hold ISO 9001 certification.', '我们获得药监三类医疗器械审批。', '我们具备三甲医院临床资质。']) {
    assert.ok(coverageScan(body, []).missed.length > 0, body);
  }
  assert.equal(coverageScan('Hello, thank you for your time.', []).missed.length, 0);
});
