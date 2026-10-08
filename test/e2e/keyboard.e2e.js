// Journey 12a: keyboard only. Everything the app offers can be reached and used without a mouse: tab order, Ctrl+Enter,
// Escape, arrow keys in menus, focus returned to where it came from, and a visible focus indicator at every stop.

import { assert, describe, eventually, focusAudit, journey, seedSampleJournal, test, ui } from './helpers.js';

/** Accessible-ish name of the focused element. */
const focusedName = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'BODY';
  return (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 60);
});
const focusedTag = (page) => page.evaluate(() => (document.activeElement ? document.activeElement.tagName : 'NONE'));

/** Tab until the focused element's name matches (fails after `max` presses). */
async function tabTo(page, pattern, max = 25) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    if (pattern.test(await focusedName(page))) return;
  }
  assert.fail(`Tab never reached ${pattern} (stopped on "${await focusedName(page)}")`);
}

describe('keyboard only', () => {
  test('Today -> entry -> menu -> edit -> delete, without touching the mouse', () => journey({
    name: 'keyboard-flow', mocks: { local: { delayMs: 5 } },
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/');
    await ui.todayBox(page).waitFor();

    // after a page load the content region has focus (so a screen reader starts there); the next Tab enters the composer
    await eventually(async () => assert.equal(await focusedTag(page), 'MAIN'), { message: 'the main region to take focus' });
    await page.keyboard.press('Tab');
    assert.equal(await focusedName(page), 'Write a new journal entry');
    await page.keyboard.type('Typed with the keyboard only, no mouse involved.');

    // mood: a radio group is ONE Tab stop (the first mood while none is chosen) and the arrow keys move and choose
    await tabTo(page, /^Awful$/);
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight'); // Awful -> Low -> Okay -> Good
    assert.equal(await focusedName(page), 'Good');
    assert.equal(await ui.mood(page, 'Good').getAttribute('aria-checked'), 'true', 'moving with the arrows chooses');
    await page.keyboard.press('Space'); // pressing the chosen one clears it
    assert.equal(await ui.mood(page, 'Good').getAttribute('aria-checked'), 'false');
    await page.keyboard.press('Space');
    assert.equal(await ui.mood(page, 'Good').getAttribute('aria-checked'), 'true');
    await page.keyboard.press('Tab'); // the group is one stop: the next Tab leaves it for the next control
    assert.notEqual(await focusedName(page), 'Great', 'Tab does not walk through the remaining mood buttons');
    await tabTo(page, /Start journaling/);
    await page.keyboard.press('Enter');
    await page.waitForURL(/#\/entry\//);
    await ui.companion(page).first().waitFor();

    // the composer gets focus back after the reply, so typing can simply continue; Ctrl+Enter sends
    await eventually(async () => assert.equal(await focusedName(page), 'Write in your journal'), { message: 'the entry box to be focused' });
    const id = ui.entryId(page);
    assert.equal(db.entries.get(id).mood, 4);
    await page.keyboard.type('A second thought, sent with Ctrl+Enter.');
    await page.keyboard.press('Control+Enter');
    await ui.mine(page).filter({ hasText: 'A second thought, sent with Ctrl+Enter.' }).waitFor();
    await eventually(async () => assert.equal(await ui.companion(page).count(), 2), { message: 'a second reply' });
    assert.equal(await ui.entryBox(page).inputValue(), '');
    await eventually(async () => assert.equal(await focusedName(page), 'Write in your journal'));

    // the options menu: Enter opens, arrows move, Home/End jump, Escape closes and gives focus back
    const menuButton = page.getByRole('button', { name: 'Entry options' });
    await menuButton.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Entry options' });
    await menu.waitFor();
    assert.match(await focusedName(page), /^Private entry/);
    await page.keyboard.press('ArrowDown');
    assert.equal(await focusedName(page), 'Pin entry');
    await page.keyboard.press('End');
    assert.match(await focusedName(page), /^Delete entry/);
    await page.keyboard.press('ArrowDown'); // wraps around
    assert.match(await focusedName(page), /^Private entry/);
    await page.keyboard.press('ArrowUp');
    assert.match(await focusedName(page), /^Delete entry/);
    await page.keyboard.press('Home');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await focusedName(page), 'Entry options');
    assert.equal(await menuButton.getAttribute('aria-expanded'), 'false');

    // Tab leaves the menu and closes it
    await page.keyboard.press('ArrowDown');
    await menu.waitFor();
    await page.keyboard.press('Tab');
    await menu.waitFor({ state: 'hidden' });

    // a menu item can be activated with Enter: make the entry private and see the flag
    await menuButton.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await eventually(() => assert.equal(db.entries.get(id).private, true));
    await page.getByText('Private', { exact: true }).first().waitFor();
    assert.equal(await focusedName(page), 'Entry options', 'focus returns to the menu button');

    // editing your own message: Enter opens the editor, Escape cancels, Ctrl+Enter saves, focus returns each time
    const edit = page.getByRole('button', { name: 'Edit this message' }).first();
    await edit.focus();
    await page.keyboard.press('Enter');
    const editor = page.getByRole('textbox', { name: 'Edit your message' });
    await editor.waitFor();
    await eventually(async () => assert.equal(await focusedName(page), 'Edit your message'));
    await page.keyboard.type(' (not saved)');
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'hidden' });
    assert.equal(await focusedName(page), 'Edit this message');
    assert.ok(!db.messages.list(id)[0].content.includes('(not saved)'));
    await page.keyboard.press('Enter');
    await editor.waitFor();
    await eventually(async () => assert.equal(await focusedName(page), 'Edit your message'));
    await page.keyboard.type(' (saved)');
    await page.keyboard.press('Control+Enter');
    await editor.waitFor({ state: 'hidden' });
    await eventually(() => assert.ok(db.messages.list(id)[0].content.endsWith('(saved)')));
    await eventually(async () => assert.equal(await focusedName(page), 'Edit this message'));
    await page.getByText('edited', { exact: true }).first().waitFor();

    // delete: a destructive dialog opens on its least destructive button (Cancel), Escape cancels and returns focus to the menu button
    await menuButton.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Delete this entry?' });
    await dialog.waitFor();
    assert.equal(await focusedName(page), 'Cancel', 'the dialog does not open on the destructive button');
    // the page behind a modal dialog is inert: Tab can only reach the dialog (or leave the document for the browser's own UI)
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement === document.body || Boolean(document.activeElement.closest('dialog'))), true, 'focus never lands on the page behind the dialog');
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await focusedName(page), 'Entry options');
    assert.ok(db.entries.get(id), 'Escape did not delete anything');

    await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await dialog.waitFor();
    // a stray Enter or Space on a freshly opened dialog only cancels it
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(db.entries.get(id), 'Enter on the opening focus (Cancel) deleted nothing');
    assert.equal(await focusedName(page), 'Entry options');

    await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await dialog.waitFor();
    await page.keyboard.press('Tab'); // Cancel -> Delete entry
    assert.equal(await focusedName(page), 'Delete entry');
    await page.keyboard.press('Enter'); // the person chose it on purpose
    await page.getByText('Entry deleted').waitFor();
    await page.waitForURL(/#\/history/);
    assert.equal(db.entries.get(id), null);
  }));

  test('the entry header: title with Enter/Escape, feelings and tags with Enter, comma, Escape and Backspace-free removal', () => journey({
    name: 'keyboard-header',
  }, async (j) => {
    const { page, db } = j;
    const made = await j.app.entry({ content: 'Header test.', title: 'First title' });
    const id = made.entry.id;
    await j.goto(`/entry/${id}`);
    const title = page.getByRole('textbox', { name: 'Entry title' });
    await title.waitFor();

    // Enter saves and leaves the field; Escape throws the edit away
    await title.focus();
    await title.fill('A better title');
    await page.keyboard.press('Enter');
    await eventually(() => assert.equal(db.entries.get(id).title, 'A better title'));
    // (the page learns the saved title when the server's answer arrives; Escape below reverts to that)
    await eventually(async () => assert.equal(await page.title(), 'A better title · MyJournal'), { message: 'the saved title to reach the page' });
    assert.notEqual(await focusedName(page), 'Entry title');
    await title.focus();
    await title.fill('Never saved');
    await page.keyboard.press('Escape');
    assert.equal(await title.inputValue(), 'A better title');
    assert.equal(db.entries.get(id).title, 'A better title');

    // tags: Enter adds, comma adds, Escape cancels, duplicates are refused with a note, labels are lower-cased
    await page.getByRole('button', { name: 'Add tag' }).click();
    const input = page.getByRole('textbox', { name: 'Add tag' });
    await input.waitFor();
    await page.keyboard.type('Work');
    await page.keyboard.press('Enter');
    await eventually(() => assert.deepEqual(db.entries.get(id).tags, ['work']));
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.keyboard.type('family,');
    await eventually(() => assert.deepEqual(db.entries.get(id).tags, ['work', 'family']));
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.keyboard.type('nothing');
    await page.keyboard.press('Escape');
    assert.deepEqual(db.entries.get(id).tags, ['work', 'family'], 'Escape adds nothing');
    assert.equal(await focusedName(page), 'Add tag');
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.keyboard.type('WORK');
    await page.keyboard.press('Enter');
    await page.getByText(/is already there/).waitFor();
    await page.getByRole('button', { name: 'Remove tag work' }).click();
    await eventually(() => assert.deepEqual(db.entries.get(id).tags, ['family']));

    // feelings work the same way
    await page.getByRole('button', { name: 'Add feeling' }).click();
    await page.keyboard.type('Calm');
    await page.keyboard.press('Enter');
    await eventually(() => assert.deepEqual(db.entries.get(id).emotions, ['calm']));
    await page.getByRole('button', { name: 'Remove feeling calm' }).waitFor();

    // a chip typed but not committed is saved when the person leaves the page
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.keyboard.type('unfinished');
    await page.getByRole('link', { name: 'History', exact: true }).first().click();
    await eventually(() => assert.deepEqual(db.entries.get(id).tags, ['family', 'unfinished']));
  }));
});

