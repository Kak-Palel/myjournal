// Journey 2: the core loop. Write on Today with a mood -> Start journaling -> the reply streams in -> a second message ->
// Stop in the middle of the stream (the partial stays) -> Regenerate -> Wrap up (summary + a new memory).

import { describe, journey, test, ui, assert, eventually, sleep } from './helpers.js';

const FIRST_TEXT = 'Woke up early and went for a long walk by the river. I love long walks like this. I work as a product designer, and today I feel proud and calm.';
const FIRST_REPLY = 'That sounds like a lovely start to the day. What did you notice on the walk that you want to keep?';
const LONG_REPLY = 'It makes sense that the quiet stayed with you. '.repeat(8).trim();
const REGENERATED = 'Here is a fresh angle on it. What would make tomorrow feel like this too?';

describe('write, stream, stop, regenerate, wrap up', () => {
  test('the whole conversation loop works in a real browser', () => journey({
    name: 'write-and-reply',
    mocks: { local: { delayMs: 35, replies: [FIRST_REPLY] } },
  }, async (j) => {
    const { page, mock, db } = j;

    // --- Today: write with a mood, start journaling
    await j.goto('/');
    await ui.fillToday(page, FIRST_TEXT, { mood: 'Good' });
    assert.equal(await ui.mood(page, 'Good').getAttribute('aria-checked'), 'true');
    await page.getByRole('button', { name: 'Start journaling' }).click();
    await page.waitForURL(/#\/entry\//);

    // --- the reply streams: a live bubble grows in several steps, then becomes the saved message
    const live = page.getByRole('article', { name: 'Reply in progress' });
    await live.waitFor();
    assert.ok(await ui.button(page, 'Stop').isVisible(), 'Stop is offered while the reply streams');
    const lengths = new Set();
    for (let i = 0; i < 60 && (await live.count()) > 0; i += 1) {
      const text = await live.innerText().catch(() => '');
      lengths.add(text.trim().length);
      await sleep(40);
    }
    assert.ok(lengths.size >= 3, `the reply grew in several steps, saw lengths: ${[...lengths].join(', ')}`);
    await ui.companion(page).filter({ hasText: FIRST_REPLY }).waitFor();
    await ui.mine(page).filter({ hasText: FIRST_TEXT }).waitFor();
    await ui.button(page, 'Send').waitFor();
    assert.equal(await ui.button(page, 'Stop').isVisible(), false, 'Stop is gone again');
    assert.equal(await ui.mood(page, 'Good').getAttribute('aria-checked'), 'true', 'the mood chosen on Today is on the entry');
    const entryId = ui.entryId(page);
    assert.ok(entryId);
    assert.equal(db.entries.get(entryId).mood, 4);
    // ?reply=1 is removed from the address once it has been used (a reload must not ask for another reply)
    assert.doesNotMatch(page.url(), /reply=1/);

    // --- the model saw the person's words in the prompt
    const firstRequest = mock.chatRequests().at(-1).body;
    assert.equal(firstRequest.messages[0].role, 'system');
    assert.match(firstRequest.messages[0].content, /^TASK: reply/);
    assert.equal(firstRequest.messages.at(-1).role, 'user');
    assert.equal(firstRequest.messages.at(-1).content, FIRST_TEXT);

    // --- second message, stopped half way
    mock.setBehavior({ delayMs: 150, replies: [LONG_REPLY] });
    await ui.entryBox(page).fill('It was the quiet, mostly. Nobody needed anything from me.');
    await ui.button(page, 'Send').click();
    await ui.mine(page).filter({ hasText: 'Nobody needed anything from me.' }).waitFor();
    const live2 = page.getByRole('article', { name: 'Reply in progress' });
    await live2.waitFor();
    await eventually(async () => assert.ok((await live2.innerText()).trim().length >= 12), { message: 'some streamed text to be visible' });
    await ui.button(page, 'Stop').click();

    // the partial text stays, marked as stopped, and the composer is usable again
    const partial = ui.companion(page).filter({ hasText: 'Stopped' });
    await partial.waitFor({ timeout: 15_000 });
    const partialText = (await partial.innerText()).split('\n').map((l) => l.trim()).filter(Boolean)[1];
    assert.ok(partialText && partialText.length >= 6, `the partial reply stays visible (got ${JSON.stringify(partialText)})`);
    assert.ok(LONG_REPLY.startsWith(partialText) && partialText.length < LONG_REPLY.length, `it is the first part of the reply: ${partialText}`);
    await ui.button(page, 'Send').waitFor();
    await eventually(() => {
      const last = db.messages.last(entryId);
      assert.equal(last.role, 'assistant');
      assert.equal(last.meta.stopped, true, 'the server persisted the partial reply as stopped');
      assert.ok(LONG_REPLY.startsWith(last.content.slice(0, 20)));
    }, { message: 'the stopped partial reply to be saved' });
    await mock.waitForIdle();
    assert.equal(mock.chatRequests().at(-1).aborted, true, 'the model request was aborted when Stop was pressed');

    // --- regenerate replaces the stopped reply
    mock.setBehavior({ delayMs: 0, replies: [REGENERATED] });
    await page.getByRole('button', { name: 'Regenerate this reply' }).click();
    await ui.companion(page).filter({ hasText: REGENERATED }).waitFor();
    assert.equal(await ui.companion(page).filter({ hasText: 'Stopped' }).count(), 0, 'the stopped partial is gone');
    await eventually(() => {
      const assistant = db.messages.list(entryId).filter((m) => m.role === 'assistant');
      assert.deepEqual(assistant.map((m) => m.content), [FIRST_REPLY, REGENERATED]);
    }, { message: 'the regenerated reply to replace the stopped one' });

    // --- wrap up: reflection streams, then title, summary, feelings and a new memory appear
    mock.setBehavior({ delayMs: 0, replies: [] });
    await ui.button(page, 'Wrap up').click();
    const summary = page.getByRole('region', { name: 'Entry summary' });
    await summary.waitFor({ timeout: 20_000 });
    await ui.companion(page).filter({ hasText: 'Reflection' }).waitFor();
    await summary.getByText('Added to your memory').waitFor();
    await summary.getByText('Loves long walks like this').waitFor();
    await summary.getByRole('link', { name: 'See or edit memories' }).waitFor();
    await ui.button(page, 'Wrap up again').waitFor();
    assert.notEqual(await page.getByRole('textbox', { name: 'Entry title' }).inputValue(), '', 'the entry got a title');
    await eventually(() => {
      const entry = db.entries.get(entryId);
      assert.equal(entry.status, 'wrapped');
      assert.ok(entry.summary.length > 10);
      assert.ok(db.memories.list().some((m) => m.text === 'Loves long walks like this' && m.sourceEntryId === entryId));
    }, { message: 'the wrap-up to be stored' });

    // --- and the memory shows up on the Memory page with a link back to this entry
    await page.getByRole('link', { name: 'Memory', exact: true }).first().click();
    await page.getByText('Loves long walks like this').waitFor();
    await page.getByRole('link', { name: 'From an entry' }).first().click();
    await page.waitForURL(new RegExp(`#/entry/${entryId}`));
    await summary.waitFor();
  }));
});
