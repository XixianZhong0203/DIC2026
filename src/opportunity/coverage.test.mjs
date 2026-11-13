import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageScan, draftChecks, riskCategories, COVERAGE_CATEGORIES, COVERAGE_CATEGORY_LABELS } from './coverage.mjs';

// —— 草稿覆盖扫描（窗口 2）：固定样例回归 ——
// 扫描是确定性的（不依赖模型）：同一草稿 + 同一批已抽取声明，永远得到同一份
// 「哪段原文没有进入本次核查」的报告。这里固定验收样例与既有回归样例的字符串，
// 保证三类漏抽（同一句里的多项承诺 / 委婉表述的日期承诺 / 附带条件的批准或交付）
// 持续被抓住，而普通问候与澄清问题不被误报。

// 验收样例：一句里两项承诺，模型只抽了交付日期。
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
  // 兼容视图（窗口 1 发送门槛与旧记录读取的形状）保持不变。
  assert.deepEqual(draftChecks(ACCEPTANCE_BODY, ['月底前交付']), {
    placeholders: [],
    unextracted: ['承担后续三个月的免费支持'],
  });
});

test('the two existing regression samples keep their unextracted strings', () => {
  // 中文（既有窗口 1 / claims 测试样例）：日期形式命中，且不再误判为条件形式。
  const zh = coverageScan('我们承诺下周五前完成交付，并在两周内完成上线。', ['下周五前完成交付']);
  assert.deepEqual(draftChecks('我们承诺下周五前完成交付，并在两周内完成上线。', ['下周五前完成交付']),
    { placeholders: [], unextracted: ['在两周内完成上线'] });
  assert.equal(zh.missed.length, 1);
  assert.deepEqual(zh.missed[0].categories, ['date']);
  assert.deepEqual(zh.missed[0].covered, ['我们承诺下周五前完成交付']);
  // 英文（既有 claims 测试样例）：两个分句都未进入核查。
  assert.deepEqual(
    draftChecks('We will complete delivery by Friday, and launch within two weeks.', []).unextracted,
    ['We will complete delivery by Friday', 'launch within two weeks']);
  // 占位符样例：占位符照旧上报，风险句为空。
  assert.deepEqual(draftChecks('我们承诺下周五前完成交付。费用为 [TBD] 元，稍后补上。', ['下周五前完成交付']),
    { placeholders: ['[TBD]'], unextracted: [] });
});

test('form 1: multiple commitments in one sentence — only the unextracted part is missed, the extracted part is listed as checked', () => {
  const zh = coverageScan(ACCEPTANCE_BODY, ['月底前交付']);
  assert.deepEqual(zh.missed[0].covered, ['我们预计月底前交付']);
  // 同句里没有任何分句进入核查时，covered 为空。
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
  // 中文：委婉词 + 日期；直接日期承诺同样要核查。
  assert.deepEqual(riskCategories('预计月底前交付'), ['date']);
  assert.deepEqual(riskCategories('争取下月上线'), ['date']);
  assert.deepEqual(riskCategories('下周五前完成交付'), ['date']);
  // 英文：委婉动词 + by 时间；动作 + 时间前置同样命中。
  assert.deepEqual(riskCategories('We expect to deliver by end of month'), ['date']);
  assert.deepEqual(riskCategories('We will deliver by Friday'), ['date']);
  // 未进入核查时整句/分句被报告。
  const missed = coverageScan('预计月底前交付。', []).missed;
  assert.deepEqual(missed.map(entry => entry.text), ['预计月底前交付']);
  assert.ok(missed[0].categories.includes('date'));
});

test('form 3: conditional approvals and deliveries are flagged in both languages', () => {
  // 中文三种条件形式。
  assert.ok(riskCategories('如果验收通过就交付').includes('conditional'));
  assert.ok(riskCategories('需经董事会批准后生效').includes('conditional'));
  assert.ok(riskCategories('经董事会批准后交付').includes('conditional'));
  // 英文：条件桥接词与「subject to / pending」批准类条件。
  assert.ok(riskCategories('We will deliver after board approval').includes('conditional'));
  assert.ok(riskCategories('Delivery begins once the contract is signed').includes('conditional'));
  assert.ok(riskCategories('subject to board approval').includes('conditional'));
  assert.ok(riskCategories('pending payment').includes('conditional'));
  // 日期表述不是条件：「在两周内完成上线」只命中日期形式（既有误报回归）。
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
  // 疑问句守卫：含日期与动作的澄清问题不进高风险扫描。
  assert.deepEqual(coverageScan('请问能否在下周完成？', []).missed, []);
  assert.deepEqual(coverageScan('Can you confirm by Friday?', []).missed, []);
});

test('the coverage view shapes stay stable', () => {
  // 类别代码是稳定存储值，标签是展示值；代码集合固定。
  assert.deepEqual(COVERAGE_CATEGORIES, ['fact', 'commitment', 'date', 'conditional', 'figure']);
  assert.deepEqual(Object.values(COVERAGE_CATEGORY_LABELS).every(value => value.length > 0), true);
  // 命中文本永远是草稿原文的逐字片段，所在原句是完整句子。
  const scan = coverageScan(ACCEPTANCE_BODY, ['月底前交付']);
  for (const entry of scan.missed) {
    assert.ok(ACCEPTANCE_BODY.includes(entry.text));
    assert.ok(entry.sentence.length > entry.text.length);
    assert.ok(entry.sentence.includes(entry.text));
  }
  // 未覆盖且无风险的分句不上报。
  assert.deepEqual(coverageScan('谢谢，期待与您合作。', []).missed, []);
});
