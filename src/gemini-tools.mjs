export const EMBEDDING_MODEL = 'gemini-embedding-2';
export const LIVE_TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';

export async function geminiTextReply({ model, messages, key = process.env.GEMINI_API_KEY, fetchImpl = fetch, timeout = 90000 }) {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  const contents = messages.filter(message => message.role !== 'system').map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }],
  }));
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': requireKey(key) },
    body: JSON.stringify({ contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), generationConfig: { maxOutputTokens: 8192 } }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Gemini text request failed (HTTP ${response.status}).`);
  const result = await response.json();
  const text = (result.candidates?.[0]?.content?.parts ?? []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
  if (!text.trim()) throw new Error('Gemini returned no text.');
  return text;
}

function requireKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('Configure GEMINI_API_KEY. / 请配置 GEMINI_API_KEY。');
  return key.trim();
}

export async function embedText({ text, key = process.env.GEMINI_API_KEY, fetchImpl = fetch }) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Provide text to embed. / 请提供生成向量的文本。');
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': requireKey(key) },
    body: JSON.stringify({ model: `models/${EMBEDDING_MODEL}`, content: { parts: [{ text }] } }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Gemini embedding failed (HTTP ${response.status}). / Gemini 向量请求失败。`);
  const result = await response.json();
  const values = result.embedding?.values;
  if (!Array.isArray(values) || !values.length || !values.every(Number.isFinite)) {
    throw new Error('Gemini returned an invalid embedding. / Gemini 返回的向量无效。');
  }
  return { model: EMBEDDING_MODEL, dimensions: values.length, values };
}

// The caller streams mono PCM16 audio at 16 kHz after setup completes.
export function connectLiveTranslation({ targetLanguage = 'en', key = process.env.GEMINI_API_KEY,
  onMessage = () => {}, onClose = () => {}, WebSocketImpl = WebSocket }) {
  if (typeof targetLanguage !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(targetLanguage)) {
    throw new Error('Provide a language code such as en or zh. / 请提供 en 或 zh 等语言代码。');
  }
  const url = new URL('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent');
  url.searchParams.set('key', requireKey(key));
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url.href);
    socket.binaryType = 'arraybuffer';
    let ready = false;
    const timer = setTimeout(() => { reject(new Error('Live translation setup timed out. / 实时翻译初始化超时。')); socket.close(); }, 30000);
    const stop = error => { clearTimeout(timer); if (!ready) reject(error); else onClose(error); socket.close(); };
    socket.addEventListener('open', () => socket.send(JSON.stringify({ setup: {
      model: `models/${LIVE_TRANSLATE_MODEL}`,
      inputAudioTranscription: {}, outputAudioTranscription: {},
      generationConfig: { responseModalities: ['AUDIO'], translationConfig: { targetLanguageCode: targetLanguage, echoTargetLanguage: false } },
    } })));
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
        if (message.error) { stop(new Error('Live translation was rejected. / 实时翻译请求被拒绝。')); return; }
        if (message.setupComplete && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve({
            model: LIVE_TRANSLATE_MODEL,
            sendAudio(bytes) {
              if (socket.readyState !== 1) throw new Error('Translation session is closed. / 翻译会话已关闭。');
              socket.send(JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(bytes).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
            },
            endAudio() { socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); },
            close() { socket.close(); },
          });
        }
        onMessage(message);
      } catch { stop(new Error('Invalid live translation response. / 实时翻译响应无效。')); }
    });
    socket.addEventListener('error', () => stop(new Error('Live translation connection failed. / 实时翻译连接失败。')));
    socket.addEventListener('close', () => { clearTimeout(timer); if (!ready) reject(new Error('Translation closed before setup. / 翻译会话在初始化前关闭。')); else onClose(); });
  });
}
