// The free Gemini API as the live service really behaves (docs/ARCHITECTURE.md "Live-verified corrections"), driven
// through the UI against the Gemini mock in its `live` profile: request shape, thinking settings, a guided journal that
// starts with a model turn, a retired model, an overloaded model with recovery through Settings, a revoked key, quotas.

import {
  GEMINI_KEY, assert, describe, eventually, journey, test, ui,
} from './helpers.js';

const REPLY = 'Thank you for sharing that with me. What stood out most about it?';

/** The bodies of every generateContent call the mock saw. */
const bodies = (mock) => mock.generateRequests().map((r) => r.body);

/** Banner above the composer for a problem (alert for errors, status for warnings and notes). */
const banner = (page, text) => page.getByRole('alert').or(page.getByRole('status')).filter({ hasText: text });

describe('Gemini through the whole app', () => {
  test('write, stream and wrap up on Gemini: the requests have the shape the real API accepts', () => journey({
    name: 'gemini-session', provider: 'gemini', mocks: { local: true, gemini: { live: true, delayMs: 15, replies: [REPLY] } },
  }, async (j) => {
    const { page, mocks, db } = j;
    const gemini = mocks.gemini;
    await j.goto('/');
    await page.getByRole('link', { name: /^Gemini · gemini-flash-lite-latest$/ }).waitFor();
    await ui.startJournaling(page, 'Today I finished a hard project at work. I love the feeling of a clean desk. I work as a developer.');
    await ui.companion(page).filter({ hasText: REPLY }).waitFor();

    // --- shape of the first request
    const first = gemini.generateRequests()[0];
    assert.match(first.path, /^\/v1beta\/models\/gemini-flash-lite-latest:streamGenerateContent$/);
    assert.equal(first.query.alt, 'sse');
    assert.equal(first.headers['x-goog-api-key'], GEMINI_KEY, 'the key travels in a header');
    assert.ok(!first.path.includes(GEMINI_KEY) && !JSON.stringify(first.query).includes(GEMINI_KEY), 'never in the URL');
    const body = first.body;
    assert.match(body.systemInstruction.parts[0].text, /^TASK: reply/);
    assert.equal(body.contents[0].role, 'user');
    assert.equal(body.contents.at(-1).role, 'user', 'the request never ends with a model turn (Google answers 400)');
    for (let i = 1; i < body.contents.length; i += 1) assert.notEqual(body.contents[i].role, body.contents[i - 1].role, 'turns alternate');
    assert.ok(body.contents.every((c) => c.parts.every((p) => typeof p.text === 'string' && p.text.trim() !== '')), 'no empty text parts (Google answers 400)');
    assert.equal(body.generationConfig.maxOutputTokens, 700 + 2048, 'thought tokens count against the cap, so the cap leaves room for them');
    assert.equal(body.generationConfig.temperature, 0.7);
    assert.equal(body.generationConfig.thinkingConfig, undefined, 'the default ("auto") sends no thinkingConfig');

    // --- a second message and a wrap-up: titles, summary, memories through Gemini too
    await ui.entryBox(page).fill('It felt like a weight lifted.');
    await ui.button(page, 'Send').click();
    await eventually(async () => assert.equal(await ui.companion(page).count(), 2));
    await ui.button(page, 'Wrap up').click();
    const summary = page.getByRole('region', { name: 'Entry summary' });
    await summary.waitFor({ timeout: 20_000 });
    await summary.getByText('Added to your memory').waitFor();
    const tasks = gemini.generateRequests().map((r) => /^TASK: (\w+)/.exec(r.body.systemInstruction.parts[0].text)[1]);
    assert.deepEqual(tasks, ['reply', 'reply', 'wrapup', 'meta', 'memory'], 'one call per step, in order, never in parallel');
    assert.equal(db.entries.list({ limit: 1 })[0].status, 'wrapped');
    assert.equal(mocks.local.chatRequests().length, 0, 'the local model was not used');

    // --- everything sent obeys the thinking rules learned from the live service
    const all = JSON.stringify(bodies(gemini));
    assert.ok(!all.includes('thinkingBudget'), 'thinkingBudget is never sent (3.x lite models answer 400)');
    assert.ok(!all.includes('"minimal"'), 'thinkingLevel "minimal" is never sent (3.8 flash answers 400)');

    // --- "Low" thinking is sent as thinkingLevel low
    await j.goto('/settings?tab=gemini');
    await page.getByText('Advanced', { exact: true }).click();
    await page.getByLabel('Thinking').selectOption('low');
    await ui.button(page, 'Save').click();
    await eventually(() => assert.equal(db.settings.get().ai.providers.gemini.thinking, 'low'));
    const made = await j.app.entry({ content: 'A quick note for the Low thinking check.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').click();
    await ui.companion(page).first().waitFor();
    assert.deepEqual(gemini.generateRequests().at(-1).body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  }));

  test('a guided journal starts with the companion\'s question as a model turn, which Gemini accepts', () => journey({
    name: 'gemini-guided', provider: 'gemini', mocks: { local: true, gemini: { live: true, replies: ['Lovely. Now, your thorn: what was hard today?'] } },
  }, async (j) => {
    const { page, mocks } = j;
    await j.goto('/');
    await page.getByRole('button', { name: /Rose, Thorn, Bud/ }).click();
    await page.waitForURL(/#\/entry\//);
    await ui.entryBox(page).fill('My rose: a long lunch with my sister.');
    await ui.button(page, 'Send').click();
    await ui.companion(page).filter({ hasText: 'your thorn' }).waitFor();
    const body = mocks.gemini.generateRequests().at(-1).body;
    assert.deepEqual(body.contents.map((c) => c.role), ['model', 'user'], 'the opening question is sent as a model turn, as is');
    assert.match(body.contents[0].parts[0].text, /Rose, Thorn, Bud/);
    assert.equal(await page.getByRole('alert').count(), 0);
  }));
});

describe('Gemini failure modes the live service really has', () => {
  test('a retired model: Test connection quotes Google\'s own suggestion and points to Load models', () => journey({
    name: 'gemini-retired', fresh: true, onboarded: true,
    mocks: { local: true, gemini: { live: true, retiredModels: { 'gemini-2.5-flash': 'gemini-3.8-flash' } } },
  }, async (j) => {
    const { page, mocks } = j;
    await j.goto('/settings?tab=gemini');
    await page.getByText('Advanced', { exact: true }).click();
    await page.getByLabel('Base URL', { exact: true }).fill(mocks.gemini.url);
    await page.getByLabel(/^API key/).fill(GEMINI_KEY);
    await page.getByLabel('Model', { exact: true }).fill('gemini-2.5-flash');
    await ui.button(page, 'Test connection').click();
    const failure = page.getByRole('alert').filter({ hasText: 'Things to try' });
    await failure.waitFor();
    const text = await failure.textContent(); // textContent: the code badge is upper-cased by CSS
    assert.match(text, /gemini-2\.5-flash/);
    assert.match(text, /gemini-3\.8-flash/, 'Google\'s suggested replacement is quoted');
    assert.match(text, /Load models/);
    assert.match(text, /model_not_found/);
    // Load models offers only chat models and the suggestion is on the list
    await ui.button(page, 'Load models').click();
    await page.getByText(/Found \d+ models/).waitFor();
    await page.getByRole('button', { name: /^gemini-3\.8-flash( |$)/ }).first().click();
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected', { exact: true }).waitFor();
  }));

  test('a busy model (503): the hint recommends the lite model, and switching in Settings gets the reply through', () => journey({
    name: 'gemini-overloaded', provider: 'gemini', settings: { ai: { providers: { gemini: { model: 'gemini-flash-latest' } } } },
    mocks: { local: true, gemini: { live: true, overloadedModels: ['gemini-flash-latest'], replies: [REPLY] } },
  }, async (j) => {
    const { page, mocks, db } = j;
    const made = await j.app.entry({ content: 'Will the smarter model answer?' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').click();
    const problem = banner(page, 'Try again');
    await problem.waitFor({ timeout: 20_000 });
    const text = await problem.innerText();
    assert.match(text, /gemini-flash-lite-latest/, 'the hint names the model that is rarely busy');
    assert.ok(mocks.gemini.generateRequests().length >= 1);
    assert.equal(db.messages.list(made.entry.id).length, 1, 'the person\'s message is safe');

    // the hint says to switch model in Settings, so the banner offers the way there next to Try again
    await problem.getByRole('button', { name: 'Try again' }).waitFor();
    await problem.getByRole('link', { name: 'Open settings' }).click();
    await page.waitForURL(/#\/settings\?tab=gemini/);
    await page.getByRole('button', { name: /^gemini-flash-lite-latest/ }).click();
    await ui.button(page, 'Save').click();
    await eventually(() => assert.equal(db.settings.get().ai.providers.gemini.model, 'gemini-flash-lite-latest'));
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').click();
    await ui.companion(page).filter({ hasText: REPLY }).waitFor();
    assert.equal(mocks.gemini.generateRequests().at(-1).path.includes('gemini-flash-lite-latest'), true);
  }));

  test('a key that stops working: the message and the way to Settings, then Try again after fixing it', () => journey({
    name: 'gemini-key-revoked', provider: 'gemini', mocks: { local: true, gemini: { live: true, replies: [REPLY] } },
  }, async (j) => {
    const { page, mocks } = j;
    const made = await j.app.entry({ content: 'Is my key still good?' });
    await j.goto(`/entry/${made.entry.id}`);
    mocks.gemini.setBehavior({ apiKey: ['a-different-key'] });
    await ui.button(page, 'Get a reply').click();
    const problem = banner(page, 'Gemini rejected the API key.');
    await problem.waitFor();
    await problem.getByText(/aistudio\.google\.com\/apikey/).waitFor();
    assert.match(await problem.getByRole('link', { name: 'Open settings' }).getAttribute('href'), /#\/settings\?tab=gemini/);
    mocks.gemini.setBehavior({ apiKey: [GEMINI_KEY] }); // the key works again
    await problem.getByRole('button', { name: 'Try again' }).click();
    await ui.companion(page).filter({ hasText: REPLY }).waitFor();
  }));

  test('a short rate limit is waited out; a daily quota says so', () => journey({
    name: 'gemini-quota', provider: 'gemini', mocks: { local: true, gemini: { live: true, replies: [REPLY], failures: [{ kind: 'rate_limit', retryDelay: '1s' }] } },
  }, async (j) => {
    const { page, mocks } = j;
    const made = await j.app.entry({ content: 'Slowly does it.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').click();
    await ui.companion(page).filter({ hasText: REPLY }).waitFor({ timeout: 15_000 });
    assert.equal(mocks.gemini.generateRequests().length, 2, 'one automatic retry after the wait Google asked for');
    assert.equal(await page.getByRole('alert').count(), 0);

    mocks.gemini.setBehavior({ failures: [{ kind: 'quota_daily' }] });
    await ui.entryBox(page).fill('And once more, after the daily allowance is gone.');
    await ui.button(page, 'Send').click();
    const problem = banner(page, 'Try again');
    await problem.waitFor({ timeout: 15_000 });
    assert.match(await problem.innerText(), /day|daily|tomorrow|quota|billing/i, 'the daily limit is named');
  }));

  test('Gemini declines to answer: the message says why and offers another way', () => journey({
    name: 'gemini-blocked', provider: 'gemini', mocks: { local: true, gemini: { live: true, failures: ['safety_candidate'] } },
  }, async (j) => {
    const { page, db } = j;
    const made = await j.app.entry({ content: 'Something heavy about my week.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').click();
    const problem = banner(page, 'declined');
    await problem.waitFor();
    await problem.getByText(/rephrase|another provider|switch provider/i).waitFor();
    assert.equal(db.messages.list(made.entry.id).length, 1);
  }));
});
