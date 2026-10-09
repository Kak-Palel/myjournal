import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../src/db/index.js';
import { buildWrapUpMessages } from '../../src/journal/context.js';
import { computeOverview } from '../../src/journal/insights.js';
import { respond } from '../mocks/mock-responder.js';
import { defaultSettings } from '../../src/settings.js';
import { nudgeState } from '../../public/js/components/today-logic.js';
import { seedSampleJournal, startDemo } from '../../scripts/demo-lib.js';
import { rawRequest, sse } from './helpers.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CRASH_LATER = fileURLToPath(new URL('./fixtures/crash-later.mjs', import.meta.url));

describe('seedSampleJournal does not depend on the time of day', () => {
  // Regression: the sample report was "7 days ago at 09:00", still under 7 days old before 09:00, so the weekly nudge never showed for a
  // demo (and the browser tests) started between midnight and 09:00; and the browser tests assume where a plain entry written 28
  // hours ago sorts among the samples.
  const pad = (n) => String(n).padStart(2, '0');
  const dateOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  it('at every half hour of the day: the weekly nudge is due, the streak is alive and the newest entry is last night\'s', () => {
    for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
      const now = new Date(2026, 9, 9, Math.floor(minutes / 60), minutes % 60);
      const at = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const db = openDb({ file: ':memory:' });
      try {
        seedSampleJournal(db, now);
        const today = dateOf(now);
        const overview = computeOverview({ entries: db.entries.rowsForInsights({}), today, days: 90 });
        const nudge = nudgeState({ calendar: overview.calendar, reports: db.reports.list(), today, now: now.getTime() });
        assert.equal(nudge.show, true, `${at}: the weekly reflection nudge shows (${nudge.count} entries this week)`);
        assert.ok(overview.streak.current >= 1, `${at}: a streak is running`);
        const byTitle = Object.fromEntries(db.entries.list({ limit: 50 }).map((e) => [e.title, e]));
        const firstTitle = db.entries.list({ limit: 1 })[0].title;
        assert.equal(firstTitle, 'A slow day with Miso', `${at}: newest first`);
        const plain = now.getTime() - 28 * 3600_000;
        assert.ok(byTitle['A slow day with Miso'].createdAt > plain, `${at}: Miso is newer than a plain entry from 28 hours ago`);
        assert.ok(byTitle['Long run in the rain'].createdAt < plain, `${at}: and the long run is older`);
        for (const e of db.entries.list({ limit: 50 })) assert.ok(e.createdAt <= now.getTime(), `${at}: "${e.title}" is not in the future`);
      } finally {
        db.close();
      }
    }
  });
});

