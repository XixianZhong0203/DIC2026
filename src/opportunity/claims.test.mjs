import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { opportunityWorkflow } from './opportunities.mjs';
import { ANALYSIS_DIMENSIONS, DRAFT_DIMENSIONS, claimMessages, parseClaimReport, verifyClaims, draftChecks } from './claims.mjs';

const EVIDENCE = '客户询问了报价和交付周期。';

function fixture(assessReply, claimsReply) {
  const db = new DatabaseSync(':memory:');
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const required = value => value?.trim() || fail(400, 'Required');
  const complete = async messages => {
    const user = JSON.parse(messages.at(-1).content);
    if (user.mode) {
      if (claimsReply === 'fail') {
        const error = new Error('HTTP 500');
        error.status = 502;
        throw error;
      }
      return typeof claimsReply === 'function' ? claimsReply(user) : JSON.stringify(claimsReply);
    }
    return JSON.stringify(assessReply);
  };
  const workflow = opportunityWorkflow(db, { complete, model: 'test double', fail, required });
  const call = (action, body) => workflow.mutations['/api/' + action](body);
  call('opportunity', { kind: 'lead', title: '签约核查', source: '客户线程', evidence: EVIDENCE, evidence_kind: 'customer' });
  const current = () => workflow.state().opportunities[0];
  return { call, current, state: workflow.state };
}

test('draft mode instructs extraction of decision-relevant statements; analysis mode does not', () => {
  const sources = [{ id: 'E1', source: '客户线程', date: null, kind: 'evidence', text: EVIDENCE }];
  const draft = claimMessages({ mode: 'draft', draft: { recipient: 'a@b.c', body: '合同已签署。' },
    dimensions: DRAFT_DIMENSIONS, sources, language: 'zh-CN' });
  const draftSystem = draft[0].content;
  assert.ok(draftSystem.includes('合同已签署') && draftSystem.includes('已交付')
    && draftSystem.includes('保证某时间完成'), 'the draft-mode prompt names the decision-relevant statement classes');
  const analysis = claimMessages({ mode: 'analysis', dimensions: ANALYSIS_DIMENSIONS, sources, language: 'zh-CN' });
  assert.ok(!analysis[0].content.includes('草稿模式下声明列表为空'), 'analysis mode keeps the fixed dimension list');
});

test('a verbatim supporting quote establishes support and nothing more', () => {
  const sources = [{ id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望在本季度签约。' }];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户已确认签约', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: '希望在本季度签约', note: '表达签约意向' }],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(claim.status, 'supported');
  assert.equal(claim.decisive.source.date, '2026-06-20');
});

test('a quote that is not verbatim in the cited source leaves the claim incomplete', () => {
  const sources = [{ id: 'S1', source: '6 月邮件', date: null, kind: 'customer', text: '客户表示希望在本季度签约。' }];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户已确认签约', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: '客户确认了签约', note: '被改写的引文' }],
  }], sources);
  assert.equal(claim.status, 'incomplete');
  assert.ok(claim.failedChecks.some(check => check.reason === 'quote_not_found'));
});

test('citing a source that does not exist leaves the claim incomplete', () => {
  const sources = [{ id: 'S1', source: '6 月邮件', date: null, kind: 'customer', text: '客户表示希望在本季度签约。' }];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户已确认签约', status: 'supported',
    items: [{ evidenceId: 'S9', stance: 'supports', quote: '希望在本季度签约', note: '来源不存在' }],
  }], sources);
  assert.equal(claim.status, 'incomplete');
  assert.ok(claim.failedChecks.some(check => check.reason === 'unknown_source'));
});

test('a newer record that explicitly withdraws the older record supersedes it', () => {
  const sources = [
    { id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望在本季度签约。' },
    { id: 'S2', source: '7 月邮件', date: '2026-07-02', kind: 'customer', text: '客户表示撤回此前的签约意向。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'refuted',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '希望在本季度签约', note: '早前的意向' },
      { evidenceId: 'S2', stance: 'withdraws', quote: '撤回此前的签约意向', note: '明确撤回早前的表态', revises: ['S1'] },
    ],
  }], sources);
  assert.equal(claim.status, 'refuted');
  assert.equal(claim.withdrawn, true);
  assert.equal(claim.decisive.source.date, '2026-07-02');
});

test('when both records are still valid and cannot be ordered, the claim is a source conflict', () => {
  const sources = [
    { id: 'S1', source: '周一电话', date: '2026-07-06', kind: 'customer', text: '客户表示希望签约。' },
    { id: 'S2', source: '周一邮件', date: '2026-07-06', kind: 'customer', text: '客户表示暂不推进签约。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'conflict',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '希望签约', note: '同一天记录一' },
      { evidenceId: 'S2', stance: 'refutes', quote: '暂不推进签约', note: '同一天记录二' },
    ],
  }], sources);
  assert.equal(claim.status, 'conflict');
  assert.equal(claim.conflict.supports.length, 1);
  assert.equal(claim.conflict.opposes.length, 1);
});

test('undated records cannot be ordered either, so the claim stays a conflict', () => {
  const sources = [
    { id: 'S1', source: '电话', date: null, kind: 'customer', text: '客户表示希望签约。' },
    { id: 'S2', source: '邮件', date: null, kind: 'customer', text: '客户表示暂不推进签约。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'conflict',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '希望签约', note: '无日期' },
      { evidenceId: 'S2', stance: 'refutes', quote: '暂不推进签约', note: '无日期' },
    ],
  }], sources);
  assert.equal(claim.status, 'conflict');
});

test('a newer record that only contradicts, without an explicit revision, keeps the conflict with both originals', () => {
  const sources = [
    { id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望在本季度签约。' },
    { id: 'S2', source: '7 月邮件', date: '2026-07-02', kind: 'customer', text: '客户表示暂不推进签约。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'conflict',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '希望在本季度签约', note: '早前的意向' },
      { evidenceId: 'S2', stance: 'refutes', quote: '暂不推进签约', note: '后来的反驳，没有指明修订哪条' },
    ],
  }], sources);
  assert.equal(claim.status, 'conflict');
  assert.equal(claim.conflict.supports.length, 1);
  assert.equal(claim.conflict.opposes.length, 1);
  assert.equal(claim.conflict.supports[0].source.text, '客户表示希望在本季度签约。');
  assert.equal(claim.conflict.opposes[0].source.text, '客户表示暂不推进签约。');
});

test('a newer supporting record without an explicit revision does not settle an older refutation', () => {
  const sources = [
    { id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示暂不推进签约。' },
    { id: 'S2', source: '7 月邮件', date: '2026-07-02', kind: 'customer', text: '客户表示希望在下月签约。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'conflict',
    items: [
      { evidenceId: 'S1', stance: 'refutes', quote: '暂不推进签约', note: '早前的拒绝' },
      { evidenceId: 'S2', stance: 'supports', quote: '希望在下月签约', note: '后来的意向，没有指明修订哪条' },
    ],
  }], sources);
  assert.equal(claim.status, 'conflict');
});

