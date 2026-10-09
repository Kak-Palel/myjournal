// Journey 24: the polish round after the live verification, each item pinned in a real browser with roles, labels and visible text:
// the local model picker (order, honest notes), the variable a key was found in, the wait text of Test connection for a local
// model, the General-tab hints and the 300 s ceiling, the small-model memory warning (Memory page and Local tab), the Data-tab
// privacy sentence, and a reply that never shows a second question.

import {
  GEMINI_KEY, assert, describe, eventually, journey, pageContainsSecret, test, ui,
} from './helpers.js';

const WARNING = 'Small models (under about 3B) often write poor memory notes. Check the list now and then, or switch off "Suggest memories when I wrap up an entry".';

/* ------------------------------------------------------------------------------------------------------------ */
/* Local model picker                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

describe('Local model tab: the picker', () => {
  test('recommended first, then the best model we measured, then the basic one; models nobody here ran say so', () => journey({
    name: 'polish-picker', fresh: true, onboarded: true, configureMocks: true, // (the mock, not a real Ollama on this machine)
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=local');
    const group = page.getByRole('radiogroup', { name: 'Small models to try' });
    await group.waitFor();
    const radios = group.getByRole('radio');
    const names = await radios.evaluateAll((els) => els.map((el) => el.closest('label').querySelector('.settings-model-card-name').textContent));
    assert.deepEqual(names, ['Llama 3.2 3B', 'Qwen 3 1.7B', 'Llama 3.2 1B', 'Qwen 2.5 1.5B', 'Gemma 2 2B', 'SmolLM2 1.7B']);
    const ids = await radios.evaluateAll((els) => els.map((el) => el.value));
    assert.deepEqual(ids, ['llama3.2:3b', 'qwen3:1.7b', 'llama3.2:1b', 'qwen2.5:1.5b', 'gemma2:2b', 'smollm2:1.7b']);
    assert.ok(!ids.includes('smollm2:360m'), 'the 360M model is never suggested');

    const card = (label) => group.getByRole('radio', { name: new RegExp(label) });
    await card('Llama 3.2 3B').check();
    assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'llama3.2:3b');
    assert.match(await card('Llama 3.2 3B').evaluate((el) => el.closest('label').innerText), /recommended/i);
    assert.match(await card('Qwen 3 1.7B').evaluate((el) => el.closest('label').innerText), /best measured[\s\S]*best small model we measured/i);
    assert.match(await card('Llama 3.2 1B').evaluate((el) => el.closest('label').innerText), /basic/i);
    for (const label of ['Qwen 2.5 1.5B', 'Gemma 2 2B', 'SmolLM2 1.7B']) {
      const text = await card(label).evaluate((el) => el.closest('label').innerText);
      assert.match(text, /not measured/i, label);
      assert.match(text, /did not measure/, label);
    }
    await card('Qwen 3 1.7B').check();
    assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'qwen3:1.7b');
    await ui.button(page, 'Download qwen3:1.7b').waitFor();
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* The variable a key was found in                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

describe('welcome: GOOGLE_API_KEY is named as GOOGLE_API_KEY', () => {
  test('the badge, the setup step and the key status line name the variable the server really found, never the key', () => journey({
    name: 'polish-google-key', fresh: true, mocks: { local: true }, env: { GOOGLE_API_KEY: GEMINI_KEY },
  }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await ui.heading(page, 'A private place to think out loud', 1).waitFor();
    await page.getByText('Found GOOGLE_API_KEY in your environment').waitFor();
    assert.equal(await page.getByText('Found GEMINI_API_KEY in your environment').count(), 0, 'not the variable that is not set');
    assert.equal(await page.getByText(/Found .* in your environment/).count(), 1);
    assert.equal(await ui.button(page, 'Use Gemini').evaluate((b) => document.getElementById(b.getAttribute('aria-describedby')).textContent), 'Found GOOGLE_API_KEY in your environment');
    assert.deepEqual(await pageContainsSecret(page, GEMINI_KEY), []);

    await ui.button(page, 'Use Gemini').click();
    await page.waitForURL(/#\/settings\?tab=gemini&setup=1/);
    await page.getByText(/found your key in GOOGLE_API_KEY, so there is nothing to paste/).waitFor();
    await page.getByText('Using GOOGLE_API_KEY from the environment').waitFor();
    assert.equal(await page.getByText(/GEMINI_API_KEY/).count(), 0, 'GEMINI_API_KEY is not mentioned anywhere on the page');
    assert.deepEqual(await pageContainsSecret(page, GEMINI_KEY), []);
  }));

  test('when GEMINI_API_KEY is set it is the one named (it wins, as for the key itself)', () => journey({
    name: 'polish-gemini-key', fresh: true, mocks: { local: true }, env: { GEMINI_API_KEY: GEMINI_KEY, GOOGLE_API_KEY: 'another-key-value' },
  }, async (j) => {
    const { page } = j;
    await j.goto('/');
    await page.getByText('Found GEMINI_API_KEY in your environment').waitFor();
    assert.equal(await page.getByText('Found GOOGLE_API_KEY in your environment').count(), 0);
  }));

  test('a key saved in Settings is not "found in the environment", even with the variable set', () => journey({
    name: 'polish-saved-key-wins', fresh: true, onboarded: true, mocks: { local: true }, env: { GOOGLE_API_KEY: GEMINI_KEY },
    settings: { ai: { providers: { gemini: { apiKey: 'saved-gemini-key-1234' } } } },
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=gemini');
    await page.getByText(/^Saved key ending/).waitFor();
    assert.equal(await page.getByText(/GOOGLE_API_KEY/).count(), 0);
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* Test connection                                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

describe('Test connection while it waits', () => {
  const LONG = 'The first request after a model starts loads it into memory, which can take a minute. Please wait.';

  test('a local model is told that the first request loads it into memory', () => journey({
    name: 'polish-test-local', mocks: { local: { ttfbMs: 1200 } },
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=local');
    await ui.button(page, 'Test connection').click();
    const waiting = page.getByText('Contacting the model...');
    await waiting.waitFor();
    assert.equal((await waiting.innerText()).replace(/\s+/g, ' ').trim(), `Contacting the model... ${LONG}`);
    await page.getByText('Connected', { exact: true }).waitFor();
    assert.equal(await page.getByText(LONG).count(), 0, 'the waiting text is gone once the answer is in');
  }));

  test('the other providers keep the short text', () => journey({
    name: 'polish-test-openai', mocks: { local: true, openai: { ttfbMs: 1200 } }, configureMocks: true,
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=openai');
    await ui.button(page, 'Test connection').click();
    const waiting = page.getByText('Contacting the model...');
    await waiting.waitFor();
    assert.equal((await waiting.innerText()).replace(/\s+/g, ' ').trim(), 'Contacting the model...');
    assert.equal(await page.getByText(LONG).count(), 0);
    await page.getByText('Connected', { exact: true }).waitFor();
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* General tab                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

describe('General tab: context budget and timeout', () => {
  test('the hints say what fits which window, and the timeout stops at 300 seconds', () => journey({ name: 'polish-general' }, async (j) => {
    const { page, db } = j;
    await j.goto('/settings?tab=general');
    await page.getByLabel('Your name').waitFor();
    await page.getByText('Reply length, context and timeout').click();
    await page.getByText("The default fits a 4,096-token window. For a 2,048-token window use about 1,500; raise it only after raising the model's window (Ollama: OLLAMA_CONTEXT_LENGTH).").waitFor();
    assert.equal(await page.getByText(/keep this around 1,500 to 2,500/).count(), 0, 'the old advice is gone');
    await page.getByText(/5 to 300 seconds \(nothing longer takes effect\)/).waitFor();

    const timeout = page.getByLabel('Wait for the first word (seconds)');
    assert.equal(await timeout.getAttribute('max'), '300');
    assert.equal(await timeout.inputValue(), '180');
    await timeout.fill('600');
    await ui.button(page, 'Save changes').click();
    await eventually(() => assert.equal(db.settings.get().ai.timeoutSec, 300), { message: '600 to be stored as 300' });
    await eventually(async () => assert.equal(await timeout.inputValue(), '300'));
  }));

  test('a document stored with the old 600 s limit opens as 300', () => journey({
    name: 'polish-general-old-timeout', seed: (db) => {
      db.handle.prepare("UPDATE settings SET value = json_set(value, '$.ai.timeoutSec', 600) WHERE key = 'app'").run();
    },
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=general');
    await page.getByText('Reply length, context and timeout').click();
    assert.equal(await page.getByLabel('Wait for the first word (seconds)').inputValue(), '300');
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* Small models and memory notes                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

const smallModel = (model) => ({ ai: { providers: { local: { model } } } });

describe('small-model memory warning', () => {
  test('Memory page: shown next to the switch for a local model under about 3B, and it blocks nothing', () => journey({
    name: 'polish-warning-memory', settings: smallModel('llama3.2:1b'),
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/memory');
    const suggest = ui.switch(page, /Suggest memories when I wrap up an entry/);
    await suggest.waitFor();
    await page.getByText(WARNING).waitFor();
    // the warning sits right under the switch it talks about
    const [sw, note, next] = await Promise.all([
      suggest.locator('xpath=ancestor::label[1]').boundingBox(),
      page.getByText(WARNING).boundingBox(),
      ui.switch(page, /Recall related past entries/).locator('xpath=ancestor::label[1]').boundingBox(),
    ]);
    assert.ok(note.y >= sw.y + sw.height - 1 && note.y + note.height <= next.y + 1, 'between the two switches');
    // a warning, not a blocker: the switch is on, enabled, and still works
    assert.equal(await suggest.isChecked(), true);
    assert.equal(await suggest.isDisabled(), false);
    await ui.flip(page, /Suggest memories when I wrap up an entry/);
    await eventually(() => assert.equal(db.settings.get().memory.autoExtract, false));
    await page.getByText(WARNING).waitFor();
  }));

  test('Memory page: no warning for 3B and up, an unknown size, another provider, or with the AI off', () => journey({
    name: 'polish-warning-none', settings: smallModel('llama3.2:3b'),
  }, async (j) => {
    const { page, db } = j;
    const quiet = async () => {
      await j.goto('/memory');
      await ui.switch(page, /Suggest memories when I wrap up an entry/).waitFor();
      await page.waitForTimeout(150);
      assert.equal(await page.getByText(/often write poor memory notes/).count(), 0);
    };
    await quiet(); // 3B
    for (const model of ['llama3.2', 'mistral-7b-instruct', 'llama3.1:70b']) {
      db.settings.set({ ...db.settings.get(), ai: { ...db.settings.get().ai, providers: { ...db.settings.get().ai.providers, local: { ...db.settings.get().ai.providers.local, model } } } });
      await quiet();
    }
    // a 1B model that is not the active provider
    const s = db.settings.get();
    db.settings.set({ ...s, ai: { ...s.ai, provider: 'gemini', providers: { ...s.ai.providers, local: { ...s.ai.providers.local, model: 'llama3.2:1b' } } } });
    await quiet();
    // ... and with the AI switched off
    const t = db.settings.get();
    db.settings.set({ ...t, ai: { ...t.ai, provider: 'local', enabled: false } });
    await quiet();
  }));

  test('Local tab: the same warning under the picker, with a way to the Memory page; it follows the saved model', () => journey({
    name: 'polish-warning-local', settings: smallModel('qwen3:1.7b'),
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/settings?tab=local');
    await page.getByText(WARNING).waitFor();
    const picker = await page.getByRole('radiogroup', { name: 'Small models to try' }).boundingBox();
    const note = await page.getByText(WARNING).boundingBox();
    assert.ok(note.y > picker.y + picker.height - 1, 'below the picker');
    // choosing a bigger model in the form does not change the warning until it is saved; saving does
    await page.getByLabel('Model', { exact: true }).fill('llama3.2:3b');
    assert.equal(await page.getByText(WARNING).count(), 1, 'unsaved: the active model is still the small one');
    await ui.button(page, 'Save').click();
    await eventually(() => assert.equal(db.settings.get().ai.providers.local.model, 'llama3.2:3b'));
    await eventually(async () => assert.equal(await page.getByText(/often write poor memory notes/).count(), 0), { message: 'the warning to go once the model is 3B' });
    // and back
    await page.getByLabel('Model', { exact: true }).fill('smollm2:360m');
    await ui.button(page, 'Save').click();
    await page.getByText(WARNING).waitFor();
    await page.getByRole('link', { name: 'Open Memory' }).click();
    await ui.heading(page, 'Memory', 1).waitFor();
    await page.getByText(WARNING).waitFor();
  }));

  test('Local tab: no warning while another provider is the active one', () => journey({
    name: 'polish-warning-local-inactive', provider: 'gemini', mocks: { local: true, gemini: true }, configureMocks: true, settings: smallModel('llama3.2:1b'),
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=local');
    await ui.button(page, 'Test connection').waitFor();
    await page.waitForTimeout(150);
    assert.equal(await page.getByText(/often write poor memory notes/).count(), 0);
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* Data tab                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

describe('Data tab: what the provider receives', () => {
  test('a reply sends the listed things and nothing else; wrap-up and the weekly reflection say what they add', () => journey({
    name: 'polish-privacy-data',
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=data');
    await page.getByRole('heading', { name: 'Where your data lives' }).waitFor();
    const reply = await page.getByText(/^Nothing leaves your computer unless the AI companion is on\./).innerText();
    assert.match(reply, /each reply sends the current conversation[\s\S]*to the provider you chose, and nothing else\.$/);
    const more = page.getByText(/^A wrap-up sends more than a reply/);
    await more.waitFor();
    const text = (await more.innerText()).replace(/\s+/g, ' ');
    for (const part of ['your entry text again for the title, summary and memory steps', 'up to 12 of your existing memories for the memory step',
      'A weekly reflection sends the titles, summaries, mood, feelings and tags of up to 200 non-private entries from the period']) {
      assert.ok(text.includes(part), `says: ${part}\n  got: ${text}`);
    }
  }));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* One question per reply                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

describe('a reply with two questions', () => {
  const ONE = 'That sounds like a heavy day. What part of it stays with you most?';
  const SECOND = 'And how did you sleep afterwards?';

  test('keeps the first question; the second never shows on screen, not even while the reply is being written', () => journey({
    name: 'polish-one-question', mocks: { local: { replies: [`${ONE}\n\n${SECOND}`], delayMs: 20, chunkSize: 5 } },
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/');
    await page.evaluate(() => {
      window.__sawSecond = false;
      new MutationObserver(() => {
        if (document.body.innerText.includes('how did you sleep')) window.__sawSecond = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await ui.todayBox(page).fill('Work was loud and I could not think straight all day.');
    await ui.button(page, 'Start journaling').click();
    await page.waitForURL(/#\/entry\//);
    const companion = ui.companion(page).first();
    await companion.waitFor();
    await companion.getByText(/stays with you most\?/).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]') && !/Stop/.test(document.body.innerText) , null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__sawSecond), false, 'the second question was never on screen');
    assert.doesNotMatch(await companion.innerText(), /sleep/);
    const saved = db.messages.list(db.entries.list({ limit: 1 })[0].id).find((m) => m.role === 'assistant');
    assert.equal(saved.content, ONE);
    // a reload shows the same thing
    await j.reload();
    await ui.companion(page).first().getByText(/stays with you most\?/).waitFor();
    assert.doesNotMatch(await ui.companion(page).first().innerText(), /sleep/);
  }));
});
