import { readFile, writeFile } from 'node:fs/promises';
import { synthesizeSpeech } from '../src/speech.mjs';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage / 用法: npm run tts -- input.txt output.wav [voice] [style]');
  console.log('The input text is sent to Google Gemini. / 输入文本将发送至 Google Gemini。');
  process.exit(args.includes('--help') ? 0 : 1);
}

try {
  const [input, output, voice = 'Kore', style = ''] = args;
  if (!input || !output || args.length > 4 || !output.toLowerCase().endsWith('.wav')) {
    throw new Error('Provide an input text file and an output .wav file. / 请指定输入文本文件和输出 .wav 文件。');
  }
  const text = await readFile(input, 'utf8');
  const audio = await synthesizeSpeech({ text, voice, style });
  await writeFile(output, audio.bytes, { flag: 'wx', mode: 0o600 });
  console.log(`Saved / 已保存: ${output} (${audio.model}, ${audio.voice})`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
