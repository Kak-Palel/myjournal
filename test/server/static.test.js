import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { HttpError } from '../../src/server/http.js';
import { mimeType, parseStaticPath } from '../../src/server/static.js';
import { startApp } from './helpers.js';

describe('parseStaticPath', () => {
  it('splits plain paths', () => {
    assert.deepEqual(parseStaticPath('/'), []);
    assert.deepEqual(parseStaticPath('/js/app.js'), ['js', 'app.js']);
    assert.deepEqual(parseStaticPath('/css/'), ['css']);
    assert.deepEqual(parseStaticPath('/caf%C3%A9.txt'), ['café.txt']);
  });

  it('rejects traversal, encoding tricks and odd characters', () => {
    for (const bad of ['', 'js/app.js', '/..', '/a/../b', '/%2e%2e/x', '/%2E%2e', '/a%2f..%2fb', '/%252e', '/a\\b', '/a%5Cb', '/a%00b', '/a\u0000b',
      '//x', '/a//b', '/./x', '/c:/x', '/x:y', '/a\nb', '/%']) {
      assert.throws(() => parseStaticPath(bad), (err) => err instanceof HttpError && [400, 404].includes(err.status), JSON.stringify(bad));
    }
    assert.throws(() => parseStaticPath('/.env'), (err) => err.status === 404);
  });

  it('knows common MIME types', () => {
    assert.equal(mimeType('.js'), 'text/javascript; charset=utf-8');
    assert.equal(mimeType('.css'), 'text/css; charset=utf-8');
    assert.equal(mimeType('.svg'), 'image/svg+xml');
    assert.equal(mimeType('.woff2'), 'font/woff2');
    assert.equal(mimeType('.weird'), 'application/octet-stream');
  });
});

describe('static files', () => {
  let h;
  let root;
  let outside;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'myjournal-public-'));
    outside = mkdtempSync(join(tmpdir(), 'myjournal-outside-'));
    mkdirSync(join(root, 'js'));
    mkdirSync(join(root, 'css'));
    mkdirSync(join(root, 'img'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>shell</title><div id="app"></div>');
    writeFileSync(join(root, 'js', 'app.js'), 'export const x = 1;\n');
    writeFileSync(join(root, 'css', 'base.css'), 'body { color: black; }\n');
    writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, 'img', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, 'data.unknownext'), 'x');
    writeFileSync(join(root, '.secret'), 'dotfile');
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET OUTSIDE');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
    symlinkSync(outside, join(root, 'leakdir'));
    symlinkSync(join(root, 'js', 'app.js'), join(root, 'inside-link.js'));
    h = await startApp({ ai: false, config: { publicDir: root } });
  });
  after(async () => {
    await h.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('serves files with the right type, no-cache and a validator', async () => {
    const cases = [
      ['/', 'text/html; charset=utf-8'],
      ['/index.html', 'text/html; charset=utf-8'],
      ['/js/app.js', 'text/javascript; charset=utf-8'],
      ['/css/base.css', 'text/css; charset=utf-8'],
      ['/favicon.svg', 'image/svg+xml'],
      ['/img/a.png', 'image/png'],
      ['/data.unknownext', 'application/octet-stream'],
    ];
    for (const [path, type] of cases) {
      const res = await h.get(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers['content-type'], type, path);
      assert.equal(res.headers['cache-control'], 'no-cache', path);
      assert.match(res.headers.etag, /^W\//, path);
      assert.ok(Number(res.headers['content-length']) > 0, path);
    }
    assert.equal((await h.get('/js/app.js')).text, 'export const x = 1;\n');
  });

  it('revalidates with If-None-Match and answers HEAD without a body', async () => {
    const first = await h.get('/js/app.js');
    const again = await h.get('/js/app.js', { headers: { 'If-None-Match': first.headers.etag } });
    assert.equal(again.status, 304);
    assert.equal(again.text, '');
    assert.equal(again.headers['cache-control'], 'no-cache');
    const stale = await h.get('/js/app.js', { headers: { 'If-None-Match': 'W/"nope"' } });
    assert.equal(stale.status, 200);
    const head = await h.request('HEAD', '/js/app.js');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-length'], String(first.text.length));
  });

  it('falls back to index.html for extension-less paths that match no file', async () => {
    for (const path of ['/entry/abc-123', '/history', '/settings', '/login', '/css', '/js/', '/a/b/c/d', '/entry/abc?reply=1']) {
      const res = await h.get(path);
      assert.equal(res.status, 200, path);
      assert.match(res.text, /<div id="app">/, path);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', path);
    }
  });

  it('answers a missing file (with an extension) with a JSON 404, not the app shell', async () => {
    for (const path of ['/js/missing.js', '/nope.css', '/img/x.png', '/favicon.ico', '/entry/1.html']) {
      const res = await h.get(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.json.error.code, 'not_found', path);
    }
  });

  it('hides dot files', async () => {
    assert.equal((await h.get('/.secret')).status, 404);
    assert.equal((await h.get('/js/.hidden')).status, 404);
  });

  it('does not follow symlinks that leave public/', async () => {
    for (const path of ['/leak.txt', '/leakdir/secret.txt', '/leakdir']) {
      const res = await h.get(path);
      assert.doesNotMatch(res.text, /TOP SECRET/, path);
      assert.ok(res.status === 404 || (res.status === 200 && /<div id="app">/.test(res.text)), `${path} -> ${res.status}`);
    }
    assert.equal((await h.get('/leak.txt')).status, 404);
    assert.equal((await h.get('/leakdir/secret.txt')).status, 404);
    // a symlink that stays inside is fine
    const inside = await h.get('/inside-link.js');
    assert.equal(inside.status, 200);
    assert.equal(inside.text, 'export const x = 1;\n');
  });

  it('answers 404 JSON when the public folder does not exist at all', async () => {
    const other = await startApp({ ai: false, config: { publicDir: join(tmpdir(), 'myjournal-no-such-folder-xyz') } });
    try {
      for (const path of ['/', '/history', '/js/app.js']) {
        const res = await other.get(path);
        assert.equal(res.status, 404, path);
        assert.equal(res.json.error.code, 'not_found');
      }
      assert.equal((await other.get('/api/health')).status, 200);
    } finally {
      await other.close();
    }
  });

  it('answers 404 JSON when the app files are missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'myjournal-empty-'));
    const other = await startApp({ ai: false, config: { publicDir: empty } });
    try {
      const res = await other.get('/');
      assert.equal(res.status, 404);
      assert.equal(res.json.error.code, 'not_found');
    } finally {
      await other.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('the real public/ folder', () => {
  let h;
  before(async () => { h = await startApp({ ai: false }); });
  after(() => h.close());

  it('serves the app shell, its scripts and styles', async () => {
    const index = await h.get('/');
    assert.equal(index.status, 200);
    assert.match(index.text, /<script type="module" src="\/js\/app\.js">/);
    for (const path of ['/js/app.js', '/js/lib/api.js', '/js/lib/dom.js', '/css/base.css', '/favicon.svg', '/js/views/today.js']) {
      const res = await h.get(path);
      assert.equal(res.status, 200, path);
    }
    assert.equal((await h.get('/entry/some-id')).status, 200);
  });
});
