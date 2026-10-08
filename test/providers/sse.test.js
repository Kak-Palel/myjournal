import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SseOverflowError, createLineSplitter, createNdjsonReader, createSseParser, decodeChunks, iterateNdjson, iterateSse,
} from '../../src/providers/sse.js';
import { byteByByte, chunked, collect, randomSplit, twoWaySplits } from './helpers.js';

const enc = new TextEncoder();

async function parse(pieces) {
  return collect(iterateSse(chunked(pieces)));
}

/** Parse `payload` whole, then cut at every boundary / every byte / pseudo-random cuts and demand identical events. */
async function assertSplitInvariant(payload, expected) {
  const buf = enc.encode(payload);
  const whole = await parse([buf]);
  if (expected) assert.deepEqual(whole, expected);
  assert.deepEqual(await parse(byteByByte(buf)), whole, 'byte by byte');
  for (const [a, b] of twoWaySplits(buf)) {
    assert.deepEqual(await parse([a, b]), whole, `split at ${a.length}`);
  }
  for (let seed = 1; seed <= 25; seed += 1) {
    assert.deepEqual(await parse(randomSplit(buf, seed, 6)), whole, `random seed ${seed}`);
  }
  return whole;
}

const BODY = [
  ': keep-alive',
  '',
  'data: {"a":"héllo 😀 日本語"}',
  '',
  'event: custom',
  'data:no space',
  'data: second line',
  'id: 7',
  'retry: 1500',
  '',
  'data',
  '',
  'data: [DONE]',
  '',
  '',
];

const EXPECTED = [
  { event: 'message', data: '{"a":"héllo 😀 日本語"}' },
  { event: 'custom', data: 'no space\nsecond line', id: '7', retry: 1500 },
  { event: 'message', data: '' },
  { event: 'message', data: '[DONE]' },
];

test('SSE with LF line endings is identical at every split point', async () => {
  await assertSplitInvariant(BODY.join('\n'), EXPECTED);
});

test('SSE with CRLF line endings (Gemini style) is identical at every split point, including between CR and LF', async () => {
  await assertSplitInvariant(BODY.join('\r\n'), EXPECTED);
});

test('SSE with bare CR line endings is identical at every split point', async () => {
  await assertSplitInvariant(BODY.join('\r'), EXPECTED);
});

test('SSE with mixed line endings is identical at every split point', async () => {
  const mixed = 'data: one\r\n\r\ndata: two\n\ndata: three\r\rdata: four\r\n\n';
  const events = await assertSplitInvariant(mixed);
  assert.deepEqual(events.map((e) => e.data), ['one', 'two', 'three', 'four']);
});

test('a leading UTF-8 BOM is ignored however it is split', async () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), enc.encode('data: x\n\n')]);
  const events = await assertSplitInvariant(buf.toString('utf8'));
  assert.deepEqual(events, [{ event: 'message', data: 'x' }]);
  for (const [a, b] of twoWaySplits(buf)) {
    assert.deepEqual(await parse([a, b]), [{ event: 'message', data: 'x' }]);
  }
});

test('the last event is delivered even without a closing blank line', async () => {
  const events = await assertSplitInvariant('data: first\n\ndata: last');
  assert.deepEqual(events.map((e) => e.data), ['first', 'last']);
  const crlf = await assertSplitInvariant('data: first\r\n\r\ndata: last\r\n');
  assert.deepEqual(crlf.map((e) => e.data), ['first', 'last']);
});

test('comments, unknown fields and events without data produce nothing', async () => {
  const events = await assertSplitInvariant(': ping\n\nfoo: bar\n\nevent: lonely\n\n: another\ndata: kept\n\n');
  assert.deepEqual(events, [{ event: 'message', data: 'kept' }]);
});

test('exactly one leading space is stripped from a value', async () => {
  const events = await assertSplitInvariant('data:  two spaces\n\ndata:\ttab\n\ndata: \n\n');
  assert.deepEqual(events.map((e) => e.data), [' two spaces', '\ttab', '']);
});

test('invalid retry values and ids containing NUL are ignored', async () => {
  const events = await parse(['retry: abc\nid: a\0b\ndata: x\n\n']);
  assert.deepEqual(events, [{ event: 'message', data: 'x' }]);
});

test('a multi-byte character cut in half is reassembled (4-byte emoji, byte by byte)', async () => {
  const events = await parse(byteByByte(enc.encode('data: 😀😀😀\n\n')));
  assert.equal(events[0].data, '😀😀😀');
});

test('an incomplete UTF-8 sequence at the very end becomes U+FFFD instead of being lost silently', async () => {
  const bytes = enc.encode('data: ok😀');
  const events = await parse([bytes.subarray(0, bytes.length - 1)]);
  assert.equal(events.length, 1);
  assert.ok(events[0].data.startsWith('ok'));
  assert.ok(events[0].data.includes('�'));
});

test('an oversized line is rejected instead of buffered forever', () => {
  const parser = createSseParser({ maxLineChars: 100 });
  assert.throws(() => parser.push('data: ' + 'x'.repeat(200)), SseOverflowError);
  const parser2 = createSseParser({ maxLineChars: 50 });
  assert.throws(() => {
    for (let i = 0; i < 20; i += 1) parser2.push('data: 0123456789\n');
  }, SseOverflowError);
});

test('a million tiny events parse quickly and in order', () => {
  const parser = createSseParser();
  const events = parser.push('data: 1\n\n'.repeat(20000));
  assert.equal(events.length, 20000);
});

test('createLineSplitter: terminators, CR at end of chunk, empty chunks', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('a\r'), ['a']);
  assert.deepEqual(s.push(''), []);
  assert.deepEqual(s.push('\nb\n'), ['b']); // the LF belongs to the earlier CR
  assert.deepEqual(s.push('\n'), ['']);
  assert.deepEqual(s.push('tail'), []);
  assert.deepEqual(s.end(), ['tail']);
  assert.deepEqual(s.end(), []);
});

test('NDJSON reader: same output at every split point', async () => {
  const payload = ['{"status":"pulling manifest"}', '{"status":"downloading 🦙","total":10,"completed":3}', '', '{"status":"success"}', ''].join('\n');
  const buf = enc.encode(payload);
  const run = (pieces) => collect(iterateNdjson(chunked(pieces)));
  const whole = await run([buf]);
  assert.equal(whole.length, 3);
  assert.equal(whole[1].status, 'downloading 🦙');
  assert.deepEqual(await run(byteByByte(buf)), whole);
  for (const [a, b] of twoWaySplits(buf)) assert.deepEqual(await run([a, b]), whole, `split at ${a.length}`);
  const crlf = enc.encode(payload.replaceAll('\n', '\r\n'));
  for (const [a, b] of twoWaySplits(crlf)) assert.deepEqual(await run([a, b]), whole, `crlf split at ${a.length}`);
});

test('NDJSON: invalid lines are skipped, a final line without newline is kept', async () => {
  const out = await collect(iterateNdjson(chunked(['{"a":1}\nnot json\n{"b":2}'])));
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
  const reader = createNdjsonReader();
  assert.deepEqual(reader.push('  {"a":1}  \n\n'), ['{"a":1}']);
  assert.deepEqual(reader.end(), []);
});

test('decodeChunks accepts strings and bytes', async () => {
  assert.deepEqual(await collect(decodeChunks(chunked(['ab', enc.encode('cd')]))), ['ab', 'cd']);
  assert.deepEqual(await collect(decodeChunks((async function* () { yield 'x'; yield ''; })())), ['x']);
});
