// Service worker: owns the submission queue, the NeetCode -> LeetCode mapping and the
// LeetCode side (submit + poll, executed inside a leetcode.com tab so the request carries the
// user's own session cookies and a leetcode.com origin).

import { computeFix, applyFix, guessFix, reverseFix, guessReverseFix } from './sigfix.js';

const ALARM = 'n2l-tick';
const LOG_LIMIT = 1000;
const LC_ALL = 'https://leetcode.com/api/problems/all/';
const NC_META = 'https://neetcode.io/api/getProblemMetadataFunctionHttp';

// NeetCode language id -> LeetCode language slug
const LANG_MAP = {
  python: 'python3', java: 'java', cpp: 'cpp', javascript: 'javascript', typescript: 'typescript',
  csharp: 'csharp', go: 'golang', kotlin: 'kotlin', swift: 'swift', rust: 'rust', c: 'c',
  ruby: 'ruby', scala: 'scala', dart: 'dart',
};

const DEFAULT_SETTINGS = {
  enabled: true,                    // auto-sync live submissions
  allowPremium: false,              // submit to LeetCode premium problems (needs LC Premium)
  bulkSkipAcceptedOnLeetCode: true, // bulk: skip problems already accepted on LeetCode
  resubmitIdentical: false,         // resubmit code that was already accepted on LeetCode by this extension
  delaySec: 30,                     // minimum gap between two LeetCode submissions
  notify: true,                     // desktop notification with the verdict
  lc2nc: 'mark',                    // LeetCode -> NeetCode: 'off' | 'mark' (tick the roadmap) | 'submit' (judge + tick)
};

let processing = false;
let builtinMapping = null;   // { slug: {s, n, q, p, t} }
let lcIndexCache = null;     // { at, userName, byNorm, byNum, bySlug }

// ---------------------------------------------------------------- storage helpers

const getLocal = (keys) => chrome.storage.local.get(keys);
const setLocal = (obj) => chrome.storage.local.set(obj);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// All read-modify-write cycles on the queue go through this lock so that a bulk enqueue can
// never race with the processor removing/updating the head item.
let queueLock = Promise.resolve();
function mutateQueue(mutator) {
  const run = async () => {
    const { queue = [] } = await getLocal('queue');
    const result = await mutator(queue);
    await setLocal({ queue });
    return result;
  };
  const p = queueLock.then(run, run);
  queueLock = p.catch(() => {});
  return p;
}

async function getSettings() {
  const { settings } = await getLocal('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function appendLog(entry) {
  const { log = [] } = await getLocal('log');
  log.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), ...entry });
  await setLocal({ log: log.slice(0, LOG_LIMIT) });
}