test('a newer record that explicitly changes the same commitment supersedes by revision, not by date alone', () => {
  const sources = [
    { id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望下月签约。' },
    { id: 'S2', source: '7 月邮件', date: '2026-07-02', kind: 'customer', text: '客户表示签约时间改为下季度，原计划作废。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'refuted',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '希望下月签约', note: '早前的时间承诺' },
      { evidenceId: 'S2', stance: 'refutes', quote: '签约时间改为下季度，原计划作废', note: '明确修订了同一承诺', revises: ['S1'] },
    ],
  }], sources);
  assert.equal(claim.status, 'refuted');
  assert.equal(claim.withdrawn, false);
  assert.equal(claim.decisive.source.date, '2026-07-02');
});

test('a revision pointing at a record outside the claim cannot confirm supersession', () => {
  const sources = [
    { id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望在本季度签约。' },
    { id: 'S2', source: '7 月邮件', date: '2026-07-02', kind: 'customer', text: '客户表示撤回某项早期表态。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'conflict',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '希望在本季度签约', note: '早前的意向' },
      { evidenceId: 'S2', stance: 'withdraws', quote: '撤回某项早期表态', note: '撤回指向不明', revises: ['S9'] },
    ],
  }], sources);
  assert.equal(claim.status, 'conflict');
});

test('a revision that leaves an opposing record unrevised keeps the conflict', () => {
  const sources = [
    { id: 'S1', source: '6 月上旬邮件', date: '2026-06-10', kind: 'customer', text: '客户表示希望签约。' },
    { id: 'S2', source: '6 月下旬邮件', date: '2026-06-18', kind: 'customer', text: '客户再次表示希望签约。' },
    { id: 'S3', source: '7 月邮件', date: '2026-07-02', kind: 'customer', text: '客户表示撤回 6 月上旬的签约意向。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'conflict',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '希望签约', note: '6 月上旬的意向' },
      { evidenceId: 'S2', stance: 'supports', quote: '再次表示希望签约', note: '6 月下旬的意向' },
      { evidenceId: 'S3', stance: 'withdraws', quote: '撤回 6 月上旬的签约意向', note: '只撤回了 6 月上旬那条', revises: ['S1'] },
    ],
  }], sources);
  assert.equal(claim.status, 'conflict');
});

test('an explicit revision cannot confirm supersession while a record is undated', () => {
  const sources = [
    { id: 'S1', source: '电话', date: null, kind: 'customer', text: '客户表示希望签约。' },
    { id: 'S2', source: '7 月邮件', date: '2026-07-02', kind: 'customer', text: '客户表示撤回此前的签约意向。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'conflict',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '希望签约', note: '无日期的意向' },
      { evidenceId: 'S2', stance: 'withdraws', quote: '撤回此前的签约意向', note: '明确撤回', revises: ['S1'] },
    ],
  }], sources);
  assert.equal(claim.status, 'conflict');
});

test('a tied latest date cannot be ordered, so an explicit revision does not settle the claim', () => {
  const sources = [
    { id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望签约。' },
    { id: 'S2', source: '7 月电话', date: '2026-07-06', kind: 'customer', text: '客户表示撤回此前的签约意向。' },
    { id: 'S3', source: '7 月邮件', date: '2026-07-06', kind: 'customer', text: '客户表示暂不推进签约。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'conflict',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '希望签约', note: '早前的意向' },
      { evidenceId: 'S2', stance: 'withdraws', quote: '撤回此前的签约意向', note: '同日记录一', revises: ['S1'] },
      { evidenceId: 'S3', stance: 'refutes', quote: '暂不推进签约', note: '同日记录二' },
    ],
  }], sources);
  assert.equal(claim.status, 'conflict');
});

test('a newer explicit revision that supports the claim restores support', () => {
  const sources = [
    { id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示暂不推进签约。' },
    { id: 'S2', source: '7 月邮件', date: '2026-07-02', kind: 'customer', text: '客户表示恢复签约计划，此前的暂缓不再执行。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'supported',
    items: [
      { evidenceId: 'S1', stance: 'refutes', quote: '暂不推进签约', note: '早前的拒绝' },
      { evidenceId: 'S2', stance: 'supports', quote: '恢复签约计划，此前的暂缓不再执行', note: '明确修订了早前的拒绝', revises: ['S1'] },
    ],
  }], sources);
  assert.equal(claim.status, 'supported');
  assert.equal(claim.withdrawn, false);
  assert.equal(claim.decisive.source.date, '2026-07-02');
});

test('a string revises value is normalized and still confirms supersession', () => {
  const sources = [
    { id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望在本季度签约。' },
    { id: 'S2', source: '7 月邮件', date: '2026-07-02', kind: 'customer', text: '客户表示撤回此前的签约意向。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'refuted',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '希望在本季度签约', note: '早前的意向' },
      { evidenceId: 'S2', stance: 'withdraws', quote: '撤回此前的签约意向', note: '明确撤回', revises: 'S1' },
    ],
  }], sources);
  assert.equal(claim.status, 'refuted');
  assert.equal(claim.withdrawn, true);
});

test('insufficient evidence is a concrete gap plus an evidence-supported rewrite', () => {
  const [claim] = verifyClaims([{
    id: '购买意向', dimension: '购买意向', text: '客户有购买意向', status: 'unknown',
    items: [], missing: '缺少预算确认和购买时间表', rewrite: '客户询问了报价和交付周期，购买意向尚未确认',
  }], [{ id: 'E1', source: '客户线程', date: null, kind: 'evidence', text: EVIDENCE }]);
  assert.equal(claim.status, 'unknown');
});

test('unknown without a concrete gap or rewrite is not admissible', () => {
  const [claim] = verifyClaims([{
    id: '购买意向', dimension: '购买意向', text: '客户有购买意向', status: 'unknown',
    items: [], missing: '', rewrite: '',
  }], [{ id: 'E1', source: '客户线程', date: null, kind: 'evidence', text: EVIDENCE }]);
  assert.equal(claim.status, 'incomplete');
  assert.ok(claim.failedChecks.some(check => check.reason === 'field_conflict'));
});

test('a draft claim that is not verbatim in the draft body cannot be verified', () => {
  const sources = [{ id: 'E1', source: '客户线程', date: null, kind: 'evidence', text: EVIDENCE }];
  const [claim] = verifyClaims([{
    id: '业绩', dimension: '公司业绩', text: '业绩翻番', status: 'unknown',
    items: [], missing: '缺少业绩数据', rewrite: '业绩稳步增长',
  }], sources, { body: '感谢关注，期待合作。' });
  assert.equal(claim.status, 'incomplete');
  assert.ok(claim.failedChecks.some(check => check.reason === 'claim_not_in_draft'));
});

test('an assessment stores request context and auto-verifies the decision-relevant claims', async () => {
  const { call, current, state } = fixture(
    { status: 'unknown', quote: EVIDENCE, reason: '仅询问，未确认购买意向' },
    user => JSON.stringify({ claims: user.dimensions.map(dimension => ({
      id: dimension, dimension, text: dimension, status: 'unknown', items: [],
      missing: '缺少确认信息', rewrite: '尚未确认',
    }))}),
  );
  const { id } = current();
  await call('opportunity-assess', { id, request: '这个客户有购买意向吗？', language: 'zh-CN' });
  const item = current();
  assert.equal(JSON.parse(item.analysis).request, '这个客户有购买意向吗？');
  assert.equal(item.claims.target, 'analysis');
  assert.equal(item.claimsStale, false);
  assert.deepEqual(item.claims.claims.map(claim => [claim.id, claim.status]),
    [['购买意向', 'unknown'], ['签约状态', 'unknown']]);
  assert.ok(state().audit.some(event => event.action === 'claims_checked'));
});

