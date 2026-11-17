// Cross-version statement matching (Window 1: A previously flagged risk statement in an old version still
// needs to be processed after being rephrased).
// When a flagged original sentence in an old draft no longer appears verbatim in the new body text, it
// might just be a synonymous rewrite:
// - Synonymous rewrite of the same fact ("Contract signed" -> "Both parties have completed signing") ->
// same_fact: The original risk remains to be addressed;
// - Rewritten into a different fact (-> "Customer has expressed intent to sign" / "Both parties have not
// signed yet") -> different_fact: The original statement is no longer valid;
// - Unable to determine if it is the same fact (-> "Both parties will sign next week") -> ambiguous: Have
// the founder review the new and old sentences;
// - Original sentence disappears and there are no candidates from the same action family -> absent.
// Determination uses "action family + modality (completed / intent / negated)" for certainty comparison,
// without passing through the model:
// When any modality is unknown (unparsable), lean towards judging as ambiguous, and never automatically
// dismiss old risks.
// Verbatim matching (original sentence is still in the body text) takes precedence over everything --
// returns verbatim, behaving the same as the old version.

export const MATCH_VERSION = 'claim-match-v1';

// Action family: Cross-language shared family labels (Chinese by word, English by lemma),
// source-compatible with the high-risk action table in coverage.mjs, ensuring consistency in the action
// criteria between "flagged statements" and "high-risk sentences".
const ACTION_FAMILIES = [
  { id: 'signing', zh: ['签约', '签署', '签订', '签好'], en: /\bsign(?:ed|ing)?\b/i },
  { id: 'delivery', zh: ['交付', '交货', '发货'], en: /\bdeliver(?:ed|y|ing)?\b/i },
  { id: 'payment', zh: ['付款', '支付', '到账', '回款'], en: /\bpay(?:ed|ments?)?\b/i },
  { id: 'completion', zh: ['上线', '验收', '启动', '开通', '部署', '投产'],
    en: /\b(?:launch(?:ed|ing)?|deploy(?:ed|ing)?|activat\w+|complet\w+|shipp\w+)\b/i },
  { id: 'commitment', zh: ['承诺', '保证', '确保', '担保'],
    en: /\b(?:commit(?:ted|ting)?|guarantee\w*|ensur\w*|promis\w*|pledg\w*)\b/i },
];

// Modality markers: Identified based on the relative position window of action words within clauses
// (prefix tail segment / suffix head segment), following the same logic as the citation context check in
// claims.mjs -- looking only at components closely adjacent to action words, without counting distant
// words toward the current action.
const ZH_NEGATION_MULTI = ['尚未', '没有', '还没', '不曾', '从未', '不会', '不愿', '不敢', '无法'];
const ZH_NEGATION_SINGLE = ['未'];
const ZH_NEGATION_EXCLUDE_NEXT = ['来', '知', '必', '免']; // "Future/unknown/not necessarily/inevitably" are not negative actions.
const ZH_INTENT = ['意向', '意愿', '愿意', '希望', '打算', '计划', '准备', '考虑', '表达', '提出', '期待', '拟'];
const ZH_INTENT_AFTER = ['意向', '意愿', '期待'];
const ZH_COMPLETED = ['已经', '完成', '完毕', '成功', '已'];

const EN_NEGATION = new Set(['not', 'never']);
const EN_INTENT = new Set(['intent', 'intend', 'intends', 'intended', 'intending',
  'hope', 'hopes', 'hoped', 'hoping', 'willing', 'want', 'wants', 'wanted',
  'plan', 'plans', 'planned', 'planning', 'seek', 'seeks', 'seeking']);
const EN_PAST = /^(signed|delivered|paid|completed|shipped|launched|deployed|activated|made|collected|received)$/;

// Modality strength (trade-offs when multiple action words in the same clause hit different modalities):
// negation > intent > completed > unknown.
const ASPECT_RANK = { unknown: 0, completed: 1, intent: 2, negated: 3 };

