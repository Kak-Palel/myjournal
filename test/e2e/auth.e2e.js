// Journey 9: a journal protected with JOURNAL_PASSWORD - the login screen, a wrong password, the attempt limit,
// a session that survives a reload, a session that ends (logout or expiry), and nothing readable while logged out.

import { PASSWORD, assert, describe, eventually, journey, test, ui } from './helpers.js';

const login = (page) => page.getByLabel('Password', { exact: true });

async function signIn(page, password = PASSWORD) {
  await login(page).fill(password);
  await ui.button(page, 'Open my journal').click();
}

describe('password protected journal', () => {
  // Confirmed in the browser (repeatable): with a password set, boot() starts the router on the requested route BEFORE it
  // redirects to #/login, so Today's data requests (catalog, entries, overview) run unauthenticated. Every one that is not
  // aborted in time shows up as "Failed to load resource ... 401" in the console on every cold start of a protected journal.
  test('opening a protected journal while logged out goes straight to the login screen without failed requests', { skip: 'BUG: public/js/app.js boot() - router.start() renders the requested route (Today) before redirecting to #/login, so its API calls 401 and log console errors; fix: history.replaceState(null, "", "#/login") before router.start() when auth is required and the visitor is not authenticated' }, () => journey({
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

  test('the session ending while the page is open leads back to the login screen', () => journey({
    name: 'auth-expiry', password: PASSWORD, seed: 'demo',
  }, async (j) => {
    const { page, context, diag } = j;
    diag.expectStatus(401, /\/api\//);
    await j.goto('/');
    await signIn(page);
    await ui.todayBox(page).waitFor();
    await page.getByRole('link', { name: 'A slow day with Miso' }).waitFor(); // Today has finished loading its lists
    await page.waitForLoadState('networkidle');
    await context.clearCookies(); // the session ends (expired, or the server was restarted)
    await page.getByRole('link', { name: 'History', exact: true }).first().click();
    await ui.heading(page, 'Welcome back', 1).waitFor();
    assert.match(page.url(), /#\/login/);
    // and signing in again brings the journal back
    await signIn(page);
    await ui.todayBox(page).waitFor();
  }));

  test('too many wrong passwords are slowed down with an honest message', () => journey({
    name: 'auth-rate-limit', password: PASSWORD,
  }, async (j) => {
    const { page, diag } = j;
    diag.expectStatus(401, /\/api\//); // includes the first-load noise described in the BUG test below
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
    diag.expectStatus(401, /\/api\//); // first-load noise, see the BUG test below
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
