// The Node.js version check that server.js runs before it loads anything else.
//
// This file must stay free of imports: on a Node that is too old, `import 'node:sqlite'` (several modules away)
// fails while the module graph is being linked, with a raw `ERR_UNKNOWN_BUILTIN_MODULE` stack trace. server.js
// therefore imports only this file statically, checks the version, and loads the rest with import().

/**
 * The oldest Node.js 22 release the app supports. `node:sqlite` needs no flag from 22.13, but its bundled SQLite has FTS5
 * (the full-text search MyJournal's History search is built on) only from 22.16: measured with `CREATE VIRTUAL TABLE ...
 * USING fts5` on the official binaries, 22.13 to 22.15 and every 23.x fail with "no such module: fts5", 22.16 and 24.0
 * work. So the supported releases are 22.16 and newer 22.x, and 24 or newer (package.json "engines" says the same).
 */
export const MIN_NODE = Object.freeze({ major: 22, minor: 16 });

/**
 * Is this Node.js version one the app runs on? Accepts "22.16.0", "v22.16.0" and pre-release suffixes ("24.0.0-nightly...");
 * anything that does not start with major.minor counts as not supported. Node 23 never had FTS5, so it is refused.
 * (The database layer still checks for FTS5 itself when it creates the schema, so an unusual build is reported properly too.)
 * @param {string} [version] defaults to the running Node (process.versions.node)
 * @returns {boolean}
 */
export function isSupportedNode(version = process.versions.node) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major === MIN_NODE.major) return minor >= MIN_NODE.minor;
  return major > MIN_NODE.major + 1;
}

/**
 * The friendly message for a Node.js that is too old, or '' when the version is fine.
 * @param {string} [version] defaults to the running Node (process.versions.node)
 * @param {{ command?: string }} [options] `command`: what to run again after installing Node.js (default `npm start`;
 *   scripts/demo.js says `npm run demo`)
 * @returns {string}
 */
export function nodeVersionProblem(version = process.versions.node, { command = 'npm start' } = {}) {
  if (isSupportedNode(version)) return '';
  const shown = String(version ?? '').trim().replace(/^v/, '').slice(0, 40) || 'unknown';
  const note = /^23\./.test(shown) ? ', and Node 23 is not supported' : '';
  return `MyJournal needs Node.js ${MIN_NODE.major}.${MIN_NODE.minor} or newer (this is v${shown}${note}). `
    + `Install a current version from https://nodejs.org and run ${String(command).replace(/\s+/g, ' ').trim().slice(0, 60) || 'npm start'} again.`;
}
