import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, languageName } from '../../src/journal/language.js';

const CASES = [
  ['en', 'Today was rough. I had to present the quarterly numbers to the whole team and my hands were shaking the entire time.'],
  ['en', 'Nothing much happened. Rainy, stayed in, answered a few emails, made pasta. A bit flat but not bad.'],
  ['en', 'I am so tired today.'],
  ['es', 'Hoy fue un día largo. Mi jefa me pidió terminar el informe antes del viernes y no dormí bien.'],
  ['es', 'Estoy muy contenta. Mi hermana vino de visita desde Sevilla y pasamos el sábado entero cocinando.'],
  ['es', 'Hoy me siento bien'],
  ['fr', "Aujourd'hui j'ai enfin parlé à mon père au téléphone après des mois de silence."],
  ['fr', 'Je suis fatigué mais heureux.'],
  ['de', 'Heute war ein langer Tag und ich bin müde.'],
  ['de', 'Meine Schwester hat mich angerufen und wir haben lange über die Arbeit gesprochen.'],
  ['pt', 'Estou muito cansado hoje, mas fui correr com o meu cão.'],
  ['it', 'Oggi sono molto stanco, ma sono andato a correre con il mio cane.'],
  ['nl', 'Vandaag was een lange dag en ik ben moe.'],
  ['ja', '今日は仕事が忙しくて、昼ごはんを食べる時間もありませんでした。'],
  ['zh', '今天工作很忙，我连午饭都没有时间吃。晚上给妹妹打了电话，心情好多了。'],
  ['ko', '오늘은 일이 너무 바빠서 점심도 먹을 시간이 없었어요.'],
];

test('detectLanguage recognises the main languages', () => {
  for (const [code, text] of CASES) {
    const got = detectLanguage(text);
    assert.ok(got, `no answer for ${code}: ${text}`);
    assert.equal(got.code, code, text);
    assert.equal(typeof got.name, 'string');
  }
});

test('detectLanguage names the language in English', () => {
  assert.equal(languageName('Hoy fue un día largo y no dormí bien.'), 'Spanish');
  assert.equal(languageName('Heute war ein langer Tag und ich bin müde.'), 'German');
  assert.equal(languageName('今日は仕事が忙しくて疲れました。'), 'Japanese');
  assert.equal(languageName('today was fine'), 'English');
});

test('detectLanguage says null instead of guessing', () => {
  for (const text of ['', ' ', 'ok', 'gracias', '😭🙃', '12345', 'Сегодня был длинный день.', 'مرحبا بك في اليوم', 'xyz qwv', null, undefined, 42, {}]) {
    assert.equal(detectLanguage(text), null, JSON.stringify(text));
  }
});

test('detectLanguage reads only the start of a long text and stays fast', () => {
  const long = `${'Hoy fue un día largo y no dormí bien. '.repeat(5000)}`;
  const t0 = Date.now();
  assert.equal(detectLanguage(long).code, 'es');
  assert.ok(Date.now() - t0 < 500);
  assert.equal(detectLanguage(`${'a'.repeat(100000)} the and you`), null);
});

test('detectLanguage: a short word shared by two languages does not decide', () => {
  // "no" and "me" exist in several languages; one such word is not enough
  assert.equal(detectLanguage('no me'), null);
  assert.equal(detectLanguage('la vie'), null);
});
