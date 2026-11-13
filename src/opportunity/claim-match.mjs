// 跨版本声明匹配（窗口 1：旧版被标记的风险说法换个说法后，仍需要处理）。
// 旧版草稿里被标记的原句在新正文中不再逐字出现时，可能只是近义改写：
//   - 同一事实的近义改写（「合同已签署」→「双方已完成签约」）→ same_fact：原风险仍待处理；
//   - 改写成了不同事实（→「客户已表达签约意向」/「双方尚未签约」）→ different_fact：原说法不再成立；
//   - 无法确定是否同一事实（→「双方下周签约」）→ ambiguous：新旧句交创始人核对；
//   - 原句消失且无同动作族候选句 → absent。
// 判定用「动作族 + 情态（completed / intent / negated）」确定性比较，不经模型：
// 任一情态未知（无法解析）时倾向判 ambiguous，绝不自动解除旧风险。
// 逐字匹配（原句仍在正文里）优先于一切——返回 verbatim，行为与旧版一致。

export const MATCH_VERSION = 'claim-match-v1';

// 动作族：跨语言共用族标签（中文按词、英文按词形），
// 与 coverage.mjs 的高风险动作表同源，保证「被标记说法」与「高风险句」的动作口径一致。
const ACTION_FAMILIES = [
  { id: 'signing', zh: ['签约', '签署', '签订', '签好'], en: /\bsign(?:ed|ing)?\b/i },
  { id: 'delivery', zh: ['交付', '交货', '发货'], en: /\bdeliver(?:ed|y|ing)?\b/i },
  { id: 'payment', zh: ['付款', '支付', '到账', '回款'], en: /\bpay(?:ed|ments?)?\b/i },
  { id: 'completion', zh: ['上线', '验收', '启动', '开通', '部署', '投产'],
    en: /\b(?:launch(?:ed|ing)?|deploy(?:ed|ing)?|activat\w+|complet\w+|shipp\w+)\b/i },
  { id: 'commitment', zh: ['承诺', '保证', '确保', '担保'],
    en: /\b(?:commit(?:ted|ting)?|guarantee\w*|ensur\w*|promis\w*|pledg\w*)\b/i },
];

// 情态标记：按分句内相对动作词的位置窗口识别（前缀尾段 / 后缀头段），
// 与 claims.mjs 的引文上下文检查同思路——只看紧挨动作词的成分，不把远处的词算到本动作头上。
const ZH_NEGATION_MULTI = ['尚未', '没有', '还没', '不曾', '从未', '不会', '不愿', '不敢', '无法'];
const ZH_NEGATION_SINGLE = ['未'];
const ZH_NEGATION_EXCLUDE_NEXT = ['来', '知', '必', '免']; // 「未来/未知/未必/未免」不是否定动作
const ZH_INTENT = ['意向', '意愿', '愿意', '希望', '打算', '计划', '准备', '考虑', '表达', '提出', '期待', '拟'];
const ZH_INTENT_AFTER = ['意向', '意愿', '期待'];
const ZH_COMPLETED = ['已经', '完成', '完毕', '成功', '已'];

const EN_NEGATION = new Set(['not', 'never']);
const EN_INTENT = new Set(['intent', 'intend', 'intends', 'intended', 'intending',
  'hope', 'hopes', 'hoped', 'hoping', 'willing', 'want', 'wants', 'wanted',
  'plan', 'plans', 'planned', 'planning', 'seek', 'seeks', 'seeking']);
const EN_PAST = /^(signed|delivered|paid|completed|shipped|launched|deployed|activated|made|collected|received)$/;

// 情态强弱（同一分句多个动作词命中不同情态时的取舍）：否定 > 意向 > 完成 > 未知。
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

// 一句话（或一个分句）的签名：命中的动作族 + 每个动作族的情态。
function signature(text) {
  const t = String(text ?? '').trim();
  if (!t) return { families: [], aspects: {} };
  const families = [];
  const aspects = {};
  // 词形归一：剥掉粘连的标点（末词常带句点），保证词形表与否定/意向/过去式判定一致。
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

// 按 coverage.mjs 同一口径切句、切分句（句末标点划界；逗号/顿号/并列词拆子句）。
function clauseParts(sentence) {
  return sentence.split(/，|、|；|;|以及|还有|外加|\s+and\s+|\s+as well as\s+|,\s+|\s+also\s+/i)
    .map(part => part
      .replace(/^[，、；;,\s]+/, '')
      .replace(/^(?:并且|而且|同时|此外|另外|然后|接着|还|又|并|以及|还有|外加|且)\s*/, '')
      .replace(/^(?:and also|as well as|in addition|additionally|plus|then|also|and)\s+/i, '')
      .replace(/[。！？.!?…]+\s*$/, '')
      .trim());
}

// —— 原句不可解析（无任何动作族）时的兜底：共享内容词 → 无法排除是同一事实 → ambiguous。——
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

// 主入口：旧版被标记的原句 vs 当前草稿正文。
// verdict：verbatim（原句仍在，走原有逐字口径）/ same_fact（近义改写仍是同一事实，仍待处理）/
// different_fact（改写成了不同事实）/ ambiguous（无法确定，需创始人核对）/ absent（原句消失且无候选）。
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
        // 原句解析不出动作族：按共享内容词兜底（无法排除是同一事实 → 交人工核对）。
        sharedWords = sharedContentWords(old, clause);
        if (!sharedWords.length) continue;
        relation = 'ambiguous';
      } else {
        continue; // 原句有动作族、但此分句不属于任何同族动作 → 不是这条声明的候选改写。
      }
      candidates.push({ sentence: trimmed, relation, aspects, ...(sharedWords ? { shared: sharedWords } : {}) });
    }
  }
  if (!candidates.length) return { verdict: 'absent', candidates: [] };
  const verdict = candidates.reduce((best, candidate) =>
    (RELATION_RANK[candidate.relation] > RELATION_RANK[best] ? candidate.relation : best), 'different_fact');
  return { verdict, candidates };
}
