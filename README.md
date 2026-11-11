# Daymark · DIC2026

In a one-person company, the founder makes the decision and is often the only person reviewing what the AI says or does. Daymark is a local AI workspace that brings the evidence, open questions, and approval controls into that review before the assistant speaks for the company.

## Safety and alignment for a one-person company

| Question | What Daymark does |
| --- | --- |
| **How can the founder audit a decision or action?** | The evidence panel shows the records behind a reply. Task activity records before-and-after values, and a decision receipt links the chosen action to its local result. Simulated outreach records approvals, blocks, and outcomes. |
| **What happens when instructions conflict or evidence is missing?** | Decision cards show the current arrangement and the proposed change, then recheck the relevant state at confirmation. When the evidence is insufficient, Daymark can report what is known, name what is missing, and suggest a clarifying question or search for more saved evidence. In the lead flow, every analyzed lead carries a current answer that states what is confirmed, the exact information that is missing, and an actionable next step. It keeps the four bounded cases separate — insufficient evidence, conflicting sources (the records to compare are shown, no conclusion is claimed), failed verification (marked retryable), and sufficient evidence (a bounded conclusion with its limits) — and re-derives when a source is added, so a reply with explicit signing intent updates the conclusion and points at the new source. |
| **How can the founder catch unsupported claims before relying on them?** | Lead analysis and outreach drafts can be checked against saved sources. The draft shows which claims were checked, any evidence gaps, and suggested rewrites. The send endpoint checks the current draft and requires current verification or human review before simulating an approved send. |

## Verification and model limits

- **Product checks.** All 140 automated checks passed on this integration (111 carried over, plus 7 for the founder-review source viewing and 22 for the lead current answer: the pure answer builder, its persistence and re-derivation in the lead flow, and the card rendering). The simulated-sending walkthroughs used a deterministic mock model to exercise blocking, rewriting, rechecking, and approval through the app. These checks establish the workflow behavior of the simulated send; they do not measure any real model's capability.
- **Real-model capability, described separately.** In a small synthetic evaluation of the earlier workflow, `qwen2.5:3b` over-abstained on 6 of 16 parseable turns where the evidence supported a conclusion. It gave unsupported agreement on 5 of 5 parseable pressure turns in the workspace benchmark. These counts describe the earlier real-model baseline only. Detection and false-positive rates for the current draft verifier still need to be measured on labeled drafts.
- **Founder-provided sources.** Daymark records their provenance. An explicit factual statement supplied by the founder can support wording attributed to that source. The underlying fact remains founder-attested and may need independent evidence.
- **Human review.** Daymark records the review conclusion, draft version, source set, and which source originals the founder opened in the review area. The viewing state is kept server-side and bound to the current draft and source version: it resets when the draft or the sources change (the earlier record stays in the audit history), and it is an audit trail only — it neither replaces the founder's written conclusion nor unlocks the simulated send.

## What you can do

- **Workspaces and chat.** Organize conversations by project, search and resume prior chats, and start a new conversation in the current workspace. When an input suggests a new task or a different workspace, Daymark can ask where to continue before sending it. Chats use their workspace's saved records and global memory. Merging or moving a conversation across workspaces is refused so an old chat's quotes, customer promises, and decision cards cannot become another workspace's context: continuing there means a new conversation that carries your current input, and comparing workspaces means importing specific records explicitly, each copy keeping its original workspace and source.
- **Evidence and long-term memory.** Review retrieved records, verbatim excerpts, model inferences, open questions, and the workspace used for a reply. Extract memory candidates from a conversation and confirm what to save. Review related records before changing a saved rule or preference.
- **Customer leads and improvement ideas.** Open a public search link, record sources manually, assess an opportunity, and prepare a follow-up task or an outreach draft. After an analysis, each lead keeps a current answer (what is confirmed, the exact gap, the next step) that re-derives as sources change. Open recent leads and upcoming tasks directly from the sidebar.
- **Decisions, tasks, and calendar.** Compare a proposed change with the current arrangement, preview a calendar slot, or choose between a one-time exception and a saved preference. Daymark rechecks the relevant calendar or memory when you confirm. Create, edit, complete, reopen, and delete tasks, link them to sources, and export calendar events as ICS.
- **Approvals and activity.** Review task changes and decision receipts. For simulated outreach, inspect the approved draft, any blocking reason, and the simulated result. Simulated publishing checks the current draft and version-specific verification.

## Verify claims before simulated outreach

1. Save a lead and add source records. Label customer records and founder-provided information, and add dates when known.
2. Analyze the lead. Daymark checks purchase intent and signing status against the supplied sources.
3. Save an outreach draft and select **Verify key claims**. The draft shows its current status, the actual verification scope (which claims were checked), and highlights claims that are unsupported, contradicted, conflicting, or incomplete. If no claim is extracted, the empty scope is shown explicitly instead of counting as passed. Open the cited source to review the evidence. Opening a source original in the review area is recorded; the review area and the audit show which sources have been opened and which not.
4. Adopt a suggested rewrite or edit the draft, then verify the new version. You can also record a human review conclusion for the current draft.
5. Approve the saved draft when ready. Daymark checks its current version and requires up-to-date verification or a current human review before simulating the send.

A human review is bound to the current draft version **and** the current set of sources: when the body, recipient, or any source changes, the review is shown as expired with the reason (the draft changed or the sources changed) and no longer unlocks the send; records created before the source binding have no source version and prompt re-review. An expired review can be replaced by a fresh verification of the current evidence or a new review of the current draft. Automated verification uses the configured model to interpret supplied records. Daymark checks that quotations appear verbatim in those records. When competing sources cannot be resolved by an explicit revision or withdrawal, both remain visible. Adding a source can trigger automated verification again. Sending and publishing run as local simulations. The model may miss a claim or misread a source, so the draft displays the scope of its checks. Claim-by-claim verification currently covers lead analysis and outreach drafts.

## Run locally

Requires Node.js 24 or later. Run `npm start` and open [Daymark](http://127.0.0.1:4173). The interface supports English and Chinese.

Chat and automated claim verification use the configured model. The following `qwen2.5:3b` configuration is a local setup example. The repository template also supports configuring a hosted OpenAI-compatible Chat Completions provider.

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
MODEL_ID=qwen2.5:3b
OPENAI_API_KEY=
```

Start the configured model before using chat and restart Daymark after configuration changes. Daymark stores workspace data in `data/`. With a hosted provider, relevant records and recent conversation may be included in model requests.

Run `npm test` for automated code checks.

`scripts/evidence-answer-acceptance.mjs` is the end-to-end test of the lead current answer: it starts a fresh server with a deterministic mock model and drives the four cases — the "only wants to see cases" lead (gap + next step), a reply with explicit signing intent (bounded conclusion pointing at the new source), a contradictory record (conflict, records shown for comparison), and a forced model failure (retryable, then recovered by re-verification).