describe('scripts/demo.js', () => {
  it('boots the real app with sample data and working pretend models', async () => {
    const demo = await startDemo({ delayMs: 1 });
    try {
      const get = async (path) => (await rawRequest(demo.url, 'GET', path)).json;
      assert.deepEqual(demo.seeded, { entries: 12, messages: 27, memories: 4, reports: 1 });
      const stats = await get('/api/data/stats');
      assert.deepEqual([stats.entries, stats.memories, stats.reports], [12, 4, 1]);

      const entries = (await get('/api/entries?limit=50')).entries;
      assert.equal(entries.length, 12);
      assert.equal(entries.filter((e) => e.status === 'wrapped').length, 1);
      assert.equal(entries.filter((e) => e.private).length, 1);
      assert.equal(entries.filter((e) => e.pinned).length, 1);
      assert.ok(entries.every((e) => e.mood >= 1 && e.mood <= 5 && e.emotions.length > 0 && e.summary && e.title));
      const dates = entries.map((e) => e.date);
      assert.ok(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
      const spanDays = (Date.parse(`${dates[0]}T00:00:00Z`) - Date.parse(`${dates.at(-1)}T00:00:00Z`)) / 86_400_000;
      assert.ok(spanDays >= 18 && spanDays <= 22, `entries span ${spanDays} days`);
      assert.ok(entries.every((e) => e.createdAt < Date.now() && e.updatedAt <= Date.now()));

      const settings = await get('/api/settings');
      assert.equal(settings.onboarded, true);
      assert.equal(settings.ai.provider, 'local');
      assert.equal(settings.ai.providers.local.baseUrl, demo.openai.baseUrl);
      assert.equal(settings.ai.providers.gemini.baseUrl, demo.gemini.url);
      assert.equal(settings.ai.providers.gemini.apiKeySet, true);
      assert.doesNotMatch(JSON.stringify(settings), /mock-key/);

      const overview = await get('/api/insights/overview?days=90');
      assert.ok(overview.streak.current >= 1, 'a streak is on display');
      assert.equal(overview.totals.entries, 12);
      assert.equal((await get('/api/insights/reports')).reports.length, 1);

      // all three providers work against the pretend servers
      for (const provider of ['local', 'openai', 'gemini']) {
        const test = (await rawRequest(demo.url, 'POST', '/api/providers/test', { body: { provider } })).json;
        assert.equal(test.ok, true, `${provider}: ${JSON.stringify(test)}`);
        const models = (await rawRequest(demo.url, 'POST', '/api/providers/models', { body: { provider } })).json;
        assert.equal(models.ok, true, provider);
        assert.ok(models.models.length > 0);
      }

      // a reply, a wrap-up and a weekly reflection
      const open = entries.find((e) => e.title === 'A slow day with Miso');
      const wrap = await sse(demo.url, `/api/entries/${open.id}/wrap-up`, {});
      assert.equal(wrap.names().at(-1), 'done');
      await rawRequest(demo.url, 'POST', `/api/entries/${open.id}/messages`, { body: { content: 'Added a thought.' } });
      const reply = await sse(demo.url, `/api/entries/${open.id}/reply`, {});
      assert.equal(reply.names().at(-1), 'done');
      const today = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const weekly = await sse(demo.url, '/api/insights/weekly', { today: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`, days: 14 });
      assert.equal(weekly.names().at(-1), 'done');

      const pull = await sse(demo.url, '/api/providers/local/pull', { model: 'gemma2:2b' });
      assert.equal(pull.names().at(-1), 'done');
    } finally {
      await demo.close();
    }
    assert.equal(existsSync(demo.dir), false, 'the temporary folder is removed');
  });

  it('does not let keys from the shell environment into the pretend setup', async () => {
    const saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'real-key-from-the-shell-1234';
    const demo = await startDemo({ delayMs: 1 });
    try {
      const providers = (await rawRequest(demo.url, 'GET', '/api/providers')).json.providers;
      assert.equal(providers.find((p) => p.id === 'openai').keySource, 'settings');
      assert.doesNotMatch(JSON.stringify(providers), /real-key-from-the-shell/);
    } finally {
      await demo.close();
      if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
    }
  });

  it('runs as a command: prints its URL, serves the app and cleans up on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/demo.js'], { cwd: ROOT, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const exit = new Promise((resolve) => child.on('close', resolve));
    try {
      const deadline = Date.now() + 15_000;
      let url = null;
      while (!url && Date.now() < deadline) {
        url = /Open\s+(http:\/\/\S+)/.exec(out)?.[1] ?? null;
        if (!url) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(url, `the demo printed a URL. Output so far: ${out}`);
      const health = await rawRequest(url, 'GET', '/api/health');
      assert.equal(health.status, 200);
      const page = await rawRequest(url, 'GET', '/');
      assert.match(page.text, /<div id="app">/);
      assert.match(out, /npm|Ctrl\+C/);
      const dir = /\((\/[^)]*myjournal-demo-[^)]*)\)/.exec(out)?.[1];
      assert.ok(dir && existsSync(dir), 'the temporary folder exists while running');
      child.kill('SIGTERM');
      assert.equal(await exit, 0);
      assert.equal(existsSync(dir), false);
    } finally {
      child.kill('SIGKILL');
    }
  });
  /** Run scripts/demo.js as a command; resolves once it printed its address. */
  async function startDemoProcess({ env = {}, nodeArgs = [] } = {}) {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...nodeArgs, 'scripts/demo.js'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const exit = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 15_000;
    while (!/Open\s+http:\/\/\S+/.test(out) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const url = /Open\s+(http:\/\/\S+)/.exec(out)?.[1];
    assert.ok(url, `the demo printed a URL. Output so far: ${out}`);
    const dir = /\((\/[^)]*myjournal-demo-[^)]*)\)/.exec(out)?.[1];
    assert.ok(dir && existsSync(dir), 'the temporary folder exists while running');
    return { child, exit, out: () => out, url, dir };
  }

  for (const signal of ['SIGHUP', 'SIGQUIT']) {
    it(`removes its temporary data on ${signal} too (closed terminal window)`, async () => {
      const demo = await startDemoProcess();
      try {
        demo.child.kill(signal);
        const { code } = await demo.exit;
        assert.equal(code, 0, `${signal} is handled like Ctrl+C`);
        assert.equal(existsSync(demo.dir), false, 'the temporary folder is gone');
      } finally {
        demo.child.kill('SIGKILL');
      }
    });
  }

  it('removes its temporary data even when it dies of an uncaught exception', async () => {
    const demo = await startDemoProcess({ nodeArgs: ['--import', CRASH_LATER], env: { CRASH_AFTER_MS: '1500' } });
    try {
      const { code } = await demo.exit;
      assert.notEqual(code, 0, 'it really crashed');
      assert.equal(existsSync(demo.dir), false, 'the temporary folder is gone');
    } finally {
      demo.child.kill('SIGKILL');
    }
  });

  it('cannot be reached from the network: the app and both pretend model servers listen on 127.0.0.1 only, whatever HOST says', async () => {
    const demo = await startDemo({ delayMs: 1 });
    try {
      assert.equal(demo.app.server.address().address, '127.0.0.1');
      assert.equal(demo.openai.server.address().address, '127.0.0.1');
      assert.equal(demo.gemini.server.address().address, '127.0.0.1');
    } finally {
      await demo.close();
    }
    // the command as people run it, with a HOST in its environment (the demo must not read it), probed from outside
    const process_ = await startDemoProcess({ env: { HOST: '0.0.0.0', JOURNAL_PASSWORD: '', PORT: '0' } });
    try {
      const ports = [...process_.out().matchAll(/http:\/\/127\.0\.0\.1:(\d+)/g)].map((m) => Number(m[1]));
      assert.ok(new Set(ports).size >= 3, `the app and two pretend servers announce their ports (${ports})`);
      assert.ok(!/0\.0\.0\.0/.test(process_.out()));
      const outside = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
      for (const address of outside) {
        for (const port of ports) {
          const reachable = await new Promise((resolve) => {
            const socket = net.connect({ host: address, port, timeout: 1500 });
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('timeout', () => { socket.destroy(); resolve(false); });
            socket.once('error', () => resolve(false));
          });
          assert.equal(reachable, false, `${address}:${port} must refuse connections`);
        }
      }
    } finally {
      process_.child.kill('SIGTERM');
      await process_.exit;
      process_.child.kill('SIGKILL');
    }
  });
});

describe('the pretend wrap-up reflection of the demo', () => {
  // Regression: the closing cue ("... Write 3 to 5 sentences.") is a user turn of its own after the companion's reply, and the
  // canned reflection quoted it as if the person had written it ("ending on “Write 3 to 5 sentences”").
  it('quotes only what the person wrote, never the instruction the app sends', () => {
    const turn = (role, content, i) => ({ id: String(i), seq: i, role, content, meta: {} });
    const conversations = [
      [turn('user', 'I wrote a lot today and made miso soup.', 0)],
      [turn('user', 'I wrote a lot today and made miso soup.', 0), turn('assistant', 'What did you write about?', 1)],
      [turn('user', 'I wrote a lot today.', 0), turn('assistant', 'What about?', 1), turn('user', 'My novel. Chapter three is hard.', 2)],
    ];
    for (const messages of conversations) {
      const built = buildWrapUpMessages({ settings: defaultSettings(), entry: { id: 'e', title: '', date: '2026-10-09' }, messages, memories: [], related: [], now: new Date('2026-10-09T10:00:00Z'), providerId: 'local' });
      const text = respond(built.messages);
      assert.doesNotMatch(text, /sentences|closing reflection|speaking as my companion|That is all for now/i, text);
      assert.match(text, /wrote|novel|miso|chapter/i, 'it still reflects the entry');
    }
  });
});
