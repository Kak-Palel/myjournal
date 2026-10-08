import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { rawSocket, saveSettings, startApp, waitFor, withApp } from './helpers.js';

describe('GET /api/health', () => {
  it('reports ok and the version', async () => {
    await withApp({ ai: false }, async (h) => {
      const res = await h.get('/api/health');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true, version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version });
    });
  });
});

describe('settings API', () => {
  it('returns the public shape: no raw keys, key hints instead', async () => {
    await withApp({ ai: false }, async (h) => {
      const res = await h.get('/api/settings');
      assert.equal(res.status, 200);
      const s = res.json;
      assert.equal(s.onboarded, false);
      assert.deepEqual(s.memory, { enabled: true, autoExtract: true, useRelatedEntries: true });
      assert.equal(s.ai.provider, '');
      assert.equal(s.ai.providers.gemini.model, 'gemini-flash-lite-latest');
      assert.equal(s.ai.providers.gemini.thinking, 'auto');
      for (const p of Object.values(s.ai.providers)) {
        assert.equal('apiKey' in p, false);
        assert.deepEqual([p.apiKeySet, p.apiKeyHint, p.apiKeySource], [false, '', 'none']);
      }
    });
  });

  it('merges a partial update, persists it and answers with the new public settings', async () => {
    await withApp({ ai: false }, async (h) => {
      const res = await h.put('/api/settings', { profile: { name: '  Sam  ' }, ai: { temperature: 1.25, providers: { local: { model: 'qwen2.5:1.5b' } } }, onboarded: true });
      assert.equal(res.status, 200);
      assert.equal(res.json.profile.name, 'Sam');
      assert.equal(res.json.profile.about, '');
      assert.equal(res.json.ai.temperature, 1.25);
      assert.equal(res.json.ai.maxTokens, 700, 'untouched values stay');
      assert.equal(res.json.ai.providers.local.model, 'qwen2.5:1.5b');
      assert.equal(res.json.onboarded, true);
      assert.deepEqual((await h.get('/api/settings')).json, res.json);
      assert.equal(h.db.settings.get().profile.name, 'Sam');
    });
  });

  it('stores API keys but only ever returns a hint', async () => {
    await withApp({ ai: false, env: { OPENAI_API_KEY: 'sk-from-env-5555' } }, async (h) => {
      assert.deepEqual((await h.get('/api/settings')).json.ai.providers.openai.apiKeySource, 'env');
      const set = await h.put('/api/settings', { ai: { providers: { openai: { apiKey: '  sk-saved-key-abcd\n' } } } });
      const openai = set.json.ai.providers.openai;
      assert.deepEqual([openai.apiKeySet, openai.apiKeyHint, openai.apiKeySource], [true, '…abcd', 'settings']);
      assert.doesNotMatch(set.text, /sk-saved-key|sk-from-env/);
      assert.equal(h.db.settings.get().ai.providers.openai.apiKey, 'sk-saved-key-abcd');

      const other = await h.put('/api/settings', { profile: { name: 'x' } });
      assert.equal(other.json.ai.providers.openai.apiKeyHint, '…abcd', 'omitting the key keeps it');

      const cleared = await h.put('/api/settings', { ai: { providers: { openai: { apiKey: null } } } });
      assert.deepEqual([cleared.json.ai.providers.openai.apiKeyHint, cleared.json.ai.providers.openai.apiKeySource], ['…5555', 'env'], 'the environment fills the gap');
      assert.equal(h.db.settings.get().ai.providers.openai.apiKey, '');
    });
  });

  it('accepts its own public output back unchanged without losing keys', async () => {
    await withApp({ ai: false }, async (h) => {
      saveSettings(h.db, { ai: { providers: { gemini: { apiKey: 'AIza-secret-key-wxyz' } } } });
      const current = (await h.get('/api/settings')).json;
      const res = await h.put('/api/settings', current);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, current);
      assert.equal(h.db.settings.get().ai.providers.gemini.apiKey, 'AIza-secret-key-wxyz');
    });
  });

  it('rejects invalid values with invalid_settings and field paths, changing nothing', async () => {
    await withApp({ ai: false }, async (h) => {
      const before = JSON.stringify(h.db.settings.get());
      const res = await h.put('/api/settings', {
        profile: { name: 'Fine now' },
        ai: { temperature: 'hot', provider: 'skynet', providers: { openai: { baseUrl: 'ftp://x' }, gemini: { thinking: 'maximum' } } },
        persona: { id: 'pirate' },
        memory: { enabled: 'yes' },
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'invalid_settings');
      const fields = res.json.error.fields;
      for (const path of ['ai.temperature', 'ai.provider', 'ai.providers.openai.baseUrl', 'ai.providers.gemini.thinking', 'persona.id', 'memory.enabled']) {
        assert.equal(typeof fields[path], 'string', path);
      }
      assert.equal(JSON.stringify(h.db.settings.get()), before, 'all or nothing');
      for (const body of [[], 'text', 5, null]) {
        const bad = await h.request('PUT', '/api/settings', { rawBody: JSON.stringify(body) });
        assert.equal(bad.status, 400, JSON.stringify(body));
        assert.equal(bad.json.error.code, 'invalid_settings');
      }
    });
  });

  it('rejects over-long text instead of cutting it', async () => {
    await withApp({ ai: false }, async (h) => {
      const res = await h.put('/api/settings', { profile: { about: 'x'.repeat(1001) }, ai: { providers: { openai: { apiKey: 'k'.repeat(600) } } } });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'invalid_settings');
      assert.match(res.json.error.fields['profile.about'], /1000/);
      assert.ok(res.json.error.fields['ai.providers.openai.apiKey']);
      assert.equal(h.db.settings.get().profile.about, '');
    });
  });

  it('clamps numbers, drops unknown keys and cannot be used for prototype pollution', async () => {
    await withApp({ ai: false }, async (h) => {
      const res = await h.request('PUT', '/api/settings', {
        rawBody: '{"ai":{"temperature":99,"maxTokens":1,"junk":1},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"profile":{"__proto__":{"polluted3":true}},"extra":{"a":1}}',
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ai.temperature, 2);
      assert.equal(res.json.ai.maxTokens, 64);
      assert.equal('junk' in res.json.ai, false);
      assert.equal('extra' in res.json, false);
      assert.equal({}.polluted, undefined);
      assert.equal({}.polluted2, undefined);
      assert.equal({}.polluted3, undefined);
    });
  });
});

