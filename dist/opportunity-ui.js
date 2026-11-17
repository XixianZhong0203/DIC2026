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
    archived: '发送档案已冻结', claim_rewrite_reviewed: '改写核对已记录',
  };

  const sourceKindLabels = { evidence: '证据原文', customer: '客户记录', founder: '创始人提供' };
  // Initial source identity (entered by the user, determines how its citations can support claims; after a
  // reclassification, verification fingerprints change and previous verifications automatically expire).
  const evidenceKindLabels = { customer: '客户原文／外部记录', founder: '创始人陈述', unconfirmed: '来源未确认' };
  // Reason for manual review expiration (provided by the server reviewStale): explicitly specifies whether
  // the draft or the source changed.
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
  const blockedReasons = { disclosure_restricted: '当前收件人无权收到草稿中的受限内容。', no_evidence_review: '未分析也未复核', unresolved_evidence: '证据未核实且未复核', draft_changed: '草稿版本已过期',
    claims_not_verified: '草稿声明尚未核查', claims_stale: '草稿声明核查已过期', claims_incomplete: '声明核查未完成', claims_unresolved: '声明核查未通过', claims_no_claims: '未提取到声明',
    claims_founder_only: '声明仅由创始人提供', claims_unconfirmed: '声明来源未确认',
    claims_placeholders: '占位符未处理', claims_uncovered: '高风险句未被覆盖', claims_pending: '仍有待处理项',
    claims_previous_unresolved: '上一版仍有未处理声明', claims_recheck_after_edit: '风险声明改写后需重新核查' };
  // Latest activity record for this opportunity: when sending is blocked, the block reason is displayed
  // directly in the draft area (the activity record refreshes synchronously).
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

  // Manually reviewed source records: under the current draft + current source set, which source originals
  // have been opened by the founder.
  // The server (item.reviewViewed) is the authoritative state; the local set is used for instant display,
  // and after a full-page re-render,
  // previously opened originals are re-expanded to ensure uninterrupted reading. Draft or source changes
  // -> new binding -> starts from empty;
  // old view records remain only in the audit history and are not carried over to the new review.
  // Expansion records are displayed as "Opened" in the review form.
  const recordViewSource = viewSource ?? (() => Promise.resolve());
  const viewed = new Map(); // Opportunity id -> { binding, ids: Set }
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
  const viewLines = new Map(); // Opportunity id -> Set<review area status row>
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
    void recordViewSource(item.id, sourceId); // Server records viewing action (silent, does not interrupt reading)
  }
  // Bind elements for "expandable source originals": record the source ID upon expansion and maintain the
  // expanded state after re-rendering.
  function viewableDetails(item, sourceId, node) {
    node.addEventListener('toggle', () => { if (node.open) recordView(item, sourceId); });
    if (viewedState(item).ids.has(sourceId)) node.open = true;
    return node;
  }
  // Saved manual verification conclusion + current viewing status row.
  function reviewedBlock(item) {
    const block = element('details', '');
    block.append(element('summary', t('人工核实')), element('p', item.review), reviewViewLine(item));
    return block;
  }

  // Initial source: Identity (customer original/external record, founder statement, unconfirmed source) is
  // entered by the user,
  // determining how citations of this original can support claims; reclassifying the identity changes the
  // verification fingerprint, and existing verifications automatically expire and re-run.
  function disclosureControls(item, sourceId, sourceText) {
    const rule = (item.disclosureRules ?? []).find(row => row.source_id === sourceId);
    const form = element('form', '');
    const scope = element('select', '');
    scope.setAttribute('aria-label', t('披露范围'));
    for (const [value, label] of Object.entries({
      unset: '未设置披露限制', internal: '仅内部', recipient: '仅指定收件人',
    })) {
      const option = element('option', t(label));
      option.value = value;
      option.selected = value === (rule?.scope ?? 'unset');
      scope.append(option);
    }
    const excerpt = element('textarea', '');
    excerpt.value = rule?.excerpt ?? sourceText;
    excerpt.maxLength = 8000;
    excerpt.setAttribute('aria-label', t('受限原文片段'));
    const recipient = element('input', '');
    recipient.type = 'email';
    recipient.value = rule?.recipient ?? '';
    recipient.setAttribute('aria-label', t('允许披露的收件人'));
    const update = () => {
      excerpt.hidden = scope.value === 'unset';
      excerpt.required = !excerpt.hidden;
      recipient.hidden = scope.value !== 'recipient';
      recipient.required = !recipient.hidden;
    };
    scope.addEventListener('change', update);
    update();
    const save = action(t('保存披露范围'), () => {
      if (form.reportValidity()) return request('opportunity-source-disclosure', {
        id: item.id, source_id: sourceId, scope: scope.value, excerpt: excerpt.value, recipient: recipient.value,
      });
    });
    form.onsubmit = event => { event.preventDefault(); save.click(); };
    form.append(scope, excerpt, recipient, save);
    return form;
  }

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
    block.append(form, disclosureControls(item, 'E1', item.evidence));
    return block;
  }

  // refs allow other blocks on the card (next actions of the current answer) to access the nodes of the
  // source area and the draft text.
  function sourceBlock(item, refs) {
    const block = element('details', '');
    const sources = item.sources ?? [];
    block.append(element('summary', t('来源') + ' · ' + (1 + sources.length)));
    // sourceById allows the "View Evidence" entry in the review form to directly open the source originals
    // referenced by the problem statement.
    const sourceById = new Map();
    const remember = (sourceId, node) => { sourceById.set(sourceId, node); return node; };
    block.append(remember('E1', viewableDetails(item, 'E1',
      details(t(sourceKindLabels.evidence) + ' · ' + item.source, item.evidence))));
    for (const row of sources) {
      const id = 'S' + row.id;
      const source = details(t(sourceKindLabels[row.kind] ?? row.kind) +
        (row.date ? ' · ' + row.date : '') + ' · ' + row.name, row.text);
      source.append(disclosureControls(item, id, row.text));
      block.append(remember(id, viewableDetails(item, id, source)));
    }
    // Source type labels are entered by the user; evidence status is determined solely by citations that
    // actually support the claim, regardless of the number of sources.
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
    // Supported claims are labeled according to the source identity of the supporting citations: only when
    // supported by customer source citations is it considered "customer source supported".
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
      // Only expanded items displaying source originals are counted as "expanded sources"; citation
      // excerpts are not.
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
      // Each item in the review form has its own rewrite/delete/guarantee entry (claimReviewSection); do
      // not duplicate buttons.
      if (embedActions && item.draft_id && claim.text && (item.body ?? '').includes(claim.text)) {
        article.append(action(t('采用改写并重新核查'), async () => {
          await request('opportunity-draft', { id: item.id, recipient: item.recipient,
            body: (item.body ?? '').replaceAll(claim.text, claim.rewrite) });
          await request('opportunity-claims', { id: item.id, target: 'draft', language: language() });
        }));
      }
    }
    for (const reason of new Set((claim.failedChecks ?? []).map(check => check.reason))) {
      // Citation context issues carry structured detail (truncated clause + reason); display the original
      // text and reason alongside the tag.
      const check = (claim.failedChecks ?? []).find(entry => entry.reason === reason);
      article.append(element('small', t(checkReasonLabels[reason] ?? reason) +
        (check?.detail ? ' · ' + check.detail : '')));
    }
    return article;
  }

  // Pending items: items that must be resolved after verification and before sending --
  // 1. Square bracket placeholders remaining in the draft body ([To be confirmed: ...],
  // draftChecks.placeholders);
  // 2. High-risk sentences not covered by any extracted claims (a sentence contains two commitments, but
  // the model only extracted one, draftChecks.unextracted);
  // 3. Parsing warnings (such as duplicate claim IDs, warnings).
  // Visually, all three are listed as pending items; however, the 'current status' is determined only by
  // the first two categories that will be intercepted by the window 1 threshold
  // (duplicate claims retain the first verification, do not affect the determination of that claim, and do
  // not block sending), consistent with /api/opportunity-send.
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

  // Send archive (send-archive window): an immutable snapshot of a (simulated) send -- the draft at that
  // time,
  // source full text, itemized claim determinations and citations, view logs, verification model/prompt
  // versions, approval basis, and approval time
  // are all embedded in the archive; no matter how the source changes after sending, the archive can still
  // restore 'what was approved based on what at that time'.
  // Automatic writing at the moment of sending is integrated by window 1 within /api/opportunity-send
  // (sharing the same builder);
  // this provides a manual freeze entry (opportunity-archive) and an export link
  // (/api/opportunity-archive/:id).
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
  // Verification configuration row: displays the actual configuration recorded at the time of the
  // verification log.
  // Old records missing the model field -> the entire row displays 'Unrecorded' (do not use the current
  // configuration at render time to rewrite history);
  // Record has effort=null -> 'Endpoint default' tier (the verification path never sends reasoning_effort
  // per request).
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
    // When archive bytes are modified to illegal JSON, the state comes with a minimal placeholder
    // (archiveId + integrity): the time displays 'Unrecorded'.
    entry.append(element('summary', (archive.sentAt ? new Date(archive.sentAt).toLocaleString(language()) : t('未记录')) +
      ' · ' + basis + (archive.sent ? ' · ' + t('已发送') : '')));
    entry.append(element('p',
      (approval.recipient ? t('收件人') + ' · ' + approval.recipient + ' · ' : '') + t('批准依据') + ' · ' + basis));
    if (approval.body) entry.append(details(t('草稿正文'), approval.body));
    for (const disclosure of approval.disclosure ?? []) {
      entry.append(element('small', t('披露范围') + ' · ' + disclosure.sourceName + ' · ' +
        disclosure.allowedRecipient + ' · ' + disclosure.excerpt));
    }
    // The verification configuration fetches the verification block embedded in the archive (actual values
    // recorded at the time of verification, old archives are not backfilled).
    entry.append(element('small', checkConfigText(archive.verification ?? {})));
    // Integrity: comparison result between the archived digest and recalculated storage bytes (provided
    // with the server-side state);
    // Mismatch highlight: archive content is inconsistent with approval records.
    const integrity = archive.integrity ?? null;
    if (integrity) {
      entry.append(element('small',
        t('完整性') + ' · ' + (integrity.status === 'verified' ? t('校验通过')
          : integrity.status === 'mismatch' ? t('档案内容与批准记录不一致')
          : t('无完整性记录')),
        integrity.status === 'mismatch' ? 'attention' : undefined));
    }
    // Three tiers of sources (all read the archive-embedded snapshot, unrelated to active sources):
    // 1. Sources provided to the model = verification input complete set (including full text);
    // 2. Answer-referenced sources = sources where analysis citations originate (E1) + sources explicitly
    // pointed out by the structured answer;
    // 3. Verification determination supporting sources = sources where valid citations with
    // stance=supports reside for each claim.
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
    // Pending items pinned to the top: displayed before expiration/error messages to ensure at a glance
    // that 'there is still work to be done'.
    const pending = pendingChecksBlock(review);
    if (pending) block.append(pending);
    if (item.claimsStale) block.append(element('p', t('核查已过期：来源或草稿已变更，请重新核查。'), 'attention'));
    if (review.error) block.append(element('p', t('模型请求失败') + ' · ' + review.error, 'attention'));
    // Actual verification scope: lists the claims actually verified this time; when empty, explicitly
    // prompts that the scope is empty to avoid being mistaken for 'verification passed'.
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

  // -- Per-claim manual review --
  // Claims flagged during the current draft verification (not supported by customer sources).
  // Returns empty when verification does not exist, fails, has expired, or the actual verification scope
  // is empty -- at this point, the overall manual review path is retained.
  const coverageCategoryLabels = {
    fact: '已完成事实', commitment: '对外承诺', date: '日期承诺（含委婉表述）',
    conditional: '附带条件的批准或交付', figure: '数字与业绩',
  };
  function normalizeCoverage(review) {
    if (!review) return null;
    if (review.coverage) {
      return {
        claims: review.coverage.claims ?? [],
        missed: review.coverage.missed ?? [],
        placeholders: review.coverage.placeholders ?? [],
      };
    }
    const checks = review.draftChecks;
    if (!checks) return null;
    return {
      claims: (review.claims ?? []).map(claim => String(claim.text ?? '').trim()).filter(Boolean),
      missed: (checks.unextracted ?? []).map(text => ({ text: String(text), sentence: '', categories: [], covered: [] })),
      placeholders: checks.placeholders ?? [],
    };
  }
  // Locate original text: select the segment in the draft body that did not enter verification (real
  // browser DOM uses setSelectionRange).
  function focusDraftFragment(refs, item, fragment) {
    const body = refs.draftBody;
    if (!body) return;
    if (refs.editorDetails) refs.editorDetails.open = true;
    body.focus?.();
    const at = String(item.body ?? '').indexOf(fragment);
    if (at !== -1 && typeof body.setSelectionRange === 'function') body.setSelectionRange(at, at + String(fragment).length);
  }
  function coverageBlock(item, refs) {
    const review = item.claims;
    if (!review || review.target !== 'draft') return null;
    const coverage = normalizeCoverage(review);
    if (!coverage) return null;
    const missed = coverage.missed ?? [];
    const placeholders = coverage.placeholders ?? [];
    const block = element('section', '', 'coverage-scan');
    block.setAttribute('data-missed', String(missed.length));
    const total = missed.length + placeholders.length;
    block.append(element('strong', t('覆盖扫描') + ' · ' +
      (total ? t('发现未进入核查的原文') + ' · ' + total : t('未发现漏抽'))));
    // Current verification scope: original text of claims actually extracted by the model (the part
    // entering verification); explicitly prompt when empty.
    block.append(element('small', t('本次核查范围') + ' · ' +
      ((coverage.claims ?? []).length ? (coverage.claims).join('；') : t('未提取到声明')), 'muted'));
    for (const entry of missed) {
      const article = element('article', '', 'entry');
      article.append(element('small', t('未进入本次核查的原文') + ' · ' + entry.text, 'attention'));
      if (entry.sentence) article.append(element('small', t('所在原句') + ' · ' + entry.sentence));
      if (entry.categories?.length) article.append(element('small',
        t('命中形式') + ' · ' + entry.categories.map(code => t(coverageCategoryLabels[code] ?? code)).join('、')));
      if (entry.covered?.length) article.append(element('small',
        t('同句已核查') + ' · ' + entry.covered.join('、'), 'muted'));
      article.append(action(t('定位原文'), () => focusDraftFragment(refs, item, entry.text)),
        action(t('补证'), () => {
          if (refs.sourceDetails) refs.sourceDetails.open = true;
          refs.sourceText?.focus?.();
        }));
      block.append(article);
    }
    for (const placeholder of placeholders) {
      block.append(element('small', t('占位符未处理') + ' · ' + placeholder, 'attention'));
    }
    if (missed.length) block.append(element('small',
      t('可直接在草稿中改写或删去未进入核查的片段，保存后重新核查；或先补入能支持该说法的来源再重新核查。'), 'muted'));
    return block;
  }

  function flaggedClaims(item) {
    const review = item.claims;
    if (!review || review.target !== 'draft' || review.error || item.claimsStale) return [];
    if (!(review.claims ?? []).length) return [];
    return (review.claims ?? []).filter(claim => claim.status !== 'supported');
  }
  // Whether a claim already has per-claim guarantees (server-side state().claimResolutions has been
  // filtered by current draft + source version).
  const isGuaranteed = (item, claim) => (item.claimResolutions ?? []).some(row =>
    row.claimId === claim.id && row.claimText === claim.text);
  // A local mirror consistent with the sending threshold: approvable = manual review binding the current
  // draft and sources,
  // or draft verification is fresh, scope is non-empty, and every flagged claim has a per-claim guarantee
  // (or is fully supported).
  function previousFlaggedClaims(item) {
    const rows = item.previousUnresolvedClaims ?? item.previousClaims ?? item.carryoverClaims ?? [];
    const list = Array.isArray(rows) ? rows : [];
    if (list.some(row => row?.match)) {
      return list.filter(row => ['verbatim', 'same_fact', 'ambiguous']
        .includes(row?.effectiveVerdict ?? row?.match?.verdict));
    }
    return list.filter(row => {
      const text = String(row?.claimText ?? row?.text ?? '').trim();
      return text && String(item.body ?? '').includes(text);
    });
  }
  function claimForFlag(row) {
    const stored = row?.claim ?? {};
    return { id: row?.claimId ?? row?.id ?? stored.id ?? '', dimension: row?.dimension ?? stored.dimension ?? '',
      text: String(row?.claimText ?? row?.text ?? stored.text ?? ''),
      status: row?.status ?? stored.status ?? 'unresolved', items: stored.items ?? [],
      missing: stored.missing ?? '', rewrite: stored.rewrite ?? '', conflict: stored.conflict ?? null,
      withdrawn: stored.withdrawn ?? false, failedChecks: stored.failedChecks ?? [] };
  }
  const previousFlags = previousFlaggedClaims;
  const previousGuarantee = (item, claim) => (item.claimResolutions ?? []).find(row => row.claimText === claim.text);
  const unhandledPrevious = item => previousFlags(item).filter(flag =>
    flag.match ? flag.pending : !previousGuarantee(item, claimForFlag(flag)));

  function sendable(item) {
    if (item.disclosureConflicts?.length) return false;
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
      return Boolean(item.review && !item.reviewStale) || previousFlags(item).some(flag => flag.handledBy === 'guarantee');
    }
    return review.claims.every(claim => claim.status === 'supported' || isGuaranteed(item, claim));
  }
  // A flagged claim item requiring line-by-line review: original sentence, verdict, and basis (reusing the
  // claimSection presentation). The "View Evidence" entry is placed next to the issue claim (opening the
  // corresponding source text counts as an "opened" record), along with founder actions: rewrite/delete
  // (both save a new draft and trigger re-verification), or keep this claim and record a vouching
  // justification.
  function claimReviewSection(claim, item, refs, previous = null) {
    const article = claimSection(claim, item, false);
    const citedEntries = claim.conflict
      ? [...(claim.conflict.supports ?? []), ...(claim.conflict.opposes ?? [])]
      : (claim.items ?? []).filter(entry => entry.valid);
    const openEvidence = action(t('查看证据'), () => {
      if (refs.sourceDetails) refs.sourceDetails.open = true;
      const sourceIds = [...new Set(citedEntries.filter(entry => entry.source).map(entry => entry.source.id))];
      // When a claim lacks citations, fall back to the initial source text (E1) for verification.
      for (const sourceId of sourceIds.length ? sourceIds : ['E1']) {
        const node = refs.sourceById?.get(sourceId);
        if (node && !node.open) node.open = true; // The toggle event records "opened".
      }
    });
    const resolution = previous ? previousGuarantee(item, claim)
      : (item.claimResolutions ?? []).find(row => row.claimId === claim.id && row.claimText === claim.text);
    if (resolution) {
      if (resolution.rewriteText) {
        article.append(element('small', t('原句') + ' · ' + claim.text + ' → ' + t('新句') + ' · ' + resolution.rewriteText));
      }
      article.append(openEvidence,
        element('p', t('已记录担保') + ' · ' + t('我已核实并愿意承担这条说法') + ' · ' + resolution.reason +
          ' · ' + new Date(resolution.at).toLocaleString(language()), 'muted'));
      return article;
    }
    if (previous) {
      const inBody = (item.body ?? '').includes(claim.text);
      const verdict = previous.effectiveVerdict ?? previous.match?.verdict;
      const review = previous.rewriteReview ?? null;
      if (review) {
        article.append(element('p', t('改写核对已记录') + ' · ' +
          t(review.verdict === 'deleted' ? '已删除旧声明' : review.verdict === 'same_fact' ? '同一事实' : '不同事实') + ' · ' + review.note +
          ' · ' + new Date(review.at).toLocaleString(language()), 'muted'));
      }
      if (!inBody && !review && ['ambiguous', 'different_fact', 'absent'].includes(verdict)) {
        // When it cannot be determined whether a rewritten statement remains the same fact: display both
        // the original sentence and candidate new sentence for the founder to review.
        article.append(element('p', t('无法确定改写后是否仍是同一事实，请核对原句与新句后选择：'), 'attention'));
        for (const candidate of (previous.match?.candidates ?? []).slice(0, 5)) {
          article.append(element('small', t('原句') + ' · ' + claim.text + ' → ' + t('新句') + ' · ' + candidate.sentence));
        }
        const note = element('input', '');
        note.maxLength = 2000;
        note.placeholder = t('填写核对说明');
        note.setAttribute('aria-label', note.placeholder);
        const rows = element('div', '');
        rows.append(note,
          ...(verdict === 'ambiguous' ? [action(t('是同一事实（保留标记）'), async () => {
            if (note.value.trim()) await request('opportunity-claim-rewrite-review', {
              id: item.id, draft_id: item.draft_id, claim_id: previous.claimId ?? claim.id,
              claim_text: claim.text, ...(item.claimEvidenceHash ? { evidence_hash: item.claimEvidenceHash } : {}), verdict: 'same_fact', note: note.value,
            });
          })] : []),
          action(t(verdict === 'absent' ? '已删除旧声明' : '不是同一事实（解除标记）'), async () => {
            if (note.value.trim()) await request('opportunity-claim-rewrite-review', {
              id: item.id, draft_id: item.draft_id, claim_id: previous.claimId ?? claim.id,
              claim_text: claim.text, ...(item.claimEvidenceHash ? { evidence_hash: item.claimEvidenceHash } : {}), verdict: verdict === 'absent' ? 'deleted' : 'different_fact', note: note.value,
            });
          }));
        article.append(rows);
        return article;
      }
      if (!inBody && verdict === 'same_fact') {
        // If a synonymous rewrite still represents the same fact, the original risk must still be
        // addressed: re-verify the rewritten statement, or vouch for the old original sentence line by
        // line.
        article.append(element('p', t('上一版声明被近义改写，仍是同一事实，原风险仍需处理。请重新核查改写后的说法，或针对当前草稿与来源逐条担保。'), 'attention'));
        for (const candidate of (previous.match?.candidates ?? []).slice(0, 5)) {
          if (candidate.relation !== 'same_fact' && !review) continue;
          article.append(element('small', t('原句') + ' · ' + claim.text + ' → ' + t('新句') + ' · ' + candidate.sentence));
        }
        const reason = element('input', '');
        reason.maxLength = 2000;
        reason.placeholder = t('记录担保理由');
        reason.setAttribute('aria-label', reason.placeholder);
        const guaranteeRow = element('div', '');
        guaranteeRow.append(reason, action(t('我已核实并愿意承担这条说法'), async () => {
          if (reason.value.trim()) await request('opportunity-claim-resolution', {
            id: item.id, draft_id: item.draft_id, claim_id: previous.claimId ?? claim.id,
            claim_text: claim.text, reason: reason.value, ...(item.claimEvidenceHash ? { evidence_hash: item.claimEvidenceHash } : {}),
          });
        }));
        article.append(guaranteeRow);
        return article;
      }
    }
    const reverify = async nextBody => {
      // Rewrite/Delete: save a new draft version (body text changes generate a new draft ID), then
      // re-verify.
      await request('opportunity-draft', { id: item.id, recipient: item.recipient, body: nextBody });
      await request('opportunity-claims', { id: item.id, target: 'draft', language: language() });
    };
    const rows = element('div', '');
    // Rewrite: replace the original sentence with the new statement (defaulting to the suggested rewrite).
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
    // Delete: remove the original sentence from the body text.
    const deleteRow = element('div', '');
    deleteRow.append(action(t('删除此句并重新核查'), async () => {
      const next = (item.body ?? '').replaceAll(claim.text, '');
      if (next.trim()) await reverify(next);
    }));
    // Vouch: keep this claim and explicitly record "I have verified this and am willing to take
    // responsibility for this statement" + justification.
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

  // Current answer: instructions on what to say and how to proceed when evidence is insufficient. Wording
  // and boundaries are deterministically determined by the server's evidenceAnswer. This component only
  // handles rendering and connects the "next step" to existing card entries—view source / provide
  // materials / adopt clarification question (corresponding to the view / source / draft three options of
  // the decision card), providing a retry option on failure.
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
    // Pending verification items: extracted claims consisting solely of founder statements or unconfirmed
    // sources (evidenceAnswer.pending). Wording reuses the claim status badge, consistent with the claim
    // verification section; conclusions are limited to the supported portion and are not omitted here.
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

  // Current status: the dispatch threshold status of the saved draft from the perspective of founder
  // approval. Requires action / verification expired / pending approval; pre-status is shown when there is
  // no draft or no verification record for the draft. Manual review conclusions are bound to the current
  // draft and current source version: when verification expires (draft or source changed), pending
  // approval is no longer displayed.
  function approvalStatus(item) {
    if (!item.draft_id) return { label: '尚未保存草稿', tone: 'muted' };
    if (item.disclosureConflicts?.length) return { label: '当前收件人无权收到草稿中的受限内容。', tone: 'attention' };
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
    // Line-by-line manual review: considered pending approval when all flagged claims have line-by-line
    // vouching (consistent with the dispatch threshold).
    const unhandled = claims.filter(claim => claim.status !== 'supported' && !isGuaranteed(item, claim));
    if (unhandled.length) return { label: t('待处理 {n} 条').replace('{n}', String(unhandled.length)), tone: 'attention' };
    const pending = pendingChecks(review).length;
    if (pending) return { label: '仍有待处理项', tone: 'attention', count: pending };
    return { label: '待批准', tone: 'muted' };
  }

  // Problematic claims: displayed next to the draft and approval buttons, providing the original sentence,
  // basis (citation or gap), suggested rewrite, and adoption action.
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
    // Initial source origin + identity (customer original text / founder statement / unconfirmed):
    // changing the identity will automatically invalidate the old verification and re-run it.
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
    // Manual review conclusions are bound to the current draft version and current source version: when
    // the draft is updated to a new version or the source changes, old verifications cannot unlock the
    // current draft's dispatch gate, and the form reappears to record conclusions for the current draft
    // and source.
    const reviewCurrent = Boolean(item.review) && item.review_draft === item.draft_id && !item.reviewStale;
    const flagged = flaggedClaims(item);
    if (previousFlags(item).length || flagged.length || (!item.review && (result ? result.status !== 'supported' : item.kind === 'lead')) ||
      (item.draft_id && !reviewCurrent)) {
      const reviewForm = element('form', '');
      // The review area displays the current viewing status: which sources are opened / which sources are
      // not yet opened.
      // This records the viewing action, while the conclusion is still written by the founder.
      reviewForm.append(reviewViewLine(item),
        element('small', t('展开来源原文会记录下来，保存复核时随结论写入审计。'), 'muted'));
      const retained = previousFlags(item);
      if (retained.length) {
        const pending = unhandledPrevious(item).length;
        reviewForm.append(element('p', t(pending ? '上一版仍有未处理声明' : '已复核上一版保留声明') +
          ' · ' + (pending || retained.length), pending ? 'attention' : 'muted'));
        for (const flag of retained) reviewForm.append(claimReviewSection(claimForFlag(flag), item, refs, flag));
      }
      // Item-by-item manual review: For currently flagged claims in the draft verification, provide the
      // original sentence, verdict, basis, and processing entry one by one.
      if (flagged.length) {
        reviewForm.append(element('small', t('有问题的声明') + ' · ' + flagged.length +
          ' · ' + t('逐条处理：改写或删除后重新核查，或保留并记录担保理由。'), 'attention'));
        for (const claim of flagged) reviewForm.append(claimReviewSection(claim, item, refs));
      } else if (item.draft_id && item.claims?.target === 'draft') {
        // Model verification failed or no claims extracted: Clearly display the actual verification scope,
        // while retaining the manual review path below.
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
    // Send archive: Immutable snapshot (three-tier sources + approval context + export), independent of
    // active sources.
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
      refs.editorDetails = editor;
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
        if (!item.sent) {
          for (const conflict of item.disclosureConflicts ?? []) {
            editor.append(element('p', t('披露范围') + ' · ' + conflict.sourceName +
              ' · ' + item.recipient + ' · ' + conflict.excerpt, 'attention'));
          }
        }
        if (!item.sent && !item.claimsStale) {
          const coverage = coverageBlock(item, refs);
          if (coverage) editor.append(coverage);
        }
        const status = approvalStatus(item);
        card.append(element('p', t('当前状态') + ' · ' + t(status.label) +
          (status.count ? ' · ' + status.count : ''), status.tone));
      }
      if (item.review) card.append(element('p', t('核实记录') +
        (item.reviewStale ? ' · ' + t('复核已过期') + ' · ' + reviewStaleText(item) : '') + ' · ' + item.review,
        item.reviewStale ? 'attention' : 'muted'), reviewViewLine(item));
      if (item.draft_id) {
        editor.open = true;
        // Pin pending items to the top of the draft area: Prioritized over the saved version body and
        // "flagged claims".
        // Applies only to verification results of the draft; sent opportunities no longer display them.
        const pending = !item.sent && item.claims?.target === 'draft' ? pendingChecksBlock(item.claims) : null;
        if (pending) editor.append(pending);
        editor.append(details(t('待审核的已保存版本') + ' · ' + item.recipient, item.body));
        if (item.sent) {
          editor.append(element('p', t('模拟发送成功')));
        } else {
          const attention = attentionClaims(item);
          if (attention) editor.append(attention);
          // Sending intercepted: Interception reason + latest activity log are displayed directly in the
          // draft area.
          const lastBlock = latestBlocked(audit, item.id);
          if (lastBlock) {
            editor.append(element('p', t('操作被拦截') + ' · ' + t(blockedReasons[lastBlock.reason] ?? lastBlock.reason) + ' · ' + new Date(lastBlock.time).toLocaleString(language()), 'attention'))
          }
          editor.append(action(t(item.claims?.target === 'draft' ? '重新核查' : '核查关键声明'), () => request('opportunity-claims', {
            id: item.id, target: 'draft', draft_id: item.draft_id, language: language(),
          }), false));
          if (item.disclosureConflicts?.length) {
            editor.append(element('p', t('当前收件人无权收到草稿中的受限内容。'), 'attention'));
          } else if (unhandledPrevious(item).length) {
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
            // Item-by-item manual review: Approval is hidden if flagged claims are not fully processed (or
            // verification is incomplete/expired/scope is empty).
            const unhandled = flaggedClaims(item).filter(claim => !isGuaranteed(item, claim));
            if (unhandled.length) {
              editor.append(element('p', t('还有 {n} 条被标记声明待处理。').replace('{n}', String(unhandled.length)) +
                t('逐条改写、删除或记录担保后，再批准发送。'), 'attention'));
            } else if (item.claims?.error) {
              editor.append(element('p', t('模型核查失败') + ' · ' + item.claims.error +
                ' · ' + t('实际核查范围：0 条声明（核查未完成）。请重新核查，或记录人工复核结论，再批准发送。'), 'attention'));
            } else {
              editor.append(element('p', t('请先核查关键声明，或针对当前草稿记录人工复核结论，再批准发送。'), 'attention'));
            }
          } else {
            const guaranteed = [...flaggedClaims(item).filter(claim => isGuaranteed(item, claim)),
              ...previousFlags(item).map(claimForFlag).filter(claim => previousGuarantee(item, claim))];
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
        // Viewing actions are recorded along with the source name, making it easy to see at a glance which
        // original text was expanded at the time.
        summary = t(labels.review_source_viewed) + ' · ' + detail.name + ' · ' + new Date(event.time).toLocaleString(language());
      } else if (event.action === 'human_reviewed' && Array.isArray(detail.viewed)) {
        // When saving the review, opened sources, draft ID, source version, and conclusions have been
        // written to the audit; the summary indicates which sources were opened.
        // Old records prior to feature launch lack the viewed field and are not marked to prevent
        // misinterpretation.
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
