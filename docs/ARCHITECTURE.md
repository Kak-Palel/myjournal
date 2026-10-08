# MyJournal: architecture and contracts

A private, AI-guided journal: an AI companion asks follow-up questions, remembers the person, tracks mood and writes weekly reflections. **Bring your own model**:

| Provider id | What it is | Needs key | Default base URL |
|---|---|---|---|
| `gemini` | Google Gemini API (free tier via an AI Studio key), **native** REST adapter | yes | `https://generativelanguage.googleapis.com` |
| `openai` | Any OpenAI-compatible Chat Completions API (OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, …) | yes | `https://api.openai.com/v1` |
| `local` | A self-hosted small LLM behind an OpenAI-compatible server: **Ollama** (default), llama.cpp `llama-server`, LM Studio, vLLM | no (optional) | `http://localhost:11434/v1` |

`openai` and `local` share one adapter (`src/providers/openai.js`); they differ in defaults, UI copy, key requirement, timeouts and the Ollama helpers (model download).

AI is **optional**: with no provider configured, or with the AI switched off, the app is a plain, fast, private journal.

This document describes the code as it is. User-facing guides: [README](../README.md), [PROVIDERS](PROVIDERS.md), [PRIVACY](PRIVACY.md). Section numbers (§5 settings, §6 HTTP API, §7 streaming, §8 journal logic, §9 provider layer, §10 server, §11 database) are cited from source comments; keep them stable.

---

## 1. Hard constraints

* **Node ≥ 22.13, ESM, zero runtime dependencies.** `npm start` works after `git clone` with no `npm install`; on an older Node it prints one friendly line and exits (§10). Only Node built-ins are used: `node:http`, `node:sqlite` (`DatabaseSync`, FTS5 available), `node:crypto`, `node:test`, global `fetch`, `AbortController`, `TextDecoder`, `process.loadEnvFile`. Dev-only tools (Playwright for `test/e2e`) are never dependencies of the project; the browser tests look them up at run time and skip when absent.
* **Frontend: vanilla JS ES modules, no build step, no CDN, no external fonts.** It works offline (people run local LLMs offline). No `innerHTML` with dynamic data (DOM is built with `h()` and `textContent`; `npm run check` fails the build on `innerHTML`, `outerHTML =`, `insertAdjacentHTML`, `eval`, `new Function`, `document.write` anywhere in `public/`). A strict CSP is served: no inline `<script>`, no inline event handlers, no `style=""` attributes in markup (setting `el.style.x` from JS is fine), no `eval`.
* **Privacy.** All data stays in a local SQLite file. API keys are never returned by the API (only `apiKeySet` / `apiKeyHint` / `apiKeySource`), never logged, never put in URLs (the Gemini key goes in the `x-goog-api-key` header). Request and response bodies are never logged; neither are query strings.
* **Small models are first-class.** Prompts are short, imperative, single-task; nothing relies on JSON output from a model; all model output is parsed tolerantly with deterministic fallbacks. Context budgets are honoured (Ollama defaults to a 4k window).
* **Never lose user writing.** The user's message is persisted *before* any AI call. AI failures never roll back or block saving.
* Style: 2-space indent, semicolons, single quotes, `const`/`let`, small functions, JSDoc on exported functions, **no TypeScript**, no classes unless modelling errors or handles. Comments explain *why*.

---

## 2. Repository layout (final file list)

```text
server.js                      entry: checks the Node version, loads .env and config, opens the DB, starts the server, shuts down cleanly
package.json                   scripts only; "dependencies" and "devDependencies" are empty; engines node >=22.13.0
README.md  .env.example        user documentation; every supported environment variable
Dockerfile  docker-compose.yml  .dockerignore     container deployment (see below)
.gitignore                     node_modules/, data/, .env, .env.local, *.log, .DS_Store, test-results/, screenshots/, .scratch/

src/config.js                  env -> config object, .env loader, startup safety rule (isLoopbackHost, assertSafeToStart)
src/env-keys.js                which env vars can supply a provider key + precedence rule (effectiveApiKey, keyHint)
src/settings.js                settings defaults, validation, deep-merge, masking, env seeds (shared by server and providers)
src/providers/                 LLM adapters
  index.js                     createProvider, describeProviders (catalog rows), re-exports
  config.js                    PROVIDER_DEFAULTS, resolveProviderConfig (settings + env -> request config)
  openai.js                    OpenAI-compatible adapter (openai + local), Ollama helpers (isOllama, pullOllamaModel)
  gemini.js                    Gemini native REST adapter
  common.js                    shared request loop (retry, self-healing), message validation, JSON/SSE event reader
  http.js                      timeouts/scopes, network error mapping, URL parsing, retry timing
  sse.js                       SSE and NDJSON parsers      think-filter.js   <think> block stripper
  errors.js                    ProviderError, error codes, secret redaction
src/db/                        SQLite persistence (node:sqlite)
  index.js                     openDb and the db handle    schema.js     schema + migrations
  context.js                   statement helpers, transactions   util.js   validation/limits/text helpers
  entries.js  messages.js  memories.js  reports.js  settings-store.js    repositories
  search.js                    FTS5 index + search        filters.js     shared entry filters
  portability.js               export, import, wipe, stats
src/journal/                   pure journaling logic (no I/O)
  context.js                   prompt builders       tasks.js      tolerant parsers for model output
  language.js                  detectLanguage / languageName (which language is this text in?) + the localised closing cue and weekly seed
  personas.js  templates.js    voices; 12 guided sessions + prompts of the day
  safety.js                    crisis detection + static care message
  insights.js                  streaks and overview   dates.js  text.js  tokens.js    helpers
src/server/                    HTTP layer
  app.js                       createApp: wiring, request pipeline, lifecycle
  http.js                      HttpError, JSON/body helpers, router, SSE writer
  security.js                  security headers, Host allow-list, CSRF check
  auth.js                      password, sessions, login limiter       static.js   static files
  node-version.js              the Node.js version check server.js runs first (no imports on purpose)
  ai-service.js                settings + env -> provider; ai_disabled / ai_not_configured
  generation.js                reply, wrap-up and weekly jobs; per-entry locks     validate.js   request validation
  export.js                    Markdown rendering    banner.js   start-up text    logger.js   request log
  routes/                      auth, settings, providers, catalog, entries, memories, insights, data

public/                        the web app (static, no build)
  index.html  favicon.svg      css/{base,today,entry,history,insights,memory,settings,onboarding,login}.css
  js/app.js                    shell: router, settings store, theme, connection banner, auth gating
  js/theme-init.js             applies the saved theme before first paint (CSP-friendly external script)
  js/lib/                      api, dom, router, ui, markdown, charts, voice, return-to (page to return to after sign-in), keyboard-inset (--kb-inset)
  js/views/                    today, entry, history, insights, memory, settings, onboarding, login
  js/components/               entry-*, today-*, history-*, insights-*, memory-*, settings-*, connection, privacy-copy (see §12)

scripts/demo.js                npm run demo: pretend models + sample journal in a temp folder (always on 127.0.0.1; ignores HOST and PORT; the folder is removed on SIGINT, SIGTERM, SIGHUP, SIGQUIT and on a crash)
scripts/check.js               npm run check: node --check on every script, forbidden constructs in public/
docs/                          ARCHITECTURE.md (this), PROVIDERS.md, PRIVACY.md

test/{providers,db,journal,server,frontend}/*.test.js     unit + integration (node:test); run by npm test (test/server/fixtures: stubs for the Node-version tests)
test/e2e/*.e2e.js              real-browser journeys (Playwright, optional); run by npm run test:e2e
test/mocks/                    mock-openai (also Ollama bits), mock-gemini, mock-responder, mock-server, serve.js
test/fixtures/{gemini-live,ollama-live,llamacpp-live}/    responses recorded from the real services
```

Runtime needs only `package.json`, `server.js`, `src/` and `public/` (about 1.1 MB, 121 files); the Docker image copies exactly those.

