// Decision cards for chat conflicts and uncertainty.
//
// Code ownership (aligned with the memory window):
//   this module — card construction, deterministic triggers, calendar slot
//     previews, confirmation dispatch, recheck at confirm time, and returning
//     the user's choice to the conversation context (decisionContext);
//   src/memory/* — long-term memory extraction, project scope, and the
//     old-vs-new memory conflict judgment.
//
// Shared routes (aligned with the task-log window, which owns 待办日志):
//   recheckDecision only READS tasks and memory. The actual writes still go
//   through the existing routes — /api/task (revision-gated) and /api/memory
//   (snapshot-gated) — whose contracts are unchanged. /api/decision calls
//   recheckDecision before dispatching a card effect; when it reports stale,
//   no write happens and the card is updated in place (recheck.reason +
//   refreshed options) so the owner can continue from the same card.
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
//     options?: [option], anchor?: number | null }
//   option = { id?, label (required), consequence?, preview?,
//     effect: { kind, payload } }
//   effect.kind — 'view' (open calendar / sources, no write) | 'question'
//     (draft a clarification or a source supplement, no write) | 'temporary'
//     (one-turn exception, no memory write) | 'task' (reuses /api/task,
//     revision-gated confirm) | 'memory' (reuses /api/memory + the
//     impact-review snapshot).
//
// The produced payload is stored on the assistant message as review.decision:
//   { kind, title, current, reason, proposal, records, options, anchor,
//     recheck, status, choice }
//   status: 'open' -> 'choosing' -> 'applied' | 'failed'
//   anchor: the long-term memory record the card's memory options are anchored
//     on (preference cards only); recheck re-validates it at confirm time.
//   recheck: null | { at, stale, reason } — set by the server when a confirm
//     is paused because the live state changed after the card was generated.
//   choice: { option_id, at, receipt, temporary?, temporary_text? }
//
// Receipt wording distinguishes three claims that must never be conflated:
//   我方选了某个时间 (the owner selected an option — recorded, nothing written)
//   本地日历已更新 (the local write actually happened)
//   客户已确认 (a claim about the counterparty — only ever stated by saved
//     records, never inferred from a local selection or write)
// A time merely proposed by the counterparty stays a proposal (卡片里的
// proposal 行标注「未确认」) until the owner confirms and the write succeeds.

import { rankRecords } from '../chat/local-chat.mjs';
import { memoryCandidates, scopeMatches } from '../memory/memory-impact.mjs';

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
const fmtTime = value => value.replace('T', ' ');
const describeEvent = event => '"' + event.title + '" ' + fmtTime(event.starts) + ' → ' + fmtTime(event.ends);

// Which other events overlap a candidate slot. `excludeId` removes the event
// being moved itself so the preview shows what the new slot lands next to.
// The recheck at confirm time uses this exact function, so the card preview
// and the recheck always agree on what counts as a conflict.
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

