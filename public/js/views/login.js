// Password screen (bare layout), shown only when the server was started with JOURNAL_PASSWORD.
import { h, mount } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { icon } from '../lib/ui.js';
import { startAuthenticated } from '../app.js';
import { uid, withBusy } from '../components/settings-ui.js';

/** Friendly wording for each way a login can fail. */
function describeLoginError(err) {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_password' || err.status === 401) return { message: 'That password is not right.', hint: 'Check for typos and caps lock, then try again.' };
    if (err.code === 'rate_limited' || err.status === 429) return { message: 'Too many attempts.', hint: err.hint || 'Wait a minute, then try again.' };
    return { message: err.message, hint: err.hint };
  }
  return { message: 'Something went wrong.', hint: 'Try again in a moment.' };
}

export default async function loginView(ctx) {
  const { root, signal, app } = ctx;
  const inputId = uid('login-password');
  const errorId = `${inputId}-error`;

  const input = h('input', {
    type: 'password', class: 'input login-input', id: inputId, name: 'password', autocomplete: 'current-password',
    autocapitalize: 'off', spellcheck: 'false', required: true, 'aria-describedby': errorId,
    onInput: () => clearError(),
  });
  const reveal = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon login-reveal', 'aria-label': 'Show password', 'aria-pressed': 'false',
    onClick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      reveal.setAttribute('aria-pressed', String(show));
      reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      reveal.classList.toggle('is-on', show);
      input.focus();
    },
  }, icon('eye', { size: 18 }));
  const errorEl = h('div', { class: 'login-error', id: errorId, role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block login-submit' }, 'Open my journal');

  function clearError() {
    errorEl.hidden = true;
    mount(errorEl);
    input.removeAttribute('aria-invalid');
  }

  function showMessage({ message, hint }) {
    mount(errorEl, icon('alert', { size: 18 }), h('div', null, h('strong', null, message), hint ? h('p', null, hint) : null));
    errorEl.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    input.select();
  }
  const showError = (err) => showMessage(describeLoginError(err));

  async function login() {
    if (!input.value) {
      showMessage({ message: 'Enter your password.', hint: '' });
      return;
    }
    clearError();
    try {
      await api.post('/auth/login', { password: input.value }, { signal });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      showError(err);
      return;
    }
    input.value = '';
    try {
      await startAuthenticated();
    } catch (err) {
      showError(err);
      return;
    }
    // startAuthenticated() resolves the route itself; only navigate if we are somehow still on the login page.
    if (location.hash.startsWith('#/login')) app.navigate('/');
  }

  // Password managers want an account name next to the password; this journal has one account, so it is fixed and hidden.
  const username = h('input', {
    type: 'text', name: 'username', value: 'myjournal', autocomplete: 'username', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', readOnly: true,
  });
  const form = h('form', { class: 'login-form', novalidate: true, onSubmit: (e) => { e.preventDefault(); withBusy(submit, login); } },
    username,
    h('label', { class: 'field-label', for: inputId }, 'Password'),
    h('div', { class: 'login-input-wrap' }, input, reveal),
    errorEl,
    submit);

  mount(root, h('div', { class: 'login' },
    h('div', { class: 'login-card' },
      h('div', { class: 'login-badge', 'aria-hidden': 'true' }, icon('lock', { size: 26 })),
      h('h1', { class: 'login-title' }, 'Welcome back'),
      h('p', { class: 'login-sub muted' }, 'Enter your password to open your journal.'),
      form,
      h('p', { class: 'login-foot muted small' }, 'Your journal lives on the computer running MyJournal.'))));

  // If this page is opened when no sign-in is needed, do not strand the person here.
  api.get('/auth/status', { signal }).then((status) => {
    if (status && (!status.required || status.authenticated)) startAuthenticated().then(() => { if (location.hash.startsWith('#/login')) app.navigate('/', { replace: true }); });
  }).catch(() => { /* the form still works */ });

  requestAnimationFrame(() => input.focus({ preventScroll: true }));
  return undefined;
}
