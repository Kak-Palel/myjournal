// Stateful, chunk-boundary-safe removal of <think>, <thinking> and <reasoning> blocks from streamed
// model output (DeepSeek-R1 / Qwen3 / gpt-oss style reasoning that some servers inline in `content`).
//
// Design notes
//  * Only an exact, attribute-free opening tag starts a block, so "a < b", "<3", "<b>bold</b>" or
//    "<thinker>" pass through untouched.
//  * When the end of a chunk could still turn into an opening tag ("<thi") the tail is held back (at most
//    10 characters) and is released as ordinary text as soon as it stops matching, or at end of stream.
//  * Inside a block everything is dropped, except a tail that may be the start of the closing tag.
//  * Whitespace directly after a removed block is trimmed, so "<think>..</think>\n\nHello" -> "Hello".
//  * A trailing lone high surrogate is held back until its partner arrives, so every string handed out is
//    well-formed Unicode and safe to encode on its own (emoji split across two deltas).

const NAMES = ['think', 'thinking', 'reasoning'];
// toLowerCase() can change a string's length for exotic characters, which would corrupt the indexes
// used below; tag names are ASCII, so only ASCII letters are folded.
const lowerAscii = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

const OPEN_TAGS = NAMES.map((name) => ({ name, text: `<${name}>`, close: `</${name}>` }));
const LONGEST_OPEN_TAG = Math.max(...OPEN_TAGS.map((tag) => tag.text.length));

// Cost note: case-folding is O(length), so it must never be applied to "the rest of the buffer" once per tag or
// per block (a 200 KB chunk of "<a>" took seconds and froze the event loop). Opening tags only look at a
// bounded window, closing tags search one folded copy of the chunk that is built at most once per push().

/**
 * @param {string} buf
 * @param {number} pos index of a '<' in `buf`
 * @returns {{tag: object}|{partial: true}|null}
 */
function matchOpenTag(buf, pos) {
  const head = lowerAscii(buf.slice(pos, pos + LONGEST_OPEN_TAG));
  for (const tag of OPEN_TAGS) {
    if (head.startsWith(tag.text)) return { tag };
  }
  // Fewer characters left than the tag is long (so `head` is all there is): the stream may still complete it.
  if (OPEN_TAGS.some((tag) => buf.length - pos < tag.text.length && tag.text.startsWith(head))) return { partial: true };
  return null;
}

/** Longest suffix of `buf` (not reaching back before `from`) that is a proper prefix of `closeTag` (case-insensitive). */
function pendingCloseTail(buf, from, closeTag) {
  const tail = buf.slice(Math.max(from, buf.length - (closeTag.length - 1)));
  const lower = lowerAscii(tail);
  for (let n = lower.length; n > 0; n -= 1) {
    if (closeTag.startsWith(lower.slice(lower.length - n))) return tail.slice(tail.length - n);
  }
  return '';
}

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

/**
 * @returns {{
 *   push(chunk: string): string,
 *   end(): {text: string, unterminated: boolean},
 *   readonly inThink: boolean,
 *   readonly hasVisibleText: boolean,
 * }}
 */
export function createThinkFilter() {
  let inThink = false;
  let closeTag = '';
  let pending = '';
  let trimLeading = false;
  let visible = false;
  let heldSurrogate = '';

  function emit(out, text) {
    if (!text) return out;
    let piece = text;
    if (trimLeading) {
      piece = piece.replace(/^\s+/, '');
      if (piece) trimLeading = false;
    }
    return out + piece;
  }

  function release(out) {
    let text = heldSurrogate + out;
    heldSurrogate = '';
    if (text && isHighSurrogate(text.charCodeAt(text.length - 1))) {
      heldSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    if (!visible && /\S/.test(text)) visible = true;
    return text;
  }

  return {
    /** @param {string} chunk @returns {string} text that is safe to show now (possibly '') */
    push(chunk) {
      const buf = pending + (chunk || '');
      pending = '';
      let pos = 0;
      let lower = null;
      const folded = () => (lower === null ? (lower = lowerAscii(buf)) : lower);
      let out = '';
      for (;;) {
        if (inThink) {
          const idx = folded().indexOf(closeTag, pos);
          if (idx === -1) {
            pending = pendingCloseTail(buf, pos, closeTag);
            break;
          }
          pos = idx + closeTag.length;
          inThink = false;
          trimLeading = true;
          continue;
        }
        const lt = buf.indexOf('<', pos);
        if (lt === -1) {
          out = emit(out, buf.slice(pos));
          break;
        }
        out = emit(out, buf.slice(pos, lt));
        pos = lt;
        const found = matchOpenTag(buf, pos);
        if (found && found.partial) {
          pending = buf.slice(pos);
          break;
        }
        if (found) {
          inThink = true;
          closeTag = found.tag.close;
          pos += found.tag.text.length;
          continue;
        }
        out = emit(out, '<');
        pos += 1;
      }
      return release(out);
    },

    /** Call once when the stream is over. `unterminated` is true if a block was still open. */
    end() {
      const unterminated = inThink;
      let out = '';
      if (!inThink) out = emit(out, pending);
      pending = '';
      let text = heldSurrogate + out;
      heldSurrogate = '';
      if (!visible && /\S/.test(text)) visible = true;
      inThink = false;
      return { text, unterminated };
    },

    get inThink() { return inThink; },
    /** True once any non-whitespace text has been handed out. */
    get hasVisibleText() { return visible; },
  };
}

/**
 * One-shot helper for non-streamed content.
 * @param {string} text
 * @returns {string} text without think blocks (an unterminated block is dropped)
 */
export function stripThinkBlocks(text) {
  const filter = createThinkFilter();
  return filter.push(String(text ?? '')) + filter.end().text;
}
