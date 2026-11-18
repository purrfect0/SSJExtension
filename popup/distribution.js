import { iconThemeIds } from '../icons/themes.js';

// Offline ZIP writer with friend-ready installer and visual guide at archive root.
const encoder = new TextEncoder();
const SERVER_FIELDS = [
  'id', 'name', 'host', 'httpsDomain', 'httpsPort', 'backupPort', 'feedPort', 'username', 'password', 'countryCode', 'countryName'
];

export function makeFriendProfile(status, bundleId) {
  if (!Array.isArray(status?.servers) || !status.servers.length) {
    throw new Error('Сначала добавьте хотя бы один сервер');
  }
  const servers = status.servers.map((server) => {
    if (!server.host || !server.username || !server.password) {
      throw new Error(`У сервера «${server.name || server.host || 'без имени'}» не сохранены логин и пароль`);
    }
    return Object.fromEntries(SERVER_FIELDS.filter((key) => server[key] !== undefined)
      .map((key) => [key, server[key]]));
  });
  return {
    bundleId,
    servers,
    activeServerId: servers.some((server) => server.id === status.activeServerId)
      ? status.activeServerId : servers[0].id,
    // Friends typically don't run Zapret locally, so always ship 'full' so YouTube & Discord work out of the box.
    mode: status.mode === 'all' ? 'all' : 'whitelist',
    ipsetPreset: 'full',
    adblock: status.adblock !== false,
    sponsorBlock: status.sponsorBlock !== false,
    bypassRu: true,
    autoReload: true,
    iconTheme: iconThemeIds.includes(status.iconTheme) ? status.iconTheme : 'mint',
    uiTheme: status.uiTheme === 'light' ? 'light' : 'dark'
  };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = (i >>> 1) ^ ((i & 1) ? 0xedb88320 : 0);
  return i >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(entries, now = new Date()) {
  if (entries.length > 65535) throw new Error('Слишком много файлов в архиве');
  const localParts = [];
  const directoryParts = [];
  let offset = 0;
  let directorySize = 0;
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) |
    ((now.getMonth() + 1) << 5) | now.getDate();

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const bytes = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const checksum = crc32(bytes);
    const local = new Uint8Array(30 + name.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true); // UTF-8 filenames
    header.setUint16(10, dosTime, true);
    header.setUint16(12, dosDate, true);
    header.setUint32(14, checksum, true);
    header.setUint32(18, bytes.length, true);
    header.setUint32(22, bytes.length, true);
    header.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, bytes);

    const central = new Uint8Array(46 + name.length);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(12, dosTime, true);
    record.setUint16(14, dosDate, true);
    record.setUint32(16, checksum, true);
    record.setUint32(20, bytes.length, true);
    record.setUint32(24, bytes.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.set(name, 46);
    directoryParts.push(central);
    directorySize += central.length;
    offset += local.length + bytes.length;
  }

  const end = new Uint8Array(22);
  const footer = new DataView(end.buffer);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, entries.length, true);
  footer.setUint16(10, entries.length, true);
  footer.setUint32(12, directorySize, true);
  footer.setUint32(16, offset, true);
  return new Blob([...localParts, ...directoryParts, end], { type: 'application/zip' });
}

async function readPackageFile(path) {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error(`Не удалось прочитать файл ${path}. Обновите все файлы расширения.`);
  return new Uint8Array(await response.arrayBuffer());
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function downloadFriendBuild() {
  const response = await chrome.runtime.sendMessage({ action: 'getStatus' });
  if (!response?.success) throw new Error('Не удалось прочитать настройки расширения');
  const profile = makeFriendProfile(response.data, crypto.randomUUID());
  const files = JSON.parse(new TextDecoder().decode(await readPackageFile('data/package_files.json')));
  const entries = [];

  // Put 1-click installer & readable guides right at the root of the ZIP so friends find them immediately.
  const rootExtras = [
    ['installer/install_windows.cmd', 'Установить_SSJ_VPN.cmd'],
    ['installer/guide.html', 'Инструкция.html'],
    ['START_HERE_RU.txt', 'ПРОЧИТАЙ_МЕНЯ.txt']
  ];
  for (const [src, dest] of rootExtras) {
    if (files.includes(src)) {
      entries.push({ name: dest, data: await readPackageFile(src) });
    }
  }

  for (let start = 0; start < files.length; start += 12) {
    const batch = await Promise.all(files.slice(start, start + 12).map(async (path) => ({
      name: `SSJ_VPN/${path}`,
      data: path === 'data/bundled_profile.js'
        ? `// Prepared by SSJ VPN «Скачать ZIP для друга». Contains the proxy login and password: share only with friends.\nexport const bundledProfile = ${JSON.stringify(profile, null, 2)};\n`
        : await readPackageFile(path)
    })));
    entries.push(...batch);
  }
  downloadBlob(createZip(entries), 'SSJ_VPN_for_friend.zip');
}
