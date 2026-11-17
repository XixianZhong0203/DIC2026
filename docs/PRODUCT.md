# Daymark product and implementation guide

## 1. How can the founder audit the assistant's reasoning and actions?

- **Inspect the basis of a reply.** The evidence panel shows the workspace used, retrieved records, verbatim excerpts, model inferences, open questions, and whether a second search ran. Retrieved records are the context supplied for the turn. Citations show which records the reply points to, and claim verdicts show which excerpts the verifier judged to support or oppose an extracted assertion. Model explanations remain summaries.
- **Follow a decision through to its outcome.** A decision card records the option selected and whether it was applied, paused, or failed. A calendar receipt shows the old and new time. The task activity log stores before-and-after values and links a change to its source and decision card when available.
- **Review simulated outreach.** The activity log records source changes, claim checks, drafts, source openings, manual review, approvals, blocks, and duplicate approval attempts. Every new simulated send saves a downloadable JSON archive with the draft and its hash, source originals, cited and supporting evidence, available model and prompt metadata, claim-specific guarantees, and the approval time. Later edits to the live draft or sources leave that snapshot intact. The approval audit stores a SHA-256 digest of the exact stored JSON bytes. Downloads expose `X-Archive-Integrity` as `verified`, `mismatch`, or `unrecorded`. This detects a changed archive when the audit record is intact. [Send archive](../src/opportunity/archive.mjs)
- **Review a simulated release.** The release view records verification for the current draft revision, simulated publication, duplicate attempts, and blocks for missing or stale verification.

See [reply and action routes](../server.mjs), [verbatim quote validation](../src/memory/memory-impact.mjs), [task audit and receipts](../src/tasks/task-audit.mjs), [outreach workflow](../src/opportunity/opportunities.mjs), and [release policy](../src/policy/policy.mjs).

### Retrieval score

Ordinary retrieval uses `Intl.Segmenter` to split text into words, including Chinese text. It lowercases terms, filters common words, and counts the distinct terms shared by the query and the record's source name, text, and scope. Chinese paraphrases with little shared wording can still miss relevant records.

```
score(query, record) = |terms(query) ∩ terms(source + body + scope)|
```

Daymark selects up to 12 positively scored records. If the model identifies missing evidence and reports no conflict, it can search once more using up to two stated gaps. That search can add up to four unused fact or source records with a score of at least two. A verbatim citation check requires a source ID from the supplied records and an exact substring in that record. [Retrieval implementation](../src/chat/local-chat.mjs)

## 2. What happens when instructions conflict or the assistant is uncertain?

- **Start with the right workspace.** A chat retrieves its project's active memories and records explicitly saved as global. The global marker cannot be used as a project name. Extracted customer facts and proposals stay in the current project. A workspace change can start a fresh conversation with the current input. The app distinguishes continuing, starting a new task, switching, and comparing workspaces. Cross-workspace merges and moves of populated chats are blocked. The founder can browse another workspace’s records and import selected records into the current workspace or share them globally. Copies retain their original workspace, source, and who the record applies to. Sharing controls where a record is visible. The separate applicability field tells the assistant whether a record is a general practice or a term specific to a customer or project. For example, the founder can consult another project’s pricing process while keeping that project’s customer-specific terms in their original context. [Intent classification](../src/chat/chat-intent.mjs) · [Workspace routes](../server.mjs)
- **Keep decisions and proposals distinct.** Extract memory candidates from chat, inspect their source and scope, and confirm what to save. When a new instruction overlaps an existing preference, the decision card can offer a one-time exception, a scoped addition, or a replacement. An external request to reschedule remains a proposal. The existing arrangement stays visible until the founder decides. [Memory management](../src/memory/memory-impact.mjs)
- **Recheck at confirmation.** A decision card can display the current arrangement, a proposed change, source records, and calendar options. Confirmation checks the relevant calendar or memory again. A changed situation pauses the write and can refresh the choices. The confirmation handler serializes requests for the same card and can recover a missing receipt from a committed task audit or memory record. A local calendar change records the founder's action and leaves customer acceptance as a separate fact. [Decision cards and rechecks](../src/decision/decision.mjs) · [Confirmation and receipt recovery](../src/decision/confirm.mjs)
- **Say what remains unknown.** In chat, Daymark can name an evidence gap, search saved records, or propose a clarifying question. The lead's **Current answer** distinguishes insufficient evidence, conflicting sources, failed verification, and a supported conclusion with limits. For example, “The customer expressed intent to sign. Whether the contract was signed remains unconfirmed.” The card lists founder-only claims and claims from unconfirmed sources as pending, even when other claims are supported. It can open sources, focus the source entry form, or fill a clarification draft. Adding a source or correcting its identity refreshes the lead answer and reruns any existing draft check. [Lead answer](../src/evidence/answer.mjs)

