// Journey 12c: how the app looks. Dark mode follows the device and has no forgotten light surfaces, text meets WCAG AA
// contrast in both schemes on every page, and reduced motion really stops the endless animations.

import {
  assert, auditContrast, auditLightSurfaces, describe, journey, seedEntry, seedSampleJournal, test, ui,
} from './helpers.js';

const seed = (db) => {
  seedSampleJournal(db);
  seedEntry(db, {
    title: 'Reply with everything', tags: ['work'], emotions: ['calm'], mood: 4,
    messages: [['user', 'A line of my own.'], ['assistant', 'A reply with **bold**, *italic* and a list:\n\n- one\n- two', { kind: 'reply' }], ['assistant', 'A reflection.', { kind: 'wrapup' }]],
  });
};

// Two confirmed contrast problems are pinned down in their own (skipped) tests below; the general checks leave them out so
// that everything ELSE stays protected.
const ACTIVE_NAV_AND_PILL = ['[aria-current="page"]', 'a[href="#/settings"][title]'];
const DANGER_BUTTON_IN_DIALOG = ['dialog button[class*="danger"]'];

/** Every page worth looking at, including every Settings tab. */
async function routes(j) {
  const entry = j.db.entries.list({ limit: 50 }).find((e) => e.title === 'Reply with everything');
  return ['/', '/welcome', '/history', '/history?q=pancakes', '/insights', '/memory', '/settings?tab=gemini', '/settings?tab=openai', '/settings?tab=local',
    '/settings?tab=general', '/settings?tab=data', `/entry/${entry.id}`];
}

async function visit(j, path) {
  await j.load(path);
  await j.page.getByRole('main').getByRole('heading').first().waitFor();
  await j.page.waitForTimeout(500);
}

describe('dark mode', () => {
  test('follows the device on every page: dark background, native controls dark, no forgotten light surfaces', () => journey({
    name: 'appearance-dark', colorScheme: 'dark', seed,
  }, async (j) => {
    const { page } = j;
    for (const path of await routes(j)) {
      await visit(j, path);
      const info = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        scheme: getComputedStyle(document.documentElement).colorScheme,
        bg: getComputedStyle(document.body).backgroundColor,
        fg: getComputedStyle(document.body).color,
      }));
      assert.equal(info.theme, 'auto', `${path}: the default follows the device`);
      assert.match(info.scheme, /dark/, `${path}: color-scheme lets native controls go dark (${info.scheme})`);
      const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
      assert.ok(lum(info.bg) < 0.25, `${path}: dark page background (${info.bg})`);
      assert.ok(lum(info.fg) > 0.6, `${path}: light text (${info.fg})`);
      assert.deepEqual(await auditLightSurfaces(page), [], `${path}: no light surfaces in dark mode`);
    }
  }));

  test('dialogs, menus, notices and toasts are themed and readable in dark mode', () => journey({
    name: 'appearance-dark-overlays', colorScheme: 'dark', seed,
  }, async (j) => {
    const { page, db } = j;
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Reply with everything');
    await j.goto(`/entry/${entry.id}`);
    await ui.mine(page).first().waitFor();
    await page.getByRole('button', { name: 'Entry options' }).click();
    await page.getByRole('menu', { name: 'Entry options' }).waitFor();
    assert.deepEqual(await auditLightSurfaces(page), [], 'the open menu is dark');
    await page.getByRole('menuitem', { name: /Delete entry/ }).click();
    await page.getByRole('dialog').waitFor();
    assert.deepEqual(await auditLightSurfaces(page), [], 'the open dialog is dark');
    assert.deepEqual(await auditContrast(page, { ignore: DANGER_BUTTON_IN_DIALOG }), [], 'the dialog text is readable');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await j.goto('/memory');
    await page.getByRole('button', { name: 'Pin this memory' }).first().click();
    await page.getByRole('status').filter({ hasText: /Pinned to the top|Unpinned/ }).waitFor();
    // (toasts are deliberately inverted - a light card on the dark page - so only their readability is checked)
    assert.deepEqual(await auditContrast(page, { ignore: ACTIVE_NAV_AND_PILL }), [], 'a toast is readable');
    await page.getByRole('status').filter({ hasText: /Pinned to the top|Unpinned/ }).waitFor({ state: 'detached', timeout: 6000 });

    await j.goto('/settings?tab=local');
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected', { exact: true }).waitFor();
    assert.deepEqual(await auditContrast(page, { ignore: ACTIVE_NAV_AND_PILL }), [], 'a success notice is readable');
    await page.getByLabel('Base URL', { exact: true }).fill('http://127.0.0.1:9/v1');
    await ui.button(page, 'Test connection').click();
    await page.getByRole('alert').filter({ hasText: 'Things to try' }).waitFor();
    assert.deepEqual(await auditContrast(page, { ignore: ACTIVE_NAV_AND_PILL }), [], 'an error notice is readable');
    assert.deepEqual(await auditLightSurfaces(page), []);
  }));
});

