const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const ignored = new Set(['the', 'a', 'to', 'is', 'in', 'of', 'what', 'can', 'for', 'i', '的', '了', '吗', '我', '你', '一下']);
function words(text) {
  return new Set([...segmenter.segment(text.toLowerCase())]
    .filter(item => item.isWordLike && !ignored.has(item.segment)).map(item => item.segment));
}

export function rankRecords(question, records) {
  const terms = words(question);
  return records.map(record => {
    const matches = words(record.source + ' ' + record.body + ' ' + record.scope);
    return { record, score: [...terms].filter(word => matches.has(word)).length };
  }).sort((a, b) => b.score - a.score);
}

export function localReply(question, language, { records, tasks, release, verified }) {
  const en = language === 'en';
  const result = answer => ({ answer, cited: [], mode: 'local' });
  if (/^(你好|您好|嗨|hi|hello|hey)[!！。\s]*$/i.test(question)) {
    return result(en ? 'Hello. Ask me about a project record, your open tasks, or the current release status.'
      : '你好。你可以问我项目记录、未完成的待办，或当前版本的发布状态。');
  }
  if (/发布|测试|releas|test status/i.test(question) && /当前|版本|v0\.2|current/i.test(question)) {
    return result(verified
      ? (en ? `${release} has a passing simulated test record. Check the saved draft and approval before release.`
        : `${release} 有模拟测试通过记录。发布前请核对已保存的草稿及其授权。`)
      : (en ? `I cannot confirm ${release} passed testing. The current version has no passing simulated test record.`
        : `我无法确认 ${release} 已通过测试。当前版本没有模拟测试通过记录。`));
  }
  if (/待办|日程|日历|tasks?|calendar|schedule/i.test(question)) {
    const open = tasks.filter(task => !task.done).slice(0, 6);
    return result(open.length
      ? [en ? 'Open items in your workspace:' : '工作台中的未完成事项：',
        ...open.map(task => `• ${task.title} · ${task.starts.replace('T', ' ')}`)].join('\n')
      : en ? 'There are no open tasks in your workspace.' : '工作台里没有未完成的待办。');
  }
  const overview = /做到哪|项目进展|最近记录|project progress|where did we leave off/i.test(question);
  const cited = rankRecords(question, records).filter(match => overview || match.score > 0)
    .slice(0, 3).map(match => match.record);
  if (!cited.length) return result(en ? 'I could not find a matching record. Try a project name or keyword, or save the original source in Records.'
    : '我没有找到相关记录。可以换一个项目名或关键词，也可以先把原文存到资料里。');
  return {
    ...result([en ? 'Here are matching records. Open the sources below to check their context.' : '找到这些相关记录。可以展开下方出处核对上下文。',
      ...cited.map(record => `• #${record.id} · ${record.source}`)].join('\n')),
    cited,
  };
}
