// Journey 4: History - month grouping, "Load more" paging, full-text search with highlighting, mood / pinned / tag
// filters, deep links to a filtered list and keyboard shortcuts, all against seeded data (12 sample entries + 70 plain ones).

import { describe, journey, test, ui, assert, eventually, seedBulk, seedSampleJournal } from './helpers.js';

// The plain entries start 28 hours ago: older than "A slow day with Miso" (yesterday 21:12, at most 26.8 h ago) and newer than "Long run in
// the rain" (the day before at 19:12, at least 28.8 h ago), whatever the time of day. At 30 hours the second card was a sample entry
// between midnight and 01:00.
const seed = (db) => { seedSampleJournal(db); seedBulk(db, 70, { startHoursAgo: 28 }); };

/** The entry cards currently listed (every card's title is a link to its entry). */
const cards = (page) => page.getByRole('main').locator('a[href^="#/entry/"]');
const countOf = (db, options) => db.entries.list({ limit: 200, ...options }).length;

describe('history', () => {
  test('lists entries by month and pages with "Load more"', () => journey({ name: 'history-paging', seed }, async (j) => {
    const { page, db } = j;
    const total = db.stats().entries;
    assert.equal(total, 82);
    await j.goto('/history');
    await ui.heading(page, 'History', 1).waitFor();

    // newest first, 30 per page, grouped under month headings
    await eventually(async () => assert.equal(await cards(page).count(), 30), { message: 'the first page of 30 cards' });
    const months = await page.getByRole('main').getByRole('heading', { level: 2 }).allTextContents(); // textContent: CSS may upper-case the look
    assert.ok(months.length >= 1);
    for (const m of months) assert.match(m, /^[A-Z][a-z]+ \d{4}$/, `"${m}" is a month heading`);
    assert.match(await cards(page).first().innerText(), /A slow day with Miso/, 'newest entry first (it was written yesterday evening; the plain ones start 28 hours ago)');
    assert.match(await cards(page).nth(1).innerText(), /Bulk entry 001/);

    await ui.button(page, 'Load more').click();
    await eventually(async () => assert.equal(await cards(page).count(), 60), { message: '60 cards after Load more' });
    await ui.button(page, 'Load more').click();
    await eventually(async () => assert.equal(await cards(page).count(), total), { message: 'all entries after the second Load more' });
    assert.equal(await ui.button(page, 'Load more').count(), 0, 'no more pages');

    // no entry appears twice across pages
    const hrefs = await cards(page).evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    assert.equal(new Set(hrefs).size, hrefs.length, 'no duplicates between pages');

    // a card opens its entry
    await page.getByRole('link', { name: 'Bulk entry 001' }).click();
    await page.waitForURL(/#\/entry\//);
    await ui.mine(page).filter({ hasText: 'Plain note number 1 ' }).waitFor();
  }));

  test('search finds words, highlights them, explains empty results and clears with Escape', () => journey({ name: 'history-search', seed }, async (j) => {
    const { page } = j;
    await j.goto('/history');
    const search = page.getByRole('searchbox', { name: 'Search your entries' });
    await search.waitFor();
    await eventually(async () => assert.equal(await cards(page).count(), 30));

    await search.fill('pancakes');
    await page.getByText('1 result for “pancakes”').waitFor();
    await eventually(async () => assert.equal(await cards(page).count(), 1));
    assert.match(await cards(page).first().innerText(), /A slow day with Miso/);
    const marks = await page.getByRole('main').locator('mark').allInnerTexts();
    assert.ok(marks.length >= 1 && marks.every((m) => /pancakes/i.test(m)), `the matched word is highlighted: ${JSON.stringify(marks)}`);
    assert.match(page.url(), /#\/history\?q=pancakes/, 'the search is in the address, so it can be shared and reloaded');

    // prefix search, ranked results span more than the month grouping
    await search.fill('marath');
    await page.getByText(/\d+ results? for “marath”/).waitFor();
    assert.ok((await cards(page).count()) >= 1);

    await search.fill('zzzqqq');
    await page.getByText('Nothing matches “zzzqqq”').waitFor();
    await ui.button(page, 'Clear search and filters').click();
    await eventually(async () => assert.equal(await cards(page).count(), 30));
    assert.equal(await search.inputValue(), '');

    // Escape inside the box clears it as well
    await search.fill('Miso');
    await page.getByText(/1 result for “Miso”|2 results for “Miso”/).waitFor();
    await search.press('Escape');
    await eventually(async () => assert.equal(await cards(page).count(), 30));
    assert.equal(await search.inputValue(), '');

    // hostile search text is harmless (the server quotes it) and gets a calm answer
    await search.fill('" OR 1=1 -- ) (');
    await eventually(async () => {
      const text = await page.getByRole('main').innerText();
      assert.ok(/Nothing matches|result/.test(text), 'a normal result or empty state, not an error');
    });
    assert.equal(await page.getByRole('alert').count(), 0);
  }));

  test('a search with more than 30 matches pages with "Load more" and does not call a page "30 results" while more wait', () => journey({ name: 'history-search-paging', seed }, async (j) => {
    const { page, db } = j;
    // every plain entry says "ordinary things"
    const total = db.search('ordinary', { limit: 100, includePrivate: true }).length;
    assert.ok(total > 60 && total < 100, `the seed has ${total} matches`);
    await j.goto('/history');
    const search = page.getByRole('searchbox', { name: 'Search your entries' });
    await search.fill('ordinary');
    await page.getByText('Showing the best 30 matches for “ordinary”').waitFor();
    await eventually(async () => assert.equal(await cards(page).count(), 30));
    assert.equal(await page.getByText('30 results for').count(), 0, 'a page of a longer list is not "30 results"');
    // ranked results have no month headings: the card titles (h3) sit under a heading of their own, not straight under the h1
    await page.getByRole('heading', { name: 'Search results', level: 2 }).waitFor({ state: 'attached' });

    await ui.button(page, 'Load more').click();
    await page.getByText('Showing the best 60 matches for “ordinary”').waitFor();
    await eventually(async () => assert.equal(await cards(page).count(), 60));
    await ui.button(page, 'Load more').click();
    await page.getByText(`${total} results for “ordinary”`).waitFor();
    await eventually(async () => assert.equal(await cards(page).count(), total));
    assert.equal(await ui.button(page, 'Load more').count(), 0, 'the last page ends the list');
    const hrefs = await cards(page).evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    assert.equal(new Set(hrefs).size, total, 'no entry twice, none missing');
  }));

  test('Back to a deep list does not retry for ever when a later page cannot be loaded', () => journey({ name: 'history-restore-fails', seed: (db) => seedBulk(db, 320, { startHoursAgo: 1 }) }, async (j) => {
    const { page, diag } = j;
    diag.allowConsole(/Failed to load resource|ERR_FAILED|Failed to fetch/);
    diag.allowFailedRequests(/net::ERR/);
    await j.goto('/history');
    await eventually(async () => assert.equal(await cards(page).count(), 30));
    for (let want = 60; want <= 270; want += 30) {
      await ui.button(page, 'Load more').click();
      await eventually(async () => assert.equal(await cards(page).count(), want), { message: `${want} cards` });
    }
    await cards(page).last().click(); // leave from deep in the list
    await page.waitForURL(/#\/entry\//);

    // every request for the list from now on fails after the first one (a server restart, a 5xx)
    let listRequests = 0;
    // exactly the list requests (a glob such as **/api/entries?* also matches /api/entries/<id>, where ? is any one character)
    await page.route((url) => url.pathname === '/api/entries' && url.searchParams.has('limit'), (route) => {
      listRequests += 1;
      if (listRequests === 1) return route.continue();
      return route.abort('failed');
    });
    await page.goBack();
    await page.waitForURL(/#\/history/);
    await eventually(async () => assert.ok(await cards(page).count() >= 200, 'the first, successful page is shown'), { message: 'the restored first page', timeout: 30_000 });
    await page.waitForTimeout(2500);
    const seen = listRequests;
    await page.waitForTimeout(1500);
    assert.ok(seen <= 3, `the restore gave up after ${seen} list requests`);
    assert.equal(listRequests, seen, 'and it stays quiet');
    assert.equal(await ui.button(page, 'Load more').count(), 1, 'the person can still press Load more');
  }));

  test('filters by mood, pinned and tag; chips on a card filter too; Clear filters resets', () => journey({ name: 'history-filters', seed }, async (j) => {
    const { page, db } = j;
    await j.goto('/history');
    await eventually(async () => assert.equal(await cards(page).count(), 30));

    // mood
    const greatCount = countOf(db, { mood: 5 });
    assert.ok(greatCount > 3 && greatCount < 30);
    const great = ui.button(page, 'Great mood');
    await great.click();
    assert.equal(await great.getAttribute('aria-pressed'), 'true');
    await eventually(async () => assert.equal(await cards(page).count(), greatCount), { message: 'only Great-mood entries' });
    assert.equal(await page.getByRole('img', { name: 'Mood: Great' }).count(), greatCount, 'every card shows the Great face');
    assert.match(page.url(), /mood=5/);
    await great.click(); // toggle off
    await eventually(async () => assert.equal(await cards(page).count(), 30));

    // pinned
    await ui.button(page, 'Pinned').click();
    await eventually(async () => assert.equal(await cards(page).count(), countOf(db, { pinned: true })));
    assert.match(await cards(page).first().innerText(), /Presentation day/);
    await ui.button(page, 'Pinned').click();

    // tag, from the select
    const tagSelect = page.getByLabel('Filter by tag');
    await tagSelect.waitFor();
    await tagSelect.selectOption({ label: '#running' });
    const running = countOf(db, { tag: 'running' });
    await eventually(async () => assert.equal(await cards(page).count(), running), { message: 'only #running entries' });
    assert.match(page.url(), /tag=running/);

    // combine with search
    await page.getByRole('searchbox', { name: 'Search your entries' }).fill('rain');
    await page.getByText(/1 result for “rain”/).waitFor();
    assert.match(await cards(page).first().innerText(), /Long run in the rain/);

    // Clear filters resets everything
    await ui.button(page, 'Clear filters').click();
    await eventually(async () => assert.equal(await cards(page).count(), 30));
    assert.equal(await tagSelect.inputValue(), '');
    assert.equal(await page.getByRole('searchbox', { name: 'Search your entries' }).inputValue(), '');
    assert.doesNotMatch(page.url(), /tag=|mood=|q=/);

    // a tag chip on a card filters by that tag
    await page.getByRole('button', { name: '#gratitude', exact: true }).first().click();
    const gratitude = countOf(db, { tag: 'gratitude' });
    await eventually(async () => assert.equal(await cards(page).count(), gratitude), { message: 'chip click filters by tag' });
    assert.equal(await tagSelect.inputValue(), 'gratitude');
  }));

  test('a filtered list can be opened from its address; "/" focuses the search box', () => journey({ name: 'history-deeplink', seed }, async (j) => {
    const { page, db } = j;
    await j.load('/history?mood=2&q=');
    await eventually(async () => assert.equal(await cards(page).count(), countOf(db, { mood: 2 })));
    assert.equal(await ui.button(page, 'Low mood').getAttribute('aria-pressed'), 'true');

    await j.load('/history?q=running');
    const search = page.getByRole('searchbox', { name: 'Search your entries' });
    await page.getByText(/\d+ results? for “running”/).waitFor();
    assert.equal(await search.inputValue(), 'running');

    // "/" jumps to the search box unless you are typing somewhere
    await j.load('/history');
    await eventually(async () => assert.equal(await cards(page).count(), 30));
    await page.getByRole('main').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    assert.equal(await search.evaluate((el) => document.activeElement === el), true);
  }));

  test('an empty journal explains itself', () => journey({ name: 'history-empty' }, async (j) => {
    const { page } = j;
    await j.goto('/history');
    await page.getByText('Your journal is waiting').waitFor();
    await page.getByRole('link', { name: 'Write your first entry' }).click();
    await ui.todayBox(page).waitFor();
    assert.equal(await ui.todayBox(page).evaluate((el) => document.activeElement === el), true, 'the Write link focuses the box');
  }));
});
