import { extraCoveragePatterns } from './support-quote.mjs';
// -- Draft coverage scan (Window 2: discovering risks in drafts missed by the model) --
// Statement verification relies on the model to extract 'decision-affecting statements' from the draft
// text one by one before verification; when the model misses extraction, the raw text that fails to enter
// verification becomes a risk. This module is independent of model output and performs deterministic
// scanning by sentence/clause (reproducible):
// 1. Multiple commitments in the same sentence: sentences are split into clauses by commas/ideographic
// commas/conjunctions and checked independently;
// A clause hits a high-risk pattern but is not covered by any extracted statement, while another clause in
// the same sentence has already been extracted
// -> The model only extracted one item (missed result carries covered: the verified clause from the same
// sentence, provided for positioning comparison).
// 2. Date commitments with hedging: when dates are surrounded by hedges (expected/estimated/strive for/try
// to/probably...), soft tails (around/before and after/after...), or auxiliary verbs (can/will/shall...),
// the model easily extracts only the date and misses the action;
// Both Chinese and English date commitments (including by/within/before/until/on + time phrase) are
// included in the scan.
// 3. Approvals or deliveries with conditions: 'upon approval by...', 'pending confirmation', 'if... then',
// 'need/must be approved by', '...if/after' and English after/once/upon/when/subject to/contingent
// on/pending...
// hide commitments inside conditions, and are similarly intercepted when unextracted.
// Each hit (missed entry) carries:
// text verbatim raw text snippet not entering this verification (for locating/rewriting);
// sentence complete original sentence where the snippet resides (for locating in the text);
// categories hit patterns (keys of COVERAGE_CATEGORY_LABELS, UI displays Chinese labels);
// covered other clauses in the same sentence that have entered this verification (control for multiple
// commitment scenarios, can be empty).
// Interrogative sentences (clarification questions) do not enter high-risk scans: greetings and
// clarifications are not commitments.
// draftChecks is a compatible view ({ placeholders, unextracted: [string] }), sending threshold (Window 1)
// and legacy storage records read it; coverageScan is the complete result, persisted with the verification
// record as an independent coverage field and output to the UI.

const PLACEHOLDER = /\[(?:待确认|待核实|待定|TBD|to be confirmed|to be verified)[^\[\]]*\]/gi;

// Hit patterns: keys are stable codes (for storage/audit), values are Chinese labels (displayed on the
// UI).
export const COVERAGE_CATEGORY_LABELS = {
  fact: '已完成事实',
  commitment: '对外承诺',
  date: '日期承诺（含委婉表述）',
  conditional: '附带条件的批准或交付',
  figure: '数字与业绩',
};
export const COVERAGE_CATEGORIES = Object.keys(COVERAGE_CATEGORY_LABELS);

