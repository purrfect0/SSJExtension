// Popup state: reactive mirror of background status + active browser tab.
const listeners = new Set();

export const state = {
  enabled: true,
  mode: 'whitelist',
  ipsetPreset: 'full',
  adblock: true,
  sponsorBlock: true,
  bypassRu: true,
  autoReload: true,
  webrtcProtect: false,
  onboardingDone: true,
  server: null,
  servers: [],
  activeServerId: '',
  iconTheme: 'mint',
  uiTheme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  pending: null,
  customWhitelist: [],
  customBypass: [],
  adblockAllowlist: [],
  health: { status: 'checking' },
  pingBusy: false,
  totalIpRanges: 0,
  totalDefaultDomains: 0,
  totalGeoDomains: 0,
  lastUpdated: '',
  tab: null,   // { id, url, host, isWeb }
  site: null   // checkHostStatus answer for current tab
};

export function update(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
