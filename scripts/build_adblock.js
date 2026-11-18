/**
 * Build uBO-Lite-grade MV3 declarativeNetRequest AdBlock ruleset (`data/adblock_rules.json`)
 * combining:
 *   1. AdGuard Russian Filter (RU AdList + AdGuard RU URL & domain rules)
 *   2. AdGuard Base Filter (EasyList + AdGuard Global URL & domain rules)
 *   3. AdGuard DNS Filter + Peter Lowe's AdServers (24,000+ root ad/tracker domain trees)
 *
 * Node.js 20+; zero external dependencies.
 * Run: node scripts/build_adblock.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { domainToASCII } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

const SOURCES = {
  peterLowe: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&mimetype=plaintext',
  adguardDns: 'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt',
  adguardRu: 'https://filters.adtidy.org/extension/chromium/filters/1.txt',
  adguardBase: 'https://filters.adtidy.org/extension/chromium/filters/2.txt'
};

// Core domains never blocked as bare root domains (specific ad paths like ||yandex.ru/ads/ still work!).
const PROTECTED_ROOTS = new Set([
  'google.com', 'www.google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com',
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com', 'ggpht.com',
  'cloudflare.com', 'cdnjs.cloudflare.com', 'challenges.cloudflare.com', 'cp.cloudflare.com',
  'jsdelivr.net', 'unpkg.com', 'fastly.net', 'akamaized.net', 'cloudfront.net',
  'recaptcha.net', 'hcaptcha.com',
  'yandex.ru', 'ya.ru', 'yandex.net', 'yastatic.net', 'yandex.com', 'kinopoisk.ru', 'dzen.ru',
  'vk.com', 'vk.ru', 'userapi.com', 'vkuser.net', 'vkuseraudio.net', 'vkuservideo.net', 'ok.ru', 'mycdn.me',
  'mail.ru', 'imgsmail.ru',
  'gosuslugi.ru', 'mos.ru', 'nalog.ru', 'sberbank.ru', 'tbank.ru', 'tinkoff.ru', 'alfabank.ru', 'vtb.ru',
  'ozon.ru', 'ozone.ru', 'ozonusercontent.com', 'wildberries.ru', 'wb.ru', 'wbbasket.ru', 'wbstatic.net', 'avito.ru', 'avito.st',
  'telegram.org', 't.me', 'web.telegram.org', 'whatsapp.com', 'whatsapp.net', 'signal.org',
  'discord.com', 'discordapp.com', 'discordapp.net', 'discord.gg',
  'openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com', 'sora.com',
  'claude.ai', 'anthropic.com', 'gemini.google.com', 'aistudio.google.com', 'notebooklm.google.com', 'cursor.com',
  'github.com', 'githubusercontent.com', 'githubassets.com', 'gitlab.com',
  'apple.com', 'icloud.com', 'mzstatic.com', 'microsoft.com', 'live.com', 'office.com', 'bing.com',
  'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'epicgames.com', 'roblox.com', 'rbxcdn.com',
  'spotify.com', 'scdn.co', 'spotifycdn.com', 'netflix.com', 'nflxvideo.net', 'twitch.tv',
  'instagram.com', 'cdninstagram.com', 'facebook.com', 'fbcdn.net', 'threads.net', 'threads.com',
  'x.com', 'twitter.com', 'twimg.com', 'tiktok.com', 'tiktokcdn.com',
  'wikipedia.org', 'wikimedia.org', 'reddit.com', 'redd.it', 'redditmedia.com', 'redditstatic.com',
  'notion.so', 'notion.com', 'figma.com', 'canva.com', 'miro.com', 'trello.com', 'atlassian.com', 'slack.com',
  'sponsor.ajay.app', 'sslip.io', 'nip.io', 'ipify.org', 'ipwho.is', 'country.is', 'geojs.io'
]);

const MUST_BLOCK_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', '2mdn.net',
  'an.yandex.ru', 'yandexadexchange.net', 'adfox.ru', 'awaps.yandex.net', 'bs.yandex.ru',
  'ads.vk.com', 'ad.mail.ru', 'r.mail.ru', 'top-fwz1.mail.ru', 'target.my.com', 'trk.mail.ru',
  'adriver.ru', 'smi2.ru', 'smi2.net', '24smi.org', '24smi.info', 'lentainform.com',
  'mgid.com', 'marketgid.com', 'directadvert.ru', 'relap.io', 'buzzoola.com', 'betweenexchange.com',
  'adhigh.net', 'otm-r.com', 'soloway.ru', 'kavanga.ru', 'hybrid.ai', 'aidata.io', 'rutarget.ru',
  'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com',
  'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'teads.tv', 'smartadserver.com',
  'amazon-adsystem.com', 'moatads.com', 'adsrvr.org', 'bidswitch.net', 'sharethrough.com',
  'triplelift.com', 'revcontent.com', 'adroll.com', 'quantserve.com', 'scorecardresearch.com',
  'propellerads.com', 'adsterra.com', 'clickadu.com', 'hilltopads.net', 'evadav.com',
  'popads.net', 'popcash.net', 'exoclick.com', 'juicyads.com', 'trafficjunky.net'
];

const SUBRESOURCE_TYPES = [
  'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'
];

const TYPE_MAP = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  media: 'media',
  font: 'font',
  ping: 'ping',
  beacon: 'ping',
  websocket: 'websocket',
  object: 'object',
  other: 'other'
};

function cleanAsciiDomain(raw) {
  const trimmed = String(raw || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!trimmed || !trimmed.includes('.') || trimmed.length > 253) return '';
  let ascii = '';
  try { ascii = domainToASCII(trimmed); } catch (_) { return ''; }
  if (!ascii || ascii.length > 253) return '';
  if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(ascii)) return '';
  if (/^\d+$/.test(ascii.split('.').pop())) return '';
  return ascii;
}

function hasParentInSet(domain, set) {
  let dot = domain.indexOf('.');
  while (dot !== -1) {
    if (set.has(domain.slice(dot + 1))) return true;
    dot = domain.indexOf('.', dot + 1);
  }
  return false;
}

function isYoutubeOrProtectedUrl(pattern) {
  const lower = pattern.toLowerCase();
  if (lower.includes('youtube.') || lower.includes('googlevideo.') || lower.includes('ytimg.')) return true;
  const hostMatch = /^\|\|([a-z0-9.-]+)\^?$/i.exec(lower);
  if (hostMatch && PROTECTED_ROOTS.has(hostMatch[1])) return true;
  return false;
}

// Parse an ABP / AdGuard network URL filter rule into an MV3 DNR condition (or null if unsupported).
function parseUrlRule(rawLine, blockedDomainsSet) {
  let line = rawLine.trim();
  if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[')) return null;
  // Skip cosmetic / scriptlet / HTML rules
  if (line.includes('##') || line.includes('#@#') || line.includes('#?#') || line.includes('#$#') || line.includes('$$')) return null;

  let isAllow = false;
  if (line.startsWith('@@')) {
    isAllow = true;
    line = line.slice(2);
  }

  if (line.startsWith('$')) return null;

  let pattern = line;
  let modStr = '';
  const dollarIdx = line.indexOf('$');
  if (dollarIdx >= 0) {
    pattern = line.slice(0, dollarIdx);
    modStr = line.slice(dollarIdx + 1);
  }

  pattern = pattern.replace(/\*\*+/g, '*');
  if (!pattern || pattern.length < 5 || pattern.length > 160) return null;
  if (pattern.startsWith('/') && pattern.endsWith('/')) return null; // skip raw regexes
  if (!/^[\x21-\x7E]+$/.test(pattern)) return null; // strict printable ASCII without spaces
  if (pattern.startsWith('||*') || pattern === '||' || pattern === '|' || pattern === '^') return null;
  if (pattern.replace(/^\|\|?/, '').replace(/\|$/, '').includes('|')) return null;
  if (pattern.includes('$')) return null;
  if (isYoutubeOrProtectedUrl(pattern)) return null;

  // Skip pure ||domain^ rules if already handled by requestDomains map
  const pureDom = /^\|\|([a-z0-9.-]+)\^$/i.exec(pattern);
  if (pureDom && !modStr) {
    const d = cleanAsciiDomain(pureDom[1]);
    if (d && (blockedDomainsSet.has(d) || hasParentInSet(d, blockedDomainsSet))) return null;
  }

  let domainType = null;
  const includeTypes = new Set();
  const excludeTypes = new Set();
  const initiatorDomains = [];
  const excludedInitiatorDomains = [];

  if (modStr) {
    for (const rawMod of modStr.split(',')) {
      const m = rawMod.trim().toLowerCase();
      if (!m || m === 'important') continue;
      if (m === 'third-party' || m === '3p') { domainType = 'thirdParty'; continue; }
      if (m === '~third-party' || m === '1p' || m === 'first-party') { domainType = 'firstParty'; continue; }
      if (m.startsWith('domain=')) {
        const list = m.slice(7).split('|');
        for (const item of list) {
          if (!item) continue;
          const neg = item.startsWith('~');
          const d = cleanAsciiDomain(neg ? item.slice(1) : item);
          if (!d) return null;
          if (neg) excludedInitiatorDomains.push(d);
          else initiatorDomains.push(d);
        }
        continue;
      }
      if (m.startsWith('~')) {
        const mapped = TYPE_MAP[m.slice(1)];
        if (!mapped) return null;
        excludeTypes.add(mapped);
        continue;
      }
      const mapped = TYPE_MAP[m];
      if (!mapped) return null; // unsupported modifier ($csp, $removeparam, $redirect, $popup, $badfilter, etc.)
      includeTypes.add(mapped);
    }
  }

  let resourceTypes = includeTypes.size
    ? [...includeTypes]
    : SUBRESOURCE_TYPES.filter((t) => !excludeTypes.has(t));
  resourceTypes = resourceTypes.filter((t) => t !== 'main_frame');
  if (!resourceTypes.length) return null;

  const condition = { urlFilter: pattern, resourceTypes };
  if (domainType) condition.domainType = domainType;
  if (initiatorDomains.length) condition.initiatorDomains = [...new Set(initiatorDomains)];
  if (excludedInitiatorDomains.length) condition.excludedInitiatorDomains = [...new Set(excludedInitiatorDomains)];

  return { isAllow, condition };
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return await res.text();
}

function scoreDomain(d, peterSet) {
  if (peterSet.has(d)) return 100;
  if (/\.(ru|su|xn--p1ai|by|kz)$/.test(d)) return 95;
  if (/(^|\.)(ads?|adv|adserver|adservice|adsystem|adform|adfox|adriver|adtech|banner|banners|telemetry|metrics|tracker|tracking|analytics|click|popunder|popads|push|teaser|casino|bet|slots)/i.test(d)) return 90;
  if (d.length <= 24 && /\.(com|net|org|io|co|me|tv|info|biz)$/.test(d)) return 75;
  if (d.length <= 32) return 60;
  return 20;
}

async function main() {
  console.log('[SSJ AdBlock] Downloading AdGuard RU, AdGuard Base, AdGuard DNS & Peter Lowe...');
  const [peterText, adguardDnsText, adguardRuText, adguardBaseText] = await Promise.all([
    fetchText(SOURCES.peterLowe),
    fetchText(SOURCES.adguardDns),
    fetchText(SOURCES.adguardRu),
    fetchText(SOURCES.adguardBase)
  ]);

  const rawBlocked = new Set();
  const rawExceptions = new Set();
  const peterSet = new Set();

  for (const d of MUST_BLOCK_DOMAINS) {
    const clean = cleanAsciiDomain(d);
    if (clean && !PROTECTED_ROOTS.has(clean)) {
      rawBlocked.add(clean);
      peterSet.add(clean);
    }
  }

  for (const line of peterText.split(/\r?\n/)) {
    const t = line.split('#')[0].trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    const clean = cleanAsciiDomain(parts[parts.length - 1]);
    if (clean && !PROTECTED_ROOTS.has(clean)) {
      rawBlocked.add(clean);
      peterSet.add(clean);
    }
  }

  for (const line of adguardDnsText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('!') || t.startsWith('#') || t.includes('$badfilter')) continue;
    const excMatch = /^@@\|\|([a-z0-9._-]+)\^/i.exec(t);
    if (excMatch) {
      const clean = cleanAsciiDomain(excMatch[1]);
      if (clean) rawExceptions.add(clean);
      continue;
    }
    const blkMatch = /^\|\|([a-z0-9._-]+)\^(\$(?:important|third-party|all))?$/i.exec(t);
    if (blkMatch) {
      const clean = cleanAsciiDomain(blkMatch[1]);
      if (clean && !PROTECTED_ROOTS.has(clean)) rawBlocked.add(clean);
      continue;
    }
    const hostMatch = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9._-]+)$/i.exec(t);
    if (hostMatch) {
      const clean = cleanAsciiDomain(hostMatch[1]);
      if (clean && !PROTECTED_ROOTS.has(clean)) rawBlocked.add(clean);
    }
  }

  for (const exc of rawExceptions) rawBlocked.delete(exc);
  for (const safe of PROTECTED_ROOTS) rawBlocked.delete(safe);

  const prunedBlocked = [];
  for (const d of rawBlocked) {
    if (!hasParentInSet(d, rawBlocked)) prunedBlocked.push(d);
  }
  const prunedSet = new Set(prunedBlocked);
  const prunedExceptions = [];
  for (const exc of rawExceptions) {
    if (hasParentInSet(exc, prunedSet)) prunedExceptions.push(exc);
  }

  prunedBlocked.sort((a, b) => scoreDomain(b, peterSet) - scoreDomain(a, peterSet) || a.localeCompare(b));
  const MAX_EXT_DOMAINS = 24000;
  const selectedDomains = prunedBlocked.slice(0, MAX_EXT_DOMAINS).sort();
  const selectedSet = new Set(selectedDomains);
  const activeExceptions = prunedExceptions.filter((exc) => hasParentInSet(exc, selectedSet)).sort();

  // Extract surgical URL-pattern rules from AdGuard Russian (priority!) + AdGuard Base
  const seenUrlKeys = new Set();
  const urlBlockRules = [];
  const urlAllowRules = [];
  const MAX_URL_BLOCK_RULES = 3200;
  const MAX_URL_ALLOW_RULES = 600;

  for (const [sourceName, text] of [['ru', adguardRuText], ['base', adguardBaseText]]) {
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseUrlRule(line, selectedSet);
      if (!parsed) continue;
      const key = `${parsed.isAllow ? 'A' : 'B'}:${JSON.stringify(parsed.condition)}`;
      if (seenUrlKeys.has(key)) continue;
      seenUrlKeys.add(key);

      if (parsed.isAllow) {
        if (urlAllowRules.length < MAX_URL_ALLOW_RULES) urlAllowRules.push(parsed.condition);
      } else {
        // Prioritize Russian rules first, then general third-party / ad path rules
        if (sourceName === 'base' && !parsed.condition.domainType && !parsed.condition.initiatorDomains) continue;
        if (urlBlockRules.length < MAX_URL_BLOCK_RULES) urlBlockRules.push(parsed.condition);
      }
    }
  }

  const rules = [];
  let id = 1;
  const CHUNK = 60;

  // 1. Packed root ad/tracker domain rules
  for (let i = 0; i < selectedDomains.length; i += CHUNK) {
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'block' },
      condition: {
        requestDomains: selectedDomains.slice(i, i + CHUNK),
        resourceTypes: SUBRESOURCE_TYPES
      }
    });
  }

  // 2. Surgical URL-path & script rules (AdGuard RU + AdGuard Base)
  for (const condition of urlBlockRules) {
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'block' },
      condition
    });
  }

  // 3. Domain & URL allowlist exceptions (priority: 2)
  for (let i = 0; i < activeExceptions.length; i += CHUNK) {
    rules.push({
      id: id++,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        requestDomains: activeExceptions.slice(i, i + CHUNK)
      }
    });
  }
  for (const condition of urlAllowRules) {
    rules.push({
      id: id++,
      priority: 2,
      action: { type: 'allow' },
      condition
    });
  }

  const json = JSON.stringify(rules);
  if (!/^[\x00-\x7F]*$/.test(json)) {
    throw new Error('Generated adblock_rules.json contains non-ASCII characters!');
  }

  const outPath = path.join(ROOT, 'data/adblock_rules.json');
  fs.writeFileSync(outPath + '.tmp', json + '\n');
  fs.renameSync(outPath + '.tmp', outPath);

  console.log(`[SSJ AdBlock] Packed ${selectedDomains.length} root domains + ${urlBlockRules.length} URL filters + ${activeExceptions.length + urlAllowRules.length} allow rules`);
  console.log(`[SSJ AdBlock] Total DNR rules: ${rules.length} / 30000 (${(Buffer.byteLength(json) / 1024).toFixed(1)} KB)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[SSJ AdBlock] Failed:', err.message);
    process.exitCode = 1;
  });
}
