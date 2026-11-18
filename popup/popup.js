// SSJ VPN popup entry point.
import { setupNav, go } from './nav.js';
import { refreshStatus, refreshTab, refreshSite, refreshHealth, watchHealth } from './sync.js';
import { state } from './store.js';
import { send } from './api.js';
import { setupMain } from './views/main.js';
import { setupRules } from './views/rules.js';
import { setupServers } from './views/servers.js';
import { setupAddServer, handlePending } from './views/add-server.js';
import { setupSettings } from './views/settings.js';
import { setupOnboarding } from './views/setup.js';
import { setupFooter } from './views/footer.js';

function measureGutter() {
  const probe = document.createElement('div');
  probe.className = 'view-body';
  probe.style.cssText = 'position:absolute;visibility:hidden;width:100px;height:40px;padding:0';
  document.body.append(probe);
  const gutter = (probe.offsetWidth - probe.clientWidth) / 2;
  probe.remove();
  document.documentElement.style.setProperty('--gutter', `${gutter}px`);
}

async function init() {
  measureGutter();
  setupMain();
  setupRules();
  setupServers();
  setupAddServer();
  setupSettings();
  setupOnboarding();
  setupFooter();
  setupNav();
  watchHealth();

  await Promise.all([refreshStatus(), refreshTab()]);
  if (!state.onboardingDone) {
    go('setup');
  }
  await refreshSite();
  if (state.enabled && state.server) {
    refreshHealth({ silent: true });
  }

  if (state.pending) handlePending(await send('checkPending'));
  const geo = await send('ensureGeo');
  if (geo.success && geo.changed) refreshStatus();
}

document.addEventListener('DOMContentLoaded', init);
