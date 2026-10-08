import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  META_EXAMPLE, cleanReply, detectEmotions, looksLikeRefusal, parseMemoryLines, parseMeta, stripThinking,
} from '../../src/journal/tasks.js';

// ------------------------------------------------------------------------------------------------ cleanReply

test('cleanReply keeps a normal reply unchanged', () => {
  const reply = 'That sounds like a lot to carry. What part of it weighs on you the most?';
  assert.equal(cleanReply(reply), reply);
});

test('cleanReply strips reasoning blocks', () => {
  assert.equal(cleanReply('<think>The user is sad.</think>\n\nI am sorry to hear that. What happened?'), 'I am sorry to hear that. What happened?');
  assert.equal(cleanReply('<thinking>a</thinking>Hi.<reasoning>b</reasoning> There?'), 'Hi. There?');
  assert.equal(cleanReply('<THINK>x\ny\nz</THINK>Hello again. How was it?'), 'Hello again. How was it?');
  assert.equal(cleanReply('<think>never closed and the reply is lost'), '');
  assert.equal(cleanReply('Reasoning goes here without an opening tag.</think>Actual reply. Why?'), 'Actual reply. Why?');
  assert.equal(cleanReply('<think></think>'), '');
});

test('cleanReply strips role prefixes', () => {
  for (const [input, expected] of [
    ['Assistant: That sounds hard. What happened?', 'That sounds hard. What happened?'],
    ['AI: Hello there.', 'Hello there.'],
    ['Reply: Mm. And then?', 'Mm. And then?'],
    ['**Assistant:** Mm. And then?', 'Mm. And then?'],
    ['**Assistant**: Mm. And then?', 'Mm. And then?'],
    ['[Assistant] Mm. And then?', '[Assistant] Mm. And then?'],
    ['Response - Mm. And then?', 'Mm. And then?'],
    ['Companion: Mm. And then?', 'Mm. And then?'],
    ['assistant:\nMm. And then?', 'Mm. And then?'],
    ['Assistant: Reply: Mm. And then?', 'Mm. And then?'],
    ['> Assistant: Mm.', 'Mm.'],
    ['Answer: Mm.', 'Mm.'],
    ['\u52a9\u624b\uff1a\u542c\u8d77\u6765\u5f88\u4e0d\u5bb9\u6613\u3002\u53d1\u751f\u4e86\u4ec0\u4e48\uff1f', '\u542c\u8d77\u6765\u5f88\u4e0d\u5bb9\u6613\u3002\u53d1\u751f\u4e86\u4ec0\u4e48\uff1f'],
  ]) assert.equal(cleanReply(input), expected, input);
  assert.equal(cleanReply('Model answers are fine: this is a normal sentence.'), 'Model answers are fine: this is a normal sentence.');
  assert.equal(cleanReply('I think the AI: that is a thing you said'), 'I think the AI: that is a thing you said');
});

test('cleanReply strips wrapping code fences and quotes, only around the WHOLE reply', () => {
  assert.equal(cleanReply('```\nThat sounds hard.\n```'), 'That sounds hard.');
  assert.equal(cleanReply('```markdown\nThat sounds hard.\n\nWhy?\n```'), 'That sounds hard.\n\nWhy?');
  assert.equal(cleanReply('```text\nHello?\n```\n'), 'Hello?');
  assert.equal(cleanReply('```\nUnclosed fence content'), 'Unclosed fence content');
  assert.equal(cleanReply('Use this:\n```\ncode\n```\nOk?'), 'Use this:\n```\ncode\n```\nOk?');
  assert.equal(cleanReply('"That sounds hard. What happened?"'), 'That sounds hard. What happened?');
  assert.equal(cleanReply('“That sounds hard.”'), 'That sounds hard.');
  assert.equal(cleanReply('«Que s’est-il passé ?»'), 'Que s’est-il passé ?');
  assert.equal(cleanReply('"Hi," she said, "bye."'), '"Hi," she said, "bye."');
  assert.equal(cleanReply('She said "no" and left.'), 'She said "no" and left.');
  assert.equal(cleanReply('"'), '"');
  assert.equal(cleanReply('Assistant: "Quoted reply here."'), 'Quoted reply here.');
});

test('cleanReply drops preambles, chat-template tokens and invented user turns', () => {
  assert.equal(cleanReply("Here's my reply:\n\nThat sounds hard. Why?"), 'That sounds hard. Why?');
  assert.equal(cleanReply('Sure! Here is a response:\nThat sounds hard.'), 'That sounds hard.');
  assert.equal(cleanReply('That sounds hard. Why?\n\nUser: because'), 'That sounds hard. Why?');
  assert.equal(cleanReply('That sounds hard. Why?\n**User:** because\nAssistant: ok'), 'That sounds hard. Why?');
  assert.equal(cleanReply('Hi there.<|im_end|>\n<|im_start|>user\nmore'), 'Hi there.');
  assert.equal(cleanReply('<|im_start|>assistant\nHi there<|im_end|>'), 'Hi there');
  assert.equal(cleanReply('Hello.</s>'), 'Hello.');
  assert.equal(cleanReply('Hello.<end_of_turn>\n<start_of_turn>user'), 'Hello.');
  assert.equal(cleanReply('<start_of_turn>model\nHello.'), 'Hello.');
  assert.equal(cleanReply('Hello <|weird|> world'), 'Hello  world');
});

test('cleanReply normalises whitespace but keeps markdown-lite', () => {
  assert.equal(cleanReply('  a\r\n\r\n\r\n\r\nb  \r\n'), 'a\n\nb');
  assert.equal(cleanReply('**Bold** and *soft*\n\n- one\n- two  \n'), '**Bold** and *soft*\n\n- one\n- two');
  assert.equal(cleanReply('\n\n\tindented? \n'), 'indented?');
  assert.equal(cleanReply('a\u0000b​c'), 'abc');
});

test('cleanReply tolerates non-strings and keeps unicode', () => {
  for (const v of [undefined, null, 5, {}, []]) assert.equal(cleanReply(v), '');
  assert.equal(cleanReply('Qué difícil \u{1F625}. ¿Qué pasó?'), 'Qué difícil \u{1F625}. ¿Qué pasó?');
  assert.equal(cleanReply('今日は大変でしたね。何がありましたか？'), '今日は大変でしたね。何がありましたか？');
  assert.equal(cleanReply('x'.repeat(200_000)).length, 200_000);
});

test('stripThinking and looksLikeRefusal', () => {
  assert.equal(stripThinking('a<think>b</think>c'), 'ac');
  assert.equal(stripThinking(42), '');
  for (const r of ["I'm sorry, but I can't help with that.", 'I cannot assist with this request.', 'As an AI language model, I do not have feelings.', 'Sorry, I am unable to do that.', 'Unfortunately, I cannot comply.', 'Lo siento, no puedo ayudar.']) {
    assert.equal(looksLikeRefusal(r), true, r);
  }
  for (const ok of ['Title: Sorry, not sorry', 'I can see why that hurt.', 'Cannot wait for Friday', '']) assert.equal(looksLikeRefusal(ok), false, ok);
});

// ------------------------------------------------------------------------------------------------ parseMeta

const USER_TEXT = 'I was so anxious about the presentation today. My manager Dan was supportive though, and I felt relieved afterwards.';

