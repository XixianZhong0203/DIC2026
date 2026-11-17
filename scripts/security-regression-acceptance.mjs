// Security regression acceptance · deterministic local mock, temporary data only.
//
// Coverage (one group per item, the check names are the kill points used by the mutation runner):
//   1. carried-over draft flags - a flag raised on an older draft version survives an edit and keeps
//      blocking the send until it is handled for the current version.
//   2. exact recipient disclosure - a protected excerpt is released only to the exact recipient that
//      was named when the protection rule was recorded.
//   3. hosted input screening - a hosted model refuses a request that carries protected source text.
//   4. placeholders - an unresolved placeholder keeps the send blocked until the draft is fixed and
//      re-verified.
//   5. claim-specific guarantee version binding - a guarantee releases exactly the draft version it was
//      recorded for and never a later one.
//   6. archive digest - the send archive digest is recorded with the approval, verifies on export and
//      reports a mismatch after the stored bytes are tampered with.
//   7. English synthetic product flow - one complete English journey: capture, assess, source, draft,
//      verify, approve, send, archive.
//   8. malformed model output - broken model output is never treated as support.
//
// The suite starts a real server from a temporary byte-level copy of the working tree; the only
// replacement is src/models.mjs, which points at the deterministic mock provider started here on
// loopback. The mock entry is deliberately flagged as a hosted endpoint so that the hosted input
// screening is exercised end to end, while the endpoint address stays on loopback: no request ever
// leaves the machine and no real model is ever called.
//
// The mock answers from the request content (never from a queue), so a scenario cannot silently drift
// when the number of model calls changes.
//
// Usage: node scripts/security-regression-acceptance.mjs

import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnGateServer, waitFor } from './approval-gate-acceptance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4241;
const MOCK_PORT = 4242;
const BASE = 'http://127.0.0.1:' + PORT;

// Product dimension label (kept in Chinese like the product surface).
const CLAIM_DIMENSION = '对外承诺';

// ---------------------------------------------------------------------------
// Deterministic mock model.
//
// The response is derived from the request content. Rules are matched by request kind and by an
// optional substring of the request context:
//   - kind 'assess'  : the lead assessment, context = the whole request payload
//   - kind 'analysis': the analysis-target claim verification, context = the whole request payload
//   - kind 'draft'   : the draft-target claim verification, context = the draft body only (the body is
//                      what distinguishes one draft scenario from another)
//   - kind 'chat'    : the chat reply
// A rule may carry `raw` to answer with an exact string (used by the malformed output cases).
// ---------------------------------------------------------------------------
const mockState = { rules: [], requests: [] };

export function setMockRules(rules) {
  mockState.rules = [...rules];
}

export function resetMock() {
  mockState.rules = [];
  mockState.requests = [];
}

export function mockRequests() {
  return mockState.requests;
}

