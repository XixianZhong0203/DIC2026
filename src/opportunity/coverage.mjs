// —— 草稿覆盖扫描（窗口 2：发现草稿里被模型漏抽的风险）——
// 声明核查依赖模型把草稿正文里"会影响决定的说法"逐条抽出来再核查；模型漏抽时，
// 未进入核查的原文就成了风险。本模块独立于模型输出，按句/分句做确定性扫描（可复现）：
//   1. 同一句里的多项承诺：句子按逗号/顿号/并列词拆成分句，各自独立检查；
//      一个分句命中高风险形式却未被任何已抽取声明覆盖，而同句的另一分句已被抽取
//      → 模型只抽到了一项（漏抽结果带 covered：同句已核查的分句，供定位对照）。
//   2. 委婉表述的日期承诺：日期前后包着委婉词（预计/估计/争取/尽量/大概…）、
//      软尾（左右/前后/之后…）或助动词（能/会/将…）时，模型容易只抽日期不抽动作；
//      中文与英文日期承诺（含 by/within/before/until/on + 时间短语）都纳入扫描。
//   3. 附带条件的批准或交付：「经…批准后」「待…确认」「如果…就」「需/须…批准」、
//      「…的话/之后」及英文 after/once/upon/when/subject to/contingent on/pending…
//      把承诺藏在条件里，未被抽取时同样拦截。
// 每个命中（missed 条目）携带：
//   text      未进入本次核查的原文片段（逐字，供定位/改写）；
//   sentence  片段所在的完整原句（供在正文中定位）；
//   categories  命中的形式（COVERAGE_CATEGORY_LABELS 的键，界面显示中文标签）；
//   covered   同句里已进入本次核查的其他分句（多项承诺情形下的对照，可为空）。
// 疑问句（澄清问题）不进高风险扫描：问候与澄清不是承诺。
// draftChecks 是兼容视图（{ placeholders, unextracted: [字符串] }），发送门槛（窗口 1）
// 与旧存储记录读它；coverageScan 是完整结果，随核查记录以独立字段 coverage 落库并输出给界面。

const PLACEHOLDER = /\[(?:待确认|待核实|待定|TBD|to be confirmed|to be verified)[^\[\]]*\]/gi;

// 命中形式：键是稳定代码（存储/审计用），值是中文标签（界面显示）。
export const COVERAGE_CATEGORY_LABELS = {
  fact: '已完成事实',
  commitment: '对外承诺',
  date: '日期承诺（含委婉表述）',
  conditional: '附带条件的批准或交付',
  figure: '数字与业绩',
};
export const COVERAGE_CATEGORIES = Object.keys(COVERAGE_CATEGORY_LABELS);

