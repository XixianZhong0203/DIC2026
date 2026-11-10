import { demoReport } from '/policy.mjs';

const get = id => document.getElementById(id);
let current;
let editing = null;

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
  get('notice').textContent = '';
  try { await callback(); }
  catch (error) { get('notice').textContent = error.message; }
  finally { button.disabled = false; }
}

async function request(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  current = data;
  render();
}

function clearRevision() {
  editing = null;
  get('memoryForm').reset();
  get('revision').hidden = get('cancel').hidden = true;
}

function render() {
  const { memory, messages, draft, events, status, live, release, repository } = current;
  get('connection').textContent = live ? '模型已配置' : '本地演示模式';
  const conversation = get('conversation');
  conversation.replaceChildren();
  if (!messages.length) conversation.append(element('p', live ? '试着问一个关于项目进度的问题。' : '配置模型后可对话，也可以先体验示例记忆和模拟发布。', 'muted'));
  for (const message of messages) {
    const card = element('article', '', 'message ' + message.role);
    card.append(element('small', message.role === 'user' ? '你' : 'Daymark'), element('p', message.body));
    if (message.review?.conflict) card.append(element('p', message.review.conflict, 'attention'));
    if (message.review?.question) card.append(element('p', message.review.question, 'attention'));
    for (const record of message.review?.cited ?? []) {
      const detail = element('details', '');
      detail.append(element('summary', '#' + record.id + ' · ' + record.source), element('p', record.body));
      card.append(detail);
    }
    conversation.append(card);
  }
  conversation.scrollTop = conversation.scrollHeight;

  const labels = { fact: '事实', preference: '偏好', rule: '已确认规则', proposal: '未确认提议' };
  get('memory').replaceChildren(...memory.map(record => {
    const card = element('article', '', 'entry');
    card.append(element('small', '#' + record.id + ' · ' + labels[record.kind] + ' · ' + record.scope +
      (record.superseded ? ' · 已被修订' : '') + (record.replaces ? ' · 修订 #' + record.replaces : '')));
    card.append(element('p', record.body), element('p', '出处 · ' + record.source, 'muted'));
    if (!record.superseded) card.append(action('修订', () => {
      editing = record.id;
      const form = get('memoryForm');
      for (const name of ['kind', 'scope', 'body']) form.elements[name].value = record[name];
      form.elements.source.value = '';
      get('revision').textContent = '正在修订 #' + record.id;
      get('revision').hidden = get('cancel').hidden = false;
      form.elements.body.focus();
    }));
    return card;
  }));

  get('release').replaceChildren();
  if (draft) {
    const card = element('article', '', 'entry');
    card.append(element('small', repository + ' · ' + release),
      element('p', draft.body),
      element('p', { ready: '等待批准这版草稿', published: '已模拟发布', unverified: '缺少当前版本的测试通过记录' }[status]));
    if (status === 'unverified') card.append(action('模拟登记当前版本测试通过', () => request('verify', {})));
    if (status === 'ready') card.append(action('批准并模拟发布这版草稿', () => request('publish', { id: draft.id }), false));
    get('release').append(card);
  }
  get('events').replaceChildren(...events.map(event => element('p',
    (event.type === 'published' ? '模拟发布 · 草稿 ' + event.draft.slice(0, 8) : '模拟测试通过') +
    ' · ' + event.version + ' · ' + new Date(event.time).toLocaleString(), 'muted')));
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
formAction('chat', async (data, form) => { await request('chat', data); form.reset(); });
formAction('memoryForm', async data => { await request('memory', { ...data, replaces: editing }); clearRevision(); });
formAction('draftForm', async (data, form) => { await request('draft', data); form.reset(); });
formAction('evaluation', data => {
  get('results').replaceChildren(...['reference', 'daymark'].map(mode => {
    const result = demoReport(mode, 'v0.2', data.verified, Boolean(data.approved));
    const card = element('article', '', 'entry');
    card.append(element('small', mode === 'reference' ? '预设的错误行为' : 'Daymark 规则演示'),
      element('p', result.evidence), element('strong', result.outcome));
    return card;
  }));
});
request('state').catch(error => { get('notice').textContent = error.message; });
