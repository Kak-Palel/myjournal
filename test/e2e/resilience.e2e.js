// Journey 23: the app keeps its footing. The server stops and comes back (one calm banner, automatic recovery), Back and Forward
// return to where you were in a long History, "Load more" does not drop the keyboard, and a reply that arrives in a few big
// frames (as Gemini's does) is typed out progressively instead of appearing in one jump.

import { createApp } from '../../src/server/app.js';
import { freePort } from '../server/helpers.js';
import {
  assert, describe, eventually, journey, seedBulk, seedSampleJournal, sleep, test, ui,
} from './helpers.js';

/** The entry cards currently listed in History (every card's title is a link to its entry). */
const cards = (page) => page.getByRole('main').locator('a[href^="#/entry/"]');

/**
 * Start the server again on the same address with the same data, after the journey's own instance was stopped. (An app that was
 * closed stays closed, so this is a new instance; the caller closes it.)
 */
async function restartServer(j) {
  const again = createApp({ config: j.app.config, db: j.app.db });
  await again.listen();
  return again;
}

describe('the server goes away and comes back', () => {
  for (const [label, mobile, viewport] of [['desktop', false, { width: 1280, height: 800 }], ['phone', true, { width: 390, height: 844 }]]) {
    test(`${label}: one banner while it is down, "Try now", and everything recovers by itself when it returns`, async () => {
      const port = await freePort();
      await journey({ name: `resilience-offline-${label}`, seed: 'demo', mobile, viewport, config: { port } }, async (j) => {
        const { page, diag } = j;
        // a stopped server makes the browser itself log failed requests: that is the scenario, not noise
        diag.allowConsole(/Failed to load resource|ERR_CONNECTION_REFUSED|Failed to fetch|dynamically imported module|TypeError/);
        diag.allowFailedRequests(/net::ERR/);
        await j.goto('/');
        await ui.todayBox(page).waitFor();
        await page.waitForLoadState('networkidle');
        assert.equal(await page.getByText('Cannot reach MyJournal.').count(), 0, 'no banner while the server is up');

        await j.app.app.close(); // the server stops
        let again = null;
        try {
          await page.getByRole('link', { name: 'Insights', exact: true }).first().click();
          const banner = page.getByRole('alert').filter({ hasText: 'Cannot reach MyJournal.' });
          await banner.waitFor({ timeout: 8000 });
          assert.equal(await page.getByText('Cannot reach MyJournal.').count(), 1, 'exactly one banner, not one per failed request');
          await page.getByText('MyJournal did not answer').waitFor(); // the page's own words, not a raw "Failed to fetch dynamically imported module"
          await page.getByRole('button', { name: 'Reload' }).waitFor();
          assert.equal(await page.getByText(/dynamically imported module/).count(), 0);
          await banner.getByRole('button', { name: /Try now|Checking/ }).click();
          await page.waitForTimeout(800);
          assert.equal(await banner.count(), 1, 'still down: the banner stays');

          again = await restartServer(j); // the server returns on the same address
          await banner.waitFor({ state: 'detached', timeout: 25_000 });
          // the page that failed to load is loaded again without a click (a reload, which also ends the "Connected again." toast early)
          await ui.heading(page, 'Insights', 1).waitFor({ timeout: 15_000 });
          assert.equal(await page.getByRole('button', { name: 'Reload' }).count(), 0);
        } finally {
          if (again) await again.close();
        }
      });
    });
  }

  test('a request that fails while the server is down is retried by itself when it returns', async () => {
    const port = await freePort();
    await journey({ name: 'resilience-offline-retry', seed: 'demo', config: { port } }, async (j) => {
      const { page, diag } = j;
      diag.allowConsole(/Failed to load resource|ERR_CONNECTION_REFUSED|Failed to fetch/);
      diag.allowFailedRequests(/net::ERR/);
      await j.goto('/history');
      await eventually(async () => assert.equal(await cards(page).count(), 12), { message: 'all twelve sample entries' });
      await j.app.app.close();
      let again = null;
      try {
        const search = page.getByRole('searchbox', { name: 'Search your entries' });
        await search.fill('Miso');
        const banner = page.getByRole('alert').filter({ hasText: 'Cannot reach MyJournal.' });
        await banner.waitFor({ timeout: 8000 });
        again = await restartServer(j);
        await banner.waitFor({ state: 'detached', timeout: 25_000 });
        await page.getByText('Connected again.').waitFor(); // said once, when it is back
        await page.getByText(/results? for “Miso”/).waitFor({ timeout: 15_000 }); // the search that failed ran again
        assert.ok(await cards(page).count() >= 1);
      } finally {
        if (again) await again.close();
      }
    });
  });
});