// —— 中文模式 ——
// 日期核心：绝对（今天/本月/月底…）+ 相对（下周/下月/下季度/年底）+ 数字（含中文数字）。
const ZH_DATE = '(?:今天|明天|后天|下周|下月|下季度|本月|本季度|年底|季末|月底|(?:下)?周[一二三四五六日天]|(?:\\d+|[一二两三四五六七八九十]+|几|数)\\s*个?\\s*(?:工作日|自然日|日|天|周|星期|个月|月|季度|小时))';
// 日期承诺的动作表（交付类动作）。不含 支持/服务/培训 等持续服务类——
// 「承担后续三个月的免费支持」这类由 commitment 形式负责，避免日期模式误吞。
const ZH_ACTION = '(?:完成|交付|上线|付款|签约|启动|验收|部署|开通|发出|回复|安排|做到|达成|实现|开始|执行|进行)';
const ZH_PATTERNS = {
  fact: [
    /已(?:经)?(?:签署|签订|签约|签好|交付|付款|支付|到账|回款|完成|上线|验收|启动|开通|部署|投产)/,
  ],
  commitment: [
    // 承诺动词 + 承诺对象（含 免费/优惠/折扣 等价值词）：「承担后续三个月的免费支持」
    /(?:承诺|保证|确保|担保|承担|负责|提供|赠送|退还|赔偿|补偿)[^\n。？]{0,24}?(?:完成|交付|上线|付款|签约|启动|验收|部署|开通|发出|回复|安排|做到|达成|实现|支持|保障|服务|维护|响应|培训|升级|迁移|备份|免费|优惠|折扣|减免|退款)/,
    // 价值词 + 服务对象：即使没有承诺动词，也是对外承诺
    /(?:免费|优惠|折扣|半价|减免|让步)[^\n。？]{0,16}?(?:支持|服务|维护|保障|培训|升级|迁移|备份|退款|赔偿|补偿)/,
  ],
  date: [
    // 委婉词可缺省（直接日期承诺同样要核查）：(预计/争取/尽量/大概…) + 日期
    // + 软尾（左右/前后/上下）+ 之前/之后/内/前… + 能/会/将/可以… + 动作
    new RegExp(
      '(?:预计|估计|预估|大概|大约|差不多|尽量|争取|力争|有望|基本)?\\s*' +
      ZH_DATE + '\\s*(?:左右|前后|上下)?\\s*' +
      '(?:之前|以前|之后|以后|之内|以内|前|内)?\\s*' +
      '(?:能|会|将|可以|可|得|才|就|即可|方可)?\\s*' + ZH_ACTION
    ),
  ],
  conditional: [
    // 如果/一旦/一经/只要/若/假如/倘若 + 条件 + 就/则/即 + 动作：「如果验收通过就交付」
    /(?:如果|一旦|一经|只要|若|假如|倘若)(?:[^。？\n]{1,24}?)\s*(?:就|则|便|即|即可|才能|方可)?\s*(?:完成|交付|上线|付款|签约|启动|验收|部署|开通|发出|回复|安排|开始|执行|进行)/,
    // 需/须/需要/待 +（经/由/过）+ 批准类条件：「需经董事会批准后生效」
    /(?:需|须|需要|待)[^。？\n]{0,12}?(?:经|由|过)?\s*[^。？\n]{0,10}?(?:批准|审批|核准|确认|同意|签字|签署|验收)/,
    // …的话/之后/以后/完毕/完成 + 就/则 + 动作：「您确认的话我们就按此执行」。
    // 触发词与动作之间至少隔一个字符：「在两周内完成上线」是日期表述（完成是动作本身），
    // 不是条件，由日期形式负责。
    /[^。？\n]{2,20}(?:的话|之后|以后|完毕|完成)[^。？\n]{1,10}(?:就|则|便|即)?\s*(?:完成|交付|上线|付款|签约|启动|验收|部署|开通|发出|开始|执行|进行)/,
    // 条件名词 + 后/之后/完毕 + 动作：「经董事会批准后交付」「付款后安排培训」「验收通过后上线」。
    // 「后」后紧跟「续」（后续 = follow-up）不是条件词，排除。
    /[^。？\n]{0,20}?(?:批准|审批|核准|确认|通过|同意|签字|签署|验收|付款|到账|回款|签约|开通)[^。？\n]{0,8}?(?:之后|以后|后|完毕)(?!续)[^。？\n]{0,16}?(?:完成|交付|上线|付款|签约|启动|验收|部署|开通|发出|回复|安排|开始|执行|进行)/,
  ],
  figure: [
    /(?:\d+(?:\.\d+)?\s*(?:%|％|倍|万|亿|元|个|名|家|份|天|日|周|小时|美元|人民币)|翻(?:倍|番))/,
  ],
};