test('a failed model request stores an incomplete review and still returns normally', async () => {
  const { call, current, state } = fixture({ status: 'unknown' }, 'fail');
  const { id } = current();
  await call('opportunity-claims', { id, target: 'analysis', language: 'zh-CN' });
  const item = current();
  assert.equal(item.claims.error, 'HTTP 500');
  assert.ok(item.claims.claims.every(claim => claim.status === 'incomplete'));
  assert.ok(item.claims.claims.every(claim => claim.failedChecks.some(check => check.reason === 'request_failed')));
  assert.ok(state().audit.some(event => event.action === 'claims_failed'));
});

test('adding a newer withdrawal source re-verifies and flips the current state to withdrawn', async () => {
  const { call, current } = fixture(
    { status: 'unknown', quote: EVIDENCE, reason: '未确认' },
    user => JSON.stringify({
      claims: [{
        id: '签约状态', dimension: '签约状态', text: '签约状态',
        items: user.sources.filter(source => source.text.includes('签约')).map(source => ({
          evidenceId: source.id,
          stance: source.text.includes('暂不推进') ? 'withdraws' : 'supports',
          quote: source.text.includes('暂不推进') ? '暂不推进签约' : '希望在本季度签约',
          note: source.text.includes('暂不推进') ? '客户撤回了签约表态' : '客户曾表达签约意向',
          revises: source.text.includes('暂不推进')
            ? user.sources.filter(other => other.text.includes('希望在本季度签约')).map(other => other.id)
            : [],
        })),
        missing: '', rewrite: '',
      }, {
        id: '购买意向', dimension: '购买意向', text: '购买意向',
        items: [], missing: '缺少预算与购买计划确认', rewrite: '客户询问了报价和交付周期',
      }],
    }),
  );
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户会签约吗？', language: 'zh-CN' });
  await call('opportunity-source', { id, name: '6 月客户邮件', date: '2026-06-20', kind: 'customer',
    text: '客户表示希望在本季度签约。', language: 'zh-CN' });
  let item = current();
  assert.equal(item.claims.target, 'analysis');
  assert.equal(item.claims.claims[0].status, 'supported');
  await call('opportunity-source', { id, name: '7 月客户邮件', date: '2026-07-02', kind: 'customer',
    text: '客户表示暂不推进签约。', language: 'zh-CN' });
  item = current();
  assert.equal(item.claimsStale, false);
  assert.equal(item.claims.claims[0].status, 'refuted');
  assert.equal(item.claims.claims[0].withdrawn, true);
  assert.equal(item.claims.claims[0].decisive.source.date, '2026-07-02');
});

test('a newer refuting source keeps the stored conflict with both originals until a confirmed explicit withdrawal flips the state', async () => {
  const { call, current } = fixture(
    { status: 'unknown', quote: EVIDENCE, reason: '未确认' },
    user => JSON.stringify({
      claims: [{
        id: '签约状态', dimension: '签约状态', text: '签约状态',
        items: user.sources.filter(source => source.text.includes('签约')).map(source => {
          if (source.text.includes('撤回')) return {
            evidenceId: source.id, stance: 'withdraws', quote: '撤回此前的签约意向',
            note: '明确撤回早前的签约意向',
            revises: user.sources.filter(other => other.text.includes('希望签约')).map(other => other.id),
          };
          if (source.text.includes('不推进')) return {
            evidenceId: source.id, stance: 'refutes', quote: '暂不推进签约', note: '改口不推进，但没有指明修订哪条',
          };
          return {
            evidenceId: source.id, stance: 'supports', quote: '希望签约', note: '客户曾表达签约意向',
          };
        }),
        missing: '', rewrite: '',
      }, {
        id: '购买意向', dimension: '购买意向', text: '购买意向',
        items: [], missing: '缺少预算与购买计划确认', rewrite: '客户询问了报价和交付周期',
      }],
    }),
  );
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户会签约吗？', language: 'zh-CN' });
  await call('opportunity-source', { id, name: '6 月客户邮件', date: '2026-06-20', kind: 'customer',
    text: '客户表示希望签约。', language: 'zh-CN' });
  await call('opportunity-source', { id, name: '7 月客户邮件', date: '2026-07-02', kind: 'customer',
    text: '客户表示暂不推进签约。', language: 'zh-CN' });
  let claim = current().claims.claims[0];
  assert.equal(claim.status, 'conflict');
  assert.equal(claim.conflict.supports[0].source.text, '客户表示希望签约。');
  assert.equal(claim.conflict.opposes[0].source.text, '客户表示暂不推进签约。');
  await call('opportunity-source', { id, name: '8 月客户邮件', date: '2026-08-01', kind: 'customer',
    text: '客户明确表示撤回此前的签约意向。', language: 'zh-CN' });
  claim = current().claims.claims[0];
  assert.equal(claim.status, 'refuted');
  assert.equal(claim.withdrawn, true);
  assert.equal(claim.decisive.source.date, '2026-08-01');
});

test('a non-verbatim quote from the model leaves the stored review incomplete', async () => {
  const { call, current } = fixture({ status: 'unknown' }, user => JSON.stringify({
    claims: [{
      id: '签约状态', dimension: '签约状态', text: '签约状态',
      items: [{ evidenceId: 'E1', stance: 'supports', quote: '客户确认了签约', note: '引文被改写' }],
      missing: '', rewrite: '',
    }, {
      id: '购买意向', dimension: '购买意向', text: '购买意向',
      items: [], missing: '缺少预算与购买计划确认', rewrite: '客户询问了报价和交付周期',
    }],
  }));
  const { id } = current();
  await call('opportunity-claims', { id, target: 'analysis', language: 'zh-CN' });
  const claim = current().claims.claims[0];
  assert.equal(claim.status, 'incomplete');
  assert.ok(claim.failedChecks.some(check => check.reason === 'quote_not_found'));
});

test('two dated records on the same day that cannot be ordered are stored as a conflict', async () => {
  const { call, current } = fixture({ status: 'unknown' }, user => JSON.stringify({
    claims: [{
      id: '签约状态', dimension: '签约状态', text: '签约状态',
      // 只引用谈签约的两条当天记录（E1 是客户线程原文，与签约无关）。
      items: user.sources.filter(source => source.text.includes('签约')).map(source => ({
        evidenceId: source.id,
        stance: source.text.includes('不推进') ? 'refutes' : 'supports',
        quote: source.text.includes('不推进') ? '暂不推进签约' : '希望签约',
        note: '同一天的两条记录',
      })),
      missing: '', rewrite: '',
    }, {
      id: '购买意向', dimension: '购买意向', text: '购买意向',
      items: [], missing: '缺少预算与购买计划确认', rewrite: '客户询问了报价和交付周期',
    }],
  }));
  const { id } = current();
  await call('opportunity-source', { id, name: '周一电话', date: '2026-07-06', kind: 'customer',
    text: '客户表示希望签约。', language: 'zh-CN' });
  await call('opportunity-source', { id, name: '周一邮件', date: '2026-07-06', kind: 'customer',
    text: '客户表示暂不推进签约。', language: 'zh-CN' });
  await call('opportunity-claims', { id, target: 'analysis', language: 'zh-CN' });
  const claim = current().claims.claims[0];
  assert.equal(claim.status, 'conflict');
  assert.equal(claim.conflict.supports.length, 1);
  assert.equal(claim.conflict.opposes.length, 1);
});

