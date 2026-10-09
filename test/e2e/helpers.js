// Shared plumbing for the browser end-to-end suite (test/e2e/*.e2e.js).
//
//   * Finds Playwright and Chromium without adding a dependency to the product (see `prepare`), and SKIPS every test
//     with a readable reason when either is missing - the suite never fails just because a browser is not installed.
//   * `journey(options, async (j) => { ... })` boots the REAL app (src/server) on a free port with a temporary data
//     folder and mock LLM servers (test/mocks), opens a fresh browser context, runs the test body and tears everything
//     down again. After the body it asserts that the page produced no console errors or warnings, no uncaught page
//     errors, no CSP violations, no native dialogs and no unexpected HTTP error responses (zero-noise policy).
//   * Selectors in the tests use roles, labels and visible text - never CSS classes - so the CSS and DOM can be
//     polished without breaking the suite.
//
// Nothing here is a test file itself.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seedSampleJournal } from '../../scripts/demo-lib.js';
import { LIVE_MODELS, createMockGemini } from '../mocks/mock-gemini.js';
import { createMockOpenAI } from '../mocks/mock-openai.js';
import { startApp } from '../server/helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

export { describe, assert };

/* ------------------------------------------------------------------------------------------------------------ */
/* Playwright + Chromium discovery                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

const PLAYWRIGHT_CANDIDATES = [
  'playwright',
  'playwright-core',
  pathToFileURL('/opt/node-tools/node_modules/playwright/index.mjs').href,
];
const KNOWN_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** Import the first Playwright flavour that resolves. @returns {Promise<{ chromium?: object, tried: string[] }>} */
async function loadPlaywright() {
  const tried = [];
  for (const spec of PLAYWRIGHT_CANDIDATES) {
    try {
      const mod = await import(spec);
      const chromium = mod.chromium || (mod.default && mod.default.chromium);
      if (chromium) return { chromium, tried };
      tried.push(`${spec} (no chromium export)`);
    } catch (err) {
      tried.push(`${spec} (${err && err.code ? err.code : String(err && err.message).split('\n')[0]})`);
    }
  }
  return { tried };
}

/** CHROMIUM_PATH, else the sandbox's known Chromium, else undefined (= Playwright's own default browser). */
function chromiumExecutable() {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv) return fromEnv;
  if (existsSync(KNOWN_CHROMIUM)) return KNOWN_CHROMIUM;
  return undefined;
}

/** Browser flags: no sandbox when running as root (containers), no proxy so loopback is always direct. */
function launchArgs() {
  const args = ['--no-proxy-server', '--disable-dev-shm-usage', '--hide-scrollbars'];
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  if (root || process.env.CI) args.push('--no-sandbox');
  return args;
}

/** Launch the shared browser once per test file. Never throws: a missing browser becomes a skip reason. */
async function prepare() {
  if (process.env.E2E_SKIP) return { ok: false, reason: `E2E_SKIP is set (${process.env.E2E_SKIP})` };
  const { chromium, tried } = await loadPlaywright();
  if (!chromium) {
    return { ok: false, reason: `Playwright is not installed (tried ${tried.join(', ')}). Install it outside the repo, e.g. "npm i playwright-core" in a scratch folder, and make it resolvable.` };
  }
  const executablePath = chromiumExecutable();
  try {
    const browser = await chromium.launch({ headless: true, executablePath, args: launchArgs() });
    return { ok: true, browser, executablePath: executablePath || '(playwright default)' };
  } catch (err) {
    const why = String(err && err.message).split('\n').find((l) => l.trim()) || 'unknown error';
    return { ok: false, reason: `Chromium could not be launched (${executablePath || 'playwright default'}): ${why}. Set CHROMIUM_PATH to a Chromium executable.` };
  }
}

const env = await prepare();

/** `false` when the suite can run, otherwise the human readable reason every test is skipped for. */
export const SKIP_REASON = env.ok ? false : `E2E skipped: ${env.reason}`;
if (!env.ok) process.stderr.write(`\n[e2e] ${SKIP_REASON}\n`);

