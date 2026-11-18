// Synchronises popup state with background service worker and active tab.
import { state, update } from './store.js';
import { send } from './api.js';

export async function refreshStatus() {
  const res = await send('getStatus');
  if (res.success) update(res.data);
  return res.success;
}

export async function refreshTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) { update({ tab: { isWeb: false } }); return; }
    const url = new URL(tab.url);
    const isWeb = url.protocol === 'http:' || url.protocol === 'https:';
    update({ tab: { id: tab.id, url: tab.url, host: url.hostname.replace(/^\[|\]$/g, ''), isWeb } });
  } catch (_) {
    update({ tab: { isWeb: false } });
  }
}

export async function refreshSite() {
  if (!state.tab || !state.tab.isWeb) { update({ site: null }); return; }
  const res = await send('checkHostStatus', { host: state.tab.host, tabId: state.tab.id });
  update({ site: res.success ? res : null });
}

export async function reloadActiveTabIfEnabled() {
  if (!state.autoReload || !state.tab?.isWeb || !Number.isInteger(state.tab.id)) return false;
  try {
    await new Promise((r) => setTimeout(r, 120));
    await chrome.tabs.reload(state.tab.id);
    return true;
  } catch (_) {
    return false;
  }
}

let healthBusy = false;
/**
 * Refreshes proxy health. When `silent` is true and status is already `ok`, keeps the green
 * connected UI steady instead of flashing "Подключаемся…" every time the popup opens.
 */
export async function refreshHealth({ silent = false } = {}) {
  if (healthBusy) return;
  healthBusy = true;
  const keepOk = silent && state.health?.status === 'ok' && state.health?.serverId === state.activeServerId;
  update({
    pingBusy: true,
    health: keepOk
      ? state.health
      : { ...state.health, status: state.enabled && state.server ? 'checking' : state.health.status }
  });
  try {
    const res = await send('checkHealth');
    if (res.success) update({ health: res.health });
  } finally {
    healthBusy = false;
    update({ pingBusy: false });
  }
  refreshSite();
}

export function watchHealth() {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'session' && changes.ssjHealth?.newValue) {
      update({ health: changes.ssjHealth.newValue });
    }
  });
}