describe('catalog', () => {
  it('serves templates (without guidance), personas and a deterministic prompt of the day', async () => {
    await withApp({ ai: false }, async (h) => {
      const res = await h.get('/api/catalog?date=2026-10-08');
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.json).sort(), ['personas', 'promptOfTheDay', 'templates']);
      assert.equal(res.json.templates.length, 12);
      for (const t of res.json.templates) {
        assert.deepEqual(Object.keys(t).sort(), ['category', 'description', 'icon', 'id', 'minutes', 'opening', 'title']);
        assert.ok(['Daily', 'Mind', 'Growth', 'Creative'].includes(t.category));
      }
      assert.ok(res.json.templates.some((t) => t.id === 'rose-thorn-bud'));
      assert.deepEqual(res.json.personas.map((p) => p.id), ['companion', 'coach', 'cbt', 'stoic', 'friend']);
      for (const p of res.json.personas) assert.deepEqual(Object.keys(p).sort(), ['description', 'id', 'name']);
      assert.match(res.json.promptOfTheDay.id, /^pod-\d\d$/);
      assert.ok(res.json.promptOfTheDay.text.length > 10);
      assert.deepEqual((await h.get('/api/catalog?date=2026-10-08')).json.promptOfTheDay, res.json.promptOfTheDay);
      assert.notDeepEqual((await h.get('/api/catalog?date=2026-10-09')).json.promptOfTheDay, res.json.promptOfTheDay);
      assert.equal((await h.get('/api/catalog')).status, 200);
      assert.equal((await h.get('/api/catalog?date=2026-99-99')).status, 400);
      assert.equal((await h.get('/api/catalog?date=today')).status, 400);
    });
  });
});

