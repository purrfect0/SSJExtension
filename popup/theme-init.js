// Read the small local cache before the first paint. The background settings
// remain authoritative and are synchronised when the popup opens.
(() => {
  let theme = 'dark';
  try {
    if (localStorage.getItem('ssj.uiTheme') === 'light') theme = 'light';
  } catch (_) {
    // The popup still opens if the browser disables localStorage.
  }
  document.documentElement.dataset.theme = theme;
})();
