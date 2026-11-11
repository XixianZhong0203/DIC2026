// Decision cards for chat conflicts and uncertainty.
//
// Code ownership (aligned with the memory window):
//   this module — card construction, deterministic triggers, calendar slot
//     previews, confirmation dispatch, and returning the user's choice to the
//     conversation context (decisionContext);
//   src/memory/* — long-term memory extraction, project scope, and the
//     old-vs-new memory conflict judgment.
//
// The memory window (or the chat pipeline) hands this module the same four
// pieces of information for every decision it wants the owner to make:
//   current   — the currently valid decisions (what is confirmed right now);
//   proposal  — the new proposal, or the information gap that blocks the reply;
//   recordIds — the related memory record IDs;
//   asks      — the items suggested for a user decision, each with options.
//
// Handoff shape (buildDecision input):
//   { kind: 'reschedule' | 'preference' | 'clarify',
//     title?, current?, proposal?, reason?, recordIds?: number[],
//     records?: [{ id, kind, source, body }],
//     asks?: [{ title?, reason?, options?: [option] }],
//     options?: [option] }
//   option = { id?, label (required), consequence?, preview?,
//     effect: { kind, payload } }
//   effect.kind — 'view' (open calendar / sources, no write) | 'question'
//     (draft a clarification, no write) | 'temporary' (one-turn exception,
//     no memory write) | 'task' (reuses /api/task, revision-gated confirm)
//     | 'memory' (reuses /api/memory + the impact-review snapshot).
//
// The produced payload is stored on the assistant message as review.decision:
//   { kind, title, current, reason, proposal, records, options, status, choice }
//   status: 'open' -> 'choosing' -> 'applied' | 'failed'
//   choice: { option_id, at, receipt, temporary?, temporary_text? }

import { rankRecords } from '../chat/local-chat.mjs';
import { memoryCandidates } from '../memory/memory-impact.mjs';

export const DECISION_KINDS = ['reschedule', 'preference', 'clarify'];
export const EFFECT_KINDS = ['view', 'question', 'temporary', 'task', 'memory'];

const FULL_TIME = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/g;
const ISO_DATE = /(\d{4}-\d{2}-\d{2})/g;

function validSlot(date, time) {
  const value = date + 'T' + time;
  const parsed = new Date(value + 'Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 16) === value;
}

export function extractTimes(...texts) {
  const found = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const match of text.matchAll(FULL_TIME)) {
      if (validSlot(match[1], match[2])) found.add(match[1] + 'T' + match[2]);
    }
  }
  return [...found];
}

export function extractDates(...texts) {
  const found = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const match of text.matchAll(ISO_DATE)) {
      const parsed = new Date(match[1] + 'T00:00Z');
      if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[1]) {
        found.add(match[1]);
      }
    }
  }
  return [...found];
}

export function nextDayKey(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

const minutesOf = value => Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));

// Which other events overlap a candidate slot. `excludeId` removes the event
// being moved itself so the preview shows what the new slot lands next to.
export function slotPreview(tasks, starts, ends, excludeId = null) {
  const events = (tasks ?? [])
    .filter(task => task.id !== excludeId && !task.deleted && task.starts < ends && task.ends > starts)
    .map(task => ({ id: task.id, title: task.title, starts: task.starts, ends: task.ends, done: Boolean(task.done) }));
  return {
    date: starts.slice(0, 10),
    starts,
    ends,
    excludeId: excludeId ?? null,
    events,
    conflict: events.some(event => !event.done),
  };
}