function zhNegated(prefix) {
  const tail = prefix.slice(-8);
  for (const word of ZH_NEGATION_MULTI) if (tail.includes(word)) return true;
  let at = tail.indexOf('未');
  while (at !== -1) {
    const next = tail.charAt(at + 1);
    if (!ZH_NEGATION_EXCLUDE_NEXT.includes(next)) return true;
    at = tail.indexOf('未', at + 1);
  }
  return false;
}

function zhAspect(text, start, end) {
  const prefix = text.slice(0, start);
  const suffix = text.slice(end).replace(/^[，、；;\s]+/, '');
  if (zhNegated(prefix)) return 'negated';
  if (ZH_INTENT.some(word => prefix.slice(-8).includes(word))) return 'intent';
  if (ZH_INTENT_AFTER.some(word => suffix.startsWith(word))) return 'intent';
  if (ZH_COMPLETED.some(word => prefix.slice(-4).includes(word))) return 'completed';
  if (suffix.startsWith('了')) return 'completed';
  return 'unknown';
}

function enAspect(words, index) {
  const before = words.slice(Math.max(0, index - 2), index);
  const after = words.slice(index + 1, index + 2);
  if (before.some(word => EN_NEGATION.has(word))) return 'negated';
  if (before.some(word => EN_INTENT.has(word)) || (after[0] && EN_INTENT.has(after[0]))) return 'intent';
  if (EN_PAST.test(words[index])) return 'completed';
  return 'unknown';
}

const pickAspect = (a, b) => (ASPECT_RANK[b] > ASPECT_RANK[a] ? b : a);

