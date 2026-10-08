# MyJournal

**A private journal with an AI that asks the next good question.** You write; a companion replies with a gentle follow-up, remembers what matters to you, notices your moods and writes you a weekly reflection. Your journal lives in one file on your own computer, and you bring your own model: a free Gemini key, any OpenAI-compatible API, or a small model running on your own machine, so nothing has to leave it.

It is a single Node.js program with **no dependencies to install**. Prefer no AI at all? It is also a calm, fast, private journal on its own.

- [What you get](#what-you-get)
- [Quick start](#quick-start) · [Try it without any key](#try-it-without-any-key)
- [Connect a model](#connect-a-model): [free Gemini](#a-free-gemini-key) · [OpenAI and compatible](#b-openai-or-any-openai-compatible-api) · [your own machine](#c-a-small-model-on-your-own-machine)
- [Run it in Docker](#run-it-in-docker)
- [Configuration reference](#configuration-reference)
- [Your data and privacy](#your-data-and-privacy) · [Security model](#security-model)
- [Project layout](#project-layout) · [Development](#development)
- [Limitations and roadmap](#limitations-and-roadmap) · [FAQ and troubleshooting](#faq-and-troubleshooting)
- More: [docs/PROVIDERS.md](docs/PROVIDERS.md) (every provider in depth), [docs/PRIVACY.md](docs/PRIVACY.md) (what leaves your machine), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it is built)

## What you get

- **Free writing or guided journals.** Start from a blank page and the prompt of the day, or pick one of 12 guided sessions: Rose, Thorn, Bud · Gratitude · Morning intention · Evening reflection · Thought record · Worry dump · Self-compassion · Goals check-in · Relationship reflection · Dream journal · Weekly review · Decision helper.
- **Follow-up questions.** Each reply responds to what you wrote and ends with one open question. Press **Stop** any time, **Regenerate** a reply, or **Save without reply** when you just want to write.
- **Memory you can see.** After you press **Wrap up**, the companion can save short lasting facts ("has a younger sister called Maya"). They are listed on the **Memory** page, where you can add, edit, pin, delete or switch memory off. It can also recall a few related older entries while it replies.
- **Mood and emotions.** Log a mood from 1 to 5 on any entry. Wrap-up adds a title, a summary, a few feelings and some tags, all editable.
- **Insights.** Streak, entries and words written, average mood, a mood chart, a calendar of the days you wrote, and your top feelings and tags, all computed on your computer.
- **Weekly reflection.** One button writes a short reflection over the last 7, 14 or 30 days. Past reflections are kept.
- **Personas.** Companion, Coach, CBT-style guide, Stoic, Friend, or your own description of the voice you want.
- **Search and history.** Full-text search, filters for mood, tag and pinned, entries grouped by month.
- **Voice dictation.** A Dictate button appears in browsers that support speech recognition (see [PRIVACY](docs/PRIVACY.md#voice-dictation): the browser, not MyJournal, does the listening).
- **Export and import.** Download everything as JSON (re-importable) or Markdown, or one entry as Markdown. Import merges a JSON export without overwriting anything.
- **Private entries.** Mark an entry **Private** to keep it out of memory, recall and weekly reflections.
- **Works with no AI.** Skip the model, or switch it off later in Settings → General. Everything except the AI still works.
- **Light and dark theme**, keyboard-friendly, and a phone-sized layout.

> MyJournal is a journaling tool, not therapy. It shows a gentle, fixed care message when your writing mentions being in danger, but it cannot call for help and it is not a substitute for a professional or a crisis line.

## Quick start

You need **Node.js 22.13 or newer** (`node --version`). There is nothing to install: no `npm install`, no build step.

<!-- TODO(lead): put the real repository URL in the git clone line below. -->

```bash
git clone <repository-url> myjournal
cd myjournal
npm start
```

Open **http://127.0.0.1:3210**. The first screen asks which model to use, or lets you pick **Just journal, no AI**. Stop the server with Ctrl+C.

The terminal prints where your data lives. By default that is `./data/journal.db`, relative to the folder you started `npm start` in. The server listens on this computer only (`127.0.0.1`), so nobody else on your network can reach it.

Another port: `PORT=3211 npm start` (Windows PowerShell: `$env:PORT=3211; npm start`).

## Try it without any key

```bash
npm run demo
```

Starts pretend model servers and the real app on a free port with three weeks of sample entries, memories and a weekly reflection, all in a temporary folder that is deleted when you press Ctrl+C. The replies are canned (nothing here is a real AI), but every screen works, including **Test connection** and **Download model**. Open the address it prints.

## Connect a model

Pick one. You can switch any time under **Settings**; each provider keeps its own key, address and model. The flow is the same everywhere: open the provider's tab, fill in the fields, press **Test connection**, then **Use this provider**.

| | Needs | Costs | Where your text goes |
|---|---|---|---|
| [Free Gemini](#a-free-gemini-key) | a Google account | free tier, with limits | Google |
| [OpenAI-compatible](#b-openai-or-any-openai-compatible-api) | an API key | pay per use | the service you choose |
| [Your own machine](#c-a-small-model-on-your-own-machine) | a computer with a few GB of free memory | free | nowhere, it stays on your machine |

### A. Free Gemini key

1. Open <https://aistudio.google.com/apikey>, sign in with a Google account and create an API key.
2. In MyJournal choose **Use Gemini** on the welcome screen (or **Settings → Gemini (free)**), paste the key, press **Test connection**, then **Use this provider**.

Or give the key through the environment (it is then never written to the journal file):

```bash
GEMINI_API_KEY=your-key npm start
```

An environment key alone does not switch the AI on: still pick **Gemini** once in Settings (the terminal reminds you).

**Model.** The default, `gemini-flash-lite-latest`, is the recommended one: it answers in about a second and has the most generous free quota. `gemini-flash-latest` is smarter but was often slow or busy ("503 high demand") when we tried it. Use **Load models** to see what your key can use. Details and live measurements: [docs/PROVIDERS.md](docs/PROVIDERS.md#google-gemini).

> **Free-tier privacy warning.** On Google's free tier your prompts and the model's answers may be used to improve Google's products and may be read by human reviewers. A key on a billing-enabled project is not used that way. **Do not journal secrets with a free key.** If that matters to you, use a local model.

**Behind a company proxy?** Node's built-in `fetch` ignores `HTTPS_PROXY` unless the process is started with `NODE_USE_ENV_PROXY=1` (Node 22.21 or newer):

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://proxy.example.com:3128 NO_PROXY=localhost,127.0.0.1 npm start
```

Set these in the real environment, not in `.env` (Node reads them before the app starts). Keep `localhost,127.0.0.1` in `NO_PROXY` if you also use a local model, or those requests go to the proxy too. If the proxy re-signs HTTPS, also set `NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem`.

### B. OpenAI, or any OpenAI-compatible API

1. Create an API key with your provider.
2. **Settings → OpenAI-compatible**: paste the key. Under **Base URL**, press a preset or type your own:

   | Service | Base URL | Model names look like |
   |---|---|---|
   | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` (the default) |
   | OpenRouter | `https://openrouter.ai/api/v1` | `vendor/model`, for example `openai/gpt-4o-mini` |
   | Groq | `https://api.groq.com/openai/v1` | press **Load models** |
   | Together | `https://api.together.xyz/v1` | press **Load models** |

   Any other service that speaks the OpenAI "chat completions" API (DeepSeek, Mistral, a company gateway, LiteLLM, vLLM, …) works the same way with its own base URL, which normally ends in `/v1`.
3. Press **Load models** to pick a model your key can use (or type its name), **Test connection**, **Use this provider**.

Through the environment instead:

```bash
OPENAI_API_KEY=sk-... npm start
# another service:
OPENAI_API_KEY=... OPENAI_BASE_URL=https://openrouter.ai/api/v1 npm start
```

`OPENAI_BASE_URL` (like `LOCAL_LLM_BASE_URL` and `LOCAL_LLM_MODEL`) only provides the *starting* value of a fresh install. Once you press Save in Settings, the value shown there is stored and the variable no longer changes it.

Your journal text goes to whatever service is behind the base URL: check its data retention and training policy. Azure-style URLs (a `?api-version=` query string, an `api-key` header) are not supported; see [docs/PROVIDERS.md](docs/PROVIDERS.md#openai-compatible-apis).

### C. A small model on your own machine

Nothing leaves your computer, it works offline and it costs nothing, at the price of simpler conversations than the big cloud models give. **3B models are the sensible minimum for a pleasant chat; 1B models are for testing the plumbing**: they connect and reply, but stay basic.

#### Ollama (the easy way)

1. Install Ollama from <https://ollama.com/download> (macOS, Windows, Linux). Most installs start it for you; otherwise run `ollama serve`.
2. Download a small model (about 2 GB):

   ```bash
   ollama pull llama3.2:3b
   ```

   Smaller or lighter alternatives from the app's picker: `llama3.2:1b` (about 1.3 GB, testing only), `qwen2.5:1.5b`, `gemma2:2b`, `smollm2:1.7b`.
3. Give it a bigger memory window. Ollama's default is 4096 tokens on typical machines, which cuts long entries off. Start it with more:

   ```bash
   OLLAMA_CONTEXT_LENGTH=8192 ollama serve
   ```

   (Windows PowerShell: `$env:OLLAMA_CONTEXT_LENGTH=8192; ollama serve`.) If Ollama runs as a background service or app, set `OLLAMA_CONTEXT_LENGTH` in that service's environment and restart it. A larger window uses more memory.
4. In MyJournal: **Settings → Local model**. The default address `http://localhost:11434/v1` is already the Ollama preset and the default model is `llama3.2:3b`. Press **Test connection**, then **Use this provider**.

Skip step 2 if you like: the **Download model** button on that tab fetches the model through your Ollama server and shows progress. (The very first reply after a download is slower while the model loads into memory.)

#### llama.cpp

```bash
llama-server -m model.gguf --port 8080 -c 4096
```

In **Settings → Local model** press the **llama.cpp** preset (`http://localhost:8080/v1`), then **Load models**, pick the one that appears (it is the GGUF file you started the server with) and **Test connection**. `-c` is the context window in tokens; use at least 4096.

#### LM Studio

Load a model in LM Studio and start its local server (default port 1234), then press the **LM Studio** preset (`http://localhost:1234/v1`), **Load models**, **Test connection**.

#### Good to know

- **Context window.** If the model's window is smaller than what MyJournal sends, long entries get cut or you see a "too long for the model" error. The default *Context budget* (3,000, counted conservatively) fits a 4,096-token window; for a 2,048-token window lower it in Settings → General to about 1,500, and if you raise the window you can raise the budget with it. See [docs/PROVIDERS.md](docs/PROVIDERS.md#context-windows-and-the-truncation-trap).
- **First reply is slow.** The first request after starting a model loads it into memory. If it keeps timing out, raise *Wait for the first word* in Settings → General.
- **"Thinking" models** (qwen3-style) are handled: MyJournal asks them not to think, and strips any `<think>…</think>` text that still arrives.
- A local server on *another* computer works too (set its address), but your text then travels to that computer, over plain `http://` unless you set up HTTPS.

#### Tested with

<!-- TODO(lead): fill in the "Tested with" table from the live runs (provider, model, version, hardware, first-byte time, notes). Facts known so far: Ollama 0.40.1 on CPU; models llama3.2:1b, qwen3:1.7b, smollm2:360m; llama.cpp llama-server; Gemini free tier measured 2026-10-08 (see test/fixtures/gemini-live/README.md). -->

## Run it in Docker

Optional. Needs Docker with Compose v2. The container listens on all interfaces *inside* Docker, so a password is **required** (the server refuses to start without one), and the compose file publishes the port on `127.0.0.1` only.

```bash
cp .env.example .env          # then edit .env and set JOURNAL_PASSWORD to a long passphrase
docker compose up -d --build
```

Open <http://127.0.0.1:3210> and sign in. Your journal is in the `journal-data` Docker volume.

With a small model in a container too (CPU is fine; the default model is about 2 GB):

```bash
docker compose --profile ollama up -d --build
docker compose logs -f ollama-pull      # watch the one-time download
```

Then choose **Local model** in the app. `docker compose down` stops everything and keeps your data; `docker compose down -v` also **deletes the volumes, journal included**. Details, hardening choices and the Ollama on the host variant are commented in [docker-compose.yml](docker-compose.yml). Without Compose:

```bash
docker build -t myjournal .
docker run -d --name myjournal -p 127.0.0.1:3210:3210 -v myjournal-data:/data \
  -e JOURNAL_PASSWORD='a long passphrase' myjournal
```

## Configuration reference

Everything is optional. Set variables in the environment, or in a `.env` file in the folder you start the server from ([.env.example](.env.example) lists them all; real environment variables win over the file).

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3210` | Port to listen on. `0` picks a free one. |
| `HOST` | `127.0.0.1` | Address to listen on. Anything but a loopback address (for example `0.0.0.0`) needs `JOURNAL_PASSWORD` or `JOURNAL_INSECURE_ALLOW_NO_AUTH=1`, otherwise the server refuses to start. |
| `JOURNAL_DATA_DIR` | `./data` | Folder for `journal.db`. A relative path is relative to the folder you start in. |
| `JOURNAL_PASSWORD` | none | Password to sign in. Not stored anywhere but your environment; changing it signs everyone out. |
| `JOURNAL_ALLOWED_HOSTS` | none | Extra `Host` header values to accept, comma separated (`journal.example.com` any port, `journal.example.com:8443` that port only). Needed behind a reverse proxy on the same computer; see [Host checks](#security-model). |
| `JOURNAL_INSECURE_ALLOW_NO_AUTH` | off | `1`, `true` or `yes`: allow a non-loopback `HOST` without a password. Only if something else in front already does the login. |
| `GEMINI_API_KEY` | none | Gemini key (`GOOGLE_API_KEY` is read too). A key saved in Settings wins. |
| `OPENAI_API_KEY` | none | Key for the OpenAI-compatible provider. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Starting base URL for that provider. |
| `LOCAL_LLM_BASE_URL` | `http://localhost:11434/v1` | Starting address of the local model server. |
| `LOCAL_LLM_MODEL` | `llama3.2:3b` | Starting model name for the local provider. |
| `LOCAL_LLM_API_KEY` | none | Only if your local server wants a key (Ollama does not). |
| `NODE_USE_ENV_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` | none | Node's own variables, for company proxies. See [above](#a-free-gemini-key). Must be in the real environment, not in `.env`. |

Keys from the environment are never written to the journal file. The three `*_BASE_URL` / `LOCAL_LLM_MODEL` variables only seed a fresh install (see [B](#b-openai-or-any-openai-compatible-api)).

Docker Compose adds `JOURNAL_HOST_PORT` (host port, default `3210`), `TZ`, `OLLAMA_MODEL` and `OLLAMA_CONTEXT_LENGTH`; they are explained in `.env.example`.

**Settings in the app** (Settings → General) and their limits:

| Setting | Default | Range |
|---|---|---|
| Creativity (temperature) | 0.7 | 0 to 2 |
| Longest reply (tokens) | 700 | 64 to 8192 |
| Context budget (tokens, approximate) | 3000 | 500 to 32000 |
| Wait for the first word (seconds) | 120 | 5 to 600 |
| Memory, auto-extract, recall related entries | all on | on / off |
| Use the AI companion | on | on / off |

## Your data and privacy

- **Where it lives.** One SQLite file, `journal.db`, in the data folder (plus `journal.db-wal` and `-shm` files while the server runs). Entries, your messages, the companion's replies, memories, reports and your settings are all in it. The folder is created readable by you only. Nothing is stored anywhere else, except a few small things in your browser: your theme, the Insights range you picked, and an unsent draft while you type (it is removed once the text is saved).
- **What leaves your computer.** Only AI requests, and only to the provider you chose. With a local model on this computer, nothing. MyJournal has no accounts, no analytics and no telemetry, and the web page loads no scripts, fonts or images from other sites.
- **What the AI sees.** For a reply: the current conversation (shortened to your context budget), your name and "About you" text, today's date, your memories, a few related past entries (title and summary, or an excerpt) and, in a guided session, that session's instructions. Not the rest of your journal, not your settings, not your keys. Wrap-up repeats the conversation for the closing reflection, then sends only what *you* wrote for the title and summary step, and what you wrote plus your known memories for the memory step. A weekly reflection sends titles, summaries or short excerpts, moods, feelings and tags of that period's non-private entries, plus your memories.
- **Private flag.** A private entry is kept out of memory, recall and weekly reflections. It is still sent to your AI when you ask for a reply in it; use **Save without reply**, or switch the AI off, for text no model should see.
- **API keys** you paste into Settings are stored **unencrypted** in `journal.db`. If that matters, leave the key fields empty and use the environment variables instead; keys from the environment are never written to the file. Exports never contain settings or keys.
- **Backups, moving and deleting.** Copy the data folder while the server is stopped, or use **Settings → Data → Export** (JSON restores everything; Markdown is for reading). **Settings → Data → Delete everything** removes entries, messages, memories and reports (optionally settings and keys too) and compacts the file; there is no undo.

The complete picture, per provider: [docs/PRIVACY.md](docs/PRIVACY.md).

## Security model

MyJournal is built for **one person on a computer they control**.

- **Loopback by default.** It listens on `127.0.0.1`. Listening on any other address makes it refuse to start unless you set a password (or explicitly opt out with `JOURNAL_INSECURE_ALLOW_NO_AUTH=1`).
- **Password.** With `JOURNAL_PASSWORD` set, every API call needs a session (a random token in an HTTP-only, same-site cookie named `mj_session_<port>`, valid 30 days, kept in memory, so a restart signs you out). After 5 wrong passwords from one address, sign-in waits a minute. There is one password for one person.
- **Host checks.** The server only answers requests whose `Host` header is `localhost`, `127.0.0.1`, `[::1]`, the address you set in `HOST` or an entry of `JOURNAL_ALLOWED_HOSTS` (a defence against DNS-rebinding attacks from web pages). The check is on whenever no password is set, and also when a password is set but the server listens on loopback. It is off only for a non-loopback `HOST` with a password.
- **CSRF.** Every state-changing request must carry `X-MyJournal: 1` and, when the browser sends an `Origin`, that origin must match the `Host` (or `X-Forwarded-Host`). No CORS headers are ever sent.
- **Browser hardening.** A strict Content-Security-Policy (`default-src 'self'`, no inline scripts or styles), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`; the app is plain JavaScript with no third-party code, and all AI text is rendered as text, never as HTML.
- **Not protected, by design:** there is **no encryption at rest** (anyone who can read the data folder can read the journal and any saved API key; use disk encryption), **no HTTPS** (put a reverse proxy with TLS in front before using it beyond your own computer: the password and cookie otherwise travel in clear text), **no multi-user separation**, and no protection against malware or someone using your signed-in browser.

## Project layout

```text
server.js            entry point: loads .env and config, opens the database, starts the server
src/config.js        environment -> configuration, the .env loader, the startup safety rule
src/settings.js      settings defaults, validation, merging, key masking
src/providers/       the model adapters: openai.js (OpenAI-compatible + local), gemini.js, errors, SSE parsing
src/db/              SQLite storage (node:sqlite): entries, messages, memories, reports, search, export/import
src/journal/         pure journaling logic: prompts, personas, guided templates, insights, safety
src/server/          HTTP layer: routes, security, auth, generation (streaming), static files
public/              the web app: plain JavaScript modules and CSS, no build step
scripts/             demo.js (npm run demo), check.js (npm run check)
test/                unit and integration tests, mock model servers, recorded real responses, browser tests
docs/                PROVIDERS.md, PRIVACY.md, ARCHITECTURE.md
Dockerfile, docker-compose.yml, .env.example
```

## Development

Node 22.13 or newer. The product has zero dependencies; keep it that way.

```bash
npm start            # run the server
npm run dev          # same, restarting on file changes
npm test             # unit + integration tests with mock model servers (about 1,350 tests, 1-2 minutes)
npm run check        # node --check on every script, and no innerHTML / eval anywhere in public/
npm run test:e2e     # real-browser journeys; needs Playwright + Chromium (not dependencies), skipped without them
npm run mock-llm     # pretend model servers on :11500 (OpenAI/Ollama style) and :11501 (Gemini)
npm run demo         # the whole app on pretend models with sample data
```

Everything that talks to a model is tested against mock servers in `test/mocks`, and the Gemini, Ollama and llama.cpp adapters also against responses recorded from the real services (`test/fixtures`). The browser tests are described in [test/e2e/README.md](test/e2e/README.md). How the pieces fit: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Limitations and roadmap

What it is not, today:

- **One person, one computer.** No accounts, no sync between devices, no sharing. To use it from a phone, host it somewhere you control (see [reverse proxy](#faq-and-troubleshooting)).
- **No encryption at rest, no built-in HTTPS.** See [Security model](#security-model).
- **Text only.** No images, audio recordings or attachments. Voice dictation turns speech into text through your browser.
- **English interface.** The companion answers in the language you write in, but small local models are much weaker outside English.
- **Small models are small.** Replies from 1B–3B models are simpler, and the automatic title, summary and memory steps can be off. Review the Memory page now and then.
- **Search is keyword-based**, not semantic, and "related entries" use the same search.
- **Import** understands MyJournal's own JSON export only.
- **Sessions are in memory:** restarting the server signs you out.
- **No automatic backups.**
- The browser tests run in Chromium; Firefox and Safari are not part of them. Dictation does not exist in Firefox.

Ideas that are not built (no promises): optional encryption at rest, importers for other journal apps, semantic search, an interface in other languages.

## FAQ and troubleshooting

**"Port 3210 is already in use."** Is MyJournal already running? Pick another port: `PORT=3211 npm start`.

**`No such built-in module: node:sqlite`.** Your Node.js is too old (that error appears on Node 20 and 21). Install Node 22.13 or newer.

**"Could not connect to the local model server" (Ollama connection refused).** Ollama is not running or the address is wrong. Start it (`ollama serve`, or open the Ollama app), then check **Settings → Local model**: the address is `http://localhost:11434/v1`. Inside Docker, `localhost` is the container itself: use `http://ollama:11434/v1` for the bundled Ollama or `http://host.docker.internal:11434/v1` for one on the host.

**"The server address is not valid" for an address that looks right.** Node's `fetch` refuses a fixed list of ports that browsers also block (6000, for example; see "bad ports" in the Fetch standard). Start your model server on another port.

**"The model … was not found."** The name in Settings is not a model your server has. For Ollama run `ollama pull <name>` or press **Download model**; for others press **Load models** and pick one from the list.

**"This conversation is too long for the model", or replies that ignore earlier text.** The model's context window is smaller than what is sent. Raise the window (Ollama: `OLLAMA_CONTEXT_LENGTH=8192`, llama.cpp: `-c`) and/or lower Settings → General → *Context budget*. Details: [docs/PROVIDERS.md](docs/PROVIDERS.md#context-windows-and-the-truncation-trap).

**The first reply from a local model takes ages or times out.** The model is being loaded into memory. Give it time and raise *Wait for the first word* (Settings → General). Note that **Test connection** gives up after 90 seconds whatever that setting says; press it again once the model has loaded.

**Gemini: "rate limit reached" (429).** The free tier allows only so many requests per minute. Wait the number of seconds the message gives and try again. **"The free daily limit … is used up"** means try tomorrow, switch model, or enable billing.

**Gemini: "Gemini is overloaded right now" (503).** Google's side is busy, usually briefly; `gemini-flash-lite-latest` is busy far less often than `gemini-flash-latest`. **"Gemini is not available in your region"**: the free tier is not offered everywhere; use billing, another provider or a local model.

**"Gemini has retired …" or "This model is no longer available".** Google removed that model. Press **Load models** and pick a current one, or use `gemini-flash-lite-latest`.

**More error messages and what they mean:** the full table is in [docs/PROVIDERS.md](docs/PROVIDERS.md#troubleshooting-every-error-code).

**I forgot my password.** There is no stored password: it is whatever `JOURNAL_PASSWORD` says in your environment or `.env`. Change it there and restart.

**It asks for a password and I never set one.** Something set `JOURNAL_PASSWORD`: check your `.env` file and your shell. Remove it (and restart) to go back to no sign-in on a loopback address.

**"This address is not allowed to open the journal" (403 `forbidden_host`).** You opened it under a name the Host check does not know, such as a LAN address or `http://myserver:3210`. Use `http://localhost:3210`, or add the name to `JOURNAL_ALLOWED_HOSTS`, or listen on a non-loopback `HOST` with a password (which turns the Host check off).

**Behind a reverse proxy (nginx, Caddy, …).**

1. Make the proxy pass the original `Host` header, or send `X-Forwarded-Host`: otherwise saves fail with `forbidden_origin` ("This request comes from a different website").
2. If MyJournal listens on loopback (the default), add the public name: `JOURNAL_ALLOWED_HOSTS=journal.example.com`.
3. Send `X-Forwarded-Proto: https` from the TLS proxy so the session cookie is marked `Secure`.
4. Do not buffer streamed replies (MyJournal already sends `X-Accel-Buffering: no`, which nginx honours).
5. Failed sign-ins are counted per connecting address, and behind a proxy that is the proxy itself (`X-Forwarded-For` is not consulted): five wrong passwords from anyone lock everybody out for a minute. This does not weaken the password, but expect it.

```nginx
location / {
    proxy_pass http://127.0.0.1:3210;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

(Caddy: `reverse_proxy 127.0.0.1:3210` already forwards the original Host and handles streaming. These proxy snippets were not run here; adapt them to your setup.) Set a `JOURNAL_PASSWORD`: the proxy makes the journal reachable by others.

**Docker: the container exits right away.** `JOURNAL_PASSWORD` is missing. Compose tells you so; `docker run` needs `-e JOURNAL_PASSWORD=...`. **"permission denied" on a bind-mounted `/data`:** the folder must be writable by uid 1000.

**There is no microphone button.** Your browser has no speech recognition: Firefox does not offer it, Chrome does, others vary.

**Windows.** Use PowerShell syntax for variables: `$env:PORT=3211; npm start`.

## Inspired by

MyJournal is an independent open-source project inspired by guided AI journaling apps in the style of Rosebud. It has no affiliation with, and is not endorsed by, Rosebud or anyone behind it.

## License

<!-- TODO(lead): choose and state a license (there is no LICENSE file yet), and add the file. -->
