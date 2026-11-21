import { setTimeout as delay } from 'node:timers/promises';
import { connectLiveTranslation, LIVE_TRANSLATE_MODEL } from './gemini-tools.mjs';

export function pcmWav(pcm, rate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function translationPcm(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Upload a PCM WAV file. / 请上传 PCM WAV 文件。');
  }
  let format = false;
  let pcm;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('Truncated WAV file. / WAV 文件不完整。');
    if (kind === 'fmt ' && size >= 16) {
      format = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 &&
        wav.readUInt32LE(start + 4) === 16000 && wav.readUInt16LE(start + 14) === 16;
    }
    if (kind === 'data') pcm = wav.subarray(start, start + size);
    offset = start + size + size % 2;
  }
  if (!format || !pcm?.length || pcm.length % 2 || pcm.length > 960000) {
    throw new Error('Use a mono 16-bit PCM WAV at 16 kHz, up to 30 seconds. / 请使用最长 30 秒、16 kHz 单声道 16 位 PCM WAV。');
  }
  return pcm;
}

// A short uploaded recording is streamed through the Live translation protocol.
export async function translateRecording({ wav, targetLanguage, connect = connectLiveTranslation }) {
  const pcm = translationPcm(wav);
  const chunks = [];
  let transcript = '';
  let session;
  let ended = false;
  let finish;
  let fail;
  let failure;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  completed.catch(() => {});
  const stop = error => { failure = error; fail(error); };
  const timer = setTimeout(() => stop(new Error('Translation timed out. / 翻译超时。')), 90000);
  try {
    session = await connect({ targetLanguage,
      onMessage(message) {
        const content = message.serverContent;
        for (const part of content?.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) chunks.push(Buffer.from(part.inlineData.data, 'base64'));
        }
        if (content?.outputTranscription?.text) transcript += content.outputTranscription.text;
        if (ended && content?.turnComplete) finish();
      },
      onClose(error) { stop(error ?? new Error('Translation connection closed. / 翻译连接已关闭。')); },
    });
    for (let offset = 0; offset < pcm.length; offset += 3200) {
      if (failure) throw failure;
      const chunk = pcm.subarray(offset, offset + 3200);
      session.sendAudio(chunk);
      await delay(chunk.length / 32);
    }
    ended = true;
    session.endAudio();
    await completed;
    const output = Buffer.concat(chunks);
    if (!output.length) throw new Error('No translated audio returned. / 未返回翻译音频。');
    return { model: LIVE_TRANSLATE_MODEL, mimeType: 'audio/wav', data: pcmWav(output).toString('base64'), transcript };
  } finally {
    clearTimeout(timer);
    session?.close();
  }
}
