// Writing itself: drafts that survive reloads and navigation, the 20,000 character limit, long messages, copying and
// deleting messages, the header (date, mood, private, pin), dictation without a microphone, and Today's extras
// (prompt of the day, the weekly nudge, the streak).

import {
  assert, describe, eventually, journey, seedSampleJournal, test, ui,
} from './helpers.js';

const draftKeys = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mj-draft:')));
const draftOf = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

describe('drafts', () => {
  test('what you typed on Today comes back after a reload and is gone once the entry exists', () => journey({
    name: 'drafts-today',
  }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await ui.todayBox(page).fill('Half a thought that I have not sent yet.');
    await eventually(async () => assert.deepEqual(await draftKeys(page), ['mj-draft:new']), { message: 'the draft to be saved' });
    await j.reload();
    await eventually(async () => assert.equal(await ui.todayBox(page).inputValue(), 'Half a thought that I have not sent yet.'));
    await page.getByRole('button', { name: 'Start journaling' }).click();
    await page.waitForURL(/#\/entry\//);
    await ui.mine(page).first().waitFor();
    assert.deepEqual(await draftKeys(page), [], 'no draft is left behind once it became an entry');
    await j.goto('/');
    assert.equal(await ui.todayBox(page).inputValue(), '');
  }));

  test('in an entry: restored with a notice, kept when leaving fast, removed when sent', () => journey({
    name: 'drafts-entry',
  }, async (j) => {
    const { page, db } = j;
    const made = await j.app.entry({ content: 'First line.' });
    const id = made.entry.id;
    await j.goto(`/entry/${id}`);
    await ui.mine(page).first().waitFor();

    await ui.entryBox(page).fill('A draft I will not send yet.');
    await eventually(async () => assert.equal(await draftOf(page, `mj-draft:${id}`), 'A draft I will not send yet.'));
    await j.reload();
    await eventually(async () => assert.equal(await ui.entryBox(page).inputValue(), 'A draft I will not send yet.'));
    await page.getByText('Restored your unsent draft.').waitFor();

    // typing and leaving at once (before the autosave timer fires) still keeps it
    await ui.entryBox(page).fill('Typed and left within a heartbeat.');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'History' }).click();
    await ui.heading(page, 'History', 1).waitFor();
    assert.equal(await draftOf(page, `mj-draft:${id}`), 'Typed and left within a heartbeat.');
    await j.goto(`/entry/${id}`);
    await eventually(async () => assert.equal(await ui.entryBox(page).inputValue(), 'Typed and left within a heartbeat.'));

    // Save without reply stores it and clears the draft
    await ui.button(page, 'Save without reply').click();
    await ui.mine(page).filter({ hasText: 'Typed and left within a heartbeat.' }).waitFor();
    assert.equal(await draftOf(page, `mj-draft:${id}`), null);
    assert.equal(await ui.entryBox(page).inputValue(), '');
    assert.equal(db.messages.list(id).length, 2);

    // deleting the entry removes its draft too
    await ui.entryBox(page).fill('Another draft, then the entry is deleted.');
    await eventually(async () => assert.equal(await draftOf(page, `mj-draft:${id}`), 'Another draft, then the entry is deleted.'));
    await page.getByRole('button', { name: 'Entry options' }).click();
    await page.getByRole('menuitem', { name: /Delete entry/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete entry' }).click();
    await page.waitForURL(/#\/history/);
    assert.equal(await draftOf(page, `mj-draft:${id}`), null);
  }));

  test('Enter makes a new line (it never sends); Shift+Enter too', () => journey({ name: 'drafts-enter' }, async (j) => {
    const { page, db } = j;
    const made = await j.app.entry({ content: 'Opening.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.entryBox(page).click();
    await page.keyboard.type('line one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('line two');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line three');
    assert.equal(await ui.entryBox(page).inputValue(), 'line one\nline two\nline three');
    assert.equal(db.messages.list(made.entry.id).length, 1, 'nothing was sent');
    await ui.button(page, 'Save without reply').click();
    await ui.mine(page).filter({ hasText: 'line three' }).waitFor();
    assert.equal(db.messages.list(made.entry.id)[1].content, 'line one\nline two\nline three');
    // paragraphs are kept as separate blocks
    assert.equal(await ui.mine(page).last().locator('p').count() >= 1, true);
  }));
});

describe('limits', () => {
  test('the counter appears near 20,000 characters; over the limit Send and Save are off and the text stays', () => journey({
    name: 'limits-entry',
  }, async (j) => {
    const { page, db } = j;
    const made = await j.app.entry({ content: 'Opening.' });
    await j.goto(`/entry/${made.entry.id}`);
    const box = ui.entryBox(page);
    await box.waitFor();
    assert.equal(await page.getByText(/\/ 20,000/).isVisible(), false, 'no counter for short texts');

    await box.fill('x'.repeat(16_500));
    await page.getByText('16,500 / 20,000').waitFor();
    assert.equal(await ui.button(page, 'Send').isDisabled(), false);

    await box.fill('y'.repeat(20_001));
    await page.getByText('20,001 / 20,000').waitFor();
    assert.equal(await box.getAttribute('aria-invalid'), 'true');
    assert.equal(await ui.button(page, 'Send').isDisabled(), true);
    assert.equal(await ui.button(page, 'Save without reply').isDisabled(), true);
    await box.press('Control+Enter');
    await page.getByText(/too much text for one message/).waitFor();
    assert.equal(db.messages.list(made.entry.id).length, 1, 'nothing was sent');
    assert.equal((await box.inputValue()).length, 20_001, 'and nothing was cut off');

    // a long but allowed message is saved whole and shown folded with a way to read it all
    await box.fill(`${'A paragraph of ordinary words. '.repeat(600)}THE END`);
    await ui.button(page, 'Save without reply').click();
    const bubble = ui.mine(page).last();
    await bubble.waitFor();
    const more = bubble.getByRole('button', { name: 'Show more' });
    await more.waitFor();
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    await more.click();
    await bubble.getByRole('button', { name: 'Show less' }).waitFor();
    assert.match(await bubble.innerText(), /THE END/);
    assert.ok(db.messages.list(made.entry.id)[1].content.endsWith('THE END'));
  }));

  test('on Today a text that is too long is refused politely and kept', () => journey({ name: 'limits-today' }, async (j) => {
    const { page, db } = j;
    await j.goto('/');
    await ui.todayBox(page).fill('z'.repeat(20_050));
    await page.getByRole('button', { name: 'Start journaling' }).click();
    await page.getByText(/That is longer than 20,000 characters/).waitFor();
    assert.equal(db.stats().entries, 0);
    assert.equal((await ui.todayBox(page).inputValue()).length, 20_050);
    // an empty box explains instead of doing nothing
    await ui.todayBox(page).fill('   ');
    await page.getByRole('button', { name: 'Start journaling' }).click();
    await page.getByText(/Write a few words to begin/).waitFor();
  }));
});

describe('messages and the entry header', () => {
  test('copy a reply, delete a message with confirmation, regenerate only on the last reply', () => journey({
    name: 'messages-actions', mocks: { local: { replies: ['A reply worth copying.', 'A second reply.'] } },
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/');
    await ui.startJournaling(page, 'First message.');
    await ui.companion(page).filter({ hasText: 'A reply worth copying.' }).waitFor();
    const id = ui.entryId(page);
    await ui.entryBox(page).fill('Second message.');
    await ui.button(page, 'Send').click();
    await ui.companion(page).filter({ hasText: 'A second reply.' }).waitFor();

    // Regenerate only exists on the very last reply
    assert.equal(await page.getByRole('button', { name: 'Regenerate this reply' }).count(), 1);
    assert.equal(await ui.companion(page).first().getByRole('button', { name: 'Regenerate this reply' }).count(), 0);

    // copy puts the text on the clipboard and says so
    await ui.companion(page).first().getByRole('button', { name: 'Copy this reply' }).click();
    await page.getByText('Copied', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'A reply worth copying.');

    // deleting your own message asks first; Cancel keeps it
    const mine = ui.mine(page).first();
    await mine.getByRole('button', { name: 'Delete this message' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this message?' });
    await dialog.waitFor();
    await dialog.getByText('Replies from your companion stay.').waitFor();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(db.messages.list(id).filter((m) => m.role === 'user').length, 2);
    await mine.getByRole('button', { name: 'Delete this message' }).click();
    await dialog.getByRole('button', { name: 'Delete message' }).click();
    await eventually(() => assert.deepEqual(db.messages.list(id).filter((m) => m.role === 'user').map((m) => m.content), ['Second message.']));
    await page.getByText('First message.').waitFor({ state: 'detached' });
    assert.equal(await ui.companion(page).count(), 2, 'the replies stayed');
  }));

  test('date, mood, private and pin from the header are saved and show up in History and Today', () => journey({
    name: 'header-controls',
  }, async (j) => {
    const { page, db } = j;
    const made = await j.app.entry({ content: 'Header controls.', title: 'Controls', mood: 3 });
    const id = made.entry.id;
    await j.goto(`/entry/${id}`);
    await ui.mine(page).first().waitFor();

    // mood: pick another, then click it again to clear it
    await ui.mood(page, 'Great').click();
    await eventually(() => assert.equal(db.entries.get(id).mood, 5));
    await ui.mood(page, 'Great').click();
    await eventually(() => assert.equal(db.entries.get(id).mood, null));
    assert.equal(await ui.mood(page, 'Great').getAttribute('aria-checked'), 'false');

    // date: moving it to another month regroups it in History
    const date = page.getByLabel('Entry date');
    await date.fill('2025-03-04');
    await date.press('Enter');
    await eventually(() => assert.equal(db.entries.get(id).date, '2025-03-04'));
    await j.reload();
    assert.equal(await page.getByLabel('Entry date').inputValue(), '2025-03-04');
    await j.goto('/history');
    await page.getByRole('heading', { name: 'March 2025', level: 2 }).waitFor();
    await j.goto(`/entry/${id}`);

    // private and pinned show flags on the entry, in History, and Pinned appears on Today
    await page.getByRole('button', { name: 'Entry options' }).click();
    await page.getByRole('menuitemcheckbox', { name: /Private entry/ }).click();
    await page.getByRole('button', { name: 'Entry options' }).click();
    await page.getByRole('menuitem', { name: 'Pin entry' }).click();
    await eventually(() => {
      const e = db.entries.get(id);
      assert.equal(e.private, true);
      assert.equal(e.pinned, true);
    });
    await page.getByText('Private', { exact: true }).first().waitFor();
    await page.getByText('Pinned', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Entry options' }).click();
    assert.equal(await page.getByRole('menuitemcheckbox', { name: /Private entry/ }).getAttribute('aria-checked'), 'true');
    assert.ok(await page.getByRole('menuitem', { name: 'Unpin entry' }).isVisible());
    await page.keyboard.press('Escape');
    await j.goto('/');
    await ui.heading(page, 'Pinned', 2).waitFor();
    await page.getByRole('link', { name: 'Controls' }).first().waitFor();
    await j.goto('/history?pinned=1');
    await page.getByRole('link', { name: 'Controls' }).waitFor();
    // a private entry is not offered to the model as "related" and not used for weekly reflections (checked server side),
    // but it is of course still yours to read
    await page.getByText('Private', { exact: false }).first().waitFor();
  }));

  test('dictation without a microphone says what to do instead of failing silently', () => journey({ name: 'dictation-blocked' }, async (j) => {
    const { page } = j;
    await j.goto('/');
    const dictate = page.getByRole('button', { name: 'Dictate' });
    if ((await dictate.count()) === 0) return; // a browser without speech recognition simply has no button
    await dictate.click();
    await page.getByText(/Microphone access is blocked/).waitFor();
    await ui.todayBox(page).fill('Typing still works.');
    assert.equal(await ui.todayBox(page).inputValue(), 'Typing still works.');
  }));
});

describe('Today extras', () => {
  test('the prompt of the day becomes the entry title; it can be dropped before writing', () => journey({
    name: 'today-prompt',
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/');
    await ui.heading(page, 'Prompt of the day', 2).waitFor();
    const text = (await page.getByRole('blockquote').or(page.locator('blockquote')).first().innerText()).trim();
    assert.ok(text.length > 10);
    await page.getByRole('button', { name: 'Write about this' }).click();
    await page.getByRole('button', { name: 'Remove the prompt' }).waitFor();
    await page.getByText(text, { exact: false }).first().waitFor();
    await page.getByRole('button', { name: 'Remove the prompt' }).click();
    await page.getByRole('button', { name: 'Remove the prompt' }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Write about this' }).click();

    await ui.todayBox(page).fill('My answer to the question of the day.');
    await page.getByRole('button', { name: 'Start journaling' }).click();
    await page.waitForURL(/#\/entry\//);
    await ui.mine(page).filter({ hasText: 'My answer to the question of the day.' }).waitFor();
    const entry = db.entries.get(ui.entryId(page));
    assert.equal(entry.title, text, 'the question became the title');
    assert.equal(entry.kind, 'guided');
    assert.equal(db.messages.list(entry.id)[0].content, 'My answer to the question of the day.', 'the person\'s words are stored untouched');
  }));

  test('streak, recent entries, the weekly nudge (dismissed for the day) and its link to Insights', () => journey({
    name: 'today-extras', seed: (db) => seedSampleJournal(db),
  }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await page.getByText(/\d+ day streak/).waitFor();
    await ui.heading(page, 'Recent entries', 2).waitFor();
    await ui.heading(page, 'Pinned', 2).waitFor();
    const nudge = page.getByRole('region', { name: 'Weekly reflection' });
    await nudge.waitFor();
    await nudge.getByText(/You have written \d+ times this week\./).waitFor();

    await nudge.getByRole('button', { name: 'Not now' }).click();
    await nudge.waitFor({ state: 'detached' });
    await j.reload();
    await ui.heading(page, 'Recent entries', 2).waitFor();
    await page.waitForTimeout(600);
    assert.equal(await page.getByRole('region', { name: 'Weekly reflection' }).count(), 0, 'dismissed for today, also after a reload');

    // another day: the nudge is back and leads to Insights
    await page.evaluate(() => localStorage.removeItem('mj-nudge-dismissed'));
    await j.reload();
    await page.getByRole('link', { name: 'See your weekly reflection' }).click();
    await ui.heading(page, 'Insights', 1).waitFor();

    // "View all" and a recent entry
    await j.goto('/');
    await page.getByRole('link', { name: /View all/ }).click();
    await ui.heading(page, 'History', 1).waitFor();
  }));

  test('a fresh journal welcomes instead of showing empty boxes', () => journey({ name: 'today-empty' }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await page.getByText('Your journal starts here').waitFor();
    assert.equal(await page.getByRole('region', { name: 'Weekly reflection' }).count(), 0);
    assert.equal(await page.getByText(/day streak/).count(), 0);
    await ui.heading(page, 'Guided journals', 2).waitFor();
  }));
});