test('draft verification binds to the saved version; a new draft goes stale until re-verified', async () => {
  const { call, current } = fixture(
    { status: 'unknown', quote: EVIDENCE, reason: '未确认' },
    user => {
      if (!user.draft) {
        return JSON.stringify({ claims: user.dimensions.map(dimension => ({
          id: dimension, dimension, text: dimension, status: 'unknown', items: [],
          missing: '缺少确认信息', rewrite: '尚未确认',
        })),
        });
      }
      const claims = [];
      for (const [text, dimension] of [['签约', '签约状态'], ['业绩翻番', '公司业绩']]) {
        if (user.draft.body.includes(text)) {
          claims.push({ id: text, dimension, text, status: 'unknown', items: [],
            missing: '缺少' + text + '的核实信息', rewrite: text + '（待确认）' });
        }
      }
      return JSON.stringify({ claims });
    },
  );
  const { id } = current();
  await call('opportunity-assess', { id, request: '客户意向如何？', language: 'zh-CN' });
  call('opportunity-draft', { id, recipient: 'client@example.test', body: '我们下个月签约，业绩翻番。' });
  const oldDraft = current().draft_id;
  assert.ok(oldDraft);
  await call('opportunity-claims', { id, target: 'draft', draft_id: oldDraft, language: 'zh-CN' });
  let item = current();
  assert.equal(item.claims.target, 'draft');
  assert.equal(item.claimsStale, false);
  assert.equal(item.claims.claims.length, 2);
  assert.ok(item.claims.claims.every(claim => claim.status === 'unknown'));
  // 采用改写：先保存新草稿版本，再重新核查。
  await call('opportunity-draft', { id, recipient: 'client@example.test',
    body: (item.body ?? '').replaceAll('业绩翻番', '业绩翻番（待确认）') });
  item = current();
  assert.notEqual(item.draft_id, oldDraft);
  assert.equal(item.claimsStale, true);
  await call('opportunity-claims', { id, target: 'draft', language: 'zh-CN' });
  item = current();
  assert.equal(item.claimsStale, false);
  assert.equal(item.claims.draftId, item.draft_id);
});

test('an outdated draft id is rejected for draft verification; omitting it re-binds to the current draft', async () => {
  const { call, current } = fixture({ status: 'unknown' }, user => JSON.stringify({
    claims: user.draft ? [] : user.dimensions.map(dimension => ({
      id: dimension, dimension, text: dimension, status: 'unknown', items: [],
      missing: '缺少确认信息', rewrite: '尚未确认',
    })),
  }));
  const { id } = current();
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'v1' });
  const oldDraft = current().draft_id;
  call('opportunity-draft', { id, recipient: 'client@example.test', body: 'v2' });
  assert.notEqual(current().draft_id, oldDraft);
  await assert.rejects(
    () => call('opportunity-claims', { id, target: 'draft', draft_id: oldDraft, language: 'zh-CN' }),
    { status: 409, message: '草稿已变更，请重新核对后确认。' },
  );
  await call('opportunity-claims', { id, target: 'draft', language: 'zh-CN' });
  assert.equal(current().claims.draftId, current().draft_id);
});

test('sources accept a date, a founder identity, and reject invalid input', async () => {
  const { call, current } = fixture({ status: 'unknown' }, 'fail');
  const { id } = current();
  await call('opportunity-source', { id, name: '创始人确认', date: '2026-07-01', kind: 'founder',
    text: '创始人确认客户预算已到位。', language: 'zh-CN' });
  assert.deepEqual(current().sources.map(row => [row.kind, row.date]), [['founder', '2026-07-01']]);
  await assert.rejects(
    () => call('opportunity-source', { id, name: '坏日期', date: '2026-02-30', kind: 'customer', text: 'x', language: 'zh-CN' }),
    { status: 400 },
  );
  await assert.rejects(
    () => call('opportunity-source', { id, name: '坏类型', kind: 'other', text: 'x', language: 'zh-CN' }),
    { status: 400 },
  );
  assert.equal(current().sources.length, 1);
});

// —— 创始人自述与证据判定：仅创始人陈述 vs 有客户来源支持 ——

test('supporting quotes all from founder sources leave the claim founder_only, not supported', () => {
  const sources = [
    { id: 'E1', source: '客户线程', date: null, kind: 'evidence', text: '客户询问了报价和交付周期。' },
    { id: 'S1', source: '创始人记录', date: null, kind: 'founder', text: '客户已签约，合同生效。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: '客户已签约', note: '创始人陈述已完成事实' }],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(claim.status, 'founder_only');
  assert.equal(claim.decisive.source.kind, 'founder');
});

test('an intent-only customer quote does not change the founder-only state', () => {
  const sources = [
    { id: 'E1', source: '客户线程', date: null, kind: 'evidence', text: '客户询问了报价和交付周期。' },
    { id: 'S1', source: '创始人记录', date: null, kind: 'founder', text: '客户已签约，合同生效。' },
    { id: 'S2', source: '客户邮件', date: '2026-07-02', kind: 'customer', text: '我们愿意签约，期待合作。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'supported',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '客户已签约', note: '创始人陈述已完成事实' },
      { evidenceId: 'S2', stance: 'neutral', quote: '我们愿意签约', note: '只表达意愿，未陈述已签署' },
    ],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(claim.status, 'founder_only');
  assert.equal(claim.decisive.source.kind, 'founder');
});

test('a customer quote that states the completed fact upgrades the claim to supported', () => {
  const sources = [
    { id: 'S1', source: '创始人记录', date: null, kind: 'founder', text: '客户已签约，合同生效。' },
    { id: 'S2', source: '合同记录', date: '2026-07-05', kind: 'customer', text: '客户已于 7 月 5 日签署合同。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'supported',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '客户已签约', note: '创始人陈述' },
      { evidenceId: 'S2', stance: 'supports', quote: '签署合同', note: '客户来源记录已完成事实' },
    ],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(claim.status, 'supported');
  assert.equal(claim.decisive.source.kind, 'customer');
});

test('support recorded as a customer record keeps the claim supported', () => {
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'supported',
    items: [{ evidenceId: 'E1', stance: 'supports', quote: '双方已签署合同', note: '客户原文逐字陈述' }],
    missing: '', rewrite: '',
  }], [{ id: 'E1', source: '客户线程', date: null, kind: 'customer', text: '双方已签署合同。' }]);
  assert.equal(claim.status, 'supported');
});

test('an initial source with unconfirmed identity leaves the claim unconfirmed, quote still admissible', () => {
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'supported',
    items: [{ evidenceId: 'E1', stance: 'supports', quote: '客户已签约', note: '来源身份未确认的陈述' }],
    missing: '', rewrite: '',
  }], [{ id: 'E1', source: '客户线程', date: null, kind: 'unconfirmed', text: '客户已签约。' }]);
  assert.equal(claim.status, 'unconfirmed');
  assert.equal(claim.decisive.source.kind, 'unconfirmed');
  assert.deepEqual(claim.failedChecks, []);
});

test('a legacy generic evidence quote is read as unconfirmed, not as verified support', () => {
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'supported',
    items: [{ evidenceId: 'E1', stance: 'supports', quote: '客户已签约', note: '旧版通用来源' }],
    missing: '', rewrite: '',
  }], [{ id: 'E1', source: '客户线程', date: null, kind: 'evidence', text: '客户已签约。' }]);
  assert.equal(claim.status, 'unconfirmed');
});

