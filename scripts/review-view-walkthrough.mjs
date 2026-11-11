// 人工复核来源记录 · 界面走查与验收脚本
//
// 自包含：在临时数据目录里启动本地服务（PORT 4317），按验收场景驱动 API，
// 并在每一步用真实 UI 模块（dist/opportunity-ui.js，最小假 DOM）渲染机会卡片与
// 审计面板，打印复核区/审计里实际显示的文字（中英双语），同时断言验收条件：
//   1. 展开来源 S1 但不展开 S2 → 保存复核 → 审计只显示 S1；
//   2. 更换草稿或加入新来源后，旧查看记录不会出现在新复核上；
//   3. 未展开来源时复核区与审计准确显示「尚未展开来源」。
//
// 运行：node scripts/review-view-walkthrough.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createOpportunityUI } from '../dist/opportunity-ui.js';
import { translate } from '../dist/i18n.js';

const PORT = 4317;
const BASE = 'http://127.0.0.1:' + PORT;
const dataDir = mkdtempSync(os.tmpdir() + '/daymark-walkthrough-');
let step = 0;

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), DAYMARK_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', chunk => process.stderr.write('[server] ' + chunk));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务未在预期时间内启动');
}

const post = async (name, body) => {
  const response = await fetch(BASE + '/api/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${name} 失败（${response.status}）：${data.error}`);
  return data;
};
// 状态是 GET 端点（server.mjs：/api/state）。
const state = async () => {
  const response = await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(5000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`state 失败（${response.status}）：${data.error}`);
  return data;
};

// ---- 最小假 DOM：驱动真实 UI 模块，取回渲染后的文字（与 dist/opportunity-ui.test.mjs 同一手法）----
function uiHarness(language) {
  const element = (tag, text = '') => {
    const node = { tag, text, children: [], open: false, listeners: {},
      get textContent() { return this.text; },
      set textContent(value) { this.text = value; },
      append(...kids) { this.children.push(...kids); },
      replaceChildren(...kids) { this.children = [...kids]; },
      setAttribute() {},
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      reportValidity() { return true; },
    };
    return node;
  };
  const action = (label) => element('button', label);
  const elements = new Map();
  const get = id => elements.get(id) ?? (elements.set(id, element('div', '')), elements.get(id));
  const render = createOpportunityUI({
    get, t: phrase => translate(language, phrase), element, action,
    request: async () => {}, viewSource: async () => {},
    formAction: () => {}, language: () => language, createTask: () => {},
  });
  const prefixes = [translate(language, '已展开来源'), translate(language, '尚未展开来源')];
  return {
    render,
    // 复核区状态行：「已展开来源 · …」或「尚未展开来源」。
    viewLine: () => {
      const walk = node => {
        for (const kid of node.children ?? []) {
          if (kid.tag === 'small' && prefixes.some(prefix => String(kid.text).startsWith(prefix))) return kid.text;
          const hit = walk(kid);
          if (hit) return hit;
        }
        return null;
      };
      return walk(elements.get('opportunity-list')) ?? '(无复核区状态行)';
    },
    // 审计面板里每条记录的摘要 + 查看状态行。
    audit: () => elements.get('opportunity-audit').children.map(block => {
      const summary = block.children?.[0]?.text ?? '';
      const note = (block.children ?? []).find(kid => kid.tag === 'p' &&
        prefixes.some(prefix => String(kid.text).startsWith(prefix)));
      return note ? summary + ' → ' + note.text : summary;
    }).filter(Boolean),
  };
}
const zh = uiHarness('zh-CN');
const en = uiHarness('en');

function show(title, data) {
  zh.render(data);
  en.render(data);
  step += 1;
  console.log(`\n[${step}] ${title}`);
  console.log('    复核区（中）: ' + zh.viewLine());
  console.log('    复核区（英）: ' + en.viewLine());
  console.log('    审计记录:');
  for (const row of zh.audit()) console.log('      · ' + row);
}
const leadOf = data => data.opportunities.find(row => row.id === leadId);
let leadId = null;

try {
  await waitForServer();
  console.log('服务已启动（临时数据目录 ' + dataDir + '）');

  // 准备一条线索：证据 E1 + 两个来源 S1、S2，并保存第一版草稿。
  leadId = (await post('opportunity', {
    kind: 'lead', title: '交付日期线索', source: '客户邮件', evidence: '客户表示希望周五交付。',
  })).opportunities.at(0).id; // rowid 倒序：刚创建的线索在最前
  await post('opportunity-source', { id: leadId, name: '客户邮件', date: '2026-07-01', kind: 'customer', text: '客户确认周五交付。' });
  await post('opportunity-source', { id: leadId, name: '创始人笔记', kind: 'founder', text: '创始人记得周五已答应客户。' });
  await post('opportunity-draft', { id: leadId, recipient: 'client@example.test', body: '我们按周五交付推进。' });

  show('草稿 v1 保存完成，尚未展开任何来源', await state());
  assert.match(zh.viewLine(), /尚未展开来源/, '验收 3：未展开来源时复核区显示「尚未展开来源」');
  assert.match(en.viewLine(), /^No sources opened yet$/, 'English shows the empty state');

  // 展开 S1 的来源原文（对应界面点击展开；不展开 S2）。
  await post('opportunity-review-view', { id: leadId, source_id: 'S1' });

  show('展开来源 S1（不展开 S2）', await state());
  assert.match(zh.viewLine(), /已展开来源 · 客户邮件/, '复核区当场显示已展开的来源');
  assert.doesNotMatch(zh.viewLine(), /尚未展开来源/);

  // 保存复核：审计写入已展开来源、草稿 ID、来源版本与结论。
  await post('opportunity-review', { id: leadId, analysis_id: null, draft_id: leadOf(await state()).draft_id, resolution: '已读客户邮件原文，日期仍需确认。' });
  const data1 = await state();
  const detail1 = JSON.parse(data1.audit.find(event => event.action === 'human_reviewed').detail);
  show('保存复核结论（展开了 S1）', data1);
  assert.deepEqual(detail1.viewed, ['S1'], '验收 1：审计只显示展开的 S1，不含 S2');
  assert.deepEqual(detail1.viewedNames, ['客户邮件']);
  assert.equal(detail1.draftId, leadOf(data1).draft_id, '审计带草稿 ID');
  assert.equal(typeof detail1.evidence, 'string', '审计带来源版本');
  assert.equal(detail1.resolution, '已读客户邮件原文，日期仍需确认。', '审计带复核结论');
  assert.ok(data1.audit.some(event => event.action === 'review_source_viewed'), '查看动作本身有审计记录');

  // 更换草稿（v2）：查看状态从空开始，旧复核留在历史里。
  await post('opportunity-draft', { id: leadId, recipient: 'client@example.test', body: '我们按客户确认的日期推进。' });

  show('更换为草稿 v2 后，复核区回到空查看状态', await state());
  assert.match(zh.viewLine(), /尚未展开来源/, '验收 2：草稿变化后旧查看记录不带到新复核');

  // 针对新草稿保存复核（仍未展开任何来源）。
  await post('opportunity-review', { id: leadId, analysis_id: null, draft_id: leadOf(await state()).draft_id, resolution: '针对 v2 草稿重新复核。' });
  const data2 = await state();
  const detail2 = JSON.parse(data2.audit.find(event => event.action === 'human_reviewed').detail);
  show('针对 v2 保存复核（未展开来源）', data2);
  assert.deepEqual(detail2.viewed, [], '新复核的查看状态是空的，不继承旧记录');
  const history = data2.audit.filter(event => event.action === 'human_reviewed');
  assert.deepEqual(JSON.parse(history[1].detail).viewed, ['S1'], '旧复核及其查看记录保留在历史里');

  // 加入新来源 S3（撤回邮件）：查看状态再次重置；展开 S1 后再保存复核。
  await post('opportunity-source', { id: leadId, name: '撤回邮件', date: '2026-07-10', kind: 'customer', text: '客户撤回此前的日期确认。' });

  show('加入新来源 S3 后，查看状态重新从空开始', await state());
  assert.match(zh.viewLine(), /尚未展开来源/, '验收 2：来源集合变化后同样重置');

  await post('opportunity-review-view', { id: leadId, source_id: 'S1' });
  await post('opportunity-review', { id: leadId, analysis_id: null, draft_id: leadOf(await state()).draft_id, resolution: '按撤回邮件重新核对，已展开 S1。' });
  const data3 = await state();
  const detail3 = JSON.parse(data3.audit.find(event => event.action === 'human_reviewed').detail);
  show('新来源版本下展开 S1 并保存复核', data3);
  assert.deepEqual(detail3.viewed, ['S1']);
  assert.equal(data3.audit.filter(event => event.action === 'human_reviewed').length, 3, '历史中保留 3 次复核');
  assert.equal(data3.audit.filter(event => event.action === 'review_source_viewed').length, 2, '查看动作审计 2 条（v1 一次、v3 一次）');

  console.log('\n验收通过：');
  console.log('  · 展开 S1 不展开 S2 → 审计只显示 S1（viewed = [' + JSON.stringify(detail1.viewed) + ']）');
  console.log('  · 更换草稿 / 加入新来源 → 新复核查看状态为空，旧记录留在历史');
  console.log('  · 未展开来源时，复核区与审计准确显示「尚未展开来源」');
} finally {
  server.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}
