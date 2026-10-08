// Journey 7: Settings, provider tabs. For each provider: fill the form, Test connection (a rejected key shows the
// message, hint and next steps; a good one shows Connected), Save, reload and see everything persisted, with the typed
// API key never appearing anywhere in the page afterwards - only the "ending ..." hint.

import { freePort } from '../server/helpers.js';
import {
  GEMINI_KEY, OPENAI_KEY, allFieldValues, assert, describe, eventually, journey, pageContainsSecret, test, ui,
} from './helpers.js';

const GOOD_HINT = /Saved key ending …-key/;

/** Open a Settings tab by its address (like following a link). */
async function openTab(j, id) {
  await j.goto(`/settings?tab=${id}`);
  await ui.heading(j.page, 'Settings', 1).waitFor();
}

/** The whole page, every field, web storage and the settings API must not contain `secret`. */
async function assertSecretHidden(j, secret) {
  assert.deepEqual(await pageContainsSecret(j.page, secret), [], 'the key is not in the markup, fields or web storage');
  assert.ok(!(await allFieldValues(j.page)).some((v) => v.includes(secret)), 'no field holds the key');
  const res = await j.api('GET', '/settings');
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes(secret), 'GET /api/settings never returns the key');
  assert.ok(!res.text.includes('"apiKey"'), 'there is no apiKey field at all, only apiKeySet / apiKeyHint');
}

describe('settings: Gemini tab', () => {
  test('privacy note, key guide, rejected key, good key, save, masking, reload, model pills, thinking, remove key', () => journey({
    name: 'settings-gemini', fresh: true, onboarded: true, mocks: { gemini: true },
  }, async (j) => {
    const { page, db, mocks } = j;
    await openTab(j, 'gemini');

    // the privacy note is visible without any interaction
    await page.getByText('Privacy', { exact: true }).first().waitFor();
    await page.getByText(/Google may use your prompts and responses to improve its products/).waitFor();
    await page.getByText(/Do not journal secrets with the free tier/).waitFor();
    const keyLink = page.getByRole('link', { name: 'Google AI Studio' });
    assert.equal(await keyLink.getAttribute('href'), 'https://aistudio.google.com/apikey');
    assert.equal(await keyLink.getAttribute('target'), '_blank');
    assert.match(await keyLink.getAttribute('rel'), /noopener/);
    assert.match(await keyLink.getAttribute('rel'), /noreferrer/);

    // no key: Test explains instead of calling out
    await ui.button(page, 'Test connection').click();
    await page.getByText('Paste your API key first, then test.').waitFor();
    assert.equal(mocks.gemini.requests.length, 0);
    await page.getByText('No key saved yet').waitFor();

    // point it at the mock (the address is under Advanced) and try a wrong key
    await page.getByText('Advanced', { exact: true }).click();
    await page.getByLabel('Base URL', { exact: true }).fill(mocks.gemini.url);
    const key = page.getByLabel(/^API key/);
    await key.fill('AIza-wrong-key-0000');
    assert.equal(await key.getAttribute('type'), 'password', 'the key field is masked while typing');
    await ui.button(page, 'Test connection').click();
    const failure = page.getByRole('alert').filter({ hasText: 'Gemini rejected the API key.' });
    await failure.waitFor();
    await failure.getByText(/Copy a fresh key from https:\/\/aistudio\.google\.com\/apikey/).waitFor();
    await failure.getByText('Things to try').waitFor();
    await failure.getByText('Error code:').waitFor();
    assert.equal(await failure.getByText('auth', { exact: true }).count(), 1);
    assert.deepEqual(await pageContainsSecret(page, 'AIza-wrong-key-0000'), ['field password'], 'only the field being typed holds it');
    assert.equal(db.settings.get().ai.providers.gemini.apiKey, '', 'a failed test saves nothing');
    // the wrong key was sent in the header, never in the URL
    const wrongReq = mocks.gemini.requests.find((r) => r.method === 'POST');
    assert.equal(wrongReq.headers['x-goog-api-key'], 'AIza-wrong-key-0000');
    assert.ok(!wrongReq.path.includes('AIza') && !JSON.stringify(wrongReq.query).includes('AIza'));

    // the right key connects
    await key.fill(GEMINI_KEY);
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.getByText(/gemini-flash-lite-latest - /).waitFor();

    // save: the form empties the key field and only shows the hint
    await ui.button(page, 'Save').click();
    await page.getByText(GOOD_HINT).waitFor();
    assert.equal(await key.inputValue(), '', 'the key field is empty after saving');
    await assertSecretHidden(j, GEMINI_KEY);
    await eventually(() => assert.equal(db.settings.get().ai.providers.gemini.apiKey, GEMINI_KEY), { message: 'the key to be stored server side' });

    // Load models: the list is filtered to chat models, aliases first
    await ui.button(page, 'Load models').click();
    await page.getByText(/Found \d+ models/).waitFor();
    const listed = await page.getByText(/models? on this server - pick one|match what you typed/).locator('xpath=following-sibling::ul[1]//button').allInnerTexts();
    assert.ok(listed.length > 0 && listed.length < 62, `non-chat models are filtered out (${listed.length} of 62)`);
    assert.ok(listed.every((t) => !/tts|embed|imagen|veo|lyria|image|robotics|transcribe/i.test(t)), `no non-chat models: ${listed.slice(0, 5).join(' | ')}`);
    assert.match(listed[0], /-latest/, 'aliases come first');

    // pick a suggested model and the Low thinking level, save, reload: all of it is still there
    await page.getByRole('button', { name: /gemini-flash-latest/ }).first().click();
    await page.getByLabel('Thinking').selectOption('low');
    await page.getByText('Unsaved changes').first().waitFor();
    await ui.button(page, 'Save').click();
    await page.getByText('Unsaved changes').waitFor({ state: 'hidden' });
    await j.reload();
    await ui.heading(page, 'Settings', 1).waitFor();
    await page.getByText(GOOD_HINT).waitFor();
    assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'gemini-flash-latest');
    await page.getByText('Advanced', { exact: true }).click();
    assert.equal(await page.getByLabel('Base URL', { exact: true }).inputValue(), mocks.gemini.url);
    assert.equal(await page.getByLabel('Thinking').inputValue(), 'low');
    await assertSecretHidden(j, GEMINI_KEY);

    // make it the provider in use; the sidebar says so
    await ui.button(page, 'Use this provider').click();
    await page.getByRole('link', { name: 'Gemini · gemini-flash-latest' }).waitFor();
    await ui.tab(page, 'Gemini (free)').getByText('In use').waitFor();
    assert.equal(db.settings.get().ai.provider, 'gemini');
    assert.equal(await page.getByRole('button', { name: 'Use this provider' }).count(), 0);

    // removing the saved key asks first, then forgets it
    await ui.button(page, 'Remove saved key').click();
    await page.getByRole('dialog').getByText('Remove the saved key?').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove key' }).click();
    await page.getByText('No key saved yet').waitFor();
    await eventually(() => assert.equal(db.settings.get().ai.providers.gemini.apiKey, ''));
    await page.getByText('Needs a key').first().waitFor();
  }));

  test('an empty Gemini setup is refused politely when saving a bad address', () => journey({
    name: 'settings-gemini-bad-url', fresh: true, onboarded: true, mocks: { gemini: true },
  }, async (j) => {
    const { page, diag } = j;
    diag.expectStatus(400, /\/api\/settings/);
    await openTab(j, 'gemini');
    await page.getByText('Advanced', { exact: true }).click();
    const url = page.getByLabel('Base URL', { exact: true });
    await url.fill('ftp://example.com');
    await page.getByLabel(/^API key/).fill('some-key-12345678');
    await ui.button(page, 'Save').click();
    const summary = page.getByRole('alert').first();
    await summary.waitFor();
    assert.match(await url.getAttribute('aria-invalid'), /true/, 'the offending field is marked invalid');
    await page.getByText('Use the default address').click();
    assert.equal(await url.inputValue(), 'https://generativelanguage.googleapis.com');
  }));
});

