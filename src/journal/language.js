// A tiny language guesser, used to name the user's language in prompts ("Write in Spanish.").
//
// Small local models follow an English instruction such as "write in the language the user writes in" poorly
// (measured on Ollama: llama3.2:1b and qwen3:1.7b answered Spanish, French and Japanese entries in English), and an
// English cue at the end of the prompt pulls them to English even harder. Naming the language works much better.
// No dependency, no model: script detection for Japanese, Chinese and Korean, and stopword scoring for the main
// Latin-script languages. When the guess is not clearly better than the runner-up, the answer is null and the
// prompts keep their language-neutral wording ("in the language the user writes in").

/** @typedef {{code: string, name: string}} Language */

// Function words that are common in the language and (mostly) not in the others. A word that two languages share is
// listed in both: it adds to both scores and so cancels out.
const STOPWORDS = {
  en: 'the and you your that with have this for was are not but what about when how they from would there their just like been really because very know think feel felt had has will can all out one more some than then them these those today my me it its is of to in on at as be do did so if we he she his her him our us an or by no yes',
  es: 'el los las que con por para una mi tus tu es y en se lo me más muy pero como fue estoy está están tengo tiene hoy día cuando porque también hay son este esta ese esa del al sí nada algo todo cada ella ellos nos mis sus ya han había hace desde sobre entre sin así bien',
  fr: 'le les des que avec pour une je tu il elle est et en ne pas ce mon ma mes qui dans sur mais très plus fait ai suis sont cette ces nous vous ils elles au aux du de la où quand parce aussi tout rien quelque comme même être avoir été était un',
  de: 'der die das und ich ist nicht ein eine mit zu den auf für mein meine von sich dem war es auch aber wie noch nur sehr heute habe bin du er sie wir ihr wenn dass nach bei aus über einen einer einem im am vom zum zur kein keine',
  pt: 'os as que com por para uma meu minha meus minhas é e em se não eu mais muito mas como foi estou está tenho hoje dia quando porque também há são este esta esse essa do da dos das no na nos nas um já têm tem ele ela nós você vocês',
  it: 'il lo gli che con per una mio mia miei è e in si non io più molto ma come ho sono oggi giorno quando anche perché questo questa quello della del dei delle nel nella un di la le ha hanno lui lei noi voi tutto niente',
  nl: 'de het een en ik is niet met te voor van mijn op dat ook maar zo nog heel vandaag ben heb je hij zij wij jullie dit deze die er als dan naar bij uit over veel geen wel',
};
const NAMES = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', nl: 'Dutch', ja: 'Japanese', zh: 'Chinese', ko: 'Korean' };

const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([code, list]) => [code, new Set(list.split(' '))]));
const MAX_SCAN = 4000;
const HAN = /\p{Script=Han}/gu;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HANGUL = /\p{Script=Hangul}/gu;
const LETTER = /\p{L}/gu;
// Letters that point at one language even when the stopwords do not decide it.
const HINTS = [
  ['es', /[¿¡ñ]/gu],
  ['pt', /[ãõ]|ç(?=ão|õe)/gu],
  ['fr', /[àâçèêëîïôûùœ]|\b[cdjlmnst]'(?=\p{L})/giu],
  ['de', /[äöüß]/giu],
];

/**
 * Guess the language of a text. Returns `null` when the text is too short or the guess is not clear, so callers can
 * keep a language-neutral instruction.
 * @param {unknown} text
 * @returns {Language|null}
 */
export function detectLanguage(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const sample = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  const letters = (sample.match(LETTER) || []).length;
  if (letters < 4) return null;

  // Scripts first: Japanese text contains Han characters too, so kana decide between Japanese and Chinese.
  const kana = (sample.match(KANA) || []).length;
  const han = (sample.match(HAN) || []).length;
  const hangul = (sample.match(HANGUL) || []).length;
  if (kana >= 2 && kana + han >= letters * 0.3) return { code: 'ja', name: NAMES.ja };
  if (hangul >= 2 && hangul >= letters * 0.3) return { code: 'ko', name: NAMES.ko };
  if (han >= 2 && han >= letters * 0.3) return { code: 'zh', name: NAMES.zh };
  const latin = (sample.match(/\p{Script=Latin}/gu) || []).length;
  if (latin < letters * 0.6) return null; // Cyrillic, Arabic, Greek, ...: not named, the neutral wording is used

  const words = sample.toLowerCase().match(/\p{L}+/gu) || [];
  const scores = {};
  for (const code of Object.keys(SETS)) scores[code] = 0;
  for (const w of words) for (const code of Object.keys(SETS)) if (SETS[code].has(w)) scores[code] += 1;
  for (const [code, re] of HINTS) scores[code] += 2 * Math.min(2, (sample.match(re) || []).length);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestCode, best] = ranked[0];
  const second = ranked[1][1];
  const share = best / Math.max(1, words.length);
  if (best < 2 || (words.length >= 4 && share < 0.12) || best < second * 1.5 + 0.5) return null;
  if (words.length < 4 && second > 0) return null; // two or three words that two languages share prove nothing
  return { code: bestCode, name: NAMES[bestCode] };
}

