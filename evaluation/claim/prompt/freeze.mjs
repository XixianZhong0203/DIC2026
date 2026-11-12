// 提示词冻结（claim verifier prompt freeze）
//
// 冻结对象：src/opportunity/claims.mjs 的 claimMessages() 渲染出的 system 消息
// （zh/en × analysis/draft 共 4 个变体），以及 user 消息的 JSON 输入契约与模型输出契约。
// 留出集按冻结版提示词出题；改提示词 = 新轮次（claim-v2），须重跑 --selftest 并重新出题。
//
// Usage:
//   node evaluation/claim/prompt/freeze.mjs --write   # 首次冻结（claim-v1）；已有冻结后须 --write --version <新版本>
//   node evaluation/claim/prompt/freeze.mjs --check  # 漂移检查：当前代码渲染结果 vs 已提交指纹；退出码 0 = 未漂移

import { claimMessages, ANALYSIS_DIMENSIONS, DRAFT_DIMENSIONS } from '../../../src/opportunity/claims.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

const here = new URL('.', import.meta.url);
const promptFile = new URL('PROMPT.md', here);
const fingerprintsFile = new URL('fingerprints.json', here);
const sha = s => createHash('sha256').update(s).digest('hex');

// system 消息只依赖 language 与 mode，与具体输入无关；参考输入仅作渲染载体。
function renderAll() {
  const out = {};
  for (const language of ['zh', 'en']) {
    for (const mode of ['analysis', 'draft']) {
      const messages = claimMessages({
        mode,
        request: mode === 'analysis' ? 'Does this prospect have confirmed intent to buy?' : null,
        assessment: mode === 'analysis' ? { status: 'unknown' } : null,
        draft: mode === 'draft' ? '（冻结参考文本）' : null,
        dimensions: mode === 'draft' ? DRAFT_DIMENSIONS : ANALYSIS_DIMENSIONS,
        sources: [],
        language,
      });
      out[`${language}-${mode}`] = { sha256: sha(messages[0].content), text: messages[0].content };
    }
  }
  return out;
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: resolvePath(dirname(here.pathname) + '/../..'), encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}

function writeFingerprint(version) {
  const rendered = renderAll();
  const out = {
    version,
    frozenAt: new Date().toISOString(),
    gitHead: gitHead(),
    source: 'src/opportunity/claims.mjs :: claimMessages()',
    variants: Object.fromEntries(Object.entries(rendered).map(([k, v]) => [k, v.sha256])),
  };
  writeFileSync(fingerprintsFile, JSON.stringify(out, null, 2) + '\n');

  const rows = Object.entries(rendered).map(([k, v]) => `| ${k} | \`${v.sha256}\` |`).join('\n');
  const sections = Object.entries(rendered).map(([k, v]) =>
    `### ${k}\n\n\`\`\`\n${v.text}\n\`\`\`\n`).join('\n');
  const md = `# 声明核查提示词（冻结版 ${version}）

- 冻结日期：${out.frozenAt.slice(0, 10)}
- 代码版本：git ${out.gitHead}
- 渲染来源：\`${out.source}\`（4 变体：zh/en × analysis/draft）
- 状态：**冻结中**——留出集按此提示词出题；改提示词 = 新轮次（版本 +1），重跑 \`--selftest\` 后重新出题
- 漂移检查：\`node evaluation/claim/prompt/freeze.mjs --check\`（退出码 0 = 未漂移）

## 指纹（sha256，system 消息全文；机器可读版见 fingerprints.json）

| 变体 | 指纹 |
|---|---|
${rows}

## 冻结范围

1. system 消息：上表 4 个变体全文（见下）。
2. user 消息 JSON 输入契约：\`{ mode, dimensions, claims, assessment, draft, sources }\`。
3. 模型输出契约：\`{"claims":[{ id, dimension, text, status, items[{evidenceId, stance, quote, note, revises}], missing, rewrite }]}\`；
   status ∈ {supported, refuted, unknown, conflict}；stance ∈ {supports, refutes, withdraws, neutral}；
   quote 必须逐字出自指定来源；text（草稿模式）必须逐字出自草稿正文。

## 解冻流程（改提示词时）

1. 改 \`src/opportunity/claims.mjs\`；\`--check\` 将报漂移（这是预期）。
2. 升版本（claim-v1 → claim-v2），\`--write\` 重新生成 PROMPT.md 与 fingerprints.json。
3. 重跑 \`node evaluation/claim/scorer.mjs --selftest\`。
4. 金标文件的 \`prompt\` 字段改为新版本；旧留出集在新提示词下重新核查后才可复用。

## 变体全文

${sections}
`;
  writeFileSync(promptFile, md);
  console.log(`已冻结 ${version}：${promptFile.pathname} + ${fingerprintsFile.pathname}（git ${out.gitHead}）`);
}

function check() {
  if (!existsSync(fingerprintsFile)) {
    console.error('fingerprints.json 不存在：先运行 --write 冻结。');
    process.exit(1);
  }
  const recorded = JSON.parse(readFileSync(fingerprintsFile, 'utf8'));
  const rendered = renderAll();
  const drift = Object.entries(recorded.variants).filter(([k, v]) => rendered[k]?.sha256 !== v);
  const missing = Object.keys(recorded.variants).filter(k => !rendered[k]);
  if (drift.length || missing.length) {
    console.error(`提示词漂移（记录版本 ${recorded.version}，frozenAt ${recorded.frozenAt}）：`);
    for (const [k, v] of drift) console.error(`  ✗ ${k}：记录 ${v} ≠ 当前 ${rendered[k]?.sha256}`);
    for (const k of missing) console.error(`  ✗ ${k}：变体缺失`);
    console.error('若为有意修改：升版本后 --write 重新冻结，并走解冻流程（重跑 selftest、金标 prompt 字段换新版本）。');
    process.exit(1);
  }
  console.log(`提示词未漂移：${recorded.version}（${Object.keys(recorded.variants).length} 个变体指纹全部匹配，git ${gitHead()}）。`);
}

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
if (args.includes('--write')) {
  const existing = existsSync(fingerprintsFile) ? JSON.parse(readFileSync(fingerprintsFile, 'utf8')) : null;
  const version = flag('--version') ?? (existing ? null : 'claim-v1');
  if (!version) {
    console.error(`已存在冻结版本 ${existing.version}；重新冻结必须显式升版本：--write --version <新版本>。`);
    process.exit(2);
  }
  if (existing && existing.version === version) {
    console.error(`版本 ${version} 已冻结过；重新冻结必须升版本（如 ${version.replace(/\d+$/, n => String(Number(n) + 1))}）。`);
    process.exit(2);
  }
  writeFingerprint(version);
} else if (args.includes('--check')) {
  check();
} else {
  console.error('用法：--write [--version <v>] | --check');
  process.exit(2);
}
