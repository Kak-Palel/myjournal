# Browser end-to-end tests

Real Chromium against the real app (`src/server`) on a free port, with a temporary data folder and the mock LLM servers from
`test/mocks`. No fixed ports, nothing outside the machine is contacted, everything is closed again in `finally` blocks.

```bash
npm run test:e2e                              # the whole suite (about 4-5 minutes)
node --test test/e2e/keyboard.e2e.js          # one journey file
node --test --test-name-pattern="history" test/e2e/*.e2e.js
E2E_ARTIFACTS_DIR=/tmp/shots npm run test:e2e # where failure screenshots go (default: test-results/e2e/, git-ignored)
```

The product has zero dependencies and so does this folder. Playwright is looked up at run time, in this order:
`import('playwright')`, `import('playwright-core')`, `/opt/node-tools/node_modules/playwright/index.mjs`.
Chromium is `$CHROMIUM_PATH`, else `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, else Playwright's own default.

## When there is no browser

If Playwright or Chromium cannot be found or started, every test is reported as **skipped** with the reason
(for example `E2E skipped: Playwright is not installed (tried playwright (ERR_MODULE_NOT_FOUND), ...)`), a line is printed to
stderr, and the run still succeeds. Set `E2E_SKIP=1` to skip on purpose.

## How a journey is written

```js
import { describe, journey, test, ui, assert } from './helpers.js';

describe('something', () => {
  test('does a thing', () => journey({ provider: 'local', seed: 'demo', mocks: { local: { delayMs: 30 } } }, async (j) => {
    await j.goto('/history');
    await ui.heading(j.page, 'History', 1).waitFor();
    ...
  }));
});
```

* `journey()` boots the app and mocks, opens a fresh browser context, runs the body and always cleans up. Options: `fresh`
  (not onboarded), `provider`, `mocks` (`local`, `openai`, `gemini` and their options), `seed` (`'demo'` or `(db) => ...`),
  `password`, `viewport`, `mobile`, `colorScheme`, `settings`.
* After the body, `journey()` fails the test if the page produced any console error or warning, uncaught exception, CSP
  violation, native dialog, failed request, request to another origin, or an HTTP error that the test did not declare with
  `j.diag.expectStatus(status, pathPattern)`. Zero noise is part of every journey.
* On failure the error carries the URL, the visible text and a screenshot path.
* Selectors use roles, labels and visible text only (no CSS classes), so the styling can change freely.
* `{ skip: 'BUG: ...' }` marks a test that asserts the CORRECT behaviour of a confirmed, still unfixed bug. Remove the skip
  when the bug is fixed. `E2E_RUN_BUGS=1 npm run test:e2e` runs those tests anyway: each one must FAIL while its bug exists
  (that is how they were verified) and pass once it is fixed - remove its skip then.

## Files

| File | Journey |
|---|---|
| `first-run.e2e.js` | welcome screen, Local model, Test connection, Save, "Just journal, no AI" |
| `write-and-reply.e2e.js` | mood, streamed reply, Stop, Regenerate, Wrap up, memory |
| `guided.e2e.js` | Rose, Thorn, Bud and other guided journals |
| `history.e2e.js` | months, Load more, search, filters, deep links |
| `insights.e2e.js` | stats, charts, range, weekly reflection |
| `memory.e2e.js` | add, pin, edit, delete, clear, the three switches and their effect |
| `settings-providers.e2e.js` | Gemini / OpenAI-compatible / Local tabs, key masking, error states, downloads, unsaved changes |
| `settings-general.e2e.js` | name, style, limits, AI on/off, theme |
| `data.e2e.js` | export, import round trip, wipe |
| `auth.e2e.js` | password login, logout, expiry, rate limit |
| `no-ai.e2e.js` | AI not set up, switched off, key missing |
| `provider-errors.e2e.js` | every way a model call can fail, with Try again |
| `keyboard.e2e.js` | keyboard-only use, tab order, visible focus |
| `responsive.e2e.js` | phones (390x844, 360x740), breakpoints, zoom |
| `appearance.e2e.js` | dark mode, WCAG AA contrast, reduced motion |
| `deep-links.e2e.js` | addresses, reloads, Back/Forward, missing entries |
| `security.e2e.js` | hostile text, CSP, CSRF, no third parties |
| `navigation-streaming.e2e.js` | leaving pages mid-stream, double actions |
| `gemini.e2e.js` | the Gemini adapter as the live service behaves: request shape, thinking, retired / busy models, quotas |
| `local-models.e2e.js` | Ollama / llama.cpp flavours: hidden reasoning, GGUF path model names, tiny context windows |
| `composer.e2e.js` | drafts, the 20,000 character limit, copy/delete messages, header controls, Today's prompt and nudge |