describe('settings: OpenAI-compatible tab', () => {
  test('presets, rejected key with next steps, good key, save, Use this provider, reload', () => journey({
    name: 'settings-openai', fresh: true, onboarded: true, mocks: { local: true, openai: true },
  }, async (j) => {
    const { page, db, mocks } = j;
    await openTab(j, 'openai');
    await page.getByText(/Your journal text is sent to the service behind the base URL/).waitFor();

    // presets fill the address and explain themselves
    const groq = page.getByRole('button', { name: 'Groq', exact: true });
    await groq.click();
    assert.equal(await page.getByLabel('Base URL', { exact: true }).inputValue(), 'https://api.groq.com/openai/v1');
    assert.equal(await groq.getAttribute('aria-pressed'), 'true');
    await page.getByText('Groq has a free tier with very fast replies.').waitFor();
    await page.getByRole('button', { name: 'OpenRouter', exact: true }).click();
    await page.getByText(/Model names look like openai\/gpt-4o-mini/).waitFor();

    // the mock, with a wrong key
    await page.getByLabel('Base URL', { exact: true }).fill(mocks.openai.baseUrl);
    await page.getByLabel('Model', { exact: true }).fill('mock-model');
    await page.getByLabel(/^API key/).fill('sk-wrong-key-123456');
    await ui.button(page, 'Test connection').click();
    const failure = page.getByRole('alert').filter({ hasText: 'The API key was rejected.' });
    await failure.waitFor();
    await failure.getByText(/Check that the key is copied in full/).waitFor();
    await failure.getByText('Things to try').waitFor();
    await failure.getByText(/An OpenRouter, Groq or Together key only works with its own base URL/).waitFor();
    await failure.getByText('Error code:').waitFor();

    // the right key
    await page.getByLabel(/^API key/).fill(OPENAI_KEY);
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected', { exact: true }).waitFor();
    const testCall = mocks.openai.chatRequests().at(-1);
    assert.equal(testCall.headers.authorization, `Bearer ${OPENAI_KEY}`);

    // save, then make it active
    await ui.button(page, 'Save').click();
    await page.getByText(/Saved key ending …-key/).waitFor();
    await assertSecretHidden(j, OPENAI_KEY);
    assert.equal(db.settings.get().ai.provider, '', 'saving alone does not switch provider');
    await ui.button(page, 'Use this provider').click();
    await page.getByRole('link', { name: 'OpenAI-compatible · mock-model' }).waitFor();
    assert.equal(db.settings.get().ai.provider, 'openai');

    // Load models lists what the server offers
    await ui.button(page, 'Load models').click();
    await page.getByText(/Found \d+ models/).waitFor();
    await page.getByRole('button', { name: 'gpt-4o-mini' }).last().waitFor();

    // persisted after a reload, key still masked
    await j.reload();
    await ui.heading(page, 'Settings', 1).waitFor();
    assert.equal(await page.getByLabel('Base URL', { exact: true }).inputValue(), mocks.openai.baseUrl);
    assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'mock-model');
    await page.getByText(/Saved key ending …-key/).waitFor();
    await assertSecretHidden(j, OPENAI_KEY);
    await ui.tab(page, 'OpenAI-compatible').getByText('In use').waitFor();

    // and the app really uses it: a reply goes to this server with the key
    const made = await j.app.entry({ content: 'Testing the OpenAI-compatible route.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').click();
    await ui.companion(page).first().waitFor();
    const reply = mocks.openai.chatRequests().at(-1);
    assert.equal(reply.headers.authorization, `Bearer ${OPENAI_KEY}`);
    assert.equal(reply.body.model, 'mock-model');
    assert.equal(mocks.local.chatRequests().length, 0, 'the local server was not used');
  }));
});

