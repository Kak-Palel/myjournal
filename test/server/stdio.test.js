import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ignoreStdioErrors } from '../../src/server/logger.js';
import { rawRequest, waitFor } from './helpers.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('stdout / stderr that nobody reads any more', () => {
  it('ignoreStdioErrors swallows stream errors once per stream', () => {
    const stream = new EventEmitter();
    ignoreStdioErrors([stream]);
    ignoreStdioErrors([stream, null]);
    assert.equal(stream.listenerCount('error'), 1, 'guarded once, however often it is asked');
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    assert.doesNotThrow(() => stream.emit('error', epipe));
    // Without a listener an 'error' event throws, which is what used to end the process.
    assert.throws(() => new EventEmitter().emit('error', epipe), /EPIPE/);
  });

  it('server.js keeps serving (and shuts down cleanly) after its stdout reader has gone away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myjournal-epipe-'));
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
      cwd: dir,
      env: { PATH: process.env.PATH, PORT: '0', JOURNAL_DATA_DIR: join(dir, 'data') },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
      const url = await waitFor(() => /Open\s+(http:\/\/\S+)/.exec(out)?.[1], { timeoutMs: 15000, message: 'the start-up banner' });
      // Like `npm start | head -n 2` after head has exited: every further log line now hits a closed pipe.
      child.stdout.destroy();
      child.stderr.destroy();
      for (let i = 0; i < 6; i += 1) {
        const res = await rawRequest(url, 'GET', '/api/health');
        assert.equal(res.status, 200, `request ${i + 1} after the pipe closed`);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.equal(child.exitCode, null, `the server is still running (stderr: ${err})`);
      child.kill('SIGTERM');
      const { code } = await closed;
      assert.equal(code, 0, 'a clean shutdown even though the goodbye text had nowhere to go');
    } finally {
      clearTimeout(timer);
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
