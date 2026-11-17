# Daymark · DIC 2026

Daymark is a local AI workspace for a one-person company. The founder often makes decisions and reviews the assistant’s work alone. Daymark makes the evidence visible, asks for clarification when an important fact is missing, and binds approval to the exact draft and evidence under review.

## At a glance

- **Server enforcement.** The integrated build passed 291 unit tests, 95/95 request-boundary, concurrency, and model-input checks, and 26/26 approval checks. The acceptance suites detected all 13 tested mutations to server safeguards. [Verification and coverage](#agentic-misalignment-and-verification)
- **Model detection.** On six synthetic drafts with 15 annotated claims, each of two Qwen 3.8 27B FP8 configurations extracted all six problem claims and marked 0/6 supported. The upper endpoint of a two-sided 95% Wilson interval is about 39%. Detection on an independent holdout and across model families remains unmeasured.
- **Human review.** Whether reviewing claims individually helps founders find more errors, and how much time it takes, remains unmeasured.

## 1. How can the founder audit the assistant’s reasoning and actions?

The evidence panel separates records provided to the model, sources cited by the reply, and excerpts the verifier judged to support or oppose a claim. The decision and task logs show what changed, including calendar changes and their receipts. Each simulated send exports a snapshot of the approved draft, sources, claim verdicts, guarantees, and approval. A SHA-256 digest in the approval audit lets Daymark detect changes to the archive while that audit remains intact. [Audit and archive details](docs/PRODUCT.md#1-how-can-the-founder-audit-the-assistants-reasoning-and-actions)

## 2. What happens when instructions conflict or the assistant is uncertain?

Daymark can show what the evidence establishes, what is still missing, and which question or record would resolve it. For example, a customer’s willingness to sign leaves the contract’s signing status unconfirmed. Decision cards distinguish a one-time exception, a policy change, and an external proposal. Before applying a calendar or memory change, Daymark rechecks the current state. Project records can be shared explicitly, with their origin and applicability preserved. [Workspace, memory, and confirmation details](docs/PRODUCT.md#2-what-happens-when-instructions-conflict-or-the-assistant-is-uncertain)

## 3. How can the founder catch unsupported agreement before relying on an answer?

Chat flags unsupported or disputed assertions above the reply and links each flag to the relevant sources. When the extracted claims all have support, the status gives the count and limits its conclusion to those extracted claims. Outreach checks show which claims were extracted and use a separate scan to catch placeholders and common high-risk clauses the model may have missed. The server blocks simulated sending unless the current draft satisfies the applicable review and explicit approval requirements. An unresolved claim survives edits and incomplete rechecks. Recipient restrictions can also block protected verbatim excerpts. [Claim verification and approval details](docs/PRODUCT.md#3-how-can-the-founder-catch-unsupported-agreement-before-relying-on-an-answer)

## Agentic misalignment and verification

The [Anthropic agentic misalignment study](https://www.anthropic.com/research/agentic-misalignment) tested models that could act under replacement or goal conflict. In Daymark, model output can propose a judgment or action. The server handles approval and the local simulated effect. The deterministic acceptance suite checks that forged approval text in chat, an added source, or an initial source produces zero simulated sends in those cases. [Request-boundary and concurrency acceptance](scripts/gate-concurrency-acceptance.mjs)

| Check | Result and scope |
| --- | --- |
| Seeded draft errors | Six synthetic drafts with 15 annotated claims on baseline `55927f2`. Both Qwen 3.8 27B FP8 configurations extracted **6/6** problem claims and marked **0/6** supported. The standard and reasoning configurations assigned the expected label to **5/6** and **4/6**, and incorrectly flagged **1/9** and **0/9** ordinary claims, respectively. Each parsed **6/6** drafts. The results describe those configurations and cases. No independent holdout or comparison across model families has been completed. |
| Historical pressure baseline | Earlier Qwen 2.5 3B runs over-abstained on **6/16** eligible supported turns. The model agreed without support in **5 of 6** pressure turns overall, with one unparseable turn. These runs preceded the current draft checks. |
| Product verification | **291 unit tests** passed. Deterministic acceptance passed **95/95** request-boundary, concurrency, and model-input checks, **26/26** approval checks, **44/44** archive checks, **67/67** customer-delivery checks, **29/29** workspace-isolation checks, and **31/31** lead-answer checks. The chat claim-check suite passed **24/24** and the shared-memory workflow passed **27/27**, both with deterministic model substitutes. [Shared-memory acceptance](scripts/shared-memory-acceptance.mjs) The English delivery and security suite passed **22/22**, and the mutation suites detected **13/13** deliberate changes to server safeguards. [English workflow and security acceptance](scripts/security-regression-acceptance.mjs) |

[Mutation cases and coverage limits](docs/PRODUCT.md#conditions-tested-by-mutation)

## Current limits

- **Chat coverage.** The checker sees this turn’s retrieved records. A missed counterexample or an assertion the model failed to extract can escape the check. The top status summarizes extracted claims.
- **Draft edits.** The bilingual matcher recognizes common signing, payment, delivery, completion, and commitment phrases. It can miss paraphrases or misunderstand a change of subject. The founder may still need to compare versions and decide whether the original assertion remains. [Rewrite matcher](src/opportunity/claim-match.mjs)
- **Shared records and disclosure.** The founder can consult and share records across projects. The recipient and hosted-model checks match explicitly protected excerpts. Reworded disclosures and sensitive information without a protection rule remain outside this check. The applicability label guides how the model uses shared material. Tests cover recorded provenance, retrieval boundaries, and the draft checks in the exercised cases. Semantic leakage through shared memory remains unmeasured.

## Run locally

Use Node.js 24 or later. Copy [.env.example](.env.example) to `.env`, configure a model, run `npm start`, and open [Daymark](http://127.0.0.1:4173). Daymark supports self-hosted and hosted OpenAI-compatible endpoints. We recommend on-device inference for workflows that handle sensitive customer records. [Deployment, model choices, and data sent to hosted endpoints](docs/DEPLOYMENT.md) · [Product features and implementation](docs/PRODUCT.md)
