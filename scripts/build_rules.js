/** Build RKN + community + service geoblocks. Node.js 20+; no dependencies.
 * Online: node scripts/build_rules.js
 * Rebuild collected inputs: node scripts/build_rules.js --offline <directory>
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { domainToASCII } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const POLICY = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/rule_policy.json'), 'utf8'));
const RESOLVERS = ['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query'];
const NON_PUBLIC = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '198.18.0.0/15',
  '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3'];

function ipToInt(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`Invalid IPv4: ${ip}`);
  const octets = ip.split('.').map(Number);
  if (octets.some((octet) => octet > 255)) throw new Error(`Invalid IPv4: ${ip}`);
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}
function intToIp(value) { return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.'); }
function cidrToRange(cidr) {
  const parts = cidr.split('/');
  const prefix = parts.length === 1 ? 32 : Number(parts[1]);
  if (parts.length > 2 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32 || parts[1] === '') throw new Error(`Invalid prefix: ${cidr}`);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ipToInt(parts[0]) / size) * size;
  return [start, start + size - 1];
}
function mergeRanges(ranges) {
  const sorted = ranges.map((range) => [...range]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}
function subtractRanges(ranges, exclusions) {
  const input = mergeRanges(ranges), cuts = mergeRanges(exclusions), result = [];
  let firstCut = 0;
  for (const [start, end] of input) {
    let cursor = start;
    while (firstCut < cuts.length && cuts[firstCut][1] < start) firstCut++;
    for (let index = firstCut; index < cuts.length && cuts[index][0] <= end; index++) {
      const [cutStart, cutEnd] = cuts[index];
      if (cutStart > cursor) result.push([cursor, Math.min(end, cutStart - 1)]);
      cursor = Math.max(cursor, cutEnd + 1);
      if (cursor > end) break;
    }
    if (cursor <= end) result.push([cursor, end]);
  }
  return result;
}
function encodeRanges(ranges) {
  let previous = 0;
  return ranges.flatMap(([start, end]) => {
    const pair = [start - previous, end - start]; previous = end; return pair;
  });
}
function rangesToCidrs(ranges) {
  const result = [];
  for (const [start, end] of ranges) {
    let cursor = start;
    while (cursor <= end) {
      const alignment = cursor === 0 ? 2 ** 32 : (cursor & -cursor) >>> 0;
      const size = Math.min(alignment, 2 ** Math.floor(Math.log2(end - cursor + 1)));
      result.push(`${intToIp(cursor)}/${32 - Math.log2(size)}`); cursor += size;
    }
  }
  return result;
}
function parseDomains(text) {
  const domains = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.split('#')[0].trim().toLowerCase().replace(/^(\*\.|\.)/, '').replace(/\.$/, '');
    if (!raw) continue;
    const domain = domainToASCII(raw);
    // A bare TLD is deliberately rejected: it must not proxy an entire country.
    if (domain && domain.includes('.') && domain.length <= 253 && /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(domain)) domains.push(domain);
  }
  return [...new Set(domains)].sort();
}
function parseRanges(text) {
  return text.split(/\r?\n/).map((line) => line.split('#')[0].trim()).filter(Boolean).map((line) => {
    if (Number(line.split('/')[1] ?? 32) < 8) throw new Error(`Unexpected broad network: ${line}`);
    return cidrToRange(line);
  });
}
async function fetchText(url) {
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (!text.trim() || text.length > 10 * 1024 * 1024 || /^\s*</.test(text)) throw new Error('Invalid list response');
      return text;
    } catch (error) { failure = error; }
  }
  throw new Error(`${url}: ${failure.message}`);
}
async function resolveGeoblocks(domains) {
  const records = Object.fromEntries(domains.map((domain) => [domain, new Set()]));
  const jobs = domains.flatMap((domain) => RESOLVERS.map((resolver) => ({ domain, resolver })));
  const errors = [], nonPublic = NON_PUBLIC.map(cidrToRange);
  let next = 0, finished = 0;
  async function worker() {
    while (next < jobs.length) {
      const { domain, resolver } = jobs[next++];
      try {
        const response = await fetch(`${resolver}?name=${encodeURIComponent(domain)}&type=A`, {
          headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (![0, 3].includes(data.Status)) throw new Error(`DNS status ${data.Status}`);
        for (const answer of data.Answer || []) {
          if (answer.type !== 1) continue;
          const value = ipToInt(answer.data);
          if (!nonPublic.some(([start, end]) => value >= start && value <= end)) records[domain].add(answer.data);
        }
      } catch (error) { errors.push({ domain, resolver, error: error.message }); }
      if (++finished % 200 === 0) console.log(`[SSJ VPN] DNS ${finished}/${jobs.length}`);
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));
  return { updatedAt: new Date().toISOString(), resolvers: RESOLVERS,
    records: Object.fromEntries(Object.entries(records).map(([domain, values]) => [domain, [...values].sort()])), errors };
}
function geoblockDomains(inputs) {
  return [...new Set([...parseDomains(inputs['geoblock.lst']), ...parseDomains(inputs['no-russia-hosts.txt']),
    ...parseDomains(inputs['google-ai.lst']), ...POLICY.geminiDomains])].sort();
}
function zapretNetworkRanges(inputs) {
  const cloudflare = JSON.parse(inputs['cloudflare-prefixes.json']).result?.ipv4_cidrs || [];
  const google = (JSON.parse(inputs['google-prefixes.json']).prefixes || []).map((entry) => entry.ipv4Prefix).filter(Boolean);
  const cloud = (JSON.parse(inputs['google-cloud-prefixes.json']).prefixes || []).map((entry) => entry.ipv4Prefix).filter(Boolean);
  const discord = parseRanges(inputs['discord-v4.lst']);
  if (cloudflare.length < 10 || google.length < 50 || cloud.length < 100 || discord.length < 2) {
    throw new Error('Incomplete Zapret network source; previous database kept');
  }
  // Official Google guidance: goog.json minus cloud.json yields service/API ranges,
  // without treating every Google Cloud customer's VM as a YouTube server.
  const googleServices = subtractRanges(google.map(cidrToRange), cloud.map(cidrToRange));
  return mergeRanges([...POLICY.zapretCidrs.map(cidrToRange), ...cloudflare.map(cidrToRange), ...googleServices, ...discord]);
}
function compileRules(inputs, snapshot, now = new Date().toISOString()) {
  for (const [name, minimum] of Object.entries({ 'community-domains.lst': 50, 'inside-domains.lst': 100,
    'geoblock.lst': 100, 'no-russia-hosts.txt': 100, 'google-ai.lst': 3, 'youtube.lst': 3, 'discord.lst': 3 })) {
    if (parseDomains(inputs[name]).length < minimum) throw new Error(`Incomplete source ${name}; previous database kept`);
  }
  const rkn = parseRanges(inputs['rkn.lst']), community = parseRanges(inputs['community.lst']);
  const geoDomains = geoblockDomains(inputs);
  if (rkn.length < 1000 || community.length < 50 || geoDomains.length < 100) throw new Error('An upstream list is incomplete; previous database kept');
  const resolvedDomains = geoDomains.filter((domain) => snapshot.records[domain]?.length);
  if (resolvedDomains.length < Math.max(100, geoDomains.length * 0.6)) throw new Error('Too few valid DNS answers; previous database kept');
  const geoRanges = resolvedDomains.flatMap((domain) => snapshot.records[domain].map(cidrToRange));
  const full = subtractRanges([...rkn, ...community, ...POLICY.telegramCidrs.map(cidrToRange), ...geoRanges], NON_PUBLIC.map(cidrToRange));
  // True interval subtraction also handles partial CIDR overlaps.
  const zapretExclusions = zapretNetworkRanges(inputs);
  const zapret = subtractRanges(full, zapretExclusions);
  const zapretDomains = [...new Set([...POLICY.zapretDomains, ...parseDomains(inputs['youtube.lst']), ...parseDomains(inputs['discord.lst'])])].sort();
  const domains = [...new Set([...parseDomains(inputs['community-domains.lst']), ...parseDomains(inputs['inside-domains.lst']),
    ...POLICY.extraDomains, ...geoDomains, ...zapretDomains])].sort();
  const countAddresses = (ranges) => ranges.reduce((count, [start, end]) => count + end - start + 1, 0);
  const fullCidrs = rangesToCidrs(full), zapretCidrs = rangesToCidrs(zapret);
  const rules = {
    version: 2, updatedAt: now, ipRangeCount: full.length, zapretIpRangeCount: zapret.length,
    ipCidrCount: fullCidrs.length, zapretIpCidrCount: zapretCidrs.length,
    ipv4AddressCount: countAddresses(full), zapretIpv4AddressCount: countAddresses(zapret),
    zapretExcludedIpv4Count: countAddresses(full) - countAddresses(zapret),
    domainCount: domains.length, geoDomainCount: geoDomains.length,
    deltas: encodeRanges(full), zapretDeltas: encodeRanges(zapret), domains, geoDomains,
    zapretDomains, geminiDomains: POLICY.geminiDomains, zapretCidrs: rangesToCidrs(zapretExclusions),
    dnsSnapshot: { updatedAt: snapshot.updatedAt, resolvers: snapshot.resolvers, queriedDomains: geoDomains.length,
      resolvedDomains: resolvedDomains.length, unresolvedDomains: geoDomains.filter((domain) => !snapshot.records[domain]?.length),
      uniqueIpv4: new Set(geoRanges.map(([start]) => start)).size, queryErrors: snapshot.errors?.length || 0 },
    sources: Object.entries(POLICY.sources).map(([name, url]) => ({ name, url, sha256: crypto.createHash('sha256').update(inputs[name]).digest('hex') }))
  };
  return { rules, fullCidrs, zapretCidrs };
}
async function updateRules() {
  const index = process.argv.indexOf('--offline');
  if (index >= 0 && !process.argv[index + 1]) throw new Error('--offline requires a directory');
  const directory = index >= 0 ? path.resolve(process.argv[index + 1]) : null;
  const inputs = Object.fromEntries(await Promise.all(Object.entries(POLICY.sources).map(async ([name, url]) =>
    [name, directory ? fs.readFileSync(path.join(directory, name), 'utf8') : await fetchText(url)])));
  const domains = geoblockDomains(inputs);
  console.log(`[SSJ VPN] ${domains.length} geoblock domains; building RKN + community + DNS address sets`);
  const snapshot = directory ? JSON.parse(fs.readFileSync(path.join(directory, 'dns-snapshot.json'), 'utf8')) : await resolveGeoblocks(domains);
  const { rules, fullCidrs, zapretCidrs } = compileRules(inputs, snapshot);
  const text = JSON.stringify(rules), metadata = { ...rules };
  for (const key of ['deltas', 'zapretDeltas', 'domains', 'geoDomains', 'zapretDomains', 'geminiDomains']) delete metadata[key];
  const outputs = {
    'default_rules.js': `export const defaultRules = ${text};\nexport default defaultRules;\n`,
    'rules-metadata.json': JSON.stringify(metadata, null, 2) + '\n'
  };
  if (process.argv.includes('--dump')) {
    Object.assign(outputs, {
      'ipset-full-v4.lst': fullCidrs.join('\n') + '\n',
      'ipset-zapret-v4.lst': zapretCidrs.join('\n') + '\n',
      'domains-geoblock.lst': rules.geoDomains.join('\n') + '\n',
      'domains-zapret.lst': rules.zapretDomains.join('\n') + '\n',
      'ipset-zapret-excluded-v4.lst': rules.zapretCidrs.join('\n') + '\n',
      'geoblock-dns.json': JSON.stringify({ updatedAt: snapshot.updatedAt, resolvers: snapshot.resolvers, records: snapshot.records }, null, 2) + '\n'
    });
  }
  for (const [name, content] of Object.entries(outputs)) fs.writeFileSync(path.join(ROOT, 'data', name + '.tmp'), content);
  for (const name of Object.keys(outputs)) fs.renameSync(path.join(ROOT, 'data', name + '.tmp'), path.join(ROOT, 'data', name));
  console.log(`[SSJ VPN] Full: ${fullCidrs.length} IPv4 CIDRs (${rules.ipRangeCount} ranges), ${rules.domainCount} domains`);
  console.log(`[SSJ VPN] Zapret: ${zapretCidrs.length} IPv4 CIDRs; ${rules.zapretExcludedIpv4Count} addresses excluded`);
  console.log(`[SSJ VPN] DNS: ${rules.dnsSnapshot.resolvedDomains}/${domains.length} domains resolved`);
}
if (require.main === module) updateRules().catch((error) => { console.error('[SSJ VPN] Rule update aborted:', error.message); process.exitCode = 1; });
module.exports = { updateRules, ipToInt, cidrToRange, mergeRanges, subtractRanges, encodeRanges, rangesToCidrs, parseDomains, parseRanges, compileRules, zapretNetworkRanges };
