// "One question per reply": small models sometimes append a second question in a paragraph of its own. The reply (and only the
// reply) drops it: the saved message and the `done` event carry the cleaned text, and the live stream never shows the dropped
// paragraph. Wrap-up and the weekly reflection are untouched (they share cleanReply, which must not do this).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanReply } from '../../src/journal/tasks.js';
import { dropSecondQuestion } from '../../src/server/generation.js';
import { saveSettings, withApp } from './helpers.js';

const reply = (h, id, body = {}) => h.sse(`/api/entries/${id}/reply`, body);
const messagesOf = async (h, id) => (await h.get(`/api/entries/${id}`)).json.messages;

const ONE = 'That sounds like a heavy day. What part of it stays with you most?';
const TWO = `${ONE}\n\nAnd how did you sleep afterwards?`;

describe('dropSecondQuestion (pure)', () => {
  const same = (text, why) => assert.equal(dropSecondQuestion(text), text, why);

  it('drops a last paragraph that is one sentence ending in "?" when the paragraph before also ends in "?"', () => {
    assert.equal(dropSecondQuestion(TWO), ONE);
    assert.equal(dropSecondQuestion('Q one?\n\nQ two?'), 'Q one?');
    assert.equal(dropSecondQuestion('Intro line.\n\nWhat felt hardest?\n\nWho could you tell?'), 'Intro line.\n\nWhat felt hardest?');
  });

  it('only the last paragraph, and only once', () => {
    assert.equal(dropSecondQuestion('A?\n\nB?\n\nC?'), 'A?\n\nB?');
  });

  it('tolerates closing quotes, brackets, markdown emphasis and the full-width question mark', () => {
    assert.equal(dropSecondQuestion('What was it like?\n\n**And then what happened?**'), 'What was it like?');
    assert.equal(dropSecondQuestion('He asked "why did you go?"\n\n(Was it worth it?)'), 'He asked "why did you go?"');
    assert.equal(dropSecondQuestion('どう感じましたか？\n\nそれからどうなりましたか？'), 'どう感じましたか？');
    assert.equal(dropSecondQuestion('¿Cómo te sentiste?\n\n¿Y después qué pasó?'), '¿Cómo te sentiste?');
  });

  it('keeps everything else untouched', () => {
    same(ONE, 'a single paragraph');
    same('One thought.\n\nWhat comes next?', 'only the last paragraph is a question');
    same('Is that right?\n\nIt does not sound like it. What would you change?', 'the last paragraph has two sentences');
    same('What happened?\n\nTell me more.', 'the last paragraph is not a question');
    same('What happened?\n\nA statement, then:\nWhat now?', 'a paragraph of several lines');
    same('What happened?\n\n- Who was there?', 'a list item is not a stray question');
    same('What happened?\n\n1. Who was there?', 'a numbered list item');
    same('Who was there?\n\n# And where was it?', 'a heading');
    same('Tell me more.\n\nWho was there?', 'the paragraph before does not end in a question');
    same('', 'empty');
    same('?', 'a lone question mark');
  });

  it('knows an abbreviation is not a sentence break', () => {
    // "Dr. Smith" is one sentence, so the last paragraph is a lone sentence and goes
    assert.equal(dropSecondQuestion('Did it help?\n\nWhat did Dr. Smith say?'), 'Did it help?');
  });

  it('is not applied to non-strings', () => {
    assert.equal(dropSecondQuestion(undefined), undefined);
    assert.equal(dropSecondQuestion(null), null);
  });

  it('cleanReply, shared by wrap-up and the weekly reflection, never does this', () => {
    assert.equal(cleanReply(TWO), TWO);
    assert.equal(cleanReply('Q one?\n\nQ two?'), 'Q one?\n\nQ two?');
  });
});

