import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crisisNotice, detectCrisis } from '../../src/journal/safety.js';

// Clear statements of suicidal thoughts or self-harm intent. Each must be flagged.
const POSITIVE = [
  // English
  'I want to die',
  'i just want to die',
  'I wanna die',
  'I really want to die tonight.',
  'I wish I was dead',
  'I wish I were dead.',
  'I wish I could just disappear forever',
  "I wish I'd never been born",
  "I'm thinking about killing myself",
  "I'm going to kill myself tonight",
  'I tried to kill myself last year',
  'I want to end my life',
  'I am thinking of taking my own life',
  'I have been having suicidal thoughts',
  'I feel suicidal',
  "I don't want to be alive anymore",
  "I don't want to live anymore",
  'i dont want to live anymore',
  'I don’t want to live anymore', // curly apostrophe
  "There's no reason to live",
  'Everyone would be better off without me',
  "I'd be better off dead",
  'life is not worth living',
  "I've been cutting myself again",
  'I want to hurt myself',
  'I feel like hurting myself',
  'I keep thinking about self-harm',
  "I'm planning to commit suicide",
  'I have a suicide plan',
  'I want to jump off a bridge',
  "I'm going to hang myself",
  "I can't stop thinking about ending it all",
  'I am so done with life',
  "I don't want to wake up.",
  'I just want to go to sleep and never wake up',
  'Sometimes I think everyone would be better off if I was gone',
  // shouting, spacing, punctuation, surroundings
  'I WANT TO DIE',
  'i want to\ndie',
  'Work was fine. Dinner was fine.\n\nBut honestly... I want to die. Anyway, bed.',
  '😞😞 i want to die 😞',
  // other languages
  'Quiero morir',
  'Me quiero matar',
  'No quiero vivir más',
  'Voy a quitarme la vida',
  'Pienso en suicidarme',
  'Je veux mourir',
  "J'ai envie de mourir",
  'Je vais me suicider',
  'Je ne veux plus vivre',
  'Ich will sterben',
  'Ich möchte nicht mehr leben',
  'Ich will mich umbringen',
  'Quero morrer',
  'Quero me matar',
  'Não quero mais viver',
  'Penso em me suicidar',
  // colloquial "wanna" forms (the pattern once required a second "to" after "wanna")
  "I don't wanna live anymore.",
  "I don't wanna be here anymore.",
  "I don't wanna exist.",
  'I dont wanna live.',
  'I do not wanna live',
  "I don't wanna wake up.",
  "I don't wanna be alive.",
  'I no longer wanna live',
  // explicit statements the first version missed
  'I think I should die.',
  'I need to die.',
  'I deserve to die.',
  "I'm ready to die.",
  "I'm so ready to die",
  "I don't deserve to live.",
  "I don't deserve to be alive",
  "I don't see the point of being alive.",
  "I can't find a reason to go on",
  "I don't see the point in living anymore",
  'The world would be better without me.',
  "Everyone would be happier without me",
  "They're better without me.",
  'I wish I was never born.',
  'I wish I would die in my sleep.',
  'I wish I could die',
  "I'm thinking about hurting myself.",
  "I've been thinking about hurting myself again",
  'I think about hurting myself sometimes',
  "I'm thinking of cutting myself",
  'I overdosed last night.',
  'I took a whole bottle of pills.',
  'I took too many pills and I don\'t care what happens.',
  "I took a bunch of pills and I don't care what happens.",
  'I cut myself again.',
  'I cut myself again last night.',
  'I hurt myself again last night on purpose.',
  'I burned myself on purpose',
  'Part of me wants to die.',
  'A part of me really wants to die',
  'I think about dying every day.',
  'I keep thinking about dying.',
  "I don't care if I live or die",
  'I used to be fine. Now I feel suicidal.',
  // first person next to somebody else: the writer is still at risk
  'My brother attempted suicide and now I feel suicidal myself.',
  "After my brother's suicide attempt I started having suicidal thoughts.",
  'I told her I was suicidal.',
  "My therapist says I'm suicidal.",
  'I attempted suicide last year.',
  'My sister is struggling. I am suicidal.',
  "I'm worried about my friend, but I have thoughts of suicide too.",
];