function hashCode(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------- mapping

async function loadBuiltinMapping() {
  if (builtinMapping) return builtinMapping;
  const res = await fetch(chrome.runtime.getURL('data/mapping.json'));
  builtinMapping = await res.json();
  return builtinMapping;
}

function entryFromCompact(problemId, c) {
  return { problemId, slug: c.s, num: c.n, questionId: c.q, premium: !!c.p, title: c.t, fixes: c.f || null, topic: c.k || null };
}

// LeetCode slug -> NeetCode mapping entry (bundled + live-resolved)
async function resolveByLeetCodeSlug(lcSlug) {
  const builtin = await loadBuiltinMapping();
  const { mappingExtra = {} } = await getLocal('mappingExtra');
  for (const [nc, c] of Object.entries({ ...mappingExtra, ...builtin })) {
    if (c.s === lcSlug) return entryFromCompact(nc, c);
  }
  return null;
}

// NeetCode's getCompletedProblems answers with LeetCode links grouped by list/topic, e.g.
// { "Arrays & Hashing": ["contains-duplicate/", "two-sum/"], ... }. Collect every string in the
// structure, normalise it to a slug and translate LeetCode slugs to NeetCode slugs.
async function completedToIds(raw) {
  const builtin = await loadBuiltinMapping();
  const { mappingExtra = {} } = await getLocal('mappingExtra');
  const all = { ...mappingExtra, ...builtin };
  const byLc = {};
  for (const [nc, c] of Object.entries(all)) byLc[c.s] = nc;

  const strings = [];
  const walk = (x, depth) => {
    if (x == null || depth > 4) return;
    if (typeof x === 'string') strings.push(x);
    else if (Array.isArray(x)) x.forEach((v) => walk(v, depth + 1));
    else if (typeof x === 'object') Object.values(x).forEach((v) => walk(v, depth + 1));
  };
  walk(raw, 0);

  const ids = new Set();
  const unknown = new Set();
  for (const s0 of strings) {
    const s = String(s0).trim().replace(/^https?:\/\/[^/]+/, '').replace(/^\/?problems\//, '').replace(/^\//, '')
      .split(/[?#]/)[0].replace(/\/+$/, '');
    if (!s) continue;
    if (byLc[s]) ids.add(byLc[s]);
    else if (all[s]) ids.add(s);
    else unknown.add(s);
  }
  return { ids: [...ids], unknown: [...unknown] };
}

// The practice checkbox is on only for this exact URL. A leftover "<slug>/" does not count:
// unticking removes the full URL and leaves the short one in place.
function lcRoadmapLink(slug) {
  return `https://leetcode.com/problems/${String(slug || '').replace(/^\/+|\/+$/g, '')}/`;
}

function roadmapTickedSlugs(raw) {
  const strings = [];
  const walk = (x, depth) => {
    if (x == null || depth > 4) return;
    if (typeof x === 'string') strings.push(x);
    else if (Array.isArray(x)) x.forEach((v) => walk(v, depth + 1));
    else if (typeof x === 'object') Object.values(x).forEach((v) => walk(v, depth + 1));
  };
  walk(raw, 0);
  const slugs = new Set();
  for (const s0 of strings) {
    const m = /^https:\/\/leetcode\.com\/problems\/([^/?#]+)\/$/.exec(String(s0).trim());
    if (m) slugs.add(m[1]);
  }
  return slugs;
}

// NeetCode language id <- LeetCode slug (for starter-code lookups)
const LC2NC = Object.fromEntries(Object.entries(LANG_MAP).map(([nc, lc]) => [lc, nc]));

// Signature fix for one problem/language: bundled -> cached live result -> computed live from
// NeetCode's starter code and LeetCode's snippet -> heuristic (JS/TS only).
async function resolveFix(item) {
  const { problemId, lcLang } = item;
  const bundled = item.map.fixes && item.map.fixes[lcLang];
  if (bundled) return { fix: bundled, source: 'bundled' };
  const { fixExtra = {} } = await getLocal('fixExtra');
  const cached = fixExtra[problemId] && fixExtra[problemId][lcLang];
  if (cached !== undefined) return { fix: cached, source: 'cache' };

  let fix = null;
  try {
    const [ncStarter, lcSnippet] = await Promise.all([
      fetchNeetCodeStarter(problemId, LC2NC[lcLang]),
      fetchLeetCodeSnippet(item.map.slug, lcLang),
    ]);
    fix = computeFix(ncStarter, lcSnippet, lcLang);
    if (fix && !fix.r && !fix.w) fix = null;
    if (ncStarter && lcSnippet) {
      fixExtra[problemId] = { ...(fixExtra[problemId] || {}), [lcLang]: fix };
      await setLocal({ fixExtra });
      return { fix, source: 'live' };
    }
  } catch (err) {
    console.warn('[neetbridge] live signature check failed', err);
  }
  return { fix: guessFix(item.code, lcLang), source: 'guess' };
}

async function fetchNeetCodeStarter(problemId, ncLang) {
  if (!ncLang) return null;
  let starter = null;
  try {
    const res = await fetch(NC_META, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { problemId } }) });
    const j = await res.json();
    const d = (j && (j.data || j.result)) || {};
    starter = d.starterCode && d.starterCode[ncLang];
  } catch { /* ignore */ }
  if (!starter) {
    // Pro-only problems hide the starter from anonymous calls; ask a logged-in NeetCode tab.
    const tabs = await chrome.tabs.query({ url: 'https://neetcode.io/*' });
    for (const t of tabs) {
      try {
        const r = await chrome.tabs.sendMessage(t.id, { type: 'N2L_GET_STARTER', problemId, lang: ncLang });
        if (r && r.starter) { starter = r.starter; break; }
      } catch { /* tab without content script */ }
    }
  }
  return starter || null;
}

async function fetchLeetCodeSnippet(slug, lcLang) {
  const tabId = await getLeetCodeTabId();
  const r = await runInTab(tabId, lcSnippetInPage, { slug, lcLang });
  return (r && r.ok && r.code) || null;
}

// Fetch LeetCode's problem list. The service worker fetch normally carries the user's cookies
// (host permission); if it comes back anonymous and a leetcode.com tab is open, ask that tab.
async function fetchLcAll() {
  let j = null;
  try {
    const res = await fetch(LC_ALL, { credentials: 'include', cache: 'no-store' });
    if (res.ok) j = await res.json();
  } catch { /* fall through to the tab */ }
  if (j && j.user_name) return j;
  const tabs = await chrome.tabs.query({ url: 'https://leetcode.com/*' });
  const tab = tabs.find((t) => t.status === 'complete' && !t.discarded);
  if (tab) {
    try {
      const viaTab = await runInTab(tab.id, lcFetchAllInPage, {});
      if (viaTab && viaTab.ok) return viaTab.json;
    } catch { /* ignore */ }
  }
  if (!j) throw new Error('LeetCode problem list could not be fetched');
  return j;
}

async function getLcIndex(force = false) {
  if (!force && lcIndexCache && Date.now() - lcIndexCache.at < 10 * 60_000) return lcIndexCache;
  const j = await fetchLcAll();
  const byNorm = {}, byNum = {}, bySlug = {};
  for (const x of j.stat_status_pairs || []) {
    const s = x.stat;
    const e = { slug: s.question__title_slug, num: s.frontend_question_id, questionId: s.question_id,
      premium: !!x.paid_only, title: s.question__title, status: x.status };
    byNorm[norm(e.title)] = e; byNum[e.num] = e; bySlug[e.slug] = e;
  }
  lcIndexCache = { at: Date.now(), userName: j.user_name || '', numSolved: j.num_solved || 0, byNorm, byNum, bySlug };
  return lcIndexCache;
}

// Live fallback for problems missing from the bundled mapping: NeetCode's public metadata
// endpoint gives the LeetCode title; the video title ("... - Leetcode 1 - ...") is the backup.
async function resolveLive(problemId) {
  let meta = null;
  try {
    const res = await fetch(NC_META, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { problemId } }) });
    const j = await res.json();
    meta = (j && (j.data || j.result)) || null;
  } catch { /* offline or blocked */ }
  if (!meta) return null;

  const idx = await getLcIndex();
  let hit = meta.name ? idx.byNorm[norm(meta.name)] : null;
  if (!hit) {
    const vid = /embed\/([\w-]+)/.exec(meta.video || '');
    if (vid) {
      try {
        const o = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid[1]}&format=json`).then((r) => r.json());
        const m = /leetcode\s*#?\s*(\d+)/i.exec(o.title || '');
        if (m) hit = idx.byNum[Number(m[1])];
      } catch { /* ignore */ }
    }
  }
  if (!hit) return null;
  const entry = { problemId, slug: hit.slug, num: hit.num, questionId: hit.questionId, premium: hit.premium, title: hit.title };
  const { mappingExtra = {} } = await getLocal('mappingExtra');
  mappingExtra[problemId] = { s: entry.slug, n: entry.num, q: entry.questionId, p: entry.premium ? 1 : 0, t: entry.title };
  await setLocal({ mappingExtra });
  return entry;
}

async function resolveMapping(problemId) {
  const builtin = await loadBuiltinMapping();
  if (builtin[problemId]) return entryFromCompact(problemId, builtin[problemId]);
  const { mappingExtra = {} } = await getLocal('mappingExtra');
  if (mappingExtra[problemId]) return entryFromCompact(problemId, mappingExtra[problemId]);
  return resolveLive(problemId);
}

// ---------------------------------------------------------------- queue

async function enqueue(raw, source, { dryRun = false } = {}) {
  const settings = await getSettings();
  const problemId = String(raw.problemId || '');
  const lcLang = LANG_MAP[String(raw.lang || '').toLowerCase()];
  if (!problemId || typeof raw.code !== 'string' || !raw.code.trim()) return { reason: 'Empty submission, ignored.' };
  if (!lcLang) return { reason: `Language "${raw.lang}" is not supported on LeetCode.`, level: 'warn' };

  const map = await resolveMapping(problemId);
  if (!map) {
    await appendLog({ problemId, lang: lcLang, source, status: 'Unmapped', detail: 'No LeetCode problem found for this NeetCode problem.' });
    return { reason: `No LeetCode equivalent found for "${problemId}".`, level: 'warn' };
  }
  const label = `#${map.num} ${map.title}`;
  if (map.premium && !settings.allowPremium) {
    await appendLog({ problemId, lang: lcLang, source, status: 'Skipped (premium)', title: map.title, num: map.num, slug: map.slug });
    return { reason: `${label} is LeetCode Premium - skipped (enable in settings if you have Premium).`, level: 'gold' };
  }

  const key = `${problemId}|${lcLang}|${hashCode(raw.code)}`;
  const { synced = {} } = await getLocal('synced');
  if (!settings.resubmitIdentical && synced[key] && synced[key].status === 'Accepted') {
    return { reason: `${label}: identical code already accepted on LeetCode.`, level: 'info', duplicate: true };
  }

  if (source === 'bulk' && settings.bulkSkipAcceptedOnLeetCode) {
    try {
      const idx = await getLcIndex();
      const st = idx.bySlug[map.slug];
      if (st && st.status === 'ac') {
        return { reason: `${label} already accepted on LeetCode.`, level: 'info', duplicate: true };
      }
    } catch { /* if the check fails, just submit */ }
  }

  if (dryRun) {
    await appendLog({ problemId, lang: lcLang, source, status: 'Dry run', title: map.title, num: map.num, slug: map.slug,
      detail: `would submit ${raw.code.length} chars of ${lcLang}` });
    return { queued: true, dryRun: true, title: label };
  }

  const added = await mutateQueue((queue) => {
    if (queue.some((q) => q.key === key)) return false;
    queue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      key, problemId, source, lcLang, code: raw.code, at: raw.at || Date.now(), attempts: 0,
      map: { slug: map.slug, num: map.num, questionId: map.questionId, title: map.title, premium: map.premium, fixes: map.fixes || null },
    });
    return true;
  });
  if (!added) return { reason: `${label} is already queued.`, level: 'info', duplicate: true };
  processQueue();
  return { queued: true, title: label };
}

