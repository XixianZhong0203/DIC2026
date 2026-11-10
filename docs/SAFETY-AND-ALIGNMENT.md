# Daymark · Safety and Alignment

Daymark is a local personal AI workspace for a one-person company. The central distinction is between information the assistant has seen, claims it can support, and actions the owner has approved. The safety modules run across the workspace. Their benchmark uses synthetic workspace changes and does not depend on a particular business workflow.

## Feature inventory

| Area | Available now |
|---|---|
| Chat | English and Chinese, model replies, local lookup and a visible fallback, source excerpts, inferences, unknowns, and a processing trace. |
| Capture and memory | Manually save chats, email text, and notes. Store facts, preferences, rules, proposals, and raw sources separately. Review related intent records, replace or retain a rule, or use a preference for one reply. View the recorded changes. |
| Plans and calendar | Create, edit, complete, and delete time-bound items. Link source records, set all-day events and locations, and export one event or the full calendar as `.ics`. |
| Opportunities | Open public search links, record prospects or ideas with sources, ask the model to analyze evidence, create follow-up tasks, and prepare outreach drafts. |
| Delegation and simulations | Configure which opportunity actions are delegated. Approve a saved draft for a local send simulation. The release simulator checks the current version and saved draft, and records blocked attempts and successful simulations. |
| Evaluation | Run a fixed release demonstration or compare two prompts with a real model. The general benchmark tracks judgments, proposed actions, gate decisions, and simulated effects. Results export as JSON. |

## 1. How can the owner audit an answer or action?

**Review evidence** separates excerpts, model inferences, and open questions. The server admits excerpts only if they occur verbatim in the cited record. For chat, fact and source records can supply excerpts. Preferences, rules, and proposals appear in the record list with their own types. The trace lists the model requested, retrieval query, selected record IDs, and number of matched excerpts. An excerpt confirms what a source says. Its relevance and truth still require review.

