// The "Cannot reach MyJournal" state machine (public/js/components/connection.js) with a fake clock and a fake probe,
// plus the small helpers added alongside it (inline code spans in server hints, viewport-relative text box heights).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_DELAYS, createConnectionMonitor, probeDelay, probeHealth } from '../../public/js/components/connection.js';
import { splitCode, stripCode, viewportShare } from '../../public/js/lib/ui.js';
import { isImportFailure } from '../../public/js/lib/router.js';

/** Fake timers: nothing fires until the test advances time. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    get pending() { return timers.size; },
    /** Advance time, running due timers in order (and any they schedule). */
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      }
      now = end;
    },
  };
}

function setup({ answers }) {
  const clock = fakeClock();
  const states = [];
  let recovered = 0;
  let probes = 0;
  const monitor = createConnectionMonitor({
    probe: async () => { probes += 1; return answers.length ? answers.shift() : true; },
    onChange: (s) => states.push(`${s.status}${s.status === 'offline' ? `#${s.attempt}` : ''}`),
    onRecovered: () => { recovered += 1; },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
  });
  return { clock, states, monitor, get recovered() { return recovered; }, get probes() { return probes; } };
}
const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

describe('connection monitor', () => {
  test('a failed request that the health check disproves never shows a banner', async () => {
    const t = setup({ answers: [true] });
    t.monitor.suspect();
    await settle();
    assert.deepEqual(t.states, ['online']);
    assert.equal(t.recovered, 0);
    assert.equal(t.clock.pending, 0);
  });

  test('a confirmed outage shows the banner, re-checks with growing pauses and reports recovery once', async () => {
    const t = setup({ answers: [false, false, false, true] });
    t.monitor.suspect();
    await settle();
    assert.deepEqual(t.states, ['offline#0']);
    assert.equal(t.monitor.state().nextCheckAt, PROBE_DELAYS[0]);
    await t.clock.tick(PROBE_DELAYS[0]);
    assert.equal(t.monitor.state().attempt, 1);
    await t.clock.tick(PROBE_DELAYS[1]);
    assert.equal(t.monitor.state().attempt, 2);
    assert.equal(t.recovered, 0);
    await t.clock.tick(PROBE_DELAYS[2]);
    assert.equal(t.monitor.state().status, 'online');
    assert.equal(t.recovered, 1);
    assert.equal(t.clock.pending, 0, 'no timer is left running once the server is back');
    assert.equal(t.states.at(-1), 'online');
    assert.ok(t.states.includes('checking'));
  });

  test('more failed requests while the server is away do not start more checks', async () => {
    const t = setup({ answers: [false] });
    t.monitor.suspect();
    await settle();
    t.monitor.suspect();
    t.monitor.suspect();
    await settle();
    assert.equal(t.probes, 1);
    assert.equal(t.clock.pending, 1);
  });

  test('"Try now" checks immediately and keeps the schedule if the server is still away', async () => {
    const t = setup({ answers: [false, false, true] });
    t.monitor.suspect();
    await settle();
    t.monitor.checkNow();
    await settle();
    assert.equal(t.probes, 2);
    assert.equal(t.monitor.state().status, 'offline');
    assert.equal(t.clock.pending, 1, 'exactly one pending re-check');
    t.monitor.checkNow();
    await settle();
    assert.equal(t.monitor.state().status, 'online');
    assert.equal(t.recovered, 1);
  });

  test('a successful request is enough to clear the banner', async () => {
    const t = setup({ answers: [false] });
    t.monitor.suspect();
    await settle();
    t.monitor.reachable();
    assert.equal(t.monitor.state().status, 'online');
    assert.equal(t.recovered, 1);
    assert.equal(t.clock.pending, 0);
  });

  test('a probe that was already running cannot bring the banner back after the server answered', async () => {
    const clock = fakeClock();
    let release;
    const monitor = createConnectionMonitor({
      probe: () => new Promise((resolve) => { release = resolve; }),
      onChange: () => {},
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
    });
    monitor.suspect();
    monitor.reachable(); // still online: no effect
    release(false);
    await settle();
    assert.equal(monitor.state().status, 'offline');
    monitor.checkNow();
    monitor.reachable(); // a request succeeded while that check was running
    release(false); // the slow check reports failure afterwards: it is stale
    await settle();
    assert.equal(monitor.state().status, 'online');
  });

  test('a probe that throws counts as a failure; destroy stops everything', async () => {
    const clock = fakeClock();
    const states = [];
    const monitor = createConnectionMonitor({ probe: async () => { throw new Error('boom'); }, onChange: (s) => states.push(s.status), setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    monitor.suspect();
    await settle();
    assert.equal(monitor.state().status, 'offline');
    monitor.destroy();
    assert.equal(clock.pending, 0);
    await clock.tick(60_000);
    assert.equal(states.filter((s) => s === 'checking').length, 0);
  });

  test('pauses grow and then stay at the last value', () => {
    assert.equal(probeDelay(0), PROBE_DELAYS[0]);
    assert.ok(probeDelay(3) > probeDelay(1));
    assert.equal(probeDelay(99), PROBE_DELAYS.at(-1));
    assert.equal(probeDelay(-5), PROBE_DELAYS[0]);
  });

  test('probeHealth: any answer below 500 means the server is there', async () => {
    assert.equal(await probeHealth(async () => ({ status: 200 })), true);
    assert.equal(await probeHealth(async () => ({ status: 401 })), true);
    assert.equal(await probeHealth(async () => ({ status: 502 })), false);
    assert.equal(await probeHealth(async () => { throw new TypeError('Failed to fetch'); }), false);
  });
});

describe('inline code in server hints', () => {
  test('backtick spans become code parts, the rest stays text', () => {
    assert.deepEqual(splitCode('Start it with `ollama serve` (or llama-server), then retry.'), [
      { text: 'Start it with ' }, { text: 'ollama serve', code: true }, { text: ' (or llama-server), then retry.' },
    ]);
    assert.deepEqual(splitCode('no code'), [{ text: 'no code' }]);
    assert.deepEqual(splitCode(''), []);
    assert.deepEqual(splitCode(null), []);
    assert.deepEqual(splitCode('a `b` `c`'), [{ text: 'a ' }, { text: 'b', code: true }, { text: ' ' }, { text: 'c', code: true }]);
  });
  test('an unbalanced or multi-line backtick is left alone', () => {
    assert.deepEqual(splitCode('it`s fine'), [{ text: 'it`s fine' }]);
    assert.deepEqual(splitCode('`a\nb`'), [{ text: '`a\nb`' }]);
  });
  test('stripCode drops the markers for plain-text places', () => {
    assert.equal(stripCode('Run `ollama pull x` first'), 'Run ollama pull x first');
    assert.equal(stripCode(undefined), '');
  });
});

describe('viewportShare and import failures', () => {
  test('viewportShare follows the window height, less in a short window, within bounds', () => {
    const original = globalThis.window;
    try {
      const at = (h) => { globalThis.window = { innerHeight: h }; return viewportShare(0.4, { min: 96, max: 340, shortShare: 0.3 })(); };
      assert.equal(at(1000), 340);
      assert.equal(at(800), 320);
      assert.equal(at(520), 156); // short window (a phone with the keyboard open)
      assert.equal(at(300), 96);
    } finally {
      globalThis.window = original;
    }
  });
  test('only network-style module failures count as the server being away', () => {
    assert.equal(isImportFailure(new TypeError('Failed to fetch dynamically imported module: http://x/js/views/a.js')), true);
    assert.equal(isImportFailure(new TypeError('Importing a module script failed.')), true);
    assert.equal(isImportFailure(new TypeError('x is not a function')), false);
    assert.equal(isImportFailure(new SyntaxError('Unexpected token')), false);
    assert.equal(isImportFailure(null), false);
  });
});
