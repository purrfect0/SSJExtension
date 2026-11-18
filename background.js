/**
 * SSJ VPN v1.0 — background service worker (Manifest V3).
 *
 * Features:
 *   - Split tunnelling PAC engine (domains + delta-encoded RKN IPv4 binary search + custom VPN & bypass lists)
 *   - Dual-port HTTPS HTTP/2 + TLS 1.3 automatic proxy failover (:8443 -> :2053) with strict kill switch
 *   - Automatic background RKN/geoblock domain updates from the active VPS (:2083) every 12h
 *   - Hybrid AdBlock (MV3 declarativeNetRequest + per-site allowlist + VPS dnsmasq)
 *   - Privacy-preserving YouTube SponsorBlock SHA-256 prefix client
 */

import { defaultRules } from './data/default_rules.js';
import { bundledProfile } from './data/bundled_profile.js';
import { iconThemeIds as ICON_THEMES } from './icons/themes.js';
import { matchesDomain, isZapretDomain, isGeoDomain, includedDomains, ipInPreset,
  normalizeRule, registrableDomain, matchingRules, isIpRule, isIPv6 } from './data/routing_utils.js';

const ZAPRET_DOMAINS = defaultRules.zapretDomains;
const SETTINGS_VERSION = 9;

const HEALTH_HOST = 'cp.cloudflare.com';
const HEALTH_URL = `https://${HEALTH_HOST}/generate_204`;
const HEALTH_ALARM = 'ssj-health';
const RULES_SYNC_ALARM = 'ssj-rules-sync';

const KNOWN_DIRECT = [
  'ru', 'xn--p1ai', 'su', 'yandex.net', 'yastatic.net', 'yandex.com', 'ya.ru', 'vk.com', 'vk.ru', 'vk.me',
  'userapi.com', 'vkuser.net', 'vkuseraudio.net', 'vkuservideo.net', 'mycdn.me', 'ok.ru', 'mail.ru',
  'imgsmail.ru', 'max.ru', 'avito.st', 'wbbasket.ru', 'wbstatic.net', 'ozone.ru', 'ozonusercontent.com',
  'tbank.ru', 'tinkoff.ru', 'sberbank.ru', 'gosuslugi.ru', 'cdnvideo.ru'
];

const SERVER_FIELDS = [
  'id', 'name', 'host', 'httpsDomain', 'httpsPort', 'backupPort', 'feedPort',
  'username', 'password', 'countryCode', 'countryName', 'geoCheckedAt', 'addedAt'
];

function cleanServer(raw) {
  const record = {};
  for (const key of SERVER_FIELDS) if (raw[key] !== undefined) record[key] = raw[key];
  record.httpsDomain = record.httpsDomain || `${record.host}.sslip.io`;
  record.httpsPort = Number(record.httpsPort) || 8443;
  record.backupPort = raw.backupPort === 0 ? 0 : (Number(raw.backupPort) || (record.httpsPort === 8443 ? 2053 : 0));
  record.feedPort = Number(raw.feedPort) || 2083;
  return record;
}

const STARTER_SERVERS = Array.isArray(bundledProfile?.servers)
  ? bundledProfile.servers.filter((server) => server && server.host).map(cleanServer)
  : [];
const STARTER_SERVER = STARTER_SERVERS.find((server) => server.id === bundledProfile?.activeServerId)
  || STARTER_SERVERS[0] || null;

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: bundledProfile?.mode === 'all' ? 'all' : 'whitelist',
  ipsetPreset: bundledProfile?.ipsetPreset === 'zapret' ? 'zapret' : 'full',
  adblock: bundledProfile?.adblock !== false,
  sponsorBlock: bundledProfile?.sponsorBlock !== false,
  bypassRu: bundledProfile?.bypassRu !== false,
  autoReload: bundledProfile?.autoReload !== false,
  webrtcProtect: Boolean(bundledProfile?.webrtcProtect),
  onboardingDone: false,
  settingsVersion: SETTINGS_VERSION,
  iconTheme: ICON_THEMES.includes(bundledProfile?.iconTheme) ? bundledProfile.iconTheme : 'mint',
  uiTheme: bundledProfile?.uiTheme === 'light' ? 'light' : 'dark',
  servers: STARTER_SERVERS,
  activeServerId: STARTER_SERVER ? STARTER_SERVER.id : '',
  server: STARTER_SERVER ? { ...STARTER_SERVER } : null,
  pending: null,
  customWhitelist: [],
  customBypass: [],
  adblockAllowlist: [],
  lastUpdated: defaultRules.updatedAt || new Date().toISOString()
};

let currentSettings = { ...DEFAULT_SETTINGS };
let remoteRules = { updatedAt: '', domains: [], geoDomains: [] };
let settingsLoaded = false;

function normalizeRules(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const { rule } = normalizeRule(item);
    if (rule && !out.includes(rule)) out.push(rule);
  }
  return out;
}

function effectiveDomains(preset) {
  const base = includedDomains(preset);
  if (!remoteRules.domains?.length) return base;
  const merged = new Set(base);
  for (const d of remoteRules.domains) {
    if (preset === 'zapret' && isZapretDomain(d)) continue;
    merged.add(d);
  }
  return [...merged];
}

function isEffectiveGeo(host) {
  return isGeoDomain(host) || (remoteRules.geoDomains?.length > 0 && matchesDomain(host, remoteRules.geoDomains));
}

function effectiveUpdatedAt() {
  const baseDate = defaultRules.updatedAt || '';
  const remDate = remoteRules.updatedAt || '';
  return remDate > baseDate ? remDate : baseDate;
}

function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  delete s.excludeGemini;

  let servers = Array.isArray(raw && raw.servers) ? raw.servers.filter((x) => x && x.host) : [];
  if (!servers.length) {
    servers = raw && raw.server && raw.server.host
      ? [{ ...raw.server, id: raw.server.id || 'srv_main' }]
      : STARTER_SERVERS.map((server) => ({ ...server }));
  }

  if (bundledProfile?.bundleId && raw?.appliedBundleId !== bundledProfile.bundleId) {
    servers = servers.map((srv) => ({ ...srv }));

    for (const supplied of STARTER_SERVERS) {
      const existing = servers.find((server) => server.host === supplied.host &&
        Number(server.httpsPort || 8443) === Number(supplied.httpsPort || 8443));
      if (existing) {
        if (supplied.username && supplied.password) {
          existing.username = supplied.username;
          existing.password = supplied.password;
        }
        if (supplied.httpsDomain) existing.httpsDomain = supplied.httpsDomain;
        if (supplied.backupPort !== undefined) existing.backupPort = supplied.backupPort;
        if (supplied.feedPort !== undefined) existing.feedPort = supplied.feedPort;
        if (supplied.name) existing.name = supplied.name;
        if (supplied.countryCode) existing.countryCode = supplied.countryCode;
        if (supplied.countryName) existing.countryName = supplied.countryName;
      } else {
        const id = servers.some((server) => server.id === supplied.id) ? newServerId() : supplied.id;
        servers.push({ ...supplied, id });
      }
    }
    if (STARTER_SERVER) {
      const match = servers.find((server) => server.host === STARTER_SERVER.host);
      if (match && (!s.activeServerId || !servers.some((x) => x.id === s.activeServerId))) {
        s.activeServerId = match.id;
      }
    }
    s.appliedBundleId = bundledProfile.bundleId;
  }

  s.servers = servers.map(cleanServer);
  s.settingsVersion = SETTINGS_VERSION;
  if (!ICON_THEMES.includes(s.iconTheme)) s.iconTheme = 'mint';
  if (!['dark', 'light'].includes(s.uiTheme)) s.uiTheme = 'dark';
  if (!['whitelist', 'all'].includes(s.mode)) s.mode = 'whitelist';
  if (!['full', 'zapret'].includes(s.ipsetPreset)) s.ipsetPreset = 'full';
  s.adblock = raw && typeof raw.adblock === 'boolean' ? raw.adblock : DEFAULT_SETTINGS.adblock;
  s.sponsorBlock = raw && typeof raw.sponsorBlock === 'boolean' ? raw.sponsorBlock : DEFAULT_SETTINGS.sponsorBlock;
  s.bypassRu = raw && typeof raw.bypassRu === 'boolean' ? raw.bypassRu : DEFAULT_SETTINGS.bypassRu;
  s.autoReload = raw && typeof raw.autoReload === 'boolean' ? raw.autoReload : DEFAULT_SETTINGS.autoReload;
  s.webrtcProtect = Boolean(raw && raw.webrtcProtect);
  s.onboardingDone = Boolean(raw && raw.onboardingDone);

  const active = s.servers.find((x) => x.id === s.activeServerId) || s.servers[0] || null;
  s.activeServerId = active ? active.id : '';
  s.server = active ? { ...active } : null;
  s.customWhitelist = normalizeRules(raw && raw.customWhitelist);
  s.customBypass = normalizeRules(raw && raw.customBypass).filter((r) => !s.customWhitelist.includes(r));
  s.adblockAllowlist = normalizeRules(raw && raw.adblockAllowlist).filter((r) => !isIpRule(r));
  s.pending = (raw && raw.pending) || null;
  return s;
}

