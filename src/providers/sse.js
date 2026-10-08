// Incremental Server-Sent-Events and NDJSON readers.
//
// Everything here is split-invariant: feeding a payload in one piece, byte by byte, or cut at any
// other boundary (inside a multi-byte UTF-8 sequence, between the CR and the LF of a CRLF, in the
// middle of a field name) produces exactly the same events. The tests enforce that for every cut.

/** Default ceiling for a single un-terminated line / event, to stop a hostile server filling memory. */
export const DEFAULT_MAX_BUFFER_CHARS = 8 * 1024 * 1024;

export class SseOverflowError extends Error {
  constructor(limit) {
    super(`Stream line exceeded ${limit} characters without a line break.`);
    this.name = 'SseOverflowError';
    this.code = 'SSE_OVERFLOW';
  }
}

/**
 * Splits text chunks into lines. A line ends at LF, CR or CRLF; a CR at the very end of a chunk is
 * remembered so that an LF starting the next chunk is not mistaken for an empty line.
 * @param {{maxLineChars?: number}} [opts]
 */
export function createLineSplitter({ maxLineChars = DEFAULT_MAX_BUFFER_CHARS } = {}) {
  let buffer = '';
  let skipLF = false;
  let started = false;

  return {
    /** @param {string} text @returns {string[]} the lines completed by this chunk */
    push(text) {
      if (!text) return [];
      if (!started) {
        started = true;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        if (!text) return [];
      }
      let start = 0;
      if (skipLF) {
        skipLF = false;
        if (text.charCodeAt(0) === 10) start = 1;
      }
      const lines = [];
      for (let i = start; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (c !== 10 && c !== 13) continue;
        lines.push(buffer + text.slice(start, i));
        buffer = '';
        if (c === 13) {
          if (i + 1 < text.length) {
            if (text.charCodeAt(i + 1) === 10) i += 1;
          } else {
            skipLF = true;
          }
        }
        start = i + 1;
      }
      buffer += text.slice(start);
      if (buffer.length > maxLineChars) throw new SseOverflowError(maxLineChars);
      return lines;
    },
    /** @returns {string[]} the final, un-terminated line if there is one */
    end() {
      const rest = buffer;
      buffer = '';
      skipLF = false;
      return rest ? [rest] : [];
    },
  };
}

/**
 * @typedef {object} SseEvent
 * @property {string} event event name ('message' when the server sent none)
 * @property {string} data  data lines joined with "\n"
 * @property {string} [id]
 * @property {number} [retry]
 */

/**
 * Incremental SSE parser. `data:{"a":1}` (no space), `data: x` (one space stripped), comment lines
 * (": keep-alive"), multi-line data, `event:`/`id:`/`retry:` are handled. At end of input a trailing
 * event that was not closed by a blank line is still delivered: LLM servers that just close the socket
 * after the last chunk exist, and dropping their final token would be worse than being lenient.
 * @param {{maxLineChars?: number}} [opts]
 */
export function createSseParser(opts = {}) {
  const splitter = createLineSplitter(opts);
  const maxChars = opts.maxLineChars ?? DEFAULT_MAX_BUFFER_CHARS;
  let eventName = '';
  let dataLines = [];
  let dataChars = 0;
  let id;
  let retry;

  function dispatch(out) {
    if (dataLines.length > 0) {
      const ev = { event: eventName || 'message', data: dataLines.join('\n') };
      if (id !== undefined) ev.id = id;
      if (retry !== undefined) ev.retry = retry;
      out.push(ev);
    }
    eventName = '';
    dataLines = [];
    dataChars = 0;
    id = undefined;
    retry = undefined;
  }

  function onLine(line, out) {
    if (line === '') {
      dispatch(out);
      return;
    }
    if (line.charCodeAt(0) === 58) return; // ':' comment
    const colon = line.indexOf(':');
    let field = line;
    let value = '';
    if (colon !== -1) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 32) value = value.slice(1);
    }
    if (field === 'data') {
      dataLines.push(value);
      dataChars += value.length + 1;
      if (dataChars > maxChars) throw new SseOverflowError(maxChars);
    } else if (field === 'event') {
      eventName = value;
    } else if (field === 'id') {
      if (!value.includes('\0')) id = value;
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) retry = Number(value);
    }
  }

  return {
    /** @param {string} text @returns {SseEvent[]} */
    push(text) {
      const out = [];
      for (const line of splitter.push(text)) onLine(line, out);
      return out;
    },
    /** Flush at end of stream. @returns {SseEvent[]} */
    end() {
      const out = [];
      for (const line of splitter.end()) onLine(line, out);
      dispatch(out);
      return out;
    },
  };
}

/**
 * Newline-delimited reader (Ollama's /api/pull). Blank lines are skipped.
 * @param {{maxLineChars?: number}} [opts]
 */
export function createNdjsonReader(opts = {}) {
  const splitter = createLineSplitter(opts);
  const keep = (lines) => lines.map((l) => l.trim()).filter(Boolean);
  return {
    /** @param {string} text @returns {string[]} */
    push: (text) => keep(splitter.push(text)),
    /** @returns {string[]} */
    end: () => keep(splitter.end()),
  };
}

/**
 * Turn an async iterable of Uint8Array (or string) chunks into text, decoding UTF-8 incrementally so a
 * multi-byte character cut in half by the network is reassembled, not replaced with U+FFFD.
 * @param {AsyncIterable<Uint8Array|string>} chunks
 * @returns {AsyncGenerator<string>}
 */
export async function* decodeChunks(chunks) {
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/**
 * @param {AsyncIterable<Uint8Array|string>} chunks
 * @param {{maxLineChars?: number}} [opts]
 * @returns {AsyncGenerator<SseEvent>}
 */
export async function* iterateSse(chunks, opts) {
  const parser = createSseParser(opts);
  for await (const text of decodeChunks(chunks)) {
    for (const ev of parser.push(text)) yield ev;
  }
  for (const ev of parser.end()) yield ev;
}

/**
 * Yield parsed JSON objects from an NDJSON stream. Lines that are not valid JSON are skipped.
 * @param {AsyncIterable<Uint8Array|string>} chunks
 * @param {{maxLineChars?: number}} [opts]
 * @returns {AsyncGenerator<any>}
 */
export async function* iterateNdjson(chunks, opts) {
  const reader = createNdjsonReader(opts);
  const parse = function* (lines) {
    for (const line of lines) {
      try { yield JSON.parse(line); } catch { /* not JSON: ignore the line */ }
    }
  };
  for await (const text of decodeChunks(chunks)) yield* parse(reader.push(text));
  yield* parse(reader.end());
}
