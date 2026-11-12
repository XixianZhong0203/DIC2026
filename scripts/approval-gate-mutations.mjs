// 审批闸门 · 关键条件临时变异测试
//
//   对闸门的关键条件逐一做「临时变异」：在临时目录中复制一份服务代码（工作树
//   字节级拷贝，仅替换 src/models.mjs 为本地 mock 目录），应用单一变异，启动真实
//   服务并跑 approval-gate-acceptance 的同一套检查。判据：
//     - 原始代码套件必须全绿（否则是测试自身的问题，先修测试）；
//     - 变异后的代码必须被预先声明的对应检查抓到（kill 点）——抓不到说明套件
//       对该条件没有防护，需要补检查。
//   变异只作用于临时拷贝：工作树不被修改（临时变异，跑完即删）。
//
//   运行方式：node scripts/approval-gate-mutations.mjs

import { rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWorkDir, spawnGateServer, startMockModel, makeQueues, runGateChecks, waitFor } from './approval-gate-acceptance.mjs';

const PORT = 4231;
const MOCK_PORT = 4232;
const BASE = 'http://127.0.0.1:' + PORT;

// 关键条件（锚点必须在工作树中唯一出现，buildWorkDir 会校验）。
const MUTATIONS = [
  { id: 'M1', file: 'src/opportunity/opportunities.mjs',
    old: "if (item.sent) {\n          audit(id, 'duplicate_send', { draftId: draft_id });", new: 'if (item.sent) {\n          return;',
    note: '让重复批准静默成功并漏记审计',
    kill: 'gate-state/duplicate-send-idempotent' },
  { id: 'M2', file: 'src/opportunity/opportunities.mjs',
    old: 'if (!item.draft_id || item.draft_id !== draft_id) {', new: 'if (false) {',
    note: '停用草稿版本令牌检查（允许旧令牌批准）',
    kill: 'gate-state/stale-token-replayed-after-edit' },
  { id: 'M3', file: 'src/opportunity/opportunities.mjs',
    old: "check(id, 'send', ['approval']);", new: "check(id, 'send', ['approval', 'human']);",
    note: '放宽授权模式（human 模式可发送）',
    kill: 'gate-state/delegation-mode-human' },
  { id: 'M4', file: 'src/opportunity/opportunities.mjs',
    old: 'item.review_evidence === evidenceHash(item, sourceRows)', new: 'true',
    note: '去掉复核→来源集合绑定（过期复核可放行）',
    kill: 'gate-state/review-bound-to-stale-sources' },
  { id: 'M5', file: 'src/opportunity/opportunities.mjs',
    old: 'if (claimsStale(item, review, sourceRows)) {', new: 'if (false) {',
    note: '去掉核查新鲜度检查（过期声明核查可放行）',
    kill: 'gate-state/stale-draft-claims' },
  { id: 'M6', file: 'server.mjs',
    old: "if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) fail(403, '请求来源不匹配。');",
    new: "if (false) fail(403, '请求来源不匹配。');",
    note: '去掉 Origin 检查（伪造来源可触达发送路径）',
    kill: 'http/wrong-origin' },
  { id: 'M7', file: 'server.mjs',
    old: "if (req.headers.host !== '127.0.0.1:' + port) fail(403, '请使用本地启动地址。');",
    new: "if (false) fail(403, '请使用本地启动地址。');",
    note: '去掉 Host 检查（非本地地址可触达发送路径）',
    kill: 'http/wrong-host' },
];

// 跑一轮（原始或变异）：启动 mock + 临时服务，执行全套检查，返回 { results, mock }。
async function runRound({ label, mutations = [] }) {
  const silent = (name, status, detail) => {
    if (status === 'FAIL') console.log('      ' + name + '  · ' + detail);
  };
  const queues = makeQueues();
  const mock = startMockModel(MOCK_PORT, queues, silent);
  const workDir = buildWorkDir({ mutations });
  const server = spawnGateServer({ dir: workDir.dir, dataDir: workDir.dataDir, port: PORT, mockPort: MOCK_PORT });
  if (!(await waitFor(BASE, server))) {
    console.log('FAIL  ' + label + ': server did not start（若提示端口占用，检查是否有残留 Daymark 进程）\n' + server.log());
    await server.stop();
    await mock.close();
    await rm(workDir.dir, { recursive: true, force: true });
    process.exit(1);
  }
  let results;
  try {
    results = await runGateChecks({ port: PORT, record: silent, quietTable: label !== 'baseline', dbFile: workDir.dataDir + '/daymark.sqlite' });
  } catch (error) {
    results = [{ name: 'suite-crash', status: 'FAIL', detail: String(error?.message ?? error).split('\n')[0] }];
  }
  await server.stop();
  await mock.close();
  await rm(workDir.dir, { recursive: true, force: true });
  const failed = results.filter(r => r.status === 'FAIL');
  return { label, results, failed, mockRequests: mock.requests.length };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  console.log('Mutation testing: 审批闸门关键条件（临时变异，工作树不改）');
  let allGood = true;

  console.log('\n[0] 原始代码基线（必须全绿）');
  const baseline = await runRound({ label: 'baseline' });
  if (baseline.failed.length) {
    for (const item of baseline.failed) console.log('  FAIL  ' + item.name + '  · ' + item.detail);
    console.log('\n基线未全绿：先修验收套件本身，再做变异测试。');
    process.exit(1);
  }
  console.log('  PASS  基线 ' + baseline.results.length + ' 项检查全部通过（mock 请求 ' + baseline.mockRequests + ' 次）');

  let killed = 0;
  for (const m of MUTATIONS) {
    const round = await runRound({ label: m.id, mutations: [m] });
    const killFailed = round.failed.some(r => r.name === m.kill);
    const ok = killFailed && round.failed.length >= 1;
    if (ok) killed++;
    console.log('\n[' + m.id + '] ' + m.note);
    console.log('      变异：' + m.file + ' → ' + m.old.replace(/\n/g, ' ⏎ ').slice(0, 70) + ' … → ' + m.new.replace(/\n/g, ' ⏎ ').slice(0, 40));
    console.log('      预期 kill 点：' + m.kill);
    console.log('      实际失败 ' + round.failed.length + ' 项：' + round.failed.map(r => r.name).join('、'));
    console.log('  ' + (ok ? 'KILLED ✓' : 'NOT KILLED ✗') + '  ' + (ok ? '变异被检查抓到' : '套件没有覆盖该条件，需要补检查'));
    if (!ok) allGood = false;
  }

  console.log('\n变异 ' + MUTATIONS.length + ' 个：' + killed + ' 个被杀，' + (MUTATIONS.length - killed) + ' 个漏网');
  process.exit(allGood ? 0 : 1);
}