export function buildDecision({ kind, title, current, proposal, reason, recordIds, records, asks, options, status = 'open', anchor = null }) {
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
    anchor: Number.isSafeInteger(anchor) ? anchor : null,
    recheck: null,
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

// --- Reschedule option builders (shared by detection and confirm-time recheck)

export function rescheduleKeepOption(target, tasks) {
  return {
    id: 'keep', label: '保持原时间',
    consequence: '日历不变，事件仍按原时间进行。',
    preview: slotPreview(tasks, target.starts, target.ends, null),
    effect: { kind: 'view', payload: { calendar: target.starts.slice(0, 10) } },
  };
}

export function rescheduleChangeOption({ id, target, tasks, starts, ends, consequence }) {
  const preview = slotPreview(tasks, starts, ends, target.id);
  return {
    id,
    label: '改到 ' + fmtTime(starts) + ' → ' + fmtTime(ends),
    consequence,
    preview,
    effect: {
      kind: 'task',
      payload: {
        id: target.id, revision: target.revision, title: target.title,
        starts, ends, memory_id: target.memory_id ?? null,
        all_day: false, location: target.location ?? '', notes: target.notes ?? '',
      },
    },
  };
}

export function rescheduleCalendarOption({ tasks, date, excludeId }) {
  return {
    id: 'calendar', label: '打开日历选择时间',
    consequence: '到日历查看当天安排并确认新时间。',
    preview: slotPreview(tasks, date + 'T00:00', nextDayKey(date) + 'T00:00', excludeId ?? null),
    effect: { kind: 'view', payload: { calendar: date } },
  };
}

// The earliest start time from `fromTime` (HH:MM) onward on `date` that fits
// `duration` minutes without overlapping other open timed events (the event
// being moved itself, `excludeId`, is ignored). Returns null when nothing
// fits before 23:59. Used to suggest a concrete free slot after a recheck
// finds the proposed slot blocked.
export function suggestSlot(tasks, date, duration, excludeId = null, fromTime = '08:00') {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || duration <= 0) return null;
  const busy = (tasks ?? [])
    .filter(task => task.id !== excludeId && !task.deleted && !task.done && !task.all_day
      && task.starts.slice(0, 10) === date && task.ends.slice(0, 10) === date)
    .map(task => [minutesOf(task.starts), minutesOf(task.ends)])
    .sort((a, b) => a[0] - b[0]);
  let cursor = minutesOf(date + 'T' + fromTime);
  for (const [start, end] of busy) {
    if (cursor + duration <= start) break;
    cursor = Math.max(cursor, end);
  }
  if (cursor + duration > 23 * 60 + 59) return null;
  const fmt = m => date + 'T' + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  return { starts: fmt(cursor), ends: fmt(cursor + duration) };
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
  const current = '当前安排：' + target.title + ' · ' + fmtTime(target.starts) + ' → ' + fmtTime(target.ends);
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
          rescheduleKeepOption(target, tasks),
          rescheduleCalendarOption({ tasks, date, excludeId: target.id }),
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
    proposal: '新时间：' + fmtTime(start) + ' → ' + fmtTime(end),
    asks: [{
      title: base.title,
      reason: base.reason,
      options: [
        rescheduleKeepOption(target, tasks),
        rescheduleChangeOption({
          id: 'reschedule', target, tasks, starts: start, ends: end,
          consequence: '事件更新为新时间，日历和待办同步。' +
            (preview.conflict ? '注意：该时段与其他事件重叠，请再核对。' : '该时段无冲突。'),
        }),
      ],
    }],
  });
}

// --- Preference option builder (shared by detection and confirm-time recheck)

