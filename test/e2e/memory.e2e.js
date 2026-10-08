// Journey 6: Memory - add, pin, edit, delete (two steps), clear all, and the three master switches, including their
// real effect on what is sent to the model.

import { describe, journey, test, ui, assert, eventually } from './helpers.js';

// scoped to the list: the explainer above it quotes two example memories
const item = (page, text) => page.getByRole('region', { name: 'What I remember' }).getByRole('listitem').filter({ hasText: text });
const switchNamed = (page, name) => ui.switch(page, name);

describe('memory', () => {
  test('add, pin, edit, cancel with Escape, save with Ctrl+Enter, and delete in two steps', () => journey({ name: 'memory-crud', seed: 'demo' }, async (j) => {
    const { page, db } = j;
    await j.goto('/memory');
    await ui.heading(page, 'Memory', 1).waitFor();
    await ui.heading(page, 'How memory works', 2).waitFor();
    await page.getByText('4 memories', { exact: true }).waitFor();
    await item(page, 'Has a younger sister called Maya').waitFor();

    // add (an empty text is refused politely)
    const addBox = page.getByLabel('Add a memory');
    await ui.button(page, 'Add memory').click();
    await page.getByRole('alert').filter({ hasText: /.+/ }).first().waitFor();
    assert.equal(db.memories.list().length, 4);
    await addBox.fill('Prefers short walks to the gym');
    await ui.button(page, 'Add memory').click();
    await item(page, 'Prefers short walks to the gym').waitFor();
    await page.getByText('5 memories', { exact: true }).waitFor();
    await eventually(() => assert.ok(db.memories.list().some((m) => m.text === 'Prefers short walks to the gym')));
    assert.equal(await addBox.inputValue(), '', 'the box is emptied after adding');

    // Ctrl+Enter adds too
    await addBox.fill('Drinks tea, not coffee');
    await addBox.press('Control+Enter');
    await item(page, 'Drinks tea, not coffee').waitFor();

    // pin moves it to the top and survives a reload
    const walks = item(page, 'Prefers short walks to the gym');
    await walks.getByRole('button', { name: 'Pin this memory' }).click();
    await walks.getByText('Pinned', { exact: true }).waitFor();
    await eventually(() => assert.equal(db.memories.list().find((m) => m.text.startsWith('Prefers short')).pinned, true));
    await j.reload();
    await item(page, 'Prefers short walks to the gym').waitFor();
    const order = await page.getByRole('region', { name: 'What I remember' }).getByRole('listitem').allInnerTexts();
    assert.match(order[0], /Maya|Prefers short walks/, 'pinned memories come first');
    assert.ok(order.findIndex((t) => /Prefers short walks/.test(t)) <= 1, 'the newly pinned memory is at the top, next to the other pinned one');
    await item(page, 'Prefers short walks to the gym').getByRole('button', { name: 'Unpin this memory' }).click();
    await eventually(() => assert.equal(db.memories.list().find((m) => m.text.startsWith('Prefers short')).pinned, false));

    // edit: Escape cancels, Ctrl+Enter saves, Save button saves
    const tea = item(page, 'Drinks tea, not coffee');
    await tea.getByRole('button', { name: 'Edit this memory' }).click();
    const editor = page.getByRole('textbox', { name: 'Edit memory' });
    await editor.waitFor();
    assert.equal(await editor.inputValue(), 'Drinks tea, not coffee');
    await editor.fill('Changed my mind');
    await editor.press('Escape');
    await item(page, 'Drinks tea, not coffee').waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Edit memory' }).count(), 0);
    assert.ok(db.memories.list().some((m) => m.text === 'Drinks tea, not coffee'), 'Escape discarded the edit');

    await item(page, 'Drinks tea, not coffee').getByRole('button', { name: 'Edit this memory' }).click();
    await editor.fill('Drinks green tea, not coffee');
    await editor.press('Control+Enter');
    await item(page, 'Drinks green tea, not coffee').waitFor();
    await eventually(() => assert.ok(db.memories.list().some((m) => m.text === 'Drinks green tea, not coffee')));

    await item(page, 'Drinks green tea, not coffee').getByRole('button', { name: 'Edit this memory' }).click();
    await editor.fill('Drinks green tea');
    await ui.button(page, 'Save').click();
    await item(page, 'Drinks green tea').waitFor();
    assert.equal(db.memories.list().filter((m) => m.text.startsWith('Drinks')).length, 1);

    // delete needs a second click; Keep backs out
    const target = item(page, 'Drinks green tea');
    await target.getByRole('button', { name: 'Delete this memory' }).click();
    await target.getByText('Forget this?').waitFor();
    await target.getByRole('button', { name: 'Keep' }).click();
    await target.getByRole('button', { name: 'Delete this memory' }).waitFor();
    assert.ok(db.memories.list().some((m) => m.text === 'Drinks green tea'));
    await target.getByRole('button', { name: 'Delete this memory' }).click();
    await target.getByRole('button', { name: 'Forget', exact: true }).click();
    await eventually(async () => assert.equal(await item(page, 'Drinks green tea').count(), 0));
    assert.ok(!db.memories.list().some((m) => m.text.startsWith('Drinks')));
  }));

  test('"Clear all" asks first and leaves an explained empty state', () => journey({ name: 'memory-clear', seed: 'demo' }, async (j) => {
    const { page, db } = j;
    await j.goto('/memory');
    await page.getByText('4 memories', { exact: true }).waitFor();
    await ui.button(page, 'Clear all').click();
    await page.getByRole('dialog').getByText('Forget everything?').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    assert.equal(db.memories.list().length, 4);
    await ui.button(page, 'Clear all').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Forget everything' }).click();
    await page.getByText('Nothing remembered yet').waitFor();
    await eventually(() => assert.equal(db.memories.list().length, 0));
    assert.equal(await ui.button(page, 'Clear all').isVisible(), false);
  }));

  test('master switches persist, disable each other correctly and change what the model is told', () => journey({
    name: 'memory-switches', seed: 'demo',
  }, async (j) => {
    const { page, db, mock } = j;
    await j.goto('/memory');
    const remember = switchNamed(page, /Remember things about me/);
    const suggest = switchNamed(page, /Suggest memories when I wrap up an entry/);
    const recall = switchNamed(page, /Recall related past entries/);
    await remember.waitFor();
    for (const sw of [remember, suggest, recall]) assert.equal(await sw.isChecked(), true);

    // while memory is on, replies are written with the memories in the prompt
    const entry = await j.app.entry({ content: 'Dinner with my sister tonight.' });
    await j.goto(`/entry/${entry.entry.id}`);
    await ui.mine(page).filter({ hasText: 'Dinner with my sister' }).waitFor();
    await ui.button(page, 'Get a reply').click();
    await ui.companion(page).first().waitFor();
    assert.match(mock.chatRequests().at(-1).body.messages[0].content, /Maya/, 'memories are part of the prompt');

    // switch memory off: the other two switches become inactive and a notice explains it
    await j.goto('/memory');
    await ui.flip(page, /Remember things about me/);
    await page.getByText('Memory is off.').waitFor();
    await eventually(() => assert.equal(db.settings.get().memory.enabled, false));
    assert.equal(await suggest.isDisabled(), true);
    assert.equal(await recall.isDisabled(), true);
    await j.reload();
    await page.getByText('Memory is off.').waitFor();
    assert.equal(await switchNamed(page, /Remember things about me/).isChecked(), false, 'the choice survives a reload');
    assert.equal(db.memories.list().length, 4, 'existing memories are kept');

    // ... and the model is no longer told about them
    await j.goto(`/entry/${entry.entry.id}`);
    await ui.entryBox(page).fill('And dessert too.');
    await ui.button(page, 'Send').click();
    await ui.companion(page).nth(1).waitFor();
    const system = mock.chatRequests().at(-1).body.messages[0].content;
    assert.doesNotMatch(system, /Maya/, 'memories are not sent while memory is off');

    // back on, and the two sub-switches work independently
    await j.goto('/memory');
    await ui.flip(page, /Remember things about me/);
    await eventually(() => assert.equal(db.settings.get().memory.enabled, true));
    await eventually(async () => assert.equal(await switchNamed(page, /Suggest memories/).isDisabled(), false));
    await ui.flip(page, /Suggest memories/);
    await eventually(() => assert.equal(db.settings.get().memory.autoExtract, false));
    await ui.flip(page, /Recall related past entries/);
    await eventually(() => assert.equal(db.settings.get().memory.useRelatedEntries, false));
    await j.reload();
    assert.equal(await switchNamed(page, /Suggest memories/).isChecked(), false);
    assert.equal(await switchNamed(page, /Recall related past entries/).isChecked(), false);
    assert.equal(await switchNamed(page, /Remember things about me/).isChecked(), true);
  }));

  test('with automatic suggestions off, wrapping up an entry adds no memory', () => journey({
    name: 'memory-no-autoextract', settings: { memory: { autoExtract: false } },
  }, async (j) => {
    const { page, db, mock } = j;
    const made = await j.app.entry({ content: 'I love long walks by the river and I work as a gardener.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.mine(page).first().waitFor();
    await ui.button(page, 'Wrap up').click();
    await page.getByRole('region', { name: 'Entry summary' }).waitFor({ timeout: 20_000 });
    assert.equal(db.memories.list().length, 0);
    const tasks = mock.chatRequests().map((r) => /^TASK: (\w+)/.exec(r.body.messages[0].content)[1]);
    assert.ok(!tasks.includes('memory'), `no memory extraction call was made (calls: ${tasks.join(', ')})`);
    assert.equal(await page.getByRole('region', { name: 'Entry summary' }).getByText('Added to your memory').count(), 0);
  }));
});
