// Journey 22: what the live verification rounds (real Gemini, real Ollama / llama.cpp, a browser audit) turned up, each pinned
// to the behaviour it needs: the Gemini "Thinking" wording, the composer toolbar on a phone, honest privacy wording, the
// browser's date in reply and wrap-up requests, installed local models, safe initial focus in destructive dialogs, a welcome
// screen that notices keys in the server's environment, and a writing box that stays above an on-screen keyboard.
// (Error banners with "Open settings" live in provider-errors / gemini; deep links through the password screen in auth.)

import {
  GEMINI_KEY, OPENAI_KEY, assert, describe, eventually, journey, pageContainsSecret, seedEntry, test, ui,
} from './helpers.js';

/* ------------------------------------------------------------------------------------------------------------ */
/* Gemini: "Thinking"                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

describe('Gemini: the Thinking option', () => {
  test('"Low" is described as less thinking, not as faster, and the hint says to leave Auto on Flash-Lite', () => journey({
    name: 'fixes-thinking-copy', fresh: true, onboarded: true, mocks: { gemini: true },
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=gemini');
    await page.getByText('Advanced', { exact: true }).click();
    const thinking = page.getByLabel('Thinking');
    assert.deepEqual(await thinking.locator('option').allInnerTexts(), ['Auto (recommended)', 'Low - less thinking']);
    assert.equal(await page.getByText('faster replies').count(), 0, 'no promise of speed');
    const hint = page.getByText(/Flash-Lite does not think, so Low makes it slower/);
    await hint.waitFor();
    assert.match(await hint.innerText(), /gemini-3\.5-flash and up/);
    assert.match(await hint.innerText(), /leave Auto there/);
    // the value stored is still "low"
    await thinking.selectOption({ label: 'Low - less thinking' });
    assert.equal(await thinking.inputValue(), 'low');
  }));
});

describe('Settings on a phone', () => {
  for (const width of [360, 375, 390, 412]) {
    test(`the model name is not cut off next to "Load models" at ${width} px`, () => journey({
      name: `fixes-model-field-${width}`, fresh: true, onboarded: true, mobile: true, viewport: { width, height: 800 },
    }, async (j) => {
      const { page } = j;
      await j.goto('/settings?tab=gemini');
      const model = page.getByLabel('Model', { exact: true });
      await model.waitFor();
      assert.equal(await model.inputValue(), 'gemini-flash-lite-latest');
      const overflow = await model.evaluate((el) => el.scrollWidth - el.clientWidth);
      assert.ok(overflow <= 0, `the whole name fits in the field (scrollWidth - clientWidth = ${overflow})`);
      const box = await model.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, 'and the field is inside the screen');
      assert.equal(await ui.noHorizontalScroll(page), true);
    }));
  }
});

/* ------------------------------------------------------------------------------------------------------------ */
/* The composer toolbar on a phone                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

describe('composer toolbar on a phone', () => {
  for (const width of [360, 390]) {
    test(`"Wrap up again" is not cut off at ${width} px`, () => journey({
      name: `fixes-wrap-again-${width}`, seed: 'demo', mobile: true, viewport: { width, height: 800 },
    }, async (j) => {
      const { page, db } = j;
      const wrapped = db.entries.list({ limit: 50 }).find((e) => e.title === 'Presentation day');
      assert.equal(wrapped.status, 'wrapped');
      await j.goto(`/entry/${wrapped.id}`);
      const again = page.getByRole('button', { name: 'Wrap up again' }); // its accessible name keeps the full words
      await again.waitFor();
      const box = await again.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `inside the screen: ${JSON.stringify(box)}`);
      const clipped = await again.evaluate((button) => [button, ...button.querySelectorAll('span')].some((el) => el.scrollWidth > el.clientWidth + 1));
      assert.equal(clipped, false, 'no label is clipped (no "Wrap up ag...")');
      const label = (await again.innerText()).trim();
      assert.ok(!label.includes('…') && !label.includes('...'), `the visible label is whole: "${label}"`);
      assert.match(label, /^Wrap up/);
      // every control of the toolbar is fully on screen and none overlaps another
      const boxes = [];
      for (const name of ['Dictate', 'Wrap up again', 'Save without reply', 'Send']) {
        const b = await page.getByRole('button', { name }).first().boundingBox();
        assert.ok(b, `${name} is shown`);
        assert.ok(b.x >= 0 && b.x + b.width <= width + 0.5, `${name} fits the width: ${JSON.stringify(b)}`);
        boxes.push({ name, ...b });
      }
      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          const [p, q] = [boxes[a], boxes[b]];
          const overlap = p.x < q.x + q.width - 0.5 && q.x < p.x + p.width - 0.5 && p.y < q.y + q.height - 0.5 && q.y < p.y + p.height - 0.5;
          assert.equal(overlap, false, `${p.name} and ${q.name} do not overlap`);
        }
      }
      assert.equal(await ui.noHorizontalScroll(page), true);
    }));
  }

  test('on a desktop the full words are shown; an entry that was never wrapped says just "Wrap up"', () => journey({
    name: 'fixes-wrap-again-desktop', seed: 'demo',
  }, async (j) => {
    const { page, db } = j;
    const entries = db.entries.list({ limit: 50 });
    const wrapped = entries.find((e) => e.title === 'Presentation day');
    await j.goto(`/entry/${wrapped.id}`);
    const again = page.getByRole('button', { name: 'Wrap up again' });
    await again.waitFor();
    assert.equal((await again.innerText()).trim(), 'Wrap up again');
    const open = entries.find((e) => e.status === 'open');
    await j.goto(`/entry/${open.id}`);
    await ui.button(page, 'Wrap up').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Wrap up again' }).count(), 0);
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* Privacy wording                                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

const STILL_WRITTEN = 'Replies in a private entry are still written by your AI provider; use Save without reply to keep text away from it.';

describe('privacy wording', () => {
  test('Settings > Data lists everything a reply sends to the provider', () => journey({ name: 'fixes-privacy-data' }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=data');
    await page.getByRole('heading', { name: 'Where your data lives' }).waitFor();
    const paragraph = page.getByText(/^Nothing leaves your computer unless the AI companion is on\./);
    const text = await paragraph.innerText();
    for (const part of ['the current conversation', 'today\'s date', 'your name and "About you" text', 'your memories', 'the mood you logged', 'a guided session\'s instructions',
      'if "Recall related past entries" is on', 'short excerpts of older entries (never private ones)', 'to the provider you chose, and nothing else.']) {
      assert.ok(text.includes(part), `says: ${part}\n  got: ${text}`);
    }
  }));

  test('"Private" says replies are still written by the provider: menu, flag tooltip and the Memory page', () => journey({
    name: 'fixes-privacy-private', mocks: { local: { replies: ['A reply in a private entry.'] } },
  }, async (j) => {
    const { page, db, mock } = j;
    const made = await j.app.entry({ content: 'Something I would rather keep out of memory.' });
    const id = made.entry.id;
    await j.goto(`/entry/${id}`);
    await ui.mine(page).first().waitFor();

    await page.getByRole('button', { name: 'Entry options' }).click();
    const item = page.getByRole('menuitemcheckbox', { name: /Private entry/ });
    const description = await item.innerText();
    assert.ok(description.includes('Keeps it out of memory, recall and weekly reflections.'), description);
    assert.ok(description.includes(STILL_WRITTEN), `the menu says: ${description}`);
    await item.click();
    await eventually(() => assert.equal(db.entries.get(id).private, true));

    const flag = page.getByTitle(/^Private: kept out of memory/);
    await flag.waitFor();
    assert.ok((await flag.getAttribute('title')).includes(STILL_WRITTEN));

    await j.goto('/memory');
    await page.getByText('Private entries stay out of memory', { exact: true }).waitFor();
    await page.getByText(STILL_WRITTEN).first().waitFor();
    assert.equal(await page.getByText('Private entries are never used').count(), 0, 'the old promise is gone');

    // ... and it is true: Save without reply sends nothing, Send in the private entry does send the conversation
    await j.goto(`/entry/${id}`);
    await ui.entryBox(page).fill('A second line that stays on this computer.');
    await ui.button(page, 'Save without reply').click();
    await ui.mine(page).filter({ hasText: 'A second line that stays on this computer.' }).waitFor();
    assert.equal(mock.chatRequests().length, 0, 'Save without reply never calls the provider');
    await ui.entryBox(page).fill('A third line, sent for a reply.');
    await ui.button(page, 'Send').click();
    await ui.companion(page).filter({ hasText: 'A reply in a private entry.' }).waitFor();
    const sent = JSON.stringify(mock.chatRequests().at(-1).body.messages);
    assert.ok(sent.includes('A third line, sent for a reply.'), 'the conversation of a private entry is sent when a reply is asked for');
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* The browser's date in reply and wrap-up requests                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

describe('replies and wrap-ups carry the browser date', () => {
  test('reply, regenerate and wrap-up send today: <the browser\'s date>, and the prompt says it', () => journey({
    name: 'fixes-today-in-requests',
  }, async (j) => {
    const { page, mock, context } = j;
    // The browser is somewhere it is already Tuesday 4 March 2031, late in the evening; the server's own clock disagrees.
    await context.clock.setFixedTime(new Date(2031, 2, 4, 23, 50));
    const bodies = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/entries\/[^/]+\/(reply|wrap-up)$/.test(new URL(request.url()).pathname)) {
        bodies.push({ path: new URL(request.url()).pathname.split('/').pop(), body: JSON.parse(request.postData() || '{}') });
      }
    });
    await j.goto('/');
    await ui.startJournaling(page, 'The evening of a long day.');
    await ui.companion(page).first().waitFor();
    assert.equal(await page.evaluate(() => new Date().getFullYear()), 2031, 'the page really runs on the faked date');

    await eventually(() => assert.deepEqual(bodies.map((b) => b.path), ['reply']));
    assert.deepEqual(bodies[0].body, { regenerate: false, today: '2031-03-04' });
    const system = mock.chatRequests().at(-1).body.messages[0].content;
    assert.match(system, /Today is Tuesday, 4 March 2031\./, 'the prompt carries the browser\'s date');

    await page.getByRole('button', { name: 'Regenerate this reply' }).click();
    await eventually(() => assert.deepEqual(bodies.map((b) => b.path), ['reply', 'reply']));
    assert.deepEqual(bodies[1].body, { regenerate: true, today: '2031-03-04' });
    await eventually(() => assert.match(mock.chatRequests().at(-1).body.messages[0].content, /Today is Tuesday, 4 March 2031\./));

    await ui.button(page, 'Wrap up').click();
    await eventually(() => assert.deepEqual(bodies.map((b) => b.path), ['reply', 'reply', 'wrap-up']));
    assert.deepEqual(bodies[2].body, { today: '2031-03-04' });
    await page.getByRole('region', { name: 'Entry summary' }).waitFor({ timeout: 20_000 });
    const wrapRequests = mock.chatRequests().filter((r) => /TASK: (reply|wrapup|wrap)/i.test(r.body.messages[0].content) || /Today is/.test(r.body.messages[0].content));
    assert.ok(wrapRequests.every((r) => !/Today is[^.]*2026/.test(r.body.messages[0].content)), 'the server clock never leaked into a prompt');
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* Local models that are already installed                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

describe('Local model: installed models', () => {
  test('a model the server already has says "Already installed" instead of offering a download that needs the internet', () => journey({
    name: 'fixes-local-installed', fresh: true, onboarded: true, mocks: { local: { models: ['llama3.2:3b', 'mistral:latest'], pull: { delayMs: 40, steps: 4 } } },
  }, async (j) => {
    const { page, mock } = j;
    const pulls = [];
    page.on('request', (request) => { if (/\/api\/providers\/local\/pull$/.test(new URL(request.url()).pathname)) pulls.push(request.url()); });
    await j.goto('/settings?tab=local');
    await page.getByLabel('Base URL', { exact: true }).fill(mock.baseUrl);
    const model = page.getByLabel('Model', { exact: true });
    await model.fill('llama3.2:3b');
    await ui.button(page, 'Load models').click();
    await page.getByText(/Found 2 models/).waitFor();

    const installed = page.getByRole('button', { name: 'Already installed' });
    await installed.waitFor();
    assert.equal(await installed.getAttribute('aria-disabled'), 'true');
    assert.equal(await page.getByRole('button', { name: /^Download llama3\.2:3b$/ }).count(), 0);
    await installed.click({ force: true });
    await page.waitForTimeout(300);
    assert.deepEqual(pulls, [], 'pressing it starts nothing');
    assert.equal(await page.getByRole('progressbar', { name: 'Download progress' }).count(), 0);

    // an untagged name means ":latest", as it does for `ollama pull`
    await model.fill('mistral');
    await installed.waitFor();

    // a model that is not there can be downloaded; afterwards it counts as installed
    await model.fill('qwen2.5:1.5b');
    const download = ui.button(page, 'Download qwen2.5:1.5b');
    await download.waitFor();
    assert.equal(await download.getAttribute('aria-disabled'), null);
    await download.click();
    await page.getByText('qwen2.5:1.5b is ready').waitFor();
    assert.equal(pulls.length, 1);
    await installed.waitFor();

    // editing the address drops the list (it belonged to the old server), so the download is offered again
    await page.getByLabel('Base URL', { exact: true }).fill(`${mock.baseUrl}/`.replace(/\/\/$/, '/') + 'x');
    await ui.button(page, 'Download qwen2.5:1.5b').waitFor();
  }));

  test('the keyboard focus stays on the button when it turns into "Already installed"', () => journey({
    name: 'fixes-local-installed-focus', fresh: true, onboarded: true, mocks: { local: { models: ['llama3.2:3b'], pull: { delayMs: 30, steps: 3 } } },
  }, async (j) => {
    const { page, mock } = j;
    await j.goto('/settings?tab=local');
    await page.getByLabel('Base URL', { exact: true }).fill(mock.baseUrl);
    await page.getByLabel('Model', { exact: true }).fill('llama3.2:1b');
    const download = ui.button(page, 'Download llama3.2:1b');
    await download.focus();
    await page.keyboard.press('Enter');
    await page.getByText('llama3.2:1b is ready').waitFor();
    const installed = page.getByRole('button', { name: 'Already installed' });
    await installed.waitFor();
    assert.equal(await installed.evaluate((el) => document.activeElement === el), true, 'focus is still on that button');
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* Destructive dialogs open on the safe choice                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

const activeName = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el && el !== document.body ? (el.getAttribute('aria-label') || el.textContent || el.tagName).replace(/\s+/g, ' ').trim() : 'BODY';
});

describe('destructive dialogs', () => {
  test('every "danger" dialog opens on Cancel, so a stray Enter keeps everything', () => journey({
    name: 'fixes-dialog-focus', seed: 'demo', provider: 'openai', mocks: { local: true, openai: true },
  }, async (j) => {
    const { page, db } = j;
    const dialog = page.getByRole('dialog');

    // Memory: Clear all
    await j.goto('/memory');
    const memories = db.memories.list().length;
    await ui.button(page, 'Clear all').click();
    await dialog.getByText('Forget everything?').waitFor();
    assert.equal(await activeName(page), 'Cancel');
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(db.memories.list().length, memories, 'Enter on the opening focus changed nothing');

    // an entry: delete a message
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Presentation day');
    await j.goto(`/entry/${entry.id}`);
    await ui.mine(page).first().waitFor();
    const before = db.messages.list(entry.id).length;
    await ui.mine(page).first().getByRole('button', { name: 'Delete this message' }).click();
    await dialog.getByText('Delete this message?').waitFor();
    assert.equal(await activeName(page), 'Cancel');
    await page.keyboard.press('Space');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(db.messages.list(entry.id).length, before);

    // an entry: delete it
    await page.getByRole('button', { name: 'Entry options' }).click();
    await page.getByRole('menuitem', { name: /Delete entry/ }).click();
    await dialog.getByText('Delete this entry?').waitFor();
    assert.equal(await activeName(page), 'Cancel');
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(db.entries.get(entry.id));

    // Settings: remove a saved key
    await j.goto('/settings?tab=openai');
    await ui.button(page, 'Remove saved key').click();
    await dialog.getByText('Remove the saved key?').waitFor();
    assert.equal(await activeName(page), 'Cancel');
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(db.settings.get().ai.providers.openai.apiKey, OPENAI_KEY);

    // Settings: delete everything asks for the word, so the box has focus (and the button is still off)
    await j.goto('/settings?tab=data');
    await ui.button(page, 'Delete my journal data...').click();
    await dialog.getByText('Delete everything?').waitFor();
    assert.equal(await activeName(page), 'Type DELETE to confirm');
    assert.equal(await dialog.getByRole('button', { name: 'Delete everything' }).isDisabled(), true);
    await page.keyboard.press('Enter'); // Enter with nothing typed does nothing at all
    assert.equal(await dialog.count(), 1);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(db.stats().entries > 0);
  }));

  test('a dialog that is not destructive still opens on its main button', () => journey({
    name: 'fixes-dialog-focus-plain', fresh: true, onboarded: true,
  }, async (j) => {
    const { page, mock } = j;
    await j.goto('/settings?tab=local');
    await page.getByLabel('Base URL', { exact: true }).fill(mock.baseUrl);
    await ui.tab(page, 'General').click();
    await page.getByRole('dialog').waitFor();
    // the "unsaved changes" question keeps its own choice (Keep editing) - the focus rule is only about danger dialogs
    assert.equal(await activeName(page), 'Keep editing');
    await page.getByRole('button', { name: 'Discard changes' }).click();
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* The welcome screen and keys the server already has                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

describe('welcome: keys found in the environment', () => {
  test('badges on the Gemini and OpenAI cards (never the key), a one-step setup, and no Save needed', () => journey({
    name: 'fixes-welcome-env-keys', fresh: true, configureMocks: true, keysInEnv: true, mocks: { local: true, gemini: true, openai: true },
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/');
    await ui.heading(page, 'A private place to think out loud', 1).waitFor();
    await page.getByText('Found GEMINI_API_KEY in your environment').waitFor();
    await page.getByText('Found OPENAI_API_KEY in your environment').waitFor();
    assert.equal(await page.getByText(/Found .* in your environment/).count(), 2, 'the local model has no badge');
    assert.deepEqual(await pageContainsSecret(page, GEMINI_KEY), []);
    assert.deepEqual(await pageContainsSecret(page, OPENAI_KEY), []);
    // each choice button is described by its badge for screen readers
    assert.match(await ui.button(page, 'Use Gemini').getAttribute('aria-describedby'), /./);
    assert.equal(await page.getByRole('button', { name: 'Use Gemini' }).evaluate((b) => b.getAttribute('aria-describedby') && document.getElementById(b.getAttribute('aria-describedby')).textContent), 'Found GEMINI_API_KEY in your environment');

    await ui.button(page, 'Use Gemini').click();
    await page.waitForURL(/#\/settings\?tab=gemini&setup=1/);
    await page.getByText('Almost there - one quick step').waitFor();
    await page.getByText(/found your key in GEMINI_API_KEY, so there is nothing to paste/).waitFor();
    assert.equal(await page.getByText('Almost there - two quick steps').count(), 0);
    await page.getByText('Using GEMINI_API_KEY from the environment').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Get a free key' }).count(), 0, 'no "how to get a key" when there is one');
    assert.equal(await page.getByRole('link', { name: 'Google AI Studio' }).count(), 0);
    assert.deepEqual(await pageContainsSecret(page, GEMINI_KEY), []);

    // Test connection is the prominent button: it looks different from Save
    const colour = (button) => button.evaluate((el) => getComputedStyle(el).backgroundColor);
    const test = ui.button(page, 'Test connection');
    const save = ui.button(page, 'Save');
    assert.notEqual(await colour(test), await colour(save), 'Test connection stands out from Save');
    assert.equal(await page.getByRole('button', { name: 'Use this provider' }).count(), 0, 'the choice already made it the provider in use');

    // one press, then it is done: no Save, nothing typed
    await test.click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.getByText('You are all set').waitFor();
    await page.mouse.move(0, 0); // (a hovered button has its own colour)
    await eventually(async () => assert.equal(await colour(test), await colour(save)), { message: 'the emphasis to go once it worked' });
    assert.equal(db.settings.get().ai.providers.gemini.apiKey, '', 'the key from the environment was never stored');
    assert.equal(db.settings.get().ai.provider, 'gemini');
    await page.getByRole('link', { name: 'Start journaling' }).click();
    await ui.todayBox(page).waitFor();
    await ui.startJournaling(page, 'Straight in with the key that was already there.');
    await ui.companion(page).first().waitFor();
  }));

  test('OpenAI: its own badge and the same one-step setup', () => journey({
    name: 'fixes-welcome-env-openai', fresh: true, configureMocks: true, keysInEnv: true, mocks: { local: true, openai: true },
  }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await page.getByText('Found OPENAI_API_KEY in your environment').waitFor();
    assert.equal(await page.getByText('Found GEMINI_API_KEY in your environment').count(), 0, 'only the keys that exist are announced');
    await ui.button(page, 'Use my own API').click();
    await page.waitForURL(/#\/settings\?tab=openai&setup=1/);
    await page.getByText(/found your key in OPENAI_API_KEY/).waitFor();
    await ui.button(page, 'Test connection').click();
    await page.getByText('You are all set').waitFor();
  }));

  test('without any key in the environment the welcome screen and the two-step setup are unchanged', () => journey({
    name: 'fixes-welcome-no-env', fresh: true, mocks: { local: true },
  }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await ui.heading(page, 'Free Gemini').waitFor();
    assert.equal(await page.getByText(/in your environment/).count(), 0);
    await ui.button(page, 'Use Gemini').click();
    await page.waitForURL(/#\/settings\?tab=gemini&setup=1/);
    await page.getByText('Almost there - two quick steps').waitFor();
    await page.getByRole('heading', { name: 'Get a free key' }).waitFor();
  }));

  test('a key typed over the one from the environment is saved with Save, as before', () => journey({
    name: 'fixes-welcome-env-override', fresh: true, configureMocks: true, keysInEnv: true, mocks: { local: true, gemini: true },
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/welcome');
    await ui.button(page, 'Use Gemini').click();
    await page.getByText('Almost there - one quick step').waitFor();
    await page.getByLabel(/^API key/).fill(GEMINI_KEY);
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected', { exact: true }).waitFor();
    assert.equal(await page.getByText('You are all set').count(), 0, 'a test of an unsaved key is not "all set"');
    await page.getByText(/Press Save to keep these settings/).waitFor();
    await ui.button(page, 'Save').click();
    await page.getByText('You are all set').waitFor();
    assert.equal(db.settings.get().ai.providers.gemini.apiKey, GEMINI_KEY);
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* On-screen keyboard                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Replace window.visualViewport with an object the test can resize, as an iOS keyboard does: the layout viewport keeps its
 * size, only the visual viewport shrinks. Must run before the app loads.
 */