async function loadSettings() {
  try {
    const data = await chrome.storage.local.get(['ssjSettings', 'ssjRemoteRules']);
    if (data.ssjRemoteRules && Array.isArray(data.ssjRemoteRules.domains)) {
      remoteRules = data.ssjRemoteRules;
    }
    currentSettings = normalizeSettings(data.ssjSettings);
    settingsLoaded = true;
    const stored = data.ssjSettings;
    if (!stored || !Array.isArray(stored.servers) || stored.settingsVersion !== SETTINGS_VERSION ||
        stored.appliedBundleId !== currentSettings.appliedBundleId) {
      await chrome.storage.local.set({ ssjSettings: currentSettings });
    }
  } catch (e) {
    console.error('[SSJ VPN] Error loading settings:', e);
  }
}

async function saveSettings() {
  currentSettings = normalizeSettings(currentSettings);
  settingsLoaded = true;
  await chrome.storage.local.set({ ssjSettings: currentSettings });
}

let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn);
  lockChain = run.catch(() => {});
  return run;
}

async function mutate(fn) {
  return withLock(async () => {
    await loadSettings();
    const result = await fn(currentSettings);
    await saveSettings();
    return result;
  });
}

// ---------------------------------------------------------------------------
// PAC script generation (with dual-port automatic failover & strict ASCII guarantee)
// ---------------------------------------------------------------------------
function splitCustomRules(rules) {
  const domains = {};
  const ipv4 = [];
  const ipv6 = {};
  for (const rule of rules || []) {
    if (isIPv6(rule)) ipv6[rule] = 1;
    else if (isIpRule(rule)) ipv4.push(rule);
    else domains[rule] = 1;
  }
  return { domains, ipv4, ipv6 };
}

