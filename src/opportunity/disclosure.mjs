// Explicitly selected verbatim excerpts are checked across all leads.
export function disclosureDecisions(body, recipient, rules) {
  const address = (recipient ?? '').trim().toLowerCase();
  return rules.filter(rule => body.includes(rule.excerpt)).map(rule => ({
    opportunityId: rule.opportunity,
    sourceId: rule.source_id,
    sourceName: rule.source_name,
    excerpt: rule.excerpt,
    scope: rule.scope,
    allowedRecipient: rule.recipient,
    decision: rule.scope === 'recipient' && rule.recipient === address ? 'allowed' : 'blocked',
  }));
}
