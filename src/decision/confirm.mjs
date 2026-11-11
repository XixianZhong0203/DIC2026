// /api/decision confirmation dispatch (决策卡确认执行).
//
// Code ownership (aligned with the decision-card wording window):
//   this module — the confirm path itself: per-card serialization (double
//     click, two tabs, retries), confirm-time recheck dispatch, idempotent
//     recovery from existing records, and the card states 已选待确认 /
//     已应用 / 暂缓 / 失败;
//   src/decision/decision.mjs — card wording, deterministic triggers,
//     recheckDecision (reads only), and the conversation context;
//   src/tasks/task-audit.mjs — the audit rows and receipt wording for task
//     writes;
//   the actual writes still go through the existing /api/task
//   (revision-gated) and /api/memory (snapshot-gated) routes, whose
//   contracts are unchanged.
//
// Invariants:
//   - one valid confirmation per card applies the change exactly once.
//     Confirms for the same card are serialized in-process (a double click or
//     a second tab queues behind the first and then answers from the actual
//     card state); the underlying write keeps its own gate; an already
//     applied card answers 409.
//   - the receipt always describes the write that actually happened. On
//     success it is built from the re-read task row / saved memory row. If
//     saving the receipt on the card failed after the write committed, the
//     next confirm rebuilds the receipt from the existing records (the
//     task_audit row linked via via.decision, or the memory row linked via
//     message_id and matching this option's payload) and marks the card
//     applied WITHOUT re-applying.
//   - a confirm held back by the recheck is 暂缓 (paused): nothing is
//     written, the card is refreshed in place with the reason and, when
//     available, what is actually effective right now (recheck.current).
//     A write blocked by a concurrent change is re-checked and paused the
//     same way when the state simply drifted; only a hard error is 失败.

import { recheckDecision, EFFECT_KINDS, DECISION_MEMORY_SOURCE } from './decision.mjs';
import { auditForDecision, changeReceipt } from '../tasks/task-audit.mjs';

// The audit actions that carry a real calendar change (a decision card's
// 'task' effect performs an update; created/deleted are accepted too so a
// recovery never depends on the exact action name).
const MUTATING_TASK_ACTIONS = new Set(['created', 'updated', 'deleted']);

