import test from 'node:test';
import assert from 'node:assert/strict';
import { embedText, connectLiveTranslation, LIVE_TRANSLATE_MODEL } from './gemini-tools.mjs';

test('embedding requests preserve bilingual input and reject invalid vectors', async () => {
  let request;
  const result = await embedText({ text: '普通问题 / General question', key: 'synthetic',
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ embedding: { values: [0.1, -0.2] } }) };
    },
  });
  assert.equal(request.body.content.parts[0].text, '普通问题 / General question');
  assert.match(request.url, /gemini-embedding-2:embedContent$/);
  assert.equal(result.dimensions, 2);
  await assert.rejects(embedText({ text: 'test', key: 'synthetic',
    fetchImpl: async () => ({ ok: true, json: async () => ({ embedding: { values: ['invalid'] } }) }),
  }), /invalid embedding/);
});

test('live translation waits for setup and sends audio through the native protocol', async () => {
  let socket;
  class MockSocket extends EventTarget {
    readyState = 1;
    messages = [];
    constructor() {
      super();
      socket = this;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(raw) {
      const message = JSON.parse(raw);
      this.messages.push(message);
      if (message.setup) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ setupComplete: {} }) })));
    }
    close() { this.readyState = 3; }
  }
  const session = await connectLiveTranslation({ key: 'synthetic', targetLanguage: 'zh', WebSocketImpl: MockSocket });
  assert.equal(socket.messages[0].setup.model, 'models/' + LIVE_TRANSLATE_MODEL);
  assert.equal(socket.messages[0].setup.generationConfig.translationConfig.targetLanguageCode, 'zh');
  session.sendAudio(Buffer.from([0, 1]));
  assert.equal(socket.messages[1].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  session.endAudio();
  assert.equal(socket.messages[2].realtimeInput.audioStreamEnd, true);
  session.close();
});
