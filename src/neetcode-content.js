// Isolated-world content script on neetcode.io.
//
// Responsibilities:
//   1. Receive submission events from neetcode-hook.js (MAIN world) and forward accepted ones
//      to the background service worker, which handles the LeetCode side.
//   2. Show a small toast on the NeetCode page with the LeetCode verdict.
//   3. Bulk sync: on request from the popup/background, walk the user's completed problems on
//      NeetCode (using the user's own Firebase session) and hand every accepted solution to the
//      background queue.

const NC_API = 'https://neetcode.io/api/';
const FIREBASE_DB = 'firebaseLocalStorageDb';
const FIREBASE_STORE = 'firebaseLocalStorage';

let capturedHeaders = null;   // headers NeetCode itself sent to /api/* (Authorization etc.)
let capturedAt = 0;
let bulkAbort = false;

// ---------------------------------------------------------------- hook events

// Deliver a message to the service worker. A worker that is still waking up (or restarts mid-handler)
// can drop a message or answer nothing; the background ignores duplicates, so retrying is safe.
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

  if (msg.type === 'N2L_API_HEADERS') {
    capturedHeaders = msg.headers;
    capturedAt = msg.capturedAt || Date.now();
    return;
  }

  if (msg.type === 'N2L_SUBMISSION') {
    if (msg.status !== 'Accepted') return;
    sendToBackground({
      type: 'N2L_ACCEPTED',
      source: 'live',
      problemId: msg.problemId,
      lang: msg.lang,
      code: msg.code,
      at: msg.at,
    }).then((reply) => {
      if (reply && reply.queued) showToast(`Queued for LeetCode: ${reply.title || msg.problemId}`, 'info');
      else if (reply && reply.reason) showToast(reply.reason, reply.level || 'warn');
    }).catch(() => { /* background unavailable after retries */ });
  }
});

// ---------------------------------------------------------------- background -> page

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'N2L_RESULT') {
    showToast(msg.text, msg.level || 'info', msg.url);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'N2L_COLLECT') {
    bulkAbort = false;
    collectAccepted(msg.options || {}).catch((err) => {
      chrome.runtime.sendMessage({ type: 'N2L_BULK_DONE', error: String((err && err.message) || err) }).catch(() => {});
    });
    sendResponse({ started: true });
    return false;
  }

  if (msg.type === 'N2L_BULK_ABORT') {
    bulkAbort = true;
    sendResponse({ ok: true });
    return false;
  }

  // LeetCode -> NeetCode: run the code through NeetCode's judge (same call the Submit button makes)
  if (msg.type === 'N2L_NC_SUBMIT') {
    (async () => {
      const headers = await getApiHeaders();
      const res = await callNeetCode('executeCodeFunctionHttp', { problemId: msg.problemId, rawCode: msg.code, lang: msg.lang }, headers);
      const status = (res && res.status && res.status.description) || 'Unknown';
      return {
        ok: true, status,
        testCases: res && res.test_case_count, correct: res && res.correct_test_case_count,
        error: (res && (res.compile_output || res.stderr)) || null,
      };
    })().then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // LeetCode -> NeetCode: tick the problem in the NeetCode roadmap
  if (msg.type === 'N2L_NC_MARK') {
    (async () => {
      const headers = await getApiHeaders();
      await callNeetCode('callableFunctionHttp', { functionId: 'markProblemComplete', topic: msg.topic, problem: msg.link }, headers);
      return { ok: true };
    })().then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // Raw completed-problems structure (LeetCode links grouped by topic), for the reverse bulk sync
  if (msg.type === 'N2L_NC_COMPLETED') {
    (async () => {
      const headers = await getApiHeaders();
      return { ok: true, raw: await callNeetCode('callableFunctionHttp', { functionId: 'getCompletedProblems' }, headers) };
    })().then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === 'N2L_GET_STARTER') {
    (async () => {
      const headers = await getApiHeaders().catch(() => ({}));
      const meta = await callNeetCode('getProblemMetadataFunctionHttp', { problemId: msg.problemId }, headers);
      return { starter: (meta && meta.starterCode && meta.starterCode[msg.lang]) || null };
    })().then(sendResponse, (err) => sendResponse({ starter: null, error: String(err) }));
    return true;
  }

  if (msg.type === 'N2L_PING') {
    readFirebaseToken().then((tok) => sendResponse({ ok: true, hooked: true, hasHeaders: !!capturedHeaders, loggedIn: !!tok || !!capturedHeaders,
      // ready: a token the API calls can use right now (unexpired, or recently captured headers)
      ready: (!!tok && (tok.expirationTime > Date.now() + 60_000 || !!(tok.refreshToken && tok.apiKey))) || (!!capturedHeaders && Date.now() - capturedAt < 50 * 60_000) }));
    return true;
  }
  return false;
});

