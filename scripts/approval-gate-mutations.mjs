// approval gate · critical condition temporary mutation test
//
// Perform "temporary mutation" on each key condition of the gate one by one: make a byte-level copy of the
// service code in a temporary directory (working tree byte-level copy, replacing only src/models.mjs with
// the local mock directory), apply a single mutation, start the real service, and run the same set of
// approval-gate-acceptance checks. Criteria:
// - The original code suite must be all green (otherwise it is a test issue itself, fix the tests first);
// - The mutated code must be caught by the pre-declared corresponding check (kill point) -- if not caught,
// it means the suite has no protection for this condition, and a check needs to be added.
// Mutations only apply to the temporary copy: the working tree is not modified (temporary mutation,
// deleted immediately after running).
//
// Two suites are exercised:
// - gate     : scripts/approval-gate-acceptance.mjs (send gate state table, HTTP layer, forged approval,
// concurrency);
// - security : scripts/security-regression-acceptance.mjs (carried-over draft flags, exact recipient
// disclosure, hosted input screening, placeholders, claim-specific guarantee version binding, archive
// digest, English synthetic product flow, malformed model output).
// Each mutation declares the suite that owns its kill point.
//
// Usage: node scripts/approval-gate-mutations.mjs

import { rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWorkDir, spawnGateServer, startMockModel, makeQueues, runGateChecks, waitFor } from './approval-gate-acceptance.mjs';
import { buildSecurityWorkDir, startSecurityMock, runSecurityChecks } from './security-regression-acceptance.mjs';

const PORT = 4231;
const MOCK_PORT = 4232;
const BASE = 'http://127.0.0.1:' + PORT;
const SECURITY_PORT = 4233;
const SECURITY_MOCK_PORT = 4234;
const SECURITY_BASE = 'http://127.0.0.1:' + SECURITY_PORT;

// Key condition (anchors must appear uniquely in the working tree, buildWorkDir will validate).
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
  { id: 'M8', suite: 'security', file: 'src/opportunity/opportunities.mjs',
    old: 'if (unhandledPrevious.length) {', new: 'if (false) {',
    note: 'drop the carried-over draft flag check (a flag raised on an older version no longer blocks the send)',
    kill: 'carried-over-flags/previous-claim-blocks-send' },
  { id: 'M9', suite: 'security', file: 'src/opportunity/disclosure.mjs',
    old: "decision: rule.scope === 'recipient' && rule.recipient === address ? 'allowed' : 'blocked',",
    new: "decision: rule.scope === 'recipient' ? 'allowed' : 'blocked',",
    note: 'release a protected excerpt to any recipient instead of the exact one',
    kill: 'disclosure/other-recipient-is-blocked' },
  { id: 'M10', suite: 'security', file: 'server.mjs',
    old: 'if (hosted && workflow.hasRestrictedModelInput(messages)) {', new: 'if (false) {',
    note: 'drop the hosted input screening (protected source text may reach a hosted model)',
    kill: 'hosted-input/protected-text-is-refused' },
  { id: 'M11', suite: 'security', file: 'src/opportunity/opportunities.mjs',
    old: 'if (placeholders.length || unresolvedCoverage.length) {', new: 'if (unresolvedCoverage.length) {',
    note: 'drop the placeholder check (an unresolved placeholder no longer blocks the send)',
    kill: 'placeholders/unresolved-placeholder-blocks-the-send' },
  { id: 'M12', suite: 'security', file: 'src/opportunity/opportunities.mjs',
    old: 'row.draftId === (item.draft_id ?? null) && row.evidence === evidence);',
    new: 'row.evidence === evidence);',
    note: 'drop the draft version binding of a claim guarantee (an old guarantee releases a newer version)',
    kill: 'guarantee/version-binding-expires-with-the-draft' },
  { id: 'M13', suite: 'security', file: 'src/opportunity/archive.mjs',
    old: "status: actual === recorded.digest ? 'verified' : 'mismatch', digest: recorded.digest, actual };",
    new: "status: 'verified', digest: recorded.digest, actual };",
    note: 'always report the archive digest as verified (tampering with the stored archive is not detected)',
    kill: 'archive/digest-verifies-and-detects-tampering' },
];

