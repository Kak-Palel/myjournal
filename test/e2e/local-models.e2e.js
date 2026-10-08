// Small self-hosted models as they really behave (docs/PROVIDERS.md): Ollama and llama.cpp flavours of the mock - hidden
// reasoning that must never reach the page, a model that spends its whole budget thinking, a GGUF path as the model
// name, and a tiny context window that the prompt budget has to respect.

import {
  assert, describe, eventually, journey, test, ui,
} from './helpers.js';

const ANSWER = 'That sounds like a quiet, good kind of day. What made it feel that way?';
const THOUGHT = 'Hmm, the user wrote a short note. I should be kind and ask one question.';

describe('reasoning models', () => {
  test('think blocks and reasoning fields are stripped from replies, wrap-ups, titles and reflections', () => journey({
    name: 'local-think-blocks',
    mocks: { local: { flavor: 'ollama', models: ['llama3.2:3b'], think: THOUGHT, reasoningContent: 'Secretly reasoning here.', replies: [ANSWER] } },
  }, async (j) => {
    const { page, db, mock } = j;
    await j.goto('/');
    await ui.startJournaling(page, 'A calm day with tea and a book. I love slow afternoons.');
    await ui.companion(page).filter({ hasText: ANSWER }).waitFor();
    for (const hidden of ['<think>', 'Hmm, the user wrote', 'Secretly reasoning']) {
      assert.equal(await page.getByText(hidden, { exact: false }).count(), 0, `"${hidden}" is not on the page`);
    }
    const stored = db.messages.list(ui.entryId(page))[1];
    assert.equal(stored.content, ANSWER, 'only the answer is stored');
    assert.ok(mock.chatRequests().length >= 1);

    // the other tasks use the same model and still parse (their prompts are labelled lines, not JSON)
    await ui.button(page, 'Wrap up').click();
    const summary = page.getByRole('region', { name: 'Entry summary' });
    await summary.waitFor({ timeout: 20_000 });
    const title = await page.getByRole('textbox', { name: 'Entry title' }).inputValue();
    assert.ok(title.length > 0 && !/think|user wrote/i.test(title), `a clean title: ${title}`);
    assert.doesNotMatch(await summary.textContent(), /think|Secretly|user wrote/i);
    for (const m of db.messages.list(ui.entryId(page))) assert.doesNotMatch(m.content, /<think>|Secretly reasoning/);
    assert.doesNotMatch((await page.getByRole('main').innerText()), /Secretly reasoning|Hmm, the user wrote/);
  }));

  test('a model that spends everything on hidden reasoning gets an honest message and a hint', () => journey({
    name: 'local-think-only', mocks: { local: { flavor: 'ollama', models: ['llama3.2:3b'], failures: ['think_only'] } },
  }, async (j) => {
    const { page, db } = j;
    const made = await j.app.entry({ content: 'Anything to say?' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').click();
    const problem = page.getByRole('alert').filter({ hasText: 'hidden reasoning' });
    await problem.waitFor();
    await problem.getByText(/max tokens|non-reasoning|token budget|thinking/i).first().waitFor();
    assert.equal(await ui.companion(page).count(), 0, 'no empty or half-thought bubble');
    assert.equal(db.messages.list(made.entry.id).length, 1);
  }));
});

describe('llama.cpp and the GGUF path as a model name', () => {
  test('preset, Load models lists the file path, Test connection, Save, reply with that model', () => journey({
    name: 'local-llamacpp', fresh: true, onboarded: true, mocks: { local: { flavor: 'llamacpp', replies: [ANSWER] } },
  }, async (j) => {
    const { page, mock, db } = j;
    await j.goto('/settings?tab=local');
    await page.getByRole('button', { name: 'llama.cpp', exact: true }).click();
    assert.equal(await page.getByLabel('Base URL', { exact: true }).inputValue(), 'http://localhost:8080/v1');
    await page.getByText(/llama-server listens on port 8080/).waitFor();
    await page.getByLabel('Base URL', { exact: true }).fill(mock.baseUrl);
    await ui.button(page, 'Load models').click();
    await page.getByText('Found 1 model.').waitFor();
    const gguf = '/models/qwen3-1.7b-q4km.gguf';
    await page.getByRole('button', { name: new RegExp(`^${gguf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first().click();
    assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), gguf);
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await ui.button(page, 'Use this provider').click();
    await eventually(() => assert.equal(db.settings.get().ai.providers.local.model, gguf));

    mock.setBehavior({ replies: [ANSWER] }); // (the connection test above used up the scripted reply)
    const made = await j.app.entry({ content: 'Does llama.cpp answer?' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').click();
    await ui.companion(page).filter({ hasText: ANSWER }).waitFor();
    assert.equal(mock.chatRequests().at(-1).body.model, gguf);
    // llama.cpp has no Ollama API: downloading is explained rather than attempted
    j.diag.expectStatus(409, /providers\/local\/pull/);
    await j.goto('/settings?tab=local');
    await page.getByLabel('Model', { exact: true }).fill('qwen3:1.7b');
    await ui.button(page, 'Download qwen3:1.7b').click();
    await page.getByText('This server is not Ollama, so MyJournal cannot download models for it.').waitFor();
  }));
});

describe('tiny context windows', () => {
  test('with a 2k window and a long conversation the prompt still fits: nothing is trimmed behind the app\'s back and the latest words are kept', () => journey({
    name: 'local-small-context',
    settings: { ai: { contextBudgetTokens: 1500 } },
    mocks: { local: { flavor: 'ollama', models: ['llama3.2:3b'], numCtx: 2048, replies: [ANSWER] } },
    seed: (db) => {
      const e = db.entries.create({ title: 'A long conversation', date: new Date().toISOString().slice(0, 10) });
      for (let i = 0; i < 14; i += 1) {
        db.messages.add(e.id, { role: i % 2 === 0 ? 'user' : 'assistant', content: `Turn ${i + 1}. ${'This is a fairly long sentence that takes up some room in the window. '.repeat(10)}`, meta: i % 2 ? { kind: 'reply' } : {} });
      }
      db.memories.create({ text: 'Has a younger sister called Maya', pinned: true });
      db.memories.create({ text: 'Works as a product designer' });
    },
  }, async (j) => {
    const { page, db, mock } = j;
    const entry = db.entries.list({ limit: 5 }).find((e) => e.title === 'A long conversation');
    await j.goto(`/entry/${entry.id}`);
    await ui.mine(page).first().waitFor();
    await ui.entryBox(page).fill('The newest thing I want to say is about the sea.');
    await ui.button(page, 'Send').click();
    await ui.companion(page).filter({ hasText: ANSWER }).waitFor();
    const request = mock.chatRequests().at(-1);
    const sent = request.body.messages;
    const chars = sent.reduce((n, m) => n + m.content.length, 0);
    assert.ok(chars / 3.5 <= 1700, `the prompt is about ${Math.round(chars / 3.5)} tokens, within the 1500-token budget`);
    assert.ok(!request.trimmedMessages, 'the server did not have to drop anything');
    assert.equal(sent[0].role, 'system');
    assert.equal(sent.at(-1).content, 'The newest thing I want to say is about the sea.', 'the latest message is always kept');
    assert.ok(sent.length < 16, `older turns were left out (${sent.length} messages sent of 16)`);
    assert.equal(await page.getByRole('alert').count(), 0);
  }));

  test('a context-length error from the server points to the real fixes', () => journey({
    name: 'local-context-error', mocks: { local: { flavor: 'ollama', models: ['llama3.2:3b'], failures: ['context_length'] } },
  }, async (j) => {
    const { page } = j;
    const made = await j.app.entry({ content: 'Too much for a small window.' });
    await j.goto(`/entry/${made.entry.id}`);
    await ui.button(page, 'Get a reply').click();
    const problem = page.getByRole('alert').filter({ hasText: /context/i });
    await problem.waitFor();
    const text = await problem.textContent();
    assert.match(text, /OLLAMA_CONTEXT_LENGTH|context budget|context size/i);
    await problem.getByRole('link', { name: 'Open settings' }).waitFor();
  }));
});
