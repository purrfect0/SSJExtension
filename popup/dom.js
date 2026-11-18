import { createIcon } from '../icons/ui/icons.js';

export const $ = (id) => document.getElementById(id);
export const icon = createIcon;

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const FLAG_FALLBACK = '../flags/xx.svg';
export function flagImg(code) {
  const img = el('img', { alt: '', draggable: 'false' });
  img.addEventListener('error', () => { if (!img.src.endsWith('/flags/xx.svg')) img.src = FLAG_FALLBACK; });
  img.src = /^[a-z]{2}$/i.test(code || '') ? `../flags/${code.toLowerCase()}.svg` : FLAG_FALLBACK;
  return img;
}

export function serverTitle(srv) {
  return (srv && (srv.name || srv.countryName || srv.host)) || 'Сервер';
}

const timers = new WeakMap();
export function setStatus(node, text, kind = '') {
  clearTimeout(timers.get(node));
  node.textContent = text || '';
  node.className = `status-line${kind ? ` ${kind}` : ''}`;
  if (kind === 'success' && text) timers.set(node, setTimeout(() => { node.textContent = ''; }, 4000));
}

export function setError(node, text, input) {
  node.textContent = text || '';
  node.hidden = !text;
  if (input) input.setAttribute('aria-invalid', text ? 'true' : 'false');
}

let toastTimer;
/**
 * Floating message above the footer: it never pushes the layout.
 * @param {string} text
 * @param {'error' | 'success'} [kind]
 */
export function toast(text, kind = 'error') {
  const node = $('toast');
  clearTimeout(toastTimer);
  node.textContent = text;
  node.className = `toast${kind === 'success' ? ' success' : ''}`;
  node.setAttribute('role', kind === 'success' ? 'status' : 'alert');
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 5000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// Arrow-key movement inside a group of radio-like or tab-like buttons.
export function arrowNavigation(container, selector, onMove) {
  container.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const items = [...container.querySelectorAll(selector)];
    const index = items.indexOf(document.activeElement);
    if (index === -1) return;
    let next = -1;
    if (step) next = (index + step + items.length) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (next === -1) return;
    event.preventDefault();
    items[next].focus();
    onMove?.(items[next]);
  });
}
