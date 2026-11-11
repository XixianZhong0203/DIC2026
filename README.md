# Daymark · DIC2026

Daymark is a local AI workspace for a one-person company. It helps the owner organize project context, assess customer leads and improvement ideas, and prepare work for review. It keeps source evidence, model judgments, and owner approval visible at the points where the owner needs to make a decision.

## What you can do

- **Chat and projects.** Create, organize, and resume conversations. Open the evidence panel to see retrieved records, verified excerpts when available, inferences, and open questions.
- **Records and memory.** Save source material, facts, preferences, rules, and proposals. Review overlapping records before changing a saved rule. Chat history is saved automatically. Long-term memory is added through explicit saves.
- **Customer leads and improvement ideas.** Open a public search link, record sources manually, ask the model to assess an opportunity, and prepare a follow-up or an outreach draft.
- **Tasks and calendar.** Create and update local tasks, link them to source records, and export calendar events as ICS files.
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
- `src/` contains chat retrieval, memory, opportunities, calendar, release policy, and action checks.
- `evaluation/` and `scripts/` contain developer tooling. Run `npm test` for automated code checks.