function ensureAsciiPac(script) {
  return script.replace(/[^\x00-\x7F]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function generatePacScript(settings) {
  if (!settings.enabled || !settings.server) {
    return 'function FindProxyForURL(url, host) { return "DIRECT"; }';
  }
  const { host, httpsDomain, httpsPort, backupPort } = settings.server;
  const domain = httpsDomain || `${host}.sslip.io`;
  const port = Number(httpsPort) || 8443;
  const bPort = Number(backupPort) || 0;
  // Native Chromium automatic proxy failover: tries primary :8443, falls back to :2053 if blocked, never leaks DIRECT.
  const proxyString = bPort && bPort !== port
    ? `HTTPS ${domain}:${port}; HTTPS ${domain}:${bPort}`
    : `HTTPS ${domain}:${port}`;

  const ownHosts = {};
  for (const s of (settings.servers || [])) {
    ownHosts[String(s.host).toLowerCase()] = 1;
    ownHosts[String(s.httpsDomain || `${s.host}.sslip.io`).toLowerCase()] = 1;
  }

  const custom = splitCustomRules(settings.customWhitelist);
  const bypass = splitCustomRules(settings.customBypass);
  const domainsMap = {};
  const isZapretPreset = settings.ipsetPreset === 'zapret';
  for (const d of effectiveDomains(settings.ipsetPreset)) domainsMap[d] = 1;

  const common = `
var PROXY = ${JSON.stringify(proxyString)};
var OWN_HOSTS = ${JSON.stringify(ownHosts)};
var HEALTH_HOST = ${JSON.stringify(HEALTH_HOST)};
var CUSTOM_DOMAINS = ${JSON.stringify(custom.domains)};
var CUSTOM_IPS = ${JSON.stringify(custom.ipv4)};
var CUSTOM_IPV6 = ${JSON.stringify(custom.ipv6)};
var BYPASS_DOMAINS = ${JSON.stringify(bypass.domains)};
var BYPASS_IPS = ${JSON.stringify(bypass.ipv4)};
var BYPASS_IPV6 = ${JSON.stringify(bypass.ipv6)};
var KNOWN_DIRECT = ${JSON.stringify(Object.fromEntries(KNOWN_DIRECT.map((d) => [d, 1])))};

function isLocalHost(host) {
  if (isPlainHostName(host) || host === "localhost" || shExpMatch(host, "*.local") ||
      shExpMatch(host, "*.localhost") || shExpMatch(host, "*.lan") || shExpMatch(host, "*.home.arpa")) return true;
  if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(host)) {
    return isInNet(host, "127.0.0.0", "255.0.0.0") || isInNet(host, "10.0.0.0", "255.0.0.0") ||
      isInNet(host, "172.16.0.0", "255.240.0.0") || isInNet(host, "192.168.0.0", "255.255.0.0") ||
      isInNet(host, "169.254.0.0", "255.255.0.0") || isInNet(host, "100.64.0.0", "255.192.0.0") ||
      isInNet(host, "0.0.0.0", "255.0.0.0");
  }
  return host === "::1" || /^f[cd]/.test(host) || /^fe80:/.test(host);
}

function inDomainMap(host, map) {
  if (map[host] === 1) return true;
  var dot = host.indexOf(".");
  while (dot !== -1) {
    if (map[host.substring(dot + 1)] === 1) return true;
    dot = host.indexOf(".", dot + 1);
  }
  return false;
}

function maskFor(bits) {
  var mask = [];
  for (var i = 0; i < 4; i++) {
    var n = Math.min(Math.max(bits, 0), 8);
    mask.push(256 - Math.pow(2, 8 - n));
    bits -= 8;
  }
  return mask.join(".");
}

function inIpList(ip, list) {
  for (var i = 0; i < list.length; i++) {
    var rule = list[i];
    var slash = rule.indexOf("/");
    if (slash === -1) { if (ip === rule) return true; }
    else if (isInNet(ip, rule.substring(0, slash), maskFor(+rule.substring(slash + 1)))) return true;
  }
  return false;
}
`;

  if (settings.mode === 'all') {
    const bypassRu = Boolean(settings.bypassRu);
    return ensureAsciiPac(`${common}
var BYPASS_RU = ${bypassRu ? 'true' : 'false'};
var DOMAINS = ${bypassRu ? JSON.stringify(domainsMap) : '{}'};

function FindProxyForURL(url, host) {
  host = host.toLowerCase().replace(/\\.$/, "").replace(/^\\[|\\]$/g, "");
  if (host === HEALTH_HOST) return PROXY;
  if (OWN_HOSTS[host] === 1 || isLocalHost(host)) return "DIRECT";

  // 1. Explicit user direct bypass rules
  if (inDomainMap(host, BYPASS_DOMAINS) || BYPASS_IPV6[host] === 1) return "DIRECT";
  var isIp = /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(host);
  if (isIp && inIpList(host, BYPASS_IPS)) return "DIRECT";

  // 2. Explicit user VPN rules
  if (inDomainMap(host, CUSTOM_DOMAINS) || CUSTOM_IPV6[host] === 1) return PROXY;
  if (isIp && inIpList(host, CUSTOM_IPS)) return PROXY;

  // 3. Keep Russian banking/state/.ru sites direct unless they are known blocked domains
  if (BYPASS_RU && !inDomainMap(host, DOMAINS) && inDomainMap(host, KNOWN_DIRECT)) return "DIRECT";

  return PROXY;
}`);
  }

  const deltas = isZapretPreset ? defaultRules.zapretDeltas : defaultRules.deltas;

  return ensureAsciiPac(`${common}
var DOMAINS = ${JSON.stringify(domainsMap)};
var IS_ZAPRET = ${isZapretPreset ? 'true' : 'false'};
var ZAPRET_DOMAINS = ${JSON.stringify(isZapretPreset ? ZAPRET_DOMAINS : [])};
var DELTAS = ${JSON.stringify(deltas)};

var S = [], E = [];
(function () {
  var prev = 0;
  for (var i = 0; i < DELTAS.length; i += 2) {
    var start = prev + DELTAS[i];
    var end = start + DELTAS[i + 1];
    S.push(start); E.push(end); prev = end;
  }
  DELTAS = null;
})();

function ipToInt(ip) {
  var p = ip.split(".");
  return (((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0);
}

function inBlockedRanges(ip) {
  var v = ipToInt(ip), lo = 0, hi = S.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >>> 1;
    if (v < S[mid]) hi = mid - 1;
    else if (v > E[mid]) lo = mid + 1;
    else return true;
  }
  return false;
}

function inDomainList(host, list) {
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (host === d || (host.length > d.length && host.substring(host.length - d.length - 1) === "." + d)) return true;
  }
  return false;
}

var DNS_CACHE = {}, DNS_CACHE_SIZE = 0;
function resolveCached(host) {
  if (DNS_CACHE.hasOwnProperty(host)) return DNS_CACHE[host];
  if (DNS_CACHE_SIZE > 3000) { DNS_CACHE = {}; DNS_CACHE_SIZE = 0; }
  var ip = dnsResolve(host) || "";
  DNS_CACHE[host] = ip; DNS_CACHE_SIZE++;
  return ip;
}

function FindProxyForURL(url, host) {
  host = host.toLowerCase().replace(/\\.$/, "").replace(/^\\[|\\]$/g, "");
  if (host === HEALTH_HOST) return PROXY;
  if (OWN_HOSTS[host] === 1 || isLocalHost(host)) return "DIRECT";

  // 1. User direct bypass exceptions win first.
  if (inDomainMap(host, BYPASS_DOMAINS) || BYPASS_IPV6[host] === 1) return "DIRECT";

  // 2. User custom VPN rules.
  if (inDomainMap(host, CUSTOM_DOMAINS) || CUSTOM_IPV6[host] === 1) return PROXY;

  var isIp = /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(host);
  if (isIp) {
    if (inIpList(host, BYPASS_IPS)) return "DIRECT";
    return (inIpList(host, CUSTOM_IPS) || inBlockedRanges(host)) ? PROXY : "DIRECT";
  }
  if (host.indexOf(":") !== -1) return "DIRECT";

  // 3. Sites handled locally by Zapret.
  if (IS_ZAPRET && inDomainList(host, ZAPRET_DOMAINS)) return "DIRECT";

  // 4. Built-in + auto-synced list of blocked and geo-restricted services.
  if (inDomainMap(host, DOMAINS)) return PROXY;

  // 5. Well-known Russian services: no DNS lookup needed.
  if (inDomainMap(host, KNOWN_DIRECT)) return "DIRECT";

  // 6. Address blocked by IP (RKN ranges) or ISP DNS stub.
  var ip = resolveCached(host);
  if (ip) {
    if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(ip) && inIpList(ip, BYPASS_IPS)) return "DIRECT";
    if (ip === "127.0.0.1" || ip === "0.0.0.0") return PROXY;
    if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(ip) && (inIpList(ip, CUSTOM_IPS) || inBlockedRanges(ip))) return PROXY;
  }
  return "DIRECT";
}`);
}

// ---------------------------------------------------------------------------
// Proxy, WebRTC, AdBlock DNR (static + per-site dynamic allowlist) & Health
// ---------------------------------------------------------------------------
async function getProxyControl() {
  try {
    const details = await chrome.proxy.settings.get({ incognito: false });
    return details.levelOfControl;
  } catch (_) {
    return 'unknown';
  }
}

function isBlockedControl(level) {
  return level === 'controlled_by_other_extensions' || level === 'not_controllable';
}

async function applyWebRtcPolicy(active, protect) {
  const api = chrome.privacy?.network?.webRTCIPHandlingPolicy;
  if (!api) return;
  try {
    if (active && protect) {
      await api.set({ value: 'disable_non_proxied_udp', scope: 'regular' });
    } else {
      await api.clear({ scope: 'regular' });
    }
  } catch (_) {}
}

const DYNAMIC_ALLOW_IDS = [10001, 10002];

async function applyAdblockPolicy(enabled, allowlist = []) {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.updateEnabledRulesets) return;
  try {
    await dnr.updateEnabledRulesets({
      enableRulesetIds: enabled ? ['ssj_adblock'] : [],
      disableRulesetIds: enabled ? [] : ['ssj_adblock']
    });
    if (dnr.updateDynamicRules) {
      const cleanAllow = (allowlist || []).filter((d) => d && !isIpRule(d) && /^[\x21-\x7E]+$/.test(d));
      const addRules = [];
      if (enabled && cleanAllow.length) {
        addRules.push(
          {
            id: 10001,
            priority: 100,
            action: { type: 'allowAllRequests' },
            condition: { requestDomains: cleanAllow, resourceTypes: ['main_frame', 'sub_frame'] }
          },
          {
            id: 10002,
            priority: 100,
            action: { type: 'allow' },
            condition: { initiatorDomains: cleanAllow }
          }
        );
      }
      await dnr.updateDynamicRules({ removeRuleIds: DYNAMIC_ALLOW_IDS, addRules });
    }
  } catch (_) {}
}

let health = { status: 'checking' };
let lastProxyError = null;

async function loadRuntimeState() {
  try {
    const data = await chrome.storage.session.get(['ssjHealth', 'ssjProxyError']);
    if (data.ssjHealth) health = data.ssjHealth;
    if (data.ssjProxyError) lastProxyError = data.ssjProxyError;
  } catch (_) {}
}

async function setHealth(next) {
  health = { ...next, checkedAt: Date.now() };
  try { await chrome.storage.session.set({ ssjHealth: health }); } catch (_) {}
  refreshActionState();
}

let applyChain = Promise.resolve();
function applyProxySettings() {
  const run = applyChain.then(applyProxyNow);
  applyChain = run.catch(() => {});
  return run;
}

async function applyProxyNow() {
  await loadSettings();
  const control = await getProxyControl();

  if (!currentSettings.enabled || !currentSettings.server) {
    if (control === 'controlled_by_this_extension') {
      await chrome.proxy.settings.clear({ scope: 'regular' });
    }
    await applyWebRtcPolicy(false, false);
    await applyAdblockPolicy(false, []);
    await chrome.alarms.clear(HEALTH_ALARM);
    await setHealth({ status: currentSettings.server ? 'off' : 'noserver' });
    return;
  }

  if (isBlockedControl(control)) {
    await setHealth({ status: 'conflict', control });
    return;
  }

  await chrome.proxy.settings.set({
    value: {
      mode: 'pac_script',
      pacScript: { data: generatePacScript(currentSettings), mandatory: true }
    },
    scope: 'regular'
  });
  await applyWebRtcPolicy(true, currentSettings.webrtcProtect);
  await applyAdblockPolicy(currentSettings.adblock, currentSettings.adblockAllowlist);
  authFailures.clear();
  chrome.alarms.create(HEALTH_ALARM, { delayInMinutes: 2, periodInMinutes: 2 });
  chrome.alarms.create(RULES_SYNC_ALARM, { delayInMinutes: 15, periodInMinutes: 720 });
  if (health.status !== 'ok' || health.serverId !== currentSettings.activeServerId) {
    await setHealth({ status: 'checking', serverId: currentSettings.activeServerId });
  }
  scheduleHealthCheck(200);
}

// ---------------------------------------------------------------------------
// Automatic daily RKN/geoblock domain list sync from active VPS (:2083)
// ---------------------------------------------------------------------------
let syncBusy = false;
async function syncRemoteRules() {
  if (syncBusy) return false;
  syncBusy = true;
  try {
    await loadSettings();
    const srv = currentSettings.server;
    if (!srv || !srv.httpsDomain) return false;
    const feedPort = Number(srv.feedPort) || 2083;
    const url = `https://${srv.httpsDomain}:${feedPort}/v1/ssj-rules.json`;
    const data = await fetchJson(url, 8000);
    if (!data || !Array.isArray(data.domains) || data.domains.length < 500) return false;
    const cleanDom = data.domains.filter((d) => typeof d === 'string' && /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(d));
    const cleanGeo = Array.isArray(data.geoDomains)
      ? data.geoDomains.filter((d) => typeof d === 'string' && /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(d))
      : [];
    if (cleanDom.length < 500) return false;
    const changed = data.updatedAt !== remoteRules.updatedAt || cleanDom.length !== (remoteRules.domains || []).length;
    remoteRules = {
      updatedAt: String(data.updatedAt || new Date().toISOString()),
      domains: cleanDom,
      geoDomains: cleanGeo
    };
    await chrome.storage.local.set({ ssjRemoteRules: remoteRules });
    if (changed && currentSettings.enabled && currentSettings.server) {
      await applyProxySettings();
    }
    return changed;
  } catch (_) {
    return false;
  } finally {
    syncBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Privacy-preserving SponsorBlock client (SHA-256 4-char prefix k-anonymity)
// ---------------------------------------------------------------------------
const sponsorCache = new Map();
const SPONSOR_TTL_MS = 30 * 60 * 1000;

async function sha256HexPrefix(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  return Array.from(arr.slice(0, 3), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 4);
}

async function fetchSponsorSegments(videoId) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(String(videoId || ''))) return [];
  const now = Date.now();
  const cached = sponsorCache.get(videoId);
  if (cached && now - cached.at < SPONSOR_TTL_MS) return cached.segments;

  try {
    const prefix = await sha256HexPrefix(videoId);
    const categories = encodeURIComponent(JSON.stringify(['sponsor', 'selfpromo', 'interaction']));
    const url = `https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=${categories}`;
    const list = await fetchJson(url, 4500);
    let segments = [];
    if (Array.isArray(list)) {
      const hit = list.find((entry) => entry && entry.videoID === videoId);
      if (hit && Array.isArray(hit.segments)) {
        segments = hit.segments
          .filter((s) => Array.isArray(s.segment) && s.segment.length === 2 && s.segment[1] > s.segment[0])
          .map((s) => ({ UUID: String(s.UUID || ''), category: String(s.category || 'sponsor'), segment: [Number(s.segment[0]), Number(s.segment[1])] }));
      }
    }
    if (sponsorCache.size > 150) {
      sponsorCache.delete(sponsorCache.keys().next().value);
    }
    sponsorCache.set(videoId, { at: now, segments });
    return segments;
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Health & Error reporting
// ---------------------------------------------------------------------------
const PROXY_ERRORS = {
  'net::ERR_PROXY_CONNECTION_FAILED': 'Сервер не отвечает',
  'net::ERR_TUNNEL_CONNECTION_FAILED': 'Сервер отклонил соединение',
  'net::ERR_PROXY_CERTIFICATE_INVALID': 'Ошибка сертификата сервера',
  'net::ERR_PROXY_AUTH_UNSUPPORTED': 'Сервер не принял логин и пароль',
  'net::ERR_PROXY_AUTH_REQUESTED': 'Сервер не принял логин и пароль',
  'net::ERR_UNEXPECTED_PROXY_AUTH': 'Сервер не принял логин и пароль',
  'net::ERR_TIMED_OUT': 'Сервер не отвечает',
  'net::ERR_CONNECTION_TIMED_OUT': 'Сервер не отвечает',
  'net::ERR_CONNECTION_REFUSED': 'Порт сервера закрыт',
  'net::ERR_CONNECTION_RESET': 'Соединение с сервером сброшено',
  'net::ERR_CONNECTION_CLOSED': 'Соединение с сервером сброшено',
  'net::ERR_NAME_NOT_RESOLVED': 'Не найден адрес сервера',
  'net::ERR_INTERNET_DISCONNECTED': 'Нет интернета'
};

function describeError(code) {
  if (!code) return 'Сервер не отвечает';
  if (PROXY_ERRORS[code]) return PROXY_ERRORS[code];
  if (/CERT/.test(code)) return 'Ошибка сертификата сервера';
  return `Нет связи (${code.replace('net::', '')})`;
}

async function timedHealthFetch(timeoutMs) {
  const url = `${HEALTH_URL}?ssj=${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  probeErrors.delete(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    if (res.status !== 204) throw Object.assign(new Error('bad status'), { code: `HTTP ${res.status}` });
    return performance.now() - started;
  } catch (err) {
    for (let i = 0; i < 8 && !probeErrors.has(url); i++) await new Promise((r) => setTimeout(r, 35));
    const code = probeErrors.get(url) || err.code || (ctrl.signal.aborted ? 'net::ERR_TIMED_OUT' : '');
    probeErrors.delete(url);
    throw Object.assign(new Error(code), { code });
  } finally {
    clearTimeout(timer);
  }
}

let healthRun = null;
async function checkHealth() {
  if (healthRun) return healthRun;
  healthRun = (async () => {
    await loadSettings();
    if (!currentSettings.enabled || !currentSettings.server) {
      await setHealth({ status: currentSettings.server ? 'off' : 'noserver' });
      return health;
    }
    const control = await getProxyControl();
    if (isBlockedControl(control)) {
      await setHealth({ status: 'conflict', control });
      return health;
    }
    if (control !== 'controlled_by_this_extension') {
      await applyProxyNow();
    }
    const serverId = currentSettings.activeServerId;
    try {
      const first = await timedHealthFetch(7000);
      const second = await timedHealthFetch(3500);
      const best = Math.min(first, second);
      await setHealth({ status: 'ok', latencyMs: Math.max(1, Math.round(best)), serverId });
    } catch (err) {
      const authFailed = authFailures.size > 0 || /AUTH/.test(err.code || '');
      await setHealth({
        status: authFailed ? 'auth' : 'down',
        error: authFailed ? 'Сервер не принял логин и пароль' : describeError(err.code),
        code: err.code || '',
        serverId
      });
    }
    return health;
  })();
  try {
    return await healthRun;
  } finally {
    healthRun = null;
  }
}

let healthTimer = null;
function scheduleHealthCheck(delayMs) {
  clearTimeout(healthTimer);
  healthTimer = setTimeout(() => { checkHealth().catch(() => {}); }, delayMs);
}

function refreshActionState() {
  const s = currentSettings;
  const active = Boolean(s.enabled && s.server && ['ok', 'checking'].includes(health.status));
  updateIcon(active);
  let badge = '';
  let color = '#19D3A2';
  let title = 'SSJ VPN';
  if (health.status === 'off') title = 'SSJ VPN — выключен';
  else if (health.status === 'noserver') { badge = '!'; color = '#F59E0B'; title = 'SSJ VPN — добавьте сервер'; }
  else if (health.status === 'conflict') { badge = '!'; color = '#F59E0B'; title = 'SSJ VPN — прокси занят другим расширением'; }
  else if (health.status === 'down' || health.status === 'auth') { badge = '!'; color = '#F43F5E'; title = `SSJ VPN — ${health.error || 'сервер не отвечает'}`; }
  else if (health.status === 'ok') title = `SSJ VPN — подключён (${health.latencyMs} мс)`;
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title });
}

function updateIcon(isActive) {
  const suffix = isActive ? '' : '_off';
  const theme = ICON_THEMES.includes(currentSettings.iconTheme) ? currentSettings.iconTheme : 'mint';
  chrome.action.setIcon({
    path: {
      16: `icons/${theme}/icon16${suffix}.png`,
      24: `icons/${theme}/icon24${suffix}.png`,
      32: `icons/${theme}/icon32${suffix}.png`,
      48: `icons/${theme}/icon48${suffix}.png`,
      128: `icons/${theme}/icon128${suffix}.png`
    }
  });
}

chrome.proxy.onProxyError.addListener((details) => {
  lastProxyError = { error: details.error, details: details.details || '', at: Date.now() };
  chrome.storage.session.set({ ssjProxyError: lastProxyError }).catch(() => {});
  if (currentSettings.enabled && health.status === 'ok') scheduleHealthCheck(1500);
});

chrome.proxy.settings.onChange.addListener(() => {
  scheduleHealthCheck(500);
});

// ---------------------------------------------------------------------------
// Tab route observation via webRequest
// ---------------------------------------------------------------------------
const tabRoutes = new Map();
let tabRoutesLoaded = false;

async function ensureTabRoutes() {
  if (tabRoutesLoaded) return;
  tabRoutesLoaded = true;
  try {
    const data = await chrome.storage.session.get(['ssjTabRoutes']);
    for (const [tabId, route] of Object.entries(data.ssjTabRoutes || {})) {
      if (!tabRoutes.has(Number(tabId))) tabRoutes.set(Number(tabId), route);
    }
  } catch (_) {}
}

let saveRoutesTimer = null;
function persistTabRoutes() {
  clearTimeout(saveRoutesTimer);
  saveRoutesTimer = setTimeout(() => {
    const entries = [...tabRoutes.entries()].slice(-200);
    chrome.storage.session.set({ ssjTabRoutes: Object.fromEntries(entries) }).catch(() => {});
  }, 300);
}

function serverAddresses() {
  const set = new Set();
  for (const server of currentSettings.servers || []) {
    set.add(String(server.host).toLowerCase());
    if (server.httpsDomain) set.add(String(server.httpsDomain).toLowerCase());
  }
  return set;
}

function recordTabRoute(details, error) {
  if (details.tabId < 0) return;
  let host = '';
  try { host = new URL(details.url).hostname.toLowerCase(); } catch (_) { return; }
  const ip = String(details.ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!error && (!ip || details.fromCache)) return;
  tabRoutes.set(details.tabId, {
    host, ip, at: Date.now(),
    viaVpn: Boolean(ip && serverAddresses().has(ip)),
    error: error || ''
  });
  persistTabRoutes();
}

chrome.webRequest.onResponseStarted.addListener(
  (details) => { ensureTabRoutes().then(() => recordTabRoute(details, '')); },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }
);
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.error === 'net::ERR_ABORTED') return;
    ensureTabRoutes().then(() => recordTabRoute(details, details.error));
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }
);
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabRoutes.delete(tabId)) persistTabRoutes();
});

// ---------------------------------------------------------------------------
// Multi-server helpers, TLS probing, install command & Access Key (ssj1:...)
// ---------------------------------------------------------------------------
const PENDING_TTL_MS = 30 * 60 * 1000;
const PENDING_ALARM = 'ssj-pending-install';

function isValidIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || '');
  return Boolean(m) && m.slice(1).every((n) => Number(n) <= 255);
}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function cleanName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 28);
}

function defaultServerName(code, host) {
  return code ? `VPN ${countryNameRu(code)}` : `VPN ${host}`;
}

function clampPort(value, fallback) {
  const n = parseInt(value, 10);
  return n >= 1 && n <= 65535 ? n : fallback;
}

function newServerId() {
  return `srv_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

function randomAlnum(length) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function countryNameRu(code) {
  try {
    return new Intl.DisplayNames(['ru'], { type: 'region' }).of(code) || code;
  } catch (_) {
    return code;
  }
}

async function fetchJson(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function lookupCountry(ip) {
  const providers = [
    async () => {
      const j = await fetchJson(`https://ipwho.is/${ip}`);
      return j && j.success !== false ? j.country_code : '';
    },
    async () => {
      const j = await fetchJson(`https://api.country.is/${ip}`);
      return j ? j.country : '';
    },
    async () => {
      const j = await fetchJson(`https://get.geojs.io/v1/ip/country/${ip}.json`);
      return j ? j.country : '';
    }
  ];
  for (const provider of providers) {
    try {
      const code = String((await provider()) || '').trim();
      if (/^[A-Za-z]{2}$/.test(code)) return code.toUpperCase();
    } catch (_) {}
  }
  return '';
}

const probeErrors = new Map();
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.url.includes('ssj_probe=') || details.url.startsWith(HEALTH_URL)) {
      probeErrors.set(details.url, details.error);
      if (probeErrors.size > 100) {
        probeErrors.delete(probeErrors.keys().next().value);
      }
    }
  },
  { urls: ['https://*/*'] }
);

async function probeTls(domain, port, timeoutMs = 6000) {
  const url = `https://${domain}:${port}/?ssj_probe=${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  probeErrors.delete(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return true;
  } catch (_) {
    for (let i = 0; i < 10 && !probeErrors.has(url); i++) {
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    const error = probeErrors.get(url);
    probeErrors.delete(url);
    return error === 'net::ERR_UNEXPECTED_PROXY_AUTH';
  } finally {
    clearTimeout(timer);
  }
}

async function detectWorkingDomain(host, port, timeoutMs = 5000) {
  const ports = port === 8443 ? [8443, 2053] : [port];
  for (const domain of [`${host}.sslip.io`, `${host}.nip.io`]) {
    for (const p of ports) {
      if (await probeTls(domain, p, timeoutMs)) return domain;
    }
  }
  return '';
}

async function gzipBase64(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function buildServerCommand(scriptFile, env) {
  const res = await fetch(chrome.runtime.getURL(scriptFile));
  const text = await res.text();
  const packed = await gzipBase64(text);
  // Wrap at 76 chars per line so pasting never hits the Linux kernel 4095-byte N_TTY single-line limit.
  const wrapped = packed.replace(/.{1,76}/g, '$&\n').trimEnd();
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
  return `${vars} bash -c "$(base64 -d <<'SSJ' | gunzip\n${wrapped}\nSSJ\n)"`;
}

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(token) {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function createAccessKey(settings) {
  if (!settings.servers.length) throw new Error('Сначала добавьте хотя бы один сервер');
  const active = settings.server || settings.servers[0];
  const payload = {
    v: 1,
    a: active.host,
    s: settings.servers.map((srv) => ({
      n: srv.name || '',
      h: srv.host,
      d: srv.httpsDomain && srv.httpsDomain !== `${srv.host}.sslip.io` ? srv.httpsDomain : undefined,
      p: srv.httpsPort && srv.httpsPort !== 8443 ? srv.httpsPort : undefined,
      b: srv.backupPort && srv.backupPort !== 2053 ? srv.backupPort : undefined,
      u: srv.username,
      w: srv.password,
      c: srv.countryCode || undefined
    }))
  };
  return `ssj1:${toBase64Url(JSON.stringify(payload))}`;
}

function parseAccessKey(rawText) {
  const match = /ssj1:([A-Za-z0-9_-]{16,})/.exec(String(rawText || ''));
  if (!match) return { error: 'Ключ не найден. Скопируйте строку вида ssj1:… целиком.' };
  try {
    const data = JSON.parse(fromBase64Url(match[1]));
    if (!data || !Array.isArray(data.s) || !data.s.length) return { error: 'Повреждённый ключ доступа' };
    const servers = [];
    for (const item of data.s) {
      const host = String(item.h || '').trim();
      const username = String(item.u || '').trim();
      const password = String(item.w || '').trim();
      if (!isValidIPv4(host) || !username || !password) continue;
      const code = /^[A-Za-z]{2}$/.test(item.c || '') ? String(item.c).toUpperCase() : '';
      const httpsPort = clampPort(item.p, 8443);
      const backupPort = item.b !== undefined ? clampPort(item.b, 0) : (httpsPort === 8443 ? 2053 : 0);
      const httpsDomain = item.d && /^[a-z0-9.-]+$/i.test(item.d) ? String(item.d).toLowerCase() : `${host}.sslip.io`;
      servers.push({
        host,
        httpsDomain,
        httpsPort,
        backupPort,
        feedPort: 2083,
        name: cleanName(item.n) || defaultServerName(code, host),
        username,
        password,
        countryCode: code,
        countryName: code ? countryNameRu(code) : ''
      });
    }
    if (!servers.length) return { error: 'В ключе нет корректных данных сервера' };
    return { servers, activeHost: String(data.a || servers[0].host) };
  } catch (_) {
    return { error: 'Не удалось прочитать ключ доступа. Проверьте, что он скопирован полностью.' };
  }
}

async function ensureGeo() {
  await loadSettings();
  const now = Date.now();
  const todo = currentSettings.servers.filter(
    (s) => !s.countryCode && (!s.geoCheckedAt || now - s.geoCheckedAt > 6 * 3600 * 1000)
  );
  if (!todo.length) return false;

  const found = {};
  for (const s of todo) found[s.id] = await lookupCountry(s.host);

  await mutate((cur) => {
    for (const s of cur.servers) {
      if (!(s.id in found)) continue;
      s.geoCheckedAt = now;
      if (found[s.id] && !s.countryCode) {
        s.countryCode = found[s.id];
        s.countryName = countryNameRu(found[s.id]);
      }
    }
  });
  return true;
}

function armPendingAlarm() {
  if (currentSettings.pending) {
    chrome.alarms.create(PENDING_ALARM, { delayInMinutes: 0.25, periodInMinutes: 0.5 });
  }
}

async function checkPendingNow() {
  await loadSettings();
  const p = currentSettings.pending;
  if (!p) return { status: 'none' };

  if (Date.now() - p.createdAt > PENDING_TTL_MS) {
    await mutate((s) => { s.pending = null; });
    await chrome.alarms.clear(PENDING_ALARM);
    return { status: 'expired', host: p.host };
  }

  const httpsDomain = await detectWorkingDomain(p.host, 8443, 5000);
  if (!httpsDomain) return { status: 'waiting' };

  const code = await lookupCountry(p.host);
  let created = null;
  await mutate((s) => {
    if (!s.pending || s.pending.id !== p.id) return;
    if (!s.servers.some((x) => x.host === p.host)) {
      created = {
        id: newServerId(),
        host: p.host,
        httpsDomain,
        httpsPort: 8443,
        backupPort: 2053,
        feedPort: 2083,
        name: cleanName(p.name) || defaultServerName(code, p.host),
        username: p.username,
        password: p.password,
        countryCode: code,
        countryName: code ? countryNameRu(code) : '',
        geoCheckedAt: Date.now(),
        addedAt: Date.now()
      };
      s.servers.push(created);
      s.activeServerId = created.id;
    }
    s.pending = null;
  });

  await chrome.alarms.clear(PENDING_ALARM);
  if (!created) return { status: 'none' };
  await applyProxySettings();
  return { status: 'added', server: created };
}

// Fast in-memory proxy authentication (accepts both primary :8443 and failover :2053 ports).
const authAttempts = new Map();
const authFailures = new Set();
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) {
      callback({});
      return;
    }
    const respond = () => {
      const s = currentSettings;
      const challenger = ((details.challenger && details.challenger.host) || '').toLowerCase().replace(/\.$/, '');
      const port = Number(details.challenger && details.challenger.port);
      const srv = (s.servers || []).find((x) => {
        const hostOk = String(x.host).toLowerCase() === challenger || (x.httpsDomain || '').toLowerCase() === challenger;
        const portOk = Number(x.httpsPort || 8443) === port || (Number(x.backupPort || 0) > 0 && Number(x.backupPort) === port);
        return hostOk && portOk;
      });
      if (!srv || !srv.username || !srv.password) {
        callback({});
        return;
      }
      const attempts = (authAttempts.get(details.requestId) || 0) + 1;
      authAttempts.set(details.requestId, attempts);
      setTimeout(() => authAttempts.delete(details.requestId), 60000);
      if (attempts > 1) {
        authFailures.add(srv.id);
        callback({ cancel: true });
        if (health.status !== 'auth') scheduleHealthCheck(200);
        return;
      }
      callback({ authCredentials: { username: srv.username, password: srv.password } });
    };

    if (settingsLoaded) respond();
    else loadSettings().then(respond).catch(() => callback({}));
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
let startPromise = null;
function start() {
  if (!startPromise) {
    startPromise = (async () => {
      await loadRuntimeState();
      await loadSettings();
      const control = await getProxyControl();
      if (currentSettings.enabled && currentSettings.server && control !== 'controlled_by_this_extension') {
        await applyProxySettings();
      } else if (!currentSettings.enabled || !currentSettings.server) {
        await applyProxySettings();
      } else {
        await applyWebRtcPolicy(true, currentSettings.webrtcProtect);
        await applyAdblockPolicy(currentSettings.adblock, currentSettings.adblockAllowlist);
        chrome.alarms.create(RULES_SYNC_ALARM, { delayInMinutes: 15, periodInMinutes: 720 });
        refreshActionState();
        if (!health.checkedAt || Date.now() - health.checkedAt > 60000) scheduleHealthCheck(800);
      }
      armPendingAlarm();
      if (currentSettings.enabled && currentSettings.server) {
        setTimeout(() => { syncRemoteRules().catch(() => {}); }, 3500);
      }
    })().catch((err) => {
      startPromise = null;
      console.error('[SSJ VPN] start failed:', err);
    });
  }
  return startPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  start().then(() => {
    applyProxySettings().catch(() => {});
    ensureGeo().catch(() => {});
    syncRemoteRules().catch(() => {});
  });
});
chrome.runtime.onStartup.addListener(() => {
  start().then(() => {
    ensureGeo().catch(() => {});
    syncRemoteRules().catch(() => {});
  });
});
start();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PENDING_ALARM) checkPendingNow().catch(() => {});
  if (alarm.name === HEALTH_ALARM) start().then(() => checkHealth()).catch(() => {});
  if (alarm.name === RULES_SYNC_ALARM) start().then(() => syncRemoteRules()).catch(() => {});
});

const UNLOCKED_ACTIONS = new Set([
  'addServerManual', 'checkPending', 'ensureGeo', 'probeServer',
  'checkHealth', 'importKey', 'getSponsorSegments', 'syncRules'
]);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const run = async () => { await start(); return handleMessage(request, sendResponse); };
  const task = UNLOCKED_ACTIONS.has(request.action) ? run() : withLock(run);
  task.catch((err) => {
    console.error('[SSJ VPN] Message failed:', request && request.action, err);
    sendResponse({ success: false, error: String((err && err.message) || err) });
  });
  return true;
});

function publicStatus() {
  const preset = currentSettings.ipsetPreset || 'full';
  const domains = effectiveDomains(preset);
  return {
    enabled: currentSettings.enabled,
    mode: currentSettings.mode,
    ipsetPreset: preset,
    adblock: currentSettings.adblock,
    sponsorBlock: currentSettings.sponsorBlock,
    bypassRu: currentSettings.bypassRu,
    autoReload: currentSettings.autoReload,
    webrtcProtect: currentSettings.webrtcProtect,
    onboardingDone: currentSettings.onboardingDone,
    server: currentSettings.server,
    servers: currentSettings.servers,
    activeServerId: currentSettings.activeServerId,
    iconTheme: currentSettings.iconTheme,
    uiTheme: currentSettings.uiTheme,
    pending: currentSettings.pending || null,
    customWhitelist: currentSettings.customWhitelist || [],
    customBypass: currentSettings.customBypass || [],
    adblockAllowlist: currentSettings.adblockAllowlist || [],
    health,
    lastProxyError,
    totalIpRanges: (preset === 'zapret' ? defaultRules.zapretDeltas : defaultRules.deltas).length / 2,
    totalDefaultDomains: domains.length,
    totalGeoDomains: domains.filter(isEffectiveGeo).length,
    lastUpdated: effectiveUpdatedAt()
  };
}

async function hostStatus(host, tabId) {
  host = String(host || '').trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  const s = currentSettings;
  const matchedRules = matchingRules(host, s.customWhitelist);
  const matchedBypass = matchingRules(host, s.customBypass);
  const matchedAdAllow = matchingRules(host, s.adblockAllowlist);
  const ownServer = s.servers.some((server) =>
    host === server.host.toLowerCase() || host === (server.httpsDomain || '').toLowerCase());
  const isLocal = !host || (!host.includes('.') && !host.includes(':')) || host.endsWith('.local') ||
    host === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || ownServer;
  const isBypassed = matchedBypass.length > 0;
  const isCustom = !isBypassed && matchedRules.length > 0;
  const isZapretExcluded = !isBypassed && !isCustom && s.mode !== 'all' && s.ipsetPreset === 'zapret' && isZapretDomain(host);
  const isDefault = !isBypassed && !isZapretExcluded &&
    (matchesDomain(host, effectiveDomains(s.ipsetPreset)) || ipInPreset(host, s.ipsetPreset));
  const isKnownRu = matchesDomain(host, KNOWN_DIRECT);
  const isIpLiteral = isIpRule(host);

  let route = 'direct';
  let reason = 'none';
  if (!s.enabled || !s.server) reason = 'off';
  else if (isLocal) reason = 'local';
  else if (isBypassed) { route = 'direct'; reason = 'bypass'; }
  else if (isCustom) { route = 'vpn'; reason = 'custom'; }
  else if (s.mode === 'all') {
    if (s.bypassRu && !isDefault && isKnownRu) { route = 'direct'; reason = 'ru_direct'; }
    else { route = 'vpn'; reason = 'all'; }
  }
  else if (isZapretExcluded) reason = 'zapret';
  else if (isDefault) { route = 'vpn'; reason = isEffectiveGeo(host) ? 'geo' : 'base'; }
  else if (!isIpLiteral && !isKnownRu) { route = 'ip'; reason = 'ip'; }

  await ensureTabRoutes();
  const seen = Number.isInteger(tabId) ? tabRoutes.get(tabId) : null;
  const observed = seen && seen.host === host && Date.now() - seen.at < 6 * 3600 * 1000 ? seen : null;

  return {
    success: true, host, route, reason,
    matchedRules,
    matchedBypass,
    isCustomWhitelisted: isCustom,
    isCustomBypassed: isBypassed,
    isDefaultWhitelisted: isDefault,
    isZapretExcluded,
    isAdblockAllowed: matchedAdAllow.length > 0,
    isLocal,
    suggestedRule: isIpLiteral ? host : registrableDomain(host),
    observed
  };
}

async function handleMessage(request, sendResponse) {
  await loadSettings();

  switch (request.action) {
    case 'getStatus': {
      sendResponse({ success: true, data: publicStatus() });
      break;
    }

    case 'completeOnboarding': {
      const p = request.patch || {};
      if (p.mode === 'whitelist' || p.mode === 'all') currentSettings.mode = p.mode;
      if (p.ipsetPreset === 'full' || p.ipsetPreset === 'zapret') currentSettings.ipsetPreset = p.ipsetPreset;
      if (p.uiTheme === 'dark' || p.uiTheme === 'light') currentSettings.uiTheme = p.uiTheme;
      for (const boolKey of ['adblock', 'sponsorBlock', 'bypassRu', 'autoReload', 'webrtcProtect']) {
        if (typeof p[boolKey] === 'boolean') currentSettings[boolKey] = p[boolKey];
      }
      currentSettings.onboardingDone = true;
      await saveSettings();
      await applyProxySettings();
      sendResponse({ success: true, data: publicStatus() });
      break;
    }

    case 'checkHealth': {
      const result = await checkHealth();
      sendResponse({ success: true, health: result, lastProxyError });
      break;
    }

    case 'syncRules': {
      const changed = await syncRemoteRules();
      sendResponse({ success: true, changed, lastUpdated: effectiveUpdatedAt() });
      break;
    }

    case 'getSponsorSegments': {
      if (!currentSettings.enabled || !currentSettings.sponsorBlock) {
        sendResponse({ success: true, segments: [] });
        break;
      }
      const segments = await fetchSponsorSegments(request.videoId);
      sendResponse({ success: true, segments });
      break;
    }

    case 'toggleSiteAdblock': {
      const rawHost = String(request.host || '').trim().toLowerCase();
      if (!rawHost || isIpRule(rawHost)) {
        sendResponse({ success: false, error: 'Недоступно для этого адреса' });
        break;
      }
      const matched = matchingRules(rawHost, currentSettings.adblockAllowlist);
      let allowed;
      const domain = registrableDomain(rawHost);
      if (matched.length) {
        currentSettings.adblockAllowlist = currentSettings.adblockAllowlist.filter((x) => !matched.includes(x));
        allowed = false;
      } else {
        const norm = normalizeRule(domain);
        if (norm.error) { sendResponse({ success: false, error: norm.error }); break; }
        if (!currentSettings.adblockAllowlist.includes(norm.rule)) {
          currentSettings.adblockAllowlist.push(norm.rule);
        }
        allowed = true;
      }
      await saveSettings();
      await applyAdblockPolicy(Boolean(currentSettings.enabled && currentSettings.adblock), currentSettings.adblockAllowlist);
      sendResponse({ success: true, allowed, domain, adblockAllowlist: currentSettings.adblockAllowlist });
      break;
    }

    case 'toggleEnable': {
      if (!currentSettings.server && !currentSettings.enabled) {
        sendResponse({ success: false, error: 'Сначала добавьте сервер или вставьте ключ доступа' });
        break;
      }
      currentSettings.enabled = !currentSettings.enabled;
      await saveSettings();
      await applyProxySettings();
      sendResponse({ success: true, enabled: currentSettings.enabled, health });
      break;
    }

    case 'setMode': {
      if (request.mode !== 'whitelist' && request.mode !== 'all') {
        sendResponse({ success: false, error: 'Неизвестный режим' });
        break;
      }
      currentSettings.mode = request.mode;
      await saveSettings();
      await applyProxySettings();
      sendResponse({ success: true, mode: currentSettings.mode });
      break;
    }

    case 'setIpsetPreset': {
      if (request.preset !== 'full' && request.preset !== 'zapret') {
        sendResponse({ success: false, error: 'Неизвестный список' });
        break;
      }
      currentSettings.ipsetPreset = request.preset;
      await saveSettings();
      await applyProxySettings();
      sendResponse({ success: true, ipsetPreset: currentSettings.ipsetPreset });
      break;
    }

    case 'setSetting': {
      const { key, value } = request;
      if (!['adblock', 'sponsorBlock', 'bypassRu', 'autoReload', 'webrtcProtect'].includes(key)) {
        sendResponse({ success: false, error: 'Неизвестная настройка' });
        break;
      }
      currentSettings[key] = Boolean(value);
      await saveSettings();
      if (key === 'adblock') {
        await applyAdblockPolicy(Boolean(currentSettings.enabled && currentSettings.adblock), currentSettings.adblockAllowlist);
      } else if (key === 'bypassRu' || key === 'webrtcProtect') {
        await applyProxySettings();
      }
      sendResponse({ success: true, [key]: currentSettings[key] });
      break;
    }

    case 'addCustomRule': {
      const input = request.fromSite ? registrableDomain(request.rule) : request.rule;
      const { rule, error } = normalizeRule(input);
      if (error) {
        sendResponse({ success: false, error });
        break;
      }
      const bypassRemoved = matchingRules(rule, currentSettings.customBypass);
      if (bypassRemoved.length || currentSettings.customBypass.includes(rule)) {
        currentSettings.customBypass = currentSettings.customBypass.filter((x) => x !== rule && !bypassRemoved.includes(x));
      }
      const exists = currentSettings.customWhitelist.includes(rule);
      if (!exists) currentSettings.customWhitelist.push(rule);
      await saveSettings();
      await applyProxySettings();
      sendResponse({
        success: true, rule, existed: exists,
        customWhitelist: currentSettings.customWhitelist,
        customBypass: currentSettings.customBypass
      });
      break;
    }

    case 'removeCustomRule': {
      const toRemove = request.host
        ? matchingRules(request.host, currentSettings.customWhitelist)
        : [normalizeRule(request.rule).rule || String(request.rule || '').trim().toLowerCase()];
      currentSettings.customWhitelist = currentSettings.customWhitelist.filter((x) => !toRemove.includes(x));
      await saveSettings();
      await applyProxySettings();
      sendResponse({ success: true, removed: toRemove, customWhitelist: currentSettings.customWhitelist });
      break;
    }

    case 'addBypassRule': {
      const input = request.fromSite ? registrableDomain(request.rule) : request.rule;
      const { rule, error } = normalizeRule(input);
      if (error) {
        sendResponse({ success: false, error });
        break;
      }
      const customRemoved = matchingRules(rule, currentSettings.customWhitelist);
      if (customRemoved.length || currentSettings.customWhitelist.includes(rule)) {
        currentSettings.customWhitelist = currentSettings.customWhitelist.filter((x) => x !== rule && !customRemoved.includes(x));
      }
      const exists = currentSettings.customBypass.includes(rule);
      if (!exists) currentSettings.customBypass.push(rule);
      await saveSettings();
      await applyProxySettings();
      sendResponse({
        success: true, rule, existed: exists,
        customBypass: currentSettings.customBypass,
        customWhitelist: currentSettings.customWhitelist
      });
      break;
    }

    case 'removeBypassRule': {
      const toRemove = request.host
        ? matchingRules(request.host, currentSettings.customBypass)
        : [normalizeRule(request.rule).rule || String(request.rule || '').trim().toLowerCase()];
      currentSettings.customBypass = currentSettings.customBypass.filter((x) => !toRemove.includes(x));
      await saveSettings();
      await applyProxySettings();
      sendResponse({ success: true, removed: toRemove, customBypass: currentSettings.customBypass });
      break;
    }

    case 'checkHostStatus': {
      sendResponse(await hostStatus(request.host, request.tabId));
      break;
    }

    case 'setUiTheme': {
      if (!['dark', 'light'].includes(request.theme)) {
        sendResponse({ success: false, error: 'Неизвестная тема оформления' });
        break;
      }
      currentSettings.uiTheme = request.theme;
      await saveSettings();
      sendResponse({ success: true, uiTheme: currentSettings.uiTheme });
      break;
    }

    case 'setIconTheme': {
      if (!ICON_THEMES.includes(request.theme)) {
        sendResponse({ success: false, error: 'Неизвестная цветовая схема' });
        break;
      }
      currentSettings.iconTheme = request.theme;
      await saveSettings();
      refreshActionState();
      sendResponse({ success: true, iconTheme: request.theme });
      break;
    }

    case 'selectServer': {
      const target = currentSettings.servers.find((x) => x.id === request.serverId);
      if (!target) {
        sendResponse({ success: false, error: 'Сервер не найден' });
        break;
      }
      currentSettings.activeServerId = target.id;
      await saveSettings();
      await applyProxySettings();
      sendResponse({ success: true });
      break;
    }

    case 'removeServer': {
      if (currentSettings.servers.length <= 1) {
        sendResponse({ success: false, error: 'Нельзя удалить единственный сервер' });
        break;
      }
      currentSettings.servers = currentSettings.servers.filter((x) => x.id !== request.serverId);
      await saveSettings();
      await applyProxySettings();
      sendResponse({ success: true });
      break;
    }

    case 'exportKey': {
      try {
        const key = createAccessKey(currentSettings);
        sendResponse({ success: true, key });
      } catch (err) {
        sendResponse({ success: false, error: err.message || 'Не удалось создать ключ' });
      }
      break;
    }

    case 'importKey': {
      const parsed = parseAccessKey(request.key);
      if (parsed.error) {
        sendResponse({ success: false, error: parsed.error });
        break;
      }
      const primary = parsed.servers.find((s) => s.host === parsed.activeHost) || parsed.servers[0];
      const reachable = (await probeTls(primary.httpsDomain, primary.httpsPort, 5500)) ||
        (primary.backupPort ? await probeTls(primary.httpsDomain, primary.backupPort, 5500) : false);
      if (!reachable) {
        sendResponse({
          success: false,
          error: `Сервер ${primary.host} из ключа сейчас не отвечает. Проверьте интернет или уточните ключ у друга.`
        });
        break;
      }
      for (const srv of parsed.servers) {
        if (!srv.countryCode) {
          const code = await lookupCountry(srv.host);
          if (code) {
            srv.countryCode = code;
            srv.countryName = countryNameRu(code);
          }
        }
      }
      let activeAdded = null;
      await mutate((s) => {
        for (const incoming of parsed.servers) {
          const existing = s.servers.find((x) => x.host === incoming.host && Number(x.httpsPort || 8443) === incoming.httpsPort);
          if (existing) {
            existing.username = incoming.username;
            existing.password = incoming.password;
            existing.httpsDomain = incoming.httpsDomain;
            existing.backupPort = incoming.backupPort;
            if (incoming.name) existing.name = incoming.name;
            if (incoming.countryCode) {
              existing.countryCode = incoming.countryCode;
              existing.countryName = incoming.countryName;
            }
            if (incoming.host === primary.host) activeAdded = existing;
          } else {
            const record = {
              id: newServerId(),
              ...incoming,
              geoCheckedAt: Date.now(),
              addedAt: Date.now()
            };
            s.servers.push(record);
            if (incoming.host === primary.host) activeAdded = record;
          }
        }
        if (activeAdded) s.activeServerId = activeAdded.id;
        s.enabled = true;
      });
      authFailures.clear();
      await applyProxySettings();
      syncRemoteRules().catch(() => {});
      sendResponse({ success: true, count: parsed.servers.length, server: activeAdded });
      break;
    }

    case 'getUninstallCommand': {
      const target = currentSettings.servers.find((x) => x.id === request.serverId);
      if (!target) {
        sendResponse({ success: false, error: 'Сервер не найден' });
        break;
      }
      const command = await buildServerCommand('server/uninstall.sh', { SSJ_IP: target.host });
      sendResponse({ success: true, command });
      break;
    }

    case 'beginInstall': {
      const host = String(request.host || '').trim();
      if (!isValidIPv4(host)) {
        sendResponse({ success: false, error: 'Введите IPv4-адрес сервера, например 203.0.113.10' });
        break;
      }
      if (isPrivateIPv4(host)) {
        sendResponse({ success: false, error: 'Нужен публичный IP-адрес сервера' });
        break;
      }
      if (currentSettings.servers.some((x) => x.host === host)) {
        sendResponse({ success: false, error: 'Этот сервер уже добавлен' });
        break;
      }
      if (!currentSettings.pending || currentSettings.pending.host !== host) {
        const username = 'ssj';
        const password = randomAlnum(18);
        const command = await buildServerCommand('server/install.sh', {
          SSJ_IP: host, SSJ_USER: username, SSJ_PASS: password
        });
        currentSettings.pending = {
          id: newServerId(), host, name: cleanName(request.name), username, password, command, createdAt: Date.now()
        };
      } else {
        currentSettings.pending.name = cleanName(request.name);
      }
      await saveSettings();
      armPendingAlarm();
      sendResponse({ success: true, pending: currentSettings.pending });
      break;
    }

    case 'cancelPending': {
      currentSettings.pending = null;
      await saveSettings();
      await chrome.alarms.clear(PENDING_ALARM);
      sendResponse({ success: true });
      break;
    }

    case 'checkPending': {
      const result = await checkPendingNow();
      sendResponse({ success: true, ...result });
      break;
    }

    case 'probeServer': {
      const port = clampPort(request.port, 8443);
      const domain = String(request.domain || '');
      if (!/^[0-9a-z.-]+\.(sslip|nip)\.io$/i.test(domain)) {
        sendResponse({ success: false, error: 'Bad domain' });
        break;
      }
      sendResponse({ success: true, alive: await probeTls(domain, port, 4500) });
      break;
    }

    case 'ensureGeo': {
      const changed = await ensureGeo();
      sendResponse({ success: true, changed });
      break;
    }

    case 'addServerManual': {
      const r = request.payload || {};
      const host = String(r.host || '').trim();
      const username = String(r.username || '').trim();
      const password = String(r.password || '').trim();
      const editId = r.editId || '';
      if (!isValidIPv4(host)) {
        sendResponse({ success: false, error: 'Введите IPv4-адрес сервера' });
        break;
      }
      if (!username || !password) {
        sendResponse({ success: false, error: 'Укажите логин и пароль прокси' });
        break;
      }
      const httpsPort = clampPort(r.httpsPort, 8443);
      const existing = editId ? currentSettings.servers.find((x) => x.id === editId) : null;
      if (editId && !existing) {
        sendResponse({ success: false, error: 'Сервер не найден' });
        break;
      }
      if (currentSettings.servers.some((x) => x.host === host && x.id !== editId)) {
        sendResponse({ success: false, error: 'Сервер с таким IP уже добавлен' });
        break;
      }
      let httpsDomain = existing && existing.host === host && existing.httpsDomain
        ? existing.httpsDomain
        : `${host}.sslip.io`;
      if (!existing || existing.host !== host || Number(existing.httpsPort) !== httpsPort) {
        const detected = await detectWorkingDomain(host, httpsPort, 6000);
        if (!detected) {
          sendResponse({
            success: false,
            error: `Нет ответа на https://${host}.sslip.io:${httpsPort}. Проверьте IP, порт и что прокси запущен.`
          });
          break;
        }
        httpsDomain = detected;
      }
      let code = /^[A-Za-z]{2}$/.test(r.countryCode || '') ? String(r.countryCode).toUpperCase() : '';
      if (!code) {
        code = (existing && existing.host === host && existing.countryCode) || (await lookupCountry(host));
      }
      const name = cleanName(r.name) || (existing && existing.name) || defaultServerName(code, host);
      const saved = await mutate((s) => {
        const record = {
          id: existing ? existing.id : newServerId(),
          host,
          httpsDomain,
          httpsPort,
          backupPort: httpsPort === 8443 ? 2053 : 0,
          feedPort: 2083,
          name,
          username,
          password,
          countryCode: code,
          countryName: code ? countryNameRu(code) : '',
          geoCheckedAt: Date.now(),
          addedAt: (existing && existing.addedAt) || Date.now()
        };
        const idx = s.servers.findIndex((x) => x.id === record.id);
        if (idx >= 0) s.servers[idx] = record;
        else s.servers.push(record);
        if (!s.activeServerId || !s.servers.some((x) => x.id === s.activeServerId)) s.activeServerId = record.id;
        return record;
      });
      authFailures.delete(saved.id);
      await applyProxySettings();
      syncRemoteRules().catch(() => {});
      sendResponse({ success: true, server: saved });
      break;
    }

    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }
}