// Everyday language that mentions death or killing but is not a crisis. None may be flagged.
const NEGATIVE = [
  "I'm killing it at work this week",
  'We were dying laughing at dinner',
  'That cake was to die for',
  'I could die of embarrassment',
  'This deadline is killing me',
  "I'm dead tired after the run",
  'My phone died on the way home',
  'My grandfather died last spring and I still miss him',
  "I'm dying to see the new film",
  "I'd kill for a coffee right now",
  'She wants to die laughing every time he tells that joke',
  'I cut myself shaving this morning',
  'I hurt myself at the gym and my knee aches',
  'I burned myself on the stove again',
  'My brother wanted to die laughing when he saw it',
  "I'm not suicidal, just exhausted",
  "I would never kill myself, but I feel so empty",
  'A documentary about suicide prevention month',
  'The Suicide Squad was a fun movie',
  'I need to take my life back from my phone',
  'I took my life savings and bought a house',
  'I want to jump off the cliff into the lake this summer',
  'I feel like jumping out of my skin with nerves',
  'I want to jump out of a plane someday',
  "I'm drowning myself in work lately",
  'I could shoot myself in the foot with this email',
  "I don't want to wake up early tomorrow",
  "I don't want to live in a big city anymore",
  "I'm so tired of living with roommates",
  "It's killing me to wait for the results",
  'I wanted to die of embarrassment when I tripped on stage',
  "I'm going to kill this presentation tomorrow",
  'My life is full of things worth living for',
  "I'm dying of thirst, need water",
  'I want to end this meeting',
  'I want to end the argument with my sister',
  'I want to cut myself some slack',
  'I should stop punishing myself for small mistakes',
  "I don't want to hurt myself by overtraining",
  'Kill the lights, I am going to sleep',
  "I'm going to kill time at the mall",
  'He wanted to die when she walked out on him',
  'I would die if I missed the train',
  'I wish I could sleep forever, this bed is so cozy',
  'I wish I could disappear into a book for the whole weekend',
  'Me muero de risa con mi hermano',
  'Estoy muerto de cansancio',
  'Me quiero morir de vergüenza',
  'No quiero vivir en esta ciudad',
  'Voy a matar el tiempo en el parque',
  'Je suis mort de rire',
  'Je meurs de faim',
  "J'ai envie de mourir de honte",
  'Je ne veux pas mourir',
  'Ich sterbe vor Lachen',
  'Ich will sterben vor Scham',
  'Ich bin tot müde',
  'Estou morrendo de rir',
  'Quero morrer de vergonha',
  'Não quero morrer',
  'I took a walk and felt alive for the first time in months',
  'Ate too much cake. Feeling dead inside my pants, ha.',
  // morning intentions and everyday "wanna" / "should" / "ready" phrasing
  "I hope I don't wake up late tomorrow.",
  "I hope I don't wake up with a headache.",
  "I hope I don't wake up tired again",
  "I don't wanna live in a big city anymore",
  "I don't wanna live with roommates anymore",
  "I don't wanna wake up early tomorrow",
  "I don't wanna be late",
  'I wish I could die of embarrassment',
  'I should die of embarrassment after that email',
  'I need to die laughing, that video is too funny',
  "I'm ready to die on this hill",
  "I'm ready to die for my kids, you know that",
  'I overdosed on caffeine and sugar at the party',
  'I took a whole bottle of water to the gym',
  'I took all my meds this morning and felt fine',
  "I took a bunch of vitamins and I don't care for the taste",
  "I took a handful of pills to the pharmacy. I don't care about the receipt.",
  'I took too many pills by accident and called the pharmacist',
  'I cut myself again while chopping onions',
  'I cut myself shaving again',
  "I'm thinking about hurting my knee more if I keep running",
  'I think about dying my hair blue',
  'I think about dyeing my hair every day',
  'The meeting would be better without me there',
  "I don't see the point of life insurance",
  "I don't see the point of living in a city",
  "I don't deserve to live in such a beautiful house",
  "I don't care if I wake up late",
  // somebody else's suicide or self-harm
  'My brother attempted suicide last year.',
  'He is suicidal and I am scared for him.',
  'My friend is thinking about suicide.',
  'My mother has suicidal thoughts.',
  'My sister tried to commit suicide in 2019.',
  'Her suicide note was found.',
  "I'm worried my sister is suicidal.",
  'My best friend self-harms and I do not know how to help.',
  "My daughter's school called about her self-harm.",
  'My brother told me he is suicidal.',
  'They said he attempted suicide in college.',
];

