// Pure helpers about the shape of an entry's conversation (no DOM): unit-tested in Node.

/** The static crisis card the server persists when it spots a crisis keyword (`meta.kind: 'safety'`). */
export function isSafetyMessage(message) {
  return Boolean(message && message.role === 'assistant' && message.meta && message.meta.kind === 'safety');
}

/**
 * The last message that is part of the actual conversation: safety cards are skipped because they are
 * not a reply. Without this, a safety card followed by a provider error leaves the user's message
 * looking answered, so neither "Get a reply" nor "Try again" would be offered.
 * @param {{ role?: string, meta?: object }[]} messages
 * @returns {object | null}
 */
export function trailingMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!isSafetyMessage(list[i])) return list[i];
  }
  return null;
}
