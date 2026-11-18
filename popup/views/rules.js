// "Список сайтов": Через VPN (customWhitelist), Напрямую (customBypass), Встроенная база + Zapret.
import { $, el, icon, setError, arrowNavigation } from '../dom.js';
import { state, update, subscribe } from '../store.js';
import { send } from '../api.js';
import { onShow } from '../nav.js';
import { refreshSite } from '../sync.js';
import { plural } from './main.js';

let activeTab = 'custom'; // 'custom' | 'bypass' | 'base'
let baseModule = null;

async function base() {
  if (!baseModule) {
    const [{ defaultRules }, utils] = await Promise.all([
      import('../../data/default_rules.js'), import('../../data/routing_utils.js')
    ]);
    baseModule = { defaultRules, ...utils };
  }
  return baseModule;
}

function renderRuleList(listEl, emptyEl, countEl, rules, dataAttr) {
  countEl.textContent = rules.length;
  emptyEl.hidden = rules.length > 0;
  listEl.replaceChildren(...rules.slice().reverse().map((rule) => el('li', { class: 'list-item' },
    el('span', { class: 'list-item-text', text: rule, title: rule }),
    el('button', {
      type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `Удалить ${rule}`, title: 'Удалить',
      dataset: { [dataAttr]: rule }
    }, icon('trash-2', 15))
  )));
}

function renderLists() {
  renderRuleList($('customList'), $('customEmpty'), $('customCount'), state.customWhitelist, 'rule');
  renderRuleList($('bypassList'), $('bypassEmpty'), $('bypassCount'), state.customBypass, 'bypassRule');
}

function renderPreset() {
  for (const btn of document.querySelectorAll('[data-preset]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.preset === state.ipsetPreset));
  }
  $('presetHint').textContent = state.ipsetPreset === 'zapret'
    ? 'YouTube и Discord идут напрямую через ваш локальный Zapret, остальные блокировки — через VPN.'
    : 'YouTube, Discord и все заблокированные сервисы идут через ваш сервер VPN.';
  const ip = Number(state.totalIpRanges || 0);
  const dom = Number(state.totalDefaultDomains || 0);
  $('baseStats').textContent = `В базе ${dom.toLocaleString('ru-RU')} ${plural(dom, 'домен', 'домена', 'доменов')} и ${ip.toLocaleString('ru-RU')} ${plural(ip, 'диапазон', 'диапазона', 'диапазонов')} IP${state.lastUpdated ? ` · от ${new Date(state.lastUpdated).toLocaleDateString('ru-RU')}` : ''}.`;
}

function baseTag(domain, m) {
  if (state.ipsetPreset === 'zapret' && m.isZapretDomain(domain)) return { text: 'Через Zapret', cls: 'tag muted' };
  if (m.isGeoDomain(domain)) return { text: 'Геоблок', cls: 'tag' };
  return { text: 'РКН', cls: 'tag muted' };
}

async function renderBase() {
  const m = await base();
  const term = $('inputSearchBase').value.trim().toLowerCase();
  const all = term ? m.defaultRules.domains : m.includedDomains(state.ipsetPreset);
  const found = term ? all.filter((d) => d.includes(term)) : all;
  const shown = found.slice(0, 60);
  $('baseList').replaceChildren(...shown.map((d) => {
    const tag = baseTag(d, m);
    return el('li', { class: 'list-item' },
      el('span', { class: 'list-item-text', text: d }),
      el('span', { class: tag.cls, text: tag.text }));
  }));
  const more = $('baseMore');
  more.hidden = found.length <= shown.length && found.length > 0;
  more.textContent = found.length
    ? `Показано ${shown.length} из ${found.length.toLocaleString('ru-RU')}. Уточните запрос.`
    : 'Такого домена во встроенной базе нет — добавьте его во вкладку «Через VPN».';
}

function updateInputContext() {
  const isBypass = activeTab === 'bypass';
  $('inputNewRule').placeholder = isBypass
    ? 'Домен или IP напрямую (bank.ru)'
    : 'Домен или IP (notion.so)';
  $('ruleHint').textContent = isBypass
    ? 'Добавится в «Напрямую»: сайт пойдёт в обход VPN вместе с поддоменами.'
    : 'Поддомены учитываются автоматически. Можно вставить ссылку целиком.';
}

function selectTab(which) {
  activeTab = which;
  const map = {
    custom: [$('tabCustom'), $('panelCustom')],
    bypass: [$('tabBypass'), $('panelBypass')],
    base: [$('tabBase'), $('panelBase')]
  };
  for (const [key, [tab, panel]] of Object.entries(map)) {
    const on = key === which;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
  }
  updateInputContext();
  if (which === 'base') renderBase();
}

export function setupRules() {
  subscribe(() => { renderLists(); renderPreset(); });
  onShow('rules', () => {
    setError($('ruleError'), '', $('inputNewRule'));
    updateInputContext();
    if (activeTab === 'base') renderBase();
  });

  $('formAddRule').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('inputNewRule');
    if (!input.value.trim()) { input.focus(); return; }
    const targetBypass = activeTab === 'bypass';
    const res = await send(targetBypass ? 'addBypassRule' : 'addCustomRule', { rule: input.value });
    setError($('ruleError'), res.success ? '' : res.error, input);
    if (!res.success) return;
    if (res.existed) setError($('ruleError'), `${res.rule} уже есть в этом списке`, input);
    input.value = '';
    update({
      customWhitelist: res.customWhitelist ?? state.customWhitelist,
      customBypass: res.customBypass ?? state.customBypass
    });
    if (activeTab === 'base') selectTab('custom');
    refreshSite();
  });

  $('inputNewRule').addEventListener('input', () => setError($('ruleError'), '', $('inputNewRule')));

  $('customList').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-rule]');
    if (!btn) return;
    const res = await send('removeCustomRule', { rule: btn.dataset.rule });
    if (!res.success) return;
    update({ customWhitelist: res.customWhitelist || [] });
    refreshSite();
  });

  $('bypassList').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-bypass-rule]');
    if (!btn) return;
    const res = await send('removeBypassRule', { rule: btn.dataset.bypassRule });
    if (!res.success) return;
    update({ customBypass: res.customBypass || [] });
    refreshSite();
  });

  $('tabCustom').addEventListener('click', () => selectTab('custom'));
  $('tabBypass').addEventListener('click', () => selectTab('bypass'));
  $('tabBase').addEventListener('click', () => selectTab('base'));
  arrowNavigation(document.querySelector('.tabs'), '[role="tab"]', (tab) => tab.click());

  let searchTimer;
  $('inputSearchBase').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderBase, 120);
  });

  for (const btn of document.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', async () => {
      if (btn.dataset.preset === state.ipsetPreset) return;
      const res = await send('setIpsetPreset', { preset: btn.dataset.preset });
      if (!res.success) return;
      const status = await send('getStatus');
      if (status.success) update(status.data);
      renderBase();
      refreshSite();
    });
  }
}
