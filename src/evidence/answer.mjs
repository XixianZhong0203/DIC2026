// How to phrase and how to proceed when evidence is insufficient (evidence answer).
//
// Convert an "evidence bundle" (a single clue analysis result + itemized statement verification + source
// original text) into a structured, deterministic answer covering four aspects:
// What is confirmed (confirmed) / What information is missing (missing) / What to do next (next)
// / Which sources to point to (supporting).
//
// Extracted statements marked as "founder_only" and "unconfirmed" are not counted as confirmed, and are
// listed separately as pending items (pending): conclusions extend only to parts supported by customer
// sources, and pending items remain always visible and will not be omitted by summaries.
//
// Distinguish four situations so that "how to phrase" and "how to proceed" each have clear boundaries:
// insufficient Insufficient evidence - Existing materials only support partial conclusions: state clearly
// what is confirmed, what is missing, and the next steps.
// conflict Source conflict - Sources contradict each other: display records that need comparison without
// jumping to conclusions.
// failed Verification failed - Model verification failed: prompt that it can be retried (original text and
// sources are not affected by the failure).
// sufficient Sufficient evidence - Provide a clear and bounded conclusion: up to which step it is
// confirmed and which step remains to be confirmed.
//
// This is the single source of truth for "how to phrase": the clue workflow and decision cards both
// consume it, keeping wording consistent.
// Pure function, no I/O, no model calls - the model is only responsible for producing raw materials
// (status/quote/unknown/...), while the wording and boundaries here are determined by deterministic code,
// which is unit-testable and replayable.

export const SITUATIONS = ['sufficient', 'insufficient', 'conflict', 'failed'];

