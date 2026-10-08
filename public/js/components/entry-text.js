// Pure text helpers for rendering journal text safely and readably (no DOM).

const LONG_CHARS = 1800;
const LONG_LINES = 18;
const MAX_BLOCKS = 400;

/**
 * Split user text into paragraphs on blank lines, so each paragraph can get its own text direction
 * (a mix of English and Arabic in one entry lines up correctly). Single newlines stay inside a paragraph.
 * Pathologically fragmented text is returned as one block to keep the DOM small.
 * @param {string} text
 * @returns {string[]}
 */
export function splitParagraphs(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  const blocks = raw.split(/\n[ \t]*\n+/).map((b) => b.replace(/^\n+|\s+$/g, '')).filter((b) => b.trim());
  return blocks.length > MAX_BLOCKS ? [raw.trim()] : blocks;
}

/** Long messages are collapsed behind "Show more" so a 100 000-character paste does not bury the thread. */
export function isLongText(text) {
  const s = String(text ?? '');
  if (s.length > LONG_CHARS) return true;
  let lines = 0;
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10 && (lines += 1) > LONG_LINES) return true;
  return false;
}

/**
 * What stays in the writing box once `sent` has been saved. Normally nothing; but the box stays editable
 * while the request is in flight, so words typed (or dictated) in the meantime must survive.
 * If the writer changed the saved text itself nothing is dropped: a duplicate beats lost words.
 * @param {string} current the box's value now
 * @param {string} sent the text that was saved
 * @returns {string}
 */
export function remainderAfterSend(current, sent) {
  const text = String(current ?? '');
  const saved = String(sent ?? '').trim();
  const body = text.trim();
  if (body === saved) return '';
  // Only the outer edge is trimmed: a trailing space the writer just typed must stay, or their next word would glue on.
  const start = text.trimStart();
  if (saved && start.startsWith(saved)) return start.slice(saved.length).trimStart();
  const end = text.trimEnd();
  if (saved && end.endsWith(saved)) return end.slice(0, end.length - saved.length).trimEnd();
  return text;
}

/** "1,234 words" style counter text. */
export function wordsLabel(n) {
  const count = Number.isFinite(n) ? n : 0;
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'word' : 'words'}`;
}