async function fakeVisualViewport(page) {
  await page.addInitScript(() => {
    const fake = new EventTarget();
    Object.assign(fake, { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
    window.__setViewport = (patch, events = ['resize']) => { Object.assign(fake, patch); for (const type of events) fake.dispatchEvent(new Event(type)); };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
  });
}

const inset = (page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--kb-inset'));
const frame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

describe('on-screen keyboard', () => {
  const messages = [['user', 'Line one of a long evening.'], ['assistant', 'What stands out about it?', { kind: 'reply' }], ['user', 'Mostly the quiet.'], ['assistant', 'Say more about the quiet.', { kind: 'reply' }], ['user', 'It felt earned. The very last message.']];

  test('a keyboard that covers the page (iOS) lifts the writing box above it and keeps the last message clear', () => journey({
    name: 'fixes-keyboard-inset', mobile: true, viewport: { width: 390, height: 844 },
    seed: (db) => seedEntry(db, { title: 'Keyboard', messages }),
  }, async (j) => {
    const { page, db } = j;
    await fakeVisualViewport(page);
    const entry = db.entries.list({ limit: 5 }).find((e) => e.title === 'Keyboard');
    await j.goto(`/entry/${entry.id}`);
    const send = page.getByRole('button', { name: 'Send' });
    await send.waitFor();
    await frame(page);
    assert.equal(await inset(page), '', 'no keyboard, nothing set');
    const resting = await send.boundingBox();

    await page.evaluate(() => window.__setViewport({ height: 508 })); // a 336 px keyboard
    await eventually(async () => assert.equal(await inset(page), '336px'), { message: 'the inset to be published' });
    await frame(page);
    const lifted = await send.boundingBox();
    assert.ok(lifted.y + lifted.height <= 508 + 0.5, `Send is above the keyboard: bottom ${lifted.y + lifted.height} of 508`);
    assert.ok(lifted.y < resting.y, 'and it moved up from where it rests');

    // scrolled to the end, the last message ends above the writing box
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await frame(page);
    const last = await ui.mine(page).last().boundingBox();
    const box = await page.getByRole('form', { name: 'Write' }).boundingBox();
    assert.ok(last.y + last.height <= box.y + 0.5, `the last message (bottom ${last.y + last.height}) is not under the writing box (top ${box.y})`);

    // iOS pans the visual viewport while typing: the inset follows
    await page.evaluate(() => window.__setViewport({ offsetTop: 100 }, ['scroll']));
    await eventually(async () => assert.equal(await inset(page), '236px'));

    // keyboard closed: everything is back where it was, and the property is gone rather than left at zero
    await page.evaluate(() => window.__setViewport({ height: window.innerHeight, offsetTop: 0 }));
    await eventually(async () => assert.equal(await inset(page), ''));
    await frame(page);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await frame(page);
    const back = await send.boundingBox();
    assert.ok(Math.abs(back.y - resting.y) < 1.5, `Send is back (${back.y} vs ${resting.y})`);
  }));

  test('pinch zoom is not a keyboard, and a missing visualViewport changes nothing', () => journey({
    name: 'fixes-keyboard-zoom', mobile: true, viewport: { width: 390, height: 844 },
    seed: (db) => seedEntry(db, { title: 'Zoom', messages }),
  }, async (j) => {
    const { page, db } = j;
    await fakeVisualViewport(page);
    const entry = db.entries.list({ limit: 5 }).find((e) => e.title === 'Zoom');
    await j.goto(`/entry/${entry.id}`);
    const send = page.getByRole('button', { name: 'Send' });
    await send.waitFor();
    await frame(page);
    const resting = await send.boundingBox();
    await page.evaluate(() => window.__setViewport({ height: 422, scale: 2 }));
    await frame(page);
    await frame(page);
    assert.equal(await inset(page), '');
    assert.deepEqual(await send.boundingBox(), resting);
  }));

  test('on a desktop nothing changes: no property, same layout, also when resize events keep coming', () => journey({
    name: 'fixes-keyboard-desktop', seed: (db) => seedEntry(db, { title: 'Desktop', messages }),
  }, async (j) => {
    const { page, db } = j;
    await fakeVisualViewport(page);
    const entry = db.entries.list({ limit: 5 }).find((e) => e.title === 'Desktop');
    await j.goto(`/entry/${entry.id}`);
    const send = page.getByRole('button', { name: 'Send' });
    await send.waitFor();
    await frame(page);
    const resting = await send.boundingBox();
    for (let i = 0; i < 5; i += 1) await page.evaluate(() => window.__setViewport({}, ['resize', 'scroll']));
    await frame(page);
    assert.equal(await inset(page), '');
    assert.deepEqual(await send.boundingBox(), resting);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.entry-page')).paddingBottom), '0px');
  }));

  test('a browser without visualViewport loads and works as before', () => journey({
    name: 'fixes-keyboard-no-api', mobile: true, viewport: { width: 390, height: 844 },
    seed: (db) => seedEntry(db, { title: 'NoViewport', messages }),
  }, async (j) => {
    const { page, db } = j;
    await page.addInitScript(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => undefined }); });
    const entry = db.entries.list({ limit: 5 }).find((e) => e.title === 'NoViewport');
    await j.goto(`/entry/${entry.id}`);
    await ui.entryBox(page).fill('Still typing.');
    await ui.button(page, 'Save without reply').click();
    await ui.mine(page).filter({ hasText: 'Still typing.' }).waitFor();
    assert.equal(await inset(page), '');
  }));
});