export function buildDecision({ kind, title, current, proposal, reason, recordIds, records, asks, options, status = 'open' }) {
  if (!DECISION_KINDS.includes(kind)) throw new Error('Decision card kind must be reschedule, preference, or clarify.');
  const ask = Array.isArray(asks) ? asks[0] : asks ?? {};
  const source = options ?? ask?.options ?? [];
  if (!Array.isArray(source) || !source.length) throw new Error('A decision card needs at least one option.');
  const normalized = source.slice(0, 4).map((option, index) => {
    if (!option || typeof option.label !== 'string' || !option.label.trim()) {
      throw new Error('Every decision option needs a display label.');
    }
    const effect = option.effect ?? { kind: 'view', payload: {} };
    if (!EFFECT_KINDS.includes(effect?.kind)) throw new Error('Unsupported decision option action.');
    return {
      id: typeof option.id === 'string' && option.id.trim() ? option.id.trim().slice(0, 40) : 'option-' + (index + 1),
      label: option.label.trim().slice(0, 200),
      consequence: typeof option.consequence === 'string' ? option.consequence.trim().slice(0, 800) : '',
      preview: option.preview ?? null,
      effect,
    };
  });
  const shown = (records ?? []).filter(record => Number.isSafeInteger(record?.id)).slice(0, 6)
    .map(record => ({ id: record.id, kind: record.kind ?? '', scope: record.scope ?? '', source: record.source ?? '', body: record.body ?? '' }));
  return {
    kind,
    title: ((typeof title === 'string' && title.trim()) || (typeof ask?.title === 'string' && ask.title.trim()) || '请确认').slice(0, 200),
    current: typeof current === 'string' ? current.trim().slice(0, 800) : '',
    reason: (typeof reason === 'string' ? reason : (typeof ask?.reason === 'string' ? ask.reason : '')).trim().slice(0, 800),
    proposal: typeof proposal === 'string' ? proposal.trim().slice(0, 800) : '',
    records: shown,
    options: normalized,
    status,
    choice: null,
  };
}

// ---------------------------------------------------------------------------
// Deterministic chat triggers: turn a model reply (conflict / question /
// unknowns) plus the live workspace state into one of the three card kinds.
// Priority: reschedule > preference > clarify. All of them may decline (null).
// ---------------------------------------------------------------------------

function resolveRecords({ target = null, review = {}, memories = [] }) {
  const ids = new Set();
  if (Number.isSafeInteger(target?.memory_id)) ids.add(target.memory_id);
  for (const record of review.cited ?? []) if (Number.isSafeInteger(record?.id)) ids.add(record.id);
  if (!ids.size) return [];
  return (memories ?? []).filter(record => ids.has(record.id))
    .map(record => ({ id: record.id, kind: record.kind, source: record.source, body: record.body }));
}

