// Minimal harness: runs src/background.js under Node with a fake `chrome` API and exercises the
// queue logic end-to-end (live submission, bulk dedupe, login pause + resume, mapping fallback).
//   node test/run.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapping = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'mapping.json'), 'utf8'));

// ----------------------------------------------------------------- fake chrome
const store = {};
const listeners = { message: [], alarm: [] };
const tabs = [{ id: 7, url: 'https://leetcode.com/problemset/', status: 'complete', discarded: false },
  { id: 9, url: 'https://neetcode.io/problems/two-integer-sum', status: 'complete', discarded: false }];
const sentToTabs = [];
const injected = [];
const submitted = [];   // args passed to lcSubmitInPage
const notifications = [];
let lcLoggedIn = true;
let ncCompleted = { 'Arrays & Hashing': ['https://leetcode.com/problems/two-sum/', 'contains-duplicate/'] };
let verdict = 'Accepted';
let ncVerdict = 'Accepted';
let nextSubmissionId = 100;

const LC_PY_CONTAINS = ['class Solution:', '    def containsDuplicate(self, nums: List[int]) -> bool:', '        return len(set(nums)) < len(nums)', ''].join('\n');
const LC_JS_TWO_SUM = ['var twoSum = function(nums, target) {', '    return [0, 1];', '};', ''].join('\n');

const NC_STARTER = ['class Solution:', '    def newBrand(self, x: int) -> int:', '        '].join('\n');
const LC_SNIPPET = ['class Solution:', '    def brandNew(self, x: int) -> int:', '        '].join('\n');
const PY_HAS_DUP = ['class Solution:', '    def hasDuplicate(self, nums):', '        return len(set(nums)) < len(nums)', ''].join('\n');
const JS_TWO_SUM = ['class Solution {', '    twoSum(nums, target) { return [0, 1]; }', '}', ''].join('\n');
const PY_NEW_BRAND = ['class Solution:', '    def newBrand(self, x):', '        return x', ''].join('\n');

global.fetch = async (url, init) => {
  if (String(url).endsWith('data/mapping.json')) return { ok: true, json: async () => mapping };
  if (String(url).includes('leetcode.com/api/problems/all/')) {
    return { ok: true, json: async () => ({ user_name: lcLoggedIn ? 'tester' : '', num_solved: 3, stat_status_pairs: [
      { stat: { question__title: 'Two Sum', question__title_slug: 'two-sum', frontend_question_id: 1, question_id: 1 }, paid_only: false, status: 'ac' },
      { stat: { question__title: 'Contains Duplicate', question__title_slug: 'contains-duplicate', frontend_question_id: 217, question_id: 217 }, paid_only: false, status: 'ac' },
      { stat: { question__title: 'Walls and Gates', question__title_slug: 'walls-and-gates', frontend_question_id: 286, question_id: 286 }, paid_only: true, status: null },
      { stat: { question__title: 'Brand New Problem', question__title_slug: 'brand-new-problem', frontend_question_id: 9999, question_id: 12345 }, paid_only: false, status: null },
    ] }) };
  }
  if (String(url).includes('getProblemMetadataFunctionHttp')) {
    const { problemId } = JSON.parse(init.body).data;
    if (problemId === 'brand-new') return { ok: true, json: async () => ({ data: { name: 'Brand New Problem', video: '', starterCode: { python: NC_STARTER } } }) };
    return { ok: true, json: async () => ({ error: 'nope' }) };
  }
  throw new Error('unexpected fetch ' + url);
};