test('detectCrisis flags clear statements (and there are enough samples)', () => {
  assert.ok(POSITIVE.length >= 25);
  for (const text of POSITIVE) {
    const result = detectCrisis(text);
    assert.equal(result.flagged, true, `should flag: ${JSON.stringify(text)}`);
    assert.ok(result.matches.length >= 1 && result.matches.length <= 5, `matches for ${JSON.stringify(text)}`);
  }
});

test('detectCrisis ignores hyperbole, idioms, accidents, negation and third persons', () => {
  assert.ok(NEGATIVE.length >= 25);
  for (const text of NEGATIVE) {
    const result = detectCrisis(text);
    assert.equal(result.flagged, false, `should NOT flag: ${JSON.stringify(text)} (matched ${JSON.stringify(result.matches)})`);
    assert.deepEqual(result.matches, []);
  }
});

test('detectCrisis result shape', () => {
  const clean = detectCrisis('I had a lovely walk and a good dinner.');
  assert.deepEqual(clean, { flagged: false, matches: [] });
  const hit = detectCrisis('I want to die. I feel suicidal. I have a suicide plan.');
  assert.equal(hit.flagged, true);
  assert.ok(Array.isArray(hit.matches));
  assert.ok(hit.matches.every((m) => typeof m === 'string' && m.length > 0 && m.length < 80));
  assert.equal(new Set(hit.matches).size, hit.matches.length, 'no duplicate matches');
  assert.ok(hit.matches.length <= 5);
  const many = detectCrisis(`${'I want to die. I feel suicidal. I will kill myself. I wish I was dead. I have a suicide plan. I want to hurt myself. '.repeat(3)}`);
  assert.ok(many.matches.length <= 5);
});

test('detectCrisis is safe on unusual input', () => {
  for (const bad of [undefined, null, 5, {}, [], '', '   ', '\n\n']) assert.deepEqual(detectCrisis(bad), { flagged: false, matches: [] });
  assert.equal(detectCrisis('a'.repeat(1_000_000)).flagged, false);
  assert.equal(detectCrisis('\u0000I want to die\u0000').flagged, true);
  assert.equal(detectCrisis('I want to die').flagged, true, 'non-breaking spaces');
  assert.equal(detectCrisis('I want to dıe').flagged, false);
  assert.equal(detectCrisis('😀'.repeat(50_000)).flagged, false);
});

test('detectCrisis finds the worst sentence at the very end of a huge entry and stays fast', () => {
  const filler = 'We walked by the river and had coffee with Maya. '.repeat(5000);
  const t0 = Date.now();
  assert.equal(detectCrisis(`${filler}I want to die`).flagged, true);
  assert.equal(detectCrisis(`I want to die ${filler}`).flagged, true);
  assert.equal(detectCrisis(`${filler}${filler}`).flagged, false);
  assert.ok(Date.now() - t0 < 3000, 'regex scan must stay linear');
});

test('detectCrisis resists pathological repetition (no catastrophic backtracking)', () => {
  const nasty = [
    `${'just really '.repeat(5000)}want to die`,
    `i wish i ${'just '.repeat(20000)}`,
    `${'i '.repeat(30000)}`,
    `${'want to '.repeat(20000)}`,
    `${'kill '.repeat(20000)}myself`,
    `${'i think i '.repeat(10000)}should`,
    `${'my brother '.repeat(10000)}suicidal`,
    `${'he is suicidal. '.repeat(5000)}`,
    `${'i took too many '.repeat(8000)}`,
    `${"i don't deserve to ".repeat(8000)}`,
  ];
  const t0 = Date.now();
  for (const text of nasty) detectCrisis(text);
  assert.ok(Date.now() - t0 < 3000);
});

