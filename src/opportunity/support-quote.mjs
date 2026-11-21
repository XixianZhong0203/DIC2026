
/**
 * Validates quote support issues for completed SIGNING claims only.
 * Returns a detected issue code, or null when this narrow guard detects no issue.
 */
export function supportQuoteIssue(claimText, item) {
  if (!item || item.stance !== 'supports') {
    return null;
  }

  const claim = String(claimText ?? '').trim();
  const quote = (item.quote || '').trim();
  const clause = (item.quoteContext && item.quoteContext.clause) || quote;
  const at = item.source?.text?.indexOf(quote) ?? -1;
  const suffix = at < 0 ? '' : item.source.text.slice(at + quote.length, at + quote.length + 12);

  if (!claim || !quote) {
    return null;
  }

  // 1. Narrow check: Only validate completed SIGNING claims.
  // Return null for other dimensions (e.g. general funding, delivery, product features, general business).
  const isSigningClaim = /\b(?:signed|executed|unsigned)\b|(?:已经?|尚未|未|没有|没|正式|成功).{0,4}(?:签署|签约|签订)|(?:签署|签约|签订).{0,3}(?:完成|完毕|了)/i.test(claim);
  if (!isSigningClaim || /签约(?:意向|意愿)|\b(?:intend|willing|interest)\w*\b/i.test(claim)) {
    return null;
  }

  // 2. Detect English signed/executed contract/agreement and Chinese 已签约 / 合同已签署
  const hasEnglishSigning = /\b(signed|executed|concluded|finalized)\b/i.test(clause);
  const hasChineseSigning = /(?:已经?|正式|成功).{0,24}(?:签署|签约|签订)|(?:签署|签约|签订).{0,3}(?:了|完成|完毕)/.test(clause);
  const hasPositiveSigningAction = hasEnglishSigning || hasChineseSigning;

  // 3. Question checks (interrogative sources): inspect quote, clause, and immediate source suffix
  const enQuestionRegex = /^(?:who|what|where|when|why|how|is|are|has|have|had|can|could|would|should|will|do|does|did)\b/i;
  const zhQuestionRegex = /(\?|[\?？]|(吗|呢|怎么|如何|谁|哪里|为什么|什么|几|多少)[啊呢嘛呀]?$)/;

  if (enQuestionRegex.test(clause) || /[?？]/.test(quote) || zhQuestionRegex.test(quote) || zhQuestionRegex.test(clause) || /^(?:了|过|的)?(?:吗|么|呢)[？?]?/.test(suffix)) {
    return 'quote_is_question';
  }

  if (/^[A-Za-z-]+[.!]?$/.test(quote)) return 'quote_too_short';

  // 4. If both claim and quote say not yet signed, PRESERVE support (return null)
  const negativeSigningClaim = /\b(?:not|never|hasn't|haven't|hadn't)\s+(?:yet\s+)?(?:signed|executed)\b|\bunsigned\b|(?:尚未|未|没有|还没|没)(?:正式|已经)?(?:签署|签约|签订)/i.test(claim);
  const negativeSigningQuote = /\b(?:not|never|hasn't|haven't|hadn't)\s+(?:yet\s+)?(?:signed|executed)\b|\bunsigned\b|(?:尚未|未|没有|还没|没)(?:正式|已经)?(?:签署|签约|签订)/i.test(quote);
  if (negativeSigningClaim !== negativeSigningQuote) return 'quote_polarity_mismatch';

  // 5. One-word quote contract for claim has signed must reject
  const wordCount = quote.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 1 && !/\b(?:signed|executed)\b|(?:签署|签约|签订)/i.test(quote) && /\b(contract|agreement|contractual)\b|(合同|协议)/i.test(quote)) {
    return 'single_topic_word_cannot_prove_action';
  }

  // 6. NDA cannot prove a service contract; an NDA quote CAN prove an NDA claim
  const isNDARelatedClaim = /\b(nda|non-disclosure|confidentiality)\b|(保密协议)/i.test(claim);
  const isNDARelatedQuote = /\b(nda|non-disclosure|confidentiality)\b|(保密协议)/i.test(clause);
  const isServiceOrDefinitiveContractClaim = /\b(?:contract|agreement|msa)\b|(?:合同|协议)/i.test(claim);

  if (isNDARelatedQuote && isServiceOrDefinitiveContractClaim && !isNDARelatedClaim) {
    return 'preliminary_doc_cannot_prove_contract';
  }

  if (negativeSigningClaim && negativeSigningQuote) return null;

  // 7. A source merely interested or willing to sign cannot support signing completion
  const intentOrWillingnessRegex = /\b(intend|plan|hope|aim|expect|want|try|seek|willing|interested|propose|schedule|forecast|estimate|will|shall|would|could|may|might)\b|(计划|打算|期望|意图|拟|将要|会|希望|争取|准备|拟定|意向|愿意|有兴趣)/i;
  if (intentOrWillingnessRegex.test(quote) && !hasPositiveSigningAction) {
    return 'intent_cannot_prove_completion';
  }

  // 9. Refusal / conditional qualification in the same clause conservatively
  if (/\b(?:if|unless|when|once)\b.{0,45}\b(?:signed|executed)\b|(?:如果|若|一旦).{0,16}(?:签署|签约|签订)/i.test(clause)) return 'conditional_qualification_cannot_prove_completion';
  const conditionalRefusalRegex = /\b(if|unless|provided|subject to|pending|conditional|refuse|declined)\b|(如果|除非|前提是|视情况|拒绝|暂缓)/i;
  if (conditionalRefusalRegex.test(clause) && !hasPositiveSigningAction) {
    return 'conditional_qualification_cannot_prove_completion';
  }

  if (!hasPositiveSigningAction) return 'quote_missing_signing_action';
  return null;
}

export const extraCoveragePatterns = {
  zhFigures: [/[¥￥$€£]\s*\d[\d,]*(?:\.\d+)?/],
  enFigures: [
    /[$€£¥]\s*\d[\d,]*(?:\.\d+)?/,
    /\b\d[\d,]*(?:\.\d+)?(?:\s+[a-z-]+){0,3}\s+(?:databases?|users?|integrations?|customers?|projects?|clients?)\b/i,
  ],
  zhFacts: [/(?:认证|资质|药监|医疗器械.{0,12}(?:批准|审批|许可)|三甲医院)/],
  enFacts: [/\b(?:certified|certifications?|accredited|accreditations?|qualifications?)\b|\bISO\s*\d{3,5}\b/i],
};
