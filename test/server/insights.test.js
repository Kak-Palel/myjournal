import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { saveSettings, waitFor, withApp } from './helpers.js';

const TODAY = '2026-10-08';
const WEEKLY = '**How the week felt.** A mix of busy and calm.\n\n**What stood out.** You made time for a friend.\n\n**A pattern.** Work stress came up often.\n\n**For next week.** Plan one slow evening.';
const weekly = (h, body = {}) => h.sse('/api/insights/weekly', body);

async function seed(h, rows) {
  const ids = [];
  for (const row of rows) {
    const { entry } = await h.entry({ content: row.text, date: row.date, mood: row.mood, private: row.private, title: row.title });
    if (row.summary || row.emotions || row.tags) h.db.entries.update(entry.id, { summary: row.summary, emotions: row.emotions, tags: row.tags, status: row.wrapped ? 'wrapped' : 'open' });
    ids.push(entry.id);
  }
  return ids;
}

describe('GET /api/insights/overview', () => {
  it('computes streaks, totals, mood series, calendar, emotions and tags', async () => {
    await withApp({ ai: false }, async (h) => {
      await seed(h, [
        { text: 'one two three', date: '2026-10-08', mood: 4, emotions: ['calm'], tags: ['work'], wrapped: true },
        { text: 'four five', date: '2026-10-08', mood: 2, emotions: ['calm', 'tired'], tags: ['work', 'home'] },
        { text: 'six', date: '2026-10-07', mood: 3 },
        { text: 'seven eight', date: '2026-10-05' },
        { text: 'old entry', date: '2026-01-01', mood: 5, emotions: ['joy'] },
        { text: 'private thoughts here', date: '2026-10-06', mood: 1, private: true },
      ]);
      const res = await h.get(`/api/insights/overview?today=${TODAY}&days=30`);
      assert.equal(res.status, 200);
      const o = res.json;
      assert.deepEqual(Object.keys(o).sort(), ['calendar', 'emotions', 'mood', 'streak', 'tags', 'today', 'totals']);
      assert.equal(o.today, TODAY);
      assert.deepEqual(o.streak, { current: 4, longest: 4, lastEntryDate: TODAY });
      assert.deepEqual(o.totals, { entries: 6, words: 3 + 2 + 1 + 2 + 2 + 3, daysWritten: 5, wrapped: 1 });
      assert.deepEqual(o.mood.series, [
        { date: '2026-10-06', avg: 1, count: 1 },
        { date: '2026-10-07', avg: 3, count: 1 },
        { date: '2026-10-08', avg: 3, count: 2 },
      ]);
      assert.equal(o.mood.average, 2.5);
      assert.deepEqual(o.calendar.map((c) => c.date), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
      assert.deepEqual(o.calendar.at(-1), { date: TODAY, count: 2, words: 5 });
      assert.deepEqual(o.emotions, [{ name: 'calm', count: 2 }, { name: 'tired', count: 1 }]);
      assert.deepEqual(o.tags, [{ name: 'work', count: 2 }, { name: 'home', count: 1 }]);

      const wide = (await h.get(`/api/insights/overview?today=${TODAY}&days=3650`)).json;
      assert.ok(wide.emotions.some((e) => e.name === 'joy'));
      assert.ok(!o.emotions.some((e) => e.name === 'joy'), 'the 30 day window leaves the January entry out');
    });
  });

  it('answers an empty journal and validates its parameters', async () => {
    await withApp({ ai: false }, async (h) => {
      const o = (await h.get(`/api/insights/overview?today=${TODAY}`)).json;
      assert.deepEqual(o.streak, { current: 0, longest: 0, lastEntryDate: null });
      assert.deepEqual(o.totals, { entries: 0, words: 0, daysWritten: 0, wrapped: 0 });
      assert.equal(o.mood.average, null);
      assert.deepEqual(o.calendar, []);
      assert.equal((await h.get('/api/insights/overview')).status, 200, 'today defaults to the server\'s date');
      for (const query of ['today=2026-13-01', 'today=nope', 'days=abc', 'days=-3', 'days=1.5']) {
        const res = await h.get(`/api/insights/overview?${query}`);
        assert.equal(res.status, 400, query);
        assert.equal(res.json.error.code, 'bad_request');
      }
      assert.equal((await h.get(`/api/insights/overview?today=${TODAY}&days=99999`)).status, 200, 'a huge window is capped');
    });
  });
});

describe('POST /api/insights/weekly', () => {
  it('writes a reflection from the non-private entries of the window and saves it as a report', async () => {
    await withApp({ mock: { replies: [WEEKLY], delayMs: 2 } }, async (h) => {
      h.db.memories.create({ text: 'Has a younger sister called Maya' });
      await seed(h, [
        { text: 'Busy day at the office with many calls.', date: '2026-10-08', mood: 3, title: 'Office day', summary: 'A busy office day.', emotions: ['tired'] },
        { text: 'Dinner with Maya and long talk about life.', date: '2026-10-05', mood: 5, title: 'Dinner with Maya' },
        { text: 'My private therapy notes.', date: '2026-10-06', private: true, title: 'Therapy notes' },
        { text: 'Way too old for a one week window.', date: '2026-09-20', title: 'Old news' },
      ]);
      const stream = await weekly(h, { today: TODAY, days: 7 });
      assert.equal(stream.status, 200);
      assert.equal(stream.names().at(-1), 'done');
      assert.deepEqual([...new Set(stream.names())], ['delta', 'done']);
      assert.equal(stream.text(), WEEKLY);

      const { report } = stream.of('done')[0];
      assert.deepEqual(Object.keys(report).sort(), ['content', 'createdAt', 'id', 'kind', 'meta', 'periodEnd', 'periodStart']);
      assert.equal(report.kind, 'weekly');
      assert.equal(report.periodStart, '2026-10-02');
      assert.equal(report.periodEnd, TODAY);
      assert.equal(report.content, WEEKLY);
      assert.deepEqual(report.meta, { provider: 'local', model: 'llama3.2:3b', entryCount: 2 });

      const request = h.mock.lastChatRequest();
      const system = request.body.messages[0].content;
      const user = request.body.messages[1].content;
      assert.match(system, /^TASK: weekly\n/);
      assert.match(system, /Has a younger sister called Maya/);
      assert.match(user, /Office day/);
      assert.match(user, /A busy office day\./);
      assert.match(user, /Dinner with Maya and long talk/, 'an entry without a summary contributes the start of its text');
      assert.doesNotMatch(user, /Therapy|therapy|Old news|too old/);
      assert.ok(request.body.max_tokens >= 600);

      const listed = (await h.get('/api/insights/reports')).json;
      assert.deepEqual(listed.reports.map((r) => r.id), [report.id]);
      assert.equal(h.app.generations.size, 0);
    });
  });

  it('honours the number of days', async () => {
    await withApp({}, async (h) => {
      await seed(h, [
        { text: 'Recent.', date: '2026-10-07', title: 'Recent' },
        { text: 'Two weeks back.', date: '2026-09-27', title: 'Fortnight' },
      ]);
      await weekly(h, { today: TODAY, days: 7 });
      assert.doesNotMatch(h.mock.lastChatRequest().body.messages[1].content, /Fortnight/);
      const stream = await weekly(h, { today: TODAY, days: 14 });
      assert.match(h.mock.lastChatRequest().body.messages[1].content, /Fortnight/);
      assert.equal(stream.of('done')[0].report.periodStart, '2026-09-25');
      assert.equal(stream.of('done')[0].report.meta.entryCount, 2);
    });
  });

  it('defaults to seven days ending today (server date)', async () => {
    await withApp({}, async (h) => {
      const stream = await weekly(h);
      assert.equal(stream.status, 422, 'no entries yet');
      const { entry } = await h.entry({ content: 'Written now.' });
      const ok = await weekly(h);
      assert.equal(ok.names().at(-1), 'done');
      assert.equal(ok.of('done')[0].report.periodEnd, entry.date);
    });
  });

  it('answers 422 not_enough_entries before streaming when nothing qualifies', async () => {
    await withApp({}, async (h) => {
      const empty = await weekly(h, { today: TODAY });
      assert.equal(empty.status, 422);
      assert.match(empty.headers['content-type'], /json/);
      assert.equal(empty.error.code, 'not_enough_entries');
      assert.equal(empty.events.length, 0);
      await seed(h, [{ text: 'Only private.', date: TODAY, private: true }, { text: 'Too old.', date: '2026-01-01' }]);
      assert.equal((await weekly(h, { today: TODAY, days: 7 })).error.code, 'not_enough_entries');
      assert.equal(h.mock.chatRequests().length, 0);
      assert.equal(h.app.generations.size, 0);
      assert.deepEqual((await h.get('/api/insights/reports')).json, { reports: [] });
    });
  });

  it('validates the request and checks the AI first', async () => {
    await withApp({}, async (h) => {
      await seed(h, [{ text: 'x', date: TODAY }]);
      for (const body of [{ today: 'nope' }, { today: '2026-02-30' }, { days: 0 }, { days: 400 }, { days: '7' }, { days: 2.5 }]) {
        const res = await weekly(h, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.error.code, 'bad_request');
      }
      saveSettings(h.db, { ai: { enabled: false } });
      assert.equal((await weekly(h, { today: TODAY })).error.code, 'ai_disabled');
    });
    await withApp({ ai: false }, async (h) => {
      const res = await weekly(h, { today: TODAY });
      assert.equal(res.status, 409);
      assert.equal(res.error.code, 'ai_not_configured');
    });
  });

  it('allows one weekly reflection at a time, and a stopped one is not saved', async () => {
    await withApp({ mock: { delayMs: 20, replies: ['word '.repeat(300)] } }, async (h) => {
      await seed(h, [{ text: 'Entry.', date: TODAY }]);
      const first = h.stream('/api/insights/weekly', { today: TODAY });
      await first.waitForEvent('delta');
      const second = await weekly(h, { today: TODAY });
      assert.equal(second.status, 409);
      assert.equal(second.error.code, 'generation_in_progress');
      first.abort();
      await first.finished;
      await h.mock.waitForIdle();
      await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });
      assert.deepEqual((await h.get('/api/insights/reports')).json, { reports: [] });
      h.mock.setBehavior({ replies: [WEEKLY] });
      assert.equal((await weekly(h, { today: TODAY })).names().at(-1), 'done');
    });
  });

  it('does not mix up an entry called "weekly" (possible after an import) with the weekly job', async () => {
    await withApp({ mock: { delayMs: 15, replies: ['word '.repeat(300)] } }, async (h) => {
      h.db.entries.create({ id: 'weekly', date: TODAY });
      h.db.messages.add('weekly', { role: 'user', content: 'An entry with an unlucky id.' });
      h.db.entries.create({ id: 'job:pull', date: TODAY });
      h.db.messages.add('job:pull', { role: 'user', content: 'Another unlucky id.' });
      const report = h.stream('/api/insights/weekly', { today: TODAY });
      await report.waitForEvent('delta');
      h.mock.setBehavior({ delayMs: 0, replies: ['Fine. Why?'] });
      const reply = await h.sse('/api/entries/weekly/reply', {});
      assert.equal(reply.names().at(-1), 'done', 'the reply is not blocked by the running weekly job');
      assert.equal((await h.sse('/api/entries/job:pull/reply', {})).names().at(-1), 'done');
      report.abort();
      await report.finished;
      await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });
    });
  });

  it('reports provider failures as an error event and saves nothing', async () => {
    await withApp({ mock: { failures: ['quota'] } }, async (h) => {
      await seed(h, [{ text: 'Entry.', date: TODAY }]);
      const stream = await weekly(h, { today: TODAY });
      assert.equal(stream.status, 200);
      assert.equal(stream.of('error')[0].error.code, 'quota');
      assert.deepEqual((await h.get('/api/insights/reports')).json, { reports: [] });
      assert.equal(h.app.generations.size, 0);
    });
  });
});

describe('reports', () => {
  it('lists newest first and deletes by id', async () => {
    await withApp({ ai: false }, async (h) => {
      const a = h.db.reports.create({ periodStart: '2026-09-01', periodEnd: '2026-09-07', content: 'first', createdAt: 1000 });
      const b = h.db.reports.create({ periodStart: '2026-09-08', periodEnd: '2026-09-14', content: 'second', createdAt: 2000 });
      assert.deepEqual((await h.get('/api/insights/reports')).json.reports.map((r) => r.id), [b.id, a.id]);
      const res = await h.del(`/api/insights/reports/${b.id}`);
      assert.equal(res.status, 204);
      assert.deepEqual((await h.get('/api/insights/reports')).json.reports.map((r) => r.id), [a.id]);
      assert.equal((await h.del(`/api/insights/reports/${b.id}`)).status, 404);
      assert.equal((await h.del('/api/insights/reports/..%2f')).status, 404);
    });
  });
});
