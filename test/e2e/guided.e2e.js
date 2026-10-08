// Journey 3: guided journals. Today's grid opens "Rose, Thorn, Bud": the entry starts with the companion's opening
// question (no AI call), the answer is sent with the guidance, and the next question follows.

import { describe, journey, test, ui, assert, eventually } from './helpers.js';

const OPENING = "Let's do a Rose, Thorn, Bud check-in, one part at a time. First, your rose: what was a highlight of your day, big or small?";
const ROSE_ANSWER = 'My rose was finishing the chapter I have been stuck on for a week.';
const NEXT_QUESTION = 'Finishing something stuck feels wonderful. Now your thorn: what was hard today?';

describe('guided journals', () => {
  test('Rose, Thorn, Bud: opening question without an AI call, then a guided reply', () => journey({
    name: 'guided-rose-thorn-bud',
    mocks: { local: { replies: [NEXT_QUESTION] } },
  }, async (j) => {
    const { page, mock, db } = j;
    await j.goto('/');

    // The grid is grouped by category and every template is a button.
    await ui.heading(page, 'Guided journals', 2).waitFor();
    await ui.heading(page, 'Daily', 3).waitFor();
    const buttonCount = await page.getByRole('group', { name: /journals$/ }).getByRole('button').count();
    assert.ok(buttonCount >= 12, `all 12 guided journals are listed (saw ${buttonCount})`);

    await page.getByRole('button', { name: /Rose, Thorn, Bud/ }).click();
    await page.waitForURL(/#\/entry\//);

    // The opening is the template's own text, shown as a guided prompt, and no model was called to get it.
    await ui.companion(page).filter({ hasText: OPENING }).waitFor();
    await page.getByText('Guided prompt').waitFor();
    assert.equal(mock.chatRequests().length, 0, 'opening a guided journal costs no AI call');
    const entryId = ui.entryId(page);
    const entry = db.entries.get(entryId);
    assert.equal(entry.kind, 'guided');
    assert.equal(entry.templateId, 'rose-thorn-bud');
    const msgs = db.messages.list(entryId);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].meta.kind, 'prompt');

    // Answer; the reply continues with the next part.
    await ui.entryBox(page).fill(ROSE_ANSWER);
    await ui.button(page, 'Send').click();
    await ui.companion(page).filter({ hasText: NEXT_QUESTION }).waitFor();
    await ui.mine(page).filter({ hasText: ROSE_ANSWER }).waitFor();

    // The prompt carried the template guidance and the conversation so far, opening question included.
    const body = mock.chatRequests().at(-1).body;
    const system = body.messages[0];
    assert.equal(system.role, 'system');
    assert.match(system.content, /^TASK: reply/);
    assert.match(system.content, /Rose, Thorn, Bud/i);
    const roles = body.messages.slice(1).map((m) => m.role);
    assert.deepEqual(roles, ['assistant', 'user'], 'the guided opening is part of the conversation');
    assert.equal(body.messages[1].content, OPENING);
    assert.equal(body.messages[2].content, ROSE_ANSWER);

    // History marks it as guided.
    await page.getByRole('link', { name: 'History', exact: true }).first().click();
    await eventually(async () => {
      assert.ok((await page.getByText(/Guided/).count()) > 0);
    }, { message: 'History to flag the guided entry' });
  }));

  test('a guided journal also works with no AI configured (the question is still asked)', () => journey({
    name: 'guided-no-ai', provider: '',
  }, async (j) => {
    const { page, mock } = j;
    await j.goto('/');
    await page.getByText('Each one opens with a question to write about.').waitFor();
    await page.getByRole('button', { name: /Gratitude/ }).click();
    await page.waitForURL(/#\/entry\//);
    await page.getByText('Guided prompt').waitFor();
    await ui.entryBox(page).fill('Thankful for hot tea and a quiet hour.');
    await ui.button(page, 'Save entry').click();
    await ui.mine(page).filter({ hasText: 'Thankful for hot tea' }).waitFor();
    assert.equal(mock.chatRequests().length, 0);
  }));
});
