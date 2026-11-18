export const TTS_MODEL = 'gemini-3.8-flash-tts';

// Gemini TTS uses the native Interactions API and returns encoded audio.
export async function synthesizeSpeech({ text, voice = 'Kore', style = '', key = process.env.GEMINI_API_KEY, fetchImpl = fetch }) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Provide text to read. / 请提供朗读文本。');
  if (!key?.trim()) throw new Error('Configure GEMINI_API_KEY. / 请配置 GEMINI_API_KEY。');
  if (typeof voice !== 'string' || !voice.trim()) throw new Error('Provide a voice name. / 请提供音色名称。');
  if (typeof style !== 'string') throw new Error('Style must be text. / 语音风格必须为文本。');
  const content = { type: 'text', text };
  if (style.trim()) content.annotations = [{ type: 'speech_metadata', style }];
  const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key.trim() },
    body: JSON.stringify({ model: TTS_MODEL, input: [{ type: 'user_input', content: [content] }],
      response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice }] } }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    throw new Error(`Gemini TTS request failed (HTTP ${response.status}). / Gemini 语音请求失败。`);
  }
  const result = await response.json();
  const blocks = (result.steps ?? []).filter(step => step.type === 'model_output')
    .flatMap(step => step.content ?? []).filter(part => part.type === 'audio');
  const audio = blocks.at(-1);
  if (typeof audio?.data !== 'string' || !audio.data.length) {
    throw new Error('Gemini returned no audio. / Gemini 未返回音频。');
  }
  const bytes = Buffer.from(audio.data, 'base64');
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Gemini returned an unexpected audio format. / Gemini 返回了非预期音频格式。');
  }
  return { bytes, mimeType: 'audio/wav', model: TTS_MODEL, voice };
}