test('an unconfirmed source mixed with a founder statement stays unconfirmed', () => {
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'supported',
    items: [
      { evidenceId: 'E1', stance: 'supports', quote: '客户已签约', note: '来源未确认' },
      { evidenceId: 'S1', stance: 'supports', quote: '客户已签约', note: '创始人陈述' },
    ],
    missing: '', rewrite: '',
  }], [
    { id: 'E1', source: '客户线程', date: null, kind: 'unconfirmed', text: '客户已签约。' },
    { id: 'S1', source: '创始人记录', date: null, kind: 'founder', text: '客户已签约。' },
  ]);
  assert.equal(claim.status, 'unconfirmed');
});

test('a neutral customer quote cannot supply the customer-side support', () => {
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'supported',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '客户已签约', note: '创始人陈述' },
      { evidenceId: 'S2', stance: 'neutral', quote: '我们愿意签约', note: '只表达意愿' },
    ],
    missing: '', rewrite: '',
  }], [
    { id: 'S1', source: '创始人记录', date: null, kind: 'founder', text: '客户已签约。' },
    { id: 'S2', source: '客户邮件', date: '2026-07-02', kind: 'customer', text: '我们愿意签约，期待合作。' },
  ]);
  assert.equal(claim.status, 'founder_only');
});

test('a neutral stance is admissible and neither supports nor opposes the claim', () => {
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'unknown',
    items: [{ evidenceId: 'S1', stance: 'neutral', quote: '我们愿意签约', note: '意向，未陈述已签署' }],
    missing: '缺少已签署合同的记录', rewrite: '客户表示愿意签约',
  }], [{ id: 'S1', source: '客户邮件', date: null, kind: 'customer', text: '我们愿意签约，期待合作。' }]);
  assert.equal(claim.status, 'unknown');
  assert.deepEqual(claim.failedChecks, []);
});

test('a neutral undated record still keeps an otherwise decisive revision a conflict', () => {
  const sources = [
    { id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望在本季度签约。' },
    { id: 'S2', source: '7 月邮件', date: '2026-07-02', kind: 'customer', text: '客户表示撤回此前的签约意向。' },
    { id: 'S3', source: '客户备注', date: null, kind: 'customer', text: '客户表示愿意签约，期待合作。' },
  ];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'conflict',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: '希望在本季度签约', note: '早前的意向' },
      { evidenceId: 'S2', stance: 'withdraws', quote: '撤回此前的签约意向', note: '明确撤回', revises: ['S1'] },
      { evidenceId: 'S3', stance: 'neutral', quote: '愿意签约', note: '无日期备注，只表达意愿' },
    ],
    missing: '需要确认无日期备注与已撤回意向的先后', rewrite: '',
  }], sources);
  assert.equal(claim.status, 'conflict');
  assert.equal(claim.conflict.supports.length, 1);
  assert.equal(claim.conflict.opposes.length, 1);
});

test('the prompt names the neutral stance and the founder/customer source boundary', () => {
  const sources = [{ id: 'E1', source: '客户线程', date: null, kind: 'evidence', text: EVIDENCE }];
  const zh = claimMessages({ mode: 'draft', draft: { recipient: 'a@b.c', body: '合同已签署。' },
    dimensions: DRAFT_DIMENSIONS, sources, language: 'zh-CN' })[0].content;
  assert.ok(zh.includes('neutral 相关但不定论') && zh.includes('创始人转述客户的话仍是创始人来源')
    && zh.includes('不记 supports'), 'the zh prompt covers neutral and the founder boundary');
  const en = claimMessages({ mode: 'draft', draft: { recipient: 'a@b.c', body: '合同已签署。' },
    dimensions: DRAFT_DIMENSIONS, sources, language: 'en' })[0].content;
  assert.ok(en.includes('neutral') && en.includes('still a founder source')
    && en.includes('never supports'), 'the en prompt covers neutral and the founder boundary');
});

// —— parseClaimReport：结构错误判 parse_failed；重复声明 ID 去重并记 warning ——

test('malformed model output is a parse failure, never a partial review', () => {
  const malformed = [
    '{"claims":[{"id":"a"',            // 截断的 JSON
    'Here is the report:\n{"claims":[]}',  // JSON 前后裹了散文
    '```json\n{"claims":[]',           // 只有开头的代码围栏
    '{"claims":"none"}',               // claims 不是数组
    '',                                // 空输出
  ];
  for (const raw of malformed) {
    assert.throws(() => parseClaimReport(raw, {}), { reason: 'parse_failed', message: '结构无效' });
  }
});

test('output wrapped in a complete JSON code fence still parses', () => {
  const raw = '```json\n{"claims":[{"id":"签约状态","dimension":"签约状态","text":"客户会签约","status":"unknown","items":[],"missing":"缺少确认","rewrite":"尚未确认"}]}\n```';
  const { claims, warnings } = parseClaimReport(raw, {});
  assert.equal(claims.length, 1);
  assert.deepEqual(warnings, []);
});

test('analysis mode requires every expected dimension id', () => {
  assert.throws(() => parseClaimReport(
    JSON.stringify({ claims: [{ id: '购买意向', dimension: '购买意向', text: '客户有购买意向',
      status: 'unknown', items: [], missing: '缺少预算确认', rewrite: '尚未确认' }] }),
    { mode: 'analysis', expectIds: ANALYSIS_DIMENSIONS },
  ), { reason: 'field_conflict', message: '缺少声明 签约状态' });
});

test('a duplicate claim id keeps the first occurrence and records a warning', () => {
  const raw = JSON.stringify({ claims: [
    { id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'unknown', items: [], missing: '缺少确认', rewrite: '尚未确认' },
    { id: '签约状态', dimension: '签约状态', text: '同 ID 的重复抽取', status: 'unknown', items: [], missing: '缺少确认', rewrite: '尚未确认' },
  ]});
  const { claims, warnings } = parseClaimReport(raw, {});
  assert.equal(claims.length, 1);
  assert.equal(claims[0].text, '客户会签约');
  assert.deepEqual(warnings, [{ reason: 'duplicate_claim_id', id: '签约状态' }]);
});

// —— 字段矛盾：缺 note、立场值不在枚举、模型谎报 supported 都没有引文支撑 ——

test('an item without a note, or with an unknown stance, is a field conflict leaving the claim incomplete', () => {
  const sources = [{ id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望在本季度签约。' }];
  const [noNote] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: '希望在本季度签约' }],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(noNote.status, 'incomplete');
  assert.ok(noNote.failedChecks.some(check => check.reason === 'field_conflict'));
  const [badStance] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'backing', quote: '希望在本季度签约', note: '立场值不在枚举内' }],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(badStance.status, 'incomplete');
  assert.ok(badStance.failedChecks.some(check => check.reason === 'field_conflict'));
});

test('a model-asserted supported status without any supporting items is never supported', () => {
  const sources = [{ id: 'S1', source: '6 月邮件', date: null, kind: 'customer', text: '客户表示希望在本季度签约。' }];
  const [forged] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'supported',
    items: [], missing: '', rewrite: '',
  }], sources);
  assert.equal(forged.status, 'incomplete');
  assert.ok(forged.failedChecks.some(check => check.reason === 'field_conflict'));
});

