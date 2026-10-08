// Journey 12b: phones and desktops. Every route fits a 390x844 (and a 360x740) screen without sideways scrolling, the bottom
// tab bar replaces the sidebar, hostile content (very long words) cannot push the layout wide, and the core flow works
// with touch.

import { assert, describe, eventually, journey, seedEntry, seedSampleJournal, test, ui } from './helpers.js';

const LONG_WORD = 'Supercalifragilistic'.repeat(14);
const LONG_URL = `https://example.com/${'a'.repeat(220)}`;

const seed = (db) => {
  seedSampleJournal(db);
  seedEntry(db, {
    title: `A title with ${LONG_WORD}`,
    tags: ['averyveryverylongtagnamethatgoesonandon'],
    emotions: ['overwhelmedandrestlessandtired'],
    messages: [
      ['user', `${LONG_WORD} and a link ${LONG_URL}\n\n${'Many words in a long paragraph. '.repeat(40)}`],
      ['assistant', `A reply with a long token ${LONG_WORD} and **bold** text.\n\n- item ${LONG_WORD}\n- another`, { kind: 'reply' }],
    ],
  });
};

/** Wait until the page shows its first heading and lazy sections have had time to arrive. */
async function settle(page) {
  await page.getByRole('main').getByRole('heading').first().waitFor();
  await page.waitForTimeout(500);
}

const sideways = (page) => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth, body: document.body.scrollWidth }));

/** The elements that stick out of the viewport on the right (for a useful failure message). */
const culprits = (page) => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!el.checkVisibility() || el.closest('.sr-only, .skip-link')) continue;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 30)}" right=${Math.round(r.right)}`);
  }
  return out.slice(0, 6);
});

describe('phone layouts', () => {
  for (const [width, height] of [[390, 844], [360, 740]]) {
    test(`${width}x${height}: every route fits the screen and uses the bottom tab bar`, () => journey({
      name: `responsive-${width}`, viewport: { width, height }, mobile: true, seed,
    }, async (j) => {
      const { page, db } = j;
      const long = db.entries.list({ limit: 50 }).find((e) => e.title.startsWith('A title with'));
      const plain = db.entries.list({ limit: 50 }).find((e) => e.title === 'Presentation day');
      const routes = [
        '/', '/welcome', '/history', '/history?q=pancakes', '/insights', '/memory',
        '/settings?tab=gemini', '/settings?tab=openai', '/settings?tab=local', '/settings?tab=general', '/settings?tab=data',
        `/entry/${long.id}`, `/entry/${plain.id}`,
      ];
      for (const path of routes) {
        await j.load(path);
        await settle(page);
        const w = await sideways(page);
        assert.ok(w.scroll <= w.inner, `${path}: no sideways scrolling (page ${w.scroll}px in a ${w.inner}px window): ${(await culprits(page)).join('; ')}`);
        assert.ok(await ui.noHorizontalScroll(page), `${path}: documentElement.scrollWidth <= innerWidth`);

        // exactly one main navigation, at the bottom edge, full width, with comfortable touch targets
        const nav = page.getByRole('navigation', { name: 'Main' });
        if (path !== '/welcome') {
          assert.equal(await nav.count(), 1, `${path}: one main navigation is on screen (the sidebar is hidden)`);
          const box = await nav.boundingBox();
          assert.ok(Math.abs(box.y + box.height - height) <= 1, `${path}: the tab bar sits at the bottom edge (${JSON.stringify(box)})`);
          assert.ok(box.width >= width - 1);
          for (const link of await nav.getByRole('link').all()) {
            const b = await link.boundingBox();
            assert.ok(b.height >= 44, `${path}: tab bar target is at least 44px high (${Math.round(b.height)})`);
          }
        }
      }
    }));
  }

  test('long words in titles, entries and chips wrap instead of stretching the page, in History, Today and the entry', () => journey({
    name: 'responsive-long-words', viewport: { width: 360, height: 740 }, mobile: true, seed,
  }, async (j) => {
    const { page, db } = j;
    const long = db.entries.list({ limit: 50 }).find((e) => e.title.startsWith('A title with'));
    await j.load(`/entry/${long.id}`);
    await settle(page);
    const bubble = ui.mine(page).first();
    await bubble.waitFor();
    const box = await bubble.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 360, `the long message stays inside the screen: ${JSON.stringify(box)}`);
    // the composer stays above the tab bar and inside the screen
    const composer = ui.entryBox(page);
    const cb = await composer.boundingBox();
    const nb = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
    assert.ok(cb.y + cb.height <= nb.y + 1, 'the composer is not hidden behind the tab bar');
    assert.ok(cb.x >= 0 && cb.x + cb.width <= 360);
    for (const path of ['/', '/history']) {
      await j.load(path);
      await settle(page);
      assert.ok(await ui.noHorizontalScroll(page), `${path}: ${(await culprits(page)).join('; ')}`);
    }
  }));

  test('menus, dialogs and toasts fit on a phone', () => journey({
    name: 'responsive-overlays', viewport: { width: 360, height: 740 }, mobile: true, seed,
  }, async (j) => {
    const { page, db } = j;
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Presentation day');
    await j.load(`/entry/${entry.id}`);
    await settle(page);

    await page.getByRole('button', { name: 'Entry options' }).click();
    const menu = page.getByRole('menu', { name: 'Entry options' });
    await menu.waitFor();
    const mb = await menu.boundingBox();
    assert.ok(mb.x >= 0 && mb.x + mb.width <= 360 && mb.y >= 0 && mb.y + mb.height <= 740, `the menu is fully on screen: ${JSON.stringify(mb)}`);
    await page.getByRole('menuitem', { name: /Delete entry/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this entry?' });
    await dialog.waitFor();
    const db1 = await dialog.boundingBox();
    assert.ok(db1.x >= 0 && db1.x + db1.width <= 360 && db1.y >= 0 && db1.y + db1.height <= 740, `the dialog fits: ${JSON.stringify(db1)}`);
    for (const b of await dialog.getByRole('button').all()) {
      const bb = await b.boundingBox();
      assert.ok(bb.x >= 0 && bb.x + bb.width <= 360, 'dialog buttons are reachable');
    }
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // a toast
    const wasPinned = db.entries.get(entry.id).pinned;
    await page.getByRole('button', { name: 'Entry options' }).click();
    await page.getByRole('menuitem', { name: /Pin entry|Unpin entry/ }).click();
    await eventually(() => assert.equal(db.entries.get(entry.id).pinned, !wasPinned));
    await j.goto('/memory');
    await page.getByRole('button', { name: 'Pin this memory' }).first().click();
    const toast = page.getByRole('status').filter({ hasText: /Pinned to the top|Unpinned/ });
    await toast.waitFor();
    const tb = await toast.boundingBox();
    assert.ok(tb.x >= 0 && tb.x + tb.width <= 360, `the toast fits: ${JSON.stringify(tb)}`);
    assert.ok(await ui.noHorizontalScroll(page));
  }));

  test('the core flow works with touch: write, tap Start, get a reply, wrap up', () => journey({
    name: 'responsive-touch-flow', viewport: { width: 390, height: 844 }, mobile: true, mocks: { local: { delayMs: 5 } },
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/');
    await ui.todayBox(page).tap();
    await page.keyboard.type('Writing this on my phone while waiting for the bus. I love early mornings.');
    await ui.mood(page, 'Good').tap();
    const start = page.getByRole('button', { name: 'Start journaling' });
    const sb = await start.boundingBox();
    assert.ok(sb.y + sb.height <= 844 - 60 || sb.y >= 0, 'the Start button is reachable');
    await start.tap();
    await page.waitForURL(/#\/entry\//);
    await ui.companion(page).first().waitFor();
    assert.ok(await ui.noHorizontalScroll(page));

    await ui.button(page, 'Wrap up').tap();
    const summary = page.getByRole('region', { name: 'Entry summary' });
    await summary.waitFor({ timeout: 20_000 });
    const box = await summary.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'the summary fits');
    assert.ok(await ui.noHorizontalScroll(page));
    assert.equal(db.entries.list({ limit: 5 })[0].status, 'wrapped');

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'History' }).tap();
    await ui.heading(page, 'History', 1).waitFor();
    await page.getByRole('link', { name: /./ }).filter({ hasText: /./ }).first().waitFor();
    assert.ok(await ui.noHorizontalScroll(page));
  }));

  test('the login screen fits a phone too', () => journey({
    name: 'responsive-login', viewport: { width: 360, height: 740 }, mobile: true, password: 'a long enough passphrase',
  }, async (j) => {
    const { page, diag } = j;
    diag.expectStatus(401, /\/api\//);
    await j.goto('/');
    await ui.heading(page, 'Welcome back', 1).waitFor();
    assert.ok(await ui.noHorizontalScroll(page));
    const field = await page.getByLabel('Password', { exact: true }).boundingBox();
    assert.ok(field.x >= 0 && field.x + field.width <= 360);
  }));
});