function preferenceAskOptions({ anchor, intents, scope, body }) {
  const impact = memoryCandidates({ kind: anchor.kind, scope, body },
    intents.filter(record => record.id !== anchor.id)).slice(0, 5)
    .map(record => ({ id: record.id, kind: record.kind, scope: record.scope, body: record.body }));
  const records = [...intents].map(record => ({ id: record.id, kind: record.kind, scope: record.scope, source: record.source, body: record.body }));
  return {
    records,
    options: [
      {
        id: 'once', label: '仅本次',
        consequence: '该请求只在本对话中记为本次例外，长期偏好不变。',
        preview: { text: '本次例外（仅本对话）：' + body },
        effect: { kind: 'temporary', payload: { text: body } },
      },
      {
        id: 'keepboth', label: '并存',
        consequence: '新记录独立保存，与记录 #' + anchor.id + ' 并存且都长期生效；其他可能受影响的记录会在保存前列出核对。',
        preview: { impact },
        effect: {
          kind: 'memory',
          payload: {
            kind: anchor.kind, scope, body,
            source: '对话决策 · 长期偏好冲突',
          },
        },
      },
      {
        id: 'longterm', label: '更新长期偏好',
        consequence: '将修订记录 #' + anchor.id + '，新偏好长期生效；其他可能受影响的记录会在保存前列出核对。',
        preview: { replaces: anchor.id, impact },
        effect: {
          kind: 'memory',
          payload: {
            kind: anchor.kind, scope, body,
            source: '对话决策 · 长期偏好冲突', replaces: anchor.id,
          },
        },
      },
    ],
  };
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
  // A replacement keeps the anchored record's type (a rule stays a rule).
  const body = question.trim().slice(0, 4000);
  if (!body) return null;
  const { records, options } = preferenceAskOptions({ anchor: base, intents, scope: scope ?? 'DIC2026', body });
  return buildDecision({
    kind: 'preference',
    title: '长期偏好冲突',
    current: '当前生效的长期偏好：' + intents.map(record => '#' + record.id + ' ' + record.body).join('；'),
    reason: review.conflict,
    proposal: question,
    recordIds: records.map(record => record.id),
    records,
    anchor: base.id,
    asks: [{
      title: '长期偏好冲突',
      reason: review.conflict,
      options,
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
          id: 'source', label: '补充资料',
          consequence: '把能证明该问题的原文或出处发进来，证据核对后再继续。',
          preview: { text: '仍缺证据：' + gap },
          effect: { kind: 'question', payload: { text: '请补充资料 · ' + gap + '\n\n在下方粘贴原文（并尽量注明来源）：' } },
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
// Confirm-time recheck (确认时重查):
//
// Before a card effect is applied, re-read the live workspace state and
// compare it with what the card was generated against. If the relevant state
// changed after generation, the write is paused: no mutation happens, the
// card is updated in place with a specific reason plus refreshed options,
// and the owner continues from the same card.
//
//   - 'task' effects: the referenced event must still exist and keep its
//     revision, and the candidate slot is re-previewed with the live
//     calendar (same slotPreview the card used, so they always agree).
//     A newly overlapping task pauses the write and the refreshed options
//     add a concrete free-slot suggestion (suggestSlot) plus the calendar.
//   - 'memory' effects: the anchored record (effect payload `replaces`, or
//     the card's `anchor`) must still be the valid one — if it was revised
//     after the card was generated, an old card must not overwrite a later
//     confirmed decision. The impact set is also re-derived against the
//     current active preferences/rules; drift requires re-confirmation with
//     options re-anchored on the valid successor record.
//
// recheckDecision returns { stale, reason, options }:
//   stale=false → safe to apply the write;
//   stale=true  → pause; `reason` says concretely what changed and
//     `options` (when present) are the refreshed options for the card.
// ---------------------------------------------------------------------------

export function recheckDecision({ decision, option, tasks = [], memories = [] }) {
  const effect = option?.effect ?? {};
  if (effect.kind === 'task') return taskRecheck({ option, tasks });
  if (effect.kind === 'memory') return memoryRecheck({ decision, option, memories });
  // 'view', 'question', 'temporary' change nothing on the server side.
  return { stale: false };
}

function taskRecheck({ option, tasks }) {
  const payload = option.effect?.payload ?? {};
  if (!Number.isSafeInteger(payload.id) || typeof payload.starts !== 'string' || typeof payload.ends !== 'string') {
    return { stale: true, reason: '卡片选项缺少有效的事件和时间信息，请重新打开卡片确认。' };
  }
  const target = (tasks ?? []).find(task => task.id === payload.id && !task.deleted) ?? null;
  if (!target) {
    return { stale: true, reason: '卡片引用的事件 #' + payload.id + ' 已不存在（可能已被删除或修改），请先在日历中核对当前安排。' };
  }
  const problems = [];
  if (target.revision !== payload.revision) {
    problems.push('事件已被修改，当前为 ' + fmtTime(target.starts) + ' → ' + fmtTime(target.ends) +
      '（卡片基于旧版本 ' + fmtTime(payload.starts) + ' → ' + fmtTime(payload.ends) + '）');
  }
  const now = slotPreview(tasks, payload.starts, payload.ends, target.id);
  const storedBusy = (option.preview?.events ?? []).filter(event => !event.done);
  const nowBusy = now.events.filter(event => !event.done);
  const added = nowBusy.filter(event => !storedBusy.some(item => item.id === event.id));
  const removed = storedBusy.filter(event => !nowBusy.some(item => item.id === event.id));
  if (added.length) problems.push('该时段在卡片生成后新增未完成任务：' + added.map(describeEvent).join('；'));
  if (removed.length) problems.push('原先重叠的 ' + removed.map(describeEvent).join('；') + ' 已不在该时段，该时段现在空闲。');
  if (!problems.length) return { stale: false };

  // Refresh the card in place: same target event, live previews, and a
  // concrete alternative slot when the proposed time is now blocked.
  const date = payload.starts.slice(0, 10);
  const duration = Math.max(60, minutesOf(target.ends) - minutesOf(target.starts));
  const options = [rescheduleKeepOption(target, tasks)];
  const sameAsCurrent = target.starts === payload.starts && target.ends === payload.ends;
  const endTotal = minutesOf(payload.starts) + duration;
  let proposedEnd = null;
  if (!sameAsCurrent && endTotal <= 1439) {
    proposedEnd = payload.starts.slice(0, 11) + String(Math.floor(endTotal / 60)).padStart(2, '0') + ':' + String(endTotal % 60).padStart(2, '0');
    options.push(rescheduleChangeOption({
      id: 'reschedule', target, tasks, starts: payload.starts, ends: proposedEnd,
      consequence: '事件更新为新时间，日历和待办同步。' +
        (now.conflict ? '注意：该时段与其他事件重叠，请再核对。' : '该时段无冲突。'),
    }));
  }
  if (now.conflict && proposedEnd) {
    const alt = suggestSlot(tasks, date, duration, target.id, payload.starts.slice(11));
    if (alt && (alt.starts !== payload.starts || alt.ends !== proposedEnd)) {
      options.push(rescheduleChangeOption({
        id: 'reschedule-alt', target, tasks, starts: alt.starts, ends: alt.ends,
        consequence: '避开该时段新增的事件，事件更新为该时间，日历和待办同步。',
      }));
    }
  }
  options.push(rescheduleCalendarOption({ tasks, date, excludeId: target.id }));
  return { stale: true, reason: problems.join('；'), options };
}

function memoryRecheck({ decision, option, memories }) {
  const payload = option.effect?.payload ?? {};
  const anchorId = payload.replaces ?? decision?.anchor ?? null;
  const problems = [];
  let successor = null;
  if (anchorId != null) {
    const record = (memories ?? []).find(item => item.id === anchorId) ?? null;
    if (!record) {
      problems.push('卡片引用的记录 #' + anchorId + ' 已不存在。');
    } else if (record.superseded) {
      const chain = (memories ?? []).filter(item => item.replaces === anchorId && !item.superseded).sort((a, b) => a.id - b.id);
      successor = chain.length ? chain[chain.length - 1] : null;
      problems.push('卡片引用的长期偏好 #' + record.id + ' 已被修订' +
        (successor ? '（现行有效版本 #' + successor.id + '：' + successor.body + '）' : '') +
        '，为避免用旧卡覆盖后来确认的决定，请重新确认。');
    }
  }
  // Re-derive the impact set against the current active preferences/rules;
  // if it drifted since the card was generated, the owner must re-review.
  const scope = payload.scope ?? 'DIC2026';
  const intents = (memories ?? []).filter(record => !record.superseded
    && ['preference', 'rule'].includes(record.kind) && scopeMatches(record.scope, scope));
  const excludeId = successor?.id ?? anchorId;
  const fresh = memoryCandidates({ kind: payload.kind, scope, body: payload.body },
    intents.filter(record => record.id !== excludeId)).map(record => record.id);
  const original = (option.preview?.impact ?? []).map(record => record.id);
  if (original.some(id => !fresh.includes(id)) || fresh.some(id => !original.includes(id))) {
    problems.push('卡片生成后，该范围内的长期偏好/规则已变化，可能受影响的记录需重新核对。');
  }
  if (!problems.length) return { stale: false };

  // Re-anchor the options on a currently valid record so the owner can
  // continue from the same card with the live state.
  let newAnchor = successor;
  if (!newAnchor && intents.length) {
    const scored = rankRecords((decision?.proposal ?? '') + ' ' + (decision?.reason ?? ''), intents);
    newAnchor = scored.find(row => row.score >= 1)?.record ?? null;
  }
  const options = newAnchor
    ? preferenceAskOptions({ anchor: newAnchor, intents, scope, body: payload.body }).options
    : [
        {
          id: 'once', label: '仅本次',
          consequence: '该请求只在本对话中记为本次例外，长期偏好不变。',
          preview: { text: '本次例外（仅本对话）：' + (decision?.proposal ?? '') },
          effect: { kind: 'temporary', payload: { text: decision?.proposal ?? '' } },
        },
        {
          id: 'view', label: '查看原文',
          consequence: '在证据面板中查看检索到的记录、推断和待核实项。',
          effect: { kind: 'view', payload: { sources: true } },
        },
      ];
  return { stale: true, reason: problems.join('；'), options };
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
