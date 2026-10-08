# MyJournal — architecture & contracts

A private, AI-guided journal (think: Rosebud-style guided journaling with an AI that asks follow-up
questions, remembers you, and surfaces patterns). **Bring your own model**:

| Provider id | What it is | Needs key | Default base URL |
|---|---|---|---|
| `gemini` | Google Gemini API (free tier via AI Studio key) — **native** REST adapter | yes | `https://generativelanguage.googleapis.com` |
| `openai` | Any OpenAI-compatible Chat Completions API (OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, …) | yes | `https://api.openai.com/v1` |
| `local` | Self-hosted small LLM through an OpenAI-compatible server: **Ollama** (default), llama.cpp `llama-server`, LM Studio, vLLM | no (optional) | `http://localhost:11434/v1` |

`openai` and `local` share one adapter (`src/providers/openai.js`); they differ in defaults, UI copy,
key requirement, timeouts and the optional Ollama helpers (model pull).

AI is **optional**: with no provider configured the app is a plain, fast, private journal.

---------------------------------------------------------------------------------------------------

## 1. Hard constraints (read first)

* **Node ≥ 22.13, ESM, zero runtime dependencies.** `npm start` must work after `git clone` with no
  `npm install`. Use only Node built-ins: `node:http`, `node:sqlite` (`DatabaseSync`, FTS5 is available),
  `node:crypto`, `node:test`, global `fetch`, `AbortController`, `TextDecoder`, `process.loadEnvFile`.
  Dev-only deps (e.g. `playwright-core`) are allowed solely for `test/e2e` and must be optional.
* **Frontend: vanilla JS ES modules, no build step, no CDN, no external fonts**. Must work offline
  (people run local LLMs offline). Never use `innerHTML` with dynamic data; build DOM with `h()` /
  `textContent`. A strict CSP is served, so: no inline `<script>`, no inline event handlers,
  no `style=""` attributes in markup (setting `el.style.x` via JS is fine), no `eval`.
* **Privacy**: all data stays in a local SQLite file. Secrets (API keys) are never returned by the API
  (only `apiKeySet`/`apiKeyHint`), never logged, never put in URLs (Gemini key goes in the
  `x-goog-api-key` header). Request/response bodies are never logged.
* **Small models are first-class.** Prompts are short, imperative, single-task; no reliance on JSON
  output from the model; all model output parsing is tolerant with deterministic fallbacks. Context
  budgets are honoured (Ollama defaults to a 2k–4k context window).
* **Never lose user writing.** The user's message is persisted *before* any AI call. AI failures never
  roll back or block saving.
* Style: 2-space indent, semicolons, single quotes, `const`/`let`, small functions, JSDoc on exported
  functions, **no TypeScript**, no classes unless modelling errors/handles. Comments explain *why*.

---------------------------------------------------------------------------------------------------

## 2. Repository layout and file ownership

```
server.js                    entry (thin): loads config, opens DB, starts server        [server agent]
src/config.js                env → config object                                         [server agent]
src/settings.js              settings defaults/validation/merge/masking (shared)         [db agent]
src/providers/               LLM adapters                                                [providers agent]
  errors.js  index.js  config.js  openai.js  gemini.js  sse.js  think-filter.js  http.js
src/db/                      SQLite persistence                                          [db agent]
  index.js  schema.js  entries.js  messages.js  memories.js  reports.js  settings-store.js
  search.js  portability.js
src/journal/                 pure journaling logic (no I/O)                              [journal agent]
  personas.js  templates.js  context.js  tasks.js  safety.js  insights.js  tokens.js  text.js
src/server/                  HTTP layer                                                  [server agent]
  app.js  http.js  security.js  static.js  auth.js  generation.js  ai-service.js  routes/*.js
public/                      frontend (static)
  index.html  favicon.svg  css/base.css   js/app.js  js/lib/{dom,api,router,ui}.js          [lead, DONE]
  js/lib/markdown.js (safe markdown-lite → DOM, DONE, shared)                                  [lead, DONE]
  js/lib/{charts,voice}.js  js/views/*.js  js/components/*.js  css/<view>.css                  [frontend agents]
test/mocks/                  mock LLM servers (OpenAI-compatible, Gemini, Ollama bits)       [providers agent]
test/{providers,db,journal,server}/*.test.js     unit + integration (node:test)
test/e2e/*.e2e.js            browser tests (Playwright, optional)
scripts/                     demo.js, check.js
docs/                        ARCHITECTURE.md (this), PROVIDERS.md, PRIVACY.md             [docs agent]
```

Agents may only create/modify files they own. If you need a change in a file you don't own, write the
request at the end of your final report (do **not** edit it).

---------------------------------------------------------------------------------------------------

## 3. Conventions

* JSON is **camelCase**; SQL columns are snake_case; the repository layer converts.
* Timestamps: integer **milliseconds since epoch** (`createdAt`, `updatedAt`).
* Calendar dates: `'YYYY-MM-DD'` strings in the *user's local time* (`entry.date`). The client sends its
  local date where it matters (`date`, `today`); the server never guesses time zones for streaks.
* IDs: `crypto.randomUUID()`.
* Mood: integer `1..5` (1 awful … 5 great) or `null`.
* Errors over HTTP: status code + `{ "error": { "code": "snake_case", "message": "human readable", "hint"?: "what to try", "fields"?: { "path": "msg" } } }`.
* The server never sends HTML. All text is plain; the client escapes/renders.

---------------------------------------------------------------------------------------------------

## 4. Data model

### JSON shapes (API + JS repos)