// Close the browser when this test file's root suite is done, and kill it if the process dies first: a live
// browser keeps the event loop (and therefore `node --test`) alive forever.
after(async () => { if (env.ok) await env.browser.close().catch(() => {}); });
process.once('exit', () => {
  if (env.ok) { try { env.browser.process()?.kill('SIGKILL'); } catch { /* already gone */ } }
});

const DEFAULT_TEST_TIMEOUT_MS = 90_000;

/**
 * node:test `it` that is skipped (with the reason) when no browser is available, and has a hard timeout so a stuck
 * journey can never hang the run.
 * @param {string} name
 * @param {object|Function} optionsOrFn
 * @param {Function} [maybeFn]
 */
export function test(name, optionsOrFn, maybeFn) {
  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn || {};
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  const merged = { timeout: DEFAULT_TEST_TIMEOUT_MS, ...options };
  // E2E_RUN_BUGS=1 runs the tests that are skipped for a confirmed bug (they must FAIL until the bug is fixed)
  if (process.env.E2E_RUN_BUGS && typeof merged.skip === 'string' && merged.skip.startsWith('BUG:')) delete merged.skip;
  if (SKIP_REASON && !merged.skip) merged.skip = SKIP_REASON;
  return it(name, merged, fn);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Small async helpers                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-run `fn` until it stops throwing and does not return `false`. Use for assertions about state that settles
 * (server side effects, streaming text, settings saved in the background).
 */
export async function eventually(fn, { timeout = 8000, interval = 40, message = 'the condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    try {
      const value = await fn();
      if (value !== false) return value;
      last = new Error('returned false');
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeout} ms waiting for ${message}${last ? `\n  last result: ${last.message}` : ''}`, { cause: last });
    }
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Diagnostics: everything the page complains about                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

const FAILED_RESOURCE_RE = /Failed to load resource: the server responded with a status of (\d+)/;

/**
 * Collects console errors/warnings, uncaught page errors, CSP violations, native dialogs, failed requests and HTTP
 * error responses of one page. `assertClean()` fails the journey when anything unexpected was recorded.
 */
class Diagnostics {
  constructor(page, origin) {
    this.origin = origin;
    this.console = [];
    this.pageErrors = [];
    this.csp = [];
    this.dialogs = [];
    this.responses = [];
    this.failedRequests = [];
    this.crashes = [];
    /** Requests the BROWSER made to anything but the app itself (the app must never talk to a third party). */
    this.external = [];
    this.allowExternal = false;
    /** @type {{ status: number, path: RegExp|string }[]} */
    this.expectedStatuses = [];
    /** @type {RegExp[]} */
    this.allowedConsole = [];
    /** @type {RegExp[]} */
    this.allowedFailedRequests = [];
    this.allowDialogTypes = new Set(['beforeunload']);

    page.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      this.console.push({ type, text: msg.text(), url: msg.location().url || '' });
    });
    page.on('pageerror', (err) => this.pageErrors.push(String((err && err.stack) || err)));
    page.on('crash', () => this.crashes.push('the page crashed'));
    page.on('response', (res) => {
      if (res.status() >= 400 && res.url().startsWith(origin)) {
        this.responses.push({ status: res.status(), method: res.request().method(), path: new URL(res.url()).pathname });
      }
    });
    page.on('request', (req) => {
      const url = req.url();
      if (/^(data|blob|about):/.test(url)) return;
      let o = '';
      try { o = new URL(url).origin; } catch { o = url; }
      if (o !== origin) this.external.push(`${req.method()} ${url}`);
    });
    page.on('requestfailed', (req) => {
      const failure = (req.failure() && req.failure().errorText) || 'failed';
      if (/ERR_ABORTED/.test(failure)) return; // an aborted fetch (Stop, navigation) is normal
      this.failedRequests.push(`${req.method()} ${req.url()} - ${failure}`);
    });
    page.on('dialog', async (dialog) => {
      this.dialogs.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === 'beforeunload') await dialog.accept().catch(() => {});
      else await dialog.dismiss().catch(() => {});
    });
  }

  /** Declare that HTTP `status` for requests whose path matches is part of the scenario (and its console echo too). */
  expectStatus(status, path = /./) {
    this.expectedStatuses.push({ status, path });
  }

  /** Declare that console messages matching `pattern` are part of the scenario. */
  allowConsole(pattern) {
    this.allowedConsole.push(pattern);
  }

  /** Declare that requests that fail at the network level ("METHOD url - error") matching `pattern` are part of the scenario (a stopped server). */
  allowFailedRequests(pattern) {
    this.allowedFailedRequests.push(pattern);
  }

  /** Allow a native dialog type (alert/confirm/prompt are NOT expected anywhere in this app). */
  allowDialog(type) {
    this.allowDialogTypes.add(type);
  }

  #matchesExpected(status, path) {
    return this.expectedStatuses.some((e) => e.status === status && (typeof e.path === 'string' ? path.includes(e.path) : e.path.test(path)));
  }

  /** Everything unexpected that was seen so far, as readable lines. */
  problems() {
    const out = [];
    for (const c of this.console) {
      if (this.allowedConsole.some((re) => re.test(c.text))) continue;
      const m = FAILED_RESOURCE_RE.exec(c.text);
      if (m) {
        let path = c.url;
        try { path = new URL(c.url).pathname; } catch { /* keep raw */ }
        if (this.#matchesExpected(Number(m[1]), path)) continue;
      }
      out.push(`console.${c.type}: ${c.text}${c.url ? ` (${c.url})` : ''}`);
    }
    for (const e of this.pageErrors) out.push(`uncaught page error: ${e}`);
    for (const v of this.csp) out.push(`CSP violation: ${JSON.stringify(v)}`);
    for (const r of this.responses) {
      if (!this.#matchesExpected(r.status, r.path)) out.push(`unexpected HTTP ${r.status}: ${r.method} ${r.path}`);
    }
    if (!this.allowExternal) for (const x of this.external) out.push(`the browser contacted a third party: ${x}`);
    for (const f of this.failedRequests) if (!this.allowedFailedRequests.some((re) => re.test(f))) out.push(`request failed: ${f}`);
    for (const d of this.dialogs) {
      if (!this.allowDialogTypes.has(d.type)) out.push(`native ${d.type} dialog opened: ${d.message}`);
    }
    for (const c of this.crashes) out.push(c);
    return out;
  }

  assertClean(label = 'page') {
    const problems = this.problems();
    assert.deepEqual(problems, [], `${label} produced browser noise:\n  ${problems.join('\n  ')}`);
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Booting the app + mocks                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

export const OPENAI_KEY = 'test-openai-key';
export const GEMINI_KEY = 'test-gemini-key';
export const PASSWORD = 'correct horse battery staple';

/**
 * @typedef {object} JourneyOptions
 * @property {boolean} [fresh] brand-new journal: not onboarded, nothing configured (default false)
 * @property {''|'local'|'openai'|'gemini'} [provider] active provider (default 'local'; '' = AI not set up). Ignored when `fresh`.
 * @property {boolean} [onboarded] default true unless `fresh`
 * @property {object} [mocks] which mock LLM servers to start and their options:
 *     { local?: object|true, openai?: object|true, gemini?: object|true }. `local` is started by default.
 *     `local` and `openai` are OpenAI-compatible mocks (openai requires the key OPENAI_KEY); `gemini` requires GEMINI_KEY.
 * @property {boolean} [configureMocks] point the three providers' saved settings at the mocks (default true unless `fresh`)
 * @property {object} [settings] extra settings patch (deep-merged last)
 * @property {string} [password] start the app with JOURNAL_PASSWORD
 * @property {object} [config] server configuration overrides (for example a fixed `port` when a test stops and restarts the server)
 * @property {Record<string, string>} [env] the server's environment (what `process.env` is to a real run). Only these variables exist
 *     for the app, never the developer's own shell: GEMINI_API_KEY, OPENAI_API_KEY, LOCAL_LLM_API_KEY, ...
 * @property {boolean} [keysInEnv] the mocks' API keys are NOT saved in Settings but handed over in the environment instead
 *     (GEMINI_API_KEY / OPENAI_API_KEY), as when somebody starts the app with their keys exported
 * @property {'demo'|((db: object) => void)|null} [seed] fill the journal before the browser opens
 * @property {{ width: number, height: number }} [viewport] default 1280x800
 * @property {'light'|'dark'} [colorScheme] default 'light'
 * @property {boolean} [mobile] emulate a touch phone (hasTouch, isMobile)
 * @property {string} [name] label used in failure artefacts
 */

/** Turn mock option shorthands into real options. */
const mockOptions = (value) => (value === true || value === undefined ? {} : value);

/**
 * Boot the app, run `fn`, always clean up.
 * @param {JourneyOptions} options
 * @param {(j: object) => Promise<void>} fn
 */
export async function journey(options, fn) {
  const o = { fresh: false, provider: 'local', mocks: { local: true }, ...options };
  if (!env.ok) throw new Error(SKIP_REASON);
  const closers = [];
  const mocks = {};
  let app = null;
  let context = null;
  let page = null;
  let diag = null;
  let ok = false;
  try {
    if (o.mocks.local) { mocks.local = await createMockOpenAI(mockOptions(o.mocks.local)); closers.push(() => mocks.local.close()); }
    if (o.mocks.openai) { mocks.openai = await createMockOpenAI({ apiKey: [OPENAI_KEY], ...mockOptions(o.mocks.openai) }); closers.push(() => mocks.openai.close()); }
    if (o.mocks.gemini) {
      mocks.gemini = await createMockGemini({ apiKey: [GEMINI_KEY], models: [...LIVE_MODELS], ...mockOptions(o.mocks.gemini) });
      closers.push(() => mocks.gemini.close());
    }

    const configure = o.configureMocks ?? !o.fresh;
    const providers = {};
    if (configure && mocks.local) providers.local = { baseUrl: mocks.local.baseUrl, model: 'llama3.2:3b' };
    const saved = (key) => (o.keysInEnv ? {} : { apiKey: key });
    if (configure && mocks.openai) providers.openai = { baseUrl: mocks.openai.baseUrl, model: 'mock-model', ...saved(OPENAI_KEY) };
    if (configure && mocks.gemini) providers.gemini = { baseUrl: mocks.gemini.url, ...saved(GEMINI_KEY) };
    const serverEnv = { ...(o.keysInEnv && mocks.openai ? { OPENAI_API_KEY: OPENAI_KEY } : {}), ...(o.keysInEnv && mocks.gemini ? { GEMINI_API_KEY: GEMINI_KEY } : {}), ...(o.env || {}) };
    const settings = {};
    if (!o.fresh) settings.onboarded = o.onboarded ?? true;
    else if (o.onboarded) settings.onboarded = true;
    const ai = {};
    if (Object.keys(providers).length) ai.providers = providers;
    if (!o.fresh) ai.provider = o.provider ?? 'local';
    if (Object.keys(ai).length) settings.ai = ai;
    const merged = deepMerge(settings, o.settings || {});

    app = await startApp({
      ai: false,
      settings: merged,
      // E2E_PUBLIC_DIR serves another copy of public/ (for example the one from an older commit) to prove that a regression
      // test fails on the old frontend and passes on the new one.
      config: { ...(process.env.E2E_PUBLIC_DIR ? { publicDir: resolve(process.env.E2E_PUBLIC_DIR) } : {}), ...(o.password ? { password: o.password } : {}), ...(o.config || {}) },
      env: serverEnv,
    });
    closers.push(() => app.close());
    if (o.seed === 'demo') seedSampleJournal(app.db);
    else if (typeof o.seed === 'function') await o.seed(app.db, app);

    context = await env.browser.newContext({
      viewport: o.viewport || { width: 1280, height: 800 },
      colorScheme: o.colorScheme || 'light',
      locale: 'en-US',
      acceptDownloads: true,
      permissions: ['clipboard-read', 'clipboard-write'],
      ...(o.mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
    });
    closers.push(() => context.close());
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(20_000);
    diag = new Diagnostics(page, new URL(app.url).origin);
    await page.exposeFunction('__mjReportCsp', (v) => diag.csp.push(v));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        try {
          window.__mjReportCsp({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: e.sample });
        } catch { /* binding gone */ }
      });
    });

    const j = makeJourneyApi({ page, context, app, mocks, diag, options: o });
    await fn(j);
    diag.assertClean(`journey "${o.name || 'unnamed'}"`);
    ok = true;
  } catch (err) {
    await annotateFailure(err, { page, diag, name: o.name });
    throw err;
  } finally {
    for (const close of closers.reverse()) {
      try { await close(); } catch { /* best effort */ }
    }
    void ok;
  }
}

function deepMerge(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' ? deepMerge(target[k], v) : v;
  }
  return out;
}

/** On failure: append the URL, visible text and recorded noise to the error and save a screenshot. */
async function annotateFailure(err, { page, diag, name }) {
  if (!err || typeof err !== 'object') return;
  const lines = [];
  try {
    if (page && !page.isClosed()) {
      lines.push(`url: ${page.url()}`);
      const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      lines.push(`visible text (first 1500 chars):\n${String(text).slice(0, 1500)}`);
      const dir = process.env.E2E_ARTIFACTS_DIR || join(REPO_ROOT, 'test-results', 'e2e');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${String(name || 'journey').replace(/[^a-z0-9]+/gi, '-').slice(0, 80)}.png`);
      await page.screenshot({ path: file, fullPage: true }).then(() => lines.push(`screenshot: ${file}`)).catch(() => {});
    }
    if (diag) {
      const p = diag.problems();
      if (p.length) lines.push(`browser noise so far:\n  ${p.join('\n  ')}`);
    }
  } catch { /* diagnostics must never hide the real failure */ }
  if (lines.length) err.message = `${err.message}\n--- e2e diagnostics ---\n${lines.join('\n')}`;
}

