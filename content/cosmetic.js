// SSJ VPN — lightweight cosmetic ad & empty-banner hider (zero layout breakage, per-site toggleable).
(() => {
  const host = (location.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return;
  // YouTube has its own dedicated module (content/youtube.js).
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) return;

  const STYLE_ID = 'ssj-vpn-cosmetic-adblock';

  const COMMON_CSS = `
    [id^="yandex_rtb_"]:not(html):not(body),
    [class*="yandex_rtb"]:not(html):not(body),
    [id^="adfox_"]:not(html):not(body),
    [id^="div-gpt-ad"]:not(html):not(body),
    ins.adsbygoogle:not(html):not(body),
    [id^="smi2adblock"]:not(html):not(body),
    [id*="MarketGid"]:not(html):not(body),
    .mgbox:not(html):not(body),
    [id^="adriver_"]:not(html):not(body),
    .relap-default-wrapper:not(html):not(body),
    .buzzoola-player:not(html):not(body),
    iframe[src*="doubleclick.net"],
    iframe[src*="googlesyndication.com"],
    iframe[src*="yandexadexchange.net"],
    iframe[src*="adfox.ru"],
    iframe[src*="adriver.ru"] {
      display: none !important;
    }
  `;

  const SITE_CSS = [
    {
      match: /(^|\.)(yandex\.(ru|by|kz|com)|ya\.ru)$/,
      css: `
        #search-result > li:has([href*="yabs.yandex."]),
        #search-result > li:has(.OrganicTitleContentSpan_promo),
        .AdvBanner, .Direct, .serp-adv-item, [data-fast-name="advertising"],
        .zen-row-adv, [data-testid="ad-block"] { display: none !important; }
      `
    },
    {
      match: /(^|\.)google\./,
      css: `
        #tads, #tadsb, #bottomads, #rhs [data-text-ad], [data-pla-slot-pos] { display: none !important; }
      `
    },
    {
      match: /(^|\.)vk\.(com|ru)$/,
      css: `
        #ads_left, ._ads_block_data_w, .ads_ads_news_wrap, [data-ad-view] { display: none !important; }
      `
    },
    {
      match: /(^|\.)dzen\.ru$/,
      css: `
        [class*="ad-block-"], [data-testid*="ad-card"], [aria-label="Реклама"] { display: none !important; }
      `
    },
    {
      match: /(^|\.)pikabu\.ru$/,
      css: `
        .story_sponsor, .sidebar-block_ad, [data-type="ad"] { display: none !important; }
      `
    }
  ];

  function isHostAllowed(allowlist) {
    if (!Array.isArray(allowlist) || !allowlist.length) return false;
    return allowlist.some((rule) => host === rule || host.endsWith('.' + rule));
  }

  function applyCosmetics(settings) {
    const active = Boolean(
      settings &&
      settings.enabled !== false &&
      settings.adblock !== false &&
      !isHostAllowed(settings.adblockAllowlist)
    );
    const existing = document.getElementById(STYLE_ID);
    if (!active) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;

    let css = COMMON_CSS;
    for (const entry of SITE_CSS) {
      if (entry.match.test(host)) css += '\n' + entry.css;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  try {
    chrome.storage.local.get(['ssjSettings'], (data) => {
      if (chrome.runtime.lastError) return;
      applyCosmetics((data && data.ssjSettings) || { enabled: true, adblock: true });
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.ssjSettings) {
        applyCosmetics(changes.ssjSettings.newValue);
      }
    });
  } catch (_) {}
})();