function rescheduleDecision({ question, review, tasks, memories }) {
  const slots = extractTimes(question, review?.conflict, review?.understood, review?.question);
  const dates = extractDates(question, review?.conflict, review?.understood, review?.question);
  if (!slots.length && !dates.length) return null;
  const open = (tasks ?? []).filter(task => !task.all_day && !task.done && !task.deleted);
  if (!open.length) return null;
  const matchText = [question, review?.understood, review?.conflict, review?.question].join(' ');
  const scored = rankRecords(matchText, open.map(task => ({
    id: task.id, kind: 'task', scope: '', source: 'Calendar', body: task.title + ' ' + (task.notes ?? ''),
  })));
  const positive = scored.filter(row => row.score >= 1);
  const byTitle = positive.length === 1 ? positive[0] : scored.find(row => row.score >= 2) ?? null;
  // A named event beats "the only event on the new date": the user may be
  // moving an event that already sits on that date next to another one.
  let target = byTitle ? open.find(task => task.id === byTitle.record.id) : null;
  if (!target) {
    const date = dates.find(value => open.filter(task => task.starts.slice(0, 10) === value).length === 1);
    if (date) target = open.find(task => task.starts.slice(0, 10) === date);
  }
  if (!target) return null;

  const records = resolveRecords({ target, review, memories });
  const current = '当前安排：' + target.title + ' · ' + target.starts.replace('T', ' ') + ' → ' + target.ends.replace('T', ' ');
  const base = {
    kind: 'reschedule',
    title: '确认改期 "' + target.title + '"',
    current,
    proposal: '',
    reason: review?.conflict || '用户提到了新的时间，请确认是否调整安排。',
    recordIds: records.map(record => record.id),
    records,
  };

  if (!slots.length) {
    const date = dates[0];
    return buildDecision({
      ...base,
      proposal: '新日期：' + date,
      asks: [{
        title: base.title,
        reason: base.reason,
        options: [
          {
            id: 'keep', label: '保持原时间',
            consequence: '日历不变，事件仍按原时间进行。',
            preview: slotPreview(tasks, target.starts, target.ends, null),
            effect: { kind: 'view', payload: { calendar: target.starts.slice(0, 10) } },
          },
          {
            id: 'calendar', label: '打开日历选择时间',
            consequence: '到日历查看当天安排并确认新时间。',
            preview: slotPreview(tasks, date + 'T00:00', nextDayKey(date) + 'T00:00', target.id),
            effect: { kind: 'view', payload: { calendar: date } },
          },
        ],
      }],
    });
  }

  const start = slots.find(value => value !== target.starts) ?? null;
  if (!start) return null; // the "new" time is exactly the current one: nothing to decide
  const duration = Math.max(60, minutesOf(target.ends) - minutesOf(target.starts));
  const endTotal = minutesOf(start) + duration;
  if (endTotal > 1439) return null; // the slot would run past midnight
  const end = start.slice(0, 11) + String(Math.floor(endTotal / 60)).padStart(2, '0') + ':' + String(endTotal % 60).padStart(2, '0');
  const preview = slotPreview(tasks, start, end, target.id);
  return buildDecision({
    ...base,
    proposal: '新时间：' + start.replace('T', ' ') + ' → ' + end.replace('T', ' '),
    asks: [{
      title: base.title,
      reason: base.reason,
      options: [
        {
          id: 'keep', label: '保持原时间',
          consequence: '日历不变，事件仍按原时间进行。',
          preview: slotPreview(tasks, target.starts, target.ends, null),
          effect: { kind: 'view', payload: { calendar: target.starts.slice(0, 10) } },
        },
        {
          id: 'reschedule', label: '改到 ' + start.replace('T', ' ') + ' → ' + end.replace('T', ' '),
          consequence: '事件更新为新时间，日历和待办同步。' +
            (preview.conflict ? '注意：该时段与其他事件重叠，请再核对。' : '该时段无冲突。'),
          preview,
          effect: {
            kind: 'task',
            payload: {
              id: target.id, revision: target.revision, title: target.title,
              starts: start, ends: end, memory_id: target.memory_id ?? null,
              all_day: false, location: target.location ?? '', notes: target.notes ?? '',
            },
          },
        },
      ],
    }],
  });
}

function preferenceDecision({ question, review, memories, scope }) {
  if (!review?.conflict) return null;
  const intents = (memories ?? []).filter(record => !record.superseded && ['preference', 'rule'].includes(record.kind));
  if (!intents.length) return null;
  // Anchor on the active preference the conflict is actually about: when none
  // of them shares a term with the exchange, the conflict is elsewhere.
  const scored = rankRecords(question + ' ' + review.conflict, intents);
  const base = scored.find(row => row.score >= 1)?.record;
  if (!base) return null;
  const body = question.trim().slice(0, 4000);
  if (!body) return null;
  // A replacement keeps the anchored record's type (a rule stays a rule).
  const impact = memoryCandidates({ kind: base.kind, scope: scope ?? 'DIC2026', body },
    intents.filter(record => record.id !== base.id)).slice(0, 5)
    .map(record => ({ id: record.id, kind: record.kind, scope: record.scope, body: record.body }));
  const records = [...intents].map(record => ({ id: record.id, kind: record.kind, scope: record.scope, source: record.source, body: record.body }));
  return buildDecision({
    kind: 'preference',
    title: '长期偏好冲突',
    current: '当前生效的长期偏好：' + intents.map(record => '#' + record.id + ' ' + record.body).join('；'),
    reason: review.conflict,
    proposal: question,
    recordIds: records.map(record => record.id),
    records,
    asks: [{
      title: '长期偏好冲突',
      reason: review.conflict,
      options: [
        {
          id: 'once', label: '仅本次',
          consequence: '该请求只在本对话中记为本次例外，长期偏好不变。',
          preview: { text: '本次例外（仅本对话）：' + question },
          effect: { kind: 'temporary', payload: { text: question } },
        },
        {
          id: 'keepboth', label: '并存',
          consequence: '新记录独立保存，与记录 #' + base.id + ' 并存且都长期生效；其他可能受影响的记录会在保存前列出核对。',
          preview: { impact },
          effect: {
            kind: 'memory',
            payload: {
              kind: base.kind, scope: scope ?? 'DIC2026', body,
              source: '对话决策 · 长期偏好冲突',
            },
          },
        },
        {
          id: 'longterm', label: '更新长期偏好',
          consequence: '将修订记录 #' + base.id + '，新偏好长期生效；其他可能受影响的记录会在保存前列出核对。',
          preview: { replaces: base.id, impact },
          effect: {
            kind: 'memory',
            payload: {
              kind: base.kind, scope: scope ?? 'DIC2026', body,
              source: '对话决策 · 长期偏好冲突', replaces: base.id,
            },
          },
        },
      ],
    }],
  });
}

