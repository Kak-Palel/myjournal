// Guided journal templates and the prompt of the day.
//
// `opening` is what the companion says first (no AI call is needed to start a guided entry).
// `guidance` (server-side only, <= 90 words) tells the model how to run the session.
// `steps` (server-side only) lets context.js add a computed hint such as "Step 2 of 5: ..." so a small
// model does not have to keep track of where it is. Step 1 is the question asked by the opening; the
// first AI reply therefore works on step 2.

import { dayNumber } from './dates.js';

/** @typedef {{id: string, title: string, category: 'Daily'|'Mind'|'Growth'|'Creative', description: string, icon: string,
 *   opening: string, guidance: string, minutes: number, steps: readonly string[]}} Template */

export const TEMPLATE_CATEGORIES = Object.freeze(['Daily', 'Mind', 'Growth', 'Creative']);

const template = (t) => Object.freeze({ ...t, steps: Object.freeze([...t.steps]) });

/** @type {readonly Template[]} in the order the UI shows them */
export const TEMPLATES = Object.freeze([
  template({
    id: 'rose-thorn-bud',
    title: 'Rose, Thorn, Bud',
    category: 'Daily',
    description: 'A quick check-in on a highlight, a challenge and something you are looking forward to.',
    icon: 'flower',
    minutes: 5,
    opening: "Let's do a Rose, Thorn, Bud check-in, one part at a time. First, your rose: what was a highlight of your day, big or small?",
    guidance: 'This is a Rose, Thorn, Bud check-in. Go one part at a time and never ask for two parts in one message. '
      + 'Rose is a highlight, thorn is a challenge, bud is something the user looks forward to or that is just starting to grow. '
      + 'After each answer, reflect it back in one warm sentence, then ask about the next part. '
      + 'After the bud, ask what the user notices when they see all three together.',
    steps: [
      'Ask for the rose (a highlight, and what made it good).',
      'Ask for the thorn (something that was hard or drained them).',
      'Ask for the bud (something they look forward to, or that is just starting).',
      'Ask what they notice when they look at the rose, the thorn and the bud together.',
    ],
  }),
  template({
    id: 'gratitude',
    title: 'Gratitude',
    category: 'Daily',
    description: 'Notice a few good things and why they mattered to you.',
    icon: 'smile',
    minutes: 3,
    opening: "Let's take a few minutes to notice what is good. What is one thing from today, small or big, that you feel grateful for?",
    guidance: 'This is a gratitude practice. Help the user notice up to three good things and why each one mattered to them. '
      + 'Ask for details: who, what, how it felt. Ask for one thing at a time. '
      + 'Do not push positivity on a hard day; being grateful for small, plain things is enough. '
      + 'Never turn their gratitude into a lesson.',
    steps: [
      'Ask for something they are grateful for from today.',
      'Ask why it mattered, and how it felt in the moment.',
      'Ask for a second thing, of any size, or a person they appreciate.',
      'Ask for a third thing, or something about themselves they appreciate.',
      'Ask which of these they want to give a little more room tomorrow.',
    ],
  }),
  template({
    id: 'morning-intention',
    title: 'Morning intention',
    category: 'Daily',
    description: 'Set the tone for your day with a feeling, a focus and one small step.',
    icon: 'sun',
    minutes: 3,
    opening: "Good morning. Let's set a gentle intention for the day. How are you arriving this morning, in body and mind?",
    guidance: 'This is a morning intention. Keep it light and forward-looking. '
      + 'Move from how the user feels now, to what matters most today, to one small concrete action, to a one-sentence intention they can carry. '
      + 'Do not build a to-do list. '
      + 'Offer to shape the intention into one sentence only after they have shared a focus.',
    steps: [
      'Ask how they are arriving this morning (body, mind, energy).',
      'Ask what matters most today, or what they want to protect.',
      'Ask what might get in the way, and how they could meet it kindly.',
      'Ask for one small concrete action they will do first.',
      'Help them word a one-sentence intention in their own words.',
    ],
  }),
  template({
    id: 'evening-reflection',
    title: 'Evening reflection',
    category: 'Daily',
    description: 'Wind down by looking back at your day: what happened, how it felt, what you learned.',
    icon: 'moon',
    minutes: 5,
    opening: "Let's wind down and look back on your day. What stands out most as you think about it?",
    guidance: 'This is an evening reflection. Help the user look back on the day: what stood out, how it felt, '
      + 'what they are proud of or would do differently, and what they can let go of tonight. '
      + 'Stay gentle and unhurried; do not problem-solve after a long day. '
      + 'End with something to put down tonight or carry into tomorrow.',
    steps: [
      'Ask what stood out most today.',
      'Ask how it felt, and where they noticed that feeling.',
      'Ask what they are proud of or glad they did today.',
      'Ask what was hard, and what they might do differently, without blame.',
      'Ask what they want to let go of tonight and what to carry into tomorrow.',
    ],
  }),
  template({
    id: 'thought-record',
    title: 'Thought record',
    category: 'Mind',
    description: 'Untangle a hard moment: the situation, the thought, the feeling and a fairer way to see it.',
    icon: 'lightbulb',
    minutes: 10,
    opening: "Let's slow down and look at a difficult moment, step by step. First, the situation: what happened, and where were you?",
    guidance: 'This is a thought record, a cognitive behavioural exercise. Work in this order, one step per message: '
      + 'situation, automatic thought, emotion with intensity from 0 to 10, evidence for and against the thought, balanced thought. '
      + 'Ask Socratic questions. Never tell the user a thought is wrong or label it a distortion. '
      + 'Do not skip ahead. This is journaling, not therapy.',
    steps: [
      'Ask for the situation (what happened, where, when, with whom).',
      'Ask what went through their mind, the automatic thought, in their own words.',
      'Ask which emotion they felt and how strong it was, from 0 to 10.',
      'Ask what supports the thought and what goes against it, one side at a time.',
      'Help them put a balanced thought into words, then ask how strong the emotion feels now.',
    ],
  }),
  template({
    id: 'worry-dump',
    title: 'Worry dump',
    category: 'Mind',
    description: 'Empty your head onto the page, then sort what you can act on from what you cannot.',
    icon: 'cloud',
    minutes: 5,
    opening: "Let's get your worries out of your head and onto the page; messy is fine. What is weighing on your mind right now?",
    guidance: 'This is a worry dump. First let the user pour everything out without fixing anything: acknowledge, do not solve. '
      + 'Then help sort the worries: which can they act on, and which are outside their control? '
      + 'For one actionable worry, find a tiny next step. For the rest, help them set them down for now. '
      + 'Stay calm and slow.',
    steps: [
      'Invite them to pour out everything that worries them, with no fixing yet.',
      'Ask whether anything else is on their mind, then acknowledge how much they are carrying.',
      'Ask which worry is loudest and what exactly they fear could happen.',
      'Ask which worries they can act on and which are outside their control.',
      'For one worry they can act on, ask for a tiny next step; ask how they can set the rest down for now.',
    ],
  }),
  template({
    id: 'self-compassion',
    title: 'Self-compassion',
    category: 'Mind',
    description: 'Meet a hard moment with the kindness you would give a good friend.',
    icon: 'heart',
    minutes: 7,
    opening: "Let's give a hard moment some kindness. What is something you have been judging yourself for lately?",
    guidance: 'This is a self-compassion exercise with three parts: notice the pain without judging it, remember that struggling is part of being human, '
      + 'then offer kind words. Be warm and unhurried. Never argue with their feelings or hurry to fix them. '
      + 'In the last step, invite the user to write what they would say to a close friend in the same situation, and then to say a little of it to themselves.',
    steps: [
      'Ask what they are judging themselves for, and what the inner critic says.',
      'Ask how this feels in the body, and help them name the feeling kindly.',
      'Ask whether other people might struggle in a similar way, so they remember they are not alone.',
      'Ask what they would say to a close friend in this exact situation.',
      'Invite them to say a little of that to themselves, in their own words.',
    ],
  }),
  template({
    id: 'goals-checkin',
    title: 'Goals check-in',
    category: 'Growth',
    description: 'Check in on a goal: progress, obstacles and the next small step.',
    icon: 'target',
    minutes: 8,
    opening: "Let's check in on something you are working toward. Which goal would you like to look at today?",
    guidance: 'This is a goal check-in. Cover: why the goal matters to the user, what progress they have made (celebrate it), '
      + 'what is in the way, and one small next step with a time. Ask for specifics. '
      + 'Do not set goals for them and do not push. If they feel behind, respond with understanding before asking about the next step.',
    steps: [
      'Ask which goal they want to check in on and why it matters to them.',
      'Ask what progress they have made, even small, and celebrate it.',
      'Ask what has been getting in the way.',
      'Ask what would help (a change of plan, support, or a smaller step).',
      'Ask for one small next step and when they will do it.',
    ],
  }),
  template({
    id: 'relationship-reflection',
    title: 'Relationship reflection',
    category: 'Growth',
    description: 'Reflect on one relationship: what is going well, what is hard and what you need.',
    icon: 'users',
    minutes: 8,
    opening: "Let's reflect on a relationship that is on your mind. Who would you like to think about today?",
    guidance: 'This is a relationship reflection. Help the user explore one relationship: what it means to them, what feels good, '
      + 'what feels hard, what they need, and what they could say or do. Stay neutral. '
      + 'Never judge the other person and never tell the user to end or keep a relationship. '
      + 'You only hear one side, so do not assume what the other person meant.',
    steps: [
      'Ask who they want to reflect on and what the relationship means to them.',
      'Ask what is going well, or what they appreciate about this person.',
      'Ask what feels hard or unresolved, and how that feels.',
      'Ask what they need from the relationship that they are not getting.',
      'Ask what they could say or do next, if anything, and what feels right to them.',
    ],
  }),
  template({
    id: 'dream-journal',
    title: 'Dream journal',
    category: 'Creative',
    description: 'Capture a dream while it is fresh: details first, feelings second, meaning last.',
    icon: 'star',
    minutes: 6,
    opening: "Let's capture your dream while it is still fresh. What do you remember, even if it is only a fragment?",
    guidance: 'This is a dream journal. Work in three phases. First the details: setting, people, objects, colours and what happened, in the user\'s words. '
      + 'Then the feelings: how they felt in the dream and on waking. Only at the end the meaning: what it might connect to in their life. '
      + 'Never interpret symbols or say what a dream means. Offer questions, not verdicts.',
    steps: [
      'Ask for the setting and what happened, as much as they remember.',
      'Ask who or what appeared, and for details such as colours, objects and sounds.',
      'Ask how they felt during the dream and when they woke up.',
      'Ask what in their waking life this might echo, if anything. Offer it as a question, not a verdict.',
      'Ask whether anything in it is worth remembering or exploring, or what title they would give it.',
    ],
  }),
  template({
    id: 'weekly-review',
    title: 'Weekly review',
    category: 'Growth',
    description: 'Look back on your week: wins, challenges, lessons and what comes next.',
    icon: 'calendar',
    minutes: 10,
    opening: "Let's look back on your week. What were the highlights, the moments you are glad happened?",
    guidance: 'This is a weekly review. Cover: wins and highlights, challenges, what the user learned, what gave them energy and what drained it, '
      + 'and one or two intentions for next week. Ask about one thing at a time. '
      + 'Celebrate wins before turning to difficulties. Keep intentions few and realistic; do not create a long to-do list.',
    steps: [
      'Ask for the highlights and wins of the week.',
      'Ask about the challenges, and what was harder than expected.',
      'Ask what they learned about themselves or about what works for them.',
      'Ask what gave them energy and what drained it.',
      'Ask for one or two intentions for next week, small and realistic.',
    ],
  }),
  template({
    id: 'decision-helper',
    title: 'Decision helper',
    category: 'Growth',
    description: 'Think a decision through: options, what matters to you, worries and a next step.',
    icon: 'compass',
    minutes: 10,
    opening: "Let's think this decision through together. What choice are you facing right now?",
    guidance: 'This is a decision helper. Help the user clarify, not decide: the choice, the options (including doing nothing), '
      + 'what matters most to them, what each option gives and costs, and what their gut says. '
      + 'Never tell them what to choose. Reflect their own words. '
      + 'End with the smallest step that would give them more information or move them forward.',
    steps: [
      'Ask what decision they face and when it has to be made.',
      'Ask what options they see, including doing nothing.',
      'Ask what matters most to them in this choice.',
      'Ask what each option would give them and cost them.',
      'Ask what their gut says, then help them find a small next step to test it.',
    ],
  }),
]);

