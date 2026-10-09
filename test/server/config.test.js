import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError, assertSafeToStart, dotEnvPasswordWarning, isLoopbackHost, loadConfig, loadDotEnv } from '../../src/config.js';
import { describeAi, formatBanner } from '../../src/server/banner.js';
import { defaultSettings } from '../../src/settings.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('loadConfig', () => {
  it('uses the documented defaults', () => {
    const c = loadConfig({}, { cwd: '/somewhere' });
    assert.equal(c.port, 3210);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.dataDir, '/somewhere/data');
    assert.equal(c.dbFile, '/somewhere/data/journal.db');
    assert.equal(c.password, '');
    assert.deepEqual(c.allowedHosts, []);
    assert.equal(c.insecureAllowNoAuth, false);
    assert.equal(c.maxJsonBytes, 1024 * 1024);
    assert.equal(c.maxImportBytes, 50 * 1024 * 1024);
    assert.match(c.version, /^\d+\.\d+\.\d+/);
  });

  it('parses every variable of section 5', () => {
    const c = loadConfig({
      PORT: '4000',
      HOST: '0.0.0.0',
      JOURNAL_DATA_DIR: 'journal-data',
      JOURNAL_PASSWORD: 'correct horse',
      JOURNAL_ALLOWED_HOSTS: ' Journal.Example.com , https://other.example.org/path ,192.168.1.20:8080,,',
      JOURNAL_INSECURE_ALLOW_NO_AUTH: '1',
    }, { cwd: '/base' });
    assert.equal(c.port, 4000);
    assert.equal(c.host, '0.0.0.0');
    assert.equal(c.dataDir, '/base/journal-data');
    assert.equal(c.password, 'correct horse');
    assert.deepEqual(c.allowedHosts, ['journal.example.com', 'other.example.org', '192.168.1.20:8080']);
    assert.equal(c.insecureAllowNoAuth, true);
  });

  it('accepts port 0 and brackets around an IPv6 host', () => {
    assert.equal(loadConfig({ PORT: '0' }).port, 0);
    assert.equal(loadConfig({ HOST: '[::1]' }).host, '::1');
  });

  it('rejects malformed values with a ConfigError that says what to do', () => {
    for (const env of [{ PORT: 'abc' }, { PORT: '70000' }, { PORT: '-1' }, { PORT: '3210; rm' }]) {
      assert.throws(() => loadConfig(env), (err) => err instanceof ConfigError && /PORT/.test(err.message) && Boolean(err.hint));
    }
    assert.throws(() => loadConfig({ HOST: 'bad host!' }), ConfigError);
    assert.throws(() => loadConfig({ JOURNAL_ALLOWED_HOSTS: 'ok.example.com,bad host' }), ConfigError);
  });

  it('lets overrides win', () => {
    const c = loadConfig({ PORT: '4000' }, { overrides: { port: 0, quiet: true, dataDir: '/x' } });
    assert.equal(c.port, 0);
    assert.equal(c.quiet, true);
    assert.equal(c.dbFile, '/x/journal.db');
  });
});

describe('startup safety rule', () => {
  it('knows which hosts are loopback', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.5.5.5', 'LOCALHOST', '::ffff:127.0.0.1']) assert.equal(isLoopbackHost(host), true, host);
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com', '10.0.0.1', '127.evil.com', '']) assert.equal(isLoopbackHost(host), false, host);
  });

  it('refuses a non-loopback host without a password', () => {
    assert.throws(() => assertSafeToStart({ host: '0.0.0.0', password: '', insecureAllowNoAuth: false }), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /without a password/);
      assert.match(err.hint, /JOURNAL_PASSWORD/);
      assert.match(err.hint, /JOURNAL_INSECURE_ALLOW_NO_AUTH=1/);
      return true;
    });
  });

  it('allows loopback, a password, or the explicit override', () => {
    assert.doesNotThrow(() => assertSafeToStart({ host: '127.0.0.1', password: '' }));
    assert.doesNotThrow(() => assertSafeToStart({ host: '0.0.0.0', password: 'secret' }));
    assert.doesNotThrow(() => assertSafeToStart({ host: '0.0.0.0', password: '', insecureAllowNoAuth: true }));
  });
});