describe('History keeps its place', () => {
  const seed = (db) => { seedSampleJournal(db); seedBulk(db, 110); };

  test('Back from an entry returns to the same depth and scroll position; a link starts at the top again', () => journey({
    name: 'resilience-back-scroll', seed, viewport: { width: 1280, height: 800 },
  }, async (j) => {
    const { page } = j;
    await j.goto('/history');
    await eventually(async () => assert.equal(await cards(page).count(), 30));
    await ui.button(page, 'Load more').click();
    await eventually(async () => assert.equal(await cards(page).count(), 60));
    await ui.button(page, 'Load more').click();
    await eventually(async () => assert.equal(await cards(page).count(), 90));

    const target = cards(page).nth(70);
    await target.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -120));
    const title = (await target.innerText()).split('\n')[0];
    const before = await page.evaluate(() => Math.round(window.scrollY));
    assert.ok(before > 2000, `scrolled well down the list (${before})`);
    await target.click();
    await page.waitForURL(/#\/entry\//);
    await ui.mine(page).first().waitFor();

    await page.goBack();
    await eventually(async () => assert.equal(await cards(page).count(), 90), { message: 'the same 90 cards again' });
    await eventually(async () => {
      const now = await page.evaluate(() => Math.round(window.scrollY));
      assert.ok(Math.abs(now - before) <= 160, `back at about the same place: ${now} vs ${before}`);
    }, { message: 'the scroll position to be restored' });
    assert.match(await page.getByRole('link', { name: title.trim() }).first().innerText(), new RegExp(title.trim().slice(0, 12)));

    // a link to History (not Back) is a new visit: the top, one page
    await page.getByRole('link', { name: 'Insights', exact: true }).first().click();
    await ui.heading(page, 'Insights', 1).waitFor();
    await page.getByRole('link', { name: 'History', exact: true }).first().click();
    await eventually(async () => assert.equal(await cards(page).count(), 30), { message: 'a fresh visit shows one page' });
    assert.ok(await page.evaluate(() => window.scrollY) < 50, 'and starts at the top');
  }));

  test('"Load more" keeps the keyboard where it is: the first new entry takes focus', () => journey({
    name: 'resilience-load-more-focus', seed, viewport: { width: 1280, height: 800 },
  }, async (j) => {
    const { page } = j;
    await j.goto('/history');
    await eventually(async () => assert.equal(await cards(page).count(), 30));
    const more = ui.button(page, 'Load more');
    await more.focus();
    await page.keyboard.press('Enter');
    await eventually(async () => assert.equal(await cards(page).count(), 60));
    const index = await page.evaluate(() => {
      const links = [...document.querySelectorAll('main a[href^="#/entry/"]')];
      return links.findIndex((a) => a === document.activeElement);
    });
    assert.equal(index, 30, 'focus is on the first entry of the new page (not lost to the page body)');
    // and Tab continues from there, through the new entries
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement === document.body), true);
  }));
});

describe('a reply that arrives in a few big frames', () => {
  test('is typed out progressively, finishes complete, and a local model with tiny frames adds no delay', () => journey({
    name: 'resilience-reveal',
    mocks: { local: { chunkSize: 260, delayMs: 70, replies: [`${'Gemini sends its answer in a few big pieces, so the page types it out word by word. '.repeat(10)}What stands out?`] } },
  }, async (j) => {
    const { page } = j;
    const made = await j.app.entry({ content: 'Tell me something.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.mine(page).first().waitFor();
    await ui.button(page, 'Get a reply').click();

    const lengths = [];
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      lengths.push(await page.getByRole('main').evaluate((el) => el.innerText.length));
      if (await ui.companion(page).count()) break; // the saved message replaced the live bubble
      await sleep(30);
    }
    const distinct = [...new Set(lengths)];
    const growth = distinct.filter((n, i) => i > 0 && n > distinct[i - 1]).length;
    assert.ok(growth >= 8, `the text grew in many small steps, not one jump (${growth} growth steps: ${distinct.slice(0, 12).join(', ')}...)`);
    for (let i = 1; i < distinct.length; i += 1) assert.ok(distinct[i] >= distinct[i - 1] - 40, 'it never collapses back while typing (apart from the end swap)');
    await ui.companion(page).first().waitFor();
    assert.match(await ui.companion(page).first().innerText(), /What stands out\?/, 'the whole reply is there at the end');
    assert.ok(Date.now() - started < 12_000, 'and it did not take forever');
  }));
});