// LeetCode -> NeetCode. `raw` = {slug, lang (LeetCode slug), code, ...}
async function enqueueReverse(raw, source, { dryRun = false, level = null, retick = false } = {}) {
  const settings = await getSettings();
  const mode = level || settings.lc2nc;
  if (!mode || mode === 'off') return { reason: 'LeetCode -> NeetCode sync is off.', level: 'silent' };
  const lcSlug = String(raw.slug || '');
  if (!lcSlug || typeof raw.code !== 'string' || !raw.code.trim()) return { reason: 'Empty submission, ignored.', level: 'silent' };

  const map = await resolveByLeetCodeSlug(lcSlug);
  if (!map) return { reason: `${lcSlug} is not on NeetCode.`, level: 'silent' };
  const label = `#${map.num} ${map.title}`;
  const ncLang = LC2NC[String(raw.lang || '').toLowerCase()];
  if (mode === 'submit' && !ncLang) {
    await appendLog({ problemId: map.problemId, lang: raw.lang, source, direction: 'lc2nc', status: 'Skipped (language)', title: map.title, num: map.num, slug: map.slug,
      detail: `NeetCode has no ${raw.lang} judge; only the roadmap tick will be applied.` });
  }

  const key = `lc2nc|${map.problemId}|${ncLang || 'mark'}|${mode === 'submit' && ncLang ? hashCode(raw.code) : 'mark'}`;
  const { synced = {} } = await getLocal('synced');
  if (!retick && !settings.resubmitIdentical && synced[key] && synced[key].status === 'Accepted') {
    return { reason: `${label}: already synced to NeetCode.`, level: 'info', duplicate: true };
  }
  if (dryRun) {
    await appendLog({ problemId: map.problemId, lang: raw.lang, source, direction: 'lc2nc', status: 'Dry run', title: map.title, num: map.num, slug: map.slug,
      detail: mode === 'submit' && ncLang ? `would submit ${raw.code.length} chars of ${ncLang} to NeetCode and tick ${map.topic || '?'}` : `would tick ${map.topic || '?'} on NeetCode` });
    return { queued: true, dryRun: true, title: label };
  }

  const added = await mutateQueue((queue) => {
    if (queue.some((q) => q.key === key)) return false;
    queue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      key, direction: 'lc2nc', mode: mode === 'submit' && ncLang ? 'submit' : 'mark',
      problemId: map.problemId, source, lcLang: raw.lang, ncLang, code: raw.code, at: raw.at || Date.now(), attempts: 0,
      map: { slug: map.slug, num: map.num, questionId: map.questionId, title: map.title, premium: map.premium, fixes: map.fixes || null, topic: map.topic },
    });
    return true;
  });
  if (!added) return { reason: `${label} is already queued.`, level: 'info', duplicate: true };
  processQueue();
  return { queued: true, title: label };
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      const st = await getLocal(['queue', 'paused', 'lastSubmitAt']);
      if (st.paused) break;
      const queue = st.queue || [];
      const item = queue[0];
      if (!item) break;

      const settings = await getSettings();
      const gapMs = Math.max(10, Number(settings.delaySec) || 30) * 1000;
      const readyAt = Math.max((st.lastSubmitAt || 0) + gapMs, item.notBefore || 0);
      const wait = item.inFlight ? 0 : readyAt - Date.now();
      if (wait > 0) {
        if (wait <= 25_000) { await sleep(wait); continue; }
        await chrome.alarms.create(ALARM, { when: Date.now() + wait });
        break;
      }

      const outcome = item.direction === 'lc2nc' ? await handleReverseItem(item) : await handleItem(item);
      if (outcome === 'paused') break;
      await mutateQueue((queue) => {
        const idx = queue.findIndex((q) => q.id === item.id);
        if (idx < 0) return;
        if (outcome === 'retry') queue[idx] = item;
        else queue.splice(idx, 1);
      });
    }
  } catch (err) {
    console.error('[neetbridge] queue error', err);
    await appendLog({ status: 'Error', detail: `${String((err && err.message) || err)} - retrying in 1 min` });
    await chrome.alarms.create(ALARM, { when: Date.now() + 60_000 });
  } finally {
    processing = false;
  }
}