export function createDecisionRoute({ db, tasks, memories, mutations, state, fail }) {
  // Per-card confirmation queue: concurrent confirms of the same card
  // (double click, two tabs, a network retry) run one at a time; a late
  // arrival re-reads the card and answers from the actual state (409
  // applied) instead of writing again. Cross-card conflicts stay the
  // concern of the underlying routes' own gates.
  const queued = new Map();
  const serialize = (messageId, work) => {
    const pending = queued.get(messageId) ?? Promise.resolve();
    const run = pending.then(work, work);
    queued.set(messageId, run);
    run.then(
      () => { if (queued.get(messageId) === run) queued.delete(messageId); },
      () => { if (queued.get(messageId) === run) queued.delete(messageId); },
    );
    return run;
  };

  // Fresh read of the card. An applied card is terminal: it answers 409 so a
  // retry (or the other tab) refreshes instead of writing again.
  const readCard = messageId => {
    const row = db.prepare('SELECT * FROM messages WHERE id = ? AND role = ?').get(messageId, 'assistant');
    if (!row) fail(404, '找不到对应的决策消息。');
    const review = JSON.parse(row.review ?? 'null');
    const decision = review?.decision;
    if (!decision) fail(404, '这条消息没有决策卡。');
    if (decision.status === 'applied') fail(409, '该决策已确认，请刷新查看结果。');
    return { review, decision };
  };

  const saveCard = (messageId, review) =>
    db.prepare('UPDATE messages SET review = ? WHERE id = ?').run(JSON.stringify(review), messageId);

  // The receipt for a memory write, built from the row that was actually
  // saved (its id and its real replaces), not from the card's payload.
  const memoryReceipt = saved =>
    '本地长期偏好已更新' +
    (saved?.replaces != null ? ' · 修订 #' + saved.replaces : '') +
    ' · 新记录 #' + (saved?.id ?? '');

  // True when `saved` is exactly the row this option's confirm would have
  // written (same kind/scope/body/replaces and the decision-card source),
  // i.e. the change already happened through this card.
  const writtenBy = (option, saved) => {
    const payload = option.effect?.payload ?? {};
    return saved?.source === DECISION_MEMORY_SOURCE
      && saved.kind === payload.kind
      && saved.scope === payload.scope
      && saved.body === payload.body
      && (saved.replaces ?? null) === (payload.replaces ?? null);
  };

  // Idempotent recovery: when the write committed but the receipt save
  // failed (or a concurrent confirm applied first), rebuild the receipt
  // from the existing records and mark the card applied — without writing.
  //   task effects   — the audit row the write left (via.decision links it to
  //                    this card, via.option to this option);
  //   memory effects — the memory row the write left (message_id links it to
  //                    this card; the payload must match this option so a
  //                    sibling option never inherits another's receipt).
  const recoveredReceipt = (messageId, option) => {
    const effect = option.effect ?? {};
    if (effect.kind === 'task') {
      for (const row of auditForDecision(db, messageId)) {
        if (MUTATING_TASK_ACTIONS.has(row.action) && row.via?.option === option.id) {
          return '本地日历已更新 · ' + changeReceipt(row.action, row.before, row.after);
        }
      }
      return null;
    }
    if (effect.kind === 'memory') {
      const rows = db.prepare('SELECT * FROM memory WHERE message_id = ? ORDER BY id DESC LIMIT 10').all(messageId);
      for (const saved of rows) if (writtenBy(option, saved)) return memoryReceipt(saved);
      return null;
    }
    return null; // view / question / temporary change nothing on the server
  };

  // 暂缓 (pause): nothing was written; the card is refreshed in place with
  // the specific reason, refreshed options, and — when the recheck knows it
  // — what is actually effective right now, so follow-ups stay on the live
  // arrangement.
  function pauseCard(decision, recheck, at) {
    decision.status = 'open';
    decision.recheck = { at, stale: true, reason: recheck.reason };
    if (recheck.options?.length) {
      decision.options = recheck.options;
      if (decision.choice && !decision.options.some(item => item.id === decision.choice.option_id)) {
        decision.choice = null;
      }
    }
    if (recheck.current) decision.current = recheck.current;
  }

  return async function decide({ message_id, option_id, confirm }) {
    if (!Number.isSafeInteger(message_id) || typeof option_id !== 'string') fail(400, '请求内容不正确。');
    return serialize(message_id, async () => {
      const { review, decision } = readCard(message_id);
      const option = (decision.options ?? []).find(item => item.id === option_id);
      if (!option) fail(404, '找不到对应的决策选项。');
      const effect = option.effect ?? {};
      if (!EFFECT_KINDS.includes(effect.kind)) fail(400, '该选项没有对应的操作。');
      const at = new Date().toISOString();

      if (confirm === true) {
        // 1) Idempotency: this card's confirm may have already committed
        //    (write succeeded, receipt save failed) — report the actual
        //    result and mark applied without writing again.
        const recovered = recoveredReceipt(message_id, option);
        if (recovered) {
          decision.recheck = null;
          decision.status = 'applied';
          decision.choice = { option_id, at, receipt: recovered };
          saveCard(message_id, review);
          return state();
        }
        // 2) Confirm-time recheck: when the live state drifted since the
        //    card was generated, pause (no write) and refresh in place.
        const recheck = recheckDecision({ decision, option, tasks: tasks(), memories: memories() });
        if (recheck.stale) {
          pauseCard(decision, recheck, at);
          saveCard(message_id, review);
          return state();
        }
        // 3) Apply through the existing routes (revision/snapshot gated).
        let receipt = '';
        try {
          if (effect.kind === 'task') {
            // 决策卡触发的改期：关联该次选择，回执给出原时间、新时间和实际结果。
            const previous = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted = 0').get(effect.payload?.id ?? -1);
            await mutations['/api/task']({ ...(effect.payload ?? {}), via: {
              decision: message_id, option: option.id, option_label: option.label, at,
            } });
            const updated = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted = 0').get(effect.payload?.id ?? -1);
            receipt = '本地日历已更新 · ' + changeReceipt('updated', previous, updated);
          } else if (effect.kind === 'memory') {
            const payload = effect.payload ?? {};
            // Defense in depth against a duplicate that slipped past the
            // queue: if this option's row already exists, it is the actual
            // result — report it, don't re-write.
            const existing = db.prepare('SELECT * FROM memory WHERE message_id = ? ORDER BY id DESC LIMIT 10').all(message_id)
              .find(saved => writtenBy(option, saved));
            if (existing) {
              decision.recheck = null;
              decision.status = 'applied';
              decision.choice = { option_id, at, receipt: memoryReceipt(existing) };
              saveCard(message_id, review);
              return state();
            }
            const impact = await mutations['/api/memory-impact']({
              kind: payload.kind, scope: payload.scope, body: payload.body, replaces: payload.replaces, language: 'zh-CN',
            });
            mutations['/api/memory']({ ...payload, snapshot: impact.snapshot, review_base: payload.replaces ?? null, message_id });
            const saved = db.prepare('SELECT * FROM memory WHERE message_id = ? ORDER BY id DESC LIMIT 1').get(message_id);
            receipt = memoryReceipt(saved);
          } else if (effect.kind === 'temporary') {
            receipt = '已记为本次例外，长期偏好不变';
          } else if (effect.kind === 'question') {
            receipt = '已填入输入框，发送后继续';
          } else {
            receipt = '已确认查看，本地数据未变更';
          }
          decision.recheck = null;
        } catch (error) {
          if (!error.status) throw error;
          // A concurrent writer may have changed the state between the
          // recheck and the write: re-check it. When the recheck now reports
          // stale, the situation simply drifted, so pause with refreshed
          // options; only a hard error stays a failure.
          const again = recheckDecision({ decision, option, tasks: tasks(), memories: memories() });
          if (again.stale) {
            pauseCard(decision, again, at);
            saveCard(message_id, review);
            return state();
          }
          decision.status = 'failed';
          decision.choice = { option_id, at, receipt: error.message };
          saveCard(message_id, review);
          return state();
        }
        decision.status = 'applied';
        decision.choice = {
          option_id, at, receipt,
          ...(effect.kind === 'temporary' ? { temporary: true, temporary_text: String(effect.payload?.text ?? '').slice(0, 800) } : {}),
        };
        saveCard(message_id, review);
        return state();
      }

      // A selection only: 已选待确认 — record the choice, write nothing.
      decision.status = 'choosing';
      decision.choice = { option_id, at, receipt: '' };
      saveCard(message_id, review);
      return state();
    });
  };
}