// Signature of a sentence (or a clause): Hit action families + modality of each action family.
function signature(text) {
  const t = String(text ?? '').trim();
  if (!t) return { families: [], aspects: {} };
  const families = [];
  const aspects = {};
  // Lemma normalization: Strip attached punctuation (trailing words often carry periods) to ensure lemma
  // tables are consistent with negation/intent/past-tense determinations.
  const words = t.toLowerCase().split(/\s+/).map(word => word.replace(/[^a-z']/g, '')).filter(Boolean);
  for (const family of ACTION_FAMILIES) {
    let aspect = 'unknown';
    let found = false;
    for (const word of family.zh) {
      let at = t.indexOf(word);
      while (at !== -1) {
        found = true;
        aspect = pickAspect(aspect, zhAspect(t, at, at + word.length));
        at = t.indexOf(word, at + word.length);
      }
    }
    words.forEach((word, i) => {
      if (!family.en.test(word)) return;
      found = true;
      aspect = pickAspect(aspect, enAspect(words, i));
    });
    if (found) {
      families.push(family.id);
      aspects[family.id] = aspect;
    }
  }
  return { families, aspects };
}

// Split sentences and sub-clauses using the same criteria as coverage.mjs (bounded by sentence-ending
// punctuation; commas/ideographic commas/conjunctions split sub-clauses).
function clauseParts(sentence) {
  return sentence.split(/，|、|；|;|以及|还有|外加|\s+and\s+|\s+as well as\s+|,\s+|\s+also\s+/i)
    .map(part => part
      .replace(/^[，、；;,\s]+/, '')
      .replace(/^(?:并且|而且|同时|此外|另外|然后|接着|还|又|并|以及|还有|外加|且)\s*/, '')
      .replace(/^(?:and also|as well as|in addition|additionally|plus|then|also|and)\s+/i, '')
      .replace(/[。！？.!?…]+\s*$/, '')
      .trim());
}

// -- Fallback when the original sentence is unparsable (no action family): Shared content words -> cannot
// rule out being the same fact -> ambiguous. --
const ZH_STOP = new Set('的了是在有和与或及也都就而且更最已未不没太非个之其于对把被让给为以从到向往这那谁哪吗呢吧啊呀哦嗯嘛哈');
function zhGrams(text) {
  const chars = [...text];
  const grams = new Set();
  for (let i = 0; i + 1 < chars.length; i++) {
    const gram = chars[i] + chars[i + 1];
    if (!ZH_STOP.has(chars[i]) && !ZH_STOP.has(chars[i + 1])) grams.add(gram);
  }
  return grams;
}
const EN_STOP = new Set(['the', 'and', 'but', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from',
  'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'it', 'its', 'this',
  'that', 'these', 'those', 'as', 'if', 'will', 'would', 'can', 'could', 'should', 'shall', 'may',
  'might', 'not', 'no', 'yes', 'about', 'into', 'over', 'after', 'before', 'when', 'while', 'which',
  'who', 'whom', 'what', 'where', 'why', 'how', 'their', 'they', 'them', 'then', 'than', 'so', 'such',
  'only', 'very', 'too', 'also', 'each', 'both', 'all', 'any', 'there', 'here']);
function enContentWords(text) {
  return new Set(text.toLowerCase().split(/\s+/).map(word => word.replace(/[^a-z']/g, ''))
    .filter(word => word.length >= 4 && !EN_STOP.has(word)));
}
function sharedContentWords(oldText, clause) {
  if (/[a-z]/i.test(oldText) && /[a-z]/i.test(clause)) {
    const words = enContentWords(oldText);
    const inClause = enContentWords(clause);
    return [...words].filter(word => inClause.has(word));
  }
  const grams = zhGrams(oldText);
  return [...grams].filter(gram => clause.includes(gram));
}

const RELATION_RANK = { different_fact: 1, ambiguous: 2, same_fact: 3 };

// Main entry: Flagged original sentence from the old version vs. current draft body text.
// verdict: verbatim (original sentence remains, use original verbatim criteria) / same_fact (synonymous
// rewrite is still the same fact, still pending processing) /
// different_fact (rewritten into a different fact) / ambiguous (unable to determine, requires founder
// review) / absent (original sentence disappeared and no candidates exist).
export function matchClaimRewrite(claimText, body) {
  const old = String(claimText ?? '').trim();
  const text = String(body ?? '').trim();
  if (!old) return { verdict: 'absent', candidates: [] };
  if (text.includes(old)) return { verdict: 'verbatim', candidates: [] };
  const oldSig = signature(old);
  const candidates = [];
  const seen = new Set();
  for (const sentence of text.split(/(?<=[。！？!?；;…\n])/)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    for (const clause of clauseParts(trimmed)) {
      if (clause.length < 2 || seen.has(clause)) continue;
      seen.add(clause);
      const nextSig = signature(clause);
      const shared = oldSig.families.filter(family => nextSig.families.includes(family));
      let relation = null;
      let aspects = {};
      let sharedWords = null;
      if (shared.length) {
        for (const family of shared) {
          const oldAspect = oldSig.aspects[family] ?? 'unknown';
          const nextAspect = nextSig.aspects[family] ?? 'unknown';
          aspects[family] = { old: oldAspect, next: nextAspect };
          const rel = oldAspect === 'unknown' || nextAspect === 'unknown'
            ? 'ambiguous'
            : (oldAspect === nextAspect ? 'same_fact' : 'different_fact');
          if (relation === null || RELATION_RANK[rel] > RELATION_RANK[relation]) relation = rel;
        }
      } else if (!oldSig.families.length) {
        // Original sentence cannot parse action families: Fallback based on shared content words (cannot
        // rule out being the same fact -> hand over for manual review).
        sharedWords = sharedContentWords(old, clause);
        if (!sharedWords.length) continue;
        relation = 'ambiguous';
      } else {
        continue; // Original sentence has action families, but this clause does not belong to any family-matching action ->
// not a candidate rewrite for this statement.
      }
      candidates.push({ sentence: trimmed, relation, aspects, ...(sharedWords ? { shared: sharedWords } : {}) });
    }
  }
  if (!candidates.length) return { verdict: 'absent', candidates: [] };
  const verdict = candidates.reduce((best, candidate) =>
    (RELATION_RANK[candidate.relation] > RELATION_RANK[best] ? candidate.relation : best), 'different_fact');
  return { verdict, candidates };
}