## 3. How can the founder catch unsupported agreement before relying on an answer?

1. **Check the claim against its source.** Lead analysis verifies purchase intent and signing status. Saved outreach drafts can be checked for customer intent, signing status, company performance, and external commitments. The configured model identifies the relationship between a claim and a source. Daymark checks that quoted text appears in the specified source, and that an extracted draft claim occurs in the draft. The verifier rejects excerpts that omit nearby negation, conditions, or qualifiers it can detect, and asks for a fuller excerpt when a short quote matches different clauses. A source marked as merely relevant carries no supporting or opposing weight. [Claim verification](../src/opportunity/claims.mjs) · [FEVER](https://aclanthology.org/N18-1074/)
2. **Flag unsupported claims in chat.** The workflow model checks extracted assertions against the records retrieved for that reply. If a reply says “the contract was signed” and the customer record only expresses intent to sign, the check can mark the assertion as pending for insufficient evidence. A status above the reply identifies refuted claims, conflicting sources, outstanding claims, a failed check, or an empty extraction. When every extracted claim has support, the status reports the number checked. Select a flagged claim to inspect its evidence. The reply remains available if the check fails. [Chat claim checks](../src/chat/chat-claims.mjs)
3. **Show provenance and competing evidence.** The founder labels the initial record as customer or external, founder-provided, or unconfirmed. Legacy initial records default to unconfirmed. Founder-only or unconfirmed support is flagged and cannot satisfy the automatic send check. The label records the stated origin. Conflicting sources remain visible unless the dated record explicitly revises or withdraws the relevant earlier opposing records. An expression of intent can support intent while signing remains unconfirmed.
4. **Show the actual verification scope before approval.** The saved draft lists checked claims, problematic sentences, sources, missing information, and suggested rewrites. The coverage panel highlights the missed fragment in context and can select it in the editor. A rule-based scan flags bracketed placeholders and high-risk clauses that the model did not extract. A rewrite saves a new draft version and rechecks it. An empty set of extracted claims requires further handling. For each flagged claim, the founder can add evidence, rewrite or remove the statement and recheck, or explicitly stand behind it with a recorded reason. Approval records which flagged claims the founder stood behind. The review log records source openings. Opening a source does not establish that it was read or understood.
5. **Enforce the decision at the action endpoint.** The simulated send checks delegation mode, the saved draft version, and the applicable claim check or manual review. The application records the block reason or the approved version and simulated result. Simulated publishing separately checks explicit acceptance, the action, scope and draft revision, and current-version verification. [Send gate](../src/opportunity/opportunities.mjs) · [Release gate](../src/alignment/alignment.mjs)


Malformed JSON or an invalid top-level response fails the check. Invalid claim or evidence fields can leave a claim incomplete. Duplicate claim IDs require a fresh check before automatic approval. The verifier derives a claim’s status from checked evidence and quote context. A model-supplied `supported` label alone carries no authority. [Claim parser and verifier](../src/opportunity/claims.mjs)

### Recipient disclosure

A source can protect a verbatim excerpt for internal use or for one specified email recipient. Before simulated sending, the server checks the saved draft against protected excerpts across leads. A matching excerpt outside the recipient's authorization blocks sending even after a factual review. The block records the source and recipient. Approved sends preserve applicable disclosure decisions in the archive. Before calling a hosted model, Daymark also checks assembled messages for protected excerpts, including references repeated in the saved draft or history. If a match is found, the request is paused and the user can review the evidence manually or use a local model. The local GPT bridge counts as hosted because it forwards requests. Custom loopback endpoints are treated as local and must keep inference on the machine. These checks cover exact excerpts. Paraphrases and unmarked material remain outside its coverage.

### Version checks

Automatic draft verification binds the draft ID, recipient, body hash, and evidence hash. Human review binds the draft ID and the evidence hash. Source-viewing records use the same version boundary. SHA-256 fingerprints capture changes to the draft body or the evidence set, including the recorded identity of the initial source. Re-identifying the initial source refreshes the lead answer and any existing draft check. Previous human reviews and source-viewing records remain in the audit history under their original evidence version.

```
current human review = recorded conclusion
                       AND review.draft_id = current draft ID
                       AND review.evidence_hash = current evidence hash
```

Automatic approval eligibility requires a current, completed check, at least one extracted claim, and **every extracted claim supported**. In a current check with flagged claims, each flagged statement needs a claim-specific guarantee unless the founder edits the draft and gets a new result. Each guarantee binds the claim ID and exact statement to the current draft ID and evidence hash. An overall review can cover a missing, failed, stale, or empty check when it is itself bound to the current draft and evidence. Unresolved placeholders block every send path. When a current, completed verification identifies a high-risk clause outside its extracted claims, the founder must revise and recheck or explicitly address that clause in a version-bound review. Duplicate claim IDs in a current draft check require a recheck. Each path requires explicit approval. Repeating approval for the same draft records the attempt and leaves the original simulated send intact.

**Flags survive draft edits.** An overall review cannot resolve a carried-over flag. A new check can clear it by explicitly supporting the same statement or covering the candidate rewrite with supported claims. When a check does not cover the relevant text, the founder records a claim-specific guarantee where available or confirms removal or a change of fact with a reason. A matcher result of “absent” or “different fact” alone leaves the flag pending. The server ties the resolution to the current draft and source set. [Send gate](../src/opportunity/opportunities.mjs)

### Conditions tested by mutation

Each row is one temporary change to the application. The corresponding acceptance check failed for all 13 changes. [Mutation runner](../scripts/approval-gate-mutations.mjs) · [Approval acceptance](../scripts/approval-gate-acceptance.mjs)

| ID | Temporary change | Acceptance check |
| --- | --- | --- |
| M1 | Make a duplicate approval return silently and omit its audit event | Duplicate approval is rejected and recorded |
| M2 | Skip the initial saved-draft ID check | Replay of an old approval after an edit is blocked with the draft-change reason |
| M3 | Allow sending in the manual delegation mode | Manual mode blocks assistant sending |
| M4 | Remove the link between an overall review and its source set | A review bound to stale sources cannot authorize a send |
| M5 | Skip the current draft-check freshness guard | A stale draft check cannot authorize a send |
| M6 | Remove the request Origin check | A request with a foreign Origin is rejected |
| M7 | Remove the request Host check | A request with an unexpected Host is rejected |
| M8 | Skip the check for unresolved flags from earlier drafts | An older flag still blocks the edited draft |
| M9 | Allow a protected excerpt for any recipient | The unauthorized recipient is rejected |
| M10 | Skip screening for protected inputs before a hosted call | Protected text is blocked before the mock endpoint receives it |
| M11 | Skip the unresolved placeholder check | A draft with a placeholder is blocked |
| M12 | Ignore the draft binding of a claim guarantee | A guarantee expires when the draft changes |
| M13 | Report every archive digest as verified | A change to stored archive bytes is detected |

Source classification is exercised by unit and workflow tests and has no dedicated mutation. [English workflow and security acceptance](../scripts/security-regression-acceptance.mjs)

The reported model measurements apply to the tested Qwen configurations. The application can use other configured verification models. The verification panel and archive show the model, thinking tier, and prompt versions recorded at check time. Older checks may lack metadata. The app currently has no warning for models outside the measured configurations. Current-model abstention, fabrication under goal pressure, and cross-customer leakage through global retrieval still need broader measurement. The deterministic suite covers workspace isolation and explicit import. Human review effectiveness remains an open question.

## Product features

| Area | Available functions |
| --- | --- |
| **Workspaces and chat** | Create, rename, group, search, resume, merge within a workspace, and delete conversations. Autosave chat history, show message times, suggest new chats or workspace switches, and choose a model and thinking level per conversation. Inspect the reply’s top verification status, individual claim checks, and the evidence panel. |
| **Records and memory** | Capture source text, facts, preferences, rules, and proposals. Extract and confirm memory candidates, review overlapping records, inspect changes, and share selected records with provenance in another workspace or globally. |
| **Leads and improvement ideas** | Open public search links, record prospects or ideas manually, add dated sources, assess opportunities, check lead claims, prepare outreach, and create follow-up tasks. Recent leads and upcoming tasks open their matching cards. |
| **Decisions and planning** | Review scheduling and preference conflicts, choose an option, preview calendar changes, confirm or clarify, and inspect receipts. Create, edit, complete, reopen, and delete tasks with source links, dates, locations, and notes. View the calendar and export events as ICS. |
| **Delegation and simulations** | Configure analysis, drafting, and approval policies. Verify outreach drafts, record source viewing, manual review and claim-specific guarantees, simulate approved sends and export their archives, and simulate version-checked releases. |
| **Developer tools** | Run unit checks, synthetic workspace and opportunity comparisons, and product acceptance scripts. Keep generated traces and screenshots local. |

## Memory ranking

When the founder proposes a memory change, Daymark ranks existing records for review with personalized PageRank. The seed is the term-overlap score plus two points for a matching scope, normalized across up to 80 candidates. Edges use the number of shared body terms, plus one for a matching scope. Let `s` be the normalized seed and `P` the row-normalized edge matrix. A record with no outgoing edge redistributes its mass according to `s`.

```
r₀ = s
rₜ₊₁ = 0.15s + 0.85Pᵀrₜ
```

After 20 iterations the default view returns up to eight candidates. The score ranks records for review. The model can classify candidate conflicts and the founder decides what to save. [Ranking and scope code](../src/memory/memory-impact.mjs) · [Semantic Commit](https://arxiv.org/abs/2504.09283)
