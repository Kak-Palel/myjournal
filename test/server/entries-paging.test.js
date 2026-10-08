import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startApp } from './helpers.js';

// Regression: History pages by the numeric `nextBefore` only. When many entries share one createdAt (an import
// from a tool that stamps everything alike) the database layer widens a page by at most 500 rows; the rest of the
// group was skipped by `created_at < nextBefore` and could never be scrolled to.
describe('GET /api/entries paging through entries that share a createdAt', () => {
  const TIE = 1_700_000_000_000;
  const TIED = 1300; // more than twice the database layer's tie extension
  let s;
  let expected; // every id, in the order the API must list them
  let expectedFrom2026; // the same for ?from=2026-01-01 (half of the tie group is dated a day earlier)
  before(async () => {
    s = await startApp({ ai: false });
    const make = (createdAt, n, date = '2026-01-01') => s.db.entries.create({ date, title: `entry ${n}`, createdAt });
    const newer = [3, 2, 1].map((i) => make(TIE + i * 1000, `newer-${i}`));
    const tied = Array.from({ length: TIED }, (_, i) => make(TIE, `tied-${i}`, i % 2 === 0 ? '2026-01-01' : '2025-12-31'));
    const older = [1, 2, 3, 4].map((i) => make(TIE - i * 1000, `older-${i}`));
    const tiedOrder = [...tied].sort((a, b) => (a.id < b.id ? 1 : -1)); // created_at DESC, id DESC
    const all = [...newer, ...tiedOrder, ...older];
    expected = all.map((e) => e.id);
    expectedFrom2026 = all.filter((e) => e.date === '2026-01-01').map((e) => e.id);
  });
  after(() => s.close());

  async function walk(limit, extra = '') {
    const seen = [];
    const pages = [];
    let before = null;
    for (let guard = 0; guard < 200; guard += 1) {
      const res = await s.get(`/api/entries?limit=${limit}${extra}${before === null ? '' : `&before=${before}`}`);
      assert.equal(res.status, 200);
      pages.push(res.json.entries.length);
      seen.push(...res.json.entries.map((e) => e.id));
      if (res.json.nextBefore === null) return { seen, pages };
      assert.equal(typeof res.json.nextBefore, 'number');
      before = res.json.nextBefore;
    }
    throw new Error('paging did not end');
  }

  it('reaches every entry with the numeric cursor alone', async () => {
    const { seen } = await walk(30);
    assert.equal(seen.length, expected.length, 'no entry is skipped');
    assert.equal(new Set(seen).size, seen.length, 'no entry is repeated');
    assert.deepEqual(seen, expected);
  });

  it('keeps pages that end between two timestamps at the size that was asked for', async () => {
    const two = await s.get('/api/entries?limit=2');
    assert.equal(two.json.entries.length, 2);
    assert.equal(two.json.nextBefore, TIE + 2000);
    const three = await s.get('/api/entries?limit=3'); // ends on the last row before the tie group
    assert.equal(three.json.entries.length, 3);
    assert.equal(three.json.nextBefore, TIE + 1000);
    const rest = await s.get(`/api/entries?limit=3&before=${three.json.nextBefore}`);
    assert.equal(rest.json.entries.length, TIED, 'the tie group arrives whole');
    assert.equal(rest.json.nextBefore, TIE);
    assert.deepEqual(rest.json.entries.map((e) => e.id), expected.slice(3, 3 + TIED));
    const older = await s.get(`/api/entries?limit=3&before=${rest.json.nextBefore}`);
    assert.deepEqual(older.json.entries.map((e) => e.id), expected.slice(3 + TIED, 3 + TIED + 3));
    assert.equal(older.json.nextBefore, TIE - 3000);
  });

  it('widens only the page that ends inside the group', async () => {
    const { pages } = await walk(30);
    assert.deepEqual(pages, [3 + TIED, 4]);
  });

  it('applies the filters to the rest of the group too', async () => {
    const { seen } = await walk(30, '&from=2026-01-01');
    assert.equal(seen.length, expectedFrom2026.length);
    assert.deepEqual(seen, expectedFrom2026);
    const { seen: other } = await walk(200, '&to=2025-12-31');
    assert.equal(other.length, TIED / 2, 'only the entries dated a day earlier');
  });

  it('ends cleanly after the last entry', async () => {
    const last = await s.get(`/api/entries?limit=5&before=${TIE - 3000}`);
    assert.equal(last.json.entries.length, 1);
    assert.equal(last.json.nextBefore, null, 'nothing follows the oldest entry');
  });
});
