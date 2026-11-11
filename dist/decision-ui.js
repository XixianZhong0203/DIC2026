// Interactive decision card rendered next to a chat answer when the reply
// hits a conflict or an information gap. Follows the Shanghai-RITS pattern:
// a structured payload (review.decision), an interactive card, and the
// choice returned to the conversation through POST /api/decision.
export function createDecisionUI({ t, element, action, request, fetchResult, language, openSources, copyText, fillComposer, jumpToCalendar, jumpToTask }) {
  const kindLabels = { reschedule: '确认改期', preference: '长期偏好冲突', clarify: '证据不足 · 待确认' };
  const recordLabels = { fact: '事实', preference: '偏好', rule: '已确认规则', proposal: '未确认提议', source: '原始资料', task: '日历' };

  function runView(effect, message) {
    const payload = effect?.payload ?? {};
    if (payload.calendar) jumpToCalendar(payload.calendar);
    if (payload.sources) openSources(message.review);
  }

  function previewContent(box, option, message) {
    box.replaceChildren();
    const effect = option.effect ?? {};
    const out = [];
    if (effect.kind === 'task' && option.preview) {
      const p = option.preview;
      out.push(element('small', t(p.conflict ? '该时段与其他事件有重叠' : '该时段无冲突') + ' · ' +
        p.date + ' ' + p.starts.slice(11) + ' → ' + p.ends.slice(11)));
      for (const event of p.events ?? []) {
        out.push(element('p', (event.id === p.excludeId ? t('原事件') : t('日历')) + ' · ' +
          event.title + ' · ' + event.starts.slice(11) + ' → ' + event.ends.slice(11)));
      }
      if (!p.events?.length) out.push(element('p', t('该时段无冲突')));
    } else if (effect.kind === 'memory' && option.preview) {
      if (option.preview.replaces) out.push(element('small', t('确认后将修订记录 #') + option.preview.replaces));
      const impact = option.preview.impact ?? [];
      if (impact.length) {
        out.push(element('small', t('可能受影响的偏好或规则')));
        for (const record of impact) out.push(element('p', '#' + record.id + ' · ' + record.scope + ' · ' + record.body));
      } else {
        out.push(element('p', t('未发现其他相关偏好或规则')));
      }
    } else if (option.preview?.text) {
      out.push(element('p', option.preview.text));
    } else if (effect.kind === 'view' && effect.payload?.sources && message.review) {
      for (const fact of message.review.facts ?? []) {
        out.push(element('p', (fact.id ? '#' + fact.id + ' · ' + fact.source + '\n' : '') + fact.quote));
      }
      for (const record of message.review.cited ?? []) out.push(element('p', '#' + record.id + ' · ' + record.body));
      if (!message.review.facts?.length && !message.review.cited?.length) out.push(element('p', t('暂无可核对的摘录')));
    }
    box.append(...out);
  }

  function classifyPreview(box, option) {
    const payload = option.effect?.payload ?? {};
    return fetchResult('memory-impact', { ...payload, replaces: payload.replaces, classify: true, language: language() })
      .then(result => {
        const labels = { direct: '直接冲突', ambiguous: '范围或指代不清', none: '模型未发现冲突', unreviewed: '待人工核对' };
        for (const record of result.impact ?? []) {
          box.append(element('small', '#' + record.id + ' · ' + t(labels[record.classification] ?? record.classification)));
          if (record.reason) box.append(element('p', record.reason));
          if (record.question) box.append(element('p', record.question));
        }
      });
  }

  function optionBlock(message, option) {
    const decision = message.review.decision;
    const applied = decision.status === 'applied';
    const label = element('label', '', 'decision-option');
    const radio = element('input', '');
    radio.type = 'radio';
    radio.name = 'decision-' + message.id;
    radio.value = option.id;
    radio.disabled = applied;
    if (decision.choice?.option_id === option.id) {
      radio.checked = true;
      label.classList.add('selected');
    }
    const body = element('div', '', 'decision-option-body');
    body.append(element('strong', option.label));
    if (option.consequence) body.append(element('p', t('选择后') + ' ' + option.consequence));
    const box = element('div', '', 'decision-preview');
    box.hidden = true;
    body.append(box);
    const showPreview = () => { previewContent(box, option, message); box.hidden = false; };
    radio.onchange = () => {
      if (!radio.checked) return;
      showPreview();
      const effect = option.effect ?? {};
      if (effect.kind === 'view' && effect.payload?.calendar) jumpToCalendar(effect.payload.calendar);
      // The selection itself is returned to the conversation; the confirm
      // button below performs the actual (confirmed) action.
      request('decision', { message_id: message.id, option_id: option.id });
    };
    const effect = option.effect ?? {};
    if (effect.kind === 'view') body.append(action(t('打开查看'), () => runView(effect, message)));
    if (effect.kind === 'question') {
      const text = effect.payload?.text ?? option.preview?.text ?? '';
      body.append(action(t('填入输入框'), () => fillComposer(text)), action(t('复制'), () => copyText(text)));
    }
    if (effect.kind === 'memory') {
      body.append(action(t('用模型检查冲突'), async () => {
        showPreview();
        await classifyPreview(box, option);
      }));
    }
    label.append(radio, body);
    return { label, showPreview };
  }

  return function renderDecision(parent, message) {
    const decision = message.review?.decision;
    if (!decision) return;
    const applied = decision.status === 'applied';
    const section = element('section', '', 'decision' + (applied ? ' applied' : '') + (decision.status === 'failed' ? ' failed' : ''));
    const head = element('div', '', 'decision-head');
    head.append(element('span', t(kindLabels[decision.kind] ?? '请确认'), 'decision-kind'));
    head.append(element('strong', decision.title));
    const status = applied ? t('已确认')
      : decision.status === 'failed' ? t('确认失败')
      : decision.choice ? t('已选择') : t('待你决定');
    head.append(element('span', status, 'decision-status'));
    section.append(head);
    if (decision.current) section.append(element('p', t('当前已确认') + ' · ' + decision.current));
    if (decision.proposal) section.append(element('p', t('新要求') + ' · ' + decision.proposal));
    if (decision.reason) section.append(element('p', t('为什么需要你决定') + ' · ' + decision.reason));
    if (decision.records?.length) {
      const row = element('p', t('相关记录') + ' · ', 'decision-records');
      for (const record of decision.records) {
        row.append(element('span', '#' + record.id + ' · ' + t(recordLabels[record.kind] ?? record.kind) +
          (record.scope ? ' · ' + t(record.scope === '*' ? '全局' : record.scope) : '') +
          (record.source ? ' · ' + record.source : ''), 'decision-record'));
      }
      section.append(row);
    }
    const optionsBox = element('div', '', 'decision-options');
    for (const option of decision.options ?? []) {
      const { label, showPreview } = optionBlock(message, option);
      optionsBox.append(label);
      if (decision.choice?.option_id === option.id) showPreview();
    }
    section.append(optionsBox);
    const actions = element('div', '', 'decision-actions');
    if (!applied) {
      const confirm = action(t('确认此选项'), () => {
        const checked = section.querySelector('input[name="decision-' + message.id + '"]:checked');
        if (!checked) return;
        return request('decision', { message_id: message.id, option_id: checked.value, confirm: true });
      }, false);
      confirm.disabled = !decision.choice;
      actions.append(confirm);
    }
    if (decision.choice?.receipt) {
      actions.append(element('p', (applied ? '✓ ' : '× ') + decision.choice.receipt, applied ? 'decision-ok' : 'decision-err'));
    }
    // 已确认的改期：从回执直接找到对应待办（原时间见卡片「当前已确认」与回执）。
    if (applied && jumpToTask) {
      const chosen = (decision.options ?? []).find(item => item.id === decision.choice?.option_id);
      if (chosen?.effect?.kind === 'task' && chosen.effect.payload?.id != null) {
        actions.append(action(t('查看待办'), () => jumpToTask(chosen.effect.payload.id)));
      }
    }
    section.append(actions);
    parent.append(section);
  };
}
