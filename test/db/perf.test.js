import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.js';
import { rng, scratchDir } from './helpers.js';

// Sanity bounds, deliberately 10-50x looser than a normal laptop so slow CI boxes do not flake.
// The point is to catch accidental O(n^2) behaviour (e.g. a full FTS scan per message), not to benchmark.
const WORDS = 'morning coffee quiet river anxious work deadline sister Maya garden walk tired grateful music rain sunrise project friend dinner sleep ocean forest book plan idea weekend stress calm lonely happy'.split(' ');

function sentence(rand, n) {
  return Array.from({ length: n }, () => rand.pick(WORDS)).join(' ');
}

test('performance: 2000 entries x 6 messages insert, list, paginate and search stay fast (file database)', () => {
  const t = scratchDir('perf');
  try {
    const db = openDb({ file: t.file });
    const rand = rng(99);
    const timings = {};
    const time = (label, fn) => {
      const start = performance.now();
      const result = fn();
      timings[label] = Math.round(performance.now() - start);
      return result;
    };

    time('insert', () =>
      db.tx(() => {
        for (let i = 0; i < 2000; i++) {
          const e = db.entries.create({ title: sentence(rand, 3), tags: [rand.pick(WORDS)], date: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, mood: 1 + (i % 5) });
          for (let m = 0; m < 6; m++) {
            db.messages.add(e.id, { role: m % 2 === 0 ? 'user' : 'assistant', content: sentence(rand, 30 + (m % 3) * 10) });
          }
        }
      }),
    );
    assert.equal(db.stats().entries, 2000);
    assert.equal(db.stats().messages, 12_000);
    assert.ok(timings.insert < 60_000, `insert took ${timings.insert} ms`);

    const first = time('list', () => db.entries.list({ limit: 30 }));
    assert.equal(first.length, 30);
    assert.ok(first.every((e) => e.messageCount === 6 && e.preview.length > 0));
    assert.ok(timings.list < 2000, `list took ${timings.list} ms`);

    time('paginate', () => {
      let before;
      let total = 0;
      for (let guard = 0; guard < 100; guard++) {
        const page = db.entries.page({ limit: 50, before });
        total += page.entries.length;
        if (page.nextBefore === null) break;
        before = page.nextBefore;
      }
      assert.equal(total, 2000);
    });
    assert.ok(timings.paginate < 10_000, `pagination took ${timings.paginate} ms`);

    time('filters', () => {
      assert.ok(db.entries.list({ mood: 3, limit: 200 }).length === 200);
      assert.ok(db.entries.list({ tag: 'river', limit: 200 }).length > 0);
      assert.ok(db.entries.list({ from: '2026-03-01', to: '2026-03-31', limit: 200 }).length > 0);
    });
    assert.ok(timings.filters < 3000, `filters took ${timings.filters} ms`);

    time('search', () => {
      for (const q of ['river', 'quiet morning', 'anxio deadl', 'maya sister garden', 'zzzzzz']) {
        const hits = db.search(q, { limit: 20, includePrivate: true });
        assert.ok(hits.length <= 20);
        if (q !== 'zzzzzz') assert.ok(hits.length > 0, q);
      }
      assert.equal(db.search('river quiet anxious', { mode: 'any', limit: 10 }).length, 10);
    });
    assert.ok(timings.search < 5000, `search took ${timings.search} ms`);

    time('insights', () => {
      assert.equal(db.entries.rowsForInsights({ includePrivate: true }).length, 2000);
    });
    assert.ok(timings.insights < 3000, `rowsForInsights took ${timings.insights} ms`);

    // appending to one entry must not depend on the size of the whole index
    const target = first[0];
    time('append', () => {
      for (let i = 0; i < 200; i++) db.messages.add(target.id, { role: i % 2 ? 'assistant' : 'user', content: sentence(rand, 20) });
    });
    assert.ok(timings.append < 10_000, `200 appends took ${timings.append} ms`);

    const report = time('consistency', () => db.search.checkConsistency());
    assert.deepEqual(report.problems, []);
    assert.ok(timings.consistency < 15_000, `consistency check took ${timings.consistency} ms`);

    const dump = time('export', () => db.exportAll());
    assert.equal(dump.entries.length, 2000);
    assert.ok(timings.export < 15_000, `export took ${timings.export} ms`);
    const copy = openDb({ file: ':memory:' });
    time('import', () => copy.importAll(JSON.parse(JSON.stringify(dump))));
    assert.equal(copy.stats().entries, 2000);
    assert.equal(copy.stats().messages, 12_200);
    assert.ok(timings.import < 60_000, `import took ${timings.import} ms`);
    assert.deepEqual(copy.search.checkConsistency().problems, []);
    copy.close();

    time('reindexAll', () => db.search.reindexAll());
    assert.ok(timings.reindexAll < 30_000, `reindexAll took ${timings.reindexAll} ms`);
    db.close();
    console.log('# perf timings (ms):', JSON.stringify(timings));
  } finally {
    t.cleanup();
  }
});
