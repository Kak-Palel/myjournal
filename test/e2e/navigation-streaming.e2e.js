// Journey 15: leaving a page while something is still streaming (a reply, a wrap-up, a weekly reflection, a model
// download, a connection test). Nothing may throw, nothing may keep running in the background, the server must let go of
// its lock, and the person's words and the partial answer must still be there when they come back.

import {
  assert, describe, eventually, journey, seedSampleJournal, sleep, test, ui,
} from './helpers.js';

const LONG_REPLY = 'There is a lot to say about a day like that, and I want to take it slowly. '.repeat(6).trim();
const SLOW = { delayMs: 120, replies: [LONG_REPLY] };
const seed = (db) => seedSampleJournal(db);

/** Collect the URLs of every request the page makes from now on. */
function recordRequests(page) {
  const urls = [];
  page.on('request', (req) => { if (req.url().includes('/api/')) urls.push(`${req.method()} ${new URL(req.url()).pathname}`); });
  return urls;
}

/** Start a reply and wait until some of it is on screen. */
async function startStreaming(page, label = 'Get a reply') {
  await ui.button(page, label).click();
  const live = page.getByRole('article', { name: 'Reply in progress' });
  await live.waitFor();
  await eventually(async () => assert.ok((await live.innerText()).trim().length >= 10), { message: 'some streamed text' });
  return live;
}

