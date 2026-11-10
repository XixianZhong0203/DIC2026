import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryCandidates, verifiedQuotes } from './memory-impact.mjs';

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