describe('memories API', () => {
  it('creates, lists (pinned first), edits, pins and deletes', async () => {
    await withApp({ ai: false }, async (h) => {
      const a = await h.post('/api/memories', { text: '  Has   a sister called Maya ' });
      assert.equal(a.status, 201);
      assert.equal(a.json.memory.text, 'Has a sister called Maya');
      assert.equal(a.json.memory.pinned, false);
      assert.equal(a.json.memory.sourceEntryId, null);
      const b = await h.post('/api/memories', { text: 'Works as a nurse 🩺', pinned: true });
      assert.equal(b.json.memory.pinned, true);
      const list = (await h.get('/api/memories')).json;
      assert.deepEqual(Object.keys(list), ['memories']);
      assert.deepEqual(list.memories.map((m) => m.id), [b.json.memory.id, a.json.memory.id]);

      const edited = await h.patch(`/api/memories/${a.json.memory.id}`, { text: 'Has a younger sister', pinned: true });
      assert.equal(edited.status, 200);
      assert.equal(edited.json.memory.text, 'Has a younger sister');
      assert.equal(edited.json.memory.pinned, true);
      assert.equal((await h.patch(`/api/memories/${a.json.memory.id}`, {})).status, 200);
      assert.equal((await h.del(`/api/memories/${b.json.memory.id}`)).status, 204);
      assert.equal((await h.del(`/api/memories/${b.json.memory.id}`)).status, 404);
      assert.equal((await h.patch(`/api/memories/${b.json.memory.id}`, { text: 'x' })).status, 404);
      assert.equal((await h.del('/api/memories/../x')).status, 404);
    });
  });

  it('validates text and flags', async () => {
    await withApp({ ai: false }, async (h) => {
      for (const body of [{}, { text: '' }, { text: '   ' }, { text: 5 }, { text: 'x'.repeat(301) }, { text: 'ok', pinned: 'yes' }]) {
        const res = await h.post('/api/memories', body);
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
        assert.equal(res.json.error.code, 'bad_request');
      }
      assert.equal((await h.post('/api/memories', { text: 'x'.repeat(300) })).status, 201);
      const { json } = await h.post('/api/memories', { text: 'fine' });
      for (const body of [{ text: '' }, { text: 'y'.repeat(301) }, { pinned: 1 }, { text: [] }]) {
        assert.equal((await h.patch(`/api/memories/${json.memory.id}`, body)).status, 400, JSON.stringify(body));
      }
    });
  });

  it('clears everything and says how many were removed', async () => {
    await withApp({ ai: false }, async (h) => {
      for (const text of ['one', 'two', 'three']) await h.post('/api/memories', { text });
      const res = await h.post('/api/memories/clear', {});
      assert.deepEqual(res.json, { ok: true, removed: 3 });
      assert.deepEqual((await h.get('/api/memories')).json, { memories: [] });
      assert.deepEqual((await h.post('/api/memories/clear', {})).json, { ok: true, removed: 0 });
    });
  });

  it('keeps a memory when its source entry is deleted', async () => {
    await withApp({ ai: false }, async (h) => {
      const { entry } = await h.entry({ content: 'source' });
      const memory = h.db.memories.create({ text: 'Fact from an entry', sourceEntryId: entry.id });
      await h.del(`/api/entries/${entry.id}`);
      const list = (await h.get('/api/memories')).json.memories;
      assert.equal(list.length, 1);
      assert.equal(list[0].id, memory.id);
      assert.equal(list[0].sourceEntryId, null);
    });
  });
});

