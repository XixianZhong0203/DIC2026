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
// Distinguish situations so that "how to phrase" and "how to proceed" each have clear boundaries:
// insufficient Insufficient evidence - Existing materials only support partial conclusions: state clearly
// what is confirmed, what is missing, and the next steps.
// conflict Source conflict - Sources contradict each other: display records that need comparison without
// jumping to conclusions.
// failed Verification failed - Model verification failed: prompt that it can be retried (original text and
// sources are not affected by the failure).
// sufficient Sufficient evidence - Provide a clear and bounded conclusion: up to which step it is
// confirmed and which step remains to be confirmed.
// partial Partially supported - Supported claims coexist with unknown / refuted / incomplete / founder_only /
// unconfirmed claims: keep the supported part, surface the pending matters, and resolve missing evidence
// before relying on the full conclusion.
//
// This is the single source of truth for "how to phrase": the clue workflow and decision cards both
// consume it, keeping wording consistent.
// Pure function, no I/O, no model calls - the model is only responsible for producing raw materials
// (status/quote/unknown/...), while the wording and boundaries here are determined by deterministic code,
// which is unit-testable and replayable.

export const SITUATIONS = ['sufficient', 'insufficient', 'conflict', 'failed', 'partial'];

// Deterministic fallback wording for the situations where the analysis did not supply usable answer texts.
// Each entry is authored bilingually (Chinese source text + English): the optional bundle language selects the
// active copy, and structured fallbacks on the bundle take precedence for callers that author custom wording.
// These strings are newly authored deterministic copy; user and source quotations (quotes, rewrites, supplied
// answers) are never translated or altered.
const FALLBACKS = {
  failed: { next: { zh: '模型核查失败，可重试（重新核查）。原文与来源记录不受本次失败影响。', en: 'Model verification failed. It can be retried (re-run). The original text and sources are unaffected by this failure.' } },
  conflict: { missing: { zh: '来源相互矛盾，先比较下列记录再下结论。', en: 'The sources contradict each other; compare the records before concluding.' }, next: { zh: '请确认哪条记录为准，或补充更新的、更权威的资料。', en: 'Confirm which record should prevail, or add a more authoritative source.' } },
  sufficient: { next: { zh: '可依据已确认内容继续。', en: 'Proceed on the basis of the confirmed content.' } },
  insufficient: { missing: { zh: '现有材料不足以支持关键结论。', en: 'The available materials do not support the key conclusion yet.' }, next: { zh: '请补充资料，或用澄清问题继续。', en: 'Add the missing materials, or continue with clarifying questions.' } },
  partial: { missing: { zh: '存在仍需确认的说法，先补齐证据再据此下结论。', en: 'Some statements still need evidence; resolve them before relying on the conclusion.' }, next: { zh: '请先补充能支持该说法的来源，或针对缺失的声明重新核查，再据此下结论。', en: 'Add a source that supports this statement, or re-verify the unresolved claim before relying on it.' } },
};

const fallbackText = (bundle, situation, field) => {
  const authored = FALLBACKS[situation]?.[field];
  const fallback = bundle.fallbacks?.[situation]?.[field] ?? authored;
  const text = typeof fallback === 'string' ? { zh: fallback, en: fallback } : fallback ?? {};
  return bundle.language === 'en' ? (text.en ?? '') : (text.zh ?? '');
};

// Convert the evidence bundle into a structured answer. For bundle fields, see buildAnswerBundle
// (opportunities.mjs).
export function evidenceAnswer(bundle) {
  const b = bundle ?? {};
  const copy = (zh, en) => b.language === 'en' ? en : zh;
  const label = claim => claimLabel(claim, b.language);
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
      next: fallbackText(b, 'failed', 'next'),
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
      missing: fallbackText(b, 'conflict', 'missing'),
      bounds: '',
      next: b.clarification || b.suggestedReply || fallbackText(b, 'conflict', 'next'),
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
  // When supported claims coexist with unresolved ones (unknown / refuted / incomplete / founder_only /
  // unconfirmed), the answer is "partial": the supported part is kept, the pending matters are surfaced, and
  // missing evidence is resolved before the full conclusion is relied on. Only fully supported answers stay
  // "sufficient".
  if (supported.length) {
    const hasUnresolved = unknown.length + refuted.length + incomplete.length + pending.length > 0;
    const situation = hasUnresolved ? 'partial' : 'sufficient';
    const confirmed = supported.map(claim => claim.rewrite || label(claim)).join('；');
    const open = unknown.map(claim => claim.missing || label(claim)).join('；');
    const refutedNote = refuted.map(claim => label(claim) + copy(' 被来源反驳', ' is contradicted by a source')).join('；');
    const incompleteNote = incomplete.map(claim => label(claim) + copy(' 未完成核查', ' has incomplete verification')).join('；');
    // Pending items are also classified into the conclusion boundary: conclusions only extend to the
    // supported parts, and statements backed by founder statements and unconfirmed sources are explicitly
    // marked as "pending independent verification / pending verification".
    const pendingNote = pending.map(claim => label({ dimension: claim.dimension, text: claim.text })
      + (claim.status === 'founder_only' ? copy('（仅创始人陈述，待独立核实）', ' (founder statement only; independent verification needed)') : copy('（来源未确认，待核实）', ' (source identity unconfirmed; verification needed)'))).join('；');
    const bounds = [open, refutedNote, incompleteNote, pendingNote].filter(Boolean).join('；') || copy('暂无仍未确认项。', 'No unresolved items among the extracted claims.');
    return {
      situation,
      confirmed,
      missing: open,
      bounds,
      next: situation === 'partial'
        ? (fallbackText(b, 'partial', 'next') + (b.suggestedReply || b.clarification ? ' ' + (b.suggestedReply || b.clarification) : ''))
        : (b.suggestedReply || b.clarification || fallbackText(b, 'sufficient', 'next')),
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
    || fallbackText(b, 'insufficient', 'missing');
  return {
    situation: 'insufficient',
    confirmed: b.quote || b.reason || '',
    missing,
    bounds: '',
    next: b.suggestedReply || b.clarification || fallbackText(b, 'insufficient', 'next'),
    retryable: false,
    compare: [],
    supporting: [],
    pending,
    incomplete: incomplete.map(claim => claim.dimension || claim.id).filter(Boolean),
  };
}

const DIMENSION_EN = { '购买意向': 'Purchase intent', '签约状态': 'Signing status', '付款状态': 'Payment status', '交付时间': 'Delivery time', '交付状态': 'Delivery status', '预算': 'Budget', '对外承诺': 'External commitment', '功能范围': 'Feature scope' };
function claimLabel(claim, language) {
  const en = language === 'en';
  const dimension = en ? (DIMENSION_EN[claim?.dimension] ?? claim?.dimension) : claim?.dimension;
  return (dimension ? dimension + (en ? ': ' : '：') : '') + (claim?.text || (en ? '(No claim text returned)' : '（模型未返回声明原文）'));
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
