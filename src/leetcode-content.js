// Isolated-world content script on leetcode.com.
//
//   1. Receives verdict events from leetcode-hook.js (MAIN world) and forwards accepted ones to
//      the background service worker (LeetCode -> NeetCode direction).
//   2. Shows a small toast with the NeetCode result.
// The NeetCode -> LeetCode submissions are executed by the background with chrome.scripting
// directly in this tab; they do not go through this file.

// A worker that is still waking up (or restarts mid-handler) can drop a message or answer nothing;
// the background ignores duplicates, so retrying is safe.
async function sendToBackground(message, tries = 4) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const reply = await chrome.runtime.sendMessage(message);
      if (reply !== undefined && reply !== null) return reply;
      lastErr = new Error('no reply from background');
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 500 * (i + 1) * (i + 1)));
  }
  throw lastErr;
}

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.__n2l !== true) return;
  const msg = event.data;
  if (msg.type !== 'N2L_LC_SUBMISSION' || msg.status !== 'Accepted') return;
  sendToBackground({
    type: 'N2L_LC_ACCEPTED',
    source: 'live',
    slug: msg.slug,
    lang: msg.lang,
    code: msg.code,
    questionId: msg.questionId,
    submissionId: msg.submissionId,
    at: msg.at,
  }).then((reply) => {
    if (reply && reply.queued) showToast(`Queued for NeetCode: ${reply.title || msg.slug}`, 'info');
    else if (reply && reply.reason && reply.level !== 'silent') showToast(reply.reason, reply.level || 'warn');
  }).catch(() => { /* background unavailable */ });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'N2L_RESULT') {
    showToast(msg.text, msg.level || 'info', msg.url);
    sendResponse({ ok: true });
  }
  return false;
});

// ---------------------------------------------------------------- toast UI

let toastHost = null;
let toastTimer = null;

function ensureToastHost() {
  if (toastHost && document.contains(toastHost)) return toastHost;
  toastHost = document.createElement('div');
  toastHost.id = 'neetbridge-toast-host';
  const shadow = toastHost.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .toast {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
        max-width: 360px; padding: 10px 14px; border-radius: 8px;
        font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #fff; background: #1f2937; box-shadow: 0 6px 20px rgba(0,0,0,.35);
        display: flex; gap: 10px; align-items: center;
        opacity: 0; transform: translateY(8px); transition: opacity .2s, transform .2s;
      }
      .toast.show { opacity: 1; transform: none; }
      .toast.ok { background: #14532d; }
      .toast.warn { background: #7c2d12; }
      .toast.error { background: #7f1d1d; }
      .toast.gold { background: #713f12; }
      .tag { font-weight: 600; opacity: .8; white-space: nowrap; }
      a { color: #bfdbfe; }
    </style>
    <div class="toast"><span class="tag">neetbridge</span><span class="msg"></span></div>`;
  (document.body || document.documentElement).appendChild(toastHost);
  return toastHost;
}

function showToast(text, level, url) {
  const host = ensureToastHost();
  const toast = host.shadowRoot.querySelector('.toast');
  const msg = host.shadowRoot.querySelector('.msg');
  msg.textContent = '';
  msg.append(document.createTextNode(text + (url ? ' ' : '')));
  if (url) {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'open';
    msg.append(a);
  }
  toast.className = `toast show ${level || 'info'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), level === 'error' || level === 'warn' ? 15000 : 8000);
}
