import { createHash, randomUUID } from 'node:crypto';

// Send archive (send-archive window): an immutable snapshot of a (simulated) send operation.
//
// Design principle - self-contained: the archive embeds all judgment raw materials (the draft body and
// recipients at the time, the full text of the source snapshot, item-by-item statement judgments and
// citations, viewing records, verification model/thinking tier/prompt version, approval basis and approval
// time), retaining no pointers to active data. Therefore, no matter how the source or draft is modified
// after sending, the old archive can still restore "what was approved based on what at that time" (the
// acceptance line of this window).
//
// Integrity (change detection): calculate SHA-256 for the "actually saved JSON bytes" upon archiving
// (storeArchive returns the digest without writing it into the archive JSON itself -- writing it would
// change the byte standard), and the digest is written into the approval audit along with the archive ID
// (written to approved in window 1, written to archived upon manual freeze); during export, recalculate
// and compare using the same byte standard, with results verified (verification passed) / mismatch
// (archive content inconsistent with approval record) / unrecorded (no integrity record, old archive). The
// verification configuration (model/thinking tier/prompt version) in the archive JSON takes the actual
// value written by the verification record at the moment of verification, and old verification records
// lacking fields are recorded as null (the interface displays "Unrecorded"), without backfilling history
// using the current configuration at the freeze moment.
//
// Division of labor (window alignment): This window: archive fields (schema), builder buildSendArchive,
// storage (including archive summary), export (/api/opportunity-archive/:id, including integrity check),
// and the interface's three-tier source, verification configuration, and integrity display. Window 1:
// writing after passing the /api/opportunity-send threshold -- reusing the pure function below, where the
// approval passed is taken from the approved audit at the time (basis/sentAt subject to the sending time),
// and the digest returned by storeArchive is written by window 1 into the approval audit (approved) along
// with the archive ID. The builder is the sole source of truth for the schema; it is shared between manual
// freezing before sending (/api/opportunity-archive) and writing during sending.

export const SCHEMA_VERSION = 2;

const sha256 = value => createHash('sha256').update(value).digest('hex');

// Source snapshot: initial sources (E1, identity determined by user-entered evidence_kind) + sources added
// one by one (S<id>). Same shape as verification inputs (verificationSources in opportunities.mjs): this
// snapshot is the "sources provided to the model".
export function sourceSnapshot(opportunity, sourceRows) {
  return [
    { id: 'E1', source: opportunity.source, date: null, kind: opportunity.evidence_kind ?? 'unconfirmed', text: opportunity.evidence },
    ...(sourceRows ?? []).map(row => ({ id: 'S' + row.id, source: row.name, date: row.date ?? null, kind: row.kind, text: row.text })),
  ];
}

