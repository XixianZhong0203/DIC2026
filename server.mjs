import { parseClaimReport, verifyClaims } from './src/opportunity/claims.mjs';
import { CHAT_CLAIM_DIMENSIONS, CHAT_CLAIMS_PROMPT_VERSION, chatClaimSources, chatClaimMessages, chatClaimSummary } from './src/chat/chat-claims.mjs';
import { loadArchiveRow, archiveIntegrity } from './src/opportunity/archive.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { memoryCandidates, recordsInScope, scopeMatches, normalizeCandidates, verifiedQuotes,
  effectiveAppliesTo, normalizeAppliesTo, recordProvenance, memoryExtractionMessages,
  memoryConflictMessages } from './src/memory/memory-impact.mjs';
import { rankRecords } from './src/chat/local-chat.mjs';
import { ruleIntent, normalizeIntent, workspaceMentions, chatIntentMessages } from './src/chat/chat-intent.mjs';
import { chatReplyMessages } from './src/chat/chat-reply.mjs';
import { opportunityWorkflow } from './src/opportunity/opportunities.mjs';
import { actionDecision, runAlignmentBenchmark } from './src/alignment/alignment.mjs';
import { calendarFile } from './src/calendar/calendar.mjs';
import { GLOBAL_SCOPE, demoRecords, releaseStatus, release, repository } from './src/policy/policy.mjs';
import { detectDecision, decisionContext, recheckDecision } from './src/decision/decision.mjs';
// Multi-model catalog (multi-model window): models, endpoints, credentials, and reasoning effort levels
// switchable per session.
import { MODELS, modelById, defaultModel, modelKey, modelConfigured, conversationModel, modelProvider } from './src/models.mjs';
import { embedText, geminiTextReply } from './src/gemini-tools.mjs';
import { synthesizeSpeech } from './src/speech.mjs';
import { translateRecording } from './src/audio-tools.mjs';
// Decision card confirm execution: per-card serialization, confirm-time
// recheck dispatch, idempotent receipt recovery, and the card states
// Selected pending confirmation / Applied / Deferred / Failed. See the module header for ownership.
import { createDecisionRoute } from './src/decision/confirm.mjs';
// Pending operation audit trail (audit window): task_audit table, before/after snapshots, and decision
// card receipt text.
import { createTaskAudit, changeReceipt } from './src/tasks/task-audit.mjs';

const dataDir = process.env.DAYMARK_DATA_DIR ?? new URL('./data/', import.meta.url).pathname;
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(dataDir + '/daymark.sqlite');
db.exec(`
  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY, kind TEXT, scope TEXT, body TEXT, source TEXT, replaces INTEGER
  );
  CREATE TABLE IF NOT EXISTS alignment_runs (id INTEGER PRIMARY KEY, report TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memory_decisions (
    id INTEGER PRIMARY KEY, record INTEGER NOT NULL, detail TEXT NOT NULL, time TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, role TEXT, body TEXT, review TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, starts TEXT NOT NULL, ends TEXT NOT NULL,
    memory_id INTEGER REFERENCES memory(id), done INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY, version TEXT, body TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, type TEXT, version TEXT, draft TEXT, time TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_publish ON events(draft) WHERE type = 'published';
`);