global.chrome = {
  runtime: {
    getURL: (p) => 'chrome-extension://abc/' + p,
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
  },
  storage: { local: {
    get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in store) out[k] = structuredClone(store[k]); return out; },
    set: async (obj) => { Object.assign(store, structuredClone(obj)); },
  } },
  alarms: { create: async () => {}, onAlarm: { addListener: (fn) => listeners.alarm.push(fn) } },
  notifications: { create: async (id, opts) => { notifications.push({ id, ...opts }); return id; }, clear: async () => {}, onClicked: { addListener: () => {} } },
  tabs: {
    query: async ({ url }) => { const pats = [].concat(url).map((u) => u.replace('*', '')); return tabs.filter((t) => pats.some((p) => t.url.startsWith(p))); },
    get: async (id) => tabs.find((t) => t.id === id),
    create: async ({ url }) => { const t = { id: 50 + tabs.length, url, status: 'complete', discarded: false }; tabs.push(t); return t; },
    reload: async () => {},
    sendMessage: async (id, msg) => {
      sentToTabs.push({ id, msg });
      if (msg.type === 'N2L_NC_SUBMIT') return { ok: true, status: ncVerdict, testCases: 5, correct: ncVerdict === 'Accepted' ? 5 : 3 };
      if (msg.type === 'N2L_NC_COMPLETED') return { ok: true, raw: ncCompleted };
      return { ok: true };
    },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
  },
  scripting: {
    executeScript: async ({ func, args }) => {
      injected.push(func.name);
      if (func.name === 'lcSubmitInPage') {
        submitted.push(args[0]);
        if (!lcLoggedIn) return [{ result: { ok: false, error: 'not-logged-in' } }];
        return [{ result: { ok: true, submissionId: nextSubmissionId++ } }];
      }
      if (func.name === 'lcCheckInPage') {
        return [{ result: { done: true, ok: true, statusMsg: verdict, totalCorrect: 10, totalTestcases: 10, runtime: '40 ms' } }];
      }
      if (func.name === 'lcFetchAllInPage') return [{ result: { ok: false } }];
      if (func.name === 'lcSnippetInPage') return [{ result: { ok: true, code: args[0].slug === 'brand-new-problem' ? LC_SNIPPET : null } }];
      throw new Error('unknown injected function ' + func.name);
    },
  },
};

// Virtual clock: every setTimeout(ms) advances Date.now() by ms but only waits 5 ms for real,
// so the 10 s gap between submissions passes instantly in the test.
const realSetTimeout = global.setTimeout;
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
global.setTimeout = (fn, ms) => { clockOffset += ms || 0; return realSetTimeout(fn, Math.min(ms || 0, 5)); };

await import(pathToFileURL(path.join(ROOT, 'src', 'background.js')).href);
const send = (msg) => new Promise((resolve) => listeners.message[0](msg, {}, resolve));
const settle = () => new Promise((r) => realSetTimeout(r, 150));

