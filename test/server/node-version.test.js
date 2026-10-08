// The Node.js version check of server.js. A Node older than 22.13 must get one friendly sentence, not the raw
// "No such built-in module: node:sqlite" stack trace that a static import chain produces before any code runs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIN_NODE, isSupportedNode, nodeVersionProblem } from '../../src/server/node-version.js';
import { waitFor } from './helpers.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./fixtures/fake-node-version.mjs', import.meta.url));

describe('isSupportedNode / nodeVersionProblem', () => {
  it('knows the minimum (22.13) and accepts everything from it upwards', () => {
    assert.deepEqual({ ...MIN_NODE }, { major: 22, minor: 13 });
    for (const ok of ['22.13.0', '22.13.1', '22.14.0', '22.22.0', '23.0.0', '24.1.0', '30.0.0', 'v22.13.0', ' 22.13.0 ', '22.13.0-nightly20241001', '23.0.0-rc.1']) {
      assert.equal(isSupportedNode(ok), true, ok);
      assert.equal(nodeVersionProblem(ok), '', ok);
    }
  });

  it('refuses anything older, and anything that is not a version', () => {
    for (const bad of ['22.12.0', '22.12.99', '22.5.1', '22.0.0', '21.7.3', '20.20.0', '20.19.0', '18.20.4', '16.0.0', '8.17.0', 'v20.0.0', '', '   ', 'banana', '22', 'v', null, '.13.0']) {
      assert.equal(isSupportedNode(bad), false, String(bad));
      assert.notEqual(nodeVersionProblem(bad), '', String(bad));
    }
    assert.equal(isSupportedNode(), true, 'the Node running this suite is supported (default: process.versions.node)');
    assert.equal(nodeVersionProblem(), '');
  });

  it('the message names the minimum and the running version and says what to do', () => {
    assert.equal(
      nodeVersionProblem('20.20.0'),
      'MyJournal needs Node.js 22.13 or newer (this is v20.20.0). Install a current version from https://nodejs.org and run npm start again.',
    );
    assert.match(nodeVersionProblem('v21.7.3'), /\(this is v21\.7\.3\)/, 'a leading v is not doubled');
    assert.match(nodeVersionProblem('22.12.0'), /\(this is v22\.12\.0\)/);
    assert.match(nodeVersionProblem('x'.repeat(500)), /^MyJournal needs Node\.js 22\.13 or newer \(this is vx{40}\)\./, 'a silly version string cannot flood the terminal');
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
  for (const version of ['20.19.0', '21.7.3', '22.12.0']) {
    it(`v${version}: prints the friendly message, exits 1 and never loads node:sqlite`, async () => {
      const r = await runServer(version);
      assert.equal(r.code, 1);
      assert.match(r.err, new RegExp(`MyJournal needs Node\\.js 22\\.13 or newer \\(this is v${version.replace(/\./g, '\\.')}\\)\\. Install a current version from https://nodejs\\.org and run npm start again\\.`));
      assert.doesNotMatch(r.err, /ERR_UNKNOWN_BUILTIN_MODULE|No such built-in module|at .*\(.*\.js:\d+/, 'no stack trace');
      assert.match(r.err, /\[probe\] node:sqlite not loaded/, 'the check ran before anything that needs node:sqlite was imported');
      assert.equal(r.out, '', 'nothing on stdout (no banner)');
      assert.equal(r.dataDirCreated, false, 'and no data folder was created');
    });
  }

  it('v22.13.0 (the minimum) starts normally and shuts down cleanly', async () => {
    const r = await runServer('22.13.0', { until: (out) => /Open\s+http:\/\/\S+/.test(out) });
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.err, /needs Node\.js/);
    assert.match(r.err, /\[probe\] node:sqlite LOADED/, 'the rest of the app was loaded (dynamic import)');
    assert.match(r.out, /Goodbye/);
  });
});
