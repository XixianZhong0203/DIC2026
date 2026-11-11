# Daymark · DIC 2026

Daymark is a local AI workspace for a one-person company (OPC). The founder makes business decisions and is often the only person reviewing what the assistant says or does. Daymark brings source evidence, open questions, and approval controls into that review.

## 1. How can the founder audit the assistant's reasoning and actions?

- **Inspect the basis of a reply.** The evidence panel shows the workspace used, retrieved records, verbatim excerpts, model inferences, open questions, and whether a second search ran. This makes the stated basis of a reply inspectable. Model explanations remain summaries.
- **Follow a decision through to its outcome.** A decision card records the option selected and whether it was applied, paused, or failed. A calendar receipt shows the old and new time. The task activity log stores before-and-after values and links a change to its source and decision card when available.
- **Review simulated outreach.** The activity log records source changes, claim checks, drafts, human review conclusions, approvals, blocks, and simulated sends. Opening a source original in the review area is recorded against the current draft and source set. That record shows which source was opened. The written review records the founder's conclusion.
- **Review a simulated release.** The release view records current-version verification and simulated publication events, including blocks for an outdated draft or missing verification.

Implementation: [reply and action routes](server.mjs), [verbatim quote validation](src/memory/memory-impact.mjs), [task audit and receipts](src/tasks/task-audit.mjs), [outreach workflow](src/opportunity/opportunities.mjs), and [release policy](src/policy/policy.mjs).

### Retrieval score

For ordinary retrieval, the score is the number of distinct normalized terms shared by the query and a record's source name, text, and scope.

```
score(query, record) = |terms(query) ∩ terms(source + body + scope)|
```

Daymark selects up to 12 positively scored records. If the model identifies missing evidence and reports no conflict, it can search once more using up to two stated gaps. That search can add up to four unused fact or source records with a score of at least two. A verbatim citation check requires a source ID from the supplied records and an exact substring in that record. [Retrieval implementation](src/chat/local-chat.mjs)

## 2. What happens when instructions conflict or the assistant is uncertain?

- **Start with the right workspace.** A chat retrieves its project's active memories and global records. A workspace change can start a fresh conversation with the current input. The app distinguishes continuing, starting a new task, switching, and comparing workspaces. Cross-workspace merges and moves of populated chats are blocked. The founder can explicitly import selected records with their original workspace and source noted. [Intent classification](src/chat/chat-intent.mjs) · [Workspace routes](server.mjs)
- **Keep decisions and proposals distinct.** Extract memory candidates from chat, inspect their source and scope, and confirm what to save. When a new instruction overlaps an existing preference, the decision card can offer a one-time exception, a scoped addition, or a replacement. An external request to reschedule remains a proposal. The existing arrangement stays visible until the founder decides. [Memory management](src/memory/memory-impact.mjs)
- **Recheck at confirmation.** A decision card can display the current arrangement, a proposed change, source records, and calendar options. Confirmation checks the relevant calendar or memory again. A changed situation pauses the write and can refresh the choices. The confirmation handler serializes requests for the same card and can recover a missing receipt from a committed task audit or memory record. A local calendar change records the founder's action and leaves customer acceptance as a separate fact. [Decision cards and rechecks](src/decision/decision.mjs) · [Confirmation and receipt recovery](src/decision/confirm.mjs)
- **Say what remains unknown.** In chat, Daymark can name an evidence gap, search saved records, or propose a clarifying question. The lead's **Current answer** distinguishes insufficient evidence, conflicting sources, failed verification, and a supported conclusion with limits. For example, “The customer expressed intent to sign. Whether the contract was signed remains unconfirmed.” The card can open sources, focus the source entry form, or fill a clarification draft. [Lead answer](src/evidence/answer.mjs)

### Memory conflict ranking

When the founder proposes a memory change, Daymark ranks existing records for review with personalized PageRank. The seed is the term-overlap score plus two points for a matching scope, normalized across up to 80 candidates. Edges use the number of shared body terms, plus one for a matching scope. Let `s` be the normalized seed and `P` the row-normalized edge matrix. A record with no outgoing edge redistributes its mass according to `s`.

```
r₀ = s
rₜ₊₁ = 0.15s + 0.85Pᵀrₜ
```