describe('settings: Local model tab', () => {
  test('address warnings, unreachable server with next steps, then the mock: Test, Save, reload', () => journey({
    name: 'settings-local', fresh: true, onboarded: true,
  }, async (j) => {
    const { page, db, mock } = j;
    await openTab(j, 'local');
    await page.getByText(/your journal text never leaves it/).waitFor();
    const url = page.getByLabel('Base URL', { exact: true });
    assert.equal(await url.inputValue(), 'http://localhost:11434/v1');
    await page.getByRole('button', { name: 'llama.cpp', exact: true }).click();
    assert.equal(await url.inputValue(), 'http://localhost:8080/v1');
    await page.getByRole('button', { name: 'LM Studio', exact: true }).click();
    assert.equal(await url.inputValue(), 'http://localhost:1234/v1');

    // a non-local address gets an honest warning
    await url.fill('https://models.example.com/v1');
    await page.getByText(/This address is not on your computer/).waitFor();
    await url.fill('http://192.168.1.50:11434/v1');
    await page.getByText(/another device on your network/).waitFor();

    // nothing listens here: the failure says what to check and offers copyable commands
    const port = await freePort();
    await url.fill(`http://127.0.0.1:${port}/v1`);
    await ui.button(page, 'Test connection').click();
    const failure = page.getByRole('alert').filter({ hasText: 'Things to try' });
    await failure.waitFor();
    await failure.getByText(/Is your model server running\?/).waitFor();
    await failure.getByText('ollama serve').first().waitFor();
    await failure.getByText('Error code:').waitFor();
    await failure.getByText('network', { exact: true }).waitFor();
    assert.ok((await failure.innerText()).includes(`127.0.0.1:${port}`), 'the message names the address that was tried');

    // now the mock
    await url.fill(mock.baseUrl);
    await ui.button(page, 'Load models').click();
    await page.getByText(/Found \d+ models/).waitFor();
    await page.getByLabel('Model', { exact: true }).fill('llama3.2:3b');
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await ui.button(page, 'Save').click();
    await eventually(() => assert.equal(db.settings.get().ai.providers.local.baseUrl, mock.baseUrl));
    await j.reload();
    await ui.heading(page, 'Settings', 1).waitFor();
    assert.equal(await page.getByLabel('Base URL', { exact: true }).inputValue(), mock.baseUrl);
    assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'llama3.2:3b');
    await page.getByText('No key needed').waitFor();
  }));

  test('a local server that wants a key: the optional key field works and stays hidden', () => journey({
    name: 'settings-local-key', fresh: true, onboarded: true, mocks: { local: { apiKey: ['local-secret-key'] } },
  }, async (j) => {
    const { page, db, mock } = j;
    await openTab(j, 'local');
    await page.getByLabel('Base URL', { exact: true }).fill(mock.baseUrl);
    await ui.button(page, 'Test connection').click();
    await page.getByRole('alert').filter({ hasText: 'The local server wants an API key.' }).waitFor();
    await page.getByLabel(/^API key/).fill('local-secret-key');
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await ui.button(page, 'Save').click();
    await page.getByText(/Saved key ending …-key/).waitFor();
    await assertSecretHidden(j, 'local-secret-key');
    assert.equal(db.settings.get().ai.providers.local.apiKey, 'local-secret-key');
  }));

  test('Download model shows progress and finishes; Cancel stops it; a non-Ollama server explains itself', () => journey({
    name: 'settings-local-download', fresh: true, onboarded: true, mocks: { local: { pull: { delayMs: 60, steps: 8 } } },
  }, async (j) => {
    const { page, mock, diag } = j;
    diag.expectStatus(409, /providers\/local\/pull/);
    await openTab(j, 'local');
    await page.getByLabel('Base URL', { exact: true }).fill(mock.baseUrl);
    const model = page.getByLabel('Model', { exact: true });
    await model.fill('qwen2.5:1.5b');

    // choosing a small model card fills the model field
    await page.getByRole('radio', { name: /Gemma 2 2B/ }).check();
    assert.equal(await model.inputValue(), 'gemma2:2b');
    await model.fill('qwen2.5:1.5b');

    // full download
    await ui.button(page, 'Download qwen2.5:1.5b').click();
    const progress = page.getByRole('progressbar', { name: 'Download progress' });
    await progress.waitFor();
    await page.getByText(/Downloading - \d+%/).waitFor();
    await page.getByText('qwen2.5:1.5b is ready').waitFor();
    assert.ok(mock.behavior.models.includes('qwen2.5:1.5b'));
    await page.getByText('Installed', { exact: true }).filter({ visible: true }).first().waitFor();

    // cancel half way
    mock.setBehavior({ pull: { delayMs: 300, steps: 8 } });
    await model.fill('llama3.2:1b');
    await ui.button(page, 'Download llama3.2:1b').click();
    await progress.waitFor();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByText('Download cancelled').waitFor();
    await progress.waitFor({ state: 'hidden' });

    // a server that is not Ollama
    mock.setBehavior({ ollama: false });
    await ui.button(page, 'Download llama3.2:1b').click();
    await page.getByText('This server is not Ollama, so MyJournal cannot download models for it.').waitFor();
    await page.getByText(/load a model in that app, then press Load models/).waitFor();
  }));
});

