// Wording about what the AI provider receives. Kept in one place (pure strings, no DOM) so Settings, the entry menu and the
// Memory page cannot drift apart, and so a test can pin the claims to what docs/PRIVACY.md and the server really do:
//   * a reply sends the conversation, today's date, your name and "About you" text, memories, the logged mood, a guided session's
//     instructions and, with "Recall related past entries" on, short excerpts of older entries (never private ones);
//   * a private entry is kept out of memory, recall and weekly reflections, but its own conversation is still sent when
//     a reply is requested in it. "Save without reply" is what keeps text away from the provider.

/** The clause every description of the Private switch carries. */
export const PRIVATE_STILL_SENT = 'Replies in a private entry are still written by your AI provider; use Save without reply to keep text away from it.';

/** Entry menu, under "Private entry". */
export const PRIVATE_MENU_DESCRIPTION = `Keeps it out of memory, recall and weekly reflections. ${PRIVATE_STILL_SENT}`;

/** Tooltip of the "Private" flag in an entry's header. */
export const PRIVATE_FLAG_TITLE = `Private: kept out of memory, recall and weekly reflections. ${PRIVATE_STILL_SENT}`;

/** Memory page: the point about private entries. */
export const PRIVATE_MEMORY_TITLE = 'Private entries stay out of memory';
export const PRIVATE_MEMORY_TEXT = `If you mark an entry private, it is left out of memory, recall and weekly reflections. ${PRIVATE_STILL_SENT}`;

/** Settings > Data > "Where your data lives": the complete list of what a reply sends. */
export const DATA_SENT_WITH_A_REPLY = 'Nothing leaves your computer unless the AI companion is on. Then each reply sends the current conversation, today\'s date, '
  + 'your name and "About you" text, your memories, the mood you logged for the entry, a guided session\'s instructions and, if "Recall related past entries" is on, '
  + 'a few short excerpts of older entries (never private ones) to the provider you chose, and nothing else.';