// -- Chinese mode --
// Date core: absolute (today/this month/end of month...) + relative (next week/next month/next quarter/end
// of year) + numbers (including Chinese numerals).
const ZH_DATE = '(?:今天|明天|后天|下周|下月|下季度|本月|本季度|年底|季末|月底|(?:下)?周[一二三四五六日天]|(?:\\d+|[一二两三四五六七八九十]+|几|数)\\s*个?\\s*(?:工作日|自然日|日|天|周|星期|个月|月|季度|小时))';
// Action table for date commitments (delivery-type actions). Excludes ongoing service types like
// support/service/training --
// 'Assume free support for the subsequent three months' is handled by the commitment pattern to avoid date
// patterns swallowing it incorrectly.
const ZH_ACTION = '(?:完成|交付|上线|付款|签约|启动|验收|部署|开通|发出|回复|安排|做到|达成|实现|开始|执行|进行)';
const ZH_PATTERNS = {
  fact: [
    ...extraCoveragePatterns.zhFacts,
    /已(?:经)?(?:签署|签订|签约|签好|交付|付款|支付|到账|回款|完成|上线|验收|启动|开通|部署|投产)/,
  ],
  commitment: [
    // Commitment verb + commitment target (including value words like free/discount/special offer):
    // "Assume free support for the next three months"
    /(?:承诺|保证|确保|担保|承担|负责|提供|赠送|退还|赔偿|补偿)[^\n。？]{0,24}?(?:完成|交付|上线|付款|签约|启动|验收|部署|开通|发出|回复|安排|做到|达成|实现|支持|保障|服务|维护|响应|培训|升级|迁移|备份|免费|优惠|折扣|减免|退款)/,
    // Value word + service target: Even without a commitment verb, this constitutes an external commitment
    /(?:免费|优惠|折扣|半价|减免|让步)[^\n。？]{0,16}?(?:支持|服务|维护|保障|培训|升级|迁移|备份|退款|赔偿|补偿)/,
  ],
  date: [
    // Euphemisms can be omitted (direct date commitments must also be verified): (estimated/strive to/try
    // to/roughly...) + date + soft tail (around/about/plus or minus) + before/after/within/prior to... +
    // can/will/shall/may... + action
    new RegExp(
      '(?:预计|估计|预估|大概|大约|差不多|尽量|争取|力争|有望|基本)?\\s*' +
      ZH_DATE + '\\s*(?:左右|前后|上下)?\\s*' +
      '(?:之前|以前|之后|以后|之内|以内|前|内)?\\s*' +
      '(?:能|会|将|可以|可|得|才|就|即可|方可)?\\s*' + ZH_ACTION
    ),
  ],
  conditional: [
    // If/once/upon/as long as/if/provided that/supposing + condition + then/in that case/is + action: "If
    // acceptance passes, delivery will be made"
    /(?:如果|一旦|一经|只要|若|假如|倘若)(?:[^。？\n]{1,24}?)\s*(?:就|则|便|即|即可|才能|方可)?\s*(?:完成|交付|上线|付款|签约|启动|验收|部署|开通|发出|回复|安排|开始|执行|进行)/,
    // Need/must/require/pending + (through/by/via) + approval-type condition: "Subject to board approval
    // to take effect"
    /(?:需|须|需要|待)[^。？\n]{0,12}?(?:经|由|过)?\s*[^。？\n]{0,10}?(?:批准|审批|核准|确认|同意|签字|签署|验收)/,
    // ...if/after/subsequent to/completed/finished + then/shall + action: "If you confirm, we will execute
    // accordingly". At least one character must separate the trigger word and the action: "Complete the
    // launch within two weeks" is a date expression (complete is the action itself), not a condition,
    // which is handled by the date format.
    /[^。？\n]{2,20}(?:的话|之后|以后|完毕|完成)[^。？\n]{1,10}(?:就|则|便|即)?\s*(?:完成|交付|上线|付款|签约|启动|验收|部署|开通|发出|开始|执行|进行)/,
    // Conditional noun + after/afterwards/completed + action: "Deliver after board approval", "Arrange
    // training after payment", "Launch after acceptance passes". If "after" is immediately followed by
    // "math" or "subsequent" (subsequent = follow-up), it is not a conditional word and is excluded.
    /[^。？\n]{0,20}?(?:批准|审批|核准|确认|通过|同意|签字|签署|验收|付款|到账|回款|签约|开通)[^。？\n]{0,8}?(?:之后|以后|后|完毕)(?!续)[^。？\n]{0,16}?(?:完成|交付|上线|付款|签约|启动|验收|部署|开通|发出|回复|安排|开始|执行|进行)/,
  ],
  figure: [
    ...extraCoveragePatterns.zhFigures,
    /(?:\d+(?:\.\d+)?\s*(?:%|％|倍|万|亿|元|个|名|家|份|天|日|周|小时|美元|人民币)|翻(?:倍|番))/,
  ],
};

