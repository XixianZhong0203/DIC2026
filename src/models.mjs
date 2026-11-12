import { codexModels } from './chat/codex-models.mjs';

// Daymark 模型目录（multi-model 窗口）：聊天界面上可按会话切换的全部模型。
//
// 每一项指向一个 OpenAI 兼容的 /chat/completions 端点。凭证解析规则：
// `key` 字面量 > `keyEnv` 指定的环境变量 > `fallbackKey` 字面量。
// `efforts` 把界面上的思考档位（low/medium/high）映射到该端点接受的
// reasoning_effort 取值；空对象表示该模型没有可选档位。
// `timeout` 是该模型的默认请求超时（毫秒）。
//
// opencode.ai 的免费模型走共享公共池（OpenCode 模型目录里 apiKey 为 "public"）；
// 若 .env 里设置了 OPENCODE_API_KEY，则用你自己的 OpenCode 账户凭证调用。
// Qwen 走本地 LiteLLM/vLLM 部署：实测该端点只接受 low / medium / xhigh
// （"high" 会返回 400），因此界面 high 档映射为 xhigh。

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
      base: customEndpoint.href, keyEnv: 'OPENAI_API_KEY', fallbackKey: undefined, local,
      timeout: local ? 90000 : 18000 };
    if (index < 0) MODELS.push(entry);
    else MODELS[index] = entry;
  }
}

export const modelById = id => (typeof id === 'string' && MODELS.find(entry => entry.id === id)) || null;
// 默认模型：.env 的 MODEL_ID 命中目录则用之，否则取目录第一项。
export const DEFAULT_MODEL_ID = (process.env.MODEL_ID && modelById(process.env.MODEL_ID)?.id) || MODELS[0].id;
export const defaultModel = () => modelById(DEFAULT_MODEL_ID) ?? MODELS[0];

export const modelKey = entry => {
  const fromEnv = entry.keyEnv ? (process.env[entry.keyEnv] ?? '').trim() : '';
  return entry.key ?? (fromEnv || entry.fallbackKey || '');
};
export const modelConfigured = entry => Boolean(entry.local || modelKey(entry));
// 会话存储的模型/档位 → 有效调用目标。未知模型回落默认模型；不在该模型
// 支持列表里的档位按“未指定”处理（端点用自己的默认值）。
export const conversationModel = (conversation, defaultEntry) => {
  const entry = modelById(conversation?.model) ?? defaultEntry;
  const effort = Object.hasOwn(entry.efforts ?? {}, conversation?.effort) ? conversation.effort : entry.codex ? 'low' : null;
  return { entry, effort };
};