describe('desktop layout', () => {
  test('the sidebar appears from 900px, the tab bar below it; the content column stays readable on wide screens', () => journey({
    name: 'responsive-desktop', seed: 'demo',
  }, async (j) => {
    const { page, db } = j;
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Presentation day');
    await j.goto('/history');
    await settle(page);
    const nav = page.getByRole('navigation', { name: 'Main' });

    for (const [w, h, expectSidebar] of [[1440, 900, true], [1024, 768, true], [900, 700, true], [899, 700, false], [768, 1024, false]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(150);
      assert.equal(await nav.count(), 1, `${w}px: exactly one main navigation`);
      const box = await nav.boundingBox();
      if (expectSidebar) {
        assert.ok(box.x < 60 && box.width < 320 && box.y < h / 2 && box.height < h / 2, `${w}px: a sidebar on the left (${JSON.stringify(box)})`);
      } else {
        assert.ok(box.y + box.height >= h - 1 && box.width >= w - 1, `${w}px: a tab bar along the bottom (${JSON.stringify(box)})`);
      }
      assert.ok(await ui.noHorizontalScroll(page), `${w}px: no sideways scrolling`);
    }

    // on a very wide screen the reading column does not stretch across the whole window
    await page.setViewportSize({ width: 1920, height: 1000 });
    await j.goto(`/entry/${entry.id}`);
    await ui.mine(page).first().waitFor();
    const bubble = await ui.mine(page).first().boundingBox();
    assert.ok(bubble.width <= 900, `message bubbles keep a readable width on 1920px screens (${Math.round(bubble.width)}px)`);
    const thread = await page.getByRole('region', { name: 'Conversation' }).boundingBox();
    assert.ok(thread.width <= 1000, `the conversation column is limited (${Math.round(thread.width)}px)`);
  }));

  test('zoomed to 200% (a 640px layout) nothing breaks and nothing needs sideways scrolling', () => journey({
    name: 'responsive-zoom', seed: 'demo', viewport: { width: 640, height: 450 },
  }, async (j) => {
    const { page, db } = j;
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Presentation day');
    for (const path of ['/', '/history', '/memory', '/settings?tab=general', '/settings?tab=local', `/entry/${entry.id}`, '/insights']) {
      await j.load(path);
      await settle(page);
      assert.ok(await ui.noHorizontalScroll(page), `${path}: ${(await culprits(page)).join('; ')}`);
    }
  }));
});