async function pauseQueue(reason) {
  await setLocal({ paused: reason });
  await appendLog({ status: 'Paused', detail: reason });
}

// Returns 'done' | 'retry' | 'paused'. Mutates item for retry/inFlight bookkeeping.
async function handleItem(item) {
  const { slug, questionId, num, title } = item.map;
  const label = `LeetCode #${num} ${title}`;
  let tabId;
  try {
    tabId = await getLeetCodeTabId();
  } catch (err) {
    await pauseQueue(`Could not open a leetcode.com tab: ${err.message}`);
    return 'paused';
  }

  let submissionId = item.inFlight && item.inFlight.submissionId;
  let fixNotes = [];
  if (!submissionId) {
    let code = item.code;
    try {
      const { fix } = await resolveFix(item);
      const applied = applyFix(item.code, item.lcLang, fix);
      code = applied.code;
      fixNotes = applied.notes;
    } catch (err) {
      console.warn('[neetbridge] signature fix skipped', err);
    }
    const r = await runInTab(tabId, lcSubmitInPage, { slug, questionId, lang: item.lcLang, code });
    await setLocal({ lastSubmitAt: Date.now() });
    if (!r.ok) {
      if (r.error === 'not-logged-in' || r.error === 'no-csrf') {
        await pauseQueue('Not logged in on LeetCode. Log in at leetcode.com, then press Resume in the popup.');
        return 'paused';
      }
      if ((r.retry || r.error === 'network') && item.attempts < 3) {
        item.attempts += 1;
        item.notBefore = Date.now() + 60_000 * item.attempts;
        await appendLog({ ...logBase(item), status: 'Retry scheduled', detail: `${r.error}: ${r.detail || ''}`.trim() });
        return 'retry';
      }
      await appendLog({ ...logBase(item), status: 'Submit failed', detail: `${r.error}${r.status ? ' HTTP ' + r.status : ''}: ${r.detail || ''}`.trim() });
      await notifySites(`${label}: submit failed (${r.error})`, 'error');
      return 'done';
    }
    submissionId = r.submissionId;
    item.inFlight = { submissionId, at: Date.now(), fixNotes };
    await mutateQueue((queue) => {
      const idx = queue.findIndex((q) => q.id === item.id);
      if (idx >= 0) queue[idx] = item;
    });
  }

  let verdict = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const c = await runInTab(tabId, lcCheckInPage, { submissionId, budgetMs: 20_000, intervalMs: 1500 });
    if (c.done) { verdict = c; break; }
  }

  const url = `https://leetcode.com/submissions/detail/${submissionId}/`;
  const status = verdict ? (verdict.ok ? verdict.statusMsg : verdict.error) : 'Timed out waiting for verdict';
  const notes = (item.inFlight && item.inFlight.fixNotes) || fixNotes || [];
  const detail = verdict && verdict.ok
    ? [verdict.compileError, verdict.runtimeError, verdict.totalTestcases != null ? `${verdict.totalCorrect}/${verdict.totalTestcases} test cases` : null,
      verdict.runtime ? `runtime ${verdict.runtime}` : null, ...notes].filter(Boolean).join(' | ')
    : notes.join(' | ');
  await appendLog({ ...logBase(item), status, detail, submissionId, url });

  const { synced = {} } = await getLocal('synced');
  synced[item.key] = { status, submissionId, at: Date.now() };
  await setLocal({ synced });

  const ok = status === 'Accepted';
  await notifySites(`${label}: ${status}`, ok ? 'ok' : 'error', url);
  await notifyDesktop(ok, label, status, detail, url);
  return 'done';
}