```jsonc
// Entry — one journaling session (a conversation that starts with the user's writing)
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
  "private": false,                    // true ⇒ excluded from memory, related-entry recall, weekly reports
  "pinned": false,
  "wordCount": 123,                    // words in user messages
  "messageCount": 4
}
// EntrySummary (list endpoints) = Entry + { "preview": "first ~160 chars of the first user message", "snippet"?: "plain-text search excerpt" }

// Message
{ "id": "uuid", "entryId": "uuid", "seq": 0, "role": "user" | "assistant", "content": "string",
  "createdAt": 1760000000000,
  "meta": {                       // free-form, all optional
    "kind": "prompt" | "reply" | "wrapup" | "safety",   // assistant messages; absent on user messages
    "stopped": true,              // generation was cancelled by the user; content is partial
    "provider": "gemini", "model": "gemini-flash-latest",
    "edited": true } }

// Memory — a short durable fact about the user, always visible/editable/deletable by the user
{ "id": "uuid", "text": "Has a younger sister called Maya", "pinned": false,
  "sourceEntryId": null | "uuid", "createdAt": 0, "updatedAt": 0 }

// Report — AI weekly write-up
{ "id": "uuid", "kind": "weekly", "periodStart": "2026-10-02", "periodEnd": "2026-10-08",
  "content": "markdown-lite text", "createdAt": 0, "meta": { "provider": "gemini", "model": "…", "entryCount": 5 } }
```

### SQL (src/db/schema.js; `PRAGMA journal_mode=WAL; foreign_keys=ON; user_version` migrations)

```sql
entries(rowid implicit, id TEXT UNIQUE NOT NULL, created_at INT, updated_at INT, entry_date TEXT,
        title TEXT DEFAULT '', kind TEXT, template_id TEXT, mood INT, emotions TEXT /*json*/, tags TEXT /*json*/,
        summary TEXT DEFAULT '', status TEXT DEFAULT 'open', private INT DEFAULT 0, pinned INT DEFAULT 0,
        word_count INT DEFAULT 0)
messages(id TEXT PK, entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE, seq INT, role TEXT, content TEXT,
         created_at INT, meta TEXT /*json*/, UNIQUE(entry_id, seq))
memories(id TEXT PK, text TEXT, pinned INT, source_entry_id TEXT /*no FK: survive entry deletion? NO — SET NULL*/, created_at INT, updated_at INT)
reports(id TEXT PK, kind TEXT, period_start TEXT, period_end TEXT, content TEXT, created_at INT, meta TEXT)
settings(key TEXT PK, value TEXT /*json*/)
entry_search  -- FTS5(entry_id UNINDEXED, title, body, tags, tokenize='unicode61 remove_diacritics 2', prefix='2 3')
              -- one row per entry; body = concatenated *user* message text; rewritten whenever title/messages/tags change
```

Indexes: `entries(created_at DESC)`, `entries(entry_date)`, `messages(entry_id, seq)`.

---------------------------------------------------------------------------------------------------

## 5. Settings

Stored as one JSON document (`settings` table, key `app`). Defaults live in `src/settings.js`
(`DEFAULT_SETTINGS`). **Internal** shape (has raw keys; never leaves the server):

```jsonc
{
  "onboarded": false,
  "profile": { "name": "", "about": "" },                       // about ≤ 1000 chars: "things my companion should know"
  "persona": { "id": "companion", "custom": "" },               // id ∈ companion|coach|cbt|stoic|friend|custom ; custom ≤ 1500 chars
  "memory":  { "enabled": true, "autoExtract": true, "useRelatedEntries": true },
  "ai": {
    "enabled": true,
    "provider": "",                                             // "" (unconfigured) | "gemini" | "openai" | "local"
    "temperature": 0.7,                                         // 0..2
    "maxTokens": 700,                                           // 64..8192 reply cap
    "contextBudgetTokens": 3000,                                // 500..32000 approx. prompt budget (history + memory)
    "timeoutSec": 120,                                          // first-byte timeout; local cold-starts can be slow
    "providers": {
      "gemini": { "baseUrl": "https://generativelanguage.googleapis.com", "model": "gemini-flash-latest", "thinking": "fast", "apiKey": "" },
      "openai": { "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini", "apiKey": "" },
      "local":  { "baseUrl": "http://localhost:11434/v1", "model": "llama3.2:3b", "apiKey": "" }
    }
  }
}
```

**Public** shape (`GET /api/settings`, `PUT` response): identical, except every `providers.*` object has
`apiKey` removed and gains `apiKeySet: boolean`, `apiKeyHint: string` (`"…abcd"` last 4 chars, `""` if none)
and `apiKeySource: "settings" | "env" | "none"`.

**PUT** takes a *partial* document, deep-merged. In `providers.<id>`, `apiKey: "<string>"` sets the key,
`apiKey: null` clears the saved key (env fallback then applies), omitted keeps it. Unknown keys are
dropped, numbers clamped, strings trimmed/length-limited, URLs must be `http(s)`; failures → `400 invalid_settings` with `fields`.

