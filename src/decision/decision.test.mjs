import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTimes, extractDates, nextDayKey, slotPreview, buildDecision, detectDecision, decisionContext,
} from './decision.mjs';

const memory = (id, kind, body, extra = {}) => ({
  id, kind, scope: 'DIC2026', source: '测试', body, superseded: false, replaces: null, ...extra,
});
const task = (id, title, starts, ends, extra = {}) => ({
  id, title, starts, ends, memory_id: null, done: 0, all_day: 0, location: '', notes: '', revision: 0, deleted: 0, ...extra,
});
const review = (extra = {}) => ({
  answer: '答复', conflict: '', question: '', understood: '', plain: false,
  evidence: 'verbatim', facts: [], inferences: [], unknowns: [], cited: [], trace: null, ...extra,
});

test('extractTimes keeps only real datetimes', () => {
  assert.deepEqual(extractTimes('改到 2026-11-14 15:30，另 2026-13-40 09:00 无效', '2026-11-12T09:00'),
    ['2026-11-14T15:30', '2026-11-12T09:00']);
  assert.deepEqual(extractTimes('没有任何时间'), []);
});

test('extractDates and nextDayKey', () => {
  assert.deepEqual(extractDates('新日期 2026-11-14 或者 2026-02-30'), ['2026-11-14']);
  assert.equal(nextDayKey('2026-11-30'), '2026-12-01');
});

test('slotPreview detects overlaps against other events', () => {
  const tasks = [
    task(1, '甲', '2026-11-14T14:00', '2026-11-14T15:00'),
    task(2, '乙', '2026-11-14T16:00', '2026-11-14T17:00'),
    task(3, '丙', '2026-11-15T10:00', '2026-11-15T11:00'),
    task(4, '丁', '2026-11-14T10:00', '2026-11-14T11:00', { done: 1 }),
  ];
  const busy = slotPreview(tasks, '2026-11-14T14:30', '2026-11-14T16:30', 1);
  assert.equal(busy.conflict, true);
  assert.deepEqual(busy.events.map(event => event.id), [2]);
  const free = slotPreview(tasks, '2026-11-14T17:30', '2026-11-14T18:00', null);
  assert.equal(free.conflict, false);
});

test('buildDecision normalizes the handoff payload', () => {
  const decision = buildDecision({
    kind: 'preference',
    current: '当前有效决定',
    proposal: '新提议',
    recordIds: [2, 99, null, 1],
    records: [{ id: 2, kind: 'preference', source: '来源', body: '内容' }],
    asks: [{
      title: '标题',
      reason: '原因',
      options: [
        { label: '选项一', consequence: '结果一', effect: { kind: 'temporary', payload: { text: 'x' } } },
        { label: '选项二', effect: { kind: 'memory', payload: {} } },
      ],
    }],
  });
  assert.equal(decision.kind, 'preference');
  assert.equal(decision.title, '标题');
  assert.equal(decision.reason, '原因');
  assert.deepEqual(decision.records.map(record => record.id), [2]);
  assert.deepEqual(decision.options.map(option => option.id), ['option-1', 'option-2']);
  assert.equal(decision.status, 'open');
  assert.equal(decision.choice, null);
  assert.throws(() => buildDecision({ kind: 'preference', options: [] }), /at least one option/);
  assert.throws(() => buildDecision({ kind: 'bogus' }), /kind/);
});

test('detectDecision: reschedule with a new time on the calendar', () => {
  const tasks = [task(7, '客户会议', '2026-11-13T15:00', '2026-11-13T16:30', { memory_id: 3, revision: 2 })];
  const memories = [memory(3, 'source', '客户会议 11-13 15:00')];
  const decision = detectDecision({
    question: '客户改期了，会议挪到 2026-11-14 15:30',
    review: review({ understood: '把客户会议改到 2026-11-14 15:30' }),
    tasks, memories,
  });
  assert.equal(decision.kind, 'reschedule');
  assert.match(decision.current, /客户会议/);
  const change = decision.options.find(option => option.id === 'reschedule');
  assert.equal(change.effect.kind, 'task');
  assert.equal(change.effect.payload.id, 7);
  assert.equal(change.effect.payload.revision, 2);
  assert.equal(change.effect.payload.starts, '2026-11-14T15:30');
  assert.equal(change.effect.payload.ends, '2026-11-14T17:00'); // keeps the 90-minute span
  assert.equal(change.preview.conflict, false);
});

