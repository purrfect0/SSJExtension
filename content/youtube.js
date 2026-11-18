// SSJ VPN — YouTube SponsorBlock + safe YouTube video ad auto-skipper (never triggers anti-adblock).
(() => {
  const STYLE_ID = 'ssj-yt-style';
  const BAR_CLASS = 'ssj-sb-markers';
  const TOAST_ID = 'ssj-sb-toast';

  let cfg = { enabled: true, adblock: true, sponsorBlock: true, adblockAllowlist: [] };
  let currentVideoId = '';
  let segments = [];
  let manualUnskipped = new Set();
  let lastSkipAt = 0;
  let toastTimer = null;
  let savedMute = null;
  let savedRate = null;
  let wasAdShowing = false;

  function isYtAllowed() {
    return Array.isArray(cfg.adblockAllowlist) &&
      cfg.adblockAllowlist.some((d) => d === 'youtube.com' || 'youtube.com'.endsWith('.' + d));
  }

  function adSkipActive() {
    return Boolean(cfg.enabled && cfg.adblock && !isYtAllowed());
  }

  function sbActive() {
    return Boolean(cfg.enabled && cfg.sponsorBlock);
  }

  function syncStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!cfg.enabled) {
      if (style) style.remove();
      clearMarkers();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    const adCss = adSkipActive() ? `
      ytd-ad-slot-renderer,
      ytd-in-feed-ad-layout-renderer,
      ytd-promoted-sparkles-web-renderer,
      ytd-display-ad-renderer,
      ytd-statement-banner-renderer,
      ytd-companion-slot-renderer,
      #masthead-ad,
      #player-ads,
      .ytp-ad-overlay-container {
        display: none !important;
      }
    ` : '';
    const sbCss = `
      .${BAR_CLASS} {
        position: absolute; inset: 0; pointer-events: none; z-index: 36; overflow: hidden;
      }
      .${BAR_CLASS} > span {
        position: absolute; top: 0; bottom: 0;
        background: rgba(25, 211, 162, 0.82);
        border-radius: 1px;
      }
      #${TOAST_ID} {
        position: absolute; right: 16px; bottom: 68px; z-index: 65;
        display: inline-flex; align-items: center; gap: 10px;
        padding: 8px 13px; border-radius: 999px;
        background: rgba(15, 19, 31, 0.88);
        border: 1px solid rgba(25, 211, 162, 0.45);
        color: #f3f6fc; font: 600 12.5px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        backdrop-filter: blur(8px);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.38);
        transition: opacity 0.2s ease;
      }
      #${TOAST_ID}[hidden] { display: none !important; }
      #${TOAST_ID} button {
        background: rgba(25, 211, 162, 0.18); color: #19d3a2;
        border: 0; border-radius: 999px; padding: 4px 9px;
        font: inherit; font-size: 11.5px; cursor: pointer;
      }
      #${TOAST_ID} button:hover { background: rgba(25, 211, 162, 0.3); }
    `;
    style.textContent = adCss + sbCss;
  }

  // ---------- 1. Safe YouTube Official Video Ad Auto-Skipper ----------
  function handleYoutubeAd() {
    const player = document.getElementById('movie_player');
    if (!player) return;
    const video = player.querySelector('video.html5-main-video') || player.querySelector('video');
    if (!video) return;

    const adShowing = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
    if (!adShowing || !adSkipActive()) {
      if (wasAdShowing) {
        wasAdShowing = false;
        if (savedMute !== null) { video.muted = savedMute; savedMute = null; }
        if (savedRate !== null && video.playbackRate > 2) { video.playbackRate = savedRate; savedRate = null; }
      }
      return;
    }

    if (!wasAdShowing) {
      wasAdShowing = true;
      savedMute = video.muted;
      savedRate = video.playbackRate <= 2 ? video.playbackRate : 1;
    }
    video.muted = true;

    const skipSelectors = [
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      '.ytp-ad-skip-button-slot button',
      '.ytp-ad-overlay-close-button'
    ];
    for (const sel of skipSelectors) {
      const btn = player.querySelector(sel);
      if (btn) { try { btn.click(); } catch (_) {} }
    }

    if (Number.isFinite(video.duration) && video.duration > 0.4 && video.currentTime < video.duration - 0.15) {
      try {
        video.currentTime = Math.max(0, video.duration - 0.05);
      } catch (_) {
        try { video.playbackRate = 16; } catch (_) {}
      }
    }
  }

  // ---------- 2. SponsorBlock ----------
  function extractVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v') || '';
      const shorts = /^\/shorts\/([A-Za-z0-9_-]{6,})/.exec(u.pathname);
      if (shorts) return shorts[1];
    } catch (_) {}
    return '';
  }

  function clearMarkers() {
    document.querySelectorAll('.' + BAR_CLASS).forEach((n) => n.remove());
  }

  function renderMarkers(video) {
    clearMarkers();
    if (!sbActive() || !segments.length || !video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const bar = document.querySelector('.ytp-progress-bar');
    if (!bar) return;
    const wrap = document.createElement('div');
    wrap.className = BAR_CLASS;
    const total = video.duration;
    for (const seg of segments) {
      const [start, end] = seg.segment;
      if (start >= total) continue;
      const left = Math.max(0, (start / total) * 100);
      const width = Math.max(0.4, ((Math.min(end, total) - start) / total) * 100);
      const span = document.createElement('span');
      span.style.left = `${left.toFixed(3)}%`;
      span.style.width = `${width.toFixed(3)}%`;
      wrap.appendChild(span);
    }
    bar.appendChild(wrap);
  }

  function showSkipToast(label, seg, video) {
    const player = document.getElementById('movie_player');
    if (!player) return;
    let node = document.getElementById(TOAST_ID);
    if (!node) {
      node = document.createElement('div');
      node.id = TOAST_ID;
      player.appendChild(node);
    }
    clearTimeout(toastTimer);
    node.replaceChildren();
    const text = document.createElement('span');
    text.textContent = label;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = 'Вернуть';
    undo.addEventListener('click', (e) => {
      e.stopPropagation();
      manualUnskipped.add(seg.UUID);
      if (video) video.currentTime = seg.segment[0];
      node.hidden = true;
    });
    node.append(text, undo);
    node.hidden = false;
    toastTimer = setTimeout(() => { node.hidden = true; }, 3800);
  }

  const CATEGORY_LABELS = {
    sponsor: 'Интеграция пропущена',
    selfpromo: 'Самореклама пропущена',
    interaction: 'Напоминание пропущено'
  };

  function checkSponsorTime(video) {
    if (!sbActive() || !segments.length || !video || video.paused) return;
    const player = document.getElementById('movie_player');
    if (player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))) return;

    const now = performance.now();
    if (now - lastSkipAt < 400) return;
    const t = video.currentTime;

    for (const seg of segments) {
      if (manualUnskipped.has(seg.UUID)) continue;
      const [start, end] = seg.segment;
      if (end - start < 0.8) continue;
      if (t >= start && t < end - 0.35) {
        lastSkipAt = now;
        video.currentTime = end;
        showSkipToast(CATEGORY_LABELS[seg.category] || 'Пропущено', seg, video);
        break;
      }
    }
  }

  async function loadSegmentsForVideo(videoId) {
    segments = [];
    manualUnskipped.clear();
    clearMarkers();
    if (!videoId || !sbActive()) return;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getSponsorSegments', videoId });
      if (videoId !== currentVideoId) return;
      if (res && res.success && Array.isArray(res.segments)) {
        segments = res.segments;
        const video = document.querySelector('#movie_player video');
        if (video) renderMarkers(video);
      }
    } catch (_) {}
  }

  function checkNavigation() {
    const vid = extractVideoId();
    if (vid !== currentVideoId) {
      currentVideoId = vid;
      loadSegmentsForVideo(vid);
    }
  }

  let boundVideo = null;
  function attachVideoListeners() {
    const video = document.querySelector('#movie_player video');
    if (!video || video === boundVideo) return;
    boundVideo = video;
    video.addEventListener('timeupdate', () => {
      handleYoutubeAd();
      checkSponsorTime(video);
    });
    video.addEventListener('loadedmetadata', () => renderMarkers(video));
    video.addEventListener('durationchange', () => renderMarkers(video));
  }

  function boot() {
    syncStyles();
    checkNavigation();
    attachVideoListeners();
    handleYoutubeAd();

    window.addEventListener('yt-navigate-finish', () => {
      checkNavigation();
      attachVideoListeners();
    });

    const observer = new MutationObserver(() => {
      attachVideoListeners();
      handleYoutubeAd();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });

    setInterval(() => {
      checkNavigation();
      handleYoutubeAd();
    }, 800);
  }

  try {
    chrome.storage.local.get(['ssjSettings'], (data) => {
      if (!chrome.runtime.lastError && data && data.ssjSettings) {
        cfg = { ...cfg, ...data.ssjSettings };
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
      } else {
        boot();
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.ssjSettings && changes.ssjSettings.newValue) {
        const prevSb = sbActive();
        cfg = { ...cfg, ...changes.ssjSettings.newValue };
        syncStyles();
        if (!prevSb && sbActive() && currentVideoId) loadSegmentsForVideo(currentVideoId);
      }
    });
  } catch (_) {}
})();
