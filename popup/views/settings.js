// Settings: theme, toolbar icon, routing & privacy toggles.
import { $, el, arrowNavigation, toast } from '../dom.js';
import { state, update, subscribe } from '../store.js';
import { send } from '../api.js';
import { refreshSite } from '../sync.js';
import { iconThemes } from '../../icons/themes.js';
import { openSetupWizard } from './setup.js';

export function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem('ssj.uiTheme', value); } catch (_) {}
}

export function currentIconTheme() {
  return iconThemes.some((t) => t.id === state.iconTheme) ? state.iconTheme : 'mint';
}

function render() {
  applyTheme(state.uiTheme);
  for (const btn of document.querySelectorAll('[data-theme-choice]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeChoice === state.uiTheme));
  }
  const current = currentIconTheme();
  const on = state.enabled && ['ok', 'checking'].includes(state.health.status);
  $('brandLogo').src = `../icons/${current}/icon32${on ? '' : '_off'}.png`;

  const box = $('iconThemes');
  const focused = document.activeElement?.dataset?.iconTheme;
  box.replaceChildren(...iconThemes.map((t) => el('button', {
    type: 'button', class: 'icon-theme', role: 'radio', 'aria-checked': String(t.id === current),
    tabindex: t.id === current ? '0' : '-1', title: t.name, 'aria-label': t.name, dataset: { iconTheme: t.id }
  }, el('img', { src: `../icons/${t.id}/icon48.png`, alt: '' }))));
  if (focused) box.querySelector(`[data-icon-theme="${focused}"]`)?.focus();

  $('toggleAdblock').checked = Boolean(state.adblock);
  $('toggleSponsorBlock').checked = Boolean(state.sponsorBlock);
  $('toggleBypassRu').checked = Boolean(state.bypassRu);
  $('toggleAutoReload').checked = Boolean(state.autoReload);
  $('toggleWebrtc').checked = Boolean(state.webrtcProtect);

  const updated = state.lastUpdated ? new Date(state.lastUpdated).toLocaleDateString('ru-RU') : '—';
  $('aboutText').textContent = `SSJ VPN v${chrome.runtime.getManifest?.().version_name || '1.0'} · база блокировок от ${updated}`;
}

export function setupSettings() {
  subscribe(render);

  for (const btn of document.querySelectorAll('[data-theme-choice]')) {
    btn.addEventListener('click', async () => {
      const theme = btn.dataset.themeChoice;
      if (theme === state.uiTheme) return;
      const previous = state.uiTheme;
      update({ uiTheme: theme });
      const res = await send('setUiTheme', { theme });
      if (!res.success) { update({ uiTheme: previous }); toast(res.error); }
    });
  }

  const box = $('iconThemes');
  box.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-icon-theme]');
    if (!btn || btn.dataset.iconTheme === state.iconTheme) return;
    const res = await send('setIconTheme', { theme: btn.dataset.iconTheme });
    if (res.success) update({ iconTheme: res.iconTheme });
    else toast(res.error);
  });
  arrowNavigation(box, '[data-icon-theme]', (btn) => btn.click());

  const bindToggle = (id, key) => {
    $(id).addEventListener('change', async () => {
      const next = $(id).checked;
      update({ [key]: next });
      const res = await send('setSetting', { key, value: next });
      if (!res.success) {
        update({ [key]: !next });
        toast(res.error);
        return;
      }
      if (key === 'bypassRu') refreshSite();
    });
  };
  bindToggle('toggleAdblock', 'adblock');
  bindToggle('toggleSponsorBlock', 'sponsorBlock');
  bindToggle('toggleBypassRu', 'bypassRu');
  bindToggle('toggleAutoReload', 'autoReload');
  bindToggle('toggleWebrtc', 'webrtcProtect');

  $('btnRunSetup').addEventListener('click', () => openSetupWizard());
}
