// View navigation with back stack and Escape support.
import { $ } from './dom.js';
import { state } from './store.js';

const stack = ['main'];
const hooks = new Map();

export function onShow(view, fn) { hooks.set(view, fn); }
export function currentView() { return stack[stack.length - 1]; }

function render(focus = true) {
  const active = currentView();
  for (const node of document.querySelectorAll('[data-view]')) {
    node.hidden = node.dataset.view !== active;
  }
  for (const btn of document.querySelectorAll('.header-actions [data-nav]')) {
    if (btn.dataset.nav === active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  hooks.get(active)?.();
  if (focus) {
    const view = document.querySelector(`[data-view="${active}"]`);
    for (const box of [view, view?.querySelector('.view-body')]) if (box) box.scrollTop = 0;
    view?.querySelector('h1')?.focus({ preventScroll: true });
  }
}

export function go(view) {
  if (currentView() === view) return;
  if (view === 'main') {
    stack.length = 0;
    stack.push('main');
    render();
    return;
  }
  const top = ['servers', 'settings', 'setup'];
  if (top.includes(view)) stack.length = 1;
  stack.push(view);
  render();
}

export function back() {
  if (stack.length > 1) stack.pop();
  render();
}

export function setupNav() {
  document.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      if (nav.closest('.header-actions') && currentView() === nav.dataset.nav) back();
      else go(nav.dataset.nav);
      return;
    }
    if (event.target.closest('[data-back]')) back();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && stack.length > 1 && !event.defaultPrevented) {
      if (currentView() === 'setup' && !state.onboardingDone) return;
      event.preventDefault();
      back();
    }
  });
  render(false);
}

export { $ };
