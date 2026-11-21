import { codexModels } from './chat/local-gpt-models.mjs';

// Daymark model catalog (multi-model window): all models that can be switched by session on the chat
// interface.
//
// Each item points to an OpenAI-compatible /chat/completions endpoint. Credential resolution rules: `key`
// literal > environment variable specified by `keyEnv` > `fallbackKey` literal. `efforts` maps the
// thinking tiers on the interface (low/medium/high) to the reasoning_effort values accepted by the
// endpoint; an empty object indicates that the model has no optional tiers. `timeout` is the default
// request timeout for the model in milliseconds.
//
// opencode.ai's free models use the shared public pool (apiKey is "public" in the OpenCode model catalog);
// if OPENCODE_API_KEY is set in .env, your own OpenCode account credentials are used for calls. Qwen uses
// local LiteLLM/vLLM deployment: actual testing shows this endpoint only accepts low / medium / xhigh
// ("high" returns 400), so the interface high tier is mapped to xhigh.

const customBase = process.env.OPENAI_BASE_URL?.trim();
const customModel = process.env.MODEL_ID?.trim();
const customEndpoint = customBase && customModel ? new URL(customBase) : null;
const OPENCODE_INFERENCE = 'https://opencode.ai/inference/openai/v1';

const free = (id, name, efforts) => ({
  id, name, base: OPENCODE_INFERENCE, keyEnv: 'OPENCODE_API_KEY', fallbackKey: 'public',
  timeout: 60000, efforts,
});

export const MODELS = [
  {
    id: 'Qwen3.8-27B-FP8-reasoning',
    name: 'Qwen 3.8 27B',
    base: 'https://ask-llm-internal.ritsdev.top/v1',
    keyEnv: 'OPENAI_API_KEY',
    timeout: 90000,
    efforts: { low: 'low', medium: 'medium', high: 'xhigh' },
  },
  ...(process.env.GEMINI_API_KEY?.trim() ? [{
    id: 'gemini-4-hydrogen',
    name: 'Gemini 4 Hydrogen',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    timeout: 90000,
    efforts: {},
  }, {
    id: 'gemma-4-31b-it',
    name: 'Gemma 4 31B',
    nativeGemini: true,
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    timeout: 90000,
    efforts: {},
  }, {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    timeout: 60000,
    efforts: {},
  }] : []),
  free('iceman-free', 'Iceman Free', {}),
  free('inkling-2-small-free', 'Inkling 2 Small Free', { low: 'low', medium: 'medium', high: 'high' }),
  free('longcat-2.5-free', 'LongCat 2.5 Free', {}),
  free('flint-40b-free', 'Flint 40B Free', { low: 'low', medium: 'medium', high: 'high' }),
  free('minimax-m3.1-flash-free', 'MiniMax M3.1 Flash Free', { low: 'low', medium: 'medium', high: 'high' }),
  free('deepseek-v4.1-flash-free', 'DeepSeek V4.1 Flash Free', { low: 'low', high: 'high' }),
  free('nemotron-3.5-super-vl-free', 'Nemotron 3.5 Super VL Free', { low: 'low', medium: 'medium', high: 'high' }),
  free('beam-free', 'Beam Free', { low: 'low', medium: 'medium', high: 'high' }),
  free('mimo-v2.6-flash-free', 'MiMo-V2.6-Flash Free', {}),
  free('glm-5.3-flash-free', 'GLM-5.3-Flash Free', { low: 'low', high: 'high' }),
  free('nemotron-3.5-lightning-free', 'Nemotron 3.5 Lightning Free', {}),
  free('big-pickle', 'Big Pickle', {}),
  ...(process.env.DAYMARK_CODEX_PICKER === '1' ? codexModels.map(({ id, label, efforts }) => ({
    id, name: label, base: 'http://127.0.0.1:' + Number(process.env.DAYMARK_CODEX_BRIDGE_PORT ?? 4334) + '/v1', local: true, codex: true,
    timeout: 90000, efforts: Object.fromEntries(efforts.map(effort => [effort, effort])),
  })) : []),
];

// Preserve the original MODEL_ID + OPENAI_BASE_URL setup for custom providers.
if (customEndpoint) {
  const index = MODELS.findIndex(entry => entry.id === customModel);
  if (!MODELS[index]?.codex) {
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(customEndpoint.hostname);
    const entry = { ...MODELS[index], id: customModel, name: MODELS[index]?.name ?? customModel,
      base: customEndpoint.href, keyEnv: 'OPENAI_API_KEY', fallbackKey: undefined, nativeGemini: false, local,
      timeout: local ? 90000 : 18000 };
    if (index < 0) MODELS.push(entry);
    else MODELS[index] = entry;
  }
}

export const modelById = id => (typeof id === 'string' && MODELS.find(entry => entry.id === id)) || null;
export const modelProvider = entry => {
  if (entry.codex) return 'OpenAI';
  if (entry.base.includes('generativelanguage.googleapis.com')) return 'Google';
  if (entry.base.includes('opencode.ai')) return 'OpenCode';
  if (entry.id.toLowerCase().includes('qwen')) return 'Qwen';
  return 'Custom';
};
// Default model: if .env's MODEL_ID hits the catalog, use it; otherwise, take the first item in the
// catalog.
export const DEFAULT_MODEL_ID = (process.env.MODEL_ID && modelById(process.env.MODEL_ID)?.id) || MODELS[0].id;
export const defaultModel = () => modelById(DEFAULT_MODEL_ID) ?? MODELS[0];

export const modelKey = entry => {
  const fromEnv = entry.keyEnv ? (process.env[entry.keyEnv] ?? '').trim() : '';
  return entry.key ?? (fromEnv || entry.fallbackKey || '');
};
export const modelConfigured = entry => Boolean(entry.local || modelKey(entry));
// Session-stored model/tier -> effective call target. Unknown models fall back to the default model; tiers
// not supported by the model are treated as "unspecified" (the endpoint uses its own default values).
export const conversationModel = (conversation, defaultEntry) => {
  const entry = modelById(conversation?.model) ?? defaultEntry;
  const effort = Object.hasOwn(entry.efforts ?? {}, conversation?.effort) ? conversation.effort : entry.codex ? 'low' : null;
  return { entry, effort };
};
