import { rankRecords, words } from '../chat/local-chat.mjs';
import { GLOBAL_SCOPE } from '../policy/policy.mjs';

// Scope matching for project-scoped memory. A record is visible to a project
// when its scope names that project or is global; a global edit is checked
// against every scope.
export function scopeMatches(recordScope, project) {
  const record = String(recordScope ?? '').trim();
  const target = String(project ?? '').trim();
  return record === GLOBAL_SCOPE || target === GLOBAL_SCOPE || record === target;
}

// Select the memories visible in a conversation's project scope.
export function recordsInScope(records, project) {
  return records.filter(record => scopeMatches(record.scope, project));
}

// —— 共享记忆保留原项目与适用范围（shared-memory 窗口）——
// 一条记录随共享（跨工作区带入 / 全局可见）进入另一个项目的上下文时，必须
// 同时携带三样东西：原项目（origin，记录从哪里来）、出处（source，已有字段）、
// 适用对象（applies_to，这条条款约束谁）。适用对象与适用范围（scope）是两个
// 轴：scope 决定记录在哪个项目的记忆里可见；applies_to 决定记录里的折扣、
// 承诺、合同状态等条款只对哪个客户/项目成立。
//   applies_to = '*'    通用做法（谈判流程、文档规范…），可用于任何项目；
//   applies_to = '<名>' 条款明确约束该项目/客户，对其他项目只是参考资料；
//   applies_to = ''     未显式记录（旧数据），按 scope 推导：全局 → '*'，否则自身项目。

// 记录实际生效的适用对象（读端口径：显式值优先，空值按 scope 推导）。
export function effectiveAppliesTo(record) {
  const stored = String(record?.applies_to ?? '').trim();
  if (stored) return stored;
  const scope = String(record?.scope ?? '').trim();
  return scope === GLOBAL_SCOPE || scope === '' ? GLOBAL_SCOPE : scope;
}

// 保存入口的校验：只接受 '*' 或非空名称；空值表示「与适用范围一致」（由服务端
// 按 scope 落库），超长或非法值按空值处理（不让模型/界面提交越界值）。
export function normalizeAppliesTo(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 100) return '';
  return text.toLowerCase() === 'global' ? GLOBAL_SCOPE : text;
}

// 记录进入模型上下文 / 检索结果 / 证据面板的统一视图：在原字段上加
// applies_to（恒带，显式生效值）与 origin（仅在原项目不同于自身 scope 时带——
// 跨工作区带入的副本或在他处创建的全局记录，普通记录不添噪音）。
export function recordProvenance(record) {
  const scope = String(record.scope ?? '').trim();
  const origin = String(record.origin_scope ?? '').trim();
  return {
    id: record.id, kind: record.kind, scope, body: record.body, source: record.source,
    applies_to: effectiveAppliesTo(record),
    ...(origin && origin !== scope ? { origin } : {}),
  };
}

// Personalized PageRank with restart at the incoming edit. This small graph
// links memory records through shared terms and scopes.
export function memoryCandidates(edit, records, limit = 8) {
  const scope = edit.scope.trim().toLowerCase();
  const ranked = rankRecords(edit.body, records).map(({ record, score }) => ({
    record, seed: score + (record.scope.trim().toLowerCase() === scope ? 2 : 0),
  })).sort((a, b) => b.seed - a.seed).slice(0, 80);
  const total = ranked.reduce((sum, row) => sum + row.seed, 0);
  if (!total) return [];
  const restart = ranked.map(row => row.seed / total);
  const tokens = ranked.map(({ record }) => words(record.body));
  const links = ranked.map(({ record }, i) => ranked.map((other, j) => {
    if (i === j) return 0;
    const sameScope = record.scope.trim().toLowerCase() === other.record.scope.trim().toLowerCase();
    const common = [...tokens[i]].filter(word => tokens[j].has(word)).length;
    return (sameScope ? 1 : 0) + common;
  }));
  let relevance = restart;
  for (let step = 0; step < 20; step++) {
    const next = restart.map(weight => 0.15 * weight);
    for (const [i, row] of links.entries()) {
      const weight = row.reduce((sum, edge) => sum + edge, 0);
      for (const [j, edge] of row.entries()) {
        next[j] += 0.85 * relevance[i] * (weight ? edge / weight : restart[j]);
      }
    }
    relevance = next;
  }
  return ranked.map(({ record }, i) => ({ ...record, relevance: relevance[i] }))
    .filter(record => record.relevance > 0).sort((a, b) => b.relevance - a.relevance).slice(0, limit);
}

// Normalize the model's memory candidates from a conversation. Each keeps
// content, kind, scope, confirmation status, and the source message.
export const MEMORY_KINDS = ['fact', 'preference', 'rule', 'proposal'];
export const MEMORY_STATUSES = ['confirmed', 'pending'];

export function normalizeCandidates(raw, { messageIds = [], project = '' }) {
  const items = Array.isArray(raw) ? raw : [];
  const ids = new Set(messageIds);
  const out = [];
  for (const item of items.slice(0, 6)) {
    if (typeof item?.content !== 'string' || !item.content.trim() || item.content.length > 1000) continue;
    if (!MEMORY_KINDS.includes(item.kind) || !MEMORY_STATUSES.includes(item.status)) continue;
    const requestedScope = typeof item.scope === 'string' ? item.scope.trim().toLowerCase() : '';
    const globalPreference = item.kind === 'preference' && item.status === 'confirmed' &&
      (requestedScope === GLOBAL_SCOPE || requestedScope === 'global');
    const scope = globalPreference ? GLOBAL_SCOPE : project;
    if (!scope || scope.length > 100) continue;
    const messageId = item.message_id == null ? null
      : (Number.isSafeInteger(item.message_id) && ids.has(item.message_id) ? item.message_id : null);
    out.push({ content: item.content.trim(), kind: item.kind, scope,
      status: item.status, message_id: messageId });
  }
  return out;
}

export function verifiedQuotes(facts, records) {
  const sources = new Map(records.map(record => [record.id, record]));
  return (Array.isArray(facts) ? facts : []).slice(0, 12).flatMap(fact => {
    const record = sources.get(fact?.id);
    return record && typeof fact.quote === 'string' && fact.quote.trim() && record.body.includes(fact.quote)
      ? [{ id: record.id, quote: fact.quote, source: record.source, kind: record.kind }] : [];
  });
}
