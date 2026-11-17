import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_VERSION, matchClaimRewrite } from './claim-match.mjs';

// Window 1 acceptance verification: Flagged original sentence from old version vs. new body text.
// Verbatim preserved -> verbatim; synonymous rewrite is still the same fact -> same_fact; rewritten into a
// different fact -> different_fact;
// Unable to determine if it is the same fact -> ambiguous; original sentence disappeared and no candidate
// from the same action family -> absent.

test('the old sentence still verbatim in the body wins over everything (salutation change keeps the flag)', () => {
  const result = matchClaimRewrite('合同已签署', '王经理：合同已签署，请查收。');
  assert.equal(result.verdict, 'verbatim');
  assert.deepEqual(result.candidates, []);
});

test('a near-synonym rewrite of a completed fact stays the same fact', () => {
  const result = matchClaimRewrite('合同已签署', '双方已完成签约。');
  assert.equal(result.verdict, 'same_fact');
  assert.ok(result.candidates.some(candidate => candidate.relation === 'same_fact'
    && candidate.sentence === '双方已完成签约。'));
  assert.equal(result.candidates[0].aspects.signing.old, 'completed');
  assert.equal(result.candidates[0].aspects.signing.next, 'completed');
});

test('rewriting a completed fact into an intent statement is a different fact', () => {
  const result = matchClaimRewrite('合同已签署', '客户已表达签约意向。');
  assert.equal(result.verdict, 'different_fact');
  assert.equal(result.candidates[0].aspects.signing.next, 'intent');
});

test('a scheduled signing (no completion marker) against a completed claim is ambiguous', () => {
  const result = matchClaimRewrite('合同已签署', '双方下周签约。');
  assert.equal(result.verdict, 'ambiguous');
  assert.equal(result.candidates[0].aspects.signing.next, 'unknown');
});

test('negating the old fact is a different fact', () => {
  assert.equal(matchClaimRewrite('合同已签署', '双方尚未签约。').verdict, 'different_fact');
  assert.equal(matchClaimRewrite('合同已签署', '双方没有签约。').verdict, 'different_fact');
  assert.equal(matchClaimRewrite('合同已签署', '双方未签约。').verdict, 'different_fact');
  assert.equal(matchClaimRewrite('客户已签约', '客户不愿签约。').verdict, 'different_fact');
});

test('the same intent fact rewritten stays the same fact; negating it is different', () => {
  assert.equal(matchClaimRewrite('客户已表达签约意向', '客户明确表达了签约意向。').verdict, 'same_fact');
  assert.equal(matchClaimRewrite('客户已表达签约意向', '客户尚未表达签约意向。').verdict, 'different_fact');
});

test('an unparseable old sentence falls back to shared content words (ambiguous, never auto-released)', () => {
  assert.equal(matchClaimRewrite('报价单已发送', '报价单已发出。').verdict, 'ambiguous');
  assert.equal(matchClaimRewrite('报价单已发送', '报价单发出时间为周几，请确认。').verdict, 'ambiguous');
  // No shared content words and no action family -> absent.
  assert.equal(matchClaimRewrite('报价单已发送', '后续安排另行沟通。').verdict, 'absent');
});

test('a deleted sentence with no same-family candidate is absent', () => {
  const result = matchClaimRewrite('合同已签署', '我们下周再谈细节。');
  assert.equal(result.verdict, 'absent');
  assert.deepEqual(result.candidates, []);
});

test('cross-language matching works through the shared family labels', () => {
  assert.equal(matchClaimRewrite('The contract is signed.', 'The contract has been signed.').verdict, 'same_fact');
  assert.equal(matchClaimRewrite('The contract is signed.', 'The customer expressed intent to sign the contract.').verdict, 'different_fact');
  assert.equal(matchClaimRewrite('The contract is signed.', 'The parties have not signed the contract.').verdict, 'different_fact');
  assert.equal(matchClaimRewrite('The contract is signed.', 'The parties will sign next week.').verdict, 'ambiguous');
  assert.equal(matchClaimRewrite('合同已签署', 'The contract has been signed.').verdict, 'same_fact');
});

test('claims with no recognizable fact family and no overlap are absent, not ambiguous', () => {
  assert.equal(matchClaimRewrite('合同已签署', '我们会继续提供服务。').verdict, 'absent');
  assert.equal(matchClaimRewrite('合同已签署', '').verdict, 'absent');
  assert.equal(matchClaimRewrite('', '合同已签署。').verdict, 'absent');
});

test('the match version is stable for review bindings', () => {
  assert.equal(MATCH_VERSION, 'claim-match-v1');
});
