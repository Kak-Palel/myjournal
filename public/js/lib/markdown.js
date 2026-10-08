// Markdown-lite for AI replies and reports. Safety model: we never produce HTML strings.
// parseMarkdown() builds a plain-data AST; renderMarkdown() turns that AST into DOM nodes using
// createElement/createTextNode, so there is nothing to escape and nothing that can become markup.
// Links are deliberately rendered as plain text (a model should not be able to place clickable URLs
// in a private journal). Unbalanced or unknown syntax stays literal text.
//
// Pure functions (parse*) never touch `document`, so they are unit-tested in Node.

const MAX_INPUT = 200_000; // hard cap so a pathological response cannot freeze the tab
const MAX_SPAN = 1500; // an emphasis span longer than this is treated as literal text (keeps scanning linear-ish)

/* ----------------------------------------------------------------- inline */
/**
 * @typedef {{t:'text',v:string}|{t:'strong',c:Inline[]}|{t:'em',c:Inline[]}|{t:'code',v:string}|{t:'br'}} Inline
 */

/** Parse inline syntax: `code`, **bold**, __bold__, *italic*, _italic_, [text](url) → text. */
export function parseInline(src, depth = 0) {
  /** @type {Inline[]} */
  const out = [];
  let text = '';
  const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = ''; } };
  const s = String(src);
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (ch === '\\' && i + 1 < s.length && /[\\`*_[\]()#>~-]/.test(s[i + 1])) { // escaped punctuation
      text += s[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) { flush(); out.push({ t: 'code', v: s.slice(i + 1, end) }); i = end + 1; continue; }
    }

    if ((ch === '*' || ch === '_') && s[i + 1] === ch && depth < 4) { // strong
      const end = findClose(s, i + 2, ch + ch);
      if (end !== -1) { flush(); out.push({ t: 'strong', c: parseInline(s.slice(i + 2, end), depth + 1) }); i = end + 2; continue; }
    }

    if ((ch === '*' || ch === '_') && depth < 4) { // emphasis
      const prev = i > 0 ? s[i - 1] : ' ';
      const next = s[i + 1];
      const wordBoundary = ch === '*' || !/[\p{L}\p{N}]/u.test(prev); // snake_case stays literal
      if (wordBoundary && next && !/\s/.test(next) && next !== ch) {
        const end = findClose(s, i + 1, ch);
        if (end !== -1) { flush(); out.push({ t: 'em', c: parseInline(s.slice(i + 1, end), depth + 1) }); i = end + 1; continue; }
      }
    }

    if (ch === '[') { // [label](url) → just the label
      const m = /^\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/.exec(s.slice(i, i + 720));
      if (m) { text += m[1]; i += m[0].length; continue; }
    }

    if (ch === '\n') { flush(); out.push({ t: 'br' }); i += 1; continue; }

    text += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Index of the closing delimiter `delim` at/after `from` whose preceding char is not whitespace; -1 if none. */
function findClose(s, from, delim) {
  let idx = from;
  for (;;) {
    idx = s.indexOf(delim, idx);
    if (idx === -1 || idx - from > MAX_SPAN) return -1;
    if (idx > from && !/\s/.test(s[idx - 1])) {
      // for single-char delimiters, don't close on a doubled delimiter (that would be a strong opener)
      if (delim.length === 1 && s[idx + 1] === delim) { idx += 2; continue; }
      return idx;
    }
    idx += delim.length;
  }
}

/* ------------------------------------------------------------------ blocks */
/**
 * @typedef {{type:'p',inline:Inline[]}|{type:'h',level:number,inline:Inline[]}|{type:'ul',items:Inline[][]}
 *   |{type:'ol',start:number,items:Inline[][]}|{type:'quote',blocks:Block[]}|{type:'code',text:string,lang:string}|{type:'hr'}} Block
 */

const RE_FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_UL = /^\s{0,3}[-*•]\s+(.*)$/;
const RE_OL = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** Parse markdown-lite into a block AST. */
export function parseMarkdown(src, depth = 0) {
  const text = String(src ?? '').slice(0, MAX_INPUT).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  /** @type {Block[]} */
  const blocks = [];
  let para = [];

  const flushPara = () => {
    if (para.length) { blocks.push({ type: 'p', inline: parseInline(para.join('\n').trim()) }); para = []; }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fence = RE_FENCE.exec(line);
    if (fence) {
      flushPara();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) { body.push(lines[i]); i += 1; }
      blocks.push({ type: 'code', text: body.join('\n'), lang: fence[2] || '' });
      continue;
    }

    if (line.trim() === '') { flushPara(); continue; }

    if (RE_HR.test(line)) { flushPara(); blocks.push({ type: 'hr' }); continue; }

    const heading = RE_HEADING.exec(line);
    if (heading) { flushPara(); blocks.push({ type: 'h', level: heading[1].length, inline: parseInline(heading[2]) }); continue; }

    if (RE_UL.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && RE_UL.test(lines[i])) { items.push(parseInline(RE_UL.exec(lines[i])[1])); i += 1; }
      i -= 1;
      blocks.push({ type: 'ul', items });
      continue;
    }

    const ol = RE_OL.exec(line);
    if (ol) {
      flushPara();
      const start = Number(ol[1]);
      const items = [];
      while (i < lines.length && RE_OL.test(lines[i])) { items.push(parseInline(RE_OL.exec(lines[i])[2])); i += 1; }
      i -= 1;
      blocks.push({ type: 'ol', start, items });
      continue;
    }

    if (RE_QUOTE.test(line) && depth < 3) {
      flushPara();
      const inner = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) { inner.push(RE_QUOTE.exec(lines[i])[1]); i += 1; }
      i -= 1;
      blocks.push({ type: 'quote', blocks: parseMarkdown(inner.join('\n'), depth + 1) });
      continue;
    }

    para.push(line);
  }
  flushPara();
  return blocks;
}

/* --------------------------------------------------------------- rendering */
function inlineToNodes(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.t === 'text') out.push(document.createTextNode(n.v));
    else if (n.t === 'br') out.push(document.createElement('br'));
    else if (n.t === 'code') { const el = document.createElement('code'); el.className = 'code'; el.textContent = n.v; out.push(el); }
    else {
      const el = document.createElement(n.t === 'strong' ? 'strong' : 'em');
      for (const child of inlineToNodes(n.c)) el.appendChild(child);
      out.push(el);
    }
  }
  return out;
}

function blockToNode(b) {
  switch (b.type) {
    case 'p': { const el = document.createElement('p'); inlineToNodes(b.inline).forEach((c) => el.appendChild(c)); return el; }
    case 'h': {
      const el = document.createElement(`h${Math.min(6, Math.max(3, b.level + 2))}`); // # → h3 … keeps chat headings modest
      el.className = 'md-heading';
      inlineToNodes(b.inline).forEach((c) => el.appendChild(c));
      return el;
    }
    case 'ul':
    case 'ol': {
      const el = document.createElement(b.type);
      if (b.type === 'ol' && b.start !== 1) el.setAttribute('start', String(b.start));
      for (const item of b.items) {
        const li = document.createElement('li');
        inlineToNodes(item).forEach((c) => li.appendChild(c));
        el.appendChild(li);
      }
      return el;
    }
    case 'quote': { const el = document.createElement('blockquote'); b.blocks.forEach((x) => el.appendChild(blockToNode(x))); return el; }
    case 'code': {
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      const code = document.createElement('code');
      code.textContent = b.text;
      pre.appendChild(code);
      return pre;
    }
    case 'hr': return document.createElement('hr');
    default: return document.createDocumentFragment();
  }
}

/** Render markdown-lite to a DocumentFragment of DOM nodes. */
export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  for (const b of parseMarkdown(src)) frag.appendChild(blockToNode(b));
  return frag;
}

/** Render only inline syntax (titles, chips) to an array of nodes. */
export function renderInline(src) {
  return inlineToNodes(parseInline(src));
}
