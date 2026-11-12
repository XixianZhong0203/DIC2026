export function createOpportunityUI({ get, t, element, action, request, formAction, language, createTask, viewSource }) {
  formAction('opportunity-form', async (data, form) => {
    await request('opportunity', data);
    form.reset();
  });
  formAction('lead-search', ({ query }) => {
    const link = get('lead-search-link');
    link.href = 'https://www.google.com/search?q=' + encodeURIComponent(query);
    link.hidden = false;
  });
  formAction('model-evaluation', () => request('opportunity-benchmark', { language: language() }));

  const labels = {
    lead: '潜在客户', idea: '改进想法', research: '资料分析', draft: '起草联系邮件',
    send: '对外发送', transfer: '转账', auto: '可委托 AI', approval: '逐次审批',
    human: '本人处理', captured: '保存线索', assessed: '分析完成', drafted: '草稿已保存',
    simulated_send: '模拟发送成功', blocked: '操作被拦截', policy: '授权已更新', analysis_started: '开始分析', analysis_failed: '模型分析失败',
    evidence_checked: '核对原文', human_reviewed: '人工核实', approved: '已批准版本',
    source_added: '来源已保存', claims_checked: '声明核查完成', claims_failed: '声明核查失败',
    review_source_viewed: '展开来源原文',
    evidence_kind_changed: '初始来源身份已改',
    archived: '发送档案已冻结',
  };

  const sourceKindLabels = { evidence: '证据原文', customer: '客户记录', founder: '创始人提供' };
  // 初始来源的身份（用户录入，决定其引文能如何支持声明；改判后核查指纹变化，旧核查自动过期）。
  const evidenceKindLabels = { customer: '客户原文／外部记录', founder: '创始人陈述', unconfirmed: '来源未确认' };
  // 人工复核过期的原因（由服务端 reviewStale 给出）：明确是草稿变了还是来源变了。
  const reviewStaleLabels = { draft_changed: '草稿变了', source_changed: '来源变了', review_unbound: '复核缺少来源版本' };
  const reviewStaleText = item => (item.reviewStale ?? []).map(code => t(reviewStaleLabels[code] ?? code)).join('、');
  const claimStatusLabels = { supported: '支持', refuted: '反驳', unknown: '证据不足', conflict: '来源冲突', incomplete: '未完成核查',
    founder_only: '由创始人提供，待独立核实', unconfirmed: '来源未确认，待核实' };
  const stanceLabels = { supports: '支持', refutes: '反驳', withdraws: '撤回', neutral: '仅相关' };
  const checkReasonLabels = {
    unknown_source: '引用了不存在的来源', quote_not_found: '引文未在来源原文中逐字找到',
    field_conflict: '模型输出字段不一致', claim_not_in_draft: '声明未在草稿正文中逐字出现',
    request_failed: '模型请求失败', empty_claim_text: '声明原文为空',
    truncated_negation: '声明截断了否定词，语义可能反转',
    quote_missing_context: '引文缺少关键上下文（截掉了原文的否定/条件/限定）', quote_ambiguous: '引文在原文中出现多次且含义不同，需更完整的引文',
  };
  const blockedReasons = { no_evidence_review: '未分析也未复核', unresolved_evidence: '证据未核实且未复核', draft_changed: '草稿版本已过期',
    claims_not_verified: '草稿声明尚未核查', claims_stale: '草稿声明核查已过期', claims_incomplete: '声明核查未完成', claims_unresolved: '声明核查未通过', claims_no_claims: '未提取到声明',
    claims_founder_only: '声明仅由创始人提供', claims_unconfirmed: '声明来源未确认',
    claims_placeholders: '占位符未处理', claims_uncovered: '高风险句未被覆盖', claims_pending: '仍有待处理项',
    claims_previous_unresolved: '上一版仍有未处理声明', claims_recheck_after_edit: '风险声明改写后需重新核查' };
  // 该机会最近一条活动记录：发送被拦截后在草稿区当场显示拦截原因（活动记录同步刷新）。
  function latestBlocked(audit, itemId) {
    const rows = (audit ?? []).filter(row => row.opportunity === itemId);
    const latest = rows[0];
    if (!latest || latest.action !== 'blocked') return null;
    let detail = {};
    try { detail = JSON.parse(latest.detail); } catch {}
    return { reason: detail.reason ?? null, time: latest.time };
  }

  function details(title, content) {
    const wrapper = element('details', '');
    wrapper.append(element('summary', title), element('p', content));
    return wrapper;
  }

  // 人工复核来源记录：当前草稿 + 当前来源集合下，创始人已打开哪些来源原文。
  // 服务端（item.reviewViewed）是权威状态；本地集合用于即时显示，并在整页重渲染后
  // 把打开过的原文重新展开，阅读不中断。草稿或来源变化 → 新绑定 → 从空开始；
  // 旧查看记录只留在审计历史里，不会带到新复核上。展开记录在复核表单里显示为「已打开」。
  const recordViewSource = viewSource ?? (() => Promise.resolve());
  const viewed = new Map(); // 机会 id -> { binding, ids: Set }
  const viewedBinding = item =>
    (item.reviewViewed?.draftId ?? item.draft_id ?? 'none') + '·' + (item.reviewViewed?.evidence ?? 'none');
  function viewedState(item) {
    const binding = viewedBinding(item);
    let mine = viewed.get(item.id);
    if (!mine || mine.binding !== binding) viewed.set(item.id, mine = { binding, ids: new Set() });
    for (const sourceId of item.reviewViewed?.viewed ?? []) mine.ids.add(sourceId);
    return mine;
  }
  const sourceOrder = id => (id === 'E1' ? [0, 0] : [1, Number(id.slice(1))]);
  const sourceName = (item, sourceId) => sourceId === 'E1'
    ? t('证据原文') + ' · ' + item.source
    : ((item.sources ?? []).find(row => 'S' + row.id === sourceId)?.name ?? sourceId);
  function reviewedText(item) {
    const state = viewedState(item);
    return state.ids.size
      ? t('已打开') + ' · ' + [...state.ids]
        .sort((a, b) => sourceOrder(a)[0] - sourceOrder(b)[0] || sourceOrder(a)[1] - sourceOrder(b)[1])
        .map(sourceId => t(sourceName(item, sourceId))).join('、')
      : t('尚未打开来源');
  }
  const viewLines = new Map(); // 机会 id -> Set<复核区状态行>
  function reviewViewLine(item) {
    const line = element('small', reviewedText(item), 'muted');
    if (!viewLines.has(item.id)) viewLines.set(item.id, new Set());
    viewLines.get(item.id).add(line);
    return line;
  }
  function recordView(item, sourceId) {
    const state = viewedState(item);
    if (state.ids.has(sourceId)) return;
    state.ids.add(sourceId);
    for (const line of viewLines.get(item.id) ?? []) line.textContent = reviewedText(item);
    void recordViewSource(item.id, sourceId); // 服务端记录查看动作（静默，不打断阅读）
  }
  // 绑定「可展开来源原文」的元素：展开时记录来源 ID，重渲染后保持展开。
  function viewableDetails(item, sourceId, node) {
    node.addEventListener('toggle', () => { if (node.open) recordView(item, sourceId); });
    if (viewedState(item).ids.has(sourceId)) node.open = true;
    return node;
  }
  // 已保存的人工核实结论 + 当前查看状态行。
  function reviewedBlock(item) {
    const block = element('details', '');
    block.append(element('summary', t('人工核实')), element('p', item.review), reviewViewLine(item));
    return block;
  }

  // 初始来源：身份（客户原文／外部记录、创始人陈述、来源未确认）由用户录入，
  // 决定这段原文的引文能如何支持声明；改判身份会改变核查指纹，已有核查自动过期重跑。
  function originBlock(item) {
    const kind = item.evidence_kind ?? 'unconfirmed';
    const block = element('details', '');
    block.open = true;
    block.append(element('summary', t('出处') + ' · ' + t(evidenceKindLabels[kind] ?? 'unconfirmed') + ' · ' + item.source));
    block.append(element('p', item.evidence));
    const form = element('form', '');
    const select = element('select', '');
    for (const [value, label] of Object.entries(evidenceKindLabels)) {
      const option = element('option', t(label));
      option.value = value;
      option.selected = value === kind;
      select.append(option);
    }
    const confirm = action(t('确认来源身份'), () => {
      if (select.value !== kind) {
        return request('opportunity-evidence-kind', { id: item.id, evidence_kind: select.value, language: language() });
      }
    });
    form.onsubmit = event => { event.preventDefault(); confirm.click(); };
    form.append(select, confirm);
    block.append(form);
    return block;
  }

  // refs 让卡片上的其他区块（当前回答的下一步动作）拿到来源区与草稿正文的节点。
  function sourceBlock(item, refs) {
    const block = element('details', '');
    const sources = item.sources ?? [];
    block.append(element('summary', t('来源') + ' · ' + (1 + sources.length)));
    // sourceById 让复核表单的「查看证据」入口能直接打开问题声明引用的来源原文。
    const sourceById = new Map();
    const remember = (sourceId, node) => { sourceById.set(sourceId, node); return node; };
    block.append(remember('E1', viewableDetails(item, 'E1',
      details(t(sourceKindLabels.evidence) + ' · ' + item.source, item.evidence))));
    for (const row of sources) {
      block.append(remember('S' + row.id, viewableDetails(item, 'S' + row.id, details(
        t(sourceKindLabels[row.kind] ?? row.kind) + (row.date ? ' · ' + row.date : '') + ' · ' + row.name, row.text))));
    }
    // 来源类型标签由用户录入；证据状态只按实际支持声明的引文判定，与来源数量无关。
    block.append(element('small', t('来源类型（客户来源 / 创始人提供）由你录入；声明的证据状态只看实际支持该声明的引文，一条无关的客户引文不会改变它。')));
    const form = element('form', '');
    const name = element('input', '');
    name.required = true;
    name.maxLength = 200;
    name.placeholder = t('来源名称');
    name.setAttribute('aria-label', name.placeholder);
    const date = element('input', '');
    date.type = 'date';
    date.setAttribute('aria-label', t('来源日期'));
    const kind = element('select', '');
    const customer = element('option', t(sourceKindLabels.customer));
    customer.value = 'customer';
    const founder = element('option', t(sourceKindLabels.founder));
    founder.value = 'founder';
    kind.append(customer, founder);
    const text = element('textarea', '');
    text.required = true;
    text.maxLength = 8000;
    text.placeholder = t('来源原文');
    text.setAttribute('aria-label', text.placeholder);
    const save = action(t('保存来源'), () => {
      if (form.reportValidity()) return request('opportunity-source', {
        id: item.id, name: name.value, date: date.value || null, kind: kind.value, text: text.value, language: language(),
      });
    });
    form.onsubmit = event => { event.preventDefault(); save.click(); };
    form.append(name, date, kind, text, save);
    block.append(form);
    if (refs) { refs.sourceDetails = block; refs.sourceText = text; refs.sourceById = sourceById; }
    return block;
  }

  function claimSection(claim, item, embedActions = true) {
    const article = element('article', '', 'entry');
    article.append(element('strong', (claim.dimension ? t(claim.dimension) + ' · ' : '') + (claim.text || t('模型未返回声明原文'))));
    // 支持的声明按支持引文的来源身份标注：只有客户来源引文支持才算「客户来源支持」。
    const customerSupport = claim.status === 'supported' &&
      (claim.conflict ? (claim.conflict.supports ?? []) : (claim.items ?? []))
        .some(entry => entry.valid && entry.stance === 'supports' && entry.source?.kind === 'customer');
    article.append(element('small', t(claimStatusLabels[claim.status] ?? claim.status) +
      (customerSupport ? ' · ' + t('客户来源支持') : '') +
      (claim.withdrawn ? ' · ' + t('该承诺已被撤回') : '')));
    if (claim.status === 'founder_only') {
      article.append(element('small', t('可补入独立来源（如客户合同、付款或交付记录）后重新核查，或改写为有依据的说法，或针对当前草稿与来源记录人工复核结论，再批准发送。')));
    }
    if (claim.status === 'unconfirmed') {
      article.append(element('small', t('请先确认这段来源的身份（客户原文／外部记录、创始人陈述、来源未确认），再补入独立来源（如客户合同、付款或交付记录）后重新核查，或改写为有依据的说法，或针对当前草稿与来源记录人工复核结论，再批准发送。')));
    }
    const cited = (entry, original) => {
      const summary = t(stanceLabels[entry.stance] ?? entry.stance) +
        ' · ' + entry.source.source + (entry.source.date ? ' · ' + entry.source.date : '');
      if (!original) return details(summary, entry.quote + (entry.note ? '（' + entry.note + '）' : ''));
      const block = element('details', '');
      block.append(element('summary', summary),
        element('p', entry.quote + (entry.note ? '（' + entry.note + '）' : '')));
      if (entry.source.text) block.append(element('p', t('来源原文') + ' · ' + entry.source.text));
      // 只有展示来源原文的展开项才计为「展开来源」；引文摘录不算。
      return entry.source.text ? viewableDetails(item, entry.source.id, block) : block;
    };
    if (claim.conflict) {
      for (const entry of [...(claim.conflict.supports ?? []), ...(claim.conflict.opposes ?? [])]) article.append(cited(entry, true));
    } else {
      for (const entry of claim.items ?? []) if (entry.valid) article.append(cited(entry));
    }
    if (claim.missing) article.append(element('p', t('缺少信息') + ' · ' + claim.missing, 'attention'));
    if (claim.rewrite) {
      article.append(element('p', t('建议改写') + ' · ' + claim.rewrite));
      // 复核表单里的逐条条目自带改写/删除/担保入口（claimReviewSection），不重复给按钮。
      if (embedActions && item.draft_id && claim.text && (item.body ?? '').includes(claim.text)) {
        article.append(action(t('采用改写并重新核查'), async () => {
          await request('opportunity-draft', { id: item.id, recipient: item.recipient,
            body: (item.body ?? '').replaceAll(claim.text, claim.rewrite) });
          await request('opportunity-claims', { id: item.id, target: 'draft', language: language() });
        }));
      }
    }
    for (const reason of new Set((claim.failedChecks ?? []).map(check => check.reason))) {
      // 引文上下文问题带结构化 detail（被截子句 + 原因），随标签一起展示原文与原因。
      const check = (claim.failedChecks ?? []).find(entry => entry.reason === reason);
      article.append(element('small', t(checkReasonLabels[reason] ?? reason) +
        (check?.detail ? ' · ' + check.detail : '')));
    }
    return article;
  }

  // 待处理项：核查完成后、发送前仍必须落实的内容——
  // 1. 草稿正文里遗留的方括号占位符（[待确认：…] 等，draftChecks.placeholders）；
  // 2. 未被任何已抽取声明覆盖的高风险句（一句里有两项承诺、模型只抽到一项，draftChecks.unextracted）；
  // 3. 解析告警（如重复声明 ID，warnings）。
  // 展示上三者都列为待处理项；但「当前状态」只按会被窗口 1 门槛拦截的前两类判定
  // （重复声明已保留第一条核查，不影响该声明的判定，不阻断发送），与 /api/opportunity-send 一致。
  const pendingCheckLabels = { duplicate_claim_id: '重复声明已忽略' };
  function pendingItems(review) {
    const items = [];
    for (const placeholder of review?.draftChecks?.placeholders ?? []) {
      items.push({ label: '占位符未处理', text: placeholder });
    }
    for (const clause of review?.draftChecks?.unextracted ?? []) {
      items.push({ label: '未被抽取的高风险句', text: clause });
    }
    return items;
  }
  function pendingChecks(review) {
    const checks = pendingItems(review);
    for (const warning of review?.warnings ?? []) {
      checks.push({ label: pendingCheckLabels[warning.reason] ?? warning.reason, text: warning.id ?? '' });
    }
    return checks;
  }
  function pendingChecksBlock(review) {
    const checks = pendingChecks(review);
    if (!checks.length) return null;
    const wrap = element('div', '');
    wrap.append(element('p', t('仍有待处理项') + ' · ' + checks.length, 'attention'));
    for (const check of checks) {
      wrap.append(element('small', t(check.label) + (check.text ? ' · ' + check.text : ''), 'attention'));
    }
    return wrap;
  }

  // 发送档案（send-archive 窗口）：一次（模拟）发送的不可变快照——当时的草稿、
  // 来源全文、逐条声明判定与引文、查看记录、核查模型/提示版本、批准依据与批准时间
  // 都内嵌在档案里；发送后来源再怎么改，档案仍能还原「当时基于什么批准了什么」。
  // 发送时刻的自动写入由窗口 1 在 /api/opportunity-send 内接入（共用同一构建器）；
  // 这里提供手动冻结入口（opportunity-archive）与导出链接（/api/opportunity-archive/:id）。
  const archiveBasisLabels = { human_review: '人工复核', human_guarantee: '创始人逐条担保', model_supported: '声明核查通过', pending: '未达发送门槛' };
  function archiveTier(title, entries, empty) {
    const block = element('details', '');
    block.append(element('summary', t(title) + ' · ' + (entries.length ? entries.length : t(empty))));
    for (const entry of entries) {
      const label = entry.id + (entry.name ? ' · ' + entry.name : '') +
        (entry.kind ? ' · ' + t(sourceKindLabels[entry.kind] ?? entry.kind) : '') +
        (entry.date ? ' · ' + entry.date : '');
      if (entry.text) block.append(details(label, entry.text));
      else if (entry.quote) block.append(details(label, entry.quote + (entry.note ? '（' + entry.note + '）' : '')));
      else block.append(element('small', label));
    }
    return block;
  }
  // 核查配置行：展示核查记录在核查时刻落下的实际配置。
  // 旧记录缺 model 字段 → 整行显示「未记录」（不用渲染时刻的当前配置补写历史）；
  // 记录里 effort=null → 「端点默认」档位（核查路径从不逐请求发送 reasoning_effort）。
  const effortLabels = { low: '低', medium: '中', high: '高' };
  function checkConfigText(record) {
    if (!record || record.model == null) return t('未记录');
    const effort = 'effort' in record
      ? (record.effort == null ? t('端点默认') : t(effortLabels[record.effort] ?? record.effort))
      : t('未记录');
    const prompts = record.prompts;
    const versions = (prompts && (prompts.claims || prompts.analysis))
      ? (prompts.claims || '—') + ' / ' + (prompts.analysis || '—')
      : t('未记录');
    return t('核查模型') + ' · ' + record.model + ' · ' + t('思考档位') + ' · ' + effort +
      ' · ' + t('提示版本') + ' · ' + versions;
  }
  function archiveEntry(archive) {
    const entry = element('details', '');
    const approval = archive.approval ?? {};
    const basis = t(archiveBasisLabels[approval.basis] ?? approval.basis ?? 'pending');
    // 档案字节被改成非法 JSON 时 state 附带最小占位（archiveId + integrity）：时间显示「未记录」。
    entry.append(element('summary', (archive.sentAt ? new Date(archive.sentAt).toLocaleString(language()) : t('未记录')) +
      ' · ' + basis + (archive.sent ? ' · ' + t('已发送') : '')));
    entry.append(element('p',
      (approval.recipient ? t('收件人') + ' · ' + approval.recipient + ' · ' : '') + t('批准依据') + ' · ' + basis));
    if (approval.body) entry.append(details(t('草稿正文'), approval.body));
    // 核查配置取档案内嵌的 verification 块（核查时刻写下的实际值，旧档案不补写）。
    entry.append(element('small', checkConfigText(archive.verification ?? {})));
    // 完整性：存档 digest 与存储字节重算的比对结果（服务端 state 附带）；
    // mismatch 高亮：档案内容与批准记录不一致。
    const integrity = archive.integrity ?? null;
    if (integrity) {
      entry.append(element('small',
        t('完整性') + ' · ' + (integrity.status === 'verified' ? t('校验通过')
          : integrity.status === 'mismatch' ? t('档案内容与批准记录不一致')
          : t('无完整性记录')),
        integrity.status === 'mismatch' ? 'attention' : undefined));
    }
    // 三档来源（都读档案内嵌快照，与活动来源无关）：
    // 1. 提供给模型的来源 = 核查输入全集（含全文）；
    // 2. 回答引用的来源 = 分析引文所出（E1）+ 结构化回答明指的来源；
    // 3. 核查判定支持该声明的来源 = 每条声明里 stance=supports 的有效引文所在来源。
    const snapshot = (archive.sources ?? []).map(source => ({
      id: source.id, name: source.source, kind: source.kind, date: source.date, text: source.text,
    }));
    entry.append(archiveTier('提供给模型的来源', snapshot, '无来源'));
    entry.append(archiveTier('回答引用的来源', archive.answerCitedSources ?? [], '回答未引用来源'));
    const supportTier = element('details', '');
    supportTier.append(element('summary', t('核查判定支持该声明的来源')));
    const claims = archive.claims ?? [];
    if (!claims.length) supportTier.append(element('small', t('档案中没有声明核查记录')));
    for (const claim of claims) {
      const claimBlock = element('details', '');
      claimBlock.append(element('summary',
        (claim.dimension ? t(claim.dimension) + ' · ' : '') + (claim.text || t('模型未返回声明原文')) +
        ' · ' + t(claimStatusLabels[claim.status] ?? claim.status)));
      const sources = claim.supportingSources ?? [];
      for (const source of sources) {
        claimBlock.append(details(source.id + ' · ' + source.name + ' · ' + source.quote,
          source.note ? '（' + source.note + '）' : ''));
      }
      if (!sources.length) claimBlock.append(element('small', t('该声明没有来自来源的支持性引文')));
      const items = claim.items ?? [];
      if (items.length) {
        claimBlock.append(element('small', t('逐条担保理由')));
        for (const item of items) {
          const note = item.note ? '（' + item.note + '）' : '';
          const invalid = item.valid ? '' :
            (item.reasons?.length ? ' · ' + item.reasons.map(reason => t(checkReasonLabels[reason] ?? reason)).join('、') : '');
          claimBlock.append(details(
            t(stanceLabels[item.stance] ?? item.stance ?? '') + ' · ' + item.evidenceId + invalid,
            (item.quote ?? '') + note));
        }
      }
      supportTier.append(claimBlock);
    }
    entry.append(supportTier);
    const viewing = archive.viewing ?? null;
    if (viewing) {
      entry.append(element('small', t('查看记录') + ' · ' +
        ((viewing.viewedNames ?? []).length ? t('已展开来源') + ' · ' + viewing.viewedNames.join('、') : t('尚未展开来源'))));
    }
    const link = element('a', t('导出发送档案'));
    link.href = '/api/opportunity-archive/' + archive.archiveId;
    link.download = 'daymark-send-archive-' + archive.archiveId + '.json';
    entry.append(link);
    return entry;
  }
  function archivesBlock(item) {
    const block = element('details', '');
    const archives = item.archives ?? [];
    block.append(element('summary', t('发送档案') + (archives.length ? ' · ' + archives.length : '')));
    if (!archives.length) {
      block.append(element('p', t('还没有发送档案。冻结会把当前草稿、来源、核查与批准状态存为不可变快照；发送后来源再怎么改，档案里仍是当时批准的原文。')));
    }
    for (const archive of archives) block.append(archiveEntry(archive));
    block.append(action(t('冻结当前状态为发送档案'), () => request('opportunity-archive', { id: item.id })));
    return block;
  }

  function claimsBlock(item) {
    const review = item.claims;
    const block = element('details', '');
    const label = t('声明核查') + (review ? ' · ' +
      t(review.target === 'draft' ? '草稿声明' : '分析声明') + ' · ' + new Date(review.at).toLocaleString(language()) : '');
    block.append(element('summary', label));
    if (!review) {
      block.append(element('p', t('还没有核查记录。') +
        t(item.kind === 'lead' ? '分析后自动核查，或在保存草稿后点「核查关键声明」。' : '分析后自动核查。')));
      return block;
    }
    // 待处理项置顶：先于过期/错误提示，保证一眼看到「还有事没做完」。
    const pending = pendingChecksBlock(review);
    if (pending) block.append(pending);
    if (item.claimsStale) block.append(element('p', t('核查已过期：来源或草稿已变更，请重新核查。'), 'attention'));
    if (review.error) block.append(element('p', t('模型请求失败') + ' · ' + review.error, 'attention'));
    // 实际核查范围：列出本次真正核查过的声明；为空时明确提示范围是空的，避免被当成"核查通过"。
    const scope = (review.claims ?? []).map(claim =>
      (claim.dimension ? t(claim.dimension) + '：' : '') + (claim.text || t('模型未返回声明原文')));
    if (!review.error) block.append(element('small', t('本次核查范围') + ' · ' +
      (scope.length ? scope.join('；') : t('未提取到声明'))));
    block.append(element('small', checkConfigText(review)));
    if (review.claims?.length) {
      for (const claim of review.claims) block.append(claimSection(claim, item));
    } else {
      block.append(element('p', t('本次核查未提取到任何声明，实际核查范围为空，不能视为核查通过。'), 'attention'));
    }
    block.append(action(t('重新核查'), () => request('opportunity-claims', {
      id: item.id, target: review.target,
      draft_id: review.target === 'draft' ? (item.draft_id ?? undefined) : undefined,
      language: language(),
    })));
    return block;
  }

  // —— 逐条人工复核（per-claim review）——
  // 当前草稿核查中被标记（未获客户来源支持）的声明。
  // 核查不存在、失败、过期或实际核查范围为空时返回空——此时保留整体人工复核路径。
  function flaggedClaims(item) {
    const review = item.claims;
    if (!review || review.target !== 'draft' || review.error || item.claimsStale) return [];
    if (!(review.claims ?? []).length) return [];
    return (review.claims ?? []).filter(claim => claim.status !== 'supported');
  }
  // 一条声明是否已有逐条担保（服务端 state().claimResolutions 已按当前草稿 + 来源版本过滤）。
  const isGuaranteed = (item, claim) => (item.claimResolutions ?? []).some(row =>
    row.claimId === claim.id && row.claimText === claim.text);
  // 与发送门槛一致的本地镜像：可批准 = 绑定当前草稿与来源的人工复核，
  // 或草稿核查新鲜、范围非空、每条被标记声明都有逐条担保（或全部获支持）。
  const previousFlags = item => item.previousUnresolvedClaims ?? [];
  const previousGuarantee = (item, claim) => (item.claimResolutions ?? []).find(row => row.claimText === claim.text);
  const unhandledPrevious = item => previousFlags(item).filter(claim => !previousGuarantee(item, claim));

  function sendable(item) {
    if (item.needsClaimRecheck || unhandledPrevious(item).length) return false;
    if (item.draftPlaceholders?.length) return false;
    const review = item.claims;
    if (!item.claimsStale && review?.target === 'draft' &&
        review.warnings?.some(warning => warning.reason === 'duplicate_claim_id')) return false;
    const currentReview = item.review && item.review_draft === item.draft_id && !item.reviewStale;
    const coverage = item.carryoverChecks ?? (!item.claimsStale && review?.target === 'draft' && !review.error && review.claims?.length ? review.draftChecks : null);
    if (coverage?.placeholders?.length ||
        coverage?.unextracted?.some(clause => !currentReview || !item.review.includes(clause))) return false;
    if (review?.target !== 'draft' || review.error || item.claimsStale || !review.claims?.length) {
      return Boolean(item.review && !item.reviewStale) || previousFlags(item).length > 0;
    }
    return review.claims.every(claim => claim.status === 'supported' || isGuaranteed(item, claim));
  }
  // 一条被标记声明的逐条复核条目：原句、判定、依据（复用 claimSection 的展示），
  // 「查看证据」入口放在问题声明旁（打开对应来源原文即计入「已打开」记录），
  // 以及创始人的处理：改写 / 删除（都保存新草稿并重新核查）、或保留这条声明并记录担保理由。
  function claimReviewSection(claim, item, refs, previous = false) {
    const article = claimSection(claim, item, false);
    const citedEntries = claim.conflict
      ? [...(claim.conflict.supports ?? []), ...(claim.conflict.opposes ?? [])]
      : (claim.items ?? []).filter(entry => entry.valid);
    const openEvidence = action(t('查看证据'), () => {
      if (refs.sourceDetails) refs.sourceDetails.open = true;
      const sourceIds = [...new Set(citedEntries.filter(entry => entry.source).map(entry => entry.source.id))];
      // 声明没有引文时，回到初始来源原文（E1）核对。
      for (const sourceId of sourceIds.length ? sourceIds : ['E1']) {
        const node = refs.sourceById?.get(sourceId);
        if (node && !node.open) node.open = true; // toggle 事件记录「已打开」
      }
    });
    const resolution = previous ? previousGuarantee(item, claim)
      : (item.claimResolutions ?? []).find(row => row.claimId === claim.id && row.claimText === claim.text);
    if (resolution) {
      article.append(openEvidence,
        element('p', t('已记录担保') + ' · ' + t('我已核实并愿意承担这条说法') + ' · ' + resolution.reason +
          ' · ' + new Date(resolution.at).toLocaleString(language()), 'muted'));
      return article;
    }
    const reverify = async nextBody => {
      // 改写/删除：保存新草稿版本（正文变化产生新草稿 ID），再重新核查。
      await request('opportunity-draft', { id: item.id, recipient: item.recipient, body: nextBody });
      await request('opportunity-claims', { id: item.id, target: 'draft', language: language() });
    };
    const rows = element('div', '');
    // 改写：原句替换为新说法（默认带入建议改写）。
    const rewrite = element('input', '');
    rewrite.maxLength = 4000;
    rewrite.value = claim.rewrite ?? '';
    rewrite.placeholder = t('改写后的说法');
    rewrite.setAttribute('aria-label', rewrite.placeholder);
    const rewriteRow = element('div', '');
    rewriteRow.append(rewrite, action(t('改写并重新核查'), async () => {
      const next = (item.body ?? '').replaceAll(claim.text, rewrite.value);
      if (next.trim()) await reverify(next);
    }));
    // 删除：从正文移除原句。
    const deleteRow = element('div', '');
    deleteRow.append(action(t('删除此句并重新核查'), async () => {
      const next = (item.body ?? '').replaceAll(claim.text, '');
      if (next.trim()) await reverify(next);
    }));
    // 担保：保留这条声明，明确记录「我已核实并愿意承担这条说法」+ 理由。
    const reason = element('input', '');
    reason.maxLength = 2000;
    reason.placeholder = t('记录担保理由');
    reason.setAttribute('aria-label', reason.placeholder);
    const guaranteeRow = element('div', '');
    guaranteeRow.append(reason, action(t('我已核实并愿意承担这条说法'), async () => {
      if (reason.value.trim()) await request('opportunity-claim-resolution', {
        id: item.id, draft_id: item.draft_id, claim_id: claim.id, text: claim.text, reason: reason.value,
        ...(previous && item.claimEvidenceHash ? { evidence_hash: item.claimEvidenceHash } : {}),
      });
    }));
    rows.append(rewriteRow, deleteRow, guaranteeRow);
    article.append(openEvidence,
      element('small', t('处理方式：改写或删除后保存新草稿并重新核查；保留这条声明时，明确记录「我已核实并愿意承担这条说法」并附理由。'), 'muted'),
      rows);
    return article;
  }

  // 当前回答：证据不足时怎么说、怎么继续。措辞与边界由服务端 evidenceAnswer 确定性决定，
  // 这里只负责展示，并把「下一步」接到卡片上已有的入口——查看来源 / 补资料 / 采用澄清问题
  // （对应决策卡的 view / source / draft 三个选项），失败时给出重试。
  const answerSituationLabels = {
    sufficient: '证据充分 · 结论有边界',
    insufficient: '证据不足 · 先说清缺口',
    conflict: '来源冲突 · 先比较记录',
    failed: '核查失败 · 可重试',
  };
  function answerBlock(item, refs, result) {
    const answer = item.answer;
    if (!answer) return null;
    const block = element('section', '', 'evidence-answer');
    block.setAttribute('data-situation', answer.situation);
    block.append(element('strong', t('当前回答') + ' · ' + t(answerSituationLabels[answer.situation] ?? answer.situation)));
    if (answer.situation === 'sufficient') {
      if (answer.confirmed) block.append(element('p', t('已确认') + ' · ' + answer.confirmed));
      if (answer.missing) block.append(element('p', t('仍缺') + ' · ' + answer.missing, 'attention'));
      if (answer.bounds) block.append(element('p', t('结论边界') + ' · ' + answer.bounds, 'attention'));
      if (answer.supporting?.length) {
        block.append(element('small', t('依据来源') + ' · ' + answer.supporting.map(source => source.label).join('、')));
      }
    } else if (answer.situation === 'insufficient') {
      if (answer.confirmed) block.append(element('p', t('已确认') + ' · ' + answer.confirmed));
      if (answer.missing) block.append(element('p', t('缺少') + ' · ' + answer.missing, 'attention'));
    } else if (answer.situation === 'conflict') {
      if (answer.missing) block.append(element('p', t('缺少') + ' · ' + answer.missing, 'attention'));
      for (const entry of answer.compare ?? []) {
        block.append(details(t(stanceLabels[entry.stance] ?? entry.stance) + ' · ' + entry.label +
          (entry.quote ? ' · ' + entry.quote : ''), entry.text));
      }
    }
    // 待核实项：仅创始人陈述／来源未确认的已提取声明（evidenceAnswer.pending）。
    // 措辞复用声明状态标签，与声明核查区一致；结论只到已支持的部分，这里不被省略。
    if (answer.pending?.length) {
      const pendingText = answer.pending.map(entry =>
        (entry.dimension ? t(entry.dimension) + '：' : '') + (entry.text || t('模型未返回声明原文'))
        + '（' + t(claimStatusLabels[entry.status] ?? entry.status) + '）').join('；');
      block.append(element('p', t('待核实') + ' · ' + pendingText, 'attention'));
    }
    if (answer.next) block.append(element('p', t('下一步') + ' · ' + answer.next));
    if (answer.incomplete?.length) {
      block.append(element('small', t('未完成核查') + ' · ' + answer.incomplete.join('、'), 'attention'));
    }
    const buttons = [];
    if (answer.situation === 'failed') {
      buttons.push(action(t('重新核查'), () => request('opportunity-claims', {
        id: item.id, target: 'analysis', language: language(),
      })));
    }
    buttons.push(action(t('查看来源'), () => { if (refs.sourceDetails) refs.sourceDetails.open = true; }));
    buttons.push(action(t('补资料'), () => {
      if (refs.sourceDetails) refs.sourceDetails.open = true;
      refs.sourceText?.focus?.();
    }));
    if (result?.clarification) {
      buttons.push(action(t('采用澄清问题'), () => {
        if (refs.draftBody) { refs.draftBody.value = result.clarification; refs.draftBody.focus?.(); }
      }));
    }
    block.append(...buttons);
    return block;
  }

  // 当前状态：从创始人批准视角看已保存草稿的发送门槛状态。
  // 需要处理 / 核查过期 / 待批准；尚无草稿或尚无针对草稿的核查记录时给出前置状态。
  // 人工复核结论绑定当前草稿与当前来源版本：复核过期（草稿变了或来源变了）时不再显示待批准。
  function approvalStatus(item) {
    if (!item.draft_id) return { label: '尚未保存草稿', tone: 'muted' };
    const retained = unhandledPrevious(item).length;
    if (retained) return { label: '上一版仍有未处理声明', tone: 'attention', count: retained };
    if (item.needsClaimRecheck) return { label: '风险声明改写后需重新核查', tone: 'attention' };
    if (sendable(item)) return { label: '待批准', tone: 'muted' };
    if (item.draftPlaceholders?.length) return { label: '仍有待处理项', tone: 'attention', count: item.draftPlaceholders.length };
    if (item.reviewStale && !flaggedClaims(item).length) {
      return { label: t('复核已过期') + ' · ' + reviewStaleText(item), tone: 'attention' };
    }
    const review = item.claims;
    if (!review || review.target !== 'draft') return { label: '尚未核查', tone: 'attention' };
    if (item.claimsStale) return { label: '核查过期', tone: 'attention' };
    const claims = review.claims ?? [];
    if (review.error || !claims.length) return { label: '需要处理', tone: 'attention' };
    // 逐条人工复核：被标记声明全部有逐条担保时即为待批准（与发送门槛一致）。
    const unhandled = claims.filter(claim => claim.status !== 'supported' && !isGuaranteed(item, claim));
    if (unhandled.length) return { label: '待处理 ' + unhandled.length + ' 条', tone: 'attention' };
    const pending = pendingChecks(review).length;
    if (pending) return { label: '仍有待处理项', tone: 'attention', count: pending };
    return { label: '待批准', tone: 'muted' };
  }

  // 有问题的声明：显示在草稿与批准按钮旁，给出原句、依据（引文或缺口）、建议改写和采用动作。
  function attentionClaims(item) {
    const review = item.claims;
    if (!review || review.target !== 'draft') return null;
    const wrap = element('div', '');
    if (review.error) {
      wrap.append(element('p', t('模型请求失败') + ' · ' + review.error, 'attention'));
      return wrap;
    }
    const claims = (review.claims ?? []).filter(claim => claim.status !== 'supported');
    if (!(review.claims ?? []).length) {
      wrap.append(element('p', t('本次核查未提取到任何声明，实际核查范围为空，不能视为核查通过。'), 'attention'));
      return wrap;
    }
    if (!claims.length) return null;
    wrap.append(element('p', t('有问题的声明') + ' · ' + claims.length, 'attention'));
    for (const claim of claims) wrap.append(claimSection(claim, item));
    return wrap;
  }

  function opportunityCard(item, audit) {
    const card = element('article', '', 'entry');
    card.setAttribute('data-opportunity-id', item.id);
    card.append(element('small', t(labels[item.kind])), element('h3', item.title));
    // 初始来源的出处 + 身份（客户原文／创始人陈述／未确认）：改判身份会让旧核查自动过期重跑。
    card.append(originBlock(item));
    const refs = { sourceDetails: null, sourceText: null, sourceById: new Map(), draftBody: null };
    card.append(sourceBlock(item, refs));
    const result = item.analysis && JSON.parse(item.analysis);
    if (result) {
      card.append(element('p', t(result.status === 'supported' ? '模型判断有依据，请核对' : '证据不足或仍待确认'), 'attention'));
      const answer = answerBlock(item, refs, result);
      if (answer) card.append(answer);
      if (result.quote) card.append(details(t('核对原文片段'), result.quote));
      if (result.reason) card.append(details(t('判断依据'), result.reason));
      if (result.conflict) card.append(element('p', result.conflict, 'attention'));
      if (result.clarification) card.append(element('p', result.clarification));
      if (result.unknown) card.append(details(t('仍需核实'), result.unknown));
      if (result.suggestedReply) card.append(details(t('模型建议稿'), result.suggestedReply));
      card.append(details(t('模型原始输出'), result.raw));
      if (item.review) card.append(reviewedBlock(item));
    }
    // 人工复核结论绑定到当前草稿版本与当前来源版本：草稿换新版本或来源变化后，
    // 旧复核不能解锁当前草稿的发送门禁，表单重新出现，供针对当前草稿与来源记录结论。
    const reviewCurrent = Boolean(item.review) && item.review_draft === item.draft_id && !item.reviewStale;
    const flagged = flaggedClaims(item);
    if (previousFlags(item).length || flagged.length || (!item.review && (result ? result.status !== 'supported' : item.kind === 'lead')) ||
      (item.draft_id && !reviewCurrent)) {
      const reviewForm = element('form', '');
      // 复核区显示当前查看状态：已打开哪些来源 / 尚未打开来源。
      // 这里记录的是查看动作，结论仍由创始人自己写下。
      reviewForm.append(reviewViewLine(item),
        element('small', t('展开来源原文会记录下来，保存复核时随结论写入审计。'), 'muted'));
      const retained = previousFlags(item);
      if (retained.length) {
        const pending = unhandledPrevious(item).length;
        reviewForm.append(element('p', t(pending ? '上一版仍有未处理声明' : '已复核上一版保留声明') +
          ' · ' + (pending || retained.length), pending ? 'attention' : 'muted'));
        for (const claim of retained) reviewForm.append(claimReviewSection(claim, item, refs, true));
      }
      // 逐条人工复核：当前草稿核查中被标记的声明，逐条给出原句、判定、依据与处理入口。
      if (flagged.length) {
        reviewForm.append(element('small', t('有问题的声明') + ' · ' + flagged.length +
          ' · ' + t('逐条处理：改写或删除后重新核查，或保留并记录担保理由。'), 'attention'));
        for (const claim of flagged) reviewForm.append(claimReviewSection(claim, item, refs));
      } else if (item.draft_id && item.claims?.target === 'draft') {
        // 模型核查失败或未提取到声明：明确显示实际核查范围，保留下方的人工复核路径。
        if (item.claims.error) {
          reviewForm.append(element('p', t('模型核查失败') + ' · ' + item.claims.error +
            ' · ' + t('实际核查范围：0 条声明（核查未完成）。请重新核查，或在下方记录人工复核结论。'), 'attention'));
        } else if (item.claimsStale) {
          reviewForm.append(element('p', t('核查已过期：来源或草稿已变更，请重新核查，或在下方记录人工复核结论。'), 'attention'));
        } else if (!(item.claims.claims ?? []).length) {
          reviewForm.append(element('p', t('本次核查未提取到任何声明，实际核查范围为空，不能视为核查通过。请在下方记录人工复核结论。'), 'attention'));
        }
      }
      const resolution = element('textarea', '');
      resolution.required = true;
      resolution.maxLength = 2000;
      resolution.placeholder = t('记录核实结果或说明这封邮件只用于澄清');
      resolution.setAttribute('aria-label', resolution.placeholder);
      const saveReview = action(t('保存核实结果'), () => {
        if (reviewForm.reportValidity()) return request('opportunity-review', {
          id: item.id, analysis_id: result?.analysisId ?? null, draft_id: item.draft_id ?? null,
          resolution: resolution.value,
        });
      });
      reviewForm.append(resolution, saveReview);
      card.append(reviewForm);
    }
    card.append(claimsBlock(item));
    // 发送档案：不可变快照（三档来源 + 批准上下文 + 导出），与活动来源无关。
    card.append(archivesBlock(item));
    const analysisForm = element('form', '');
    const question = element('input', '');
    question.required = true;
    question.maxLength = 1000;
    question.placeholder = t('你希望核实什么？');
    question.setAttribute('aria-label', question.placeholder);
    const analyze = action(t('用模型分析'), () =>
      request('opportunity-assess', { id: item.id, request: question.value, language: language() }), false);
    analysisForm.onsubmit = event => { event.preventDefault(); analyze.click(); };
    analysisForm.append(question, analyze);
    card.append(analysisForm, action(t('创建跟进待办'), () => createTask(item)));
    if (item.kind === 'lead') {
      const editor = element('details', '');
      editor.append(element('summary', t('联系邮件草稿')));
      const form = element('form', '');
      const recipient = element('input', '');
      recipient.type = 'email';
      recipient.required = true;
      recipient.placeholder = t('收件人');
      recipient.setAttribute('aria-label', recipient.placeholder);
      recipient.value = item.recipient ?? '';
      const body = element('textarea', '');
      body.required = true;
      body.placeholder = t('邮件正文');
      body.setAttribute('aria-label', body.placeholder);
      body.value = item.body ?? '';
      refs.draftBody = body;
      const suggestion = item.analysis && JSON.parse(item.analysis).suggestedReply;
      if (suggestion) editor.append(action(t('将模型建议填入草稿'), () => { body.value = suggestion; }));
      const save = action(t('保存邮件草稿'), () => {
        if (form.reportValidity()) return request('opportunity-draft', { id: item.id, recipient: recipient.value, body: body.value });
      });
      form.onsubmit = event => { event.preventDefault(); save.click(); };
      form.append(recipient, body, save);
      editor.append(form);
      const evidenceLabel = item.review ? (item.reviewStale ? t('人工核实已过期') : t('已人工核实'))
        : result?.status === 'supported' ? t('模型判断有依据')
        : result ? t('模型判断待核实')
        : t('无证据：未分析、未复核');
      card.append(element('p', t('证据状态') + ' · ' + evidenceLabel,
        item.reviewStale || (!item.review && result?.status !== 'supported') ? 'attention' : 'muted'));
      if (!item.sent) {
        const status = approvalStatus(item);
        card.append(element('p', t('当前状态') + ' · ' + t(status.label) +
          (status.count ? ' · ' + status.count : ''), status.tone));
      }
      if (item.review) card.append(element('p', t('核实记录') +
        (item.reviewStale ? ' · ' + t('复核已过期') + ' · ' + reviewStaleText(item) : '') + ' · ' + item.review,
        item.reviewStale ? 'attention' : 'muted'), reviewViewLine(item));
      if (item.draft_id) {
        editor.open = true;
        // 待处理项置顶到草稿区：优先于已保存版本正文与「有问题的声明」。
        // 只针对针对草稿的核查结果；已发送的机会不再展示。
        const pending = !item.sent && item.claims?.target === 'draft' ? pendingChecksBlock(item.claims) : null;
        if (pending) editor.append(pending);
        editor.append(details(t('待审核的已保存版本') + ' · ' + item.recipient, item.body));
        if (item.sent) {
          editor.append(element('p', t('模拟发送成功')));
        } else {
          const attention = attentionClaims(item);
          if (attention) editor.append(attention);
          // 发送被拦截：拦截原因 + 最新活动记录在草稿区当场显示。
          const lastBlock = latestBlocked(audit, item.id);
          if (lastBlock) {
            editor.append(element('p', t('操作被拦截') + ' · ' + t(blockedReasons[lastBlock.reason] ?? lastBlock.reason) + ' · ' + new Date(lastBlock.time).toLocaleString(language()), 'attention'))
          }
          editor.append(action(t(item.claims?.target === 'draft' ? '重新核查' : '核查关键声明'), () => request('opportunity-claims', {
            id: item.id, target: 'draft', draft_id: item.draft_id, language: language(),
          }), false));
          if (unhandledPrevious(item).length) {
            editor.append(element('p', t('上一版仍有未处理声明') + ' · ' +
              unhandledPrevious(item).map(claim => claim.text).join('、'), 'attention'));
          } else if (item.needsClaimRecheck) {
            editor.append(element('p', t('风险声明改写后需重新核查'), 'attention'));
          } else if (item.reviewStale && !sendable(item)) {
            editor.append(element('p', t('人工核实已过期') + ' · ' + reviewStaleText(item) +
              ' · ' + t('请重新核查，或针对当前草稿记录人工复核结论。'), 'attention'));
          } else if (!item.review && !result && !sendable(item)) {
            editor.append(element('p', t('还没有分析，也没有人工复核。请先用模型分析，或先记录人工核实结果，再批准发送。'), 'attention'));
          } else if (!sendable(item)) {
            // 逐条人工复核：被标记声明未全部处理（或核查未完成/过期/范围为空）时不显示批准。
            const unhandled = flaggedClaims(item).filter(claim => !isGuaranteed(item, claim));
            if (unhandled.length) {
              editor.append(element('p', t('还有 ' + unhandled.length + ' 条被标记声明待处理。') +
                t('逐条改写、删除或记录担保后，再批准发送。'), 'attention'));
            } else if (item.claims?.error) {
              editor.append(element('p', t('模型核查失败') + ' · ' + item.claims.error +
                ' · ' + t('实际核查范围：0 条声明（核查未完成）。请重新核查，或记录人工复核结论，再批准发送。'), 'attention'));
            } else {
              editor.append(element('p', t('请先核查关键声明，或针对当前草稿记录人工复核结论，再批准发送。'), 'attention'));
            }
          } else {
            const guaranteed = [...flaggedClaims(item).filter(claim => isGuaranteed(item, claim)),
              ...previousFlags(item).filter(claim => previousGuarantee(item, claim))];
            editor.append(action(t('批准已保存版本并模拟发送'), () =>
              request('opportunity-send', { id: item.id, draft_id: item.draft_id }), false));
            if (guaranteed.length) {
              editor.append(element('p', t('批准发送将记录由创始人担保的声明') + ' · ' +
                guaranteed.map(claim => claim.text).join('、'), 'muted'));
            }
          }
        }
      }
      card.append(editor);
    }
    return card;
  }

  return function render(state) {
    get('opportunity-list').replaceChildren(...(state.opportunities ?? []).map(item => opportunityCard(item, state.audit)));
    get('delegation-list').replaceChildren(...Object.entries(state.delegation ?? {}).map(([key, mode]) => {
      const row = element('div', '', 'entry');
      row.append(element('strong', t(labels[key])), element('p', t(labels[mode] ?? '仅起草')));
      if (key !== 'transfer') {
        const next = mode === 'human' ? { research: 'auto', draft: 'draft', send: 'approval' }[key] : 'human';
        row.append(action(t(next === 'human' ? '改为本人处理' : '恢复委托'), () =>
          request('delegation', { action: key, mode: next })));
      }
      return row;
    }));
    get('opportunity-audit').replaceChildren(...(state.audit ?? []).map(event => {
      const detail = JSON.parse(event.detail);
      const reason = event.action === 'blocked' && detail.reason ? ' · ' + t(blockedReasons[detail.reason] ?? detail.reason) : '';
      let summary = t(labels[event.action] ?? event.action) + reason + ' · ' + new Date(event.time).toLocaleString(language());
      let note = '';
      if (event.action === 'review_source_viewed' && detail.name) {
        // 查看动作随来源名称记录，一眼看出当时展开的是哪条原文。
        summary = t(labels.review_source_viewed) + ' · ' + detail.name + ' · ' + new Date(event.time).toLocaleString(language());
      } else if (event.action === 'human_reviewed' && Array.isArray(detail.viewed)) {
        // 保存复核时已把已打开来源、草稿 ID、来源版本与结论写入审计；摘要标明已打开哪些来源。
        // 功能上线前的旧记录没有 viewed 字段，不标注，避免误读。
        note = detail.viewed.length
          ? t('已打开') + ' · ' + (detail.viewedNames ?? []).join('、')
          : t('尚未打开来源');
      }
      const block = element('details', '');
      block.append(element('summary', summary));
      if (note) block.append(element('p', note, 'muted'));
      block.append(element('p', JSON.stringify(detail, null, 2)));
      return block;
    }));
    const report = state.benchmark;
    get('model-results').replaceChildren();
    if (report) {
      get('model-results').append(element('p', report.model + ' · ' + report.at));
      for (const row of report.results) {
        get('model-results').append(details(row.id + ' · ' + t(row.guarded ? 'Daymark 提示' : '基础模型') +
          ' · ' + t(row.error ? '模型分析失败' : row.statusMatched ? '符合预期' : '需要复核'), JSON.stringify(row, null, 2)));
      }
      const link = element('a', t('下载模型评估凭据'));
      link.href = '/api/opportunity-report';
      link.download = 'daymark-model-evaluation.json';
      get('model-results').append(link);
    }
  };
}
