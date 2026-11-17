import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { opportunityWorkflow, ANALYSIS_PROMPT_VERSION } from './opportunities.mjs';
import { loadArchive, archivesForOpportunity, buildSendArchive, storeArchive, SCHEMA_VERSION } from './archive.mjs';
import { sha256, CLAIMS_PROMPT_VERSION } from './claims.mjs';

const EVIDENCE = 'Friday was proposed only.';

// Same fixture set as opportunities.test.mjs: in-memory database + mock models.
// Mock models distinguish by call: assess (no mode/draft) returns analysis; claims calls return claims
// based on mode.
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

// All claims are supported by verbatim citations from E1 (initial source identity is customer ->
// supported).
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

// Acceptance line (send-archive window): if sources are modified after sending, the old archive can still
// be restored
// "What was approved based on what at the time" - source full text, approval basis, and approval time all
// take values from the moment of sending.
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
  assert.equal(archive.verification.prompts.claims, CLAIMS_PROMPT_VERSION);
  // Three tiers of sources:
  assert.deepEqual(archive.sourcesProvidedToModel, ['E1', 'S1']);
  assert.equal(archive.sources[0].text, EVIDENCE);
  assert.equal(archive.sources[1].text, '客户确认周五交付。');
  assert.deepEqual(archive.answerCitedSources.map(entry => entry.id), ['E1']);
  assert.equal(archive.claims[0].supportingSources[0].id, 'E1');
  assert.equal(archive.claims[0].supportingSources[0].quote, EVIDENCE);

  // If sources are modified after sending: campaign status changes accordingly (verification expired),
  // while the old archive remains unchanged.
  db.prepare('UPDATE opportunities SET evidence=? WHERE id=?')
    .run('The prospect changed the date to Tuesday.', id);
  db.prepare('UPDATE lead_sources SET text=? WHERE opportunity=? AND name=?')
    .run('客户改口：交付改到周二。', id, '客户确认邮件');
  assert.notEqual(current().evidence, EVIDENCE);
  assert.equal(current().claimsStale, true);
  // The old archive can still restore what was approved based on what at the time:
  const unchanged = loadArchive(db, archiveId);
  assert.equal(unchanged.sources[0].text, EVIDENCE);
  assert.equal(unchanged.sources[1].text, '客户确认周五交付。');
  assert.equal(unchanged.approval.basis, 'model_supported');
  assert.equal(unchanged.approval.body, 'We will deliver on Friday.');
  assert.equal(unchanged.sentAt, approved.time);
  // The archive carried in the state is also the same immutable snapshot:
  const stored = state().opportunities[0].archives;
  assert.equal(stored[0].archiveId, archiveId);
  assert.equal(stored[0].sources[1].text, '客户确认周五交付。');

  const second = call('opportunity-archive', { id }).archive;
  assert.equal(second, archiveId);
  assert.equal(archivesForOpportunity(db, id).length, 1);
});

// Manual freezing before sending: approval basis is labeled according to the current threshold status
// (pending -> verification passed model_supported),
// and archives are append-only.
test('freezing before sending labels the approval basis by the current gate state', async () => {
  const { call, current, state, db } = fixture(supportedClaimsReply);
  const { id } = current();
  // No analysis, no draft: sending threshold not met.
  const first = call('opportunity-archive', { id }).archive;
  const pending = loadArchive(db, first);
  assert.equal(pending.approval.basis, 'pending');
  assert.equal(pending.sent, false);
  assert.equal(pending.approval.recipient, null);
  assert.deepEqual(pending.sourcesProvidedToModel, ['E1']);
  assert.deepEqual(pending.answerCitedSources, []);
  assert.equal(pending.claims.length, 0);
  // Draft + freeze after verification passes for the draft: claims verification marked as passed, but
  // still not sent.
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
  // Archives are insert-only: two freezes leave two archives, with the audit log keeping one entry for
  // each.
  assert.equal(archivesForOpportunity(db, id).length, 2);
  assert.equal(state().audit.filter(event => event.action === 'archived').length, 2);
});

