// Cheap token estimation. Real tokenizers differ per model, so this errs on the high side.
// For Latin text it is exactly ceil(chars / 3.5) (ARCHITECTURE section 8). Scripts that tokenizers
// split much more finely are weighted up, otherwise a Japanese or Russian journal would overflow the
// small context window of a local model while the estimate still said "fits".

/** Fixed per-message cost of the chat template (role markers, separators). */
export const MESSAGE_OVERHEAD_TOKENS = 4;

// Roughly one token per character (CJK, Kana, Hangul, Thai and friends).
const WIDE_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu;
// Non-Latin alphabets: about two characters per token on common tokenizers.
const SPARSE_RE = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Georgian}\p{Script=Armenian}]/gu;
// Emoji cost 2-4 tokens each but occupy only two UTF-16 units.
const PICTO_RE = /\p{Extended_Pictographic}/gu;

function countMatches(text, re) {
  const found = text.match(re);
  return found ? found.length : 0;
}

/**
 * Approximate token count of a text (never negative, 0 for empty or non-string input).
 * @param {unknown} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0;
  const wide = countMatches(text, WIDE_RE);
  const sparse = countMatches(text, SPARSE_RE);
  const picto = countMatches(text, PICTO_RE);
  // Astral wide characters (CJK extension B, emoji) take two UTF-16 units; subtract what is priced separately.
  const priced = wide + sparse + picto * 2;
  const rest = Math.max(0, text.length - priced);
  return Math.ceil(rest / 3.5 + wide + sparse / 2 + picto * 2);
}

/**
 * Estimated size of a chat prompt: content tokens plus a small fixed cost per message.
 * @param {{content?: string}[]} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    total += estimateTokens(m && m.content) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}
