// The Node.js version check that server.js runs before it loads anything else.
//
// This file must stay free of imports: on a Node that is too old, `import 'node:sqlite'` (several modules away)
// fails while the module graph is being linked, with a raw `ERR_UNKNOWN_BUILTIN_MODULE` stack trace. server.js
// therefore imports only this file statically, checks the version, and loads the rest with import().

/** The oldest Node.js release the app supports (`node:sqlite` without a flag; package.json "engines"). */
export const MIN_NODE = Object.freeze({ major: 22, minor: 13 });

/**
 * Is this Node.js version new enough? Accepts "22.13.0", "v22.13.0" and pre-release suffixes ("23.0.0-nightly...");
 * anything that does not start with major.minor counts as not supported.
 * @param {string} [version] defaults to the running Node (process.versions.node)
 * @returns {boolean}
 */
export function isSupportedNode(version = process.versions.node) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

/**
 * The friendly message for a Node.js that is too old, or '' when the version is fine.
 * @param {string} [version] defaults to the running Node (process.versions.node)
 * @returns {string}
 */
export function nodeVersionProblem(version = process.versions.node) {
  if (isSupportedNode(version)) return '';
  const shown = String(version ?? '').trim().replace(/^v/, '').slice(0, 40) || 'unknown';
  return `MyJournal needs Node.js ${MIN_NODE.major}.${MIN_NODE.minor} or newer (this is v${shown}). `
    + 'Install a current version from https://nodejs.org and run npm start again.';
}
