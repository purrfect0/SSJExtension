// The only place that talks to the background service worker.
export async function send(action, payload = {}) {
  try {
    const res = await chrome.runtime.sendMessage({ action, ...payload });
    return res || { success: false, error: 'Расширение не ответило' };
  } catch (_) {
    return { success: false, error: 'Расширение не отвечает. Откройте окно ещё раз.' };
  }
}
