import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translate } from './i18n.js';

// English-first completeness: the default locale is English, so every fixed UI phrase rendered through
// translate() must resolve to English instead of leaking the Chinese key.
test('fixed UI phrases added for the opportunity and chat surfaces resolve to English', () => {
  for (const phrase of [
    '确认来源身份',
    '客户来源支持',
    '初始来源身份已改',
    '由创始人提供，待独立核实',
    '来源未确认，待核实',
    '创始人陈述',
    '创始人逐条担保',
    '客户原文／外部记录',
    '来源未确认',
    '待处理 {n} 条',
    '还有 {n} 条被标记声明待处理。',
  ]) {
    assert.notEqual(translate('en', phrase), phrase, `an English label exists for ${phrase}`);
    assert.doesNotMatch(translate('en', phrase), /[\u4e00-\u9fff]/, `the label for ${phrase} is not Chinese`);
    assert.equal(translate('zh-CN', phrase), phrase, 'zh mode returns the product string unchanged');
  }
});

// API error translation is done in the UI layer only (server messages stay Chinese on the wire).
test('fixed API errors are translated to English', () => {
  assert.equal(translate('en', '此模型不支持该思考强度。'), 'This model does not support that thinking tier.');
  assert.equal(translate('en', '未配置模型，无法使用对话。'), 'No model is configured, so chat is unavailable.');
  assert.equal(translate('en', '来源已变更，请重新核对后确认。'), 'The sources have changed. Review again before confirming.');
  assert.equal(translate('en', '这次发送没有当时保存的档案。'), 'This send has no archive saved at that time.');
});

test('model service errors keep the upstream description attached in English', () => {
  assert.equal(translate('en', '模型服务返回 HTTP 429。请检查模型、凭证和账户配置。 上游：quota exhausted'),
    'The model service returned HTTP 429. Check your model, credentials, and account configuration. Upstream: quota exhausted');
  assert.equal(translate('en', '模型服务返回 HTTP 502。请检查模型、凭证和账户配置。'),
    'The model service returned HTTP 502. Check your model, credentials, and account configuration.');
});

test('send-gate rejections embed dynamic lists: fixed parts translate, the list stays verbatim', () => {
  const en = translate('en', '以下声明仅由创始人提供，待独立核实：交付 · 签约。请补入独立来源（如客户合同、付款或交付记录）后重新核查，或改写为有依据的说法，或逐条记录担保，再批准发送。');
  assert.ok(en.startsWith('These claims are founder-provided only and need independent verification: 交付 · 签约.'),
    'the prefix is translated and the interpolated claim list stays verbatim');
  assert.ok(en.endsWith('or record a per-claim guarantee before approving the send.'), 'the closing sentence is translated');
  assert.equal(translate('en', '上一版仍有未处理声明：我们确认周五交付'),
    'Unresolved claim(s) from an earlier draft: 我们确认周五交付');
  assert.equal(translate('en', '草稿正文仍有未确认的占位符：[日期]。请落实后再批准发送。'),
    'The draft body still has unresolved placeholders: [日期]. Resolve them before approving the send.');
});

test('untranslated phrases (supplied text) pass through unchanged in both locales', () => {
  const supplied = '客户确认周五交付。';
  assert.equal(translate('en', supplied), supplied);
  assert.equal(translate('zh-CN', supplied), supplied);
});

// Supplied text (record bodies, source names, scope names) is never translated, even when it happens to
// equal a dictionary key. app.js needs a DOM, so this guards the invariant at the source level: only fixed
// UI labels may pass through t().
test('supplied fields are rendered verbatim, not through t()', () => {
  for (const file of ['dist/app.js', 'dist/opportunity-ui.js', 'dist/decision-ui.js']) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    for (const forbidden of ['t(record.body)', 't(live.body)', 't(record.source)', 't(item.body)', 't(item.evidence)']) {
      assert.ok(!src.includes(forbidden), `${file} must not translate supplied text via ${forbidden}`);
    }
  }
});