// ---------------------------------------------------------------- NeetCode API access

// Firebase keeps the signed-in user in IndexedDB by default, but in localStorage or
// sessionStorage when the site picks that persistence. Check all three.
function tokenFromUser(user) {
  const tm = user && user.stsTokenManager;
  return tm && tm.accessToken ? { accessToken: tm.accessToken, expirationTime: Number(tm.expirationTime) || 0,
    refreshToken: tm.refreshToken || null, apiKey: (user && user.apiKey) || null } : null;
}

function readWebStorageToken() {
  for (const store of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      for (let i = 0; store && i < store.length; i++) {
        const k = store.key(i);
        if (!k || !k.startsWith('firebase:authUser:')) continue;
        const tok = tokenFromUser(JSON.parse(store.getItem(k)));
        if (tok) return tok;
      }
    } catch { /* storage blocked or bad JSON */ }
  }
  return null;
}

async function readFirebaseToken() {
  return (await readIndexedDbToken()) || readWebStorageToken();
}

function readIndexedDbToken() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(FIREBASE_DB); } catch { return resolve(null); }
    req.onerror = () => resolve(null);
    // The db does not exist yet: abort instead of creating an empty one under Firebase's name.
    req.onupgradeneeded = () => { try { req.transaction.abort(); } catch { /* ignore */ } };
    req.onsuccess = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(FIREBASE_STORE)) { db.close(); return resolve(null); }
        const all = db.transaction(FIREBASE_STORE, 'readonly').objectStore(FIREBASE_STORE).getAll();
        all.onsuccess = () => {
          const rows = all.result || [];
          const row = rows.find((r) => r && typeof r.fbase_key === 'string' && r.fbase_key.startsWith('firebase:authUser:'));
          db.close();
          resolve(tokenFromUser(row && row.value));
        };
        all.onerror = () => { db.close(); resolve(null); };
      } catch { resolve(null); }
    };
  });
}