describe('POST /api/entries/:id/reply drops a second question', () => {
  it('the done event and the saved message carry the cleaned text, and the stream never shows the dropped paragraph', async () => {
    for (const chunkSize of [0, 1, 7, 23]) {
      await withApp({ mock: { replies: [TWO], chunkSize } }, async (h) => {
        const { entry } = await h.entry({ content: 'Work was loud and I could not think.' });
        const stream = await reply(h, entry.id);
        assert.equal(stream.names().at(-1), 'done', `chunkSize ${chunkSize}`);
        const done = stream.of('done')[0];
        assert.equal(done.message.content, ONE);
        const saved = (await messagesOf(h, entry.id))[1];
        assert.deepEqual(saved, done.message, 'the persisted message is the done message');
        assert.equal(done.message.content.match(/\?/g).length, 1, 'exactly one question');
        // deltas vs done: the live text is the saved text, never more
        assert.equal(stream.text().trim(), done.message.content, `chunkSize ${chunkSize}: what was streamed is what was saved`);
        assert.doesNotMatch(stream.text(), /sleep/);
      });
    }
  });

  it('a reply that keeps its last paragraph is streamed whole, held text included', async () => {
    const keep = 'Is that how it felt at the time?\n\nIt sounds like you carried a lot. What would you tell a friend in your place?';
    const closing = 'What did that mean to you?\n\nThanks for sharing it with me.';
    for (const text of [keep, closing, 'No question here, just warmth.\n\nA second paragraph.']) {
      for (const chunkSize of [0, 3, 40]) {
        await withApp({ mock: { replies: [text], chunkSize } }, async (h) => {
          const { entry } = await h.entry({ content: 'A long day.' });
          const stream = await reply(h, entry.id);
          const done = stream.of('done')[0];
          assert.equal(done.message.content, text, `chunkSize ${chunkSize}`);
          assert.equal(stream.text().trim(), text, 'everything that is kept is streamed, in order');
        });
      }
    }
  });

  it('replies that need no help are unchanged: one paragraph, lists, a question in the middle', async () => {
    const texts = [ONE, 'Which of these fits?\n\n- Tired\n- Wired\n\nWhich is closer?', 'Did you rest?\n\nI hope so. Tell me about tomorrow?'];
    for (const text of texts) {
      await withApp({ mock: { replies: [text], chunkSize: 5 } }, async (h) => {
        const { entry } = await h.entry({ content: 'Hello again.' });
        const stream = await reply(h, entry.id);
        assert.equal(stream.of('done')[0].message.content, text);
        assert.equal(stream.text().trim(), text);
      });
    }
  });

  it('a very long reply with a question at the end of every paragraph is streamed whole, in order, and without slowing down', async () => {
    const paragraph = (i) => `This is paragraph number ${i} and it says a few things about the day. Does that ring true for you?`;
    const text = Array.from({ length: 60 }, (_, i) => paragraph(i)).join('\n\n');
    assert.ok(text.length > 5000, 'longer than the window the stream looks through');
    await withApp({ mock: { replies: [text], chunkSize: 3 } }, async (h) => {
      const { entry } = await h.entry({ content: 'Tell me a lot.' });
      const started = Date.now();
      const stream = await reply(h, entry.id);
      assert.ok(Date.now() - started < 8000, 'no quadratic slowdown');
      assert.equal(stream.of('done')[0].message.content, text);
      assert.equal(stream.text().trim(), text);
    });
  });

  it('regenerate cleans the same way', async () => {
    await withApp({ mock: { replies: ['First try.', TWO] } }, async (h) => {
      const { entry } = await h.entry({ content: 'Another long day.' });
      await reply(h, entry.id);
      const again = await reply(h, entry.id, { regenerate: true });
      assert.equal(again.of('done')[0].message.content, ONE);
      assert.equal((await messagesOf(h, entry.id)).filter((m) => m.role === 'assistant').length, 1);
    });
  });

  it('a reply cut off by an error after the second question is saved (stopped) without it', async () => {
    await withApp({ mock: { replies: [TWO], failures: [{ kind: 'error_in_stream', after: TWO.length }], chunkSize: 1 } }, async (h) => {
      const { entry } = await h.entry({ content: 'Go on.' });
      const stream = await reply(h, entry.id);
      assert.equal(stream.names().at(-1), 'error', 'the provider failed after the whole text had been written');
      const saved = (await messagesOf(h, entry.id))[1];
      assert.equal(saved.meta.stopped, true);
      assert.equal(saved.content, ONE, 'saved after the same clean-up as a finished reply');
      assert.equal(stream.text().trim(), ONE, 'and the stream matches what was saved');
    });
  });

  it('a reply stopped while the second question is still being written keeps what the first paragraph said', async () => {
    await withApp({ mock: { replies: [TWO], failures: [{ kind: 'error_in_stream', after: ONE.length + 10 }], chunkSize: 1 } }, async (h) => {
      const { entry } = await h.entry({ content: 'Go on.' });
      const stream = await reply(h, entry.id);
      assert.equal(stream.names().at(-1), 'error');
      const saved = (await messagesOf(h, entry.id))[1];
      assert.equal(saved.meta.stopped, true);
      assert.equal(saved.content, `${ONE}\n\nAnd how`, 'an unfinished paragraph is not a second question yet, so it stays');
      assert.equal(stream.text().trim(), saved.content, 'the held text reached the client before the error');
    });
  });

  it('works for Gemini and the OpenAI-compatible provider too (big frames and small ones)', async () => {
    for (const ai of ['gemini', 'openai']) {
      await withApp({ ai, mock: { replies: [TWO] } }, async (h) => {
        const { entry } = await h.entry({ content: 'Quiet evening.' });
        const stream = await reply(h, entry.id);
        assert.equal(stream.of('done')[0].message.content, ONE, ai);
        assert.equal(stream.text().trim(), ONE, `${ai}: the stream matches`);
      });
    }
  });

  it('wrap-up keeps its own text: two question paragraphs in a closing reflection are not touched', async () => {
    const closing = 'You named a hard day and a small win.\n\nWhat will you carry forward?\n\nWhat can wait until tomorrow?';
    await withApp({ mock: { replies: [closing] } }, async (h) => {
      saveSettings(h.db, { memory: { autoExtract: false } });
      const { entry } = await h.entry({ content: 'Today was hard, but I finished the report.' });
      const stream = await h.sse(`/api/entries/${entry.id}/wrap-up`, {});
      const done = stream.of('done')[0];
      assert.equal(done.message.content, closing);
    });
  });
});
