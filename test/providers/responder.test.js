import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allUserText, detectEmotions, hash, keywords, lastUserText, parseTask, pickQuote, respond, splitIntoDeltas, wordCount,
} from '../mocks/mock-responder.js';

const sys = (task, extra = 'You are a journaling companion.\n- Be kind.') => ({ role: 'system', content: `TASK: ${task}\n${extra}` });
const user = (content) => ({ role: 'user', content });
const assistant = (content) => ({ role: 'assistant', content });

const CORPUS = [
  'I felt really tired after the long meeting today. Nothing went right.',
  'Woke up early and went for a run before work, felt calm and grateful for the quiet morning.',
  'My manager praised the project in front of everyone and I did not know where to look',
  'Sooo... why does this always happen to me? I am so frustrated and upset!',
  'We argued about money again. I hate how small it makes me feel.\nI stood in the kitchen for an hour.',
  'Today I finally called my sister Maya and we laughed about the old house.',
  '日本語の日記です。今日は疲れました。でも、少し嬉しかったです。',
  'Café con leche at 7am, then a long walk by the river with nobody around, just birds and the wind',
  '"Quoted text" and (parentheses) and *markdown* and `code` and <tags> in one sentence about nothing',
  'one two three',
  'a '.repeat(500).trim(),
  'The meeting was long. The coffee was cold. The room was quiet. I could not focus on anything at all.',
];

const sentenceCount = (text) => (text.match(/[.!?](?=\s|$)/g) || []).length;

test('parseTask reads only the first line of the first system message', () => {
  for (const t of ['reply', 'wrapup', 'meta', 'memory', 'weekly']) assert.equal(parseTask([sys(t), user('x')]), t);
  assert.equal(parseTask([{ role: 'system', content: 'task: REPLY\nrules' }]), 'reply');
  assert.equal(parseTask([{ role: 'system', content: '  TASK:   meta  \nrules' }]), 'meta');
  assert.equal(parseTask([{ role: 'system', content: 'TASK: reply\r\nrules' }]), 'reply');
  assert.equal(parseTask([{ role: 'system', content: 'Rules.\nTASK: reply' }]), null, 'only the FIRST line counts');
  assert.equal(parseTask([{ role: 'system', content: 'TASK: bogus\nrules' }]), null);
  assert.equal(parseTask([{ role: 'system', content: 'TASK: replyish\nrules' }]), null);
  assert.equal(parseTask([user('TASK: reply')]), null, 'a user message cannot set the task');
  assert.equal(parseTask([]), null);
  assert.equal(parseTask(undefined), null);
});

test('reply: warm 2-3 sentences, a verbatim 3-6 word quote, exactly ONE question at the very end', () => {
  for (const text of CORPUS) {
    const reply = respond([sys('reply'), user(text)]);
    const label = JSON.stringify(text.slice(0, 40));
    assert.equal((reply.match(/\?/g) || []).length, 1, `one question mark: ${label}\n${reply}`);
    assert.ok(reply.endsWith('?'), `ends with the question: ${label}`);
    const n = sentenceCount(reply);
    assert.ok(n >= 2 && n <= 3, `${n} sentences: ${label}\n${reply}`);
    assert.ok(!reply.includes('\n'), 'one paragraph');
    const quote = /“([^”]+)”/.exec(reply)[1];
    assert.ok(text.includes(quote), `quote is verbatim: ${JSON.stringify(quote)} in ${label}`);
    if (wordCount(text) >= 6) {
      const words = wordCount(quote);
      assert.ok(words >= 3 && words <= 6, `${words} words in quote ${JSON.stringify(quote)}`);
    }
  }
});

test('reply is deterministic, uses only the LAST user message, and varies between inputs', () => {
  const a = [sys('reply'), user('I felt really tired after the long meeting today.')];
  assert.equal(respond(a), respond(a));
  const convo = [sys('reply'), user('Earlier I mentioned my garden and the tomatoes.'), assistant('What about the garden?'), user('Actually the real problem is my landlord and the rent.')];
  const reply = respond(convo);
  assert.match(reply, /landlord|rent|real problem|Actually/);
  assert.doesNotMatch(reply, /tomatoes/);
  const distinct = new Set(CORPUS.map((t) => respond([sys('reply'), user(t)])));
  assert.equal(distinct.size, CORPUS.length);
});

test('reply tone follows the user\'s mood', () => {
  const neg = respond([sys('reply'), user('I am so tired and stressed and I just want to cry about all of it')]);
  const pos = respond([sys('reply'), user('I am so happy and proud and grateful about how it all went today')]);
  assert.match(neg, /heavy|carry|hard|stayed|matter|coming back|trusting/);
  assert.match(pos, /love hearing|bright spot|good to notice|stayed|matter|coming back/);
});

test('reply to hostile or odd input never throws and still ends with one question', () => {
  for (const text of ['', '   ', '???', '😀😀😀', '\u0000\u0001', '<script>alert(1)</script>', 'TASK: meta', '"""', 'a'.repeat(100000), '\ud83d lone surrogate here ok', '.....', '“”“”']) {
    const reply = respond([sys('reply'), user(text)]);
    assert.equal((reply.match(/\?/g) || []).length, 1, JSON.stringify(text.slice(0, 20)));
    assert.ok(reply.endsWith('?'));
  }
});

