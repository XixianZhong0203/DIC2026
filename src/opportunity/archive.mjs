import { createHash, randomUUID } from 'node:crypto';

// 发送档案（send-archive 窗口）：一次（模拟）发送的不可变快照。
//
// 设计原则——自包含：档案内嵌全部判定原料（当时的草稿正文与收件人、来源快照全文、
// 逐条声明判定与引文、查看记录、核查模型/思考档位/提示版本、批准依据与批准时间），
// 不保留任何指向活动数据的指针。因此发送之后来源或草稿再怎么修改，
// 旧档案仍能还原「当时基于什么批准了什么」（本窗口的验收线）。
//
// 分工（窗口对齐）：
//   本窗口：档案字段（schema）、构建器 buildSendArchive、存储、导出（/api/opportunity-archive/:id）
//   与界面三档来源展示。
//   窗口 1：/api/opportunity-send 门槛通过后的写入——复用的正是下面这个纯函数，
//   它传入的 approval 取自当时的 approved 审计（basis/sentAt 以发送时刻为准）。
//   构建器是 schema 的唯一来源；发送前手动冻结（/api/opportunity-archive）与发送时写入共用它。

export const SCHEMA_VERSION = 1;

const sha256 = value => createHash('sha256').update(value).digest('hex');

// 来源快照：初始来源（E1，身份由用户录入的 evidence_kind 决定）+ 逐条添加的来源（S<id>）。
// 与核查输入（opportunities.mjs 的 verificationSources）同形：这份快照就是「提供给模型的来源」。
export function sourceSnapshot(opportunity, sourceRows) {
  return [
    { id: 'E1', source: opportunity.source, date: null, kind: opportunity.evidence_kind ?? 'unconfirmed', text: opportunity.evidence },
    ...(sourceRows ?? []).map(row => ({ id: 'S' + row.id, source: row.name, date: row.date ?? null, kind: row.kind, text: row.text })),
  ];
}

