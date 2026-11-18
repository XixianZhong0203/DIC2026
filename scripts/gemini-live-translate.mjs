import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { connectLiveTranslation } from '../src/gemini-tools.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length !== 3) {
  console.log('Usage / 用法: npm run translate-audio -- input.pcm output.pcm en');
  console.log('Input: mono PCM16, 16 kHz. Output: mono PCM16, 24 kHz. / 输入：单声道 PCM16，16 kHz。输出：单声道 PCM16，24 kHz。');
  console.log('Audio is streamed to Google. / 音频流将发送至 Google。');
  process.exit(args.includes('--help') ? 0 : 1);
}

let session;
let input;
let output;
let timeout;
let writes = Promise.resolve();
try {
  const [inputPath, outputPath, targetLanguage] = args;
  input = await open(inputPath, 'r');
  const stat = await input.stat();
  if (!stat.size || stat.size % 2) throw new Error('Input must contain PCM16 samples. / 输入必须包含 PCM16 采样。');
  output = await open(outputPath, 'wx', 0o600);
  let ended = false;
  let finish;
  let fail;
  const complete = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  // Attach a handler immediately, including failures while audio is being sent.
  complete.catch(() => {});
  session = await connectLiveTranslation({ targetLanguage,
    onMessage(message) {
      const content = message.serverContent;
      for (const part of content?.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          const bytes = Buffer.from(part.inlineData.data, 'base64');
          writes = writes.then(() => output.write(bytes));
          writes.catch(fail);
        }
      }
      if (content?.outputTranscription?.text) process.stderr.write(content.outputTranscription.text);
      if (ended && content?.turnComplete) finish();
    },
    onClose(error) { fail(error ?? new Error('Translation connection closed. / 翻译连接已关闭。')); },
  });
  timeout = setTimeout(() => fail(new Error('Translation timed out. / 翻译超时。')), 180000);
  for await (const chunk of input.createReadStream({ highWaterMark: 3200, autoClose: false })) {
    session.sendAudio(chunk);
    await delay(chunk.length / 32);
  }
  ended = true;
  session.endAudio();
  await complete;
  await writes;
  console.error('\nSaved / 已保存: ' + outputPath);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  session?.close();
  await writes.catch(() => {});
  await input?.close();
  await output?.close();
}