**Env fallbacks** (UI-saved value wins, env fills the gap, `apiKeySource` reports which):
`GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `LOCAL_LLM_API_KEY`,
`LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`. Env base URLs/model only seed *defaults* for a fresh DB.

Server config env (`src/config.js`): `PORT` (3210), `HOST` (127.0.0.1), `JOURNAL_DATA_DIR` (./data),
`JOURNAL_PASSWORD`, `JOURNAL_ALLOWED_HOSTS`, `JOURNAL_INSECURE_ALLOW_NO_AUTH=1`.
A `.env` file in the CWD is loaded with `process.loadEnvFile()` if present (real env wins).

---------------------------------------------------------------------------------------------------

## 6. HTTP API

All under `/api`, JSON in/out (`Content-Type: application/json`) unless stated. **Every non-GET request
must carry header `X-MyJournal: 1`** (CSRF defence; the browser client adds it). Endpoints marked
**SSE** respond `200 text/event-stream` (see §7) *after* validation; validation/precondition failures
return normal JSON errors **before** the stream starts.

### Auth (only meaningful when `JOURNAL_PASSWORD` is set)
| | | |
|---|---|---|
| GET | `/api/health` | `{ ok: true, version }` — public |
| GET | `/api/auth/status` | `{ required: bool, authenticated: bool }` — public |
| POST | `/api/auth/login` `{password}` | `{ ok: true }` + `Set-Cookie: mj_session=…; HttpOnly; SameSite=Strict; Path=/` · `401 invalid_password` · `429 rate_limited` (5 failures/min/IP) |
| POST | `/api/auth/logout` | `{ ok: true }` |

When auth is required every other `/api/*` returns `401 unauthorized` until logged in. Static files are public.

### Settings & providers
| | | |
|---|---|---|
| GET | `/api/settings` | public Settings |
| PUT | `/api/settings` (partial) | public Settings · `400 invalid_settings` |
| GET | `/api/providers` | `{ active, providers: [{ id, label, tagline, description, needsKey, defaultBaseUrl, defaultModel, keyUrl?, privacyNote, suggestedModels: [{id,label,note?}], configured, keySource }] }` |
| POST | `/api/providers/test` `{ provider, config?: {baseUrl?,model?,apiKey?} }` | **always 200** for valid input: `{ ok, provider, model, latencyMs, sample?, error?: {code,message,hint?} }`. `config` overlays saved settings so users can test before saving. `400` for unknown provider. |
| POST | `/api/providers/models` `{ provider, config? }` | `{ ok, models: [{id,label}], error? }` |
| POST | `/api/providers/local/pull` `{ model, config?: {baseUrl?} }` **SSE** | Ollama only (native `/api/pull` at base URL minus `/v1`). Events `progress {status, completed?, total?, percent?}`, `done {}`, `error`. `409 not_ollama` if `/api/version` fails. |

### Catalog
| GET | `/api/catalog?date=YYYY-MM-DD` | `{ templates: [Template], personas: [{id,name,description}], promptOfTheDay: {id, text} }` |
|---|---|---|

`Template` = `{ id, title, category: "Daily"|"Mind"|"Growth"|"Creative", description, icon, opening, minutes }`
(`guidance` stays server-side).

### Entries
| | | |
|---|---|---|
| GET | `/api/entries?limit=30&before=<createdAt>&q=&mood=&tag=&from=&to=&pinned=1` | `{ entries: [EntrySummary], nextBefore: number \| null }`. With `q`: FTS ranked, `nextBefore` is `null` (single page, max 50), `snippet` filled. `from`/`to` are `YYYY-MM-DD` inclusive. |
| POST | `/api/entries` `{ kind?, templateId?, title?, mood?, date?, private?, content? }` | `201 { entry, messages }`. `templateId` ⇒ `kind: "guided"` and seeds one assistant message (`meta.kind:"prompt"`, text = template `opening`, **no AI call**). `content` ⇒ also creates the first user message. |
| GET | `/api/entries/:id` | `{ entry, messages }` · `404 not_found` |
| PATCH | `/api/entries/:id` `{ title?, mood?, tags?, emotions?, private?, pinned?, date? }` | `{ entry }` |
| DELETE | `/api/entries/:id` | `204` |
| POST | `/api/entries/:id/messages` `{ content }` | `201 { message, entry }` — appends a **user** message (no AI). Empty/whitespace → `400`. Max 20 000 chars. |
| PATCH | `/api/entries/:id/messages/:mid` `{ content }` | `{ message, entry }` (sets `meta.edited`) |
| DELETE | `/api/entries/:id/messages/:mid` | `{ entry }` |
| POST | `/api/entries/:id/reply` `{ regenerate?: boolean }` **SSE** | AI reply to the conversation as it stands. Preconditions (JSON errors): `409 ai_disabled`, `409 ai_not_configured`, `409 generation_in_progress`, `409 nothing_to_reply_to` (last message isn't a user message and `regenerate` is false). `regenerate:true` first deletes the trailing assistant `reply` message. |
| POST | `/api/entries/:id/wrap-up` **SSE** | Closing reflection + metadata + memories (see §7). Same preconditions as reply. |
| GET | `/api/entries/:id/export.md` | `text/markdown` attachment |

### Memories
| GET | `/api/memories` | `{ memories: [Memory] }` (pinned first, then newest) |
|---|---|---|
| POST | `/api/memories` `{ text, pinned? }` | `201 { memory }` (text ≤ 300 chars) |
| PATCH | `/api/memories/:id` `{ text?, pinned? }` | `{ memory }` |
| DELETE | `/api/memories/:id` | `204` |
| POST | `/api/memories/clear` | `{ ok: true, removed }` |

### Insights
| GET | `/api/insights/overview?today=YYYY-MM-DD&days=90` | see below |
|---|---|---|
| GET | `/api/insights/reports` | `{ reports: [Report] }` newest first |
| POST | `/api/insights/weekly` `{ today?, days? = 7 }` **SSE** | `422 not_enough_entries` if no non-private entries in the window; events `delta`, `done {report}` |
| DELETE | `/api/insights/reports/:id` | `204` |

```jsonc
// overview
{ "today": "2026-10-08",
  "streak": { "current": 3, "longest": 12, "lastEntryDate": "2026-10-08" },   // current counts if last entry is today OR yesterday
  "totals": { "entries": 40, "words": 18000, "daysWritten": 31, "wrapped": 22 },
  "mood":   { "average": 3.6 | null, "series": [{ "date": "2026-10-01", "avg": 3.5, "count": 2 }] },   // only days with a mood, within `days`
  "calendar": [{ "date": "2026-10-01", "count": 2, "words": 340 }],            // only days with entries, within `days`
  "emotions": [{ "name": "calm", "count": 7 }],                                 // top 10 within `days`
  "tags":     [{ "name": "work", "count": 5 }] }                                // top 10 within `days`
```

### Data
| GET | `/api/data/stats` | `{ entries, messages, memories, reports, dbBytes }` |
|---|---|---|
| GET | `/api/data/export?format=json\|markdown` | attachment. JSON: `{ app:"myjournal", version:1, exportedAt, entries:[{...Entry, messages:[Message]}], memories:[], reports:[] }` (settings/keys are **never** exported) |
| POST | `/api/data/import` *(export JSON as body, ≤ 50 MB)* | `{ imported: {entries,messages,memories,reports}, skipped }` — merge by id, skip existing, validates shape, never executes anything |
| POST | `/api/data/wipe` `{ confirm: "DELETE", includeSettings?: boolean }` | `{ ok: true }` |

### Error codes
`bad_request, invalid_settings, not_found, unauthorized, invalid_password, forbidden_origin, forbidden_host,
conflict, generation_in_progress, nothing_to_reply_to, payload_too_large, rate_limited, ai_disabled,
ai_not_configured, not_enough_entries, not_ollama` plus the **provider error codes** of §9 (only inside SSE `error`
events and `/api/providers/*` bodies).

---------------------------------------------------------------------------------------------------

## 7. SSE protocol (reply, wrap-up, weekly report, model pull)

`POST` + `fetch` streaming (not `EventSource`). Frames: `event: <name>\ndata: <single-line JSON>\n\n`.
A comment frame `: ping\n\n` is sent every 15 s. Headers: `Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-store`, `X-Accel-Buffering: no`, `Connection: keep-alive`.

| event | data | when |
|---|---|---|
| `notice` | `{ kind: "safety", text, message }` | crisis keywords detected in the last user message — sent first; `message` is the persisted static assistant message (`meta.kind:"safety"`) |
| `phase` | `{ name: "reflection" \| "metadata" \| "memory" }` | wrap-up progress |
| `delta` | `{ text }` | streamed assistant text |
| `entry` | `{ entry }` | entry metadata changed (title, summary, emotions, status…) |
| `memories` | `{ added: [Memory] }` | wrap-up extracted new memories |
| `done` | reply: `{ message, entry }` · wrap-up: `{ message, entry, memories }` · weekly: `{ report }` · pull: `{}` | success; persisted objects |
| `error` | `{ error: { code, message, hint? } }` | failure after the stream started; stream ends. For `reply`, the user message is already persisted; partial text (if any) is kept as a `stopped` message |

**Cancellation**: the client aborts the fetch → the server aborts the upstream request, persists the partial
assistant text (if non-empty) with `meta.stopped = true`, and releases the per-entry lock. Only **one**
generation per entry at a time (`409 generation_in_progress`).

**Wrap-up pipeline** (sequential, never parallel — free-tier rate limits): (1) stream closing reflection
(`phase reflection`) → persist as `meta.kind:"wrapup"`; (2) `phase metadata`: one small non-streamed call →
title (only if user hasn't set one), summary, emotions, tags (fallbacks if the model output is unusable);
(3) `phase memory` (only if `memory.enabled && memory.autoExtract && !entry.private`): one small call →
0–3 memory facts, deduped against existing memories. Steps 2–3 are best-effort: their failure does not fail wrap-up.
Finally `entry.status = "wrapped"`.

---------------------------------------------------------------------------------------------------

## 8. Journal logic (`src/journal/*`, pure, synchronous, unit-tested)

```js
// tokens.js
estimateTokens(text) -> number                       // ceil(chars / 3.5); cheap and conservative
// text.js
firstWords(text, maxChars) ; truncate(text, maxChars) ; normalizeLabels(list, {max, maxLen}) -> string[] ; wordCount(text)
extractKeywords(text, {max}) -> string[]             // stopword-filtered, for related-entry search
// personas.js
PERSONAS: [{ id, name, description, prompt }] ; getPersona(id) ; resolvePersonaPrompt({id, custom}) -> string
// templates.js
TEMPLATES: [{ id, title, category, description, icon, opening, guidance, minutes }] ; getTemplate(id) ; publicTemplate(t)
promptOfTheDay(dateStr) -> { id, text }              // deterministic per date
// safety.js
detectCrisis(text) -> { flagged: boolean, matches: string[] } ; crisisNotice() -> string   // static, kind, region-neutral (988 for US + findahelpline.com)
// context.js
buildReplyMessages({ settings, entry, messages, memories, related, now, providerId, templateGuidance }) ->
   { messages: [{role:'system'|'user'|'assistant', content}], debug: { approxTokens, droppedMessages, memoriesUsed, relatedUsed } }
buildWrapUpMessages(sameArgs) ; buildMetaMessages({entry,messages,settings}) ; buildMemoryMessages({entry,messages,existingMemories,settings})
buildWeeklyMessages({ entries, memories, settings, periodStart, periodEnd })
// tasks.js  (parsers for tolerant model output)
parseMeta(text, {fallbackTitle}) -> { title, summary, emotions[], tags[] }   // "Title: …\nSummary: …\nEmotions: a, b\nTags: x, y" with fuzzy fallbacks
parseMemoryLines(text, {existing}) -> string[]                               // "- fact" lines, drops "none", dups, junk; ≤3, ≤200 chars each
cleanReply(text) -> string                                                    // strips <think>, role prefixes ("Assistant:"), code fences wrapping, trailing whitespace
// insights.js
computeOverview({ entries, today, days }) -> overview (see §6)   // entries = minimal rows {date, mood, emotions, tags, wordCount, status}
computeStreaks(dates, today) -> { current, longest, lastEntryDate }
```

**Task marker (contract)**: the *system* message of every model call produced by `context.js` starts with a first line
`TASK: reply` | `TASK: wrapup` | `TASK: meta` | `TASK: memory` | `TASK: weekly`. It costs ~3 tokens, helps debugging, and
lets the mock LLM servers answer each task in the right format deterministically.

**Label formats (contract, used by the parsers and by the mocks)**
* `meta` → the model is asked for exactly four lines: `Title: …` / `Summary: …` / `Emotions: a, b, c` / `Tags: x, y`.
* `memory` → bullet lines `- fact`, or the single word `none`.
* `weekly` → plain paragraphs, optional `**Bold**` lead-ins and `- ` bullets (rendered by the client's markdown-lite).
* `reply` / `wrapup` → plain prose (markdown-lite allowed: `**bold**`, `*italic*`, `- ` bullets, blank-line paragraphs).

**Templates**: ids (fixed) — `rose-thorn-bud`, `gratitude`, `morning-intention`, `evening-reflection`, `thought-record`,
`worry-dump`, `self-compassion`, `goals-checkin`, `relationship-reflection`, `dream-journal`, `weekly-review`, `decision-helper`.
`icon` must be one of `ICON_NAMES` exported by `public/js/lib/ui.js` (the unit test imports it to enforce this).

**Prompt design rules** (these matter for 1B–3B models): system prompt ≤ ~350 tokens; imperative bullet rules;
exactly one question per reply; 2–4 sentences; reply in the user's language; no lists unless asked; never
diagnose; one task per call; metadata/memory calls use *labelled plain-text lines*, never JSON; temperature for
metadata/memory calls is forced low (0.2). Memory block and related-entry block are each capped (~600 / ~700 tokens)
and **dropped first** when the budget is tight, then the oldest conversation turns (never the latest user
message, never the system prompt). Messages passed to adapters are strictly `system?` then `user`/`assistant`
turns; consecutive same-role turns are merged by the context builder; `meta.kind === "safety"` messages are
omitted from context.

---------------------------------------------------------------------------------------------------

## 9. Provider layer (`src/providers/*`)

```js
// index.js
createProvider(id, cfg, { fetch? }) -> Provider      // cfg = resolved config (below). fetch injectable for tests.
describeProviders(env) -> catalog rows for GET /api/providers (without `configured`)
// config.js
resolveProviderConfig(id, settings, env) -> { id, baseUrl, model, apiKey, keySource, thinking?, timeoutMs }
// Provider
{ id, label,
  stream(req) -> AsyncGenerator<{type:'delta', text} | {type:'done', finishReason, usage?}>,
  chat(req)   -> Promise<{ text, finishReason, usage? }>,           // drains stream(); applies cleanReply-equivalent <think> stripping
  listModels({signal}) -> Promise<[{id,label}]>,
  test({signal}) -> Promise<{ ok: true, model, latencyMs, sample }>  // throws ProviderError on failure
}
// req = { messages:[{role,content}], temperature?, maxTokens?, signal?: AbortSignal, timeoutMs? }
```

`ProviderError` (`errors.js`): `{ name, code, message (user-friendly), hint?, status?, retryAfterMs?, provider, cause? }`.
Codes: `auth`, `rate_limit`, `quota`, `model_not_found`, `bad_base_url`, `network`, `timeout`, `blocked`,
`context_too_long`, `bad_request`, `server`, `overloaded`, `region`, `empty`, `unknown`.
A caller abort throws the standard `AbortError` (`err.name === 'AbortError'`), **not** a `ProviderError`.
Messages must be actionable and must **never** contain the API key.

### Shared HTTP behaviour
Node's global `fetch` ignores `HTTPS_PROXY` unless the process runs with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21). We do not
re-implement proxying; docs tell users behind a corporate proxy to set it. (In this dev sandbox every live probe needs it.)
First-byte timeout = `timeoutMs`; idle timeout between chunks = 60 s; both produce `timeout` (hint: for local
models the first request loads the model, try again). Network failure → `network` with a hint naming the URL
that was tried (and, for `local`, "is Ollama running? `ollama serve`"). At most **one** automatic retry for
transient `429` with `retryAfterMs ≤ 8000` and for `503`; never retry after any delta was emitted.

### OpenAI-compatible adapter (`openai` + `local`)
* Endpoint normalization: trim, strip trailing `/`, strip a trailing `/chat/completions`; for `local`, if the URL has
  no path (e.g. `http://localhost:11434`) append `/v1`. Request goes to `${base}/chat/completions`.
* Headers: `Content-Type: application/json`, `Accept: text/event-stream`, `Authorization: Bearer <key>` only if a key exists.
* Body: `{ model, messages, stream: true, temperature, <token param>, stream_options: { include_usage: true } }`.
  Token param is `max_completion_tokens` when the host is `api.openai.com`, else `max_tokens`.
  **Self-healing on `400`**: if the error text mentions `max_tokens`/`max_completion_tokens` flip the param; mentions
  `temperature` → drop it; mentions `stream_options` → drop it. Retry (max 2 adaptations), remember per adapter instance.
* Streaming parse (`sse.js`, shared): handles `\r\n`, chunk boundaries inside lines/UTF-8, `: comments`, `data: [DONE]`.
  Text = `choices[0].delta.content` (ignore `reasoning_content` / `reasoning`); finish = `choices[0].finish_reason`;
  usage from the final chunk if present. If the server answers with `application/json` instead of SSE, read
  `choices[0].message.content`.
* `think-filter.js`: stateful filter removing `<think>…</think>` (and `<thinking>`, `<reasoning>`) blocks even when the tags
  split across chunks; leading whitespace after a removed block is trimmed. If the stream ends inside an unterminated
  `<think>` and nothing was emitted → `ProviderError('empty')` with hint "the model spent its whole token budget
  thinking — raise max tokens or use a non-reasoning model".
* Error mapping: `401/403` → `auth`; `404` → `model_not_found` if body mentions the model, else `bad_base_url`;
  `429` → `quota` if body has `insufficient_quota`/`billing`, else `rate_limit` (honour `retry-after`);
  `400` + `context_length`/`maximum context` → `context_too_long`; `5xx` → `server`; refused/DNS → `network`.
  An empty successful stream → `empty`.
* `listModels`: `GET ${base}/models` → `data[].id` sorted alphabetically; tolerate `{models:[…]}` and bare arrays.
* `test`: one tiny streamed request (`max tokens 16`, "Reply with the single word: OK"), success on any 2xx stream even
  if the sample is empty (reasoning models) — `sample` is whatever came back.
* Ollama helper: `pullModel({model, signal}) -> AsyncGenerator<progress>` (native `POST {root}/api/pull`, NDJSON) and
  `isOllama()` (`GET {root}/api/version`), where `{root}` is the base URL with `/v1` stripped.

### Gemini adapter (native REST)
* `POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse`, header `x-goog-api-key` (never `?key=`).
  Model ids: strip a leading `models/`, `encodeURIComponent` the rest.
* Body: `{ systemInstruction: { parts: [{text}] }, contents: [{ role: 'user'|'model', parts: [{text}] }], generationConfig: { temperature, maxOutputTokens, thinkingConfig? } }`.
  Contents must **start with a user turn and alternate**: merge consecutive same-role turns; if the first turn is a
  model turn (guided-journal opening prompt) prepend a user turn `"(I open my journal.)"`. System messages are joined into `systemInstruction`.
* **Thinking** (`cfg.thinking`): `"fast"` (default) → ask for minimal thinking where known: model matches
  `/gemini-2\.5-(flash|flash-lite)/` → `{ thinkingBudget: 0 }`; matches `/gemini-3/` or `-latest` aliases → `{ thinkingLevel: 'minimal' }`
  (`'low'` if the id contains `pro`). `"default"` → omit `thinkingConfig` and raise `maxOutputTokens` to ≥ 2048 so
  thoughts cannot starve the answer. If Gemini answers `400` mentioning `thinking`, retry once without `thinkingConfig`
  and remember that for the model. Parts with `thought: true` are never emitted.
* Parse SSE `data:` JSON chunks: text from `candidates[0].content.parts[].text`; `finishReason`; `usageMetadata`.
  `promptFeedback.blockReason` or `finishReason ∈ {SAFETY, PROHIBITED_CONTENT, BLOCKLIST, SPII, IMAGE_SAFETY}` with no text → `blocked`
  ("Gemini declined to answer this one — journaling about hard things can trip safety filters; rephrase or switch provider").
  `MAX_TOKENS` with no text → `empty` (hint: thinking consumed the budget).
* Errors arrive as `{ error: { code, status, message, details: [{ '@type': '…ErrorInfo', reason }, { '@type': '…RetryInfo', retryDelay: '12s' }] } }`.
  Mapping — **invalid key is HTTP 400 with `reason: API_KEY_INVALID`** and **a missing key is HTTP 403 `PERMISSION_DENIED` "Method doesn't allow unregistered callers"** (both verified live; both → `auth`, the second with hint "no API key was sent"). Header `x-goog-api-key` is confirmed to be honoured; `UNAUTHENTICATED`/`PERMISSION_DENIED` → `auth`;
  `RESOURCE_EXHAUSTED`/429 → `rate_limit` (parse `retryDelay`; message containing `per day`/`quota exceeded` for daily → `quota`);
  `NOT_FOUND` → `model_not_found` (hint: open Settings → *Load models*); `FAILED_PRECONDITION` with "location" → `region`;
  `UNAVAILABLE`/503 → `overloaded`; other 400 → `bad_request` with Google's message.
* `listModels`: `GET {base}/v1beta/models?pageSize=1000` (follow `nextPageToken`, ≤5 pages); keep entries whose
  `supportedGenerationMethods` includes `generateContent` (or all, if the field is absent); drop ids matching
  `/embedding|aqa|imagen|veo|tts|image|live|audio|robotics|computer-use|learnlm/`; strip `models/`; label = `displayName || id`;
  sort: `*-latest` aliases first, then ids descending.
* `test`: tiny request via `generateContent`-compatible stream; same success rule as OpenAI.
* Free-tier privacy note shown in UI: *prompts and responses on the free tier may be used by Google to improve its products
  (and reviewed by humans); billing-enabled projects are not.* Don't journal secrets with the free tier.

### Catalog copy (`describeProviders`)
* gemini — "Free Gemini API": tagline "Free key from Google AI Studio", `keyUrl: https://aistudio.google.com/apikey`, suggested models
  `gemini-flash-latest` ("Fast, recommended"), `gemini-flash-lite-latest` ("Fastest, highest free limits"); privacyNote above.
* openai — "OpenAI-compatible API": tagline "OpenAI, OpenRouter, Groq, Together, DeepSeek, …"; suggested `gpt-4o-mini`; presets for base URLs
  (OpenAI, OpenRouter `https://openrouter.ai/api/v1`, Groq `https://api.groq.com/openai/v1`, Together `https://api.together.xyz/v1`).
* local — "Self-hosted small LLM": tagline "Runs on your machine — nothing leaves it"; presets Ollama `http://localhost:11434/v1`, llama.cpp `http://localhost:8080/v1`,
  LM Studio `http://localhost:1234/v1`; suggested models `llama3.2:1b` (~1.3 GB, plumbing tests), `qwen2.5:1.5b`, `gemma2:2b`, `llama3.2:3b` (better quality), `smollm2:1.7b`.

---------------------------------------------------------------------------------------------------

## 10. Server (`src/server/*`)

* `createApp({ config, db, fetch? }) -> { server, listen(), close() }` — no global state, so tests spin up many instances on port 0.
* Router: tiny pattern router in `http.js` (`/entries/:id/messages/:mid`), JSON body reader with size cap (1 MB default, 50 MB for import),
  `sendJson/sendError/sendNoContent`, `openSse(res) -> { send(event,data), close() }`.
* **Security** (`security.js`), applied before routing:
  1. `Host` header allow-list: `localhost`, `127.0.0.1`, `[::1]` (any port) + `config.allowedHosts` — enforced when no password is set (DNS-rebinding defence) → `403 forbidden_host`.
  2. For non-GET `/api` requests: require `X-MyJournal: 1` and, if an `Origin` header is present, its host must equal `Host` → else `403 forbidden_origin`. No CORS headers are ever sent.
  3. Headers on everything: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy: microphone=(self), camera=(), geolocation=()`; `/api/*` also `Cache-Control: no-store`.
  4. Startup refuses a non-loopback `HOST` without `JOURNAL_PASSWORD` unless `JOURNAL_INSECURE_ALLOW_NO_AUTH=1`.
* **Auth** (`auth.js`): password compared with `crypto.timingSafeEqual` over SHA-256 digests; session token = random 32 bytes stored server-side in a Map (TTL 30 days); cookie `mj_session` HttpOnly, SameSite=Strict, Path=/, `Secure` only when `X-Forwarded-Proto: https`.
* **Static** (`static.js`): serves `public/`, `index.html` for unknown non-`/api` paths without extension (SPA), strict path-traversal protection (resolve + prefix check, reject `..`, NUL, backslashes), correct MIME types, `Cache-Control: no-cache`.
* **AI service** (`ai-service.js`): `getProvider(settings, env)` → `{ provider, cfg }` or throws `ai_not_configured` / `ai_disabled`; wraps `createProvider(resolveProviderConfig(...))`.
* **Generation** (`generation.js`): per-entry lock, abort wiring (`res.on('close')` while not finished ⇒ abort), partial persistence, SSE error mapping.
* Logging: one line per request (`method path status ms`), never bodies/headers/keys. Quiet in tests (`config.quiet`).
* Graceful shutdown on SIGINT/SIGTERM (stop accepting, abort generations, close DB).

---------------------------------------------------------------------------------------------------

## 11. DB layer API (`src/db/index.js`)

```js
openDb({ file }) -> db            // file: path or ':memory:'; creates dir (0700) and file (0600); runs migrations
db.entries.create(fields) / get(id) / list({limit,before,mood,tag,from,to,pinned,includePrivate=true}) / update(id, patch) / delete(id)
db.entries.rowsForInsights({ from, to, includePrivate }) -> [{id,date,mood,emotions,tags,wordCount,status,private,title,summary,createdAt}]
db.messages.add(entryId, { role, content, meta, createdAt? }) -> Message   // assigns seq, updates entry word_count/updated_at/search index, in a transaction
db.messages.list(entryId) / get(id) / update(id, {content, meta}) / delete(id) / deleteLast(entryId) / last(entryId)
db.memories.list() / create({text,pinned,sourceEntryId}) / update(id,patch) / delete(id) / clear() / exists(text)  // exists: case/space-insensitive
db.reports.list() / create(...) / delete(id)
db.settings.get() -> internal settings (defaults merged) / set(settings)
db.search(queryText, { limit=20, excludeEntryId, includePrivate=false, mode: 'all'|'any' }) -> [{ entryId, rank, snippet }]
db.exportAll() / db.importAll(json) -> counts / db.wipe({ includeSettings }) / db.stats() / db.close()
```
`mode: 'all'` = every token prefix-matched (UI search); `'any'` = OR of tokens ranked by bm25 (related-entry recall). Queries
are **always sanitised** into a safe FTS5 expression (quote every token) — raw user input never reaches `MATCH`.

`src/settings.js` exports `DEFAULT_SETTINGS`, `normalizeSettings(input)`, `mergeSettings(current, patch) -> { settings, errors }`,
`publicSettings(settings, env)`, `isProviderConfigured(settings, env)`, `PROVIDER_IDS`.

---------------------------------------------------------------------------------------------------

## 12. Frontend architecture

### Shared core (already written — read these files, do not edit)
* `public/js/lib/dom.js` — `h(tag, props?, ...children)`, `s()` (SVG), `clear`, `mount`, `$`, `$$`. `props`: `class` (string|array|object), `on<Event>`, `dataset`, `style` (object), `ref(fn)`, `aria-*`/`data-*`/any attribute; `value`/`checked`/`disabled`/`selected`/`hidden`/`textContent` as properties. **No HTML strings.**
* `public/js/lib/api.js` — `api.get/post/put/patch/del(path, body?, {signal})` (paths relative to `/api`), `api.stream(path, body, {signal, onEvent(name, data)})`, `api.download(path, filename)`, `ApiError {status, code, message, hint, fields}`.
* `public/js/lib/router.js` + `public/js/app.js` — hash router; each view is `export default async function view(ctx)` returning an optional cleanup function.
  `ctx = { root, params, query (URLSearchParams), signal (aborts on navigation), app }`.
  `app = { settings, refreshSettings(), saveSettings(patch), navigate(path), toast(msg, opts), on(event, fn), catalog() }`.
* `public/js/lib/markdown.js` — `renderMarkdown(text) -> DocumentFragment`, `renderInline(text) -> Node[]`, pure `parseMarkdown/parseInline` (no HTML ever; links become plain text). Use it for every AI-authored text.
* `public/js/lib/ui.js` — `moodPicker`, `skeleton`, `showError`, `addDays`, `parseDate`, `formatMonth`, `greeting`, `ICON_NAMES`, plus `toast`, `confirmDialog`, `openModal`, `icon(name, {size})`, `spinner`, `emptyState`, `MOODS`, `moodFace`, `debounce`, `autosize`, `formatDate`, `formatTime`, `relativeTime`, `copyText`, `todayString`.
* `public/css/base.css` — design tokens (light/dark), reset, layout shell, buttons, forms, cards, chips, dialog, toast, skeleton.

### Frontend file ownership details
Two frontend agents work in parallel. **Frontend-A** owns `views/{today,entry,history}.js`, `css/{today,entry,history}.css`,
`lib/voice.js`. **Frontend-B** owns `views/{settings,insights,memory,onboarding,login}.js`,
`css/{settings,insights,memory,onboarding,login}.css`, `lib/charts.js`. Shared components go in `js/components/` and are named
`<owner-view>-<thing>.js` (e.g. `entry-message.js`, `settings-provider-form.js`); never import another agent's view or component —
if you need something shared, put it in your own file. Views may import `lib/*.js` freely (including the other agent's lib files
*after* they exist; if unsure, copy the 5 lines you need). Pure logic (markdown parsing, chart math) lives in functions that take
plain data so it can be unit-tested in Node (`test/frontend/*.test.js`; modules must not touch `document` at import time).

### Routes
`#/` Today · `#/welcome` onboarding · `#/entry/:id` (`?reply=1` auto-requests an AI reply for a trailing user message) · `#/history` ·
`#/insights` · `#/memory` · `#/settings` (`?tab=gemini|openai|local|general|data`) · `#/login`.

### Views and what they must do
* **Today** (`views/today.js`): greeting + streak chip; big composer ("What's on your mind?") with mood chips and **Start journaling** (creates entry with `content`, navigates to `#/entry/:id?reply=1`; if AI isn't configured, saves and navigates without `reply`); *prompt of the day* card (click → guided entry); guided journal grid grouped by category (click → `POST /entries {templateId}` → open); recent entries (5) + pinned; weekly-reflection nudge. Keyboard: Ctrl/⌘+Enter submits.
* **Entry** (`views/entry.js`): chat-style column (journal text in serif bubbles, AI replies with a calm accent); editable title, date, mood picker, emotion/tag chips (editable), overflow menu (private toggle, pin, export .md, delete). Composer: autosizing textarea, **Send** (= `POST messages` then `POST reply` SSE streaming into a live bubble with caret), **Save without reply**, **Stop** while streaming, **Wrap up** (SSE wrap-up with phase labels; shows summary + new memories), regenerate last reply, edit/delete own messages, voice dictation (Web Speech API, feature-detected). Inline error banners with provider error `hint` and a *Retry* + *Open settings* action; "AI isn't set up" banner when `ai_not_configured`. `aria-live="polite"` on the streaming bubble. Safety notice renders as a distinct, gentle card. Must never lose typed text on failure.
* **History** (`views/history.js`): debounced search (FTS, highlighted terms via DOM—not HTML), filters (mood, tag, pinned), month-grouped list, "Load more".
* **Insights** (`views/insights.js`): stat cards; mood line chart (SVG, accessible: `<title>`, table fallback); 90-day calendar heatmap; top emotions/tags bars; **Weekly reflection** generate (SSE stream) + past reports.
* **Memory** (`views/memory.js`): explanation + master toggles (`memory.enabled`, `autoExtract`, `useRelatedEntries`); list with inline edit, pin, delete, add, "clear all"; link to source entry.
* **Settings** (`views/settings.js`): tabs *Gemini (free)* / *OpenAI-compatible* / *Local model* / *General* / *Data*. Provider tab: key field (masked, show `apiKeyHint`/source), base URL (+ preset buttons), model combobox with **Load models**, **Test connection** (shows latency/sample or error + hint), **Use this provider** (sets `ai.provider`), privacy note. Local tab adds Ollama quick-start (copy-able commands), small-model suggestions, **Download model** with progress (SSE). General: your name, about, persona (cards + custom), temperature, max tokens, context budget, timeout, AI on/off, theme. Data: stats, export JSON/Markdown, import, wipe (typed confirmation).
* **Onboarding** (`views/onboarding.js`): three provider cards (Free Gemini · OpenAI-compatible · Local small model) + "Just journal, no AI"; sets `onboarded`.
* **Login** (`views/login.js`).

### UX bar
Calm, warm, uncluttered; serif for journal text, system sans for UI; keyboard-first; visible focus; `prefers-reduced-motion` respected;
WCAG AA contrast; works at 360 px wide (bottom tab bar on mobile, sidebar on ≥ 900 px); skeleton loaders, never blank screens; every
async button has loading + disabled states; every error is human-readable with a next step.

---------------------------------------------------------------------------------------------------

## 13. Testing strategy

* `node --test`, files `test/**/*.test.js`; each module has unit tests next to its mirror dir under `test/`.
* **Mock LLM servers** (`test/mocks/`, owned by the providers agent, reused by server + e2e tests):
  * `mock-openai.js` — `createMockOpenAI({ replies?, delayMs?, failures? })` → `{ url, close(), requests[] }`; implements `GET /v1/models`, `POST /v1/chat/completions` (SSE chunked **realistically**: role-only first delta, content deltas split mid-word/mid-UTF-8, `finish_reason` chunk, usage chunk, `[DONE]`; non-stream JSON mode), optional `<think>` blocks, error injection (401, 404 model, 429 with `retry-after`, 400 on `max_tokens`/`temperature`/`stream_options`, 500, hang, malformed chunk), plus Ollama endpoints `GET /api/version`, `POST /api/pull` (NDJSON progress).
  * `mock-gemini.js` — `createMockGemini({...})`: `GET /v1beta/models`, `POST /v1beta/models/:m:streamGenerateContent?alt=sse` and `:generateContent`, validates `x-goog-api-key`, alternation of roles, returns Google-style error JSON (invalid key = 400 `API_KEY_INVALID`, 429 with `RetryInfo`, 404, 503, safety block).
  * Replies are deterministic and *role-aware*: the mock inspects the prompt to answer title/summary/memory/wrap-up requests in the labelled-line formats of §8 so end-to-end flows are testable.
  * `serve.js` — CLI that starts both mocks (ports 11500/11501) for manual UI trials (`npm run mock-llm`).
* Server integration tests boot the real app on port 0 with a temp dir and the mocks.
* E2E (`test/e2e/*.e2e.js`): Playwright (`playwright-core`, Chromium at `$PLAYWRIGHT_BROWSERS_PATH` / `/opt/pw-browsers`), skipped
  gracefully when unavailable.
* A real small model smoke test is documented in `docs/PROVIDERS.md` (Ollama) — cannot run in CI.
