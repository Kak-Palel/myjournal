// Journey 9: a journal protected with JOURNAL_PASSWORD - the login screen, a wrong password, the attempt limit,
// a session that survives a reload, a session that ends (logout or expiry), and nothing readable while logged out.

import { PASSWORD, assert, describe, eventually, journey, test, ui } from './helpers.js';

const login = (page) => page.getByLabel('Password', { exact: true });

async function signIn(page, password = PASSWORD) {
  await login(page).fill(password);
  await ui.button(page, 'Open my journal').click();
}

describe('password protected journal', () => {
  // Regression: with a password set, boot() used to start the router on the requested route BEFORE it redirected to #/login,
  // so Today's data requests (catalog, entries, overview) ran unauthenticated and logged "Failed to load resource ... 401" in the
  // console on every cold start of a protected journal. The sign-in page is now shown before any page is resolved.
  test('opening a protected journal while logged out goes straight to the login screen without failed requests', () => journey({
    name: 'auth-cold-start-noise', password: PASSWORD,
  }, async (j) => {
    const { page, diag } = j;
    await j.goto('/');
    await ui.heading(page, 'Welcome back', 1).waitFor();
    await page.waitForTimeout(500);
    assert.deepEqual(diag.problems(), []);
  }));

  test('login screen, wrong password, show/hide, sign in, reload, sign out', () => journey({
    name: 'auth-flow', password: PASSWORD, seed: 'demo',
  }, async (j) => {
    const { page, context, diag } = j;
    diag.expectStatus(401, /\/api\//);

    // logged out: only the login screen, never the journal
    await j.goto('/');
    await ui.heading(page, 'Welcome back', 1).waitFor();
    assert.match(page.url(), /#\/login$/);
    await page.getByText('Enter your password to open your journal.').waitFor();
    const text = await page.locator('body').innerText();
    assert.ok(!text.includes('Presentation day') && !text.includes('Miso'), 'no journal content on the login screen');
    assert.equal((await j.api('GET', '/entries')).status, 401, 'the API refuses without a session');
    assert.equal((await j.api('GET', '/entries')).json.error.code, 'unauthorized');
    assert.equal((await j.api('GET', '/settings')).status, 401);
    assert.equal((await j.api('GET', '/auth/status')).json.authenticated, false);
    assert.equal((await context.cookies()).length, 0);

    // empty and wrong passwords get calm messages and keep the field ready
    await ui.button(page, 'Open my journal').click();
    await page.getByRole('alert').filter({ hasText: 'Enter your password.' }).waitFor();
    await signIn(page, 'not the password');
    const alert = page.getByRole('alert').filter({ hasText: 'That password is not right.' });
    await alert.waitFor();
    await alert.getByText('Check for typos and caps lock, then try again.').waitFor();
    assert.equal(await login(page).getAttribute('aria-invalid'), 'true');
    assert.equal(await login(page).evaluate((el) => document.activeElement === el), true, 'focus is back in the password field');
    assert.match(page.url(), /#\/login$/);
    assert.equal((await context.cookies()).length, 0, 'no session was created');

    // typing again clears the message; the eye button shows and hides the text
    await login(page).fill('x');
    await alert.waitFor({ state: 'hidden' });
    assert.equal(await login(page).getAttribute('type'), 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    assert.equal(await login(page).getAttribute('type'), 'text');
    await page.getByRole('button', { name: 'Hide password' }).click();
    assert.equal(await login(page).getAttribute('type'), 'password');

    // the right one opens the journal
    await signIn(page);
    await page.getByRole('heading', { level: 1 }).filter({ hasText: /^(Good morning|Good afternoon|Good evening|Still up)/ }).waitFor();
    await ui.todayBox(page).waitFor();
    assert.doesNotMatch(page.url(), /login/);
    await page.getByText('A slow day with Miso').first().waitFor();
    assert.equal(await login(page).count(), 0);

    // the session cookie is httpOnly and not readable by scripts
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name.startsWith('mj_session'));
    assert.ok(session, 'a session cookie exists');
    assert.equal(session.httpOnly, true);
    assert.equal(session.sameSite, 'Strict');
    assert.equal(await page.evaluate(() => document.cookie), '', 'scripts cannot see the session cookie');
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).includes(PASSWORD), 'the password is not stored in the browser');

    // a reload stays signed in
    await j.reload();
    await ui.todayBox(page).waitFor();
    assert.doesNotMatch(page.url(), /login/);
    assert.equal((await j.api('GET', '/auth/status')).json.authenticated, true);

    // visiting the login address while signed in sends you on
    await j.load('/login');
    await ui.todayBox(page).waitFor();

    // sign out lives on the Data tab
    await j.goto('/settings?tab=data');
    await page.getByRole('heading', { name: 'Access' }).waitFor();
    await ui.button(page, 'Sign out').click();
    await ui.heading(page, 'Welcome back', 1).waitFor();
    assert.equal((await j.api('GET', '/entries')).status, 401, 'the old session no longer works');
    assert.ok(!(await context.cookies()).some((c) => c.name.startsWith('mj_session') && c.value), 'the cookie is cleared');
    // Back does not reveal anything
    await page.goBack().catch(() => {});
    await j.reload();
    await ui.heading(page, 'Welcome back', 1).waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes('Miso'));
  }));

  test('the session ending while the page is open leads to the login screen and, after signing in again, back to the same page', () => journey({
    name: 'auth-expiry', password: PASSWORD, seed: 'demo',
  }, async (j) => {
    const { page, context, diag } = j;
    diag.expectStatus(401, /\/api\//); // the request that finds out the session is gone
    await j.goto('/');
    await signIn(page);
    await ui.todayBox(page).waitFor();
    await page.getByRole('link', { name: 'A slow day with Miso' }).waitFor(); // Today has finished loading its lists
    await page.waitForLoadState('networkidle');
    await context.clearCookies(); // the session ends (expired, or the server was restarted)
    await page.getByRole('link', { name: 'History', exact: true }).first().click();
    await ui.heading(page, 'Welcome back', 1).waitFor();
    assert.match(page.url(), /#\/login/);
    // and signing in again brings back the page that was open, not Today
    await signIn(page);
    await ui.heading(page, 'History', 1).waitFor();
    assert.match(page.url(), /#\/history$/);
    assert.equal(await ui.todayBox(page).count(), 0);
  }));

  test('the session ending on a page with filters or an open entry: sign in brings back the same address and the typed words', () => journey({
    name: 'auth-expiry-deep', password: PASSWORD, seed: 'demo',
  }, async (j) => {
    const { page, context, diag, db } = j;
    diag.expectStatus(401, /\/api\//);
    const entry = db.entries.list({ limit: 50 }).find((e) => e.title === 'Long run in the rain');

    // a filtered History
    await j.goto('/history?mood=4');
    await signIn(page);
    await ui.heading(page, 'History', 1).waitFor();
    await page.waitForLoadState('networkidle');
    assert.match(page.url(), /#\/history\?mood=4$/);
    await context.clearCookies();
    await page.reload(); // the next request finds out
    await ui.heading(page, 'Welcome back', 1).waitFor();
    assert.match(page.url(), /#\/login$/);
    await signIn(page);
    await ui.heading(page, 'History', 1).waitFor();
    assert.match(page.url(), /#\/history\?mood=4$/, 'the filter is still in the address');

    // an entry with an unsent message: pressing Send after the session ended
    await j.goto(`/entry/${entry.id}`);
    await ui.mine(page).first().waitFor();
    await ui.entryBox(page).fill('Words typed while the session had already ended.');
    await context.clearCookies();
    await ui.button(page, 'Send').click();
    await ui.heading(page, 'Welcome back', 1).waitFor();
    assert.equal(db.messages.list(entry.id).some((m) => m.content.includes('Words typed while the session')), false, 'nothing was saved without a session');
    await signIn(page);
    await ui.mine(page).first().waitFor();
    assert.match(page.url(), new RegExp(`#/entry/${entry.id}$`));
    assert.equal(await ui.entryBox(page).inputValue(), 'Words typed while the session had already ended.', 'the draft survived the sign-in');
  }));

  for (const [label, path] of [
    ['a filtered History', '/history?mood=4'],
    ['an entry', null],
    ['Settings on its Data tab', '/settings?tab=data'],
    ['Memory', '/memory'],
    ['Insights', '/insights'],
  ]) {
    test(`a deep link to ${label} opened while logged out shows the login screen quietly and returns there after signing in`, () => journey({
      name: `auth-deep-link-${label.replace(/\W+/g, '-').toLowerCase()}`, password: PASSWORD, seed: 'demo',
    }, async (j) => {
      const { page, db, diag } = j;
      const target = path || `/entry/${db.entries.list({ limit: 50 }).find((e) => e.title === 'Presentation day').id}`;
      await j.load(target);
      await ui.heading(page, 'Welcome back', 1).waitFor();
      await page.waitForTimeout(400);
      assert.match(page.url(), /#\/login$/);
      assert.deepEqual(diag.problems(), [], 'no unauthenticated API call, no console error');
      const text = await page.locator('body').innerText();
      assert.ok(!text.includes('Miso') && !text.includes('Presentation day'), 'no journal content before signing in');

      // a wrong password does not lose the intended address
      diag.expectStatus(401, /\/api\/auth\/login/);
      await signIn(page, 'not the password');
      await page.getByRole('alert').filter({ hasText: 'That password is not right.' }).waitFor();
      await signIn(page);
      await page.waitForURL((url) => url.hash === `#${target}`);
      await ui.heading(page, /./).first().waitFor();
      assert.equal(await ui.todayBox(page).count(), 0, 'not Today');
      assert.equal(await login(page).count(), 0);
    }));
  }

  test('signing out on purpose and signing back in starts at Today', () => journey({
    name: 'auth-sign-out-then-in', password: PASSWORD, seed: 'demo',
  }, async (j) => {
    const { page, diag } = j;
    diag.expectStatus(401, /\/api\//);
    await j.goto('/settings?tab=data');
    await signIn(page);
    await page.getByRole('heading', { name: 'Access' }).waitFor();
    await ui.button(page, 'Sign out').click();
    await ui.heading(page, 'Welcome back', 1).waitFor();
    await signIn(page);
    await ui.todayBox(page).waitFor();
    assert.match(page.url(), /#\/$/);
  }));

  test('too many wrong passwords are slowed down with an honest message', () => journey({
    name: 'auth-rate-limit', password: PASSWORD,
  }, async (j) => {
    const { page, diag } = j;
    diag.expectStatus(401, /\/api\/auth\/login/); // every wrong password answers 401
    diag.expectStatus(429, /\/api\/auth\/login/);
    await j.goto('/');
    await ui.heading(page, 'Welcome back', 1).waitFor();
    let limited = false;
    for (let i = 0; i < 8 && !limited; i += 1) {
      await signIn(page, `wrong ${i}`);
      limited = await page.getByRole('alert').filter({ hasText: 'Too many attempts.' }).waitFor({ timeout: 1500 }).then(() => true, () => false);
    }
    assert.ok(limited, 'the sixth or later attempt is told to wait');
    await page.getByText(/Wait a minute|try again/i).first().waitFor();
    // even the right password is refused while limited (nobody can brute-force through the limit)
    await signIn(page);
    await page.getByRole('alert').filter({ hasText: 'Too many attempts.' }).waitFor();
    assert.match(page.url(), /#\/login/);
  }));

  test('state-changing requests without the CSRF header are refused even when signed in', () => journey({
    name: 'auth-csrf', password: PASSWORD,
  }, async (j) => {
    const { page, diag } = j;
    diag.expectStatus(403, /\/api\//);
    await j.goto('/');
    await signIn(page);
    await ui.todayBox(page).waitFor();
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"content":"sneaky"}', credentials: 'same-origin' });
      return { status: r.status, body: await r.json() };
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden_origin');
    await eventually(() => assert.equal(j.db.stats().entries, 0));
  }));
});
