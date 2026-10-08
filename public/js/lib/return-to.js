// Where the person goes after signing in. Pure functions over hash strings ("#/entry/abc?x=1"), so the rules are
// unit-tested without a browser. app.js keeps the one remembered address in memory.
import { parseHash } from './router.js';

/**
 * The address worth coming back to after a sign-in: the page that was asked for, or the one a session that ended was on.
 * The sign-in page itself is never remembered, and neither is an empty address ('' = no special place, land on Today).
 * @param {string} hash e.g. location.hash
 * @returns {string} the hash to remember, or ''
 */
export function returnAddress(hash) {
  const text = String(hash || '');
  if (!text || text === '#') return '';
  return parseHash(text).path === '/login' ? '' : text;
}

/**
 * Address to show once the person is allowed in.
 * @param {{ current: string, intended: string, onboarded: boolean }} state `current`: the address bar; `intended`: what
 *   returnAddress() remembered; `onboarded`: has the welcome screen been done (a brand new journal starts there)
 * @returns {string|null} a replacement address, or null to keep the current one
 */
export function postLoginHash({ current, intended, onboarded }) {
  let target = null;
  if (parseHash(current).path === '/login') target = returnAddress(intended) || '#/';
  const path = parseHash(target || current).path;
  if (!onboarded && path === '/') target = '#/welcome'; // a journal nobody has set up yet starts with the welcome screen
  return target;
}