const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
for (const [column, definition] of [
  ['all_day', 'INTEGER NOT NULL DEFAULT 0'], ['location', "TEXT NOT NULL DEFAULT ''"],
  ['notes', "TEXT NOT NULL DEFAULT ''"], ['deleted', 'INTEGER NOT NULL DEFAULT 0'],
  ['revision', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  if (!taskColumns.has(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
}
db.exec('CREATE TABLE IF NOT EXISTS calendar_identity (id INTEGER PRIMARY KEY CHECK (id = 1), uid TEXT NOT NULL)');
db.prepare('INSERT OR IGNORE INTO calendar_identity VALUES (1, ?)').run(randomUUID());
const calendarId = db.prepare('SELECT uid FROM calendar_identity WHERE id = 1').get().uid;
const tasks = () => db.prepare('SELECT * FROM tasks WHERE deleted = 0 ORDER BY starts, id').all();
// Pending operation audit trail: record must be called within the task routing transaction (see task
// routing below).
const taskAudit = createTaskAudit(db);
db.exec(`CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', created TEXT NOT NULL
);`);
// Multi-model window: each session remembers its selected model and reasoning effort level (null = default
// model / endpoint default effort level).
const conversationColumns = new Set(db.prepare('PRAGMA table_info(conversations)').all().map(column => column.name));
for (const [column, definition] of [['model', 'TEXT'], ['effort', 'TEXT']]) {
  if (!conversationColumns.has(column)) db.exec(`ALTER TABLE conversations ADD COLUMN ${column} ${definition}`);
}
const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(column => column.name));
if (!messageColumns.has('conversation_id')) db.exec('ALTER TABLE messages ADD COLUMN conversation_id INTEGER');
if (!messageColumns.has('time')) db.exec('ALTER TABLE messages ADD COLUMN time TEXT');
const memoryColumns = new Set(db.prepare('PRAGMA table_info(memory)').all().map(column => column.name));
if (!memoryColumns.has('message_id')) db.exec('ALTER TABLE memory ADD COLUMN message_id INTEGER');
// Shared memory retains original project and scope (shared-memory window): applies_to records which
// project this clause constrains (null = legacy data without explicit record, inferred by scope on read:
// global -> '*', project -> itself); origin_scope records the project where it originally took effect, and
// copies brought across workspaces are displayed along with the record.
if (!memoryColumns.has('applies_to')) db.exec(`ALTER TABLE memory ADD COLUMN applies_to TEXT NOT NULL DEFAULT ''`);
if (!memoryColumns.has('origin_scope')) db.exec(`ALTER TABLE memory ADD COLUMN origin_scope TEXT NOT NULL DEFAULT ''`);
if (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id IS NULL').get().n) {
  const created = db.prepare('INSERT INTO conversations(title, created) VALUES (?, ?)').run('过往对话', new Date().toISOString());
  db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id IS NULL').run(Number(created.lastInsertRowid));
}
// Older messages have no timestamp; approximate it with their conversation's
// creation time so chat dividers can group them by day.
db.prepare('UPDATE messages SET time = (SELECT created FROM conversations WHERE id = messages.conversation_id) WHERE time IS NULL').run();

// The default model takes the one specified by MODEL_ID in the catalog (.env), and the UI overrides it per
// session (see /api/conversation-model).
const defaultEntry = defaultModel();
const model = defaultEntry.id;
const modelLive = MODELS.some(modelConfigured);
const events = () => db.prepare('SELECT * FROM events ORDER BY id DESC').all();
const memories = () => db.prepare(`
  SELECT m.*, EXISTS(SELECT 1 FROM memory n WHERE n.replaces = m.id) AS superseded
  FROM memory m ORDER BY id DESC
`).all();
const messages = () => db.prepare('SELECT * FROM messages ORDER BY id').all().map(row => ({
  ...row, review: row.review && JSON.parse(row.review),
}));
function backfillOrphanMessages() {
  if (!db.prepare('SELECT id FROM messages WHERE conversation_id IS NULL LIMIT 1').get()) return;
  let row = db.prepare("SELECT id FROM conversations WHERE title = '过往对话'").get();
  if (!row) row = db.prepare("INSERT INTO conversations(title, created) VALUES ('过往对话', ?)").get(new Date().toISOString());
  db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id IS NULL').run(Number(row.id));
}
const conversations = () => {
  backfillOrphanMessages();
  return db.prepare('SELECT * FROM conversations ORDER BY id').all();
};
const conversationHistory = id => db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(id).map(row => ({
  ...row, review: row.review && JSON.parse(row.review),
}));
const draft = () => db.prepare('SELECT * FROM drafts ORDER BY rowid DESC LIMIT 1').get() ?? null;
const log = (type, version, id = null) =>
  db.prepare('INSERT INTO events(type,version,draft,time) VALUES (?,?,?,?)').run(type, version, id, new Date().toISOString());
const latestAlignment = () => JSON.parse(db.prepare('SELECT report FROM alignment_runs ORDER BY id DESC LIMIT 1').get()?.report ?? 'null');
const memoryDecisions = () => db.prepare('SELECT * FROM memory_decisions ORDER BY id DESC LIMIT 100').all();
// Conversations without an explicit project belong to the default project.
const isReservedProject = project => typeof project === 'string' && project.trim() === GLOBAL_SCOPE;
const projectOf = conversation => {
  const project = (conversation?.project ?? '').trim();
  return project && !isReservedProject(project) ? project : 'DIC2026';
};
function checkProjectName(project) {
  if (isReservedProject(project)) fail(400, '「*」用于全局记忆，不能用作项目名称。');
}
function checkConversationScope(conversation) {
  if (isReservedProject(conversation?.project)) {
    fail(409, '这个旧会话使用了保留的项目名称。请在正确的项目中开启新会话。');
  }
}
// Known workspaces: every named conversation project plus every non-global
// memory scope, so a workspace that only has memory so far is still a valid
// switch target.
const workspaces = () => {
  const names = new Set();
  for (const row of db.prepare("SELECT DISTINCT project FROM conversations WHERE project != ''").all()) {
    if (!isReservedProject(row.project)) names.add(row.project);
  }
  for (const row of db.prepare('SELECT DISTINCT scope FROM memory WHERE scope != ? AND scope != \'\'').all(GLOBAL_SCOPE)) names.add(row.scope);
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
};
// Active preferences and rules visible from a scope: same scope, or global
// on either side (a global edit is checked against every project).
const activeIntent = (scope = GLOBAL_SCOPE) =>
  memories().filter(record => !record.superseded && ['preference', 'rule'].includes(record.kind)
    && scopeMatches(record.scope, scope));
const memorySnapshot = (edit, base, records) =>
  createHash('sha256').update(JSON.stringify([edit, base ?? null, records.map(record => record.id)])).digest('hex');

const state = () => {
  const current = draft();
  const activity = events();
  return { ...workflow.state(), alignment: latestAlignment(), memoryDecisions: memoryDecisions(), tasks: tasks(), taskAudit: taskAudit.list(), memory: memories(), messages: messages(), conversations: conversations(), workspaces: workspaces(), draft: current, events: activity,
    status: current ? releaseStatus(current, activity) : null, live: modelLive, model, models: MODELS.map(entry => ({ id: entry.id, name: entry.name, provider: modelProvider(entry), requiredEffort: Boolean(entry.codex), efforts: Object.keys(entry.efforts ?? {}) })), release, repository };
};

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function required(value, length) {
  if (typeof value !== 'string' || !value.trim() || value.length > length) fail(400, '请检查输入内容。');
  return value.trim();
}

// entry: model item in the catalog (defaults to the default model); effort: UI reasoning effort
// low/medium/high. reasoning_effort is sent with the request only if the effort level is in the model's
// supported list; otherwise, the endpoint uses its own default value.
async function complete(messages, timeout, entry = defaultEntry, effort = null) {
  if (!modelConfigured(entry)) fail(503, '请在本地 .env 配置模型 API，或打开独立的模拟评测。');
  const key = modelKey(entry);
  const endpoint = new URL(entry.base);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  // A loopback bridge can still forward prompts to a hosted provider.
  const bridgePort = Number(process.env.DAYMARK_CODEX_BRIDGE_PORT ?? 4334);
  const hosted = !local || entry.codex || Number(endpoint.port) === bridgePort;
  if (hosted && workflow.hasRestrictedModelInput(messages)) {
    fail(409, '当前请求包含受限原文，托管模型无法使用这部分证据。请改用本地模型或人工复核。');
  }
  if (entry.nativeGemini) {
    try { return await geminiTextReply({ model: entry.id, messages, key, timeout: timeout ?? entry.timeout }); }
    catch { fail(502, '模型连接失败，请检查服务地址或网络。'); }
  }
  const params = { model: entry.id, max_tokens: 2048, messages,
    ...(entry.codex ? { reasoning_effort: effort ?? 'low', service_tier: 'default' }
      : !local && Object.hasOwn(entry.efforts ?? {}, effort) ? { reasoning_effort: entry.efforts[effort] } : {}),
    ...(local ? { response_format: { type: "json_object" } } : {}) };
  const response = await fetch(entry.base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    signal: AbortSignal.timeout(timeout ?? entry.timeout ?? 18000),
    body: JSON.stringify(params),
  }).catch(() => fail(502, '模型连接失败，请检查服务地址或网络。'));
  if (!response.ok) {
    // Upstream errors (such as opencode free pool quota exhaustion, reasoning_effort not accepted) are
    // returned to the UI along with the status code.
    const upstream = (await response.json().catch(() => null))?.error?.message;
    const detail = typeof upstream === 'string' && upstream.trim() ? ' 上游：' + upstream.trim().slice(0, 300) : '';
    fail(502, `模型服务返回 HTTP ${response.status}。请检查模型、凭证和账户配置。${detail}`);
  }
  const result = await response.json().catch(() => null);
  const raw = result?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string' || !raw.trim()) fail(502, '模型没有返回可核查的答复，请重试。');
  return raw;
}

const workflow = opportunityWorkflow(db, { complete, model, fail, required });

async function modelReply(question, language, active, recent, decisions = null, conversation = null, entry = defaultEntry, effort = null) {
  const history = recent.filter((message, index) => !(message.review?.temporary ||
    (message.role === 'user' && recent[index + 1]?.review?.temporary)))
    .slice(-14)
    .map(({ role, body }) => ({ role, content: body }));
  const current = draft();
  const messages = chatReplyMessages({
    language,
    active,
    decisions,
    release,
    verified: Boolean(current) && releaseStatus(current, events()) === 'ready',
    history,
    question,
  });
  const raw = await complete(messages, null, entry, effort);
  let review;
  let plain = false;
  try {
    review = JSON.parse(raw?.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ''));
    required(review.answer, 16000);
  } catch {
    review = { answer: raw.trim().slice(0, 16000) };
    plain = true;
    if (!review.answer) fail(502, '模型没有返回可核查的答复，请重试。');
  }
  const ids = Array.isArray(review.citations) ? review.citations : [];
  const cited = active.filter(record => ids.includes(record.id));
  const facts = verifiedQuotes(review.facts, active.filter(record => ['fact', 'source'].includes(record.kind)));
  const stringList = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 8) : [];
  // An unconfirmed proposal surfaced from the exchange; the user decides
  // whether to keep it as a pending proposal (kind=proposal).
  let proposal = null;
  if (review.proposal && typeof review.proposal.body === 'string' && review.proposal.body.trim()) {
    let messageId = Number.isSafeInteger(review.proposal.message_id) ? review.proposal.message_id : null;
    if (messageId != null && (!conversation ||
        !db.prepare('SELECT id FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, conversation.id))) {
      messageId = null;
    }
    proposal = { body: review.proposal.body.trim().slice(0, 400), message_id: messageId };
  }
  return { answer: review.answer, cited, facts, inferences: stringList(review.inferences),
    unknowns: stringList(review.unknowns), mode: 'model', modelId: entry.id, plain, conflict: typeof review.conflict === 'string' ? review.conflict : '',
    question: typeof review.question === 'string' ? review.question : '',
    understood: typeof review.understood === 'string' ? review.understood : '', proposal,
    language: language === 'en' ? 'en' : 'zh-CN' };
}

async function chatClaimCheck(review, retrieved, language) {
  // Verification uses the default workflow model; the actual model used is recorded in claimCheck.model
  // for the evidence panel and tracing.
  const checkEntry = defaultEntry;
  const at = new Date().toISOString();
  try {
    const raw = await complete(
      chatClaimMessages({ answer: review.answer, sources: chatClaimSources(retrieved), language }),
      90000, checkEntry, null);
    const { claims } = parseClaimReport(raw, { mode: 'chat' });
    const verified = verifyClaims(
      claims.filter(claim => CHAT_CLAIM_DIMENSIONS.includes(claim.dimension)),
      chatClaimSources(retrieved),
      { body: review.answer, identity: 'workspace' });
    return { prompt: CHAT_CLAIMS_PROMPT_VERSION, model: checkEntry.id, at, summary: chatClaimSummary(verified, null), claims: verified };
  } catch (error) {
    return { prompt: CHAT_CLAIMS_PROMPT_VERSION, model: checkEntry.id, at,
      error: error?.status ? error.message : (error?.reason ?? 'unknown'),
      summary: chatClaimSummary([], error?.status ? error.message : (error?.reason ?? 'unknown')),
      claims: [] };
  }
}

async function reply(question, language, temporary, conversationId, projectName, requestModel = null, requestEffort = null) {
  let conversation;
  if (conversationId == null) {
    checkProjectName(projectName);
    // A new conversation inherits the workspace named by the caller (an
    // empty/absent project stays ungrouped and reads the default scope). Its
    // model/thinking level comes from the composer selector; values outside
    // the catalog (or unsupported levels) fall back to the defaults.
    const newEntry = modelById(requestModel) ?? defaultEntry;
    if (newEntry.codex && requestEffort && !Object.hasOwn(newEntry.efforts, requestEffort)) fail(400, '此模型不支持该思考强度。');
    const { effort: newEffort } = conversationModel({ model: newEntry.id, effort: requestEffort }, newEntry);
    conversation = Number(db.prepare('INSERT INTO conversations(title, project, created, model, effort) VALUES (?,?,?,?,?)')
      .run(question.slice(0, 30), typeof projectName === 'string' ? projectName.trim().slice(0, 60) : '', new Date().toISOString(), newEntry.id, newEffort).lastInsertRowid);
  } else if (!Number.isSafeInteger(conversationId) ||
      !db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId)) {
    fail(404, '找不到这个对话。');
  } else {
    conversation = conversationId;
  }
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation);
  checkConversationScope(conv);
  // The model and reasoning effort configured for this session determine this round of invocation
  // (defaults to the default model and endpoint default effort when not configured).
  const { entry, effort } = conversationModel(conv, defaultEntry);
  if (!modelConfigured(entry)) fail(503, '未配置模型，无法使用对话。');
  // Long-term memory is project-scoped: a new chat retrieves records of its
  // own project plus records saved as global.
  const project = projectOf(conv);
  const records = recordsInScope(memories(), project).filter(row => !row.superseded);
  let retrieved = [];
  const recent = conversationHistory(conversation);
  const previous = recent.at(-1)?.review;
  const clarification = previous?.temporary ? '' : previous?.question;
  const retrievalQuery = clarification ? question + '\n' + clarification.slice(0, 350) : question;
  // Conversations always go through model answers (local query mode removed)
  // Shared memory window: search results uniformly use the recordProvenance view, carrying applicable
  // objects (applies_to) and original projects (origin, records brought across workspaces). Models and
  // evidence panels use this to distinguish general practices from clauses with clearly applicable
  // objects.
  retrieved = rankRecords(retrievalQuery, records).filter(match => match.score > 0).slice(0, 12).map(match => recordProvenance(match.record));
  // The user's previous decision card selection is sent back to the model, so subsequent follow-ups can
  // refer to the newly selected item or time slot.
  const decisions = decisionContext(recent);
  let review = await modelReply(question, language, retrieved, recent, decisions, conv, entry, effort);
  if (review.unknowns.length && !review.conflict) {
    const gap = review.unknowns.slice(0, 2).join(' ').slice(0, 500);
    const used = new Set(retrieved.map(record => record.id));
    const extra = rankRecords(gap, records.filter(record => !used.has(record.id) && ['fact', 'source'].includes(record.kind)))
      .filter(match => match.score >= 2).slice(0, 4).map(match => recordProvenance(match.record));
    if (extra.length) {
      retrieved.push(...extra);
      try {
        review = await modelReply(question, language, retrieved, recent, decisions, conv, entry, effort);
        review.gapRetrieval = { query: gap, ids: extra.map(record => record.id), status: 'completed' };
      } catch (error) {
        if (!error.status) throw error;
        review.gapRetrieval = { query: gap, ids: extra.map(record => record.id), status: 'failed' };
      }
    }
  }
  review.temporary = temporary;
  review.evidence = review.plain ? 'plain'
    : (review.facts?.length ?? 0) > 0 ? 'verbatim'
    : (review.cited?.length ?? 0) > 0 ? 'cited' : 'uncited';
  review.trace = {
    attemptedModel: entry.id,
    modelEffort: effort ?? '',
    // The workspace this reply actually read: the conversation's project
    // (plus global records). Shown in the evidence panel so the user can
    // confirm the material range. '' = ungrouped chat (default scope).
    scope: (conv.project ?? '').trim(),
    retrieved: retrieved.map(record => ({
      id: record.id, kind: record.kind, scope: record.scope, source: record.source,
      // Shared memory window: applies_to always carries the applicable target; origin is only carried when
      // brought across workspaces, and the evidence panel uses it to indicate where the record came from
      // and which terms constrain whom.
      applies_to: record.applies_to,
      ...(record.origin ? { origin: record.origin } : {}),
    })),
    matchedQuotes: review.facts?.length ?? 0,
    retrievalQuery,
    gapRetrieval: review.gapRetrieval ?? null,
    result: 'model',
  };
  // Conflict / uncertainty in this reply becomes an interactive decision card.
  // Only this conversation's scope (project + global) may anchor the card.
  review.decision = detectDecision({ question, review, tasks: tasks(),
    memories: recordsInScope(memories(), project), retrieved, scope: project });
  review.claimCheck = await chatClaimCheck(review, retrieved, language);
  const insert = db.prepare('INSERT INTO messages(role,body,review,conversation_id,time) VALUES (?,?,?,?,?)');
  const firstMessage = !db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1').get(conversation);
  const sentAt = new Date().toISOString();
  db.exec('BEGIN');
  try {
    insert.run('user', question, null, conversation, sentAt);
    insert.run('assistant', review.answer, JSON.stringify(review), conversation, sentAt);
    if (firstMessage) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(question.slice(0, 30), conversation);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ...state(), conversation };
}

