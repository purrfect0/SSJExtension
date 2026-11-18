// Main screen: power + honest status, server picker, current site, routing mode.
import { $, el, flagImg, serverTitle, toast, arrowNavigation, icon } from '../dom.js';
import { state, update, subscribe } from '../store.js';
import { send } from '../api.js';
import { go } from '../nav.js';
import { refreshStatus, refreshSite, refreshHealth, reloadActiveTabIfEnabled } from '../sync.js';

const STATUS = {
  off: { title: 'VPN выключен', tip: 'Все сайты открываются напрямую', kind: 'off' },
  noserver: { title: 'Добавьте сервер', tip: 'Без сервера VPN не включить', kind: 'warn' },
  checking: { title: 'Подключаемся…', tip: 'Проверяем связь с сервером', kind: '' },
  ok: { title: 'VPN включён', tip: '', kind: '' },
  down: { title: 'Нет связи с сервером', tip: 'Сайты из списка закрыты, пока связь не вернётся. Нажмите, чтобы проверить ещё раз', kind: 'bad' },
  auth: { title: 'Неверный пароль', tip: 'Сервер не принял логин или пароль. Нажмите, чтобы исправить', kind: 'bad' },
  conflict: { title: 'Прокси занят', tip: 'Прокси браузера управляет другое расширение. Отключите его, и VPN включится сам', kind: 'warn' }
};

const STATUS_ACTION = {
  noserver: () => go('addServer'),
  auth: () => go('servers'),
  down: () => refreshHealth({ silent: false })
};

