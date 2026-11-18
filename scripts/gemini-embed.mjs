import { readFile, writeFile } from 'node:fs/promises';
import { embedText } from '../src/gemini-tools.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length !== 2) {
  console.log('Usage / 用法: npm run embed -- input.txt output.json');
  console.log('The input text is sent to Google. / 输入文本将发送至 Google。');
  process.exit(args.includes('--help') ? 0 : 1);
}
try {
  const [input, output] = args;
  const result = await embedText({ text: await readFile(input, 'utf8') });
  await writeFile(output, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Saved / 已保存: ${output} (${result.model}, ${result.dimensions})`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
