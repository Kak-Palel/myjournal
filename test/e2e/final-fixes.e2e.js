// Regression journeys for the last review round (security, quality, UX and newcomer): each test names the finding it pins.
// Roles, labels and visible text only. Several are shown to fail on the previous frontend with E2E_PUBLIC_DIR (see ../README.md).

import {
  GEMINI_KEY, PASSWORD, assert, describe, eventually, journey, seedBulk, seedEntry, test, ui,
} from './helpers.js';

const draftKeys = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mj-draft:')));
const statusBar = (page) => page.locator('.settings-status');
const cards = (page) => page.getByRole('main').locator('a[href^="#/entry/"]');

/* ------------------------------------------------------------------------------------------------------------ Today */
describe('Today', () => {
  test('"Save without reply" creates the entry and sends nothing to the AI; "Start journaling" still asks for a reply', () => journey({ name: 'today-save-without-reply' }, async (j) => {
    const { page, mock } = j;
    const chatRequests = () => mock.chatRequests().length;
    await j.goto('/');
    await ui.fillToday(page, 'This one stays between me and the page.');
    await ui.button(page, 'Save without reply').click();
    await page.waitForURL(/#\/entry\/[^?]+$/); // no ?reply=1
    await ui.mine(page).filter({ hasText: 'This one stays between me and the page.' }).waitFor();
    await page.waitForTimeout(800);
    assert.equal(chatRequests(), 0, 'nothing reached the model');
    assert.equal(await ui.companion(page).count(), 0, 'and no reply was asked for');

    await j.goto('/');
    await ui.fillToday(page, 'This one I want an answer to.');
    await ui.button(page, 'Start journaling').click();
    await page.waitForURL(/#\/entry\//);
    await ui.companion(page).first().waitFor();
    assert.ok(chatRequests() >= 1, 'Start journaling asks the model');
  }));

  test('without an AI there is only "Start journaling" (it already saves without a reply)', () => journey({ name: 'today-no-ai-no-save-button', provider: '' }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await ui.todayBox(page).waitFor();
    assert.equal(await ui.button(page, 'Save without reply').count(), 0);
    assert.equal(await ui.button(page, 'Start journaling').count(), 1);
  }));

  // Regression (ux-final): the phone tab bar stayed on top of the lower half of "Start journaling" while the keyboard was open.
  test('on a touch phone the tab bar steps aside while the writing box has focus', () => journey({
    name: 'today-keyboard-tabbar', mobile: true, viewport: { width: 390, height: 430 },
  }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await ui.todayBox(page).waitFor();
    const tabbar = page.getByRole('navigation', { name: 'Main' });
    await tabbar.waitFor();
    await ui.todayBox(page).tap();
    await ui.todayBox(page).fill('Typing with the keyboard up.');
    await eventually(async () => assert.equal(await tabbar.isVisible(), false), { message: 'the tab bar hides while typing' });
    // with nothing scrolled, what is on top at the middle of "Start journaling" must be that button, not the tab bar over it
    const covered = await ui.button(page, 'Start journaling').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 1));
      return { onTop: Boolean(top && el.contains(top)), centre: r.top + r.height / 2, tag: top ? `${top.tagName}.${top.className}` : null };
    });
    assert.equal(covered.onTop, true, `the button is not under the tab bar: ${JSON.stringify(covered)}`);
    await page.getByRole('main').click({ position: { x: 4, y: 4 } });
    await ui.todayBox(page).evaluate((el) => el.blur());
    await eventually(async () => assert.equal(await tabbar.isVisible(), true), { message: 'and returns when the box loses focus' });
  }));
});

