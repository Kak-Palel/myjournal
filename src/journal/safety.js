// Crisis detection for journal text. This is a gentle safety net, not a classifier: when it fires the
// app shows a static, kind notice (crisisNotice) next to the normal reply, nothing is blocked.
//
// Design:
//  * Multi-word patterns only (English plus a few common Spanish, French, German and Portuguese
//    phrases). A bare "die", "kill" or "suicide" never flags.
//  * False-positive aware: hyperbole ("die of embarrassment", "killing myself laughing"), idioms
//    ("shoot myself in the foot", "take my life back") and accidents ("I cut myself shaving") are
//    recognised and skipped; so are negated statements ("I would never kill myself", "I'm not suicidal")
//    and third-person subjects ("she wanted to die laughing").
//  * Text is matched in a folded form: lower case, accents removed, curly quotes straightened, so
//    "ich möchte sterben" and "ich mochte sterben" both work. Patterns are therefore written without accents.
//
// Statements about other people ("she tried to kill herself", "my brother attempted suicide") are deliberately
// not flagged: the patterns are about the writer. Rules without a subject of their own are checked with
// `subject` (the words right before the match) or `others` (the whole clause before the match).

const MAX_SCAN_CHARS = 60_000;
const MAX_MATCHES = 5;

/** Fold text for matching: lower case, no accents, straight apostrophes, single spaces. */
function fold(text) {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ');
}

// -- shared building blocks (regex source fragments, written for folded text) --------------------------------
const ADV = "(?:(?:just|really|actually|honestly|truly|seriously|literally|finally|so|badly|always|sometimes|often|still|now) )*";
/** Intent lead-ins for "I ... <verb>" patterns that would otherwise match accidents or idioms. */
const INTENT = "(?:want(?:ed|ing)?|wanna|going|gonna|plan(?:ning|ned)?|thinking (?:about|of)|think(?:ing)? about|decided|deciding|ready|trying|tried|attempt(?:ed|ing)?|tempted|considering|contemplating|need(?:ed)?|feel(?:ing)? like|felt like|thought about|thoughts? of|urge to|'?ll|will|about)";
/** "to" or "to just" etc. between an intent word and its verb. */
const TO = "(?: (?:to|just|really|actually|finally|seriously|go|and))*";