(async () => {
  // settings with a short gap
  await send({ type: 'setSettings', settings: { delaySec: 10 } });
  assert.strictEqual((await send({ type: 'getState' })).settings.delaySec, 10);

  // 1. live accepted submission -> submitted, logged, synced
  let r = await send({ type: 'N2L_ACCEPTED', source: 'live', problemId: 'two-integer-sum', lang: 'python', code: 'class Solution: pass' });
  assert.strictEqual(r.queued, true, JSON.stringify(r));
  assert.strictEqual(r.title, '#1 Two Sum');
  await settle();
  let st = await send({ type: 'getState' });
  assert.strictEqual(st.queueCount, 0);
  assert.strictEqual(st.log[0].status, 'Accepted');
  assert.strictEqual(st.log[0].url, 'https://leetcode.com/submissions/detail/100/');
  assert.ok(injected.includes('lcSubmitInPage') && injected.includes('lcCheckInPage'));
  assert.ok(sentToTabs.some((s) => s.id === 9 && s.msg.type === 'N2L_RESULT' && /Accepted/.test(s.msg.text)));
  assert.strictEqual(notifications.length, 1);
  assert.ok(/Accepted on LeetCode/.test(notifications[0].title) && /#1 Two Sum/.test(notifications[0].message), JSON.stringify(notifications[0]));

  // 2. identical code again -> duplicate, not queued
  r = await send({ type: 'N2L_ACCEPTED', source: 'live', problemId: 'two-integer-sum', lang: 'python', code: 'class Solution: pass' });
  assert.strictEqual(r.duplicate, true, JSON.stringify(r));

  // 3. premium skipped by default
  r = await send({ type: 'N2L_ACCEPTED', source: 'live', problemId: 'islands-and-treasure', lang: 'java', code: 'x' });
  assert.ok(/Premium/.test(r.reason), r.reason);

  // 4. unsupported language
  r = await send({ type: 'N2L_ACCEPTED', source: 'live', problemId: 'two-integer-sum', lang: 'sql', code: 'select 1' });
  assert.ok(/not supported/.test(r.reason), r.reason);

  // 5. unknown slug -> live lookup via NeetCode title -> cached in mappingExtra
  r = await send({ type: 'N2L_ACCEPTED', source: 'live', problemId: 'brand-new', lang: 'cpp', code: 'int main(){}' });
  assert.strictEqual(r.title, '#9999 Brand New Problem', JSON.stringify(r));
  assert.strictEqual(store.mappingExtra['brand-new'].q, 12345);
  await settle();

  // 6. unknown slug with no match -> Unmapped
  r = await send({ type: 'N2L_ACCEPTED', source: 'live', problemId: 'does-not-exist', lang: 'cpp', code: 'x' });
  assert.ok(/No LeetCode equivalent/.test(r.reason), r.reason);

  // 7. bulk: already-AC on LeetCode is skipped, others queued, duplicates within the batch collapsed
  r = await send({ type: 'N2L_ENQUEUE', source: 'bulk', items: [
    { problemId: 'two-integer-sum', lang: 'python', code: 'different code' },       // ac on LC -> skipped
    { problemId: 'brand-new', lang: 'cpp', code: 'v2' },
    { problemId: 'brand-new', lang: 'cpp', code: 'v2' },                            // duplicate
  ] });
  assert.strictEqual(r.queued, 1, JSON.stringify(r));
  await settle();

  // 8. logged out -> pause; log in + resume -> continues
  lcLoggedIn = false;
  verdict = 'Wrong Answer';
  r = await send({ type: 'N2L_ACCEPTED', source: 'live', problemId: 'brand-new', lang: 'cpp', code: 'v3' });
  assert.strictEqual(r.queued, true);
  await settle();
  st = await send({ type: 'getState' });
  assert.ok(/Not logged in/.test(st.paused), st.paused);
  assert.strictEqual(st.queueCount, 1);
  lcLoggedIn = true;
  await send({ type: 'resume' });
  await settle();
  st = await send({ type: 'getState' });
  assert.strictEqual(st.paused, null);
  assert.strictEqual(st.queueCount, 0);
  assert.strictEqual(st.log[0].status, 'Wrong Answer');
  assert.ok(/10\/10 test cases/.test(st.log[0].detail));

  // 9. wrong answer is not treated as synced -> same code can be queued again
  r = await send({ type: 'N2L_ACCEPTED', source: 'live', problemId: 'brand-new', lang: 'cpp', code: 'v3' });
  assert.strictEqual(r.queued, true);
  await settle();

  // 10. bulk dry run: items are logged, nothing is queued
  await send({ type: 'startBulk', options: { dryRun: true } });
  r = await send({ type: 'N2L_ENQUEUE', source: 'bulk', items: [{ problemId: 'brand-new', lang: 'cpp', code: 'v4' }] });
  assert.strictEqual(r.queued, 1);
  st = await send({ type: 'getState' });
  assert.strictEqual(st.queueCount, 0);
  assert.strictEqual(st.log[0].status, 'Dry run');
  assert.strictEqual(st.bulk.dryRun, true);

  // 11. signature fixes: bundled rename (python), JS shim, live-computed rename for an unknown slug
  await send({ type: 'clearLog' });
  r = await send({ type: 'N2L_ACCEPTED', source: 'live', problemId: 'duplicate-integer', lang: 'python', code: PY_HAS_DUP });
  assert.strictEqual(r.queued, true, JSON.stringify(r));
  await settle();
  let last = submitted[submitted.length - 1];
  assert.ok(last.code.includes('def containsDuplicate(') && !last.code.includes('hasDuplicate'), last.code);
  st = await send({ type: 'getState' });
  assert.ok(/renamed hasDuplicate -> containsDuplicate/.test(st.log[0].detail), st.log[0].detail);

  r = await send({ type: 'N2L_ACCEPTED', source: 'live', problemId: 'two-integer-sum', lang: 'javascript', code: JS_TWO_SUM });
  assert.strictEqual(r.queued, true, JSON.stringify(r));
  await settle();
  last = submitted[submitted.length - 1];
  assert.ok(last.code.includes('var twoSum = function(...args) { return new Solution().twoSum(...args); };'), last.code);

  r = await send({ type: 'N2L_ACCEPTED', source: 'live', problemId: 'brand-new', lang: 'python', code: PY_NEW_BRAND });
  assert.strictEqual(r.queued, true, JSON.stringify(r));
  await settle();
  last = submitted[submitted.length - 1];
  assert.ok(last.code.includes('def brandNew(') && !last.code.includes('newBrand'), last.code);
  assert.deepStrictEqual(store.fixExtra['brand-new'].python3, { r: [['newBrand', 'brandNew']] });

  // 12. getCompletedProblems shape: LeetCode links grouped by topic -> NeetCode slugs (all groups, deduped)
  r = await send({ type: 'N2L_COMPLETED_TO_IDS', raw: {
    'Arrays & Hashing': ['contains-duplicate/', 'two-sum/', 'group-anagrams/'],
    'Two Pointers': ['3sum/', 'two-sum/'],
    'Sliding Window': ['/problems/best-time-to-buy-and-sell-stock/', 'https://leetcode.com/problems/permutation-in-string/'],
    'misc': ['something-unknown/', 'two-integer-sum'],
  } });
  assert.deepStrictEqual(r.ids.sort(), ['anagram-groups', 'buy-and-sell-crypto', 'duplicate-integer', 'permutation-string', 'three-integer-sum', 'two-integer-sum'].sort(), JSON.stringify(r));
  assert.deepStrictEqual(r.unknown, ['something-unknown']);

  // 13. LeetCode -> NeetCode, level "submit": reverse rename, judge call, roadmap tick
  await send({ type: 'setSettings', settings: { lc2nc: 'submit' } });
  await send({ type: 'clearLog' });
  sentToTabs.length = 0;
  r = await send({ type: 'N2L_LC_ACCEPTED', source: 'live', slug: 'contains-duplicate', lang: 'python3', code: LC_PY_CONTAINS });
  assert.strictEqual(r.queued, true, JSON.stringify(r));
  assert.strictEqual(r.title, '#217 Contains Duplicate');
  await settle();
  const ncSubmit = sentToTabs.find((s) => s.msg.type === 'N2L_NC_SUBMIT');
  assert.ok(ncSubmit && ncSubmit.id === 9, 'judge call must go to the neetcode tab');
  assert.strictEqual(ncSubmit.msg.problemId, 'duplicate-integer');
  assert.strictEqual(ncSubmit.msg.lang, 'python');
  assert.ok(ncSubmit.msg.code.includes('def hasDuplicate(') && !ncSubmit.msg.code.includes('containsDuplicate'), ncSubmit.msg.code);
  const ncMark = sentToTabs.find((s) => s.msg.type === 'N2L_NC_MARK');
  assert.deepStrictEqual({ topic: ncMark.msg.topic, link: ncMark.msg.link }, { topic: 'Arrays & Hashing', link: 'https://leetcode.com/problems/contains-duplicate/' });
  st = await send({ type: 'getState' });
  assert.strictEqual(st.queueCount, 0);
  assert.strictEqual(st.log[0].status, 'Accepted');
  assert.strictEqual(st.log[0].direction, 'lc2nc');
  assert.ok(/ticked in Arrays & Hashing/.test(st.log[0].detail) && /renamed containsDuplicate -> hasDuplicate/.test(st.log[0].detail), st.log[0].detail);
  assert.ok(sentToTabs.some((s) => s.id === 7 && s.msg.type === 'N2L_RESULT' && /NeetCode Contains Duplicate: Accepted/.test(s.msg.text)), 'toast on the leetcode tab');
  assert.ok(sentToTabs.some((s) => s.id === 9 && s.msg.type === 'N2L_RESULT' && /NeetCode Contains Duplicate: Accepted/.test(s.msg.text)), 'toast on the neetcode tab too');

  // 14. JS: LeetCode plain function gets a class Solution wrapper for NeetCode
  sentToTabs.length = 0;
  r = await send({ type: 'N2L_LC_ACCEPTED', source: 'live', slug: 'two-sum', lang: 'javascript', code: LC_JS_TWO_SUM });
  assert.strictEqual(r.queued, true, JSON.stringify(r));
  await settle();
  const jsSubmit = sentToTabs.find((s) => s.msg.type === 'N2L_NC_SUBMIT');
  assert.ok(jsSubmit.msg.code.includes('class Solution {') && jsSubmit.msg.code.includes('twoSum(...args) { return twoSum(...args); }'), jsSubmit.msg.code);

  // 15. level "mark": no judge call, only the tick; not-on-NeetCode problems are silently ignored
  await send({ type: 'setSettings', settings: { lc2nc: 'mark' } });
  sentToTabs.length = 0;
  r = await send({ type: 'N2L_LC_ACCEPTED', source: 'live', slug: 'valid-anagram', lang: 'cpp', code: 'class Solution {};' });
  assert.strictEqual(r.queued, true, JSON.stringify(r));
  await settle();
  assert.ok(!sentToTabs.some((s) => s.msg.type === 'N2L_NC_SUBMIT'));
  assert.ok(sentToTabs.some((s) => s.msg.type === 'N2L_NC_MARK' && s.msg.link === 'https://leetcode.com/problems/valid-anagram/'));
  r = await send({ type: 'N2L_LC_ACCEPTED', source: 'live', slug: 'not-on-neetcode-at-all', lang: 'cpp', code: 'x' });
  assert.strictEqual(r.level, 'silent', JSON.stringify(r));

  // 16. level "off"
  await send({ type: 'setSettings', settings: { lc2nc: 'off' } });
  r = await send({ type: 'N2L_LC_ACCEPTED', source: 'live', slug: 'valid-anagram', lang: 'cpp', code: 'y' });
  assert.strictEqual(r.level, 'silent', JSON.stringify(r));

  // 17. reverse bulk: the full roadmap URL is already ticked. A leftover short slug is not,
  // and a previous "already synced" note does not block it, so an untick can be ticked again.
  await send({ type: 'setSettings', settings: { lc2nc: 'mark' } });
  await send({ type: 'clearLog' });
  store.synced = { ...(store.synced || {}), 'lc2nc|duplicate-integer|python|mark': { status: 'Accepted', at: 1 } };
  await send({ type: 'startReverseBulk', options: { dryRun: true } });
  await settle();
  st = await send({ type: 'getState' });
  assert.strictEqual(st.bulk.direction, 'lc2nc');
  assert.strictEqual(st.bulk.phase, 'done');
  assert.strictEqual(st.bulk.found, 1, JSON.stringify(st.bulk));
  assert.ok(st.log.some((e) => e.slug === 'contains-duplicate' && e.status === 'Dry run'));
  assert.ok(!st.log.some((e) => e.slug === 'two-sum'));

  console.log('all background tests passed');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