After 20 iterations the default view returns up to eight candidates. The score ranks records for review. The model can classify candidate conflicts and the founder decides what to save. [Ranking and scope code](src/memory/memory-impact.mjs) · [Semantic Commit](https://arxiv.org/abs/2504.09283)

## 3. How can the founder catch unsupported agreement before relying on an answer?

1. **Check the claim against its source.** Lead analysis verifies purchase intent and signing status. Saved outreach drafts can be checked for customer intent, signing status, company performance, and external commitments. The configured model identifies the relationship between a claim and a source. Daymark checks that quoted text appears in the specified source, and that an extracted draft claim occurs in the draft. A source marked as merely relevant carries no supporting or opposing weight. [Claim verification](src/opportunity/claims.mjs) · [FEVER](https://aclanthology.org/N18-1074/)
2. **Show provenance and competing evidence.** The founder labels the initial record as customer or external, founder-provided, or unconfirmed. Legacy initial records default to unconfirmed. Founder-only or unconfirmed support is flagged and cannot satisfy the automatic send check. The label records the stated origin. Conflicting sources remain visible unless the dated record explicitly revises or withdraws the relevant earlier opposing records. An expression of intent can support intent while signing remains unconfirmed.
3. **Show the actual verification scope before approval.** The saved draft lists checked claims, problematic sentences, sources, missing information, and suggested rewrites. A rewrite saves a new draft version and rechecks it. An empty set of extracted claims requires further handling. The founder can add evidence, revise and recheck, or record a human review for the current version.
4. **Enforce the decision at the action endpoint.** The simulated send checks delegation mode, the current draft, lead assessment or review, and the current draft's verification or human review. The application records the block reason or the approved version and simulated result. Simulated publishing separately checks explicit acceptance, the action, scope and draft revision, and current-version verification. [Send gate](src/opportunity/opportunities.mjs) · [Release gate](src/alignment/alignment.mjs)

### Version checks

Automatic draft verification binds the draft ID, recipient, body hash, and evidence hash. Human review binds the draft ID and the evidence hash. Source-viewing records use the same version boundary. SHA-256 fingerprints capture changes to the draft body or the evidence set, including the recorded identity of the initial source.

```
current human review = recorded conclusion
                       AND review.draft_id = current draft ID
                       AND review.evidence_hash = current evidence hash
```

The send endpoint can also accept a current automatic verification with a nonempty set of supported claims. In either case, the founder explicitly approves the saved draft. Daymark simulates the effect locally.

### What the checks cover

- **Product verification.** The integrated release passed **167/167 unit tests** and **67/67 checks** in the synthetic customer-delivery flow. The latter uses a deterministic mock model to exercise project isolation, decision receipts, unsupported claims, review and simulated send. [End-to-end walkthrough](scripts/customer-delivery-acceptance.mjs)
- **Historical model baseline.** In a small synthetic run of an earlier workflow, `qwen2.5:3b` over-abstained in **6/16** parseable turns where evidence supported a conclusion and gave unsupported agreement in **5/5** parseable pressure turns in the workspace benchmark. Detection and false-positive rates for the current draft verifier remain unmeasured. [Benchmark implementation](src/alignment/alignment.mjs) · [Evaluation runner](evaluation/round1.mjs)
- **Current limits.** Source labels reflect user-recorded provenance. Model interpretation and claim extraction can miss or misread material. Claim-by-claim checks currently cover lead analysis and outreach drafts. The lead answer can omit founder-only or unconfirmed statements from its summary, and reclassifying a source can leave the lead answer stale when the most recent verification targeted the draft. The draft send checks use their own verification state.

## Product features

| Area | Available functions |
| --- | --- |
| **Workspaces and chat** | Create, rename, group, search, resume, merge within a workspace, and delete conversations. Autosave chat history, show message times, and suggest new chats or workspace switches. |
| **Records and memory** | Capture source text, facts, preferences, rules, and proposals. Extract and confirm memory candidates, review overlapping records, inspect changes, and import selected records with provenance. |
| **Leads and improvement ideas** | Open public search links, record prospects or ideas manually, add dated sources, assess opportunities, check lead claims, prepare outreach, and create follow-up tasks. Recent leads and upcoming tasks open their matching cards. |
| **Decisions and planning** | Review scheduling and preference conflicts, choose an option, preview calendar changes, confirm or clarify, and inspect receipts. Create, edit, complete, reopen, and delete tasks with source links, dates, locations, and notes. View the calendar and export events as ICS. |
| **Delegation and simulations** | Configure analysis, drafting, and approval policies. Verify outreach drafts, record source viewing and human review, simulate approved sends, and simulate version-checked releases. |
| **Developer tools** | Run unit checks, synthetic workspace and opportunity comparisons, and product acceptance scripts. Keep generated traces and screenshots local. |

## Run locally

Use Node.js 24 or later. Start the server with `npm start` and open [Daymark](http://127.0.0.1:4173). The interface supports English and Chinese. Run `npm test` for unit checks.

Chat, memory extraction, and automated claim interpretation use the configured model. Retrieval, scope, quote matching, version checks, confirmation, and audit writes run in application code. Example local Ollama configuration in `.env`:

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
MODEL_ID=qwen2.5:3b
OPENAI_API_KEY=
```

Start the configured model before using chat. Restart Daymark after changing configuration. The workspace database lives in `data/`. When using a hosted OpenAI-compatible provider, relevant records and recent conversation can be included in model requests.
