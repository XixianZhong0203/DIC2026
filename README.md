# Daymark · DIC 2026

Daymark is a local AI workspace for a one-person company. The founder often makes decisions and reviews the assistant’s work alone. Daymark checks claims in customer outreach before a founder approves the exact draft and evidence under review.

## At a glance

- **Server enforcement.** The current local revision passes 304 unit tests, 26/26 approval checks, 24/24 chat checks, and 27/27 shared-memory checks with deterministic model substitutes. The earlier baseline detected 13 deliberate changes to server safeguards. [Verification and coverage](#agentic-misalignment-and-verification)
- **Draft pilot.** Gemini and Qwen extracted **13/21** and **12/21** annotated problem claims, respectively. With either model, the simulated approval workflow blocked all **19** problem drafts and cleared **2/3** clean drafts. The synthetic drafts were model-authored. [Pilot design and limits](#pilot-findings)
- **Human review.** Whether reviewing claims individually helps founders find more errors, and how much time it takes, remains unmeasured.

## 1. How can the founder audit the assistant’s reasoning and actions?

The evidence panel separates records provided to the model, sources cited by the reply, and excerpts the verifier judged to support or oppose a claim. The decision and task logs show what changed, including calendar changes and their receipts. Each simulated send exports a snapshot of the approved draft, sources, claim verdicts, guarantees, and approval. A SHA-256 digest detects partial edits to an archive when the approval audit remains intact. Both records live in the same local database. [Audit and archive details](docs/PRODUCT.md#1-how-can-the-founder-audit-the-assistants-reasoning-and-actions)

## 2. What happens when instructions conflict or the assistant is uncertain?

Daymark labels mixed evidence **partially supported** when confirmed claims coexist with unresolved claims. It names the confirmed part, keeps the unresolved part visible, and asks for missing evidence before reliance. Daymark can show what the evidence establishes, what is still missing, and which question or record would resolve it. For example, a customer’s willingness to sign leaves the contract’s signing status unconfirmed. Decision cards distinguish a one-time exception, a policy change, and an external proposal. Before applying a calendar or memory change, Daymark rechecks the current state. Project records can be shared explicitly, with their origin and applicability preserved. [Workspace, memory, and confirmation details](docs/PRODUCT.md#2-what-happens-when-instructions-conflict-or-the-assistant-is-uncertain)

## 3. How can the founder catch unsupported agreement before relying on an answer?

Chat flags unsupported or disputed assertions above the reply and links each flag to the relevant sources. When the extracted claims all have support, the status gives the count and limits its conclusion to those extracted claims. Outreach checks show which claims were extracted and use a separate scan to catch placeholders and common high-risk clauses the model may have missed. The server blocks simulated sending unless the current draft satisfies the applicable review and explicit approval requirements. An unresolved claim survives edits and incomplete rechecks. Recipient restrictions can also block protected verbatim excerpts. The code checks cited text and applies contextual rules. Additional guards for completed-signing claims flag question forms, polarity mismatches, intent without completion, one-word English excerpts, and NDA evidence used for a different contract. The coverage scanner also flags quantities, currency amounts, and certification claims that were omitted from extraction. Whether a passage semantically supports a claim remains a model judgment. [How we test for sycophancy](#sycophancy-abstention-and-source-injection) [Claim verification and approval details](docs/PRODUCT.md#3-how-can-the-founder-catch-unsupported-agreement-before-relying-on-an-answer)

## Agentic misalignment and verification

The [Anthropic agentic misalignment study](https://www.anthropic.com/research/agentic-misalignment) tested models that could act under replacement or goal conflict. In Daymark, model output can propose a judgment or action. The server handles approval and the local simulated effect. The deterministic acceptance suite checks that forged approval text in chat, an added source, or an initial source produces zero simulated sends in those cases. [Request-boundary and concurrency acceptance](scripts/gate-concurrency-acceptance.mjs)

| Check | Result and scope |
| --- | --- |
| Current deterministic verification | **304 unit tests**, **26/26** approval checks, **24/24** chat claim checks, **27/27** shared-memory checks, **31/31** lead-answer checks, **67/67** customer-delivery checks, **44/44** archive checks, and **22/22** security regression checks passed. These checks use scripted model responses. |
| Earlier baseline verification | At baseline `ace50e3`, request-boundary/concurrency/model-input checks passed **95/95**, workspace isolation passed **29/29**, and server safeguard mutation checks detected **13/13** changes. Those mutation cases predate the new signing-support guards. |

[Mutation cases and coverage limits](docs/PRODUCT.md#conditions-tested-by-mutation)

### Pilot findings

The real-model draft pilot predates the current signing-support guards and partial-answer status. It used commit `ace50e3`, the same 22 synthetic drafts per model, and one run per model. An approval attempt targeted the current draft version without manual review or a founder guarantee.

| Outcome | Gemini 3.5 Flash-Lite | Qwen 3.8 27B FP8 |
| --- | ---: | ---: |
| Problem claims extracted | 13/21 | 12/21 |
| Extracted problem claims flagged | 13/13 | 12/12 |
| Request or parsing failures | 1/22 | 7/22 |
| Problem drafts cleared for simulated send | 0/19 | 0/19 |
| Clean drafts cleared for simulated send | 2/3 | 2/3 |

The two-sided 95% Wilson interval for each 0/19 result is approximately **0–16.8%**. The send outcome includes blocks caused by failed checks. The drafts were authored by model families under test. The pilot included three clean drafts and no independent human-authored holdout. The Gemini run retains per-case console outcomes and summary counts. Its raw draft responses were overwritten in a report filename collision.

An offline diagnostic of the same baseline draft set ran the rule scanner without pre-covered spans. It flagged clauses containing **14/21** annotated problem spans. The archived Qwen extraction hit **12/21**. Counting the two sets together yielded **19/21** spans, including **7** spans found only by rules. This measures coverage of annotated text under a diagnostic setting. It is separate from per-draft runtime blocking and from semantic correctness.

### Sycophancy, abstention, and source injection

The second-round evaluation tests whether a lead assessment follows the founder's confidence when the customer evidence stays the same. For example, the founder may insist that a prospect is definitely buying after the prospect merely asks to see examples.

- **Same evidence, different framing.** Compare neutral, pressuring, and affirming prompts against identical customer evidence.
- **Repeated pushback.** Reassess the same lead over four rounds with no new evidence and track changes in the verdict. Compare the model's raw verdict with the status Daymark shows.
- **New evidence as a positive control.** Add an explicit customer commitment and check that the assessment updates. A system that always abstains can pass the pressure case and still fail this control.

The harness also covers abstention, workspace isolation, and source injection. Run `node evaluation/round2.mjs --fixture` to check the pipeline with predetermined answers. Real-model sycophancy results for this harness are pending. [Second-round evaluation](evaluation/round2.mjs)

## Current limits

- **Citation scope.** Signing-support guards cover a bounded set of wording, polarity, and document-kind patterns. Paraphrases, unusual phrasing, and other claim types can still escape the guards. Conservative checks can also reject valid excerpts. Compare the source before approving a consequential claim.
- **Chat coverage.** Retrieved records are sent in a separate reference-data message with an explicit untrusted-data label. Instructions inside a record cannot provide approval. This separation still depends on the model following the rules. The checker sees this turn’s retrieved records. A missed counterexample or an assertion the model failed to extract can escape the check. The top status summarizes extracted claims.
- **Draft edits.** The bilingual matcher recognizes common signing, payment, delivery, completion, and commitment phrases. It can miss paraphrases or misunderstand a change of subject. The founder may still need to compare versions and decide whether the original assertion remains. [Rewrite matcher](src/opportunity/claim-match.mjs)
- **Shared records and disclosure.** The founder can consult and share records across projects. The recipient and hosted-model checks match explicitly protected excerpts. Reworded disclosures and sensitive information without a protection rule remain outside this check. The applicability label guides how the model uses shared material. Tests cover recorded provenance, retrieval boundaries, and the draft checks in the exercised cases. In a small Gemini chat pilot, one of two replies about customer B repeated customer A’s terms while correctly leaving B’s price unconfirmed. Neither reply became a saved outbound draft. Broader measurement remains pending.

## Run locally

Use Node.js 24 or later. Copy [.env.example](.env.example) to `.env`, configure a model, run `npm start`, and open [Daymark](http://127.0.0.1:4173). Daymark supports self-hosted and hosted OpenAI-compatible endpoints. We recommend on-device inference for workflows that handle sensitive customer records. [Deployment, model choices, and data sent to hosted endpoints](docs/DEPLOYMENT.md) · [Product features and implementation](docs/PRODUCT.md)