// 档案构建器：把发送（或冻结）时刻的全部判定原料收进一份自包含快照。
// 三档来源在这里一次性区分清楚（界面直接按这些字段展示）：
//   sourcesProvidedToModel  提供给模型的来源 = 核查输入全集（快照全部 ID）；
//   answerCitedSources      回答引用的来源   = 分析逐字摘录所出（E1，有摘录时）+ 结构化回答明指的来源（answer.supporting）；
//   claims[].supportingSources  核查判定支持该声明的来源 = 每条声明里 stance=supports 的有效引文所在来源。
export function buildSendArchive(ctx) {
  const {
    opportunity, sourceRows, claims = null, analysis = null, answer = null,
    reviewViewed = null, viewingTrail = [], model = null, effort = null,
    prompts = {}, approval = {},
  } = ctx;

  const snapshot = sourceSnapshot(opportunity, sourceRows);
  const byId = new Map(snapshot.map(source => [source.id, source]));
  const entryOf = id => {
    const source = byId.get(id);
    return source ? { id: source.id, name: source.source, kind: source.kind, date: source.date } : null;
  };

  // 回答引用的来源：分析的引文逐字出自初始来源（E1）；answer.supporting 是回答明指的来源。
  const cited = new Map();
  if (analysis?.quote?.trim()) cited.set('E1', 'E1');
  for (const entry of answer?.supporting ?? []) {
    if (byId.has(entry.id)) cited.set(entry.id, entry.id);
  }

  const claimEntries = (claims?.claims ?? []).map(claim => {
    const items = claim.items ?? [];
    const supporting = items.filter(entry => entry.valid && entry.stance === 'supports' && entry.source?.id);
    return {
      id: claim.id,
      dimension: claim.dimension,
      text: claim.text,
      status: claim.status,
      withdrawn: claim.withdrawn ?? false,
      // 逐条担保理由：每条引文的立场、逐字引文、说明、是否通过程序校验。
      items: items.map(entry => ({
        evidenceId: entry.evidenceId, stance: entry.stance, quote: entry.quote,
        note: entry.note, revises: entry.revises ?? [], valid: entry.valid,
        reasons: entry.reasons ?? [],
      })),
      // 核查判定支持该声明的来源：stance=supports 的有效引文，按来源去重、保序。
      supportingSources: [...new Map(supporting.map(entry => [entry.source.id, entry])).values()]
        .map(entry => ({ id: entry.source.id, name: entry.source.source, kind: entry.source.kind,
          quote: entry.quote, note: entry.note })),
      missing: claim.missing ?? '',
      rewrite: claim.rewrite ?? '',
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    archiveId: randomUUID(),
    opportunityId: opportunity.id,
    kind: opportunity.kind,
    title: opportunity.title,
    // 批准时间：窗口 1 发送时写入传真实发送时刻；手动冻结传冻结时刻。
    sentAt: approval.sentAt ?? new Date().toISOString(),
    sent: approval.sent ?? Boolean(opportunity.sent),
    approval: {
      draftId: approval.draftId ?? opportunity.draft_id ?? null,
      recipient: approval.recipient ?? opportunity.recipient ?? null,
      // 当时的草稿：正文是不可变快照，活动草稿之后怎么改都不影响档案。
      body: approval.body ?? opportunity.body ?? null,
      bodyHash: approval.bodyHash ?? sha256(opportunity.body ?? ''),
      mode: approval.mode ?? null,
      // human_review = 针对当前草稿与来源的人工复核结论；model_supported = 草稿声明核查通过；
      // pending = 冻结时尚未满足发送门槛。
      basis: approval.basis ?? 'pending',
      resolution: approval.resolution ?? null,
      guarantees: approval.guarantees ?? [],
      reviewedCoverage: approval.reviewedCoverage ?? [],
    },
    // 来源快照（含全文）：发送后来源被修改，这里仍是「当时的来源」。
    sources: snapshot,
    sourcesProvidedToModel: snapshot.map(source => source.id),
    answerCitedSources: [...cited.values()].map(entryOf).filter(Boolean),
    verification: {
      model,
      // 思考档位：null = 端点默认档位（核查路径不逐请求指定档位）。
      effort,
      prompts: { claims: prompts.claims ?? null, analysis: prompts.analysis ?? null },
      target: claims?.target ?? null,
      at: claims?.at ?? null,
      // 核查失败时记录原因（原文与来源不受失败影响，档案如实呈现「未完成核查」）。
      error: claims?.error ?? null,
      // 核查绑定：当时的草稿/收件人/正文哈希/来源集合指纹——「当时基于什么判定」的指纹。
      evidenceHash: claims?.evidenceHash ?? null,
      draftId: claims?.draftId ?? null,
      recipient: claims?.recipient ?? null,
      bodyHash: claims?.bodyHash ?? null,
    },
    claims: claimEntries,
    answer: answer ?? null,
    analysis: analysis ? {
      analysisId: analysis.analysisId ?? null,
      status: analysis.status ?? null,
      quote: analysis.quote ?? '',
      reason: analysis.reason ?? '',
    } : null,
    // 查看记录：viewed/viewedNames 是冻结时刻绑定（草稿 + 来源集合）下已展开的来源；
    // records 是全部查看动作轨迹（各带自己的绑定与时间戳），供完整还原。
    viewing: {
      draftId: reviewViewed?.draftId ?? null,
      evidence: reviewViewed?.evidence ?? null,
      viewed: reviewViewed?.viewed ?? [],
      viewedNames: (reviewViewed?.viewed ?? []).map(id => byId.get(id)?.source ?? id),
      records: viewingTrail.map(entry => ({
        sourceId: entry.sourceId, name: entry.name, kind: entry.kind,
        draftId: entry.draftId ?? null, evidence: entry.evidence ?? null, time: entry.time ?? null,
      })),
    },
  };
}

// —— 存储（opportunity_archives）：档案是不可变快照，只插入、不更新 ——

export function createArchiveTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_archives (
      id TEXT PRIMARY KEY, opportunity TEXT NOT NULL, created TEXT NOT NULL, archive TEXT NOT NULL
    );
  `);
}

export function storeArchive(db, archive) {
  db.prepare('INSERT INTO opportunity_archives(id, opportunity, created, archive) VALUES (?,?,?,?)')
    .run(archive.archiveId, archive.opportunityId, new Date().toISOString(), JSON.stringify(archive));
  return archive;
}

export function loadArchive(db, archiveId) {
  const row = db.prepare('SELECT archive FROM opportunity_archives WHERE id=?').get(archiveId);
  try { return row ? JSON.parse(row.archive) : null; } catch { return null; }
}

export function archivesForOpportunity(db, opportunityId) {
  return db.prepare('SELECT archive FROM opportunity_archives WHERE opportunity=? ORDER BY created DESC, rowid DESC').all(opportunityId)
    .map(row => { try { return JSON.parse(row.archive); } catch { return null; } })
    .filter(Boolean);
}
