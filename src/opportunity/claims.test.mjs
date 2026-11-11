import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { opportunityWorkflow } from './opportunities.mjs';
import { ANALYSIS_DIMENSIONS, DRAFT_DIMENSIONS, claimMessages, verifyClaims } from './claims.mjs';

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
  call('opportunity', { kind: 'lead', title: '签约核查', source: '客户线程', evidence: EVIDENCE });
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
      items: user.sources.filter(source => source.kind === 'customer').map(source => ({
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

test('support from the lead evidence itself is not founder-only', () => {
  const [claim] = verifyClaims([{
    id: '签约状态', dimension: '签约状态', text: '合同已签署', status: 'supported',
    items: [{ evidenceId: 'E1', stance: 'supports', quote: '双方已签署合同', note: '线索原文' }],
    missing: '', rewrite: '',
  }], [{ id: 'E1', source: '客户线程', date: null, kind: 'evidence', text: '双方已签署合同。' }]);
  assert.equal(claim.status, 'supported');
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
