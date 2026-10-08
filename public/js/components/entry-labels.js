// Pure helpers for the editable emotion / tag chips (limits mirror ARCHITECTURE §4: emotions ≤ 5,
// tags ≤ 8, each ≤ 24 characters, lowercase). The server normalises again; this keeps the UI honest.

export const LABEL_LIMITS = Object.freeze({
  emotions: Object.freeze({ max: 5, maxLen: 24 }),
  tags: Object.freeze({ max: 8, maxLen: 24 }),
});

/** Trim, drop a leading #, collapse whitespace, lowercase and cap at `maxLen` characters. */
export function normalizeLabel(raw, maxLen = 24) {
  const cleaned = String(raw ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
  return Array.from(cleaned).slice(0, maxLen).join('').trim();
}

/**
 * Add a label to a list without mutating it.
 * @param {string[]} list
 * @param {string} raw
 * @param {{ max: number, maxLen: number }} limits
 * @returns {{ list: string[], added: string|null, reason: '' | 'empty' | 'duplicate' | 'full' }}
 */
export function addLabel(list, raw, limits) {
  const label = normalizeLabel(raw, limits.maxLen);
  if (!label) return { list, added: null, reason: 'empty' };
  if (list.includes(label)) return { list, added: null, reason: 'duplicate' };
  if (list.length >= limits.max) return { list, added: null, reason: 'full' };
  return { list: [...list, label], added: label, reason: '' };
}

export function removeLabel(list, label) {
  return list.filter((item) => item !== label);
}
