// Journey 14: hostile text and the browser's own defences. Whatever a person (or a model, or an imported file) puts into
// the journal is shown as text and never becomes markup or code; the Content-Security-Policy is really enforced, never
// violated by the app itself, and the browser never talks to anyone but the app's own server.

import {
  XSS_PAYLOADS, assert, describe, eventually, injectionReport, journey, test, ui,
} from './helpers.js';

const P = XSS_PAYLOADS;
const ALL_PAYLOADS = [P.img, P.script, P.svg, P.anchor, P.attr, P.iframe];

const MODEL_REPLY = `${P.img}\n\n**bold works** and *italic* with ${P.script} and ${P.svg}\n\n- ${P.attr}\n- [a link](javascript:window.__xss=1) and ![pic](x)\n\n\`${P.iframe}\``;
const MODEL_REFLECTION = `Reflection ${P.img} **strong** ${P.script}`;
const MODEL_META = `Title: ${P.img}\nSummary: ${P.script} and ${P.svg}\nEmotions: ${P.attr}, calm\nTags: ${P.anchor}, work`;
const MODEL_MEMORY = `- ${P.img}\n- Likes ${P.script}`;
const MODEL_WEEKLY = `**Week** ${P.img}\n\n${P.script} [x](javascript:window.__xss=2)\n\n- ${P.svg}`;

/** Fail with a readable list when the page shows any sign of injected markup or a fired payload. */
async function assertNoInjection(page, label) {
  assert.deepEqual(await injectionReport(page), [], `${label}: hostile text turned into markup or code`);
}

