# Daymark · DIC2026

Daymark is a local AI workspace for a one-person company. It helps the owner organize project context, assess customer leads and improvement ideas, and prepare work for review. It keeps source evidence, model judgments, and owner approval visible at the points where the owner needs to make a decision.

## What you can do

- **Chat and projects.** Create, organize, and resume conversations. Open the evidence panel to see retrieved records, verified excerpts when available, inferences, and open questions.
- **Records and memory.** Save source material, facts, preferences, rules, and proposals. Chat history is saved automatically; long-term memory is added through explicit saves. Memories are project-scoped: a chat only retrieves records of its own project and records saved as global, so a change in one project never touches another. Review overlapping records before changing a saved rule. Extract memory candidates from a conversation — content, type, scope, confirmation status, and source message — and confirm them before they are saved. Requests from the other side (like a client proposing a new delivery date) are kept as unconfirmed proposals; the previously confirmed rule stays valid until you accept, and accepting revises the old rule with a change record.
- **Customer leads and improvement ideas.** Open a public search link, record sources manually, ask the model to assess an opportunity, and prepare a follow-up or an outreach draft.
- **Tasks and calendar.** Create and update local tasks, link them to source records, and export calendar events as ICS files.
- **Decision cards.** When a reply hits a conflict (a reschedule, a long-term preference clash) or an evidence gap, an interactive card appears next to the reply: what is currently confirmed, why you must decide, and what each option will do. A selection returns to the conversation so follow-ups can refer to it; confirming runs the option through its normal flow — calendar/task updates with conflict checks, the memory impact review for long-term preference changes, or a drafted clarification question — and shows the result. A one-time exception applies only to the next reply.
- **Approval and activity.** Review saved drafts, require evidence review for simulated outreach, and inspect approval, blocking, and simulation events. Simulated publishing checks the draft and the current version's verification record.

## Safety boundaries

An exact excerpt establishes that the quoted text appears in a saved record. Assessing whether it supports the conclusion still requires review. An owner approval applies to the saved draft being approved. Daymark simulates sending and publishing locally.

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
- `src/` contains chat retrieval, memory, opportunities, calendar, release policy, action checks, and decision cards (`src/decision/`).
- `evaluation/` and `scripts/` contain developer tooling. Run `npm test` for automated code checks, and `node scripts/memory-acceptance.mjs` for the end-to-end memory save and conflict acceptance (chat steps run when a model is reachable; otherwise they are skipped and the trace is written to `docs/evidence/`).
