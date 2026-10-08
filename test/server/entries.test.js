import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TEMPLATES } from '../../src/journal/templates.js';
import { startApp } from './helpers.js';

describe('entries API', () => {
  let h;
  before(async () => { h = await startApp({ ai: false }); });
  after(() => h.close());

  describe('POST /api/entries', () => {
    it('creates an empty free entry with defaults', async () => {
      const res = await h.post('/api/entries', {});
      assert.equal(res.status, 201);
      const { entry, messages } = res.json;
      assert.match(entry.id, /^[0-9a-f-]{36}$/);
      assert.equal(entry.kind, 'free');
      assert.equal(entry.templateId, null);
      assert.equal(entry.mood, null);
      assert.equal(entry.status, 'open');
      assert.equal(entry.private, false);
      assert.equal(entry.pinned, false);
      assert.equal(entry.title, '');
      assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(entry.messageCount, 0);
      assert.deepEqual(messages, []);
    });

    it('stores the first user message, mood, date, title and privacy', async () => {
      const res = await h.post('/api/entries', { content: '  My first line.\nSecond line.  ', mood: 4, date: '2026-09-30', title: 'A title', private: true, kind: 'guided' });
      assert.equal(res.status, 201);
      assert.equal(res.json.entry.mood, 4);
      assert.equal(res.json.entry.date, '2026-09-30');
      assert.equal(res.json.entry.title, 'A title');
      assert.equal(res.json.entry.private, true);
      assert.equal(res.json.entry.kind, 'guided');
      assert.equal(res.json.entry.wordCount, 5);
      assert.equal(res.json.messages.length, 1);
      assert.equal(res.json.messages[0].role, 'user');
      assert.equal(res.json.messages[0].content, 'My first line.\nSecond line.');
      assert.equal(res.json.messages[0].seq, 0);
    });

    it('seeds a guided session with the template opening and no AI call', async () => {
      for (const template of TEMPLATES) {
        const res = await h.post('/api/entries', { templateId: template.id, date: '2026-10-01' });
        assert.equal(res.status, 201, template.id);
        assert.equal(res.json.entry.kind, 'guided');
        assert.equal(res.json.entry.templateId, template.id);
        assert.equal(res.json.messages.length, 1);
        assert.equal(res.json.messages[0].role, 'assistant');
        assert.equal(res.json.messages[0].content, template.opening);
        assert.deepEqual(res.json.messages[0].meta, { kind: 'prompt' });
      }
    });

    it('forces guided when a template is given and adds the content as the first answer', async () => {
      const res = await h.post('/api/entries', { templateId: 'gratitude', kind: 'free', content: 'My dog' });
      assert.equal(res.status, 201);
      assert.equal(res.json.entry.kind, 'guided');
      assert.deepEqual(res.json.messages.map((m) => m.role), ['assistant', 'user']);
    });

    it('validates every field', async () => {
      const bad = [
        [{ templateId: 'nope' }, 'templateId'],
        [{ templateId: 5 }, 'templateId'],
        [{ kind: 'weird' }, 'kind'],
        [{ mood: 0 }, 'mood'],
        [{ mood: 6 }, 'mood'],
        [{ mood: 2.5 }, 'mood'],
        [{ mood: '3' }, 'mood'],
        [{ date: '2026-02-30' }, 'date'],
        [{ date: 'yesterday' }, 'date'],
        [{ date: 20261001 }, 'date'],
        [{ private: 'yes' }, 'private'],
        [{ title: 12 }, 'title'],
        [{ title: 'x'.repeat(2001) }, 'title'],
        [{ content: '' }, 'content'],
        [{ content: '   \n ' }, 'content'],
        [{ content: 42 }, 'content'],
        [{ content: null }, 'content'],
      ];
      for (const [body, field] of bad) {
        const res = await h.post('/api/entries', body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.json.error.code, 'bad_request');
        assert.ok(res.json.error.fields && field in res.json.error.fields, `${JSON.stringify(body)} names ${field}`);
      }
      const tooLong = await h.post('/api/entries', { content: 'x'.repeat(20001) });
      assert.equal(tooLong.status, 413);
      assert.equal(tooLong.json.error.code, 'payload_too_large');
      const edge = await h.post('/api/entries', { content: 'x'.repeat(20000) });
      assert.equal(edge.status, 201);
    });

    it('creates nothing when validation fails halfway', async () => {
      const before = (await h.get('/api/data/stats')).json;
      await h.post('/api/entries', { content: 'fine', mood: 9 });
      assert.deepEqual((await h.get('/api/data/stats')).json.entries, before.entries);
    });

    it('keeps emoji, CJK and combining text intact', async () => {
      const text = 'Hoy fue un día difícil 😔 — 今天很累。 Ünïcödé ✨ 👨‍👩‍👧';
      const res = await h.post('/api/entries', { content: text });
      assert.equal(res.json.messages[0].content, text);
      const again = await h.get(`/api/entries/${res.json.entry.id}`);
      assert.equal(again.json.messages[0].content, text);
    });
  });

  describe('GET /api/entries/:id and ids', () => {
    it('returns the entry with its messages', async () => {
      const { entry } = await h.entry({ content: 'one' });
      await h.post(`/api/entries/${entry.id}/messages`, { content: 'two' });
      const res = await h.get(`/api/entries/${entry.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.json.entry.id, entry.id);
      assert.deepEqual(res.json.messages.map((m) => m.content), ['one', 'two']);
      assert.deepEqual(res.json.messages.map((m) => m.seq), [0, 1]);
      assert.equal(res.json.entry.messageCount, 2);
    });

    it('answers 404 for unknown and impossible ids alike', async () => {
      const ids = ['00000000-0000-4000-8000-000000000000', 'nope', '..', '%2e%2e', 'a'.repeat(101), '__proto__', 'a%20b', 'a;b', 'x\u0000y'.replace('\u0000', '%00')];
      for (const id of ids) {
        for (const [method, suffix] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/messages'], ['GET', '/export.md'], ['POST', '/reply'], ['POST', '/wrap-up']]) {
          const res = await h.request(method, `/api/entries/${id}${suffix}`, { body: method === 'GET' || method === 'DELETE' ? undefined : { content: 'x' } });
          assert.equal(res.status, 404, `${method} ${id}${suffix}`);
          assert.equal(res.json.error.code, 'not_found');
        }
      }
    });
  });

  describe('PATCH /api/entries/:id', () => {
    it('updates title, mood, tags, emotions, privacy, pin and date', async () => {
      const { entry } = await h.entry({ content: 'text' });
      const res = await h.patch(`/api/entries/${entry.id}`, {
        title: 'Renamed', mood: 5, tags: ['Work', ' Family ', 'work'], emotions: ['Calm', 'proud'], private: true, pinned: true, date: '2026-08-15',
      });
      assert.equal(res.status, 200);
      const e = res.json.entry;
      assert.equal(e.title, 'Renamed');
      assert.equal(e.mood, 5);
      assert.deepEqual(e.tags, ['work', 'family']);
      assert.deepEqual(e.emotions, ['calm', 'proud']);
      assert.equal(e.private, true);
      assert.equal(e.pinned, true);
      assert.equal(e.date, '2026-08-15');
      assert.ok(e.updatedAt >= entry.updatedAt);
    });

    it('clears the mood with null and the title with an empty string', async () => {
      const { entry } = await h.entry({ title: 'T', mood: 3 });
      const res = await h.patch(`/api/entries/${entry.id}`, { mood: null, title: '' });
      assert.equal(res.json.entry.mood, null);
      assert.equal(res.json.entry.title, '');
    });

    it('ignores fields that are not patchable and accepts an empty patch', async () => {
      const { entry } = await h.entry({ content: 'text' });
      const res = await h.patch(`/api/entries/${entry.id}`, { status: 'wrapped', summary: 'sneaky', id: 'other', wordCount: 999, createdAt: 1 });
      assert.equal(res.status, 200);
      assert.equal(res.json.entry.status, 'open');
      assert.equal(res.json.entry.summary, '');
      assert.equal(res.json.entry.id, entry.id);
      assert.equal(res.json.entry.createdAt, entry.createdAt);
      assert.equal(res.json.entry.wordCount, 1);
      assert.equal((await h.patch(`/api/entries/${entry.id}`, {})).status, 200);
    });

    it('validates types and 404s for unknown entries', async () => {
      const { entry } = await h.entry({});
      for (const body of [{ title: 5 }, { mood: 7 }, { mood: 'a' }, { tags: 'work' }, { tags: [1] }, { tags: Array(60).fill('a') }, { emotions: {} }, { private: 1 }, { pinned: 'true' }, { date: '2026-13-01' }]) {
        const res = await h.patch(`/api/entries/${entry.id}`, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.json.error.code, 'bad_request');
      }
      assert.equal((await h.patch('/api/entries/00000000-0000-4000-8000-000000000000', { title: 'x' })).status, 404);
      assert.equal((await h.request('PATCH', `/api/entries/${entry.id}`, { rawBody: '[]' })).status, 400);
    });
  });

  describe('messages', () => {
    it('appends user messages (201 { message, entry }) and trims them', async () => {
      const { entry } = await h.entry({});
      const res = await h.post(`/api/entries/${entry.id}/messages`, { content: '  hello there  ' });
      assert.equal(res.status, 201);
      assert.equal(res.json.message.content, 'hello there');
      assert.equal(res.json.message.role, 'user');
      assert.equal(res.json.message.entryId, entry.id);
      assert.equal(res.json.entry.messageCount, 1);
      assert.equal(res.json.entry.wordCount, 2);
    });

    it('treats NUL characters as nothing and keeps zero-width joiners', async () => {
      const { entry } = await h.entry({});
      assert.equal((await h.post(`/api/entries/${entry.id}/messages`, { content: '\u0000\u0000 \u0000' })).status, 400);
      const res = await h.post(`/api/entries/${entry.id}/messages`, { content: 'a\u0000b 👨\u200d👩\u200d👧' });
      assert.equal(res.status, 201);
      assert.equal(res.json.message.content, 'ab 👨\u200d👩\u200d👧');
    });

    it('rejects empty, whitespace, non-text and over-long messages', async () => {
      const { entry } = await h.entry({});
      for (const content of ['', '  \n\t ', null, 12, ['a'], {}]) {
        const res = await h.post(`/api/entries/${entry.id}/messages`, { content });
        assert.equal(res.status, 400, JSON.stringify(content));
      }
      assert.equal((await h.post(`/api/entries/${entry.id}/messages`, {})).status, 400);
      const long = await h.post(`/api/entries/${entry.id}/messages`, { content: 'a'.repeat(20001) });
      assert.equal(long.status, 413);
      assert.equal(long.json.error.code, 'payload_too_large');
      assert.equal((await h.post(`/api/entries/${entry.id}/messages`, { content: 'a'.repeat(20000) })).status, 201);
      assert.equal((await h.get(`/api/entries/${entry.id}`)).json.messages.length, 1);
    });

    it('edits a message and marks it edited; an unchanged text is not an edit', async () => {
      const { entry, messages } = await h.entry({ content: 'draft' });
      const res = await h.patch(`/api/entries/${entry.id}/messages/${messages[0].id}`, { content: 'final text here' });
      assert.equal(res.status, 200);
      assert.equal(res.json.message.content, 'final text here');
      assert.equal(res.json.message.meta.edited, true);
      assert.equal(res.json.entry.wordCount, 3);
      const same = await h.patch(`/api/entries/${entry.id}/messages/${messages[0].id}`, { content: 'final text here' });
      assert.equal(same.status, 200);
      const found = await h.patch(`/api/entries/${entry.id}/messages/${messages[0].id}`, { content: '' });
      assert.equal(found.status, 400);
    });

    it('deletes a message and returns the entry', async () => {
      const { entry } = await h.entry({ content: 'one' });
      const second = (await h.post(`/api/entries/${entry.id}/messages`, { content: 'two words' })).json.message;
      const res = await h.del(`/api/entries/${entry.id}/messages/${second.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.json.entry.messageCount, 1);
      assert.equal(res.json.entry.wordCount, 1);
      assert.equal((await h.del(`/api/entries/${entry.id}/messages/${second.id}`)).status, 404);
    });

    it('treats a message of another entry as not found', async () => {
      const a = await h.entry({ content: 'in a' });
      const b = await h.entry({ content: 'in b' });
      const foreign = b.messages[0].id;
      assert.equal((await h.patch(`/api/entries/${a.entry.id}/messages/${foreign}`, { content: 'hijack' })).status, 404);
      assert.equal((await h.del(`/api/entries/${a.entry.id}/messages/${foreign}`)).status, 404);
      assert.equal((await h.get(`/api/entries/${b.entry.id}`)).json.messages[0].content, 'in b');
      assert.equal((await h.patch(`/api/entries/${a.entry.id}/messages/nope`, { content: 'x' })).status, 404);
    });
  });

  describe('DELETE /api/entries/:id', () => {
    it('deletes with 204, cascades messages and removes the entry from search', async () => {
      const { entry } = await h.entry({ content: 'xylophoneparade is my unique word' });
      assert.equal((await h.get('/api/entries?q=xylophoneparade')).json.entries.length, 1);
      const res = await h.del(`/api/entries/${entry.id}`);
      assert.equal(res.status, 204);
      assert.equal(res.text, '');
      assert.equal((await h.get(`/api/entries/${entry.id}`)).status, 404);
      assert.equal((await h.get('/api/entries?q=xylophoneparade')).json.entries.length, 0);
      assert.equal((await h.del(`/api/entries/${entry.id}`)).status, 404);
    });
  });

  describe('GET /api/entries (list and search)', () => {
    let ids;
    let s;
    before(async () => {
      s = await startApp({ ai: false });
      const seed = [
        { content: 'Walked along the river with Maya and felt calm.', date: '2026-07-01', mood: 4, title: 'River walk' },
        { content: 'Deadline stress at work, my manager was tense.', date: '2026-07-02', mood: 2, title: 'Work stress' },
        { content: 'Cooked pasta for dinner, simple and good.', date: '2026-07-03', mood: 3, title: 'Pasta' },
        { content: 'A private thought about my doctor appointment.', date: '2026-07-04', mood: 3, title: 'Private', private: true },
      ];
      ids = [];
      for (const fields of seed) ids.push((await s.entry(fields)).entry.id);
      await s.patch(`/api/entries/${ids[0]}`, { tags: ['nature', 'friends'], pinned: true });
      await s.patch(`/api/entries/${ids[1]}`, { tags: ['work'] });
    });

    after(() => s.close());

    const listFor = async (query) => (await s.get(`/api/entries?${query}`)).json;

    it('lists newest first with previews and a nextBefore cursor', async () => {
      const res = await s.get('/api/entries?limit=2');
      assert.equal(res.status, 200);
      assert.equal(res.json.entries.length, 2);
      assert.ok(res.json.entries[0].createdAt >= res.json.entries[1].createdAt);
      assert.equal(typeof res.json.entries[0].preview, 'string');
      assert.equal(typeof res.json.nextBefore, 'number');
      assert.deepEqual(Object.keys(res.json).sort(), ['entries', 'nextBefore']);
    });

    it('pages through everything without gaps or repeats', async () => {
      const seen = [];
      let before = null;
      for (let guard = 0; guard < 100; guard += 1) {
        const res = await listFor(`limit=3${before ? `&before=${before}` : ''}`);
        seen.push(...res.entries.map((e) => e.id));
        if (res.nextBefore === null) break;
        before = res.nextBefore;
      }
      const all = (await listFor('limit=200')).entries.map((e) => e.id);
      assert.deepEqual(seen, all);
      assert.equal(new Set(seen).size, seen.length);
    });

    it('filters by mood, tag, date range and pinned', async () => {
      assert.deepEqual((await listFor('mood=2')).entries.map((e) => e.id), [ids[1]]);
      assert.deepEqual((await listFor('tag=Work')).entries.map((e) => e.id), [ids[1]]);
      assert.deepEqual((await listFor('pinned=1')).entries.map((e) => e.id), [ids[0]]);
      const range = (await listFor('from=2026-07-02&to=2026-07-03')).entries.map((e) => e.id).sort();
      assert.deepEqual(range, [ids[1], ids[2]].sort());
    });

    it('searches full text with highlighted-ready snippets, ranked, single page', async () => {
      const res = await listFor('q=river');
      assert.deepEqual(res.entries.map((e) => e.id), [ids[0]]);
      assert.equal(res.nextBefore, null);
      assert.match(res.entries[0].snippet, /river/i);
      assert.equal(res.entries[0].title, 'River walk');
      assert.deepEqual((await listFor('q=stress+work')).entries.map((e) => e.id), [ids[1]]);
      assert.deepEqual((await listFor('q=past')).entries.map((e) => e.id), [ids[2]]); // prefix match
      assert.deepEqual((await listFor('q=river&mood=2')).entries, []);
    });

    it('includes private entries in the person\'s own search', async () => {
      assert.deepEqual((await listFor('q=doctor')).entries.map((e) => e.id), [ids[3]]);
    });

    it('survives hostile search text', async () => {
      for (const q of ['"', '"unterminated', 'a AND', 'NEAR(', '*', ') OR (', "'; DROP TABLE entries; --", '\\', 'é'.repeat(300), '😀', '日本語']) {
        const res = await s.get(`/api/entries?q=${encodeURIComponent(q)}`);
        assert.equal(res.status, 200, q);
        assert.ok(Array.isArray(res.json.entries));
      }
      assert.equal((await s.get(`/api/entries?q=${'a'.repeat(501)}`)).status, 400);
    });

    it('caps search results at 50 and validates query parameters', async () => {
      assert.ok((await listFor('q=a&limit=200')).entries.length <= 50);
      for (const query of ['limit=abc', 'limit=-1', 'limit=1.5', 'mood=9', 'mood=x', 'from=nope', 'to=2026-99-01', 'before=abc']) {
        const res = await s.get(`/api/entries?${query}`);
        assert.equal(res.status, 400, query);
        assert.equal(res.json.error.code, 'bad_request');
      }
      assert.equal((await listFor('limit=100000')).entries.length >= 1, true, 'a large limit is capped, not an error');
    });
  });

  describe('GET /api/entries/:id/export.md', () => {
    it('downloads Markdown with a safe file name', async () => {
      const { entry } = await h.entry({ content: 'Today I walked.\n\nIt was nice.', title: 'Café / walk: "fun"?', mood: 4, date: '2026-10-08' });
      await h.patch(`/api/entries/${entry.id}`, { tags: ['outdoors'], emotions: ['calm'] });
      const res = await h.get(`/api/entries/${entry.id}/export.md`);
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'text/markdown; charset=utf-8');
      assert.match(res.headers['content-disposition'], /^attachment; filename="cafe-walk-fun-2026-10-08\.md"; filename\*=UTF-8''/);
      assert.match(res.text, /^# Café \/ walk: "fun"\?\n/);
      assert.match(res.text, /Thursday, 8 October 2026/);
      assert.match(res.text, /Mood: Good \(4\/5\)/);
      assert.match(res.text, /Feelings: calm/);
      assert.match(res.text, /Tags: outdoors/);
      assert.match(res.text, /\*\*You\*\*\n\nToday I walked\.\n\nIt was nice\./);
    });

    it('survives an untitled entry without messages', async () => {
      const { entry } = await h.entry({});
      const res = await h.get(`/api/entries/${entry.id}/export.md`);
      assert.equal(res.status, 200);
      assert.match(res.text, /^# Untitled entry/);
      assert.match(res.headers['content-disposition'], /filename="entry-/);
    });
  });
});
