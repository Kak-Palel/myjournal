import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crisisNotice } from '../../src/journal/safety.js';
import { saveSettings, waitFor, withApp } from './helpers.js';

const TEXT = 'I spent the morning planning my sister Maya\'s birthday party. I am excited but also tired because work was busy.';
const REFLECTION = 'You carried a lot today and still found energy for Maya\'s party. Planning something kind for her seems to matter to you. Be gentle with yourself tonight.';
const META = 'Title: Planning Maya\'s party\nSummary: Planned a birthday party for a sister while feeling excited and tired.\nEmotions: excited, tired\nTags: family, party';
// Grounded in TEXT ("my sister Maya"): the memory step drops a fact whose details ("younger") the entry never mentioned.
const MEMORY = '- Has a sister called Maya';

const wrapUp = (h, id, body = {}) => h.sse(`/api/entries/${id}/wrap-up`, body);
const systemOf = (request) => request.body.messages.find((m) => m.role === 'system').content;
const taskOf = (request) => systemOf(request).split('\n')[0];
const kinds = async (h, id) => (await h.get(`/api/entries/${id}`)).json.messages.map((m) => m.meta.kind || 'user');

describe('POST /api/entries/:id/wrap-up', () => {
  it('runs reflection, metadata and memory in order and marks the entry wrapped', async () => {
    await withApp({}, async (h) => {
      const inflight = [];
      const track = (text) => () => { inflight.push(h.mock.inflight); return text; };
      h.mock.setBehavior({ replies: [track(REFLECTION), track(META), track(MEMORY)], delayMs: 2 });
      const { entry } = await h.entry({ content: TEXT, mood: 4, date: '2026-10-08' });
      const stream = await wrapUp(h, entry.id);
      assert.equal(stream.status, 200);

      const outline = stream.events.filter((e) => e.event !== 'delta').map((e) => (e.event === 'phase' ? `phase:${e.data.name}` : e.event));
      assert.deepEqual(outline, ['phase:reflection', 'phase:metadata', 'entry', 'phase:memory', 'memories', 'done']);
      assert.equal(stream.names().indexOf('delta') > stream.names().indexOf('phase'), true, 'text streams during the reflection phase');
      assert.equal(stream.text(), REFLECTION);

      const done = stream.of('done')[0];
      assert.deepEqual(Object.keys(done).sort(), ['entry', 'memories', 'message']);
      assert.deepEqual(done.message.meta, { kind: 'wrapup', provider: 'local', model: 'llama3.2:3b' });
      assert.equal(done.message.content, REFLECTION);
      assert.equal(done.entry.status, 'wrapped');
      assert.equal(done.entry.title, 'Planning Maya\'s party');
      assert.equal(done.entry.summary, 'Planned a birthday party for a sister while feeling excited and tired.');
      assert.deepEqual(done.entry.emotions, ['excited', 'tired']);
      assert.deepEqual(done.entry.tags, ['family', 'party']);
      assert.equal(done.memories.length, 1);
      assert.equal(done.memories[0].text, 'Has a sister called Maya');
      assert.equal(done.memories[0].sourceEntryId, entry.id);
      assert.deepEqual(stream.of('memories')[0].added, done.memories);
      assert.equal(stream.of('entry')[0].entry.title, 'Planning Maya\'s party');

      // what the server asked the model, in which order and with which settings
      const requests = h.mock.chatRequests();
      assert.deepEqual(requests.map(taskOf), ['TASK: wrapup', 'TASK: meta', 'TASK: memory']);
      assert.equal(requests[0].body.temperature, 0.7);
      for (const small of requests.slice(1)) {
        assert.equal(small.body.temperature, 0.2, 'metadata and memory calls run cold');
        assert.equal(small.body.max_tokens, 160);
      }
      assert.deepEqual(inflight, [1, 1, 1], 'never two model calls at the same time');
      assert.equal(requests[1].body.messages[1].content.startsWith('Journal entry:'), true);

      assert.deepEqual(await kinds(h, entry.id), ['user', 'wrapup']);
      assert.equal(h.db.memories.list().length, 1);
      assert.equal(h.app.generations.size, 0);
    });
  });

  it('works end to end with the mock model\'s own answers (no scripting)', async () => {
    await withApp({}, async (h) => {
      const { entry } = await h.entry({ content: TEXT });
      const stream = await wrapUp(h, entry.id);
      assert.equal(stream.names().at(-1), 'done');
      const done = stream.of('done')[0];
      assert.equal(done.entry.status, 'wrapped');
      assert.ok(done.entry.title.length > 0);
      assert.ok(done.entry.summary.length > 0);
      assert.ok(done.entry.emotions.length > 0);
      assert.ok(done.message.content.length > 20);
    });
  });

  describe('best-effort steps', () => {
    it('warns, but still wraps up, when the metadata call fails', async () => {
      await withApp({ mock: { failures: [null, 'server_error', null], replies: [REFLECTION, MEMORY] } }, async (h) => {
        const { entry } = await h.entry({ content: TEXT });
        const stream = await wrapUp(h, entry.id);
        const warns = stream.of('notice').filter((n) => n.kind === 'warn');
        assert.equal(warns.length, 1);
        assert.match(warns[0].text, /^Saved without an automatic title or summary: /);
        assert.equal(stream.names().at(-1), 'done');
        const done = stream.of('done')[0];
        assert.equal(done.entry.status, 'wrapped');
        assert.equal(done.entry.title, '');
        assert.equal(done.entry.summary, '');
        assert.equal(done.memories.length, 1, 'the memory step still ran');
        assert.ok(!stream.names().includes('entry'));
      });
    });

    it('warns, but still wraps up, when the memory call fails', async () => {
      await withApp({ mock: { failures: [null, null, 'quota'], replies: [REFLECTION, META] } }, async (h) => {
        const { entry } = await h.entry({ content: TEXT });
        const stream = await wrapUp(h, entry.id);
        const warns = stream.of('notice').filter((n) => n.kind === 'warn');
        assert.equal(warns.length, 1);
        assert.match(warns[0].text, /^Saved without new memories: /);
        const done = stream.of('done')[0];
        assert.equal(done.entry.status, 'wrapped');
        assert.equal(done.entry.title, 'Planning Maya\'s party');
        assert.deepEqual(done.memories, []);
        assert.equal(h.db.memories.list().length, 0);
      });
    });

    it('survives both small calls failing', async () => {
      await withApp({ mock: { failures: [null, 'unauthorized', 'server_error'], replies: [REFLECTION] } }, async (h) => {
        const { entry } = await h.entry({ content: TEXT });
        const stream = await wrapUp(h, entry.id);
        assert.equal(stream.of('notice').filter((n) => n.kind === 'warn').length, 2);
        assert.equal(stream.of('done')[0].entry.status, 'wrapped');
        assert.deepEqual(await kinds(h, entry.id), ['user', 'wrapup']);
      });
    });

    it('falls back to deterministic metadata when the model answers with junk', async () => {
      await withApp({ mock: { replies: [REFLECTION, 'sure! here you go, hope it helps :)', 'none'] } }, async (h) => {
        const { entry } = await h.entry({ content: TEXT });
        const stream = await wrapUp(h, entry.id);
        const done = stream.of('done')[0];
        assert.equal(done.entry.status, 'wrapped');
        assert.ok(done.entry.title.length > 0, 'a title is derived from the text');
        assert.ok(done.entry.summary.length > 0);
        assert.deepEqual(done.memories, []);
        assert.equal(stream.of('notice').length, 0);
      });
    });

    it('does not overwrite a title or labels the person chose', async () => {
      await withApp({ mock: { replies: [REFLECTION, META, 'none'] } }, async (h) => {
        const { entry } = await h.entry({ content: TEXT, title: 'My own title' });
        await h.patch(`/api/entries/${entry.id}`, { emotions: ['grateful'], tags: ['mine'] });
        const done = (await wrapUp(h, entry.id)).of('done')[0];
        assert.equal(done.entry.title, 'My own title');
        assert.deepEqual(done.entry.emotions, ['grateful']);
        assert.deepEqual(done.entry.tags, ['mine']);
        assert.equal(done.entry.summary, 'Planned a birthday party for a sister while feeling excited and tired.');
      });
    });
  });

  describe('memories', () => {
    it('does not add a fact that is already remembered', async () => {
      await withApp({ mock: { replies: [REFLECTION, META, '- Has a younger sister called Maya.\n- Works at a busy office'] } }, async (h) => {
        h.db.memories.create({ text: 'has a younger sister called maya' });
        const { entry } = await h.entry({ content: `${TEXT} My office is always busy.` });
        const done = (await wrapUp(h, entry.id)).of('done')[0];
        assert.ok(done.memories.every((m) => !/sister/i.test(m.text)));
        assert.equal(h.db.memories.list().filter((m) => /sister/i.test(m.text)).length, 1);
        const request = h.mock.chatRequests()[2];
        assert.match(systemOf(request), /Already known, do not repeat:\n- has a younger sister called maya/);
      });
    });

    it('respects memory.enabled, memory.autoExtract and private entries', async () => {
      for (const [label, patch, fields] of [
        ['memory off', { memory: { enabled: false } }, {}],
        ['auto extract off', { memory: { autoExtract: false } }, {}],
        ['private entry', {}, { private: true }],
      ]) {
        await withApp({ mock: { replies: [REFLECTION, META, MEMORY] } }, async (h) => {
          saveSettings(h.db, patch);
          const { entry } = await h.entry({ content: TEXT, ...fields });
          const stream = await wrapUp(h, entry.id);
          const phases = stream.of('phase').map((p) => p.name);
          assert.deepEqual(phases, ['reflection', 'metadata'], label);
          assert.equal(h.mock.chatRequests().length, 2, label);
          assert.deepEqual(stream.of('done')[0].memories, [], label);
          assert.equal(h.db.memories.list().length, 0, label);
          assert.equal(stream.of('done')[0].entry.status, 'wrapped', label);
        });
      }
    });

    it('stores at most three facts and links them to the entry', async () => {
      const facts = '- Has a younger sister called Maya\n- Works in a busy office\n- Lives in Lisbon\n- Has two cats\n- Plays the cello';
      await withApp({ mock: { replies: [REFLECTION, META, facts] } }, async (h) => {
        const { entry } = await h.entry({ content: `${TEXT} I live in Lisbon with my two cats, and play the cello at the office on Fridays.` });
        const done = (await wrapUp(h, entry.id)).of('done')[0];
        assert.ok(done.memories.length >= 1 && done.memories.length <= 3);
        assert.ok(done.memories.every((m) => m.sourceEntryId === entry.id));
      });
    });
  });

  describe('preconditions and failures', () => {
    it('answers JSON 409 for ai_disabled, ai_not_configured, nothing_to_reply_to and generation_in_progress', async () => {
      await withApp({ ai: false }, async (h) => {
        const { entry } = await h.entry({ content: 'hello' });
        const a = await wrapUp(h, entry.id);
        assert.equal(a.status, 409);
        assert.equal(a.error.code, 'ai_not_configured');
        saveSettings(h.db, { ai: { enabled: false } });
        assert.equal((await wrapUp(h, entry.id)).error.code, 'ai_disabled');
        assert.equal((await wrapUp(h, '00000000-0000-4000-8000-000000000000')).status, 404);
      });
      await withApp({ mock: { delayMs: 20, replies: ['word '.repeat(300)] } }, async (h) => {
        const empty = await h.entry({});
        const none = await wrapUp(h, empty.entry.id);
        assert.equal(none.status, 409);
        assert.equal(none.error.code, 'nothing_to_reply_to');
        const promptOnly = await h.entry({ templateId: 'gratitude' });
        assert.equal((await wrapUp(h, promptOnly.entry.id)).error.code, 'nothing_to_reply_to');

        const { entry } = await h.entry({ content: 'Something.' });
        const first = h.stream(`/api/entries/${entry.id}/wrap-up`, {});
        await first.waitForEvent('delta');
        const second = await wrapUp(h, entry.id);
        assert.equal(second.status, 409);
        assert.equal(second.error.code, 'generation_in_progress');
        first.abort();
        await first.finished;
        await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });
      });
    });

    it('wraps up an entry whose last message is the companion\'s reply', async () => {
      await withApp({}, async (h) => {
        const { entry } = await h.entry({ content: TEXT });
        await h.sse(`/api/entries/${entry.id}/reply`, {});
        const stream = await wrapUp(h, entry.id);
        assert.equal(stream.names().at(-1), 'done');
        assert.deepEqual(await kinds(h, entry.id), ['user', 'reply', 'wrapup']);
        const request = h.mock.chatRequests().find((r) => taskOf(r) === 'TASK: wrapup');
        assert.equal(request.body.messages.at(-1).role, 'user');
      });
    });

    it('reports a failing reflection and leaves the entry open and unchanged', async () => {
      await withApp({ mock: { failures: ['unauthorized'] } }, async (h) => {
        const { entry } = await h.entry({ content: TEXT });
        const stream = await wrapUp(h, entry.id);
        assert.deepEqual(stream.names().filter((n) => n !== 'delta'), ['phase', 'error']);
        assert.equal(stream.of('error')[0].error.code, 'auth');
        const found = (await h.get(`/api/entries/${entry.id}`)).json;
        assert.equal(found.entry.status, 'open');
        assert.equal(found.messages.length, 1);
        assert.equal(h.mock.chatRequests().length, 1, 'no metadata or memory calls after a failed reflection');
        assert.equal(h.app.generations.size, 0);
        // trying again works
        assert.equal((await wrapUp(h, entry.id)).names().at(-1), 'done');
      });
    });

    it('saves nothing when the client leaves during the reflection', async () => {
      await withApp({ mock: { delayMs: 20, replies: ['word '.repeat(300)] } }, async (h) => {
        const { entry } = await h.entry({ content: TEXT });
        const stream = h.stream(`/api/entries/${entry.id}/wrap-up`, {});
        await waitFor(() => stream.of('delta').length >= 3, { message: 'deltas' });
        stream.abort();
        await stream.finished;
        await h.mock.waitForIdle();
        await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });
        const found = (await h.get(`/api/entries/${entry.id}`)).json;
        assert.equal(found.entry.status, 'open');
        assert.equal(found.messages.length, 1);
        assert.equal(h.mock.chatRequests().length, 1);
      });
    });

    it('keeps the reflection and marks the entry wrapped when the client leaves during a later step', async () => {
      await withApp({ mock: { failures: [null, 'hang'], replies: [REFLECTION] } }, async (h) => {
        const { entry } = await h.entry({ content: TEXT });
        const stream = h.stream(`/api/entries/${entry.id}/wrap-up`, {});
        await h.mock.waitForRequests(2, { filter: (r) => /chat\/completions/.test(r.path) });
        stream.abort();
        await stream.finished;
        await h.mock.waitForIdle();
        await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });
        const found = (await h.get(`/api/entries/${entry.id}`)).json;
        assert.deepEqual(found.messages.map((m) => m.meta.kind || 'user'), ['user', 'wrapup']);
        assert.equal(found.entry.status, 'wrapped');
        assert.equal(h.mock.chatRequests().length, 2, 'the memory call was skipped');
      });
    });

    it('can be repeated: a second wrap-up adds a second reflection and keeps the first title', async () => {
      await withApp({ mock: { replies: [REFLECTION, META, 'none', REFLECTION, 'Title: Another title\nSummary: Newer summary.\nEmotions: calm\nTags: x', 'none'] } }, async (h) => {
        const { entry } = await h.entry({ content: TEXT });
        await wrapUp(h, entry.id);
        await h.post(`/api/entries/${entry.id}/messages`, { content: 'One more thought about the cake.' });
        const done = (await wrapUp(h, entry.id)).of('done')[0];
        assert.equal(done.entry.title, 'Planning Maya\'s party');
        assert.equal(done.entry.summary, 'Newer summary.');
        assert.deepEqual(await kinds(h, entry.id), ['user', 'wrapup', 'user', 'wrapup']);
      });
    });
  });

  describe('prompt details', () => {
    it('mentions the guided exercise and carries the crisis notice flow', async () => {
      await withApp({}, async (h) => {
        const { entry } = await h.entry({ templateId: 'gratitude', content: 'My family, my health, a warm bed.' });
        await wrapUp(h, entry.id);
        assert.match(systemOf(h.mock.chatRequests()[0]), /guided exercise: /);
        assert.match(systemOf(h.mock.chatRequests()[1]), /guided exercise: /);
      });
      await withApp({}, async (h) => {
        const { entry } = await h.entry({ content: 'I want to end my life. I cannot go on.' });
        const stream = await wrapUp(h, entry.id);
        assert.equal(stream.names()[0], 'notice');
        assert.equal(stream.of('notice')[0].kind, 'safety');
        assert.equal(stream.of('notice')[0].message.content, crisisNotice());
        assert.deepEqual(await kinds(h, entry.id), ['user', 'safety', 'wrapup']);
        assert.match(systemOf(h.mock.chatRequests()[0]), /Put care first/);
        await wrapUp(h, entry.id);
        assert.equal((await kinds(h, entry.id)).filter((k) => k === 'safety').length, 1, 'no second care card');
      });
    });

    it('stays within a tiny context budget', async () => {
      await withApp({ settings: { ai: { contextBudgetTokens: 500 } } }, async (h) => {
        const { entry } = await h.entry({ content: `${TEXT} ${'More words about my day. '.repeat(400)}` });
        const stream = await wrapUp(h, entry.id);
        assert.equal(stream.names().at(-1), 'done');
        for (const request of h.mock.chatRequests()) {
          const chars = request.body.messages.reduce((n, m) => n + m.content.length, 0);
          assert.ok(chars / 3.5 < 600, `${taskOf(request)} prompt is about ${Math.round(chars / 3.5)} tokens`);
        }
      });
    });
  });
});