describe('leaving a page while a reply streams', () => {
  test('clicking another page: no errors, the request is aborted, the partial reply is kept, nothing keeps polling, and the entry can be answered again', () => journey({
    name: 'nav-away-reply', mocks: { local: SLOW },
  }, async (j) => {
    const { page, db, mock } = j;
    const made = await j.app.entry({ content: 'A day I need to think about.' });
    const id = made.entry.id;
    await j.goto(`/entry/${id}`);
    await ui.mine(page).first().waitFor();
    await startStreaming(page);

    const requests = recordRequests(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'History' }).click();
    await ui.heading(page, 'History', 1).waitFor();

    // the model request was dropped and the server saved what had arrived, marked as stopped
    await mock.waitForIdle(8000);
    assert.equal(mock.chatRequests().at(-1).aborted, true, 'the upstream request was aborted');
    await eventually(() => {
      const last = db.messages.last(id);
      assert.equal(last.role, 'assistant');
      assert.equal(last.meta.stopped, true);
      assert.ok(last.content.length >= 5 && LONG_REPLY.startsWith(last.content.slice(0, 8)));
    }, { message: 'the partial reply to be saved on the server' });

    // nothing from the old entry page keeps talking to the server (no polling, no retries)
    const before = requests.length;
    await sleep(2600);
    const stray = requests.slice(before).filter((r) => r.includes(`/entries/${id}`));
    assert.deepEqual(stray, [], 'no requests for the abandoned entry after leaving it');
    assert.equal(await page.getByRole('article', { name: 'Reply in progress' }).count(), 0);

    // coming back: the partial reply is there, marked, and a new reply can be requested straight away (the lock is free)
    await j.goto(`/entry/${id}`);
    await ui.companion(page).filter({ hasText: 'Stopped' }).waitFor();
    mock.setBehavior({ delayMs: 0, replies: ['A fresh and complete reply.'] });
    await page.getByRole('button', { name: 'Regenerate this reply' }).click();
    await ui.companion(page).filter({ hasText: 'A fresh and complete reply.' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0, 'no "still finishing" complaint');
    assert.deepEqual(db.messages.list(id).map((m) => m.role), ['user', 'assistant']);
  }));

  test('the browser Back button, a typed address and a reload all leave cleanly', () => journey({
    name: 'nav-away-variants', mocks: { local: SLOW },
  }, async (j) => {
    const { page, db, mock } = j;
    const made = await j.app.entry({ content: 'Variants of leaving.' });
    const id = made.entry.id;

    // 1. Back
    await j.goto('/history');
    await ui.heading(page, 'History', 1).waitFor();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Today' }).click();
    await ui.todayBox(page).waitFor();
    await j.goto(`/entry/${id}`);
    await ui.mine(page).first().waitFor();
    await startStreaming(page);
    await page.goBack();
    await ui.todayBox(page).waitFor();
    await mock.waitForIdle(8000);
    await eventually(() => assert.equal(db.messages.last(id).meta.stopped, true));

    // 2. typing a different address
    mock.setBehavior({ replies: [LONG_REPLY] });
    await j.goto(`/entry/${id}`);
    await ui.button(page, 'Regenerate this reply').click();
    await page.getByRole('article', { name: 'Reply in progress' }).waitFor();
    await page.waitForTimeout(500);
    await j.goto('/memory');
    await ui.heading(page, 'Memory', 1).waitFor();
    await mock.waitForIdle(8000);

    // 3. a full page reload while the reply is streaming
    mock.setBehavior({ replies: [LONG_REPLY] });
    await j.goto(`/entry/${id}`);
    await ui.button(page, 'Regenerate this reply').click();
    await page.getByRole('article', { name: 'Reply in progress' }).waitFor();
    await page.waitForTimeout(500);
    await page.reload();
    await ui.mine(page).first().waitFor();
    await mock.waitForIdle(8000);
    mock.setBehavior({ delayMs: 0, replies: ['Back to normal.'] });
    await ui.button(page, 'Regenerate this reply').click();
    await ui.companion(page).filter({ hasText: 'Back to normal.' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0, 'the server released its lock after every kind of leaving');
  }));

  test('a burst of navigation while a reply streams stays calm', () => journey({
    name: 'nav-storm', mocks: { local: SLOW },
  }, async (j) => {
    const { page, mock } = j;
    const made = await j.app.entry({ content: 'Stress test.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.mine(page).first().waitFor();
    await startStreaming(page);
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (let round = 0; round < 3; round += 1) {
      for (const name of ['History', 'Insights', 'Memory', 'Settings', 'Today']) {
        await nav.getByRole('link', { name }).click({ noWaitAfter: true });
      }
    }
    await ui.todayBox(page).waitFor();
    await mock.waitForIdle(8000);
    await j.goto(`/entry/${made.entry.id}`);
    await ui.mine(page).first().waitFor();
    // the view is healthy afterwards: typing and saving works
    await ui.entryBox(page).fill('Still here after the storm.');
    mock.setBehavior({ delayMs: 0, replies: ['Calm now.'] });
    await ui.button(page, 'Send').click();
    await ui.companion(page).filter({ hasText: 'Calm now.' }).waitFor();
  }));
});

describe('leaving other pages mid-stream', () => {
  test('wrap-up: the server stops, the entry is not marked wrapped, and wrapping up again works', () => journey({
    name: 'nav-away-wrapup', mocks: { local: { delayMs: 150, replies: [LONG_REPLY] } },
  }, async (j) => {
    const { page, db, mock } = j;
    const made = await j.app.entry({ content: 'I love quiet mornings and I work as a baker.' });
    const id = made.entry.id;
    await j.goto(`/entry/${id}`);
    await ui.mine(page).first().waitFor();
    await ui.button(page, 'Wrap up').click();
    const live = page.getByRole('article', { name: 'Reflection in progress' });
    await live.waitFor();
    await eventually(async () => assert.ok((await live.innerText()).trim().length >= 10));
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Memory' }).click();
    await ui.heading(page, 'Memory', 1).waitFor();
    await mock.waitForIdle(10_000);
    await sleep(500);
    assert.notEqual(db.entries.get(id).status, 'wrapped', 'an abandoned wrap-up is not a finished one');
    assert.equal(db.memories.list().length, 0, 'no memories were saved from half a wrap-up');

    mock.setBehavior({ delayMs: 0, replies: [] });
    await j.goto(`/entry/${id}`);
    await ui.button(page, 'Wrap up').click();
    await page.getByRole('region', { name: 'Entry summary' }).waitFor({ timeout: 20_000 });
    assert.equal(db.entries.get(id).status, 'wrapped');
    assert.equal(await page.getByRole('alert').count(), 0);
  }));

  test('weekly reflection: leaving cancels it, saves nothing, and writing again works', () => journey({
    name: 'nav-away-weekly', seed, mocks: { local: { delayMs: 150, replies: [LONG_REPLY] } },
  }, async (j) => {
    const { page, db, mock } = j;
    await j.goto('/insights');
    await ui.button(page, 'Write my reflection').click();
    await page.getByText('Reading your week and writing...').waitFor();
    await eventually(async () => assert.ok((await page.getByRole('main').innerText()).includes('There is a lot to say')));
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'History' }).click();
    await ui.heading(page, 'History', 1).waitFor();
    await mock.waitForIdle(10_000);
    assert.equal(db.reports.list().length, 1, 'only the seeded reflection exists');

    mock.setBehavior({ delayMs: 0, replies: [] });
    await j.goto('/insights');
    await ui.button(page, 'Write my reflection').click();
    await page.getByText('Your reflection is ready').waitFor({ timeout: 20_000 });
    assert.equal(db.reports.list().length, 2);
  }));

  test('model download: leaving cancels it and the next download is allowed', () => journey({
    name: 'nav-away-download', mocks: { local: { pull: { delayMs: 300, steps: 12 } } },
  }, async (j) => {
    const { page, mock } = j;
    await j.goto('/settings?tab=local');
    await page.getByLabel('Model', { exact: true }).fill('qwen2.5:1.5b');
    await ui.button(page, 'Download qwen2.5:1.5b').click();
    await page.getByRole('progressbar', { name: 'Download progress' }).waitFor();
    await page.waitForTimeout(600);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'History' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click(); // the typed model name was never saved
    await ui.heading(page, 'History', 1).waitFor();
    await mock.waitForIdle(10_000);
    assert.ok(!mock.behavior.models.includes('qwen2.5:1.5b'), 'the download did not complete');

    mock.setBehavior({ pull: { delayMs: 0, steps: 3 } });
    await j.goto('/settings?tab=local');
    await page.getByLabel('Model', { exact: true }).fill('qwen2.5:1.5b');
    await ui.button(page, 'Download qwen2.5:1.5b').click();
    await page.getByText('qwen2.5:1.5b is ready').waitFor();
    assert.equal(await page.getByRole('alert').count(), 0, 'no "already downloading" complaint');
  }));

  test('leaving while Test connection or Load models is waiting is silent', () => journey({
    name: 'nav-away-test-connection', mocks: { local: { ttfbMs: 1500 } },
  }, async (j) => {
    const { page } = j;
    await j.goto('/settings?tab=local');
    await ui.button(page, 'Test connection').click();
    await page.getByText('Contacting the model...').waitFor();
    await ui.button(page, 'Load models').click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Memory' }).click();
    await ui.heading(page, 'Memory', 1).waitFor();
    await page.waitForTimeout(2200);
    assert.equal(await page.getByRole('alert').count(), 0);
  }));

  test('Today: leaving right after pressing Start journaling does not lose the entry or double-create it', () => journey({
    name: 'nav-away-start',
  }, async (j) => {
    const { page, db } = j;
    await j.goto('/');
    await ui.fillToday(page, 'Pressed Start and immediately clicked away.');
    await page.getByRole('button', { name: 'Start journaling' }).dblclick();
    await page.waitForURL(/#\/entry\//);
    await ui.companion(page).first().waitFor();
    await eventually(() => assert.equal(db.stats().entries, 1), { message: 'exactly one entry' });
    assert.equal(db.messages.list(db.entries.list({ limit: 5 })[0].id).filter((m) => m.role === 'user').length, 1);
  }));
});

describe('double actions', () => {
  test('pressing Send twice quickly (button, Ctrl+Enter) sends one message and asks for one reply', () => journey({
    name: 'double-send', mocks: { local: { delayMs: 40, replies: ['One reply only, please.'] } },
  }, async (j) => {
    const { page, db, mock } = j;
    const made = await j.app.entry({ content: 'Opening line.' });
    const id = made.entry.id;
    await j.goto(`/entry/${id}`);
    await ui.mine(page).first().waitFor();
    await ui.entryBox(page).fill('A message that must not be sent twice.');
    await ui.entryBox(page).press('Control+Enter');
    await ui.entryBox(page).press('Control+Enter').catch(() => {});
    await ui.button(page, 'Send').click({ timeout: 500 }).catch(() => {});
    await ui.companion(page).filter({ hasText: 'One reply only, please.' }).waitFor();
    await sleep(500);
    const users = db.messages.list(id).filter((m) => m.role === 'user');
    assert.equal(users.length, 2, `the message was saved once (saw ${users.map((m) => m.content).join(' | ')})`);
    assert.equal(mock.chatRequests().length, 1, 'one model call');
    assert.equal(await page.getByRole('alert').count(), 0, 'no "already running" warning shown to the person');
  }));

  test('Stop twice and Stop right as the reply finishes are harmless', () => journey({
    name: 'double-stop', mocks: { local: { delayMs: 30, replies: ['Short reply that ends soon after it starts, honestly.'] } },
  }, async (j) => {
    const { page, db } = j;
    const made = await j.app.entry({ content: 'Quick one.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.mine(page).first().waitFor();
    await ui.button(page, 'Get a reply').click();
    const stop = ui.button(page, 'Stop');
    await stop.waitFor();
    await stop.click().catch(() => {});
    await stop.click({ timeout: 300 }).catch(() => {});
    await ui.button(page, 'Send').waitFor();
    await sleep(2500); // the follow-up polling after a stop has finished
    const messages = db.messages.list(made.entry.id);
    assert.ok(messages.length <= 2, `at most one assistant message (saw ${messages.length})`);
    assert.equal(await page.getByRole('alert').count(), 0);
  }));
});