// LeetCode -> NeetCode: optional judge submission, then tick the roadmap. Returns like handleItem.
async function handleReverseItem(item) {
  const { num, title, topic, slug } = item.map;
  const label = `NeetCode ${title}`;
  const problemUrl = `https://neetcode.io/problems/${item.problemId}`;
  let tabId;
  try {
    tabId = await getNeetCodeTabId();
  } catch (err) {
    await pauseQueue(`Could not open a neetcode.io tab: ${err.message}`);
    return 'paused';
  }
  await setLocal({ lastSubmitAt: Date.now() });

  const parts = [];
  let status = 'Accepted';
  if (item.mode === 'submit') {
    let code = item.code;
    let notes = [];
    try {
      const fix = await resolveReverseFix(item);
      const applied = applyFix(item.code, item.lcLang, fix);
      code = applied.code;
      notes = applied.notes;
    } catch (err) {
      console.warn('[neetbridge] reverse signature fix skipped', err);
    }
    let r;
    try {
      r = await chrome.tabs.sendMessage(tabId, { type: 'N2L_NC_SUBMIT', problemId: item.problemId, lang: item.ncLang, code });
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err) };
    }
    if (!r || !r.ok) {
      const msg = (r && r.error) || 'no response';
      if (/logged in|session/i.test(msg)) {
        await pauseQueue('Not logged in on NeetCode. Log in at neetcode.io, then press Resume in the popup.');
        return 'paused';
      }
      if (item.attempts < 2) {
        item.attempts += 1;
        item.notBefore = Date.now() + 60_000 * item.attempts;
        await appendLog({ ...logBaseReverse(item), status: 'Retry scheduled', detail: msg });
        return 'retry';
      }
      status = 'Submit failed';
      parts.push(msg);
    } else {
      status = r.status || 'Unknown';
      if (r.testCases != null) parts.push(`${r.correct ?? '?'}/${r.testCases} NeetCode test cases`);
      if (r.error) parts.push(String(r.error).slice(0, 300));
      parts.push(...notes);
    }
  }

  // Tick the roadmap regardless of the judge result (the LeetCode verdict was Accepted).
  if (topic) {
    try {
      // Practice checkboxes compare this full URL, not the short "<slug>/" form.
      const m = await chrome.tabs.sendMessage(tabId, { type: 'N2L_NC_MARK', topic, link: lcRoadmapLink(slug) });
      parts.push(m && m.ok ? `ticked in ${topic}` : `tick failed: ${(m && m.error) || 'no response'}`);
    } catch (err) {
      parts.push(`tick failed: ${String((err && err.message) || err)}`);
    }
  } else {
    parts.push('no topic known, roadmap not ticked');
  }

  const detail = parts.filter(Boolean).join(' | ');
  await appendLog({ ...logBaseReverse(item), status, detail, url: problemUrl });
  const { synced = {} } = await getLocal('synced');
  synced[item.key] = { status, at: Date.now() };
  await setLocal({ synced });

  const ok = status === 'Accepted';
  await notifySites(`${label}: ${item.mode === 'submit' ? status : 'ticked'}`, ok ? 'ok' : 'error', problemUrl);
  await notifyDesktop(ok, `${label} (#${num})`, item.mode === 'submit' ? `${status} on NeetCode` : 'Ticked on NeetCode', detail, problemUrl);
  return 'done';
}

const logBaseReverse = (item) => ({ problemId: item.problemId, lang: item.ncLang || item.lcLang, source: item.source, direction: 'lc2nc',
  title: item.map.title, num: item.map.num, slug: item.map.slug });

async function resolveReverseFix(item) {
  const lang = item.lcLang;
  const bundled = item.map.fixes && item.map.fixes[lang];
  if (bundled) return reverseFix(bundled);
  const { fixExtra = {} } = await getLocal('fixExtra');
  const cached = fixExtra[item.problemId] && fixExtra[item.problemId][lang];
  if (cached !== undefined) return reverseFix(cached);
  try {
    const [ncStarter, lcSnippet] = await Promise.all([fetchNeetCodeStarter(item.problemId, item.ncLang), fetchLeetCodeSnippet(item.map.slug, lang)]);
    let fix = computeFix(ncStarter, lcSnippet, lang);
    if (fix && !fix.r && !fix.w && !fix.u) fix = null;
    if (ncStarter && lcSnippet) {
      fixExtra[item.problemId] = { ...(fixExtra[item.problemId] || {}), [lang]: fix };
      await setLocal({ fixExtra });
      return reverseFix(fix);
    }
  } catch (err) {
    console.warn('[neetbridge] live reverse signature check failed', err);
  }
  return guessReverseFix(item.code, lang);
}


async function getNeetCodeTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://neetcode.io/*' });
  let tab = tabs.find((t) => t.status === 'complete' && !t.discarded) || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://neetcode.io/practice', active: false });
    await waitTabComplete(tab.id);
    await sleep(3000);
  } else if (tab.discarded || tab.status !== 'complete') {
    if (tab.discarded) await chrome.tabs.reload(tab.id);
    await waitTabComplete(tab.id);
    await sleep(2000);
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'N2L_PING' });
  } catch {
    await chrome.tabs.reload(tab.id);
    await waitTabComplete(tab.id);
    await sleep(3000);
    await chrome.tabs.sendMessage(tab.id, { type: 'N2L_PING' });
  }
  return tab.id;
}

