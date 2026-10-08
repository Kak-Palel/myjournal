# Privacy

A journal is about the most personal text you will ever write, so this page says plainly where your words go. It describes what the code does today; every statement here can be checked in the source.

- [The short version](#the-short-version)
- [What is stored, and where](#what-is-stored-and-where)
- [What leaves your computer](#what-leaves-your-computer): [free Gemini](#free-gemini) · [OpenAI-compatible](#openai-compatible-apis) · [local model](#local-model) · [no AI](#no-ai) · [voice dictation](#voice-dictation) · [anything else](#anything-else)
- [What the AI sees, request by request](#what-the-ai-sees-request-by-request)
- [Private entries](#private-entries)
- [Threat model](#threat-model)
- [How to reduce your exposure](#how-to-reduce-your-exposure)
- [Deleting things](#deleting-things)

## The short version

- Your journal is **one SQLite file on the computer that runs MyJournal**. There is no MyJournal server, no account, no analytics, no telemetry and no update check. The web page loads nothing from other sites.
- Text leaves your computer **only when you ask the AI companion for something**, and **only to the model provider you chose**. With a local model on the same computer, nothing leaves it at all. With the AI off, nothing leaves it.
- **Your API keys are stored unencrypted** in that same file if you paste them in Settings. Keys supplied through environment variables are never written to it.
- There is **no encryption at rest** and the app has **one user**. It is built for a computer you control; see the [threat model](#threat-model).

## What is stored, and where

| What | Where | Notes |
|---|---|---|
| Entries, your messages, the companion's replies, memories, weekly reflections, settings | `journal.db` in the data folder (`./data` by default, or `JOURNAL_DATA_DIR`), plus `journal.db-wal` / `journal.db-shm` while the server runs | A folder the app creates is readable by you only (mode 700, file 600). A full-text search index of your own writing lives in the same file. |
| API keys saved in Settings | the `settings` table of `journal.db` | **Unencrypted.** Never included in exports, never returned by the API (the app only sees "a key is set" and its last four characters), never written to logs or error messages. |
| Keys and passwords from the environment | the process environment only | Not written to the database. |
| Session login (only when `JOURNAL_PASSWORD` is set) | memory of the server; a cookie in your browser | The cookie `mj_session_<port>` is HTTP-only and same-site; the server keeps only a hash of its random token. A restart forgets all sessions. |
| Small preferences and unsent drafts | your browser's local storage on that device | Theme, the Insights range you picked, a dismissed nudge, and a draft of what you are typing (`mj-draft:…`), removed once the text is saved. Clear the site's data to remove any of it. |
| Logs | the terminal that runs the server | One line per request: method, path, status code and duration. Never bodies, headers, keys or query strings (so a search term is not logged). |

Exports (Settings → Data) contain your entries, including the ones marked private, memories and reports; they never contain settings or keys. The file you download is yours to protect.

## What leaves your computer

MyJournal's server talks to exactly one outside party, and only when needed: the AI provider you selected. The browser only ever talks to MyJournal itself (the page's Content-Security-Policy forbids anything else), so your API keys never reach the browser either.

### Free Gemini

Requests go over HTTPS to `generativelanguage.googleapis.com` (or the base URL you set), with your key in the `x-goog-api-key` header. Google receives what is listed [below](#what-the-ai-sees-request-by-request).

**Free-tier warning.** On the free tier Google may use your prompts and the model's responses to improve its products, and human reviewers may read them. Projects with billing enabled are not used that way. Rules differ by country and change: read Google's current terms. **Do not journal secrets with a free key.** If you cannot accept that, use a local model.

### OpenAI-compatible APIs

Requests go to whatever host is in the base URL, with `Authorization: Bearer <your key>`. That service's retention, logging and training policies apply: read them before writing anything sensitive. Some aggregators (OpenRouter and similar) forward your text on to further providers.

### Local model

Requests go to the address you set. For the default `http://localhost:11434/v1` that is a program on your own computer and **nothing leaves it**. Check where the address points:

- **Another computer on your network** (`http://192.168.1.20:11434/v1`): that computer sees your text, and it travels across your network in clear text.
- **A hosted address**: then it is not a local model any more.

Settings shows a warning under the address when it is not on your computer ("This address is another device on your network" or "…will travel over the internet to …").

Ollama's **Download model** button asks *your Ollama server* to download a model; Ollama itself then contacts its model registry. MyJournal sends no journal text for that.

### No AI

If you pick *Just journal, no AI* or switch off *Use the AI companion* in Settings → General, no request is ever made. Writing, saving, search, insights and export all work without it.

### Voice dictation

The **Dictate** button uses your browser's built-in speech recognition. That is the browser's feature, not MyJournal's: **in Chrome the audio is sent to Google's speech service**, other browsers do whatever theirs does, and Firefox has no support at all (the button then does not appear). MyJournal receives only the resulting text. Do not dictate what you would not send to your browser vendor.

### Anything else

- **Links.** A few help links (for example "get a key" at aistudio.google.com) open in a new tab only when you click them.
- **Updates and telemetry.** None. `npm start` makes no request on its own.
- **Fonts, scripts, images, maps.** All served from your own MyJournal; none from other sites.

## What the AI sees, request by request

Only a request you trigger sends text. What each one contains:

| You do | The model receives |
|---|---|
| Press **Send** (a reply) | A system prompt with the companion's style and rules, today's date, your name and "About you" text, your memories (if memory is on), up to 4 related older entries, 2 for a local model (title and summary or an excerpt; only if recall is on and this entry is not private), the guided session's instructions (guided journals only), the mood you logged for this entry, and the conversation of this entry, shortened to your context budget (default about 3,000 tokens). |
| Press **Wrap up** | The same again for the closing reflection. Then one small request with only what *you* wrote in the entry, for the title, summary, feelings and tags; then (unless the entry is private, or memory or auto-extract is off) one with what you wrote plus up to 12 of your existing memories, to find new lasting facts. |
| Press **Write my reflection** (weekly) | For each of up to 200 non-private entries in the period: date, title, summary (or the first 300 characters or so of what you wrote when there is no summary), mood, feelings and tags, plus your memories, name and "About you" text. |
| **Test connection** | The words "Reply with the single word: OK". No journal text. |
| **Load models** | Nothing but the request for the list (the key is sent). |

The AI never receives: other entries beyond the related ones above, your settings, other providers' keys, your password, or private entries (except the conversation of a private entry you chat in, see below). Your writing is sent as is: names, places and anything else in it included.

## Private entries

Mark an entry **Private** (the lock in the entry's menu) and it is **kept out of**:

- memory extraction at wrap-up,
- the "related past entries" that are shown to the model while it replies, both in this entry and as a source for other entries,
- weekly reflections.

It is **not** kept away from the AI in the entry itself: if you press Send in a private entry, the conversation of that entry goes to your provider like any other. For text no model should see, use **Save without reply**, or switch the AI off. Private entries still appear in your own history, search, insights counts and exports.

## Threat model

MyJournal is meant for **one person who controls the computer it runs on**.

**It defends against:**

- **Other people on your network.** By default it listens on `127.0.0.1` only. Listening elsewhere is refused unless a password is set (or you explicitly opt out).
- **Web pages in your browser trying to reach your journal.** A malicious site cannot read it (no CORS headers are ever sent, a strict Content-Security-Policy applies, all changes need a custom header and a matching `Origin`) and cannot trick the local server through DNS rebinding (the `Host` header is checked unless a password protects a non-loopback server).
- **Password guessing:** five wrong passwords from one address, then a one-minute wait; comparison in constant time.
- **Leaking secrets by accident:** keys are masked in the API, left out of exports and scrubbed from errors and logs.
- **Hostile text:** AI replies, imported files and your own entries are rendered as plain text and never as HTML or code; imports are validated field by field.

**It does not defend against:**

- **Anyone who can read your files or your user account.** There is no encryption at rest: the database and any saved API keys are readable by whoever can read the data folder, your backups, or a synced folder. Use full-disk encryption, keep the data folder out of cloud-synced locations unless you trust them, and prefer environment variables for keys.
- **Malware, browser extensions, or someone using your unlocked, signed-in browser.**
- **Network eavesdroppers when you serve it beyond your own computer without HTTPS.** MyJournal does not speak HTTPS; use a reverse proxy with TLS. The password and session cookie otherwise travel in clear text, as does text sent to a model on another computer.
- **Your AI provider.** Whatever you send to a cloud model is theirs to handle under their terms.
- **Multiple users.** There is one shared password and one journal.

## How to reduce your exposure

1. **Use a local model** for anything sensitive. Nothing leaves your computer.
2. If you use a cloud model, **prefer a paid, billing-enabled key** over the free tier, and read the provider's retention policy.
3. **Use Private entries and Save without reply** for text the AI should not touch, or turn the AI off for a while.
4. Keep API keys in **environment variables** instead of Settings, so they are never in the database file.
5. **Encrypt the disk**, keep `data/` out of cloud-synced folders, and back it up somewhere you trust.
6. Leave `HOST` at `127.0.0.1`. If you must serve it elsewhere: set `JOURNAL_PASSWORD` (long passphrase), put HTTPS in front, and publish the port on loopback only (the Docker Compose file does).
7. Dictate only if you are comfortable with your browser's speech service.
8. Remove what you no longer want: delete entries and memories, or [wipe everything](#deleting-things).

## Deleting things

- **An entry or a message:** removed from the database, from the search index and from related lists. Memories that were learned from a deleted entry stay (they are facts about you, listed on the Memory page) until you delete them; they no longer link to the entry.
- **Memories:** delete one, or *Clear all* on the Memory page.
- **Everything:** Settings → Data → *Delete everything* (type DELETE) removes all entries, messages, memories and reports, optionally your settings and saved API keys too, then compacts the file. There is no undo.
- **How thoroughly:** SQLite is run with `secure_delete` on, so deleted text is overwritten in the file, the search index is merged to drop old words, and a wipe compacts the database. The server also tidies the index when it shuts down cleanly. Copies you made yourself (exports, backups, a copied data folder) are untouched; so are copies at your AI provider, which you would have to ask them to delete.