// —— 捣乱输入：额外字段、缺字段、空引文都不能改变判定、不能产生假通过 ——

test('extra fields on the report, a claim, or an item do not change the verdict', () => {
  const sources = [{ id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望在本季度签约。' }];
  const base = {
    id: '签约状态', dimension: '签约状态', text: '客户已确认签约', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: '希望在本季度签约', note: '表达签约意向' }],
    missing: '', rewrite: '',
  };
  // 模型多吐字段：顶层备注/模型名、声明上的置信度与推理、条目上的打分——都不得影响判定。
  const { claims, warnings } = parseClaimReport(JSON.stringify({
    notes: '顶层额外信息', model: 'test double',
    claims: [{
      ...base,
      confidence: 0.99, reasoning: '客户想签约', extra: { nested: { a: 1 } },
      items: base.items.map(item => ({ ...item, score: 1, flagged: true, modelNote: '条目级额外信息' })),
    }],
  }), {});
  assert.equal(claims.length, 1);
  assert.deepEqual(warnings, []);
  assert.equal(claims[0].status, 'supported');
  const [clean] = verifyClaims(parseClaimReport(JSON.stringify({ claims: [base] }), {}).claims, sources);
  const [messy] = verifyClaims(claims, sources);
  assert.equal(messy.status, 'supported');
  assert.deepEqual(messy.failedChecks, []);
  assert.deepEqual(messy, clean, 'extra fields must not change the verdict');
});

test('a claim missing status/items/missing/rewrite is incomplete; unknown needs missing plus rewrite', () => {
  const sources = [{ id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望在本季度签约。' }];
  const [sparse] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户已确认签约',
  }], sources);
  assert.equal(sparse.status, 'incomplete');
  assert.ok(sparse.failedChecks.some(check => check.reason === 'field_conflict'));
  // 缺 items 键但有具体缺口与改写：unknown 可采信。
  const [noItemsKey] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户会签约',
    missing: '缺少已签署合同的记录', rewrite: '客户表示希望在本季度签约',
  }], sources);
  assert.equal(noItemsKey.status, 'unknown');
  assert.deepEqual(noItemsKey.failedChecks, []);
  assert.deepEqual(noItemsKey.items, []);
});

test('an item with an empty (or blank) quote is a quote_not_found leaving the claim incomplete', () => {
  const sources = [{ id: 'S1', source: '6 月邮件', date: '2026-06-20', kind: 'customer', text: '客户表示希望在本季度签约。' }];
  for (const quote of ['', '   ']) {
    const [claim] = verifyClaims([{
      id: '签约状态', dimension: '签约状态', text: '客户会签约', status: 'supported',
      items: [{ evidenceId: 'S1', stance: 'supports', quote, note: '空引文' }],
      missing: '', rewrite: '',
    }], sources);
    assert.equal(claim.status, 'incomplete');
    assert.ok(claim.failedChecks.some(check => check.reason === 'quote_not_found'));
  }
});

// —— 草稿正文检查：空原文与截断否定词（仅 body 存在时生效，判未完成核查） ——

test('a draft claim with empty text is an incomplete verification', () => {
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '', status: 'unknown',
    items: [], missing: '', rewrite: '',
  }], [], { body: '感谢关注，期待合作。' });
  assert.equal(claim.status, 'incomplete');
  assert.ok(claim.failedChecks.some(check => check.reason === 'empty_claim_text'));
});

test('a draft claim whose only occurrences in the body are negated is an incomplete verification', () => {
  const cases = [
    ['承诺下周交付', '我们不会承诺下周交付。'],
    ['承诺下周交付', '我们不承诺下周交付。'],
    ['commit to delivery', 'We will not commit to delivery next week.'],
  ];
  for (const [text, body] of cases) {
    const [claim] = verifyClaims([{
      id: '交付', dimension: '对外承诺', text, status: 'unknown',
      items: [], missing: '缺少客户确认', rewrite: '尚未确认',
    }], [], { body });
    assert.equal(claim.status, 'incomplete', `expected incomplete for ${text} in ${body}`);
    assert.ok(claim.failedChecks.some(check => check.reason === 'truncated_negation'),
      `expected truncated_negation for ${text} in ${body}`);
  }
});

test('a clean or mixed occurrence is not flagged; without a body the checks never run', () => {
  const [zh] = verifyClaims([{
    id: '交付', dimension: '对外承诺', text: '承诺下周交付', status: 'unknown',
    items: [], missing: '缺少客户确认', rewrite: '尚未确认',
  }], [], { body: '我们承诺下周交付。' });
  assert.equal(zh.status, 'unknown');
  assert.deepEqual(zh.failedChecks, []);
  const [en] = verifyClaims([{
    id: '交付', dimension: '对外承诺', text: 'commit to delivery', status: 'unknown',
    items: [], missing: 'no confirmation yet', rewrite: 'not yet confirmed',
  }], [], { body: 'We commit to delivery next week.' });
  assert.equal(en.status, 'unknown');
  assert.deepEqual(en.failedChecks, []);
  // 混合出现：正文里既有被否定的一次也有正向的一次 → 不整体判截断。
  const [mixed] = verifyClaims([{
    id: '交付', dimension: '对外承诺', text: '按期完成', status: 'unknown',
    items: [], missing: '缺少客户确认', rewrite: '尚未确认',
  }], [], { body: '我们不会承诺下周交付，但会按期完成。' });
  assert.deepEqual(mixed.failedChecks, []);
  // 同一段正文里，只被否定过的那条仍判截断。
  const [mixedNegated] = verifyClaims([{
    id: '交付', dimension: '对外承诺', text: '承诺下周交付', status: 'unknown',
    items: [], missing: '缺少客户确认', rewrite: '尚未确认',
  }], [], { body: '我们不会承诺下周交付，但会按期完成。' });
  assert.ok(mixedNegated.failedChecks.some(check => check.reason === 'truncated_negation'));
  // 分析模式没有 body：即使原文与某个假设正文构成否定关系也不运行检查。
  const [analysis] = verifyClaims([{
    id: '交付', dimension: '对外承诺', text: '承诺下周交付', status: 'unknown',
    items: [], missing: '缺少客户确认', rewrite: '尚未确认',
  }], []);
  assert.equal(analysis.status, 'unknown');
  assert.deepEqual(analysis.failedChecks, []);
});

test('an occurrence at the very start of the body has no prefix and is not a truncated negation', () => {
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'unknown',
    items: [], missing: '缺少合同记录', rewrite: '尚未确认',
  }], [], { body: '合同已签署。' });
  assert.equal(claim.status, 'unknown');
  assert.deepEqual(claim.failedChecks, []);
});

// —— 引文上下文检查：逐字存在还不够，片段必须自带完整语义（验收线）——
// 「The contract is not signed」里的「signed」、「approved pending board review」里的「approved」、
// 「合同尚未签署」里的「签署」、「需经董事会批准后生效」里的「生效」——截掉否定词/条件/限定的
// 片段不能采信：不能凭它判 supported（也不能凭它判 refuted），结构化失败原因带原文子句与原因。

