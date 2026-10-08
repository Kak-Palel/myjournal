// Journey 13: addresses. Every route can be opened cold and reloaded, an entry's address works in a fresh tab, Back and
// Forward behave, unknown and broken addresses end somewhere sensible, and an entry deleted elsewhere is explained.

import { assert, describe, eventually, journey, seedSampleJournal, test, ui } from './helpers.js';

const seed = (db) => seedSampleJournal(db);
const entryByTitle = (db, title) => db.entries.list({ limit: 100 }).find((e) => e.title === title);

describe('deep links and reloads', () => {
  test('an entry opens from its address in a fresh page, keeps its place on reload, and sets the tab title', () => journey({
    name: 'links-entry', seed,
  }, async (j) => {
    const { page, db } = j;
    const entry = entryByTitle(db, 'Presentation day');
    await j.load(`/entry/${entry.id}`);
    await ui.mine(page).filter({ hasText: 'Presented the redesign to the whole studio' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Entry title' }).inputValue(), 'Presentation day');
    assert.equal(await page.title(), 'Presentation day · MyJournal');
    await page.getByRole('region', { name: 'Entry summary' }).waitFor(); // a wrapped entry shows its summary
    assert.equal(await ui.mood(page, 'Great').getAttribute('aria-checked'), 'true');
    await page.getByText('Pinned', { exact: true }).first().waitFor();

    await j.reload();
    await ui.mine(page).filter({ hasText: 'Presented the redesign to the whole studio' }).waitFor();
    assert.match(page.url(), new RegExp(`#/entry/${entry.id}$`));

    // a second, completely separate page (another tab) opens the same address
    const other = await j.context.newPage();
    await other.goto(page.url());
    await other.getByRole('article').filter({ hasText: 'Presented the redesign' }).first().waitFor();
    await other.close();
  }));

  test('?reply=1 asks for a reply once; reloading the address does not ask again', () => journey({
    name: 'links-reply-param', mocks: { local: { replies: ['A reply requested by the address.'] } },
  }, async (j) => {
    const { page, mock, db } = j;
    const made = await j.app.entry({ content: 'Opened with reply=1.' });
    await j.load(`/entry/${made.entry.id}?reply=1`);
    await ui.companion(page).filter({ hasText: 'A reply requested by the address.' }).waitFor();
    assert.doesNotMatch(page.url(), /reply=1/);
    assert.equal(mock.chatRequests().length, 1);
    await j.reload();
    await ui.mine(page).first().waitFor();
    await ui.companion(page).first().waitFor();
    await page.waitForTimeout(400);
    assert.equal(mock.chatRequests().length, 1, 'a reload did not ask the model again');
    assert.equal(db.messages.list(made.entry.id).length, 2);
  }));

  test('every route opens cold and survives a reload', () => journey({ name: 'links-every-route', seed }, async (j) => {
    const { page, db } = j;
    const entry = entryByTitle(db, 'Long run in the rain');
    const cases = [
      ['/', () => ui.todayBox(page)],
      ['/welcome', () => ui.heading(page, 'A private place to think out loud', 1)],
      ['/history', () => ui.heading(page, 'History', 1)],
      ['/history?mood=5', () => ui.button(page, 'Great mood')],
      ['/insights', () => ui.heading(page, 'Insights', 1)],
      ['/memory', () => ui.heading(page, 'Memory', 1)],
      ['/settings', () => ui.heading(page, 'Settings', 1)],
      ['/settings?tab=data', () => page.getByText('What is stored')],
      ['/settings?tab=general', () => page.getByLabel('Your name')],
      ['/settings?tab=local', () => page.getByText('Quick start with Ollama')],
      ['/settings?tab=openai', () => page.getByText(/service behind the base URL/)],
      [`/entry/${entry.id}`, () => page.getByRole('textbox', { name: 'Entry title' })],
    ];
    for (const [path, marker] of cases) {
      await j.load(path);
      await marker().waitFor();
      await j.reload();
      await marker().waitFor();
      assert.match(page.url(), new RegExp(`#${path.replace(/[?]/g, '\\?')}`), `${path}: the address is kept`);
    }
  }));

  test('the Settings tab is part of the address: switching tabs updates it and a reload returns to the same tab', () => journey({
    name: 'links-settings-tab',
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings');
    await ui.heading(page, 'Settings', 1).waitFor();
    // no tab given: the active provider's tab (Local model here)
    assert.equal(await ui.tab(page, 'Local model').getAttribute('aria-selected'), 'true');
    await ui.tab(page, 'General').click();
    await page.getByLabel('Your name').waitFor();
    assert.match(page.url(), /#\/settings\?tab=general/);
    await j.reload();
    await page.getByLabel('Your name').waitFor();
    assert.equal(await ui.tab(page, 'General').getAttribute('aria-selected'), 'true');
    await ui.tab(page, 'Data').click();
    assert.match(page.url(), /tab=data/);
    // an unknown tab falls back to the active provider's
    await j.load('/settings?tab=bogus');
    await ui.heading(page, 'Settings', 1).waitFor();
    assert.equal(await ui.tab(page, 'Local model').getAttribute('aria-selected'), 'true');
  }));

  test('Back and Forward walk through the pages that were visited', () => journey({ name: 'links-history-stack', seed }, async (j) => {
    const { page, db } = j;
    const entry = entryByTitle(db, 'Dinner with Maya');
    await j.goto('/');
    await ui.todayBox(page).waitFor();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'History' }).click();
    await ui.heading(page, 'History', 1).waitFor();
    await page.getByRole('link', { name: 'Dinner with Maya' }).click();
    await page.waitForURL(new RegExp(`#/entry/${entry.id}`));
    await ui.mine(page).first().waitFor();

    await page.goBack();
    await ui.heading(page, 'History', 1).waitFor();
    await page.goBack();
    await ui.todayBox(page).waitFor();
    await page.goForward();
    await ui.heading(page, 'History', 1).waitFor();
    await page.goForward();
    await ui.mine(page).first().waitFor();
    // the entry's own "History" link goes back to the list
    await page.getByRole('link', { name: 'History', exact: true }).filter({ hasText: 'History' }).first().click();
    await ui.heading(page, 'History', 1).waitFor();
  }));
});

describe('addresses that lead nowhere', () => {
  test('a missing entry says so and offers a way out; unknown routes land on Today', () => journey({ name: 'links-missing' }, async (j) => {
    const { page, diag } = j;
    diag.expectStatus(404, /\/api\/entries\//);
    await j.load('/entry/00000000-0000-4000-8000-000000000000');
    await page.getByText('We cannot find that entry').waitFor();
    await page.getByText('It may have been deleted, or the link is not quite right.').waitFor();
    await page.getByRole('link', { name: 'Back to Today' }).click();
    await ui.todayBox(page).waitFor();

    await j.load('/entry/a%2Fb'); // an encoded slash is just another unknown id
    await page.getByText('We cannot find that entry').waitFor();
    await page.getByRole('link', { name: 'Go to History' }).click();
    await ui.heading(page, 'History', 1).waitFor();

    for (const path of ['/nonsense', '/entry/', '/entry/x/y', '/settings/extra']) {
      await j.load(path);
      await ui.todayBox(page).waitFor();
    }
  }));

  test('an address without a hash (the server\'s fallback page) opens Today; files that do not exist are real 404s', () => journey({ name: 'links-fallback' }, async (j) => {
    const { page } = j;
    const res = await page.request.get(`${j.origin}/history`);
    assert.equal(res.status(), 200);
    assert.match(res.headers()['content-type'], /text\/html/);
    assert.match(res.headers()['content-security-policy'], /script-src 'self'/);
    assert.equal((await page.request.get(`${j.origin}/js/does-not-exist.js`)).status(), 404);
    assert.equal((await page.request.get(`${j.origin}/api/does-not-exist`)).status(), 404);
    await page.goto(`${j.origin}/history`);
    await ui.todayBox(page).waitFor();
  }));

  // Regression: decodeURIComponent() in the router's match() sat outside its try/catch, so an address with broken
  // percent-encoding threw "URIError: URI malformed" out of the hashchange handler (an uncaught page error) and the previous
  // page simply stayed on screen. Such an address now matches no page and ends on Today like any other unknown one.
  test('an address with broken percent-encoding does not throw', () => journey({
    name: 'links-bad-encoding',
  }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await ui.todayBox(page).waitFor();
    await page.evaluate(() => { window.location.hash = '#/entry/%E0%A4%A'; });
    await page.waitForTimeout(500);
    assert.deepEqual(j.diag.pageErrors, [], 'no uncaught error');
    await ui.todayBox(page).waitFor();
  }));

  test('an entry deleted elsewhere: the open page explains and keeps the typed text; a reload says it is gone', () => journey({
    name: 'links-deleted-elsewhere',
  }, async (j) => {
    const { page, db, diag } = j;
    diag.expectStatus(404, /\/api\/entries\//);
    const made = await j.app.entry({ content: 'This entry is about to disappear.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.mine(page).first().waitFor();
    db.entries.delete(made.entry.id); // "another tab" deletes it

    await ui.entryBox(page).fill('Words typed after the entry was deleted.');
    await ui.button(page, 'Send').click();
    const banner = page.getByRole('alert').filter({ hasText: 'This entry no longer exists.' });
    await banner.waitFor();
    await banner.getByText('It may have been deleted in another tab.').waitFor();
    assert.equal(await ui.entryBox(page).inputValue(), 'Words typed after the entry was deleted.', 'the typed text is not lost');

    await j.reload();
    await page.getByText('We cannot find that entry').waitFor();
  }));
});