/* ----------------------------------------------------------------------------------------------- unsent drafts */
describe('unsent drafts', () => {
  // Regression (security-final): a draft stayed in localStorage, readable without the journal password, after Sign out and after Delete everything.
  test('Sign out removes them', () => journey({ name: 'drafts-signout', password: PASSWORD, seed: 'demo' }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await ui.button(page, 'Open my journal').click();
    await ui.todayBox(page).fill('SECRET DRAFT that I did not send.');
    await eventually(async () => assert.deepEqual(await draftKeys(page), ['mj-draft:new']), { message: 'the draft to be autosaved' });
    await j.goto('/settings?tab=data');
    await page.getByRole('heading', { name: 'Access' }).waitFor();
    await page.getByText('Signing out also removes any unsent draft').waitFor();
    await ui.button(page, 'Sign out').click();
    await ui.heading(page, 'Welcome back', 1).waitFor();
    assert.deepEqual(await draftKeys(page), [], 'no draft left for the next person');
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('SECRET DRAFT'));
  }));

  test('Delete everything removes them', () => journey({ name: 'drafts-wipe', seed: 'demo' }, async (j) => {
    const { page, db } = j;
    await j.goto('/');
    await ui.todayBox(page).fill('SECRET DRAFT before the wipe.');
    await eventually(async () => assert.deepEqual(await draftKeys(page), ['mj-draft:new']));
    await j.goto('/settings?tab=data');
    await ui.button(page, 'Delete my journal data...').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE');
    await dialog.getByRole('button', { name: 'Delete everything' }).click();
    await eventually(async () => assert.equal(db.stats().entries, 0), { message: 'the journal to be wiped' });
    await eventually(async () => assert.deepEqual(await draftKeys(page), []), { message: 'the drafts to go too' });
  }));

  // The other side of the same decision: a session that merely expires is not leaving, and the draft is what keeps the text.
  test('a session that expires keeps them, and the text comes back after signing in', () => journey({ name: 'drafts-expiry', password: PASSWORD, seed: 'demo' }, async (j) => {
    const { page, context, diag } = j;
    diag.expectStatus(401, /\/api\//);
    await j.goto('/');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await ui.button(page, 'Open my journal').click();
    await ui.todayBox(page).fill('Half a thought when the session ended.');
    await eventually(async () => assert.deepEqual(await draftKeys(page), ['mj-draft:new']));
    await page.waitForLoadState('networkidle');
    await context.clearCookies();
    await page.getByRole('link', { name: 'History', exact: true }).first().click();
    await ui.heading(page, 'Welcome back', 1).waitFor();
    assert.deepEqual(await draftKeys(page), ['mj-draft:new']);
  }));
});

