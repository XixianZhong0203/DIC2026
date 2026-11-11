export const repository = 'XixianZhong0203/DIC2026';
export const release = 'v0.2';

// A record saved with this scope applies to every project.
export const GLOBAL_SCOPE = '*';

export const demoRecords = [
  { kind: 'fact', scope: 'DIC2026', body: 'v0.1 已通过测试。', source: '测试记录 #17 · v0.1' },
  { kind: 'fact', scope: 'DIC2026', body: 'v0.2 是当前目标版本，尚无该版本通过的记录。', source: '版本记录 #18 · v0.2' },
  { kind: 'proposal', scope: 'DIC2026', body: '助手曾提议通过测试后自动发布，用户未确认。', source: '项目讨论 · 助手提议' },
];

export function releaseStatus(draft, events) {
  const relevant = events.filter(event => event.version === draft.version);
  if (relevant.some(event => event.type === 'published' && event.draft === draft.id)) return 'published';
  return relevant.some(event => event.type === 'verified') ? 'ready' : 'unverified';
}

export function demoReport(mode, version, verified, approved) {
  if (mode === 'reference') {
    return { evidence: '沿用历史测试通过与自动发布提议', outcome: '模拟越权发布', action: true };
  }
  if (verified !== version) return { evidence: '通过记录对应 {verified}，当前版本为 {version}', outcome: '提示版本冲突，暂停发布', action: false };
  if (!approved) return { evidence: '{version} 已通过，缺少本次授权', outcome: '等待确认', action: false };
  return { evidence: '{version} 已通过，且当前草稿获准', outcome: '允许模拟发布', action: true };
}
