# Daymark · DIC2026

Daymark is a local AI workspace for one-person companies. It helps a founder keep project decisions across conversations, assess customer leads, and review evidence before approving outreach.

## What you can do

- **Review the evidence behind a reply.** Open the evidence panel to see retrieved records, exact excerpts when available, model inferences, and open questions. For simulated outreach, review the approval, block reason, or simulated result in the activity log.
- **Carry project decisions across conversations.** Extract memory candidates from a chat and confirm what to save. Project chats retrieve records for their project and records marked global.
- **Resolve conflicts in chat.** Decision cards can show the current arrangement and a new proposal, surface the local calendar, or offer a one-time exception and a long-term preference change. Confirm a change before applying it.
- **Track leads and improvement ideas.** Record sources manually, assess an opportunity, prepare an outreach draft, and create follow-up tasks. Tasks can link to sources and appear in a local calendar with ICS export.

## Verify claims before simulated outreach

1. Save a lead and add source records. Label customer records and founder-provided information, and add dates when known.
2. Analyze the lead. Daymark checks purchase intent and signing status against the supplied sources.
3. Save an outreach draft and select **Verify key claims**. The draft shows its current status, the actual verification scope (which claims were checked), and highlights claims that are unsupported, contradicted, conflicting, or incomplete. If no claim is extracted, the empty scope is shown explicitly instead of counting as passed. Open the cited source to review the evidence.
4. Adopt a suggested rewrite or edit the draft, then verify the new version. You can also record a human review conclusion for the current draft.
5. Approve the saved draft when ready. Daymark checks its current version and requires up-to-date verification or a current human review before simulating the send.

A human review is bound to the current draft version **and** the current set of sources: when the body, recipient, or any source changes, the review is shown as expired with the reason (the draft changed or the sources changed) and no longer unlocks the send; records created before the source binding have no source version and prompt re-review. An expired review can be replaced by a fresh verification of the current evidence or a new review of the current draft. Automated verification uses the configured model to interpret supplied records. Daymark checks that quotations appear verbatim in those records. When competing sources cannot be resolved by an explicit revision or withdrawal, both remain visible. Adding a source can trigger automated verification again. Sending and publishing run as local simulations.

## Run locally

Requires Node.js 24 or later. Run `npm start` and open [Daymark](http://127.0.0.1:4173). The interface supports English and Chinese.

To use chat, configure Ollama or another OpenAI-compatible Chat Completions provider in a local `.env`. For example:

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
MODEL_ID=qwen2.5:3b
OPENAI_API_KEY=
```

Start the configured model before using chat and restart Daymark after configuration changes. Daymark stores workspace data in `data/`. With a hosted provider, relevant records and recent conversation may be included in model requests.

Run `npm test` for automated code checks.