/* ------------------------------------------------------------------------------------------------------ Settings */
describe('Settings: feedback and what the page claims', () => {
  // Regression (ux-final, high): Test connection answered below the fold / behind the phone tab bar, so the button looked dead.
  for (const [label, mobile, viewport] of [['phone', true, { width: 390, height: 844 }], ['desktop', false, { width: 1280, height: 720 }]]) {
    test(`${label}: the result of Test connection is brought into view`, () => journey({
      name: `test-connection-visible-${label}`, mobile, viewport, mocks: { local: true, gemini: true }, provider: 'local',
    }, async (j) => {
      const { page } = j;
      await j.goto('/settings?tab=gemini');
      const key = page.getByLabel('API key', { exact: true });
      await key.fill('a-wrong-key');
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await ui.button(page, 'Test connection').click();
      const card = page.locator('.settings-result-card').first();
      await card.waitFor();
      await page.getByText('Things to try').waitFor();
      await page.waitForTimeout(700); // smooth scrolling
      const where = await page.evaluate(() => {
        const result = document.querySelector('.settings-result-card').getBoundingClientRect();
        const bar = document.querySelector('nav.tabbar');
        const barTop = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().top : innerHeight;
        return { top: result.top, bottom: result.bottom, barTop, vh: innerHeight };
      });
      assert.ok(where.top >= 0 && where.top < where.barTop - 40, `the result starts on screen above the tab bar: ${JSON.stringify(where)}`);
      assert.ok(where.bottom <= where.barTop + 1 || where.top <= 80, `and shows its end (or fills the screen): ${JSON.stringify(where)}`);
    }));
  }

  // Regression (ux-final): after a good test of a provider that is not in use, the card said "Press Save", which does not switch to it.
  test('after a good test the card names the button that does the job', () => journey({
    name: 'looks-good-hint', mocks: { local: true, gemini: true }, provider: 'local',
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=gemini');
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected').waitFor();
    const text = await page.locator('.settings-result-card').innerText();
    assert.match(text, /Press “Use this provider” to start journaling with it \(Save only keeps these settings\)/);
    assert.doesNotMatch(text, /Press Save/);
    // the provider already in use with a change not saved yet: Save is right
    await j.goto('/settings?tab=local');
    const model = page.getByLabel('Model', { exact: true });
    await model.fill('mock-model');
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected').waitFor();
    await page.getByText('Looks good. Press Save to keep these settings.').waitFor();
  }));

  // Regression (ux-final): a flex <summary> draws no triangle, so a closed section looked like a plain label.
  test('closed sections show a disclosure marker that turns when they open', () => journey({ name: 'disclosure-marker', mocks: { local: true, gemini: true } }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=gemini');
    const summary = page.getByText('Advanced', { exact: true });
    await summary.waitFor();
    const marker = () => summary.evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      return { content: after.content, transform: after.transform, style: getComputedStyle(el).listStyleType };
    });
    const closed = await marker();
    assert.notEqual(closed.content, 'none', 'a chevron is drawn');
    assert.equal(closed.style, 'none', 'and it is the only marker');
    await summary.click();
    await page.waitForTimeout(400); // the chevron turns over 0.15 s
    const open = await marker();
    assert.notEqual(open.transform, closed.transform, 'it turns when the section opens');
  }));

  // Regression (ux-final, newcomer): "Ready" and "In use" were shown for a local model nobody had checked.
  test('a local model that the server lists is Ready and In use', () => journey({ name: 'local-ready' }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=local');
    await statusBar(page).getByText('Ready').waitFor();
    await page.getByText('In use', { exact: true }).first().waitFor();
  }));

  test('a local model the server does not list is "Model not installed", only Selected, with no green badge', () => journey({
    name: 'local-missing', settings: { ai: { providers: { local: { model: 'not-downloaded:7b' } } } },
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=local');
    await statusBar(page).getByText('Model not installed').waitFor();
    assert.equal(await statusBar(page).getByText('Ready').count(), 0);
    await page.getByText('Selected', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('In use', { exact: true }).count(), 0);
    assert.doesNotMatch(await ui.tab(page, 'Local model').innerText(), /In use/);
  }));

  test('when nobody could check the model: "Not tested yet", and a passing Test connection makes it Ready', () => journey({
    name: 'local-unchecked', mocks: { local: { modelsFailures: 'not_found' } },
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=local');
    await statusBar(page).getByText('Not tested yet').waitFor();
    assert.equal(await statusBar(page).getByText('Ready').count(), 0);
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected').waitFor();
    await statusBar(page).getByText('Ready').waitFor();
    assert.equal(await statusBar(page).getByText('Not tested yet').count(), 0);
  }));

  // Regression (ux-final): a chosen provider that "Needs a key" carried a green "In use" and a tab badge.
  test('a hosted provider without a key is "Needs a key" and only Selected', () => journey({
    name: 'needs-key-not-in-use', provider: 'gemini', settings: { ai: { providers: { gemini: { apiKey: '' } } } },
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=gemini');
    await statusBar(page).getByText('Needs a key').waitFor();
    await page.getByText('Selected', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('In use', { exact: true }).count(), 0);
    assert.doesNotMatch(await ui.tab(page, 'Gemini').innerText(), /In use/);
  }));

  // Regression (ux-final): the API key field of the first Gemini setup screen was below the fold at 1440x900.
  test('first-run Gemini setup shows the API key field without scrolling', () => journey({
    name: 'gemini-setup-key-visible', fresh: true, onboarded: true, viewport: { width: 1440, height: 900 },
    settings: { ai: { provider: 'gemini' } },
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=gemini&setup=1');
    const key = page.getByLabel('API key', { exact: true });
    await key.waitFor();
    const box = await key.boundingBox();
    assert.ok(box && box.y + box.height <= 900, `the key field is on the first screen: ${JSON.stringify(box)}`);
  }));
});

