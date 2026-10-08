// Accessible overflow menu (button + role="menu" popover): arrow keys, Home/End, Escape returns focus,
// outside click and Tab close it. The document listener only exists while the menu is open and is
// removed by destroy().
import { h } from '../lib/dom.js';
import { icon } from '../lib/ui.js';

/**
 * @typedef {object} MenuItem
 * @property {string} id
 * @property {string} label
 * @property {string} [description] one line under the label
 * @property {string} [icon]
 * @property {boolean} [checkbox] role="menuitemcheckbox"
 * @property {boolean} [checked]
 * @property {boolean} [danger]
 * @property {boolean} [separatorBefore]
 * @property {() => void} onSelect
 */

/**
 * @param {{ label: string, items: MenuItem[] }} opts
 * @returns {{ el: HTMLElement, setItems(items: MenuItem[]): void, close(): void, destroy(): void }}
 */
export function createMenu({ label, items }) {
  let current = items;
  let open = false;
  const menuId = `entry-menu-${Math.random().toString(36).slice(2, 8)}`;
  const button = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon entry-menu-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    'aria-controls': menuId, 'aria-label': label, title: label,
  }, icon('more'));
  const list = h('div', { class: 'entry-menu', id: menuId, role: 'menu', 'aria-label': label, hidden: true });
  const el = h('div', { class: 'entry-menu-wrap' }, button, list);

  const itemButtons = () => Array.from(list.querySelectorAll('[role^="menuitem"]'));

  function paint() {
    list.replaceChildren(...current.map((item) => {
      const node = h('button', {
        type: 'button', class: ['entry-menu-item', item.danger ? 'is-danger' : ''], tabindex: '-1',
        role: item.checkbox ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': item.checkbox ? (item.checked ? 'true' : 'false') : null,
        dataset: { id: item.id },
        onClick: () => { close(true); item.onSelect(); },
      },
      item.icon ? icon(item.icon, { size: 18 }) : h('span', { class: 'entry-menu-gap' }),
      h('span', { class: 'entry-menu-text' },
        h('span', { class: 'entry-menu-label' }, item.label),
        item.description ? h('span', { class: 'entry-menu-desc' }, item.description) : null),
      item.checkbox ? h('span', { class: 'entry-menu-switch', 'aria-hidden': 'true' }) : null);
      return item.separatorBefore ? h('div', { class: 'entry-menu-sep-wrap', role: 'none' }, h('hr', { class: 'entry-menu-sep' }), node) : node;
    }));
  }

  function focusItem(index) {
    const nodes = itemButtons();
    if (nodes.length === 0) return;
    nodes[(index + nodes.length) % nodes.length].focus();
  }

  function onDocPointer(e) { if (!el.contains(e.target)) close(false); }
  function onDocFocus(e) { if (!el.contains(e.target)) close(false); }

  function openMenu(focusFirst = true) {
    if (open) return;
    open = true;
    paint();
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('focusin', onDocFocus, true);
    if (focusFirst) focusItem(0);
  }

  function close(restoreFocus) {
    if (!open) return;
    open = false;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('focusin', onDocFocus, true);
    if (restoreFocus) button.focus();
  }

  button.addEventListener('click', () => { if (open) close(true); else openMenu(true); });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(false); focusItem(e.key === 'ArrowDown' ? 0 : -1); }
  });
  list.addEventListener('keydown', (e) => {
    const nodes = itemButtons();
    const idx = nodes.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(idx - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
    else if (e.key === 'End') { e.preventDefault(); focusItem(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  });

  return {
    el,
    setItems(next) { current = next; if (open) paint(); },
    close: () => close(false),
    destroy() { close(false); },
  };
}