/** What a journey body receives. */
function makeJourneyApi({ page, context, app, mocks, diag, options }) {
  const origin = new URL(app.url).origin;
  return {
    page,
    context,
    app,
    db: app.db,
    mocks,
    mock: mocks.local,
    diag,
    origin,
    options,
    /** Open `#/path`: a full page load on a blank tab, an in-app hash navigation otherwise. */
    async goto(path = '/') {
      const hash = `#${path.startsWith('/') ? path : `/${path}`}`;
      if (page.url() === 'about:blank') await page.goto(`${origin}/${hash}`);
      else await page.evaluate((h) => { window.location.hash = h; }, hash);
    },
    /** Fresh page load of `#/path` regardless of the current page (a deep link typed into the address bar). */
    async load(path = '/') {
      await page.goto('about:blank');
      await page.goto(`${origin}/#${path.startsWith('/') ? path : `/${path}`}`);
    },
    /** Reload the current page (keeps the hash). */
    async reload() {
      await page.reload();
    },
    /** fetch() from inside the page (cookies and the CSRF header included). */
    api(method, path, body) {
      return page.evaluate(async ({ method: m, path: p, body: b }) => {
        const res = await fetch(`/api${p}`, {
          method: m,
          headers: { 'X-MyJournal': '1', ...(b === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: b === undefined ? undefined : JSON.stringify(b),
          credentials: 'same-origin',
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, text, json };
      }, { method, path, body });
    },
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Data seeding                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

export { seedSampleJournal };

const MOOD_CYCLE = [1, 2, 3, 4, 5, null];
const TAG_CYCLE = [['work'], ['family', 'home'], ['running'], ['gratitude'], [], ['work', 'planning']];

/**
 * Add `count` plain entries (one user message each), newest first, one per hour going back from now, so that
 * History needs several pages. Titles are "Bulk entry 001" (001 = newest).
 */
export function seedBulk(db, count, { titlePrefix = 'Bulk entry', startHoursAgo = 30 } = {}) {
  const now = Date.now();
  const pad = (n) => String(n).padStart(2, '0');
  db.tx(() => {
    for (let i = 0; i < count; i += 1) {
      const created = new Date(now - (startHoursAgo + i) * 3600_000);
      const date = `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}`;
      const entry = db.entries.create({
        createdAt: created.getTime(),
        date,
        title: `${titlePrefix} ${String(i + 1).padStart(3, '0')}`,
        mood: MOOD_CYCLE[i % MOOD_CYCLE.length],
        tags: TAG_CYCLE[i % TAG_CYCLE.length],
        emotions: i % 4 === 0 ? ['calm'] : [],
      });
      const m = db.messages.add(entry.id, { role: 'user', content: `Plain note number ${i + 1} about ordinary things.`, createdAt: created.getTime() + 1000 });
      db.entries.update(entry.id, { updatedAt: m.createdAt });
    }
  });
}

/** Create one entry with the given messages [[role, text, meta?], ...] and return it. */
export function seedEntry(db, { title = '', mood = null, tags = [], emotions = [], messages = [], ...rest } = {}) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const entry = db.entries.create({ title, mood, tags, emotions, date, ...rest });
  for (const [role, content, meta] of messages) db.messages.add(entry.id, { role, content, meta });
  return db.entries.get(entry.id);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* UI actions shared by the journeys (roles, labels and text only)                                               */
/* ------------------------------------------------------------------------------------------------------------ */

export const ui = {
  todayBox: (page) => page.getByLabel('Write a new journal entry'),
  entryBox: (page) => page.getByLabel('Write in your journal'),
  mood: (page, label) => page.getByRole('radio', { name: label, exact: true }),
  button: (page, name, opts = {}) => page.getByRole('button', { name, exact: true, ...opts }),
  tab: (page, name) => page.getByRole('tab', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }),
  /** The companion's chat bubbles (replies, prompts, reflections). */
  companion: (page) => page.getByRole('article').filter({ hasText: 'Companion:' }),
  /** The person's own chat bubbles. */
  mine: (page) => page.getByRole('article').filter({ hasText: 'You wrote:' }),
  /** The real checkbox behind a switch (role=switch). It is visually replaced by a track, so use `flip` to click it. */
  switch: (page, name) => page.getByRole('switch', { name }),
  /** Click a switch the way a person does: on its label. */
  flip: (page, name) => page.getByRole('switch', { name }).locator('xpath=ancestor::label[1]').click(),
  heading: (page, name, level) => page.getByRole('heading', { name, ...(level ? { level } : {}) }),
  toast: (page, text) => page.getByRole('status').filter({ hasText: text }),

  /** Type into the Today box (and optionally pick a mood) without sending. */
  async fillToday(page, text, { mood } = {}) {
    const box = ui.todayBox(page);
    await box.waitFor();
    await box.fill(text);
    if (mood) await ui.mood(page, mood).click();
  },
  /** Today: fill the box and press "Start journaling"; resolves once the entry page is showing. */
  async startJournaling(page, text, { mood } = {}) {
    await ui.fillToday(page, text, { mood });
    await page.getByRole('button', { name: 'Start journaling' }).click();
    await page.waitForURL(/#\/entry\//);
    await ui.entryBox(page).waitFor();
  },
  /** The id in the current `#/entry/:id` URL. */
  entryId(page) {
    const m = /#\/entry\/([^?]+)/.exec(page.url());
    return m ? decodeURIComponent(m[1]) : null;
  },
  /** Open Settings on a tab by clicking through the UI (`label` is the visible tab text, e.g. 'Local model'). */
  async openSettings(page, tabLabel) {
    await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
    await ui.heading(page, 'Settings', 1).waitFor();
    if (tabLabel) {
      await ui.tab(page, tabLabel).click();
      await page.getByRole('tabpanel').filter({ visible: true }).first().waitFor();
    }
  },
  /** Wait for the app shell and the first view (any heading in <main>). */
  async ready(page) {
    await page.getByRole('main').waitFor();
    await page.getByRole('main').getByRole('heading').first().waitFor();
  },
  /** True when nothing sticks out sideways (the mobile layout check). */
  noHorizontalScroll: (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
};

/**
 * Runs INSIDE the page (pass it to `page.evaluate`): every visible piece of text whose colour contrast against its
 * background is below WCAG AA (4.5:1, or 3:1 for large text). Text on gradients/images and disabled controls is skipped.
 * @param {{ ignore?: string[], only?: string[] }} [options] CSS selectors: text inside `ignore` is skipped; with `only`, just
 *   text inside those is looked at (used to pin down one known problem separately from the general check)
 * @returns {{ text: string, ratio: number, need: number, size: number, fg: string, bg: string, tag: string }[]}
 */
export function contrastAudit(options) {
  const ignore = (options && options.ignore) || [];
  const only = (options && options.only) || [];
  const parse = (str) => {
    let m = /^rgba?\(([^)]+)\)$/.exec(str.trim());
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
    }
    m = /^color\(srgb ([^)]+)\)$/.exec(str.trim());
    if (m) {
      const p = m[1].split(/[ /]+/).filter(Boolean).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] === undefined ? 1 : p[3] };
    }
    return null;
  };
  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
  });
  const lum = ({ r, g, b }) => {
    const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  function backgroundOf(el) {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    const rootBg = parse(getComputedStyle(document.documentElement).backgroundColor);
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
    if (bodyBg && bodyBg.a > 0) base = blend(bodyBg, base);
    else if (rootBg && rootBg.a > 0) base = blend(rootBg, base);
    for (const layer of layers.reverse()) base = blend(layer, base);
    return base;
  }
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || ['SCRIPT', 'STYLE', 'OPTION', 'TITLE', 'DESC'].includes(el.tagName)) continue;
    seen.add(el);
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    if (el.closest('[aria-hidden="true"], [hidden], .sr-only, svg')) continue;
    if (el.closest('button:disabled, input:disabled, [aria-disabled="true"], select:disabled')) continue;
    if (ignore.length && el.closest(ignore.join(','))) continue;
    if (only.length && !el.closest(only.join(','))) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.right < 0) continue;
    const cs = getComputedStyle(el);
    const fgRaw = parse(cs.color);
    const bg = backgroundOf(el);
    if (!fgRaw || !bg) continue;
    let opacity = 1;
    for (let n = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    const fg = blend({ ...fgRaw, a: fgRaw.a * opacity }, bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got < need) {
      out.push({
        text: text.slice(0, 50), ratio: Math.round(got * 100) / 100, need, size, fg: cs.color,
        bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`, tag: el.tagName.toLowerCase(),
      });
    }
  }
  return out;
}

/** Wait until no CSS transition or one-off animation is still running (computed styles are mid-way values until then). */
export function settleAnimations(page) {
  return page.evaluate(async () => {
    const finite = () => document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity && a.playState === 'running');
    for (let i = 0; i < 10 && finite().length; i += 1) await Promise.allSettled(finite().map((a) => a.finished));
  });
}

/** `contrastAudit` run on a page whose transitions have finished. */
export async function auditContrast(page, options) {
  await settleAnimations(page);
  return page.evaluate(contrastAudit, options);
}

/** `lightSurfaces` run on a page whose transitions have finished. */
export async function auditLightSurfaces(page) {
  await settleAnimations(page);
  return page.evaluate(lightSurfaces);
}

/**
 * Runs INSIDE the page: opaque, reasonably large boxes whose background is light. Used in dark mode to spot surfaces
 * (inputs, dialogs, cards, charts) that were forgotten when the dark palette was defined.
 * @returns {string[]}
 */
export function lightSurfaces() {
  const lum = (c) => {
    const m = c.match(/[\d.]+/g).map(Number);
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
  };
  const out = [];
  for (const el of document.querySelectorAll('body, body *')) {
    if (!el.checkVisibility()) continue;
    const cs = getComputedStyle(el);
    const m = cs.backgroundColor.match(/[\d.]+/g);
    if (!m || (m.length > 3 && Number(m[3]) < 0.9)) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 1500) continue;
    if (lum(cs.backgroundColor) > 0.5) out.push(`${el.tagName.toLowerCase()} ${cs.backgroundColor} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return out;
}

/**
 * Press Tab up to `stops` times and report, for every stop, whether focusing it visibly changes the page (pixel
 * comparison of the viewport with and without focus). This is independent of HOW the focus ring is drawn (outline,
 * shadow, a card highlight through :has()), so it catches only a genuinely invisible focus.
 * @returns {Promise<{ stops: string[], invisible: string[] }>}
 */
export async function focusAudit(page, { stops = 30 } = {}) {
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.mouse.move(0, 0);
  const names = [];
  const invisible = [];
  let previous = null;
  for (let i = 0; i < stops; i += 1) {
    await page.keyboard.press('Tab');
    const handle = await page.evaluateHandle(() => document.activeElement);
    const same = previous ? await page.evaluate(([a, b]) => a === b, [previous, handle]) : false;
    const isBody = await page.evaluate((el) => el === document.body, handle);
    if (isBody) break;
    if (!same) {
      const name = await page.evaluate((el) => `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.type || '').trim().slice(0, 30)}"`, handle);
      names.push(name);
      const focused = await page.screenshot({ animations: 'disabled' });
      await page.evaluate((el) => el.blur(), handle);
      const blurred = await page.screenshot({ animations: 'disabled' });
      await page.evaluate((el) => el.focus(), handle);
      if (focused.equals(blurred)) invisible.push(name);
    }
    previous = handle;
  }
  return { stops: names, invisible };
}

/**
 * Evidence that hostile text became markup or code: any element that should not exist inside the app, any inline event
 * handler attribute, any javascript: link, or a fired payload (`window.__xss`). An empty list is the goal.
 * @returns {Promise<string[]>}
 */
export function injectionReport(page) {
  return page.evaluate(() => {
    const found = [];
    if (window.__xss !== undefined) found.push(`window.__xss was set to ${String(window.__xss)}`);
    const root = document.getElementById('app') || document.body;
    for (const el of root.querySelectorAll('img, iframe, object, embed, script, style, link, form[action^="javascript" i]')) {
      found.push(`unexpected <${el.tagName.toLowerCase()}> element`);
    }
    for (const el of document.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        if (/^on/i.test(attr.name)) found.push(`<${el.tagName.toLowerCase()} ${attr.name}>`);
        if (/^(href|src|action|formaction|xlink:href)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value)) found.push(`<${el.tagName.toLowerCase()} ${attr.name}="javascript:...">`);
      }
    }
    return found;
  });
}

/** Text of every `input`, `textarea` and `select` value on the page (to prove a secret is not sitting in a field). */
export function allFieldValues(page) {
  return page.evaluate(() => [...document.querySelectorAll('input, textarea, select')].map((el) => (el.type === 'file' ? '' : el.value)));
}

/** Everything the page could leak a typed secret into: markup, field values, web storage. */
export async function pageContainsSecret(page, secret) {
  return page.evaluate((needle) => {
    const hits = [];
    if (document.documentElement.outerHTML.includes(needle)) hits.push('markup');
    if (document.body.innerText.includes(needle)) hits.push('visible text');
    for (const el of document.querySelectorAll('input, textarea')) if (el.type !== 'file' && el.value.includes(needle)) hits.push(`field ${el.type}`);
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (k.includes(needle) || String(store.getItem(k)).includes(needle)) hits.push('web storage');
      }
    }
    return hits;
  }, secret);
}

/** Read a Playwright download into a string. */
export async function readDownload(download) {
  const path = await download.path();
  return readFileSync(path, 'utf8');
}

/** Hostile strings that must show up as text and never run. Each tries to set window.__xss. */
export const XSS_PAYLOADS = Object.freeze({
  img: '<img src=x onerror="window.__xss=(window.__xss||0)+1">',
  script: '<script>window.__xss=(window.__xss||0)+1</script>',
  svg: '<svg onload="window.__xss=(window.__xss||0)+1"></svg>',
  anchor: '[click me](javascript:window.__xss=1) <a href="javascript:window.__xss=1">x</a>',
  attr: '"><b onmouseover="window.__xss=1">hover</b>',
  iframe: '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>',
});