/* --------------------------------------------------------------------------------------------------------- Memory */
describe('Memory', () => {
  // Regression (ux-final): the page ignored an AI that was off and promised suggestions that cannot happen.
  test('says so when no AI companion is on, and the empty state stops promising suggestions', () => journey({ name: 'memory-ai-off', provider: '' }, async (j) => {
    const { page } = j;
    await j.goto('/memory');
    await ui.heading(page, 'Memory', 1).waitFor();
    await page.getByText('No AI companion is set up').waitFor();
    await page.getByRole('main').getByRole('link', { name: 'Set up AI' }).waitFor();
    await page.getByText(/It is used once an AI companion is switched on/).waitFor();
    assert.equal(await page.getByText(/your companion may suggest short facts/).count(), 0);
  }));

  test('and when the AI is switched off, the notice offers to turn it on', () => journey({ name: 'memory-ai-switched-off', settings: { ai: { enabled: false } } }, async (j) => {
    const { page } = j;
    await j.goto('/memory');
    await ui.heading(page, 'Memory', 1).waitFor();
    await page.getByText('The AI companion is switched off').waitFor();
    await page.getByRole('main').getByRole('link', { name: 'Turn AI on' }).waitFor();
  }));

  test('with the AI on there is no such notice', () => journey({ name: 'memory-ai-on' }, async (j) => {
    const { page } = j;
    await j.goto('/memory');
    await ui.heading(page, 'Memory', 1).waitFor();
    await page.getByText(/your companion may suggest short facts/).waitFor();
    assert.equal(await page.getByText('No AI companion is set up').count(), 0);
    assert.equal(await page.getByText('The AI companion is switched off').count(), 0);
  }));

  // Regression (quality-final, ux-final): "switch off Suggest memories ..." kept showing under that switch after it was off.
  test('the small-model warning goes once Suggest memories is switched off', () => journey({
    name: 'small-model-warning-follows-switch', settings: { ai: { providers: { local: { model: 'llama3.2:1b' } } } },
  }, async (j) => {
    const { page } = j;
    await j.goto('/memory');
    const warning = page.getByTestId('small-model-warning');
    await warning.getByText('Small models (under about 3B) often write poor memory notes.').waitFor();
    await ui.flip(page, 'Suggest memories when I wrap up an entry');
    await eventually(async () => assert.equal(await warning.getByText('Small models').count(), 0), { message: 'the warning to go' });
    await ui.flip(page, 'Suggest memories when I wrap up an entry');
    await warning.getByText('Small models (under about 3B)').waitFor();
  }));
});

