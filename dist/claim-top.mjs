// 回答顶部状态文案（窗口 2）：由后端核查结果生成的 summary 决定回答正文上方显示的
// 整体状态标题。纯函数，不触碰 DOM，供 app.js 渲染与单元测试共用——保证界面文案与
// 后端的 status 口径一一对应、且不随渲染细节漂移。
//
// 状态与文案的对应（与任务书要求的五类顶部状态一致）：
//   failed    核查失败
//   conflict  发现证据冲突
//   refuted   证据反驳
//   attention 有关键说法待核实
//   verified  已核查 N 条，均有依据（N = total，写清「均有依据」的范围是已核查的 N 条）
//   none      本轮未抽取到可核查声明
export function claimTopTitle(summary, t) {
  if (!summary || typeof summary.status !== 'string') return t('核查失败');
  if (summary.status === 'verified') return t('已核查 {n} 条，均有依据').replace('{n}', String(summary.total ?? 0));
  return t({
    failed: '核查失败', conflict: '发现证据冲突', refuted: '证据反驳',
    attention: '有关键说法待核实', none: '本轮未抽取到可核查声明',
  }[summary.status] ?? '核查失败');
}
