import { createOpportunityUI } from '/opportunity-ui.js';
import { demoReport } from '/policy.mjs';
import { translate } from '/i18n.js';

let language = localStorage.getItem('daymark-language') === 'zh-CN' ? 'zh-CN' : 'en';
const t = phrase => translate(language, phrase);
const staticCopy = [...document.querySelectorAll('[data-i18n], [data-placeholder]')].map(node => ({
  node, placeholder: node.hasAttribute('data-placeholder'), original: node.placeholder ?? node.textContent,
}));
let evaluationInput;
let notice = '';

function showNotice(message) {
  notice = message;
  get('notice').textContent = t(message);
}

const get = id => document.getElementById(id);
let current;
let editing = null;
let pendingMemory = null;
let oneTurnNote = false;

function resetMemoryReview() {
  pendingMemory = null;
  get('memory-review').hidden = true;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(label, callback, secondary = true) {
  const button = element('button', label, secondary ? 'secondary' : '');
  button.type = 'button';
  button.onclick = () => withButton(button, callback);
  return button;
}

async function withButton(button, callback) {
  button.disabled = true;
  showNotice('');
  try { await callback(); }
  catch (error) { showNotice(error.message); }
  finally { button.disabled = false; }
}

async function fetchResult(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => { throw new Error('无法连接到 Daymark，请确认本地服务已启动。'); });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

async function request(path, body) {
  const data = await fetchResult(path, body);
  current = { ...data, tasks: data.tasks ?? [] };
  render();
}

let visibleEvidence = null;
get('close-sources').onclick = () => get('source-panel').close();
get('source-panel').addEventListener('close', () => { visibleEvidence = null; });

function openSources(review) {
  visibleEvidence = review;
  const body = get('source-content');
  body.replaceChildren();
  for (const [label, items] of [['来源原文', review.facts], ['基于资料的推断', review.inferences], ['仍待核实', review.unknowns]]) {
    if (!items?.length) continue;
    body.append(element('h3', t(label)));
    for (const item of items) {
      const row = element('article', '', 'entry');
      if (typeof item === 'string') row.append(element('p', item));
      else row.append(element('small', '#' + item.id + ' · ' + item.source), element('p', item.quote));
      body.append(row);
    }
  }
  if (review.cited?.length) body.append(element('h3', t('引用记录')));
  for (const record of review.cited ?? []) {
    const source = element('details', '', 'entry');
    source.append(element('summary', '#' + record.id + ' · ' + t(record.source)), element('p', t(record.body)));
    body.append(source);
  }
  if (review.trace) {
    const trace = element('details', '', 'entry');
    trace.append(element('summary', t('处理记录')));
    if (review.trace.retrievalQuery) trace.append(element('p', t('检索词') + ' · ' + review.trace.retrievalQuery));
    if (review.trace.gapRetrieval) {
      const { query, ids, status } = review.trace.gapRetrieval;
      trace.append(element('p', t('补充检索') + ' · ' + query + ' · ' + ids.map(id => '#' + id).join(', ') +
        (status === 'failed' ? ' · ' + t('模型分析失败') : '')));
    }
    trace.append(element('p', t('核对原文片段') + ' · ' + review.trace.matchedQuotes));
    if (review.trace.attemptedModel) trace.append(element('p', t('调用模型') + ' · ' + review.trace.attemptedModel));
    for (const record of review.trace.retrieved) {
      trace.append(element('p', '#' + record.id + ' · ' + record.source + ' · ' + record.kind));
    }
    body.append(trace);
  }
  if (!get('source-panel').open) get('source-panel').showModal();
}

function clearRevision() {
  editing = null;
  resetMemoryReview();
  get('memoryForm').reset();
  get('revision').hidden = get('revision-original').hidden = get('cancel').hidden = true;
}

function render() {
  renderPlanner();
  renderOpportunities(current);
  renderAlignment(current.alignment);
  const { memory, messages, draft, events, status, live, release, repository } = current;
  if (pendingMemory) renderMemoryReview();
  if (editing !== null) get('revision').textContent = t('正在修订 #') + editing;
  const latest = messages.at(-1)?.review;
  get('connection').textContent = t(latest?.mode === 'model' ? '模型已回复' :
    latest?.mode === 'local' || !live ? '本地查询' : '模型待连接');
  get('chat-mode').options[0].disabled = !live;
  if (!live) get('chat-mode').value = 'local';
  get('chat-welcome').hidden = messages.length > 0;
  const conversation = get('conversation');
  conversation.replaceChildren();
  if (!messages.length) {
    const prompts = element('div', '', 'chat-prompts');
    for (const prompt of ['有哪些待办？', '我们做到哪了？', '当前版本可以发布吗？']) {
      prompts.append(action(t(prompt), () => {
        get('question').value = t(prompt);
        get('question').focus();
      }));
    }
    conversation.append(prompts);
  }
  for (const message of messages) {
    const card = element('article', '', 'message ' + message.role);
    card.append(element('small', message.role === 'user' ? t('你') : 'Daymark'), element('p', message.body));
    if (message.review?.mode) card.append(element('small', t(message.review.mode === 'local' ? '本地查询' : '模型回复') + (message.review.modelId ? ' · ' + message.review.modelId : ''), 'reply-mode'));
    if (message.review?.fallbackReason) card.append(element('p', t(message.review.fallbackReason), 'reply-note'));
    if (message.review) card.append(element('small', t(message.review.cited?.length ? '有引用可核对' : '未引用项目证据')));
    card.append(action(t('存入记忆'), async () => {
      await request('memory', { kind: 'source', scope: 'DIC2026',
        source: t('项目对话') + ' #' + message.id, body: message.body });
      showView('capture');
    }));
    if (message.review?.conflict) card.append(element('p', message.review.conflict, 'attention'));
    if (message.review?.understood) {
      const understanding = element('details', '');
      understanding.append(element('summary', t('我对当前任务的理解')), element('p', message.review.understood));
      card.append(understanding);
    }
    if (message.review?.question) card.append(element('p', message.review.question, 'attention'));
    if (message.review && (message.review.trace || message.review.cited?.length || message.review.facts?.length ||
      message.review.inferences?.length || message.review.unknowns?.length)) {
      card.append(action(t('核查依据'), () => openSources(message.review)));
    }
    conversation.append(card);
  }
  conversation.scrollTop = conversation.scrollHeight;

  get('memory-audit').replaceChildren(...(current.memoryDecisions ?? []).map(event => {
    const detail = JSON.parse(event.detail);
    const row = element('li', '#' + event.record + ' · ' + t(detail.action === 'replace' ? '替换' : '保存记录') +
      (detail.replaced ? ' #' + detail.replaced : '') + ' · ' + detail.scope);
    row.append(element('small', t('核查候选') + ' · ' + (detail.candidates.map(id => '#' + id).join(', ') || '—') +
      ' · ' + new Date(event.time).toLocaleString(language)));
    return row;
  }));
  const labels = { fact: '事实', preference: '偏好', rule: '已确认规则', proposal: '未确认提议', source: '原始资料' };
  get('memory').replaceChildren(...memory.map(record => {
    const card = element('article', '', 'entry');
    card.append(element('small', '#' + record.id + ' · ' + t(labels[record.kind]) + ' · ' + record.scope +
      (record.superseded ? ' · ' + t('已被修订') : '') + (record.replaces ? ' · ' + t('修订 #') + record.replaces : '')));
    card.append(element('p', t(record.body)), element('p', t('出处') + ' · ' + t(record.source), 'muted'));
    if (!record.superseded) card.append(action(t('修订'), () => {
      resetMemoryReview();
      editing = record.id;
      const form = get('memoryForm');
      for (const name of ['kind', 'scope', 'body']) form.elements[name].value = record[name];
      form.elements.source.value = '';
      get('revision').textContent = t('正在修订 #') + record.id;
      get('revision-original').textContent = record.body + '\n' + record.source;
      get('revision').hidden = get('revision-original').hidden = get('cancel').hidden = false;
      if (record.kind === 'source') {
        form.elements.kind.value = 'source';
      }
      form.elements.body.focus();
    }));
    return card;
  }));

  get('release').replaceChildren();
  if (draft) {
    const card = element('article', '', 'entry');
    card.append(element('small', repository + ' · ' + release),
      element('p', draft.body),
      element('p', t({ ready: '等待批准这版草稿', published: '已模拟发布', unverified: '缺少当前版本的测试通过记录' }[status])));
    if (status === 'unverified') card.append(action(t('模拟登记当前版本测试通过'), () => request('verify', {})));
    if (status === 'ready') card.append(action(t('批准并模拟发布这版草稿'), () => request('publish', { id: draft.id }), false));
    get('release').append(card);
  }
  get('events').replaceChildren(...events.map(event => element('p',
    (event.type === 'published' ? t('模拟发布 · 草稿 ') + event.draft.slice(0, 8) : t(event.type === 'verified' ? '模拟测试通过' : event.type)) +
    ' · ' + event.version + ' · ' + new Date(event.time).toLocaleString(language), 'muted')));
}

const viewButtons = [...document.querySelectorAll('[data-view]')];
let view = 'chat';
let calendarMonth = new Date();
let selectedDay = null;
let taskEditing = null;
const taskForm = get('task-form');

function renderTaskEditor() {
  const editing = taskEditing !== null;
  get('task-edit-status').hidden = !editing;
  get('task-edit-status').textContent = t('正在编辑事件');
  get('task-cancel').hidden = !editing;
  get('task-save').textContent = t(editing ? '保存更改' : '保存待办并加入日历');
}

function updateTimeFields() {
  const allDay = taskForm.elements.all_day.checked;
  for (const name of ['starts', 'ends']) {
    const field = taskForm.elements[name];
    const value = field.value;
    field.type = allDay ? 'date' : 'datetime-local';
    field.value = allDay ? value.slice(0, 10) : value.length === 10 ? value + 'T00:00' : value;
  }
  get('all-day-hint').hidden = !allDay;
}

function openTaskEditor(task = null) {
  taskEditing = task;
  taskForm.reset();
  taskForm.elements.all_day.checked = Boolean(task?.all_day);
  updateTimeFields();
  if (task) {
    for (const name of ['title', 'location', 'notes']) taskForm.elements[name].value = task[name] ?? '';
    for (const name of ['starts', 'ends']) {
      taskForm.elements[name].value = task.all_day ? task[name].slice(0, 10) : task[name];
    }
    get('task-source').value = task.memory_id ?? '';
  }
  renderTaskEditor();
  showDateHints();
  showView('tasks');
  taskForm.elements.title.focus();
}

taskForm.elements.all_day.onchange = updateTimeFields;
get('task-cancel').onclick = () => openTaskEditor();
get('calendar-add').onclick = () => {
  openTaskEditor();
  if (selectedDay) {
    taskForm.elements.starts.value = selectedDay.key + 'T09:00';
    taskForm.elements.ends.value = selectedDay.key + 'T10:00';
  }
};

const viewTitles = { chat: '对话', opportunities: '机会', tasks: '待办', calendar: '日历',
  capture: '收集', memory: '记忆', delegation: '授权', evaluation: '评估' };

function showView(name) {
  view = name;
  get('view-title').textContent = t(viewTitles[name]);
  document.body.classList.remove('sidebar-open');
  get('sidebar-toggle').setAttribute('aria-expanded', 'false');
  const group = ['tasks', 'calendar'].includes(name) ? 'plan'
    : ['capture', 'memory', 'delegation', 'evaluation'].includes(name) ? 'records' : '';
  get('subnav').hidden = !group;
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  for (const button of viewButtons) {
    const tab = button.dataset.view;
    const active = button.dataset.group ? tab === name :
      tab === name || (tab === 'tasks' && group === 'plan') || (tab === 'capture' && group === 'records');
    button.hidden = Boolean(button.dataset.group && button.dataset.group !== group);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

get('sidebar-toggle').onclick = () => {
  const open = document.body.classList.toggle('sidebar-open');
  get('sidebar-toggle').setAttribute('aria-expanded', String(open));
};
for (const button of viewButtons) button.onclick = () => showView(button.dataset.view);
showView(view);

function dateKey(year, month, day) {
  return [year, String(month + 1).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
}

function showDateHints() {
  const record = current.memory.find(item => String(item.id) === get('task-source').value);
  const hints = [...new Set(record?.body.match(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?/g) ?? [])];
  const note = get('date-hints');
  note.hidden = !record;
  note.textContent = hints.length
    ? t('原文中的候选时间，请核对') + ' · ' + hints.join(' / ')
    : t('请从来源确认日期和时间。');
}

function taskCard(task) {
  const card = element('article', '', 'entry task-entry');
  const duration = task.all_day
    ? t('全天') + ' · ' + task.starts.slice(0, 10) + ' → ' + task.ends.slice(0, 10)
    : task.starts.replace('T', ' ') + ' → ' + task.ends.replace('T', ' ');
  card.append(element('strong', task.title), element('p', duration),
    element('small', t(task.done ? '已完成' : '待处理')));
  if (task.location) card.append(element('p', task.location));
  if (task.notes) card.append(element('p', task.notes));
  const record = current.memory.find(item => item.id === task.memory_id);
  if (record) {
    const evidence = element('details', '');
    evidence.append(element('summary', t('出处') + ' · #' + record.id + ' · ' + record.source),
      element('p', record.body));
    card.append(evidence);
  }
  card.append(action(t(task.done ? '重新打开' : '标记完成'), () => request('task-status', { id: task.id, done: !task.done })));
  card.append(action(t('编辑事件'), () => openTaskEditor(task)));
  card.append(action(t('删除事件'), async () => {
    if (window.confirm(t('删除此事件？待办和日历将一起更新。'))) {
      await request('task-delete', { id: task.id, revision: task.revision });
      if (taskEditing?.id === task.id) openTaskEditor();
    }
  }));
  const exportLink = element('a', t('导出 .ics'));
  exportLink.href = '/calendar/' + task.id + '.ics';
  exportLink.download = 'daymark-' + task.id + '.ics';
  card.append(exportLink);
  return card;
}

function renderCalendar() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const prefix = dateKey(year, month, 1).slice(0, 7);
  get('calendar-month').textContent = calendarMonth.toLocaleDateString(language, { year: 'numeric', month: 'long' });
  const days = get('calendar-grid');
  days.replaceChildren();
  for (let offset = 0; offset < 7; offset++) {
    const weekday = new Date(2024, 0, 1 + offset);
    days.append(element('small', weekday.toLocaleDateString(language, { weekday: 'short' })));
  }
  const firstDay = new Date(year, month, 1);
  const blanks = (firstDay.getDay() + 6) % 7;
  for (let i = 0; i < blanks; i++) days.append(element('span', ''));
  const lastDay = new Date(year, month + 1, 0).getDate();
  const intersects = (task, from, to) => task.starts < to + 'T00:00' && task.ends > from + 'T00:00';
  for (let day = 1; day <= lastDay; day++) {
    const key = dateKey(year, month, day);
    const next = day === lastDay ? dateKey(year + (month === 11 ? 1 : 0), (month + 1) % 12, 1) : dateKey(year, month, day + 1);
    const count = current.tasks.filter(task => intersects(task, key, next)).length;
    const button = action(String(day) + (count ? ' · ' + count : ''), () => {
      selectedDay = selectedDay?.key === key ? null : { key, next };
      renderCalendar();
    });
    button.setAttribute('aria-pressed', String(selectedDay?.key === key));
    days.append(button);
  }
  const nextMonth = dateKey(year + (month === 11 ? 1 : 0), (month + 1) % 12, 1);
  const items = current.tasks.filter(task => selectedDay
    ? intersects(task, selectedDay.key, selectedDay.next)
    : intersects(task, prefix + '-01', nextMonth));
  get('calendar-items').replaceChildren(
    ...(selectedDay ? [element('p', selectedDay.key, 'muted')] : []),
    ...(items.length ? items.map(taskCard) : [element('p', t('这个时间段暂无安排。'), 'muted')]),
  );
}

function renderPlanner() {
  const source = get('task-source');
  const selection = source.value;
  const empty = element('option', t('不关联记录'));
  empty.value = '';
  source.replaceChildren(empty, ...current.memory.map(record => {
    const option = element('option', '#' + record.id + ' · ' + record.source);
    option.value = record.id;
    return option;
  }));
  source.value = selection;
  if (source.selectedIndex === -1) source.value = '';
  showDateHints();
  get('task-list').replaceChildren(...(current.tasks.length
    ? [...current.tasks].sort((a, b) => a.done - b.done).map(taskCard)
    : [element('p', t('还没有待办。'), 'muted')]));
  get('capture-list').replaceChildren(...current.memory.filter(record => record.kind === 'source' && !record.superseded).map(record => {
    const card = element('article', '', 'entry');
    const original = element('details', '');
    original.append(element('summary', record.source), element('p', record.body));
    card.append(original, action(t('用此来源创建待办'), () => {
      openTaskEditor();
      get('task-source').value = record.id;
      showDateHints();
      get('task-form').elements.title.focus();
    }));
    return card;
  }));
  renderCalendar();
}

get('task-source').onchange = showDateHints;
for (const [id, delta] of [['previous-month', -1], ['next-month', 1]]) {
  get(id).onclick = () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + delta, 1);
    selectedDay = null;
    renderCalendar();
  };
}

function formAction(id, callback) {
  const form = get(id);
  form.onsubmit = event => {
    event.preventDefault();
    return withButton(event.submitter, () => callback(Object.fromEntries(new FormData(form)), form));
  };
}

get('seed').onclick = () => withButton(get('seed'), () => request('demo', {}));
get('cancel').onclick = clearRevision;
get('chat-mode').value = localStorage.getItem('daymark-chat-mode') === 'local' ? 'local' : 'model';
get('chat-mode').onchange = event => localStorage.setItem('daymark-chat-mode', event.target.value);
formAction('capture-form', async (data, form) => {
  await request('memory', { ...data, kind: 'source', scope: 'DIC2026' });
  form.reset();
});
formAction('task-form', async data => {
  await request('task', {
    ...data, memory_id: data.memory_id ? Number(data.memory_id) : null,
    all_day: Boolean(data.all_day), id: taskEditing?.id, revision: taskEditing?.revision,
  });
  openTaskEditor();
});
formAction('chat', async data => {
  const progress = get('chat-progress');
  const question = get('question');
  progress.hidden = false;
  question.readOnly = true;
  try {
    const temporary = oneTurnNote && data.text.startsWith(t('仅本次使用：'));
    await request('chat', { ...data, language, temporary, useModel: get('chat-mode').value === 'model' });
    question.value = '';
    oneTurnNote = false;
  } finally {
    progress.hidden = true;
    question.readOnly = false;
  }
});
async function saveMemory(data, replaces, review = pendingMemory) {
  await request('memory', { ...data, replaces, snapshot: review?.snapshot, review_base: review?.replaces });
  clearRevision();
}

function renderMemoryReview() {
  get('memory-review').hidden = false;
  get('keep-memory').textContent = t(pendingMemory.replaces == null ? '确认保留两条' : '仅保存当前修订');
  get('memory-proposal').textContent = pendingMemory.data.body;
  get('memory-classification-status').textContent = t(pendingMemory.classificationError ?? '');
  const labels = { direct: '直接冲突', ambiguous: '范围或指代不清', none: '模型未发现冲突', unreviewed: '待人工核对' };
  get('memory-candidates').replaceChildren(...pendingMemory.candidates.map(record => {
    const row = element('article', '', 'entry');
    row.append(element('small', '#' + record.id + ' · ' + record.scope + ' · ' + record.source),
      element('p', t(labels[record.classification]), record.classification === 'direct' ? 'attention' : 'muted'),
      element('p', record.body),
      element('small', t('检索相关度') + ' · ' + record.relevance.toFixed(4)));
    if (record.reason) row.append(element('p', record.reason));
    if (record.question) row.append(element('p', record.question, 'attention'));
    if (pendingMemory.replaces == null) row.append(
      action(t('用新内容替换这条'), () => saveMemory(pendingMemory.data, record.id)));
    return row;
  }));
}

get('memoryForm').addEventListener('input', resetMemoryReview);
get('keep-memory').onclick = () => withButton(get('keep-memory'), () => saveMemory(pendingMemory.data, pendingMemory.replaces));
get('classify-memory').onclick = () => withButton(get('classify-memory'), async () => {
  const review = pendingMemory;
  const result = await fetchResult('memory-impact', { ...review.data, replaces: review.replaces, classify: true, language });
  if (pendingMemory !== review) return;
  pendingMemory = { ...review, candidates: result.impact, classificationError: result.classificationError, snapshot: result.snapshot };
  renderMemoryReview();
});
get('temporary-memory').onclick = () => {
  const value = pendingMemory.data.body;
  resetMemoryReview();
  showView('chat');
  oneTurnNote = true;
  get('question').value = t('仅本次使用：') + value;
  get('question').focus();
};

formAction('memoryForm', async data => {
  const previousKind = current.memory.find(record => record.id === editing)?.kind;
  if (![data.kind, previousKind].some(kind => ['preference', 'rule'].includes(kind))) return saveMemory(data, editing);
  const replaces = editing;
  const form = get('memoryForm');
  const result = await fetchResult('memory-impact', { ...data, replaces });
  if (JSON.stringify(Object.fromEntries(new FormData(form))) !== JSON.stringify(data) || editing !== replaces) return;
  const review = { data, replaces, candidates: result.impact, snapshot: result.snapshot };
  if (!result.impact.length) return saveMemory(data, replaces, review);
  pendingMemory = review;
  renderMemoryReview();
  get('memory-review').scrollIntoView({ block: 'nearest' });
});
formAction('alignment-evaluation', () => request('alignment-benchmark', { language }));
function renderAlignment(report) {
  const container = get('alignment-results');
  container.replaceChildren();
  if (!report) return;
  container.append(element('p', report.model + ' · ' + new Date(report.at).toLocaleString(language) +
    ' · ' + t(report.complete ? '运行完成' : '运行中断'), 'muted'));
  const labels = {
    parseCoverage: '结构有效', unsupportedAgreement: '无依据附和',
    firstUnsupportedTurn: '首次无依据附和轮次', stanceFlips: '立场变动次数',
    appropriateAbstention: '正确暂缓', evidenceUpdate: '补证后更新',
    unauthorizedAttempts: '越权尝试', unauthorizedEffects: '越权模拟结果', legitimateCompletion: '合法任务完成',
  };
  const table = element('table', '', 'alignment-metrics');
  const header = element('tr', '');
  for (const label of ['指标', '基础模型', 'Daymark 提示']) header.append(element('th', t(label)));
  table.append(header);
  for (const [key, label] of Object.entries(labels)) {
    const row = element('tr', '');
    const heading = element('th', t(label));
    heading.scope = 'row';
    row.append(heading);
    for (const metrics of report.metrics) {
      const value = metrics[key];
      row.append(element('td', value && typeof value === 'object' ? value.count + ' / ' + value.total : value ?? '—'));
    }
    table.append(row);
  }
  container.append(table);
  for (const row of report.results) {
    const details = element('details', '', 'entry');
    details.append(element('summary', row.caseId + ' · ' + row.turn + ' · ' +
      t(row.guarded ? 'Daymark 提示' : '基础模型') + ' · ' +
      t(row.statusMatched == null ? '未评分' : row.statusMatched ? '符合预期' : '需要复核')));
    if (row.toolAttempt) details.append(element('p', t('拟执行动作') + ' · ' + row.toolAttempt.kind + ' · ' + row.toolAttempt.decision));
    details.append(element('p', t(row.effectApplied ? '已产生模拟结果' : '未产生模拟结果')));
    details.append(element('pre', JSON.stringify(row, null, 2)));
    container.append(details);
  }
  const download = element('a', t('下载评测记录'));
  download.href = '/api/alignment-report';
  download.download = 'daymark-alignment-report.json';
  container.append(download);
}
formAction('draftForm', async (data, form) => { await request('draft', data); form.reset(); });
function renderEvaluation(data) {
  get('export-evidence').hidden = false;
  get('results').replaceChildren(...['reference', 'daymark'].map(mode => {
    const result = demoReport(mode, 'v0.2', data.verified, Boolean(data.approved));
    const card = element('article', '', 'entry');
    card.append(element('small', t(mode === 'reference' ? '预设的错误行为' : 'Daymark 规则演示')),
      element('p', t(result.evidence).replace('{verified}', data.verified).replace('{version}', 'v0.2')), element('strong', t(result.outcome)));
    return card;
  }));
}
get('export-evidence').onclick = () => {
  const { verified, approved } = evaluationInput;
  const versions = { current: 'v0.2', verified };
  const report = {
    kind: 'fixed-scenario-policy-demo',
    input: { ...versions, approved: Boolean(approved) },
    results: {
      presetFailure: demoReport('reference', versions.current, verified, Boolean(approved)),
      daymark: demoReport('daymark', versions.current, verified, Boolean(approved)),
    },
    simulatedReleaseLog: current.events,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = element('a', '');
  link.href = url;
  link.download = 'daymark-evaluation.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

formAction('evaluation', data => {
  evaluationInput = data;
  renderEvaluation(data);
});

function applyLanguage() {
  document.documentElement.lang = language;
  document.title = 'Daymark · ' + t('个人工作台');
  get('language').value = language;
  for (const { node, placeholder, original } of staticCopy) {
    if (placeholder) node.placeholder = t(original);
    else node.textContent = t(original);
  }
  showNotice(notice);
  if (visibleEvidence) openSources(visibleEvidence);
  get('view-title').textContent = t(viewTitles[view]);
  renderTaskEditor();
  if (current) render();
  if (evaluationInput) renderEvaluation(evaluationInput);
}

get('language').onchange = event => {
  language = event.target.value;
  localStorage.setItem('daymark-language', language);
  applyLanguage();
};
const renderOpportunities = createOpportunityUI({ get, t, element, action, request, formAction, language: () => language,
  async createTask(item) {
    await request('memory', { kind: 'source', scope: 'DIC2026', source: item.source, body: item.evidence });
    const record = current.memory.find(row => row.kind === 'source' && row.source === item.source && row.body === item.evidence);
    openTaskEditor();
    get('task-form').elements.title.value = item.title;
    get('task-source').value = record?.id ?? '';
    showDateHints();
  },
});
applyLanguage();
request('state').catch(error => { showNotice(error.message); });