async function populate(h) {
  const a = await h.entry({ content: 'First entry about Lisbon and pastel de nata.', date: '2026-10-01', mood: 4, title: 'Lisbon' });
  const b = await h.entry({ content: 'Second entry, private.', date: '2026-10-02', private: true });
  await h.post(`/api/entries/${a.entry.id}/messages`, { content: 'More thoughts: émotions 😊 and 日本語.' });
  h.db.messages.add(a.entry.id, { role: 'assistant', content: 'A reply. Why?', meta: { kind: 'reply', provider: 'local', model: 'm' } });
  h.db.memories.create({ text: 'Likes pastel de nata', pinned: true, sourceEntryId: a.entry.id });
  h.db.reports.create({ periodStart: '2026-09-25', periodEnd: '2026-10-01', content: 'A weekly **report**.', meta: { entryCount: 1 } });
  return { a: a.entry, b: b.entry };
}

describe('data API', () => {
  it('reports counts and size', async () => {
    await withApp({ ai: false }, async (h) => {
      await populate(h);
      const res = await h.get('/api/data/stats');
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.json).sort(), ['dbBytes', 'entries', 'memories', 'messages', 'reports']);
      assert.deepEqual([res.json.entries, res.json.messages, res.json.memories, res.json.reports], [2, 4, 1, 1]);
      assert.ok(res.json.dbBytes > 0);
    });
  });

  it('exports JSON as an attachment without settings or keys', async () => {
    await withApp({ ai: false, settings: { ai: { providers: { openai: { apiKey: 'sk-never-export-me-1234' } } }, profile: { name: 'Sam' } } }, async (h) => {
      const { a } = await populate(h);
      const res = await h.get('/api/data/export?format=json');
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /^application\/json/);
      assert.match(res.headers['content-disposition'], /^attachment; filename="myjournal-export-\d{4}-\d{2}-\d{2}\.json"/);
      const doc = JSON.parse(res.text);
      assert.equal(doc.app, 'myjournal');
      assert.equal(doc.version, 1);
      assert.equal(typeof doc.exportedAt, 'number');
      assert.equal(doc.entries.length, 2);
      const exported = doc.entries.find((e) => e.id === a.id);
      assert.deepEqual(exported.messages.map((m) => m.role), ['user', 'user', 'assistant']);
      assert.equal(doc.memories.length, 1);
      assert.equal(doc.reports.length, 1);
      assert.doesNotMatch(res.text, /sk-never-export-me|apiKey|"profile"/);
      assert.equal((await h.get('/api/data/export')).status, 200, 'json is the default format');
    });
  });

  it('exports Markdown with entries, memories and reports', async () => {
    await withApp({ ai: false }, async (h) => {
      await populate(h);
      const res = await h.get('/api/data/export?format=markdown');
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /^text\/markdown/);
      assert.match(res.headers['content-disposition'], /filename="myjournal-export-\d{4}-\d{2}-\d{2}\.md"/);
      assert.match(res.text, /^# MyJournal export/);
      assert.match(res.text, /## Lisbon/);
      assert.match(res.text, /émotions 😊 and 日本語/);
      assert.match(res.text, /\*\*Companion\*\*\n\nA reply\. Why\?/);
      assert.match(res.text, /## Memories\n\n- Likes pastel de nata \(pinned\)/);
      assert.match(res.text, /### 2026-09-25 to 2026-10-01/);
      assert.equal((await h.get('/api/data/export?format=csv')).status, 400);
      assert.equal((await h.get('/api/data/export?format=')).status, 200);
    });
  });

  it('round-trips an export into a fresh journal, and a second import skips everything', async () => {
    const source = await startApp({ ai: false });
    const target = await startApp({ ai: false });
    try {
      const { a } = await populate(source);
      const exported = await source.get('/api/data/export?format=json');
      const first = await target.request('POST', '/api/data/import', { rawBody: exported.text });
      assert.equal(first.status, 200);
      assert.deepEqual(first.json, { imported: { entries: 2, messages: 4, memories: 1, reports: 1 }, skipped: 0 });

      const copy = (await target.get(`/api/entries/${a.id}`)).json;
      const original = (await source.get(`/api/entries/${a.id}`)).json;
      assert.deepEqual(copy.entry, original.entry);
      assert.deepEqual(copy.messages, original.messages);
      assert.deepEqual((await target.get('/api/memories')).json, (await source.get('/api/memories')).json);
      assert.deepEqual((await target.get('/api/insights/reports')).json, (await source.get('/api/insights/reports')).json);
      assert.equal((await target.get('/api/entries?q=pastel')).json.entries.length, 1, 'the search index was rebuilt');
      assert.deepEqual((await target.get('/api/data/stats')).json.entries, 2);

      const second = await target.request('POST', '/api/data/import', { rawBody: exported.text });
      assert.deepEqual(second.json.imported, { entries: 0, messages: 0, memories: 0, reports: 0 });
      assert.equal(second.json.skipped, 2 + 4 + 1 + 1);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('refuses things that are not a MyJournal export', async () => {
    await withApp({ ai: false }, async (h) => {
      const bodies = ['{"hello":"world"}', '{"app":"other","entries":[]}', '{"app":"myjournal","version":99,"entries":[]}', '{"entries":"nope"}', '[]', '"text"', 'not json', '', '{"app":"myjournal","version":"x","entries":[]}'];
      for (const rawBody of bodies) {
        const res = await h.request('POST', '/api/data/import', { rawBody });
        assert.equal(res.status, 400, rawBody);
        assert.equal(res.json.error.code, 'bad_request');
      }
      assert.deepEqual((await h.get('/api/data/stats')).json.entries, 0);
    });
  });

  it('skips hostile records instead of failing or executing anything', async () => {
    await withApp({ ai: false }, async (h) => {
      const doc = {
        app: 'myjournal',
        version: 1,
        entries: [
          { id: '__proto__', createdAt: 1, messages: [] },
          { id: 'bad date', createdAt: 1 },
          { id: 'ok-1', createdAt: 1_700_000_000_000, date: '2026-02-31', messages: [] },
          { id: 'ok-2', createdAt: 1_700_000_000_000, date: '2026-02-03', title: '<script>alert(1)</script>', messages: [{ id: 'm-1', role: 'user', content: '${process.exit(1)} {{7*7}}', createdAt: 1_700_000_000_001 }, { id: 'm-2', role: 'root', content: 'x', createdAt: 1 }] },
          { id: 'ok-3', createdAt: 'yesterday' },
          42,
          null,
        ],
        memories: [{ id: 'mem-1', text: 'x'.repeat(5000), createdAt: 1 }, { id: 'mem-2', text: 'Fine fact', createdAt: 1 }],
        reports: [{ id: 'r-1', periodStart: '2026-10-09', periodEnd: '2026-10-01', content: 'backwards', createdAt: 1 }],
        injected: { $ne: 1 },
      };
      const res = await h.post('/api/data/import', doc);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.imported, { entries: 1, messages: 1, memories: 1, reports: 0 });
      assert.ok(res.json.skipped >= 8);
      const entry = (await h.get('/api/entries/ok-2')).json;
      assert.equal(entry.entry.title, '<script>alert(1)</script>', 'stored verbatim, as text');
      assert.equal(entry.messages[0].content, '${process.exit(1)} {{7*7}}');
      assert.equal({}.polluted, undefined);
    });
  });

  it('accepts big imports (up to 50 MB) while ordinary requests stay capped at 1 MB', async () => {
    const source = await startApp({ ai: false });
    const target = await startApp({ ai: false });
    try {
      const text = 'A fairly long paragraph about my day, with several clauses, and some punctuation. '.repeat(240);
      for (let i = 0; i < 120; i += 1) source.db.entries.create({ id: `e${i}`, createdAt: 1_700_000_000_000 + i, date: '2026-01-01' });
      for (let i = 0; i < 120; i += 1) source.db.messages.add(`e${i}`, { role: 'user', content: text, createdAt: 1_700_000_000_000 + i });
      const exported = await source.get('/api/data/export?format=json');
      assert.ok(exported.text.length > 2 * 1024 * 1024, `export is ${exported.text.length} bytes`);
      const res = await target.request('POST', '/api/data/import', { rawBody: exported.text, timeoutMs: 60000 });
      assert.equal(res.status, 200);
      assert.equal(res.json.imported.entries, 120);
      assert.equal(res.json.imported.messages, 120);
      const tooBigForNormal = await target.request('POST', '/api/memories', { rawBody: exported.text });
      assert.equal(tooBigForNormal.status, 413);
      const raw = await rawSocket(target.url, `POST /api/data/import HTTP/1.1\r\nHost: localhost\r\nX-MyJournal: 1\r\nContent-Type: application/json\r\nContent-Length: ${50 * 1024 * 1024 + 1}\r\nConnection: close\r\n\r\n{`);
      assert.match(raw, /^HTTP\/1\.1 413/);
      assert.match(raw, /payload_too_large/);
    } finally {
      await source.close();
      await target.close();
    }
  });

  describe('wipe', () => {
    it('needs the exact confirmation word', async () => {
      await withApp({ ai: false }, async (h) => {
        await populate(h);
        for (const body of [{}, { confirm: 'delete' }, { confirm: 'DELETE ' }, { confirm: true }, { confirm: 'yes' }]) {
          const res = await h.post('/api/data/wipe', body);
          assert.equal(res.status, 400, JSON.stringify(body));
          assert.equal(res.json.error.code, 'bad_request');
        }
        assert.equal((await h.post('/api/data/wipe', { confirm: 'DELETE', includeSettings: 'yes' })).status, 400);
        assert.deepEqual((await h.get('/api/data/stats')).json.entries, 2);
      });
    });

    it('deletes the journal but keeps settings by default', async () => {
      await withApp({ settings: { profile: { name: 'Sam' }, ai: { providers: { openai: { apiKey: 'sk-keep-me-0001' } } } } }, async (h) => {
        await populate(h);
        const res = await h.post('/api/data/wipe', { confirm: 'DELETE' });
        assert.deepEqual(res.json, { ok: true });
        const stats = (await h.get('/api/data/stats')).json;
        assert.deepEqual([stats.entries, stats.messages, stats.memories, stats.reports], [0, 0, 0, 0]);
        assert.deepEqual((await h.get('/api/entries?q=lisbon')).json.entries, []);
        const settings = (await h.get('/api/settings')).json;
        assert.equal(settings.profile.name, 'Sam');
        assert.equal(settings.ai.providers.openai.apiKeyHint, '…0001');
        assert.equal((await h.entry({ content: 'A new beginning.' })).entry.wordCount, 3);
      });
    });

    it('can also reset settings and saved API keys', async () => {
      await withApp({ settings: { profile: { name: 'Sam' }, ai: { providers: { openai: { apiKey: 'sk-erase-me-0002' } } } } }, async (h) => {
        await populate(h);
        const res = await h.post('/api/data/wipe', { confirm: 'DELETE', includeSettings: true });
        assert.equal(res.status, 200);
        const settings = (await h.get('/api/settings')).json;
        assert.equal(settings.onboarded, false);
        assert.equal(settings.profile.name, '');
        assert.equal(settings.ai.provider, '');
        assert.equal(settings.ai.providers.openai.apiKeySet, false);
        assert.equal(h.db.settings.get().ai.providers.openai.apiKey, '');
      });
    });

    it('stops a reply that is still being written', async () => {
      await withApp({ mock: { delayMs: 15, replies: ['word '.repeat(300)] } }, async (h) => {
        const { entry } = await h.entry({ content: 'Soon wiped.' });
        const stream = h.stream(`/api/entries/${entry.id}/reply`, {});
        await stream.waitForEvent('delta');
        assert.equal((await h.post('/api/data/wipe', { confirm: 'DELETE' })).status, 200);
        await stream.finished;
        await h.mock.waitForIdle();
        await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });
        assert.deepEqual((await h.get('/api/data/stats')).json.messages, 0, 'nothing was written back into the emptied journal');
      });
    });
  });
});
