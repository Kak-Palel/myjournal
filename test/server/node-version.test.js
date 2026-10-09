// The Node.js version check of server.js. A Node older than 22.16 (or 23.x) must get one friendly sentence, not the raw
// "No such built-in module: node:sqlite" stack trace that a static import chain produces before any code runs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIN_NODE, isSupportedNode, nodeVersionProblem } from '../../src/server/node-version.js';
import { waitFor } from './helpers.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./fixtures/fake-node-version.mjs', import.meta.url));
const NO_FTS5 = fileURLToPath(new URL('./fixtures/no-fts5.mjs', import.meta.url));

describe('isSupportedNode / nodeVersionProblem', () => {
  it('knows the minimum (22.16) and accepts 22.16 and newer 22.x, and 24 and newer', () => {
    assert.deepEqual({ ...MIN_NODE }, { major: 22, minor: 16 });
    for (const ok of ['22.16.0', '22.16.1', '22.17.0', '22.22.0', '24.0.0', '24.1.0', '25.0.0', '30.0.0', 'v22.16.0', ' 22.16.0 ', '22.16.0-nightly20241001', '24.0.0-rc.1']) {
      assert.equal(isSupportedNode(ok), true, ok);
      assert.equal(nodeVersionProblem(ok), '', ok);
    }
  });

  it('refuses anything older, all of Node 23, and anything that is not a version', () => {
    // 22.13 to 22.15 and every 23.x: node:sqlite works but its SQLite has no FTS5 ("no such module: fts5"), measured on the official binaries.
    for (const bad of ['22.15.1', '22.15.0', '22.14.0', '22.13.0', '22.13.1', '22.12.0', '22.5.1', '22.0.0', '23.0.0', '23.6.0', '23.11.0', 'v23.11.1', '23.0.0-rc.1', '21.7.3', '20.20.0', '20.19.0', '18.20.4', '16.0.0', '8.17.0', 'v20.0.0', '', '   ', 'banana', '22', 'v', null, '.13.0']) {
      assert.equal(isSupportedNode(bad), false, String(bad));
      assert.notEqual(nodeVersionProblem(bad), '', String(bad));
    }
    assert.equal(isSupportedNode(), true, 'the Node running this suite is supported (default: process.versions.node)');
    assert.equal(nodeVersionProblem(), '');
  });

  it('the message names the minimum and the running version and says what to do', () => {
    assert.equal(
      nodeVersionProblem('20.20.0'),
      'MyJournal needs Node.js 22.16 or newer (this is v20.20.0). Install a current version from https://nodejs.org and run npm start again.',
    );
    assert.match(nodeVersionProblem('v21.7.3'), /\(this is v21\.7\.3\)/, 'a leading v is not doubled');
    assert.match(nodeVersionProblem('22.15.1'), /\(this is v22\.15\.1\)/);
    assert.match(nodeVersionProblem('23.6.0'), /\(this is v23\.6\.0, and Node 23 is not supported\)/, 'Node 23 is newer than 22.16 but unsupported, and the message says why it is still refused');
    assert.doesNotMatch(nodeVersionProblem('22.15.1'), /Node 23/);
    assert.match(nodeVersionProblem('x'.repeat(500)), /^MyJournal needs Node\.js 22\.16 or newer \(this is vx{40}\)\./, 'a silly version string cannot flood the terminal');
  });
});