test('"wanna" forms are flagged exactly like "want to" forms', () => {
  const tails = ['live anymore', 'live.', 'live', 'be alive', 'be alive anymore', 'be here anymore', 'exist', 'exist.', 'wake up', 'wake up.', 'wake up again',
    'wake up early tomorrow', 'live in a big city anymore', 'live with roommates', 'be late'];
  for (const lead of ["I don't", 'i dont', 'I do not']) {
    for (const tail of tails) {
      const long = detectCrisis(`${lead} want to ${tail}`).flagged;
      const colloquial = detectCrisis(`${lead} wanna ${tail}`).flagged;
      assert.equal(colloquial, long, `${lead} wanna ${tail}`);
    }
  }
  assert.equal(detectCrisis("I don't wanna live anymore").flagged, true);
  assert.equal(detectCrisis("I don't wanna wake up early tomorrow").flagged, false);
});

test('"I hope I don\'t wake up" is flagged only when nothing follows', () => {
  for (const text of ["I hope I don't wake up.", "I hope I never wake up", "I hope I don't wake up again", "i hope i dont wake up, honestly"]) {
    assert.equal(detectCrisis(text).flagged, true, text);
  }
  for (const text of ["I hope I don't wake up late", "I hope I won't wake up with a cold", "I hope I don't wake up the baby"]) {
    assert.equal(detectCrisis(text).flagged, false, text);
  }
});

test('suicide vocabulary about somebody else is ignored, about the writer is not (closest subject in the clause wins)', () => {
  const aboutOthers = [
    'My brother attempted suicide last year.',
    'My uncle committed suicide when I was a child, and I still miss him.',
    'He is suicidal and I am scared for him.',
    'She has been having suicidal thoughts and I told her to call someone.',
    'Their daughter attempted suicide.',
    "My friend's suicide attempt changed everything for us.",
    'I am helping my cousin, who is suicidal, to find a therapist.',
  ];
  for (const text of aboutOthers) assert.equal(detectCrisis(text).flagged, false, `should NOT flag: ${text}`);
  const aboutTheWriter = [
    'My brother attempted suicide. I feel suicidal too.',
    'My brother attempted suicide and I feel suicidal too',
    'I told my brother I was suicidal.',
    "When my mum found out I'd attempted suicide she cried.",
    'Suicidal thoughts again today.',
    'My mother says I am suicidal, but I am not sure.',
    'I have suicidal thoughts. My friends do not know.',
  ];
  for (const text of aboutTheWriter) assert.equal(detectCrisis(text).flagged, true, `should flag: ${text}`);
});

test('negation does not hide "can\'t stop thinking" statements', () => {
  assert.equal(detectCrisis("I can't stop thinking about killing myself").flagged, true);
  assert.equal(detectCrisis("I can't help thinking about ending it all").flagged, true);
  assert.equal(detectCrisis("I don't think I'd ever kill myself").flagged, true, 'ambiguous: err on the side of care');
  assert.equal(detectCrisis('I would never kill myself').flagged, false);
});

test('crisisNotice is short, kind, region-neutral, plain text', () => {
  const text = crisisNotice();
  assert.equal(typeof text, 'string');
  assert.equal(crisisNotice(), text, 'static');
  assert.ok(text.length > 200 && text.length < 900, `length ${text.length}`);
  assert.match(text, /\b988\b/);
  assert.match(text, /findahelpline\.com/);
  assert.match(text, /emergency number/i);
  assert.match(text, /professional help/i);
  assert.match(text, /call or text 988/i);
  assert.match(text, /elsewhere/i, 'covers people outside the US');
  assert.ok(!/[*_#`<>]/.test(text), 'plain text: no markdown or HTML');
  assert.ok(!/https?:\/\//.test(text), 'no links to click, just a name to type');
  assert.ok(!/\b(?:diagnos|disorder|patient|symptom|therapy session)\b/i.test(text), 'non-clinical');
  assert.ok(!/\b(?:AI|language model|chatbot)\b/.test(text), 'does not volunteer being an AI');
  assert.ok(text.split(/\s+/).length <= 110, 'short');
  assert.ok(/I'm really sorry|you're hurting|sorry/i.test(text), 'opens with care');
});
