import { rankRecords, words } from './local-chat.mjs';

// Personalized PageRank with restart at the incoming edit. This small graph
// links memory records through shared terms and scopes.
export function memoryCandidates(edit, records, limit = 8) {
  const scope = edit.scope.trim().toLowerCase();
  const ranked = rankRecords(edit.body, records).map(({ record, score }) => ({
    record, seed: score + (record.scope.trim().toLowerCase() === scope ? 2 : 0),
  })).sort((a, b) => b.seed - a.seed).slice(0, 80);
  const total = ranked.reduce((sum, row) => sum + row.seed, 0);
  if (!total) return [];
  const restart = ranked.map(row => row.seed / total);
  const tokens = ranked.map(({ record }) => words(record.body));
  const links = ranked.map(({ record }, i) => ranked.map((other, j) => {
    if (i === j) return 0;
    const sameScope = record.scope.trim().toLowerCase() === other.record.scope.trim().toLowerCase();
    const common = [...tokens[i]].filter(word => tokens[j].has(word)).length;
    return (sameScope ? 1 : 0) + common;
  }));
  let relevance = restart;
  for (let step = 0; step < 20; step++) {
    const next = restart.map(weight => 0.15 * weight);
    for (const [i, row] of links.entries()) {
      const weight = row.reduce((sum, edge) => sum + edge, 0);
      for (const [j, edge] of row.entries()) {
        next[j] += 0.85 * relevance[i] * (weight ? edge / weight : restart[j]);
      }
    }
    relevance = next;
  }
  return ranked.map(({ record }, i) => ({ ...record, relevance: relevance[i] }))
    .filter(record => record.relevance > 0).sort((a, b) => b.relevance - a.relevance).slice(0, limit);
}

export function verifiedQuotes(facts, records) {
  const sources = new Map(records.map(record => [record.id, record]));
  return (Array.isArray(facts) ? facts : []).slice(0, 12).flatMap(fact => {
    const record = sources.get(fact?.id);
    return record && typeof fact.quote === 'string' && fact.quote.trim() && record.body.includes(fact.quote)
      ? [{ id: record.id, quote: fact.quote, source: record.source, kind: record.kind }] : [];
  });
}
