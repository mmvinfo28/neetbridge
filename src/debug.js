// Live monitor for the neetbridge service worker. Reads storage and tabs directly; uses only the
// storage permission and the existing leetcode.com / neetcode.io host permissions (tabs.query by url).
const root = document.getElementById('root');
const jsonEl = document.getElementById('json');
const updatedEl = document.getElementById('updated');
const ts = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '-');

async function tabInfo(id) {
  if (id == null) return { id: null, exists: false, url: null };
  try {
    const t = await chrome.tabs.get(id);
    return { id, exists: true, url: t.url || t.pendingUrl || '', status: t.status, active: t.active, discarded: t.discarded };
  } catch { return { id, exists: false, url: null }; }
}

async function collect() {
  const now = Date.now();
  const local = await chrome.storage.local.get(['queue', 'log', 'bulk', 'settings', 'paused', 'helperTabs', 'lastSubmitAt']);
  let session = {};
  try { session = await chrome.storage.session.get('debugStatus'); } catch { /* ignore */ }
  const queue = local.queue || [];
  const log = local.log || [];
  const lastErrorFor = (q) => {
    const e = log.find((l) => ((l.slug && l.slug === (q.map && q.map.slug)) || (l.problemId && l.problemId === q.problemId)) &&
      (l.direction || 'nc2lc') === (q.direction || 'nc2lc') && l.status !== 'Accepted' && l.status !== 'Dry run');
    return e ? `${e.status}${e.detail ? ': ' + e.detail : ''}` : (q.lastError || '');
  };
  const helper = local.helperTabs || {};
  const [lcOpen, ncOpen] = await Promise.all([
    chrome.tabs.query({ url: 'https://leetcode.com/*' }),
    chrome.tabs.query({ url: 'https://neetcode.io/*' }),
  ]);
  const owned = {};
  for (const site of ['leetcode', 'neetcode']) owned[site] = await tabInfo(helper[site]);
  const slim = (t) => ({ id: t.id, url: t.url, active: t.active, discarded: t.discarded, status: t.status });
  const s = local.settings || {};
  return {
    now: ts(now),
    queue: {
      length: queue.length,
      paused: local.paused || null,
      lastSubmitAt: ts(local.lastSubmitAt),
      items: queue.map((q) => ({
        id: q.id, direction: q.direction || 'nc2lc', problem: q.map ? `#${q.map.num} ${q.map.title}` : q.problemId,
        source: q.source, attempts: q.attempts || 0, inFlight: !!q.inFlight,
        nextAttempt: ts(q.notBefore), dueInSec: q.notBefore ? Math.round((q.notBefore - now) / 1000) : 0,
        lastError: lastErrorFor(q),
      })),
    },
    bulk: local.bulk || null,
    settings: s,
    modes: { nc2lc: (s.enabled === undefined || s.enabled) ? 'submit' : 'off', lc2nc: s.lc2nc || 'mark' },
    helperTabs: owned,
    openTabs: { leetcode: lcOpen.length, neetcode: ncOpen.length, leetcodeTabs: lcOpen.map(slim), neetcodeTabs: ncOpen.map(slim) },
    debugStatus: session.debugStatus || null,
    log: log.slice(0, 100).map((e) => ({
      at: ts(e.at), direction: e.direction || 'nc2lc', status: e.status,
      problem: e.num ? `#${e.num} ${e.title}` : (e.problemId || ''), detail: e.detail || '',
    })),
  };
}

function table(headers, rows) {
  const t = document.createElement('table');
  const h = t.insertRow();
  headers.forEach((x) => { const th = document.createElement('th'); th.textContent = x; h.append(th); });
  if (!rows.length) {
    const r = t.insertRow(); const c = r.insertCell();
    c.colSpan = headers.length; c.textContent = '(none)'; c.className = 'muted';
  }
  for (const row of rows) {
    const r = t.insertRow();
    row.forEach((v) => { r.insertCell().textContent = v == null ? '' : String(v); });
  }
  return t;
}
function section(title, ...nodes) {
  const h = document.createElement('h2');
  h.textContent = title;
  const frag = document.createDocumentFragment();
  frag.append(h, ...nodes);
  return frag;
}
function kv(obj) {
  return table(['key', 'value'], Object.entries(obj).map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : v]));
}

function render(d) {
  const ds = d.debugStatus;
  root.replaceChildren(
    section(`1. Queue: length ${d.queue.length}${d.queue.paused ? ' (PAUSED: ' + d.queue.paused + ')' : ''}; last submit ${d.queue.lastSubmitAt}`,
      table(['id', 'direction', 'problem', 'source', 'attempts', 'inFlight', 'nextAttempt', 'dueInSec', 'lastError'],
        d.queue.items.map((q) => [q.id, q.direction, q.problem, q.source, q.attempts, q.inFlight, q.nextAttempt, q.dueInSec, q.lastError]))),
    section(`2. Recent log (newest first, ${d.log.length} shown)`,
      table(['time', 'direction', 'status', 'problem', 'detail'], d.log.map((e) => [e.at, e.direction, e.status, e.problem, e.detail]))),
    section('3. Bulk run and settings', kv({
      bulk: d.bulk,
      previewOnly: d.bulk ? !!d.bulk.dryRun : '(no bulk run recorded; popup default is on)',
      gapSeconds: d.settings.delaySec === undefined ? 30 : d.settings.delaySec,
      'mode nc2lc': d.modes.nc2lc, 'mode lc2nc': d.modes.lc2nc, settings: d.settings,
    })),
    section('4. Tabs',
      table(['site', 'owned tab id', 'exists', 'url', 'status', 'open tabs total'],
        ['leetcode', 'neetcode'].map((s) => [s, d.helperTabs[s].id, d.helperTabs[s].exists, d.helperTabs[s].url, d.helperTabs[s].status, d.openTabs[s]])),
      table(['site', 'tab id', 'url', 'active', 'discarded'],
        [...d.openTabs.leetcodeTabs.map((t) => ['leetcode', t.id, t.url, t.active, t.discarded]),
          ...d.openTabs.neetcodeTabs.map((t) => ['neetcode', t.id, t.url, t.active, t.discarded])])),
    section('5. processQueue', kv(ds ? {
      processing: ds.processing, lastRunStart: ts(ds.lastRunStart), lastLoopAt: ts(ds.lastLoopAt), lastRunEnd: ts(ds.lastRunEnd),
      lastAction: ds.lastAction, serviceWorkerStarted: ts(ds.swStartedAt),
    } : { status: 'no debugStatus yet (processQueue has not run since browser start)' })),
  );
  jsonEl.textContent = JSON.stringify(d, null, 2);
  updatedEl.textContent = `Updated ${d.now} UTC`;
}

let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try { render(await collect()); } catch (e) { updatedEl.textContent = `Error: ${e && e.message}`; }
  busy = false;
}
chrome.storage.onChanged.addListener(refresh);
setInterval(refresh, 1000);
refresh();
