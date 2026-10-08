// One message in the entry thread. User text is rendered as plain text nodes in paragraphs; AI text
// goes through renderMarkdown. Nothing here builds HTML strings.
import { h } from '../lib/dom.js';
import { icon, formatTime, autosize } from '../lib/ui.js';
import { renderMarkdown } from '../lib/markdown.js';
import { splitParagraphs, isLongText } from './entry-text.js';

const KIND_LABEL = {
  prompt: { icon: 'compass', text: 'Guided prompt' },
  wrapup: { icon: 'sparkles', text: 'Reflection' },
  safety: { icon: 'heart', text: 'A gentle note' },
};

/** Message kind for styling: prompt | reply | wrapup | safety (user messages: 'user'). */
export function messageKind(message) {
  if (message.role === 'user') return 'user';
  const k = message.meta && message.meta.kind;
  return k === 'prompt' || k === 'wrapup' || k === 'safety' ? k : 'reply';
}

/** User text → paragraphs of text nodes (one `dir="auto"` block each). */
function plainParagraphs(text) {
  return splitParagraphs(text).map((p) => h('p', { class: 'entry-p', dir: 'auto' }, p));
}

/** AI markdown → DOM, with every top-level block given its own text direction. */
export function aiContent(text) {
  const frag = renderMarkdown(text);
  for (const child of frag.children) child.setAttribute('dir', 'auto');
  return frag;
}

function iconButton({ label, iconName, onClick, className = '' }) {
  return h('button', { type: 'button', class: ['entry-act', className], 'aria-label': label, title: label, onClick }, icon(iconName, { size: 16 }));
}

/** Wrap long content in a collapsible region with a "Show more" toggle. */
function collapsible(content, text) {
  if (!isLongText(text)) return content;
  const region = h('div', { class: 'entry-clamp is-clamped' }, content);
  const toggle = h('button', {
    type: 'button', class: 'entry-more', 'aria-expanded': 'false',
    onClick: () => {
      const open = region.classList.toggle('is-clamped') === false;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? 'Show less' : 'Show more';
    },
  }, 'Show more');
  return h('div', { class: 'entry-clamp-wrap' }, region, toggle);
}

/**
 * Inline editor that replaces a user bubble's text. `onSave(text)` may reject; the error is shown inline.
 */
function createEditor(message, { onSave, onCancel }) {
  const textarea = h('textarea', { class: 'textarea entry-edit-input', 'aria-label': 'Edit your message', rows: 3 });
  textarea.value = message.content;
  const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const save = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Save changes');
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: onCancel }, 'Cancel');
  const fit = autosize(textarea, { maxHeight: 420 });

  async function commit() {
    const next = textarea.value.trim();
    if (!next) { error.textContent = 'A message cannot be empty. Cancel to keep the original, or delete the message.'; error.hidden = false; return; }
    if (next === message.content.trim()) { onCancel(); return; }
    save.disabled = true;
    save.textContent = 'Saving…';
    error.hidden = true;
    try {
      await onSave(next);
    } catch (err) {
      save.disabled = false;
      save.textContent = 'Save changes';
      error.textContent = err && err.message ? `${err.message} Your edit is still here.` : 'Could not save. Your edit is still here.';
      error.hidden = false;
    }
  }
  save.addEventListener('click', commit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); commit(); }
  });
  const el = h('div', { class: 'entry-edit' }, textarea, error, h('div', { class: 'entry-edit-actions' }, cancel, save));
  requestAnimationFrame(() => { fit(); textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); });
  return el;
}

/**
 * Render one persisted (or local "stopped") message.
 * @param {object} message
 * @param {object} opts
 * @param {boolean} [opts.canRegenerate] show "Regenerate" (last reply only)
 * @param {{ edit(message: object, text: string): Promise<void>, remove(message: object): void,
 *           regenerate(): void, copy(message: object): void }} opts.handlers
 * @returns {HTMLElement}
 */
export function renderMessage(message, { canRegenerate = false, handlers }) {
  const kind = messageKind(message);
  const stopped = Boolean(message.meta && message.meta.stopped);
  const edited = Boolean(message.meta && message.meta.edited);
  const local = Boolean(message.local);

  const footer = h('div', { class: 'entry-foot' });
  const time = h('span', { class: 'entry-time' }, formatTime(message.createdAt));
  footer.append(time);
  if (edited) footer.append(h('span', { class: 'entry-tag' }, 'edited'));
  if (stopped) footer.append(h('span', { class: 'entry-tag is-stopped' }, 'Stopped'));

  if (kind === 'user') {
    const body = h('div', { class: 'entry-text' }, plainParagraphs(message.content));
    const bubble = h('div', { class: 'entry-bubble' }, h('span', { class: 'sr-only' }, 'You wrote: '), collapsible(body, message.content));
    const el = h('article', { class: 'entry-msg entry-msg-user', dataset: { mid: message.id } }, bubble, footer);

    if (!local) {
      const actions = h('span', { class: 'entry-acts' });
      const edit = iconButton({
        label: 'Edit this message', iconName: 'edit', className: 'entry-act-edit',
        onClick: () => {
          const editor = createEditor(message, {
            onCancel: () => { bubble.replaceChildren(h('span', { class: 'sr-only' }, 'You wrote: '), collapsible(body, message.content)); footer.hidden = false; edit.focus(); },
            onSave: async (text) => { await handlers.edit(message, text); },
          });
          bubble.replaceChildren(editor);
          footer.hidden = true;
        },
      });
      actions.append(edit, iconButton({ label: 'Delete this message', iconName: 'trash', className: 'entry-act-delete', onClick: () => handlers.remove(message) }));
      footer.append(actions);
    }
    return el;
  }

  const label = KIND_LABEL[kind];
  const content = aiContent(message.content);
  const body = h('div', { class: 'entry-text' }, content);
  const head = label ? h('div', { class: 'entry-card-head' }, icon(label.icon, { size: 18 }), h('span', null, label.text)) : null;

  const actions = h('span', { class: 'entry-acts' });
  if (!local && kind !== 'safety') {
    actions.append(iconButton({ label: 'Copy this reply', iconName: 'copy', className: 'entry-act-copy', onClick: () => handlers.copy(message) }));
  }
  if (!local && canRegenerate && kind === 'reply') {
    actions.append(iconButton({ label: 'Regenerate this reply', iconName: 'refresh', className: 'entry-act-regen', onClick: () => handlers.regenerate() }));
  }
  if (actions.childElementCount) footer.append(actions);

  const bubble = h('div', { class: 'entry-bubble' },
    h('span', { class: 'sr-only' }, kind === 'safety' ? 'A gentle note: ' : 'Companion: '),
    head,
    collapsible(body, message.content));

  const avatar = kind === 'reply' || kind === 'prompt'
    ? h('span', { class: 'entry-avatar', 'aria-hidden': 'true' }, icon('sprout', { size: 16 }))
    : null;

  return h('article', {
    class: ['entry-msg', 'entry-msg-ai', `is-${kind}`, stopped ? 'is-stopped' : ''],
    dataset: { mid: message.id },
    role: kind === 'safety' ? 'note' : null,
  }, avatar, h('div', { class: 'entry-msg-main' }, bubble, footer));
}
