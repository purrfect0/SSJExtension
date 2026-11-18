// Add / edit server: paste access key (ssj1:...), 1-line VPS installer, or manual proxy parameters.
import { $, setStatus, setError, copyText, icon, serverTitle, toast } from '../dom.js';
import { state, update } from '../store.js';
import { send } from '../api.js';
import { onShow, back } from '../nav.js';
import { refreshStatus, refreshSite, refreshHealth } from '../sync.js';

let mode = 'auto'; // 'key' | 'auto' | 'manual'
let editingId = '';
let pollTimer = null;
let tick = 0;
let checking = false;

function setMode(next) {
  mode = next;
  for (const btn of document.querySelectorAll('[data-add-mode]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.addMode === mode));
  }
  $('formKeyAdd').hidden = mode !== 'key';
  $('formInstall').hidden = mode !== 'auto' || Boolean(state.pending);
  $('installCard').hidden = mode !== 'auto' || !state.pending;
  $('formManual').hidden = mode !== 'manual';
  if (mode === 'auto') renderInstall(); else stopPolling();
}

function resetForm() {
  editingId = '';
  $('addServerTitle').textContent = 'Новый сервер';
  $('addModeSwitch').hidden = false;
  for (const id of ['cfgName', 'cfgHost', 'cfgCountry', 'cfgUsername', 'cfgPassword', 'inputAddKey']) {
    $(id).value = '';
  }
  $('cfgPort').value = '8443';
  setPasswordVisible(false);
  $('btnSaveServer').textContent = 'Проверить и добавить';
  $('btnCopyUninstall').hidden = true;
  setStatus($('saveStatus'), '');
  setStatus($('addKeyStatus'), '');
}

export function startEdit(serverId) {
  const srv = state.servers.find((x) => x.id === serverId);
  if (!srv) return;
  resetForm();
  editingId = srv.id;
  $('addServerTitle').textContent = serverTitle(srv);
  $('addModeSwitch').hidden = true;
  $('cfgName').value = srv.name || '';
  $('cfgHost').value = srv.host;
  $('cfgPort').value = srv.httpsPort || 8443;
  $('cfgCountry').value = srv.countryCode || '';
  $('cfgUsername').value = srv.username || '';
  $('cfgPassword').value = srv.password || '';
  $('btnSaveServer').textContent = 'Сохранить';
  $('btnCopyUninstall').hidden = false;
  mode = 'manual';
}

function setPasswordVisible(visible) {
  $('cfgPassword').type = visible ? 'text' : 'password';
  const btn = $('btnTogglePw');
  btn.replaceChildren(icon(visible ? 'eye-off' : 'eye', 16));
  btn.setAttribute('aria-pressed', String(visible));
  btn.setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
}

function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderInstall() {
  const p = state.pending;
  $('formInstall').hidden = Boolean(p);
  $('installCard').hidden = !p;
  if (!p) { stopPolling(); return; }
  $('installCmd').textContent = p.command;
  $('installStatusText').textContent = `Ждём установку на ${p.host} · ${elapsed(Date.now() - p.createdAt)}`;
  startPolling();
}

function startPolling() {
  if (pollTimer) return;
  tick = 0;
  pollTimer = setInterval(async () => {
    if (!state.pending) { stopPolling(); return; }
    $('installStatusText').textContent = `Ждём установку на ${state.pending.host} · ${elapsed(Date.now() - state.pending.createdAt)}`;
    if (++tick % 4 || checking) return;
    checking = true;
    try { await handlePending(await send('checkPending')); } finally { checking = false; }
  }, 1000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

export async function handlePending(res) {
  if (!res || !res.success) return;
  if (res.status === 'added') {
    stopPolling();
    update({ pending: null });
    $('inputInstallIp').value = '';
    $('inputInstallName').value = '';
    await refreshStatus();
    refreshHealth({ silent: false });
    back();
    toast(`Сервер добавлен: ${serverTitle(res.server)}`, 'success');
  } else if (res.status === 'expired') {
    update({ pending: null });
    renderInstall();
    setError($('installError'), 'Сервер не ответил за 30 минут. Проверьте вывод команды на VPS и начните заново.');
  } else if (res.status === 'none' && state.pending) {
    update({ pending: null });
    renderInstall();
  }
}

export function setupAddServer() {
  onShow('addServer', () => {
    if (!editingId) {
      resetForm();
      setMode(state.pending ? 'auto' : !state.servers.length ? 'key' : mode);
    } else {
      setMode('manual');
    }
  });
  onShow('servers', () => { stopPolling(); editingId = ''; });

  for (const btn of document.querySelectorAll('[data-add-mode]')) {
    btn.addEventListener('click', () => setMode(btn.dataset.addMode));
  }

  $('formKeyAdd').addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = $('inputAddKey').value.trim();
    if (!raw) { $('inputAddKey').focus(); return; }
    setStatus($('addKeyStatus'), 'Проверяем сервер из ключа…');
    $('btnSubmitAddKey').disabled = true;
    const res = await send('importKey', { key: raw });
    $('btnSubmitAddKey').disabled = false;
    if (!res.success) {
      setStatus($('addKeyStatus'), res.error, 'error');
      return;
    }
    $('inputAddKey').value = '';
    await refreshStatus();
    await refreshSite();
    refreshHealth({ silent: false });
    back();
    toast(`Подключён: ${serverTitle(res.server)}`, 'success');
  });

  $('formInstall').addEventListener('submit', async (event) => {
    event.preventDefault();
    setError($('installError'), '', $('inputInstallIp'));
    $('btnBeginInstall').disabled = true;
    const res = await send('beginInstall', { host: $('inputInstallIp').value.trim(), name: $('inputInstallName').value.trim() });
    $('btnBeginInstall').disabled = false;
    if (!res.success) { setError($('installError'), res.error, $('inputInstallIp')); return; }
    update({ pending: res.pending });
    renderInstall();
    $('btnCopyCmd').focus();
  });

  $('btnCopyCmd').addEventListener('click', async () => {
    if (!state.pending) return;
    const ok = await copyText(state.pending.command);
    $('btnCopyCmdText').textContent = ok ? 'Скопировано!' : 'Не удалось скопировать — выделите вручную';
    setTimeout(() => { $('btnCopyCmdText').textContent = 'Скопировать команду'; }, 1800);
  });

  $('btnCancelInstall').addEventListener('click', async () => {
    await send('cancelPending');
    update({ pending: null });
    renderInstall();
    $('inputInstallIp').focus();
  });

  $('btnTogglePw').addEventListener('click', () => setPasswordVisible($('cfgPassword').type === 'password'));

  $('formManual').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      name: $('cfgName').value.trim(),
      host: $('cfgHost').value.trim(),
      httpsPort: parseInt($('cfgPort').value, 10) || 8443,
      username: $('cfgUsername').value.trim(),
      password: $('cfgPassword').value.trim(),
      countryCode: $('cfgCountry').value.trim(),
      editId: editingId
    };
    setStatus($('saveStatus'), editingId ? 'Сохраняем…' : 'Проверяем связь с сервером…');
    $('btnSaveServer').disabled = true;
    const res = await send('addServerManual', { payload });
    $('btnSaveServer').disabled = false;
    if (!res.success) { setStatus($('saveStatus'), res.error, 'error'); return; }
    const wasEdit = Boolean(editingId);
    editingId = '';
    await refreshStatus();
    refreshSite();
    refreshHealth({ silent: false });
    back();
    toast(wasEdit ? 'Настройки сервера сохранены' : `Сервер добавлен: ${serverTitle(res.server)}`, 'success');
  });

  $('btnCopyUninstall').addEventListener('click', async () => {
    if (!editingId) return;
    const res = await send('getUninstallCommand', { serverId: editingId });
    const ok = res.success && (await copyText(res.command));
    setStatus($('saveStatus'), ok ? 'Команда удаления скопирована. Вставьте её в консоль VPS под root.' : 'Не удалось получить команду удаления', ok ? 'success' : 'error');
  });
}
