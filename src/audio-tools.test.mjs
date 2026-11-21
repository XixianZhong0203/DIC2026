import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmWav, translationPcm, translateRecording } from './audio-tools.mjs';
import { geminiTextReply } from './gemini-tools.mjs';

test('translation accepts only bounded mono PCM16 recordings at 16 kHz', () => {
  const pcm = Buffer.alloc(320);
  assert.deepEqual(translationPcm(pcmWav(pcm, 16000)), pcm);
  assert.throws(() => translationPcm(pcmWav(pcm, 24000)), /16 kHz/);
  assert.throws(() => translationPcm(pcmWav(Buffer.alloc(960002), 16000)), /30 seconds/);
  assert.throws(() => translationPcm(pcmWav(pcm, 16000).subarray(0, 50)), /Truncated/);
});

test('recording translation returns a playable WAV and closes its session', async () => {
  let closed = false;
  let sent = 0;
  const result = await translateRecording({ wav: pcmWav(Buffer.alloc(320), 16000), targetLanguage: 'en',
    connect: async ({ onMessage, targetLanguage }) => {
      assert.equal(targetLanguage, 'en');
      return {
        sendAudio(bytes) { sent += bytes.length; },
        endAudio() {
          onMessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(240).toString('base64') } }] }, outputTranscription: { text: 'Hello.' }, turnComplete: true } });
        },
        close() { closed = true; },
      };
    },
  });
  assert.equal(sent, 320);
  assert.equal(closed, true);
  assert.equal(result.transcript, 'Hello.');
  const wav = Buffer.from(result.data, 'base64');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
});

test('native Gemma chat preserves system instructions and excludes thought parts', async () => {
  let request;
  const answer = await geminiTextReply({ model: 'gemma-4-31b-it', key: 'synthetic',
    messages: [{ role: 'system', content: 'Answer general questions.' }, { role: 'user', content: 'Explain gravity.' }],
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'private', thought: true }, { text: 'Gravity attracts matter.' }] } }] }) };
    },
  });
  assert.match(request.url, /gemma-4-31b-it:generateContent$/);
  assert.equal(request.body.systemInstruction.parts[0].text, 'Answer general questions.');
  assert.equal(answer, 'Gravity attracts matter.');
});