// Archive builder: Captures all evaluation materials at the moment of sending (or freezing) into a
// self-contained snapshot.
// Distinguishes the three tiers of sources here once and for all (the UI displays directly using these
// fields):
// sourcesProvidedToModel = Complete set of inputs provided to the model (all snapshot IDs);
// answerCitedSources = Sources cited by the answer = Sources of analytical verbatim excerpts (E1, when
// excerpts exist) + sources explicitly specified by the structured answer (answer.supporting);
// claims[].supportingSources = Sources supporting the claim in verification judgment = Sources of valid
// citations with stance=supports in each claim.
export function buildSendArchive(ctx) {
  const {
    opportunity, sourceRows, claims = null, analysis = null, answer = null,
    reviewViewed = null, viewingTrail = [], approval = {},
  } = ctx;

  const snapshot = sourceSnapshot(opportunity, sourceRows);
  const byId = new Map(snapshot.map(source => [source.id, source]));
  const entryOf = id => {
    const source = byId.get(id);
    return source ? { id: source.id, name: source.source, kind: source.kind, date: source.date } : null;
  };

  // Answer cited sources: Analytical verbatim citations originate from the initial sources (E1);
  // answer.supporting represents the sources explicitly specified by the answer.
  const cited = new Map();
  if (analysis?.quote?.trim()) cited.set('E1', 'E1');
  for (const entry of answer?.supporting ?? []) {
    if (byId.has(entry.id)) cited.set(entry.id, entry.id);
  }

  const claimEntries = (claims?.claims ?? []).map(claim => {
    const items = claim.items ?? [];
    const supporting = items.filter(entry => entry.valid && entry.stance === 'supports' && entry.source?.id);
    return {
      id: claim.id,
      dimension: claim.dimension,
      text: claim.text,
      status: claim.status,
      withdrawn: claim.withdrawn ?? false,
      // Per-item guarantee reasons: The stance, verbatim citation, explanation, and programmatic
      // validation status of each citation.
      items: items.map(entry => ({
        evidenceId: entry.evidenceId, stance: entry.stance, quote: entry.quote,
        note: entry.note, revises: entry.revises ?? [], valid: entry.valid,
        reasons: entry.reasons ?? [],
      })),
      // Sources supporting the claim in verification judgment: Valid citations with stance=supports,
      // deduplicated by source while preserving order.
      supportingSources: [...new Map(supporting.map(entry => [entry.source.id, entry])).values()]
        .map(entry => ({ id: entry.source.id, name: entry.source.source, kind: entry.source.kind,
          quote: entry.quote, note: entry.note })),
      missing: claim.missing ?? '',
      rewrite: claim.rewrite ?? '',
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    archiveId: randomUUID(),
    opportunityId: opportunity.id,
    kind: opportunity.kind,
    title: opportunity.title,
    // Approval time: Pass the true sending timestamp when sent from window 1; pass the freezing timestamp
    // when manually frozen.
    sentAt: approval.sentAt ?? new Date().toISOString(),
    sent: approval.sent ?? Boolean(opportunity.sent),
    approval: {
      draftId: approval.draftId ?? opportunity.draft_id ?? null,
      recipient: approval.recipient ?? opportunity.recipient ?? null,
      // Draft at the time: The body is an immutable snapshot; subsequent changes to the active draft will
      // not affect the archive.
      body: approval.body ?? opportunity.body ?? null,
      bodyHash: approval.bodyHash ?? sha256(opportunity.body ?? ''),
      mode: approval.mode ?? null,
      // human_review = Manual review conclusion for the current draft and sources; model_supported = Draft
      // claims passed verification;
      // pending = Failed to meet sending thresholds at the time of freezing.
      basis: approval.basis ?? 'pending',
      resolution: approval.resolution ?? null,
      guarantees: approval.guarantees ?? [],
      reviewedCoverage: approval.reviewedCoverage ?? [],
      disclosure: approval.disclosure ?? [],
    },
    // Source snapshot (including full text): Even if sources are modified after sending, this preserves
    // the sources as they were at that time.
    sources: snapshot,
    sourcesProvidedToModel: snapshot.map(source => source.id),
    answerCitedSources: [...cited.values()].map(entryOf).filter(Boolean),
    verification: {
      // Fetch the three configuration items taking the actual values recorded in the verification record
      // at the time of verification (written by runClaimsReview), without passing from ctx:
      // Missing fields in old verification records -> The three items are null (UI displays "Not
      // recorded"), avoiding backfilling history with the current configuration at the freeze time;
      // effort=null = Endpoint default tier (verification path does not send reasoning_effort).
      model: claims?.model ?? null,
      effort: claims?.effort ?? null,
      prompts: claims?.prompts ?? (claims?.promptVersion ? { claims: claims.promptVersion, analysis: null } : null),
      target: claims?.target ?? null,
      at: claims?.at ?? null,
      // Record the reason when verification fails (original text and sources are unaffected by the
      // failure, and the archive faithfully presents "Verification incomplete").
      error: claims?.error ?? null,
      // Verification binding: Fingerprint of "what the judgment was based on at the
      // time"—draft/recipient/body hash/source set fingerprint.
      evidenceHash: claims?.evidenceHash ?? null,
      draftId: claims?.draftId ?? null,
      recipient: claims?.recipient ?? null,
      bodyHash: claims?.bodyHash ?? null,
    },
    claims: claimEntries,
    answer: answer ?? null,
    analysis: analysis ? {
      analysisId: analysis.analysisId ?? null,
      status: analysis.status ?? null,
      quote: analysis.quote ?? '',
      reason: analysis.reason ?? '',
    } : null,
    // View records: viewed/viewedNames are sources expanded under the bound state (draft + source set) at
    // the freezing moment;
    // records are all viewing action trajectories (each with its own binding and timestamp) for complete
    // reconstruction.
    viewing: {
      draftId: reviewViewed?.draftId ?? null,
      evidence: reviewViewed?.evidence ?? null,
      viewed: reviewViewed?.viewed ?? [],
      viewedNames: (reviewViewed?.viewed ?? []).map(id => byId.get(id)?.source ?? id),
      records: viewingTrail.map(entry => ({
        sourceId: entry.sourceId, name: entry.name, kind: entry.kind,
        draftId: entry.draftId ?? null, evidence: entry.evidence ?? null, time: entry.time ?? null,
      })),
    },
  };
}

// -- Storage (opportunity_archives): Archives are immutable snapshots, insert-only, never updated --

export function createArchiveTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_archives (
      id TEXT PRIMARY KEY, opportunity TEXT NOT NULL, created TEXT NOT NULL, archive TEXT NOT NULL
    );
  `);
}

// Returns the digest of actual stored bytes (digest = SHA-256(archive column bytes)). The caller (window 1
// sending moment /
// manual freezing) writes it into the audit along with archiveId, and recalculates for comparison during
// export using the same byte standard—therefore the digest
// is not written into the archive JSON (writing it would change the bytes being digested).
export function storeArchive(db, archive) {
  const bytes = JSON.stringify(archive);
  db.prepare('INSERT INTO opportunity_archives(id, opportunity, created, archive) VALUES (?,?,?,?)')
    .run(archive.archiveId, archive.opportunityId, new Date().toISOString(), bytes);
  return { archive, digest: sha256(bytes) };
}

// Get archive row: raw is the original bytes of the column (for integrity check and export byte
// standards), parsed is the parsed object.
export function loadArchiveRow(db, archiveId) {
  const row = db.prepare('SELECT id, opportunity, archive FROM opportunity_archives WHERE id=?').get(archiveId);
  if (!row) return null;
  let parsed;
  try { parsed = JSON.parse(row.archive); } catch { parsed = null; }
  return { id: row.id, opportunity: row.opportunity, raw: row.archive, parsed };
}

export function loadArchive(db, archiveId) {
  return loadArchiveRow(db, archiveId)?.parsed ?? null;
}

// -- Integrity check: Recalculate SHA-256 on archive column bytes and compare with the digest recorded in
// the audit --
// Recorded in audit events under detail with this archive's archiveId + digest (approved = written at
// window 1 sending moment,
// archived = written at manual freeze); no record -> unrecorded (legacy archive, UI displays "No integrity
// record").
// When a record exists, recalculate actual using current bytes: consistent -> verified, inconsistent ->
// mismatch (archive content inconsistent with approval record).
export function archiveIntegrity(db, opportunityId, archiveId, storedBytes) {
  const recorded = db.prepare(`
    SELECT detail FROM opportunity_log
    WHERE opportunity=? AND action IN ('approved','archived') AND detail IS NOT NULL
    ORDER BY time DESC, id DESC
  `).all(opportunityId)
    .map(row => { try { return JSON.parse(row.detail); } catch { return null; } })
    .find(detail => detail?.archiveId === archiveId && typeof detail.digest === 'string');
  if (!recorded) return { status: 'unrecorded' };
  const actual = sha256(storedBytes);
  return { status: actual === recorded.digest ? 'verified' : 'mismatch', digest: recorded.digest, actual };
}

export function archivesForOpportunity(db, opportunityId) {
  return db.prepare('SELECT archive FROM opportunity_archives WHERE opportunity=? ORDER BY created DESC, rowid DESC').all(opportunityId)
    .map(row => { try { return JSON.parse(row.archive); } catch { return null; } })
    .filter(Boolean);
}