export function statusInfo(s = state) {
  let h = s.health || { status: 'checking' };
  if (!s.servers.length) h = { status: 'noserver' };
  else if (!s.enabled) h = { status: 'off' };
  else if (h.status === 'off' || h.status === 'noserver') h = { status: 'checking' };
  const base = STATUS[h.status] || STATUS.checking;
  let tip = base.tip;
  if (h.status === 'ok') tip = `${s.mode === 'all' ? 'Все сайты' : 'Заблокированные сайты'} идут через VPN · пинг ${h.latencyMs} мс`;
  if (h.status === 'down' && h.error) tip = `${h.error}. ${base.tip}`;
  return { ...base, tip, status: h.status };
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function renderHero() {
  const info = statusInfo();
  const power = $('btnTogglePower');
  const on = state.enabled && state.servers.length > 0;
  const checking = info.status === 'checking' && on;
  power.className = `power-button${on ? '' : ' off'}${checking ? ' checking' : ''}${info.kind === 'bad' ? ' bad' : ''}${info.kind === 'warn' && on ? ' warn' : ''}`;
  power.setAttribute('aria-pressed', String(on));
  $('powerLabel').textContent = on ? 'Выключить VPN' : 'Включить VPN';
  power.title = on ? 'Выключить VPN' : 'Включить VPN';

  const title = $('statusTitle');
  title.className = `status-title${info.kind ? ` ${info.kind}` : ''}`;
  title.title = info.tip;
  if (STATUS_ACTION[info.status]) {
    title.replaceChildren(el('button', {
      type: 'button', class: 'status-title-btn', dataset: { statusAction: info.status },
      'aria-label': `${info.title}. ${info.tip}`
    }, el('span', { text: info.title }), icon('chevron-right', 16)));
  } else {
    title.textContent = info.title;
  }

  $('appRoot').classList.toggle('is-off', !on);
  $('appHeader').classList.toggle('off', !on);
}

function renderServers() {
  const bar = $('serverChips');
  const focusedId = document.activeElement?.closest?.('.server-chip')?.dataset.serverId;
  bar.replaceChildren(...state.servers.map((srv) => {
    const active = srv.id === state.activeServerId;
    return el('button', {
      type: 'button', class: 'server-chip', role: 'radio',
      'aria-checked': String(active), tabindex: active ? '0' : '-1',
      title: `${serverTitle(srv)} — ${srv.host}`, dataset: { serverId: srv.id }
    }, flagImg(srv.countryCode), el('span', { class: 'chip-name', text: serverTitle(srv) }));
  }), el('button', {
    type: 'button', class: `server-chip-add${!state.servers.length ? ' is-empty' : ''}`, title: 'Добавить сервер', 'aria-label': 'Добавить сервер',
    dataset: { add: '1' }
  }, icon('plus', 14), !state.servers.length ? el('span', { text: 'Добавить сервер' }) : null));

  if (focusedId) bar.querySelector(`[data-server-id="${focusedId}"]`)?.focus();
  const activeChip = bar.querySelector('[aria-checked="true"]');
  if (activeChip && !focusedId) bar.scrollLeft = Math.max(0, activeChip.offsetLeft - bar.offsetLeft - 32);
  updateChipFades(bar);
}

function updateChipFades(bar) {
  const max = bar.scrollWidth - bar.clientWidth;
  bar.classList.toggle('fade-start', bar.scrollLeft > 1);
  bar.classList.toggle('fade-end', bar.scrollLeft < max - 1);
}

function routeText(site) {
  if (!site) return { text: 'Проверяем…', tip: '', cls: '' };
  if (site.reason === 'local') return { text: 'Напрямую', tip: 'Локальный адрес', cls: '' };
  if (site.reason === 'off') return { text: 'Напрямую', tip: 'VPN выключен', cls: '' };
  if (site.reason === 'bypass') return { text: 'Напрямую · исключение', tip: 'В списке исключений', cls: 'bypass' };
  const h = state.health.status;
  const serverBad = h === 'down' || h === 'auth';
  const why = {
    custom: 'В моём списке', all: 'Режим «Все сайты»', base: 'Во встроенной базе', geo: 'Сервис ограничен в РФ',
    zapret: 'Обрабатывает Zapret', ru_direct: 'Сайт РФ напрямую', ip: 'IP-адрес не заблокирован', none: 'Нет в списке'
  }[site.reason] || '';

  const obs = site.observed;
  if (obs && obs.error && site.route !== 'direct') {
    return { text: 'Не открылся', tip: serverBad ? 'Нет связи с сервером' : 'Не открылся через VPN', cls: 'bad' };
  }
  if (obs && !obs.error) {
    if (obs.viaVpn) return { text: 'Через VPN', tip: site.route === 'ip' ? 'IP-адрес в базе РКН' : why, cls: 'vpn' };
    if (site.route === 'vpn') return { text: 'Обновите страницу', tip: 'Сайт открылся напрямую, после обновления пойдёт через VPN', cls: '' };
    return { text: 'Напрямую', tip: why, cls: '' };
  }
  if (site.route === 'vpn') {
    if (serverBad) return { text: 'Нет связи', tip: 'Сайт идёт через VPN, но сервер недоступен', cls: 'bad' };
    return { text: 'Через VPN', tip: why, cls: 'vpn' };
  }
  if (site.route === 'ip') return { text: 'Напрямую', tip: 'Через VPN, только если IP сайта в базе РКН', cls: '' };
  return { text: 'Напрямую', tip: why, cls: '' };
}

function renderSite() {
  const tab = state.tab;
  const site = state.site;
  const action = $('btnSiteAction');
  const adBtn = $('btnSiteAdblock');
  const fav = $('siteFavicon');
  const fallback = $('siteFallback');

  if (!tab || !tab.isWeb) {
    $('siteHost').textContent = tab ? 'Служебная страница' : '…';
    $('siteRouteText').textContent = 'Без VPN';
    $('siteRoute').className = 'site-route';
    fav.hidden = true; fallback.style.display = '';
    action.hidden = true;
    adBtn.hidden = true;
    return;
  }

  $('siteHost').textContent = tab.host;
  $('siteHost').title = tab.host;
  if (fav.dataset.page !== tab.url) {
    fav.dataset.page = tab.url;
    fav.onload = () => { fav.hidden = false; fallback.style.display = 'none'; };
    fav.onerror = () => { fav.hidden = true; fallback.style.display = ''; };
    fav.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`);
  }

  const route = routeText(site);
  $('siteRouteText').textContent = route.text;
  $('siteRoute').className = `site-route ${route.cls}`.trim();
  $('siteRoute').title = route.tip;

  if (!site || site.isLocal) { action.hidden = true; adBtn.hidden = true; return; }
  action.hidden = false;
  action.disabled = false;

  // Per-site AdBlock toggle (shown only when global AdBlock is enabled)
  if (state.adblock && state.enabled) {
    adBtn.hidden = false;
    const paused = Boolean(site.isAdblockAllowed);
    adBtn.className = `icon-btn icon-btn-sm site-ad-btn ${paused ? 'paused' : 'on'}`;
    adBtn.replaceChildren(icon(paused ? 'shield-off' : 'shield-check', 15));
    adBtn.title = paused
      ? `AdBlock отключён на ${site.suggestedRule}. Нажмите, чтобы включить`
      : `AdBlock включён на ${site.suggestedRule}. Нажмите, чтобы отключить на этом сайте`;
    adBtn.setAttribute('aria-label', adBtn.title);
    adBtn.setAttribute('aria-pressed', String(!paused));
  } else {
    adBtn.hidden = true;
  }

  const goingViaVpn = site.route === 'vpn' || Boolean(site.observed && !site.observed.error && site.observed.viaVpn);

  if (site.isCustomWhitelisted) {
    action.className = 'btn btn-sm btn-secondary';
    action.replaceChildren(icon('x', 14), el('span', { text: 'Убрать' }));
    action.title = `Убрать из моего списка: ${site.matchedRules.join(', ')}`;
    action.dataset.act = 'removeCustom';
  } else if (site.isCustomBypassed) {
    action.className = 'btn btn-sm btn-secondary';
    action.replaceChildren(icon('shield-check', 14), el('span', { text: 'Вернуть' }));
    action.title = `Убрать из исключений: ${site.matchedBypass.join(', ')}`;
    action.dataset.act = 'removeBypass';
  } else if (goingViaVpn) {
    action.className = 'btn btn-sm btn-secondary';
    action.replaceChildren(icon('shield-off', 14), el('span', { text: 'Напрямую' }));
    action.title = `Всегда открывать ${site.suggestedRule} напрямую без VPN`;
    action.dataset.act = 'addBypass';
  } else {
    action.className = 'btn btn-sm btn-primary';
    action.replaceChildren(icon('plus', 14), el('span', { text: 'Через VPN' }));
    action.title = `Добавить ${site.suggestedRule} и все его поддомены в мой список`;
    action.dataset.act = 'addCustom';
  }
  action.setAttribute('aria-label', action.title);
}

function renderMode() {
  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.mode));
  }
  const n = state.customWhitelist.length + state.customBypass.length;
  $('rulesSummary').textContent = n ? `${n} ${plural(n, 'своё', 'своих', 'своих')}` : '';
}

export function setupMain() {
  subscribe(() => { renderHero(); renderServers(); renderSite(); renderMode(); });

  $('btnTogglePower').addEventListener('click', async () => {
    const power = $('btnTogglePower');
    if (!state.servers.length) { go('addServer'); return; }
    power.setAttribute('aria-busy', 'true');
    power.disabled = true;
    const res = await send('toggleEnable');
    power.removeAttribute('aria-busy');
    power.disabled = false;
    if (!res.success) { toast(res.error); return; }
    update({ enabled: res.enabled, health: res.health || state.health });
    await refreshSite();
    if (res.enabled) refreshHealth({ silent: false });
  });

  $('statusTitle').addEventListener('click', (event) => {
    const key = event.target.closest('[data-status-action]')?.dataset.statusAction;
    if (key) STATUS_ACTION[key]?.();
  });

  const chips = $('serverChips');
  chips.addEventListener('click', async (event) => {
    if (event.target.closest('[data-add]')) { go('addServer'); return; }
    const chip = event.target.closest('.server-chip');
    if (!chip) return;
    if (chip.dataset.serverId === state.activeServerId) { go('servers'); return; }
    const res = await send('selectServer', { serverId: chip.dataset.serverId });
    if (!res.success) { toast(res.error); return; }
    await refreshStatus();
    await refreshSite();
    refreshHealth({ silent: false });
  });
  arrowNavigation(chips, '.server-chip', (chip) => chip.click());
  chips.addEventListener('wheel', (event) => {
    if (chips.scrollWidth <= chips.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    chips.scrollLeft += event.deltaY;
  }, { passive: false });
  chips.addEventListener('scroll', () => updateChipFades(chips), { passive: true });

  let drag = null;
  chips.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    drag = { x: event.clientX, left: chips.scrollLeft, moved: false };
  });
  window.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 4) drag.moved = true;
    if (drag.moved) chips.scrollLeft = drag.left - dx;
  });
  window.addEventListener('pointerup', () => {
    if (drag?.moved) {
      const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
      chips.addEventListener('click', swallow, { capture: true });
      setTimeout(() => chips.removeEventListener('click', swallow, { capture: true }), 0);
    }
    drag = null;
  });

  $('btnSiteAdblock').addEventListener('click', async () => {
    const host = state.tab?.host;
    if (!host) return;
    const res = await send('toggleSiteAdblock', { host });
    if (!res?.success) { toast(res?.error || 'Не удалось изменить AdBlock'); return; }
    update({ adblockAllowlist: res.adblockAllowlist || state.adblockAllowlist });
    await refreshSite();
    await reloadActiveTabIfEnabled();
    toast(res.allowed ? `Реклама разрешена на ${res.domain}` : `AdBlock включён на ${res.domain}`, 'success');
  });

  $('btnSiteAction').addEventListener('click', async () => {
    const act = $('btnSiteAction').dataset.act;
    const host = state.tab?.host;
    if (!host || !act) return;
    let res;
    if (act === 'addCustom') res = await send('addCustomRule', { rule: host, fromSite: true });
    else if (act === 'removeCustom') res = await send('removeCustomRule', { host });
    else if (act === 'addBypass') res = await send('addBypassRule', { rule: host, fromSite: true });
    else if (act === 'removeBypass') res = await send('removeBypassRule', { host });

    if (!res?.success) { toast(res?.error || 'Ошибка сохранения правила'); return; }
    update({
      customWhitelist: res.customWhitelist ?? state.customWhitelist,
      customBypass: res.customBypass ?? state.customBypass
    });
    await refreshSite();
    const reloaded = await reloadActiveTabIfEnabled();
    const messages = {
      addCustom: reloaded ? `Через VPN: ${res.rule}` : `Добавлено: ${res.rule}. Обновите страницу`,
      removeCustom: 'Убрано из моего списка',
      addBypass: reloaded ? `Напрямую: ${res.rule}` : `Исключено из VPN: ${res.rule}`,
      removeBypass: 'Исключение убрано'
    };
    toast(messages[act] || 'Готово', 'success');
  });

  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.addEventListener('click', async () => {
      if (btn.dataset.mode === state.mode) return;
      const res = await send('setMode', { mode: btn.dataset.mode });
      if (!res.success) { toast(res.error); return; }
      update({ mode: res.mode });
      await refreshSite();
    });
  }
}