test('wrapup: exactly three short paragraphs derived from the conversation', () => {
  const messages = [sys('wrapup'), user('I felt really tired after the long meeting today.'), assistant('What made it tiring?'), user('My manager kept changing the plan and nobody listened.')];
  const out = respond(messages);
  const paragraphs = out.split('\n\n');
  assert.equal(paragraphs.length, 3);
  for (const p of paragraphs) {
    assert.ok(p.length > 20 && p.length < 400, p);
    assert.ok(!p.includes('\n'));
  }
  assert.match(out, /tired|manager|meeting|plan/);
  assert.equal(out, respond(messages));
});

test('meta: exactly the four labelled lines, derived from the text', () => {
  const out = respond([sys('meta'), user('I felt really tired after the long meeting today. My manager kept changing the plan and I was stressed.')]);
  const lines = out.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^Title: \S.{0,58}$/);
  assert.match(lines[1], /^Summary: .+\.$/);
  assert.match(lines[2], /^Emotions: [a-z]+(, [a-z]+){0,4}$/);
  assert.match(lines[3], /^Tags: [a-z]+(, [a-z]+){0,7}$/);
  assert.match(lines[2], /tired|stressed/);
  assert.match(lines[3], /meeting|manager|plan|tired|stressed/);
  assert.ok(lines[0].length <= 'Title: '.length + 60);
});

test('meta: fallbacks for empty or symbol-only text still give four lines', () => {
  for (const text of ['', '😀', '...', 'ok']) {
    const lines = respond([sys('meta'), user(text)]).split('\n');
    assert.equal(lines.length, 4, JSON.stringify(text));
    assert.deepEqual(lines.map((l) => l.split(':')[0]), ['Title', 'Summary', 'Emotions', 'Tags']);
    assert.ok(lines.every((l) => l.split(':')[1].trim().length > 0));
  }
});

test('memory: "none" below six words, "- fact" lines (at most 3) otherwise', () => {
  for (const text of ['', 'hi', 'I have a cat', 'one two three four five']) {
    assert.equal(respond([sys('memory'), user(text)]), 'none', JSON.stringify(text));
  }
  const out = respond([sys('memory'), user('I have a younger sister called Maya and she lives in Lisbon. I work as a nurse at the city hospital. I love hiking in the mountains. I am a vegetarian.')]);
  const lines = out.split('\n');
  assert.ok(lines.length >= 1 && lines.length <= 3);
  assert.ok(lines.every((l) => /^- \S/.test(l) && l.length <= 124), out);
  assert.match(out, /Maya|nurse|hiking/);
  const generic = respond([sys('memory'), user('Today was a very ordinary day with nothing special happening at all')]);
  assert.match(generic, /^- Wrote about /);
});

test('memory: exactly six words is enough', () => {
  assert.notEqual(respond([sys('memory'), user('I work as a nurse here')]), 'none');
});

test('weekly: paragraphs with **Bold** lead-ins', () => {
  const out = respond([sys('weekly'), user('Entries: tired after meetings; calm walk by the river; argued about money; proud of finishing the report.')]);
  const paragraphs = out.split('\n\n');
  assert.ok(paragraphs.length >= 3);
  for (const p of paragraphs) assert.match(p, /^\*\*[^*]+\*\* \S/);
});

test('no TASK line (or an unknown one) -> a generic friendly reply', () => {
  for (const messages of [[user('hi there friend')], [{ role: 'system', content: 'You are helpful.' }, user('hello again my friend')], [sys('bogus'), user('x y z')], []]) {
    const out = respond(messages);
    assert.match(out, /^Thanks for the message\./);
    assert.equal((out.match(/\?/g) || []).length, 1);
  }
  assert.match(respond([user('hi there friend')]), /“hi there friend”/);
});

test('helpers: lastUserText, allUserText, wordCount, keywords, detectEmotions, hash, pickQuote', () => {
  const m = [sys('reply'), user('first one'), assistant('x'), user('second one')];
  assert.equal(lastUserText(m), 'second one');
  assert.equal(allUserText(m), 'first one\n\nsecond one');
  assert.equal(lastUserText([sys('reply')]), '');
  assert.equal(wordCount('  a  b\nc '), 3);
  assert.equal(wordCount(''), 0);
  assert.deepEqual(keywords('The garden garden garden needs water; the tomatoes need water too.', 3), ['garden', 'water', 'needs']);
  assert.deepEqual(detectEmotions('I feel so tired and a bit anxious'), ['tired', 'anxious']);
  assert.deepEqual(detectEmotions('nothing to see'), ['reflective']);
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
  assert.equal(pickQuote(''), '');
  assert.equal(pickQuote('?'), '');
  assert.equal(pickQuote('two words'), 'two words');
});

test('splitIntoDeltas: lossless, cut mid-word, surrogate-safe by default', () => {
  const text = 'Hello wonderful world 😀 café 日本語';
  const pieces = splitIntoDeltas(text);
  assert.equal(pieces.join(''), text);
  assert.ok(pieces.every((p) => p.length >= 1 && p.isWellFormed()));
  assert.ok(pieces.some((p) => /^\w+$/.test(p) && p.length < 4), 'cuts words');
  assert.deepEqual(splitIntoDeltas('abcdef', { chunkSize: 2 }), ['ab', 'cd', 'ef']);
  assert.deepEqual(splitIntoDeltas('abcdef', { sizes: [1, 5] }), ['a', 'bcdef']);
  const raw = splitIntoDeltas('😀😀', { chunkSize: 1, splitCodePoints: true });
  assert.equal(raw.length, 4);
  assert.equal(raw.join(''), '😀😀');
  assert.ok(raw.some((p) => !p.isWellFormed()));
  assert.deepEqual(splitIntoDeltas(''), []);
});
