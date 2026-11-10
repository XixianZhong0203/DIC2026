#!/usr/bin/env node
// Replay the reply-evidence acceptance input against a running Daymark server.
// Seeds the known demo record, asks one answerable question in model mode and
// one in local mode, then prints the persisted evidence classification for
// each reply. Window 3 runs this after connecting qwen2.5:3b and compares the
// model-mode result against the recorded 0.5b baseline.
//
// Usage: node scripts/replay-evidence.mjs [port]   (default 4173)
//
// Expected with qwen2.5:3b (if it follows the JSON contract):
//   model: evidence=verbatim with fact #1 quoting a substring of record #1
//          ("v0.1 已通过测试。"). If 3b still omits "facts", expect evidence=cited
//          or uncited — that is the capability gap the benchmark should quantify.

const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
const base = `http://127.0.0.1:${port}`;

async function api(path, body) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${data?.error ?? res.statusText}`);
  return data;
}

function summarize(review) {
  return {
    mode: review.mode,
    modelId: review.modelId ?? null,
    plain: review.plain === true,
    evidence: review.evidence ?? 'legacy (pre-classification row)',
    verbatimFacts: (review.facts ?? []).map(f => `#${f.id} ${f.quote}`),
    citedRecords: (review.cited ?? []).map(r => `#${r.id} ${r.source}`),
    fallbackReason: review.fallbackReason ?? null,
    answer: String(review.answer ?? '').slice(0, 200),
  };
}

try {
  // 1) seed the known record (idempotent: skips sources that already exist)
  await api('/api/demo', {});
  // 2) fresh conversation so the replay does not disturb other chats
  const { conversation } = await api('/api/conversation', { title: 'evidence-replay' });
  // 3) the acceptance input: one known record + one answerable question
  const question = 'v0.1 通过测试了吗？';
  const modelState = await api('/api/chat', { text: question, language: 'zh-CN', useModel: true, conversation_id: conversation });
  const localState = await api('/api/chat', { text: question, language: 'zh-CN', useModel: false, conversation_id: conversation });
  const modelMsg = modelState.messages.at(-1);
  const localMsg = localState.messages.at(-1);
  const model = summarize(modelMsg.review);
  const local = summarize(localMsg.review);
  console.log(JSON.stringify({
    server: base,
    at: new Date().toISOString(),
    question,
    modelMode: model,
    localMode: local,
    verdict: model.evidence === 'verbatim' ? 'PASS — model quote verified verbatim'
      : model.evidence === 'cited' ? 'PARTIAL — sourced, but the quote is not verified verbatim'
      : model.evidence === 'plain' ? 'FAIL — model returned unparseable plain text'
      : 'FAIL — model returned no verifiable evidence',
  }, null, 2));
} catch (error) {
  console.error('replay failed:', error.message);
  process.exitCode = 1;
}