function clarifyDecision({ review }) {
  if (!review || review.plain) return null;
  const gap = review.question || review.unknowns?.[0] || '';
  if (review.evidence !== 'uncited' || !gap) return null;
  const records = (review.cited ?? []).length ? review.cited : (review.trace?.retrieved ?? []);
  return buildDecision({
    kind: 'clarify',
    title: '证据不足 · 待确认',
    current: '没有可核对的原始摘录支持这个问题，当前答复未经验证。',
    reason: gap,
    proposal: (review.unknowns ?? []).slice(0, 3).join('；'),
    recordIds: records.map(record => record.id),
    records: records.map(record => ({ id: record.id, kind: record.kind, source: record.source, body: record.body ?? '' })),
    asks: [{
      title: '证据不足 · 待确认',
      reason: gap,
      options: [
        {
          id: 'view', label: '查看原文',
          consequence: '在证据面板中查看检索到的记录、推断和待核实项。',
          effect: { kind: 'view', payload: { sources: true } },
        },
        {
          id: 'draft', label: '起草澄清问题',
          consequence: '根据缺失的证据起草澄清问题，填入输入框发送即可确认。',
          preview: { text: gap },
          effect: { kind: 'question', payload: { text: gap } },
        },
      ],
    }],
  });
}

export function detectDecision({ question, review, tasks = [], memories = [], scope = 'DIC2026' }) {
  if (!review) return null;
  const reschedule = rescheduleDecision({ question, review, tasks, memories });
  if (reschedule) return reschedule;
  const preference = preferenceDecision({ question, review, memories, scope });
  if (preference) return preference;
  return clarifyDecision({ review });
}

// ---------------------------------------------------------------------------
// Returning choices to the conversation: the fragment injected into the next
// model reply so follow-ups can refer to what the user just picked.
// ---------------------------------------------------------------------------

export function decisionContext(messages) {
  const rows = (messages ?? [])
    .map(message => ({ message, decision: message.review?.decision }))
    .filter(({ decision }) => decision?.choice?.option_id);
  if (!rows.length) return null;
  const lastUser = (messages ?? []).filter(message => message.role === 'user').at(-1)?.id ?? null;
  const lines = rows.slice(-5).map(({ message, decision }) => {
    const choice = decision.choice;
    const option = (decision.options ?? []).find(item => item.id === choice.option_id);
    return '- ' + decision.title + ' · 用户选择了：' + (option?.label ?? choice.option_id) +
      (choice.receipt ? ' · 结果：' + choice.receipt : '');
  });
  let temporary = '';
  for (const { message, decision } of rows) {
    const choice = decision.choice;
    // A one-turn exception applies only while no later user message exists.
    if (choice.temporary === true && choice.temporary_text && !(lastUser != null && message.id < lastUser)) {
      temporary = choice.temporary_text;
    }
  }
  return { lines, temporary };
}
