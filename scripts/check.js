#!/usr/bin/env node
// Static checks that need no dependencies:  npm run check
//   1. `node --check` on every .js / .mjs / .cjs file under src, public, test, scripts, plus server.js
//   2. a grep that fails on innerHTML and eval (and their close relatives) anywhere in public/, because the
//      frontend builds DOM with h() / textContent only and runs under a strict CSP.

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT_DIRS = ['src', 'public', 'test', 'scripts'];
const SCRIPT_FILES = ['server.js'];
const EXTENSIONS = /\.(?:js|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.scratch']);
const PARALLEL = 8;

/** Patterns that must never appear in the browser code, with the reason shown to the developer. */
export const FORBIDDEN_IN_PUBLIC = Object.freeze([
  { re: /\binnerHTML\b/, why: 'innerHTML (build DOM with h() or textContent)' },
  { re: /\bouterHTML\s*=/, why: 'assigning outerHTML' },
  { re: /\binsertAdjacentHTML\b/, why: 'insertAdjacentHTML' },
  { re: /\beval\s*\(/, why: 'eval()' },
  { re: /\bnew\s+Function\s*\(/, why: 'new Function()' },
  { re: /\bdocument\.write(?:ln)?\s*\(/, why: 'document.write()' },
]);

/** @param {string} dir @returns {string[]} absolute paths of script files below `dir` */
export function collectScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectScripts(path));
    else if (entry.isFile() && EXTENSIONS.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Find forbidden constructs in a source text.
 * @param {string} text
 * @returns {{ line: number, why: string, source: string }[]}
 */
export function scanForbidden(text) {
  const found = [];
  text.split('\n').forEach((source, index) => {
    for (const { re, why } of FORBIDDEN_IN_PUBLIC) {
      if (re.test(source)) found.push({ line: index + 1, why, source: source.trim().slice(0, 120) });
    }
  });
  return found;
}

/**
 * How Node should parse a script. `.mjs`/`.cjs` say it themselves; a `.js` file follows the nearest package.json
 * "type" below `root`. Without a "type" it is a module: this project is ESM only, and leaving the decision to Node
 * (which guesses for typeless files) makes `node --check` pass a file with a syntax error whenever it contains
 * import/export, because the guess swallows the error.
 * @param {string} file absolute path
 * @param {string} root
 * @returns {'module'|'commonjs'}
 */
export function moduleTypeFor(file, root) {
  if (file.endsWith('.mjs')) return 'module';
  if (file.endsWith('.cjs')) return 'commonjs';
  const top = resolvePath(root);
  let dir = dirname(resolvePath(file));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        return JSON.parse(readFileSync(manifest, 'utf8')).type === 'commonjs' ? 'commonjs' : 'module';
      } catch {
        return 'module';
      }
    }
    const parent = dirname(dir);
    if (dir === top || parent === dir) return 'module';
    dir = parent;
  }
}

/** `node --check` with the source on stdin, so the module type is stated instead of guessed from the folder. */
async function syntaxCheck(file, root) {
  let source;
  try {
    source = await readFile(file);
  } catch (err) {
    return { file, message: `cannot read the file: ${err.message}` };
  }
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--check', `--input-type=${moduleTypeFor(file, root)}`],
      { cwd: ROOT },
      (error, _stdout, stderr) => {
        const text = String(stderr || (error && error.message) || '').replaceAll('[stdin]', file);
        resolve(error ? { file, message: text.trim().split('\n').slice(0, 6).join('\n') } : null);
      },
    );
    // The child may exit on the first error before it has read everything: that is not a failure of ours.
    child.stdin.on('error', () => {});
    child.stdin.end(source);
  });
}

/**
 * Run every check.
 * @param {{ root?: string, log?: (line: string) => void }} [options]
 * @returns {Promise<{ files: number, syntaxErrors: object[], forbidden: object[] }>}
 */
export async function runChecks({ root = ROOT, log = console.log } = {}) {
  const files = [
    ...SCRIPT_DIRS.flatMap((dir) => { try { return collectScripts(join(root, dir)); } catch { return []; } }),
    ...SCRIPT_FILES.map((name) => join(root, name)),
  ];
  const syntaxErrors = [];
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next];
      next += 1;
      const problem = await syntaxCheck(file, root);
      if (problem) syntaxErrors.push(problem);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  const forbidden = [];
  for (const file of files.filter((f) => f.startsWith(join(root, 'public') + '/'))) {
    for (const hit of scanForbidden(readFileSync(file, 'utf8'))) forbidden.push({ file, ...hit });
  }

  for (const e of syntaxErrors) log(`SYNTAX ERROR in ${relative(root, e.file)}\n${e.message}\n`);
  for (const f of forbidden) log(`FORBIDDEN in ${relative(root, f.file)}:${f.line}: ${f.why}\n    ${f.source}`);
  const ok = syntaxErrors.length === 0 && forbidden.length === 0;
  log(ok
    ? `OK: ${files.length} files pass node --check, and public/ has no innerHTML / eval.`
    : `FAILED: ${syntaxErrors.length} syntax error(s), ${forbidden.length} forbidden construct(s) in ${files.length} files.`);
  return { files: files.length, syntaxErrors, forbidden };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { syntaxErrors, forbidden } = await runChecks();
  process.exit(syntaxErrors.length === 0 && forbidden.length === 0 ? 0 : 1);
}
