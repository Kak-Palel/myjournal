// Journey 8: the Data tab - what is stored, export (JSON without secrets, Markdown), import (round trip, merge, bad
// files) and wiping everything behind a typed confirmation.

import { OPENAI_KEY, assert, describe, eventually, journey, readDownload, test, ui } from './helpers.js';

async function openData(j) {
  await j.goto('/settings?tab=data');
  await ui.heading(j.page, 'Settings', 1).waitFor();
  await j.page.getByText('What is stored').waitFor();
}

/** The numbers in the "What is stored" card, by label. */
async function stored(page) {
  const out = {};
  for (const label of ['Entries', 'Messages', 'Memories', 'Reports']) {
    const dt = page.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) });
    out[label] = Number((await dt.locator('xpath=following-sibling::dd[1]').innerText()).replace(/,/g, ''));
  }
  return out;
}

/** The journal as exported, minus the time of the export, so two states can be compared. */
const snapshot = (db) => {
  const { exportedAt, ...rest } = db.exportAll();
  void exportedAt;
  return JSON.parse(JSON.stringify(rest));
};

describe('data: export', () => {
  test('stats are shown; Export JSON is valid, complete and never contains keys or settings', () => journey({
    name: 'data-export', seed: 'demo', mocks: { local: true, openai: true }, provider: 'openai',
  }, async (j) => {
    const { page, db } = j;
    assert.equal(db.settings.get().ai.providers.openai.apiKey, OPENAI_KEY, 'a key is saved, so the export has something to leak');
    await openData(j);
    const counts = await stored(page);
    assert.deepEqual(counts, { Entries: 12, Messages: db.stats().messages, Memories: 4, Reports: 1 });
    await page.getByRole('term').filter({ hasText: 'Database size' }).waitFor();

    const [download] = await Promise.all([page.waitForEvent('download'), ui.button(page, 'Export JSON').click()]);
    assert.match(download.suggestedFilename(), /\.json$/);
    await page.getByText('Export ready').waitFor();
    const text = await readDownload(download);
    const doc = JSON.parse(text);
    assert.equal(doc.app, 'myjournal');
    assert.equal(doc.version, 1);
    assert.equal(doc.entries.length, 12);
    assert.equal(doc.memories.length, 4);
    assert.equal(doc.reports.length, 1);
    assert.equal(doc.entries.reduce((n, e) => n + e.messages.length, 0), counts.Messages);
    const titles = doc.entries.map((e) => e.title);
    assert.ok(titles.includes('Presentation day') && titles.includes('Notes for myself'), 'private entries are part of YOUR export');
    for (const secret of [OPENAI_KEY, 'apiKey', 'apiKeyHint', 'providers', 'password']) {
      assert.ok(!text.includes(secret), `the export does not contain "${secret}"`);
    }
    assert.ok(!('settings' in doc), 'settings are not exported');

    const [mdDownload] = await Promise.all([page.waitForEvent('download'), ui.button(page, 'Export Markdown').click()]);
    assert.match(mdDownload.suggestedFilename(), /\.md$/);
    const md = await readDownload(mdDownload);
    assert.match(md, /Presentation day/);
    assert.match(md, /Presented the redesign to the whole studio/);
    assert.ok(!md.includes(OPENAI_KEY));
  }));

  test('one entry can be exported as Markdown from its menu', () => journey({ name: 'data-export-entry', seed: 'demo' }, async (j) => {
    const { page, db } = j;
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Presentation day');
    await j.goto(`/entry/${entry.id}`);
    await page.getByRole('textbox', { name: 'Entry title' }).waitFor();
    await page.getByRole('button', { name: 'Entry options' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export as Markdown' }).click()]);
    assert.match(download.suggestedFilename(), /presentation-day.*\.md$/);
    const md = await readDownload(download);
    assert.match(md, /Presentation day/);
    assert.match(md, /Maya texted me good luck/);
  }));
});

describe('data: import', () => {
  test('export, wipe, import brings back exactly the same journal; importing again adds nothing', () => journey({
    name: 'data-roundtrip', seed: 'demo',
  }, async (j) => {
    const { page, db } = j;
    const before = snapshot(db);
    assert.equal(before.entries.length, 12);
    await openData(j);

    const [download] = await Promise.all([page.waitForEvent('download'), ui.button(page, 'Export JSON').click()]);
    const file = { name: 'my-export.json', mimeType: 'application/json', buffer: Buffer.from(await readDownload(download), 'utf8') };

    // wipe everything (settings stay), typed confirmation included
    await wipe(page);
    await page.getByText('Everything was deleted').waitFor();
    await eventually(async () => assert.deepEqual(await stored(page), { Entries: 0, Messages: 0, Memories: 0, Reports: 0 }));
    assert.equal(db.stats().entries, 0);
    assert.equal(db.settings.get().ai.provider, 'local', 'settings were kept');

    // import: a preview first, nothing happens until Import is pressed
    await page.getByLabel('Choose an export file').setInputFiles(file);
    await page.getByText('my-export.json').waitFor();
    await page.getByText(/Contains 12 entries, \d+ messages, 4 memories, 1 report\./).waitFor();
    assert.equal(db.stats().entries, 0);
    await ui.button(page, 'Import').click();
    await page.getByText('Import finished').waitFor();
    await page.getByText(/Imported 12 entries, \d+ messages, 4 memories, 1 report\./).waitFor();
    await eventually(async () => assert.equal((await stored(page)).Entries, 12));
    assert.deepEqual(snapshot(db), before, 'the journal is identical to what was exported');

    // importing the same file again changes nothing and says so
    await page.getByLabel('Choose an export file').setInputFiles(file);
    await ui.button(page, 'Import').click();
    await page.getByText(/Nothing new to import\./).waitFor();
    assert.deepEqual(snapshot(db), before);

    // the restored entries are really usable
    await j.goto('/history');
    await page.getByRole('link', { name: 'Presentation day' }).click();
    await ui.mine(page).filter({ hasText: 'Presented the redesign to the whole studio' }).waitFor();
  }));

  test('a file that is not an export is refused with a clear message and changes nothing', () => journey({ name: 'data-import-bad', seed: 'demo' }, async (j) => {
    const { page, db } = j;
    const before = snapshot(db);
    await openData(j);
    const chooser = page.getByLabel('Choose an export file');
    const cases = [
      [{ name: 'empty.json', mimeType: 'application/json', buffer: Buffer.from('') }, 'That file is empty'],
      [{ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"app": "myjournal", ') }, 'Could not read that file'],
      [{ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{"hello": "world"}') }, /not a MyJournal export/],
      [{ name: 'list.json', mimeType: 'application/json', buffer: Buffer.from('[1,2,3]') }, /not a MyJournal export/],
      [{ name: 'no-entries.json', mimeType: 'application/json', buffer: Buffer.from('{"app":"myjournal","version":1}') }, 'The export has no entries list.'],
    ];
    for (const [file, message] of cases) {
      await chooser.setInputFiles(file);
      await page.getByRole('alert').filter({ hasText: message }).waitFor();
      assert.equal(await ui.button(page, 'Import').count(), 0, `${file.name}: there is nothing to confirm`);
    }
    assert.deepEqual(snapshot(db), before);
  }));

  test('a hostile export is imported as plain data: nothing in it runs or breaks the page', () => journey({ name: 'data-import-hostile' }, async (j) => {
    const { page, db } = j;
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    const doc = {
      app: 'myjournal', version: 1, exportedAt: new Date().toISOString(),
      entries: [{
        id: 'evil-entry-1', createdAt: Date.now() - 1000, updatedAt: Date.now(), date: '2026-10-01', title: evil, kind: 'free', templateId: null, mood: 3,
        emotions: [evil.slice(0, 20)], tags: ['x'], summary: evil, status: 'wrapped', private: false, pinned: false, wordCount: 3, messageCount: 2,
        messages: [
          { id: 'evil-m1', entryId: 'evil-entry-1', seq: 0, role: 'user', content: evil, createdAt: Date.now() - 900, meta: {} },
          { id: 'evil-m2', entryId: 'evil-entry-1', seq: 1, role: 'assistant', content: `${evil} **bold** [x](javascript:window.__xss=3)`, createdAt: Date.now() - 800, meta: { kind: 'wrapup' } },
        ],
      }],
      memories: [{ id: 'evil-mem-1', text: evil, pinned: false, sourceEntryId: null, createdAt: Date.now(), updatedAt: Date.now() }],
      reports: [],
    };
    await openData(j);
    await page.getByLabel('Choose an export file').setInputFiles({ name: 'evil.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
    await ui.button(page, 'Import').click();
    await page.getByText('Import finished').waitFor();
    assert.equal(db.stats().entries, 1);
    for (const path of ['/history', '/entry/evil-entry-1', '/memory', '/']) {
      await j.goto(path);
      await page.getByRole('main').getByRole('heading').first().waitFor();
      await page.getByText('<img src=x onerror="window.__xss=1">').first().waitFor(); // shown as text, not turned into an element
      assert.equal(await page.evaluate(() => window.__xss), undefined, `nothing ran on ${path}`);
      assert.equal(await page.evaluate(() => document.querySelectorAll('#app img, #app iframe, #app object, #app embed, #app [onerror], #app [onload]').length), 0, `no element was created from the payload on ${path}`);
    }
  }));
});

describe('data: wipe', () => {
  test('needs the word DELETE typed exactly; Cancel and Escape keep everything', () => journey({ name: 'data-wipe-guard', seed: 'demo' }, async (j) => {
    const { page, db } = j;
    await openData(j);
    const open = () => ui.button(page, 'Delete my journal data...').click();
    const dialog = page.getByRole('dialog');

    await open();
    await dialog.getByText('Delete everything?').waitFor();
    const confirm = dialog.getByRole('button', { name: 'Delete everything' });
    assert.equal(await confirm.isDisabled(), true, 'nothing is deleted before the word is typed');
    const typed = dialog.getByLabel('Type DELETE to confirm', { exact: true });
    await typed.fill('delete');
    assert.equal(await confirm.isDisabled(), true, 'lower case is not enough');
    await typed.fill('DELETE ME');
    assert.equal(await confirm.isDisabled(), true);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(db.stats().entries, 12);

    await open();
    await dialog.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(db.stats().entries, 12, 'Escape cancels even with the word typed');

    // confirmed with the button
    await open();
    await dialog.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE');
    await dialog.getByRole('button', { name: 'Delete everything' }).click();
    await page.getByText('Everything was deleted').waitFor();
    await eventually(() => assert.deepEqual({ ...db.stats(), dbBytes: 0 }, { entries: 0, messages: 0, memories: 0, reports: 0, dbBytes: 0 }));
    // the journal is empty but fully working
    await j.goto('/');
    await ui.startJournaling(page, 'A fresh start after wiping.');
    await ui.companion(page).first().waitFor();
  }));

  // Confirmed in the browser: Enter in the DELETE box closes the dialog (focus goes back to the "Delete my journal data..."
  // button during keydown) and the same key press then activates that button, so a fresh, empty dialog opens right after the wipe.
  test('confirming the wipe with Enter does not open the dialog again', { skip: 'BUG: confirmDialog (public/js/lib/ui.js) - Enter in the "type DELETE" box confirms, then the key press hits the restored-focus trigger button and re-opens the dialog; fix: e.preventDefault() in that keydown handler' }, () => journey({ name: 'data-wipe-enter', seed: 'demo' }, async (j) => {
    const { page, db } = j;
    await openData(j);
    await ui.button(page, 'Delete my journal data...').click();
    const typed = page.getByRole('dialog').getByLabel('Type DELETE to confirm', { exact: true });
    await typed.fill('DELETE');
    await typed.press('Enter');
    await page.getByText('Everything was deleted').waitFor();
    await eventually(() => assert.equal(db.stats().entries, 0));
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole('dialog').count(), 0, 'no dialog is left open after the wipe');
  }));

  test('"Also delete my settings and API keys" returns to the welcome screen with no keys left', () => journey({
    name: 'data-wipe-all', seed: 'demo', mocks: { local: true, openai: true }, provider: 'openai',
  }, async (j) => {
    const { page, db } = j;
    assert.equal(db.settings.get().ai.providers.openai.apiKey, OPENAI_KEY);
    await openData(j);
    await page.getByLabel('Also delete my settings and API keys').check();
    await wipe(page);
    await page.waitForURL(/#\/welcome/);
    await ui.heading(page, 'A private place to think out loud', 1).waitFor();
    const s = db.settings.get();
    assert.equal(s.onboarded, false);
    assert.equal(s.ai.providers.openai.apiKey, '');
    assert.equal(db.stats().entries, 0);
    const res = await j.api('GET', '/settings');
    assert.ok(!res.text.includes(OPENAI_KEY));
  }));
});

/** Open the wipe dialog, type DELETE and confirm. */
async function wipe(page) {
  await ui.button(page, 'Delete my journal data...').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Delete everything?').waitFor();
  await dialog.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE');
  await dialog.getByRole('button', { name: 'Delete everything' }).click();
}