// -- English Mode --
const EN_ACTION = '\\b(?:deliver\\w*|complet\\w*|launch\\w*|deploy\\w*|activat\\w*|sign\\w*|start\\w*|begin\\w*|send\\w*|respond\\w*|reply\\w*|arrange\\w*|execut\\w*|finish\\w*|ship\\w*)\\b';
const EN_TIME_CORE =
  '(?:\\d+\\s*(?:business\\s+|working\\s+)?(?:days?|hours?|weeks?|months?|quarters?|years?)\\b' +
  '|(?:one|two|three|four|five|six|seven|eight|nine|ten|a\\s+few|several|any)\\s*(?:days?|hours?|weeks?|months?|quarters?)\\b' +
  '|end\\s+of\\s+(?:the\\s+)?[A-Za-z]+\\b' +
  '|the\\s+[A-Za-z]+\\b' +
  '|next\\s+[A-Za-z]+\\b' +
  '|this\\s+[A-Za-z]+\\b' +
  '|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|tomorrow|tonight)\\b' +
  '|[A-Z][a-z]*day\\b' +
  '|Q[1-4]\\b)';
const EN_TIME_PREP = '\\b(?:by|within|before|until|around|on)\\s+';
// Euphemistic verbs (expect/estimate/hope/aim/plan/schedule/intend/target/seek/try/attempt + to/for/at).
const EN_SOFT_VERB = '\\b(?:expect\\w*|estimat\\w+|hop\\w*|aim\\w*|plan\\w*|schedul\\w+|intend\\w*|target\\w*|seek\\w*|tr(?:y|ied|ying)|attempt\\w*)\\s+(?:to|for|at)\\s+';
// Conditional bridge words (commitments hidden in conditions): after/once/upon/when/following/subject to/
// contingent on/pending/provided (that)/so long as/awaiting/if。
const EN_CONDITION_BRIDGE = '\\b(?:after|once|upon|when|following|subject\\s+to|contingent\\s+on|pending|provided\\s+(?:that)?|so\\s+long\\s+as|awaiting|if)\\b';
const EN_PATTERNS = {
  fact: [
    ...extraCoveragePatterns.enFacts,
    /\b(?:signed|delivered|paid|completed|shipped|launched|deployed|collected|received)\b/i,
    /\b(?:has|have|had|was|were|being)\s+(?:been\s+)?(?:signed|delivered|paid|completed|made|launched|deployed|collected|received)\b/i,
  ],
  commitment: [
    /\b(?:commit(?:s|ted|ting)?|guarantee[sd]?|ensur(?:e|es|ed)|promis(?:e|es|ed)|pledge[sd]?|undertake[sd]?|provide[sd]?|offer\w*|refund[sd]?|compensate[sd]?|waive[sd]?)\b/i,
  ],
  date: [
    // Action ... by/within/before/until/on + time: "We will deliver by end of month"
    new RegExp(EN_ACTION + '[^.?!]{0,24}?' + EN_TIME_PREP + EN_TIME_CORE, 'i'),
    // by/within/before/until/on + time ... action: "By end of month we will deliver"
    new RegExp(EN_TIME_PREP + EN_TIME_CORE + '[^.?!]{0,24}?' + EN_ACTION, 'i'),
    // Euphemistic verb + to/for/at + (action) ... by time: "We expect to deliver by end of month"
    new RegExp(EN_SOFT_VERB + '[^.?!]{0,40}?' + EN_TIME_PREP + EN_TIME_CORE, 'i'),
  ],
  conditional: [
    // Action ... conditional bridge word: "We will deliver after board approval"
    new RegExp(EN_ACTION + '[^.?!]{0,30}?' + EN_CONDITION_BRIDGE, 'i'),
    // Conditional bridge word ... action: "Delivery begins after the contract is signed"
    new RegExp(EN_CONDITION_BRIDGE + '[^.?!]{0,30}?' + EN_ACTION, 'i'),
    // Approval-type conditional nouns: "subject to board approval", "pending payment"
    /\b(?:subject\s+to|contingent\s+on|pending|awaiting)\s+(?:the\s+)?(?:board\s+|customer\s+|legal\s+|final\s+)?(?:approval|sign[-\s]?off|confirmation|acceptance|payment|contract)\b/i,
  ],
  figure: [
    ...extraCoveragePatterns.enFigures,
    /\b(?:\d+(?:\.\d+)?\s*(?:%|percent|billion|million|times|days?|hours?|weeks?|USD|EUR|CNY|RMB|dollars?|euros?|yen)|doubled|tripled|increased by|grew by|growth of)\b/i,
  ],
};