/** Run server.js as `node --import fake-node-version.mjs server.js` pretending to be another Node version. */
function runServer(fakeVersion, { until, signalAfterMatch = 'SIGTERM', timeoutMs = 20000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'myjournal-nodever-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, join(ROOT, 'server.js')], {
    cwd: dir,
    env: { PATH: process.env.PATH, FAKE_NODE_VERSION: fakeVersion, PORT: '0', JOURNAL_DATA_DIR: join(dir, 'data') },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const finish = async () => {
    if (until) {
      await waitFor(() => until(out), { timeoutMs: timeoutMs - 2000, message: 'the expected output' });
      child.kill(signalAfterMatch);
    }
    const result = await closed;
    clearTimeout(killer);
    const dataDirCreated = existsSync(join(dir, 'data'));
    rmSync(dir, { recursive: true, force: true });
    return { ...result, out, err, dataDirCreated };
  };
  return finish();
}

describe('server.js on a Node.js that is too old', () => {
  for (const version of ['20.19.0', '21.7.3', '22.15.1', '23.11.0']) {
    it(`v${version}: prints the friendly message, exits 1 and never loads node:sqlite`, async () => {
      const r = await runServer(version);
      assert.equal(r.code, 1);
      assert.match(r.err, new RegExp(`MyJournal needs Node\\.js 22\\.16 or newer \\(this is v${version.replace(/\./g, '\\.')}(?:, and Node 23 is not supported)?\\)\\. Install a current version from https://nodejs\\.org and run npm start again\\.`));
      assert.doesNotMatch(r.err, /ERR_UNKNOWN_BUILTIN_MODULE|No such built-in module|at .*\(.*\.js:\d+/, 'no stack trace');
      assert.match(r.err, /\[probe\] node:sqlite not loaded/, 'the check ran before anything that needs node:sqlite was imported');
      assert.equal(r.out, '', 'nothing on stdout (no banner)');
      assert.equal(r.dataDirCreated, false, 'and no data folder was created');
    });
  }

  it('v22.16.0 (the minimum) starts normally and shuts down cleanly', async () => {
    const r = await runServer('22.16.0', { until: (out) => /Open\s+http:\/\/\S+/.test(out) });
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.err, /needs Node\.js/);
    assert.match(r.err, /\[probe\] node:sqlite LOADED/, 'the rest of the app was loaded (dynamic import)');
    assert.match(r.out, /Goodbye/);
  });
});

/* ---------------------------------------------------------------------------------------------------------------------
 * Every script that reaches node:sqlite: npm run demo, npm test, npm run test:e2e (and npm start / npm run dev through
 * server.js) must print the same friendly sentence on a Node that is too old.
 * ------------------------------------------------------------------------------------------------------------------- */

describe('nodeVersionProblem names the command to run again', () => {
  it('defaults to npm start; a script can name its own command', () => {
    assert.match(nodeVersionProblem('20.20.0'), /and run npm start again\.$/);
    assert.match(nodeVersionProblem('20.20.0', { command: 'npm run demo' }), /and run npm run demo again\.$/);
    assert.match(nodeVersionProblem('20.20.0', { command: 'npm run dev' }), /and run npm run dev again\.$/);
    assert.equal(nodeVersionProblem('22.16.0', { command: 'npm run demo' }), '', 'no problem, no message');
    assert.match(nodeVersionProblem('20.20.0', { command: '' }), /run npm start again\.$/, 'an empty command falls back');
    assert.match(nodeVersionProblem('20.20.0', { command: 'x'.repeat(500) }), /run x{60} again\.$/, 'and cannot flood the terminal');
  });
});

/** Run `node --import fake-node-version.mjs <script> [args]` pretending to be another Node.js version. */
function runScript(script, fakeVersion, { args = [], env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'myjournal-nodever-'));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, join(ROOT, script), ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, FAKE_NODE_VERSION: fakeVersion, TMPDIR: dir, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      const leftovers = readdirSync(dir);
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, signal, out, err, leftovers });
    });
  });
}