/** [name, model output, expected fields (only the listed ones are checked), parse options] */
const META_SAMPLES = [
  ['clean four lines', 'Title: Presentation nerves\nSummary: Felt anxious before presenting, then relieved.\nEmotions: anxious, relieved\nTags: work, presentation',
    { title: 'Presentation nerves', summary: 'Felt anxious before presenting, then relieved.', emotions: ['anxious', 'relieved'], tags: ['work', 'presentation'] }],
  ['bold labels', '**Title:** Presentation nerves\n**Summary:** Felt anxious, then relieved.\n**Emotions:** anxious, relieved\n**Tags:** work',
    { title: 'Presentation nerves', summary: 'Felt anxious, then relieved.', emotions: ['anxious', 'relieved'], tags: ['work'] }],
  ['bold label with the colon inside', '**Title**: Presentation nerves\n**Summary**: Felt anxious.\n**Emotions**: anxious\n**Tags**: work',
    { title: 'Presentation nerves', emotions: ['anxious'], tags: ['work'] }],
  ['lower case labels', 'title: Presentation nerves\nsummary: Felt anxious.\nemotions: anxious, relieved\ntags: work, dan',
    { title: 'Presentation nerves', emotions: ['anxious', 'relieved'], tags: ['work', 'dan'] }],
  ['UPPER CASE labels', 'TITLE: PRESENTATION NERVES\nSUMMARY: FELT ANXIOUS.\nEMOTIONS: ANXIOUS\nTAGS: WORK',
    { title: 'PRESENTATION NERVES', emotions: ['anxious'], tags: ['work'] }],
  ['missing colon, capitalised labels', 'Title Presentation nerves\nSummary Felt anxious but supported.\nEmotions anxious, relieved\nTags work',
    { title: 'Presentation nerves', summary: 'Felt anxious but supported.', emotions: ['anxious', 'relieved'], tags: ['work'] }],
  ['missing colon, lower case labels', 'title my day at the beach\nsummary we swam all day\nemotions happy\ntags beach',
    { title: 'My day at the beach', summary: 'We swam all day', emotions: ['happy'], tags: ['beach'] }],
  ['dash instead of colon', 'Title - Presentation nerves\nSummary - Felt anxious.\nEmotions - anxious\nTags - work',
    { title: 'Presentation nerves', emotions: ['anxious'], tags: ['work'] }],
  ['equals sign', 'Title = Presentation nerves\nTags = work, talk', { title: 'Presentation nerves', tags: ['work', 'talk'] }],
  ['chatter before and after', "Sure! Here is the information you asked for:\n\nTitle: Presentation nerves\nSummary: Felt anxious.\nEmotions: anxious\nTags: work\n\nLet me know if you'd like anything else!",
    { title: 'Presentation nerves', emotions: ['anxious'], tags: ['work'] }],
  ['chatter directly after the last label', 'Title: Presentation nerves\nSummary: Felt anxious.\nEmotions: anxious\nTags: work, talk\nHope this helps! Let me know.',
    { tags: ['work', 'talk'] }],
  ['numbered list', '1. Title: Presentation nerves\n2. Summary: Felt anxious.\n3. Emotions: anxious, relieved\n4. Tags: work',
    { title: 'Presentation nerves', emotions: ['anxious', 'relieved'], tags: ['work'] }],
  ['numbered with parentheses', '1) Title: Presentation nerves\n2) Tags: work', { title: 'Presentation nerves', tags: ['work'] }],
  ['bullets', '- Title: Presentation nerves\n- Summary: Felt anxious.\n- Emotions: anxious\n- Tags: work',
    { title: 'Presentation nerves', emotions: ['anxious'], tags: ['work'] }],
  ['asterisk bullets with bold labels', '* **Title:** Presentation nerves\n* **Emotions:** anxious, relieved', { title: 'Presentation nerves', emotions: ['anxious', 'relieved'] }],
  ['quotes around the title', 'Title: "Presentation nerves"\nSummary: Felt anxious.', { title: 'Presentation nerves' }],
  ['curly quotes around the title', 'Title: “Presentation nerves”', { title: 'Presentation nerves' }],
  ['single quotes around the title', "Title: 'Presentation nerves'", { title: 'Presentation nerves' }],
  ['guillemets around the title', 'Titre : «Une présentation stressante»', { title: 'Une présentation stressante' }],
  ['trailing full stop on the title', 'Title: Presentation nerves.\nSummary: Felt anxious.', { title: 'Presentation nerves' }],
  ['markdown heading title', '## Title: Presentation nerves\nSummary: x', { title: 'Presentation nerves' }],
  ['parenthetical after the label', 'Title (2 to 6 words): Presentation nerves\nTags (comma separated): work, talk', { title: 'Presentation nerves', tags: ['work', 'talk'] }],
  ['JSON object', '{"title": "Presentation nerves", "summary": "Felt anxious.", "emotions": ["anxious", "relieved"], "tags": ["work"]}',
    { title: 'Presentation nerves', summary: 'Felt anxious.', emotions: ['anxious', 'relieved'], tags: ['work'] }],
  ['JSON in a code fence with capitalised keys', '```json\n{\n  "Title": "Presentation nerves",\n  "Summary": "Felt anxious.",\n  "Emotions": "anxious, relieved",\n  "Tags": ["work"]\n}\n```',
    { title: 'Presentation nerves', emotions: ['anxious', 'relieved'], tags: ['work'] }],
  ['broken JSON with a trailing comma', '{"title": "Presentation nerves", "emotions": ["anxious", "relieved"], "tags": ["work"],}', { title: 'Presentation nerves', emotions: ['anxious', 'relieved'], tags: ['work'] }],
  ['JSON-ish lines without braces', '"title": "Presentation nerves",\n"summary": "Felt anxious.",\n"emotions": ["anxious", "relieved"],\n"tags": ["work"]',
    { title: 'Presentation nerves', summary: 'Felt anxious.', emotions: ['anxious', 'relieved'], tags: ['work'] }],
  ['YAML style', 'title: Presentation nerves\nsummary: Felt anxious.\nemotions: [anxious, relieved]\ntags: [work, talk]',
    { title: 'Presentation nerves', emotions: ['anxious', 'relieved'], tags: ['work', 'talk'] }],
  ['refusal, no labels', "I'm sorry, but I can't help with that request.", { title: 'I was so anxious about the presentation today', emotions: ['anxious', 'relieved'], tags: [] }],
  ['refusal inside a label', 'Title: I cannot provide a title for this entry.\nSummary: I am unable to summarise.\nEmotions: anxious\nTags: work',
    { title: 'I was so anxious about the presentation today', emotions: ['anxious'], tags: ['work'] }],
  ['rambling paragraph', 'This entry is about a person who feels anxious about a presentation and then relieved because their manager was supportive. It shows how important good support is at work.',
    { title: 'I was so anxious about the presentation today', emotions: ['anxious', 'relieved'], tags: [] }],
  ['"Summary of the day" is prose, not a label', 'Summary of the day: it was fine overall.\nTitle: Presentation nerves', { title: 'Presentation nerves' }],
  ['label word inside a sentence', 'The title: Presentation nerves would suit it.', { title: 'I was so anxious about the presentation today' }],
  ['Spanish labels', 'Título: Nervios antes de presentar\nResumen: Se sintió ansioso y luego aliviado.\nEmociones: ansioso, aliviado\nEtiquetas: trabajo, presentación',
    { title: 'Nervios antes de presentar', emotions: ['ansioso', 'aliviado'], tags: ['trabajo', 'presentación'] }],
  ['French labels with accents', 'Titre : Une présentation stressante\nRésumé : Anxieux puis soulagé.\nÉmotions : anxieux, soulagé\nÉtiquettes : travail', { title: 'Une présentation stressante', tags: ['travail'] }],
  ['German labels', 'Titel: Nervosität vor dem Vortrag\nZusammenfassung: Erst nervös, dann erleichtert.\nGefühle: nervös, erleichtert\nSchlagwörter: Arbeit', { title: 'Nervosität vor dem Vortrag', emotions: ['nervös', 'erleichtert'], tags: ['arbeit'] }],
  ['Portuguese labels', 'Título: Nervosismo antes da apresentação\nEmoções: ansioso, aliviado\nEtiquetas: trabalho', { title: 'Nervosismo antes da apresentação', emotions: ['ansioso', 'aliviado'], tags: ['trabalho'] }],
  ['Chinese labels with fullwidth colon and comma', '标题：今天的演讲\n摘要：演讲前很紧张，之后松了口气。\n情绪：紧张，放松\n标签：工作，演讲',
    { title: '今天的演讲', emotions: ['紧张', '放松'], tags: ['工作', '演讲'] }],
  ['Japanese labels', 'タイトル：発表の日\n要約：緊張したが安心した。\n感情：不安、安心\nタグ：仕事、発表', { title: '発表の日', emotions: ['不安', '安心'], tags: ['仕事', '発表'] }],
  ['Korean labels', '제목: 발표 날\n요약: 긴장했지만 안도했다.\n감정: 불안, 안도\n태그: 일, 발표', { title: '발표 날', emotions: ['불안', '안도'], tags: ['일', '발표'] }],
  ['Russian labels with a two-word label', 'Заголовок: День выступления\nКраткое содержание: Волновался, потом выдохнул.\nЭмоции: тревога, облегчение\nТеги: работа, выступление',
    { title: 'День выступления', summary: 'Волновался, потом выдохнул.', emotions: ['тревога', 'облегчение'], tags: ['работа', 'выступление'] }],
  ['Italian labels', 'Titolo: Giorno della presentazione\nRiassunto: Ansia prima, sollievo dopo.\nEmozioni: ansia, sollievo\nTag: lavoro', { title: 'Giorno della presentazione', emotions: ['ansia', 'sollievo'], tags: ['lavoro'] }],
  ['English labels, non-English values', 'Title: 今日のプレゼン\nSummary: 締張したが安心した。\nEmotions: 不安, 安心\nTags: 仕事', { title: '今日のプレゼン', emotions: ['不安', '安心'], tags: ['仕事'] }],
  ['emotions written as a sentence', 'Title: Nerves\nEmotions: The writer felt anxious and then relieved after the presentation', { emotions: ['anxious', 'relieved'] }],
  ['emotions as a bulleted list under the label', 'Title: Nerves\nEmotions:\n- anxious\n- relieved\n- supported\nTags:\n- work\n- talk', { emotions: ['anxious', 'relieved', 'supported'], tags: ['work', 'talk'] }],
  ['emotions with intensities', 'Emotions: anxious (7/10), relieved (4/10)', { emotions: ['anxious', 'relieved'] }],
  ['emotions joined by "and"', 'Emotions: anxious and relieved', { emotions: ['anxious', 'relieved'] }],
  ['emotions with a trailing period and capitals', 'Emotions: Anxious, Relieved.', { emotions: ['anxious', 'relieved'] }],
  ['emotions that is only a number', 'Title: Nerves\nEmotions: 4/5\nTags: work', { emotions: ['anxious', 'relieved'], tags: ['work'] }],
  ['"none" values', 'Title: none\nSummary: N/A\nEmotions: none\nTags: n/a', { title: 'I was so anxious about the presentation today', emotions: ['anxious', 'relieved'], tags: [] }],
  ['hashtags in tags', 'Tags: #work, #Presentation, #dan', { tags: ['work', 'presentation', 'dan'] }],
  ['tags as sentences are dropped', 'Tags: this is a very long sentence about nothing in particular, work', { tags: ['work'] }],
  ['too many tags are capped', 'Tags: a1, b2, c3, d4, e5, f6, g7, h8, i9', { tags: ['a1', 'b2', 'c3', 'd4', 'e5'] }],
  ['wrapped summary', 'Title: Nerves\nSummary: Felt anxious before presenting\nbut relieved at the end.\nEmotions: anxious', { summary: 'Felt anxious before presenting but relieved at the end.', emotions: ['anxious'] }],
  ['summary longer than two sentences is cut to two', 'Summary: One thing happened. Another thing happened. A third thing happened. A fourth.', { summary: 'One thing happened. Another thing happened.' }],
  ['very long title is shortened', `Title: ${'word '.repeat(40)}end\nSummary: ok.`, null],
  ['title missing but the rest present', 'Summary: Felt anxious.\nEmotions: anxious\nTags: work', { title: 'I was so anxious about the presentation today', summary: 'Felt anxious.', tags: ['work'] }],
  ['only a title present', 'Title: Presentation nerves', { title: 'Presentation nerves', emotions: ['anxious', 'relieved'], tags: [] }],
  ['duplicate labels: the first wins', 'Title: First\nTitle: Second\nTags: a\nTags: b', { title: 'First', tags: ['a'] }],
  ['labels in a different order', 'Tags: work\nEmotions: anxious\nSummary: Felt anxious.\nTitle: Presentation nerves', { title: 'Presentation nerves', tags: ['work'], emotions: ['anxious'] }],
  ['blank lines between labels', '**Title:** Presentation nerves\n\n**Summary:** Felt anxious.\n\n**Emotions:** anxious\n\n**Tags:** work', { title: 'Presentation nerves', summary: 'Felt anxious.', emotions: ['anxious'], tags: ['work'] }],
  ['CRLF line endings', 'Title: Presentation nerves\r\nSummary: Felt anxious.\r\nEmotions: anxious\r\nTags: work\r\n', { title: 'Presentation nerves', emotions: ['anxious'], tags: ['work'] }],
  ['think block first', '<think>Let me think about the title...</think>\nTitle: Presentation nerves\nTags: work', { title: 'Presentation nerves', tags: ['work'] }],
  ['role prefix first', 'Assistant:\nTitle: Presentation nerves\nTags: work', { title: 'Presentation nerves', tags: ['work'] }],
  ['code fence around the four lines', '```\nTitle: Presentation nerves\nSummary: Felt anxious.\nEmotions: anxious\nTags: work\n```', { title: 'Presentation nerves', tags: ['work'] }],
  ['emoji in values', 'Title: Big day \u{1F389}\nEmotions: anxious \u{1F630}, relieved \u{1F60C}\nTags: work', { title: 'Big day \u{1F389}', tags: ['work'] }],
  ['placeholder echoed from the instructions', 'Title: a title of 2 to 6 words\nSummary: one or two short sentences\nEmotions: 1 to 4 feelings\nTags: 1 to 4 topics',
    { title: 'I was so anxious about the presentation today', emotions: ['anxious', 'relieved'], tags: [] }],
  ['empty string', '', { title: 'I was so anxious about the presentation today', emotions: ['anxious', 'relieved'], tags: [] }],
  ['only whitespace', '  \n\t\n', { title: 'I was so anxious about the presentation today', tags: [] }],
  ['the example copied word for word', `Title: ${META_EXAMPLE.title}\nSummary: ${META_EXAMPLE.summary}\nEmotions: ${META_EXAMPLE.emotions}\nTags: ${META_EXAMPLE.tags}`,
    { title: 'I was so anxious about the presentation today', emotions: ['anxious', 'relieved'], tags: [] }],
  ['a bare "mood" label holding a number is not an emotion list', 'Mood: 4/5\nTitle: Nerves', { title: 'Nerves', emotions: ['anxious', 'relieved'] }],
];

