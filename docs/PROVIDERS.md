# Providers

MyJournal talks to one AI model at a time, and you choose which. Three kinds are built in. They are all optional: with none connected (or the AI switched off) the app is a plain private journal.

| Provider (id) | What it is | Key | Default address | Default model |
|---|---|---|---|---|
| **Free Gemini** (`gemini`) | Google's Gemini API, free tier from AI Studio, spoken to with Google's own REST protocol | required | `https://generativelanguage.googleapis.com` | `gemini-flash-lite-latest` |
| **OpenAI-compatible** (`openai`) | Any service that speaks the OpenAI "chat completions" API: OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, gateways | required | `https://api.openai.com/v1` | `gpt-4o-mini` |
| **Local model** (`local`) | A small model served from your own machine: Ollama, llama.cpp `llama-server`, LM Studio, vLLM | optional | `http://localhost:11434/v1` | `llama3.2:3b` |

`openai` and `local` use the same code (`src/providers/openai.js`); they differ in their defaults, wording, whether a key is needed, and the Ollama helpers (model download).

This page goes deep. For the short recipes see the [README](../README.md#connect-a-model); for what each provider receives see [PRIVACY.md](PRIVACY.md).

- [How a model is used](#how-a-model-is-used)
- [Google Gemini](#google-gemini)
- [OpenAI-compatible APIs](#openai-compatible-apis)
- [Local models](#local-models): [Ollama](#ollama) · [llama.cpp](#llamacpp) · [LM Studio](#lm-studio) · [vLLM](#vllm-and-others) · [context windows](#context-windows-and-the-truncation-trap) · [small-model advice](#small-model-advice)
- [Troubleshooting: every error code](#troubleshooting-every-error-code)

## How a model is used

Everything below applies to all three providers.

**What is asked of the model.** Journal replies, the wrap-up reflection and the weekly reflection are streamed, so text appears as it is written. Two small helper calls, the title/summary/feelings/tags step and the memory step, are not streamed; they use a fixed low temperature (0.2) and a short answer cap (160 tokens). Wrap-up runs its three calls one after another, never in parallel, to stay inside free-tier rate limits. The title and memory steps are best effort: if one fails, the entry is still wrapped up and you get a toast saying what was skipped.

**Prompts for small models.** System prompts are short and imperative (one task per call, exactly one question per reply). The title and memory steps ask for labelled plain-text lines (`Title: …`, `- fact`), never JSON, and the parsers tolerate sloppy output and fall back to something sensible (for example the first words of your entry as a title).

**Your settings that reach the model** (Settings → General): *Creativity* (temperature, default 0.7), *Longest reply* (max tokens, default 700), *Context budget* (default 3,000 tokens: how much conversation and memory is sent; counted conservatively as characters ÷ 3.5; measured with Llama 3.2 on English text, that over-counts the real number by roughly a quarter to a third) and *Wait for the first word* (default 120 s). When the conversation outgrows the budget, MyJournal gives up, in this order: related past entries, then memories (unpinned first), then the oldest messages; only after that does it switch to a shorter system prompt, and as a last resort it cuts the middle out of your latest message. Your entry itself is never shortened, only what is sent.

**Timeouts and retries.** Two timers protect you from hangs: the *first-byte* timeout (*Wait for the first word*) and a 60-second silence limit between chunks once text is flowing; either one produces a `timeout` error. The one place a timeout above 300 seconds cannot work is Node's own limit of 300 s for response headers. One automatic retry happens for a `429` or `503` whose suggested wait is 8 seconds or less (one second when none is given), and never after any text has been received. **Test connection** gives up after 90 seconds and **Load models** after 20, whatever your timeout says.

**Test connection** sends one tiny request ("Reply with the single word: OK", 16 tokens) using the values currently in the form, *before* you save them, and reports latency plus whatever came back. It counts as a success even if the model returns nothing (some reasoning models spend all 16 tokens thinking), as long as the server answered like an AI API. A web page or other text at the address is reported as `bad_base_url`.

**Errors never contain your key**; it is scrubbed from every message, hint and log line. The same `code`, `message` and `hint` appear in the app's error banners, in `POST /api/providers/test` responses and in the streaming `error` events; see the [error table](#troubleshooting-every-error-code).

## Google Gemini

### Setup

Create a key at <https://aistudio.google.com/apikey>, then either paste it in **Settings → Gemini (free)** or start the server with `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) set. The key travels only in the `x-goog-api-key` request header, never in a URL. A key saved in Settings wins over the environment; keys from the environment are never written to the database.

The base URL is `https://generativelanguage.googleapis.com`. If you paste one ending in `/v1beta` or `/v1`, MyJournal removes that suffix itself. A path prefix (for example a company gateway) is kept.

### Models

The default is **`gemini-flash-lite-latest`**. Facts measured against Google's real API on 2026-10-08 with a free-tier key:

| model | time to first byte | thinking tokens (default / `low`) | notes |
|---|---|---|---|
| `gemini-flash-lite-latest` (→ `gemini-3.5-flash-lite`) | 0.5–1.4 s (one 13 s outlier) | 0 / about 465 | does not think by default; best free quota |
| `gemini-3.5-flash` | 4.0–4.5 s (2.1–2.9 s with `low`) | about 810 / about 350 | |
| `gemini-flash-latest` (→ `gemini-3.8-flash`) | all 3 default-mode requests answered `503` after 1–3 s; the one `low` request that worked took 23 s | 69–286 on `low` | "smarter" but busy: the whole reply arrives in one burst |
| `gemma-4-26b-a4b-it` | about 7 s (one sample) | about 290 | rejects any `thinkingLevel` |
| `gemini-2.5-flash-lite` | 1.6 s | 0 | rejects `thinkingLevel` |

Raw responses are in `test/fixtures/gemini-live/` (see its README). Treat the numbers as a snapshot: Google changes what the `-latest` aliases point to, and load varies by hour. That is why Flash-Lite is the default and **Flash** (`gemini-flash-latest`) is offered as "Smarter, can be slow or busy". The suggested models in the app are `gemini-flash-lite-latest`, `gemini-flash-latest`, `gemini-3.5-flash-lite` and `gemini-3.5-flash`.

**Load models** lists what your key can use. The raw list from Google has 62 entries on one page, including many that cannot chat (`*-tts`, `*-image*`, `lyria-*`, `deep-research-*`, embeddings, robotics, computer-use …) and some chat models that have been **retired but are still listed** (`gemini-2.5-flash` answers `404 "no longer available to new users"`). MyJournal keeps ids starting with `gemini-` or `gemma-`, drops the non-chat families, requires `generateContent` support, and sorts `-latest` aliases first, then newest first, with Gemma last. A retired model that slips through is caught when you use it: the error says *Gemini has retired "…"* and quotes Google's own suggestion ("Google suggests gemini-3.8-flash — pick a model from Load models in Settings").

### Thinking

Newer Gemini models may "think" before answering, and **thinking tokens count against the reply's token cap**. Live, 189 of a 200-token cap were spent thinking and the reply was cut off. So MyJournal always asks for room for the answer: `maxOutputTokens` = your *Longest reply* + 2,048 (at most 8,192). Reply length is steered by the prompt, not by that cap.

The *Gemini thinking* option has two values:

- **auto** (default): no thinking setting is sent; the model decides.
- **low**: sends `thinkingLevel: "low"`. If a model answers 400 about thinking, MyJournal drops the setting and remembers that for that model while it runs. On Flash-Lite, `low` turns thinking *on* and was slower, not faster.

`thinkingBudget: 0` and `thinkingLevel: "minimal"` are never sent: the live API rejects them on current models (400 "Request contains an invalid argument." / "Thinking level MINIMAL is not supported for this model").

### Conversation shape

Gemini accepts a conversation that **starts** with a model turn (a guided journal's opening question), so none is invented. It rejects one that **ends** with a model turn (400 "Requests ending with a model turn are not supported.") and empty text (400 "Request has empty input."). MyJournal therefore drops empty messages, merges neighbouring turns of the same role, and, if there is nothing to answer, refuses locally with "There is nothing to reply to yet." without calling the API. The system prompt goes in `systemInstruction`; for a model that rejects that, it is folded into the first message.

### Errors seen live, and the free tier

| What Google sent | MyJournal says |
|---|---|
| invalid key: HTTP 400, `API_KEY_INVALID` | `auth`: Gemini rejected the API key |
| no key: HTTP 403 "Method doesn't allow unregistered callers" | `auth`: Gemini needs an API key |
| unknown model: 404 `NOT_FOUND` | `model_not_found` |
| retired model: 404 "no longer available to new users" | `model_not_found`, quoting Google's suggested replacement |
| overload: 503 `UNAVAILABLE` "currently experiencing high demand" (after anything from 1 to 20+ seconds) | `overloaded` |

A rate-limit answer (`429 RESOURCE_EXHAUSTED` with a retry delay) could not be provoked during verification, so that mapping follows Google's documented error format rather than a live capture: a per-minute limit becomes `rate_limit` with the wait Google asked for; a per-day limit, or a model whose free quota is `limit: 0`, becomes `quota`.

**Free-tier limits differ by model and change over time.** Check your current limits in AI Studio; MyJournal never hard-codes numbers. **Availability by region** also varies: where the free tier is not offered, Google answers with a location error and MyJournal shows the `region` message. **Privacy:** on the free tier Google may use your prompts and responses to improve its products and humans may review them; billing-enabled projects are not used that way. Do not journal secrets with a free key, and check Google's current terms for your country.

Gemini can also refuse a prompt for safety reasons (journaling about hard things can trip the filters). That arrives as `blocked`; rephrase or use another provider.

## OpenAI-compatible APIs

### Setup

**Settings → OpenAI-compatible**: key, base URL (presets for OpenAI `https://api.openai.com/v1`, OpenRouter `https://openrouter.ai/api/v1`, Groq `https://api.groq.com/openai/v1`, Together `https://api.together.xyz/v1`), model name (**Load models** lists what the key can use). Or `OPENAI_API_KEY` and `OPENAI_BASE_URL` in the environment (the base URL only seeds a fresh install). Anything that serves `POST {base}/chat/completions` with streaming and `GET {base}/models` works. The adapter is tested against mock servers and responses recorded from real Ollama and llama.cpp servers; the commercial endpoints above could not be reached from the environment where this was verified, so their specifics follow their documentation.

### Addresses

Type the full address, including `http://` or `https://`. You can be loose about the end: trailing slashes are removed, a pasted `/chat/completions` is cut off, and a bare `https://api.openai.com` (or a bare local address such as `http://localhost:11434`) gets `/v1`. Settings refuses addresses with a username or password, a `?query` or a `#fragment`, or a scheme other than http(s): keys must never travel in URLs.

**Azure OpenAI deployment-style URLs are not supported** (`https://NAME.openai.azure.com/openai/deployments/DEPLOYMENT/chat/completions?api-version=…`). They need a `?api-version=` query string, which the address field rejects, and Azure's `api-key` header, while MyJournal sends `Authorization: Bearer <key>`. Put a gateway such as LiteLLM in front and use its OpenAI-style address instead.

### What is sent

`POST {base}/chat/completions` with `Content-Type: application/json`, `Accept: text/event-stream` and `Authorization: Bearer <key>` (only when there is a key). The body has `model`, `messages`, `stream: true`, `temperature`, a token limit and `stream_options: { include_usage: true }`.

**Token parameter, self-healing.** OpenAI's own API wants `max_completion_tokens`; most compatible servers want `max_tokens`. MyJournal sends `max_completion_tokens` to `api.openai.com` and `max_tokens` everywhere else. If a server answers 400 and the error text names the parameter, MyJournal flips it and retries. In the same way it drops `temperature` (some reasoning models accept only the default) or `stream_options` when the 400 names them. At most two such adaptations per request, and what worked is remembered per address and model until the server restarts, so you only ever pay for the first failed attempt.

**Reading the answer.** Text comes from `choices[0].delta.content`; `reasoning_content` / `reasoning` fields are ignored; `<think>…</think>` (and `<thinking>`, `<reasoning>`) blocks inside the text are stripped even when the tags are split across chunks. A server that returns one JSON document instead of a stream is read too. If the stream ends inside an unfinished `<think>` block with no answer, you get `empty` ("The model only produced hidden reasoning and no answer").

**Models list.** `GET {base}/models`, sorted alphabetically. `{ data: [...] }`, `{ models: [...] }` and a bare array are all understood.

## Local models

The **Local model** provider is the OpenAI-compatible adapter pointed at your own machine. No key is needed unless your server asks for one. It additionally sends `reasoning_effort: "none"`: verified against Ollama 0.40.1 and the llama.cpp server, which honour it (a qwen3 model answered in about 1.7 s instead of 8–14 s, with no token budget burnt on hidden reasoning) and ignore it for models that cannot think. A server that rejects the field with a 400 is healed by dropping it.

### Ollama

1. Install from <https://ollama.com/download>. Start it if your install did not (`ollama serve`).
2. `ollama pull llama3.2:3b` (about 2 GB), or press **Download model** in Settings → Local model. The button uses Ollama's own download API (`POST {root}/api/pull`, where *root* is your address without `/v1`), shows progress, and can be cancelled; Ollama resumes where it stopped. It works only with Ollama: for anything else the app answers `not_ollama`.
3. Address `http://localhost:11434/v1` (the **Ollama** preset; `http://localhost:11434` without `/v1` also works). Model `llama3.2:3b`.
4. Context: see [below](#context-windows-and-the-truncation-trap). `OLLAMA_CONTEXT_LENGTH=8192 ollama serve`.

Useful Ollama variables (read by Ollama, not by MyJournal): `OLLAMA_CONTEXT_LENGTH`, `OLLAMA_KEEP_ALIVE` (how long a model stays in memory, default 5 minutes: after it, the next reply pays the load time again), `OLLAMA_NUM_PARALLEL` and `OLLAMA_MAX_LOADED_MODELS` (lower them to save memory), `OLLAMA_HOST` (where it listens), `OLLAMA_MODELS` (where models are stored).

Download failures are explained in plain words: registry unreachable (`network`: check your connection and proxy settings *for Ollama*; offline, load a GGUF file with `ollama create`), unknown name (`model_not_found`), disk full, an Ollama that is too old for the model. A model that does not fit in memory shows "The model does not fit in this computer's memory"; choose a smaller one or a smaller context.

### llama.cpp

```bash
llama-server -m model.gguf --port 8080 -c 4096
```

Address `http://localhost:8080/v1` (the **llama.cpp** preset). Press **Load models**: `llama-server` lists the model under the full path of the GGUF file it was started with, and MyJournal shows the file name; pick it. `-c` is the context window in tokens; with MyJournal's default settings use 4096 or more. When a prompt is too big, `llama-server` answers with the real numbers ("request (6063 tokens) exceeds the available context size (4096 tokens)") and MyJournal passes them on in the hint.

### LM Studio

Load a model, start the local server from LM Studio's developer view (default port 1234) and use the **LM Studio** preset `http://localhost:1234/v1`. LM Studio has its own setting for the context length of each loaded model; keep it at 4096 or more. This path follows LM Studio's documentation; it was not run in the environment where the rest was verified.

### vLLM and others

`vllm serve <model> --max-model-len 4096` (default address `http://localhost:8000/v1`) and any other server with the OpenAI chat API work by typing their address under **Base URL**. Not run in the verification environment either. Remember that a key may be required (`--api-key` in vLLM): put it in the key field.

### Context windows and the truncation trap

Every model has a **context window**: the most text (in tokens) it can take in at once, your prompt plus its reply. Small local servers often start with a small one, and what happens when the prompt does not fit depends on the server. Observed against real servers:

- **Ollama 0.40.1** defaults to **4,096 tokens** on a typical machine without a big GPU (its help says the default is "4k/32k/256k based on VRAM"). When a prompt is longer than the window it **silently trims whole old messages** and keeps the system prompt and your latest message: the reply still arrives, but the model no longer knows about the earlier part of the conversation. That is the trap: nothing tells you. Only when your *latest message alone* does not fit does it answer with an error (`400 … request (7538 tokens) exceeds the available context size (4096 tokens), try increasing it`), which MyJournal shows as `context_too_long` with both numbers. Raise the window with `OLLAMA_CONTEXT_LENGTH` (it is capped at the model's own maximum).
- **llama.cpp's `llama-server`** refuses with that same explicit error whenever the prompt is larger than `-c`.
- Cloud APIs report it as an error too (`context_length_exceeded` and friends), also mapped to `context_too_long`.

MyJournal does its part with the **Context budget** setting (default 3,000, counted conservatively; real prompts measured about a quarter smaller, so a 3,000 budget sent roughly 2,300 real tokens). The budget decides what MyJournal sends; the server's window decides what it accepts. Rules of thumb, leaving room for the reply:

| Model's window | Context budget | Longest reply |
|---|---|---|
| 2,048 | about 1,500 | 300–500 |
| 4,096 (Ollama's usual default) | 3,000 (the default) | 700 (the default) |
| 8,192 | up to 6,000 | 700–1,000 |
| 32k and more (cloud models) | 8,000 or more | up to 2,000 |

Raise the server's window first, then the budget. On a CPU, long conversations also get slower: once an entry is longer than the budget, the oldest messages are dropped from the prompt, so the model has to read the changed prompt from the start on every new reply instead of reusing its cache.

### Small-model advice

- **Sizes.** 1B models (`llama3.2:1b`, about 1.3 GB, needs roughly 2 GB of memory) are for checking that everything is connected: they reply, but the conversation stays basic. 3B (`llama3.2:3b`, about 2 GB) is the sensible minimum for a pleasant chat; `qwen2.5:1.5b`, `gemma2:2b` and `smollm2:1.7b` sit in between. 7–8B models are noticeably more thoughtful and need 8 GB or more of free memory. A quantized model needs about its file size in memory plus room for the context.
- **Expectations.** Small models follow "one question, two to four sentences" well enough but can repeat themselves, miss nuance, answer in English to non-English writing, and produce odd titles or memory facts. The memory page exists so you can fix that: review it now and then.
- **Temperature.** 0.7 (default) is fine. If a small model rambles or drifts, try 0.4–0.6; the title and memory steps already use 0.2.
- **Speed.** On a CPU expect a couple of seconds to the first word and a few words per second afterwards for 1–3B models; a GPU is much faster. The first request after loading a model is the slowest.
- **Thinking models** (qwen3-style): MyJournal asks them not to think (`reasoning_effort: "none"`) and strips any `<think>…</think>` that still arrives. Servers that put the reasoning in a separate field (`reasoning_content`) are fine too.
- **Run it elsewhere.** The local provider works with any machine you can reach (`http://192.168.1.20:11434/v1`), but your journal text then crosses your network unencrypted.

### Smoke test with a real model

With Ollama running and a model pulled, start MyJournal and ask it to test the connection, exactly as the **Test connection** button does:

```bash
npm start &
curl -s -X POST http://127.0.0.1:3210/api/providers/test \
  -H 'X-MyJournal: 1' -H 'Content-Type: application/json' \
  -d '{"provider":"local","config":{"baseUrl":"http://localhost:11434/v1","model":"llama3.2:1b"}}'
# {"ok":true,"provider":"local","model":"llama3.2:1b","latencyMs":5118,"sample":"OK"}
```

A wrong model gives `{"ok":false,…,"error":{"code":"model_not_found",…}}`, a stopped server `network`. (If you set `JOURNAL_PASSWORD`, sign in first and send the cookie, or test from the app.)

## Troubleshooting: every error code

Each error in the app comes with a plain message and a hint. These are the codes, what they mean and what to do. The wording below is what MyJournal says (`{model}` and similar stand for your values).

| Code | What it means | What MyJournal says, and what to do |
|---|---|---|
| `auth` | The service did not accept the key, or wants one and has none. | OpenAI-compatible: "The API key was rejected." Check that the key is copied in full, belongs to this service, and has not been revoked. · "The service wants an API key, but none is set." Add the API key in Settings. · Local: "The local server wants an API key." Gemini: "Gemini rejected the API key." Copy a fresh key from aistudio.google.com/apikey and paste it in Settings (check for stray spaces). · "Gemini needs an API key." · "This Gemini API key has restrictions that block MyJournal." Create a key without application or IP restrictions. · "The Gemini API is not enabled for this key's Google project." Create a new key in AI Studio. · "The API key contains characters that cannot be sent in a request." Paste it again with no line breaks or fancy symbols. |
| `rate_limit` | Too many requests in a short time. | "The service is rate limiting requests." Too many requests. Try again in about N seconds. · Gemini: "Gemini's free-tier rate limit was reached." Wait about N seconds and try again. MyJournal already retried once if the wait was 8 seconds or less. |
| `quota` | Credit or the day's allowance is used up. | "The account is out of credit or quota." Check your plan and billing with the provider, or switch to another provider in Settings. · Gemini: "The free daily limit for this model is used up." / "This model has no free quota for your key." Try again tomorrow (free quotas reset daily), choose another model such as gemini-flash-lite-latest, or enable billing for your Google project. |
| `model_not_found` | The server does not know that model name. | "The model "X" was not found." OpenAI-compatible: use Load models in Settings to see which models this key can use. Local: download it with `ollama pull X` (or use Download model in Settings), or pick another model. · Gemini: "Gemini has no model called "X" for this API." Open Settings and use Load models. · "Gemini has retired "X"." Google suggests another model: pick one from Load models. |
| `bad_base_url` | The address is wrong or does not lead to an AI API. | "The server did not recognise that address." The base URL normally ends in /v1 (Ollama: http://localhost:11434/v1); check it in Settings. · "The address answered with a web page, not an AI API." · "The address answered, but not like an AI API." · "The server redirected the request somewhere else." Use the final address as the base URL (for example https:// instead of http://). · "The server address is not valid." / "No server address is set." / "Only http:// and https:// addresses are supported." The first one also appears for a port that Node's `fetch` refuses (a fixed list that browsers block as well, for example 6000): run the server on another port. |
| `network` | MyJournal could not reach the server. | Local: "Could not connect to the local model server." Is Ollama running? Start it with `ollama serve` (or start llama-server / the LM Studio local server), then check the address in Settings. · "Could not find the server." Check the address for typos and that you are online. · "The server's security certificate was not accepted." Use plain http:// on a trusted network, or add your CA via NODE_EXTRA_CA_CERTS. · "The connection to the server was closed unexpectedly." (a local server may have crashed or run out of memory loading the model; check its terminal). · Behind a company proxy see [the README](../README.md#a-free-gemini-key). |
| `timeout` | No first word within the wait time, or silence in the middle of a reply. | Local: "The first request after starting a model loads it into memory, which can take a while, and giving up cancels that load. Raise the timeout in Settings (Settings > General), then try again." Retrying at once restarts the load, so raise the timeout first. · Cloud: "Try again in a moment, or raise the timeout in Settings." · "…stopped responding in the middle of the reply": the machine may be overloaded; try again or use a smaller model. |
| `blocked` | The model or its safety filter declined to answer. | "The model declined to answer this one." Journaling about hard things can trip safety filters; rephrase, or switch provider in Settings. · "Gemini declined to answer this one." |
| `context_too_long` | The conversation does not fit the model's window. | "This conversation is too long for the model." Shorten the entry, lower the context budget in Settings, or choose a model with a longer window. Local: raise the model's context size (Ollama: set OLLAMA_CONTEXT_LENGTH, e.g. 8192, and restart it; llama.cpp: --ctx-size). When the server reports both numbers, the hint says "The prompt needs about 6063 tokens but the model's context window holds 4096." |
| `bad_request` | The server refused the request itself. | "The server rejected the request (HTTP 400)." Check the model name and settings; a different model may accept it. The server's own words are appended. · "There is nothing to reply to yet." Write something first, then ask for a reply. |
| `server` | The model server had an internal problem. | "The model server had an internal problem (HTTP 500)." Cloud: try again in a moment; if it keeps failing, check the provider's status page. Local: check the terminal where your model server runs. · "The server may still be loading the model. Wait a few seconds and try again." (503) · "The model does not fit in this computer's memory." Choose a smaller model (llama3.2:1b needs about 2 GB), or lower the context size (Ollama: OLLAMA_CONTEXT_LENGTH=4096, fewer OLLAMA_NUM_PARALLEL), close other programs. · "Gemini had an internal problem." · Ollama download: "ran out of disk space" / "needs a newer version of Ollama". |
| `overloaded` | The service is busy. | "Gemini is overloaded right now." This is usually brief. Try again in a moment, or switch to gemini-flash-lite-latest in Settings (if you are on a Lite model: pick another model with Load models). Common with `gemini-flash-latest`. |
| `region` | The service is not available where you are. | "This service is not available in your region." Choose another provider (or a local model) in Settings. · "Gemini is not available in your region." The free tier is not offered everywhere. Enable billing for your Google project, or choose another provider. |
| `empty` | The model answered with no text. | "The model returned an empty reply." Try again; very small models sometimes return nothing (try a different model). · "The model only produced hidden reasoning and no answer." The model spent its whole token budget thinking: raise max tokens or use a non-reasoning model. · "The reply was cut off before any text appeared." · Gemini: "Gemini used its whole token budget thinking and wrote no answer." Raise max tokens in Settings, or set Gemini thinking to "low". |
| `unknown` | Anything else (an unexpected HTTP status). | "The server answered with an unexpected status." Check the server and the address. |

Other things you may meet around the AI:

- **`409 ai_not_configured` / `ai_disabled`.** No usable model yet, or the AI is switched off in Settings → General. Your writing is saved either way.
- **`409 generation_in_progress`.** A reply is already being written in that entry. Wait, or press Stop.
- **`422 not_enough_entries`** (weekly reflection). No non-private entries in the period.
- **`409 not_ollama`** (Download model). The address is not an Ollama server; load the model in llama.cpp or LM Studio yourself.