// Clarifying questions are not commitments: clauses starting with question words or ending with ma/ne are
// excluded from high-risk scanning.
function isQuestionClause(clause) {
  if (/吗\s*$|呢\s*$/.test(clause)) return true;
  if (/^(?:请问|能否|是否|可否|麻烦|怎么|何时|什么时候|为何|为什么|哪)/.test(clause)) return true;
  return /^(?:do|does|did|can|could|will|would|should|may|might|is|are|was|were|have|has|had|shall|what|when|where|who|why|how)\b/i.test(clause);
}

// Which forms a clause matches (check all, return the list of matched codes in the order of
// COVERAGE_CATEGORIES).
export function riskCategories(clause) {
  if (typeof clause !== 'string' || clause.trim().length < 2) return [];
  const hits = [];
  for (const code of COVERAGE_CATEGORIES) {
    const patterns = [...(ZH_PATTERNS[code] ?? []), ...(EN_PATTERNS[code] ?? [])];
    if (patterns.some(re => re.test(clause))) hits.push(code);
  }
  return hits;
}

// Split clauses by Chinese commas/enumeration commas, English commas, and coordinating words (and/as well
// as/also/yi ji/hai you/wai jia), and remove leading conjunctions and trailing punctuation.
function clauseParts(sentence) {
  return sentence.split(/，|、|；|;|以及|还有|外加|\s+and\s+|\s+as well as\s+|,\s+|\s+also\s+/i)
    .map(part => part
      .replace(/^[，、；;,\s]+/, '')
      .replace(/^(?:并且|而且|同时|此外|另外|然后|接着|还|又|并|以及|还有|外加|且)\s*/, '')
      .replace(/^(?:and also|as well as|in addition|additionally|plus|then|also|and)\s+/i, '')
      .replace(/[。！？.!?…]+\s*$/, '')
      .trim());
}

// Scan draft body: return high-risk original text that did not enter this verification (missed) and
// residual placeholders. claimTexts are the original claim texts extracted by the model this time (the
// portion entering verification).
export function coverageScan(body, claimTexts) {
  const text = typeof body === 'string' ? body : '';
  const claims = [...new Set((claimTexts ?? [])
    .map(value => String(value ?? '').trim())
    .filter(value => value.length >= 2))];
  const isCovered = clause => claims.some(claim => clause.includes(claim) || claim.includes(clause));
  const placeholders = [...new Set([...text.matchAll(PLACEHOLDER)].map(match => match[0]))];
  const missed = [];
  for (const sentence of text.split(/(?<=[。！？!?；;…\n])/)) {
    const parts = clauseParts(sentence).filter(part => part.length >= 2);
    // Clauses in the same sentence that have already entered verification: in multiple commitment
    // scenarios, uncovered clauses rely on it to locate "which segment did not enter verification".
    const coveredParts = parts.filter(part => isCovered(part));
    for (const clause of parts) {
      if (isQuestionClause(clause)) continue;
      const categories = riskCategories(clause);
      if (!categories.length) continue;
      if (isCovered(clause)) continue;
      missed.push({
        text: clause,
        sentence: sentence.trim(),
        categories,
        covered: coveredParts.filter(part => part !== clause).slice(0, 5),
      });
    }
  }
  return { claims, missed, placeholders };
}

// Compatibility view (Window 1 sending threshold and legacy storage records): { placeholders, unextracted:
// [string] }.
export function draftChecks(body, claimTexts) {
  const scan = coverageScan(body, claimTexts);
  return { placeholders: scan.placeholders, unextracted: scan.missed.map(entry => entry.text) };
}
