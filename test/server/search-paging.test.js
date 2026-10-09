// GET /api/entries?q=...&offset=...: a search with more matches than one page continues by position. It used to answer one page of
// at most 30 hits with nextBefore: null, so the person saw "30 results" and had no way to see the rest.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withApp } from './helpers.js';

describe('GET /api/entries?q= pages through the matches', () => {
  it('70 matches come in pages of 30 with nextOffset until the end, with no repeats', async () => {
    await withApp({ ai: false }, async (h) => {
      for (let i = 0; i < 70; i += 1) await h.entry({ title: `Day ${i}`, content: `a day at work number ${i}` });
      await h.entry({ title: 'Other', content: 'nothing to see' });

      const seen = [];
      let offset = 0;
      const pages = [];
      for (let guard = 0; guard < 10; guard += 1) {
        const res = await h.get(`/api/entries?q=work&limit=30${offset ? `&offset=${offset}` : ''}`);
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.nextBefore, null, 'a search never answers with a createdAt cursor');
        pages.push(res.json.entries.length);
        seen.push(...res.json.entries.map((e) => e.id));
        assert.ok(res.json.entries.every((e) => typeof e.snippet === 'string' && e.snippet.length > 0));
        if (res.json.nextOffset === null) break;
        assert.equal(res.json.nextOffset, offset + 30);
        offset = res.json.nextOffset;
      }
      assert.deepEqual(pages, [30, 30, 10]);
      assert.equal(new Set(seen).size, 70, 'every match once');
      const inOnePage = await h.get('/api/entries?q=work&limit=200'); // the search page is capped at 50
      assert.equal(inOnePage.json.entries.length, 50);
      assert.equal(inOnePage.json.nextOffset, 50);
      const exact = await h.get('/api/entries?q=work&limit=50&offset=20');
      assert.equal(exact.json.entries.length, 50);
      assert.equal(exact.json.nextOffset, null, 'the last 50 of 70 end the list (no further hit exists)');
    });
  });

  it('a list without a search has no nextOffset; bad offsets are a 400; the depth is bounded', async () => {
    await withApp({ ai: false }, async (h) => {
      await h.entry({ content: 'one word: work' });
      const plain = await h.get('/api/entries');
      assert.equal(plain.json.nextOffset, undefined);
      assert.equal((await h.get('/api/entries?q=work&offset=abc')).status, 400);
      assert.equal((await h.get('/api/entries?q=work&offset=-1')).status, 400);
      const far = await h.get('/api/entries?q=work&offset=999999999');
      assert.equal(far.status, 200);
      assert.deepEqual(far.json, { entries: [], nextBefore: null, nextOffset: null });
      assert.equal((await h.get('/api/entries?offset=30')).status, 200, 'offset without q is ignored');
    });
  });
});
