// Accessible tab bar (WAI-ARIA tabs pattern): role=tablist with roving tabindex, Left/Right/Home/End keys.
// The caller owns the panels; this component only manages the buttons and asks `onSelect` for permission
// before switching (Settings uses that to ask about unsaved edits).
import { h } from '../lib/dom.js';

/** DOM id of a tab button. */
export const tabButtonId = (id) => `settings-tab-${id}`;
/** DOM id of a tab panel. */
export const tabPanelId = (id) => `settings-panel-${id}`;

/**
 * @param {{ tabs: Array<{id:string,label:string}>, active: string, label: string,
 *   onSelect: (id: string) => boolean | Promise<boolean> }} opts
 * @returns {{ el: HTMLElement, select(id: string, o?: {focus?: boolean}): void, setMarker(id: string, text: string): void, active(): string }}
 */
export function createTabs({ tabs, active, label, onSelect }) {
  let current = active;
  let switching = false;
  const buttons = new Map();
  const markers = new Map();

  const list = h('div', { class: 'settings-tablist', role: 'tablist', 'aria-label': label });
  for (const tab of tabs) {
    const marker = h('span', { class: 'settings-tab-marker', hidden: true });
    markers.set(tab.id, marker);
    const btn = h('button', {
      type: 'button', role: 'tab', class: 'settings-tab', id: tabButtonId(tab.id),
      'aria-controls': tabPanelId(tab.id), dataset: { tab: tab.id },
      onClick: () => request(tab.id, { focus: false }),
      onKeydown: (e) => onKey(e, tab.id),
    }, h('span', { class: 'settings-tab-label' }, tab.label), marker);
    buttons.set(tab.id, btn);
    list.append(btn);
  }
  const el = h('div', { class: 'settings-tabs' }, list);

  function paint({ scroll }) {
    for (const [id, btn] of buttons) {
      const on = id === current;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
      btn.classList.toggle('is-active', on);
    }
    if (scroll) buttons.get(current).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function request(id, { focus }) {
    if (id === current || switching) return;
    switching = true;
    let allowed = false;
    try { allowed = Boolean(await onSelect(id)); } finally { switching = false; }
    if (allowed) {
      current = id;
      paint({ scroll: true });
      if (focus) buttons.get(id).focus();
    } else {
      buttons.get(current).focus(); // the user stayed: keep keyboard users where they were
    }
  }

  function onKey(e, id) {
    const index = tabs.findIndex((t) => t.id === id);
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === -1) return;
    e.preventDefault();
    request(tabs[next].id, { focus: true });
  }

  paint({ scroll: false });
  return {
    el,
    active: () => current,
    /** Switch without asking (used for the initial tab and after the caller already confirmed). */
    select(id, { focus = false } = {}) {
      if (!buttons.has(id)) return;
      current = id;
      paint({ scroll: true });
      if (focus) buttons.get(id).focus();
    },
    /** Small status next to a tab label, e.g. "Active". Empty text hides it. */
    setMarker(id, text) {
      const marker = markers.get(id);
      if (!marker) return;
      marker.textContent = text || '';
      marker.hidden = !text;
      buttons.get(id).classList.toggle('has-marker', Boolean(text));
    },
  };
}
