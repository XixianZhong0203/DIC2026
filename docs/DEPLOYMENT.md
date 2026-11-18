# Running Daymark and connecting models

## Run locally

Use Node.js 24 or later. Copy [`.env.example`](../.env.example) to `.env`, configure a model, run `npm start`, and open [Daymark](http://127.0.0.1:4173). The interface and model instructions support English and Chinese. The selected interface language determines which instruction set Daymark sends. Source text and verbatim quotes retain their original language. Run `npm test` for unit checks. The database defaults to `data/daymark.sqlite`. Set `DAYMARK_DATA_DIR` to use a different directory.

## Connect a model

Set `OPENAI_BASE_URL` and `MODEL_ID` to connect your own OpenAI-compatible chat completion endpoint. Set `OPENAI_API_KEY` if the endpoint requires it. For example, an Ollama instance on this machine can use `http://127.0.0.1:11434/v1` and the ID of a model installed in Ollama. We recommend a model that runs on your machine for workflows involving sensitive customer records. The example environment currently selects the team’s Qwen configuration via a hosted LiteLLM endpoint.

We chose Qwen 3.8 27B via LiteLLM, Gemini 3.5 Flash-Lite, GPT via a local bridge, and models offered by OpenCode for our own deployment based on cost, availability, and testing needs. Daymark also accepts other models through the compatible endpoint configuration above.

For the team’s Gemini integration, set `GEMINI_API_KEY`. For the optional GPT connection, sign in to the Codex CLI, run `node scripts/local-gpt-bridge.mjs` separately, set `DAYMARK_CODEX_PICKER=1`, and restart Daymark. The local GPT bridge forwards requests to OpenAI. For a Node certificate validation error on macOS, `NODE_USE_SYSTEM_CA=1` enables the system trust store.

With `GEMINI_API_KEY` configured, Gemini 4 Hydrogen (`gemini-4-hydrogen`) appears in the conversation model picker after restarting Daymark. Chat instructions support general questions, writing, translation, and coding outside the project, while keeping project factual claims subject to evidence requirements.

The model selected in the composer handles that conversation’s chat replies. Topic detection, memory extraction and review, lead analysis, claim verification, and evaluations use the configured default model. If both chat and these workflows need on-device inference, configure the default endpoint accordingly.

## What we measured

The [README draft pilot](../README.md#pilot-findings) reports results for Gemini 3.5 Flash-Lite and Qwen 3.8 27B FP8 on the same synthetic drafts. GPT and OpenCode-backed models were outside that pilot.

## What Daymark sends to a model endpoint

| Workflow | Data included in the request |
| --- | --- |
| Chat and reply verification | Chat can include the current input, recent messages, workspace records retrieved for the turn, and relevant decision-card context. The follow-up claim check receives the reply and this turn’s retrieved source material. |
| Topic and workspace detection | When the workflow calls a model, it sends the new input, workspace names, and short excerpts from recent messages. |
| Memory extraction and conflict review | Extraction sends recent eligible conversation messages and project context. Conflict classification sends the proposed edit and candidate memory records. |
| Lead analysis and claim verification | Lead analysis can include the question and lead evidence. Claim verification uses the relevant source originals and either the prior lead assessment or the saved outreach draft, including its recipient. |

For a hosted endpoint, these request fields leave the machine. Daymark checks the assembled request for explicitly protected verbatim excerpts before calling a hosted endpoint. A matching excerpt blocks the request. This check depends on the protection rules the founder has added and on exact text matching. Paraphrases and unmarked information may still be sent. The GPT bridge is treated as hosted because it forwards requests. [Model request and workflow code](../server.mjs) · [Outreach verification](../src/opportunity/opportunities.mjs)


## Gemini text-to-speech

The optional speech tool uses `gemini-3.8-flash-tts` through Google's native Interactions API and reads `GEMINI_API_KEY` from the local `.env` file. Run it from the project directory with a UTF-8 text file.

```sh
npm run tts -- narration.txt narration.wav Kore "Clear, calm English narration"
```

Chinese and English input are supported. The optional final argument controls delivery style. The command writes a WAV file and refuses to overwrite an existing file. It sends the explicitly supplied text and style to Google. This command operates independently of the conversation model picker and does not retrieve workspace records or apply workspace disclosure rules. Select the text file accordingly.

A short English generation request succeeded with the configured Gemini key. Transport checks also exercised bilingual input, missing audio, and upstream HTTP errors. The generated sample stays outside the repository. [Google TTS documentation](https://ai.google.dev/gemini-api/docs/speech-generation)

## Gemini live translation and embeddings

These optional tools use the same local `GEMINI_API_KEY`. Run them from the project directory. They send only the files explicitly supplied to Google and do not retrieve workspace memories or apply workspace disclosure rules.

```sh
npm run translate-audio -- input.pcm translated.pcm en
npm run embed -- input.txt embedding.json
```

Live translation uses `gemini-3.5-live-translate-preview` and the native WebSocket protocol. Supply raw little-endian PCM16 mono audio at 16 kHz. The tool streams it at playback speed, writes translated raw PCM16 mono audio at 24 kHz, and prints translated transcripts to the terminal. Use `zh` for Chinese or `en` for English. This release exposes an audio-file streaming command. Browser microphone capture is outside this implementation. [Live translation protocol](https://ai.google.dev/gemini-api/docs/live-api/live-translate)

The embedding command uses `gemini-embedding-2` to convert UTF-8 text into a JSON vector with its model and dimension count. Workspace retrieval continues to use its existing ranking. Both commands require a new output path. [Embedding API](https://ai.google.dev/gemini-api/docs/embeddings)

Hydrogen, live translation, and Embedding 2 received offline configuration and protocol checks. No live connectivity or model-quality tests were requested for this integration.