test('detectDecision: reschedule preview flags an overlapping event', () => {
  const tasks = [
    task(7, '客户会议', '2026-11-13T15:00', '2026-11-13T16:30'),
    task(8, '评审', '2026-11-14T16:00', '2026-11-14T17:00'),
  ];
  const decision = detectDecision({
    question: '客户会议改到 2026-11-14 15:30',
    review: review(),
    tasks, memories: [],
  });
  const change = decision.options.find(option => option.id === 'reschedule');
  assert.equal(change.preview.conflict, true);
  assert.deepEqual(change.preview.events.map(event => event.id), [8]);
});

test('detectDecision: date-only reschedule offers the calendar view', () => {
  const tasks = [task(7, '客户会议', '2026-11-13T15:00', '2026-11-13T16:30')];
  const decision = detectDecision({
    question: '客户把会议改到 2026-11-14 了，具体时间还没定',
    review: review(),
    tasks, memories: [],
  });
  assert.equal(decision.kind, 'reschedule');
  const calendar = decision.options.find(option => option.id === 'calendar');
  assert.equal(calendar.effect.kind, 'view');
  assert.equal(calendar.effect.payload.calendar, '2026-11-14');
  assert.equal(calendar.preview.date, '2026-11-14');
});

test('detectDecision: no card when a time is mentioned but no task is involved', () => {
  assert.equal(detectDecision({
    question: '听说 2026-11-14 15:30 有活动',
    review: review(),
    tasks: [task(7, '客户会议', '2026-11-13T15:00', '2026-11-13T16:30')],
    memories: [],
  }), null);
});

