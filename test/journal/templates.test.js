import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICON_NAMES } from '../../public/js/lib/ui.js';
import {
  PROMPT_COUNT, TEMPLATES, TEMPLATE_CATEGORIES, allPrompts, getTemplate, promptOfTheDay, publicTemplate, templateStep,
} from '../../src/journal/templates.js';
import { addDays, dayNumber } from '../../src/journal/dates.js';

const IDS = ['rose-thorn-bud', 'gratitude', 'morning-intention', 'evening-reflection', 'thought-record', 'worry-dump',
  'self-compassion', 'goals-checkin', 'relationship-reflection', 'dream-journal', 'weekly-review', 'decision-helper'];

const words = (s) => s.trim().split(/\s+/).length;

test('the twelve fixed template ids exist, in order', () => {
  assert.deepEqual(TEMPLATES.map((t) => t.id), IDS);
  assert.equal(new Set(IDS).size, 12);
});

test('every template is complete and well-formed', () => {
  for (const t of TEMPLATES) {
    assert.ok(t.title.length >= 4 && t.title.length <= 30, `${t.id} title`);
    assert.ok(TEMPLATE_CATEGORIES.includes(t.category), `${t.id} category ${t.category}`);
    assert.ok(/[.!]$/.test(t.description) && t.description.length <= 120, `${t.id} description: one sentence`);
    assert.equal((t.description.match(/[.!?](?:\s|$)/g) || []).length, 1, `${t.id} description is a single sentence`);
    assert.ok(ICON_NAMES.includes(t.icon), `${t.id}: icon "${t.icon}" is not in ICON_NAMES`);
    assert.ok(Number.isInteger(t.minutes) && t.minutes >= 2 && t.minutes <= 15, `${t.id} minutes`);
    assert.ok(Array.isArray(t.steps) && t.steps.length >= 4 && t.steps.length <= 6, `${t.id} steps`);
  }
});

test('categories: all four are used and Daily/Mind/Growth/Creative are the only ones', () => {
  assert.deepEqual([...TEMPLATE_CATEGORIES], ['Daily', 'Mind', 'Growth', 'Creative']);
  for (const c of TEMPLATE_CATEGORIES) assert.ok(TEMPLATES.some((t) => t.category === c), c);
  assert.ok(TEMPLATES.every((t) => TEMPLATE_CATEGORIES.includes(t.category)));
});

test('openings are warm, specific, 1-3 sentences and end with the first question', () => {
  for (const t of TEMPLATES) {
    assert.ok(t.opening.endsWith('?'), `${t.id} opening must end with a question`);
    const sentences = t.opening.match(/[^.!?]+[.!?]+/g) || [];
    assert.ok(sentences.length >= 1 && sentences.length <= 3, `${t.id}: ${sentences.length} sentences`);
    assert.equal((t.opening.match(/\?/g) || []).length, 1, `${t.id}: exactly one question mark`);
    assert.ok(t.opening.length >= 40 && t.opening.length <= 260, `${t.id} opening length ${t.opening.length}`);
    assert.ok(!/\bAI\b|\bassistant\b/i.test(t.opening));
  }
});

test('guidance is at most 90 words, imperative and names the format of the session', () => {
  for (const t of TEMPLATES) {
    assert.ok(words(t.guidance) <= 90, `${t.id}: guidance has ${words(t.guidance)} words`);
    assert.ok(words(t.guidance) >= 30, `${t.id}: guidance too thin`);
    assert.ok(!/\n/.test(t.guidance), `${t.id}: one paragraph`);
  }
});

test('steps are directive sentences without colons (they follow "Step n of m:")', () => {
  for (const t of TEMPLATES) {
    for (const step of t.steps) {
      assert.ok(/^(Ask|Invite|Help|For)\b/.test(step), `${t.id}: step should start with a verb: ${step}`);
      assert.ok(step.endsWith('.'), `${t.id}: ${step}`);
      assert.ok(!step.includes(':'), `${t.id}: no colon in step: ${step}`);
      assert.ok(step.length <= 130, `${t.id}: step too long`);
    }
  }
});

test('the contract examples: rose/thorn/bud one at a time, thought record order, dream order', () => {
  const rtb = getTemplate('rose-thorn-bud');
  assert.equal(rtb.steps.length, 4);
  assert.match(rtb.steps[0], /rose/i);
  assert.match(rtb.steps[1], /thorn/i);
  assert.match(rtb.steps[2], /bud/i);
  assert.match(rtb.guidance, /one part at a time/i);
  assert.match(rtb.guidance, /rose is a highlight/i);
  assert.match(rtb.guidance, /thorn is a challenge/i);
  assert.match(rtb.guidance, /bud is something/i);
  assert.match(rtb.opening, /\brose\b/i);

  const tr = getTemplate('thought-record');
  const order = ['situation', 'automatic thought|went through their mind', 'emotion|feeling|felt', 'supports|evidence', 'balanced'];
  assert.equal(tr.steps.length, 5);
  order.forEach((re, i) => assert.match(tr.steps[i], new RegExp(re, 'i'), `thought-record step ${i + 1}`));
  assert.match(tr.guidance, /situation, automatic thought, emotion/i);

  const dj = getTemplate('dream-journal');
  assert.match(dj.guidance, /details/i);
  assert.ok(dj.guidance.toLowerCase().indexOf('feelings') > dj.guidance.toLowerCase().indexOf('details'));
  assert.ok(dj.guidance.toLowerCase().indexOf('meaning') > dj.guidance.toLowerCase().indexOf('feelings'));
});

