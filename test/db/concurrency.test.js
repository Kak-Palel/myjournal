import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openDb } from '../../src/db/index.js';
import { scratchDir } from './helpers.js';

const WRITER = new URL('./fixtures/writer.mjs', import.meta.url).pathname;

function runWriter(file, entryId, count, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', WRITER, file, entryId, String(count), label], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('two processes appending to the same entry never collide: unique contiguous seq, no lock errors', async () => {
  const t = scratchDir('multiproc');
  try {
    const db = openDb({ file: t.file });
    const entry = db.entries.create({ title: 'Shared' });
    const child = runWriter(t.file, entry.id, 150, 'child');
    let parentFailures = 0;
    for (let i = 0; i < 150; i++) {
      try {
        db.messages.add(entry.id, { role: 'user', content: `parent message ${i}` });
      } catch (err) {
        parentFailures++;
        console.error(err);
      }
    }
    const { code, stderr } = await child;
    assert.equal(stderr, '');
    assert.equal(code, 0);
    assert.equal(parentFailures, 0);
    const messages = db.messages.list(entry.id);
    assert.equal(messages.length, 300);
    assert.deepEqual(messages.map((m) => m.seq), Array.from({ length: 300 }, (_, i) => i));
    assert.equal(messages.filter((m) => m.content.startsWith('child')).length, 150);
    assert.deepEqual(db.search.checkConsistency().problems, []);
    assert.equal(db.entries.get(entry.id).messageCount, 300);
    db.close();
  } finally {
    t.cleanup();
  }
});

test('interleaved writes from two connections in one process keep seq unique and the index consistent', () => {
  const t = scratchDir('twoconn2');
  try {
    const a = openDb({ file: t.file });
    const b = openDb({ file: t.file });
    const entry = a.entries.create({ title: 'Interleaved' });
    for (let i = 0; i < 40; i++) {
      (i % 2 ? a : b).messages.add(entry.id, { role: 'user', content: `word${i}` });
    }
    assert.deepEqual(a.messages.list(entry.id).map((m) => m.seq), Array.from({ length: 40 }, (_, i) => i));
    assert.equal(b.search('word39').length, 1);
    assert.deepEqual(a.search.checkConsistency().problems, []);
    a.close();
    b.close();
  } finally {
    t.cleanup();
  }
});

test('an open write transaction in another connection makes a writer wait, then fail with a clear error (not hang or corrupt)', () => {
  const t = scratchDir('busy');
  try {
    const a = openDb({ file: t.file });
    const b = openDb({ file: t.file });
    b.handle.exec('PRAGMA busy_timeout = 50');
    const entry = a.entries.create({ title: 'Locked' });
    a.handle.exec('BEGIN IMMEDIATE');
    assert.throws(() => b.messages.add(entry.id, { role: 'user', content: 'blocked' }), /locked|busy/i);
    a.handle.exec('COMMIT');
    b.messages.add(entry.id, { role: 'user', content: 'now it works' });
    assert.equal(a.messages.list(entry.id).length, 1);
    // the failed attempt must not leave b inside a half-open transaction
    b.messages.add(entry.id, { role: 'user', content: 'and again' });
    assert.equal(a.messages.list(entry.id).length, 2);
    a.close();
    b.close();
  } finally {
    t.cleanup();
  }
});
