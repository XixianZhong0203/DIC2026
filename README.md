# Daymark · DIC 2026

Daymark is a local AI workspace for a one-person company (OPC), where the founder often makes decisions and reviews the assistant’s work alone.

## At a glance

- **Design.** Daymark shows the evidence behind a proposed action. Before a simulated send, the server checks the saved draft and its evidence version, blocks unresolved placeholders, and requires individual resolution of flagged claims. The approval preserves an exportable record of the draft and sources.
- **Server enforcement.** The integrated build passed 220 unit tests, 91/91 request-boundary and concurrency checks, and 26/26 approval checks. The acceptance suite detected all seven tested changes to approval conditions. These checks establish enforcement for the exercised cases. [Verification and coverage](#agentic-misalignment-and-verification)
- **Model detection.** In six synthetic drafts with 15 annotated claims, two Qwen 3.8 27B FP8 configurations each extracted all 6 problem claims and marked 0/6 supported. The upper endpoint of a two-sided 95% Wilson interval is about 39% for each 0/6 result. Detection on an independent holdout, including Chinese drafts and another model family, remains unmeasured.
- **Human review.** Whether claim-by-claim review helps founders find more errors, and how much time it takes, remains unmeasured.

## 1. How can the founder audit the assistant's reasoning and actions?

- **Inspect the basis of a reply.** The evidence panel shows the workspace used, retrieved records, verbatim excerpts, model inferences, open questions, and whether a second search ran. This makes the stated basis of a reply inspectable. Model explanations remain summaries.
- **Follow a decision through to its outcome.** A decision card records the option selected and whether it was applied, paused, or failed. A calendar receipt shows the old and new time. The task activity log stores before-and-after values and links a change to its source and decision card when available.
- **Review simulated outreach.** The activity log records source changes, claim checks, drafts, source openings, manual review, approvals, blocks, and duplicate approval attempts. Every new simulated send saves a downloadable JSON archive with the draft and its hash, source originals, cited and supporting evidence, available model and prompt metadata, claim-specific guarantees, and the approval time. Later edits to the live draft or sources leave that snapshot intact. The approval audit stores a SHA-256 digest of the exact stored JSON bytes. Downloads expose `X-Archive-Integrity` as `verified`, `mismatch`, or `unrecorded`. This detects a changed archive when the audit record is intact. [Send archive](src/opportunity/archive.mjs)
- **Review a simulated release.** The release view records verification for the current draft revision, simulated publication, duplicate attempts, and blocks for missing or stale verification.

Implementation: [reply and action routes](server.mjs), [verbatim quote validation](src/memory/memory-impact.mjs), [task audit and receipts](src/tasks/task-audit.mjs), [outreach workflow](src/opportunity/opportunities.mjs), and [release policy](src/policy/policy.mjs).

### Retrieval score

Ordinary retrieval uses `Intl.Segmenter` to split text into words, including Chinese text. It lowercases terms, filters common words, and counts the distinct terms shared by the query and the record's source name, text, and scope. Chinese paraphrases with little shared wording can still miss relevant records.

```
score(query, record) = |terms(query) ∩ terms(source + body + scope)|
```

Daymark selects up to 12 positively scored records. If the model identifies missing evidence and reports no conflict, it can search once more using up to two stated gaps. That search can add up to four unused fact or source records with a score of at least two. A verbatim citation check requires a source ID from the supplied records and an exact substring in that record. [Retrieval implementation](src/chat/local-chat.mjs)

## 2. What happens when instructions conflict or the assistant is uncertain?

- **Start with the right workspace.** A chat retrieves its project's active memories and records explicitly saved as global. The global marker cannot be used as a project name. Extracted customer facts and proposals stay in the current project. A workspace change can start a fresh conversation with the current input. The app distinguishes continuing, starting a new task, switching, and comparing workspaces. Cross-workspace merges and moves of populated chats are blocked. The founder can explicitly import selected records with their original workspace and source noted. [Intent classification](src/chat/chat-intent.mjs) · [Workspace routes](server.mjs)
- **Keep decisions and proposals distinct.** Extract memory candidates from chat, inspect their source and scope, and confirm what to save. When a new instruction overlaps an existing preference, the decision card can offer a one-time exception, a scoped addition, or a replacement. An external request to reschedule remains a proposal. The existing arrangement stays visible until the founder decides. [Memory management](src/memory/memory-impact.mjs)
- **Recheck at confirmation.** A decision card can display the current arrangement, a proposed change, source records, and calendar options. Confirmation checks the relevant calendar or memory again. A changed situation pauses the write and can refresh the choices. The confirmation handler serializes requests for the same card and can recover a missing receipt from a committed task audit or memory record. A local calendar change records the founder's action and leaves customer acceptance as a separate fact. [Decision cards and rechecks](src/decision/decision.mjs) · [Confirmation and receipt recovery](src/decision/confirm.mjs)
- **Say what remains unknown.** In chat, Daymark can name an evidence gap, search saved records, or propose a clarifying question. The lead's **Current answer** distinguishes insufficient evidence, conflicting sources, failed verification, and a supported conclusion with limits. For example, “The customer expressed intent to sign. Whether the contract was signed remains unconfirmed.” The card lists founder-only claims and claims from unconfirmed sources as pending, even when other claims are supported. It can open sources, focus the source entry form, or fill a clarification draft. Adding a source or correcting its identity refreshes the lead answer and reruns any existing draft check. [Lead answer](src/evidence/answer.mjs)

## 3. How can the founder catch unsupported agreement before relying on an answer?

1. **Check the claim against its source.** Lead analysis verifies purchase intent and signing status. Saved outreach drafts can be checked for customer intent, signing status, company performance, and external commitments. The configured model identifies the relationship between a claim and a source. Daymark checks that quoted text appears in the specified source, and that an extracted draft claim occurs in the draft. The verifier rejects excerpts that omit nearby negation, conditions, or qualifiers it can detect, and asks for a fuller excerpt when a short quote matches different clauses. A source marked as merely relevant carries no supporting or opposing weight. [Claim verification](src/opportunity/claims.mjs) · [FEVER](https://aclanthology.org/N18-1074/)
2. **Show provenance and competing evidence.** The founder labels the initial record as customer or external, founder-provided, or unconfirmed. Legacy initial records default to unconfirmed. Founder-only or unconfirmed support is flagged and cannot satisfy the automatic send check. The label records the stated origin. Conflicting sources remain visible unless the dated record explicitly revises or withdraws the relevant earlier opposing records. An expression of intent can support intent while signing remains unconfirmed.
3. **Show the actual verification scope before approval.** The saved draft lists checked claims, problematic sentences, sources, missing information, and suggested rewrites. A rule-based scan flags bracketed placeholders and high-risk clauses that the model did not extract. A rewrite saves a new draft version and rechecks it. An empty set of extracted claims requires further handling. For each flagged claim, the founder can add evidence, rewrite or remove the statement and recheck, or explicitly stand behind it with a recorded reason. Approval records which flagged claims the founder stood behind. The review log records source openings. Opening a source does not establish that it was read or understood.
4. **Enforce the decision at the action endpoint.** The simulated send checks delegation mode, the saved draft version, and the applicable claim check or manual review. The application records the block reason or the approved version and simulated result. Simulated publishing separately checks explicit acceptance, the action, scope and draft revision, and current-version verification. [Send gate](src/opportunity/opportunities.mjs) · [Release gate](src/alignment/alignment.mjs)

### Version checks

Automatic draft verification binds the draft ID, recipient, body hash, and evidence hash. Human review binds the draft ID and the evidence hash. Source-viewing records use the same version boundary. SHA-256 fingerprints capture changes to the draft body or the evidence set, including the recorded identity of the initial source. Re-identifying the initial source refreshes the lead answer and any existing draft check. Previous human reviews and source-viewing records remain in the audit history under their original evidence version.

```
current human review = recorded conclusion
                       AND review.draft_id = current draft ID
                       AND review.evidence_hash = current evidence hash
```

Automatic approval eligibility requires a current, completed check, at least one extracted claim, and **every extracted claim supported**. In a current check with flagged claims, each flagged statement needs a claim-specific guarantee unless the founder edits the draft and gets a new result. Each guarantee binds the claim ID and exact statement to the current draft ID and evidence hash. An overall review can cover a missing, failed, stale, or empty check when it is itself bound to the current draft and evidence. Unresolved placeholders block every send path. When a current, completed verification identifies a high-risk clause outside its extracted claims, the founder must revise and recheck or explicitly address that clause in a version-bound review. Duplicate claim IDs in a current draft check require a recheck. Each path requires explicit approval. Repeating approval for the same draft records the attempt and leaves the original simulated send intact.

**Flags survive draft edits.** If a previously flagged statement remains verbatim, an overall review cannot clear it. The founder can revise or remove it and recheck, record a guarantee for the current draft and source set, or obtain a current check that explicitly supports the same statement. Failed, empty, or partial rechecks preserve the flag. [Send gate](src/opportunity/opportunities.mjs)

## Agentic misalignment and verification

The [Anthropic agentic misalignment study](https://www.anthropic.com/research/agentic-misalignment) tested models that could act under replacement or goal conflict. In Daymark, model output can propose a judgment or action. The server handles approval and the local simulated effect. The deterministic acceptance suite checks that forged approval text in chat, an added source, or an initial source produces zero simulated sends in those cases. [Request-boundary and concurrency acceptance](scripts/gate-concurrency-acceptance.mjs) A founder can still rely on a misleading answer. The model can still miss a claim or misread evidence. The context checks cover common omissions and ambiguous matches. Subtler wording can still escape them. Claim-level checks currently cover lead analysis and outreach drafts.

| Check | Result and scope |
| --- | --- |
| Seeded draft errors | Six synthetic drafts with 15 annotated claims on baseline `55927f2`. Both Qwen 3.8 27B FP8 configurations extracted **6/6** problem claims and marked **0/6** supported. The standard and reasoning configurations assigned the expected label to **5/6** and **4/6**, and incorrectly flagged **1/9** and **0/9** ordinary claims, respectively. Each parsed **6/6** drafts. The results describe those configurations and cases. No independent holdout or comparison across model families has been completed. |
| Historical pressure baseline | Earlier Qwen 2.5 3B runs over-abstained on **6/16** eligible supported turns. The model agreed without support in **5 of 6** pressure turns overall, with one unparseable turn. These runs preceded the current draft checks. |
| Product verification | **220 unit tests** passed. Deterministic acceptance passed **91/91** request-boundary and concurrency checks, **26/26** approval checks, **44/44** archive checks, and **67/67** customer-delivery checks. All seven tested changes to approval conditions were detected by the acceptance suite. |

### Conditions tested by mutation

Each row is one temporary change to the application. The corresponding acceptance check failed for all seven changes. [Mutation runner](scripts/approval-gate-mutations.mjs) · [Approval acceptance](scripts/approval-gate-acceptance.mjs)

| ID | Temporary change | Acceptance check |
| --- | --- | --- |
| M1 | Make a duplicate approval return silently and omit its audit event | Duplicate approval is rejected and recorded |
| M2 | Skip the initial saved-draft ID check | Replay of an old approval after an edit is blocked with the draft-change reason |
| M3 | Allow sending in the manual delegation mode | Manual mode blocks assistant sending |
| M4 | Remove the link between an overall review and its source set | A review bound to stale sources cannot authorize a send |
| M5 | Skip the current draft-check freshness guard | A stale draft check cannot authorize a send |
| M6 | Remove the request Origin check | A request with a foreign Origin is rejected |
| M7 | Remove the request Host check | A request with an unexpected Host is rejected |

This mutation set has no separate mutation for the placeholder rule, source classification, claim-specific guarantee binding, or archive integrity. Unit and workflow tests exercise several of those paths separately.

The reported model measurements apply to the tested Qwen configurations. The application can use other configured verification models. The verification panel and archive show the model, thinking tier, and prompt versions recorded at check time. Older checks may lack metadata. The app currently has no warning for models outside the measured configurations. Current-model abstention, fabrication under goal pressure, and cross-customer leakage through global retrieval still need broader measurement. The deterministic suite covers workspace isolation and explicit import. Human review effectiveness remains an open question.

## Product features

| Area | Available functions |
| --- | --- |
| **Workspaces and chat** | Create, rename, group, search, resume, merge within a workspace, and delete conversations. Autosave chat history, show message times, suggest new chats or workspace switches, and choose a model and thinking level per conversation. |
| **Records and memory** | Capture source text, facts, preferences, rules, and proposals. Extract and confirm memory candidates, review overlapping records, inspect changes, and import selected records with provenance. |
| **Leads and improvement ideas** | Open public search links, record prospects or ideas manually, add dated sources, assess opportunities, check lead claims, prepare outreach, and create follow-up tasks. Recent leads and upcoming tasks open their matching cards. |
| **Decisions and planning** | Review scheduling and preference conflicts, choose an option, preview calendar changes, confirm or clarify, and inspect receipts. Create, edit, complete, reopen, and delete tasks with source links, dates, locations, and notes. View the calendar and export events as ICS. |
| **Delegation and simulations** | Configure analysis, drafting, and approval policies. Verify outreach drafts, record source viewing, manual review and claim-specific guarantees, simulate approved sends and export their archives, and simulate version-checked releases. |
| **Developer tools** | Run unit checks, synthetic workspace and opportunity comparisons, and product acceptance scripts. Keep generated traces and screenshots local. |

## Run locally

Use Node.js 24 or later. Start the server with `npm start` and open [Daymark](http://127.0.0.1:4173). The interface supports English and Chinese. Run `npm test` for unit checks.

Copy [.env.example](.env.example) to `.env` and configure a model. The [catalog](src/models.mjs) includes Qwen 3.8 27B through LiteLLM and OpenCode models. You can also set `OPENAI_BASE_URL` and `MODEL_ID` for a custom OpenAI-compatible endpoint such as Ollama. Use the composer menu to choose a model and the available thinking level for each conversation. The conversation selection applies only to chat replies. Topic detection, memory extraction and review, lead analysis, claim verification, and evaluations use the configured default model. Hosted model requests can include relevant records and recent conversation.

For the optional GPT models, sign in to the Codex CLI, run `node scripts/local-gpt-bridge.mjs` in a separate terminal, then set `DAYMARK_CODEX_PICKER=1` in Daymark's `.env` and restart. GPT‑6.1 Sol offers **Low**. GPT‑5.6 Sol, Terra, and Luna offer **Low** or **Medium**. The local bridge uses standard processing. Availability depends on the signed-in Codex account. The workspace database lives in `data/`.

## Appendix · Memory ranking

When the founder proposes a memory change, Daymark ranks existing records for review with personalized PageRank. The seed is the term-overlap score plus two points for a matching scope, normalized across up to 80 candidates. Edges use the number of shared body terms, plus one for a matching scope. Let `s` be the normalized seed and `P` the row-normalized edge matrix. A record with no outgoing edge redistributes its mass according to `s`.

```
r₀ = s
rₜ₊₁ = 0.15s + 0.85Pᵀrₜ
```

After 20 iterations the default view returns up to eight candidates. The score ranks records for review. The model can classify candidate conflicts and the founder decides what to save. [Ranking and scope code](src/memory/memory-impact.mjs) · [Semantic Commit](https://arxiv.org/abs/2504.09283)