/**
 * Template by id.
 * @param {unknown} id
 * @returns {Template|null}
 */
export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

/**
 * The client-safe view of a template: `guidance` and `steps` stay on the server.
 * @param {Template} t
 * @returns {{id: string, title: string, category: string, description: string, icon: string, opening: string, minutes: number}}
 */
export function publicTemplate(t) {
  const { id, title, category, description, icon, opening, minutes } = t;
  return { id, title, category, description, icon, opening, minutes };
}

/**
 * Where a guided session stands, from the number of answers the user has given so far.
 * The reply being written is for the NEXT step: after 1 answer the companion works on step 2.
 * @param {Template|null} t
 * @param {number} userTurns number of user turns so far (consecutive user messages count as one)
 * @returns {{n: number, total: number, done: boolean, text: string}|null} `null` without steps
 */
export function templateStep(t, userTurns) {
  if (!t || !Array.isArray(t.steps) || t.steps.length === 0) return null;
  const total = t.steps.length;
  const turns = Number.isFinite(userTurns) ? Math.max(0, Math.floor(userTurns)) : 0;
  const n = Math.min(total + 1, turns + 1);
  if (n > total) {
    return {
      n,
      total,
      done: true,
      text: `All ${total} steps are covered. Reflect briefly on what the user shared, then ask whether anything else wants to be said.`,
    };
  }
  return { n, total, done: false, text: `Step ${n} of ${total}: ${t.steps[n - 1]}` };
}