const mutations = {
  ...workflow.mutations,
  '/api/speech': async ({ text, voice, style }) => {
    const input = required(text, 4000);
    if (!process.env.GEMINI_API_KEY?.trim()) fail(503, '请配置 GEMINI_API_KEY。');
    if (workflow.hasRestrictedModelInput([{ role: 'user', content: input + '\n' + (typeof style === 'string' ? style : '') }])) {
      fail(409, '当前请求包含受限原文，托管模型无法使用这部分证据。请改用本地模型或人工复核。');
    }
    try {
      const result = await synthesizeSpeech({ text: input, voice: required(voice ?? 'Kore', 100), style: typeof style === 'string' ? style.slice(0, 500) : '' });
      return { model: result.model, mimeType: result.mimeType, data: result.bytes.toString('base64') };
    } catch { fail(502, 'Gemini 语音请求失败，请检查密钥、配额和网络。'); }
  },
  '/api/live-translate': async ({ audio, targetLanguage }) => {
    if (!process.env.GEMINI_API_KEY?.trim()) fail(503, '请配置 GEMINI_API_KEY。');
    const encoded = required(audio, 1300000);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail(400, '请检查输入内容。');
    if (!['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de'].includes(targetLanguage)) fail(400, '请检查输入内容。');
    try {
      return await translateRecording({ wav: Buffer.from(encoded, 'base64'), targetLanguage });
    } catch (error) {
      if (/WAV/.test(error.message)) fail(400, error.message);
      fail(502, 'Gemini 翻译请求失败，请检查音频、密钥、配额和网络。');
    }
  },
  '/api/embedding': async ({ text }) => {
    const input = required(text, 12000);
    if (!process.env.GEMINI_API_KEY?.trim()) fail(503, '请配置 GEMINI_API_KEY。');
    if (workflow.hasRestrictedModelInput([{ role: 'user', content: input }])) {
      fail(409, '当前请求包含受限原文，托管模型无法使用这部分证据。请改用本地模型或人工复核。');
    }
    const started = performance.now();
    try {
      const result = await embedText({ text: input });
      return { ...result, elapsedMs: Math.round(performance.now() - started), characters: input.length };
    } catch { fail(502, 'Gemini Embedding 请求失败，请检查密钥、配额和网络。'); }
  },
  '/api/alignment-benchmark': async ({ language }) => {
    const report = await runAlignmentBenchmark(complete, model, language === 'zh-CN' ? language : 'en');
    db.prepare('INSERT INTO alignment_runs(report) VALUES (?)').run(JSON.stringify(report));
  },
  '/api/memory-impact': async ({ kind, scope, body, replaces, classify, language }) => {
    if (!['fact', 'preference', 'rule', 'proposal', 'source'].includes(kind)) fail(400, '请选择记录类型。');
    const edit = { kind, scope: required(scope, 100), body: required(body, kind === 'source' ? 16000 : 4000) };
    // Pre-save review is scoped: same project plus global records (a global
    // edit is checked against every project).
    const records = activeIntent(edit.scope);
    const snapshot = memorySnapshot(edit, replaces, records);
    const candidates = memoryCandidates(edit, records.filter(record => record.id !== replaces));
    let classifications = [];
    let classificationError = '';
    if (classify === true && candidates.length) {
      try {
        const raw = await complete(memoryConflictMessages({ language, edit, candidates }));
        const parsed = JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ''));
        classifications = Array.isArray(parsed?.items) ? parsed.items : [];
      } catch (error) {
        classificationError = error.status ? error.message : '模型没有返回可核查的答复，请重试。';
      }
    }
    return { impact: candidates.map(record => {
      const item = classifications.find(row => row?.id === record.id && ['direct','ambiguous','none'].includes(row.type));
      return { ...record, classification: item?.type ?? 'unreviewed',
        reason: typeof item?.reason === 'string' ? item.reason : '',
        question: typeof item?.question === 'string' ? item.question : '' };
    }), classificationError, snapshot };
  },
  // Extract long-term memory candidates from a conversation. The model
  // proposes content, kind, scope, confirmation status and the source
  // message; saving still goes through the existing /api/memory route
  // (including the pre-save review for preferences and rules).
  '/api/memory-candidates': async ({ conversation_id, language }) => {
    if (!modelConfigured(defaultEntry)) fail(503, '未配置模型，无法使用对话。');
    if (!Number.isSafeInteger(conversation_id) ||
        !db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversation_id)) fail(404, '找不到这个对话。');
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id);
    checkConversationScope(conversation);
    const scope = projectOf(conversation);
    const history = conversationHistory(conversation.id)
      .filter((message, index, list) => !(message.review?.temporary ||
        (message.role === 'user' && list[index + 1]?.review?.temporary))).slice(-14)
      .map(({ id, role, body }) => ({ id, role, body: body.slice(0, 2000) }));
    if (!history.length) return { candidates: [], scope, conversation: conversation.id, project: conversation.project };
    const raw = await complete(memoryExtractionMessages({ language, scope, history }));
    let parsed;
    try {
      parsed = JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ''));
    } catch {
      parsed = null;
    }
    const candidates = normalizeCandidates(parsed?.candidates, {
      messageIds: history.map(item => item.id), project: scope });
    return { candidates, scope, conversation: conversation.id, project: conversation.project };
  },
  '/api/memory': ({ kind, scope, body, source, replaces, review_base, snapshot, message_id, applies_to }) => {
    if (!['fact', 'preference', 'rule', 'proposal', 'source'].includes(kind)) fail(400, '请选择记录类型。');
    const messageId = message_id === '' || message_id == null ? null : message_id;
    if (messageId != null && (!Number.isSafeInteger(messageId) ||
        !db.prepare('SELECT id FROM messages WHERE id = ?').get(messageId))) fail(400, '找不到对应的对话消息。');
    const old = replaces == null ? null : memories().find(record => record.id === replaces);
    if (replaces != null && (!old || old.superseded)) fail(409, '原记录已变更，请刷新后重试。');
    const edit = { kind, scope: required(scope, 100), body: required(body, kind === 'source' ? 16000 : 4000) };
    const origin = required(source, 500);
    // Applicable target (shared-memory window): Empty = consistent with the scope (derived by scope on
    // read); '*' (universal, all projects) or specific client/project names can be explicitly saved.
    // Out-of-bounds values are treated as empty.
    const appliesTo = applies_to === undefined && old ? effectiveAppliesTo(old) : normalizeAppliesTo(applies_to);
    // Origin project captured at save time: For records extracted from specific chat messages, record the
    // project of the session to which the message belongs (ungrouped sessions fall back to the record's
    // own scope); for records saved directly via forms, the origin project is the scope itself. Display
    // and model context carry the origin field only when origin != scope.
    let originScope = old?.origin_scope || old?.scope || edit.scope;
    if (!old && messageId != null) {
      const owner = db.prepare('SELECT c.project FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?')
        .get(messageId);
      originScope = (owner?.project ?? '').trim() || edit.scope;
    }
    const needsReview = ['preference', 'rule'].includes(kind) || ['preference', 'rule'].includes(old?.kind);
    // The reviewed snapshot is bound to the same scope as the pre-save check.
    const records = needsReview ? activeIntent(edit.scope) : [];
    const base = review_base ?? null;
    const candidates = needsReview ? memoryCandidates(edit, records.filter(record => record.id !== base)) : [];
    if (needsReview && (snapshot !== memorySnapshot(edit, base, records) ||
        (old && old.id !== base && !candidates.some(record => record.id === old.id)))) {
      fail(409, '记忆核查已过期，请重新查看影响范围。');
    }
    db.exec('BEGIN');
    try {
      const result = db.prepare('INSERT INTO memory(kind,scope,body,source,replaces,message_id,applies_to,origin_scope) VALUES (?,?,?,?,?,?,?,?)')
        .run(kind, edit.scope, edit.body, origin, old?.id ?? null, messageId ?? null, appliesTo, originScope);
      if (needsReview) db.prepare('INSERT INTO memory_decisions(record,detail,time) VALUES (?,?,?)')
        .run(result.lastInsertRowid, JSON.stringify({ action: old ? 'replace' : 'keep', replaced: old?.id ?? null,
          scope: edit.scope, candidates: candidates.map(record => record.id) }), new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },
  // Explicitly importing records across workspaces (workspace-isolation window): After the user explicitly
  // selects records to import, the server copies them to the target workspace; the new record's source
  // retains the original workspace, original record ID, and original source, while the original record
  // remains untouched. It is not associated with message_id to prevent accidental deletion of imported
  // copies in other workspaces when deleting the original workspace session. Repeated imports are
  // idempotent.
  '/api/memory-import': ({ record_id, scope }) => {
    if (!Number.isSafeInteger(record_id)) fail(400, '请求内容不正确。');
    if (typeof scope !== 'string' || !scope.trim() || scope.trim().length > 100) fail(400, '请检查输入内容。');
    const origin = db.prepare('SELECT * FROM memory WHERE id = ?').get(record_id);
    if (!origin) fail(404, '找不到要带入的记录。');
    if (db.prepare('SELECT 1 FROM memory WHERE replaces = ? LIMIT 1').get(record_id)) {
      fail(409, '这条记录已被修订，请带入修订后的版本。');
    }
    const target = scope.trim();
    if (origin.scope === target) fail(400, '记录已属于该工作区。');
    if (origin.scope === GLOBAL_SCOPE) fail(400, '全局记录已对所有工作区可见，无需带入。');
    const provenance = ('来自「' + origin.scope + '」的记录 #' + origin.id + ' · ' + origin.source).slice(0, 500);
    const existing = db.prepare('SELECT id FROM memory WHERE scope = ? AND source = ?').get(target, provenance);
    if (existing) return { ...state(), imported: existing.id, already: true };
    const result = db.prepare('INSERT INTO memory(kind, scope, body, source, applies_to, origin_scope) VALUES (?,?,?,?,?,?)')
      .run(origin.kind, target, origin.body, provenance, effectiveAppliesTo(origin), origin.origin_scope || origin.scope);
    return { ...state(), imported: Number(result.lastInsertRowid), already: false };
  },
  // Decision card confirmation (/api/decision) is built by createDecisionRoute below: a selection is
  // recorded as soon as it is made (selected pending confirmation, nothing written);
  // confirm=true runs the option's effect through the same handlers and
  // confirmation rules as its direct route (/api/task is revision-gated,
  // /api/memory checks the impact snapshot). Confirms for one card are
  // serialized (double click / two tabs / retries), a recheck failure pauses
  // the card in place (deferred), and a committed write whose receipt save failed
  // is recovered from the existing records (task_audit / memory row) so the
  // receipt always matches the actual result.
  '/api/decision': null,
  '/api/task': ({ id, revision, title, starts, ends, memory_id, all_day = false, location = '', notes = '', via }) => {
    if (typeof all_day !== 'boolean') fail(400, '请求内容不正确。');
    if (all_day) {
      starts = typeof starts === 'string' ? starts + 'T00:00' : starts;
      ends = typeof ends === 'string' ? ends + 'T00:00' : ends;
    }
    const valid = value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
      const date = new Date(value + 'Z');
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value;
    };
    if (!valid(starts) || !valid(ends) || ends <= starts) fail(400, '请选择有效的开始和结束时间。');
    if (memory_id != null && (!Number.isSafeInteger(memory_id) || !db.prepare('SELECT id FROM memory WHERE id = ?').get(memory_id))) {
      fail(400, '找不到关联的来源记录。');
    }
    if (typeof location !== 'string' || location.length > 500 || typeof notes !== 'string' || notes.length > 4000) {
      fail(400, '请检查输入内容。');
    }
    const fields = [required(title, 200), starts, ends, memory_id ?? null, Number(all_day), location.trim(), notes.trim()];
    // Todo changes and operation logs are committed in the same transaction: on 409/failure, both are
    // rolled back together, leaving no erroneous success records.
    if (id == null) {
      db.exec('BEGIN');
      try {
        const result = db.prepare('INSERT INTO tasks(title, starts, ends, memory_id, all_day, location, notes) VALUES (?,?,?,?,?,?,?)').run(...fields);
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(result.lastInsertRowid));
        taskAudit.record(row, 'created', null, via);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } else {
      if (!Number.isSafeInteger(id) || !Number.isSafeInteger(revision)) fail(400, '请求内容不正确。');
      db.exec('BEGIN');
      try {
        const before = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted = 0').get(id);
        const result = db.prepare(`UPDATE tasks SET title=?, starts=?, ends=?, memory_id=?, all_day=?,
          location=?, notes=?, revision=revision+1 WHERE id=? AND revision=? AND deleted=0`).run(...fields, id, revision);
        if (!result.changes) fail(409, '事件已变更，请刷新后重试。');
        const after = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        taskAudit.record(after, 'updated', before, via);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  },
  '/api/task-delete': ({ id, revision, via }) => {
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(revision)) fail(400, '请求内容不正确。');
    db.exec('BEGIN');
    try {
      const before = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted = 0').get(id);
      const result = db.prepare('UPDATE tasks SET deleted=1, revision=revision+1 WHERE id=? AND revision=? AND deleted=0').run(id, revision);
      if (!result.changes) fail(409, '事件已变更，请刷新后重试。');
      const after = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      taskAudit.record(after, 'deleted', before, via);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
  '/api/task-status': ({ id, done, via }) => {
    if (!Number.isSafeInteger(id) || typeof done !== 'boolean') fail(400, '请求内容不正确。');
    const next = Number(done);
    db.exec('BEGIN');
    try {
      const before = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted = 0').get(id);
      if (!before) fail(404, '找不到这条待办。');
      if (Number(before.done) === next) {
        db.exec('ROLLBACK');
        return; // Duplicate request: state unchanged, no operation log written
      }
      db.prepare('UPDATE tasks SET done = ? WHERE id = ?').run(next, id);
      const after = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      taskAudit.record(after, next ? 'done' : 'reopened', before, via);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
  '/api/demo': () => {
    const insert = db.prepare('INSERT INTO memory(kind,scope,body,source) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM memory WHERE source = ?)');
    for (const item of demoRecords) insert.run(item.kind, item.scope, item.body, item.source, item.source);
  },
  // Pre-send switch detection: run the deterministic rules (explicit switch
  // phrasing + known workspace names) first, then let the model judge
  // ambiguous topic changes. The model only suggests; the route validates
  // that the target workspace exists. Uncertain judgment or a failed assist
  // keeps the original input ('continue') and the manual switch entry.
  '/api/chat-intent': async ({ text, conversation_id, language }) => {
    const input = required(text, 6000);
    const known = workspaces();
    const conv = conversation_id == null ? null : db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id);
    if (conversation_id != null && !conv) fail(404, '找不到这个对话。');
    checkConversationScope(conv);
    const current = (conv?.project ?? '').trim();
    const base = { current, workspaces: known };
    const rule = ruleIntent(input, known, current);
    if (rule) return { ...base, ...rule };
    let intent = { action: 'continue', workspace: '', involved: [], reason: '' };
    if (modelConfigured(defaultEntry)) {
      const recent = conversationHistory(conv?.id ?? -1).slice(-6)
        .map(({ role, body }) => ({ role, body: String(body).slice(0, 300) }));
      try {
        const raw = await complete(chatIntentMessages({
          language, current, workspaces: known, recent, input,
        }), 45000);
        const parsed = normalizeIntent(JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, '')), { workspaces: known, current });
        if (parsed) {
          intent = parsed;
          if (intent.action === 'compare') intent.involved = workspaceMentions(input, known, current).mentionsAll;
        }
      } catch {
        // Assist failed: keep the original input and the manual switch entry.
        intent = { action: 'continue', workspace: '', involved: [], reason: '' };
      }
    }
    return { ...base, ...intent };
  },
  // useModel is still referenced by external scripts; it is kept for compatibility but no longer
  // differentiates: all chats go through the model. project only takes effect when conversation_id is
  // omitted (new chat): new chats inherit the selected workspace. model/effort work similarly: they only
  // initialize the session's model and reasoning tier when creating a new chat.
  '/api/chat': ({ text, language, useModel = true, temporary, conversation_id, project, model: chatModel, effort }) =>
    reply(required(text, 6000), language, temporary === true, conversation_id, project, chatModel, effort),
  // Session-level model/tier switching (multi-model window): validated and written to the session, to be
  // read by subsequent /api/chat generation of replies.
  '/api/conversation-model': ({ id, model: chatModel, effort }) => {
    if (!Number.isSafeInteger(id) || !db.prepare('SELECT id FROM conversations WHERE id = ?').get(id)) {
      fail(404, '找不到这个对话。');
    }
    const stored = db.prepare('SELECT model, effort FROM conversations WHERE id = ?').get(id);
    const entry = modelById(chatModel ?? stored.model) ?? (chatModel == null ? defaultEntry : null);
    if (!entry) fail(400, '模型不存在，请刷新后重试。');
    if (effort && !Object.hasOwn(entry.efforts ?? {}, effort)) fail(400, '此模型不支持该思考强度。');
    const nextEffort = effort ?? stored.effort;
    db.prepare('UPDATE conversations SET model = ?, effort = ? WHERE id = ?').run(
      entry.id, Object.hasOwn(entry.efforts ?? {}, nextEffort) ? nextEffort : entry.codex ? 'low' : null, id);
  },
  '/api/conversation': ({ title, project, model: chatModel, effort }) => {
    if (title != null && typeof title !== 'string') fail(400, '请检查输入内容。');
    if (project != null && (typeof project !== 'string' || project.length > 60)) fail(400, '请检查输入内容。');
    checkProjectName(project);
    const entry = modelById(chatModel) ?? defaultEntry;
    if (entry.codex && effort && !Object.hasOwn(entry.efforts, effort)) fail(400, '此模型不支持该思考强度。');
    const { effort: initialEffort } = conversationModel({ model: entry.id, effort }, entry);
    const result = db.prepare('INSERT INTO conversations(title, project, created, model, effort) VALUES (?,?,?,?,?)')
      .run(typeof title === 'string' && title.trim() ? title.trim().slice(0, 60) : '新对话',
        typeof project === 'string' ? project.trim() : '', new Date().toISOString(), entry.id, initialEffort);
    return { ...state(), conversation: Number(result.lastInsertRowid) };
  },
  '/api/conversation-edit': ({ id, title, project }) => {
    if (!Number.isSafeInteger(id) || !db.prepare('SELECT id FROM conversations WHERE id = ?').get(id)) {
      fail(404, '找不到这个对话。');
    }
    const sets = [];
    const args = [];
    if (title != null) {
      if (typeof title !== 'string' || !title.trim() || title.length > 60) fail(400, '请检查输入内容。');
      sets.push('title = ?');
      args.push(title.trim());
    }
    if (project != null) {
      if (typeof project !== 'string' || project.length > 60) fail(400, '请检查输入内容。');
      checkProjectName(project);
      // Cross-workspace isolation (workspace-isolation window): Moving a session with historical messages
      // across workspaces will carry old quotes, commitments, and decision cards into the subsequent
      // context of the new workspace, so it is rejected; sessions without messages are just changing
      // ownership and can be moved.
      const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
      if ((isReservedProject(conversation.project) || projectOf(conversation) !== projectOf({ project })) &&
          db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1').get(id)) {
        fail(409, '带消息的会话不能直接跨工作区移动：历史会带着旧报价、承诺和决策卡进入新工作区。请在目标工作区开新对话，或明确带入需要的记录。');
      }
      sets.push('project = ?');
      args.push(project.trim());
    }
    if (sets.length) db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  },
  // Cross-workspace context isolation (workspace-isolation window; aligned with the window handling
  // general chat/uncertainty replies: only changes dialogue routing, does not touch
  // reply()/modelReply()/decision card chains): Merging within the same workspace moves history as usual;
  // cross-workspace merging will carry quotes, customer commitments, and decision cards from the old chat
  // into the context of subsequent answers in the target workspace, so it is rejected. To continue working
  // across workspaces, please open a new chat in the target workspace (bringing in the current input), and
  // explicitly import records via /api/memory-import when you need to reference each other's materials.
  '/api/conversation-merge': ({ id, target }) => {
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(target) || id === target) fail(400, '请求内容不正确。');
    const source = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    const goal = db.prepare('SELECT * FROM conversations WHERE id = ?').get(target);
    if (!source || !goal) fail(404, '找不到这个对话。');
    checkConversationScope(source);
    checkConversationScope(goal);
    if (projectOf(source) !== projectOf(goal)) {
      fail(409, '跨工作区不能直接并入：旧对话的报价、承诺和决策卡不会跟着历史一起移动。请在目标工作区开新对话，或明确带入需要的记录。');
    }
    db.exec('BEGIN');
    db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?').run(target, id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    db.exec('COMMIT');
  },
  '/api/conversation-delete': ({ id }) => {
    if (!Number.isSafeInteger(id)) fail(400, '请求内容不正确。');
    db.exec('BEGIN');
    const removed = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    if (!removed.changes) {
      db.exec('ROLLBACK');
      fail(404, '找不到这个对话。');
    }
    // Memories saved from this conversation's messages go with it, along with any later revisions of those memories.
    const seeds = db.prepare('SELECT m.id FROM memory m JOIN messages msg ON msg.id = m.message_id WHERE msg.conversation_id = ?').all(id);
    const doomed = new Set(seeds.map(row => row.id));
    let frontier = seeds.map(row => row.id);
    while (frontier.length) {
      frontier = db.prepare(`SELECT id FROM memory WHERE replaces IN (${frontier.map(() => '?').join(',')})`)
        .all(...frontier).map(row => row.id).filter(row => !doomed.has(row));
      for (const row of frontier) doomed.add(row);
    }
    if (doomed.size) db.prepare(`DELETE FROM memory WHERE id IN (${[...doomed].map(() => '?').join(',')})`).run(...[...doomed]);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    db.exec('COMMIT');
  },
  '/api/draft': ({ body }) => {
    db.prepare('INSERT INTO drafts VALUES (?,?,?)').run(randomUUID(), release, required(body, 12000));
  },
  '/api/verify': () => {
    // Passing tests records binding to the current draft (revision): when subsequent edits to the draft
    // produce a new version, this record is no longer passed and must be re-verified against the new
    // version.
    const current = draft();
    log('verified', release, current ? current.id : null);
  },
  '/api/publish': ({ id }) => {
    const current = draft();
    if (!current || current.id !== id) {
      log('blocked_revision', release, typeof id === 'string' ? id.slice(0, 100) : null);
      fail(409, '草稿已变更，请重新核对后确认。');
    }
    const status = releaseStatus(current, events());
    if (status === 'published') {
      // Duplicate publishing: does not generate a second published entry, but the attempt itself leaves an
      // audit log.
      log('duplicate_publish', release, current.id);
      return;
    }
    const target = { kind: 'publish', scope: current.version, revision: current.id };
    // This route is the local user's explicit action. Chat has no access to it.
    const authority = { ...target, principal: 'owner', state: 'accepted' };
    if (actionDecision(target, authority, status === 'ready') !== 'allowed') {
      log('blocked_evidence', current.version, current.id);
      fail(409, '缺少当前版本的模拟测试通过记录。');
    }
    log('published', current.version, id);
  },
};
// Decision-card confirm execution: per-card serialization,
// confirm-time recheck, idempotent receipt recovery from the existing
// records (task_audit via / memory.message_id), and the card states.
mutations['/api/decision'] = createDecisionRoute({ db, tasks, memories, mutations, state, fail });

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/i18n.js', ['i18n.js', 'text/javascript']],
  ['/opportunity-ui.js', ['opportunity-ui.js', 'text/javascript']],
  ['/decision-ui.js', ['decision-ui.js', 'text/javascript']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/policy.mjs', ['../src/policy/policy.mjs', 'text/javascript']],
  // Chat assertion check (window 2/3): The top status determination of the answer uses the same
  // implementation as the backend (when old messages lack the summary field, the UI uses the same local
  // function to compute it, keeping the criteria consistent).
  ['/chat-claims.mjs', ['../src/chat/chat-claims.mjs', 'text/javascript']],
  // Window 2: Pure function for the answer top status title (summary -> text), shared between app.js and
  // unit tests.
  ['/claim-top.mjs', ['claim-top.mjs', 'text/javascript']],
]);
const port = Number(process.env.PORT ?? 4173);
createServer(async (req, res) => {
  try {
    if (req.headers.host !== '127.0.0.1:' + port) fail(403, '请使用本地启动地址。');
    const route = req.url;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.method === 'GET' && assets.has(route)) {
      const [file, mime] = assets.get(route);
      res.setHeader('Content-Type', mime + '; charset=utf-8');
      return res.end(await readFile(new URL('./dist/' + file, import.meta.url)));
    }
    if (req.method === 'GET' && (route === '/calendar.ics' || /^\/calendar\/\d+\.ics$/.test(route))) {
      const id = /^\/calendar\/(\d+)\.ics$/.exec(route)?.[1];
      const selected = id ? tasks().filter(task => String(task.id) === id) : tasks();
      if (id && !selected.length) fail(404, '找不到这条待办。');
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="daymark' + (id ? '-' + id : '') + '.ics"');
      return res.end(calendarFile(selected, calendarId));
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && route === '/api/alignment-report') {
      const report = latestAlignment();
      if (!report) fail(404, '页面不存在。');
      res.setHeader('Content-Disposition', 'attachment; filename="daymark-alignment-report.json"');
      return res.end(JSON.stringify(report, null, 2));
    }
    if (req.method === 'GET' && route === '/api/opportunity-report') {
      const report = workflow.state().benchmark;
      if (!report) fail(404, '页面不存在。');
      res.setHeader('Content-Disposition', 'attachment; filename="daymark-model-evaluation.json"');
      return res.end(JSON.stringify(report, null, 2));
    }
    // Send archive export (send-archive window): Returns the stored archive JSON (self-contained snapshot,
    // no recalculation). Manual freeze writes are handled in the /api/opportunity-archive change endpoint
    // of opportunities.mjs; automatic writes at the sending moment are hooked up by window 1 on the same
    // schema.
    const archiveMatch = /^\/api\/opportunity-archive\/([^/]+)$/.exec(route);
    if (req.method === 'GET' && archiveMatch) {
      const row = loadArchiveRow(db, archiveMatch[1]);
      // 404 is returned only if the row does not exist; if bytes are modified into invalid JSON, it is
      // still exported as-is (tampering itself is evidence, and exporting is a means of preserving it).
      if (!row) fail(404, '页面不存在。');
      const integrity = archiveIntegrity(db, row.opportunity, row.id, row.raw);
      res.setHeader('X-Archive-Integrity', integrity.status);
      res.setHeader('Content-Disposition', 'attachment; filename="daymark-send-archive-' + row.id + '.json"');
      return res.end(row.raw);
    }
    if (req.method === 'GET' && route === '/api/state') return res.end(JSON.stringify(state()));
    if (req.method !== 'POST' || !Object.hasOwn(mutations, route)) fail(404, '页面不存在。');
    if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) fail(403, '请求来源不匹配。');
    if (req.headers['content-type'] !== 'application/json') fail(415, '需要 JSON 请求。');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > (route === '/api/live-translate' ? 1350000 : 64000)) fail(413, '请求内容过长。');
      chunks.push(buf);
    }
    const payload = Buffer.concat(chunks).toString('utf8');
    let input;
    try { input = JSON.parse(payload); } catch { fail(400, 'JSON 格式不正确。'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '请求内容不正确。');
    const result = await mutations[route](input);
    res.end(JSON.stringify(result ?? state()));
  } catch (error) {
    res.statusCode = error.status ?? 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error.status ? error.message : 'Daymark 暂时无法处理这项请求。' }));
  }
}).listen(port, '127.0.0.1', () => console.log(`Daymark · http://127.0.0.1:${port}`));
