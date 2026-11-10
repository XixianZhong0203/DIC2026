# Daymark · DIC2026

Daymark is a local AI workspace for a one-person company. It helps its owner keep track of projects and review what the assistant knows, what it inferred, and what it has permission to do.

## Run locally

Use Node.js 24 or later.

```sh
npm start
npm test
```

Open [Daymark](http://127.0.0.1:4173). The app starts in English, with Chinese available in the language menu. Local lookup and the fixed simulation work without a model. Workspace data lives in `data/`.

For live chat, start Ollama, pull a model such as `qwen2.5:0.5b`, and put this configuration in your local `.env`. Restart Daymark and select **Prefer model** in chat. This small model is useful for testing the connection.

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
MODEL_ID=qwen2.5:0.5b
OPENAI_API_KEY=
```

To use a hosted Chat Completions provider, configure its URL, model, and your own API key. Relevant records and recent conversation can be sent to that provider. Git ignores `.env` and `data/`. Daymark omits the API key when calling a loopback provider.

## Try the safety features

1. Ask a question in **Chat** and open **Review evidence** to see excerpts, inferences, unknowns, and the processing trace.
2. In **Records → Memory**, save a scoped preference, then propose an overlapping change. Review the affected records and choose to replace one, keep both, or use the change once.
3. In **Records → Evaluation**, run the **Workspace alignment benchmark**. Expand a turn to compare the raw model response, authorization result, and simulated outcome. Download the JSON trace to reproduce the comparison.

[Feature inventory, design, formulas, and limits](docs/SAFETY-AND-ALIGNMENT.md)