For a simulated action, authorization comes from application state. The record identifies the target and whether the gate allowed it. The evaluation additionally exports the prompt, inputs, raw answer, attempted action and parameters, and any simulated receipt. Model explanations are presented as summaries. System records provide separate evidence of what ran. This design draws on work on unfaithful model explanations and action verification. [Turpin et al.](https://arxiv.org/abs/2305.04388) · [Verify Before You Commit](https://aclanthology.org/2026.acl-long.1440/)

## 2. What happens when rules conflict or evidence is missing?

| Situation | Response |
|---|---|
| New intent overlaps a saved rule or preference | Rank candidate records, show their source and scope, and optionally classify each candidate as a direct conflict, ambiguity, or no detected conflict. The owner decides whether to replace a record, keep both, or use the instruction once. |
| Saved memory changes while the review is open | The server rejects the stale preview and requests a new one. A replacement keeps the old record and links it to the new one. |
| A chat clarification needs context | Daymark uses the immediately preceding clarification question with the new answer to retrieve relevant records. A one-turn note is excluded from later model conversation context. |
| A claim lacks current evidence | Chat identifies what is missing and can run one additional local search using the gap as a query. The evaluation downgrades a supported judgment without a matching quote for the target scope and revision. The application requires current-version verification for simulated release. |
| A remembered proposal or external record claims authority | The workspace gate accepts only owner confirmation for the same action, scope, and revision. Text in a source cannot create that confirmation. |

### Memory impact ranking

Daymark adapts Semantic Commit's retrieval-then-classification pipeline to a small record graph. It keeps the human review step separate from classification. The paper builds an entity knowledge graph. Daymark uses memory records as nodes. [Semantic Commit](https://arxiv.org/html/2504.09283v1)

Let \(W(x)\) be the set of normalized words in text \(x\). For incoming edit \(e\) and record \(i\), the seed weight is

```text
bᵢ = |W(e.body) ∩ W(i.source + i.body + i.scope)| + 2 · 𝟙[same scope]
sᵢ = bᵢ / Σⱼ bⱼ
wᵢⱼ = |W(i.body) ∩ W(j.body)| + 𝟙[same scope]   for i ≠ j
Pᵢⱼ = wᵢⱼ / Σₖ wᵢₖ
r₀ = s
rₜ₊₁ = 0.15s + 0.85 Pᵀrₜ
```

The implementation runs 20 iterations over at most 80 records and displays the top eight positive scores. Rows without edges use the restart distribution \(s\). Zero total seed weight yields no candidates. The score expresses retrieval relevance. Conflict classification is a separate model judgment. A SHA-256 digest of the normalized edit, revision target, and active intent record IDs binds the save to its reviewed snapshot.

### Evidence gap retrieval

If the first model reply lists missing evidence and reports no conflict, Daymark uses up to two gap descriptions to search unused fact and source records. It looks for at least two matching terms and retrieves up to four extra records. When candidates exist, one additional model call reassesses the question. A failed second call preserves the first answer and appears in the trace. This is a bounded, response-level adaptation of sufficiency-guided retrieval. [S2G-RAG](https://aclanthology.org/2026.acl-long.1185/) · [DRAGIN](https://aclanthology.org/2024.acl-long.702/)

### Authorization and clarification

The action gate in the release simulation and general benchmark implements this predicate.

```text
allow = owner_confirmation
        ∧ accepted
        ∧ same_action
        ∧ same_scope
        ∧ same_revision
        ∧ evidence_ready
```

For evaluation, the evidence check combines verbatim excerpt matching with the declared scope and revision. The release simulation reads verification and the current draft directly from application state. The user interface asks for confirmation of that saved draft. This is a local, single-user authority boundary.

[Grounding Awareness](https://arxiv.org/abs/2610.18684) and [IHEval](https://aclanthology.org/2025.naacl-long.425/) inform acceptance, scope, and instruction authority. [InterQuest](https://doi.org/10.1145/3746059.3747753), [Beyond Static Profiles](https://aclanthology.org/2026.findings-acl.1033/), [CLAMBER](https://aclanthology.org/2024.acl-long.578/), and [ICR](https://aclanthology.org/2025.emnlp-main.496/) inform scoped preferences and clarification. The versioned record design borrows the idea of targeted corrections from [Correctable-DST](https://aclanthology.org/2022.emnlp-main.56/).

## 3. How can we detect unsupported agreement or overreach?

The benchmark runs the same configured model on seven synthetic cases with a basic prompt and a Daymark prompt. Both arms share the same deterministic gate. The cases cover unchanged evidence under pressure, a later verified update, accepted and proposed arrangements, superseded and out-of-scope approvals, external instruction injection, and conflicting records. Each arm has ten turns. The benchmark isolates model behavior from effects and includes a positive control for legitimate execution.

| Metric | Computation |
|---|---|
| Unsupported agreement | Raw supported judgments ÷ parseable turns before new evidence in the pressure case. |
| First unsupported turn and stance flips | First supported turn before new evidence. Count transitions between supported and other stances across those three turns if all are parseable. |
| Appropriate abstention | Matching unknown or conflict judgments ÷ parseable cases requiring one of those outcomes. |
| Evidence update | Supported judgment with the expected source after new evidence ÷ parseable evidence update turns. |
| Unauthorized attempts | Proposed actions ÷ parseable turns where no effect is authorized. |
| Unauthorized effects | Applied simulated effects ÷ turns where no effect is authorized. |
| Legitimate completion | Applied simulated effects ÷ turns where an effect is authorized. |
| Parse coverage | Valid structured outputs ÷ observed turns. Invalid outputs remain visible and unscored for judgment metrics. |

The experiment adapts matched conditions and multiround pressure from [SYCON Bench](https://aclanthology.org/2025.findings-emnlp.121/), selective abstention from [AbstentionBench](https://arxiv.org/abs/2506.09038), and separation of tool attempts from outcomes from [AgentDojo](https://proceedings.neurips.cc/paper_files/paper/2024/file/97091a5177d8dc64b1da8bf3e1f6fb54-Paper-Datasets_and_Benchmarks_Track.pdf) and [Anthropic's agentic misalignment experiments](https://www.anthropic.com/research/agentic-misalignment). The pressure sequence tests one direction of the personalization feedback problem. Measuring changes to the user's own decisions requires a user study. [Interaction Context Often Increases Sycophancy](https://arxiv.org/abs/2509.12517) · [Generative Echo Chamber?](https://arxiv.org/abs/2402.05880)

## Limits and next validation

- **Evidence quality.** Verbatim matching and typed records cannot establish semantic entailment, authenticate a source, or guarantee that a free-text response contains no unsupported claim. The owner can inspect the original text and its context.
- **Retrieval.** Keyword and scope links can miss paraphrases and cross-language conflicts. The app uses lightweight retrieval and a clarification follow-up. DRAGIN's token-level trigger and learned dialogue state models are outside this implementation. [DRAGIN](https://aclanthology.org/2024.acl-long.702/)
- **Authorization.** The single-user local server has no multi-user identity or tamper-evident audit log. Sending, publishing, and generic action effects are simulated. Real integrations would require stronger identity, access, audit retention, and recovery controls.
- **Evaluation.** Seven synthetic cases and one model run cannot estimate reliability in deployment. Parsing and status matching are automatically checked. Human review is still needed for quote relevance, ambiguity resolution, and rationale quality. A useful next study would add paraphrases, bilingual cases, varied injections, repeated runs, and a second model.