// Convert the evidence bundle into a structured answer. For bundle fields, see buildAnswerBundle
// (opportunities.mjs).
export function evidenceAnswer(bundle) {
  const b = bundle ?? {};
  const claims = Array.isArray(b.claims) ? b.claims : [];
  const sources = Array.isArray(b.sources) ? b.sources : [];
  const bySourceId = new Map(sources.map(source => [source.id, source]));

  const of = status => claims.filter(claim => claim?.status === status);
  const supported = of('supported');
  const conflicted = of('conflict');
  const unknown = of('unknown');
  const refuted = of('refuted');
  const incomplete = of('incomplete');
  // Pending items: extracted statements that are founder_only and unconfirmed.
  // They may coexist with other statements (e.g., intent is supported by customer sources, but signing
  // status only has founder statements),
  // so they are listed statement by statement rather than collapsed into a single missing-gap text.
  const pending = [
    ...of('founder_only').map(claim => pendingItem(claim, 'founder_only')),
    ...of('unconfirmed').map(claim => pendingItem(claim, 'unconfirmed')),
  ];

  // --- Verification failed: Model verification failed, prompt that it can be retried (original text and
  // sources are not affected by the failure) -----------
  if (b.error) {
    return {
      situation: 'failed',
      confirmed: '',
      missing: '',
      bounds: '',
      next: '模型核查失败，可重试（重新核查）。原文与来源记录不受本次失败影响。',
      retryable: true,
      compare: [],
      supporting: [],
      pending: [],
      incomplete: incomplete.map(claim => claim.dimension || claim.id).filter(Boolean),
    };
  }

  // --- Source conflict: Display records that need comparison, do not make arbitrary conclusions
  // ---------------------------
  if (conflicted.length) {
    const compare = [];
    for (const claim of conflicted) {
      for (const entry of [...(claim.conflict?.supports ?? []), ...(claim.conflict?.opposes ?? [])]) {
        if (!entry?.valid || !entry.source) continue;
        compare.push({
          id: entry.source.id,
          label: entry.source.source ?? entry.source.id,
          stance: entry.stance,
          quote: entry.quote ?? '',
          text: entry.source.text ?? '',
        });
      }
    }
    return {
      situation: 'conflict',
      confirmed: '',
      missing: '来源相互矛盾，先比较下列记录再下结论。',
      bounds: '',
      next: b.clarification || b.suggestedReply || '请确认哪条记录为准，或补充更新的、更权威的资料。',
      retryable: false,
      compare,
      supporting: [],
      pending,
      incomplete: [],
    };
  }

  // --- Sufficient evidence: At least one key statement is supported by sources -> Clear and bounded
  // conclusion ------------
  // Confirmed = Supported statements (claims that existing evidence can actually back up);
  // Boundary = Parts still unconfirmed/refuted/incomplete (explicitly state that the conclusion only goes
  // this far).
  if (supported.length) {
    const confirmed = supported.map(claim => claim.rewrite || claimLabel(claim)).join('；');
    const open = unknown.map(claim => claim.missing || claimLabel(claim)).join('；');
    const refutedNote = refuted.map(claim => claimLabel(claim) + ' 被来源反驳').join('；');
    const incompleteNote = incomplete.map(claim => claimLabel(claim) + ' 未完成核查').join('；');
    // Pending items are also classified into the conclusion boundary: conclusions only extend to the
    // supported parts, and statements backed by founder statements and unconfirmed sources are explicitly
    // marked as "pending independent verification / pending verification".
    const pendingNote = pending.map(claim => claimLabel({ dimension: claim.dimension, text: claim.text })
      + (claim.status === 'founder_only' ? '（仅创始人陈述，待独立核实）' : '（来源未确认，待核实）')).join('；');
    const bounds = [open, refutedNote, incompleteNote, pendingNote].filter(Boolean).join('；') || '暂无仍未确认项。';
    return {
      situation: 'sufficient',
      confirmed,
      missing: open,
      bounds,
      next: b.suggestedReply || b.clarification || '可依据已确认内容继续。',
      retryable: false,
      compare: [],
      supporting: supportingSources(supported, bySourceId),
      pending,
      incomplete: incomplete.map(claim => claim.dimension || claim.id).filter(Boolean),
    };
  }

  // --- Insufficient evidence: No key statement is supported by sources -> Clearly state what is
  // confirmed, what is missing, and the next steps --------
  // Confirmed = Verbatim-checked original excerpts (or judgment basis); Missing = Specifically what
  // information is missing;
  // Next step = Actionable suggestions (such as sending a case study and asking about procurement plans).
  const missing = b.unknown || unknown.map(claim => claim.missing).filter(Boolean).join('；')
    || '现有材料不足以支持关键结论。';
  return {
    situation: 'insufficient',
    confirmed: b.quote || b.reason || '',
    missing,
    bounds: '',
    next: b.suggestedReply || b.clarification || '请补充资料，或用澄清问题继续。',
    retryable: false,
    compare: [],
    supporting: [],
    pending,
    incomplete: incomplete.map(claim => claim.dimension || claim.id).filter(Boolean),
  };
}

function claimLabel(claim) {
  return (claim?.dimension ? claim.dimension + '：' : '') + (claim?.text || '（模型未返回声明原文）');
}

// Pending items: dimension of the statement along with original text + reason for pending (founder_only /
// unconfirmed),
// leaving the phrasing to be rendered by the consumer (answer card) based on existing status tags.
function pendingItem(claim, status) {
  return { dimension: claim.dimension ?? '', text: claim.text ?? '', status };
}

// Source pointed to by current conclusion: extract verbatim sources with stance=supports from the
// supported claim, deduplicate while preserving order.
function supportingSources(supportedClaims, bySourceId) {
  const seen = new Map();
  for (const claim of supportedClaims) {
    for (const item of claim.items ?? []) {
      const source = item?.source;
      if (item?.stance !== 'supports' || !source?.id || !bySourceId.has(source.id)) continue;
      const row = bySourceId.get(source.id);
      seen.set(source.id, { id: source.id, label: row?.name ?? source.source ?? source.id });
    }
  }
  return [...seen.values()];
}
