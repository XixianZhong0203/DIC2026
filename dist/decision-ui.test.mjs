import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionUI } from './decision-ui.js';

// 用最小假 DOM 驱动真实决策卡 UI：确认改期后，卡片要能看到原时间、新时间
// （回执）和实际结果，并能找到对应待办（「查看待办」按钮）。
function harness() {
  const calls = { jumpToTask: [] };
  const element = (tag, text = '', className = '') => {
    const node = { tag, text, className, children: [],
      append(...kids) { this.children.push(...kids); },
      replaceChildren(...kids) { this.children = [...kids]; },
      setAttribute() {}, classList: { add() {}, remove() {} },
    };
    return node;
  };
  const parent = () => ({ children: [], append(...kids) { this.children.push(...kids); } });
  const action = (label, callback) => {
    const button = element('button', label);
    button.onclick = () => callback();
    button.click = () => button.onclick();
    return button;
  };
  const render = createDecisionUI({
    t: key => key, element, action,
    request: async () => {},
    fetchResult: async () => ({}),
    language: () => 'en',
    openSources: () => {}, copyText: () => {}, fillComposer: () => {},
    jumpToCalendar: () => {},
    jumpToTask: id => calls.jumpToTask.push(id),
  });
  const message = decision => ({ id: 1, role: 'assistant', review: { answer: '请确认。', decision } });
  return { render, message, calls, parent };
}

function find(parent, predicate) {
  const walk = node => {
    if (predicate(node)) return node;
    for (const kid of node.children ?? []) {
      const hit = walk(kid);
      if (hit) return hit;
    }
    return null;
  };
  return walk(parent);
}

const decision = (overrides = {}) => ({
  kind: 'reschedule', title: '确认改期 "客户交付"',
  current: '当前安排：客户交付 · 2026-11-13 15:00 → 2026-11-13 16:30',
  reason: '', proposal: '', records: [],
  options: [
    { id: 'keep', label: '保持原时间', consequence: '', preview: null, effect: { kind: 'view', payload: { calendar: '2026-11-13' } } },
    { id: 'reschedule', label: '改到 2026-11-14 15:30', consequence: '', preview: null,
      effect: { kind: 'task', payload: { id: 7, revision: 3, title: '客户交付', starts: '2026-11-14T15:30', ends: '2026-11-14T17:00' } } },
  ],
  status: 'open', choice: null,
  ...overrides,
});

test('a confirmed reschedule shows the receipt (original/new time, result) and a jump to the task', () => {
  const { render, message, calls, parent } = harness();
  const receipt = '事件已更新 · 客户交付 · 原 2026-11-13 15:00 → 2026-11-13 16:30 · 新 2026-11-14 15:30 → 2026-11-14 17:00';
  const box = parent();
  render(box, message(decision({
    status: 'applied', choice: { option_id: 'reschedule', at: '2026-11-11T09:00:00.000Z', receipt },
  })));
  assert.ok(find(box, node => node.tag === 'p' && node.text === '✓ ' + receipt),
    'the receipt with original time, new time, and result is shown');
  const jump = find(box, node => node.tag === 'button' && node.text === '查看待办');
  assert.ok(jump, 'a 查看待办 action is offered on the confirmed card');
  jump.click();
  assert.deepEqual(calls.jumpToTask, [7], 'the button jumps to the rescheduled task');
});

test('a failed confirmation shows the error receipt and no task jump', () => {
  const { render, message, parent } = harness();
  const box = parent();
  render(box, message(decision({
    status: 'failed', choice: { option_id: 'reschedule', at: 't', receipt: '事件已变更，请刷新后重试。' },
  })));
  assert.ok(find(box, node => node.tag === 'p' && node.text === '× 事件已变更，请刷新后重试。'),
    'the failed receipt is shown');
  assert.equal(find(box, node => node.tag === 'button' && node.text === '查看待办'), null,
    'no task jump for a failed confirmation');
});

test('an unconfirmed card keeps the confirm button and shows no task jump', () => {
  const { render, message, parent } = harness();
  const box = parent();
  render(box, message(decision()));
  assert.equal(find(box, node => node.tag === 'button' && node.text === '查看待办'), null,
    'no task jump before confirmation');
  assert.ok(find(box, node => node.tag === 'button' && node.text === '确认此选项'),
    'the confirm button is still offered');
});
