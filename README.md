# Daymark · DIC2026

Daymark is a local AI workspace for a one-person company. It helps the owner organize project context, assess customer leads and improvement ideas, and prepare work for review. It keeps source evidence, model judgments, and owner approval visible at the points where the owner needs to make a decision.

## What you can do

- **Chat and projects.** Create, organize, and resume conversations. Open the evidence panel to see retrieved records, verified excerpts when available, inferences, and open questions.
- **Records and memory.** Save source material, facts, preferences, rules, and proposals. Review overlapping records before changing a saved rule. Chat history is saved automatically. Long-term memory is added through explicit saves.
- **Customer leads and improvement ideas.** Open a public search link, record sources manually, ask the model to assess an opportunity, and prepare a follow-up or an outreach draft.
- **Claim verification.** Add dated sources to a lead, then verify its key claims against that evidence: verdicts with verbatim source quotes, concrete gaps and supported rewrites for unsupported claims, and automatic re-verification when the evidence or the draft changes.
- **Tasks and calendar.** Create and update local tasks, link them to source records, and export calendar events as ICS files.
- **Approval and activity.** Review saved drafts, require evidence review for simulated outreach, and inspect approval, blocking, and simulation events. Simulated publishing checks the draft and the current version's verification record.

## Safety boundaries

An exact excerpt establishes that the quoted text appears in a saved record. Assessing whether it supports the conclusion still requires review. An owner approval applies to the saved draft being approved. Daymark simulates sending and publishing locally.

## Claim verification

A lead can hold named sources with an optional date and a provenance — customer record or founder-provided. Verification treats all source text as data only: instructions embedded in a source have no authority, and every source that matters must be cited with a quote that occurs verbatim in it. Founder-provided facts keep their provenance and may only support what they state.

- **After an analysis.** When an assessment is saved, the two decision-relevant claims — purchase intent and signing status — are verified automatically, and the result is shown in the analysis card: verdict, verbatim quotes with dates, and for unsupported claims a concrete missing-information gap plus a rewrite the evidence can support.
- **After a saved draft.** The button beside the saved draft, “Verify key claims”, checks the draft body (customer intent, signing status, company performance, external commitments). Each claim sentence is marked with its verdict, the supporting evidence or the gap, and an evidence-supported rewrite. “Adopt rewrite and re-verify” first saves the rewrite as a new draft version and then re-verifies.
- **Verdicts.** Supported, refuted, insufficient evidence, conflicting sources, or verification incomplete. A newer explicit withdrawal of the same commitment decides the current state by date and scope; two still-valid records whose precedence cannot be ordered are a source conflict, shown with both original texts and their dates.
- **Guards.** A cited source that does not exist, a quote that is not verbatim in the source, missing fields, or a failed model request leave the claim verification incomplete with the failed check displayed, and the result can be retried. A verification is bound to the evidence and, for drafts, to the draft version, recipient, and body; any change makes the result stale until it is re-verified.
- **No new send gate.** Verification status and approval status are shown as separate lines. Sending remains controlled by the existing explicit-approval flow for the current draft.

## Browser acceptance (claim verification)

Both paths work: with a model configured, and without one (the failure path is stored, not fatal).

1. **Save a lead.** Customer leads → new lead → enter a title, source, and evidence → save.
2. **Add sources.** In the lead card, open the “Sources” block (below the evidence) and save a customer record: name, a date, and the original text (for example, a note that the customer intends to sign this quarter, dated). A founder-provided fact can be saved the same way with its own identity.
3. **Analyze.** Click “Analyze with model”. With a model configured, the analysis card appears and the “Claim verification · analysis claims” card shows a verdict for purchase intent and signing status, each with its verbatim quote and date. Without a model, the analysis fails normally; step 4 still lets you exercise the verification UI.
4. **Save a draft and verify it.** Enter a recipient and body, save the draft, then click “Verify key claims” beside the saved version. With a model configured, each claim in the body is marked with verdict, evidence or gap, and a supported rewrite. Without a model, the card shows “Model request failed”, every claim as “verification incomplete” with the failed check, and a “Verify again” button to retry.
5. **Adopt a rewrite.** For a claim with a rewrite that occurs in the draft body, click “Adopt rewrite and re-verify”: the rewrite is saved as a new draft version and verification runs against it.
6. **Check staleness.** Edit the draft body and save a new version. The verification card reports “Verification is out of date: sources or the draft changed” and the “Verification status” line shows stale; “Verify again” re-binds to the new version.
7. **Check a withdrawal.** Add a newer dated source that explicitly withdraws an earlier commitment, and re-verify: the claim flips to refuted, the newer record is shown as decisive, and it is marked as withdrawn. Two undecidable same-date records instead show as a source conflict with both texts.
8. **Separate statuses.** “Verification status” and “approval status” are displayed as separate lines; sending still requires the existing explicit approval of the current draft.

## Run locally

Use Node.js 24 or later.

```sh
npm start
```

Open [Daymark](http://127.0.0.1:4173). The interface is available in English and Chinese. For chat, start a local Ollama model or configure an OpenAI-compatible Chat Completions endpoint in `.env`. For example:

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
MODEL_ID=qwen2.5:3b
OPENAI_API_KEY=
```

Restart Daymark after changing the configuration. Hosted providers receive relevant records and recent conversation when they are included in a model request. The workspace database is stored in `data/`.

## Repository

- `server.mjs` wires the local API, database, and frontend.
- `dist/` contains the browser interface.
- `src/` contains chat retrieval, memory, opportunities, calendar, release policy, and action checks.
- `evaluation/` and `scripts/` contain developer tooling. Run `npm test` for automated code checks.
