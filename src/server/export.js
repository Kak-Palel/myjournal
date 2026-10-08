// Markdown rendering of entries and of the whole journal (the `export.md` / `?format=markdown` downloads).
// Plain text in, plain text out: nothing here produces HTML.

import { MOOD_LABELS } from '../journal/context.js';
import { formatLongDate } from '../journal/dates.js';

const ASSISTANT_LABELS = Object.freeze({
  prompt: 'Prompt',
  wrapup: 'Reflection',
  safety: 'A gentle note',
});

/** ASCII file name part: "Café walk!" -> "cafe-walk"; '' when nothing usable is left. */
export function slugify(text, max = 40) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** `title-2026-10-08.md` style name for an entry download. */
export function entryFilename(entry) {
  return `${slugify(entry.title) || 'entry'}-${entry.date || 'journal'}.md`;
}

function speakerLabel(message) {
  if (message.role === 'user') return 'You';
  return ASSISTANT_LABELS[message.meta && message.meta.kind] || 'Companion';
}

const quote = (text) => text.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n');

/**
 * One entry as Markdown.
 * @param {object} entry
 * @param {object[]} messages
 * @param {{ level?: number }} [opts] heading level of the title (1 for a single entry, 2 inside a bigger export)
 * @returns {string}
 */
export function entryToMarkdown(entry, messages, { level = 1 } = {}) {
  const bits = [];
  const date = formatLongDate(entry.date);
  if (date) bits.push(date);
  if (entry.mood) bits.push(`Mood: ${MOOD_LABELS[entry.mood] || entry.mood} (${entry.mood}/5)`);
  if (entry.emotions.length > 0) bits.push(`Feelings: ${entry.emotions.join(', ')}`);
  if (entry.tags.length > 0) bits.push(`Tags: ${entry.tags.join(', ')}`);
  if (entry.private) bits.push('Private');

  const out = [`${'#'.repeat(level)} ${(entry.title || 'Untitled entry').replace(/\s+/g, ' ')}`, ''];
  if (bits.length > 0) out.push(`*${bits.join(' · ')}*`, '');
  if (entry.summary) out.push(quote(`**Summary:** ${entry.summary}`), '');
  if (messages.length > 0) out.push('---', '');
  for (const message of messages) {
    out.push(`**${speakerLabel(message)}**`, '', message.content.trim(), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * The whole journal as one Markdown document.
 * @param {{ exportedAt: number, entries: object[], memories: object[], reports: object[] }} doc the result of db.exportAll()
 * @returns {string}
 */
export function journalToMarkdown(doc) {
  const exported = new Date(doc.exportedAt);
  const stamp = Number.isNaN(exported.getTime()) ? '' : ` on ${exported.toISOString().slice(0, 10)}`;
  const out = ['# MyJournal export', '', `Exported${stamp}: ${doc.entries.length} ${doc.entries.length === 1 ? 'entry' : 'entries'}, ${doc.memories.length} ${doc.memories.length === 1 ? 'memory' : 'memories'}.`, ''];
  for (const entry of doc.entries) {
    out.push('---', '', entryToMarkdown(entry, entry.messages || [], { level: 2 }).trimEnd(), '');
  }
  if (doc.memories.length > 0) {
    out.push('---', '', '## Memories', '', ...doc.memories.map((m) => `- ${m.text.replace(/\s+/g, ' ')}${m.pinned ? ' (pinned)' : ''}`), '');
  }
  if (doc.reports.length > 0) {
    out.push('---', '', '## Weekly reflections', '');
    for (const report of doc.reports) out.push(`### ${report.periodStart} to ${report.periodEnd}`, '', report.content.trim(), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