test('acceptance: a fragment stripped of its negation (not signed) is missing key context, never supported', () => {
  const sources = [{ id: 'S1', source: '客户邮件', date: null, kind: 'customer', text: 'The contract is not signed.' }];
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: 'The contract is signed', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: 'signed', note: '只引了 signed' }],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(claim.status, 'incomplete', 'a truncated fragment cannot establish support');
  const check = claim.failedChecks.find(entry => entry.reason === 'quote_missing_context');
  assert.ok(check, 'the structured failure reason is recorded');
  assert.equal(check.clause, 'The contract is not signed.');
  assert.ok(check.detail.includes('not') && check.detail.includes('The contract is not signed.'), 'the reason names the cut negation and the original clause');
  const item = claim.items[0];
  assert.equal(item.valid, false);
  assert.ok(item.reasons.includes('quote_missing_context'));
  assert.equal(item.quoteContext.clause, 'The contract is not signed.');
  assert.equal(item.quoteContext.occurrences, 1);
  assert.equal(item.quoteContext.issue.reason, 'quote_missing_context');
});

test('acceptance: a fragment stripped of a trailing condition (approved pending board review) is missing key context', () => {
  const sources = [{ id: 'S1', source: '董事会记录', date: null, kind: 'customer', text: 'The proposal was approved pending board review.' }];
  for (const quote of ['approved', 'was approved']) {
    const [claim] = verifyClaims([{
      id: '签约状态', dimension: '签约状态', text: 'The proposal is approved', status: 'supported',
      items: [{ evidenceId: 'S1', stance: 'supports', quote, note: '只引了片段' }],
      missing: '', rewrite: '',
    }], sources);
    assert.equal(claim.status, 'incomplete', `quote ${JSON.stringify(quote)} must be flagged`);
    const check = claim.failedChecks.find(entry => entry.reason === 'quote_missing_context');
    assert.ok(check, `structured reason for ${JSON.stringify(quote)}`);
    assert.equal(check.clause, 'The proposal was approved pending board review.');
    assert.ok(check.detail.includes('pending board review'), 'the reason names the cut qualifier');
  }
});

test('acceptance: Chinese fragments cut from 尚未签署 / 需经董事会批准后生效 are flagged; quoting the full clause is admissible', () => {
  const cases = [
    { text: '合同尚未签署。', cut: '签署', full: '尚未签署' },
    { text: '合同需经董事会批准后生效。', cut: '生效', full: '需经董事会批准后生效' },
  ];
  for (const { text, cut, full } of cases) {
    const sources = [{ id: 'S1', source: '客户邮件', date: null, kind: 'customer', text }];
    const [cutClaim] = verifyClaims([{
      id: '签约状态', dimension: '签约状态', text: cut, status: 'supported',
      items: [{ evidenceId: 'S1', stance: 'supports', quote: cut, note: '只引了片段' }],
      missing: '', rewrite: '',
    }], sources);
    assert.equal(cutClaim.status, 'incomplete', `${cut} alone must be flagged in ${text}`);
    const check = cutClaim.failedChecks.find(entry => entry.reason === 'quote_missing_context');
    assert.ok(check, `structured reason for ${cut}`);
    assert.equal(check.clause, text);
    // 引完整子句（否定/条件都在引文内）即可采信：同一来源判 supported。
    const [fullClaim] = verifyClaims([{
      id: '签约状态', dimension: '签约状态', text: full, status: 'supported',
      items: [{ evidenceId: 'S1', stance: 'supports', quote: full, note: '引完整子句' }],
      missing: '', rewrite: '',
    }], sources);
    assert.equal(fullClaim.status, 'supported', `quoting ${full} is admissible`);
    assert.deepEqual(fullClaim.failedChecks, []);
  }
});

test('acceptance: complete, unambiguous quotes stating the fact still support the claim', () => {
  const positives = [
    { text: 'The contract is signed.', quote: 'signed' },
    { text: '客户已于 7 月 5 日签署合同。', quote: '签署合同' },
    { text: '合同已签署。', quote: '已签署' },
  ];
  for (const { text, quote } of positives) {
    const sources = [{ id: 'S1', source: '客户邮件', date: null, kind: 'customer', text }];
    const [claim] = verifyClaims([{
      id: '签约状态', dimension: '签约状态', text: quote, status: 'supported',
      items: [{ evidenceId: 'S1', stance: 'supports', quote, note: '完整且明确的引文' }],
      missing: '', rewrite: '',
    }], sources);
    assert.equal(claim.status, 'supported', `quote ${JSON.stringify(quote)} in ${text} is a clean support`);
    assert.deepEqual(claim.failedChecks, []);
    assert.equal(claim.items[0].quoteContext.issue, null);
  }
});

test('a truncated fragment is inadmissible for refutation as well, and a parallel clean quote from another source cannot rescue the flagged item', () => {
  const sources = [
    { id: 'S1', source: '客户邮件', date: null, kind: 'customer', text: 'The contract is not signed.' },
    { id: 'S2', source: '合同记录', date: '2026-07-05', kind: 'customer', text: '客户已于 7 月 5 日签署合同。' },
  ];
  // 截断片段作 refutes 同样不可采信。
  const [refuted] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: 'The contract is signed', status: 'refuted',
    items: [{ evidenceId: 'S1', stance: 'refutes', quote: 'signed', note: '只引了 signed' }],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(refuted.status, 'incomplete');
  assert.ok(refuted.failedChecks.some(check => check.reason === 'quote_missing_context'));
  // 即使同一条声明里另有干净的支持引文，被标记的引文仍使核查未完成（确定性校验不放过坏引文）。
  const [mixed] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: 'The contract is signed', status: 'supported',
    items: [
      { evidenceId: 'S1', stance: 'supports', quote: 'signed', note: '被截断的片段' },
      { evidenceId: 'S2', stance: 'supports', quote: '签署合同', note: '完整引文' },
    ],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(mixed.status, 'incomplete');
  assert.ok(mixed.failedChecks.some(check => check.reason === 'quote_missing_context' && check.clause === 'The contract is not signed.'));
  assert.equal(mixed.items[1].valid, true, 'the clean parallel quote stays admissible');
});

test('acceptance: the same fragment in different clauses needs the negated occurrence flagged first, then a longer quote to disambiguate', () => {
  const mixedSources = [{ id: 'S1', source: '客户邮件', date: null, kind: 'customer', text: '客户表示合同已签署。客户表示合同尚未签署。' }];
  const [mixed] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: '签署', note: '两处出现' }],
    missing: '', rewrite: '',
  }], mixedSources);
  // 多处出现且其中一处被截掉否定词：按缺少关键上下文标记，指出问题子句。
  assert.equal(mixed.status, 'incomplete');
  const check = mixed.failedChecks.find(entry => entry.reason === 'quote_missing_context');
  assert.ok(check);
  assert.equal(check.clause, '客户表示合同尚未签署。');
  assert.equal(mixed.items[0].quoteContext.occurrences, 2);

  const ambiguousSources = [{ id: 'S1', source: '客户邮件', date: null, kind: 'customer', text: '客户希望下月签约。客户希望下季度签约。' }];
  const [ambiguous] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户希望下月签约', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: '希望', note: '短片段多处出现' }],
    missing: '', rewrite: '',
  }], ambiguousSources);
  // 两处都干净但子句不同（含义不同）：要求更完整的引文消除歧义。
  assert.equal(ambiguous.status, 'incomplete');
  const ambiguousCheck = ambiguous.failedChecks.find(entry => entry.reason === 'quote_ambiguous');
  assert.ok(ambiguousCheck, 'ambiguity is a structured failure reason');
  assert.ok(ambiguousCheck.detail.includes('2'));
  // 更长、唯一出现的片段消除歧义后即可采信。
  const [longer] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '客户希望下月签约', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: '希望下月签约', note: '唯一出现的更长片段' }],
    missing: '', rewrite: '',
  }], ambiguousSources);
  assert.equal(longer.status, 'supported');
  assert.deepEqual(longer.failedChecks, []);
  assert.equal(longer.items[0].quoteContext.occurrences, 1);
});