**Container deployment.** `Dockerfile` (`node:22-alpine`, user `1000:1000`, `HOST=0.0.0.0 PORT=3210 JOURNAL_DATA_DIR=/data`, `VOLUME /data`, a healthcheck that fetches `http://127.0.0.1:$PORT/api/health` with Node's own `fetch`, `CMD node --disable-warning=ExperimentalWarning server.js`). Because the image binds `0.0.0.0`, the §10 startup rule makes the container exit unless `JOURNAL_PASSWORD` (or `JOURNAL_INSECURE_ALLOW_NO_AUTH=1`) is set, so the secure setup is the default one. `docker-compose.yml` requires `JOURNAL_PASSWORD`, publishes the port on `127.0.0.1` only, keeps the database in the `journal-data` volume, runs the app read-only with all capabilities dropped (it writes only to `/data`), and has an `ollama` profile (an Ollama service, a one-shot `ollama-pull` service for the model, `LOCAL_LLM_BASE_URL` pointing at it).

---

## 3. Conventions

* JSON is **camelCase**; SQL columns are snake_case; the repository layer converts.
* Timestamps: integer **milliseconds since the epoch** (`createdAt`, `updatedAt`).
* Calendar dates: `'YYYY-MM-DD'` strings in the *user's local time* (`entry.date`). The browser sends its local date where it matters (`date`, `today`); the server never guesses time zones for streaks. The web client always sends `today` with a reply, regenerate or wrap-up request (`{ regenerate, today }` / `{ today }`, from `todayString()` in `components/entry-request.js`) and `date` with a new entry; only another API client can omit them, in which case the server's own clock supplies "Today is …" in the prompt (so containers still set `TZ`).
* IDs: `crypto.randomUUID()`.
* Mood: integer `1..5` (1 awful … 5 great) or `null`.
* Errors over HTTP: a status code plus `{ "error": { "code": "snake_case", "message": "human readable", "hint"?: "what to try", "fields"?: { "path": "msg" } } }`.
* The server never sends HTML. API bodies are JSON (or `text/markdown` / `text/event-stream`); the client escapes and renders.

---

## 4. Data model

### JSON shapes (API and repositories)

```jsonc
// Entry: one journaling session (a conversation that starts with the user's writing)
{
  "id": "uuid", "createdAt": 1760000000000, "updatedAt": 1760000000000,
  "date": "2026-10-08",
  "title": "string (may be '' until set; clients show a fallback)",
  "kind": "free" | "guided", "templateId": null | "rose-thorn-bud",
  "mood": null | 1..5,
  "emotions": ["calm", "anxious"],     // lowercase, ≤5, ≤24 chars each (AI-assigned or user-edited)
  "tags": ["work"],                    // lowercase, ≤8, ≤24 chars each
  "summary": "string (1–2 sentences, '' until wrap-up)",
  "status": "open" | "wrapped",
  "private": false,                    // true: excluded from memory, related-entry recall and weekly reports
  "pinned": false,
  "wordCount": 123,                    // words in user messages (derived)
  "messageCount": 4                    // derived
}
// EntrySummary (list endpoints) = Entry + { "preview": "first ~160 chars of the first user message", "snippet"?: "plain-text search excerpt" }

// Message
{ "id": "uuid", "entryId": "uuid", "seq": 0, "role": "user" | "assistant", "content": "string",
  "createdAt": 1760000000000,
  "meta": {                       // free-form, all optional
    "kind": "prompt" | "reply" | "wrapup" | "safety",   // assistant messages; absent on user messages
    "stopped": true,              // generation was cancelled or cut short; content is partial
    "provider": "gemini", "model": "gemini-flash-lite-latest",
    "edited": true } }

// Memory: a short durable fact about the user, always visible, editable and deletable by the user
{ "id": "uuid", "text": "Has a younger sister called Maya", "pinned": false,
  "sourceEntryId": null | "uuid", "createdAt": 0, "updatedAt": 0 }

// Report: AI weekly write-up
{ "id": "uuid", "kind": "weekly", "periodStart": "2026-10-02", "periodEnd": "2026-10-08",
  "content": "markdown-lite text", "createdAt": 0, "meta": { "provider": "gemini", "model": "…", "entryCount": 5 } }
```

### SQL (`src/db/schema.js`)

`PRAGMA journal_mode=WAL; foreign_keys=ON; secure_delete=ON; busy_timeout=5000`; `user_version` migrations (currently version 1; a database written by a newer build is refused untouched with `schema_too_new`).

```sql
entries(rid INTEGER PRIMARY KEY AUTOINCREMENT,            -- stable rowid; doubles as the FTS rowid
        id TEXT NOT NULL UNIQUE, created_at INT, updated_at INT, entry_date TEXT,
        title TEXT DEFAULT '', kind TEXT CHECK IN ('free','guided'), template_id TEXT,
        mood INT CHECK NULL OR 1..5, emotions TEXT /*json*/, tags TEXT /*json*/,
        summary TEXT DEFAULT '', status TEXT CHECK IN ('open','wrapped'),
        private INT CHECK IN (0,1), pinned INT CHECK IN (0,1), word_count INT DEFAULT 0)
messages(id TEXT PRIMARY KEY, entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE, seq INT,
         role TEXT CHECK IN ('user','assistant'), content TEXT, created_at INT, meta TEXT /*json*/,
         UNIQUE(entry_id, seq))
memories(id TEXT PRIMARY KEY, text TEXT, text_norm TEXT /*dedupe key*/, pinned INT,
         source_entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,   -- the fact outlives its entry
         created_at INT, updated_at INT)
reports(id TEXT PRIMARY KEY, kind TEXT, period_start TEXT, period_end TEXT, content TEXT, created_at INT, meta TEXT)
settings(key TEXT PRIMARY KEY, value TEXT /*json; one row, key 'app'*/)
entry_search  -- FTS5(entry_id UNINDEXED, title, body, tags, tokenize='unicode61 remove_diacritics 2', prefix='2 3')
              -- one row per entry (rowid = entries.rid); body = the *user* messages' text; tags = tags + emotions;
              -- rewritten in the same transaction whenever title, messages or labels change
```

Indexes: `entries(created_at DESC, id DESC)`, `entries(entry_date)`, `memories(text_norm)`, `memories(source_entry_id)`, `reports(created_at DESC)`, plus the one `UNIQUE(entry_id, seq)` gives. FTS tables cannot have foreign keys, so the repositories keep `entry_search` in sync themselves. A start-up self-check rebuilds the index if its row count differs from `entries`.

---

## 5. Settings and configuration

Settings are one JSON document (`settings` table, key `app`). Defaults live in `src/settings.js` (`DEFAULT_SETTINGS`). The **internal** shape has raw keys and never leaves the server:

```jsonc
{
  "onboarded": false,
  "profile": { "name": "", "about": "" },                       // name ≤ 80, about ≤ 1000 chars: "things my companion should know"
  "persona": { "id": "companion", "custom": "" },               // id ∈ companion|coach|cbt|stoic|friend|custom ; custom ≤ 1500 chars
  "memory":  { "enabled": true, "autoExtract": true, "useRelatedEntries": true },
  "ai": {
    "enabled": true,
    "provider": "",                                             // "" (none chosen) | "gemini" | "openai" | "local"
    "temperature": 0.7,                                         // 0..2
    "maxTokens": 700,                                           // 64..8192 reply cap
    "contextBudgetTokens": 3000,                                // 500..32000 approximate prompt budget (history + memory)
    "timeoutSec": 180,                                          // 5..600 first-byte timeout (DEFAULT_TIMEOUT_SEC); local cold starts can be slow
    "providers": {
      "gemini": { "baseUrl": "https://generativelanguage.googleapis.com", "model": "gemini-flash-lite-latest", "thinking": "auto", "apiKey": "" },   // thinking: "auto" | "low"
      "openai": { "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini", "apiKey": "" },
      "local":  { "baseUrl": "http://localhost:11434/v1", "model": "llama3.2:3b", "apiKey": "" }
    }
  }
}
```

(`SETTINGS_LIMITS` in `src/settings.js` is the single source for these numbers: model ≤ 200 chars, API key ≤ 512 visible ASCII characters, base URL ≤ 2048.)

**Public** shape (`GET /api/settings`, and the answer to `PUT`): identical, except every `providers.*` object has `apiKey` removed and gains `apiKeySet: boolean`, `apiKeyHint: string` (`"…abcd"`, the last 4 characters; `"…"` for keys shorter than 8; `""` without a key) and `apiKeySource: "settings" | "env" | "none"`.

**PUT** takes a *partial* document that is deep-merged and validated all-or-nothing. In `providers.<id>`, `apiKey: "<string>"` sets the key (whitespace is stripped), `apiKey: null` clears the saved key (the environment then applies again), omitted keeps it. The read-only `apiKeySet` / `apiKeyHint` / `apiKeySource` fields are ignored, so the client can send public settings back unchanged. Unknown keys are dropped, numbers are clamped, strings are trimmed and length-limited, base URLs must be `http(s)://host…` with no credentials, query string or fragment (a trailing slash is removed); failures return `400 invalid_settings` with `fields`. The response is the **public settings as they now stand**, i.e. exactly what the next `GET` and the providers will use. The merge starts from the settings in force (`loadEffectiveSettings`, below), so on a fresh install the first `PUT` writes the environment's seeds into the stored document together with the change.

**Environment.**

* Provider keys: `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `OPENAI_API_KEY`, `LOCAL_LLM_API_KEY`. A key saved in Settings wins; the environment fills the gap; `apiKeySource` says which. Environment keys are never written to the database.
* URL and model seeds: `OPENAI_BASE_URL`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`. They seed only a **fresh install**: no settings document saved yet (`db.settings.exists()` is false). While that holds, `loadEffectiveSettings(db, env)` (`src/server/ai-service.js`) returns the defaults with the seeds applied (an empty or invalid variable is ignored). The first `PUT` writes the document, seeds included; from then on the environment never overrides a stored field, so a person can also choose a built-in default value on purpose (an older rule, "only replace values that still equal the default", put the environment's value back after a restart). Deleting everything *including settings* makes the install fresh again. Consequences: adding `LOCAL_LLM_BASE_URL` later (for example by enabling the compose `ollama` profile on an existing install) has no effect; the address is then set in Settings. Even choosing "Just journal, no AI" on the welcome screen saves the document, so it ends the seeding too.
* Server configuration (`src/config.js`): `PORT` (3210; `0` = any free port), `HOST` (`127.0.0.1`), `JOURNAL_DATA_DIR` (`./data`, resolved against the current directory), `JOURNAL_PASSWORD`, `JOURNAL_ALLOWED_HOSTS` (comma separated `host` or `host:port`; a pasted URL is forgiven), `JOURNAL_INSECURE_ALLOW_NO_AUTH` (`1`, `true` or `yes`). `loadConfig(env, { cwd, overrides })` also yields the internal limits: JSON bodies 1 MB, import 50 MB, SSE ping 15 s, session TTL 30 days, 5 login failures per 60 s, shutdown grace 2 s.
* `.env`: `server.js` calls `process.loadEnvFile()` on `.env` in the current directory if it exists; variables already in the real environment win. Node's own variables (`NODE_USE_ENV_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`) are read before the app starts, so putting them in `.env` is too late (verified).

---

## 6. HTTP API

Everything is under `/api`, JSON in and out (`Content-Type: application/json`) unless stated. **Every non-GET request must carry `X-MyJournal: 1`** (CSRF defence; the browser client adds it). Endpoints marked **SSE** answer `200 text/event-stream` (§7) *after* validation; validation and precondition failures are normal JSON errors **before** the stream starts. `HEAD` is served by the matching `GET`. A path that matches a route with other methods only answers `405 method_not_allowed` with an `Allow` header; an unknown path answers `404 not_found`.

### Auth (meaningful when `JOURNAL_PASSWORD` is set)
| Method | Path | Result |
|---|---|---|
| GET | `/api/health` | `{ ok: true, version }`, public |
| GET | `/api/auth/status` | `{ required, authenticated }`, public |
| POST | `/api/auth/login` `{password}` | `{ ok: true }` + `Set-Cookie: mj_session_<port>=…; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` (+ `Secure` when `X-Forwarded-Proto: https`) · `401 invalid_password` · `400 bad_request` (no password) · `429 rate_limited` with `Retry-After` (5 failures per minute per client address). Without a password configured it answers `{ ok: true }` and sets nothing. |
| POST | `/api/auth/logout` | `{ ok: true }` and clears the cookie |

The session cookie is named `mj_session_<port>` (the port the *server* listens on, so two journals on `localhost` do not sign each other out and the name survives a reverse proxy). When a password is set, every other `/api/*` path answers `401 unauthorized` until a session exists, **including unknown paths** (checked before routing). Static files are public.

### Settings and providers
| Method | Path | Result |
|---|---|---|
| GET | `/api/settings` | public settings (§5) |
| PUT | `/api/settings` (partial) | the public settings as they now stand (on a fresh install the first call stores the env seeds too, §5) · `400 invalid_settings` |
| GET | `/api/providers` | `{ active, providers: [{ id, label, tagline, description, needsKey, keyUrl?, privacyNote, suggestedModels: [{id,label,note?}], presets: [{id,label,baseUrl}], defaultBaseUrl, defaultModel, configured, keySource }] }`. `presets` is `[]` for Gemini, four for `openai` (OpenAI, OpenRouter, Groq, Together), three for `local` (Ollama, llama.cpp, LM Studio). `keySource` is `"env"`, `"settings"` or `"none"` (also `"env"` when `GOOGLE_API_KEY` supplied the Gemini key); the welcome screen reads it to show "Found GEMINI_API_KEY in your environment" (a name, never a key). |
| POST | `/api/providers/test` `{ provider, config?: {baseUrl?,model?,apiKey?} }` | **always 200** for valid input: `{ ok, provider, model, latencyMs?, sample?, error?: {code,message,hint?} }`. `config` overlays the saved settings for this one call (never stored) so people can test before saving; the key is scrubbed from the answer. The first-byte timeout is the configured one, capped at 90 s, except for `local`, which keeps the configured value up to 300 s (its first request loads the model; `testTimeoutCapMs()` in `routes/providers.js`). `400` for an unknown provider. |
| POST | `/api/providers/models` `{ provider, config? }` | `{ ok, models: [{id,label}], error? }`. Timeout capped at 20 s. |
| POST | `/api/providers/local/pull` `{ model, config?: {baseUrl?} }` **SSE** | Ollama only: native `POST {root}/api/pull`, `root` = base URL minus `/v1`. Events `progress {status, completed?, total?, percent?}`, `done {}`, `error`. `409 not_ollama` if `GET {root}/api/version` does not look like Ollama; `409 generation_in_progress` if a download is running; `400` for a bad model name. |

### Catalog
| Method | Path | Result |
|---|---|---|
| GET | `/api/catalog?date=YYYY-MM-DD` | `{ templates: [Template], personas: [{id,name,description}], promptOfTheDay: {id, text} }` |

`Template` = `{ id, title, category: "Daily"|"Mind"|"Growth"|"Creative", description, icon, opening, minutes }` (`guidance` stays server-side).

### Entries
| Method | Path | Result |
|---|---|---|
| GET | `/api/entries?limit=30&before=<createdAt>&beforeId=&q=&mood=&tag=&from=&to=&pinned=1` | `{ entries: [EntrySummary], nextBefore: number \| null }`, newest first. `limit` 1–200. Pages are cut with `db.entries.page()`, so entries that share a `createdAt` are never split across pages: **a page may hold more than `limit` entries** (such a run is read to its end), and `nextBefore` (the last entry's `createdAt`) means "strictly older". With `q`: ranked full-text search, a single page of at most 50 (`nextBefore` is `null`), `snippet` filled, the other filters still apply. `from`/`to` are `YYYY-MM-DD`, inclusive. |
| POST | `/api/entries` `{ kind?, templateId?, title?, mood?, date?, private?, content? }` | `201 { entry, messages }`. A `templateId` makes it `kind: "guided"` and seeds one assistant message (`meta.kind:"prompt"`, the template's `opening`; **no AI call**). `content` also creates the first user message. |
| GET | `/api/entries/:id` | `{ entry, messages }` · `404 not_found` |
| PATCH | `/api/entries/:id` `{ title?, mood?, tags?, emotions?, private?, pinned?, date? }` | `{ entry }` |
| DELETE | `/api/entries/:id` | `204`; aborts a reply being written for it |
| POST | `/api/entries/:id/messages` `{ content }` | `201 { message, entry }`: appends a **user** message (no AI). Blank → `400`; more than 20 000 characters → `413 payload_too_large`. |
| PATCH | `/api/entries/:id/messages/:mid` `{ content }` | `{ message, entry }` (sets `meta.edited`) |
| DELETE | `/api/entries/:id/messages/:mid` | `{ entry }` |
| POST | `/api/entries/:id/reply` `{ regenerate?, today? }` **SSE** | AI reply to the conversation as it stands (the web client always sends `today`). Preconditions, in this order, as JSON errors: `404 not_found`, `409 ai_disabled`, `409 ai_not_configured`, `409 generation_in_progress`, `409 nothing_to_reply_to` (the last message is not the user's and `regenerate` is false). `regenerate: true` first deletes the trailing assistant `reply` (only once every refusal is behind it). |
| POST | `/api/entries/:id/wrap-up` `{ today? }` **SSE** | Closing reflection + metadata + memories (§7). Same preconditions. |
| GET | `/api/entries/:id/export.md` | `text/markdown` attachment |

### Memories
| Method | Path | Result |
|---|---|---|
| GET | `/api/memories` | `{ memories: [Memory] }` (pinned first, then newest) |
| POST | `/api/memories` `{ text, pinned? }` | `201 { memory }` (text ≤ 300 characters) |
| PATCH | `/api/memories/:id` `{ text?, pinned? }` | `{ memory }` |
| DELETE | `/api/memories/:id` | `204` |
| POST | `/api/memories/clear` | `{ ok: true, removed }` |

### Insights
| Method | Path | Result |
|---|---|---|
| GET | `/api/insights/overview?today=YYYY-MM-DD&days=90` | see below (`days` 1–3660) |
| GET | `/api/insights/reports` | `{ reports: [Report] }` newest first |
| POST | `/api/insights/weekly` `{ today?, days? = 7 }` **SSE** | `days` 1–366. `409 ai_*` as above, `422 not_enough_entries` if the window has no non-private entry; events `delta`, `done {report}` |
| DELETE | `/api/insights/reports/:id` | `204` |

```jsonc
// overview: streak and totals cover all entries (private ones too); the rest only the last `days` days
{ "today": "2026-10-08",
  "streak": { "current": 3, "longest": 12, "lastEntryDate": "2026-10-08" },   // current counts if the last entry day is today or yesterday
  "totals": { "entries": 40, "words": 18000, "daysWritten": 31, "wrapped": 22 },
  "mood":   { "average": 3.6 | null, "series": [{ "date": "2026-10-01", "avg": 3.5, "count": 2 }] },   // only days with a mood
  "calendar": [{ "date": "2026-10-01", "count": 2, "words": 340 }],            // only days with entries
  "emotions": [{ "name": "calm", "count": 7 }],                                 // top 10
  "tags":     [{ "name": "work", "count": 5 }] }                                // top 10
```

### Data
| Method | Path | Result |
|---|---|---|
| GET | `/api/data/stats` | `{ entries, messages, memories, reports, dbBytes }` |
| GET | `/api/data/export?format=json\|markdown` | attachment `myjournal-export-YYYY-MM-DD.json\|.md`. JSON: `{ app:"myjournal", version:1, exportedAt, entries:[{...Entry, messages:[Message]}], memories:[], reports:[] }`; private entries are included; settings and keys **never** are. |
| POST | `/api/data/import` (export JSON as the body, ≤ 50 MB) | `{ imported: {entries,messages,memories,reports}, skipped }`: merges by id, skips what exists, validates every field, executes nothing. |
| POST | `/api/data/wipe` `{ confirm: "DELETE", includeSettings?: boolean }` | `{ ok: true }`; aborts running generations first |

### Error codes
Every error is `{ error: { code, message, hint?, fields? } }`.

| Status | Codes |
|---|---|
| 400 | `bad_request` (malformed JSON, bad field, bad path), `invalid_settings` (+ `fields`) |
| 401 | `unauthorized`, `invalid_password` |
| 403 | `forbidden_origin` (missing `X-MyJournal`, cross-site `Origin` or `Sec-Fetch-Site`), `forbidden_host` |
| 404 / 405 | `not_found`, `method_not_allowed` (+ `Allow`) |
| 409 | `conflict`, `generation_in_progress`, `nothing_to_reply_to`, `ai_disabled`, `ai_not_configured`, `not_ollama` |
| 413 | `payload_too_large` (a message over 20 000 characters, a JSON body over 1 MB, an import over 50 MB) |
| 422 | `not_enough_entries` |
| 429 | `rate_limited` (+ `Retry-After`) |
| 500 | `internal_error` (anything unexpected; details only in the server's terminal, never in the response) |
| 408 / 431 / 400 | `request_timeout`, `header_too_large`, `bad_request`: answered by the socket-level handler for requests Node rejects before routing; they still carry the security headers |

Plus the **provider error codes** of §9, which appear only inside SSE `error` events and `/api/providers/*` bodies.

---

## 7. Streaming protocol (reply, wrap-up, weekly reflection, model download)

`POST` + `fetch` streaming (not `EventSource`). Frames are `event: <name>\ndata: <single-line JSON>\n\n`. A `: ping` comment frame goes out every 15 s. Headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `X-Accel-Buffering: no`, `Connection: keep-alive`. A client that stops reading (more than 8 MB queued) is treated as gone.

| event | data | when |
|---|---|---|
| `notice` | `{ kind: "safety", text, message }` or `{ kind: "warn", text }` | `safety`: crisis phrases were detected in the person's latest message; sent first; `message` is the persisted static assistant message (`meta.kind:"safety"`). `warn`: a best-effort step failed ("Saved without an automatic title or summary: …"); the client shows a toast. |
| `phase` | `{ name: "reflection" \| "metadata" \| "memory" }` | wrap-up progress; `memory` only when that step will run |
| `delta` | `{ text }` | streamed assistant text |
| `entry` | `{ entry }` | entry metadata changed (title, summary, emotions, tags) |
| `memories` | `{ added: [Memory] }` | **only when the memory step added something** |
| `done` | reply: `{ message, entry }` · wrap-up: `{ message, entry, memories }` · weekly: `{ report }` · download: `{}` | success; the persisted objects |
| `error` | `{ error: { code, message, hint? } }` | failure after the stream started; the stream ends |

**What is persisted when a stream ends early.**

* *Reply.* The person's message is already saved. Text received before a client abort, a server shutdown or a provider failure is saved as an assistant message with `meta.stopped = true` (after the same clean-up as a finished reply; nothing is saved when it is empty). A provider failure additionally sends an `error` event. A model that returns nothing at all sends `error` (`empty`) and saves nothing.
* *Wrap-up and weekly reflection.* **Partial output is not persisted.** A half-written closing reflection or report is dropped: a stopped or failed closing reflection leaves the entry unwrapped, and a stopped or failed weekly run saves no report. Once the reflection itself is saved, stopping only skips the remaining metadata and memory steps and the entry still counts as wrapped.
* *Download.* Ollama keeps what it fetched; the next run resumes.

**Cancellation.** The client aborts the `fetch`; the server aborts the upstream request and releases the lock. Only **one** generation per key runs at a time: reply and wrap-up share `entry:<id>`, the weekly reflection is `job:weekly`, a model download `job:pull`; a second request is `409 generation_in_progress`.

**Care message.** If the latest message shows crisis phrases (`src/journal/safety.js`, conservative, multi-word patterns), the static region-neutral care message is saved right after it as an assistant message with `meta.kind:"safety"`, **even when the AI is unavailable**; the model prompt also gets a line asking it to put care first. Safety messages are left out of what is sent to the model.

**Wrap-up pipeline** (strictly sequential: free-tier rate limits, small local machines):

1. `phase reflection`: stream the closing reflection, persist it as `meta.kind:"wrapup"`. Failure or abort here ends the job as described above.
2. `phase metadata`: one small non-streamed call (temperature 0.2, ≤ 160 tokens, the person's own text only). The summary is stored; the title only when the person has not set one; emotions and tags only when empty. Fallbacks come from the person's text when the model output is unusable. Sends `entry`.
3. `phase memory`, only if `memory.enabled && memory.autoExtract && !entry.private`: one small call (the person's text plus up to 12 known memories to avoid repeats) → 0–3 facts, deduplicated; sends `memories` when any were added.

Steps 2 and 3 are best effort: a failure becomes a `warn` notice and never fails the wrap-up. Finally `entry.status = "wrapped"` and `done`. Wrapping up again adds a further reflection.

**Weekly reflection.** The window is `days` ending at `today` (inclusive); private entries are excluded; at most 200 entries are described (title, summary or a ~300-character excerpt, mood, emotions, tags). The reply cap is at least 600 tokens, whatever the setting.

---

## 8. Journal logic (`src/journal/*`, pure, synchronous, unit-tested)

```js
// tokens.js
estimateTokens(text) -> number          // Latin text: ceil(chars / 3.5), deliberately high (measured 20-35 % above the real count);
                                        // CJK/Thai/Hangul count 1 token per character, Cyrillic/Greek/Arabic/Indic ½, each emoji 2
// text.js     cleanText, oneLine, truncate, truncateMiddle, firstWords, normalizeLabels, wordCount, extractKeywords, splitSentences, firstSentences
// dates.js    parseDateString, addDays, diffDays, formatLongDate, … (all on 'YYYY-MM-DD', no time zones)
// personas.js PERSONAS (companion, coach, cbt, stoic, friend), CUSTOM_PERSONA, getPersona, publicPersonas, resolvePersonaPrompt({id, custom})
// templates.js TEMPLATES (12), TEMPLATE_CATEGORIES, getTemplate, publicTemplate, templateStep(t, userTurns), promptOfTheDay(dateStr) (deterministic per date), allPrompts
// safety.js   detectCrisis(text) -> { flagged, matches[] } ; crisisNotice() -> static text (988 for the US, findahelpline.com elsewhere)
// language.js detectLanguage(text) -> { code, name } | null : en, es, fr, de, pt, it, nl by stopword scoring (plus accent hints), ja, zh, ko by script;
//             null for short or unclear text and for scripts it does not name (Cyrillic, Arabic, …). languageName(text); LOCALIZED = { code: { closing, weeklyLead } }
//             (the closing cue and the weekly seed in en, es, fr, de, pt, it, nl, ja, zh, ko)
// context.js  prompt builders (below)
// tasks.js    tolerant parsers for model output (below)
// insights.js computeStreaks(dates, today), computeOverview({ entries, today, days }) (shape in §6)
```

```js
// context.js: every builder returns { messages: [{role:'system'|'user'|'assistant', content}], debug: {approxTokens, budget, droppedMessages, memoriesUsed, relatedUsed, compact, truncatedLastUser, ...} }
buildReplyMessages({ settings, entry, messages, memories, related, now, providerId, templateGuidance, crisis })
buildWrapUpMessages(sameArgs)          // always ends with the closing cue (closingCue(language), written as the user): a user turn after an assistant turn, else appended to the user's last turn
closingCue(language) / WRAPUP_CUE / RELATED_HEADER   // exports
buildMetaMessages({ entry, messages, settings })                      // the person's own text only
buildMemoryMessages({ entry, messages, existingMemories, settings })  // the person's text + known facts ("do not repeat")
buildWeeklyMessages({ entries, memories, settings, periodStart, periodEnd })
TASK_SAMPLING   // { meta: {temperature 0.2, maxTokens 160}, memory: {…same} }
// tasks.js
parseMeta(text, { fallbackTitle, userText, firstMessage }) -> { title, summary, emotions[], tags[] }   // "Title: …\nSummary: …\nEmotions: a, b\nTags: x, y" with fuzzy fallbacks;
                                       // drops the prompt's placeholders (<2 to 6 words>, "separated by commas") and the old example; markup like <img src=x> is kept as text;
                                       // fallback titles lose template labels ("Situation:") and are cut at a clause or word
parseMemoryLines(text, { existing, userText, userName }) -> string[]   // "- fact" lines; drops "none", duplicates, echoed examples (MEMORY_EXAMPLES stays only as a guard: a near copy
                                       // survives only if every distinctive word is in the entry), what the writer is doing now, diary events, scenes, sentences copied from the entry,
                                       // lines in the writer's voice or addressed to the writer; ≤ 3, ≤ 200 chars
cleanReply(text) -> string             // strips <think>, role prefixes ("Assistant:"), wrapping code fences, trailing whitespace
```

**Task marker (contract).** The *system* message of every call built by `context.js` starts with a first line `TASK: reply` | `TASK: wrapup` | `TASK: meta` | `TASK: memory` | `TASK: weekly`. It costs a few tokens, helps debugging and lets the mock servers answer each task in the right format.

**Label formats.** `meta`: exactly four lines, `Title: …` / `Summary: …` / `Emotions: a, b, c` / `Tags: x, y`; the prompt shows them as placeholders (`Title: <2 to 6 words>`), never with an example, and the user message ends with a one-line reminder (`Now write the four lines (Title, Summary, Emotions, Tags) for this entry.`, plus `Keep the four labels in English and write the rest in Spanish.` for a detected non-English entry). `memory`: bullet lines `- fact` (`Write each fact as: - <short fact>.`, no example facts), or the single word `none`; a detected language adds `Write the facts in Spanish.` `weekly`: plain paragraphs, optional `**Bold**` lead-ins and `- ` bullets (rendered by the client's markdown-lite). `reply` / `wrapup`: plain prose (markdown-lite allowed).

**Templates** (ids are fixed): `rose-thorn-bud`, `gratitude`, `morning-intention`, `evening-reflection`, `thought-record`, `worry-dump`, `self-compassion`, `goals-checkin`, `relationship-reflection`, `dream-journal`, `weekly-review`, `decision-helper`. `icon` must be one of `ICON_NAMES` exported by `public/js/lib/ui.js` (a unit test enforces it).

**Prompt design rules** (they matter for 1B–3B models; every one below was measured on real models, see [PROVIDERS.md](PROVIDERS.md#how-well-small-models-follow-the-rules)): the base system prompt is small (measured with the default persona and today's date: about 370 estimated tokens for a reply, 445 for a wrap-up, 165 for the title step plus about 25 in its user message, 180 for the memory step, before your name, About text, memories and related entries are added; the estimator over-counts by 20–35%, so real sizes are about a quarter lower); imperative bullet rules; exactly one question per reply; 2–4 sentences; no lists unless asked; never diagnose; one task per call; labelled plain-text lines instead of JSON for metadata and memory (temperature forced to 0.2).

* *Reply rules:* "Reply in 2 to 4 short sentences of plain prose…", "Respond to what the user just wrote, then ask exactly ONE open follow-up question. Your last sentence is that question.", "Write in the language the user writes in." (when `detectLanguage` finds a language other than English: "Write in Spanish, the language the user writes in."; English keeps the neutral line because naming it made qwen3:1.7b ask two questions more often), "Do not diagnose…", **"Profile notes, memories and earlier entries are background: mention one only when it directly relates to what the user just wrote."**, **"Do not invent details (times, places, events) that the user did not mention."**, "Do not bring up being an AI unless asked. Never claim to be human.", and the danger rule. A free-write prompt no longer says "This is a guided session." (the guidance object is always truthy; its text decides).
* *Wrap-up rules:* "The session is ending now… write a short closing reflection instead.", 3 to 5 sentences, no question, **"Speak to the user as "you", like a companion. Never write as if you were the user."**, name a feeling and one specific thing they wrote, a strength or insight, background only when it clearly connects ("Call an earlier entry an earlier entry, and never present background as something the user said today."), no invented details, a kind closing line. The last user turn is the **closing cue**, written as the user and localised: English "That is all for now. Please write your closing reflection to me now, speaking as my companion and addressing me as "you". Write 3 to 5 sentences." (Spanish, French, German, Portuguese, Italian, Dutch, Japanese, Chinese and Korean have their own; an unknown language gets the English cue plus "Use the language I have been writing in.", a detected one without a translation plus "Write it in <Language>."). Before these changes, 9 of 22 reflections from llama3.2:1b and 10 of 22 from qwen3:1.7b came back in the user's voice or about "Sam" (read by hand); after, 0 and 0.
* *Labels.* Hosted providers: "Background about Sam (do not mention it unless it is relevant): <about>" and "Possibly relevant past entries (background; mention one only if it clearly connects, and call it an earlier entry):". Local providers keep the plain "About Sam: <about>" and "Possibly relevant past entries (use only if they genuinely connect):" (the long labels made small models end with one question less often). The memory block stays "Things you know about Sam:" everywhere.
* *Weekly:* the user message ends with a seeded opening in the entries' language ("Write my weekly reflection now, as my companion. Start exactly with: "**How the week felt.** In these entries, you""), which fixed the wrong voice (4 of 8 and 7 of 8 before, 0 after, on llama3.2:1b and qwen3:1.7b). The seed names no period because a report can cover 14 or 30 days.
* *Meta and memory* show placeholders instead of examples (a 1B model copied the example in 15 of 17 entries); `MEMORY_EXAMPLES` and `META_EXAMPLE` survive in `tasks.js` only as a guard.
* `debug` gains `cue` (wrap-up: the closing cue was added) and `language` (the code that was named, or null).

**Budget.** The prompt is kept within `settings.ai.contextBudgetTokens` (as estimated above). When it does not fit, in this order: related-entry lines go (least relevant first), then memory lines (unpinned before pinned, oldest first), then the oldest conversation turns, then a shorter system prompt (compact, then minimal), and finally the middle of the latest message. **For `local` the oldest turns are dropped in blocks**: the first kept turn is rounded up to a multiple of a block size counted from the start of the conversation (8 when that costs at most 40% of what fits, else 4 or 2), so the same first message is sent for several requests and Ollama's / llama.cpp's cached prompt prefix stays valid (llama3.2:1b, 30 turns, budget 3,000: median reply 8.8 s and 9.8 s with 14% of the prompt reused when one turn was dropped per request, 2.8 s and 2.7 s with 76% reused with blocks). More is dropped, never less: the budget is still honoured and the latest message is never touched. Hosted providers still drop one turn at a time. An assistant message with `meta.stopped` shorter than 20 characters is left out of the context altogether. One huge old turn is shortened up front so it cannot push every other turn out. The memory block is capped at 600 tokens and 20 % of the budget, the related-entry block at 700 tokens and 25 %; they hold at most 8 memories and 2 related entries for `local`, 20 and 4 otherwise. Consecutive same-role turns are merged; `meta.kind === "safety"` messages are omitted.

---

## 9. Provider layer (`src/providers/*`)

```js
// index.js
createProvider(id, cfg, { fetch?, sleep?, idleTimeoutMs? }) -> Provider      // cfg = resolved config; fetch/sleep injectable for tests
describeProviders(env) -> catalog rows for GET /api/providers (without `configured`)
// config.js
resolveProviderConfig(id, settings, env) -> { id, baseUrl, model, apiKey, keySource, thinking?, timeoutMs, temperature?, maxTokens? }
// Provider
{ id, label,
  stream(req) -> AsyncGenerator<{type:'delta', text} | {type:'done', finishReason, usage?}>,
  chat(req)   -> Promise<{ text, finishReason, usage? }>,           // drains stream()
  listModels({signal}) -> Promise<[{id,label}]>,
  test({signal}) -> Promise<{ ok: true, model, latencyMs, sample }>, // throws ProviderError on failure
  isOllama(), pullModel({model, signal}) }                          // local provider only
// req = { messages:[{role,content}], temperature?, maxTokens?, signal?: AbortSignal, timeoutMs? }
```

`ProviderError` (`errors.js`): `{ name, code, message (user-friendly), hint?, status?, retryAfterMs?, provider, detail?, cause? }`. Codes: `auth`, `rate_limit`, `quota`, `model_not_found`, `bad_base_url`, `network`, `timeout`, `blocked`, `context_too_long`, `bad_request`, `server`, `overloaded`, `region`, `empty`, `unknown`. A caller abort throws the standard `AbortError` (`err.name === 'AbortError'`), **not** a `ProviderError`. Messages are actionable and **never contain the API key**: the key and its URL-encoded form are scrubbed from the message, hint, detail and the sanitised `cause`. The user-facing wording of every code is tabulated in [PROVIDERS.md](PROVIDERS.md#troubleshooting-every-error-code).

### Shared HTTP behaviour
Node's global `fetch` ignores `HTTPS_PROXY` unless the process runs with `NODE_USE_ENV_PROXY=1` (Node 22.21+; verified: the variable must be in the real environment, `.env` is too late, and `NO_PROXY` must list `localhost,127.0.0.1` or local-model traffic goes to the proxy too). We do not re-implement proxying; the docs tell people to set it. The first-byte timeout is `timeoutMs` (settings `timeoutSec`, default 180 s, one number for every provider via `DEFAULT_TIMEOUT_SEC` in `src/settings.js`; Node/undici itself gives up on response headers after 300 s, so more cannot be honoured); the idle timeout between chunks is 60 s; both produce `timeout` (for local models the hint says the first request loads the model and that giving up cancels the load). A network failure becomes `network` with a hint naming the URL that was tried (and, for `local`, "Is Ollama running? Start it with `ollama serve`…"); certificate problems mention `NODE_EXTRA_CA_CERTS`. **One** automatic retry for a `429` or `503` whose wait is ≤ 8 s (1 s if the server named none); never after any text was emitted, and **not when the failed attempt itself took longer than 8 s** (`MAX_AUTO_RETRY_WAIT_MS`; `sendWithPolicy` times each attempt with an injectable clock): a Gemini 503 that took 15 s to arrive would double the wait before the error, and the retry never succeeded in the 3 pairs observed live. Up to two (local: three) *self-healing* retries after a `400` that names a parameter (below).

### OpenAI-compatible adapter (`openai` + `local`)

* **Address.** Trimmed, trailing `/` and a trailing `/chat/completions` removed; a bare host gets `/v1` for `local` and for `api.openai.com`. Credentials, a `?query` and non-http(s) schemes are rejected (`bad_base_url`). The request goes to `${base}/chat/completions`.
* **Headers:** `Content-Type: application/json`, `Accept: text/event-stream`, `Authorization: Bearer <key>` only if a key exists.
* **Body:** `{ model, messages, stream: true, temperature, <token param>, stream_options: { include_usage: true } }`, plus `reasoning_effort: "none"` for `local` only (live-verified against Ollama 0.40.1 and llama.cpp: a qwen3:1.7b journal reply takes 3.7–4.7 s instead of 8–14 s; other models ignore it). The token parameter is `max_completion_tokens` for host `api.openai.com` and `max_tokens` everywhere else (Ollama silently ignores `max_completion_tokens`).
* **Self-healing on `400`:** if the error text names the token parameter, flip it; `temperature` or `stream_options`, drop it; `reasoning_effort` or "think", drop it. What worked is remembered per `provider|base|model` for the life of the process.
* **Reading the answer (`sse.js`, `common.js`).** Handles `\r\n`, chunk boundaries inside lines and UTF-8 sequences, `: comments`, `data: [DONE]`, and servers that answer with one JSON document instead of a stream. Text is `choices[0].delta.content`; `reasoning_content` / `reasoning` are ignored; finish is `choices[0].finish_reason`; usage comes from the last chunk. `think-filter.js` strips `<think>…</think>` (and `<thinking>`, `<reasoning>`) blocks even when the tags split across chunks and trims the whitespace after a removed block. A stream that ends inside an unfinished `<think>` with nothing emitted is `empty` ("the model spent its whole token budget thinking…"). A page or plain text where an API reply should be is `bad_base_url`.
* **Error mapping.** Redirects → `bad_base_url`; `413` or context-overflow wording (`context_length`, `maximum context`, `exceeds the available context size`, …; the hint quotes the two token numbers when the server gives them) → `context_too_long`; `401`/`403` → `auth` (a `403` about country/region → `region`); `404` → `model_not_found` if the body names the model, else `bad_base_url`; `408` → `timeout`; `402`, or `429` with `insufficient_quota` / billing wording → `quota`, any other `429` → `rate_limit` (honours `retry-after`, `retry-after-ms`); out-of-memory wording from a local server → `server` ("The model does not fit in this computer's memory"); `529` → `overloaded`; other `5xx` → `server`; other `4xx` → `bad_request`; a refusal to connect or DNS failure → `network`; a port that `fetch` refuses (the WHATWG "bad ports": 1, 7, 9, …, 6000, 6665–6669, 10080, …; the error cause is `bad port`) → `bad_base_url` "That port is blocked." with a hint naming the port from the address ("Start the model server on another port, then change the address in Settings."); an empty successful stream → `empty`; `content_filter` with no text → `blocked`.
* **`listModels`:** `GET ${base}/models`, ids sorted naturally (not Ollama's newest-first order); `{data}`, `{models}` and bare arrays are understood; a `.gguf` path id (llama.cpp) is labelled with its file name.
* **`test`:** one tiny streamed request (16 tokens, "Reply with the single word: OK"); succeeds on any 2xx that answered like an API even if the sample is empty (reasoning models).
* **Ollama helpers.** `isOllama()` = `GET {root}/api/version` returns `{version}`; `pullModel()` = `POST {root}/api/pull` (NDJSON). Errors are mapped to plain words: registry unreachable (`network`), unknown model (`model_not_found`), disk full or Ollama too old (`server`). Model names must match `[\w.:/@+-]{1,200}` without `..`.

### Gemini adapter (native REST)

* **Request.** `POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse`, header `x-goog-api-key` (never `?key=`; the header is confirmed honoured). A `/v1beta` or `/v1` suffix on the base URL is stripped. Model ids lose a leading `models/` and are URL-encoded.
* **Body.** `{ systemInstruction: { parts: [{text}] }, contents: [{ role: 'user'|'model', parts: [{text}] }], generationConfig: { temperature, maxOutputTokens, thinkingConfig? } }`. System messages are joined into `systemInstruction` (folded into the first user turn for a model that rejects it). Empty messages are dropped and consecutive same-role turns merged.
* **Turn rules (live-verified).** A conversation may **start** with a `model` turn (a guided journal's opening): it is sent as is. One that **ends** with a model turn is rejected by Google (`400 "Requests ending with a model turn are not supported."`), and an empty text part gives `400 "Request has empty input."`. So the adapter drops empty messages and, when the last remaining turn is a model turn or nothing is left, throws `bad_request` ("There is nothing to reply to yet.") without calling the API.
* **Thinking (live-verified).** `cfg.thinking` is `"auto"` (default) or `"low"`. `auto` sends **no** `thinkingConfig`. Because thought tokens count against `maxOutputTokens` (observed: 189 of 200 tokens spent thinking, reply cut off with `finishReason: MAX_TOKENS`), every request sends `maxOutputTokens = requestedMaxTokens + 2048` (at most 8192); reply length is steered by the prompt, not the cap. `low` sends `thinkingConfig: { thinkingLevel: "low" }` (accepted by 3.x models); a `400` mentioning thinking (or the bare "Request contains an invalid argument.") retries once without it and remembers that per model while the process runs. **Never** sent: `thinkingBudget: 0` (rejected by 3.x lite) and `thinkingLevel: "minimal"` (rejected by `gemini-3.8-flash`). Parts with `thought: true` are never emitted.
* **Reading the answer.** SSE frames are `data: {json}\r\n\r\n`; short answers arrive in 2–5 frames, the last carrying `finishReason` and `usageMetadata` (`thoughtsTokenCount` only when it thought), so streaming a journal-length reply arrives in few large chunks and the UI must look good regardless. Text is `candidates[0].content.parts[].text`. `promptFeedback.blockReason` or `finishReason ∈ {SAFETY, PROHIBITED_CONTENT, BLOCKLIST, SPII, IMAGE_SAFETY, RECITATION}` with no text → `blocked`; `MAX_TOKENS` with no text → `empty` (hint: thinking used the budget).
* **Error mapping.** Errors arrive as `{ error: { code, status, message, details: [ErrorInfo{reason}, RetryInfo{retryDelay}, QuotaFailure{violations}] } }`. Every error on the streaming method other than the two key errors comes back as `text/event-stream` with a plain JSON body; a bare `[{error}]` array is understood. Live-verified: an **invalid key is HTTP 400 `API_KEY_INVALID`**, a **missing key is HTTP 403 `PERMISSION_DENIED` "Method doesn't allow unregistered callers"** (both → `auth`, the second with the hint "no API key was sent"); unknown model `404 NOT_FOUND` and retired model `404 "…is no longer available to new users. Please update your code to use models/gemini-3.8-flash…"` (both → `model_not_found`, the second quoting Google's suggestion); overload `503 UNAVAILABLE` "currently experiencing high demand" → `overloaded` (hint: switch to `gemini-flash-lite-latest` in Settings, or just try again when already on a Lite model). From Google's documented format, not provoked live: `RESOURCE_EXHAUSTED`/`429` → `rate_limit` (waits `retryDelay`) or, for a per-day quota or `limit: 0`, `quota`; `FAILED_PRECONDITION` about location → `region`; restricted or disabled keys → `auth`; token-count wording → `context_too_long`; other `400` → `bad_request` with Google's message.
* **`listModels`.** `GET {base}/v1beta/models?pageSize=1000`, following `nextPageToken` (≤ 5 pages). Live: the field is `supportedGenerationMethods`, 62 entries on one page; the list holds many non-chat ids (`lyria-*`, `deep-research-*`, `*-tts`, `*-image*`, `nano-banana*`, transcribe, omni, robotics, computer-use, customtools, embeddings, imagen, veo, …) **and retired chat models that answer 404**. So the adapter keeps ids matching `^(gemini|gemma)-`, drops ids matching `/embed|aqa|imagen|veo|tts|image|banana|live|audio|transcribe|omni|robotics|computer-use|customtools|learnlm|lyria/`, requires `generateContent` (entries without the field are kept), strips `models/`, labels with `displayName || id`, and sorts `*-latest` aliases first, then newest first, with Gemma models last. Retired models still in the list are handled at request time.
* **`test`:** as for OpenAI-compatible.
* **Free tier note** (shown in the UI): prompts and responses on the free tier may be used by Google to improve its products and reviewed by humans; billing-enabled projects are not. Do not journal secrets with it.

**Live-verified facts (2026-10-08, free-tier key; raw responses in `test/fixtures/gemini-live/`).** Numbering is cited from source comments.
1. **Default model `gemini-flash-lite-latest`** (currently → `gemini-3.5-flash-lite`: about 1 s to the first byte, does not think by default, best free quota). `gemini-flash-latest` (→ `gemini-3.8-flash`) is "smarter but slower/busier": all 6 default-mode requests answered `503 "high demand"` (after 1–15 s), the one `low` request that got through took 23 s to the first byte. Suggested in the catalog: `gemini-flash-lite-latest` ("Fast — recommended"), `gemini-flash-latest` ("Smarter, can be slow or busy"), `gemini-3.5-flash-lite`, `gemini-3.5-flash`.
2. **Thinking:** `auto` (default) / `low`, as above; never `thinkingBudget: 0` or `minimal`.
3. **Turn rules:** may start with a model turn; must not end with one; no empty text.
4. **`models.list`:** allow-list `^(gemini|gemma)-` minus the non-chat families, as above; `gemma-4-*` works with `systemInstruction`, reasons by default and rejects any `thinkingLevel`.
5. **Error codes seen:** bad key `400 API_KEY_INVALID`; no key `403 PERMISSION_DENIED`; unknown and retired model `404 NOT_FOUND`; overload `503 UNAVAILABLE`, arriving after 1–15 s (hence the retry rule above). A `429` could not be provoked.
6. **Streaming shape:** `data: {json}\r\n\r\n` frames, few big chunks.

### Catalog copy (`describeProviders`)
* gemini: "Free Gemini API", tagline "Free key from Google AI Studio", `keyUrl: https://aistudio.google.com/apikey`, the suggested models above, the privacy note above, no presets.
* openai: "OpenAI-compatible API", tagline "OpenAI, OpenRouter, Groq, Together, DeepSeek, …"; suggested `gpt-4o-mini`; presets OpenAI `https://api.openai.com/v1`, OpenRouter `https://openrouter.ai/api/v1`, Groq `https://api.groq.com/openai/v1`, Together `https://api.together.xyz/v1`.
* local: "Self-hosted small LLM", tagline "Runs on your machine — nothing leaves it"; presets Ollama `http://localhost:11434/v1`, llama.cpp `http://localhost:8080/v1`, LM Studio `http://localhost:1234/v1`; suggested `llama3.2:1b` (~1.3 GB, plumbing tests), `qwen2.5:1.5b`, `gemma2:2b`, `llama3.2:3b` (better quality), `smollm2:1.7b`.

---

## 10. Server (`src/server/*`)

* `createApp({ config, db, fetch? }) -> { server, auth, generations, db, url, port, listen(), close() }`. No global state, so tests start many instances on port 0. `listen()` resolves `{ port, host, url }` and rejects with a `ListenError` that has a hint (`EADDRINUSE`, `EACCES`, `EADDRNOTAVAIL`); `close()` stops accepting, aborts running generations (their partial replies are saved), closes idle connections and, after a 2 s grace period, all of them.
* **Request pipeline** (`app.js`), for every request:
  1. security headers on the response; the target must be a plain path (`400 bad_request` otherwise);
  2. `Cache-Control: no-store` on `/api/*`;
  3. the **Host allow-list** (`security.hostCheckEnabled`, below);
  4. for `/api/*`: the **CSRF check**, then `handleApi`: **auth** (`401`) → route match (`404`, `405`) → handler. Static paths: `static.js`.
  Errors thrown anywhere become `{ error }` bodies; anything that is not an `HttpError` or a known `DbError` is logged to the terminal and answered as `500 internal_error`. A body that was not read forces `Connection: close`.
* **Security (`security.js`).**
  1. *Response headers on everything:* `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy: microphone=(self), camera=(), geolocation=()`, `X-Frame-Options: DENY`; `/api/*` also `Cache-Control: no-store`. No CORS header is ever sent.
  2. *Host allow-list* (DNS-rebinding defence): `localhost`, `127.0.0.1`, `[::1]` (any port), the address given as `HOST` (unless it is a wildcard such as `0.0.0.0`) and the `JOURNAL_ALLOWED_HOSTS` entries (a bare name allows any port, `name:port` only that port). It is **enforced whenever no password is set, and also when a password is set but the server listens on a loopback address** (a web page that rebinds its own domain to 127.0.0.1 would otherwise only have the password in its way). It is **off only for a non-loopback bind with a password**, where the password is the protection and the server cannot know its public names. A violation is `403 forbidden_host`.
  3. *CSRF:* a non-`GET`/`HEAD`/`OPTIONS` `/api` request needs `X-MyJournal: 1`; if an `Origin` header is present its scheme/host/port must equal the `Host` header (or the first `X-Forwarded-Host`, for proxies that rewrite `Host`); `Sec-Fetch-Site: cross-site` is refused. Failures are `403 forbidden_origin`.
  4. *Startup rule:* a non-loopback `HOST` without `JOURNAL_PASSWORD` is refused unless `JOURNAL_INSECURE_ALLOW_NO_AUTH` is set. The refusal prints the reason and exits with status 1.
* **Auth (`auth.js`).** The password is compared as SHA-256 digests with `crypto.timingSafeEqual` (≤ 4096 characters). A session is 32 random bytes (base64url) held in memory as a hash with a 30-day expiry (at most 1000 live sessions, oldest dropped first); a restart signs everyone out. Cookie `mj_session_<port>`: HttpOnly, SameSite=Strict, Path=/, Max-Age 30 days, `Secure` only when the request came with `X-Forwarded-Proto: https`. A new login replaces the old session. Failed logins: sliding window of 5 per 60 s per client address, taken from the socket (`::ffff:a.b.c.d` and `a.b.c.d` are the same client); `X-Forwarded-For` is not consulted, so behind a reverse proxy all visitors share one counter (verified).
* **Static files (`static.js`).** Serves `public/`; an extension-less path that matches no file gets `index.html` (single-page app), an unknown path with an extension is `404`. One round of percent-decoding, then segments must be plain: no `..`, `.`, empty segments, backslashes, NUL/control characters or `:`; dot files are `404`; the resolved real path must stay inside `public/`. Correct MIME types, `Cache-Control: no-cache` with `ETag` / `Last-Modified` (`304` supported). Only `GET`/`HEAD` (`405` otherwise).
* **AI service (`ai-service.js`).** `loadEffectiveSettings(db, env)` is the one place that decides which settings are in force: the stored document, or on a fresh install (`!db.settings.exists()`) the defaults plus the environment's URL/model seeds (§5); `server.js` uses it for the banner and `loadSettings()` for everything else. `getProvider(settings, env)` → `{ provider, cfg }` or `409 ai_disabled` / `409 ai_not_configured`; `buildWithOverlay(id, overlay, { timeoutCapMs })` for Test connection / Load models without saving. `providerRows` adds `configured` and the effective `keySource` to the catalog.
* **Generation (`generation.js`).** Per-key locks (§7), abort wiring (`res.on('close')` while the response is unfinished aborts the job), partial persistence, SSE error mapping. The preconditions run in the order given in §6.
* **Request log.** One line per request: `METHOD /path status ms`, path only (no query string, so search words are not logged), printable ASCII only, never bodies, headers or keys; quiet in tests (`config.quiet`). Warnings and errors go to stderr; `unhandledRejection` is logged and does not stop the process; writes to a closed pipe (`npm start | head`) are ignored.
* **Start-up and shutdown (`server.js`).** `server.js` imports only `src/server/node-version.js` statically and checks the Node version **first**: on anything older than 22.13 it prints `MyJournal needs Node.js 22.13 or newer (this is v20.20.2). Install a current version from https://nodejs.org and run npm start again.` and exits 1 (on a real Node 20.20.2 and 21.7.3 the old build printed an `ERR_UNKNOWN_BUILTIN_MODULE` trace instead), then loads the rest with `import()`, because `node:sqlite` is several modules away and a static import would fail while the module graph is linked. The check lives in `server.js` only: `npm run demo`, `npm test` and other scripts still stop with `No such built-in module: node:sqlite` on an old Node. Order after the check: load `.env` (warn if unreadable) → `loadConfig` → startup rule → install `SIGINT`/`SIGTERM` handlers → open the database (friendly messages for a folder that cannot be created/written, a read-only file, or a database from a newer build) → listen → print the banner (address, data file, which AI is ready, a password and exposure warning when not on loopback). A signal stops accepting, aborts generations, closes the database (`PRAGMA optimize`, WAL checkpoint, index purge) and exits 0; a second signal forces exit 1.

---

## 11. Database layer (`src/db/index.js`)

```js
openDb({ file }) -> db            // file: path or ':memory:'. Creates the directory (0700) and file (0600) itself, enables WAL, secure_delete, foreign keys; runs migrations; refuses a read-only file ("is read-only, so nothing could be saved") and a newer schema
db.entries.create(fields) / get(id) / exists(id) / update(id, patch) / delete(id) / count()
db.entries.list({ limit, before, beforeId, mood, tag, from, to, pinned, includePrivate = true }) -> EntrySummary[]   // exactly `limit` rows
db.entries.page(sameOptions) -> { entries, nextBefore, nextBeforeId, nextCursor }   // never splits a run of entries with the same createdAt: the page grows (≤ 500 extra rows) instead
db.entries.summariesFor(ids) / rowsForInsights({ from, to, includePrivate }) -> [{ id, date, mood, emotions, tags, wordCount, status, private, title, summary, createdAt }]
db.messages.add(entryId, { role, content, meta, createdAt? }) -> Message   // assigns seq; updates the entry's word count, updatedAt and search index in one transaction
db.messages.list(entryId) / get(id) / last(entryId) / update(id, { content, meta }) / delete(id) / deleteLast(entryId)
db.memories.list() / get(id) / create({ text, pinned, sourceEntryId }) / update(id, patch) / delete(id) / clear() / exists(text)   // exists: case- and space-insensitive
db.reports.list() / get(id) / create(…) / delete(id)
db.settings.get() -> internal settings (defaults merged) / set(settings) / exists() -> boolean   // exists: a readable settings document is stored (false on a fresh install, after a wipe with settings, or when the stored document is unreadable)
db.search(queryText, { limit = 20 (≤ 100), excludeEntryId, includePrivate = false, mode: 'all'|'any', mood, tag, from, to, pinned }) -> [{ entryId, rank, snippet }]
db.exportAll() / db.importAll(json) -> { imported, skipped } / db.wipe({ includeSettings }) / db.stats() / db.tx(fn) / db.close()
```

`page()` is what the HTTP list uses (and the route finishes any tie run longer than 500 itself); `list()` is exact. `mode: 'all'` prefix-matches every token (UI search); `'any'` is an OR ranked by bm25 (related-entry recall). Queries are **always sanitised** into a safe FTS5 expression (every token quoted); raw user input never reaches `MATCH`. Runs of CJK/Thai text and emoji also get a substring search, because the tokenizer treats a run as one word. Deleted text does not linger: `secure_delete`, an index purge on wipe and at clean shutdown, and `VACUUM` on wipe. Import treats the file as hostile (field-by-field validation, unknown and prototype-pollution keys dropped, counts in the file ignored). Closing runs housekeeping with a short busy timeout, so it can never hang behind another connection.

`src/settings.js` exports `DEFAULT_SETTINGS`, `DEFAULT_TIMEOUT_SEC` (180), `SETTINGS_LIMITS`, `normalizeSettings(input)` (never throws), `mergeSettings(current, patch) -> { settings, errors }`, `publicSettings(settings, env)`, `isProviderConfigured(settings, env, providerId?)`, `applyEnvSeed(settings, env)`, `PROVIDER_IDS`, `PERSONA_IDS`, `THINKING_MODES`. `applyEnvSeed` seeds unconditionally; WHEN to seed is the caller's decision: the server calls it (through `loadEffectiveSettings`, §10) only while `db.settings.exists()` is false.

---

## 12. Frontend

### Shared core (`public/js/lib`)
* `dom.js`: `h(tag, props?, ...children)`, `s()` (SVG), `clear`, `mount`, `frag`, `$`, `$$`. `props`: `class` (string, array or object), `on<Event>`, `dataset`, `style` (object), `ref(fn)`, `aria-*` / `data-*` / any attribute; `value`, `checked`, `disabled`, `selected`, `hidden`, `textContent` as properties. **No HTML strings.**
* `api.js`: `api.get/post/put/patch/del(path, body?, {signal})` (paths relative to `/api`), `api.stream(path, body, {signal, onEvent(name, data)})`, `api.download(path, filename)`, `ApiError {status, code, message, hint, fields}`; adds the `X-MyJournal` header; reports whether the server is reachable.
* `router.js` and `app.js`: a hash router; each view is `export default async function view(ctx)` returning an optional cleanup function. `ctx = { root, params, query (URLSearchParams), signal (aborts on navigation), app }`. `app = { settings, refreshSettings(), saveSettings(patch), navigate(path), toast(msg, opts), on(event, fn), catalog(), aiReady() }`. The shell holds the sidebar / bottom tab bar, the "AI" pill, the theme switch (`localStorage` key `mj-theme`, applied early by `theme-init.js`), a connection banner that probes `/api/health` when requests fail, and the sign-in gate: a `401` sends the person to `#/login`, and after signing in they return to the page they asked for (a cold start of a locked journal) or were on when the session ended (a `401` mid-session); `lib/return-to.js` (`returnAddress()`, `postLoginHash()`) keeps that address in memory only, and a deliberate Sign out, or a reload of the sign-in page, lands on Today. A journal that was never onboarded still gets the welcome screen for Today.
* `markdown.js`: `renderMarkdown(text) -> DocumentFragment`, `renderInline`, pure `parseMarkdown` / `parseInline` (no HTML ever; links become plain text). Used for every AI-authored text.
* `ui.js`: `moodPicker`, `skeleton`, `showError`, date helpers, `ICON_NAMES`, `toast`, `confirmDialog` (initial focus is **Cancel** for a danger dialog, the typed-word box for `requireText`, the confirm button otherwise; Enter in the DELETE box confirms only when the word matches), `openModal`, `icon`, `spinner`, `emptyState`, `MOODS`, `debounce`, `autosize`, `copyText`, `todayString`, …
* `charts.js` (SVG charts with accessible titles and table fallbacks), `voice.js` (Web Speech API wrapper; feature-detected; the browser, not the app, recognises speech), `keyboard-inset.js` (`occludedInset()`, pure, and `watchKeyboardInset()`: when `window.visualViewport` shows that at least 100 px of the layout viewport's bottom is covered and the page is not pinch-zoomed, it publishes `--kb-inset` on `<html>`; `entry.css` lifts the sticky composer dock and pads the entry page by it. Never set on desktop, without `visualViewport`, or where the viewport meta `interactive-widget=resizes-content` already resizes the page. Simulated in tests; not tried on a real iOS or Android keyboard).
* `css/base.css`: design tokens (light and dark), reset, layout shell, buttons, forms, cards, chips, dialog, toast, skeleton. Each view has its own stylesheet.

Components are named `<view>-<thing>.js` (for example `entry-message.js`, `settings-provider-form.js`); a view never imports another view. Two components are shared on purpose: `privacy-copy.js` holds every sentence about what the provider receives (Settings → Data, the entry menu, the Private tag's tooltip, the Memory page) so they cannot drift from [PRIVACY.md](PRIVACY.md), and `entry-request.js` builds the reply, regenerate and wrap-up request bodies (`today`). Pure logic (markdown parsing, chart maths, stream reveal, settings helpers) takes plain data and is unit-tested in Node (`test/frontend`); such modules must not touch `document` at import time.

### Routes
`#/` Today · `#/welcome` onboarding · `#/entry/:id` (`?reply=1` auto-requests a reply for a trailing user message) · `#/history` · `#/insights` · `#/memory` · `#/settings` (`?tab=gemini|openai|local|general|data`, `&setup=1` after onboarding) · `#/login`.

### Views
* **Today:** greeting and streak chip; the big composer ("What's on your mind?") with mood chips and **Start journaling** (creates the entry with `content`, then opens `#/entry/:id?reply=1`; with no AI it saves and opens without `reply`); the *prompt of the day*; the guided journal grid by category; recent and pinned entries; a weekly-reflection nudge. Ctrl/⌘+Enter submits.
* **Entry:** a chat-style column (the person's text in serif bubbles, replies with a calm accent); editable title, date, mood, emotion and tag chips; a menu (private, pin, export `.md`, delete; the Private item and the Private tag say that replies in a private entry are still written by the provider and that Save without reply keeps text away from it). Composer: autosizing textarea, **Send** (`POST messages`, then `POST reply` streaming into a live bubble), **Save without reply** (labelled **Save** under 520 px), **Stop**, **Wrap up** (phase labels, then summary and new memories; on a wrapped entry the button's accessible name is *Wrap up again* but under 520 px it shows only *Wrap up*), regenerate, copy, edit or delete messages, **Dictate**, drafts saved to local storage. Inline error banners with the provider's `hint`, **Try again** and, for the codes where a setting is the likely fix (`auth`, `model_not_found`, `bad_base_url`, `quota`, `region`, `context_too_long`, `network`, `blocked`, `empty`, `overloaded`, `timeout`, `server`; not `rate_limit`, `bad_request`, `unknown`), **Open settings**; an "AI isn't set up" banner; the safety card is a distinct gentle block. Typed text is never lost on failure. `aria-live="polite"` on the streaming bubble.
* **History:** debounced full-text search with highlighted terms (DOM, not HTML), filters for mood, tag and pinned, month groups, *Load more*.
* **Insights:** stat cards, the mood line chart, the 90-day calendar heatmap, top emotions and tags, **Weekly reflection** (7, 14 or 30 days, streamed) and past reports.
* **Memory:** explanation, the three switches (`memory.enabled`, `autoExtract`, `useRelatedEntries`), list with inline edit, pin, delete, add, *Clear all*, link to the source entry.
* **Settings:** tabs *Gemini (free)* · *OpenAI-compatible* · *Local model* · *General* · *Data*. A provider tab has a masked key field (showing `apiKeyHint` and source), the base URL with preset buttons, a model combobox with **Load models**, **Test connection** (sends the unsaved form as an overlay), **Save**, **Use this provider** and the privacy note. The Gemini tab keeps the base URL and **Thinking** under *Advanced*: options *Auto (recommended)* and *Low - less thinking*, with the hint "Low helps Flash models that think before answering (gemini-3.5-flash and up). The default Flash-Lite does not think, so Low makes it slower: leave Auto there." (measured: Flash-Lite with `low` took 2.36 s to the first byte and spent 465 thought tokens, against 0.99 s and none on auto). The Local tab adds the Ollama quick start with copyable commands, the small-model picker, and **Download model** with a cancellable progress bar, and warns when the address is not on this computer; when the chosen model is already in the loaded list (`isModelInstalled()`: exact name, or an untagged name meaning `:latest`) the button reads **Already installed** (`aria-disabled`, focus-safe, no request). *General:* name, about you, persona cards and custom text, creativity, reply length, context budget, timeout (default 180 s), AI on/off, theme. *Data:* stats, export JSON / Markdown, import, where the data lives and exactly what a reply sends (`DATA_SENT_WITH_A_REPLY` in `privacy-copy.js`: the conversation, today's date, your name and "About you" text, your memories, the logged mood, a guided session's instructions and, with recall on, a few short excerpts of older non-private entries, "and nothing else"), sign out (when a password is set), delete everything (typed confirmation). Reaching Settings with `setup=1` (from the welcome screen) shows a banner: *Almost there - two quick steps* (*one quick step* when the key comes from the environment, in which case the "Get a free key" guide is hidden and **Test connection** is the primary button); a successful test on the unchanged form then reads *You are all set* without a Save.
* **Onboarding:** three provider cards (Free Gemini · OpenAI-compatible · Local small model) and **Just journal, no AI**; sets `onboarded` (the first save of the settings document, which also ends the env seeding of §5). It reads `GET /api/providers` (lookup capped at 700 ms) and puts a badge *Found GEMINI_API_KEY in your environment* / *Found OPENAI_API_KEY in your environment* on a card whose row has `needsKey` and `keySource: "env"` (the variable's name only, never the key; the Gemini badge names `GEMINI_API_KEY` even when `GOOGLE_API_KEY` supplied it). Choosing such a card leads to Settings with `setup=1`.
* **Login:** the password form; shown by the shell when `/api/auth/status` says sign-in is required.

### UX bar
Calm, warm, uncluttered; serif for the person's text, system sans for the UI; keyboard-first with visible focus; `prefers-reduced-motion` respected; WCAG AA contrast; works at 360 px wide (bottom tab bar on phones, sidebar from 900 px); skeleton loaders, never blank screens; every async button has loading and disabled states; every error is human-readable with a next step. Checked with axe-core on every route and about 40 states at 390 px and 1280 px in both themes (0 violations) and by the browser tests (focus visible on every Tab stop, no sideways scrolling at 360–390 px, touch targets of at least 44 px on touch layouts, a keyboard-reachable mood picker that behaves like a radio group).

Behaviours worth knowing (all in `public/js`, covered by `test/frontend` and `test/e2e`):

* **Streaming reveal** (`components/entry-stream.js`). Gemini sends a reply in 3–5 big frames. A backlog of 40 characters or fewer is shown on the next animation frame (local models: no added lag); a bigger one is typed out word by word at the larger of 110 characters/s and the speed that shows every character within 1.2 s of its arrival. After the server's `done` the remaining text finishes (at most 1.2 s, plus a 250 ms timer fallback for hidden tabs) before the saved message replaces the live bubble. Stop, errors and leaving the page drop everything at once; `prefers-reduced-motion` shows each frame whole. Screen readers are told once, on completion.
* **Server unreachable** (`components/connection.js`). One banner ("Cannot reach MyJournal. Is it still running?"); it probes `/api/health` after 2, 3, 5, 8 and then every 12 s (or on *Try now* / when the tab becomes visible), and on recovery says "Connected again." and re-runs every view's *Try again*. Drafts survive in local storage.
* **Back / Forward** restores the scroll position (kept in `history.state`) and, on History, as many cards as were loaded; following a link starts at the top. *Load more* moves keyboard focus to the first new entry.
* **Leaving a page mid-stream** (link, Back, address bar, reload) aborts the upstream request, saves the partial reply (`meta.stopped`) and releases the entry's lock, so *Regenerate* works at once; leaving during a wrap-up leaves the entry unwrapped and saves no memories; an abandoned weekly reflection saves nothing; a double Ctrl+Enter or double click sends one message and makes one model call.

---

## 13. Testing

* **Unit and integration:** `npm test` runs `node --test` over `test/{providers,db,journal,server,frontend}/**/*.test.js` with `--test-concurrency=1` (1,469 tests when this was written, 1,468 passing and one skipped for lack of IPv6; about 1.5 minutes). Server tests boot the real app on port 0 with a temporary data folder and the mock LLM servers; provider tests also replay the responses recorded from the real services (`test/fixtures`).
* **Mock LLM servers** (`test/mocks`, reused by the server tests, the e2e tests, `npm run demo` and `npm run mock-llm`):
  * `mock-openai.js`: `createMockOpenAI(options)` → `{ url, baseUrl, close(), requests[], setBehavior() }` (every option and its default is in `DEFAULTS`). `GET /v1/models`, `POST /v1/chat/completions` (SSE chunked realistically: content split mid-word and mid-UTF-8, a `finish_reason` chunk, usage, `[DONE]`; non-stream JSON mode), `<think>` and reasoning-field output, a long list of injectable failures (`failures`, `rejectParams`: 401, 404, 429 with `retry-after`, 400 on `max_tokens` / `temperature` / `stream_options`, 5xx, hang, reset, malformed chunk, …) and the Ollama endpoints `GET /api/version`, `GET /api/tags`, `POST /api/pull` (NDJSON progress, with failure modes). `flavor: 'ollama' | 'llamacpp'` imitates the real servers byte for byte where it matters (chunk shapes, error bodies, a context window `numCtx` that trims old messages like Ollama and rejects like llama.cpp), as captured in `test/fixtures`.
  * `mock-gemini.js`: `createMockGemini(options)`: `GET /v1beta/models`, `…:streamGenerateContent?alt=sse` and `:generateContent`; validates `x-goog-api-key` and role alternation; answers with Google-shaped errors (invalid key 400 `API_KEY_INVALID`, 429 with `RetryInfo`, 404, retired models, 503 after a delay, safety block); `live: true` applies the per-family thinking rules and the real catalogue (`LIVE_MODELS`).
  * `mock-responder.js`: the replies are deterministic and *role-aware*: the responder reads the `TASK:` line and answers title, summary, memory, wrap-up and weekly requests in the labelled-line formats of §8, so whole flows are testable offline.
  * `serve.js`: the CLI behind `npm run mock-llm` (ports 11500 and 11501).
* **Static checks:** `npm run check` (`scripts/check.js`): `node --check` for every `.js`/`.mjs`/`.cjs` file under `src`, `public`, `test`, `scripts` and `server.js` (with the right module type), and no `innerHTML`, `eval` and friends in `public/`.
* **Browser e2e:** `npm run test:e2e` runs `test/e2e/*.e2e.js` in real Chromium against the real app (165 tests, about 5 minutes on an idle machine, much longer while a local model is generating); Playwright is found at run time and every test is *skipped* with a reason when it or Chromium is missing. Journeys fail on any console error or warning, CSP violation, unexpected HTTP error or request to another origin. No test is skipped for a known bug at the moment (a confirmed, still unfixed bug gets a test marked `skip: 'BUG: …'`, and `E2E_RUN_BUGS=1` runs such tests anyway); `E2E_PUBLIC_DIR` serves another copy of `public/`, which is how a regression test is shown to fail on the old frontend. Options and the file list: `test/e2e/README.md`.
* **Real small-model smoke test:** [PROVIDERS.md](PROVIDERS.md#smoke-test-with-a-real-model). Recordings from a real Ollama 0.40.1, llama.cpp `llama-server` and the real Gemini API are in `test/fixtures` and replayed by the provider tests.