describe('scripts/demo.js (npm run demo) on a Node.js that is too old', () => {
  for (const version of ['20.20.0', '21.7.3', '22.15.1', '23.6.0']) {
    it(`v${version}: one friendly sentence naming npm run demo, exit 1, no stack trace, node:sqlite never loaded, no temporary folder`, async () => {
      const r = await runScript('scripts/demo.js', version);
      assert.equal(r.code, 1);
      assert.match(r.err, new RegExp(`MyJournal needs Node\\.js 22\\.16 or newer \\(this is v${version.replace(/\./g, '\\.')}(?:, and Node 23 is not supported)?\\)\\. Install a current version from https://nodejs\\.org and run npm run demo again\\.`));
      assert.doesNotMatch(r.err, /ERR_UNKNOWN_BUILTIN_MODULE|No such built-in module|at .*\(.*\.js:\d+/, 'no stack trace');
      assert.match(r.err, /\[probe\] node:sqlite not loaded/);
      assert.equal(r.out, '');
      assert.deepEqual(r.leftovers, [], 'no myjournal-demo-* folder was created');
    });
  }

  it('v22.16.0 (the minimum) runs the real demo, which cleans up after itself', async () => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, join(ROOT, 'scripts/demo.js')], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, FAKE_NODE_VERSION: '22.16.0', TMPDIR: process.env.TMPDIR || '' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    try {
      await waitFor(() => /Open\s+http:\/\/\S+/.test(out), { timeoutMs: 15000, message: 'the demo address' });
      child.kill('SIGTERM');
      assert.equal(await closed, 0, err);
      assert.match(err, /\[probe\] node:sqlite LOADED/);
      assert.doesNotMatch(err, /needs Node\.js/);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('scripts/require-node.js (the pretest and pretest:e2e hooks)', () => {
  it('prints the friendly sentence with the command to run again and exits 1 on a Node that is too old', async () => {
    const test = await runScript('scripts/require-node.js', '20.20.0', { args: ['npm test'] });
    assert.equal(test.code, 1);
    assert.match(test.err, /MyJournal needs Node\.js 22\.16 or newer \(this is v20\.20\.0\)\. Install a current version from https:\/\/nodejs\.org and run npm test again\./);
    assert.doesNotMatch(test.err, /No such built-in module|ERR_UNKNOWN/);
    const e2e = await runScript('scripts/require-node.js', '21.7.3', { args: ['npm run test:e2e'] });
    assert.equal(e2e.code, 1);
    assert.match(e2e.err, /and run npm run test:e2e again\./);
    const bare = await runScript('scripts/require-node.js', '18.20.4');
    assert.match(bare.err, /and run npm test again\./, 'without an argument it names npm test');
    for (const r of [test, e2e, bare]) assert.match(r.err, /\[probe\] node:sqlite not loaded/);
  });

  it('is silent and exits 0 on a supported Node', async () => {
    for (const version of ['22.16.0', '24.1.0']) {
      const r = await runScript('scripts/require-node.js', version, { args: ['npm test'] });
      assert.equal(r.code, 0, version);
      assert.equal(r.out, '');
      assert.doesNotMatch(r.err, /needs Node/);
    }
  });
});

// A Node.js whose node:sqlite loads but whose bundled SQLite was built without FTS5 (the real cases are 22.13 to 22.15 and 23.x, which
// the version check refuses; an unusual build of a newer release could still be one). The database layer must say so in words that
// name the Node in use, and the demo must not print a stack trace.
describe('a Node.js whose SQLite has no FTS5 (preloaded stand-in)', () => {
  const run = (script, { env = {} } = {}) => new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'myjournal-nofts-'));
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', NO_FTS5, join(ROOT, script)], {
      cwd: dir,
      env: { PATH: process.env.PATH, PORT: '0', JOURNAL_DATA_DIR: join(dir, 'data'), TMPDIR: dir, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (code) => {
      clearTimeout(killer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, out, err });
    });
  });

  it('server.js: says what is missing and which Node to install, with no writable-folder advice and no stack trace', async () => {
    const r = await run('server.js');
    assert.equal(r.code, 1);
    assert.match(r.err, /MyJournal could not start\./);
    assert.match(r.err, new RegExp(`has no FTS5 full-text search[^\\n]*Node\\.js 22\\.16 or newer \\(not 23\\.x\\), or 24 or newer`));
    assert.ok(r.err.includes(`v${process.versions.node}`), 'names the Node that is running');
    assert.match(r.err, /Install a newer Node\.js from https:\/\/nodejs\.org and run npm start again\./);
    assert.doesNotMatch(r.err, /writable|22\.13|at .*\(.*\.js:\d+/);
  });

  it('npm run demo: the same sentence, not a DbError stack', async () => {
    const r = await run('scripts/demo.js');
    assert.equal(r.code, 1);
    assert.match(r.err, /The demo could not start: The SQLite inside this Node\.js \(v[\d.]+\) has no FTS5 full-text search/);
    assert.doesNotMatch(r.err, /at .*\(.*\.js:\d+|DbError:/);
  });
});

describe('every entry point that reaches node:sqlite is guarded', () => {
  const read = (path) => readFileSync(join(ROOT, path), 'utf8');
  const staticImports = (source) => [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
  const scripts = JSON.parse(read('package.json')).scripts;

  it('the launchers import nothing but the dependency-free version check statically', () => {
    for (const file of ['server.js', 'scripts/demo.js', 'scripts/require-node.js']) {
      const imports = staticImports(read(file));
      assert.equal(imports.length, 1, `${file}: ${imports}`);
      assert.match(imports[0], /src\/server\/node-version\.js$/, file);
    }
    assert.deepEqual(staticImports(read('src/server/node-version.js')), [], 'and the check itself imports nothing');
  });

  it('npm run demo goes through the launcher; npm test and npm run test:e2e run the check first', () => {
    assert.match(scripts.demo, /\bscripts\/demo\.js$/);
    assert.match(scripts.pretest, /scripts\/require-node\.js "npm test"/);
    assert.match(scripts['pretest:e2e'], /scripts\/require-node\.js "npm run test:e2e"/);
    assert.match(scripts.start, /\bserver\.js$/);
    assert.match(scripts.dev, /\bserver\.js$/);
  });

  it('no other script file loads the app statically (the demo itself lives in demo-lib.js)', () => {
    assert.match(read('scripts/demo-lib.js'), /from '\.\.\/src\/db\/index\.js'/);
    for (const file of ['scripts/check.js']) assert.doesNotMatch(read(file), /src\/db|sqlite/, `${file} does not need node:sqlite`);
  });
});

// Opt-in proof on a REAL older Node.js (not a stub):
//   MYJOURNAL_OLD_NODE=$(npx -y node@20.20.0 -p process.execPath) npm test
// (npx node@20 works from npm, no install needed). Not registered at all when the variable is not set.
if (process.env.MYJOURNAL_OLD_NODE) describe('on a real older Node.js (MYJOURNAL_OLD_NODE)', () => {
  const run = (script, args = []) => new Promise((resolve) => {
    const child = spawn(process.env.MYJOURNAL_OLD_NODE, [join(ROOT, script), ...args], { cwd: ROOT, env: { PATH: process.env.PATH } });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, err }));
  });

  for (const [script, args, command] of [['server.js', [], 'npm start'], ['scripts/demo.js', [], 'npm run demo'], ['scripts/require-node.js', ['npm test'], 'npm test']]) {
    it(`${script}: friendly message, exit 1, no stack trace`, async () => {
      const r = await run(script, args);
      assert.equal(r.code, 1);
      assert.match(r.err, new RegExp(`MyJournal needs Node\\.js 22\\.16 or newer \\(this is v\\d+\\.\\d+\\.\\d+\\)\\. Install a current version from https://nodejs\\.org and run ${command} again\\.`));
      assert.doesNotMatch(r.err, /ERR_UNKNOWN_BUILTIN_MODULE|No such built-in module/);
    });
  }
});
