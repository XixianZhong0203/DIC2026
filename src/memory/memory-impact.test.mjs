import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryCandidates, verifiedQuotes, scopeMatches, recordsInScope, normalizeCandidates } from './memory-impact.mjs';
import { GLOBAL_SCOPE } from '../policy/policy.mjs';

const rows = [
  { id: 1, scope: 'DIC2026', source: 'Project decision', kind: 'rule', body: 'Write public summaries in Chinese.' },
  { id: 2, scope: 'External', source: 'Client email', kind: 'preference', body: 'Send monthly summaries in English.' },
  { id: 3, scope: 'Calendar', source: 'Personal note', kind: 'rule', body: 'Allow an hour for lunch.' },
];

test('incoming edits can retrieve related records across scopes', () => {
  const ranked = memoryCandidates({ scope: 'DIC2026', body: 'Write summaries in English.' }, rows);
  assert.equal(ranked[0].id, 1);
  assert.ok(ranked.some(record => record.id === 2));
  assert.ok(ranked.every(record => record.id !== 3));
  assert.deepEqual(memoryCandidates({ scope: 'None', body: 'Lunar orbit' }, rows), []);
});

test('only verbatim quotes from available sources are admitted', () => {
  assert.deepEqual(verifiedQuotes([
    { id: 1, quote: 'public summaries' },
    { id: 1, quote: 'in English' },
    { id: 99, quote: 'public summaries' },
  ], rows), [{ id: 1, quote: 'public summaries', source: 'Project decision', kind: 'rule' }]);
});

test('scopeMatches links a project to its own records and to global ones', () => {
  assert.ok(scopeMatches('DIC2026', 'DIC2026'));
  assert.ok(scopeMatches(GLOBAL_SCOPE, 'DIC2026'));
  assert.ok(scopeMatches('DIC2026', GLOBAL_SCOPE)); // a global edit checks every project
  assert.ok(scopeMatches('  DIC2026  ', 'DIC2026')); // trimmed on both sides
  assert.ok(!scopeMatches('Beta', 'DIC2026'));
  assert.ok(!scopeMatches('', 'DIC2026'));
});

test('recordsInScope keeps project and global records, not other projects', () => {
  const records = [
    { id: 1, scope: 'DIC2026', kind: 'rule', body: 'a' },
    { id: 2, scope: 'Beta', kind: 'rule', body: 'b' },
    { id: 3, scope: GLOBAL_SCOPE, kind: 'preference', body: 'c' },
  ];
  assert.deepEqual(recordsInScope(records, 'DIC2026').map(record => record.id), [1, 3]);
  assert.deepEqual(recordsInScope(records, 'Beta').map(record => record.id), [2, 3]);
  assert.deepEqual(recordsInScope(records, GLOBAL_SCOPE).map(record => record.id), [1, 2, 3]);
});

test('normalizeCandidates keeps only complete candidates with valid references', () => {
  const candidates = normalizeCandidates([
    { content: '  周五交付  ', kind: 'rule', scope: '', status: 'confirmed', message_id: 3 },
    { content: '默认英文', kind: 'preference', status: 'pending' },
    { content: '对外文档全局用中文摘要', kind: 'preference', scope: 'global', status: 'confirmed', message_id: 9 },
    { content: '无效类型', kind: 'bogus', status: 'confirmed' },
    { content: '', kind: 'fact', status: 'pending' },
    // A candidate whose message reference cannot be resolved is kept (it is
    // still usable) but its source link becomes null.
    { content: '来源未定', kind: 'fact', status: 'confirmed', message_id: 99 },
  ], { messageIds: [3], project: 'DIC2026' });
  assert.deepEqual(candidates, [
    { content: '周五交付', kind: 'rule', scope: 'DIC2026', status: 'confirmed', message_id: 3 },
    { content: '默认英文', kind: 'preference', scope: 'DIC2026', status: 'pending', message_id: null },
    { content: '对外文档全局用中文摘要', kind: 'preference', scope: GLOBAL_SCOPE, status: 'confirmed', message_id: null },
    { content: '来源未定', kind: 'fact', scope: 'DIC2026', status: 'confirmed', message_id: null },
  ]);
});


test('extracted customer records stay in the current project despite model scope suggestions', () => {
  const candidates = normalizeCandidates([
    { content: '客户报价为十万元', kind: 'fact', scope: '*', status: 'confirmed' },
    { content: '客户请求改期', kind: 'proposal', scope: '另一个项目', status: 'pending' },
    { content: '可能改用英文', kind: 'preference', scope: 'global', status: 'pending' },
    { content: '所有项目采用中文', kind: 'preference', scope: '*', status: 'confirmed' },
  ], { project: '本项目' });
  assert.deepEqual(candidates.map(candidate => candidate.scope), ['本项目', '本项目', '本项目', GLOBAL_SCOPE]);
});
