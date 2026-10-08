import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crisisNotice } from '../../src/journal/safety.js';
import { freePort, saveSettings, startApp, waitFor, withApp } from './helpers.js';

const LONG = Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ');
const CRISIS = 'I feel hopeless and I want to kill myself tonight.';

const reply = (h, id, body = {}) => h.sse(`/api/entries/${id}/reply`, body);
const messagesOf = async (h, id) => (await h.get(`/api/entries/${id}`)).json.messages;
const systemOf = (request) => request.body.messages.find((m) => m.role === 'system').content;
const lastChat = (h) => h.mock.lastChatRequest();

describe('POST /api/entries/:id/reply', () => {
  describe('happy path', () => {
    it('streams deltas, then done with the persisted message and entry', async () => {
      await withApp({ mock: { delayMs: 2 } }, async (h) => {
        const { entry } = await h.entry({ content: 'I spent the morning planning my sister Maya\'s birthday party.', mood: 4, date: '2026-10-08' });
        const stream = await reply(h, entry.id);
        assert.equal(stream.status, 200);
        const names = stream.names();
        assert.equal(names.at(-1), 'done');
        assert.deepEqual([...new Set(names)], ['delta', 'done']);
        assert.ok(names.filter((n) => n === 'delta').length >= 3, 'text arrives in pieces');

        const done = stream.of('done')[0];
        assert.deepEqual(Object.keys(done).sort(), ['entry', 'message']);
        assert.equal(done.message.role, 'assistant');
        assert.equal(done.message.entryId, entry.id);
        assert.equal(done.message.seq, 1);
        assert.deepEqual(done.message.meta, { kind: 'reply', provider: 'local', model: 'llama3.2:3b' });
        assert.equal(done.message.content, stream.text(), 'the streamed text is the saved text');
        assert.match(done.message.content, /\?$/);
        assert.equal(done.entry.id, entry.id);
        assert.equal(done.entry.messageCount, 2);

        const saved = await messagesOf(h, entry.id);
        assert.deepEqual(saved.map((m) => m.role), ['user', 'assistant']);
        assert.deepEqual(saved[1], done.message);
        assert.equal(h.app.generations.size, 0, 'the lock is released');
      });
    });

    it('saves the person\'s message before the model is called and builds the prompt from the settings', async () => {
      await withApp({}, async (h) => {
        saveSettings(h.db, { profile: { name: 'Sam', about: 'I am a nurse.' }, ai: { temperature: 0.3, maxTokens: 222 } });
        const { entry } = await h.entry({ content: 'Long shift today, my feet hurt.' });
        let seen = null;
        h.mock.setBehavior({
          replies: [() => { seen = h.db.messages.list(entry.id).map((m) => m.role); return 'That sounds exhausting. What would help you rest tonight?'; }],
        });
        const stream = await reply(h, entry.id, { today: '2026-10-08' });
        assert.deepEqual(seen, ['user'], 'the user message was already in the database when the model was called');
        assert.equal(stream.names().at(-1), 'done');
        const request = lastChat(h);
        assert.equal(request.body.model, 'llama3.2:3b');
        assert.equal(request.body.stream, true);
        assert.equal(request.body.temperature, 0.3);
        assert.equal(request.body.max_tokens, 222);
        const system = systemOf(request);
        assert.match(system, /^TASK: reply\n/);
        assert.match(system, /The user's name is Sam\./);
        assert.match(system, /Today is Thursday, 8 October 2026\./);
        assert.deepEqual(request.body.messages.map((m) => m.role), ['system', 'user']);
        assert.equal(request.body.messages[1].content, 'Long shift today, my feet hurt.');
      });
    });

    it('works with the OpenAI-compatible and Gemini providers too', async () => {
      await withApp({ ai: 'openai' }, async (h) => {
        const { entry } = await h.entry({ content: 'Quiet day at home.' });
        const stream = await reply(h, entry.id);
        assert.equal(stream.names().at(-1), 'done');
        assert.deepEqual(stream.of('done')[0].message.meta, { kind: 'reply', provider: 'openai', model: 'mock-model' });
        const request = lastChat(h);
        assert.equal(request.headers.authorization, 'Bearer test-openai-key');
        assert.equal(request.body.max_tokens, 700);
      });
      await withApp({ ai: 'gemini' }, async (h) => {
        const { entry } = await h.entry({ content: 'Quiet day at home.' });
        const stream = await reply(h, entry.id);
        assert.equal(stream.names().at(-1), 'done');
        assert.equal(stream.of('done')[0].message.meta.provider, 'gemini');
        assert.equal(stream.of('done')[0].message.meta.model, 'gemini-flash-lite-latest');
        const request = h.mock.lastGenerateRequest();
        assert.equal(request.headers['x-goog-api-key'], 'test-gemini-key');
        assert.ok(!request.path.includes('test-gemini-key') && !JSON.stringify(request.query).includes('test-gemini-key'), 'the key never travels in the URL');
      });
    });

    it('cleans model output before saving it', async () => {
      await withApp({ mock: { replies: ['Assistant: <think>let me think</think>That sounds like a lot. What part weighs most?'] } }, async (h) => {
        const { entry } = await h.entry({ content: 'Too many things at once.' });
        const stream = await reply(h, entry.id);
        assert.equal(stream.of('done')[0].message.content, 'That sounds like a lot. What part weighs most?');
      });
    });

    it('keeps emoji and multi-byte text intact when the model splits them across chunks', async () => {
      const text = 'Gracias por compartirlo 🌱✨ 今日はどうでしたか？ Was ist heute passiert? 👨‍👩‍👧';
      await withApp({ mock: { replies: [text], chunkSize: 1 } }, async (h) => {
        const { entry } = await h.entry({ content: 'Hola 🌍' });
        const stream = await reply(h, entry.id);
        assert.equal(stream.of('done')[0].message.content, text);
        assert.equal(stream.text(), text);
      });
    });

    it('cuts an absurdly long model reply instead of failing', async () => {
      const huge = 'lorem ipsum '.repeat(25_000); // 300 000 characters
      await withApp({ mock: { replies: [huge], chunkSize: 4000, emptyDeltas: false } }, async (h) => {
        const { entry } = await h.entry({ content: 'Say a lot.' });
        const stream = await reply(h, entry.id);
        assert.equal(stream.names().at(-1), 'done');
        const saved = stream.of('done')[0].message.content;
        assert.ok(saved.length <= 150_000 && saved.length > 100_000, `saved ${saved.length} characters`);
        assert.ok(stream.text().length > saved.length, 'the stream itself was complete');
      });
    });

    it('sends a ping comment while waiting for a slow model', async () => {
      await withApp({ config: { ssePingMs: 25 }, mock: { ttfbMs: 300 } }, async (h) => {
        const { entry } = await h.entry({ content: 'Waiting.' });
        const stream = await reply(h, entry.id);
        assert.match(stream.raw, /^: ping\n\n/m);
        assert.equal(stream.names().at(-1), 'done');
      });
    });
  });

  describe('preconditions are JSON errors before any stream', () => {
    const expectJson = (stream, status, code) => {
      assert.equal(stream.status, status);
      assert.match(stream.headers['content-type'], /application\/json/);
      assert.equal(stream.error.code, code);
      assert.equal(stream.events.length, 0);
    };

    it('404 for an unknown entry', async () => {
      await withApp({}, async (h) => {
        expectJson(await reply(h, '00000000-0000-4000-8000-000000000000'), 404, 'not_found');
      });
    });

    it('409 ai_disabled when the companion is switched off', async () => {
      await withApp({ settings: { ai: { enabled: false } } }, async (h) => {
        const { entry } = await h.entry({ content: 'hello' });
        const stream = await reply(h, entry.id);
        expectJson(stream, 409, 'ai_disabled');
        assert.ok(stream.error.hint);
        assert.equal(h.mock.chatRequests().length, 0);
        assert.equal((await messagesOf(h, entry.id)).length, 1, 'nothing was written');
      });
    });

    it('409 ai_not_configured with no provider, and for a provider without its key', async () => {
      await withApp({ ai: false }, async (h) => {
        const { entry } = await h.entry({ content: 'hello' });
        expectJson(await reply(h, entry.id), 409, 'ai_not_configured');
        saveSettings(h.db, { ai: { provider: 'openai' } });
        const noKey = await reply(h, entry.id);
        expectJson(noKey, 409, 'ai_not_configured');
        assert.match(noKey.error.message, /not fully set up/);
        saveSettings(h.db, { ai: { provider: 'gemini' } });
        expectJson(await reply(h, entry.id), 409, 'ai_not_configured');
      });
    });

    it('picks up the key from the environment', async () => {
      const port = await freePort();
      await withApp({ ai: false, env: { OPENAI_API_KEY: 'sk-from-env-0000', OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` }, settings: { ai: { provider: 'openai' } } }, async (h) => {
        const { entry } = await h.entry({ content: 'hello' });
        const stream = await reply(h, entry.id);
        assert.equal(stream.status, 200, 'configured through the environment, so the stream opens');
        assert.equal(stream.of('error')[0].error.code, 'network', 'nothing listens on that port');
        assert.doesNotMatch(stream.raw, /sk-from-env-0000/);
      });
    });

    it('409 nothing_to_reply_to when the last message is not the person\'s', async () => {
      await withApp({}, async (h) => {
        const empty = await h.entry({});
        expectJson(await reply(h, empty.entry.id), 409, 'nothing_to_reply_to');
        const guided = await h.entry({ templateId: 'gratitude' });
        expectJson(await reply(h, guided.entry.id), 409, 'nothing_to_reply_to');
        expectJson(await reply(h, guided.entry.id, { regenerate: true }), 409, 'nothing_to_reply_to');
        assert.equal((await messagesOf(h, guided.entry.id)).length, 1, 'the opening question was not deleted by the refused regenerate');
        const answered = await h.entry({ content: 'Fine.' });
        assert.equal((await reply(h, answered.entry.id)).names().at(-1), 'done');
        expectJson(await reply(h, answered.entry.id), 409, 'nothing_to_reply_to');
        assert.equal(h.mock.chatRequests().length, 1);
      });
    });

    it('409 generation_in_progress while another reply for the entry is running', async () => {
      await withApp({ mock: { delayMs: 15, replies: [LONG] } }, async (h) => {
        const { entry } = await h.entry({ content: 'Slow one.' });
        const first = h.stream(`/api/entries/${entry.id}/reply`, {});
        await first.waitForEvent('delta');
        expectJson(await reply(h, entry.id), 409, 'generation_in_progress');
        expectJson(await h.sse(`/api/entries/${entry.id}/wrap-up`, {}), 409, 'generation_in_progress');
        first.abort();
        await first.finished;
        await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });
      });
    });

    it('rejects a malformed body', async () => {
      await withApp({}, async (h) => {
        const { entry } = await h.entry({ content: 'hello' });
        for (const body of [{ regenerate: 'yes' }, { regenerate: 1 }, { today: 'tomorrow' }, { today: '2026-02-31' }]) {
          expectJson(await reply(h, entry.id, body), 400, 'bad_request');
        }
        const raw = await h.request('POST', `/api/entries/${entry.id}/reply`, { rawBody: '{oops' });
        assert.equal(raw.status, 400);
      });
    });
  });

  describe('regenerate', () => {
    it('replaces only the trailing reply', async () => {
      await withApp({ mock: { replies: ['First answer. Why?', 'Second answer. How?'] } }, async (h) => {
        const { entry } = await h.entry({ templateId: 'gratitude', content: 'My family.' });
        await reply(h, entry.id);
        const before = await messagesOf(h, entry.id);
        assert.deepEqual(before.map((m) => m.meta.kind || 'user'), ['prompt', 'user', 'reply']);
        const stream = await reply(h, entry.id, { regenerate: true });
        assert.equal(stream.of('done')[0].message.content, 'Second answer. How?');
        const after = await messagesOf(h, entry.id);
        assert.deepEqual(after.map((m) => m.meta.kind || 'user'), ['prompt', 'user', 'reply']);
        assert.equal(after[0].id, before[0].id, 'the opening question stays');
        assert.equal(after[1].id, before[1].id);
        assert.notEqual(after[2].id, before[2].id);
        const request = lastChat(h);
        assert.equal(request.body.messages.at(-1).role, 'user', 'the old reply is not part of the prompt');
        assert.ok(!request.body.messages.some((m) => /First answer/.test(m.content)));
      });
    });

    it('does not delete a wrap-up and refuses with nothing_to_reply_to', async () => {
      await withApp({}, async (h) => {
        const { entry } = await h.entry({ content: 'A day.' });
        await reply(h, entry.id);
        await h.sse(`/api/entries/${entry.id}/wrap-up`, {});
        const before = await messagesOf(h, entry.id);
        assert.equal(before.at(-1).meta.kind, 'wrapup');
        const stream = await reply(h, entry.id, { regenerate: true });
        assert.equal(stream.status, 409);
        assert.equal(stream.error.code, 'nothing_to_reply_to');
        assert.deepEqual((await messagesOf(h, entry.id)).map((m) => m.id), before.map((m) => m.id));
      });
    });

    it('behaves like a normal reply when the last message is the person\'s', async () => {
      await withApp({}, async (h) => {
        const { entry } = await h.entry({ content: 'Hello.' });
        const stream = await reply(h, entry.id, { regenerate: true });
        assert.equal(stream.names().at(-1), 'done');
        assert.equal((await messagesOf(h, entry.id)).length, 2);
      });
    });

    it('replaces a stopped partial reply as well', async () => {
      await withApp({ mock: { delayMs: 15, replies: [LONG] } }, async (h) => {
        const { entry } = await h.entry({ content: 'Start.' });
        const first = h.stream(`/api/entries/${entry.id}/reply`, {});
        await waitFor(() => first.of('delta').length >= 3, { message: 'three deltas' });
        first.abort();
        await waitFor(async () => (await messagesOf(h, entry.id)).length === 2, { message: 'partial saved' });
        h.mock.setBehavior({ replies: ['Complete answer. Why?'] });
        const stream = await reply(h, entry.id, { regenerate: true });
        assert.equal(stream.of('done')[0].message.content, 'Complete answer. Why?');
        const saved = await messagesOf(h, entry.id);
        assert.equal(saved.length, 2);
        assert.equal(saved[1].meta.stopped, undefined);
      });
    });
  });

  describe('cancellation', () => {
    it('aborts the upstream request, saves the partial text as stopped, and frees the lock', async () => {
      await withApp({ mock: { delayMs: 20, replies: [LONG] } }, async (h) => {
        const { entry } = await h.entry({ content: 'Tell me something long.' });
        const stream = h.stream(`/api/entries/${entry.id}/reply`, {});
        await waitFor(() => stream.of('delta').length >= 4, { message: 'a few deltas' });
        const received = stream.text();
        assert.ok(received.length > 0 && received.length < LONG.length);
        stream.abort();
        await stream.finished;

        await h.mock.waitForIdle();
        assert.equal(h.mock.chatRequests().at(-1).aborted, true, 'the model request was cancelled');

        const partial = await waitFor(async () => (await messagesOf(h, entry.id)).find((m) => m.role === 'assistant'), { message: 'the partial reply' });
        assert.equal(partial.meta.stopped, true);
        assert.equal(partial.meta.kind, 'reply');
        assert.equal(partial.meta.provider, 'local');
        assert.ok(partial.content.length > 0 && partial.content.length < LONG.length);
        assert.ok(LONG.startsWith(partial.content.slice(0, 20)), 'it is the beginning of the reply');
        await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });

        // the entry can be answered again straight away
        h.mock.setBehavior({ replies: ['A fresh answer. Does that help?'] });
        const again = await reply(h, entry.id, { regenerate: true });
        assert.equal(again.names().at(-1), 'done');
        assert.equal(again.of('done')[0].message.content, 'A fresh answer. Does that help?');
      });
    });

    it('saves nothing when the client leaves before the first word, and still frees the lock', async () => {
      await withApp({ mock: { ttfbMs: 5000 } }, async (h) => {
        const { entry } = await h.entry({ content: 'Anyone there?' });
        const stream = h.stream(`/api/entries/${entry.id}/reply`, {});
        await h.mock.waitForRequests(1, { filter: (r) => /chat\/completions/.test(r.path) });
        stream.abort();
        await stream.finished;
        await h.mock.waitForIdle();
        await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });
        assert.equal((await messagesOf(h, entry.id)).length, 1);
        h.mock.setBehavior({ ttfbMs: 0 });
        assert.equal((await reply(h, entry.id)).names().at(-1), 'done');
      });
    });

    it('frees the lock when the model never answers at all', async () => {
      await withApp({ mock: { failures: ['hang'] } }, async (h) => {
        const { entry } = await h.entry({ content: 'Hello?' });
        const stream = h.stream(`/api/entries/${entry.id}/reply`, {});
        await h.mock.waitForRequests(1, { filter: (r) => /chat\/completions/.test(r.path) });
        stream.abort();
        await stream.finished;
        await h.mock.waitForIdle();
        await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });
        assert.equal((await reply(h, entry.id)).names().at(-1), 'done');
      });
    });

    it('stops the work when the entry is deleted while it is being answered', async () => {
      await withApp({ mock: { delayMs: 15, replies: [LONG] } }, async (h) => {
        const { entry } = await h.entry({ content: 'Soon gone.' });
        const stream = h.stream(`/api/entries/${entry.id}/reply`, {});
        await stream.waitForEvent('delta');
        assert.equal((await h.del(`/api/entries/${entry.id}`)).status, 204);
        await stream.finished;
        await h.mock.waitForIdle();
        await waitFor(() => h.app.generations.size === 0, { message: 'lock release' });
        assert.equal((await h.get(`/api/entries/${entry.id}`)).status, 404);
        assert.equal(h.db.messages.list(entry.id).length, 0);
      });
    });

    it('saves the partial text when the server shuts down mid-reply', async () => {
      const h = await startApp({ mock: { delayMs: 15, replies: [LONG] } });
      try {
        const { entry } = await h.entry({ content: 'Shutdown test.' });
        const stream = h.stream(`/api/entries/${entry.id}/reply`, {});
        await waitFor(() => stream.of('delta').length >= 3, { message: 'deltas' });
        await h.app.close();
        await stream.finished;
        const saved = h.db.messages.list(entry.id);
        assert.equal(saved.length, 2);
        assert.equal(saved[1].meta.stopped, true);
        assert.equal(h.app.generations.size, 0);
      } finally {
        await h.close();
      }
    });
  });

  describe('failures', () => {
    const errorOf = (stream) => stream.of('error')[0].error;

    it('reports provider errors as an error event and keeps the person\'s message', async () => {
      const cases = [
        ['unauthorized', 'auth'],
        ['quota', 'quota'],
        ['model_not_found', 'model_not_found'],
        ['server_error', 'server'],
        ['context_length', 'context_too_long'],
        ['empty', 'empty'],
      ];
      for (const [kind, code] of cases) {
        await withApp({ mock: { failures: [kind] } }, async (h) => {
          const { entry } = await h.entry({ content: 'Something to say.' });
          const stream = await reply(h, entry.id);
          assert.equal(stream.status, 200, kind);
          assert.deepEqual(stream.names().filter((n) => n !== 'delta'), ['error'], kind);
          const error = errorOf(stream);
          assert.equal(error.code, code, kind);
          assert.equal(typeof error.message, 'string');
          assert.ok(error.message.length > 0);
          assert.deepEqual((await messagesOf(h, entry.id)).map((m) => m.role), ['user'], `${kind}: only the person's message`);
          assert.equal(h.app.generations.size, 0);
          // the next try works
          assert.equal((await reply(h, entry.id)).names().at(-1), 'done', kind);
        });
      }
    });

    it('keeps the partial text as a stopped message when the model fails halfway', async () => {
      await withApp({ mock: { failures: [{ kind: 'error_in_stream', after: 4 }], replies: [LONG], delayMs: 2 } }, async (h) => {
        const { entry } = await h.entry({ content: 'Go on.' });
        const stream = await reply(h, entry.id);
        assert.equal(stream.names().at(-1), 'error');
        const streamed = stream.text();
        assert.ok(streamed.length > 0);
        const saved = await messagesOf(h, entry.id);
        assert.equal(saved.length, 2);
        assert.equal(saved[1].meta.stopped, true);
        assert.equal(saved[1].content, streamed.trim());
        assert.equal(h.app.generations.size, 0);
      });
    });

    it('never puts the API key into events, stored messages or errors', async () => {
      await withApp({ ai: 'openai', mock: { failures: ['echo_key'] } }, async (h) => {
        const { entry } = await h.entry({ content: 'Key test.' });
        const stream = await reply(h, entry.id);
        assert.equal(errorOf(stream).code, 'auth');
        assert.doesNotMatch(stream.raw, /test-openai-key/);
        assert.doesNotMatch(JSON.stringify(await messagesOf(h, entry.id)), /test-openai-key/);
      });
    });

    it('survives an unexpected exception: error event, lock released, next reply works', async () => {
      const errors = [];
      await withApp({ config: { logger: { error: (m) => errors.push(m) } } }, async (h) => {
        const { entry } = await h.entry({ content: 'Boom.' });
        const original = h.db.messages.add;
        let armed = true;
        h.db.messages.add = (...args) => {
          if (armed && args[1].role === 'assistant') { armed = false; throw new Error('disk exploded'); }
          return original(...args);
        };
        const stream = await reply(h, entry.id);
        assert.equal(stream.names().at(-1), 'error');
        assert.equal(errorOf(stream).code, 'unknown');
        assert.doesNotMatch(stream.raw, /disk exploded/);
        assert.equal(h.app.generations.size, 0);
        assert.ok(errors.length > 0);
        assert.equal((await reply(h, entry.id)).names().at(-1), 'done');
      });
    });

    it('answers concurrent replies for one entry with exactly one stream', async () => {
      await withApp({ mock: { delayMs: 10 } }, async (h) => {
        const { entry } = await h.entry({ content: 'Race.' });
        const results = await Promise.all(Array.from({ length: 5 }, () => reply(h, entry.id)));
        const ok = results.filter((r) => r.status === 200);
        const refused = results.filter((r) => r.status === 409);
        assert.equal(ok.length, 1);
        assert.equal(refused.length, 4);
        assert.ok(refused.every((r) => ['generation_in_progress', 'nothing_to_reply_to'].includes(r.error.code)));
        assert.equal((await messagesOf(h, entry.id)).length, 2);
      });
    });

    it('lets different entries be answered at the same time', async () => {
      await withApp({ mock: { delayMs: 5 } }, async (h) => {
        const entries = await Promise.all([1, 2, 3].map((n) => h.entry({ content: `Entry number ${n}.` })));
        const results = await Promise.all(entries.map(({ entry }) => reply(h, entry.id)));
        assert.ok(results.every((r) => r.names().at(-1) === 'done'));
      });
    });
  });

  describe('safety', () => {
    it('sends a safety notice first, saves the care card once, and still answers', async () => {
      await withApp({}, async (h) => {
        const { entry } = await h.entry({ content: CRISIS });
        const stream = await reply(h, entry.id);
        assert.equal(stream.names()[0], 'notice');
        const notice = stream.of('notice')[0];
        assert.equal(notice.kind, 'safety');
        assert.equal(notice.text, crisisNotice());
        assert.equal(notice.message.role, 'assistant');
        assert.deepEqual(notice.message.meta, { kind: 'safety' });
        assert.equal(notice.message.content, crisisNotice());
        assert.equal(stream.names().at(-1), 'done');

        const saved = await messagesOf(h, entry.id);
        assert.deepEqual(saved.map((m) => m.meta.kind || 'user'), ['user', 'safety', 'reply']);
        assert.equal(saved[1].id, notice.message.id);

        const system = systemOf(lastChat(h));
        assert.match(system, /Put care first/);
        assert.ok(!lastChat(h).body.messages.some((m) => m.content.includes('988')), 'the care card is not part of the prompt');

        // asking again must not stack up care cards
        const again = await reply(h, entry.id, { regenerate: true });
        assert.equal(again.of('notice')[0].message.id, notice.message.id);
        const kinds = (await messagesOf(h, entry.id)).map((m) => m.meta.kind || 'user');
        assert.deepEqual(kinds, ['user', 'safety', 'reply']);
      });
    });

    it('keeps the care card when the model fails, and the retry does not add a second one', async () => {
      await withApp({ mock: { failures: ['server_error'] } }, async (h) => {
        const { entry } = await h.entry({ content: CRISIS });
        const first = await reply(h, entry.id);
        assert.deepEqual(first.names().filter((n) => n !== 'delta'), ['notice', 'error']);
        assert.deepEqual((await messagesOf(h, entry.id)).map((m) => m.meta.kind || 'user'), ['user', 'safety']);
        // the care card is the last message, yet the person's message is still unanswered: replying is allowed
        const retry = await reply(h, entry.id);
        assert.equal(retry.names().at(-1), 'done');
        assert.deepEqual((await messagesOf(h, entry.id)).map((m) => m.meta.kind || 'user'), ['user', 'safety', 'reply']);
      });
    });

    it('saves the care card even when the AI is not available', async () => {
      await withApp({ ai: false }, async (h) => {
        const { entry } = await h.entry({ content: CRISIS });
        for (let i = 0; i < 2; i += 1) {
          const stream = await reply(h, entry.id);
          assert.equal(stream.status, 409);
          assert.equal(stream.error.code, 'ai_not_configured');
        }
        const saved = await messagesOf(h, entry.id);
        assert.deepEqual(saved.map((m) => m.meta.kind || 'user'), ['user', 'safety']);
        assert.equal(saved[1].content, crisisNotice());
      });
    });

    it('does not trigger on everyday text', async () => {
      await withApp({}, async (h) => {
        const { entry } = await h.entry({ content: 'I was dying of embarrassment, then killing myself laughing. Cut myself shaving too.' });
        const stream = await reply(h, entry.id);
        assert.ok(!stream.names().includes('notice'));
        assert.deepEqual((await messagesOf(h, entry.id)).map((m) => m.meta.kind || 'user'), ['user', 'reply']);
      });
    });
  });

  describe('memory and related entries in the prompt', () => {
    it('lists memories (pinned first) when memory is on and omits them when it is off', async () => {
      await withApp({}, async (h) => {
        h.db.memories.create({ text: 'Has a younger sister called Maya' });
        h.db.memories.create({ text: 'Works as a nurse', pinned: true });
        const { entry } = await h.entry({ content: 'Quiet evening.' });
        await reply(h, entry.id);
        const system = systemOf(lastChat(h));
        assert.match(system, /Things you know about the user:\n- Works as a nurse\n- Has a younger sister called Maya/);

        saveSettings(h.db, { memory: { enabled: false } });
        await reply(h, entry.id, { regenerate: true });
        assert.doesNotMatch(systemOf(lastChat(h)), /nurse|Maya/);
      });
    });

    it('recalls related past entries but never private ones, and never for a private entry', async () => {
      await withApp({}, async (h) => {
        const old = (await h.entry({ content: 'I baked sourdough bread all afternoon and the kitchen smelled amazing.', date: '2026-09-01', title: 'Sourdough afternoon' })).entry;
        h.db.entries.update(old.id, { summary: 'Baked sourdough bread; felt proud of the crust.' });
        const secret = (await h.entry({ content: 'My sourdough starter reminds me of my secret therapist visit.', date: '2026-09-02', title: 'Secret sourdough', private: true })).entry;
        const { entry } = await h.entry({ content: 'Thinking about baking sourdough again this weekend.', date: '2026-10-08' });

        await reply(h, entry.id);
        const system = systemOf(lastChat(h));
        assert.match(system, /Possibly relevant past entries/);
        assert.match(system, /Sourdough afternoon: Baked sourdough bread; felt proud of the crust\./);
        assert.doesNotMatch(system, /Secret sourdough|therapist/);
        assert.ok(!system.includes(secret.id));

        saveSettings(h.db, { memory: { useRelatedEntries: false } });
        await reply(h, entry.id, { regenerate: true });
        assert.doesNotMatch(systemOf(lastChat(h)), /Possibly relevant/);

        saveSettings(h.db, { memory: { useRelatedEntries: true } });
        h.db.entries.update(entry.id, { private: true });
        await reply(h, entry.id, { regenerate: true });
        assert.doesNotMatch(systemOf(lastChat(h)), /Possibly relevant/, 'a private entry gets no recall');
      });
    });

    it('adds the guided-session step for template entries', async () => {
      await withApp({}, async (h) => {
        const { entry } = await h.entry({ templateId: 'gratitude', content: 'My morning coffee.' });
        await reply(h, entry.id);
        const request = lastChat(h);
        assert.match(systemOf(request), /Step 2 of \d+:/);
        assert.deepEqual(request.body.messages.map((m) => m.role), ['system', 'assistant', 'user'], 'the opening question is the first turn');
      });
    });
  });
});