const SUITES = ['gate', 'security'];

// Run one round (original or mutated): start mock + temporary service, execute the full set of checks,
// return { results, mock }.
async function runRound({ label, mutations = [], suite = 'gate' }) {
  if (suite === 'security') return runSecurityRound({ label, mutations });
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

// Security suite round: same temporary-copy procedure, the mock answers from the request content and
// the model endpoint is flagged as hosted so the hosted input screening is exercised end to end.
async function runSecurityRound({ label, mutations = [] }) {
  const silent = (name, status, detail) => {
    if (status === 'FAIL') console.log('      ' + name + '  · ' + detail);
  };
  const mock = startSecurityMock(SECURITY_MOCK_PORT);
  const workDir = buildSecurityWorkDir({ mutations });
  const server = spawnGateServer({ dir: workDir.dir, dataDir: workDir.dataDir, port: SECURITY_PORT, mockPort: SECURITY_MOCK_PORT });
  if (!(await waitFor(SECURITY_BASE, server))) {
    console.log('FAIL  ' + label + ': server did not start（若提示端口占用，检查是否有残留 Daymark 进程）\n' + server.log());
    await server.stop();
    await mock.close();
    await rm(workDir.dir, { recursive: true, force: true });
    process.exit(1);
  }
  let results;
  try {
    results = await runSecurityChecks({ port: SECURITY_PORT, record: silent, dbFile: workDir.dataDir + '/daymark.sqlite' });
  } catch (error) {
    results = [{ name: 'suite-crash', status: 'FAIL', detail: String(error?.message ?? error).split('\n')[0] }];
  }
  await server.stop();
  await mock.close();
  await rm(workDir.dir, { recursive: true, force: true });
  const failed = results.filter(r => r.status === 'FAIL');
  return { label, results, failed, mockRequests: mock.requests().length };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  console.log('Mutation testing: 审批闸门与安全回归关键条件（临时变异，工作树不改）');
  let allGood = true;

  for (const suite of SUITES) {
    console.log('\n[0] 原始代码基线 · ' + suite + '（必须全绿）');
    const baseline = await runRound({ label: 'baseline:' + suite, suite });
    if (baseline.failed.length) {
      for (const item of baseline.failed) console.log('  FAIL  ' + item.name + '  · ' + item.detail);
      console.log('\n基线未全绿：先修验收套件本身，再做变异测试。');
      process.exit(1);
    }
    console.log('  PASS  基线 ' + baseline.results.length + ' 项检查全部通过（mock 请求 ' + baseline.mockRequests + ' 次）');
  }

  let killed = 0;
  for (const m of MUTATIONS) {
    const round = await runRound({ label: m.id, mutations: [m], suite: m.suite ?? 'gate' });
    const killFailed = round.failed.some(r => r.name === m.kill);
    const ok = killFailed && round.failed.length >= 1;
    if (ok) killed++;
    console.log('\n[' + m.id + '] ' + m.note);
    console.log('      套件：' + (m.suite ?? 'gate'));
    console.log('      变异：' + m.file + ' → ' + m.old.replace(/\n/g, ' ⏎ ').slice(0, 70) + ' … → ' + m.new.replace(/\n/g, ' ⏎ ').slice(0, 40));
    console.log('      预期 kill 点：' + m.kill);
    console.log('      实际失败 ' + round.failed.length + ' 项：' + round.failed.map(r => r.name).join('、'));
    console.log('  ' + (ok ? 'KILLED ✓' : 'NOT KILLED ✗') + '  ' + (ok ? '变异被检查抓到' : '套件没有覆盖该条件，需要补检查'));
    if (!ok) allGood = false;
  }

  console.log('\n变异 ' + MUTATIONS.length + ' 个：' + killed + ' 个被杀，' + (MUTATIONS.length - killed) + ' 个漏网');
  process.exit(allGood ? 0 : 1);
}
