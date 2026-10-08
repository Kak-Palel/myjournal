// Journey 10: AI not configured (or switched off, or the key is missing). Writing always works and is always saved;
// the page says plainly why there is no reply and where to fix it. Nothing is ever lost.

import { saveSettings } from '../server/helpers.js';
import { assert, describe, eventually, journey, test, ui } from './helpers.js';

describe('no AI configured', () => {
  test('a plain journal: write, save with Ctrl+Enter, add more, reload, find it again', () => journey({
    name: 'no-ai-plain', provider: '',
  }, async (j) => {
    const { page, mock, db } = j;
    await j.goto('/');
    await page.getByRole('link', { name: 'Set up AI' }).first().waitFor();
    await page.getByText('Each one opens with a question to write about.').waitFor();

    await ui.fillToday(page, 'No assistant here, just me and a quiet evening.', { mood: 'Okay' });
    await ui.todayBox(page).press('Control+Enter');
    await page.waitForURL(/#\/entry\//);
    await ui.mine(page).filter({ hasText: 'No assistant here, just me and a quiet evening.' }).waitFor();
    assert.doesNotMatch(page.url(), /reply=1/, 'no reply is requested without an AI');
    await page.getByText('Journal-only mode.').waitFor();
    await page.getByRole('link', { name: 'Set up an AI companion' }).waitFor();
    assert.equal(await ui.button(page, 'Send').count(), 0);
    assert.equal(await ui.button(page, 'Wrap up').count(), 0, 'Wrap up needs an AI');
    assert.equal(await ui.button(page, 'Get a reply').count(), 0);
    assert.equal(await page.getByText('Ctrl Enter to send').count(), 0, 'the send shortcut is not advertised without an AI');

    // Ctrl+Enter in the entry box saves too (there is only one thing it can mean)
    const id = ui.entryId(page);
    await ui.entryBox(page).fill('Second thought, added later.');
    await ui.entryBox(page).press('Control+Enter');
    await ui.mine(page).filter({ hasText: 'Second thought, added later.' }).waitFor();
    assert.equal(await ui.entryBox(page).inputValue(), '', 'the box is emptied once saved');
    await eventually(() => {
      const messages = db.messages.list(id);
      assert.deepEqual(messages.map((m) => [m.role, m.content]), [
        ['user', 'No assistant here, just me and a quiet evening.'],
        ['user', 'Second thought, added later.'],
      ]);
      assert.equal(db.entries.get(id).mood, 3);
    });

    await j.reload();
    await ui.mine(page).filter({ hasText: 'Second thought, added later.' }).waitFor();
    await j.goto('/history');
    await page.getByRole('link', { name: /No assistant here/ }).waitFor();
    assert.equal(mock.chatRequests().length, 0, 'no model was contacted');
  }));

  test('opening an entry for a reply without an AI shows the "not set up yet" banner and a way to fix it', () => journey({
    name: 'no-ai-banner', provider: '',
  }, async (j) => {
    const { page, mock } = j;
    const made = await j.app.entry({ content: 'Written before any AI existed.' });
    await j.goto(`/entry/${made.entry.id}?reply=1`);
    const banner = page.getByRole('status').filter({ hasText: "Saved. Your AI companion isn't set up yet." });
    await banner.waitFor();
    await banner.getByText(/Your writing is safe/).waitFor();
    await ui.mine(page).filter({ hasText: 'Written before any AI existed.' }).waitFor();
    assert.doesNotMatch(page.url(), /reply=1/);

    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await banner.waitFor({ state: 'hidden' });

    // (a fresh page load: within one page the same unanswered message is only ever auto-requested once)
    await j.load(`/entry/${made.entry.id}?reply=1`);
    await banner.waitFor();
    await banner.getByRole('link', { name: 'Set up AI' }).click();
    await ui.heading(page, 'Settings', 1).waitFor();
    assert.equal(mock.chatRequests().length, 0);
  }));

  test('the AI gets switched off in another tab: Send keeps the text, says so, and offers Settings', () => journey({
    name: 'no-ai-switched-off-elsewhere',
  }, async (j) => {
    const { page, db, diag } = j;
    diag.expectStatus(409, /\/reply$/); // the server's honest answer to "reply" while the companion is off
    const made = await j.app.entry({ content: 'First message, before anything changes.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.mine(page).first().waitFor();
    await ui.button(page, 'Send').waitFor();

    saveSettings(db, { ai: { enabled: false } }); // "another tab" turns the companion off
    await ui.entryBox(page).fill('A message the page still thinks it can send.');
    await ui.button(page, 'Send').click();

    const banner = page.getByRole('status').filter({ hasText: 'Saved. The AI companion is switched off.' });
    await banner.waitFor();
    await ui.mine(page).filter({ hasText: 'A message the page still thinks it can send.' }).waitFor();
    assert.equal(await ui.entryBox(page).inputValue(), '', 'it was saved, so the box is empty');
    assert.equal(db.messages.list(made.entry.id).filter((m) => m.role === 'user').length, 2, 'both messages are stored');
    await banner.getByRole('link', { name: 'Open settings' }).click();
    await page.waitForURL(/#\/settings\?tab=general/);
  }));

  test('no provider chosen any more: the same, with "Set up AI"', () => journey({ name: 'no-ai-unset-elsewhere' }, async (j) => {
    const { page, db, diag } = j;
    diag.expectStatus(409, /\/reply$/);
    const made = await j.app.entry({ content: 'Something to reply to.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').waitFor();
    saveSettings(db, { ai: { provider: '' } });
    await ui.button(page, 'Get a reply').click();
    const banner = page.getByRole('status').filter({ hasText: "Saved. Your AI companion isn't set up yet." });
    await banner.waitFor();
    await banner.getByRole('link', { name: 'Set up AI' }).waitFor();
    assert.equal(db.messages.list(made.entry.id).length, 1, 'nothing was lost or duplicated');
  }));

  test('Gemini chosen but no key yet: the app says it is not finished and journaling carries on', () => journey({
    name: 'no-ai-gemini-no-key', provider: 'gemini', mocks: { local: true, gemini: true }, configureMocks: false,
  }, async (j) => {
    const { page, mocks } = j;
    await j.goto('/');
    const pill = page.getByRole('link', { name: /^Gemini/ });
    await pill.waitFor();
    assert.equal(await pill.getAttribute('title'), 'Finish setting up this provider');
    await ui.startJournaling(page, 'Chose Gemini but have not pasted a key yet.');
    await ui.mine(page).first().waitFor();
    await page.getByText('Journal-only mode.').waitFor();
    assert.equal(await ui.button(page, 'Send').count(), 0);

    await j.goto('/settings');
    await page.getByText('Needs a key').first().waitFor();
    assert.equal(mocks.gemini.requests.length, 0);
  }));
});