// Reverse bulk: every problem accepted on LeetCode that exists on NeetCode and is not ticked there yet.
let reverseAbort = false;
async function startReverseBulk(options = {}) {
  reverseAbort = false;
  await setLocal({ bulk: { running: true, phase: 'starting', direction: 'lc2nc', done: 0, total: 0, found: 0, queued: 0,
    dryRun: !!options.dryRun, startedAt: Date.now(), error: null } });
  try {
    const idx = await getLcIndex(true);
    if (!idx.userName) throw new Error('Not logged in on LeetCode.');
    const accepted = Object.values(idx.bySlug).filter((e) => e.status === 'ac');
    await setLocal({ bulk: { ...(await getLocal('bulk')).bulk, phase: 'collecting', updatedAt: Date.now(), total: accepted.length } });

    // Already ticked means the practice checkbox URL is stored. A short "<slug>/" left
    // behind after an untick does not light that checkbox, so it must be ticked again.
    let ticked = new Set();
    try {
      const tabId = await getNeetCodeTabId();
      const c = await chrome.tabs.sendMessage(tabId, { type: 'N2L_NC_COMPLETED' });
      if (c && c.ok) ticked = roadmapTickedSlugs(c.raw);
    } catch (err) {
      console.warn('[neetbridge] could not read NeetCode progress', err);
    }

    const settings = await getSettings();
    const mode = options.level || (settings.lc2nc === 'off' ? 'mark' : settings.lc2nc);
    let found = 0;
    let n = 0;
    for (const e of accepted) {
      if (reverseAbort) break;
      n += 1;
      const map = await resolveByLeetCodeSlug(e.slug);
      if (!map || ticked.has(map.slug)) continue;
      found += 1;
      let code = null;
      let lang = 'python3';
      if (mode === 'submit') {
        try {
          const tabId = await getLeetCodeTabId();
          const r = await runInTab(tabId, lcLastAcceptedInPage, { slug: e.slug });
          if (r && r.ok && r.code) { code = r.code; lang = r.lang; }
        } catch (err) {
          console.warn('[neetbridge] could not fetch accepted code for', e.slug, err);
        }
      }
      await enqueueReverse({ slug: e.slug, lang, code: code || '# accepted on LeetCode', at: Date.now() }, 'bulk',
        { dryRun: !!options.dryRun, level: code ? 'submit' : 'mark', retick: true });
      const { bulk = {} } = await getLocal('bulk');
      await setLocal({ bulk: { ...bulk, done: n, found, queued: found, updatedAt: Date.now() } });
    }
    const { bulk = {} } = await getLocal('bulk');
    await setLocal({ bulk: { ...bulk, running: false, phase: reverseAbort ? 'aborted' : 'done', done: n, found } });
  } catch (err) {
    const { bulk = {} } = await getLocal('bulk');
    await setLocal({ bulk: { ...bulk, running: false, phase: 'error', error: String((err && err.message) || err) } });
  }
}

const notificationUrls = new Map();
async function notifyDesktop(ok, label, status, detail, url) {
  const settings = await getSettings();
  if (!settings.notify || !chrome.notifications) return;
  try {
    const id = `n2l-${Date.now()}`;
    notificationUrls.set(id, url);
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `${ok ? '✅' : '❌'} ${status} on LeetCode`,
      message: [label, detail].filter(Boolean).join(' - '),
      priority: ok ? 0 : 1,
    });
  } catch (err) {
    console.warn('[neetbridge] notification failed', err);
  }
}

if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((id) => {
    const url = notificationUrls.get(id);
    if (url) chrome.tabs.create({ url });
    chrome.notifications.clear(id);
  });
}

const logBase = (item) => ({ problemId: item.problemId, lang: item.lcLang, source: item.source,
  title: item.map.title, num: item.map.num, slug: item.map.slug });

// Toast on every open neetcode.io and leetcode.com tab, whichever site the user is looking at.
async function notifySites(text, level, url) {
  const tabs = await chrome.tabs.query({ url: ['https://neetcode.io/*', 'https://leetcode.com/*'] });
  await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'N2L_RESULT', text, level, url }).catch(() => {})));
}

// ---------------------------------------------------------------- LeetCode tab

function waitTabComplete(tabId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => { if (finished) return; finished = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') done(); }).catch(done);
    setTimeout(done, timeoutMs);
  });
}

async function getLeetCodeTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://leetcode.com/*' });
  const tab = tabs.find((t) => t.status === 'complete' && !t.discarded) || tabs.find((t) => !t.discarded) || tabs[0];
  if (tab) {
    if (tab.discarded) { await chrome.tabs.reload(tab.id); }
    await waitTabComplete(tab.id);
    return tab.id;
  }
  const created = await chrome.tabs.create({ url: 'https://leetcode.com/problemset/', active: false });
  await waitTabComplete(created.id);
  await sleep(1000);
  return created.id;
}

async function runInTab(tabId, func, arg) {
  const exec = () => chrome.scripting.executeScript({ target: { tabId }, func, args: [arg] });
  let results;
  try {
    results = await exec();
  } catch (err) {
    // Tab was discarded / mid-navigation: reload once and retry.
    await chrome.tabs.reload(tabId);
    await waitTabComplete(tabId);
    await sleep(1000);
    results = await exec();
  }
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error('No result from the leetcode.com tab');
  return r;
}