test('detectDecision: preference conflict offers once / long-term options', () => {
  const memories = [
    memory(4, 'preference', '回复客户邮件用中文'),
    memory(5, 'rule', '对外沟通先确认收件人'),
  ];
  const decision = detectDecision({
    question: '今天这封客户邮件用英文写',
    review: review({ conflict: '长期偏好要求用中文回复客户，与本次英文请求冲突' }),
    tasks: [], memories,
  });
  assert.equal(decision.kind, 'preference');
  assert.match(decision.current, /#4/);
  const once = decision.options.find(option => option.id === 'once');
  assert.equal(once.effect.kind, 'temporary');
  assert.equal(once.effect.payload.text, '今天这封客户邮件用英文写');
  const longTerm = decision.options.find(option => option.id === 'longterm');
  assert.equal(longTerm.effect.kind, 'memory');
  assert.equal(longTerm.effect.payload.replaces, 4);
  assert.equal(longTerm.effect.payload.kind, 'preference');
  assert.equal(longTerm.effect.payload.body, '今天这封客户邮件用英文写');
  assert.ok(longTerm.preview.impact.some(record => record.id === 5));
});

test('detectDecision: preference conflict offers keep-both as an independent save', () => {
  const memories = [
    memory(4, 'preference', '回复客户邮件用中文'),
    memory(5, 'rule', '对外沟通先确认收件人'),
  ];
  const decision = detectDecision({
    question: '以后这个客户的邮件都用英文',
    review: review({ conflict: '长期偏好要求用中文回复客户，与新的英文请求冲突' }),
    tasks: [], memories,
  });
  assert.equal(decision.kind, 'preference');
  const ids = decision.options.map(option => option.id);
  assert.ok(ids.includes('once') && ids.includes('keepboth') && ids.includes('longterm'));
  const keepBoth = decision.options.find(option => option.id === 'keepboth');
  assert.equal(keepBoth.effect.kind, 'memory');
  // Keep-both stores the new record without replacing the anchored one.
  assert.equal(keepBoth.effect.payload.replaces, undefined);
  assert.equal(keepBoth.effect.payload.kind, 'preference');
  assert.ok(keepBoth.consequence.includes('#4'));
  assert.ok(keepBoth.preview.impact.some(record => record.id === 5));
});

test('detectDecision: a rule anchor keeps the rule type in the update options', () => {
  const memories = [memory(4, 'rule', '回复客户邮件用中文')];
  const decision = detectDecision({
    question: '以后这个客户的邮件都用英文',
    review: review({ conflict: '已确认规则要求用中文回复客户，与新的英文请求冲突' }),
    tasks: [], memories,
  });
  assert.equal(decision.kind, 'preference');
  for (const id of ['keepboth', 'longterm']) {
    const option = decision.options.find(item => item.id === id);
    assert.equal(option.effect.payload.kind, 'rule');
  }
  assert.equal(decision.options.find(option => option.id === 'longterm').effect.payload.replaces, 4);
});

test('detectDecision: an unrelated conflict does not create a preference card', () => {
  const decision = detectDecision({
    question: '这两份资料的数据对不上',
    review: review({ conflict: '资料 #1 与 #2 的数字矛盾', evidence: 'cited' }),
    tasks: [], memories: [memory(4, 'preference', '回复客户邮件用中文')],
  });
  assert.equal(decision, null);
});

test('detectDecision: uncited reply with a gap offers source review and a draft', () => {
  const decision = detectDecision({
    question: '客户上次说预算大概多少？',
    review: review({
      evidence: 'uncited',
      question: '需要确认客户提到的预算区间是多少。',
      unknowns: ['预算区间', '币种'],
      cited: [{ id: 6, kind: 'source', source: '邮件', body: '原文' }],
      trace: { retrieved: [{ id: 6, kind: 'source', source: '邮件' }] },
    }),
    tasks: [], memories: [memory(6, 'source', '原文')],
  });
  assert.equal(decision.kind, 'clarify');
  assert.equal(decision.options[0].effect.kind, 'view');
  assert.equal(decision.options[1].effect.kind, 'question');
  assert.equal(decision.options[1].effect.payload.text, '需要确认客户提到的预算区间是多少。');
  assert.deepEqual(decision.records.map(record => record.id), [6]);
});

test('detectDecision: verbatim replies never create a clarify card', () => {
  assert.equal(detectDecision({
    question: '现在什么进度？',
    review: review({ unknowns: ['部署时间'] }),
    tasks: [], memories: [],
  }), null);
});

test('decisionContext: confirmed choices become model context', () => {
  const messages = [
    { id: 1, role: 'user', review: null, body: 'q1' },
    { id: 2, role: 'assistant', review: { decision: {
      title: '改期确认', status: 'applied',
      options: [{ id: 'reschedule', label: '改到 15:30' }],
      choice: { option_id: 'reschedule', at: 't', receipt: '事件已更新' },
    } } },
    { id: 3, role: 'user', review: null, body: 'q2' },
    { id: 4, role: 'assistant', review: { decision: {
      title: '偏好冲突', status: 'applied',
      options: [{ id: 'once', label: '仅本次' }],
      choice: { option_id: 'once', at: 't', receipt: '已记录', temporary: true, temporary_text: '今天用英文' },
    } } },
  ];
  const context = decisionContext(messages);
  assert.equal(context.lines.length, 2);
  assert.match(context.lines[0], /改期确认 · 用户选择了：改到 15:30 · 结果：事件已更新/);
  assert.equal(context.temporary, '今天用英文'); // the last choice sits after the last user message
});

test('decisionContext: a one-turn exception expires once the user sends another message', () => {
  const messages = [
    { id: 1, role: 'user', review: null, body: 'q1' },
    { id: 2, role: 'assistant', review: { decision: {
      title: '偏好冲突', status: 'applied',
      options: [{ id: 'once', label: '仅本次' }],
      choice: { option_id: 'once', at: 't', receipt: '', temporary: true, temporary_text: '今天用英文' },
    } } },
    { id: 3, role: 'user', review: null, body: 'q2' },
  ];
  assert.equal(decisionContext(messages).temporary, '');
});

test('detectDecision: reschedule wins over preference when both could fire', () => {
  const decision = detectDecision({
    question: '客户会议改到 2026-11-14 15:30',
    review: review({ conflict: '与长期偏好冲突' }),
    tasks: [task(7, '客户会议', '2026-11-13T15:00', '2026-11-13T16:30')],
    memories: [memory(4, 'preference', '客户会议相关偏好')],
  });
  assert.equal(decision.kind, 'reschedule');
});
