// Draft autosave for the composers. A draft lives in localStorage under one key per entry
// ("mj-draft:<entryId>", or "mj-draft:new" on the Today page) and is removed once the text is saved.
// Storage can be missing, full or blocked (private windows, strict settings), so every access is
// wrapped: the page must behave identically without it.

export const DRAFT_PREFIX = 'mj-draft:';
export const NEW_DRAFT_ID = 'new';
const MAX_DRAFT_CHARS = 500_000; // localStorage holds ~5M characters in total; never let one draft eat it

/** Storage key for an entry's draft. */
export function draftKey(entryId) {
  const id = String(entryId ?? '').trim();
  return DRAFT_PREFIX + (id || NEW_DRAFT_ID);
}

/** The browser's localStorage, or null when it is unavailable. */
export function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** @returns {string} the saved draft or '' */
export function readDraft(key, storage = defaultStorage()) {
  if (!storage) return '';
  try { return storage.getItem(key) || ''; } catch { return ''; }
}

/** Save `text`; whitespace-only text removes the draft. @returns {boolean} true when stored (or removed) */
export function writeDraft(key, text, storage = defaultStorage()) {
  if (!storage) return false;
  try {
    if (!text || !text.trim()) { storage.removeItem(key); return true; }
    if (text.length > MAX_DRAFT_CHARS) return false;
    storage.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}

export function removeDraft(key, storage = defaultStorage()) {
  if (!storage) return;
  try { storage.removeItem(key); } catch { /* ignore */ }
}

/**
 * Debounced saver. `flush()` writes immediately (call it on navigation and page hide) and
 * `clear()` cancels any pending write and deletes the draft.
 * @param {{ key: string, storage?: Storage|null, delay?: number }} opts
 */
export function createDraftSaver({ key, storage = defaultStorage(), delay = 400 }) {
  let timer = null;
  let latest = null; // text waiting to be written, or null

  function write() {
    timer = null;
    if (latest === null) return;
    const text = latest;
    latest = null;
    writeDraft(key, text, storage);
  }

  return {
    save(text) {
      latest = text;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(write, delay);
    },
    flush() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      write();
    },
    clear() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      latest = null;
      removeDraft(key, storage);
    },
  };
}
