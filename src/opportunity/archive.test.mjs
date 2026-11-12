import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { opportunityWorkflow } from './opportunities.mjs';
import { loadArchive, archivesForOpportunity, SCHEMA_VERSION } from './archive.mjs';
import { sha256 } from './claims.mjs';

const EVIDENCE = 'Friday was proposed only.';

// 与 opportunities.test.mjs 同一套 fixture：内存数据库 + 假模型。
// 假模型按调用区分：assess（无 mode/draft）返回分析；claims 调用按 mode 返回声明。
function fixture(complete) {
  const db = new DatabaseSync(':memory:');
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const required = value => value?.trim() || fail(400, 'Required');
  const workflow = opportunityWorkflow(db, {
    complete: async messages => complete(JSON.parse(messages.at(-1).content)),
    model: 'test double', fail, required,
  });
  const call = (action, body) => workflow.mutations['/api/' + action](body);
  call('opportunity', { kind: 'lead', title: 'Delivery check', source: 'Client thread', evidence: EVIDENCE,
    evidence_kind: 'customer' });
  const current = () => workflow.state().opportunities[0];
  return { call, current, state: workflow.state, db };
}

// 所有声明都用 E1 的逐字引文支持（初始来源身份为 customer → supported）。
function supportedClaimsReply(user) {
  if (user.draft) {
    return JSON.stringify({ claims: [{
      id: '对外承诺', dimension: '对外承诺', text: 'We will deliver on Friday.',
      items: [{ evidenceId: 'E1', stance: 'supports', quote: EVIDENCE, note: 'proposed only' }],
      missing: '', rewrite: '',
    }] });
  }
  if (user.mode === 'analysis') {
    return JSON.stringify({ claims: user.dimensions.map(dimension => ({
      id: dimension, dimension, text: dimension, status: 'supported',
      items: [{ evidenceId: 'E1', stance: 'supports', quote: EVIDENCE, note: 'proposed only' }],
      missing: '', rewrite: '',
    })) });
  }
  return JSON.stringify({ status: 'supported', quote: EVIDENCE, reason: 'Explicit acceptance.' });
}

// 验收线（send-archive 窗口）：发送之后来源被修改，旧档案仍能还原
// 「当时基于什么批准了什么」——来源全文、批准依据、批准时间都取发送时刻的值。
test('an old archive still reconstructs the approval after the sources change', async () => {
  const { call, current, state, db } = fixture(supportedClaimsReply);
  const { id } = current();
  await call('opportunity-assess', { id, request: 'Can we promise Friday?' });
  await call('opportunity-source', { id, name: '客户确认邮件', date: '2026-07-10', kind: 'customer',
    text: '客户确认周五交付。', language: 'en' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  await call('opportunity-claims', { id, target: 'draft', draft_id: current().draft_id, language: 'en' });
  call('opportunity-send', { id, draft_id: current().draft_id });
  assert.equal(current().sent, 1);
  const approved = state().audit.find(event => event.action === 'approved');
  assert.equal(JSON.parse(approved.detail).evidence, 'model_supported');

  const archiveId = current().archives[0]?.archiveId;
  assert.ok(archiveId);
  const archive = loadArchive(db, archiveId);
  assert.equal(archive.schemaVersion, SCHEMA_VERSION);
  assert.equal(archive.approval.basis, 'model_supported');
  assert.equal(archive.sent, true);
  assert.equal(archive.approval.recipient, 'client@example.test');
  assert.equal(archive.approval.body, 'We will deliver on Friday.');
  assert.equal(archive.approval.bodyHash, sha256('We will deliver on Friday.'));
  assert.equal(archive.sentAt, approved.time);
  assert.equal(archive.verification.model, 'test double');
  assert.equal(archive.verification.prompts.claims, 'claims-v1');
  // 三档来源：
  assert.deepEqual(archive.sourcesProvidedToModel, ['E1', 'S1']);
  assert.equal(archive.sources[0].text, EVIDENCE);
  assert.equal(archive.sources[1].text, '客户确认周五交付。');
  assert.deepEqual(archive.answerCitedSources.map(entry => entry.id), ['E1']);
  assert.equal(archive.claims[0].supportingSources[0].id, 'E1');
  assert.equal(archive.claims[0].supportingSources[0].quote, EVIDENCE);

  // 发送之后来源被修改：活动状态跟着变（核查过期），旧档案不变。
  db.prepare('UPDATE opportunities SET evidence=? WHERE id=?')
    .run('The prospect changed the date to Tuesday.', id);
  db.prepare('UPDATE lead_sources SET text=? WHERE opportunity=? AND name=?')
    .run('客户改口：交付改到周二。', id, '客户确认邮件');
  assert.notEqual(current().evidence, EVIDENCE);
  assert.equal(current().claimsStale, true);
  // 旧档案仍能还原当时基于什么批准了什么：
  const unchanged = loadArchive(db, archiveId);
  assert.equal(unchanged.sources[0].text, EVIDENCE);
  assert.equal(unchanged.sources[1].text, '客户确认周五交付。');
  assert.equal(unchanged.approval.basis, 'model_supported');
  assert.equal(unchanged.approval.body, 'We will deliver on Friday.');
  assert.equal(unchanged.sentAt, approved.time);
  // 状态里携带的档案也是同一份不可变快照：
  const stored = state().opportunities[0].archives;
  assert.equal(stored[0].archiveId, archiveId);
  assert.equal(stored[0].sources[1].text, '客户确认周五交付。');

  const second = call('opportunity-archive', { id }).archive;
  assert.equal(second, archiveId);
  assert.equal(archivesForOpportunity(db, id).length, 1);
});

// 未发送时手动冻结：批准依据按当前门槛状态标注（pending → 核查通过 model_supported），
// 且档案只增不改。
test('freezing before sending labels the approval basis by the current gate state', async () => {
  const { call, current, state, db } = fixture(supportedClaimsReply);
  const { id } = current();
  // 无分析、无草稿：未达发送门槛。
  const first = call('opportunity-archive', { id }).archive;
  const pending = loadArchive(db, first);
  assert.equal(pending.approval.basis, 'pending');
  assert.equal(pending.sent, false);
  assert.equal(pending.approval.recipient, null);
  assert.deepEqual(pending.sourcesProvidedToModel, ['E1']);
  assert.deepEqual(pending.answerCitedSources, []);
  assert.equal(pending.claims.length, 0);
  // 草稿 + 针对草稿的核查通过后冻结：标注声明核查通过，但仍未发送。
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  await call('opportunity-claims', { id, target: 'draft', draft_id: current().draft_id, language: 'en' });
  const second = call('opportunity-archive', { id }).archive;
  assert.notEqual(second, first);
  const fresh = loadArchive(db, second);
  assert.equal(fresh.approval.basis, 'model_supported');
  assert.equal(fresh.sent, false);
  assert.equal(fresh.approval.recipient, 'client@example.test');
  assert.equal(fresh.approval.body, 'We will deliver on Friday.');
  assert.equal(fresh.claims[0].status, 'supported');
  assert.equal(fresh.claims[0].supportingSources[0].quote, EVIDENCE);
  // 档案只插入：两次冻结留下两份档案，审计各留一条。
  assert.equal(archivesForOpportunity(db, id).length, 2);
  assert.equal(state().audit.filter(event => event.action === 'archived').length, 2);
});