// --- functions below are serialised and executed inside the leetcode.com tab (isolated world).
//     They must be self-contained: no references to anything outside their own body.

function lcSubmitInPage(p) {
  return (async () => {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    const csrf = m && m[1];
    if (!csrf) return { ok: false, error: 'no-csrf' };
    let res;
    try {
      res = await fetch(`https://leetcode.com/problems/${p.slug}/submit/`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrftoken': csrf },
        body: JSON.stringify({ lang: p.lang, question_id: String(p.questionId), typed_code: p.code }),
      });
    } catch (e) {
      return { ok: false, error: 'network', detail: String(e) };
    }
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* html or empty */ }
    if (res.status === 403) return { ok: false, error: 'not-logged-in', detail: text.slice(0, 200) };
    if (res.status === 429) return { ok: false, error: 'rate-limited', retry: true, detail: text.slice(0, 200) };
    if (!res.ok || !j || !j.submission_id) {
      return { ok: false, error: 'submit-failed', status: res.status, retry: res.status >= 500, detail: text.slice(0, 300) };
    }
    return { ok: true, submissionId: j.submission_id };
  })();
}

function lcFetchAllInPage() {
  return (async () => {
    try {
      const r = await fetch('https://leetcode.com/api/problems/all/', { credentials: 'include', cache: 'no-store' });
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, json: await r.json() };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })();
}

function lcSnippetInPage(p) {
  return (async () => {
    try {
      const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
      const r = await fetch('https://leetcode.com/graphql', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrftoken': (m && m[1]) || '' },
        body: JSON.stringify({
          query: 'query q($s: String!) { question(titleSlug: $s) { codeSnippets { langSlug code } } }',
          variables: { s: p.slug },
        }),
      });
      const j = await r.json();
      const snippets = (j && j.data && j.data.question && j.data.question.codeSnippets) || [];
      const hit = snippets.find((c) => c.langSlug === p.lcLang);
      return { ok: true, code: hit ? hit.code : null };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })();
}

function lcLastAcceptedInPage(p) {
  return (async () => {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    const headers = { 'content-type': 'application/json', 'x-csrftoken': (m && m[1]) || '' };
    const gql = async (query, variables) => {
      const r = await fetch('https://leetcode.com/graphql', { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ query, variables }) });
      return r.json();
    };
    try {
      const list = await gql('query l($s: String!, $o: Int!, $n: Int!) { questionSubmissionList(questionSlug: $s, offset: $o, limit: $n) { submissions { id statusDisplay lang } } }',
        { s: p.slug, o: 0, n: 20 });
      const subs = (list && list.data && list.data.questionSubmissionList && list.data.questionSubmissionList.submissions) || [];
      const acc = subs.find((x) => x.statusDisplay === 'Accepted');
      if (!acc) return { ok: false, error: 'no accepted submission' };
      const det = await gql('query d($id: Int!) { submissionDetails(submissionId: $id) { code lang { name } } }', { id: Number(acc.id) });
      const d = det && det.data && det.data.submissionDetails;
      if (!d || !d.code) return { ok: false, error: 'no code' };
      return { ok: true, code: d.code, lang: (d.lang && d.lang.name) || acc.lang, submissionId: acc.id };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })();
}

function lcCheckInPage(p) {
  return (async () => {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    const csrf = (m && m[1]) || '';
    const start = Date.now();
    while (Date.now() - start < p.budgetMs) {
      try {
        const r = await fetch(`https://leetcode.com/submissions/detail/${p.submissionId}/check/`, {
          credentials: 'include', headers: { 'x-csrftoken': csrf },
        });
        if (r.status === 403) return { done: true, ok: false, error: 'not-logged-in' };
        const j = await r.json();
        if (j.state === 'SUCCESS') {
          return {
            done: true, ok: true,
            statusMsg: j.status_msg, statusCode: j.status_code, runtime: j.status_runtime, memory: j.status_memory,
            totalCorrect: j.total_correct, totalTestcases: j.total_testcases, prettyLang: j.pretty_lang,
            compileError: j.full_compile_error || j.compile_error || null,
            runtimeError: j.full_runtime_error || j.runtime_error || null,
          };
        }
      } catch { /* transient, keep polling */ }
      await new Promise((r) => setTimeout(r, p.intervalMs));
    }
    return { done: false };
  })();
}

// ---------------------------------------------------------------- bulk

async function startBulk(options = {}) {
  await setLocal({ bulk: { running: true, phase: 'starting', done: 0, total: 0, found: 0, queued: 0,
    dryRun: !!options.dryRun, startedAt: Date.now(), error: null } });
  let tabs = await chrome.tabs.query({ url: 'https://neetcode.io/*' });
  let tab = tabs.find((t) => t.status === 'complete' && !t.discarded) || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://neetcode.io/practice', active: false });
    await waitTabComplete(tab.id);
    await sleep(3000); // let NeetCode's app + Firebase auth initialise
  } else if (tab.discarded || tab.status !== 'complete') {
    if (tab.discarded) await chrome.tabs.reload(tab.id);
    await waitTabComplete(tab.id);
    await sleep(2000);
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'N2L_PING' });
  } catch {
    await chrome.tabs.reload(tab.id);
    await waitTabComplete(tab.id);
    await sleep(3000);
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'N2L_COLLECT', options });
  } catch (err) {
    await setLocal({ bulk: { running: false, phase: 'error', error: `Could not reach the NeetCode tab: ${err.message}` } });
  }
}

