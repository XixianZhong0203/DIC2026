import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageScan, draftChecks, riskCategories, COVERAGE_CATEGORIES, COVERAGE_CATEGORY_LABELS } from './coverage.mjs';

// -- Draft coverage scan (Window 2): fixed sample regression --
// Scanning is deterministic (does not rely on the model): the same draft + the same batch of extracted
// claims will always yield the same report of
// "which original text segment did not enter this verification". Here, the strings of acceptance samples
// and existing regression samples are fixed
// to ensure that three types of missed extractions (multiple commitments in the same sentence /
// euphemistic date commitments / conditional approval or delivery)
// continue to be caught, while ordinary greetings and clarifying questions are not falsely reported.

// Acceptance sample: two commitments in one sentence, but the model only extracted the delivery date.
const ACCEPTANCE_BODY = '我们预计月底前交付，并承担后续三个月的免费支持。';

test('acceptance: the free-support commitment missed by the model is reported with its sentence and form', () => {
  const scan = coverageScan(ACCEPTANCE_BODY, ['月底前交付']);
  assert.equal(scan.claims.length, 1);
  assert.equal(scan.placeholders.length, 0);
  assert.equal(scan.missed.length, 1);
  assert.deepEqual(scan.missed[0], {
    text: '承担后续三个月的免费支持',
    sentence: ACCEPTANCE_BODY,
    categories: ['commitment'],
    covered: ['我们预计月底前交付'],
  });
  // Compatibility view (Window 1 sending threshold and legacy record reading shape) remains unchanged.
  assert.deepEqual(draftChecks(ACCEPTANCE_BODY, ['月底前交付']), {
    placeholders: [],
    unextracted: ['承担后续三个月的免费支持'],
  });
});

test('the two existing regression samples keep their unextracted strings', () => {
  // Chinese (existing Window 1 / claims test sample): date form matched, and no longer misjudged as
  // conditional form.
  const zh = coverageScan('我们承诺下周五前完成交付，并在两周内完成上线。', ['下周五前完成交付']);
  assert.deepEqual(draftChecks('我们承诺下周五前完成交付，并在两周内完成上线。', ['下周五前完成交付']),
    { placeholders: [], unextracted: ['在两周内完成上线'] });
  assert.equal(zh.missed.length, 1);
  assert.deepEqual(zh.missed[0].categories, ['date']);
  assert.deepEqual(zh.missed[0].covered, ['我们承诺下周五前完成交付']);
  // English (existing claims test samples): neither clause entered verification.
  assert.deepEqual(
    draftChecks('We will complete delivery by Friday, and launch within two weeks.', []).unextracted,
    ['We will complete delivery by Friday', 'launch within two weeks']);
  // Placeholder sample: placeholders are reported as usual, and risk sentences are empty.
  assert.deepEqual(draftChecks('我们承诺下周五前完成交付。费用为 [TBD] 元，稍后补上。', ['下周五前完成交付']),
    { placeholders: ['[TBD]'], unextracted: [] });
});

test('form 1: multiple commitments in one sentence — only the unextracted part is missed, the extracted part is listed as checked', () => {
  const zh = coverageScan(ACCEPTANCE_BODY, ['月底前交付']);
  assert.deepEqual(zh.missed[0].covered, ['我们预计月底前交付']);
  // When no clause in the same sentence enters verification, covered is empty.
  const alone = coverageScan(ACCEPTANCE_BODY, []);
  assert.equal(alone.missed.length, 2);
  assert.deepEqual(alone.missed.map(entry => entry.text), ['我们预计月底前交付', '承担后续三个月的免费支持']);
  assert.ok(alone.missed.every(entry => entry.covered.length === 0));
  assert.deepEqual(alone.missed[0].categories, ['date']);
  const en = coverageScan('We will deliver by end of month, and also offer free support for three months.',
    ['We will deliver by end of month']);
  assert.equal(en.missed.length, 1);
  assert.deepEqual(en.missed[0].text, 'offer free support for three months');
  assert.ok(en.missed[0].categories.includes('commitment'));
  assert.deepEqual(en.missed[0].covered, ['We will deliver by end of month']);
});

