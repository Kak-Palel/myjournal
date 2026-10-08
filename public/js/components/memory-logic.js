// Pure logic for the Memory view (no DOM): ordering, filtering, validation and wording.

/** Longest memory the server accepts (ARCHITECTURE section 6). Counted in UTF-16 units, like maxlength. */
export const MAX_MEMORY_CHARS = 300;
/** Show the filter box once the list is longer than this. */
export const FILTER_THRESHOLD = 6;

/** Pinned first, then newest first. Drops anything that is not a memory with text. */
export function sortMemories(list) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string')
    .sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))) || ((Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)));
}

/** Case-insensitive substring filter over memory text. An empty query keeps everything. */
export function filterMemories(list, query) {
  const q = String(query || '').trim().toLowerCase();
  return q ? list.filter((m) => m.text.toLowerCase().includes(q)) : list;
}

/**
 * Check text typed for a new or edited memory.
 * @returns {{ ok: true, text: string } | { ok: false, problem: string }}
 */
export function validateMemoryText(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, problem: 'Write a short fact first, for example "Has a younger sister called Maya".' };
  if (text.length > MAX_MEMORY_CHARS) return { ok: false, problem: `Keep it under ${MAX_MEMORY_CHARS} characters (it is ${text.length}).` };
  return { ok: true, text };
}

/** "No memories", "1 memory", "12 memories". */
export function countLabel(n) {
  const c = Math.max(0, Math.trunc(Number(n) || 0));
  if (c === 0) return 'No memories yet';
  return `${c.toLocaleString()} ${c === 1 ? 'memory' : 'memories'}`;
}

/** Merge a server memory into a list (replace by id, or add), keeping the canonical order. */
export function upsertMemory(list, memory) {
  const rest = list.filter((m) => m.id !== memory.id);
  return sortMemories([memory, ...rest]);
}

/**
 * Which master switches are usable: autoExtract and useRelatedEntries are meaningless while memory is off.
 * @param {{enabled: boolean}} memory
 */
export function switchState(memory) {
  const on = Boolean(memory && memory.enabled);
  return { enabled: true, autoExtract: on, useRelatedEntries: on };
}
