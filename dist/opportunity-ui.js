export function createOpportunityUI({ get, t, element, action, request, formAction, language, createTask }) {
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
  };

  const sourceKindLabels = { evidence: '证据原文', customer: '客户记录', founder: '创始人提供' };
  // 人工复核过期的原因（由服务端 reviewStale 给出）：明确是草稿变了还是来源变了。
  const reviewStaleLabels = { draft_changed: '草稿变了', source_changed: '来源变了', review_unbound: '复核缺少来源版本' };
  const reviewStaleText = item => (item.reviewStale ?? []).map(code => t(reviewStaleLabels[code] ?? code)).join('、');
  const claimStatusLabels = { supported: '支持', refuted: '反驳', unknown: '证据不足', conflict: '来源冲突', incomplete: '未完成核查' };
  const stanceLabels = { supports: '支持', refutes: '反驳', withdraws: '撤回' };
  const checkReasonLabels = {
    unknown_source: '引用了不存在的来源', quote_not_found: '引文未在来源原文中逐字找到',
    field_conflict: '模型输出字段不一致', claim_not_in_draft: '声明未在草稿正文中逐字出现',
    request_failed: '模型请求失败',
  };
  const blockedReasons = { no_evidence_review: '未分析也未复核', unresolved_evidence: '证据未核实且未复核', draft_changed: '草稿版本已过期',
    claims_not_verified: '草稿声明尚未核查', claims_stale: '草稿声明核查已过期', claims_incomplete: '声明核查未完成', claims_unresolved: '声明核查未通过', claims_no_claims: '未提取到声明' };
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

  function sourceBlock(item) {
    const block = element('details', '');
    const sources = item.sources ?? [];
    block.append(element('summary', t('来源') + ' · ' + (1 + sources.length)));
    block.append(details(t(sourceKindLabels.evidence) + ' · ' + item.source, item.evidence));
    for (const row of sources) {
      block.append(details(t(sourceKindLabels[row.kind] ?? row.kind) + (row.date ? ' · ' + row.date : '') + ' · ' + row.name, row.text));
    }
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
    return block;
  }

  function claimSection(claim, item) {
    const article = element('article', '', 'entry');
    article.append(element('strong', (claim.dimension ? t(claim.dimension) + ' · ' : '') + (claim.text || t('模型未返回声明原文'))));
    article.append(element('small', t(claimStatusLabels[claim.status] ?? claim.status) +
      (claim.withdrawn ? ' · ' + t('该承诺已被撤回') : '')));
    const cited = (entry, original) => {
      const summary = t(stanceLabels[entry.stance] ?? entry.stance) +
        ' · ' + entry.source.source + (entry.source.date ? ' · ' + entry.source.date : '');
      if (!original) return details(summary, entry.quote + (entry.note ? '（' + entry.note + '）' : ''));
      const block = element('details', '');
      block.append(element('summary', summary),
        element('p', entry.quote + (entry.note ? '（' + entry.note + '）' : '')));
      if (entry.source.text) block.append(element('p', t('来源原文') + ' · ' + entry.source.text));
      return block;
    };
    if (claim.conflict) {
      for (const entry of [...(claim.conflict.supports ?? []), ...(claim.conflict.opposes ?? [])]) article.append(cited(entry, true));
    } else {
      for (const entry of claim.items ?? []) if (entry.valid) article.append(cited(entry));
    }
    if (claim.missing) article.append(element('p', t('缺少信息') + ' · ' + claim.missing, 'attention'));
    if (claim.rewrite) {
      article.append(element('p', t('建议改写') + ' · ' + claim.rewrite));
      if (item.draft_id && claim.text && (item.body ?? '').includes(claim.text)) {
        article.append(action(t('采用改写并重新核查'), async () => {
          await request('opportunity-draft', { id: item.id, recipient: item.recipient,
            body: (item.body ?? '').replaceAll(claim.text, claim.rewrite) });
          await request('opportunity-claims', { id: item.id, target: 'draft', language: language() });
        }));
      }
    }
    for (const reason of new Set((claim.failedChecks ?? []).map(check => check.reason))) {
      article.append(element('small', t(checkReasonLabels[reason] ?? reason)));
    }
    return article;
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
    if (item.claimsStale) block.append(element('p', t('核查已过期：来源或草稿已变更，请重新核查。'), 'attention'));
    if (review.error) block.append(element('p', t('模型请求失败') + ' · ' + review.error, 'attention'));
    // 实际核查范围：列出本次真正核查过的声明；为空时明确提示范围是空的，避免被当成"核查通过"。
    const scope = (review.claims ?? []).map(claim =>
      (claim.dimension ? t(claim.dimension) + '：' : '') + (claim.text || t('模型未返回声明原文')));
    if (!review.error) block.append(element('small', t('本次核查范围') + ' · ' +
      (scope.length ? scope.join('；') : t('未提取到声明'))));
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

  // 当前状态：从创始人批准视角看已保存草稿的发送门槛状态。
  // 需要处理 / 核查过期 / 待批准；尚无草稿或尚无针对草稿的核查记录时给出前置状态。
  // 人工复核结论绑定当前草稿与当前来源版本：复核过期（草稿变了或来源变了）时不再显示待批准。
  function approvalStatus(item) {
    if (!item.draft_id) return { label: '尚未保存草稿', tone: 'muted' };
    if (item.review) {
      if (!item.reviewStale) return { label: '待批准', tone: 'muted' };
      return { label: t('复核已过期') + ' · ' + reviewStaleText(item), tone: 'attention' };
    }
    const review = item.claims;
    if (!review || review.target !== 'draft') return { label: '尚未核查', tone: 'attention' };
    if (item.claimsStale) return { label: '核查过期', tone: 'attention' };
    const claims = review.claims ?? [];
    if (review.error || !claims.length || claims.some(claim => claim.status !== 'supported')) {
      return { label: '需要处理', tone: 'attention' };
    }
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
    card.append(element('small', t(labels[item.kind])), element('h3', item.title));
    card.append(details(t('出处') + ' · ' + item.source, item.evidence));
    card.append(sourceBlock(item));
    const result = item.analysis && JSON.parse(item.analysis);
    if (result) {
      card.append(element('p', t(result.status === 'supported' ? '模型判断有依据，请核对' : '证据不足或仍待确认'), 'attention'));
      if (result.quote) card.append(details(t('核对原文片段'), result.quote));
      if (result.reason) card.append(details(t('判断依据'), result.reason));
      if (result.conflict) card.append(element('p', result.conflict, 'attention'));
      if (result.clarification) card.append(element('p', result.clarification));
      if (result.unknown) card.append(details(t('仍需核实'), result.unknown));
      if (result.suggestedReply) card.append(details(t('模型建议稿'), result.suggestedReply));
      card.append(details(t('模型原始输出'), result.raw));
      if (item.review) card.append(details(t('人工核实'), item.review));
    }
    // 人工复核结论绑定到当前草稿版本与当前来源版本：草稿换新版本或来源变化后，
    // 旧复核不能解锁当前草稿的发送门禁，表单重新出现，供针对当前草稿与来源记录结论。
    const reviewCurrent = Boolean(item.review) && item.review_draft === item.draft_id && !item.reviewStale;
    if ((!item.review && (result ? result.status !== 'supported' : item.kind === 'lead')) ||
      (item.draft_id && !reviewCurrent)) {
      const reviewForm = element('form', '');
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
        card.append(element('p', t('当前状态') + ' · ' + t(status.label), status.tone));
      }
      if (item.review) card.append(element('p', t('核实记录') +
        (item.reviewStale ? ' · ' + t('复核已过期') + ' · ' + reviewStaleText(item) : '') + ' · ' + item.review,
        item.reviewStale ? 'attention' : 'muted'));
      if (item.draft_id) {
        editor.open = true;
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
          if (item.reviewStale) {
            editor.append(element('p', t('人工核实已过期') + ' · ' + reviewStaleText(item) +
              ' · ' + t('请重新核查，或针对当前草稿记录人工复核结论。'), 'attention'));
          } else if (!item.review && !result) {
            editor.append(element('p', t('还没有分析，也没有人工复核。请先用模型分析，或先记录人工核实结果，再批准发送。'), 'attention'));
          } else if (!item.review && result.status !== 'supported') {
            editor.append(element('p', t('请先记录如何处理不确定性，再批准发送。'), 'attention'));
          } else {
            editor.append(action(t('批准已保存版本并模拟发送'), () =>
              request('opportunity-send', { id: item.id, draft_id: item.draft_id }), false));
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
      return details(t(labels[event.action] ?? event.action) + reason + ' · ' + new Date(event.time).toLocaleString(language()),
        JSON.stringify(detail, null, 2));
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
