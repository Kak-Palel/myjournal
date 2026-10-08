// Journey 7 (continued): the General tab - name, about, companion style, creativity, limits, AI on/off and the theme -
// saved, validated, persisted across a reload, and actually used by the rest of the app.

import { describe, journey, test, ui, assert, eventually } from './helpers.js';

const luminance = (rgb) => {
  const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};
const pageBackground = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function openGeneral(j) {
  await j.goto('/settings?tab=general');
  await ui.heading(j.page, 'Settings', 1).waitFor();
  await j.page.getByLabel('Your name').waitFor();
}

describe('settings: General tab', () => {
  test('name, about, style and creativity are saved, persisted, shown and sent to the model', () => journey({ name: 'settings-general-profile' }, async (j) => {
    const { page, db, mock } = j;
    await openGeneral(j);
    const save = ui.button(page, 'Save changes');
    assert.equal(await save.getAttribute('aria-disabled'), 'true', 'nothing to save yet');

    await page.getByLabel('Your name').fill('Sam');
    await page.getByLabel('About you').fill('I am a nurse on night shifts and I want to sleep better.');
    await page.getByRole('radio', { name: /^Coach/ }).check();
    const creativity = page.getByLabel('Creativity');
    await creativity.focus();
    await creativity.press('End');
    await page.getByText(/2\.00 - Adventurous/).waitFor();
    await page.getByText('Unsaved changes').first().waitFor();
    await ui.tab(page, 'General').getByText('Unsaved').waitFor();
    await save.click();
    await page.getByText('Saved', { exact: true }).first().waitFor();
    await page.getByText('Unsaved changes').waitFor({ state: 'hidden' });

    await eventually(() => {
      const s = db.settings.get();
      assert.equal(s.profile.name, 'Sam');
      assert.equal(s.persona.id, 'coach');
      assert.equal(s.ai.temperature, 2);
    }, { message: 'the General settings to be stored' });

    // a reload shows exactly the same values
    await j.reload();
    await page.getByLabel('Your name').waitFor();
    assert.equal(await page.getByLabel('Your name').inputValue(), 'Sam');
    assert.match(await page.getByLabel('About you').inputValue(), /nurse on night shifts/);
    assert.equal(await page.getByRole('radio', { name: /^Coach/ }).isChecked(), true);
    assert.equal(await page.getByLabel('Creativity').inputValue(), '2');

    // Revert undoes edits that were not saved
    await page.getByLabel('Your name').fill('Someone else');
    await ui.button(page, 'Revert').click();
    assert.equal(await page.getByLabel('Your name').inputValue(), 'Sam');

    // the greeting uses the name, and the model is told who it is talking to
    await j.goto('/');
    await ui.heading(page, /^(Good morning|Good afternoon|Good evening|Still up), Sam$/, 1).waitFor();
    const made = await j.app.entry({ content: 'Long shift tonight.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').click();
    await ui.companion(page).first().waitFor();
    const request = mock.chatRequests().at(-1).body;
    assert.equal(request.temperature, 2);
    const system = request.messages[0].content;
    assert.match(system, /Sam/);
    assert.match(system, /nurse on night shifts/);
  }));

  test('the custom style box appears only for "Your own" and numbers snap into range', () => journey({ name: 'settings-general-limits' }, async (j) => {
    const { page, db } = j;
    await openGeneral(j);
    const custom = page.getByLabel('Your own style');
    assert.equal(await custom.isVisible(), false);
    await page.getByRole('radio', { name: /^Custom/ }).check();
    await custom.waitFor();
    await custom.fill('Speak like a calm old friend. Be brief.');

    await page.getByText('Reply length, context and timeout').click();
    const tokens = page.getByLabel('Longest reply (tokens)');
    await tokens.fill('99999');
    await page.getByLabel('Wait for the first word (seconds)').fill('1');
    await ui.button(page, 'Save changes').click();
    await eventually(() => {
      const s = db.settings.get();
      assert.equal(s.ai.maxTokens, 8192, 'clamped to the maximum');
      assert.equal(s.ai.timeoutSec, 5, 'clamped to the minimum');
      assert.equal(s.persona.id, 'custom');
      assert.match(s.persona.custom, /calm old friend/);
    }, { message: 'clamped values to be stored' });
    assert.equal(await tokens.inputValue(), '8192');

    // an empty number next to another edit is refused with a message beside the field, and nothing is stored
    await tokens.fill('');
    await page.getByLabel('Your name').fill('Edited name');
    await ui.button(page, 'Save changes').click();
    await page.getByText(/Enter a number between 64 and 8192/).waitFor();
    assert.equal(db.settings.get().ai.maxTokens, 8192);
    assert.equal(db.settings.get().profile.name, '');
  }));

  // Regression: with ONLY the number cleared the form was not "dirty" (an empty field fell back to the saved value), so Save was
  // dimmed and pressing it showed nothing at all. An emptied number now counts as an edit and Save explains what is wrong.
  test('clearing a number and pressing Save explains the problem', () => journey({ name: 'settings-general-empty-number' }, async (j) => {
    const { page } = j;
    await openGeneral(j);
    await page.getByText('Reply length, context and timeout').click();
    await page.getByLabel('Longest reply (tokens)').fill('');
    await ui.button(page, 'Save changes').click({ force: true });
    await page.getByText(/Enter a number between 64 and 8192/).waitFor({ timeout: 2000 });
  }));

  test('switching the AI companion off turns the app into a plain journal everywhere, and back on again', () => journey({ name: 'settings-general-ai-off', seed: 'demo' }, async (j) => {
    const { page, db, mock } = j;
    await openGeneral(j);
    const toggle = ui.switch(page, /Use the AI companion/);
    assert.equal(await toggle.isChecked(), true);
    await ui.flip(page, /Use the AI companion/);
    await ui.button(page, 'Save changes').click();
    await eventually(() => assert.equal(db.settings.get().ai.enabled, false));
    await page.getByText('AI companion is off.').waitFor();
    await page.getByRole('link', { name: 'AI off' }).waitFor();

    // an entry then has no Send button, only Save
    const made = await j.app.entry({ content: 'A quiet note without AI.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Save entry').waitFor();
    assert.equal(await ui.button(page, 'Send').count(), 0);
    await page.getByText('Journal-only mode.').waitFor();
    // Insights says why there is no reflection button
    await j.goto('/insights');
    await page.getByText('The AI companion is switched off').waitFor();
    assert.equal(mock.chatRequests().length, 0);

    // back on from the status line's link
    await j.goto('/settings?tab=general');
    await ui.flip(page, /Use the AI companion/);
    await ui.button(page, 'Save changes').click();
    await eventually(() => assert.equal(db.settings.get().ai.enabled, true));
    await page.getByRole('link', { name: /Local model · llama3\.2:3b/ }).waitFor();
  }));

  test('theme: Light, Dark and "Match my device" apply at once, persist, and follow the device', () => journey({ name: 'settings-theme', colorScheme: 'dark' }, async (j) => {
    const { page } = j;
    await openGeneral(j);
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    assert.equal(await theme(), 'auto');
    assert.ok(luminance(await pageBackground(page)) < 0.3, 'auto follows a dark device');

    await page.getByRole('radio', { name: 'Light' }).check();
    assert.equal(await theme(), 'light');
    assert.ok(luminance(await pageBackground(page)) > 0.7, 'light theme has a light background');
    await j.reload();
    await ui.heading(page, 'Settings', 1).waitFor();
    assert.equal(await theme(), 'light', 'remembered after a reload');
    assert.ok(luminance(await pageBackground(page)) > 0.7);

    await page.getByRole('radio', { name: 'Dark' }).check();
    assert.equal(await theme(), 'dark');
    assert.ok(luminance(await pageBackground(page)) < 0.3);
    await page.getByRole('radio', { name: 'Match my device' }).check();
    assert.equal(await theme(), 'auto');
    await page.emulateMedia({ colorScheme: 'light' });
    assert.ok(luminance(await pageBackground(page)) > 0.7, 'auto follows the device when it turns light');

    // the sidebar button cycles through the same three
    await page.getByRole('button', { name: 'Change theme' }).click();
    assert.equal(await theme(), 'light');
    await page.getByRole('button', { name: 'Change theme' }).click();
    assert.equal(await theme(), 'dark');
  }));
});