describe('keyboard: focus and order', () => {
  test('every stop on every page has a visible focus indicator and the tab order starts in the content', () => journey({
    name: 'keyboard-focus-audit', seed: (db) => seedSampleJournal(db),
  }, async (j) => {
    const { page, db } = j;
    // an entry that already has the companion's reply last (so there is no "Get a reply" button; that one has its own test below)
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Long run in the rain');
    const routes = [
      ['/', 'Write a new journal entry'],
      ['/history', null],
      ['/insights', null],
      ['/memory', null],
      ['/settings?tab=gemini', null],
      ['/settings?tab=general', null],
      ['/settings?tab=data', null],
      [`/entry/${entry.id}`, null],
    ];
    for (const [path, firstStop] of routes) {
      await j.load(path);
      await page.getByRole('main').getByRole('heading').first().waitFor();
      await page.waitForTimeout(600); // let lazy sections arrive so the tab order is complete
      const { stops, invisible } = await focusAudit(page, { stops: 45 });
      assert.ok(stops.length >= 3, `${path}: there are keyboard stops (${stops.join(' | ')})`);
      assert.deepEqual(invisible, [], `${path}: stops with no visible focus indicator`);
      if (firstStop) assert.ok(stops[0].includes(firstStop), `${path}: the first Tab goes to "${firstStop}" (got ${stops[0]})`);
    }
  }));

  // Regression: on an older entry whose last message is the person's own, "Get a reply" sits at the bottom of the thread right
  // under the fixed composer. Tab focused it without scrolling (it was "in view") so it was hidden behind the composer
  // (WCAG 2.2 "Focus Not Obscured"); the page now keeps scroll padding for the composer's height.
  test('Tab to "Get a reply" is not hidden behind the composer', () => journey({
    name: 'keyboard-get-a-reply-obscured', seed: (db) => seedSampleJournal(db),
  }, async (j) => {
    const { page, db } = j;
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'A slow day with Miso');
    await j.load(`/entry/${entry.id}`);
    const reply = page.getByRole('button', { name: 'Get a reply' });
    await reply.waitFor();
    await page.waitForTimeout(500);
    await reply.focus();
    const covered = await reply.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !el.contains(top);
    });
    assert.equal(covered, false, 'the focused button is on top of the page, not under the composer');
  }));

  test('"Skip to content" is the first thing in the page order, appears on focus and moves focus to the content', () => journey({
    name: 'keyboard-skip-link',
  }, async (j) => {
    const { page } = j;
    await j.goto('/history');
    await ui.heading(page, 'History', 1).waitFor();
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await page.getByRole('link', { name: 'MyJournal home' }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focusedName(page), 'Skip to content');
    const box = await skip.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.width > 20, `it is on screen while focused: ${JSON.stringify(box)}`);
    await page.keyboard.press('Enter');
    assert.equal(await focusedTag(page), 'MAIN');
    assert.match(page.url(), /#\/history$/, 'the address is not changed by the skip link');
  }));

  // Regression: the five mood buttons are role="radio" in a role="radiogroup", but every one used to be its own Tab stop and the
  // arrow keys did nothing. Radio semantics promise one stop, with the arrows moving and choosing.
  test('the mood picker behaves like a radio group with the arrow keys', () => journey({
    name: 'keyboard-mood-arrows',
  }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await ui.todayBox(page).waitFor();
    await ui.mood(page, 'Awful').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await focusedName(page), 'Low');
    assert.equal(await ui.mood(page, 'Low').getAttribute('aria-checked'), 'true');
    await page.keyboard.press('Tab');
    assert.notEqual(await focusedName(page), 'Okay', 'Tab leaves the group instead of visiting every button');
  }));
});
