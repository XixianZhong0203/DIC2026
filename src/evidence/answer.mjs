// 证据不足时怎么说、怎么继续（evidence answer）。
//
// 把一个「证据束」（一次线索分析结果 + 逐条声明核查 + 来源原文）转成
// 一份结构化、确定性的回答，回答四件事：
//   已确认什么（confirmed）/ 缺少哪条信息（missing）/ 下一步怎么做（next）
//   / 指向哪些来源（supporting）。
//
// 已提取声明里「仅创始人陈述」（founder_only）与「来源未确认」（unconfirmed）的
// 条目不算已确认，单独列入待核实项（pending）：结论只到客户来源支持的部分，
// 待核实项始终可见，不会被摘要省略。
//
// 并区分四种情形（situation），让「怎么说」和「怎么继续」各有边界：
//   insufficient  证据不足  —— 现有材料只支持部分结论：说清已确认、缺哪条、下一步。
//   conflict      来源冲突  —— 来源相互矛盾：展示需要比较的记录，不擅自下结论。
//   failed        核查失败  —— 模型核查失败：提示可重试（原文与来源不受失败影响）。
//   sufficient    证据充分  —— 给出明确且有边界的结论：已确认到哪一步、哪一步仍待确认。
//
// 这是「怎么说」的唯一事实来源：线索流程与决策卡都消费它，措辞保持一致。
// 纯函数、无 I/O、无模型调用——模型只负责产出原料（status/quote/unknown/...），
// 这里的措辞与边界由确定性代码决定，可单测、可回放。

export const SITUATIONS = ['sufficient', 'insufficient', 'conflict', 'failed'];

// 把证据束转成结构化回答。bundle 字段见 buildAnswerBundle（opportunities.mjs）。
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
  // 待核实项：仅创始人陈述（founder_only）与来源未确认（unconfirmed）的已提取声明。
  // 它们可能与其他声明并存（如意向已被客户来源支持、签署状态只有创始人陈述），
  // 因此按声明逐条列出，而不是折叠进某个单一缺口文案。
  const pending = [
    ...of('founder_only').map(claim => pendingItem(claim, 'founder_only')),
    ...of('unconfirmed').map(claim => pendingItem(claim, 'unconfirmed')),
  ];

  // --- 核查失败：模型核查失败，提示可重试（原文与来源不受失败影响）-----------
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

  // --- 来源冲突：展示需要比较的记录，不擅自下结论 ---------------------------
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

  // --- 证据充分：至少一条关键声明被来源支持 → 明确且有边界的结论 ------------
  //     已确认 = 被支持的声明（现有证据真正能撑住的说法）；
  //     边界 = 仍未确认/被反驳/未完成的部分（明确说清结论只到这一步）。
  if (supported.length) {
    const confirmed = supported.map(claim => claim.rewrite || claimLabel(claim)).join('；');
    const open = unknown.map(claim => claim.missing || claimLabel(claim)).join('；');
    const refutedNote = refuted.map(claim => claimLabel(claim) + ' 被来源反驳').join('；');
    const incompleteNote = incomplete.map(claim => claimLabel(claim) + ' 未完成核查').join('；');
    // 待核实项同样划入结论边界：结论只到已支持的部分，创始人陈述与未确认来源
    // 撑住的声明明确标出「待独立核实／待核实」。
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

  // --- 证据不足：没有关键声明被来源支持 → 说清已确认、缺哪条、下一步 --------
  //     已确认 = 逐字核对过的原文摘录（或判断依据）；缺 = 具体缺哪条信息；
  //     下一步 = 可操作的建议（发案例并询问采购计划这类）。
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

// 待核实条目：声明的维度与原文 + 待核实原因（founder_only / unconfirmed），
// 措辞交给消费方（回答卡）按现有状态标签渲染。
function pendingItem(claim, status) {
  return { dimension: claim.dimension ?? '', text: claim.text ?? '', status };
}

// 当前结论所指向的来源：取被支持声明里 stance=supports 的逐字来源，去重、保序。
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
