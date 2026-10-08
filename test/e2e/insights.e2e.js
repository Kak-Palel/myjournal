// Journey 5: Insights renders its stat cards and charts from the seeded journal, remembers the chosen range, and writes a
// weekly reflection (streamed) next to the one that already exists.

import { describe, journey, test, ui, assert, eventually } from './helpers.js';

const pad = (n) => String(n).padStart(2, '0');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

describe('insights', () => {
  test('stat cards, mood chart, writing days, top emotions and tags match the data', () => journey({ name: 'insights-render', seed: 'demo' }, async (j) => {
    const { page, app } = j;
    const overview = (await app.get(`/api/insights/overview?today=${localToday()}&days=90`)).json;
    assert.equal(overview.totals.entries, 12);

    await j.goto('/insights');
    await ui.heading(page, 'Insights', 1).waitFor();

    // stat cards show the numbers the API computed
    const value = (label) => page.getByRole('main').getByText(label, { exact: true }).first().locator('xpath=following-sibling::*[1]');
    await page.getByText('Current streak', { exact: true }).waitFor();
    assert.match(await value('Entries').innerText(), new RegExp(`^${overview.totals.entries}\\b`));
    assert.match(await value('Words written').innerText(), new RegExp(`^${overview.totals.words.toLocaleString('en-US')}\\b`));
    assert.match(await value('Days written').innerText(), new RegExp(`^${overview.totals.daysWritten}\\b`));
    assert.match(await value('Average mood').innerText(), new RegExp(`^${overview.mood.average.toFixed(1)}`));

    // charts are real, labelled images with a table version for screen readers
    const moodChart = page.getByRole('img', { name: /Mood over the last 90 days/ });
    await moodChart.waitFor();
    assert.ok((await moodChart.locator('title').first().textContent()).includes('90 days'));
    await page.getByRole('img', { name: /Writing days|days written|wrote/i }).first().waitFor();
    const moodTable = page.getByRole('table').first();
    await moodTable.waitFor({ state: 'attached' });
    assert.ok((await page.getByRole('table').count()) >= 3, 'mood, calendar and the bar charts each have a table version');

    // top emotions and tags
    const emotionsTable = page.getByRole('table', { name: 'Top emotions' });
    await emotionsTable.waitFor({ state: 'attached' });
    const emotionRows = (await emotionsTable.locator('tbody tr').allInnerTexts()).map((r) => r.split('\t')[0].trim());
    assert.deepEqual(emotionRows, overview.emotions.map((e) => e.name), 'bars list the same emotions in the same order');
    const tagsTable = page.getByRole('table', { name: 'Top tags' });
    const tagRows = (await tagsTable.locator('tbody tr').allInnerTexts()).map((r) => r.split('\t')[0].trim());
    assert.deepEqual(tagRows, overview.tags.map((t) => t.name));

    // tapping a point reads it out (touch devices have no tooltips)
    await page.getByText('Hover or tap a point for details.').waitFor();

    // the range switch re-queries and is remembered across a reload
    const thirty = page.getByRole('radio', { name: '30 days' });
    await thirty.click();
    assert.equal(await thirty.getAttribute('aria-checked'), 'true');
    await page.getByRole('img', { name: /Mood over the last 30 days/ }).waitFor();
    await j.reload();
    await page.getByRole('img', { name: /Mood over the last 30 days/ }).waitFor();
    assert.equal(await page.getByRole('radio', { name: '30 days' }).getAttribute('aria-checked'), 'true');
    await page.getByRole('radio', { name: '1 year' }).click();
    await page.getByRole('img', { name: /Mood over the last 365 days/ }).waitFor();
  }));

  test('weekly reflection: the seeded one is listed, a new one streams in and can be deleted', () => journey({
    name: 'insights-weekly', seed: 'demo', mocks: { local: { delayMs: 15 } },
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/insights');
    await ui.heading(page, 'Weekly reflection', 2).waitFor();
    await page.getByText('Past reflections').waitFor();
    await page.getByText('How the week felt.').waitFor();
    assert.equal(db.reports.list().length, 1);

    await ui.button(page, 'Write my reflection').click();
    await page.getByText('Reading your week and writing...').waitFor();
    await ui.button(page, 'Stop').waitFor();
    await page.getByText('Your reflection is ready').waitFor();
    await eventually(() => assert.equal(db.reports.list().length, 2), { message: 'the new reflection to be saved' });
    const created = db.reports.list().find((r) => r.content.includes('The shape of your week.'));
    assert.ok(created, 'the mock model wrote the weekly text');
    assert.equal(created.meta.provider, 'local');

    // markdown-lite from the model is rendered as formatting, not shown as asterisks
    const lead = page.locator('strong', { hasText: 'The shape of your week.' }).first();
    await lead.waitFor();
    assert.equal(await page.getByText('**The shape of your week.**').count(), 0);

    // the weekly request carries the entries of the period but not the private one
    const weekly = j.mock.chatRequests().at(-1).body;
    assert.match(weekly.messages[0].content, /^TASK: weekly/);
    assert.ok(!JSON.stringify(weekly.messages).includes('Private reflections on what matters this year'), 'private entries are never sent');

    // delete asks first
    await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
    await page.getByRole('dialog').getByText('Delete this reflection?').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    assert.equal(db.reports.list().length, 2, 'Cancel keeps it');
    await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await eventually(() => assert.equal(db.reports.list().length, 1), { message: 'the reflection to be deleted' });
  }));

  test('without entries the page invites writing, and the weekly reflection explains why it cannot run', () => journey({ name: 'insights-empty' }, async (j) => {
    const { page, diag } = j;
    diag.expectStatus(422, /insights\/weekly/);
    await j.goto('/insights');
    await page.getByText('Your insights will grow with you').waitFor();
    await page.getByRole('link', { name: 'Write your first entry' }).waitFor();
    await ui.button(page, 'Write my reflection').click();
    await page.getByText('Not enough to reflect on yet').waitFor();
    await page.getByRole('link', { name: 'Write an entry' }).waitFor();
  }));

  test('without an AI the reflection card says what is needed and everything else still works', () => journey({ name: 'insights-no-ai', provider: '', seed: 'demo' }, async (j) => {
    const { page } = j;
    await j.goto('/insights');
    await page.getByText('Set up an AI to write reflections').waitFor();
    assert.equal(await ui.button(page, 'Write my reflection').isVisible(), false);
    await page.getByRole('img', { name: /Mood over the last 90 days/ }).waitFor();
    await page.getByRole('main').getByRole('link', { name: 'Set up AI', exact: true }).click();
    await ui.heading(page, 'Settings', 1).waitFor();
  }));
});