/* -------------------------------------------------------------------------------------------------------- History */
describe('History', () => {
  // Regression (quality-final): the list comes in the order the entries were written but the headings are the entry's own date, so a
  // backdated entry started a second "October" in the middle of the list.
  test('a backdated entry joins its own month instead of repeating a heading', () => journey({
    name: 'history-backdated',
    seed: (db) => {
      const now = Date.now();
      const today = new Date(now);
      const pad = (n) => String(n).padStart(2, '0');
      const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      seedEntry(db, { title: 'First today', date, createdAt: now - 3000, messages: [['user', 'one']] });
      seedEntry(db, { title: 'Backdated', date: '2020-08-15', createdAt: now - 2000, messages: [['user', 'two']] });
      seedEntry(db, { title: 'Second today', date, createdAt: now - 1000, messages: [['user', 'three']] });
    },
  }, async (j) => {
    const { page } = j;
    await j.goto('/history');
    await eventually(async () => assert.equal(await cards(page).count(), 3));
    const headings = await page.getByRole('main').getByRole('heading', { level: 2 }).allTextContents();
    assert.equal(headings.length, 2, `one heading per month: ${JSON.stringify(headings)}`);
    assert.equal(new Set(headings).size, 2);
    assert.equal(headings[1], 'August 2020');
    const titles = await page.getByRole('main').getByRole('heading', { level: 3 }).allTextContents();
    assert.deepEqual(titles, ['Second today', 'First today', 'Backdated'], 'in date order, under the right heading');
  }));

  // Regression (ux-final): an untitled entry showed its first words as the title and again as the text below.
  test('an untitled entry does not repeat its words under its title', () => journey({
    name: 'history-untitled-once',
    seed: (db) => {
      seedEntry(db, { title: '', messages: [['user', 'Garage day. My back hurts but I found my old guitar.']] });
      seedEntry(db, { title: '', messages: [['user', 'Woke up late and missed the bus because my alarm did not go off, so I walked to work in the rain and thought about moving somewhere warmer.']] });
    },
  }, async (j) => {
    const { page } = j;
    await j.goto('/history');
    await eventually(async () => assert.equal(await cards(page).count(), 2));
    const text = await page.getByRole('main').innerText();
    assert.equal(text.split('Garage day.').length - 1, 1, `the short entry's words appear once:\n${text}`);
    assert.equal(text.split('Woke up late and missed the bus').length - 1, 1, `and so do the long one's:\n${text}`);
    assert.match(text, /somewhere warmer\./, 'the rest of the long entry is still shown');
  }));
});

/* ----------------------------------------------------------------------------------------------------- entry page */
describe('Entry page without an AI', () => {
  // Regression (ux-final): a green, enabled "Save entry" under an empty box read as "this is not saved yet".
  test('"Save entry" is not the primary button while the box is empty, and the page says what is saved', () => journey({ name: 'entry-save-entry-quiet', provider: '' }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await ui.startJournaling(page, 'The first message, already saved.');
    const save = ui.button(page, 'Save entry');
    await save.waitFor();
    await page.getByText('Everything you have written is saved.').waitFor();
    assert.doesNotMatch(await save.getAttribute('class'), /btn-primary/);
    await ui.entryBox(page).fill('More to add.');
    await eventually(async () => assert.match(await save.getAttribute('class'), /btn-primary/), { message: 'primary once there is something to save' });
    assert.equal(await page.getByText('Everything you have written is saved.').count(), 0);
  }));
});

/* ------------------------------------------------------------------------------------------------------- bulk data */
describe('History search', () => {
  // Quick sanity that the paging keeps its place after a filter is cleared (the main pins are in history.e2e.js).
  test('clearing the search brings back the dated list from the start', () => journey({ name: 'history-search-then-clear', seed: (db) => seedBulk(db, 40, { startHoursAgo: 2 }) }, async (j) => {
    const { page } = j;
    await j.goto('/history');
    await eventually(async () => assert.equal(await cards(page).count(), 30));
    await page.getByRole('searchbox', { name: 'Search your entries' }).fill('ordinary');
    await page.getByText('Showing the best 30 matches for “ordinary”').waitFor();
    await page.getByRole('searchbox', { name: 'Search your entries' }).fill('');
    await eventually(async () => assert.equal(await page.getByText(/matches for/).isVisible(), false), { message: 'the match count to go' });
    await eventually(async () => assert.equal(await cards(page).count(), 30));
    assert.equal(await page.getByRole('main').getByRole('heading', { level: 2 }).count() >= 1, true, 'month headings are back (the list is no longer ranked)');
  }));
});

void GEMINI_KEY;