// —— 英文模式 ——
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
// 委婉动词（expect/estimate/hope/aim/plan/schedule/intend/target/seek/try/attempt + to/for/at）。
const EN_SOFT_VERB = '\\b(?:expect\\w*|estimat\\w+|hop\\w*|aim\\w*|plan\\w*|schedul\\w+|intend\\w*|target\\w*|seek\\w*|tr(?:y|ied|ying)|attempt\\w*)\\s+(?:to|for|at)\\s+';
// 条件桥接词（承诺藏在条件里）：after/once/upon/when/following/subject to/
// contingent on/pending/provided (that)/so long as/awaiting/if。
const EN_CONDITION_BRIDGE = '\\b(?:after|once|upon|when|following|subject\\s+to|contingent\\s+on|pending|provided\\s+(?:that)?|so\\s+long\\s+as|awaiting|if)\\b';
const EN_PATTERNS = {
  fact: [
    /\b(?:signed|delivered|paid|completed|shipped|launched|deployed|collected|received)\b/i,
    /\b(?:has|have|had|was|were|being)\s+(?:been\s+)?(?:signed|delivered|paid|completed|made|launched|deployed|collected|received)\b/i,
  ],
  commitment: [
    /\b(?:commit(?:s|ted|ting)?|guarantee[sd]?|ensur(?:e|es|ed)|promis(?:e|es|ed)|pledge[sd]?|undertake[sd]?|provide[sd]?|offer\w*|refund[sd]?|compensate[sd]?|waive[sd]?)\b/i,
  ],
  date: [
    // 动作 … by/within/before/until/on + 时间：「We will deliver by end of month」
    new RegExp(EN_ACTION + '[^.?!]{0,24}?' + EN_TIME_PREP + EN_TIME_CORE, 'i'),
    // by/within/before/until/on + 时间 … 动作：「By end of month we will deliver」
    new RegExp(EN_TIME_PREP + EN_TIME_CORE + '[^.?!]{0,24}?' + EN_ACTION, 'i'),
    // 委婉动词 + to/for/at +（动作）… by 时间：「We expect to deliver by end of month」
    new RegExp(EN_SOFT_VERB + '[^.?!]{0,40}?' + EN_TIME_PREP + EN_TIME_CORE, 'i'),
  ],
  conditional: [
    // 动作 … 条件桥接词：「We will deliver after board approval」
    new RegExp(EN_ACTION + '[^.?!]{0,30}?' + EN_CONDITION_BRIDGE, 'i'),
    // 条件桥接词 … 动作：「Delivery begins after the contract is signed」
    new RegExp(EN_CONDITION_BRIDGE + '[^.?!]{0,30}?' + EN_ACTION, 'i'),
    // 批准类条件名词：「subject to board approval」「pending payment」
    /\b(?:subject\s+to|contingent\s+on|pending|awaiting)\s+(?:the\s+)?(?:board\s+|customer\s+|legal\s+|final\s+)?(?:approval|sign[-\s]?off|confirmation|acceptance|payment|contract)\b/i,
  ],
  figure: [
    /\b(?:\d+(?:\.\d+)?\s*(?:%|percent|billion|million|times|days?|hours?|weeks?|USD|EUR|CNY|RMB|dollars?|euros?|yen)|doubled|tripled|increased by|grew by|growth of)\b/i,
  ],
};

// 澄清问题不是承诺：以疑问词开头或以 吗/呢 结尾的分句不进高风险扫描。
function isQuestionClause(clause) {
  if (/吗\s*$|呢\s*$/.test(clause)) return true;
  if (/^(?:请问|能否|是否|可否|麻烦|怎么|何时|什么时候|为何|为什么|哪)/.test(clause)) return true;
  return /^(?:do|does|did|can|could|will|would|should|may|might|is|are|was|were|have|has|had|shall|what|when|where|who|why|how)\b/i.test(clause);
}

// 一个分句命中哪些形式（全部检查，返回命中的代码列表，顺序按 COVERAGE_CATEGORIES）。
export function riskCategories(clause) {
  if (typeof clause !== 'string' || clause.trim().length < 2) return [];
  const hits = [];
  for (const code of COVERAGE_CATEGORIES) {
    const patterns = [...(ZH_PATTERNS[code] ?? []), ...(EN_PATTERNS[code] ?? [])];
    if (patterns.some(re => re.test(clause))) hits.push(code);
  }
  return hits;
}

// 按中文逗号/顿号、英文逗号和并列词（and/as well as/also/以及/还有/外加）拆子句，
// 去掉开头连接词与结尾标点。
function clauseParts(sentence) {
  return sentence.split(/，|、|；|;|以及|还有|外加|\s+and\s+|\s+as well as\s+|,\s+|\s+also\s+/i)
    .map(part => part
      .replace(/^[，、；;,\s]+/, '')
      .replace(/^(?:并且|而且|同时|此外|另外|然后|接着|还|又|并|以及|还有|外加|且)\s*/, '')
      .replace(/^(?:and also|as well as|in addition|additionally|plus|then|also|and)\s+/i, '')
      .replace(/[。！？.!?…]+\s*$/, '')
      .trim());
}

// 扫描草稿正文：返回未进入本次核查的高风险原文（missed）与遗留占位符。
// claimTexts 是模型本次抽取的声明原文（进入核查的部分）。
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
    // 同句里已进入核查的分句：多项承诺情形下，未覆盖分句靠它定位「哪段没进核查」。
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

// 兼容视图（窗口 1 发送门槛与旧存储记录）：{ placeholders, unextracted: [字符串] }。
export function draftChecks(body, claimTexts) {
  const scan = coverageScan(body, claimTexts);
  return { placeholders: scan.placeholders, unextracted: scan.missed.map(entry => entry.text) };
}