test('parseMeta: at least 40 malformed model outputs are handled', () => {
  assert.ok(META_SAMPLES.length >= 40, `only ${META_SAMPLES.length} samples`);
});

for (const [name, output, expected] of META_SAMPLES) {
  test(`parseMeta fuzz: ${name}`, () => {
    const result = parseMeta(output, { userText: USER_TEXT });
    assert.deepEqual(Object.keys(result).sort(), ['emotions', 'summary', 'tags', 'title']);
    assert.equal(typeof result.title, 'string');
    assert.equal(typeof result.summary, 'string');
    assert.ok(Array.isArray(result.emotions) && Array.isArray(result.tags));
    assert.ok(result.emotions.length <= 5 && result.tags.length <= 5);
    for (const label of [...result.emotions, ...result.tags]) {
      assert.equal(label, label.toLowerCase(), `label not lower case: ${label}`);
      assert.ok(Array.from(label).length <= 24, `label too long: ${label}`);
    }
    assert.ok(Array.from(result.title).length <= 80, 'title length');
    assert.ok(Array.from(result.summary).length <= 280, 'summary length');
    assert.ok(!/[\n\r]/.test(result.title + result.summary), 'single line values');
    assert.ok(!/^["'“]|["'”]$/.test(result.title), `title keeps quotes: ${result.title}`);
    assert.ok(!/\*\*|__/.test(result.title + result.summary), 'no markdown emphasis left');
    if (expected) {
      for (const [field, value] of Object.entries(expected)) {
        if (value !== undefined) assert.deepEqual(result[field], value, `${field}`);
      }
    }
  });
}

test('parseMeta: a very long title is cut at a word boundary', () => {
  const { title } = parseMeta(`Title: ${'word '.repeat(40)}end`);
  assert.ok(Array.from(title).length <= 60);
  assert.ok(!title.endsWith(' '));
  assert.match(title, /^Word( word)*$/);
});

test('parseMeta fallbacks: title, summary, emotions and tags without any model output', () => {
  const r = parseMeta('', { userText: USER_TEXT });
  assert.equal(r.title, 'I was so anxious about the presentation today');
  assert.equal(r.summary, 'I was so anxious about the presentation today. My manager Dan was supportive though, and I felt relieved afterwards.');
  assert.deepEqual(r.emotions, ['anxious', 'relieved']);
  assert.deepEqual(r.tags, []);
});

test('parseMeta fallback title: option, first message, sentence boundary, long text', () => {
  assert.equal(parseMeta('', { fallbackTitle: 'My own title' }).title, 'My own title');
  assert.equal(parseMeta('', { fallbackTitle: 'my own title.' }).title, 'My own title');
  assert.equal(parseMeta('', { userText: 'second part', firstMessage: 'Walk in the park. It was nice.' }).title, 'Walk in the park');
  assert.equal(parseMeta('', { userText: 'ugh' }).title, 'Ugh');
  const long = parseMeta('', { userText: `${'Today I walked to the market and bought apples and pears and plums '.repeat(3)}.` }).title;
  assert.ok(Array.from(long).length <= 48 && long.length > 10, long);
  assert.ok(!long.endsWith(' '));
  assert.equal(parseMeta('', {}).title, '');
  assert.equal(parseMeta(undefined).summary, '');
  assert.deepEqual(parseMeta(null), { title: '', summary: '', emotions: [], tags: [] });
});

test('parseMeta fallback summary is short, on one line and at most 200 characters', () => {
  const text = `${'A fairly long sentence about nothing in particular that keeps going. '.repeat(10)}`;
  const { summary } = parseMeta('', { userText: text });
  assert.ok(Array.from(summary).length <= 200);
  assert.ok(!summary.includes('\n'));
  const multi = parseMeta('', { userText: 'Ugh.\n\nI did not want to go.\n\nThen lunch happened.' }).summary;
  assert.ok(!multi.includes('\n'));
  assert.ok(multi.startsWith('Ugh.'));
});

test('parseMeta never throws on hostile input', () => {
  const hostile = ['{'.repeat(10000), '}'.repeat(10000), '"'.repeat(10001), '[[[['.repeat(2000), 'Title:'.repeat(5000), `Title: ${'\u{1F600}'.repeat(5000)}`,
    '\u0000\u0001Title:\u0002 x', '<think>'.repeat(5000), '```'.repeat(5000), 'Tags: ' + ','.repeat(100000), '\n'.repeat(100000), 'Emotions: ' + 'sad '.repeat(50000), '{"title": {"a": 1}, "tags": 5}', '[1,2,3]', 'null', '{"title":null}'];
  const t0 = Date.now();
  for (const h of hostile) {
    const r = parseMeta(h, { userText: 'I felt sad' });
    assert.equal(typeof r.title, 'string');
    assert.ok(Array.isArray(r.emotions));
  }
  assert.ok(Date.now() - t0 < 4000, 'must stay fast');
  for (const v of [undefined, null, 5, {}, [], true]) assert.equal(typeof parseMeta(v).title, 'string');
});

// ------------------------------------------------------------------------------------------------ detectEmotions

test('detectEmotions: lexicon, order, negation, languages', () => {
  assert.deepEqual(detectEmotions('I felt anxious and tired, but then proud.', 3), ['anxious', 'tired', 'proud']);
  assert.deepEqual(detectEmotions('I felt anxious and tired, but then proud.', 2), ['anxious', 'tired']);
  assert.deepEqual(detectEmotions("I'm not happy about this."), []);
  assert.deepEqual(detectEmotions('never felt so grateful'), ['grateful']);
  assert.deepEqual(detectEmotions("Can't wait for the weekend!"), ['excited']);
  assert.deepEqual(detectEmotions('Please write this down for me'), [], '"down" alone is not an emotion');
  assert.deepEqual(detectEmotions('I feel down today'), ['sad']);
  assert.deepEqual(detectEmotions('Estoy muy cansado y triste'), ['tired', 'sad']);
  assert.deepEqual(detectEmotions('Je suis fatigué et stressé'), ['tired', 'stressed']);
  assert.deepEqual(detectEmotions('Ich bin müde und traurig'), ['tired', 'sad']);
  assert.deepEqual(detectEmotions('Estou cansada mas feliz'), ['tired', 'happy']);
  assert.deepEqual(detectEmotions('ANXIOUS'), ['anxious']);
  assert.deepEqual(detectEmotions('\u4eca\u5929\u5f88\u5f00\u5fc3\uff0c\u4f46\u662f\u4e5f\u6709\u70b9\u7126\u8651\u3002'), ['\u5f00\u5fc3', '\u7126\u8651'], 'CJK words are returned in their own language');
  assert.deepEqual(detectEmotions('\u4eca\u65e5\u306f\u5c11\u3057\u75b2\u308c\u305f\u3051\u3069\u3001\u5b09\u3057\u3044'), ['\u75b2\u308c', '\u5b09\u3057\u3044']);
  assert.deepEqual(detectEmotions(''), []);
  assert.deepEqual(detectEmotions(null), []);
  assert.deepEqual(detectEmotions('I hurt my knee'), [], 'physical hurt is not emotional');
  assert.deepEqual(detectEmotions('I loved the movie'), [], 'loving a movie is not feeling loved');
  assert.deepEqual(detectEmotions('I lost my keys'), []);
  assert.deepEqual(detectEmotions('blood pressure check'), []);
});

// ------------------------------------------------------------------------------------------------ parseMemoryLines

test('parseMemoryLines keeps durable personal facts', () => {
  assert.deepEqual(parseMemoryLines('- Has a younger sister called Maya\n- Works as a nurse\n- Is training for a half marathon'),
    ['Has a younger sister called Maya', 'Works as a nurse', 'Is training for a half marathon']);
  assert.deepEqual(parseMemoryLines('- Lives in Lisbon'), ['Lives in Lisbon']);
  assert.deepEqual(parseMemoryLines('* Has two cats\n* Plays the cello'), ['Has two cats', 'Plays the cello']);
  assert.deepEqual(parseMemoryLines('• Studies law at night'), ['Studies law at night']);
  assert.deepEqual(parseMemoryLines('1. Works as a nurse.\n2) Has two cats.'), ['Works as a nurse', 'Has two cats']);
  assert.deepEqual(parseMemoryLines('Has a younger sister called Maya.'), ['Has a younger sister called Maya'], 'a bare line is accepted when there are no bullets');
});

test('parseMemoryLines: none, n/a and friends mean no facts', () => {
  for (const none of ['none', 'None', 'None.', 'NONE', 'n/a', 'N/A', 'No new facts', 'no new facts.', 'Nothing', 'Nothing new', 'nothing to add', '- none', '- None.', '* n/a',
    'No facts', 'No lasting facts.', 'There are no new facts.', 'Not applicable', '"none"', '**none**', 'None\n\nNote: the entry only describes feelings.', '', '   ', '<think>hmm</think>none']) {
    assert.deepEqual(parseMemoryLines(none), [], JSON.stringify(none));
  }
  for (const v of [undefined, null, 5, {}]) assert.deepEqual(parseMemoryLines(v), []);
});

test('parseMemoryLines drops questions, advice, instructions and chatter', () => {
  const output = [
    "Here are the facts I found:",
    '- Has a younger sister called Maya',
    '- Does she have any siblings?',
    '- Try journaling every morning',
    '- Remember to call your sister',
    '- You should take a break',
    '- Consider talking to a friend',
    '- Take a deep breath',
    '- Maybe wants to move abroad',
    'Note: these are only guesses.',
  ].join('\n');
  assert.deepEqual(parseMemoryLines(output), ['Has a younger sister called Maya']);
});

test('parseMemoryLines drops feelings, one-day states, events, guesses and secrets', () => {
  const dropped = [
    '- Feels sad today', '- Felt overwhelmed at work', '- Is stressed about the presentation', '- Is feeling anxious', '- Is tired', '- Was angry at Dan',
    '- Seems to be lonely', '- Is excited about tomorrow\'s trip', '- Has a meeting this afternoon', '- Needs to relax tonight', '- Had a fight with Maya', '- Went to the gym',
    '- Might be getting a promotion', '- Probably dislikes mornings', '- Has been feeling low lately', '- Has had a hard day', '- Thinks the weekend is too short',
    '- Password is hunter2', '- Has the phone number 5551234567', '- Email is sam@example.com', '- Mentioned https://example.com/me', '- Is a', '- Okay',
    '- You love running', '- Your sister is Maya', '- Wants to rest right now',
  ];
  for (const line of dropped) assert.deepEqual(parseMemoryLines(line), [], line);
});

test('parseMemoryLines rewrites first person and "the user" into the neutral third person', () => {
  assert.deepEqual(parseMemoryLines('- I work as a nurse'), ['Works as a nurse']);
  assert.deepEqual(parseMemoryLines("- I'm a teacher"), ['Is a teacher']);
  assert.deepEqual(parseMemoryLines("- I'm training for a marathon"), ['Is training for a marathon']);
  assert.deepEqual(parseMemoryLines('- I have two cats'), ['Has two cats']);
  assert.deepEqual(parseMemoryLines("- I've got a twin brother"), ['Has a twin brother']);
  assert.deepEqual(parseMemoryLines('- I live in Berlin'), ['Lives in Berlin']);
  assert.deepEqual(parseMemoryLines('- I play the cello'), ['Plays the cello']);
  assert.deepEqual(parseMemoryLines('- I study biology'), ['Studies biology']);
  assert.deepEqual(parseMemoryLines('- My sister is called Maya'), ['Their sister is called Maya']);
  assert.deepEqual(parseMemoryLines('- The user has two cats'), ['Has two cats']);
  assert.deepEqual(parseMemoryLines('- User works as a nurse'), ['Works as a nurse']);
  assert.deepEqual(parseMemoryLines('- The writer lives in Lisbon.'), ['Lives in Lisbon']);
  assert.deepEqual(parseMemoryLines('- Sam has two cats', { userName: 'Sam' }), ['Has two cats']);
  assert.deepEqual(parseMemoryLines("- Sam's sister is called Maya", { userName: 'Sam' }), ['Their sister is called Maya']);
  assert.deepEqual(parseMemoryLines('- Dan is her brother', { userName: 'Sam' }), [], 'a fact about someone else is not a fact about the user');
  assert.deepEqual(parseMemoryLines('- Sam has two cats'), [], 'a name is not removed unless it is the user\'s');
  assert.deepEqual(parseMemoryLines("- The user's sister Maya works as a nurse"), ['Their sister Maya works as a nurse']);
  assert.deepEqual(parseMemoryLines("- The user's sister is called Maya"), ['Their sister is called Maya']);
  assert.deepEqual(parseMemoryLines('- She works as a nurse'), ['Works as a nurse']);
});

test('parseMemoryLines dedupes against existing memories and within the output', () => {
  const existing = ['Has a younger sister called Maya', { text: 'Works as a nurse', pinned: true }];
  assert.deepEqual(parseMemoryLines('- Has a younger sister called Maya\n- Works as a nurse\n- Has two cats', { existing }), ['Has two cats']);
  assert.deepEqual(parseMemoryLines('- has a younger sister called maya.', { existing }), []);
  assert.deepEqual(parseMemoryLines('- Their sister is called Maya', { existing }), [], 'reworded duplicate');
  assert.deepEqual(parseMemoryLines('- Works as a nurse at night', { existing }), [], 'a longer version of a known fact');
  assert.deepEqual(parseMemoryLines('- Has two cats\n- has two cats\n- Has two cats.'), ['Has two cats']);
  assert.deepEqual(parseMemoryLines('- Has two cats', { existing: [null, 5, {}, 'unrelated'] }), ['Has two cats']);
  assert.deepEqual(parseMemoryLines('- Has two cats', { existing: 'not an array' }), ['Has two cats']);
});

test('parseMemoryLines: at most 3 facts of at most 200 characters', () => {
  const four = '- Has two cats\n- Plays the cello\n- Lives in Lisbon\n- Works as a nurse';
  assert.equal(parseMemoryLines(four).length, 3);
  const long = `- Has ${'a very long description '.repeat(12)}`;
  assert.deepEqual(parseMemoryLines(`${long}\n- Has two cats`), ['Has two cats'], 'an over-long line is dropped, not cut');
  const exactly = `Has ${'x'.repeat(196)}`;
  assert.equal(exactly.length, 200);
  assert.equal(parseMemoryLines(`- ${exactly}`).length, 1);
  assert.equal(parseMemoryLines(`- ${exactly}y`).length, 0);
});

test('parseMemoryLines: rambling without bullets yields nothing', () => {
  const rambling = 'The entry talks about the day.\nIt mentions many things.\nThere is a lot of detail.\nIt is hard to say.\nOverall it was a day.';
  assert.deepEqual(parseMemoryLines(rambling), []);
});

test('parseMemoryLines: grounding in the entry text', () => {
  const entry = 'My sister Maya called. I told her about the night shifts at the hospital.';
  assert.deepEqual(parseMemoryLines('- Has a sister called Maya\n- Works night shifts\n- Is training for a half marathon', { userText: entry }),
    ['Has a sister called Maya', 'Works night shifts'], 'the marathon fact is not in the entry');
  assert.deepEqual(parseMemoryLines('- Has a sister called Maya', { userText: 'I had a quiet day.' }), []);
  assert.deepEqual(parseMemoryLines('- Has a younger sister called Maya', { userText: '' }), ['Has a younger sister called Maya'], 'no text, no check');
  assert.deepEqual(parseMemoryLines('- Works as a nurse', { userText: "I'm a nurse on the ward" }), ['Works as a nurse']);
  assert.deepEqual(parseMemoryLines('- Is a night-shift worker', { userText: 'I work nights' }), ['Is a night-shift worker']);
});

test('parseMemoryLines works for entries in other languages', () => {
  assert.deepEqual(parseMemoryLines('- Tiene una hermana llamada Maya\n- Trabaja como enfermera'), ['Tiene una hermana llamada Maya', 'Trabaja como enfermera']);
  assert.deepEqual(parseMemoryLines('- A une s\u0153ur qui s\u2019appelle Maya'), ['A une s\u0153ur qui s\u2019appelle Maya']);
  assert.deepEqual(parseMemoryLines('- Hat eine Schwester namens Maya'), ['Hat eine Schwester namens Maya']);
  assert.deepEqual(parseMemoryLines('- \u6709\u4e00\u4e2a\u59b9\u59b9\u53ebMaya'), ['\u6709\u4e00\u4e2a\u59b9\u59b9\u53ebMaya']);
  assert.deepEqual(parseMemoryLines('- \u59b9\u306eMaya\u3068\u540c\u5c45\u3057\u3066\u3044\u308b'), ['\u59b9\u306eMaya\u3068\u540c\u5c45\u3057\u3066\u3044\u308b']);
  assert.deepEqual(parseMemoryLines('- Se siente triste hoy'), [], 'one-day states are dropped in Spanish too');
  assert.deepEqual(parseMemoryLines('- Quiz\u00e1s tiene un hermano'), [], 'hedged');
  assert.deepEqual(parseMemoryLines('- \u4eca\u5929\u5f88\u7d2f'), [], 'transient in Chinese');
  assert.deepEqual(parseMemoryLines('- \u00bfTiene hermanos?'), [], 'a question');
  for (const none of ['ninguno', 'Ninguna.', 'aucun', 'keine', 'nenhum', '\u6ca1\u6709', '\u306a\u3057', '\u2014 none']) assert.deepEqual(parseMemoryLines(none), [], none);
  const entry = 'Mi hermana Maya me llam\u00f3. Trabajo como enfermera en el hospital.';
  assert.deepEqual(parseMemoryLines('- Tiene una hermana llamada Maya\n- Trabaja como enfermera\n- Tiene dos gatos', { userText: entry }), ['Tiene una hermana llamada Maya', 'Trabaja como enfermera'], 'grounding works in Spanish');
  assert.deepEqual(parseMemoryLines('- \u6709\u4e00\u4e2a\u59b9\u59b9\u53ebMaya\n- \u517b\u4e86\u4e24\u53ea\u732b', { userText: '\u6211\u59b9\u59b9Maya\u4eca\u5929\u6253\u7535\u8bdd\u7ed9\u6211' }), ['\u6709\u4e00\u4e2a\u59b9\u59b9\u53ebMaya'], 'grounding works in Chinese');
  assert.deepEqual(parseMemoryLines('- Try journaling daily'), [], 'English advice is still rejected');
  assert.deepEqual(parseMemoryLines('- Call your sister'), []);
});

test('parseMemoryLines: reasoning, fences and role prefixes around the list', () => {
  assert.deepEqual(parseMemoryLines('<think>let me see</think>\n- Has two cats'), ['Has two cats']);
  assert.deepEqual(parseMemoryLines('```\n- Has two cats\n```'), ['Has two cats']);
  assert.deepEqual(parseMemoryLines('Assistant:\n- Has two cats'), ['Has two cats']);
  assert.deepEqual(parseMemoryLines('Facts:\n- Has two cats'), ['Has two cats']);
  assert.deepEqual(parseMemoryLines('- **Has two cats**'), ['Has two cats']);
  assert.deepEqual(parseMemoryLines('- "Has two cats"'), ['Has two cats']);
  assert.deepEqual(parseMemoryLines('- Fact: Has two cats'), ['Has two cats']);
});

test('parseMemoryLines never throws on hostile input and stays fast', () => {
  const t0 = Date.now();
  for (const text of ['-'.repeat(100000), '- '.repeat(50000), '\n'.repeat(100000), `- ${'Has '.repeat(50000)}`, '\u0000\u0000', '- \u{1F600}'.repeat(10000), '<think>'.repeat(5000)]) {
    assert.ok(Array.isArray(parseMemoryLines(text, { existing: ['x'] })));
  }
  assert.ok(Date.now() - t0 < 3000);
});

// ------------------------------------------------------------------------------------------------ randomised robustness

test('randomised fragments: parsers never throw, outputs stay in bounds, cleanReply is idempotent', () => {
  const fragments = ['Assistant:', 'AI: ', '<think>', '</think>', '```', '"', '“', '”', '\n', '\n\n', 'Title:', 'Summary:', 'Emotions:', 'Tags:', '- ', '* ', '**', '1. ',
    'none', 'Reply:', 'User:', ' ', 'hello world', 'I feel sad.', '{', '}', '[', ']', ',', '<|im_end|>', 'Has a sister', "I'm sorry, but", '\u{1F600}', '\u0000', '#', '>', '(7/10)', 'n/a'];
  let seed = 12345;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0; // fixed LCG: the same inputs on every run
    return seed / 2 ** 32;
  };
  for (let i = 0; i < 4000; i += 1) {
    let text = '';
    const parts = 1 + Math.floor(random() * 10);
    for (let j = 0; j < parts; j += 1) text += fragments[Math.floor(random() * fragments.length)];
    const cleaned = cleanReply(text);
    assert.equal(cleaned, cleaned.trim(), JSON.stringify(text));
    assert.ok(!/<\/?think|<\|im_/i.test(cleaned), JSON.stringify(text));
    assert.equal(cleanReply(cleaned), cleaned, `not idempotent: ${JSON.stringify(text)}`);
    const meta = parseMeta(text, { userText: 'I felt sad today.' });
    assert.ok(meta.emotions.length <= 5 && meta.tags.length <= 5, JSON.stringify(text));
    assert.ok(Array.from(meta.title).length <= 80);
    const facts = parseMemoryLines(text, { existing: ['Has a sister'] });
    assert.ok(facts.length <= 3 && facts.every((f) => f.length <= 200 && !f.includes('\n')), JSON.stringify(text));
  }
});

// ------------------------------------------------------------------------------------------------ regressions from the adversarial review

const META_COPY = `Title: ${META_EXAMPLE.title}\nSummary: ${META_EXAMPLE.summary}\nEmotions: ${META_EXAMPLE.emotions}\nTags: ${META_EXAMPLE.tags}`;

test('parseMeta: the prompt example is a copy even when the entry shares a word with it ("got", "forgot", "rainy", "home")', () => {
  for (const userText of [
    'I got the results back and I did not pass. I feel awful and sad.',
    'I forgot my keys and we got together late. Feeling tired.',
    'It was a rainy afternoon and I stayed in bed all day feeling sad.',
    'Walked home alone. It was quiet and I felt lonely.',
  ]) {
    const r = parseMeta(META_COPY, { userText });
    assert.notEqual(r.title.toLowerCase(), META_EXAMPLE.title.toLowerCase(), userText);
    assert.ok(!/soaked|cheerful/i.test(r.summary), `summary copied: ${r.summary}`);
    assert.ok(!r.emotions.includes('cheerful') && !r.emotions.includes('free'), `emotions copied: ${r.emotions}`);
    assert.deepEqual(r.tags, [], `tags copied: ${r.tags}`);
  }
  const r = parseMeta(META_COPY, { userText: 'I got the results back and I did not pass. I feel awful and sad.' });
  assert.equal(r.title, 'I got the results back and I did not pass');
  assert.deepEqual(r.emotions, ['sad']);
});

test('parseMeta: the copy is recognised without the final full stop, with quotes or a different case', () => {
  const userText = 'I got the results back. I am so sad.';
  const out = `Title: "rainy bike ride home"\nSummary: ${META_EXAMPLE.summary.replace(/\.$/, '')}\nEmotions: Cheerful, Free\nTags: Cycling, Weather`;
  const r = parseMeta(out, { userText });
  assert.equal(r.title, 'I got the results back');
  assert.ok(!/soaked/i.test(r.summary));
  assert.deepEqual(r.emotions, ['sad']);
  assert.deepEqual(r.tags, []);
});

test('parseMeta: copied emotions or tags are dropped on their own, genuine title and summary are kept', () => {
  const userText = 'I failed my exam today and I am so sad about it.';
  const r = parseMeta('Title: Failed exam\nSummary: The exam went badly and the writer is sad.\nEmotions: cheerful, free\nTags: cycling, weather', { userText });
  assert.equal(r.title, 'Failed exam');
  assert.equal(r.summary, 'The exam went badly and the writer is sad.');
  assert.deepEqual(r.emotions, ['sad'], 'falls back to the lexicon');
  assert.deepEqual(r.tags, []);
  // only the title is a copy: the rest of the answer is still read
  const t = parseMeta(`Title: ${META_EXAMPLE.title}\nSummary: The exam went badly.\nEmotions: sad\nTags: school`, { userText });
  assert.equal(t.title, 'I failed my exam today and I am so sad about it');
  assert.equal(t.summary, 'The exam went badly.');
  assert.deepEqual(t.emotions, ['sad']);
  assert.deepEqual(t.tags, ['school']);
});

test('parseMeta: an entry that really contains the example text may use it', () => {
  const userText = `${META_EXAMPLE.summary} Rainy bike ride home, I felt cheerful and free.`;
  const r = parseMeta(META_COPY, { userText });
  assert.equal(r.title, META_EXAMPLE.title);
  assert.equal(r.summary, META_EXAMPLE.summary);
  assert.deepEqual(r.emotions, ['cheerful', 'free']);
  assert.deepEqual(r.tags, []);
  const partial = parseMeta('Emotions: cheerful, free\nTags: cycling, weather', { userText: 'I felt cheerful today, and free as a bird. Went cycling in the weather.' });
  assert.deepEqual(partial.emotions, ['cheerful', 'free']);
  assert.deepEqual(partial.tags, ['cycling', 'weather']);
});

test('parseMeta keeps ZWNJ / ZWJ inside titles, summaries and labels', () => {
  const persian = 'کتاب‌خانه';
  const r = parseMeta(`Title: ${persian}\nSummary: من به ${persian} رفتم.\nEmotions: خوشحال\nTags: ${persian}`);
  assert.equal(r.title, persian);
  assert.ok(r.summary.includes(persian));
  assert.deepEqual(r.tags, [persian]);
  assert.equal(parseMeta('', { fallbackTitle: persian }).title, persian);
  assert.equal(cleanReply(`${persian} \u{1F468}‍\u{1F469}‍\u{1F467}`), `${persian} \u{1F468}‍\u{1F469}‍\u{1F467}`);
});

test('parseMeta: emotions written as a sentence are rescued with the lexicon, not cut into fragments', () => {
  const cases = [
    ['The writer felt anxious and tired.', ['anxious', 'tired']],
    ['The writer felt anxious and tired after work.', ['anxious', 'tired']],
    ['frustrated with Dan and anxious about the report', ['frustrated', 'anxious']],
    ['The writer is anxious about work and tired of it.', ['anxious', 'tired']],
    ['felt anxious and tired', ['anxious', 'tired']],
    ['Feeling a bit down and worried about money.', ['sad', 'anxious']],
    ['anxious, relieved, feeling a little overwhelmed by the deadline', ['anxious', 'relieved', 'overwhelmed']],
    ['The user seems hopeful.', ['hopeful']],
  ];
  for (const [raw, expected] of cases) {
    assert.deepEqual(parseMeta(`Title: T\nEmotions: ${raw}`, { userText: 'x' }).emotions, expected, raw);
  }
  // Ordinary lists are untouched, including labels of up to three words.
  assert.deepEqual(parseMeta('Emotions: anxious, relieved').emotions, ['anxious', 'relieved']);
  assert.deepEqual(parseMeta('Emotions: calm, a bit tired').emotions, ['calm', 'a bit tired']);
  assert.deepEqual(parseMeta('Emotions: mixed emotions about the trip, bittersweet').emotions, ['bittersweet'], 'no lexicon hit: labels as before');
  assert.deepEqual(parseMeta('{"emotions": ["The writer felt anxious", "tired"]}').emotions, ['anxious', 'tired']);
});

test('parseMemoryLines: facts copied from the prompt examples are dropped unless the entry has their rare word', () => {
  const copied = '- Has a younger sister called Maya\n- Works as a nurse\n- Is training for a half marathon';
  assert.deepEqual(parseMemoryLines(copied, { userText: 'My sister called me today. I trained my dog at the park.' }), []);
  assert.deepEqual(parseMemoryLines(copied, { userText: 'The nurse at the clinic called my sister. I walked the dog and trained for work.' }), ['Works as a nurse'], 'the entry mentions a nurse, but no Maya and no marathon');
  assert.deepEqual(parseMemoryLines(copied, { userText: 'My younger sister Maya called me. I am a nurse. I am training for a half marathon in March.' }),
    ['Has a younger sister called Maya', 'Works as a nurse', 'Is training for a half marathon']);
  // The entry has the example's name (a real Maya), but not "younger": the model copied the rest of the example fact.
  assert.deepEqual(parseMemoryLines(copied, { userText: 'My sister Maya called me. I am a nurse. I am training for a half marathon in March.' }),
    ['Works as a nurse', 'Is training for a half marathon']);
  assert.deepEqual(parseMemoryLines('- Has a sister called Maya', { userText: 'My sister Maya called me.' }), ['Has a sister called Maya']);
  assert.deepEqual(parseMemoryLines('- Is training for a half marathon', { userText: 'I trained my dog at the park.' }), []);
  assert.deepEqual(parseMemoryLines('- is training for a half-marathon.', { userText: 'I trained my dog at the park.' }), [], 'reworded copy');
});

test('parseMemoryLines: names and numbers in a fact must occur in the entry', () => {
  const entry = 'My brother called me about the party. We have two cats and my partner Alex took them to the vet in Lisbon.';
  assert.deepEqual(parseMemoryLines('- Has a brother called Tom', { userText: entry }), [], 'Tom is invented');
  assert.deepEqual(parseMemoryLines('- Has a brother called Tom', { userText: `${entry} Tom says hi.` }), ['Has a brother called Tom']);
  assert.deepEqual(parseMemoryLines('- Lives in Berlin', { userText: entry }), [], 'Berlin is invented');
  assert.deepEqual(parseMemoryLines('- Lives in Lisbon', { userText: entry }), ['Lives in Lisbon']);
  assert.deepEqual(parseMemoryLines('- Has 3 cats', { userText: entry }), [], '3 is invented');
  assert.deepEqual(parseMemoryLines('- Has 2 cats', { userText: entry }), ['Has 2 cats'], 'a digit may stand for the number word in the entry');
  assert.deepEqual(parseMemoryLines('- Has two cats', { userText: entry }), ['Has two cats']);
  assert.deepEqual(parseMemoryLines('- Lives with their partner Alex', { userText: entry }), ['Lives with their partner Alex']);
  assert.deepEqual(parseMemoryLines('- Has a cat', { userText: 'Mi gato es negro, Lisboa es bonita' }), [], 'still needs a shared content word');
  // Capitalised nouns in German are not names: a prefix of the word is enough.
  assert.deepEqual(parseMemoryLines('- Arbeitet als Krankenschwester', { userText: 'Ich arbeite im Krankenhaus, nachts, als Schwester.' }), ['Arbeitet als Krankenschwester']);
});

test('parseMemoryLines: "Has been ..." and "Has had a ..." keep lasting facts and still drop passing states', () => {
  for (const kept of ['Has been diagnosed with ADHD', 'Has been married for five years', 'Has been a nurse for ten years', 'Has been vegetarian since 2015',
    'Has had a stroke', 'Has had a miscarriage', 'Has had a hard childhood', 'Has been sober for two years']) {
    assert.deepEqual(parseMemoryLines(`- ${kept}`), [kept], kept);
  }
  for (const dropped of ['Has been feeling low lately', 'Has had a hard day', 'Has had a rough week', 'Has been so tired', 'Has been very stressed', 'Has felt anxious',
    'Has been sad', 'Has had a bad night', 'Has been having a rough time']) {
    assert.deepEqual(parseMemoryLines(`- ${dropped}`), [], dropped);
  }
  assert.deepEqual(parseMemoryLines("- I've been a nurse for ten years"), ['Has been a nurse for ten years']);
  assert.deepEqual(parseMemoryLines("- I've been diagnosed with ADHD"), ['Has been diagnosed with ADHD']);
});

test('parseMemoryLines: first-person words never survive in a fact', () => {
  assert.deepEqual(parseMemoryLines('- I live with my partner Alex'), ['Lives with their partner Alex']);
  assert.deepEqual(parseMemoryLines('- I am a teacher at my old school'), ['Is a teacher at their old school']);
  assert.deepEqual(parseMemoryLines('- Lives with my partner Alex and our two cats'), ['Lives with their partner Alex and their two cats']);
  assert.deepEqual(parseMemoryLines('- I have a brother, Tom, and I talk to him weekly'), [], 'two clauses about the writer and someone else');
  assert.deepEqual(parseMemoryLines('- Teaches myself guitar'), []);
  assert.deepEqual(parseMemoryLines("- Is someone I'd trust"), []);
  // other languages: a lone possessive becomes the third person, a line in the writer's own voice is dropped
  assert.deepEqual(parseMemoryLines('- Le gusta el senderismo'), ['Le gusta el senderismo']);
  assert.deepEqual(parseMemoryLines('- Vive con mi pareja Alex'), ['Vive con su pareja Alex']);
  assert.deepEqual(parseMemoryLines('- Habite avec mon compagnon Alex'), ['Habite avec son compagnon Alex']);
  assert.deepEqual(parseMemoryLines('- Tengo una hermana llamada Maya'), []);
  assert.deepEqual(parseMemoryLines("- J'ai parlé à mon père au téléphone"), []);
});

test('parseMemoryLines: other people and noun fragments do not pass as facts about the writer', () => {
  const entry = 'Dan annoys me. My boss Dan is annoying and my brother Tom drinks too much. Exam stress is high. I need sleep. I want to quit.';
  for (const line of ['Dan annoys them', 'Boss Dan is annoying', 'Brother Tom drinks too much', 'Exam stress', 'Dan is her brother', 'Tom drinks too much']) {
    assert.deepEqual(parseMemoryLines(`- ${line}`, { userText: entry }), [], `with entry: ${line}`);
  }
  for (const line of ['Dan annoys them', 'Boss Dan is annoying', 'Brother Tom drinks too much']) {
    assert.deepEqual(parseMemoryLines(`- ${line}`), [], `without entry: ${line}`);
  }
  for (const line of ['I need sleep', 'I need more sleep', 'I need a break', 'I want to quit', 'I want to give up', 'I want to scream', 'Needs sleep', 'Wants to quit']) {
    assert.deepEqual(parseMemoryLines(`- ${line}`), [], line);
  }
  // lasting needs and goals are still facts
  assert.deepEqual(parseMemoryLines('- I need glasses to read'), ['Needs glasses to read']);
  assert.deepEqual(parseMemoryLines('- I want to move to Canada', { userText: 'I want to move to Canada one day.' }), ['Wants to move to Canada']);
  assert.deepEqual(parseMemoryLines('- Lives alone', { userText: 'I live alone in a small flat.' }), ['Lives alone']);
  assert.deepEqual(parseMemoryLines('- I do yoga every morning', { userText: 'I do yoga every morning before work.' }), ['Does yoga every morning']);
});

// ------------------------------------------------------------------------------------------------ prompt tuning (live-measured fixes)

test('parseMeta: the format placeholders of the prompt are never stored, bare or in angle brackets', () => {
  const echo = 'Title: <2 to 6 words>\nSummary: <one or two short sentences, without "I" or "you">\nEmotions: <1 to 4 feelings, separated by commas>\nTags: <1 to 4 topics, separated by commas>';
  const parsed = parseMeta(echo, { userText: 'Nothing much happened. Rainy day.', fallbackTitle: 'Rainy day' });
  assert.equal(parsed.title, 'Rainy day');
  assert.equal(parsed.summary, 'Nothing much happened. Rainy day.');
  assert.deepEqual(parsed.tags, []);
  assert.ok(!parsed.emotions.some((e) => /feeling|comma|\d/.test(e)), JSON.stringify(parsed.emotions));
  // Markup is the model's text, stored as text and never unwrapped or dropped.
  assert.equal(parseMeta('Title: <img src=x onerror=1>\nSummary: <script>x()</script> and more', { userText: 'x' }).title, '<img src=x onerror=1>');
  assert.equal(parseMeta('Title: <img src=x onerror=1>\nSummary: <script>x()</script> and more', { userText: 'x' }).summary, '<script>x()</script> and more');
  // Real content that a model wrapped in angle brackets is kept.
  assert.deepEqual(parseMeta('Title: <A quiet rainy day>\nSummary: <Stayed in and made pasta.>\nEmotions: <flat, calm>\nTags: <rest, home>', { userText: 'Rainy day.' }),
    { title: 'A quiet rainy day', summary: 'Stayed in and made pasta.', emotions: ['flat', 'calm'], tags: ['rest', 'home'] });
  // Each placeholder on its own, bare.
  for (const bare of ['2 to 6 words', '1 to 4 feelings, separated by commas', '1 to 4 topics, separated by commas', 'one or two short sentences']) {
    const r = parseMeta(`Title: ${bare}\nSummary: ${bare}\nEmotions: ${bare}\nTags: ${bare}`, { userText: 'Nothing much happened.', fallbackTitle: 'Fallback' });
    assert.equal(r.title, 'Fallback', bare);
    assert.ok(!/\d to \d|short sentences/.test(`${r.summary} ${r.emotions} ${r.tags}`), bare);
  }
});

test('parseMeta: a copied old example is still recognised when it comes back from a model', () => {
  const copy = 'Title: Rainy bike ride home\nSummary: Got soaked cycling home but felt free and cheerful by the end.\nEmotions: cheerful, free\nTags: cycling, weather\n\nFeeling: anxious\nTopic: performance';
  const r = parseMeta(copy, { userText: 'I presented the numbers and my hands shook.', firstMessage: 'I presented the numbers and my hands shook.' });
  assert.notEqual(r.title, 'Rainy bike ride home');
  assert.deepEqual(r.tags, []);
});

test('parseMeta: fallback titles drop the template label and are not cut mid-phrase', () => {
  const title = (text) => parseMeta('', { userText: text, firstMessage: text }).title;
  assert.equal(title('Situation: my friend Priya cancelled our dinner on Friday for the third time this month. Automatic thought: she does not value me.'), 'My friend Priya cancelled our dinner on Friday');
  assert.equal(title("Rose: my neighbour left a jar of homemade plum jam at my door with a note saying thanks for watering her plants."), 'My neighbour left a jar of homemade plum jam');
  assert.equal(title('I called my sister Maya in the evening and that helped a lot. We talked for an hour.'), 'I called my sister Maya in the evening');
  assert.equal(title('Alex and I had another argument tonight about who does the dishes, which is obviously not really about the dishes.'), 'Alex and I had another argument tonight');
  assert.equal(title('Today was rough, I had to present the quarterly numbers to the whole team and my hands were shaking.'), 'Today was rough');
  assert.equal(title('Short and sweet.'), 'Short and sweet');
  assert.equal(title('Note: x'), 'Note: x', 'a label with almost nothing after it is not stripped');
  assert.equal(title('今日は仕事が忙しくて、昼ごはんを食べる時間もありませんでした。'), '今日は仕事が忙しくて、昼ごはんを食べる時間もありませんでした');
  // The fallback summary does not start with the template label either.
  assert.equal(parseMeta('', { userText: 'Situation: my friend cancelled dinner again on Friday. I was hurt.' }).summary, 'My friend cancelled dinner again on Friday. I was hurt.');
  // A title the person or the model gave is not touched.
  assert.equal(parseMeta('Title: Situation: dinner', { userText: 'x' }).title, 'Situation: dinner');
});

test('parseMemoryLines: an echoed example needs every distinctive word of the fact in the entry', () => {
  const entry = 'My sister Maya called me and I told her about the night shifts.';
  assert.deepEqual(parseMemoryLines('- Has a younger sister called Maya', { userText: entry }), [], '"younger" is the prompt\'s, not the entry\'s');
  assert.deepEqual(parseMemoryLines('- Has a sister called Maya', { userText: entry }), ['Has a sister called Maya']);
  assert.deepEqual(parseMemoryLines('- Has a younger sister called Maya', { userText: `${entry} She is three years younger than me.` }), ['Has a younger sister called Maya']);
  assert.deepEqual(parseMemoryLines('- Works as a nurse', { userText: 'I am a nurse on the night ward.' }), ['Works as a nurse']);
  assert.deepEqual(parseMemoryLines('- Works as a pediatric nurse', { userText: 'I am a nurse on the night ward.' }), [], 'an invented specialisation of the example');
  assert.deepEqual(parseMemoryLines('- Is training for a half marathon', { userText: 'I am training for a half marathon in March.' }), ['Is training for a half marathon']);
});

test('parseMemoryLines: what the writer is doing right now, scenes and diary events are not lasting facts', () => {
  const entry = 'Nothing much happened. I stayed in, made pasta and answered a few emails. My friend cancelled our dinner. I am planning to ask for Friday off. I am waiting for someone to arrive. I am cooking a ratatouille with my roommate Chloé tonight. I am training for a 10k run.';
  for (const line of ['Is planning to ask for Friday off', 'Is waiting for someone to arrive', 'Is cooking a ratatouille with their roommate Chloé', 'Is considering a pottery class', 'Is trying to find a way to cope',
    'Is starting to suspect that days like this do not exist', 'Is just a backup plan', 'Has never felt this heavy before', 'Does not even know where to start', 'Has been eating a lot of biscuits', 'Has been having trouble sleeping for weeks',
    'Was in their grandmother\'s kitchen', 'Their friend cancelled their planned dinner', 'Their apple cake', 'Their team shipped a new feature', 'Stayed in', 'Made pasta', 'Answered emails']) {
    assert.deepEqual(parseMemoryLines(`- ${line}`, { userText: entry }), [], line);
  }
  for (const line of ['Is training for a 10k run', 'Has been living in this city for eight months', 'Is studying for a nursing degree', 'Was born in Leeds', 'Was raised by their grandmother', 'Their grandmother passed away a year ago']) {
    assert.deepEqual(parseMemoryLines(`- ${line}`), [line], line);
  }
});

test('parseMemoryLines: a short entry without common English words is still judged as English', () => {
  // "Stayed in" used to pass because nothing marked this tiny entry as English.
  const entry = 'Nothing much happened. Rainy, stayed in, answered a few emails, made pasta. A bit flat but not bad.';
  assert.deepEqual(parseMemoryLines('- Stayed in\n- Made pasta\n- Answered emails', { userText: entry }), []);
});

test('parseMemoryLines: format placeholders and copied sentences are not facts, hostile text stays text', () => {
  assert.deepEqual(parseMemoryLines('- <short fact>\n- Likes <short fact>'), []);
  assert.deepEqual(parseMemoryLines('- Likes <script>window.x=1</script>'), ['Likes <script>window.x=1</script>'], 'markup is text, not a reason to drop the line');
  const entry = 'Mi jefa me pidió terminar el informe antes del viernes y no dormí bien. Por la tarde fui a caminar con mi perro Canela por el parque.';
  assert.deepEqual(parseMemoryLines('- Mi jefa me pidió terminar el informe antes del viernes\n- Tiene un perro llamado Canela', { userText: entry }), ['Tiene un perro llamado Canela']);
  assert.deepEqual(parseMemoryLines('- Por la tarde fui a caminar con mi perro Canela por el parque', { userText: entry }), [], 'a verbatim sentence');
  // A short sentence that is itself the fact is fine.
  assert.deepEqual(parseMemoryLines('- Has a sister called Maya', { userText: 'I have a sister called Maya.' }), ['Has a sister called Maya']);
  // The same in English: an entry sentence copied word for word.
  assert.deepEqual(parseMemoryLines('- Presented the quarterly numbers to the whole team in the morning meeting', { userText: 'I presented the quarterly numbers to the whole team in the morning meeting today.' }), []);
});

test('parseMemoryLines: other languages are judged by voice and tense, not only by grounding', () => {
  const es = 'Hoy fue un día largo. Mi jefa me pidió terminar el informe. Camino cada tarde con mi perro Canela. Mi hermana Lucía vive en Sevilla y trabaja como enfermera.';
  for (const line of ['Había terminado el informe', 'Dormía bien', 'Lucía se siente muy contenta', 'Su hermana Lucía vino de visita desde Sevilla', 'Tengo una hermana llamada Lucía', 'Él habló con su hermana']) {
    assert.deepEqual(parseMemoryLines(`- ${line}`, { userText: es }), [], line);
  }
  for (const line of ['Tiene un perro llamado Canela', 'Su hermana Lucía vive en Sevilla', 'Trabaja como enfermera', 'Vive con mi pareja Alex']) {
    const got = parseMemoryLines(`- ${line}`, { userText: `${es} Alex es mi pareja.` });
    assert.equal(got.length, 1, line);
    assert.ok(!/\b(?:mi|mis)\b/i.test(got[0]), got[0]);
  }
  const fr = "Aujourd'hui j'ai parlé à mon père au téléphone. Il a ri en parlant de mon enfance à Lyon. Je vais cuisiner avec ma colocataire Chloé.";
  for (const line of ["J'ai parlé à mon père au téléphone", "Il a ri en parlant de son enfance à Lyon", 'Elle a dit que']) {
    assert.deepEqual(parseMemoryLines(`- ${line}`, { userText: fr }), [], line);
  }
  assert.deepEqual(parseMemoryLines('- A une colocataire, Chloé', { userText: fr }), ['A une colocataire, Chloé']);
  // Japanese: plans and past polite forms are events.
  const ja = '今日は忙しかったです。帰り道に妹のあやと電話しました。週末は二人で京都に行く予定です。';
  assert.deepEqual(parseMemoryLines('- 京都に行く予定です。\n- 妹のあやと電話しました。\n- 仕事の忙しさにより、昼ごはんを食べる時間もありません。\n- 始めての京都旅に楽しみだが、ちょっと疲れています。', { userText: ja }), []);
  assert.deepEqual(parseMemoryLines('- 妹のあやがいる', { userText: ja }), ['妹のあやがいる']);
});

test('parseMemoryLines: a chat reply given instead of a fact list is not stored, in any language', () => {
  const ja = '今日は仕事が忙しくて、昼ごはんを食べる時間もありませんでした。帰り道に妹のあやと電話して、少し元気が出ました。';
  const jaReply = 'お昼も食べられないほど忙しい一日だったんだね、本当にお疲れ様。妹のあやさんと話して少し元気が出たのはよかったね。';
  assert.deepEqual(parseMemoryLines(jaReply, { userText: ja }), []);
  assert.deepEqual(parseMemoryLines('妹のあやさんと話して、あなたは元気になりました', { userText: ja }), []);
  const es = 'Hoy fue un día largo y fui a caminar con mi perro Canela por el parque.';
  assert.deepEqual(parseMemoryLines('Hoy compartiste el peso de un día cansado, aunque trajiste a este espacio el alivio de caminar con Canela por el parque', { userText: es }), []);
  assert.deepEqual(parseMemoryLines('Tu perro Canela es muy cariñoso', { userText: es }), [], 'second person (possessive)');
  assert.deepEqual(parseMemoryLines('Tiene un perro llamado Canela', { userText: es }), ['Tiene un perro llamado Canela']);
  assert.deepEqual(parseMemoryLines("Aujourd'hui, tu as traversé un mélange de soulagement. Passe une douce soirée.", { userText: "J'ai parlé à mon père. Il a ri en parlant de mon enfance à Lyon." }), []);
  // Two sentences are a paragraph, not a fact.
  assert.deepEqual(parseMemoryLines('Works as a nurse. Loves hiking in the mountains.'), []);
  assert.deepEqual(parseMemoryLines('- Works as a nurse\n- Loves hiking in the mountains'), ['Works as a nurse', 'Loves hiking in the mountains']);
});
