// Footer: active server and live round-trip ping. Click to re-check.
import { $, serverTitle } from '../dom.js';
import { state, subscribe } from '../store.js';
import { refreshHealth } from '../sync.js';

function render() {
  const h = state.enabled ? state.health : { status: 'off' };
  $('footerServerName').textContent = state.server ? serverTitle(state.server) : 'Нет сервера';
  const ping = $('footerPing');
  const dot = $('footerDot');
  let text = '';
  let cls = '';
  if (h.status === 'ok') {
    text = `${h.latencyMs} мс`;
    cls = h.latencyMs < 150 ? '' : h.latencyMs < 300 ? 'warn' : 'bad';
  } else if (h.status === 'checking') { text = '…'; cls = 'off'; }
  else if (h.status === 'down') { text = 'нет связи'; cls = 'bad'; }
  else if (h.status === 'auth') { text = 'пароль'; cls = 'bad'; }
  else if (h.status === 'conflict') { text = 'занят'; cls = 'warn'; }
  else { text = 'выкл'; cls = 'off'; }
  ping.textContent = text;
  ping.className = `footer-ping ${cls}`.trim();
  dot.className = `dot ${h.status === 'ok' ? (cls || 'vpn') : cls === 'off' ? '' : cls}`.trim();
  $('footerServer').title = h.status === 'ok'
    ? 'Пинг через VPN. Нажмите, чтобы измерить заново.'
    : 'Проверить подключение к серверу';
  $('footerServer').setAttribute('aria-label', `${$('footerServerName').textContent}, ${text}. Проверить подключение`);
}

export function setupFooter() {
  subscribe(render);
  $('footerServer').addEventListener('click', () => refreshHealth({ silent: state.health.status === 'ok' }));
  const version = chrome.runtime.getManifest?.().version_name;
  if (version) $('footerVersion').textContent = `v${version}`;
}
