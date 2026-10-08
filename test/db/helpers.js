// Shared helpers for the DB tests (not a test file itself).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/db/index.js';

const SCRATCH = new URL('../../.scratch/db/', import.meta.url).pathname;

/** A clock that advances by `step` ms on every call, so ordering is deterministic. */
export function fakeClock(start = 1_760_000_000_000, step = 1) {
  let t = start - step;
  const clock = () => (t += step);
  clock.set = (value) => {
    t = value - step;
  };
  return clock;
}

/** In-memory database with a deterministic clock. Close it with db.close() (tests use `after`). */
export function memDb(options = {}) {
  return openDb({ file: ':memory:', now: fakeClock(), ...options });
}

/** Fresh directory under .scratch/db (gitignored). Returns { dir, file, cleanup }. */
export function scratchDir(name = 'case') {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, `${name}-`));
  return {
    dir,
    file: join(dir, 'data', 'journal.db'),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Create an entry with the given user texts (alternating with assistant echoes if `withAssistant`). */
export function entryWith(db, texts, fields = {}, { withAssistant = false } = {}) {
  const entry = db.entries.create(fields);
  for (const text of texts) {
    db.messages.add(entry.id, { role: 'user', content: text });
    if (withAssistant) db.messages.add(entry.id, { role: 'assistant', content: `Tell me more about: ${text.slice(0, 20)}` });
  }
  return db.entries.get(entry.id);
}

/** Deterministic pseudo random numbers (mulberry32), so fuzz failures are reproducible. */
export function rng(seed = 1234) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (list) => list[Math.floor(next() * list.length)];
  return next;
}
