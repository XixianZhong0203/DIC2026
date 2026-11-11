import { createOpportunityUI } from '/opportunity-ui.js';
import { createDecisionUI } from '/decision-ui.js';
import { GLOBAL_SCOPE, demoReport } from '/policy.mjs';
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
let chatBusy = false;
let activeChat = Number(localStorage.getItem('daymark-chat')) || null;

function reconcileChat() {
  const chats = current?.conversations ?? [];
  if (!chats.length) { activeChat = null; return; }
  if (activeChat == null || !chats.some(chat => chat.id === activeChat)) {
    activeChat = Math.max(...chats.map(chat => chat.id));
  }
  localStorage.setItem('daymark-chat', activeChat);
}

function chatMessages() {
  if (!current || activeChat == null) return [];
  return (current.messages ?? []).filter(message => message.conversation_id === activeChat);
}

// ChatGPT-style day divider: “今天 15:43” / “昨天 15:43” / a full date.
function dayLabel(time) {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const clock = date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const label = date.toDateString() === now.toDateString() ? t('今天')
    : date.toDateString() === yesterday.toDateString() ? t('昨天')
    : date.toLocaleDateString(language, { month: 'long', day: 'numeric',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return label + ' ' + clock;
}

// The project scope of the active chat: memories saved from the chat apply to
// that project (a conversation without a project falls back to the default).
function currentProjectScope() {
  const chat = (current?.conversations ?? []).find(item => item.id === activeChat);
  return (chat?.project ?? '').trim() || 'DIC2026';
}

function setActiveChat(id) {
  activeChat = id;
  if (id != null) localStorage.setItem('daymark-chat', id);
  render();
}

// Raw project field of the active chat (may be '' = ungrouped). Distinct from
// currentProjectScope(), which resolves the fallback scope for memory.
function activeChatProject() {
  const chat = (current?.conversations ?? []).find(item => item.id === activeChat);
  return (chat?.project ?? '').trim();
}

// Create a fresh conversation in a workspace (new chats inherit it) and open it.
async function newChatIn(project) {
  const data = await fetchResult('conversation', { project });
  current = { ...data, tasks: data.tasks ?? [] };
  if (data.conversation != null) {
    activeChat = data.conversation;
    localStorage.setItem('daymark-chat', activeChat);
  }
  render();
  showView('chat');
  get('question').focus();
}

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

const escapeHtml = text => String(text).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function mdInline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function markdown(text) {
  const lines = String(text).split('\n');
  let html = '';
  let paragraph = [];
  let list = null;
  let code = false;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html += '<p>' + mdInline(escapeHtml(paragraph.join(' '))) + '</p>';
    paragraph = [];
  };
  const closeList = () => {
    if (list) { html += '</' + list + '>'; list = null; }
  };
  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) { code = false; html += '</code></pre>'; }
      else html += escapeHtml(line) + '\n';
      continue;
    }
    if (/^\s*```/.test(line)) { flushParagraph(); closeList(); code = true; html += '<pre><code>'; continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    const heading = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph(); closeList();
      const level = Math.min(heading[1].length + 2, 6);
      html += '<h' + level + '>' + mdInline(escapeHtml(heading[2])) + '</h' + level + '>';
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph(); closeList();
      html += '<blockquote>' + mdInline(escapeHtml(quote[1])) + '</blockquote>';
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = bullet ? null : line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) { closeList(); html += '<' + type + '>'; list = type; }
      html += '<li>' + mdInline(escapeHtml((bullet ?? numbered)[1])) + '</li>';
      continue;
    }
    paragraph.push(line.trim());
  }
  if (code) html += '</code></pre>';
  flushParagraph();
  closeList();
  return html;
}

const ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V4a2 2 0 0 1 2-2h9"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 19.5 3 21l1.5-4.5Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

function iconButton(name, label, callback) {
  const button = element('button', '', 'meta-button');
  button.type = 'button';
  button.title = t(label);
  button.setAttribute('aria-label', t(label));
  button.innerHTML = ICONS[name];
  button.onclick = () => withButton(button, callback);
  return button;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = element('textarea', text);
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
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
  try {
    const data = await fetchResult(path, body);
    current = { ...data, tasks: data.tasks ?? [] };
  } catch (error) {
    // 失败请求也可能留下记录（发送拦截、重复 409）：拉回最新状态，
    // 让活动记录当场刷新，再把错误交给按钮处理器显示拦截原因。
    try {
      const state = await fetchResult('state');
      current = { ...state, tasks: state.tasks ?? [] };
    } catch {
      // 连不上服务时保留原始错误
    }
    reconcileChat();
    render();
    throw error;
  }
  reconcileChat();
  render();
}

let visibleEvidence = null;
// Panels are shown non-modally (show, not showModal): the page behind them
// stays fully interactive, so an open panel can never make the rest of the
// page inert. Esc still closes any open panel.
get('close-sources').onclick = () => get('source-panel').close();
get('source-panel').addEventListener('close', () => { visibleEvidence = null; });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  for (const panel of document.querySelectorAll('dialog[open]')) panel.close();
});

// Extract memory candidates from the active chat and show them for confirmation.
get('close-candidates').onclick = () => get('candidate-panel').close();
get('chat-extract').onclick = () => withButton(get('chat-extract'), async () => {
  if (!chatMessages().length) { showNotice(t('先发送一条消息再提取记忆。')); return; }
  const result = await fetchResult('memory-candidates', { conversation_id: activeChat, language });
  renderCandidatePanel(result);
  get('candidate-panel').show();
});

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
    source.append(element('summary', '#' + record.id + ' · ' + (record.scope === GLOBAL_SCOPE ? t('全局') : (record.scope || t('未分组'))) + ' · ' + t(record.source)), element('p', t(record.body)));
    body.append(source);
  }
  if (review.trace) {
    const trace = element('details', '', 'entry');
    trace.append(element('summary', t('处理记录')));
    // Which workspace this answer actually read, so the user can confirm the
    // material range (ungrouped chats fall back to the default scope).
    trace.append(element('p', t('实际使用工作区') + ' · ' + (review.trace.scope || t('未分组'))));
    if (review.trace.retrievalQuery) trace.append(element('p', t('检索词') + ' · ' + review.trace.retrievalQuery));
    if (review.trace.gapRetrieval) {
      const { query, ids, status } = review.trace.gapRetrieval;
      trace.append(element('p', t('补充检索') + ' · ' + query + ' · ' + ids.map(id => '#' + id).join(', ') +
        (status === 'failed' ? ' · ' + t('模型分析失败') : '')));
    }
    trace.append(element('p', t('核对原文片段') + ' · ' + review.trace.matchedQuotes));
    if (review.trace.attemptedModel) trace.append(element('p', t('调用模型') + ' · ' + review.trace.attemptedModel));
    for (const record of review.trace.retrieved) {
      trace.append(element('p', '#' + record.id + ' · ' + (record.scope || t('未分组')) + ' · ' + record.source + ' · ' + record.kind));
    }
    body.append(trace);
  }
  if (!get('source-panel').open) get('source-panel').show();
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
  const { memory, draft, events, status, live, release, repository } = current;
  const messages = chatMessages();
  if (pendingMemory) renderMemoryReview();
  if (editing !== null) get('revision').textContent = t('正在修订 #') + editing;
  get('connection').textContent = t(live ? '模型已连接' : '模型未连接');
  get('connection').classList.toggle('live', live);
  get('chat-send').disabled = chatBusy || !live || !get('question').value.trim();
  get('composer-model').textContent = live ? 'Daymark' + (current.model ? ' · ' + current.model : '') : '';
  get('scroll-bottom').setAttribute('aria-label', t('回到底部'));
  layoutComposer(messages.length > 0);
  renderChatHistory();
  renderWorkspaceBar();
  if (view === 'chat') {
    const chat = (current.conversations ?? []).find(item => item.id === activeChat);
    get('view-title').textContent = t(chat?.title ?? '对话');
  }
  get('chat-welcome').hidden = messages.length > 0;
  const conversation = get('conversation');
  conversation.hidden = messages.length === 0;
  conversation.replaceChildren();
  if (!messages.length) {
    renderPromptChips();
  } else {
    let day = '';
    for (const message of messages) {
      if (message.time) {
        const key = new Date(message.time).toDateString();
        if (key !== day) {
          day = key;
          conversation.append(element('div', dayLabel(message.time), 'time-divider'));
        }
      }
      if (message.role === 'user') {
        const user = element('article', '', 'message user');
        user.append(element('p', message.body));
        conversation.append(user);
        continue;
      }
      const card = element('article', '', 'message assistant');
      const main = element('div', '', 'message-main');
      const body = element('div', '', 'message-body');
      body.innerHTML = markdown(message.body);
      main.append(body);
      const decision = message.review?.decision;
      if (message.review?.conflict && !(decision && decision.reason === message.review.conflict)) {
        main.append(element('p', message.review.conflict, 'attention'));
      }
      if (message.review?.question && !(decision && decision.reason === message.review.question)) {
        main.append(element('p', message.review.question, 'attention'));
      }
      if (message.review?.understood) {
        const understanding = element('details', '', 'message-detail');
        understanding.append(element('summary', t('我对当前任务的理解')), element('p', message.review.understood));
        main.append(understanding);
      }
      if (decision) renderDecision(main, message);
      renderProposal(main, message);
      const evidence = element('div', '', 'evidence-line');
      if (message.review?.fallbackReason) evidence.append(element('span', t(message.review.fallbackReason), 'meta-note'));
      if (message.review?.plain) evidence.append(element('span', t('模型未返回结构化答复，按纯文本展示。'), 'meta-note'));
      else if (message.review) {
        const ev = message.review.evidence ?? 'uncited';
        if (ev === 'verbatim') evidence.append(element('span', t('有引用可核对'), 'meta-note'));
        else evidence.append(element('span', t(ev === 'cited' ? '未核查项目证据 · 有来源，但引文未经逐字核对' : '未核查项目证据 · 无可核对引文'), 'meta-warn'));
      }
      if (evidence.childElementCount) main.append(evidence);
      const actions = element('div', '', 'message-actions');
      if (message.review && (message.review.trace || message.review.cited?.length || message.review.facts?.length ||
        message.review.inferences?.length || message.review.unknowns?.length)) {
        actions.append(iconButton('search', '核查依据', () => openSources(message.review)));
      }
      const copy = iconButton('copy', '复制', async () => {
        await copyText(message.body);
        copy.innerHTML = ICONS.check;
        setTimeout(() => { copy.innerHTML = ICONS.copy; }, 1600);
      });
      actions.append(copy);
      actions.append(iconButton('bookmark', '存入记忆', async () => {
        await request('memory', { kind: 'source', scope: currentProjectScope(),
          source: t('项目对话') + ' #' + message.id, body: message.body, message_id: message.id });
        navigateView('capture');
      }));
      main.append(actions);
      card.append(main);
      conversation.append(card);
    }
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
const groupViews = { chat: ['chat'], plan: ['tasks', 'calendar'], records: ['capture', 'memory', 'delegation', 'evaluation'] };
let expandedGroups = new Set(['chat']);
let view = 'chat';
let calendarMonth = new Date();
let selectedDay = null;
let taskEditing = null;
const taskForm = get('task-form');

// Back / forward history across the workspace views.
const viewHistory = [view];
let viewCursor = 0;
function syncHistoryButtons() {
  get('history-back').disabled = viewCursor <= 0;
  get('history-forward').disabled = viewCursor >= viewHistory.length - 1;
}
function navigateView(name) {
  if (name === view) { syncHistoryButtons(); return; }
  viewHistory.length = viewCursor + 1;
  viewHistory.push(name);
  viewCursor = viewHistory.length - 1;
  showView(name);
}
function stepView(delta) {
  const next = viewCursor + delta;
  if (next < 0 || next >= viewHistory.length) return;
  viewCursor = next;
  showView(viewHistory[viewCursor]);
}
get('history-back').onclick = () => stepView(-1);
get('history-forward').onclick = () => stepView(1);

// Thin icon rail: jump straight into each area and mark the active one.
const railViews = { chat: 'chat', opportunities: 'leads', tasks: 'plan', calendar: 'plan',
  capture: 'records', memory: 'records', delegation: 'records', evaluation: 'records' };
const railButtons = [...document.querySelectorAll('.rail [data-rail]')];
function syncRail() {
  const active = railViews[view];
  for (const button of railButtons) {
    if (button.dataset.rail === active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}
const railActions = {
  chat: () => navigateView('chat'),
  leads: () => navigateView('opportunities'),
  plan: () => { expandedGroups = new Set(['plan']); syncNavState(); navigateView('tasks'); },
  records: () => { expandedGroups = new Set(['records']); syncNavState(); navigateView('capture'); },
};
for (const button of railButtons) button.onclick = () => railActions[button.dataset.rail]?.();

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
  navigateView('tasks');
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

const viewTitles = { chat: '对话', opportunities: '线索', tasks: '待办', calendar: '日历',
  capture: '收集', memory: '记忆', delegation: '授权', evaluation: '评估' };

function activeGroup() {
  return Object.keys(groupViews).find(key => groupViews[key].includes(view)) ?? '';
}

function syncNavState() {
  for (const key of Object.keys(groupViews)) {
    const open = expandedGroups.has(key);
    get('group-' + key).setAttribute('aria-expanded', String(open));
    get('children-' + key).hidden = !open;
    document.querySelector(`.nav-caret[data-toggle="${key}"]`)?.classList.toggle('closed', !open);
    if (key === activeGroup()) get('group-' + key).setAttribute('aria-current', 'page');
    else get('group-' + key).removeAttribute('aria-current');
  }
}

function showView(name) {
  view = name;
  get('view-title').textContent = t(viewTitles[name]);
  document.body.classList.remove('sidebar-open');
  get('sidebar-toggle').setAttribute('aria-expanded', 'false');
  syncNavState();
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  for (const button of viewButtons) {
    if (button.dataset.view === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  syncRail();
  syncHistoryButtons();
}

get('sidebar-toggle').onclick = () => {
  const open = document.body.classList.toggle('sidebar-open');
  get('sidebar-toggle').setAttribute('aria-expanded', String(open));
};
for (const button of viewButtons) button.onclick = () => navigateView(button.dataset.view);
for (const button of document.querySelectorAll('.nav-group')) button.onclick = () => {
  const group = button.dataset.group;
  expandedGroups = expandedGroups.has(group) ? new Set() : new Set([group]);
  syncNavState();
};
for (const button of document.querySelectorAll('.nav-caret')) button.onclick = () => {
  const group = button.dataset.toggle;
  expandedGroups = expandedGroups.has(group) ? new Set() : new Set([group]);
  syncNavState();
};
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
  card.id = 'task-card-' + task.id;
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

// 待办操作留痕：时间、对象、改动前后、关联来源，以及经决策卡触发的选择。
// 复用现有活动记录的展示样式（details + summary + 明细行）。
const taskAuditActionLabels = { created: '创建', updated: '修改', done: '标记完成', reopened: '重新打开', deleted: '删除' };
const taskAuditFieldLabels = { title: '事项', location: '地点', notes: '备注' };
const taskAuditTime = value => String(value).replace('T', ' ');
function taskAuditRow(event) {
  const detail = JSON.parse(event.detail);
  const before = detail.before ?? null;
  const after = detail.after ?? null;
  const row = element('details', '');
  row.append(element('summary',
    t(taskAuditActionLabels[event.action] ?? event.action) + ' · #' + event.task + ' ' +
    t(after?.title ?? before?.title ?? '') + ' · ' + new Date(event.time).toLocaleString(language)));
  if (before?.starts && after?.starts && (before.starts !== after.starts || before.ends !== after.ends)) {
    row.append(element('p', t('原时间') + ' · ' + taskAuditTime(before.starts) + ' → ' + taskAuditTime(before.ends), 'muted'));
    row.append(element('p', t('新时间') + ' · ' + taskAuditTime(after.starts) + ' → ' + taskAuditTime(after.ends), 'muted'));
  }
  if (event.action === 'created' && after?.starts) {
    row.append(element('p', t('新时间') + ' · ' + taskAuditTime(after.starts) + ' → ' + taskAuditTime(after.ends), 'muted'));
  }
  for (const key of ['title', 'location', 'notes']) {
    if (before?.[key] != null && after?.[key] != null && before[key] !== after[key]) {
      row.append(element('p', t(taskAuditFieldLabels[key]) + ' · ' + before[key] + ' → ' + after[key], 'muted'));
    }
  }
  if (event.action === 'done' || event.action === 'reopened') {
    row.append(element('p', t('结果') + ' · ' + t(after?.done ? '已完成' : '待处理'), 'muted'));
  }
  row.append(element('p', detail.source != null ? t('关联来源') + ' · #' + detail.source : t('不关联记录'), 'muted'));
  if (detail.via?.decision) {
    row.append(element('p', t('经决策卡') + ' · ' + t('消息') + ' #' + detail.via.decision +
      (detail.via.option_label ? ' · ' + detail.via.option_label : ''), 'muted'));
  }
  return row;
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
  get('task-audit').replaceChildren(...(current.taskAudit ?? []).map(taskAuditRow));
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
// The input held by an open prompt card. Once the user picks an option the
// text is delivered exactly once (a fresh conversation in the target
// workspace, or the current conversation); cancel keeps it in the box.
let heldSwitch = null;

function setChatBusy(busy) {
  chatBusy = busy;
  get('chat-progress').hidden = !busy;
  get('question').readOnly = busy;
  get('chat-send').disabled = busy || !current?.live || !get('question').value.trim();
}

// The single send path. `target` is null for the current conversation, or
// { project } for a fresh conversation that inherits that workspace.
async function sendChat(text, target) {
  const question = get('question');
  setChatBusy(true);
  try {
    const body = { text, language,
      temporary: oneTurnNote && text.startsWith(t('仅本次使用：')) };
    if (target?.project != null) body.project = target.project;
    else body.conversation_id = activeChat;
    await request('chat', body);
    if (current.conversation != null) {
      activeChat = current.conversation;
      localStorage.setItem('daymark-chat', activeChat);
    }
    question.value = '';
    oneTurnNote = false;
  } finally {
    setChatBusy(false);
    growQuestion();
  }
}

// Before the formal answer (and memory retrieval) the input is checked for a
// possible topic or workspace change. A 'continue' judgment sends directly;
// anything else holds the input and shows the prompt card. If the check
// fails, the original input goes through as a normal message and the manual
// switch entry stays available.
formAction('chat', async data => {
  const text = data.text;
  if (heldSwitch) {
    // Enter while the card is open: send directly in the current conversation.
    heldSwitch = null;
    hideSwitchCard();
    return sendChat(text, null);
  }
  setChatBusy(true);
  try {
    const intent = await fetchResult('chat-intent', { text, conversation_id: activeChat, language });
    if (intent.action === 'continue') return sendChat(text, null);
    heldSwitch = { action: intent.action, workspace: intent.workspace ?? '', involved: intent.involved ?? [], current: intent.current ?? '' };
    showSwitchCard(text, heldSwitch);
  } catch (error) {
    showNotice(error.message);
    return sendChat(text, null);
  } finally {
    setChatBusy(false);
  }
});

function hideSwitchCard() {
  heldSwitch = null;
  const card = get('switch-card');
  card.replaceChildren();
  card.hidden = true;
}

function showSwitchCard(text, intent) {
  const card = get('switch-card');
  card.replaceChildren();
  const currentName = activeChatProject() || t('未分组');
  const name = name => name || t('未分组');
  const title = element('p', '', 'switch-card-title');
  const detail = element('p', '', 'switch-card-detail');
  const note = element('p', '', 'switch-card-note');
  const actions = element('div', '', 'switch-card-actions');
  if (intent.action === 'switch') {
    title.textContent = t('检测到跨工作区切换');
    detail.textContent = t('当前工作区：') + name(currentName) + ' → ' + t('目标工作区：') + name(intent.workspace);
    note.textContent = t('确认后将在 {ws} 开新对话，读取 {ws} 的资料和全局记忆。').replaceAll('{ws}', name(intent.workspace));
  } else if (intent.action === 'new') {
    title.textContent = t('检测到同工作区的新任务');
    detail.textContent = t('当前工作区：') + name(currentName);
    note.textContent = t('确认后在当前工作区开新对话；原对话仍可访问，新对话仍读取该工作区的长期记忆。');
  } else {
    title.textContent = t('跨工作区请求');
    detail.textContent = t('这条输入同时涉及：') + (intent.involved.length ? intent.involved.map(name).join('、') : currentName);
    note.textContent = t('现在发送只会读取当前工作区的资料；如需其他工作区的资料，请先手动切换。');
  }
  const sendAs = target => async () => {
    heldSwitch = null;
    hideSwitchCard();
    await sendChat(text, target);
  };
  if (intent.action === 'switch') {
    actions.append(action(t('切换到 {ws} 并开新对话').replaceAll('{ws}', name(intent.workspace)), sendAs({ project: intent.workspace }), false));
    actions.append(action(t('继续当前对话'), sendAs(null)));
  } else if (intent.action === 'new') {
    actions.append(action(t('在 {ws} 开新对话').replaceAll('{ws}', name(currentName)), sendAs({ project: activeChatProject() }), false));
    actions.append(action(t('继续当前对话'), sendAs(null)));
  } else {
    actions.append(action(t('在当前工作区继续'), sendAs(null), false));
  }
  actions.append(action(t('取消'), () => { heldSwitch = null; hideSwitchCard(); get('question').focus(); }, false));
  card.append(title, detail, note, actions);
  card.hidden = false;
}

const PROMPT_CHIPS = ['有哪些待办？', '我们做到哪了？', '当前版本可以发布吗？'];

function renderPromptChips() {
  const prompts = get('chat-prompts');
  prompts.replaceChildren();
  for (const prompt of PROMPT_CHIPS) {
    prompts.append(action(t(prompt), () => {
      get('question').value = t(prompt);
      get('question').focus();
      growQuestion();
    }));
  }
}

function layoutComposer(hasMessages) {
  const wrap = get('composer');
  if (hasMessages) {
    if (wrap.parentElement !== get('chat-stage')) get('chat-stage').append(wrap);
  } else if (wrap.parentElement !== get('chat-welcome')) {
    get('chat-prompts').before(wrap);
  }
}

function growQuestion() {
  const question = get('question');
  question.style.height = 'auto';
  question.style.height = Math.min(question.scrollHeight, 200) + 'px';
}

get('question').addEventListener('input', () => {
  growQuestion();
  // Editing the held input invalidates the pending suggestion: close the
  // card so a resubmission re-runs the detection on the new text.
  if (heldSwitch) hideSwitchCard();
  get('chat-send').disabled = chatBusy || !current?.live || !get('question').value.trim();
});
get('question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    get('chat-send').click();
  }
});

get('conversation').addEventListener('scroll', () => {
  const node = get('conversation');
  const jump = get('scroll-bottom');
  const away = node.scrollHeight - node.scrollTop - node.clientHeight > 120;
  jump.hidden = !away;
  if (away) jump.style.bottom = Math.max(12, get('composer').offsetTop - 14) + 'px';
});
get('scroll-bottom').onclick = () => {
  const node = get('conversation');
  node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
};
get('new-chat').onclick = () => withButton(get('new-chat'), () => newChatIn(activeChatProject()));
get('rail-new').onclick = () => withButton(get('rail-new'), () => newChatIn(activeChatProject()));
let chatFilter = '';
function closeSearch() {
  const sidebar = get('sidebar');
  sidebar.classList.remove('search-open');
  const input = get('chat-search');
  input.hidden = true;
  input.value = '';
  chatFilter = '';
  renderChatHistory();
}
get('chat-search-toggle').onclick = () => {
  const sidebar = get('sidebar');
  const input = get('chat-search');
  const open = sidebar.classList.toggle('search-open');
  input.hidden = !open;
  if (open) input.focus();
  else { input.value = ''; chatFilter = ''; renderChatHistory(); }
};
get('chat-search').addEventListener('input', event => {
  chatFilter = event.target.value.trim().toLowerCase();
  renderChatHistory();
});
get('chat-search').addEventListener('keydown', event => {
  if (event.key === 'Escape') closeSearch();
});
// The sidebar shows workspaces first, each keeping its independent chats;
// ungrouped chats stay accessible as their own entry. Workspaces that only
// hold memory so far are listed too, so they can be entered (and opened with
// a new chat) before any conversation exists there.
function renderChatHistory() {
  const list = get('chat-list');
  list.replaceChildren();
  const chats = [...(current?.conversations ?? [])].sort((a, b) => b.id - a.id)
    .filter(chat => !chatFilter || chat.title.toLowerCase().includes(chatFilter));
  if (!chats.length) {
    list.append(element('p', t(chatFilter ? '没有找到相关对话。' : '还没有对话。发消息或点「新对话」开始。'), 'muted'));
    return;
  }
  const byWorkspace = new Map();
  for (const chat of chats) {
    const name = (chat.project ?? '').trim();
    if (!byWorkspace.has(name)) byWorkspace.set(name, []);
    byWorkspace.get(name).push(chat);
  }
  const named = [...byWorkspace.entries()].filter(([name]) => name);
  named.sort((a, b) => b[1].reduce((m, c) => Math.max(m, c.id), 0) - a[1].reduce((m, c) => Math.max(m, c.id), 0));
  const memoryOnly = (current?.workspaces ?? []).filter(name => !byWorkspace.has(name));
  const groups = [
    ...named,
    ...memoryOnly.map(name => [name, []]),
    ...(byWorkspace.has('') ? [['', byWorkspace.get('')]] : []),
  ];
  for (const [name, items] of groups) list.append(workspaceGroupRow(name, items));
}

function workspaceGroupRow(name, chats) {
  const group = element('div', '', 'chat-workspace');
  const head = element('div', '', 'chat-workspace-head');
  const label = element('button', name || t('未分组'), 'chat-workspace-name');
  label.type = 'button';
  label.title = t('切换到这个工作区');
  label.onclick = () => { showView('chat'); switchToWorkspace(name); };
  const add = element('button', '+', 'chat-workspace-add');
  add.type = 'button';
  add.title = t('在此工作区新建对话');
  add.setAttribute('aria-label', t('在此工作区新建对话'));
  add.onclick = () => withButton(add, () => newChatIn(name));
  head.append(label, add);
  const body = element('div', '', 'chat-workspace-chats');
  for (const chat of chats) body.append(chatRow(chat));
  group.append(head, body);
  return group;
}

// Manual workspace switch: open the most recent chat of that workspace, or
// create the first conversation there when none exists yet.
function switchToWorkspace(name) {
  const chats = (current?.conversations ?? [])
    .filter(chat => (chat.project ?? '').trim() === name)
    .sort((a, b) => b.id - a.id);
  if (chats.length) setActiveChat(chats[0].id);
  else newChatIn(name);
}

// Chat header: which workspace the active chat belongs to, plus the manual
// switcher. The input itself is never changed by switching.
function renderWorkspaceBar() {
  const bar = get('workspace-bar');
  const select = get('workspace-select');
  const names = [...(current?.workspaces ?? [])];
  select.replaceChildren(
    ...names.map(name => {
      const option = element('option', name);
      option.value = name;
      return option;
    }),
  );
  const ungrouped = element('option', t('未分组'));
  ungrouped.value = '';
  select.append(ungrouped);
  const project = activeChatProject();
  select.value = names.includes(project) ? project : '';
  bar.hidden = !(view === 'chat' && (activeChat != null || names.length));
}
get('workspace-select').onchange = () => switchToWorkspace(get('workspace-select').value);

function chatRow(chat) {
  const row = element('div', '', 'chat-row' + (chat.id === activeChat ? ' current' : ''));
  const title = element('button', chat.title, 'chat-row-title');
  title.type = 'button';
  title.title = chat.title;
  title.onclick = () => { navigateView('chat'); setActiveChat(chat.id); closeSearch(); };
  const tools = element('div', '', 'chat-row-tools');
  const rename = element('button', '', 'chat-row-tool');
  rename.type = 'button';
  rename.title = t('重命名');
  rename.setAttribute('aria-label', t('重命名'));
  rename.innerHTML = ICONS.pencil;
  rename.onclick = () => startRename(chat, row, title);
  const merge = element('button', '⇥', 'chat-row-tool');
  merge.type = 'button';
  merge.title = t('并入当前对话');
  merge.setAttribute('aria-label', t('并入当前对话'));
  merge.hidden = chat.id === activeChat;
  merge.onclick = () => withButton(merge, async () => {
    if (activeChat == null || chat.id === activeChat) return;
    if (!window.confirm(t('把这个对话并入当前对话？消息和记忆都会一起跟过去。'))) return;
    await request('conversation-merge', { id: chat.id, target: activeChat });
    renderChatHistory();
  });
  const remove = element('button', '', 'chat-row-tool');
  remove.type = 'button';
  remove.title = t('删除对话');
  remove.setAttribute('aria-label', t('删除对话'));
  remove.innerHTML = ICONS.close;
  remove.onclick = () => withButton(remove, async () => {
    if (!window.confirm(t('删除这个对话？对话里的消息和由对话保存的记忆会一起删除。'))) return;
    await request('conversation-delete', { id: chat.id });
    if (activeChat === chat.id) {
      const chats = current.conversations ?? [];
      activeChat = chats.length ? Math.max(...chats.map(item => item.id)) : null;
    }
    localStorage.setItem('daymark-chat', activeChat);
    renderChatHistory();
  });
  tools.append(rename, merge, remove);
  const project = element('input', '', 'chat-row-project');
  project.value = chat.project;
  project.placeholder = t('未分组');
  project.maxLength = 40;
  project.setAttribute('aria-label', t('项目'));
  project.onchange = () => {
    if (project.value.trim() !== chat.project) request('conversation-edit', { id: chat.id, project: project.value.trim() });
  };
  row.append(title, tools, project);
  return row;
}

function startRename(chat, row, titleButton) {
  if (row.querySelector('.chat-row-name')) return;
  const input = element('input', '', 'chat-row-name');
  input.value = chat.title;
  input.maxLength = 60;
  input.setAttribute('aria-label', t('重命名对话'));
  titleButton.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async save => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (save && value && value !== chat.title) await request('conversation-edit', { id: chat.id, title: value });
    renderChatHistory();
  };
  input.onblur = () => { finish(true); };
  input.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    if (event.key === 'Escape') { input.onblur = null; finish(false); }
  };
}
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
  navigateView('chat');
  oneTurnNote = true;
  get('question').value = t('仅本次使用：') + value;
  get('question').focus();
};

// An unconfirmed proposal surfaced from the exchange (e.g. a customer
// asking to change a confirmed date): shown as a proposal card. Saving it
// keeps kind=proposal, so the previously confirmed rule stays valid until
// the owner explicitly accepts it.
function renderProposal(parent, message) {
  const proposal = message.review?.proposal;
  if (!proposal) return;
  const project = currentProjectScope();
  // A duplicate proposal (same content, visible in this scope) is not shown twice.
  if ((current.memory ?? []).some(record => !record.superseded && record.kind === 'proposal' &&
      record.body === proposal.body && (record.scope === project || record.scope === GLOBAL_SCOPE))) return;
  const card = element('div', '', 'proposal-card');
  card.append(element('p', t('新要求') + ' · ' + proposal.body, 'attention'));
  card.append(element('p', t('已确认的规则在你明确接受前仍然有效。'), 'meta-note'));
  card.append(action(t('保存为未确认提议'), async () => {
    await request('memory', { kind: 'proposal', scope: project, body: proposal.body,
      source: t('项目对话') + ' #' + message.id, message_id: proposal.message_id ?? null });
    showNotice(t('已保存为未确认提议'));
  }));
  parent.append(card);
}

// Model-extracted memory candidates from the chat: each keeps content, kind,
// scope, confirmation status and the source message. Saving goes through the
// normal memory form (preferences and rules still get the pre-save review).
function renderCandidatePanel(result) {
  const box = get('candidate-content');
  box.replaceChildren();
  const candidates = result.candidates ?? [];
  if (!candidates.length) {
    box.append(element('p', t('没有提取到记忆候选。'), 'muted'));
    return;
  }
  const kindLabels = { fact: '事实', preference: '偏好', rule: '已确认规则', proposal: '未确认提议' };
  for (const item of candidates) {
    const row = element('article', '', 'entry candidate-row');
    row.append(element('p', item.content));
    row.append(element('small',
      t('类型') + ' · ' + t(kindLabels[item.kind]) +
      ' · ' + t('适用范围') + ' · ' + (item.scope === GLOBAL_SCOPE ? t('全局') : item.scope) +
      ' · ' + t(item.status === 'pending' ? '待确认' : '已确认') +
      ' · ' + t('来源消息') + ' · ' + (item.message_id != null ? '#' + item.message_id : t('来源未定'))));
    row.append(action(t(item.kind === 'proposal' ? '保存为未确认提议' : '确认保存'), () => startMemorySave({
      kind: item.kind, scope: item.scope, body: item.content,
      source: item.message_id != null ? t('项目对话') + ' #' + item.message_id : t('对话提取'),
      message_id: item.message_id,
    })));
    box.append(row);
  }
}

// Prefill the memory form from a chat candidate or proposal and submit it.
function startMemorySave({ kind, scope, body, source, message_id = null }) {
  clearRevision();
  const form = get('memoryForm');
  form.elements.kind.value = kind;
  syncScopeMode(scope);
  form.elements.body.value = body;
  form.elements.source.value = source;
  form.elements.message_id.value = message_id ?? '';
  navigateView('memory');
  form.requestSubmit();
}

function syncScopeMode(scope) {
  const mode = get('scope-mode');
  if (scope === GLOBAL_SCOPE) mode.value = GLOBAL_SCOPE;
  else if (scope === currentProjectScope()) mode.value = '';
  else { mode.value = 'custom'; get('memoryForm').elements.scope.value = scope; }
  get('scope-custom').hidden = mode.value !== 'custom';
}
get('scope-mode').addEventListener('change', () => {
  get('scope-custom').hidden = get('scope-mode').value !== 'custom';
});

formAction('memoryForm', async (data, form) => {
  // Resolve the scope control (current project / global / custom) and the
  // source-message link before the existing review or direct save.
  const scopeMode = get('scope-mode').value;
  data.scope = scopeMode === 'custom' ? form.elements.scope.value.trim()
    : scopeMode === GLOBAL_SCOPE ? GLOBAL_SCOPE : currentProjectScope();
  data.message_id = data.message_id ? Number(data.message_id) : null;
  const previousKind = current.memory.find(record => record.id === editing)?.kind;
  if (![data.kind, previousKind].some(kind => ['preference', 'rule'].includes(kind))) return saveMemory(data, editing);
  const replaces = editing;
  const result = await fetchResult('memory-impact', { ...data, replaces });
  // The form is re-read after the review request to catch edits made meanwhile;
  // scope and message_id are re-derived the same way so they don't false-positive.
  const recheck = Object.fromEntries(new FormData(form));
  recheck.scope = data.scope;
  recheck.message_id = data.message_id;
  if (JSON.stringify(recheck) !== JSON.stringify(data) || editing !== replaces) return;
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
const renderDecision = createDecisionUI({
  t, element, action, request, fetchResult, language: () => language,
  openSources: review => openSources(review),
  copyText,
  fillComposer: text => {
    const question = get('question');
    question.value = text;
    growQuestion();
    get('chat-send').disabled = !current?.live || !question.value.trim();
    question.focus();
  },
  jumpToCalendar: dateKey => {
    const [year, month, day] = dateKey.split('-').map(Number);
    calendarMonth = new Date(year, month - 1, day);
    const next = new Date(year, month - 1, day + 1);
    selectedDay = { key: dateKey, next: dateKey(next.getFullYear(), next.getMonth(), next.getDate()) };
    navigateView('calendar');
    renderCalendar();
  },
  // 决策卡回执「查看待办」：跳到待办列表并高亮对应事件。
  jumpToTask: taskId => {
    showView('tasks');
    const card = get('task-card-' + taskId);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('task-flash');
      setTimeout(() => card.classList.remove('task-flash'), 1800);
    }
  },
});
applyLanguage();
request('state').then(() => {
  if (view === 'chat' && window.matchMedia('(hover: hover)').matches) get('question').focus();
}).catch(error => { showNotice(error.message); });