describe('settings: unsaved changes are never lost silently', () => {
  test('switching tabs or leaving the page asks what to do with edits', () => journey({
    name: 'settings-unsaved', fresh: true, onboarded: true,
  }, async (j) => {
    const { page, db, mock } = j;
    await openTab(j, 'local');
    const url = page.getByLabel('Base URL', { exact: true });
    await url.fill(mock.baseUrl);
    await page.getByText('Unsaved changes').first().waitFor();
    await ui.tab(page, 'Local model').getByText('Unsaved').waitFor();

    // switching tab: Keep editing stays put
    await ui.tab(page, 'Data').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('You have unsaved changes on the Local model tab.').waitFor();
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    assert.equal(await ui.tab(page, 'Local model').getAttribute('aria-selected'), 'true');
    assert.equal(await url.inputValue(), mock.baseUrl);

    // Escape also means "keep editing"
    await ui.tab(page, 'Data').click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await ui.tab(page, 'Local model').getAttribute('aria-selected'), 'true');

    // leaving through the sidebar: Save and continue saves, then goes
    await page.getByRole('link', { name: 'History', exact: true }).first().click();
    await dialog.getByRole('button', { name: 'Save and continue' }).click();
    await ui.heading(page, 'History', 1).waitFor();
    assert.equal(db.settings.get().ai.providers.local.baseUrl, mock.baseUrl);

    // Discard throws the edit away
    await j.goto('/settings?tab=local');
    await url.waitFor();
    await url.fill('http://localhost:9/v1');
    await ui.tab(page, 'General').click();
    await dialog.getByRole('button', { name: 'Discard changes' }).click();
    await ui.tab(page, 'General').waitFor();
    assert.equal(db.settings.get().ai.providers.local.baseUrl, mock.baseUrl, 'nothing was saved');
    await ui.tab(page, 'Local model').click();
    assert.equal(await url.inputValue(), mock.baseUrl, 'the tab shows the saved address again');
  }));
});
