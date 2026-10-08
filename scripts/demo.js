#!/usr/bin/env node
// Try the whole app without any key:  npm run demo
//
// Starts pretend model servers (an Ollama/OpenAI-compatible one and a Gemini one, from test/mocks), then the real
// MyJournal on a free port with a TEMPORARY data folder that already holds a few weeks of sample entries,
// memories and a weekly reflection. The local model is selected, so Send, Wrap up and Weekly reflection work
// right away. Everything is deleted again on Ctrl+C.
//
//   --port N      listen on this port instead of a free one
//   --delay MS    pause between streamed chunks of the pretend models (default 25)
//   --verbose     print one line per request

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { getTemplate } from '../src/journal/templates.js';
import { createApp } from '../src/server/app.js';
import { ignoreStdioErrors } from '../src/server/logger.js';
import { mergeSettings } from '../src/settings.js';
import { LIVE_MODELS, createMockGemini } from '../test/mocks/mock-gemini.js';
import { createMockOpenAI } from '../test/mocks/mock-openai.js';

const MOCK_KEY = 'mock-key';
const LOCAL_MODEL = 'llama3.2:3b';
const REPLY_META = Object.freeze({ kind: 'reply', provider: 'local', model: LOCAL_MODEL });

const pad = (n) => String(n).padStart(2, '0');
const dateOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local time `daysAgo` days before `now`, at hh:mm. */
function moment(now, daysAgo, hour, minute = 0) {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// Sample journal: oldest last. Each turn is [person's text, companion's reply or null].
const SAMPLE_ENTRIES = [
  {
    ago: 1, hour: 21, mood: 4, title: 'A slow day with Miso', emotions: ['calm', 'content'], tags: ['home', 'rest'],
    summary: 'A day with nothing planned: pancakes, a finished book and a cat asleep on the keyboard.',
    turns: [
      ['Finally a day with nothing planned. I slept in, made pancakes, and Miso sat on my keyboard for most of the afternoon. I finished the book I have been reading for weeks and just lay on the sofa feeling lazy in the best way.',
        'That sounds like exactly the kind of day your week was asking for. What part of it felt the most restful to you?'],
      ['Probably the pancakes, honestly. Doing something slow with my hands before I looked at my phone at all.', null],
    ],
  },
  {
    ago: 2, hour: 19, mood: 3, title: 'Long run in the rain', emotions: ['proud', 'tired'], tags: ['running', 'health'],
    summary: 'A wet 14 km long run that was hard to start and felt great to finish.',
    turns: [
      ['Did the 14 km long run even though it rained the whole time. The first three kilometres were miserable, my shoes were soaked, and I almost turned back. Then something clicked and the last five felt easy. Legs are very heavy now.',
        'Pushing through the miserable start and finding that rhythm sounds like a real win. What helped you keep going when you wanted to turn back?'],
    ],
  },
  {
    ago: 3, hour: 22, mood: 5, title: 'Presentation day', emotions: ['proud', 'relieved'], tags: ['work', 'design'], pinned: true, wrapped: true,
    summary: 'Presented the app redesign to the whole studio; it went better than expected and the team was enthusiastic.',
    turns: [
      ['Presented the redesign to the whole studio today. I was so nervous this morning that I could not eat breakfast, but once I started talking it felt natural. Priya asked a great question about onboarding and I actually had an answer.',
        'It sounds like the preparation paid off and you found your footing quickly. What do you think made it feel natural once you started?'],
      ['I think I stopped trying to sound impressive and just explained what I would want if I were the user. Also Maya texted me good luck, which helped more than she knows.', null],
    ],
    wrapup: 'You carried a lot of nerves into today and still stood up and explained your work in your own words. The moment you stopped trying to impress and spoke as the user is worth remembering, and so is the text from Maya that steadied you. Be proud of this one, and let yourself rest tonight.',
  },
  {
    ago: 5, hour: 23, mood: 2, title: 'Sleepless before the deadline', emotions: ['anxious', 'tired'], tags: ['work', 'sleep'],
    summary: 'Could not sleep because of the redesign deadline; worried about the demo and the tight schedule.',
    turns: [
      ['It is almost midnight and I cannot switch my brain off. The deadline for the redesign is Thursday and there is still so much to polish. Every time I close my eyes I think of one more thing that could go wrong in the demo.',
        'That sounds like a heavy night, with your mind running through every what-if. Which one of those worries feels the loudest right now?'],
    ],
  },
  {
    ago: 6, hour: 8, mood: 3, title: 'Three good things', emotions: ['grateful'], tags: ['gratitude', 'morning'], template: 'gratitude',
    summary: 'Coffee on the balcony, a message from an old friend and a finished to-do list.',
    turns: [
      ['1. The first coffee on the balcony while the city was still quiet. 2. An old friend from university sent me a photo of us from ten years ago. 3. I actually finished my to-do list yesterday.',
        'What a lovely trio. Of the three, which one do you most want to carry with you through the rest of today?'],
    ],
  },
  {
    ago: 8, hour: 22, mood: 4, title: 'Dinner with Maya', emotions: ['happy', 'grateful'], tags: ['family', 'friends'],
    summary: 'A long dinner with younger sister Maya; talked about her new flat and old childhood stories.',
    turns: [
      ['Had dinner with my younger sister Maya. She showed me photos of her new flat and we ended up laughing for an hour about the time we got lost on the family road trip. I realised how rarely we just sit and talk without our phones.',
        'It sounds like that evening gave you both something you do not get often. What would you like to do to keep making room for time like that?'],
    ],
  },
  {
    ago: 9, hour: 20, mood: 2, title: 'Feeling behind', emotions: ['overwhelmed', 'restless'], tags: ['work', 'planning'],
    summary: 'Overwhelmed by a long task list and the feeling of always being a step behind.',
    turns: [
      ['Everything feels like it is piling up. Emails, the redesign, laundry, the half marathon training plan. I keep switching between tasks and finishing none of them. Ended the day more tired than I started it.',
        'Switching between everything without finishing anything is exhausting in its own way. If you could finish just one thing tomorrow, which would give you the most relief?'],
    ],
  },
  {
    ago: 11, hour: 11, mood: 3, title: 'Quiet Saturday market', emotions: ['calm'], tags: ['home', 'food'],
    summary: 'A slow morning at the farmers market and cooking a big pot of soup.',
    turns: [
      ['Went to the farmers market early and bought way too many tomatoes. Spent the afternoon making soup for the week. It is simple, but standing in the kitchen with the radio on is one of my favourite ways to reset.', null],
    ],
  },
  {
    ago: 13, hour: 21, mood: 2, title: 'Argument with Jonas', emotions: ['sad', 'frustrated'], tags: ['friends'],
    summary: 'A disagreement with a close friend about cancelled plans left both of them hurt.',
    turns: [
      ['Jonas cancelled our plans again at the last minute and I snapped at him on the phone. Now I feel guilty, but I also feel like I am always the one who adapts. I do not want to lose the friendship over this.',
        'You care about the friendship and also about being heard, and both can be true. What would you want Jonas to understand if the conversation could go perfectly?'],
      ['That I am not angry about one evening, I am tired of feeling like an option. Maybe I should just tell him that instead of snapping.', null],
    ],
  },
  {
    ago: 15, hour: 7, mood: 4, title: 'Starting the half-marathon plan', emotions: ['excited', 'motivated'], tags: ['running', 'goals'],
    summary: 'Signed up for a half marathon in spring and started a 12-week training plan.',
    turns: [
      ['I did it: I signed up for the spring half marathon. The 12-week plan starts today with an easy 5 km. I am nervous about the long runs, but it feels good to have something to work towards that is just mine.',
        'Choosing something that is just yours sounds meaningful. What do you hope this training will give you besides the finish line?'],
    ],
  },
  {
    ago: 17, hour: 23, mood: 3, title: 'Notes for myself', emotions: ['thoughtful'], tags: ['reflection'], private: true,
    summary: 'Private reflections on what matters this year.',
    turns: [
      ['Things I do not want to forget: I am happiest when I have a project that is mine, enough sleep, and one proper conversation a week. Everything else is noise on top of that.', null],
    ],
  },
  {
    ago: 20, hour: 20, mood: 5, title: 'First week at the new studio', emotions: ['excited', 'nervous'], tags: ['work', 'change'],
    summary: 'Finished the first week as a product designer at a small studio; the team is welcoming and the work is interesting.',
    turns: [
      ['First week at the new studio is done. I work as a product designer here and everyone has been so welcoming. I still get lost finding the kitchen, and I am nervous about my first big review, but I already feel like I belong more than I expected.',
        'A welcoming team makes such a difference to a first week. What would make that first review feel like a success to you?'],
    ],
  },
];

const SAMPLE_MEMORIES = [
  { text: 'Has a younger sister called Maya', pinned: true, entry: 'Dinner with Maya' },
  { text: 'Works as a product designer at a small studio', entry: 'First week at the new studio' },
  { text: 'Is training for a spring half marathon', entry: 'Starting the half-marathon plan' },
  { text: 'Lives with a cat called Miso', entry: 'A slow day with Miso' },
];

const SAMPLE_REPORT = [
  '**How the week felt.** A week of two halves: tense and busy in the middle, then warmer and calmer towards the end.',
  '**What stood out.** Your long run in the rain and the dinner with Maya both gave you energy, and you described the dinner as laughing for an hour.',
  '**A pattern.** The days you felt lowest were the ones where work tasks piled up without a clear first step.',
  '**For next week.** Try choosing one small thing each morning that would make the day feel finished, and let the rest wait.',
].join('\n\n');

/**
 * Fill an empty journal with ~12 realistic entries spread over the last three weeks.
 * @param {ReturnType<typeof openDb>} db
 * @param {Date} [now]
 * @returns {{ entries: number, messages: number, memories: number, reports: number }}
 */
export function seedSampleJournal(db, now = new Date()) {
  const byTitle = new Map();
  let messages = 0;
  db.tx(() => {
    for (const sample of SAMPLE_ENTRIES) {
      const template = sample.template ? getTemplate(sample.template) : null;
      const created = moment(now, sample.ago, sample.hour, 12);
      const entry = db.entries.create({
        createdAt: created.getTime(),
        date: dateOf(created),
        title: sample.title,
        mood: sample.mood,
        emotions: sample.emotions,
        tags: sample.tags,
        summary: sample.summary,
        status: sample.wrapped ? 'wrapped' : 'open',
        private: Boolean(sample.private),
        pinned: Boolean(sample.pinned),
        ...(template ? { templateId: template.id, kind: 'guided' } : {}),
      });
      byTitle.set(sample.title, entry.id);
      let t = created.getTime();
      const add = (role, content, meta) => {
        t += role === 'user' ? 60_000 : 20_000;
        messages += 1;
        return db.messages.add(entry.id, { role, content, meta, createdAt: t });
      };
      if (template) add('assistant', template.opening, { kind: 'prompt' });
      for (const [text, reply] of sample.turns) {
        add('user', text);
        if (reply) add('assistant', reply, { ...REPLY_META });
      }
      if (sample.wrapup) add('assistant', sample.wrapup, { kind: 'wrapup', provider: 'local', model: LOCAL_MODEL });
      db.entries.update(entry.id, { updatedAt: t }); // messages.add stamps "now"; keep the sample history in the past
    }
    for (const memory of SAMPLE_MEMORIES) {
      db.memories.create({ text: memory.text, pinned: Boolean(memory.pinned), sourceEntryId: byTitle.get(memory.entry), createdAt: moment(now, 3, 22, 30).getTime() });
    }
    const end = new Date(now);
    end.setDate(end.getDate() - 8);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    db.reports.create({
      kind: 'weekly',
      periodStart: dateOf(start),
      periodEnd: dateOf(end),
      content: SAMPLE_REPORT,
      meta: { provider: 'local', model: LOCAL_MODEL, entryCount: 4 },
      createdAt: moment(now, 7, 9, 0).getTime(),
    });
  });
  return { entries: SAMPLE_ENTRIES.length, messages, memories: SAMPLE_MEMORIES.length, reports: 1 };
}

/**
 * Start everything: pretend models, a temporary journal with sample data and the real app.
 * @param {{ port?: number, delayMs?: number, verbose?: boolean }} [options]
 * @returns {Promise<{ url: string, port: number, dir: string, app: object, db: object, openai: object, gemini: object, seeded: object, close: () => Promise<void> }>}
 */
export async function startDemo({ port = 0, delayMs = 25, verbose = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'myjournal-demo-'));
  const openai = await createMockOpenAI({
    delayMs,
    models: [LOCAL_MODEL, 'llama3.2:1b', 'qwen2.5:1.5b', 'gemma2:2b', 'smollm2:1.7b', 'mock-model'],
    pull: { delayMs: 120, steps: 12 },
  });
  const gemini = await createMockGemini({ delayMs, apiKey: [MOCK_KEY], models: [...LIVE_MODELS] });
  let db;
  let app;
  const close = async () => {
    if (app) await app.close();
    if (db) db.close();
    await Promise.all([openai.close(), gemini.close()]);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    db = openDb({ file: join(dir, 'journal.db') });
    const seeded = seedSampleJournal(db);
    const { settings, errors } = mergeSettings(db.settings.get(), {
      onboarded: true,
      profile: { name: 'Sam' },
      ai: {
        enabled: true,
        provider: 'local',
        providers: {
          local: { baseUrl: openai.baseUrl, model: LOCAL_MODEL },
          openai: { baseUrl: openai.baseUrl, model: 'mock-model', apiKey: MOCK_KEY },
          gemini: { baseUrl: gemini.url, apiKey: MOCK_KEY },
        },
      },
    });
    if (Object.keys(errors).length > 0) throw new Error(`demo settings are invalid: ${JSON.stringify(errors)}`);
    db.settings.set(settings);

    // An empty environment: keys from the developer's shell must not leak into the pretend setup.
    const config = loadConfig({ JOURNAL_DATA_DIR: dir }, { overrides: { port, quiet: !verbose, env: {} } });
    app = createApp({ config, db });
    const listening = await app.listen();
    return { url: listening.url, port: listening.port, dir, app, db, openai, gemini, seeded, close };
  } catch (err) {
    await close();
    throw err;
  }
}

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  ignoreStdioErrors();
  const demo = await startDemo({
    port: Number(option('port', 0)),
    delayMs: Number(option('delay', 25)),
    verbose: process.argv.includes('--verbose'),
  });
  process.stdout.write(`
  MyJournal demo is running - pretend models, sample data, nothing is kept.

    Open   ${demo.url}

  What you can try (no key needed):
    - Write an entry on Today and press Send: the pretend local model answers (it is canned, not smart).
    - Open "A slow day with Miso" and press Wrap up to see the title, summary and memories get filled in.
    - Insights shows ${demo.seeded.entries} sample entries over three weeks; "Weekly reflection" writes a new one.
    - Settings: all three providers are wired to pretend servers, so "Test connection" and "Load models" work.
        Local model   ${demo.openai.url}   (pretend Ollama: "Download model" works too)
        Gemini        ${demo.gemini.url}   (API key: ${MOCK_KEY})
        OpenAI-style  ${demo.openai.baseUrl}   (API key: ${MOCK_KEY})

  Stop with Ctrl+C. The temporary data (${demo.dir}) is deleted.

`);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await demo.close();
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`The demo could not start: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