describe('loadDotEnv', () => {
  it('loads a .env file but never overrides the real environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myjournal-env-'));
    try {
      writeFileSync(join(dir, '.env'), 'MJ_TEST_FROM_FILE=file\nMJ_TEST_BOTH=file\n');
      process.env.MJ_TEST_BOTH = 'real';
      const result = loadDotEnv({ cwd: dir });
      assert.equal(result.loaded, true);
      assert.equal(process.env.MJ_TEST_FROM_FILE, 'file');
      assert.equal(process.env.MJ_TEST_BOTH, 'real');
    } finally {
      delete process.env.MJ_TEST_FROM_FILE;
      delete process.env.MJ_TEST_BOTH;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a missing file as normal and reports an unreadable one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myjournal-env-'));
    try {
      assert.deepEqual(loadDotEnv({ cwd: dir }), { loaded: false, path: join(dir, '.env') });
      writeFileSync(join(dir, '.env'), 'X=1\n');
      const broken = loadDotEnv({ cwd: dir, loader() { throw new Error('boom'); } });
      assert.equal(broken.loaded, false);
      assert.equal(broken.error, 'boom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a .env password that Node would cut at a #', () => {
  it('is recognised, quoted or commented-out lines are not', () => {
    assert.match(dotEnvPasswordWarning('JOURNAL_PASSWORD=correct horse #1 staple battery\n'), /only 13 characters long/);
    assert.match(dotEnvPasswordWarning('PORT=0\r\nexport JOURNAL_PASSWORD = a#b long passphrase'), /only 1 character long/);
    assert.equal(dotEnvPasswordWarning("JOURNAL_PASSWORD='correct horse #1 staple battery'"), null);
    assert.equal(dotEnvPasswordWarning('JOURNAL_PASSWORD="correct horse #1"'), null);
    assert.equal(dotEnvPasswordWarning('# JOURNAL_PASSWORD=a#b\nJOURNAL_PASSWORD=plain passphrase'), null);
    assert.equal(dotEnvPasswordWarning(''), null);
  });

  it('loadDotEnv reports it, unless the real environment already holds the password', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myjournal-env-'));
    try {
      writeFileSync(join(dir, '.env'), 'MJ_TEST_OTHER=1\nJOURNAL_PASSWORD=correct horse #1 staple battery\n');
      const noop = () => {};
      assert.match(loadDotEnv({ cwd: dir, loader: noop, env: {} }).warning, /contains a #/);
      assert.equal(loadDotEnv({ cwd: dir, loader: noop, env: { JOURNAL_PASSWORD: 'from the shell' } }).warning, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('banner', () => {
  const config = loadConfig({ JOURNAL_DATA_DIR: '/data' }, { cwd: '/x' });

  it('describes the AI state', () => {
    const s = defaultSettings();
    assert.equal(describeAi(s, {}).state, 'none');
    assert.match(describeAi(s, { GEMINI_API_KEY: 'abc' }).text, /Gemini key/);
    s.ai.provider = 'local';
    assert.equal(describeAi(s, {}).state, 'ready');
    assert.match(describeAi(s, {}).text, /llama3\.2:3b/);
    s.ai.provider = 'openai';
    assert.equal(describeAi(s, {}).state, 'needs_setup');
    assert.equal(describeAi(s, { OPENAI_API_KEY: 'sk-x' }).state, 'ready');
    s.ai.enabled = false;
    assert.equal(describeAi(s, {}).state, 'off');
  });

  it('shows the URL, data location, how to configure an AI and the demo hint', () => {
    const text = formatBanner({ config, url: 'http://127.0.0.1:3210', settings: defaultSettings() });
    assert.match(text, /http:\/\/127\.0\.0\.1:3210/);
    assert.match(text, /\/data\/journal\.db/);
    assert.match(text, /GEMINI_API_KEY/);
    assert.match(text, /OPENAI_API_KEY/);
    assert.match(text, /Ollama/);
    assert.match(text, /npm run demo/);
    assert.doesNotMatch(text, /WARNING/);
  });

  it('is quiet about setup once an AI is ready and warns about open networks', () => {
    const settings = defaultSettings();
    settings.ai.provider = 'local';
    const ready = formatBanner({ config, url: 'http://127.0.0.1:3210', settings });
    assert.doesNotMatch(ready, /Add an AI companion/);
    const open = formatBanner({ config: { ...config, host: '0.0.0.0', insecureAllowNoAuth: true }, url: 'http://localhost:3210', settings });
    assert.match(open, /WITHOUT a password/);
    const pw = formatBanner({ config: { ...config, host: '0.0.0.0', password: 'short' }, url: 'http://localhost:3210', settings });
    assert.match(pw, /HTTPS/);
    assert.match(pw, /password is short/);
    assert.doesNotMatch(pw, /short'/);
  });

  it('warns about a short password on a loopback address too, and says how a .env file shortens one', () => {
    const settings = defaultSettings();
    const short = formatBanner({ config: { ...config, password: 'a' }, url: 'http://127.0.0.1:3210', settings });
    assert.match(short, /password is short \(1 character\)/);
    assert.match(short, /\.env file an unquoted #/);
    assert.match(short, /single quotes/);
    const fine = formatBanner({ config: { ...config, password: 'a long passphrase here' }, url: 'http://127.0.0.1:3210', settings });
    assert.match(fine, /Password\s+required/);
    assert.doesNotMatch(fine, /password is short/);
  });

  it('uses the right article in "found a/an ... key"', () => {
    const settings = defaultSettings();
    assert.match(describeAi(settings, { OPENAI_API_KEY: 'sk-x' }).text, /found an OpenAI key/);
    assert.match(describeAi(settings, { GEMINI_API_KEY: 'k' }).text, /found a Gemini key/);
    assert.match(describeAi(settings, { GOOGLE_API_KEY: 'k', OPENAI_API_KEY: 'sk-x' }).text, /found a Gemini and OpenAI key/);
  });
});

// The real entry point, in a child process.
function runServer(env, { stopAfterReady = false, timeoutMs = 15000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'myjournal-boot-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
      cwd: dir,
      env: { PATH: process.env.PATH, JOURNAL_DATA_DIR: join(dir, 'data'), ...env },
    });
    let out = '';
    let err = '';
    let sentSignal = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server.js did not finish in time. stdout: ${out} stderr: ${err}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
      if (stopAfterReady && !sentSignal && /Stop with Ctrl\+C/.test(out)) {
        sentSignal = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, out, err });
    });
  });
}

describe('server.js', () => {
  it('refuses to start on a non-loopback HOST without a password', async () => {
    const { code, err, out } = await runServer({ HOST: '0.0.0.0', PORT: '0' });
    assert.equal(code, 1);
    assert.match(err, /could not start/i);
    assert.match(err, /without a password/);
    assert.match(err, /JOURNAL_PASSWORD/);
    assert.doesNotMatch(out, /Open /);
  });

  it('starts with a password, prints the banner and shuts down cleanly on SIGTERM', async () => {
    const { code, out } = await runServer({ HOST: '0.0.0.0', PORT: '0', JOURNAL_PASSWORD: 'a long enough passphrase' }, { stopAfterReady: true });
    assert.equal(code, 0);
    assert.match(out, /Open\s+http:\/\/localhost:\d+/);
    assert.match(out, /Password\s+required/);
    assert.match(out, /SIGTERM received/);
    assert.match(out, /Your journal is saved/);
  });

  it('starts on the insecure override and warns loudly', async () => {
    const { code, out } = await runServer({ HOST: '0.0.0.0', PORT: '0', JOURNAL_INSECURE_ALLOW_NO_AUTH: '1' }, { stopAfterReady: true });
    assert.equal(code, 0);
    assert.match(out, /WITHOUT a password/);
  });

  it('explains a busy port and how to pick another', async () => {
    const blocker = createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address();
    try {
      const { code, err } = await runServer({ PORT: String(port) });
      assert.equal(code, 1);
      assert.match(err, new RegExp(`Port ${port} is already in use`));
      assert.match(err, new RegExp(`PORT=${port + 1} npm start`));
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('reports a malformed PORT in plain words', async () => {
    const { code, err } = await runServer({ PORT: 'banana' });
    assert.equal(code, 1);
    assert.match(err, /PORT must be a number/);
  });

  it('reads a .env file from the working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myjournal-dotenv-'));
    try {
      writeFileSync(join(dir, '.env'), 'PORT=0\nJOURNAL_PASSWORD=from-dotenv\nHOST=0.0.0.0\n');
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
          cwd: dir,
          env: { PATH: process.env.PATH, JOURNAL_DATA_DIR: join(dir, 'data') },
        });
        let out = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, 15000);
        child.stdout.on('data', (d) => {
          out += d;
          if (/Stop with Ctrl\+C/.test(out)) child.kill('SIGINT');
        });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
      });
      assert.equal(result.code, 0);
      assert.match(result.out, /Password\s+required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a data file that is not a database: says the file is the problem, leaves it alone and does not blame the folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myjournal-badfile-'));
    try {
      mkdirSync(join(dir, 'data'));
      writeFileSync(join(dir, 'data', 'journal.db'), 'this is not a sqlite file');
      const r = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
          cwd: dir,
          env: { PATH: process.env.PATH, PORT: '0', JOURNAL_DATA_DIR: join(dir, 'data') },
        });
        let err = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, 15000);
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
      });
      assert.equal(r.code, 1);
      assert.match(r.err, /is not a readable MyJournal database \(file is not a database\)/);
      assert.match(r.err, /MyJournal has not changed that file\. Restore a backup/);
      assert.doesNotMatch(r.err, /exists and is writable|at .*\(.*\.js:\d+/);
      assert.equal(readFileSync(join(dir, 'data', 'journal.db'), 'utf8'), 'this is not a sqlite file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a SQLite file of another program in the data folder gets the same plain answer, not a crash with a stack trace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myjournal-foreign-'));
    try {
      mkdirSync(join(dir, 'data'));
      const other = new DatabaseSync(join(dir, 'data', 'journal.db'));
      other.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY); PRAGMA user_version = 1');
      other.close();
      const r = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
          cwd: dir,
          env: { PATH: process.env.PATH, PORT: '0', JOURNAL_DATA_DIR: join(dir, 'data') },
        });
        let err = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, 15000);
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
      });
      assert.equal(r.code, 1);
      assert.match(r.err, /MyJournal could not start\./);
      assert.match(r.err, /is not a MyJournal database \(no such table: entries\)/);
      assert.doesNotMatch(r.err, /crashed while starting|at .*\(.*\.js:\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a # in an unquoted .env password: the terminal says so, and single quotes keep the password whole', async () => {
    const run = async (line) => {
      const dir = mkdtempSync(join(tmpdir(), 'myjournal-dotenv-'));
      try {
        writeFileSync(join(dir, '.env'), `PORT=0\n${line}\n`);
        return await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
            cwd: dir,
            env: { PATH: process.env.PATH, JOURNAL_DATA_DIR: join(dir, 'data') },
          });
          let out = '';
          let err = '';
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, 15000);
          child.stderr.on('data', (d) => { err += d; });
          child.stdout.on('data', (d) => {
            out += d;
            if (/Stop with Ctrl\+C/.test(out)) child.kill('SIGINT');
          });
          child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const cut = await run('JOURNAL_PASSWORD=correct horse #1 staple battery');
    assert.match(cut.err, /warning: the JOURNAL_PASSWORD line of your \.env file contains a #.*only 13 characters long/);
    const short = await run('JOURNAL_PASSWORD=a#b long passphrase');
    assert.match(short.out, /Your password is short \(1 character\)/);
    const quoted = await run("JOURNAL_PASSWORD='correct horse #1 staple battery'");
    assert.match(quoted.out, /Password\s+required/);
    assert.doesNotMatch(quoted.err, /warning/);
    assert.doesNotMatch(quoted.out, /password is short/);
  });
});
