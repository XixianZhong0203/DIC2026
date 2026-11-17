import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDecisionRoute } from './confirm.mjs';

// Confirm-time memory checks reuse /api/memory-impact, which renders model
// instructions. The card must inherit the language of the reply that produced
// it so the English locale does not send Chinese instructions.
function fixture(review) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT, body TEXT, review TEXT);
    CREATE TABLE memory (
      id INTEGER PRIMARY KEY, kind TEXT, scope TEXT, body TEXT, source TEXT,
      replaces INTEGER, message_id INTEGER
    );
  `);
  db.prepare('INSERT INTO messages VALUES (1, ?, ?, ?)').run('assistant', '', JSON.stringify(review));
  const seen = [];
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const route = createDecisionRoute({
    db,
    tasks: () => [],
    memories: () => [],
    mutations: {
      '/api/memory-impact': async payload => { seen.push(payload.language); return { snapshot: 'snapshot' }; },
      '/api/memory': payload => db.prepare(
        'INSERT INTO memory(kind,scope,body,source,replaces,message_id) VALUES (?,?,?,?,?,?)')
        .run(payload.kind, payload.scope, payload.body, payload.source ?? 'test-source',
          payload.replaces ?? null, payload.message_id ?? null),
    },
    state: () => ({ ok: true }),
    fail,
  });
  return { route, seen };
}

const card = (language) => ({
  language,
  decision: {
    kind: 'preference',
    title: 'Long-term preference conflict',
    current: '',
    reason: '',
    proposal: '',
    records: [],
    anchor: null,
    recheck: null,
    status: 'open',
    choice: null,
    options: [{
      id: 'keepboth', label: 'Keep both',
      effect: { kind: 'memory', payload: { kind: 'preference', scope: 'Client A', body: 'Send weekly summaries.' } },
    }],
  },
});

test('a decision card confirm sends model instructions in the reply language', async () => {
  const en = fixture(card('en'));
  await en.route({ message_id: 1, option_id: 'keepboth', confirm: true });
  assert.deepEqual(en.seen, ['en']);

  const zh = fixture(card('zh-CN'));
  await zh.route({ message_id: 1, option_id: 'keepboth', confirm: true });
  assert.deepEqual(zh.seen, ['zh-CN']);
});

test('an explicit request language wins over the stored card language', async () => {
  const { route, seen } = fixture(card('zh-CN'));
  await route({ message_id: 1, option_id: 'keepboth', confirm: true, language: 'en' });
  assert.deepEqual(seen, ['en']);
});

test('an older card without a stored language keeps the previous Chinese default', async () => {
  const legacy = card(undefined);
  delete legacy.language;
  const { route, seen } = fixture(legacy);
  await route({ message_id: 1, option_id: 'keepboth', confirm: true });
  assert.deepEqual(seen, ['zh-CN']);
});
