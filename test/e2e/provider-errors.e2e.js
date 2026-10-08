// Journey 11: the model fails. Whatever goes wrong - the connection drops mid-reply, the key is refused, the model is
// missing, the server errors - the person's words stay saved, the page says what happened with a hint and a way forward,
// and "Try again" works. Also: slow first words, a failing wrap-up step, a failing weekly reflection, the safety card.

import { assert, describe, eventually, journey, test, ui } from './helpers.js';

const GOOD_REPLY = 'Thank you for telling me. What would help most right now?';

/** Banner above the composer (it carries an alert or status role depending on tone). */
const banner = (page, text) => page.getByRole('alert').or(page.getByRole('status')).filter({ hasText: text });

/** Create an entry holding one unanswered message and open it. */
async function openUnanswered(j, content = 'A day that needs an answer.') {
  const made = await j.app.entry({ content });
  await j.goto(`/entry/${made.entry.id}`);
  await ui.mine(j.page).filter({ hasText: content }).waitFor();
  return made.entry.id;
}

describe('provider errors while replying', () => {
  test('the stream drops half way: the partial text is kept, a hint appears, Try again gives a full reply', () => journey({
    name: 'errors-stream-drop',
    mocks: { local: { replies: [GOOD_REPLY, GOOD_REPLY], failures: [{ kind: 'reset', after: 3 }] } },
  }, async (j) => {
    const { page, db, mock } = j;
    const id = await openUnanswered(j);
    await ui.button(page, 'Get a reply').click();

    const problem = banner(page, 'Try again');
    await problem.waitFor({ timeout: 15_000 });
    const text = await problem.innerText();
    assert.match(text, /Try again/);
    assert.ok(text.split('\n').filter((l) => l.trim()).length >= 3, `message and hint are both shown: ${JSON.stringify(text)}`);
    await problem.getByRole('link', { name: 'Open settings' }).waitFor();
    assert.match(await problem.getByRole('link', { name: 'Open settings' }).getAttribute('href'), /#\/settings\?tab=local/);

    // what the model managed to say stays on the page and in the database, marked as stopped
    await ui.companion(page).filter({ hasText: 'Stopped' }).waitFor();
    await eventually(() => {
      const last = db.messages.last(id);
      assert.equal(last.role, 'assistant');
      assert.equal(last.meta.stopped, true);
      assert.ok(last.content.length > 0 && GOOD_REPLY.startsWith(last.content.slice(0, 5)));
    }, { message: 'the partial reply to be saved' });
    assert.equal(db.messages.list(id).filter((m) => m.role === 'user').length, 1, 'the person\'s message was saved once');

    // Try again: the failed partial is replaced by a complete reply, nothing is duplicated
    await problem.getByRole('button', { name: 'Try again' }).click();
    await ui.companion(page).filter({ hasText: GOOD_REPLY }).waitFor();
    await problem.waitFor({ state: 'hidden' });
    assert.equal(await ui.companion(page).filter({ hasText: 'Stopped' }).count(), 0);
    await eventually(() => {
      const messages = db.messages.list(id);
      assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
      assert.equal(messages[1].content, GOOD_REPLY);
      assert.ok(!messages[1].meta.stopped);
    });
    assert.equal(mock.chatRequests().length, 2);
  }));

  test('a refused key: the message, the hint, a link to Settings, Dismiss, and asking again', () => journey({
    name: 'errors-401', mocks: { local: { replies: [GOOD_REPLY], failures: ['unauthorized'] } },
  }, async (j) => {
    const { page, db, mock } = j;
    const id = await openUnanswered(j, 'Does anyone hear me?');
    await ui.button(page, 'Get a reply').click();
    const problem = banner(page, 'The local server wants an API key.');
    await problem.waitFor();
    await problem.getByText('Add the API key in Settings.').waitFor();
    await problem.getByRole('link', { name: 'Open settings' }).waitFor();
    assert.equal(db.messages.list(id).length, 1, 'only the person\'s message exists');

    // Dismiss hides it; asking again works once the server is happy
    await problem.getByRole('button', { name: 'Dismiss' }).click();
    await problem.waitFor({ state: 'hidden' });
    await ui.button(page, 'Get a reply').click();
    await ui.companion(page).filter({ hasText: GOOD_REPLY }).waitFor();
    assert.equal(mock.chatRequests().length, 2);
  }));

  test('a model that does not exist: the hint names the fix', () => journey({
    name: 'errors-404-model', mocks: { local: { failures: ['model_not_found'] } },
  }, async (j) => {
    const { page } = j;
    await openUnanswered(j, 'Testing a missing model.');
    await ui.button(page, 'Get a reply').click();
    const problem = banner(page, 'was not found');
    await problem.waitFor();
    await problem.getByText(/ollama pull|Download|Load models|pull/i).first().waitFor();
    await problem.getByRole('link', { name: 'Open settings' }).waitFor();
    await problem.getByRole('button', { name: 'Try again' }).waitFor();
  }));

  test('the server errors (500): clear wording, nothing lost, retry works', () => journey({
    name: 'errors-500', mocks: { local: { replies: [GOOD_REPLY], failures: ['server_error'] } },
  }, async (j) => {
    const { page, db } = j;
    const id = await openUnanswered(j, 'Something heavy today.');
    await ui.entryBox(page).fill('And a follow-up I typed while it was failing.');
    await ui.button(page, 'Send').click();
    const problem = banner(page, 'Try again');
    await problem.waitFor();
    assert.equal(db.messages.list(id).filter((m) => m.role === 'user').length, 2, 'both messages are saved');
    assert.equal(await ui.entryBox(page).inputValue(), '', 'the box is empty because the text is safe');
    await problem.getByRole('button', { name: 'Try again' }).click();
    await ui.companion(page).filter({ hasText: GOOD_REPLY }).waitFor();
  }));

  test('a rate limit with a short wait is retried automatically and the person never sees it', () => journey({
    name: 'errors-429-auto', mocks: { local: { replies: [GOOD_REPLY], failures: [{ kind: 'rate_limit', retryAfter: 1 }] } },
  }, async (j) => {
    const { page, mock } = j;
    await openUnanswered(j, 'Rate limits are not my problem.');
    await ui.button(page, 'Get a reply').click();
    await ui.companion(page).filter({ hasText: GOOD_REPLY }).waitFor({ timeout: 15_000 });
    assert.equal(mock.chatRequests().length, 2, 'one automatic retry');
    assert.equal(await page.getByRole('alert').count(), 0);
  }));

  test('a model that answers with nothing: a hint, not a blank bubble', () => journey({
    name: 'errors-empty', mocks: { local: { failures: ['empty'] } },
  }, async (j) => {
    const { page, db } = j;
    const id = await openUnanswered(j, 'Say something please.');
    await ui.button(page, 'Get a reply').click();
    const problem = banner(page, 'The model returned an empty reply.');
    await problem.waitFor();
    await problem.getByText(/very small models sometimes return nothing/).waitFor();
    assert.equal(db.messages.list(id).length, 1, 'no empty assistant message was stored');
    assert.equal(await ui.companion(page).count(), 0);
  }));

  test('a slow first word shows "Still thinking" and then the reply', () => journey({
    name: 'errors-slow', mocks: { local: { replies: [GOOD_REPLY], ttfbMs: 9500 } },
  }, async (j) => {
    const { page } = j;
    await openUnanswered(j, 'Take your time.');
    await ui.button(page, 'Get a reply').click();
    await page.getByText(/Still thinking/).waitFor({ timeout: 12_000 });
    await ui.button(page, 'Stop').waitFor();
    await ui.companion(page).filter({ hasText: GOOD_REPLY }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText(/Still thinking/).count(), 0);
  }));

  test('a model that never answers hits the first-word timeout with a helpful hint', () => journey({
    name: 'errors-timeout', settings: { ai: { timeoutSec: 5 } }, mocks: { local: { failures: ['hang'] } },
  }, async (j) => {
    const { page } = j;
    await openUnanswered(j, 'Anybody there?');
    await ui.button(page, 'Get a reply').click();
    const problem = banner(page, 'Try again');
    await problem.waitFor({ timeout: 20_000 });
    await problem.getByText(/time|wait|load|slow|longer/i).first().waitFor();
    assert.ok(await ui.button(page, 'Get a reply').isVisible(), 'the page is usable again');
  }));
});

describe('provider errors elsewhere', () => {
  test('wrap-up: a failure is explained and Try again completes it; a failing title step still saves', () => journey({
    name: 'errors-wrapup', mocks: { local: { failures: ['server_error'] } },
  }, async (j) => {
    const { page, db, mock } = j;
    const id = await openUnanswered(j, 'I love tea in the morning. I work as a baker.');
    await ui.button(page, 'Wrap up').click();
    const problem = banner(page, 'Try again');
    await problem.waitFor();
    assert.equal(db.entries.get(id).status, 'open', 'the entry is not marked wrapped when the reflection failed');
    await problem.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('region', { name: 'Entry summary' }).waitFor({ timeout: 20_000 });
    assert.equal(db.entries.get(id).status, 'wrapped');

    // second entry: the reflection works, the title/summary call fails -> a note, but the wrap-up is saved
    mock.setBehavior({ failures: [null, 'server_error'], replies: [] });
    const second = await openUnanswered(j, 'Another quiet evening with a book.');
    await ui.button(page, 'Wrap up').click();
    await page.getByText(/Saved without an automatic title or summary/).waitFor({ timeout: 20_000 });
    await eventually(() => {
      const entry = db.entries.get(second);
      assert.equal(entry.status, 'wrapped');
      assert.ok(db.messages.list(second).some((m) => m.meta && m.meta.kind === 'wrapup'));
    });
    assert.notEqual(await page.getByRole('textbox', { name: 'Entry title' }).inputValue(), undefined);
  }));

  test('weekly reflection: a stream that breaks shows what arrived, explains, and Try again works', () => journey({
    name: 'errors-weekly', seed: 'demo', mocks: { local: { failures: [{ kind: 'error_in_stream', after: 2 }] } },
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/insights');
    await ui.button(page, 'Write my reflection').click();
    const problem = page.getByRole('alert').filter({ hasText: 'Try again' });
    await problem.waitFor({ timeout: 15_000 });
    await problem.getByText(/What was written before it stopped is shown below\. It was not saved\./).waitFor();
    assert.equal(db.reports.list().length, 1, 'the half-written reflection was not saved');
    await problem.getByRole('button', { name: 'Try again' }).click();
    await page.getByText('Your reflection is ready').waitFor({ timeout: 20_000 });
    assert.equal(db.reports.list().length, 2);
  }));
});

describe('safety card', () => {
  test('crisis wording gets a gentle, static note with help lines, next to the normal reply', () => journey({
    name: 'safety-card', mocks: { local: { replies: [GOOD_REPLY] } },
  }, async (j) => {
    const { page, db } = j;
    const id = await openUnanswered(j, 'I do not want to be here anymore. I want to end my life.');
    await ui.button(page, 'Get a reply').click();
    const note = page.getByRole('note');
    await note.waitFor();
    await note.getByText(/988/).waitFor();
    await note.getByText(/findahelpline\.com/).waitFor();
    await note.getByText('A gentle note', { exact: true }).waitFor();
    await ui.companion(page).filter({ hasText: GOOD_REPLY }).waitFor();
    await eventually(() => assert.ok(db.messages.list(id).some((m) => m.meta && m.meta.kind === 'safety')));
    // the card is not something to regenerate or copy
    assert.equal(await note.getByRole('button', { name: 'Regenerate this reply' }).count(), 0);
    assert.equal(await note.getByRole('button', { name: 'Copy this reply' }).count(), 0);
  }));
});