test('form 2: softened date commitments are flagged in both languages', () => {
  // Chinese: euphemism + date; direct date commitments must also be verified.
  assert.deepEqual(riskCategories('预计月底前交付'), ['date']);
  assert.deepEqual(riskCategories('争取下月上线'), ['date']);
  assert.deepEqual(riskCategories('下周五前完成交付'), ['date']);
  // English: euphemistic verb + by time; action + fronted time also matches.
  assert.deepEqual(riskCategories('We expect to deliver by end of month'), ['date']);
  assert.deepEqual(riskCategories('We will deliver by Friday'), ['date']);
  // The whole sentence/clause is reported when it does not enter verification.
  const missed = coverageScan('预计月底前交付。', []).missed;
  assert.deepEqual(missed.map(entry => entry.text), ['预计月底前交付']);
  assert.ok(missed[0].categories.includes('date'));
});

test('form 3: conditional approvals and deliveries are flagged in both languages', () => {
  // Three conditional forms in Chinese.
  assert.ok(riskCategories('如果验收通过就交付').includes('conditional'));
  assert.ok(riskCategories('需经董事会批准后生效').includes('conditional'));
  assert.ok(riskCategories('经董事会批准后交付').includes('conditional'));
  // English: Conditional bridge words and approval-type conditions with 'subject to / pending'.
  assert.ok(riskCategories('We will deliver after board approval').includes('conditional'));
  assert.ok(riskCategories('Delivery begins once the contract is signed').includes('conditional'));
  assert.ok(riskCategories('subject to board approval').includes('conditional'));
  assert.ok(riskCategories('pending payment').includes('conditional'));
  // Date expressions are not conditions: 'Complete online within two weeks' only matches the date form (a
  // false positive regression).
  assert.deepEqual(riskCategories('在两周内完成上线'), ['date']);
});

test('completed facts and figures are reported as their own forms', () => {
  assert.deepEqual(riskCategories('合同已签署'), ['fact']);
  assert.deepEqual(riskCategories('The contract has been signed.'), ['fact']);
  assert.deepEqual(riskCategories('预计提升转化率 15%'), ['figure']);
  assert.ok(riskCategories('revenue doubled').includes('figure'));
});

test('normal drafts stay clean: greetings and clarification questions never trigger', () => {
  const zh = coverageScan('您好，感谢回复。请问贵司目前的进度如何？期待您的回复。', []);
  assert.deepEqual(zh.missed, []);
  assert.deepEqual(zh.placeholders, []);
  const en = coverageScan('Hi, thanks for the reply. Could you confirm the timeline?', []);
  assert.deepEqual(en.missed, []);
  // Interrogative guard: Clarification questions containing dates and actions do not enter high-risk
  // scanning.
  assert.deepEqual(coverageScan('请问能否在下周完成？', []).missed, []);
  assert.deepEqual(coverageScan('Can you confirm by Friday?', []).missed, []);
});

test('the coverage view shapes stay stable', () => {
  // Category codes are stable stored values, labels are display values; the code set is fixed.
  assert.deepEqual(COVERAGE_CATEGORIES, ['fact', 'commitment', 'date', 'conditional', 'figure']);
  assert.deepEqual(Object.values(COVERAGE_CATEGORY_LABELS).every(value => value.length > 0), true);
  // The matched text is always a verbatim snippet of the draft original text, and the containing sentence
  // is a complete sentence.
  const scan = coverageScan(ACCEPTANCE_BODY, ['月底前交付']);
  for (const entry of scan.missed) {
    assert.ok(ACCEPTANCE_BODY.includes(entry.text));
    assert.ok(entry.sentence.length > entry.text.length);
    assert.ok(entry.sentence.includes(entry.text));
  }
  // Uncovered and risk-free clauses are not reported.
  assert.deepEqual(coverageScan('谢谢，期待与您合作。', []).missed, []);
});
