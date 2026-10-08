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
- [Tested with](#tested-with): [Gemini](#gemini-2026-10-08) · [Ollama and llama.cpp](#ollama-and-llamacpp-2026-10-08) · [how well small models follow the rules](#how-well-small-models-follow-the-rules) · [not tested](#not-tested)
- [Troubleshooting: every error code](#troubleshooting-every-error-code)

## How a model is used

Everything below applies to all three providers.

**What is asked of the model.** Journal replies, the wrap-up reflection and the weekly reflection are streamed, so text appears as it is written. Two small helper calls, the title/summary/feelings/tags step and the memory step, are not streamed; they use a fixed low temperature (0.2) and a short answer cap (160 tokens). Wrap-up runs its three calls one after another, never in parallel, to stay inside free-tier rate limits. The title and memory steps are best effort: if one fails, the entry is still wrapped up and you get a toast saying what was skipped.

**Prompts for small models.** System prompts are short and imperative (one task per call, exactly one question per reply), and they were tuned against real models, not guessed:

- The title and memory steps ask for labelled plain-text lines (`Title: …`, `- fact`), never JSON, and show the format with placeholders (`Title: <2 to 6 words>`) instead of an example, because a 1B model copies an example word for word (llama3.2:1b copied it in 15 of 17 entries before the change, in 0 of 17 after). The parsers tolerate sloppy output, refuse a copied example or placeholder, and fall back to something sensible (for example the first words of your entry as a title).
- The closing reflection is asked for in the user's voice ("write your closing reflection to me, speaking as my companion and addressing me as you"), which is what turns "As I close this entry, I feel…" into a reflection about *you*. The weekly reflection is started for the model the same way.
- When the language of your writing is clear, the prompt names it ("Write in Spanish, the language the user writes in."): English, Spanish, French, German, Portuguese, Italian and Dutch are recognised by their common words, Japanese, Chinese and Korean by their script. For short or unclear text, or other scripts, it says "the language the user writes in" instead.
- What you told the app about yourself (name, *About you*, memories, earlier entries) is labelled as **background**, with a rule to mention it only when it directly relates and never as something you said today. This stopped Gemini Flash-Lite from bringing a profile cat into unrelated replies (5 of 17 replies before, 0 of 26 after); small local models improved less (see [below](#how-well-small-models-follow-the-rules)).

**Your settings that reach the model** (Settings → General): *Creativity* (temperature, default 0.7), *Longest reply* (max tokens, default 700), *Context budget* (default 3,000 tokens: how much conversation and memory is sent; counted conservatively as characters ÷ 3.5; measured with Llama 3.2 on English text, that over-counts the real number by roughly a quarter to a third) and *Wait for the first word* (default 180 s, the same for every provider). When the conversation outgrows the budget, MyJournal gives up, in this order: related past entries, then memories (unpinned first), then the oldest messages; only after that does it switch to a shorter system prompt, and as a last resort it cuts the middle out of your latest message. For a local model the oldest messages go in blocks of up to 8 rather than one per reply, so the server's cache of the prompt stays valid (see [below](#context-windows-and-the-truncation-trap)); hosted providers lose one at a time. Your entry itself is never shortened, only what is sent.

**Timeouts and retries.** Two timers protect you from hangs: the *first-byte* timeout (*Wait for the first word*, default 180 s) and a 60-second silence limit between chunks once text is flowing; either one produces a `timeout` error. A timeout above 300 seconds cannot work, because of Node's own limit for response headers (measured: `fetch` against a server that never answers fails after 300.9 s with `UND_ERR_HEADERS_TIMEOUT`), so the setting's upper limit of 600 s is, in effect, 300 s. One automatic retry happens for a `429` or `503` whose suggested wait is 8 seconds or less (one second when none is given), never after any text has been received, and **not when the failed attempt itself took longer than 8 seconds**: Gemini sometimes answers a 503 only after 15 s of waiting, a second try then never helped (0 of 3 pairs observed), and retrying would double the wait before you see the error. **Test connection** waits at most 90 seconds for Gemini and OpenAI-compatible services, but a **local model** gets your full timeout (up to 300 s), because its first request has to load the model and giving up cancels the load. **Load models** gives up after 20 seconds.

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
| `gemini-flash-lite-latest` (→ `gemini-3.5-flash-lite`) | 0.4–1.4 s (one 13 s outlier) | 0 / about 465 | does not think by default; best free quota |
| `gemini-3.5-flash` | 4.0–4.5 s (2.1–2.9 s with `low`) | about 810 / about 350 | |
| `gemini-flash-latest` (→ `gemini-3.8-flash`) | all 6 default-mode requests answered `503` after 1–15 s; the one `low` request that worked took 23 s | 69–286 on `low` | "smarter" but busy: the whole reply arrives in one burst |
| `gemma-4-26b-a4b-it` | about 7 s (one sample) | about 290 | rejects any `thinkingLevel` |
| `gemini-2.5-flash-lite` | 1.6 s | 0 | rejects `thinkingLevel` |

Raw responses are in `test/fixtures/gemini-live/` (see its README). Treat the numbers as a snapshot: Google changes what the `-latest` aliases point to, and load varies by hour. That is why Flash-Lite is the default and **Flash** (`gemini-flash-latest`) is offered as "Smarter, can be slow or busy". The suggested models in the app are `gemini-flash-lite-latest`, `gemini-flash-latest`, `gemini-3.5-flash-lite` and `gemini-3.5-flash`.

**Load models** lists what your key can use. The raw list from Google has 62 entries on one page, including many that cannot chat (`*-tts`, `*-image*`, `lyria-*`, `deep-research-*`, embeddings, robotics, computer-use …) and some chat models that have been **retired but are still listed** (`gemini-2.5-flash` answers `404 "no longer available to new users"`). MyJournal keeps ids starting with `gemini-` or `gemma-`, drops the non-chat families, requires `generateContent` support, and sorts `-latest` aliases first, then newest first, with Gemma last. A retired model that slips through is caught when you use it: the error says *Gemini has retired "…"* and quotes Google's own suggestion ("Google suggests gemini-3.8-flash — pick a model from Load models in Settings").

### Thinking

Newer Gemini models may "think" before answering, and **thinking tokens count against the reply's token cap**. Live, 189 of a 200-token cap were spent thinking and the reply was cut off. So MyJournal always asks for room for the answer: `maxOutputTokens` = your *Longest reply* + 2,048 (at most 8,192). Reply length is steered by the prompt, not by that cap.

The **Thinking** option (Settings → Gemini → Advanced) has two values:

- **Auto (recommended)**: no thinking setting is sent; the model decides.
- **Low - less thinking**: sends `thinkingLevel: "low"`. It helps Flash models that think before answering (`gemini-3.5-flash` and up: first word after 2.1–2.9 s instead of 4.0–4.5 s). If a model answers 400 about thinking, MyJournal drops the setting and remembers that for that model while it runs. **On the default Flash-Lite, Low turns thinking *on* and is slower, not faster** (about 465 thought tokens, 2.3 s to the first word instead of 0.9 s), so leave it on Auto there. The app's hint under the option says the same.

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
| overload: 503 `UNAVAILABLE` "currently experiencing high demand" (after anything from 1 to 20+ seconds) | `overloaded`; retried once if it arrived within 8 s, shown at once if it took longer |

A rate-limit answer (`429 RESOURCE_EXHAUSTED` with a retry delay) could not be provoked during verification, so that mapping follows Google's documented error format rather than a live capture: a per-minute limit becomes `rate_limit` with the wait Google asked for; a per-day limit, or a model whose free quota is `limit: 0`, becomes `quota`.

**Free-tier limits differ by model and change over time.** Check your current limits in AI Studio; MyJournal never hard-codes numbers. **Availability by region** also varies: where the free tier is not offered, Google answers with a location error and MyJournal shows the `region` message. **Privacy:** on the free tier Google may use your prompts and responses to improve its products and humans may review them; billing-enabled projects are not used that way. Do not journal secrets with a free key, and check Google's current terms for your country.

Gemini can also refuse a prompt for safety reasons (journaling about hard things can trip the filters). That arrives as `blocked`; rephrase or use another provider.

## OpenAI-compatible APIs

### Setup

**Settings → OpenAI-compatible**: key, base URL (presets for OpenAI `https://api.openai.com/v1`, OpenRouter `https://openrouter.ai/api/v1`, Groq `https://api.groq.com/openai/v1`, Together `https://api.together.xyz/v1`), model name (**Load models** lists what the key can use). Or `OPENAI_API_KEY` and `OPENAI_BASE_URL` in the environment (the base URL only seeds a **fresh install**: one with no settings saved yet; after the first Save it never overrides what Settings holds). Anything that serves `POST {base}/chat/completions` with streaming and `GET {base}/models` works.

**Not tested against the real services.** The environment where this was verified had no network access to OpenAI, OpenRouter, Groq or Together. The adapter is tested against mock servers and responses recorded from real Ollama and llama.cpp servers (which speak the same wire format); everything specific to the commercial endpoints (the `max_completion_tokens` parameter, their error bodies and rate limits, their model lists) follows their documentation and is unverified. See [Tested with](#tested-with).

### Addresses

Type the full address, including `http://` or `https://`. You can be loose about the end: trailing slashes are removed, a pasted `/chat/completions` is cut off, and a bare `https://api.openai.com` (or a bare local address such as `http://localhost:11434`) gets `/v1`. Settings refuses addresses with a username or password, a `?query` or a `#fragment`, or a scheme other than http(s): keys must never travel in URLs.

**Azure OpenAI deployment-style URLs are not supported** (`https://NAME.openai.azure.com/openai/deployments/DEPLOYMENT/chat/completions?api-version=…`). They need a `?api-version=` query string, which the address field rejects, and Azure's `api-key` header, while MyJournal sends `Authorization: Bearer <key>`. Put a gateway such as LiteLLM in front and use its OpenAI-style address instead.

### What is sent

`POST {base}/chat/completions` with `Content-Type: application/json`, `Accept: text/event-stream` and `Authorization: Bearer <key>` (only when there is a key). The body has `model`, `messages`, `stream: true`, `temperature`, a token limit and `stream_options: { include_usage: true }`.

**Token parameter, self-healing.** OpenAI's own API wants `max_completion_tokens`; most compatible servers want `max_tokens`. MyJournal sends `max_completion_tokens` to `api.openai.com` and `max_tokens` everywhere else. If a server answers 400 and the error text names the parameter, MyJournal flips it and retries. In the same way it drops `temperature` (some reasoning models accept only the default) or `stream_options` when the 400 names them. At most two such adaptations per request, and what worked is remembered per address and model until the server restarts, so you only ever pay for the first failed attempt.

**Reading the answer.** Text comes from `choices[0].delta.content`; `reasoning_content` / `reasoning` fields are ignored; `<think>…</think>` (and `<thinking>`, `<reasoning>`) blocks inside the text are stripped even when the tags are split across chunks. A server that returns one JSON document instead of a stream is read too. If the stream ends inside an unfinished `<think>` block with no answer, you get `empty` ("The model only produced hidden reasoning and no answer").

**Models list.** `GET {base}/models`, sorted alphabetically. `{ data: [...] }`, `{ models: [...] }` and a bare array are all understood.

## Local models

The **Local model** provider is the OpenAI-compatible adapter pointed at your own machine. No key is needed unless your server asks for one. It additionally sends `reasoning_effort: "none"`: verified against Ollama 0.40.1 and the llama.cpp server, which honour it (a qwen3:1.7b journal reply took 3.7–4.7 s with thinking off against 8–14 s with it on, with no token budget burnt on hidden reasoning) and ignore it for models that cannot think. A server that rejects the field with a 400 is healed by dropping it.

### Ollama

1. Install from <https://ollama.com/download>. Start it if your install did not (`ollama serve`).
2. `ollama pull llama3.2:3b` (about 2 GB), or press **Download model** in Settings → Local model. The button uses Ollama's own download API (`POST {root}/api/pull`, where *root* is your address without `/v1`), shows progress, and can be cancelled; Ollama resumes where it stopped. It works only with Ollama: for anything else the app answers `not_ollama`. When the model named in the field is already in the list your server reports (exact name, or a name without a tag meaning `:latest`), the button reads **Already installed** and does nothing, because Ollama contacts its registry even for models it already has, which fails offline for no reason. To update a model, run `ollama pull` in a terminal.
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

- **Ollama 0.40.1** defaults to **4,096 tokens** on a machine without a big GPU (measured on a CPU-only machine: the server log says `vram-based default context total_vram=0 B default_num_ctx=4096`; its help says the default is "4k/32k/256k based on VRAM"). When a prompt is longer than the window it **silently trims whole old messages** and keeps the system prompt and your latest message: the reply still arrives, but the model no longer knows about the earlier part of the conversation. That is the trap: nothing tells you. Only when your *latest message alone* does not fit does it answer with an error (`400 … request (7538 tokens) exceeds the available context size (4096 tokens), try increasing it`), which MyJournal shows as `context_too_long` with both numbers. Raise the window with `OLLAMA_CONTEXT_LENGTH` (it is capped at the model's own maximum; 8,192 made llama3.2:1b use 2.17 GB instead of 1.95 GB).
- **llama.cpp's `llama-server`** refuses with that same explicit error whenever the prompt is larger than `-c`.
- Cloud APIs report it as an error too (`context_length_exceeded` and friends), also mapped to `context_too_long`.

MyJournal does its part with the **Context budget** setting (default 3,000, counted conservatively; real prompts measured about a quarter smaller, so a 3,000 budget sent roughly 2,300 real tokens). The budget decides what MyJournal sends; the server's window decides what it accepts. Measured on Ollama's 4,096 window: the default budget (3,000) with the default reply cap (700) never overflowed (the largest real prompt in 21 replies was 2,278 tokens, none was cut), while a budget of 6,000 made Ollama trim silently and a llama3.2:1b reply took 30 s instead of 4.7 s. Rules of thumb, leaving room for the reply:

| Model's window | Context budget | Longest reply |
|---|---|---|
| 2,048 | about 1,500 | 300–500 |
| 4,096 (Ollama's usual default) | 3,000 (the default) | 700 (the default) |
| 8,192 | up to 6,000 | 700–1,000 |
| 32k and more (cloud models) | 8,000 or more | up to 2,000 |

Raise the server's window first, then the budget.

**Long conversations on a CPU.** Ollama and llama.cpp keep the processed start of the prompt and compute only what is new (prompt processing ran at 150–420 tokens/s on 4 cores, so a 2,200-token prompt that is not cached costs 11–16 s before the first word). Once an entry is longer than the budget, the oldest messages have to be left out, and if that moved the start of the history by one message on every reply, the server would re-read everything every time. So for local providers MyJournal drops old messages in **blocks** counted from the start of the conversation (8 at a time when that costs at most 40% of what fits, otherwise 4 or 2): the same first message is sent for several replies in a row and the cached prefix survives. Measured on llama3.2:1b with a 30-turn conversation and a 3,000 budget, once the budget was full: median reply **2.7 s and 2.8 s, with 76% of the prompt reused**, against 8.8 s and 9.8 s with 14% reused when one message was dropped per reply. The budget is still honoured and your latest message is never dropped; the first reply after a block boundary is the slow one. (Hosted providers do not cache this way and lose one message at a time.)

### Small-model advice

The evidence behind every line here is under [Tested with](#how-well-small-models-follow-the-rules).

- **Sizes.** A model of about **360M** parameters (`smollm2:360m`, 271 MB file, 0.5 GB of memory) is for checking that everything is connected, nothing more: it writes 200-word answers to a "two to four sentences" rule, loops, and invents details. A **1B** model (`llama3.2:1b`, 1.3 GB file, 1.9 GB of memory) replies sensibly but stays basic. **1.7B** (`qwen3:1.7b`, about 1.1 GB file, 1.8 GB of memory) was the best of the three we ran and is fine for journaling. **3B and up** (`llama3.2:3b`, about 2 GB, is the default) is what we recommend for a pleasant conversation, but we did not run a model of that size: it is a judgement from the trend above. 7–8B models should be noticeably more thoughtful and need 8 GB or more of free memory (also not run). A quantized model needs about its file size in memory plus room for the context.
- **Which model?** The app's picker offers `llama3.2:1b`, `qwen2.5:1.5b`, `gemma2:2b`, `llama3.2:3b` and `smollm2:1.7b`; any other model your server has works if you type its name (`qwen3:1.7b` is not in the picker but is the one we measured). For quality without running anything yourself, Gemini Flash-Lite was the reference in every comparison. For privacy, the largest model your computer runs comfortably.
- **Expectations.** Small models follow "one question, two to four sentences" less reliably than big ones (llama3.2:1b: exactly one closing question in 75% of replies; qwen3:1.7b 92%; Gemini Flash-Lite 100% of 26), can repeat themselves, miss nuance, bring up things from your profile that do not belong (llama3.2:1b in about 1 unrelated reply in 6), and produce odd titles or memory facts.
- **Memory suggestions are the weakest step.** After a wrap-up, llama3.2:1b stored mostly junk (1 valid fact among 5 stored), qwen3:1.7b 4 valid among 4 on a small test, Gemini 8 of 8. The parser already throws away copied examples, things you are doing right now, one-off events and sentences lifted from your entry, but a 1B model still gets through. Look at the Memory page now and then, or switch off *Suggest memories when I wrap up an entry* there for models under about 3B.
- **Other languages.** Spanish, French and Japanese entries were answered in the same language in 100% of the checks on llama3.2:1b and qwen3:1.7b, and the closing reflection and weekly reflection are asked for in that language. German, Portuguese and Italian were only spot-checked (29 of 32), Dutch, Chinese and Korean were never run through a model, and their wording was not reviewed by a native speaker.
- **Temperature.** 0.7 (default) is fine. If a small model rambles or drifts, try 0.4–0.6; the title and memory steps already use 0.2.
- **Speed.** Measured on 4 CPU cores: 44 tokens/s for the 360M model, 26 for llama3.2:1b, 13 for qwen3:1.7b; a journal reply takes 2.6–3.6 s (llama3.2:1b) or 3.7–4.7 s (qwen3:1.7b) once the model is loaded, and the first byte of a warm reply arrives within 26–90 ms. A GPU is much faster. The first request after loading a model is the slowest (1 to 7 s to load these models).
- **Thinking models** (qwen3-style): MyJournal asks them not to think (`reasoning_effort: "none"`) and strips any `<think>…</think>` that still arrives. Servers that put the reasoning in a separate field (`reasoning_content`) are fine too.
- **Run it elsewhere.** The local provider works with any machine you can reach (`http://192.168.1.20:11434/v1`), but your journal text then crosses your network unencrypted.

### Smoke test with a real model

With Ollama running and a model pulled, start MyJournal and ask it to test the connection, exactly as the **Test connection** button does:

```bash
npm start &
curl -s -X POST http://127.0.0.1:3210/api/providers/test \
  -H 'X-MyJournal: 1' -H 'Content-Type: application/json' \
  -d '{"provider":"local","config":{"baseUrl":"http://localhost:11434/v1","model":"llama3.2:1b"}}'
# {"ok":true,"provider":"local","model":"llama3.2:1b","latencyMs":4356,"sample":"OK"}
```

A wrong model gives `{"ok":false,…,"error":{"code":"model_not_found",…}}`, a stopped server `network`. (If you set `JOURNAL_PASSWORD`, sign in first and send the cookie, or test from the app.)

## Tested with

What was really run, on what, and what was not. Dates are 2026-10-08. The numbers are measurements from one machine and one day: treat them as orders of magnitude, not guarantees.

### Gemini (2026-10-08)

The real Gemini API with a free-tier AI Studio key: more than 200 requests, from the adapter on its own, from the whole app over HTTP (free writing, three guided sessions, wrap-up, weekly reflection, regenerate, abort, private entries, a crisis text) and from the browser UI on desktop and phone sizes. No `429` came up in any of them.

| What | Result |
|---|---|
| Default model `gemini-flash-lite-latest` (= `gemini-3.5-flash-lite`) | first word in 0.4–1.4 s (one 13 s outlier), no thinking by default; 29 app replies averaged 50 words (29–66), 2–4 sentences, 27 of 29 with exactly one question that ends the reply, no lists or leaked instructions |
| Wrap-up (reflection, then title/summary, then memory) | about 3–3.6 s in total |
| Weekly reflection over 11 entries | 1.9 s, 199 words, the four bold lead-ins |
| Streaming | a short reply arrives as 3–5 frames within 150–400 ms, so the UI types the text out progressively instead of showing it in a burst |
| Other models | the table under [Models](#models): `gemini-3.5-flash` 4.0–4.5 s and about 810 thought tokens; `gemini-flash-latest` 503 on all 6 normal requests |
| Errors seen for real | invalid key (HTTP 400), missing key (403), unknown model (404), retired model (404, with Google's suggested replacement), overload (503, after 1–15 s each); all mapped as in the [table](#troubleshooting-every-error-code) |
| Not seen | a `429` (rate limit or daily quota): its mapping follows Google's documented error format and mock tests only |

The raw responses are in `test/fixtures/gemini-live/`.

### Ollama and llama.cpp (2026-10-08)

| | |
|---|---|
| Machine | Linux x86-64, 4 CPU cores, 16 GB of RAM, no GPU |
| Ollama | 0.40.1, the official `ollama/ollama` image, extracted and run natively |
| llama.cpp | `llama-server` 0.5.0-dev (build 1, commit 631109b34), the one bundled in that image |
| Models | `smollm2:360m` (SmolLM2-360M-Instruct Q4_K_M), `llama3.2:1b` (Llama 3.2 1B Instruct Q8_0), `qwen3:1.7b` (Qwen3-1.7B Q4_K_M), taken as GGUF files from Docker Hub (`ai/*`, sha256 verified) and imported with `ollama create` |
| Not run | `ollama pull` and a real model download: the Ollama registry was unreachable from that machine (the app's error path for it was exercised: the message appears in 0.4 s). A registry build of the same model may differ in chat template or quantisation. |

What was driven against these servers: the adapter (model list, test, streaming with usage, abort mid-stream and before the first byte, a too-short timeout while a model loads, a wrong port, URL forms, `<think>` blocks and `reasoning` / `reasoning_content` fields, an answer that is only hidden reasoning), the whole app (three-turn free writing, two guided sessions, wrap-up, weekly reflection, regenerate, stop) on all three models and on llama.cpp, and the Settings screens in a browser. Raw responses (85 from Ollama, 39 from llama.cpp) are in `test/fixtures/ollama-live` and `test/fixtures/llamacpp-live`.

| Model (file) | Memory in use | Decode speed, median (range) | Cold start | A journal reply, model warm | Thinking |
|---|---|---|---|---|---|
| `smollm2:360m` (271 MB) | 0.5 GB | 43.5 tokens/s (11–56) | 1.1 s | 7–8 s (it writes 200+ words) | none |
| `llama3.2:1b` Q8_0 (1.3 GB) | 1.9 GB | 26.0 tokens/s (14–34) | 4.7 s (6.7 s the first time from disk) | 2.6–3.6 s | none |
| `qwen3:1.7b` Q4_K_M (1.1 GB) | 1.8 GB | 13.1 tokens/s (6.8–16.6) | 3.9 s | 3.7–4.7 s with thinking off, 8–14 s with it on | switched off by MyJournal |

(Memory is the resident size of the model runner with the model loaded at a 4,096-token window; `ollama serve` itself uses 42 MB. Cold start is the time to load a model whose file is in the operating system's cache.)

Facts about the servers that the app relies on:

- **Default window.** Ollama 0.40.1 on this CPU-only machine used 4,096 tokens (`vram-based default context total_vram=0 B default_num_ctx=4096`; `/api/ps` agreed). `OLLAMA_CONTEXT_LENGTH` is capped at the model's own maximum (8,192 for smollm2).
- **Prompt cache.** Both servers reuse the processed start of the prompt: a warm repeat of a conversation's start costs milliseconds, an uncached 2,200-token prompt 11–16 s on llama3.2:1b (150–420 tokens/s) and a 3,850-token one 22–23 s on qwen3:1.7b (about 200 tokens/s). That is why local prompts are trimmed in blocks (see [above](#context-windows-and-the-truncation-trap)).
- **Budget that fits.** The default (budget 3,000, reply cap 700) fits the 4,096 window: across 21 replies the largest real prompt was 2,278 tokens (estimate 2,998) and none was cut by the server. Budget 6,000 on 4,096: Ollama trimmed old messages and a llama3.2:1b reply slowed from 4.7 s to 30 s.
- **Aborts.** A browser that stops mid-stream, or during prompt processing, stops the model at once (CPU back to 0%, the next request starts in 0.15–0.4 s). Disconnecting while the model is still loading cancels the load: a retry after a too-short timeout starts it over.
- **llama.cpp specifics.** `llama-server` accepts any model name in a request and lists its one model under the full path of the GGUF file (MyJournal shows the file name); `GET /health` tells whether it is up; it answers reasoning in `reasoning_content` (or inline `<think>` with `--reasoning-format none`), both handled; `--api-key` makes it answer `401`. It announced that its default port will change in a future release (to 9931), which is why the commands in this guide pass `--port 8080` explicitly.
- **Errors.** A prompt longer than the window gives Ollama's nested JSON error or llama.cpp's `exceed_context_size_error`, both with the two numbers; both are mapped to `context_too_long`. A closed port gives `network` ("Could not connect to the local model server"); a wrong model name `model_not_found` with the `ollama pull` hint.

### How well small models follow the rules

17 fictional test conversations (8 English, 2 Spanish, 1 French, 1 Japanese, an "ok", an emoji-only message and 3 guided sessions), 5 replies each, so 85 replies per local model, run through the real models after the prompts had been tuned on this same set (so the numbers flatter the prompts somewhat, and 17 conversations is a small sample: read the counts as a rough ordering). The set is not part of the repository. Gemini Flash-Lite got 26 replies (17 conversations plus 9 repeats).

| Replies | `smollm2:360m` (17) | `llama3.2:1b` (85) | `qwen3:1.7b` (85) | Gemini Flash-Lite (26) |
|---|---|---|---|---|
| 2 to 4 sentences | 6 | 68 | 79 | 26 |
| exactly one question, and it ends the reply | 4 | 64 | 78 | 26 |
| stays in the language of the entry | 15 | 84 | 85 | 26 |
| mentions the profile's cat in a reply about something else | 1 | 15 | 0 | 0 |
| any leak of profile, memory or earlier-entry text | 3 | 17 | 0 | 0 |

| Other steps | `smollm2:360m` | `llama3.2:1b` | `qwen3:1.7b` | Gemini Flash-Lite |
|---|---|---|---|---|
| Closing reflection written *to* you, not as you (read by hand) | 13 of 22 | 22 of 22 | 22 of 22 | 14 of 14 |
| Closing reflection 3–5 sentences | 10 of 23 | 22 of 23 | 22 of 23 | 16 of 16 |
| Title, summary, feelings and tags parsed without a fallback | 9 of 17 | 17 of 17 | 17 of 17 | 7 of 7 |
| Valid facts among those stored by the memory step (read by hand) | 0 of 2 | 1 of 5 | 4 of 4 | 8 of 8 |
| Weekly reflection with the right structure (3 or 4 paragraphs, 3+ bold lead-ins) | 0 of 3 | 3 of 3 | 3 of 3 | 2 of 2 |

How the prompt changes moved these numbers (the same models, before and after): llama3.2:1b copied the format example in 15 of 17 meta calls and wrote 9 of 22 closing reflections in the wrong voice (read by hand), before; 0 and 0 after. qwen3:1.7b answered Spanish, French and Japanese entries in English 15 times in 85 before and 0 after. Gemini Flash-Lite brought the profile's cat into 5 of 17 unrelated replies before and 0 of 26 after. The cost: small models end with exactly one question a little less often than before (qwen3:1.7b 83 to 78 of 85; llama3.2:1b 67 to 64).

What a reply looks like (fictional entries, trimmed):

- Gemini Flash-Lite: *"That sounds like such a warm connection, especially with her visit coming up next month. It feels like hearing her voice brought right back that light, easy kind of joy. What was the thorn, or the part that drained you today, Sam?"*
- `llama3.2:1b`: *"It's nice that you have a supportive sister in Maya, and talking about your feelings with her can be really helpful in shifting perspective. Do you think you'll be able to plan a trip to Lisbon for your sister's visit, or will something else get in the way?"*
- `qwen3:1.7b`, thinking off: *"It's okay to feel nervous, especially when presenting important information. You're not alone in that. What's the one thing that made you feel most nervous today?"*
- `smollm2:360m`: a 232-word answer that opens "I'm so sorry to hear about your tough day at work, Alex…" and invents details; its closing reflection once repeated the same paragraph three times until it hit the token cap.

### Not tested

- **The OpenAI API and compatible services** (OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral): no network access from the development machine. Mock servers and the documentation only. Anything specific to one of them (error bodies, rate limits, the `max_completion_tokens` switch, model lists) may differ.
- **LM Studio and vLLM:** documentation only.
- **A Gemini `429`:** never provoked (see above).
- **Models of 3B and up, and anything on a GPU.**
- **The Ollama registry** (`ollama pull`, a real model download), **Docker** (`docker build`, `docker compose up`, the `ollama` and `ollama-pull` services: the compose file is checked with `docker compose config`, the Dockerfile with a linter, and the container's start and health-check commands were run natively), **nginx and Caddy** snippets.
- **Other browsers, devices and systems:** Chromium on Linux only. Not Firefox, Safari, a real phone (its on-screen keyboard handling is checked with a simulated one), macOS or Windows.

## Troubleshooting: every error code

Each error in the app comes with a plain message and a hint. Under a failed reply the banner offers **Try again** and, for every code where changing a setting is the likely fix (all but `rate_limit`, `bad_request` and `unknown`), **Open settings**, which lands on the tab of the provider that failed. These are the codes, what they mean and what to do. The wording below is what MyJournal says (`{model}` and similar stand for your values).

| Code | What it means | What MyJournal says, and what to do |
|---|---|---|
| `auth` | The service did not accept the key, or wants one and has none. | OpenAI-compatible: "The API key was rejected." Check that the key is copied in full, belongs to this service, and has not been revoked. · "The service wants an API key, but none is set." Add the API key in Settings. · Local: "The local server wants an API key." Gemini: "Gemini rejected the API key." Copy a fresh key from aistudio.google.com/apikey and paste it in Settings (check for stray spaces). · "Gemini needs an API key." · "This Gemini API key has restrictions that block MyJournal." Create a key without application or IP restrictions. · "The Gemini API is not enabled for this key's Google project." Create a new key in AI Studio. · "The API key contains characters that cannot be sent in a request." Paste it again with no line breaks or fancy symbols. |
| `rate_limit` | Too many requests in a short time. | "The service is rate limiting requests." Too many requests. Try again in about N seconds. · Gemini: "Gemini's free-tier rate limit was reached." Wait about N seconds and try again. MyJournal already retried once if the wait was 8 seconds or less. |
| `quota` | Credit or the day's allowance is used up. | "The account is out of credit or quota." Check your plan and billing with the provider, or switch to another provider in Settings. · Gemini: "The free daily limit for this model is used up." / "This model has no free quota for your key." Try again tomorrow (free quotas reset daily), choose another model such as gemini-flash-lite-latest, or enable billing for your Google project. |
| `model_not_found` | The server does not know that model name. | "The model "X" was not found." OpenAI-compatible: use Load models in Settings to see which models this key can use. Local: download it with `ollama pull X` (or use Download model in Settings), or pick another model. · Gemini: "Gemini has no model called "X" for this API." Open Settings and use Load models. · "Gemini has retired "X"." Google suggests another model: pick one from Load models. |
| `bad_base_url` | The address is wrong or does not lead to an AI API. | "The server did not recognise that address." The base URL normally ends in /v1 (Ollama: http://localhost:11434/v1); check it in Settings. · "The address answered with a web page, not an AI API." · "The address answered, but not like an AI API." · "The server redirected the request somewhere else." Use the final address as the base URL (for example https:// instead of http://). · "The server address is not valid." / "No server address is set." / "Only http:// and https:// addresses are supported." · "That port is blocked." Node's `fetch`, like web browsers, refuses a fixed list of ports (1, 7, 9, 6000, 6665–6669, 10080 and others) without even trying to connect; the hint names the port in your address ("…and port 6000 is on it. Start the model server on another port, then change the address in Settings."). |
| `network` | MyJournal could not reach the server. | Local: "Could not connect to the local model server." Is Ollama running? Start it with `ollama serve` (or start llama-server / the LM Studio local server), then check the address in Settings. · "Could not find the server." Check the address for typos and that you are online. · "The server's security certificate was not accepted." Use plain http:// on a trusted network, or add your CA via NODE_EXTRA_CA_CERTS. · "The connection to the server was closed unexpectedly." (a local server may have crashed or run out of memory loading the model; check its terminal). · Behind a company proxy see [the README](../README.md#a-free-gemini-key). |
| `timeout` | No first word within the wait time (default 180 s), or silence in the middle of a reply. | Local: "The first request after starting a model loads it into memory, which can take a while, and giving up cancels that load. Raise the timeout in Settings (Settings > General), then try again." Retrying at once restarts the load, so raise the timeout first. · Cloud: "Try again in a moment, or raise the timeout in Settings." · "…stopped responding in the middle of the reply": the machine may be overloaded; try again or use a smaller model. |
| `blocked` | The model or its safety filter declined to answer. | "The model declined to answer this one." Journaling about hard things can trip safety filters; rephrase, or switch provider in Settings. · "Gemini declined to answer this one." |
| `context_too_long` | The conversation does not fit the model's window. | "This conversation is too long for the model." Shorten the entry, lower the context budget in Settings, or choose a model with a longer window. Local: raise the model's context size (Ollama: set OLLAMA_CONTEXT_LENGTH, e.g. 8192, and restart it; llama.cpp: --ctx-size). When the server reports both numbers, the hint says "The prompt needs about 6063 tokens but the model's context window holds 4096." |
| `bad_request` | The server refused the request itself. | "The server rejected the request (HTTP 400)." Check the model name and settings; a different model may accept it. The server's own words are appended. · "There is nothing to reply to yet." Write something first, then ask for a reply. |
| `server` | The model server had an internal problem. | "The model server had an internal problem (HTTP 500)." Cloud: try again in a moment; if it keeps failing, check the provider's status page. Local: check the terminal where your model server runs. · "The server may still be loading the model. Wait a few seconds and try again." (503) · "The model does not fit in this computer's memory." Choose a smaller model (llama3.2:1b needs about 2 GB), or lower the context size (Ollama: OLLAMA_CONTEXT_LENGTH=4096, fewer OLLAMA_NUM_PARALLEL), close other programs. · "Gemini had an internal problem." · Ollama download: "ran out of disk space" / "needs a newer version of Ollama". |
| `overloaded` | The service is busy. | "Gemini is overloaded right now." This is usually brief. Try again in a moment, or switch to gemini-flash-lite-latest in Settings (if you are on a Lite model: pick another model with Load models). Common with `gemini-flash-latest`. A 503 that arrives within 8 seconds is retried once automatically; one that took longer is shown straight away, so you are not made to wait twice. |
| `region` | The service is not available where you are. | "This service is not available in your region." Choose another provider (or a local model) in Settings. · "Gemini is not available in your region." The free tier is not offered everywhere. Enable billing for your Google project, or choose another provider. |
| `empty` | The model answered with no text. | "The model returned an empty reply." Try again; very small models sometimes return nothing (try a different model). · "The model only produced hidden reasoning and no answer." The model spent its whole token budget thinking: raise max tokens or use a non-reasoning model. · "The reply was cut off before any text appeared." · Gemini: "Gemini used its whole token budget thinking and wrote no answer." Raise max tokens in Settings, or set Gemini thinking to "low". |
| `unknown` | Anything else (an unexpected HTTP status). | "The server answered with an unexpected status." Check the server and the address. |

Other things you may meet around the AI:

- **`409 ai_not_configured` / `ai_disabled`.** No usable model yet, or the AI is switched off in Settings → General. Your writing is saved either way.
- **`409 generation_in_progress`.** A reply is already being written in that entry. Wait, or press Stop.
- **`422 not_enough_entries`** (weekly reflection). No non-private entries in the period.
- **`409 not_ollama`** (Download model). The address is not an Ollama server; load the model in llama.cpp or LM Studio yourself.