// Firebase only refreshes the stored ID token (1 h lifetime) while its own timers run, so a tab
// that sat in the background holds an expired token. Exchange the refresh token the same way the
// Firebase SDK does; the new token stays in memory only.
let refreshed = null;   // { accessToken, expirationTime }
async function refreshIdToken(tok) {
  if (refreshed && refreshed.expirationTime > Date.now() + 60_000) return refreshed;
  if (!tok || !tok.refreshToken || !tok.apiKey) return null;
  try {
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(tok.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(tok.refreshToken)}`,
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.id_token) return null;
    refreshed = { accessToken: j.id_token, expirationTime: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return refreshed;
  } catch { return null; }
}

async function getApiHeaders() {
  const base = {};
  if (capturedHeaders) {
    for (const [k, v] of Object.entries(capturedHeaders)) {
      const lk = k.toLowerCase();
      if (lk === 'content-type' || lk === 'content-length' || lk === 'authorization') continue;
      base[k] = v;
    }
  }
  const tok = await readFirebaseToken();
  if (tok && tok.expirationTime > Date.now() + 60_000) {
    return { ...base, Authorization: `Bearer ${tok.accessToken}` };
  }
  const fresh = tok && await refreshIdToken(tok);
  if (fresh) return { ...base, Authorization: `Bearer ${fresh.accessToken}` };
  if (capturedHeaders && Date.now() - capturedAt < 50 * 60_000) {
    const authKey = Object.keys(capturedHeaders).find((k) => k.toLowerCase() === 'authorization');
    if (authKey) return { ...base, Authorization: capturedHeaders[authKey] };
  }
  throw new Error('Not logged in on NeetCode (no session token found). Log in, reload the page and try again.');
}

async function callNeetCode(fn, data, headers) {
  const res = await fetch(NC_API + fn, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ data }),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`NeetCode API rejected the session (${res.status}) - log in again on neetcode.io.`);
  if (!res.ok) throw new Error(`NeetCode API ${fn} failed: HTTP ${res.status}`);
  const j = await res.json();
  if (j && j.data !== undefined) return j.data;
  if (j && j.result !== undefined) return j.result;
  return j;
}

function latestAccepted(history) {
  if (!Array.isArray(history)) return null;
  const acc = history.filter((s) => s && s.statusDescription === 'Accepted' && typeof s.code === 'string' && s.code.trim());
  if (!acc.length) return null;
  acc.sort((a, b) => new Date(b.date || b.submissionDate || 0) - new Date(a.date || a.submissionDate || 0));
  return acc[0];
}

async function collectAccepted(options) {
  const progress = (payload) => chrome.runtime.sendMessage({ type: 'N2L_BULK_PROGRESS', ...payload }).catch(() => {});
  const headers = await getApiHeaders();

  progress({ phase: 'listing' });
  let ids = [];
  let listError = null;
  try {
    // Shape: { "<list or topic>": ["contains-duplicate/", "two-sum/", ...], ... } - LeetCode links,
    // grouped by list. The background turns them into NeetCode slugs via the mapping.
    const completed = await callNeetCode('callableFunctionHttp', { functionId: 'getCompletedProblems' }, headers);
    console.info('[neetbridge] getCompletedProblems raw response:', completed);
    const resolved = await chrome.runtime.sendMessage({ type: 'N2L_COMPLETED_TO_IDS', raw: completed });
    ids = (resolved && resolved.ids) || [];
    const unknown = (resolved && resolved.unknown) || [];
    console.info(`[neetbridge] completed -> ${ids.length} NeetCode problems` + (unknown.length ? `; ${unknown.length} not in the mapping: ${unknown.slice(0, 10).join(', ')}` : ''));
    if (!ids.length) console.warn('[neetbridge] getCompletedProblems returned no recognisable problems');
  } catch (err) {
    listError = err;
  }

  if (!ids.length) {
    // Fallback when the completed list is unusable: walk every LeetCode-style problem NeetCode has
    // (one request per problem, a few minutes).
    if (listError) console.warn('[neetbridge] completed list failed, scanning every problem instead:', listError);
    progress({ phase: 'scanning' });
    const list = await callNeetCode('getProblemListFunctionHttp', {}, {});
    ids = Object.keys(list || {}).filter((k) => list[k] && list[k].tag === 'NeetCode150');
  }
  if (!ids.length) throw listError || new Error('Could not read the NeetCode problem list.');

  let done = 0;
  let found = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await chrome.runtime.sendMessage({ type: 'N2L_ENQUEUE', source: 'bulk', dryRun: !!options.dryRun, items: batch }).catch(() => {});
    batch = [];
  };

  for (const problemId of ids) {
    if (bulkAbort) break;
    try {
      const meta = await callNeetCode('getProblemMetadataFunctionHttp', { problemId }, headers);
      const best = latestAccepted(meta && meta.submissionHistory);
      if (done < 3) console.info('[neetbridge] metadata sample', problemId, { completed: meta && meta.completed, history: meta && meta.submissionHistory, picked: best && { language: best.language, date: best.date, codeLength: best.code.length } });
      if (best) {
        found += 1;
        batch.push({
          problemId,
          lang: best.language || meta.language,
          code: best.code,
          at: Date.parse(best.date || best.submissionDate || '') || Date.now(),
        });
      }
    } catch (err) {
      console.warn('[neetbridge] metadata failed for', problemId, err);
    }
    done += 1;
    progress({ phase: 'collecting', done, total: ids.length, found });
    if (batch.length >= 10) await flush();
    await new Promise((r) => setTimeout(r, 150));
  }
  await flush();
  chrome.runtime.sendMessage({ type: 'N2L_BULK_DONE', aborted: bulkAbort, scanned: done, found }).catch(() => {});
}

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
