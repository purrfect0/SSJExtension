// Servers: list, select, edit, delete (with inline confirmation), friend ZIP & access key.
import { $, el, icon, flagImg, serverTitle, setStatus, copyText, toast } from '../dom.js';
import { state, subscribe } from '../store.js';
import { send } from '../api.js';
import { go } from '../nav.js';
import { refreshStatus, refreshSite, refreshHealth } from '../sync.js';
import { downloadFriendBuild } from '../distribution.js';
import { startEdit } from './add-server.js';

let confirmId = '';

function healthLabel(srv) {
  if (srv.id !== state.activeServerId) return '';
  const h = state.health;
  if (!state.enabled) return 'выбран';
  return {
    ok: `работает · ${h.latencyMs} мс`,
    down: 'нет связи',
    auth: 'неверный пароль',
    checking: 'проверка…',
    conflict: 'прокси занят'
  }[h.status] || 'выбран';
}

function healthClass(srv) {
  if (srv.id !== state.activeServerId || !state.enabled) return '';
  return { ok: 'vpn', down: 'bad', auth: 'bad', checking: 'warn', conflict: 'warn' }[state.health.status] || '';
}

function render() {
  const list = $('serverList');
  const servers = state.servers;
  list.replaceChildren(...servers.map((srv) => {
    if (srv.id === confirmId) {
      return el('li', { class: 'list-item server-item' }, el('div', { class: 'server-confirm' },
        el('span', { text: `Удалить «${serverTitle(srv)}»?` }),
        el('button', { type: 'button', class: 'btn btn-sm btn-secondary', dataset: { cancel: srv.id }, text: 'Отмена' }),
        el('button', { type: 'button', class: 'btn btn-sm btn-danger', dataset: { confirm: srv.id }, text: 'Удалить' })
      ));
    }
    const active = srv.id === state.activeServerId;
    return el('li', { class: 'list-item server-item' },
      el('button', {
        type: 'button', class: 'server-select', dataset: { select: srv.id },
        'aria-current': active ? 'true' : null, title: active ? 'Активный сервер' : 'Сделать активным'
      },
      flagImg(srv.countryCode),
      el('span', { class: 'server-meta' },
        el('span', { class: 'server-name' }, active ? el('span', { class: `dot ${healthClass(srv)}`, 'aria-hidden': 'true' }) : null, serverTitle(srv)),
        el('span', { class: 'server-sub', text: [srv.host, healthLabel(srv)].filter(Boolean).join(' · ') }))),
      el('button', { type: 'button', class: 'icon-btn icon-btn-sm', dataset: { edit: srv.id }, 'aria-label': `Изменить ${serverTitle(srv)}`, title: 'Изменить' }, icon('pencil', 15)),
      el('button', {
        type: 'button', class: 'icon-btn icon-btn-sm', dataset: { remove: srv.id },
        disabled: servers.length <= 1, 'aria-label': `Удалить ${serverTitle(srv)}`,
        title: servers.length <= 1 ? 'Нельзя удалить единственный сервер' : 'Удалить'
      }, icon('trash-2', 15))
    );
  }));
  const hasServers = servers.length > 0;
  $('btnExportFriend').disabled = !hasServers;
  $('btnCopyKey').disabled = !hasServers;
}

export function setupServers() {
  subscribe(render);

  $('serverList').addEventListener('click', async (event) => {
    const t = event.target.closest('button');
    if (!t) return;
    const { select, edit, remove, confirm, cancel } = t.dataset;
    if (select && select !== state.activeServerId) {
      const res = await send('selectServer', { serverId: select });
      if (!res.success) { toast(res.error); return; }
      await refreshStatus();
      refreshSite();
      refreshHealth({ silent: false });
    } else if (edit) {
      startEdit(edit);
      go('addServer');
    } else if (remove) {
      confirmId = remove;
      render();
      $('serverList').querySelector('[data-cancel]')?.focus();
    } else if (cancel) {
      confirmId = '';
      render();
      $('serverList').querySelector(`[data-remove="${cancel}"]`)?.focus();
    } else if (confirm) {
      confirmId = '';
      const res = await send('removeServer', { serverId: confirm });
      toast(res.success ? 'Сервер удалён' : res.error, res.success ? 'success' : 'error');
      await refreshStatus();
      refreshHealth({ silent: false });
      $('btnAddServer').focus();
    }
  });

  $('btnExportFriend').addEventListener('click', async () => {
    const btn = $('btnExportFriend');
    btn.disabled = true;
    $('btnExportFriendText').textContent = 'Собираем архив…';
    try {
      await downloadFriendBuild();
      setStatus($('exportStatus'), 'Готово: SSJ_VPN_for_friend.zip (с автоустановщиком внутри).', 'success');
    } catch (err) {
      setStatus($('exportStatus'), err.message || 'Не удалось собрать архив', 'error');
    } finally {
      btn.disabled = !state.servers.length;
      $('btnExportFriendText').textContent = 'Скачать ZIP для друга';
    }
  });

  $('btnCopyKey').addEventListener('click', async () => {
    const res = await send('exportKey');
    if (!res.success) {
      setStatus($('exportStatus'), res.error, 'error');
      return;
    }
    const ok = await copyText(res.key);
    $('btnCopyKeyText').textContent = ok ? 'Скопировано!' : 'Скопировать ключ';
    setTimeout(() => { $('btnCopyKeyText').textContent = 'Скопировать ключ'; }, 1800);
    setStatus($('exportStatus'), ok ? 'Ключ доступа скопирован — отправьте его другу.' : res.key, ok ? 'success' : '');
  });

  $('btnPasteKey').addEventListener('click', async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip || !/ssj1:/i.test(clip)) {
        go('addServer');
        document.querySelector('[data-add-mode="key"]')?.click();
        return;
      }
      setStatus($('exportStatus'), 'Проверяем сервер из ключа…');
      $('btnPasteKey').disabled = true;
      const res = await send('importKey', { key: clip });
      $('btnPasteKey').disabled = false;
      if (!res.success) {
        setStatus($('exportStatus'), res.error, 'error');
        return;
      }
      await refreshStatus();
      await refreshSite();
      refreshHealth({ silent: false });
      setStatus($('exportStatus'), `Подключён: ${serverTitle(res.server)}`, 'success');
    } catch (_) {
      go('addServer');
      document.querySelector('[data-add-mode="key"]')?.click();
    }
  });
}