test('the archive digest verifies stored bytes, detects tampering, and reports unrecorded for old archives', async () => {
  const { call, current, state, db } = fixture(supportedClaimsReply);
  const { id } = current();
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  await call('opportunity-claims', { id, target: 'draft', draft_id: current().draft_id, language: 'en' });
  const archiveId = call('opportunity-archive', { id }).archive;
  const stored = db.prepare('SELECT archive FROM opportunity_archives WHERE id=?').get(archiveId).archive;
  // Archive digest = SHA-256 of stored bytes, and is not written into the archive JSON (writing it changes
  // the bytes being digested).
  const archivedDetail = JSON.parse(state().audit.find(event => event.action === 'archived').detail);
  assert.equal(archivedDetail.archiveId, archiveId);
  assert.equal(archivedDetail.digest, sha256(stored));
  assert.ok(!stored.includes(archivedDetail.digest), 'the digest is not part of the archived JSON');
  assert.equal(state().opportunities[0].archives[0].integrity.status, 'verified');
  // Tamper with archive body: recalculation based on stored bytes does not match the recorded value ->
  // mismatch.
  db.prepare('UPDATE opportunity_archives SET archive=? WHERE id=?').run(stored + '（篡改）', archiveId);
  assert.equal(state().opportunities[0].archives[0].integrity.status, 'mismatch');
  // Restore original bytes -> verified (digest is bound to the byte standard, not the content).
  db.prepare('UPDATE opportunity_archives SET archive=? WHERE id=?').run(stored, archiveId);
  assert.equal(state().opportunities[0].archives[0].integrity.status, 'verified');
  // Old archive (no digest record in audit) -> unrecorded.
  const old = buildSendArchive({
    opportunity: current(), sourceRows: [], claims: null, analysis: null, answer: null,
    reviewViewed: null, viewingTrail: [], approval: {},
  });
  storeArchive(db, old);
  const unrecorded = state().opportunities[0].archives.find(archive => archive.archiveId === old.archiveId);
  assert.equal(unrecorded.integrity.status, 'unrecorded');
});

// The verification field of the archive takes the actual value written by the verification record at the
// time of verification: when the verification record lacks configuration fields
// (old records before upgrade), record null (UI displays "Unrecorded"), do not use the current workflow
// model to backfill history.
test('the archive records the model from the check record, without backfilling old records', async () => {
  const { call, current, db } = fixture(supportedClaimsReply);
  const { id } = current();
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'We will deliver on Friday.' });
  await call('opportunity-claims', { id, target: 'draft', draft_id: current().draft_id, language: 'en' });
  // The verification record saves the actual configuration into the database at the time of verification:
  const fresh = JSON.parse(current().claims_review);
  assert.equal(fresh.model, 'test double');
  assert.equal(fresh.effort, null);
  assert.deepEqual(fresh.prompts, { claims: CLAIMS_PROMPT_VERSION, analysis: ANALYSIS_PROMPT_VERSION });
  // The verification field of the profile is taken from the record:
  const archiveId = call('opportunity-archive', { id }).archive;
  const archive = loadArchive(db, archiveId);
  assert.equal(archive.verification.model, 'test double');
  assert.equal(archive.verification.effort, null);
  assert.deepEqual(archive.verification.prompts, { claims: CLAIMS_PROMPT_VERSION, analysis: ANALYSIS_PROMPT_VERSION });
  // Old verification records lacking configuration fields: the profile records null, and backfilling via
  // the workflow's current model is not performed.
  const stripped = JSON.parse(current().claims_review);
  delete stripped.model; delete stripped.effort; delete stripped.prompts;
  db.prepare('UPDATE opportunities SET claims_review=? WHERE id=?').run(JSON.stringify(stripped), id);
  const second = call('opportunity-archive', { id }).archive;
  assert.notEqual(second, archiveId);
  const old = loadArchive(db, second);
  assert.equal(old.verification.model, null);
  assert.equal(old.verification.effort, null);
  assert.equal(old.verification.prompts, null);
});
