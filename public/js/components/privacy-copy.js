// Wording about what the AI provider receives. Kept in one place (pure strings, no DOM) so Settings, the entry menu and the
// Memory page cannot drift apart, and so a test can pin the claims to what docs/PRIVACY.md and the server really do:
//   * a reply sends the conversation, today's date, your name and "About you" text, the companion's style (and the description
//     you wrote for a custom voice), memories, the logged mood, a guided session's instructions and, with "Recall related past
//     entries" on, short excerpts of older entries (never private ones);
//   * a wrap-up also sends the entry text for the title, summary and memory steps and up to 12 existing memories; a weekly
//     reflection sends titles, summaries, mood, feelings and tags of up to 200 non-private entries (DATA_SENT_WITH_AI_STEPS);
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
  + 'your name and “About you” text, your companion\'s style (the voice you chose, and the description you wrote if you made your own), your memories, the mood you logged for the entry, a guided session\'s instructions and, if “Recall related past entries” is on, '
  + 'a few short excerpts of older entries (never private ones) to the provider you chose, and nothing else.';

/** Settings > Data, right after the reply sentence: "and nothing else" is true for a reply only; the other two AI jobs send a little more. */
export const DATA_SENT_WITH_AI_STEPS = 'A wrap-up sends more than a reply: your entry text again for the title, summary and memory steps, plus up to 12 of your existing memories for the memory step. '
  + 'A weekly reflection sends the titles, summaries, mood, feelings and tags of up to 200 non-private entries from the period (a short excerpt of what you wrote where there is no summary), '
  + 'with your memories, name, “About you” text and companion style.';
