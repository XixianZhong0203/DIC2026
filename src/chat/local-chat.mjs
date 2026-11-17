const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const ignored = new Set(['the', 'a', 'to', 'is', 'in', 'of', 'what', 'can', 'for', 'i', '的', '了', '吗', '我', '你', '一下']);
export function words(text) {
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

// Local query reply (localReply) has been removed: all conversations now go through the model. rankRecords
// is still used for memory retrieval before the model.
