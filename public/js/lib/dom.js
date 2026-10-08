// Tiny DOM builder. No HTML strings anywhere: every piece of dynamic text goes through
// createTextNode / textContent, which is what keeps journal content from ever becoming markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Properties that must be set as DOM properties (not attributes) to behave correctly.
const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'textContent', 'indeterminate', 'readOnly']);

function appendChild(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
  } else if (child instanceof Node) {
    parent.appendChild(child);
  } else {
    parent.appendChild(document.createTextNode(String(child)));
  }
}

function classString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(classString).filter(Boolean).join(' ');
  return Object.entries(value).filter(([, on]) => on).map(([name]) => name).join(' ');
}

function applyProps(el, props, isSvg) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class' || key === 'className') {
      const cls = classString(value);
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined && v !== null) el.dataset[k] = String(v);
      }
    } else if (key === 'ref' && typeof value === 'function') {
      value(el);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (!isSvg && PROP_KEYS.has(key)) {
      el[key] = value;
    } else if (value === false) {
      continue;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

/**
 * Create an element. `h('button', { class: 'btn', onClick: fn }, 'Save')`.
 * Children may be strings, numbers, Nodes, arrays (flattened), or null/false (skipped).
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props, false);
  for (const c of children) appendChild(el, c);
  return el;
}

/** Create an SVG element in the SVG namespace. */
export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  for (const c of children) appendChild(el, c);
  return el;
}

/** Remove all children. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replace the children of `parent` with `nodes`. */
export function mount(parent, ...nodes) {
  clear(parent);
  for (const n of nodes) appendChild(parent, n);
  return parent;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** DocumentFragment from children. */
export function frag(...children) {
  const f = document.createDocumentFragment();
  for (const c of children) appendChild(f, c);
  return f;
}