// First sentence of a text, used to quote evidence verbatim.
function firstSentence(text) {
  const value = String(text ?? '').trim();
  const chinese = value.search(/[。！？!?；;…\n]/);
  const english = value.search(/\.\s+(?=[A-Z"'(])/);
  const cuts = [chinese, english].filter(index => index >= 0);
  if (!cuts.length) return value;
  return value.slice(0, Math.min(...cuts) + 1).trim();
}

const DEFAULT_ANALYSIS_CLAIMS = {
  claims: [
    { id: '购买意向', dimension: '购买意向', text: '', items: [],
      missing: 'No purchase commitment is recorded.', rewrite: 'The customer asked for a quote.' },
    { id: '签约状态', dimension: '签约状态', text: '', items: [],
      missing: 'No signed contract is recorded.', rewrite: 'No contract is on file yet.' },
  ],
};

const DEFAULT_CHAT_REPLY = {
  answer: 'The records do not settle this yet.', facts: [], inferences: [], unknowns: [],
  citations: [], conflict: '', proposal: null, question: '', understood: '',
};

function assessPayload(input) {
  const evidence = String(input?.evidence ?? '');
  return {
    status: 'unknown',
    quote: firstSentence(evidence),
    reason: 'The record shows interest, not a commitment.',
    unknown: 'A customer record that confirms the commitment is missing.',
    conflict: '',
    clarification: 'Should I draft a confirmation request?',
    suggestedReply: 'Could you confirm whether the order is signed?',
  };
}

function draftClaimsPayload(input, rule) {
  const sources = Array.isArray(input?.sources) ? input.sources : [];
  const claims = (rule.claims ?? []).map((claim, index) => {
    const id = claim.id ?? 'c' + (index + 1);
    const text = claim.text ?? '';
    const dimension = claim.dimension ?? CLAIM_DIMENSION;
    const status = claim.status ?? 'unknown';
    if (status === 'unknown') {
      return { id, dimension, text, items: [],
        missing: claim.missing ?? 'No customer record states this.',
        rewrite: claim.rewrite ?? 'The customer has not confirmed this yet.' };
    }
    const quote = claim.quote ?? '';
    const evidenceId = claim.evidenceId ??
      sources.find(source => String(source.text ?? '').includes(quote))?.id ?? 'E1';
    return { id, dimension, text, items: [{
      evidenceId, stance: status === 'refuted' ? 'refutes' : 'supports', quote,
      note: claim.note ?? 'The quoted record states this.', revises: [],
    }], missing: '', rewrite: '' };
  });
  return { claims };
}

// Request kind detection. Both the English and the Chinese verifier prompts are recognised, so the
// mock never depends on one prompt wording.
function classify(system, user) {
  if (/你是聊天回答的声明核查器|You are a verifier for chat answers/.test(system)) return 'chat-claims';
  if (/你是声明核查器|You are a claim verifier/.test(system)) {
    try { if (JSON.parse(user)?.mode === 'draft') return 'draft'; } catch {}
    return 'analysis';
  }
  if (/Return JSON with status/.test(system)) return 'assess';
  return 'chat';
}

export function startSecurityMock(port) {
  const server = createServer((req, res) => {
    let payload = '';
    req.on('data', chunk => { payload += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.includes('chat/completions')) {
        res.statusCode = 404; res.end('not found'); return;
      }
      let parsed;
      try { parsed = JSON.parse(payload); } catch { res.statusCode = 400; res.end('{}'); return; }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const system = messages.find(message => message.role === 'system')?.content ?? '';
      const user = messages.find(message => message.role === 'user')?.content ?? '';
      const kind = classify(system, user);
      let input = null;
      try { input = JSON.parse(user); } catch {}
      // The draft context is the body only: the sources of one lead are shared by every verification of
      // that lead, the body is what tells one draft scenario from another.
      const context = kind === 'draft' ? String(input?.draft?.body ?? '') : user;
      const rule = mockState.rules.find(entry =>
        (entry.kind ?? 'any') === kind && (!entry.when || context.includes(entry.when)));
      let content;
      if (rule?.raw != null) content = rule.raw;
      else if (kind === 'assess') content = JSON.stringify(assessPayload(input));
      else if (kind === 'analysis') content = JSON.stringify(DEFAULT_ANALYSIS_CLAIMS);
      else if (kind === 'draft') content = JSON.stringify(draftClaimsPayload(input, rule ?? {}));
      else if (kind === 'chat-claims') content = JSON.stringify({ claims: [] });
      else content = JSON.stringify(DEFAULT_CHAT_REPLY);
      mockState.requests.push({ kind, system, user, content });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  server.listen(port, '127.0.0.1');
  return { close: () => new Promise(resolve => server.close(resolve)), requests: () => mockState.requests };
}

// ---------------------------------------------------------------------------
// Temporary working directory: byte-level copy of the working tree (server.mjs + src/ + package.json),
// replacing only src/models.mjs with the mock catalog. Mutations apply to this copy only.
// ---------------------------------------------------------------------------
const MOCK_MODELS = `// Mock model catalog for the security regression acceptance window: one local mock model that
// points at the deterministic mock provider started by the script. The entry is flagged as a hosted
// endpoint (codex) on purpose, because the hosted input screening must be exercised end to end, while
// the endpoint address stays on loopback so no request ever leaves the machine.
const BASE = process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:0/v1';
export const MODELS = [{ id: 'mock-model', name: 'Mock Model', base: BASE, local: true, codex: true,
  keyEnv: 'MOCK_API_KEY', fallbackKey: 'mock', timeout: 15000, efforts: {} }];
export const modelById = id => (typeof id === 'string' && MODELS.find(entry => entry.id === id)) || null;
export const DEFAULT_MODEL_ID = 'mock-model';
export const defaultModel = () => modelById(DEFAULT_MODEL_ID) ?? MODELS[0];
export const modelKey = entry => {
  const fromEnv = entry.keyEnv ? (process.env[entry.keyEnv] ?? '').trim() : '';
  return entry.key ?? (fromEnv || entry.fallbackKey || '');
};
export const modelConfigured = entry => Boolean(entry.local || modelKey(entry));
export const conversationModel = (conv, defaultEntry) => {
  const entry = modelById(conv?.model) ?? defaultEntry;
  const effort = entry.efforts?.[conv?.effort] ? conv.effort : null;
  return { entry, effort };
};
`;

export function buildSecurityWorkDir({ mutations = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'daymark-security-regression-'));
  cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  copyFileSync(path.join(root, 'server.mjs'), path.join(dir, 'server.mjs'));
  copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  writeFileSync(path.join(dir, 'src', 'models.mjs'), MOCK_MODELS);
  for (const mutation of mutations) {
    const file = path.join(dir, mutation.file);
    const source = readFileSync(file, 'utf8');
    const count = source.split(mutation.old).length - 1;
    if (count !== 1) {
      throw new Error('mutation anchor is not unique (' + mutation.file + '): "' +
        mutation.old.slice(0, 60) + '" appears ' + count + ' times');
    }
    writeFileSync(file, source.replace(mutation.old, mutation.new));
  }
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir);
  return { dir, dataDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
function makeClient(port) {
  async function api(route, body) {
    const options = body === undefined ? { method: 'GET' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    };
    const response = await fetch('http://127.0.0.1:' + port + route, options);
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data, error: data.error ?? null };
  }
  return { api };
}

// ---------------------------------------------------------------------------
// Synthetic product data (English)
// ---------------------------------------------------------------------------
const NORTHWIND_EVIDENCE = 'Northwind Analytics asked for a quote for the reporting module and mentioned a budget of 12,000 USD. No purchase commitment was made.';
const NORTHWIND_CONFIRMATION = 'Northwind confirmed by email on 2026-11-18 that the reporting module order is signed.';
const NORTHWIND_CLAIM = 'The reporting module order is signed.';
const NORTHWIND_DRAFT = NORTHWIND_CLAIM + '\nWe will start the implementation in December.';

const VIREO_EVIDENCE = 'Vireo Logistics proposed 2026-12-05 as the delivery date for the pilot.';
const VIREO_CONFIRMATION = 'Vireo Logistics confirmed 2026-12-09 as the delivery date for the pilot.';
const VIREO_V1 = 'We will deliver the pilot on 2026-12-05.';
const VIREO_V2 = 'We will deliver the pilot on 2026-12-09.';

const HELIO_EVIDENCE = 'Helio confirmed the migration will complete within two weeks.';
const HELIO_CLAIM = 'We will deliver the migrated data within two weeks.';
const HELIO_BODY = HELIO_CLAIM + ' [TBD]';

const ACME_EVIDENCE = 'Acme Robotics asked about the deployment window for the pilot.';
const ACME_CLAIM = 'We will deploy the pilot on 2026-12-11.';
const ACME_BODY = ACME_CLAIM + ' Please confirm the kickoff date.';

const KESTREL_HOLDER_EVIDENCE = 'Kestrel Legal shared their standard terms: the annual retainer is 4800 USD.';
const KESTREL_EXCERPT = 'annual retainer is 4800 USD';
const KESTREL_PLAIN_EVIDENCE = 'Kestrel Legal asked for the renewal terms for the annual plan.';
const KESTREL_CLAIM = 'Your annual retainer is 4800 USD, as discussed.';
const ALLOWED_RECIPIENT = 'partner@example.test';
const BLOCKED_RECIPIENT = 'outsider@example.test';

const RESTRICTED_ERROR = '当前请求包含受限原文，托管模型无法使用这部分证据。请改用本地模型或人工复核。';

// ---------------------------------------------------------------------------
// Check suite
// ---------------------------------------------------------------------------
export async function runSecurityChecks({ port, record, dbFile = null }) {
  const { api } = makeClient(port);
  const base = 'http://127.0.0.1:' + port;
  const results = [];
  const rec = (name, status, detail = '') => {
    results.push({ name, status, detail });
    record(name, status, detail);
  };
  const run = async (name, fn) => {
    try { await fn(); rec(name, 'PASS'); }
    catch (error) { rec(name, 'FAIL', String(error?.message ?? error).split('\n').slice(0, 3).join(' | ')); }
  };

  resetMock();

  const state = async () => (await api('/api/state')).data;
  const findOpp = (s, id) => s.opportunities.find(o => o.id === id);
  const sendsFor = (s, id) => s.audit.filter(e => e.opportunity === id && e.action === 'simulated_send');
  // The state view keeps only the last 100 audit rows, so per-opportunity rows are read from the
  // temporary database directly.
  const logRows = id => {
    if (!dbFile) return [];
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      return db.prepare('SELECT action, detail FROM opportunity_log WHERE opportunity=? ORDER BY id').all(id);
    } finally { db.close(); }
  };
  const blockReason = id => {
    const rows = logRows(id).filter(row => row.action === 'blocked');
    const last = rows.at(-1);
    if (!last) return null;
    try { return JSON.parse(last.detail).reason ?? null; } catch { return null; }
  };
  const expectNoSend = async id => {
    assert.equal(sendsFor(await state(), id).length, 0, 'an unauthorized request must not produce a send event');
  };

  const createLead = async ({ title, evidence, evidenceKind = 'customer', source = 'Customer email' }) => {
    const created = await api('/api/opportunity', {
      kind: 'lead', title, source, evidence, evidence_kind: evidenceKind,
    });
    assert.equal(created.status, 200, 'lead creation failed: ' + created.error);
    return (await state()).opportunities[0].id;
  };
  const saveDraft = async (id, body, recipient = 'client@example.test') => {
    const saved = await api('/api/opportunity-draft', { id, recipient, body });
    assert.equal(saved.status, 200, 'draft save failed: ' + saved.error);
    return findOpp(await state(), id).draft_id;
  };
  const verifyDraft = async (id, draftId, language = 'en') => {
    const verified = await api('/api/opportunity-claims', { id, target: 'draft', draft_id: draftId, language });
    assert.equal(verified.status, 200, 'draft verification failed: ' + verified.error);
    return findOpp(await state(), id).claims;
  };
  const send = (id, draftId) => api('/api/opportunity-send', { id, draft_id: draftId });

  // -- 1) English synthetic product flow -----------------------------------
  let northwindId = null;
  let northwindDraft = null;

  await run('english-flow/assessment-states-the-missing-fact', async () => {
    setMockRules([{ kind: 'draft', when: 'reporting module', claims: [{
      text: NORTHWIND_CLAIM, status: 'supported', quote: NORTHWIND_CONFIRMATION,
      note: 'The customer confirmed the signed order.',
    }] }]);
    northwindId = await createLead({
      title: 'Northwind Analytics - reporting module', evidence: NORTHWIND_EVIDENCE,
    });
    const assessed = await api('/api/opportunity-assess', {
      id: northwindId, request: 'Can we confirm the reporting module order?', language: 'en',
    });
    assert.equal(assessed.status, 200, 'assessment failed: ' + assessed.error);
    const s = await state();
    const analysis = JSON.parse(findOpp(s, northwindId).analysis);
    assert.equal(analysis.status, 'unknown', 'an unsigned order must not be reported as confirmed');
    assert.ok(analysis.quote && NORTHWIND_EVIDENCE.includes(analysis.quote), 'the analysis quote is verbatim evidence');
    assert.ok(analysis.unknown.length > 0, 'the analysis names what is missing');
    assert.ok(analysis.clarification.length > 0, 'the analysis asks one clarifying question');
    assert.equal(findOpp(s, northwindId).answer.situation, 'insufficient');
    assert.ok(findOpp(s, northwindId).answer.missing.length > 0, 'the answer names the gap');
    const analysisRequest = mockRequests().find(entry => entry.kind === 'analysis');
    assert.ok(analysisRequest, 'the analysis verification reached the model');
    assert.ok(analysisRequest.system.startsWith('You are a claim verifier'), 'the English verifier prompt is used');
    assert.ok(!analysisRequest.system.includes('你是声明核查器'), 'the Chinese verifier prompt is not used');
  });

  await run('english-flow/customer-confirmation-updates-the-sources', async () => {
    const added = await api('/api/opportunity-source', {
      id: northwindId, name: 'Customer confirmation', date: '2026-11-18', kind: 'customer',
      text: NORTHWIND_CONFIRMATION, language: 'en',
    });
    assert.equal(added.status, 200, 'source add failed: ' + added.error);
    const s = await state();
    const opp = findOpp(s, northwindId);
    assert.equal(opp.sources.length, 1);
    assert.equal(opp.sources[0].text, NORTHWIND_CONFIRMATION);
    assert.ok(opp.claims && opp.claims.target === 'analysis', 'the analysis verification is re-run for the new source');
  });

  await run('english-flow/draft-verification-passes-on-the-confirmed-claim', async () => {
    northwindDraft = await saveDraft(northwindId, NORTHWIND_DRAFT, 'buyer@northwind.test');
    const claims = await verifyDraft(northwindId, northwindDraft);
    assert.equal(claims.error, null);
    assert.equal(claims.claims.length, 1);
    assert.equal(claims.claims[0].status, 'supported');
    assert.equal(claims.claims[0].text, NORTHWIND_CLAIM);
    const support = claims.claims[0].items.find(item => item.stance === 'supports');
    assert.ok(support, 'the claim carries a supporting citation');
    assert.equal(support.source.id, 'S1', 'the support comes from the customer confirmation source');
    assert.deepEqual(claims.draftChecks, { placeholders: [], unextracted: [] });
    const draftRequest = mockRequests().find(entry => entry.kind === 'draft');
    assert.ok(draftRequest, 'the draft verification reached the model');
    assert.ok(draftRequest.system.startsWith('You are a claim verifier'), 'the English verifier prompt is used');
    assert.ok(draftRequest.user.includes(NORTHWIND_CLAIM), 'the draft body is part of the verification input');
  });

  await run('english-flow/approval-sends-and-writes-the-archive', async () => {
    const sent = await send(northwindId, northwindDraft);
    assert.equal(sent.status, 200, 'the approved draft must send: ' + sent.error);
    const s = await state();
    assert.equal(sendsFor(s, northwindId).length, 1);
    assert.equal(findOpp(s, northwindId).sent, 1);
    const approved = logRows(northwindId).filter(row => row.action === 'approved').at(-1);
    assert.ok(approved, 'the approval is audited');
    const detail = JSON.parse(approved.detail);
    assert.equal(detail.evidence, 'model_supported');
    assert.ok(detail.archiveId, 'the approval records the archive id');
    assert.match(detail.digest, /^[0-9a-f]{64}$/, 'the approval records the archive digest');
    const archive = findOpp(s, northwindId).archives[0];
    assert.ok(archive, 'the send wrote an archive');
    assert.equal(archive.approval.body, NORTHWIND_DRAFT, 'the archive keeps the approved body');
    assert.equal(archive.approval.basis, 'model_supported');
    assert.equal(archive.verification.target, 'draft');
    assert.ok(archive.verification.prompts?.claims, 'the archive records the verification prompt version');
    assert.equal(archive.sources.length, 2, 'the archive keeps the full source snapshot');
    assert.equal(archive.sources[1].text, NORTHWIND_CONFIRMATION);
  });

  // -- 2) Archive digest ----------------------------------------------------
  await run('archive/digest-verifies-and-detects-tampering', async () => {
    const s = await state();
    const archive = findOpp(s, northwindId).archives[0];
    assert.ok(archive, 'the send wrote an archive');
    assert.equal(archive.integrity.status, 'verified');
    const exported = await fetch(base + '/api/opportunity-archive/' + archive.archiveId);
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get('x-archive-integrity'), 'verified');
    const bytes = await exported.text();
    const tampered = bytes.replace('Northwind', 'Nightwind');
    assert.notEqual(tampered, bytes, 'the archive bytes changed');
    const db = new DatabaseSync(dbFile);
    try {
      db.prepare('UPDATE opportunity_archives SET archive=? WHERE id=?').run(tampered, archive.archiveId);
    } finally { db.close(); }
    const afterTamper = await fetch(base + '/api/opportunity-archive/' + archive.archiveId);
    assert.equal(afterTamper.status, 200, 'the tampered archive is still exported for forensics');
    assert.equal(afterTamper.headers.get('x-archive-integrity'), 'mismatch');
    const tamperedState = await state();
    assert.equal(findOpp(tamperedState, northwindId).archives[0].integrity.status, 'mismatch');
    const restore = new DatabaseSync(dbFile);
    try {
      restore.prepare('UPDATE opportunity_archives SET archive=? WHERE id=?').run(bytes, archive.archiveId);
    } finally { restore.close(); }
    const restored = await fetch(base + '/api/opportunity-archive/' + archive.archiveId);
    assert.equal(restored.headers.get('x-archive-integrity'), 'verified');
  });

  // -- 3) Carried-over draft flags -----------------------------------------
  let vireoId = null;
  let vireoV2 = null;

  await run('carried-over-flags/previous-claim-blocks-send', async () => {
    setMockRules([
      { kind: 'draft', when: '2026-12-05', claims: [{ text: VIREO_V1, status: 'unknown' }] },
      { kind: 'draft', when: '2026-12-09', claims: [{ text: VIREO_V2, status: 'supported',
        quote: VIREO_CONFIRMATION, note: 'The customer confirmed the delivery date.' }] },
    ]);
    vireoId = await createLead({ title: 'Vireo Logistics - pilot delivery', evidence: VIREO_EVIDENCE });
    const added = await api('/api/opportunity-source', {
      id: vireoId, name: 'Customer confirmation', date: null, kind: 'customer',
      text: VIREO_CONFIRMATION, language: 'en',
    });
    assert.equal(added.status, 200, 'source add failed: ' + added.error);
    const v1 = await saveDraft(vireoId, VIREO_V1);
    const first = await verifyDraft(vireoId, v1);
    assert.equal(first.claims[0].status, 'unknown', 'the proposed date is not a confirmation');
    // The draft is edited: the old claim is no longer verified, but it is still an open risk.
    vireoV2 = await saveDraft(vireoId, VIREO_V2);
    const second = await verifyDraft(vireoId, vireoV2);
    assert.equal(second.claims[0].status, 'supported', 'the new draft verifies clean');
    const s = await state();
    const opp = findOpp(s, vireoId);
    assert.equal(opp.previousUnresolvedClaims.length, 1, 'the old claim carries over');
    assert.equal(opp.previousUnresolvedClaims[0].text, VIREO_V1);
    assert.equal(opp.rewritePending.length, 1, 'the carried-over claim is still pending');
    const sent = await send(vireoId, vireoV2);
    assert.equal(sent.status, 409, 'the carried-over claim must block the send');
    assert.equal(sent.error, '上一版仍有未处理声明：' + VIREO_V1);
    assert.equal(blockReason(vireoId), 'claims_previous_unresolved');
    await expectNoSend(vireoId);
  });

  await run('carried-over-flags/version-bound-review-releases', async () => {
    const reviewed = await api('/api/opportunity-claim-rewrite-review', {
      id: vireoId, draft_id: vireoV2, claim_text: VIREO_V1, verdict: 'different_fact',
      note: 'The date moved to the date the customer confirmed.',
    });
    assert.equal(reviewed.status, 200, 'the rewrite review failed: ' + reviewed.error);
    const s = await state();
    assert.equal(findOpp(s, vireoId).rewritePending.length, 0, 'the carried-over claim is handled');
    const sent = await send(vireoId, vireoV2);
    assert.equal(sent.status, 200, 'the handled claim must release the send: ' + sent.error);
    assert.equal(sendsFor(await state(), vireoId).length, 1);
  });

  // -- 4) Placeholders ------------------------------------------------------
  await run('placeholders/unresolved-placeholder-blocks-the-send', async () => {
    setMockRules([{ kind: 'draft', when: 'migrated data', claims: [{ text: HELIO_CLAIM, status: 'supported',
      quote: HELIO_EVIDENCE, note: 'The customer confirmed the migration window.' }] }]);
    const id = await createLead({ title: 'Helio - migration', evidence: HELIO_EVIDENCE });
    const draftId = await saveDraft(id, HELIO_BODY);
    const claims = await verifyDraft(id, draftId);
    assert.equal(claims.claims[0].status, 'supported', 'the claim itself is verified');
    assert.deepEqual(claims.draftChecks.placeholders, ['[TBD]']);
    const sent = await send(id, draftId);
    assert.equal(sent.status, 409, 'an unresolved placeholder must block the send');
    assert.equal(sent.error, '草稿正文仍有未确认的占位符：[TBD]。请落实后再批准发送。');
    assert.equal(blockReason(id), 'claims_placeholders');
    await expectNoSend(id);
  });

  await run('placeholders/resolved-placeholder-releases-the-send', async () => {
    const id = (await state()).opportunities.find(o => o.title === 'Helio - migration').id;
    const draftId = await saveDraft(id, HELIO_CLAIM);
    const claims = await verifyDraft(id, draftId);
    assert.deepEqual(claims.draftChecks.placeholders, []);
    const sent = await send(id, draftId);
    assert.equal(sent.status, 200, 'the fixed draft must send: ' + sent.error);
    assert.equal(sendsFor(await state(), id).length, 1);
  });

  // -- 5) Claim-specific guarantee version binding --------------------------
  await run('guarantee/version-binding-expires-with-the-draft', async () => {
    setMockRules([{ kind: 'draft', when: 'deploy the pilot', claims: [{ text: ACME_CLAIM, status: 'unknown' }] }]);
    const id = await createLead({ title: 'Acme Robotics - pilot', evidence: ACME_EVIDENCE });
    const v1 = await saveDraft(id, ACME_CLAIM);
    const claims = await verifyDraft(id, v1);
    assert.equal(claims.claims[0].status, 'unknown', 'the deployment window is not confirmed');
    const guaranteed = await api('/api/opportunity-claim-resolution', {
      id, draft_id: v1, claim_id: claims.claims[0].id, text: ACME_CLAIM,
      reason: 'I checked the pilot plan and take responsibility for this sentence.',
    });
    assert.equal(guaranteed.status, 200, 'the guarantee failed: ' + guaranteed.error);
    const released = await send(id, v1);
    assert.equal(released.status, 200, 'the guarantee releases the version it was recorded for: ' + released.error);
    const approved = logRows(id).filter(row => row.action === 'approved').at(-1);
    assert.equal(JSON.parse(approved.detail).evidence, 'human_guarantee');
    // The next draft version is a different version: the old guarantee must not release it.
    const v2 = await saveDraft(id, ACME_BODY);
    const second = await verifyDraft(id, v2);
    assert.equal(second.claims[0].status, 'unknown');
    const sent = await send(id, v2);
    assert.equal(sent.status, 409, 'a guarantee must not release a later draft version');
    assert.ok(sent.error.startsWith('以下声明核查未通过'), 'the blocked reason names the claim: ' + sent.error);
    assert.equal(blockReason(id), 'claims_unresolved');
    assert.equal(sendsFor(await state(), id).length, 1, 'only the released version produced a send event');
  });

  // -- 6) Malformed model output -------------------------------------------
  await run('malformed/non-json-verification-is-not-support', async () => {
    setMockRules([{ kind: 'draft', when: 'onboarding pack', raw: 'this is not JSON' }]);
    const id = await createLead({ title: 'Malformed - broken json', evidence: 'Orion Foods confirmed 2026-12-20 as the first delivery date.' });
    const draftId = await saveDraft(id, 'We will deliver the onboarding pack on 2026-12-20.');
    const claims = await verifyDraft(id, draftId);
    assert.ok(claims.error, 'the broken output is recorded as an incomplete verification');
    const sent = await send(id, draftId);
    assert.equal(sent.status, 409);
    assert.equal(blockReason(id), 'claims_incomplete');
    await expectNoSend(id);
  });

  await run('malformed/wrong-shape-verification-is-not-support', async () => {
    setMockRules([{ kind: 'draft', when: 'migration kit', raw: JSON.stringify({ claims: 'not a list' }) }]);
    const id = await createLead({ title: 'Malformed - wrong shape', evidence: 'Orion Foods confirmed 2026-12-21 as the first delivery date.' });
    const draftId = await saveDraft(id, 'We will deliver the migration kit on 2026-12-21.');
    const claims = await verifyDraft(id, draftId);
    assert.ok(claims.error, 'the broken shape is recorded as an incomplete verification');
    const sent = await send(id, draftId);
    assert.equal(sent.status, 409);
    assert.equal(blockReason(id), 'claims_incomplete');
    await expectNoSend(id);
  });

  await run('malformed/duplicate-claim-ids-block-the-send', async () => {
    setMockRules([{ kind: 'draft', when: 'training kit', raw: JSON.stringify({ claims: [
      { id: 'c1', dimension: CLAIM_DIMENSION, text: 'We will deliver the training kit on 2026-12-22.', items: [], missing: 'No customer record states this.', rewrite: 'The customer has not confirmed this yet.' },
      { id: 'c1', dimension: CLAIM_DIMENSION, text: 'We will deliver the training kit on 2026-12-22.', items: [], missing: 'No customer record states this.', rewrite: 'The customer has not confirmed this yet.' },
    ] }) }]);
    const id = await createLead({ title: 'Malformed - duplicate ids', evidence: 'Orion Foods confirmed 2026-12-22 as the first delivery date.' });
    const draftId = await saveDraft(id, 'We will deliver the training kit on 2026-12-22.');
    const claims = await verifyDraft(id, draftId);
    assert.ok(claims.warnings?.some(warning => warning.reason === 'duplicate_claim_id'), 'the duplicate id is reported');
    const sent = await send(id, draftId);
    assert.equal(sent.status, 409);
    assert.equal(blockReason(id), 'claims_incomplete');
    await expectNoSend(id);
  });

  await run('malformed/non-verbatim-quote-is-not-support', async () => {
    setMockRules([{ kind: 'draft', when: 'spare parts', claims: [{ text: 'We will deliver the spare parts on 2026-12-23.',
      status: 'supported', quote: 'the customer confirmed every spare parts order', note: 'invented quote' }] }]);
    const id = await createLead({ title: 'Malformed - invented quote', evidence: 'Orion Foods confirmed 2026-12-23 as the first delivery date.' });
    const draftId = await saveDraft(id, 'We will deliver the spare parts on 2026-12-23.');
    const claims = await verifyDraft(id, draftId);
    assert.equal(claims.claims[0].status, 'incomplete', 'an invented quote cannot support a claim');
    assert.ok(claims.claims[0].failedChecks.some(check => check.reason === 'quote_not_found'));
    const sent = await send(id, draftId);
    assert.equal(sent.status, 409);
    assert.equal(blockReason(id), 'claims_unresolved');
    await expectNoSend(id);
  });

  await run('malformed/claim-outside-the-draft-is-not-support', async () => {
    setMockRules([{ kind: 'draft', when: 'tooling', claims: [{ text: 'We will deliver the tooling on 2026-12-24.',
      status: 'supported', quote: 'Orion Foods confirmed 2026-12-24 as the first delivery date.',
      note: 'The customer confirmed the delivery date.' }] }]);
    const id = await createLead({ title: 'Malformed - claim outside the draft', evidence: 'Orion Foods confirmed 2026-12-24 as the first delivery date.' });
    const draftId = await saveDraft(id, 'We will deliver the tooling on 2026-12-25.');
    const claims = await verifyDraft(id, draftId);
    assert.equal(claims.claims[0].status, 'incomplete', 'a claim outside the draft cannot pass');
    assert.ok(claims.claims[0].failedChecks.some(check => check.reason === 'claim_not_in_draft'));
    const sent = await send(id, draftId);
    assert.equal(sent.status, 409);
    assert.equal(blockReason(id), 'claims_unresolved');
    await expectNoSend(id);
  });

  await run('malformed/empty-model-answer-is-not-support', async () => {
    setMockRules([{ kind: 'draft', when: 'fixtures', raw: '' }]);
    const id = await createLead({ title: 'Malformed - empty answer', evidence: 'Orion Foods confirmed 2026-12-26 as the first delivery date.' });
    const draftId = await saveDraft(id, 'We will deliver the fixtures on 2026-12-26.');
    const claims = await verifyDraft(id, draftId);
    assert.ok(claims.error, 'the empty answer is recorded as an incomplete verification');
    const sent = await send(id, draftId);
    assert.equal(sent.status, 409);
    assert.equal(blockReason(id), 'claims_incomplete');
    await expectNoSend(id);
  });

  await run('malformed/broken-assessment-is-not-support', async () => {
    setMockRules([{ kind: 'assess', raw: 'I am not JSON at all' }]);
    const id = await createLead({ title: 'Malformed - broken assessment', evidence: 'Pinnacle Retail asked about the return policy.' });
    const assessed = await api('/api/opportunity-assess', {
      id, request: 'Is the order confirmed?', language: 'en',
    });
    assert.equal(assessed.status, 200, 'a broken answer must not crash the request');
    const s = await state();
    const analysis = JSON.parse(findOpp(s, id).analysis);
    assert.equal(analysis.status, 'unknown', 'a broken answer is never a confirmation');
    assert.equal(analysis.parsed, false);
    const draftId = await saveDraft(id, 'Could you confirm the return policy?');
    const sent = await send(id, draftId);
    assert.equal(sent.status, 409);
    assert.equal(blockReason(id), 'unresolved_evidence');
    await expectNoSend(id);
  });

  // -- 7) Exact recipient disclosure ---------------------------------------
  // The protected excerpt lives in one lead; the drafts that quote it belong to other leads. The rule
  // is recorded only after the drafts are verified, because a hosted model must refuse a request that
  // carries the protected text (see the hosted input screening group below).
  let disclosureHolderId = null;
  let allowedLeadId = null;
  let blockedLeadId = null;
  let allowedDraft = null;
  let blockedDraft = null;

  await run('disclosure/protected-excerpt-is-bound-to-one-recipient', async () => {
    setMockRules([{ kind: 'draft', when: 'annual retainer', claims: [{ text: KESTREL_CLAIM, status: 'supported',
      quote: KESTREL_PLAIN_EVIDENCE, note: 'The customer asked for the renewal terms.' }] }]);
    disclosureHolderId = await createLead({ title: 'Kestrel Legal - protected terms', evidence: KESTREL_HOLDER_EVIDENCE });
    allowedLeadId = await createLead({ title: 'Kestrel Legal - renewal for the partner', evidence: KESTREL_PLAIN_EVIDENCE });
    blockedLeadId = await createLead({ title: 'Kestrel Legal - renewal for another address', evidence: KESTREL_PLAIN_EVIDENCE });
    allowedDraft = await saveDraft(allowedLeadId, KESTREL_CLAIM, ALLOWED_RECIPIENT);
    const allowedClaims = await verifyDraft(allowedLeadId, allowedDraft);
    assert.equal(allowedClaims.claims[0].status, 'supported');
    blockedDraft = await saveDraft(blockedLeadId, KESTREL_CLAIM, BLOCKED_RECIPIENT);
    const blockedClaims = await verifyDraft(blockedLeadId, blockedDraft);
    assert.equal(blockedClaims.claims[0].status, 'supported');
    const rule = await api('/api/opportunity-source-disclosure', {
      id: disclosureHolderId, source_id: 'E1', scope: 'recipient',
      excerpt: KESTREL_EXCERPT, recipient: ALLOWED_RECIPIENT,
    });
    assert.equal(rule.status, 200, 'the protection rule failed: ' + rule.error);
    const s = await state();
    const holder = findOpp(s, disclosureHolderId);
    assert.equal(holder.disclosureRules.length, 1);
    assert.equal(holder.disclosureRules[0].recipient, ALLOWED_RECIPIENT);
  });

  await run('disclosure/other-recipient-is-blocked', async () => {
    const sent = await send(blockedLeadId, blockedDraft);
    assert.equal(sent.status, 409, 'another recipient must not receive the protected excerpt');
    assert.equal(sent.error, '当前收件人无权收到草稿中的受限内容。');
    assert.equal(blockReason(blockedLeadId), 'disclosure_restricted');
    const s = await state();
    assert.equal(findOpp(s, blockedLeadId).disclosureConflicts.length, 1, 'the conflict is surfaced');
    assert.equal(findOpp(s, blockedLeadId).disclosureConflicts[0].allowedRecipient, ALLOWED_RECIPIENT);
    await expectNoSend(blockedLeadId);
  });

  await run('disclosure/exact-recipient-is-allowed', async () => {
    const sent = await send(allowedLeadId, allowedDraft);
    assert.equal(sent.status, 200, 'the exact recipient must be released: ' + sent.error);
    assert.equal(sendsFor(await state(), allowedLeadId).length, 1);
    const approved = logRows(allowedLeadId).filter(row => row.action === 'approved').at(-1);
    const detail = JSON.parse(approved.detail);
    assert.equal(detail.recipient, ALLOWED_RECIPIENT);
    assert.ok(detail.disclosure.some(entry => entry.decision === 'allowed'), 'the release records the disclosure decision');
  });

  // -- 8) Hosted input screening -------------------------------------------
  await run('hosted-input/protected-text-is-refused', async () => {
    const assessed = await api('/api/opportunity-assess', {
      id: disclosureHolderId, request: 'Can you confirm the annual retainer?', language: 'en',
    });
    assert.equal(assessed.status, 409, 'a hosted model must refuse a request that carries protected text');
    assert.equal(assessed.error, RESTRICTED_ERROR);
    const chat = await api('/api/chat', {
      text: 'Please repeat the annual retainer is 4800 USD figure for the partner.',
      language: 'en',
    });
    assert.equal(chat.status, 409, 'the chat path refuses the protected text as well');
    assert.equal(chat.error, RESTRICTED_ERROR);
  });

  await run('hosted-input/protected-text-is-refused-for-the-draft-check', async () => {
    // The protected text sits in the source set of this lead, so the verification request carries it
    // while the draft body stays clean (no disclosure conflict of its own).
    setMockRules([{ kind: 'draft', when: 'renewal terms', claims: [{ text: 'We can send the renewal terms.',
      status: 'supported', quote: KESTREL_HOLDER_EVIDENCE, note: 'The customer shared the standard terms.' }] }]);
    const id = await createLead({ title: 'Kestrel Legal - terms in the source set', evidence: KESTREL_HOLDER_EVIDENCE });
    const draftId = await saveDraft(id, 'We can send the renewal terms.');
    const verified = await api('/api/opportunity-claims', {
      id, target: 'draft', draft_id: draftId, language: 'en',
    });
    assert.equal(verified.status, 200, 'the request itself is handled');
    const claims = findOpp(await state(), id).claims;
    assert.equal(claims.error, RESTRICTED_ERROR, 'the refusal is recorded on the verification');
    const sent = await send(id, draftId);
    assert.equal(sent.status, 409, 'a refused verification cannot release the send');
    assert.equal(blockReason(id), 'claims_incomplete');
    await expectNoSend(id);
  });

  return results;
}

// ---------------------------------------------------------------------------
// Direct run: node scripts/security-regression-acceptance.mjs
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  console.log('Acceptance: 安全回归（草稿遗留标记 / 精确收件人披露 / 托管输入筛查 / 占位符 / 逐条担保版本绑定 / 档案摘要 / 英文合成流程 / 模型输出畸形）');
  const results = [];
  const record = (name, status, detail = '') => {
    results.push({ name, status, detail });
    console.log('  ' + status + '  ' + name + (detail ? '  · ' + detail : ''));
  };
  const mock = startSecurityMock(MOCK_PORT);
  const workDir = buildSecurityWorkDir();
  const server = spawnGateServer({ dir: workDir.dir, dataDir: workDir.dataDir, port: PORT, mockPort: MOCK_PORT });
  const cleanup = code => {
    server.stop().then(async () => {
      await mock.close();
      try { rmSync(workDir.dir, { recursive: true, force: true }); } catch {}
      process.exit(code);
    });
  };
  if (!(await waitFor(BASE, server))) {
    console.log('FAIL  server did not start（若提示端口占用，检查是否有残留 Daymark 进程）\n' + server.log());
    cleanup(1);
  }
  try {
    const checks = await runSecurityChecks({
      port: PORT, record, dbFile: workDir.dataDir + '/daymark.sqlite',
    });
    const passed = checks.filter(row => row.status === 'PASS').length;
    const failed = checks.filter(row => row.status === 'FAIL');
    console.log('\n' + checks.length + ' 项检查：' + passed + ' 通过，' + failed.length + ' 失败' +
      (mock.requests().length ? '，mock 模型请求 ' + mock.requests().length + ' 次' : ''));
    for (const item of failed) console.log('  FAIL  ' + item.name + (item.detail ? '  · ' + item.detail : ''));
    cleanup(failed.length ? 1 : 0);
  } catch (error) {
    console.log('FAIL  suite crashed: ' + (error.stack ?? error));
    cleanup(1);
  }
}