describe('hostile text is only ever text', () => {
  test('in names, entries, titles, tags, feelings, memories, search, model replies and reports - on every page that shows them', () => journey({
    name: 'xss-everywhere', mocks: { local: { replies: [MODEL_REPLY, MODEL_REFLECTION, MODEL_META, MODEL_MEMORY] } },
  }, async (j) => {
    const { page, db, mock } = j;

    // --- Settings: the name and "about you" come back in the greeting, in every prompt and in the form
    await j.goto('/settings?tab=general');
    await page.getByLabel('Your name').fill(P.img);
    await page.getByLabel('About you').fill(P.script);
    await ui.button(page, 'Save changes').click();
    await eventually(() => assert.equal(db.settings.get().profile.name, P.img));
    await assertNoInjection(page, 'settings/general');
    await j.goto('/');
    await ui.heading(page, new RegExp(`, ${P.img.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), 1).waitFor();
    await assertNoInjection(page, 'today greeting');

    // --- Today -> entry: the person's own text, all payloads at once
    await ui.fillToday(page, ALL_PAYLOADS.join('\n\n'), { mood: 'Good' });
    await page.getByRole('button', { name: 'Start journaling' }).click();
    await page.waitForURL(/#\/entry\//);
    const id = ui.entryId(page);
    await ui.companion(page).first().waitFor();
    for (const payload of [P.img, P.script, P.svg]) {
      await ui.mine(page).getByText(payload, { exact: false }).first().waitFor();
    }
    await assertNoInjection(page, 'entry (own text and a hostile model reply)');

    // the model's markdown still works (bold) while its HTML is inert, and links are never made
    const reply = ui.companion(page).first();
    await reply.locator('strong', { hasText: 'bold works' }).waitFor();
    assert.equal(await reply.locator('a').count(), 0, 'no links come out of model text');
    assert.ok((await reply.innerText()).includes('onerror='), 'the payload is visible as text');
    assert.ok((await reply.innerText()).includes('<script>'), 'including its tags');

    // the model was handed the text, not something sanitised away
    assert.ok(JSON.stringify(mock.chatRequests().at(-1).body.messages).includes('onerror'));

    // --- title, feelings and tags typed into the header
    const title = page.getByRole('textbox', { name: 'Entry title' });
    await title.fill(P.img);
    await title.press('Enter');
    await eventually(() => assert.equal(db.entries.get(id).title, P.img));
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.keyboard.type('<img src=x onerror=1>');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Add feeling' }).click();
    await page.keyboard.type('<b onmouseover=1>x</b>');
    await page.keyboard.press('Enter');
    await eventually(() => {
      const e = db.entries.get(id);
      assert.equal(e.tags.length, 1);
      assert.equal(e.emotions.length, 1);
    });
    await assertNoInjection(page, 'entry header chips');

    // --- editing a message with a payload
    await page.getByRole('button', { name: 'Edit this message' }).first().click();
    await page.getByRole('textbox', { name: 'Edit your message' }).fill(`${P.img} edited ${P.svg}`);
    await page.keyboard.press('Control+Enter');
    await ui.mine(page).getByText('edited', { exact: false }).first().waitFor();
    await assertNoInjection(page, 'edited message');

    // --- wrap up: reflection, title, summary, feelings, tags and memories all come from a hostile model
    await ui.button(page, 'Wrap up').click();
    const summary = page.getByRole('region', { name: 'Entry summary' });
    await summary.waitFor({ timeout: 20_000 });
    await summary.getByText('Added to your memory').waitFor();
    await assertNoInjection(page, 'wrap-up summary');
    await j.reload();
    await summary.waitFor();
    await assertNoInjection(page, 'entry after reload');

    // --- Memory
    await j.goto('/memory');
    await page.getByLabel('Add a memory').fill(`${P.img} ${P.attr}`);
    await ui.button(page, 'Add memory').click();
    await page.getByText('Remembered', { exact: true }).waitFor();
    await assertNoInjection(page, 'memory');

    // --- History: cards, chips, search results with highlighting, and the empty state that repeats the query
    await j.goto('/history');
    await page.getByRole('main').locator('a[href^="#/entry/"]').first().waitFor();
    await assertNoInjection(page, 'history list');
    const search = page.getByRole('searchbox', { name: 'Search your entries' });
    await search.fill('onerror');
    await page.getByText(/\d+ results? for “onerror”/).waitFor();
    await assertNoInjection(page, 'history search results');
    await search.fill(P.img);
    await eventually(async () => assert.ok((await page.getByRole('main').innerText()).length > 0));
    await assertNoInjection(page, 'history search with a payload as the query');
    await search.fill('<script>window.__xss=9</script> qzxwv');
    await page.getByText(/Nothing matches/).waitFor();
    await assertNoInjection(page, 'history empty state');
    await j.load(`/history?q=${encodeURIComponent(P.img)}&tag=${encodeURIComponent(P.script)}`);
    await page.getByRole('main').getByRole('heading', { name: 'History' }).waitFor();
    await page.waitForTimeout(400);
    await assertNoInjection(page, 'history opened with a hostile address');

    // --- Insights: tag and emotion bars (SVG text and tables) and a hostile weekly reflection
    mock.setBehavior({ replies: [MODEL_WEEKLY] });
    await j.goto('/insights');
    await page.getByRole('table', { name: 'Top tags' }).waitFor({ state: 'attached' });
    await assertNoInjection(page, 'insights charts');
    await ui.button(page, 'Write my reflection').click();
    await page.getByText('Your reflection is ready').waitFor({ timeout: 20_000 });
    await assertNoInjection(page, 'weekly reflection');
    assert.equal(await page.getByRole('main').locator('a[href^="javascript" i]').count(), 0);

    // --- Today again, with all of it in the recent list
    await j.goto('/');
    await page.getByRole('main').locator('a[href^="#/entry/"]').first().waitFor();
    await assertNoInjection(page, 'today recent entries');

    // --- a hostile model name in Settings comes back in the error message as plain text
    mock.setBehavior({ failures: ['model_not_found'] });
    await j.goto('/settings?tab=local');
    await page.getByLabel('Model', { exact: true }).fill(P.img);
    await ui.button(page, 'Test connection').click();
    const failure = page.getByRole('alert').filter({ hasText: 'Things to try' });
    await failure.waitFor();
    await failure.getByText('onerror', { exact: false }).first().waitFor();
    await assertNoInjection(page, 'settings error message');
  }));

  test('an entry that contains markdown-looking and HTML-looking text keeps every character', () => journey({ name: 'xss-roundtrip' }, async (j) => {
    const { page, db } = j;
    const text = `${P.img}\n\n<b>not bold</b> & &amp; "quotes" 'single' <!-- comment --> </div></section> ${P.anchor}`;
    await j.goto('/');
    await ui.startJournaling(page, text);
    await ui.companion(page).first().waitFor();
    const id = ui.entryId(page);
    const stored = db.messages.list(id)[0].content;
    assert.equal(stored, text, 'stored byte for byte');
    for (const needle of ['<b>not bold</b>', '&amp;', '<!-- comment -->', '</div></section>']) {
      assert.ok((await ui.mine(page).first().innerText()).includes(needle), `${needle} is shown as typed`);
    }
    await assertNoInjection(page, 'entry');
    const bolds = await ui.mine(page).first().locator('b, strong').count();
    assert.equal(bolds, 0, 'the <b> in the text did not become bold');
  }));
});

describe('the Content-Security-Policy and the browser boundary', () => {
  test('the policy is on every response, the app breaks none of it, and the browser really enforces it', () => journey({
    name: 'csp-enforced', seed: 'demo',
  }, async (j) => {
    const { page, diag, db } = j;

    // headers on the page, a script, an API answer and the SPA fallback
    for (const path of ['/', '/js/app.js', '/css/base.css', '/api/health', '/history']) {
      const res = await page.request.get(`${j.origin}${path}`);
      const csp = res.headers()['content-security-policy'];
      assert.ok(csp, `${path}: has a Content-Security-Policy`);
      for (const part of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
        assert.ok(csp.includes(part), `${path}: policy contains ${part}`);
      }
      assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp), `${path}: no unsafe-inline, unsafe-eval or wildcard`);
      assert.equal(res.headers()['x-content-type-options'], 'nosniff');
      assert.equal(res.headers()['referrer-policy'], 'no-referrer');
      assert.equal(res.headers()['x-frame-options'], 'DENY');
    }
    assert.equal((await page.request.get(`${j.origin}/api/health`)).headers()['cache-control'], 'no-store');

    // a full tour of the app: nothing violates the policy (the journey also fails on any console noise or CSP report)
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Presentation day');
    for (const path of ['/', '/history', '/insights', '/memory', '/settings?tab=gemini', '/settings?tab=openai', '/settings?tab=local', '/settings?tab=general', '/settings?tab=data', `/entry/${entry.id}`, '/welcome']) {
      await j.load(path);
      await page.getByRole('main').getByRole('heading').first().waitFor();
      await page.waitForTimeout(250);
    }
    assert.deepEqual(diag.csp, []);

    // the control experiment: the browser blocks exactly what the policy forbids
    const result = await page.evaluate(async () => {
      const out = {};
      const script = document.createElement('script');
      script.textContent = 'window.__xss = "inline script ran"';
      document.head.append(script);
      out.inlineScript = window.__xss;
      const button = document.createElement('button');
      button.setAttribute('onclick', 'window.__xss = "inline handler ran"');
      document.body.append(button);
      button.click();
      out.inlineHandler = window.__xss;
      try { await fetch('https://example.com/steal', { mode: 'no-cors' }); out.external = 'fetched'; } catch (err) { out.external = `blocked (${err.name})`; }
      const img = new Image();
      img.src = 'https://example.com/pixel.png';
      await new Promise((r) => setTimeout(r, 150));
      button.remove();
      return out;
    });
    assert.equal(result.inlineScript, undefined, 'an injected inline <script> does not run');
    assert.equal(result.inlineHandler, undefined, 'an injected inline event handler does not run');
    assert.match(result.external, /^blocked/, 'a request to another site is refused by connect-src');
    await eventually(() => assert.ok(diag.csp.length >= 4, `the browser reported the violations (${diag.csp.length})`));
    const directives = diag.csp.map((v) => v.directive).join(' ');
    assert.match(directives, /script-src/);
    assert.match(directives, /connect-src/);
    assert.match(directives, /img-src|default-src/);
    // those were the experiment's own; nothing of it reached the page
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    diag.csp.length = 0;
    diag.console.length = 0;
    diag.external.length = 0;
    diag.failedRequests.length = 0;
  }));

  test('another website cannot use the API: requests with a foreign Origin or without the app header are refused', () => journey({
    name: 'csrf-origin', seed: 'demo',
  }, async (j) => {
    const { page, db } = j;
    const before = db.stats().entries;
    const url = `${j.origin}/api/entries`;
    const evil = await page.request.post(url, { headers: { Origin: 'http://evil.example', 'X-MyJournal': '1', 'Content-Type': 'application/json' }, data: { content: 'planted' } });
    assert.equal(evil.status(), 403);
    assert.equal((await evil.json()).error.code, 'forbidden_origin');
    const bare = await page.request.post(url, { headers: { 'Content-Type': 'application/json' }, data: { content: 'planted' } });
    assert.equal(bare.status(), 403);
    const wipe = await page.request.post(`${j.origin}/api/data/wipe`, { headers: { Origin: 'http://evil.example', 'X-MyJournal': '1', 'Content-Type': 'application/json' }, data: { confirm: 'DELETE' } });
    assert.equal(wipe.status(), 403);
    assert.equal(db.stats().entries, before, 'nothing was added or removed');
    // CORS is never offered
    const probe = await page.request.fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(probe.headers()['access-control-allow-origin'], undefined);
    // the app's own page, on the other hand, works
    await j.goto('/');
    await ui.startJournaling(page, 'This one comes from the real page.');
    assert.equal(db.stats().entries, before + 1);
  }));

  test('the page is not framable and nothing outside the app is ever contacted', () => journey({
    name: 'no-third-parties', seed: 'demo', mocks: { local: true, openai: true, gemini: true },
  }, async (j) => {
    const { page, context, diag, db } = j;
    // another site cannot frame it (frame-ancestors 'none' + X-Frame-Options)
    const outer = await context.newPage();
    const outerDiag = [];
    outer.on('console', (m) => outerDiag.push(m.text()));
    await outer.goto('about:blank');
    await outer.evaluate((src) => {
      const frame = document.createElement('iframe');
      frame.id = 'victim';
      frame.src = src;
      document.body.append(frame);
    }, j.origin);
    await outer.waitForTimeout(800);
    const framed = outer.frames().find((f) => f.url().startsWith(j.origin));
    const body = framed ? await framed.evaluate(() => document.body && document.body.innerText).catch(() => '') : '';
    assert.ok(!body.includes('MyJournal') && !body.includes('What is on your mind'), 'the app did not render inside a foreign frame');
    await outer.close();

    // use everything once; the diagnostics fail the journey if the browser touched any other origin
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Presentation day');
    for (const path of ['/', '/history', '/insights', '/memory', '/settings?tab=gemini', '/settings?tab=openai', '/settings?tab=local', '/settings?tab=data', `/entry/${entry.id}`]) {
      await j.load(path);
      await page.getByRole('main').getByRole('heading').first().waitFor();
      await page.waitForTimeout(250);
    }
    // the Test button talks to OUR server, which talks to the model: the browser only ever sees the app's origin
    await j.goto('/settings?tab=openai');
    await ui.button(page, 'Test connection').click();
    await page.getByText('Connected', { exact: true }).waitFor();
    assert.deepEqual(diag.external, [], 'no request left the app\'s own origin');
    const origins = new Set(await page.evaluate(() => performance.getEntriesByType('resource').map((r) => new URL(r.name).origin)));
    assert.deepEqual([...origins], [j.origin], 'every resource the page loaded came from the app itself');
  }));
});