/** Name of the language of `text`, or null: `languageName('Hoy fue un día largo') === 'Spanish'`. */
export function languageName(text) {
  const language = detectLanguage(text);
  return language ? language.name : null;
}

// ------------------------------------------------------------------------------------------------
// Prompt snippets in the user's language
//
// Measured on llama3.2:1b and qwen3:1.7b (closing reflections for Spanish, French and Japanese entries): an English
// cue at the end of the prompt pulls a small model into English (llama kept Spanish in 0 of 4 replies), while the
// same cue written in the user's own language keeps it in 16 of 16 and also fixes the voice. The weekly report needs
// a seeded opening for the same reason: "Start exactly with ... In these entries, you" is what makes a 1B model say "you"
// instead of writing the user's diary in the first person or about "Sam" (0 of 8 wrong voice with the seed, 4 of 8 on
// llama3.2:1b and 7 of 8 on qwen3:1.7b without). The seed names no period, because the reflection also covers 14 or 30 days.
//
// `closing` is the last user turn of a closing-reflection prompt, `weeklyLead` the words the weekly reflection must
// start with. Each language needs both; a language that is missing here simply gets the English cue plus its name.

/** @type {Record<string, {closing: string, weeklyLead: string}>} */
export const LOCALIZED = {
  en: {
    closing: 'That is all for now. Please write your closing reflection to me now, speaking as my companion and addressing me as "you". Write 3 to 5 sentences.',
    weeklyLead: '**How the week felt.** In these entries, you',
  },
  es: {
    closing: 'Eso es todo por ahora. Escribe ahora tu reflexión de cierre para mí, como mi acompañante, tratándome de "tú". Escribe de 3 a 5 frases.',
    weeklyLead: '**Cómo se sintió la semana.** En estas entradas, tú',
  },
  fr: {
    closing: "C'est tout pour l'instant. Écris maintenant ta réflexion de clôture pour moi, en tant que mon compagnon, en t'adressant à moi avec « tu ». Écris 3 à 5 phrases.",
    weeklyLead: "**Comment la semaine s'est passée.** Dans ces entrées, tu",
  },
  de: {
    closing: 'Das war es für heute. Schreibe jetzt deine abschließende Reflexion für mich, als mein Begleiter, und sprich mich mit „du“ an. Schreibe 3 bis 5 Sätze.',
    weeklyLead: '**Wie sich die Woche angefühlt hat.** In diesen Einträgen hast du',
  },
  pt: {
    closing: 'Por hoje é só. Escreva agora a sua reflexão final para mim, como meu companheiro, tratando-me por "você". Escreva de 3 a 5 frases.',
    weeklyLead: '**Como foi a semana.** Nessas entradas, você',
  },
  it: {
    closing: 'Per ora è tutto. Scrivi adesso la tua riflessione finale per me, come mio compagno, dandomi del "tu". Scrivi da 3 a 5 frasi.',
    weeklyLead: "**Com'è andata la settimana.** In queste voci, tu",
  },
  nl: {
    closing: 'Dat was het voor nu. Schrijf nu je afsluitende reflectie voor mij, als mijn metgezel, en spreek me aan met "je". Schrijf 3 tot 5 zinnen.',
    weeklyLead: '**Hoe de week voelde.** In deze notities heb je',
  },
  ja: {
    closing: '今日はここまでです。私のコンパニオンとして、私に「あなた」と呼びかけながら、締めくくりの振り返りを3〜5文で書いてください。',
    weeklyLead: '**今週はどんな週だったか。** これらの記録で、あなたは',
  },
  zh: {
    closing: '今天就到这里。请以我的陪伴者的身份，用“你”称呼我，写一段结束时的回顾，3到5句话。',
    weeklyLead: '**这一周的感受。** 在这些记录里，你',
  },
  ko: {
    closing: '오늘은 여기까지예요. 저의 동반자로서 저를 "당신"이라고 부르며 마무리 성찰을 3~5문장으로 써 주세요.',
    weeklyLead: '**이번 주는 어땠나.** 이 기록들에서 당신은',
  },
};