describe('contrast (WCAG AA)', () => {
  for (const scheme of ['light', 'dark']) {
    test(`text is readable in ${scheme} mode on every page`, () => journey({
      name: `appearance-contrast-${scheme}`, colorScheme: scheme, seed,
    }, async (j) => {
      const { page } = j;
      for (const path of await routes(j)) {
        await visit(j, path);
        const bad = await auditContrast(page, { ignore: ACTIVE_NAV_AND_PILL });
        assert.deepEqual(bad, [], `${path} (${scheme}): text below 4.5:1 (3:1 for large text)`);
      }
    }));
  }

  test('danger buttons in dialogs are readable in light mode', () => journey({ name: 'appearance-contrast-danger-light', colorScheme: 'light', seed }, async (j) => {
    const { page, db } = j;
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Reply with everything');
    await j.goto(`/entry/${entry.id}`);
    await ui.mine(page).first().waitFor();
    await page.getByRole('button', { name: 'Entry options' }).click();
    await page.getByRole('menuitem', { name: /Delete entry/ }).click();
    await page.getByRole('dialog').waitFor();
    assert.deepEqual(await auditContrast(page, { only: ['dialog'] }), []);
  }));

  // Confirmed with the audit above (repeatable): --primary (#4f7a5f) text on --primary-soft (#e3eee6) is 4.12:1, below 4.5:1,
  // for the active navigation item and the AI pill in the sidebar (light mode). Proposed: a darker text colour such as #476f56
  // (4.80:1) for text that sits on --primary-soft (.nav-link.is-active, .tab-link.is-active, .ai-pill, .chip-primary).
  test('the active navigation item and the AI pill meet AA in light mode', { skip: 'BUG: base.css - var(--primary) on var(--primary-soft) is 4.12:1 (needs 4.5) for the active nav item and the sidebar AI pill; use e.g. #476f56 (4.80:1) for text on --primary-soft' }, () => journey({
    name: 'appearance-contrast-nav-light', colorScheme: 'light', seed,
  }, async (j) => {
    const { page } = j;
    await visit(j, '/history');
    assert.deepEqual(await auditContrast(page, { only: ACTIVE_NAV_AND_PILL }), []);
  }));

  // Confirmed (repeatable): white text on the dark-theme danger colour #ee8c7b is 2.42:1 (needs 4.5:1) - "Delete entry",
  // "Forget", "Delete everything" and every other danger button in dark mode. Proposed: dark ink (#1f0b07 gives 7.8:1) for
  // .btn-danger under the dark theme, as the dark toasts already do.
  test('danger buttons in dialogs are readable in dark mode', { skip: 'BUG: base.css - .btn-danger is #fff on #ee8c7b (2.42:1) in dark mode; use dark text such as #1f0b07 (7.8:1) under the dark theme' }, () => journey({
    name: 'appearance-contrast-danger-dark', colorScheme: 'dark', seed,
  }, async (j) => {
    const { page, db } = j;
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Reply with everything');
    await j.goto(`/entry/${entry.id}`);
    await ui.mine(page).first().waitFor();
    await page.getByRole('button', { name: 'Entry options' }).click();
    await page.getByRole('menuitem', { name: /Delete entry/ }).click();
    await page.getByRole('dialog').waitFor();
    assert.deepEqual(await auditContrast(page, { only: DANGER_BUTTON_IN_DIALOG }), []);
  }));
});

describe('reduced motion', () => {
  test('with "reduce motion" no endless animation runs; without it the thinking dots do move', () => journey({
    name: 'appearance-motion', mocks: { local: { ttfbMs: 1500, delayMs: 100, replies: ['A reply that takes a while to arrive, word by word, for the motion check.'] } },
  }, async (j) => {
    const { page } = j;
    const endless = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.getTiming().iterations === Infinity).length);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await j.goto('/');
    await ui.startJournaling(page, 'Checking whether things move.');
    await page.getByRole('article', { name: 'Reply in progress' }).waitFor();
    await page.waitForTimeout(300);
    assert.ok((await endless()) > 0, 'the control: the thinking dots animate when motion is allowed');
    await ui.companion(page).first().waitFor({ timeout: 15_000 });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const made = await j.app.entry({ content: 'A second entry for the reduced-motion check.' });
    j.mock.setBehavior({ replies: ['Another reply that also takes a while to arrive, for the reduced motion check.'] });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').click();
    await page.getByRole('article', { name: 'Reply in progress' }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await endless(), 0, 'no looping animation while waiting for the reply');
    await ui.companion(page).first().waitFor({ timeout: 15_000 });
    // transitions are not slowed down for people who asked for less motion either
    const slow = await page.evaluate(() => [...document.querySelectorAll('button, a, .toast')].filter((el) => parseFloat(getComputedStyle(el).transitionDuration) > 0.3).length);
    assert.equal(slow, 0, 'no long transitions');
  }));
});