test('english periods delimit clauses: repeated fragments in different sentences are ambiguous, decimals do not split', () => {
  const sources = [{ id: 'S1', source: '客户邮件', date: null, kind: 'customer',
    text: 'The terms were revised. The revised terms apply.' }];
  const [ambiguous] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: 'The terms were revised', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: 'revised', note: '两处出现' }],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(ambiguous.status, 'incomplete');
  const check = ambiguous.failedChecks.find(entry => entry.reason === 'quote_ambiguous');
  assert.ok(check, 'cross-sentence repetition is ambiguous');
  assert.equal(ambiguous.items[0].quoteContext.occurrences, 2);
  assert.equal(ambiguous.items[0].quoteContext.clause, 'The terms were revised.');
  // 引完整子句后唯一出现即可采信。
  const [clean] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: 'The terms were revised', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: 'The terms were revised', note: '唯一出现' }],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(clean.status, 'supported');
  assert.deepEqual(clean.failedChecks, []);

  // 小数里的句点不划界：「3.5」不切开句子，其后的否定仍作用于片段。
  const decSources = [{ id: 'S1', source: '客户邮件', date: null, kind: 'customer',
    text: 'The discount of 3.5 is not final.' }];
  const [dec] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: 'The discount is final', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: 'final', note: '被截断片段' }],
    missing: '', rewrite: '',
  }], decSources);
  assert.equal(dec.status, 'incomplete');
  assert.ok(dec.failedChecks.some(entry => entry.reason === 'quote_missing_context'
    && entry.clause === 'The discount of 3.5 is not final.'));
});

test('a condition phrase separated by a comma still counts as cut-off context; a plain temporal adverb does not', () => {
  const sources = [{ id: 'S1', source: '客户邮件', date: null, kind: 'customer',
    text: '合同需经董事会批准后，生效。' }];
  const [cut] = verifyClaims([{
    id: '生效条件', dimension: '生效条件', text: '合同生效', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: '生效', note: '只引了片段' }],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(cut.status, 'incomplete');
  const check = cut.failedChecks.find(entry => entry.reason === 'quote_missing_context');
  assert.equal(check.clause, '合同需经董事会批准后，生效。');
  // 引文把条件短语与逗号都带上即可采信。
  const [full] = verifyClaims([{
    id: '生效条件', dimension: '生效条件', text: '合同需经董事会批准后生效', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: '需经董事会批准后，生效', note: '引完整条件句' }],
    missing: '', rewrite: '',
  }], sources);
  assert.equal(full.status, 'supported');
  assert.deepEqual(full.failedChecks, []);

  // 简单时间状语（无条件标记）不算截掉的关键上下文，不误报。
  const plainSources = [{ id: 'S1', source: '客户邮件', date: null, kind: 'customer',
    text: '合同生效后付款。' }];
  const [plain] = verifyClaims([{
    id: '付款条件', dimension: '付款条件', text: '合同生效后付款', status: 'supported',
    items: [{ evidenceId: 'S1', stance: 'supports', quote: '付款', note: '时间状语非关键条件' }],
    missing: '', rewrite: '',
  }], plainSources);
  assert.equal(plain.status, 'supported');
  assert.deepEqual(plain.failedChecks, []);
});

test('the prompt tells the model to quote the whole clause and to disambiguate repeated fragments', () => {
  const sources = [{ id: 'E1', source: '客户线程', date: null, kind: 'evidence', text: EVIDENCE }];
  const zh = claimMessages({ mode: 'draft', draft: { recipient: 'a@b.c', body: '合同已签署。' },
    dimensions: DRAFT_DIMENSIONS, sources, language: 'zh-CN' })[0].content;
  assert.ok(zh.includes('引完整子句') && zh.includes('合同尚未签署') && zh.includes('需经董事会批准后生效')
    && zh.includes('只出现一次'), 'the zh prompt covers clause-internal cuts and disambiguation');
  const en = claimMessages({ mode: 'draft', draft: { recipient: 'a@b.c', body: '合同已签署。' },
    dimensions: DRAFT_DIMENSIONS, sources, language: 'en' })[0].content;
  assert.ok(en.includes('quote the whole clause') && en.includes('"The contract is not signed"')
    && en.includes('occurs exactly once'), 'the en prompt covers clause-internal cuts and disambiguation');
});

// —— draftChecks：占位符与未被抽取的高风险句（独立于模型输出的确定性检查） ——

test('a second commitment in one sentence that was not extracted surfaces as unextracted', () => {
  const { placeholders, unextracted } = draftChecks('我们承诺下周五前完成交付，并在两周内完成上线。', ['下周五前完成交付']);
  assert.deepEqual(placeholders, []);
  assert.deepEqual(unextracted, ['在两周内完成上线']);
});

test('English commitments that were not extracted surface as unextracted', () => {
  const { unextracted } = draftChecks('We will complete delivery by Friday, and launch within two weeks.', []);
  assert.deepEqual(unextracted, ['We will complete delivery by Friday', 'launch within two weeks']);
});

test('bracket placeholders are pending items; the full-width （待确认） rewrite convention is not', () => {
  assert.deepEqual(draftChecks('费用为[待确认：具体金额]元。', []).placeholders, ['[待确认：具体金额]']);
  assert.deepEqual(draftChecks('费用为[待核实]元。', []).placeholders, ['[待核实]']);
  assert.deepEqual(draftChecks('The amount [TBD] will follow.', []).placeholders, ['[TBD]']);
  assert.deepEqual(draftChecks('费用（待确认）后补。', []).placeholders, []);
});

// —— E2E：核查结果随 warnings 与 draftChecks 一起落库并暴露给界面 ——

test('the stored draft review carries the deterministic pending items', async () => {
  const { call, current } = fixture(
    { status: 'unknown', quote: EVIDENCE, reason: '未确认' },
    user => JSON.stringify({
      claims: user.draft ? [{
        id: '交付', dimension: '对外承诺', text: '下周五前完成交付', status: 'unknown',
        items: [], missing: '缺少客户对交付时间的确认', rewrite: '预计下周五前完成交付（待确认）',
      }] : user.dimensions.map(dimension => ({
        id: dimension, dimension, text: dimension, status: 'unknown', items: [],
        missing: '缺少确认信息', rewrite: '尚未确认',
      })),
    }),
  );
  const { id } = current();
  call('opportunity-draft', { id, recipient: 'client@example.test',
    body: '我们承诺下周五前完成交付，并在两周内完成上线。' });
  await call('opportunity-claims', { id, target: 'draft', language: 'zh-CN' });
  const item = current();
  assert.equal(item.claimsStale, false);
  assert.deepEqual(item.claims.warnings, []);
  assert.deepEqual(item.claims.draftChecks, { placeholders: [], unextracted: ['在两周内完成上线'] });
});