// ------------------------------------------------------------------------------------------------
// Prompt of the day

/** Curated one-line prompts. Order matters (it is the rotation) and ids are positional: only ever append. */
const PROMPTS = Object.freeze([
  'What is one small thing that made today a little easier than it could have been?',
  'What are you carrying right now that you have not said out loud?',
  'Describe a moment this week when you felt most like yourself.',
  'What would you do today if you were not afraid of getting it wrong?',
  'Who made a difference in your life recently, and what did they do?',
  'What is your body trying to tell you right now?',
  'What are you looking forward to, even a little?',
  'Which of your habits are you quietly proud of?',
  'What has been taking more of your energy than it deserves?',
  'If today had a colour and a kind of weather, what would they be?',
  'What have you been putting off, and what is really behind it?',
  'What did you need most today, and did you get it?',
  'Write about a place where you feel at peace. What makes it so?',
  'What is a belief you held a few years ago that has changed?',
  'When did you last laugh until it hurt? What was so funny?',
  'What would you tell your younger self about this time in your life?',
  'What boundary do you need to set, or to hold more firmly?',
  'What are you learning to accept?',
  'Which moment from today would you like to keep?',
  'What does a good day look like for you right now?',
  'Who do you miss, and what do you miss about them?',
  'What is a fear that has become smaller than it used to be?',
  'What are you curious about lately?',
  'What is something kind you did for yourself this week?',
  'What feels unfinished in your life right now?',
  'How are you really doing, underneath the usual "fine"?',
  'Which sound, smell or taste took you back to a memory recently?',
  'Name three things you can see, hear and feel right now. What do they tell you about this moment?',
  'What do you wish people understood about you?',
  'What did you do today just because you wanted to?',
  'If you could change one small thing about tomorrow, what would it be?',
  'What have you outgrown?',
  'What small win from this week did you not celebrate?',
  'What do you keep telling yourself that might not be true?',
  'When do you feel most energised, and when do you feel drained?',
  'What are you grateful for that you usually take for granted?',
  'Which relationship in your life could use a little more attention?',
  'What would "enough" look like for you today?',
  'What is a decision you are glad you made?',
  'What was the hardest part of your week, and how did you get through it?',
  'If you had a free afternoon with no obligations, how would you spend it?',
  'What lesson keeps showing up in your life?',
  'What do you want more of in your life, and what do you want less of?',
  'Who do you admire, and what do they have that you would like to grow in yourself?',
  'What would you say to a friend who felt the way you feel today?',
  'What are you ready to forgive, in yourself or in someone else?',
  'Which part of your routine no longer serves you?',
  'What is a childhood memory that still makes you smile?',
  'What makes you feel safe?',
  'What did you do well today, however small?',
  'What are you avoiding feeling?',
  'Where would you like to be a year from now?',
  'What is your favourite way to rest, and when did you last do it?',
  'What comparison have you been making that is not helping you?',
  'What brings you back to yourself when life gets loud?',
  'Tell the story of your morning in three sentences.',
  'What are you proud of that nobody knows about?',
  'What does your inner critic say most often, and how would a kind voice answer it?',
  'What do you want to remember about this season of your life?',
  'Who are you when nobody is watching?',
  'What do you need to hear right now?',
  'What is going right, even if everything else feels messy?',
  'What do you wish you had more time for?',
  'What would make this week feel like a good one?',
  'What could you say no to this week?',
  'What gave you hope recently?',
  'What have you been meaning to tell someone?',
  'How did you look after yourself today, and how could you tomorrow?',
  'What small adventure could you have this week?',
  'Which of your values did you live by today?',
  'What is the kindest thing you could do for someone this week?',
]);

/** Number of distinct prompts; the rotation repeats only after this many days. */
export const PROMPT_COUNT = PROMPTS.length;

/**
 * The prompt of the day: the same text for the same calendar date, a different one on each of the next
 * PROMPT_COUNT - 1 days. An invalid date string yields the first prompt rather than throwing.
 * @param {string} dateStr `YYYY-MM-DD` in the user's local time
 * @returns {{id: string, text: string}} id is `pod-NN`, stable for a given text
 */
export function promptOfTheDay(dateStr) {
  const n = dayNumber(dateStr);
  const day = Number.isNaN(n) ? 0 : n;
  const index = ((day % PROMPT_COUNT) + PROMPT_COUNT) % PROMPT_COUNT;
  return { id: `pod-${String(index).padStart(2, '0')}`, text: PROMPTS[index] };
}

/** All prompts of the day in rotation order (for tests and tooling). @returns {string[]} */
export function allPrompts() {
  return [...PROMPTS];
}