// -- guards ---------------------------------------------------------------------------------------------
const NEGATED_BEFORE = /(?:\bnot|\bnever|n't|\bno longer|\bnor|\bwithout|\bnada de|\bjamais|\bkein|\bnie|\bnunca|\bnao|\bno)\s+(?:\S+\s+)?$/;
// "I can't stop thinking about ending it all" contains a negation but is the opposite of reassuring.
const CANT_STOP_BEFORE = /(?:can'?t|cannot|can not|couldn'?t|unable to) (?:stop|help|quit|keep)\s+$/;
const THIRD_PERSON_BEFORE = /(?:\b(?:she|he|they|people|someone|anyone|anybody|whoever|who|him|her|them|friends?|kids?|patients?)|\b(?:my|our|his|her|their) \S+) (?:(?:also|just|really|all|both|sometimes|always|often|only) )*$/;

// Vocabulary rules ("suicidal", "attempted suicide") name no subject. They are ignored when, in the same clause, the
// closest subject before the match is somebody else ("my brother attempted suicide", "he is suicidal") and not the
// writer ("... and now I feel suicidal myself" is still flagged).
const RELATIVES = 'brother|sister|mother|mom|mum|mama|father|dad|papa|friend|best friend|son|daughter|wife|husband|partner|boyfriend|girlfriend|fiance|fiancee|cousin|uncle|aunt|aunty|nephew|niece|grandmother|grandfather|grandma|grandpa|grandson|granddaughter|colleague|coworker|co-worker|classmate|neighbou?r|roommate|flatmate|housemate|student|patient|client|boss|teacher|ex|ex-\\w+|brother-in-law|sister-in-law|stepdad|stepmom|stepmother|stepfather|parents?|family|kids?|child|children|baby|twin|buddy|therapist';
const OTHER_SUBJECT_RE = new RegExp(`\\b(?:he|she|they|him|them|his|her|their|(?:my|our) (?:[a-z]+ )?(?:${RELATIVES}))\\b`, 'g');
const SELF_SUBJECT_RE = /\b(?:i|me|myself|we|us)\b/g;

const HYPERBOLE_DIE = /^ (?:of|from) (?:embarrassment|shame|laughing|laughter|boredom|cringe|happiness|joy|cuteness|jealousy|awkwardness|secondhand)|^ (?:laughing|inside|on the spot|right there|right then|a little|a bit)\b/;

const guards = {
  hyperboleDie: HYPERBOLE_DIE,
  // "ready to die for my kids", "I'm ready to die on this hill"
  dieIdiom: new RegExp(`${HYPERBOLE_DIE.source}|^ (?:for\\b|on (?:this|that|the|my|our) hill)`),
  killMyselfIdiom: /^ (?:for (?:being|not|forgetting|losing|missing|saying|doing|making|leaving|letting|wasting|falling|getting|sending|buying|eating|failing|breaking|trusting|ignoring|\w+ing)\b|laughing|trying|working|studying|at the gym|with (?:work|stress|overwork|worry|worrying|cleaning|studying|training)|to (?:get|make|finish|keep|stay|prove|impress|please|pay|meet|lose|be))/,
  lifeBack: /^ (?:back|into|savings|story|coach|insurance|in (?:my|a|the)|more|up|to the|together|easier|work|goals?|plan|one|day|slowly|seriously|easy|step|a new|for granted|by the|for a)\b/,
  worryIdiom: /^ in (?:work|my work|books?|a book|studies|school|tv|netflix|sleep|alcohol|chocolate|ice cream|food|music|projects?|the work|the job|social media|my phone|hobbies)\b/,
  footIdiom: /^ in the (?:foot|leg|knee)\b/,
  cutSlack: /^ (?:a|an|some|another|off|free|loose|slack|short|down|out)\b/, // word-bounded: "some" must not swallow "sometimes"
};

/**
 * @typedef {object} Rule
 * @property {string} lang
 * @property {RegExp} re regex over folded text
 * @property {RegExp} [after] when this matches the text right after the match, the hit is ignored
 * @property {boolean} [subject] true: the pattern has no subject, so third-person statements are ignored
 * @property {boolean} [others] true: the pattern is vocabulary only; ignored when the closest subject in the clause is someone else
 */

const rule = (lang, source, extra = {}) => ({ lang, re: new RegExp(source, 'g'), ...extra });

/** @type {Rule[]} */
const RULES = [
  // ---- English: wanting to die ----
  rule('en', "\\bwant(?:ed|ing)? to die\\b", { after: guards.hyperboleDie, subject: true }),
  rule('en', "\\bwanna die\\b", { after: guards.hyperboleDie, subject: true }),
  rule('en', "\\bwant(?:ed|ing)? to be dead\\b", { subject: true }),
  rule('en', "\\bwish(?:ed|ing)? (?:that )?i (?:was|were|am|could be|would be) dead\\b"),
  rule('en', `\\bwish(?:ed|ing)? (?:that )?i (?:could |would )?${ADV}(?:die|disappear forever|never wake up|not wake up|wouldn'?t wake up|didn'?t wake up)\\b`, { after: guards.hyperboleDie }),
  rule('en', "\\bwish(?:ed|ing)? (?:that )?i(?: had|'d| was| were)? never (?:been |was |were )?born\\b"),
  rule('en', "\\bwish(?:ed|ing)? (?:that )?i (?:wasn'?t|weren'?t|was not|were not|am not) (?:alive|born)\\b"),
  // Same end-of-clause test as "don't want to wake up": "I hope I don't wake up late" is a morning intention.
  rule('en', "\\bhope (?:that )?i (?:don'?t|do not|never|won'?t) wake up(?: again| any ?more| ever|(?= *(?:[.!,;]|$)))"),
  rule('en', "\\b(?:go to sleep and|sleep and|just) never wake up\\b"),
  rule('en', "\\bbetter off (?:dead|without me)\\b"),
  rule('en', "\\b(?:would be|'d be|will be|'ll be|'re|'s|are|is|be|were) (?:(?:so|much|way|a lot|far|really|just|all) )*(?:better|happier|safer|easier) without me\\b", { after: /^ (?:there|here|at|in|around|on|being|if|because)\b/ }),
  rule('en', "\\bbetter off if i (?:was|were|wasn'?t|weren'?t) (?:dead|gone|here|around|alive)\\b"),
  // "wanna" already contains the "to": `(?:want to|wanna)`, never `(?:want|wanna) to`.
  rule('en', "\\b(?:don'?t|do not|no longer|not) (?:want to|wanna) (?:be alive|be here anymore|exist)\\b"),
  rule('en', "\\b(?:don'?t|do not|no longer|not) (?:want to|wanna) live(?= *(?:[.!,;]|$)| any ?more| any longer| at all| another day| through)"),
  rule('en', "\\b(?:don'?t|do not) (?:want to|wanna) wake up(?: again| any ?more| ever|(?= *(?:[.!,;]|$)))"),
  rule('en', "\\b(?:no reason|nothing|no point) (?:to|left to|in) (?:live|living|go on|going on)\\b"),
  rule('en', "\\bnothing to live for\\b"),
  rule('en', "\\b(?:don'?t|do not|can'?t|cannot) (?:see|find) (?:the |any |a )?(?:point|reason|purpose) (?:in|of|to) (?:being alive|going on|go on|continuing|carrying on|living(?= *(?:[.!,;]|$)| any ?more| any longer| like this| this way)|life(?= *(?:[.!,;]|$)| any ?more))"),
  rule('en', "\\b(?:don'?t|do not|never) deserve to (?:be alive|exist|live(?= *(?:[.!,;]|$)| any ?more| any longer| at all))"),
  rule('en', "\\b(?:don'?t|do not) care (?:if|whether) i (?:live or die|die or live|live|die)\\b"),
  // "I think I should die", "I deserve to die", "I'm ready to die" (but not "ready to die on this hill")
  rule('en', `\\bi (?:(?:think|feel|believe|know|guess|just) (?:that )?i )?(?:should|need to|have to|ought to|deserve to) ${ADV}(?:die|be dead)\\b`, { after: guards.dieIdiom }),
  rule('en', `\\bi(?:'m| am) ${ADV}ready to (?:die|be dead)\\b`, { after: guards.dieIdiom }),
  rule('en', "\\b(?:a )?part of me (?:really |just |actually |still )?want(?:s|ed)? to (?:die|be dead|disappear forever)\\b", { after: guards.hyperboleDie }),
  rule('en', `\\bi ${ADV}(?:keep )?(?:think|thought|thinking) (?:about|of) dying(?= *(?:[.!,;]|$)| (?:every|all|a lot|often|again|more|constantly|daily|at night|so much|most))`),
  rule('en', "\\b(?:isn'?t|is not|not|aren'?t|wasn'?t) (?:even )?worth (?:living|being alive)\\b"),
  rule('en', "\\b(?:i'?m|i am|so|really|just) (?:done|finished|tired|sick) (?:with|of) (?:life|being alive|living\\b(?! (?:in|with|here|there|at|like|on|off|alone|under|near|far|by|around)))"),

  // ---- English: suicide ----
  rule('en', "\\bsuicidal\\b", { others: true }),
  rule('en', "\\b(?:thoughts?|ideas?) of suicide\\b", { others: true }),
  rule('en', "\\b(?:thinking|thought|think) (?:about|of) suicide\\b", { others: true }),
  rule('en', "\\b(?:contemplat(?:e|ed|ing)|consider(?:ed|ing)?) suicide\\b", { others: true }),
  rule('en', "\\bsuicide (?:plan|note|attempt|pact|ideation)\\b", { others: true }),
  rule('en', "\\b(?:attempt(?:ed|ing)?|tried|try(?:ing)?) (?:to )?(?:commit )?suicide\\b", { others: true }),
  rule('en', "\\bcommit(?:ting)? suicide\\b", { others: true }),
  rule('en', "\\bkill(?:ing|ed)? myself\\b", { after: guards.killMyselfIdiom }),
  rule('en', `\\b${INTENT}${TO} (?:end(?:ing)?|tak(?:e|ing)) my life\\b`, { after: guards.lifeBack }),
  rule('en', "\\b(?:end(?:ed|ing)?|tak(?:e|ing)|took) my own life\\b", { after: guards.lifeBack }),
  rule('en', `\\b${INTENT}${TO} end(?:ing)? it all\\b`),

  // ---- English: self-harm ----
  rule('en', "\\bself[- ]?harm(?:ing|ed|s)?\\b", { others: true }),
  rule('en', `\\b(?:i(?:'?ll| will|'?m going to|'?m gonna| am going to| gonna| want to| wanna| need to| feel like| felt like| keep wanting to| keep thinking about|'?m thinking (?:about|of)| am thinking (?:about|of)|'?ve been thinking (?:about|of)| have been thinking (?:about|of)| think about| thought about)|(?:^|[.!?,;] |and |but |just |so )(?:want|wanna|need) to) ${ADV}(?:hurt(?:ing)?|harm(?:ing)?|cut(?:ting)?|burn(?:ing)?|punish(?:ing)?|injur(?:e|ing)|starv(?:e|ing)|mutilat(?:e|ing)) myself\\b`, { after: guards.cutSlack }),
  rule('en', "\\b(?:been|keep|kept|started|start|back to|again)(?: (?:cutting|hurting|harming|burning|punishing|starving)) myself\\b"),
  rule('en', "\\b(?:hurt|harm(?:ed)?|cut|burn(?:ed|t)?|injure[d]?|hit) myself(?: (?:again|once more|twice|several times|last night|yesterday|today|tonight|recently|earlier|this (?:week|morning)))* (?:on purpose|deliberately|intentionally)\\b"),
  // Past-tense disclosures. "I cut myself again" only at the end of a sentence: "...again while chopping onions" is an accident.
  rule('en', "\\bi (?:cut|harmed) myself again(?: (?:last night|yesterday|today|tonight|this (?:week|morning)))?(?= *(?:[.!]|$))"),
  rule('en', `\\b${INTENT}${TO} (?:cut|slit|slash) my (?:wrists?|throat|veins)\\b`),
  rule('en', "\\bslit(?:ting)? my wrists?\\b"),
  rule('en', "\\b(?:hang|hanging|shoot|shooting|drown|drowning|suffocate|suffocating|poison|poisoning|stab|stabbing|electrocute|electrocuting|asphyxiate) myself\\b", { after: new RegExp(`${guards.worryIdiom.source}|${guards.footIdiom.source}`) }),
  rule('en', `\\b${INTENT}${TO} (?:jump|jumping|throw|throwing)(?: myself)? (?:off|from)(?: of)? (?:a|the|this|my|that) (?:\\w+ )?(?:bridge|building|roof|rooftop|cliff|balcony|tower|window|overpass|ledge|garage)\\b`, { after: /^(?: \w+){0,4} into\b/ }),
  rule('en', `\\b${INTENT}${TO} (?:jump|jumping|throw|throwing)(?: myself)? in front of (?:a |the )?(?:train|car|bus|truck|subway|metro|lorry|moving)\\b`),
  rule('en', `\\b${INTENT}${TO} overdos(?:e|ing)\\b`),
  rule('en', "\\bi (?:just |have |'ve |accidentally )?over-?dosed\\b", { after: /^ on (?!pills|painkillers|tablets|meds|medication|drugs|sleeping|pain|opioid|heroin|insulin|tylenol|paracetamol|ibuprofen|aspirin|benzos|xanax|alcohol)/ }),
  // "a bunch of pills" alone is ambiguous, but followed by "I don't care what happens" it is not.
  rule('en', "\\bi (?:just |have |'ve )?took (?:a bunch of|a handful of|a lot of|so many) (?:\\w+ )?(?:pills|tablets|meds|sleeping pills|painkillers)\\b[^.!?]{0,40}\\b(?:don'?t|do not) care\\b"),
  rule('en', "\\bi (?:just |have |'ve )?took (?:too many|an entire bottle of|a whole bottle of|the whole bottle of) (?:\\w+ )?(?:pills|tablets|meds|medication|sleeping pills|painkillers)\\b", { after: /^ (?:by (?:accident|mistake)|accidentally)/ }),
  rule('en', `\\b${INTENT}${TO} (?:swallow|take|taking) (?:all|a whole bottle of|the whole bottle of|a bunch of|every one of) (?:my |the )?(?:pills|tablets|meds|medication|sleeping pills)\\b`),

  // ---- Spanish ----
  rule('es', "\\b(?:me )?quiero (?:morir|morirme|matarme|suicidarme|estar muert[oa]|desaparecer para siempre)\\b(?! de (?:verguenza|risa|aburrimiento|calor|hambre|sueno|envidia|miedo|sed|frio|celos|pena))"),
  rule('es', "\\bme quiero (?:matar|suicidar)\\b"),
  rule('es', "\\b(?:quisiera|ojala) (?:estar muert[oa]|no despertar|no haber nacido|morirme|morir)\\b"),
  rule('es', "\\bojala (?:estuviera|fuera) muert[oa]\\b"),
  rule('es', "\\b(?:voy a (?:matarme|suicidarme|quitarme la vida|acabar con mi vida)|me voy a (?:matar|suicidar))\\b"),
  rule('es', "\\b(?:quitarme la vida|acabar con mi vida|terminar con mi vida)\\b"),
  rule('es', "\\bno quiero (?:vivir|seguir viviendo|seguir con vida|estar vivo|estar viva|existir)\\b", { after: /^ (?:en|con|asi|aqui|alli|sola|solo|de esa|sin|como|mas lejos)\b/ }),
  rule('es', "\\b(?:pensamientos|ideas) suicidas\\b"),
  rule('es', "\\bpensando en (?:suicidarme|el suicidio|quitarme la vida|matarme)\\b"),
  rule('es', "\\bsuicidarme\\b"),
  rule('es', "\\b(?:quiero|voy a|ganas de) (?:hacerme dano|lastimarme|herirme|cortarme las venas|cortarme las munecas)\\b"),
  rule('es', "\\b(?:estarian|estaria) mejor sin mi\\b"),
  rule('es', "\\b(?:no vale la pena vivir|la vida no vale la pena)\\b"),

  // ---- French ----
  rule('fr', "\\bje (?:veux|voudrais) (?:mourir|me tuer|me suicider|etre mort(?:e)?)\\b(?! de (?:rire|honte|faim|soif|fatigue|sommeil|peur|chaud|froid|ennui|jalousie|gene))"),
  rule('fr', "\\bj'?ai envie de mourir\\b(?! de (?:rire|honte|faim|soif|fatigue|sommeil|peur|chaud|froid|ennui|jalousie|gene))"),
  rule('fr', "\\bje (?:veux|voudrais) en finir(?= *(?:[.!,;]|$)| avec (?:la vie|tout|moi))"),
  rule('fr', "\\ben finir avec (?:la vie|moi)\\b"),
  rule('fr', "\\bje vais me (?:tuer|suicider)\\b"),
  rule('fr', "\\b(?:mettre fin a (?:mes jours|ma vie)|me suicider)\\b"),
  rule('fr', "\\b(?:je ne veux plus vivre|je n'?ai plus envie de vivre|plus envie de vivre|je ne veux plus etre en vie)\\b"),
  rule('fr', "\\b(?:pensees|idees) suicidaires\\b"),
  rule('fr', "\\bje (?:veux|vais) me (?:faire du mal|blesser|couper les veines|scarifier)\\b"),
  rule('fr', "\\b(?:seraient|serait) mieux sans moi\\b"),

  // ---- German ----
  rule('de', "\\bich (?:will|m(?:o|oe)chte|wuerde gerne?) (?:nicht mehr leben|sterben|tot sein|mich umbringen|mich toeten|mir das leben nehmen)\\b(?! vor (?:scham|lachen|langeweile|hunger|neugier|verlegenheit))"),
  rule('de', "\\b(?:ich bringe mich um|ich werde mich umbringen|mir das leben nehmen|mein leben beenden|meinem leben ein ende (?:setzen|machen))\\b"),
  rule('de', "\\b(?:suizidgedanken|selbstmordgedanken|suizidal|suizidversuch|selbstmordversuch|selbstmord begehen|suizid begehen)\\b"),
  rule('de', "\\bich denke an (?:selbstmord|suizid)\\b"),
  rule('de', "\\bich (?:will|m(?:o|oe)chte|werde) mich (?:selbst )?(?:verletzen|ritzen)\\b"),
  rule('de', "\\b(?:besser dran ohne mich|keine lust mehr zu leben)\\b"),

  // ---- Portuguese ----
  rule('pt', "\\bquero (?:morrer|me matar|me suicidar|desaparecer para sempre|acabar com (?:a )?minha vida|tirar (?:a )?minha (?:propria )?vida|estar mort[oa])\\b(?! de (?:rir|riso|vergonha|fome|sede|saudade|sono|medo|calor|frio|inveja|tedio|tristeza))"),
  rule('pt', "\\b(?:vou me (?:matar|suicidar)|vou tirar (?:a )?minha (?:propria )?vida|tirar (?:a )?minha (?:propria )?vida|acabar com (?:a )?minha vida)\\b"),
  rule('pt', "\\bnao quero (?:mais )?(?:viver|estar vivo|estar viva|existir)\\b", { after: /^ (?:em|com|assim|aqui|ai|la|sozinh[oa]|sem|como)\b/ }),
  rule('pt', "\\b(?:pensamentos|ideias) suicidas\\b"),
  rule('pt', "\\b(?:pensando em (?:suicidio|me matar|suicidar)|tentativa de suicidio|me suicidar)\\b"),
  rule('pt', "\\b(?:quero|vou) me (?:machucar|ferir)\\b"),
  rule('pt', "\\b(?:ficariam|estariam) melhor sem mim\\b"),
];

/** Is the closest subject before `index`, within the same sentence, somebody other than the writer? */
function isAboutSomeoneElse(folded, index) {
  const window = folded.slice(Math.max(0, index - 120), index);
  const clause = window.slice(window.search(/[^.!?;]*$/));
  const lastIndexOf = (re) => {
    re.lastIndex = 0;
    let last = -1;
    let m;
    while ((m = re.exec(clause)) !== null) last = m.index;
    return last;
  };
  const other = lastIndexOf(OTHER_SUBJECT_RE);
  return other !== -1 && other > lastIndexOf(SELF_SUBJECT_RE);
}

/**
 * @typedef {object} CrisisResult
 * @property {boolean} flagged
 * @property {string[]} matches the (folded, lower-case) phrases that matched, at most 5, no duplicates
 */

/**
 * Does the text contain clear signs of suicidal thoughts or self-harm intent? Conservative on purpose:
 * multi-word patterns, with hyperbole, idioms, accidents, negation and third-person statements ignored.
 * Safe on any input (non-strings and empty text return `{ flagged: false, matches: [] }`).
 * @param {unknown} text
 * @returns {CrisisResult}
 */
export function detectCrisis(text) {
  if (typeof text !== 'string' || text.trim() === '') return { flagged: false, matches: [] };
  // Cap the work on hostile input but keep both ends: people often write the worst part last.
  const scan = text.length > MAX_SCAN_CHARS
    ? `${text.slice(0, MAX_SCAN_CHARS / 2)}\n${text.slice(text.length - MAX_SCAN_CHARS / 2)}`
    : text;
  const folded = fold(scan);
  const found = [];
  for (const { re, after, subject, others } of RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(folded)) !== null) {
      if (m[0] === '') { re.lastIndex += 1; continue; }
      const before = folded.slice(Math.max(0, m.index - 40), m.index);
      const following = folded.slice(m.index + m[0].length, m.index + m[0].length + 60);
      if (NEGATED_BEFORE.test(before) && !CANT_STOP_BEFORE.test(before)) continue;
      if (subject && THIRD_PERSON_BEFORE.test(before)) continue;
      if (others && isAboutSomeoneElse(folded, m.index)) continue;
      if (after && after.test(following)) continue;
      const phrase = m[0].trim();
      if (!found.includes(phrase)) found.push(phrase);
      if (found.length >= MAX_MATCHES) return { flagged: true, matches: found };
    }
  }
  return { flagged: found.length > 0, matches: found };
}

const NOTICE = [
  "I'm really sorry you're hurting this much, and I'm glad you put it into words. You deserve support from a real person right now.",
  'If you might act on these thoughts or feel unsafe, please call your local emergency number. In the US you can call or text 988 at any time; elsewhere, findahelpline.com lists free, confidential helplines by country.',
  "If there is someone you trust, a friend, a family member or a doctor, consider telling them how you feel today. This journal is not a substitute for professional help, but I'm here if you want to keep writing.",
].join('\n\n');

/**
 * The static message shown (and saved as an assistant message with `meta.kind: 'safety'`) when
 * detectCrisis() fires. Plain text, region-neutral, no markdown.
 * @returns {string}
 */
export function crisisNotice() {
  return NOTICE;
}
