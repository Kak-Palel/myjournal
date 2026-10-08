import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDemo } from '../../scripts/demo.js';
import { rawRequest, sse } from './helpers.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

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
});
