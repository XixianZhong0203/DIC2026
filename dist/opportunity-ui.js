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
    lead: '潜在客户', idea: '改进机会', research: '资料分析', draft: '起草联系邮件',
    send: '对外发送', transfer: '转账', auto: '可委托 AI', approval: '逐次审批',
    human: '本人处理', captured: '保存线索', assessed: '分析完成', drafted: '草稿已保存',
    simulated_send: '模拟发送成功', blocked: '操作被拦截', policy: '授权已更新',
  };

  function details(title, content) {
    const wrapper = element('details', '');
    wrapper.append(element('summary', title), element('p', content));
    return wrapper;
  }

  function opportunityCard(item) {
    const card = element('article', '', 'entry');
    card.append(element('small', t(labels[item.kind])), element('h3', item.title));
    card.append(details(t('出处') + ' · ' + item.source, item.evidence));
    if (item.analysis) {
      const result = JSON.parse(item.analysis);
      card.append(element('p', t(result.status === 'supported' ? '模型判断有依据，请核对' : '证据不足或仍待确认'), 'attention'));
      if (result.quote) card.append(details(t('核对原文片段'), result.quote));
      if (result.reason) card.append(details(t('判断依据'), result.reason));
      if (result.unknown) card.append(details(t('仍需核实'), result.unknown));
      if (result.suggestedReply) card.append(details(t('模型建议稿'), result.suggestedReply));
      card.append(details(t('模型原始输出'), result.raw));
    }
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
      if (item.draft_id) {
        editor.open = true;
        editor.append(details(t('待审核的已保存版本') + ' · ' + item.recipient, item.body));
        if (item.sent) editor.append(element('p', t('模拟发送成功')));
        else editor.append(action(t('批准已保存版本并模拟发送'), () =>
          request('opportunity-send', { id: item.id, draft_id: item.draft_id }), false));
      }
      card.append(editor);
    }
    return card;
  }

  return function render(state) {
    get('opportunity-list').replaceChildren(...(state.opportunities ?? []).map(opportunityCard));
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
    get('opportunity-audit').replaceChildren(...(state.audit ?? []).map(event =>
      details(t(labels[event.action] ?? event.action) + ' · ' + new Date(event.time).toLocaleString(language()),
        JSON.stringify(JSON.parse(event.detail), null, 2))));
    const report = state.benchmark;
    get('model-results').replaceChildren();
    if (report) {
      get('model-results').append(element('p', report.model + ' · ' + report.at));
      for (const row of report.results) {
        get('model-results').append(details(row.id + ' · ' + t(row.guarded ? 'Daymark 提示' : '基础模型') +
          ' · ' + t(row.statusMatched ? '符合预期' : '需要复核'), JSON.stringify(row, null, 2)));
      }
      const link = element('a', t('下载模型评估凭据'));
      link.href = '/api/opportunity-report';
      link.download = 'daymark-model-evaluation.json';
      get('model-results').append(link);
    }
  };
}