async function abortBulk() {
  reverseAbort = true;
  const tabs = await chrome.tabs.query({ url: 'https://neetcode.io/*' });
  await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'N2L_BULK_ABORT' }).catch(() => {})));
  const { bulk = {} } = await getLocal('bulk');
  await setLocal({ bulk: { ...bulk, running: false, phase: 'aborted' } });
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'N2L_ACCEPTED': {
        const settings = await getSettings();
        if (!settings.enabled) return { reason: 'neetbridge is paused (enable it in the popup).', level: 'info' };
        return enqueue(msg, 'live');
      }
      case 'N2L_LC_ACCEPTED':
        return enqueueReverse(msg, 'live');
      case 'startReverseBulk': {
        startReverseBulk(msg.options || {});
        return { ok: true };
      }
      case 'N2L_ENQUEUE': {
        const { bulk: before = {} } = await getLocal('bulk');
        let queued = 0;
        for (const it of msg.items || []) {
          const r = await enqueue(it, msg.source || 'bulk', { dryRun: !!(msg.dryRun || before.dryRun) });
          if (r.queued) queued += 1;
        }
        const { bulk = {} } = await getLocal('bulk');
        await setLocal({ bulk: { ...bulk, queued: (bulk.queued || 0) + queued } });
        return { queued };
      }
      case 'N2L_COMPLETED_TO_IDS':
        return completedToIds(msg.raw);
      case 'N2L_BULK_PROGRESS': {
        const { bulk = {} } = await getLocal('bulk');
        await setLocal({ bulk: { ...bulk, running: true, phase: msg.phase, updatedAt: Date.now(),
          done: msg.done ?? bulk.done, total: msg.total ?? bulk.total, found: msg.found ?? bulk.found } });
        return { ok: true };
      }
      case 'N2L_BULK_DONE': {
        const { bulk = {} } = await getLocal('bulk');
        await setLocal({ bulk: { ...bulk, running: false, phase: msg.error ? 'error' : (msg.aborted ? 'aborted' : 'done'),
          error: msg.error || null, done: msg.scanned ?? bulk.done, found: msg.found ?? bulk.found } });
        processQueue();
        return { ok: true };
      }
      case 'getState': {
        const st = await getLocal(['queue', 'paused', 'log', 'bulk']);
        if (st.bulk && st.bulk.running && Date.now() - (st.bulk.updatedAt || st.bulk.startedAt || 0) > 3 * 60_000) {
          st.bulk = { ...st.bulk, running: false, phase: 'error', error: 'No progress from the NeetCode tab for 3 minutes (tab closed or navigated away?). Start again.' };
          await setLocal({ bulk: st.bulk });
        }
        return { settings: await getSettings(), queueCount: (st.queue || []).length,
          queueHead: (st.queue || []).slice(0, 5).map((q) => ({ num: q.map.num, title: q.map.title, source: q.source, direction: q.direction || 'nc2lc' })),
          paused: st.paused || null, log: (st.log || []).slice(0, 300), bulk: st.bulk || null };
      }
      case 'setSettings': {
        const merged = { ...(await getSettings()), ...(msg.settings || {}) };
        merged.delaySec = Math.max(10, Number(merged.delaySec) || 30);
        if (!['off', 'mark', 'submit'].includes(merged.lc2nc)) merged.lc2nc = 'mark';
        await setLocal({ settings: merged });
        return { settings: merged };
      }
      case 'checkLeetCode': {
        try {
          const idx = await getLcIndex(true);
          return { loggedIn: !!idx.userName, userName: idx.userName, numSolved: idx.numSolved };
        } catch (err) {
          return { loggedIn: false, error: err.message };
        }
      }
      case 'checkNeetCode': {
        const tabs = await chrome.tabs.query({ url: 'https://neetcode.io/*' });
        if (!tabs.length) return { loggedIn: false, noTab: true };
        let stale = false;
        for (const t of tabs) {
          try {
            const r = await chrome.tabs.sendMessage(t.id, { type: 'N2L_PING' });
            if (r && r.ok && r.loggedIn !== undefined) return { loggedIn: !!r.loggedIn };
            if (r && r.ok) stale = true;   // content script from before the last extension reload
          } catch { stale = true; }
        }
        return { loggedIn: false, stale, error: 'Reload the neetcode.io tab.' };
      }
      case 'resume': {
        await setLocal({ paused: null });
        lcIndexCache = null;
        processQueue();
        return { ok: true };
      }
      case 'clearQueue': {
        await mutateQueue((queue) => { queue.length = 0; });
        await setLocal({ paused: null });
        return { ok: true };
      }
      case 'clearLog': {
        const { bulk } = await getLocal('bulk');
        await setLocal({ log: [], bulk: bulk && bulk.running ? bulk : null });
        return { ok: true };
      }
      case 'clearBulk': {
        const { bulk } = await getLocal('bulk');
        if (!bulk || !bulk.running) await setLocal({ bulk: null });
        return { ok: true };
      }
      case 'startBulk': {
        await startBulk(msg.options || {});
        return { ok: true };
      }
      case 'abortBulk': {
        await abortBulk();
        return { ok: true };
      }
      default:
        return { error: 'unknown message' };
    }
  })().then(sendResponse, (err) => sendResponse({ error: String((err && err.message) || err) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) processQueue(); });
chrome.runtime.onInstalled.addListener(async () => { await setLocal({ settings: await getSettings() }); processQueue(); });
chrome.runtime.onStartup.addListener(() => processQueue());
processQueue();