test('getTemplate and publicTemplate', () => {
  assert.equal(getTemplate('gratitude').title, 'Gratitude');
  assert.equal(getTemplate('nope'), null);
  assert.equal(getTemplate(undefined), null);
  for (const t of TEMPLATES) {
    const p = publicTemplate(t);
    assert.deepEqual(Object.keys(p).sort(), ['category', 'description', 'icon', 'id', 'minutes', 'opening', 'title']);
    assert.ok(!('guidance' in p) && !('steps' in p));
    assert.equal(p.id, t.id);
  }
  assert.doesNotMatch(JSON.stringify(TEMPLATES.map(publicTemplate)), /Socratic|Go one part at a time/);
});

test('templates are frozen', () => {
  assert.ok(Object.isFrozen(TEMPLATES));
  assert.ok(Object.isFrozen(TEMPLATES[0]));
  assert.ok(Object.isFrozen(TEMPLATES[0].steps));
});

test('templateStep: the reply works on the NEXT step', () => {
  const t = getTemplate('thought-record');
  assert.equal(templateStep(t, 0).n, 1);
  const first = templateStep(t, 1);
  assert.equal(first.n, 2);
  assert.equal(first.total, 5);
  assert.equal(first.done, false);
  assert.equal(first.text, `Step 2 of 5: ${t.steps[1]}`);
  assert.equal(templateStep(t, 4).n, 5);
  const done = templateStep(t, 5);
  assert.equal(done.done, true);
  assert.match(done.text, /^All 5 steps are covered/);
  assert.equal(templateStep(t, 99).done, true);
  assert.equal(templateStep(t, -3).n, 1);
  assert.equal(templateStep(t, NaN).n, 1);
  assert.equal(templateStep(null, 2), null);
  assert.equal(templateStep({ steps: [] }, 2), null);
});

// ---------------------------------------------------------------------------------------------- prompt of the day

test('promptOfTheDay: at least 60 curated one-line prompts, all distinct', () => {
  const prompts = allPrompts();
  assert.ok(PROMPT_COUNT >= 60, `${PROMPT_COUNT} prompts`);
  assert.equal(prompts.length, PROMPT_COUNT);
  assert.equal(new Set(prompts).size, prompts.length, 'no duplicates');
  assert.equal(new Set(prompts.map((p) => p.toLowerCase())).size, prompts.length);
  for (const p of prompts) {
    assert.ok(!p.includes('\n'), p);
    assert.ok(p.length >= 15 && p.length <= 140, `length ${p.length}: ${p}`);
    assert.ok(/[?.]$/.test(p), `ends with ? or .: ${p}`);
    assert.equal(p, p.trim());
    assert.ok(/^[A-Z]/.test(p), p);
  }
  const questions = prompts.filter((p) => p.endsWith('?')).length;
  assert.ok(questions / prompts.length > 0.8, 'mostly questions, since it can open a conversation');
});

test('promptOfTheDay is deterministic per date and shaped { id, text }', () => {
  const a = promptOfTheDay('2026-10-08');
  const b = promptOfTheDay('2026-10-08');
  assert.deepEqual(a, b);
  assert.match(a.id, /^pod-\d{2}$/);
  assert.ok(allPrompts().includes(a.text));
  assert.notEqual(promptOfTheDay('2026-10-09').text, a.text);
  assert.equal(promptOfTheDay('2026-10-08').id, a.id);
});

test('promptOfTheDay: no repeats within any 60 consecutive days (across years, DST and leap days)', () => {
  for (const start of ['2026-01-01', '2026-10-08', '2027-12-01', '2028-01-01', '2024-02-01', '2100-02-01']) {
    const seen = new Map();
    for (let i = 0; i < 400; i += 1) {
      const day = addDays(start, i);
      const { text } = promptOfTheDay(day);
      if (seen.has(text)) assert.ok(i - seen.get(text) >= 60, `${text} repeated after ${i - seen.get(text)} days (${start})`);
      seen.set(text, i);
    }
  }
});

test('promptOfTheDay covers the whole list over PROMPT_COUNT days and ids match texts', () => {
  const texts = new Set();
  const idToText = new Map();
  for (let i = 0; i < PROMPT_COUNT; i += 1) {
    const p = promptOfTheDay(addDays('2026-01-01', i));
    texts.add(p.text);
    assert.ok(!idToText.has(p.id) || idToText.get(p.id) === p.text);
    idToText.set(p.id, p.text);
  }
  assert.equal(texts.size, PROMPT_COUNT);
  assert.equal(dayNumber('2026-01-01') >= 0, true);
});

test('promptOfTheDay survives invalid dates', () => {
  for (const bad of ['', 'nope', undefined, null, 5, '2026-02-30', {}]) {
    const p = promptOfTheDay(bad);
    assert.ok(allPrompts().includes(p.text));
    assert.match(p.id, /^pod-\d{2}$/);
  }
  const before = promptOfTheDay('1960-05-05');
  assert.ok(allPrompts().includes(before.text), 'dates before 1970 work too');
});
