// Journey 1: first run. A brand-new journal opens the welcome screen; choosing "Local small model" leads through
// Settings (Test connection against the mock, then Save) to Today. "Just journal, no AI" is the other way in.
// Note: the welcome choice already makes the provider the active one, so "Use this provider" is hidden on that tab
// (it is exercised in settings.e2e.js when switching providers).

import { describe, journey, test, ui, assert, eventually } from './helpers.js';

describe('first run', () => {
  test('welcome -> Local small model -> Test connection -> Save -> Today', () => journey({ fresh: true, name: 'first-run-local' }, async (j) => {
    const { page, mock, db } = j;

    // A fresh journal is sent to the welcome screen, not to Today.
    await j.goto('/');
    await ui.heading(page, 'A private place to think out loud', 1).waitFor();
    assert.match(page.url(), /#\/welcome$/);
    await ui.heading(page, 'Free Gemini').waitFor();
    await ui.heading(page, 'OpenAI-compatible').waitFor();
    await ui.heading(page, 'Local small model').waitFor();
    await ui.button(page, 'Just journal, no AI').waitFor();
    assert.equal(db.settings.get().onboarded, false, 'nothing is saved before a choice is made');

    await ui.button(page, 'Run it locally').click();
    await page.waitForURL(/#\/settings\?tab=local&setup=1/);
    assert.equal(db.settings.get().onboarded, true);
    assert.equal(db.settings.get().ai.provider, 'local', 'the welcome choice already selects the provider');
    assert.equal(await page.getByRole('button', { name: 'Use this provider' }).count(), 0, 'so there is nothing left to "use"');

    // The Local tab is open and the setup banner explains the next two steps.
    assert.equal(await ui.tab(page, 'Local model').getAttribute('aria-selected'), 'true');
    await page.getByText('Almost there - two quick steps').waitFor();
    await page.getByText('Quick start with Ollama').waitFor();

    // Point it at the mock server (Ollama's default address is not running here).
    await page.getByLabel('Base URL', { exact: true }).fill(mock.baseUrl);
    await page.getByRole('button', { name: 'Load models' }).click();
    await page.getByText(/Found \d+ models/).waitFor();

    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.getByText(/llama3\.2:3b - \d+ ms|llama3\.2:3b - [\d.]+ s/).waitFor();
    await eventually(() => assert.ok(mock.chatRequests().length >= 1), { message: 'the mock server to see the test request' });
    const probe = mock.chatRequests()[0].body;
    assert.equal(probe.model, 'llama3.2:3b');
    assert.equal(probe.stream, true);

    await ui.button(page, 'Save').click();
    await page.getByText('You are all set').waitFor();
    await eventually(() => {
      const ai = db.settings.get().ai;
      assert.equal(ai.provider, 'local');
      assert.equal(ai.enabled, true);
      assert.equal(ai.providers.local.baseUrl, mock.baseUrl);
    }, { message: 'the provider to be saved' });
    await page.getByText('In use', { exact: true }).first().waitFor();

    // The banner's call to action leads to Today, where the sidebar shows which model is active.
    await page.getByRole('link', { name: 'Start journaling' }).click();
    await ui.todayBox(page).waitFor();
    assert.match(page.url(), /#\/$/);
    await page.getByRole('link', { name: /Local model · llama3\.2:3b/ }).waitFor();

    // Reloading does not bring the welcome screen back.
    await j.reload();
    await ui.todayBox(page).waitFor();
    assert.doesNotMatch(page.url(), /welcome/);
  }));

  test('"Just journal, no AI" lands on Today and never calls a model', () => journey({ fresh: true, name: 'first-run-no-ai' }, async (j) => {
    const { page, mock, db } = j;
    await j.goto('/');
    await ui.button(page, 'Just journal, no AI').click();
    await ui.todayBox(page).waitFor();
    assert.match(page.url(), /#\/$/);
    await eventually(() => {
      const s = db.settings.get();
      assert.equal(s.onboarded, true);
      assert.equal(s.ai.enabled, false);
    }, { message: 'the choice to be saved' });
    await page.getByRole('link', { name: 'AI off' }).waitFor();

    // Writing works, is saved, and nothing is sent anywhere.
    await ui.startJournaling(page, 'First words in a journal without any AI.');
    await ui.mine(page).filter({ hasText: 'First words in a journal without any AI.' }).waitFor();
    await page.getByText('Journal-only mode.').waitFor();
    await ui.button(page, 'Save entry').waitFor();
    assert.equal(await ui.button(page, 'Send').count(), 0, 'there is no Send button without an AI');
    assert.equal(mock.chatRequests().length, 0, 'no model was called');

    await j.reload();
    await ui.mine(page).filter({ hasText: 'First words in a journal without any AI.' }).waitFor();
    assert.equal(db.entries.list({ limit: 10 }).length, 1);
  }));

  test('each welcome card opens the matching Settings tab', () => journey({ fresh: true, name: 'first-run-cards' }, async (j) => {
    const { page, db } = j;
    const cases = [
      ['Use Gemini', 'gemini', 'Gemini (free)'],
      ['Use my own API', 'openai', 'OpenAI-compatible'],
      ['Run it locally', 'local', 'Local model'],
    ];
    for (const [cta, id, tabLabel] of cases) {
      await j.goto('/welcome');
      await ui.button(page, cta).click();
      await page.waitForURL(new RegExp(`#/settings\\?tab=${id}&setup=1`));
      assert.equal(await ui.tab(page, tabLabel).getAttribute('aria-selected'), 'true', `${tabLabel} tab is selected`);
      assert.equal(db.settings.get().ai.provider, id);
    }
  }));
});
