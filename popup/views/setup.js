// First-run onboarding wizard: asks whether setup is needed ("Настроить под себя" vs "Разберусь сам"),
// then walks through 3 concise steps and saves permanently to device storage across file updates.
import { $, toast } from '../dom.js';
import { state, update } from '../store.js';
import { send } from '../api.js';
import { onShow, go } from '../nav.js';
import { refreshSite } from '../sync.js';
import { applyTheme } from './settings.js';

let step = 0; // 0 = intro, 1 = routing/RU, 2 = adblock/youtube, 3 = comfort/theme
let draft = {};

function syncDraftFromState() {
  draft = {
    mode: state.mode === 'all' ? 'all' : 'whitelist',
    ipsetPreset: state.ipsetPreset === 'zapret' ? 'zapret' : 'full',
    bypassRu: state.bypassRu !== false,
    adblock: state.adblock !== false,
    sponsorBlock: state.sponsorBlock !== false,
    autoReload: state.autoReload !== false,
    webrtcProtect: Boolean(state.webrtcProtect),
    uiTheme: state.uiTheme === 'light' ? 'light' : 'dark'
  };
}

function renderStep() {
  $('setupIntro').hidden = step !== 0;
  $('setupStep1').hidden = step !== 1;
  $('setupStep2').hidden = step !== 2;
  $('setupStep3').hidden = step !== 3;
  $('setupStepBadge').hidden = step === 0;
  if (step > 0) $('setupStepBadge').textContent = `Шаг ${step} из 3`;
  $('setupLead').textContent = state.servers.length > 0
    ? 'Сервер уже встроен и готов к работе. Хотите за 15 секунд настроить функции под себя, или разберётесь сами?'
    : 'Хотите за 15 секунд выбрать удобный режим обхода и блокировки рекламы перед подключением сервера, или разберётесь сами?';

  for (const btn of document.querySelectorAll('[data-setup-mode]')) {
    const active = btn.dataset.setupMode === draft.mode;
    btn.setAttribute('aria-checked', String(active));
    btn.classList.toggle('selected', active);
  }
  $('setupBypassRu').checked = draft.bypassRu;
  $('setupZapret').checked = draft.ipsetPreset === 'zapret';
  $('setupAdblock').checked = draft.adblock;
  $('setupSponsorBlock').checked = draft.sponsorBlock;
  $('setupAutoReload').checked = draft.autoReload;
  $('setupWebrtc').checked = draft.webrtcProtect;

  for (const btn of document.querySelectorAll('[data-setup-theme]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.setupTheme === draft.uiTheme));
  }
}

async function finishOnboarding(patch = null) {
  const res = await send('completeOnboarding', patch ? { patch } : {});
  if (!res.success) {
    toast(res.error || 'Не удалось сохранить настройки');
    return;
  }
  update(res.data);
  await refreshSite();
  go('main');
  if (patch) toast('Настройки сохранены', 'success');
}

export function openSetupWizard() {
  syncDraftFromState();
  step = 0;
  go('setup');
}

export function setupOnboarding() {
  onShow('setup', () => {
    syncDraftFromState();
    step = 0;
    renderStep();
  });

  $('btnStartWizard').addEventListener('click', () => {
    step = 1;
    renderStep();
  });

  $('btnSkipWizard').addEventListener('click', () => {
    finishOnboarding(null);
  });

  for (const btn of document.querySelectorAll('[data-setup-mode]')) {
    btn.addEventListener('click', () => {
      draft.mode = btn.dataset.setupMode;
      renderStep();
    });
  }

  $('setupBypassRu').addEventListener('change', () => { draft.bypassRu = $('setupBypassRu').checked; });
  $('setupZapret').addEventListener('change', () => { draft.ipsetPreset = $('setupZapret').checked ? 'zapret' : 'full'; });
  $('setupAdblock').addEventListener('change', () => { draft.adblock = $('setupAdblock').checked; });
  $('setupSponsorBlock').addEventListener('change', () => { draft.sponsorBlock = $('setupSponsorBlock').checked; });
  $('setupAutoReload').addEventListener('change', () => { draft.autoReload = $('setupAutoReload').checked; });
  $('setupWebrtc').addEventListener('change', () => { draft.webrtcProtect = $('setupWebrtc').checked; });

  for (const btn of document.querySelectorAll('[data-setup-theme]')) {
    btn.addEventListener('click', () => {
      draft.uiTheme = btn.dataset.setupTheme;
      applyTheme(draft.uiTheme);
      renderStep();
    });
  }

  $('btnSetupBack1').addEventListener('click', () => { step = 0; renderStep(); });
  $('btnSetupNext1').addEventListener('click', () => { step = 2; renderStep(); });
  $('btnSetupBack2').addEventListener('click', () => { step = 1; renderStep(); });
  $('btnSetupNext2').addEventListener('click', () => { step = 3; renderStep(); });
  $('btnSetupBack3').addEventListener('click', () => { step = 2; renderStep(); });
  $('btnSetupFinish').addEventListener('click', () => finishOnboarding(draft));
}
