import { defaultRules } from './default_rules.js';

const domainSets = new WeakMap();
export function matchesDomain(host, domains) {
  host = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  let set = domainSets.get(domains);
  if (!set) {
    set = new Set(domains.map((domain) => String(domain).toLowerCase().replace(/^(\*\.|\.)/, '').replace(/\.$/, '')));
    domainSets.set(domains, set);
  }
  while (host) {
    if (set.has(host)) return true;
    const dot = host.indexOf('.');
    if (dot === -1) break;
    host = host.slice(dot + 1);
  }
  return false;
}
export const isZapretDomain = (host) => matchesDomain(host, defaultRules.zapretDomains);
export const isGeoDomain = (host) => matchesDomain(host, defaultRules.geoDomains);
export function includedDomains(preset) {
  return defaultRules.domains.filter((domain) => !(preset === 'zapret' && isZapretDomain(domain)));
}
export function ipv4Value(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split('.').map(Number);
  return parts.some((part) => part > 255) ? null : parts.reduce((value, part) => value * 256 + part, 0);
}
const decodedRanges = new Map();
export function ipInPreset(host, preset) {
  const value = ipv4Value(host);
  if (value === null) return false;
  const key = preset === 'zapret' ? 'zapret' : 'full';
  let ranges = decodedRanges.get(key);
  if (!ranges) {
    ranges = [];
    const deltas = key === 'zapret' ? defaultRules.zapretDeltas : defaultRules.deltas;
    let previous = 0;
    for (let index = 0; index < deltas.length; index += 2) {
      const start = previous + deltas[index];
      previous = start + deltas[index + 1];
      ranges.push([start, previous]);
    }
    decodedRanges.set(key, ranges);
  }
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (value < ranges[middle][0]) high = middle - 1;
    else if (value > ranges[middle][1]) low = middle + 1;
    else return true;
  }
  return false;
}
export function matchesCustomIp(host, rules) {
  const value = ipv4Value(host);
  if (value === null) return false;
  return rules.some((rule) => {
    const [ip, bits] = rule.split('/');
    const start = ipv4Value(ip), prefix = bits === undefined ? 32 : Number(bits);
    if (start === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const size = 2 ** (32 - prefix);
    return Math.floor(value / size) === Math.floor(start / size);
  });
}

// ---------------------------------------------------------------------------
// User rules: one canonical form for every rule, so a saved rule always works.
//   domain      example.com        (covers every subdomain)
//   IPv4        1.2.3.4
//   IPv4 CIDR   1.2.3.0/24
//   IPv6        2001:db8::1        (exact address)
// ---------------------------------------------------------------------------
export function isIPv6(value) {
  if (!/^[0-9a-f:.]+$/i.test(value) || !value.includes(':')) return false;
  try { return new URL(`http://[${value}]/`).hostname.length > 2; } catch (_) { return false; }
}

function canonicalIPv6(value) {
  return new URL(`http://[${value}]/`).hostname.replace(/^\[|\]$/g, '');
}

export function isIpRule(rule) {
  return ipv4Value(String(rule).split('/')[0]) !== null || isIPv6(rule);
}

// Returns { rule } or { error } with a message for the user.
export function normalizeRule(input) {
  let value = String(input || '').trim().toLowerCase();
  if (!value) return { error: 'Введите домен или IP' };
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');           // https://
  value = value.replace(/^[^/@]*@/, '');                             // user:pass@
  const cidrInput = /^(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})$/.exec(value);
  value = cidrInput ? cidrInput[1] : value.split(/[/?#\s]/)[0];     // path, query
  if (value.startsWith('[')) {                                       // [IPv6]:port
    const end = value.indexOf(']');
    value = end > 0 ? value.slice(1, end) : value;
  } else if (!isIPv6(value)) {
    value = value.replace(/:\d*$/, '');                              // :port
  }
  value = value.replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');

  const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value);
  if (cidr) {
    const bits = Number(cidr[2]);
    if (ipv4Value(cidr[1]) === null || bits > 32) return { error: 'Неверная подсеть. Пример: 1.2.3.0/24' };
    if (bits < 8) return { error: 'Слишком большая подсеть: укажите маску от /8 до /32' };
    return { rule: `${cidr[1]}/${bits}` };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return ipv4Value(value) === null ? { error: 'Неверный IP-адрес' } : { rule: value };
  }
  if (isIPv6(value)) return { rule: canonicalIPv6(value) };

  let host;
  try { host = new URL(`http://${value}/`).hostname; } catch (_) { host = ''; }  // IDN → punycode
  if (!host || !host.includes('.') || host.length > 253 ||
      !host.split('.').every((label) => /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label)) ||
      /^\d+$/.test(host.split('.').pop())) {
    return { error: 'Неверный адрес. Пример: notion.so или 1.2.3.4' };
  }
  return { rule: host };
}

// Second-level suffixes where the "main" domain has three labels (site.co.uk, site.com.ru).
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp',
  'or.jp', 'co.kr', 'co.il', 'co.in', 'co.za', 'com.br', 'com.ar', 'com.mx', 'com.tr', 'com.cn', 'com.hk',
  'com.tw', 'com.sg', 'com.ua', 'org.ua', 'net.ua', 'in.ua', 'kiev.ua', 'com.ru', 'net.ru', 'org.ru',
  'pp.ru', 'msk.ru', 'spb.ru', 'com.kz', 'org.kz', 'com.by', 'co.id', 'com.pl', 'com.es', 'com.de',
  'github.io', 'gitlab.io', 'pages.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'appspot.com',
  'blogspot.com', 'web.app', 'firebaseapp.com', 'workers.dev', 'azurewebsites.net', 'cloudfront.net'
]);

// www.youtube.com → youtube.com, so m./music. subdomains follow the same rule.
export function registrableDomain(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (isIpRule(host) || !host.includes('.')) return host;
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const take = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join('.');
}

// Every saved rule that currently applies to this host (exact, parent domain, IP or subnet).
export function matchingRules(host, rules) {
  host = String(host || '').trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host) return [];
  return (rules || []).filter((rule) => {
    if (isIPv6(rule)) return isIPv6(host) && canonicalIPv6(host) === rule;
    if (isIpRule(rule)) return matchesCustomIp(host, [rule]);
    return host === rule || host.endsWith(`.${rule}`);
  });
}
