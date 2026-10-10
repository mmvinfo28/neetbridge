// Unit tests for src/leetcode-hook.js: runs the page-world hook in a VM with fake fetch /
// XMLHttpRequest and checks which LeetCode responses turn into N2L_LC_SUBMISSION messages.
//   node test/hook.js
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'leetcode-hook.js'), 'utf8');

// fake leetcode.com: path -> JSON body of the response
const responses = new Map();
const reply = (url) => {
  const p = new URL(url, 'https://leetcode.com').pathname;
  if (!responses.has(p)) throw new Error('unexpected request ' + p);
  return responses.get(p);
};

class FakeXHR {
  constructor() { this.listeners = []; this.response = null; }
  open(method, url) { this.url = url; }
  send() { setTimeout(() => { this.response = JSON.stringify(reply(this.url)); this.listeners.forEach((fn) => fn()); }, 0); }
  addEventListener(type, fn) { if (type === 'loadend') this.listeners.push(fn); }
}

const posted = [];
const win = {
  location: { origin: 'https://leetcode.com' },
  postMessage: (msg) => posted.push(msg),
  fetch: async (input) => {
    const json = reply(typeof input === 'string' ? input : input.url);
    return { ok: true, status: 200, clone() { return this; }, json: async () => json };
  },
  XMLHttpRequest: FakeXHR,
  URL,
};
win.window = win;
vm.runInNewContext(src, win);

const settle = () => new Promise((r) => setTimeout(r, 10));
const submitBody = (lang, questionId, code) => JSON.stringify({ lang, question_id: questionId, typed_code: code });
// posted messages come from the VM realm: copy them into this one before comparing
const lastPosted = () => { const { at, ...msg } = posted[posted.length - 1]; assert.strictEqual(typeof at, 'number'); return msg; };

// 1. problem page: fetch submit, then /v2/check/ polled until the verdict is final, AI check included
const CHECK_V2 = '/submissions/detail/2165172092/v2/check/';
responses.set('/problems/number-of-1-bits/submit/', { submission_id: 2165172092 });
await win.fetch('/problems/number-of-1-bits/submit/', { method: 'POST', credentials: 'same-origin', body: submitBody('python3', '191', 'class Solution: pass') });
await settle();
for (const r of [{ state: 'PENDING' }, { state: 'RUNNING_TESTS' }, { state: 'SUCCESS', status_code: 10, status_msg: 'Accepted', ai_state: 'PENDING' }]) {
  responses.set(CHECK_V2, r);
  await win.fetch(CHECK_V2, { credentials: 'same-origin' });
  await settle();
}
assert.strictEqual(posted.length, 0, 'no verdict before the judge and the AI check are done');
responses.set(CHECK_V2, { state: 'SUCCESS', status_code: 10, status_msg: 'Accepted', ai_state: 'SUCCESS', total_correct: 600, total_testcases: 600, submission_id: '2165172092' });
await win.fetch(CHECK_V2, { credentials: 'same-origin' });
await settle();
assert.strictEqual(posted.length, 1);
assert.deepStrictEqual(lastPosted(), { __n2l: true, type: 'N2L_LC_SUBMISSION', slug: 'number-of-1-bits', lang: 'python3', code: 'class Solution: pass',
  questionId: '191', submissionId: '2165172092', status: 'Accepted', totalCorrect: 600, totalTestcases: 600 });
await win.fetch(CHECK_V2, { credentials: 'same-origin' });
await settle();
assert.strictEqual(posted.length, 1, 'one message per submission');

// 2. XMLHttpRequest and the old /check/ URL
responses.set('/problems/two-sum/submit/', { submission_id: 42 });
let xhr = new win.XMLHttpRequest();
xhr.open('POST', '/problems/two-sum/submit/');
xhr.send(submitBody('cpp', '1', 'class Solution {};'));
await settle();
responses.set('/submissions/detail/42/check/', { state: 'SUCCESS', status_code: 11, status_msg: 'Wrong Answer' });
xhr = new win.XMLHttpRequest();
xhr.open('GET', 'https://leetcode.com/submissions/detail/42/check/');
xhr.send();
await settle();
assert.strictEqual(posted.length, 2);
assert.deepStrictEqual([lastPosted().slug, lastPosted().lang, lastPosted().status], ['two-sum', 'cpp', 'Wrong Answer']);

// 3. a check for a submission the hook never saw (e.g. a Run result) is ignored
responses.set('/submissions/detail/77/check/', { state: 'SUCCESS', status_code: 10, status_msg: 'Accepted' });
await win.fetch('/submissions/detail/77/check/');
await settle();
responses.set('/submissions/detail/runcode_1759800000.12_abc/check/', { state: 'SUCCESS', status_msg: 'Accepted', run_success: true });
await win.fetch('/submissions/detail/runcode_1759800000.12_abc/check/');
await settle();
assert.strictEqual(posted.length, 2);

// 3b. non-numeric submission ids (submissionIdV2)
responses.set('/problems/two-sum/submit/', { submission_id: 'k3J9xQ' });
await win.fetch('/problems/two-sum/submit/', { method: 'POST', body: submitBody('java', '1', 'class Solution {}') });
await settle();
responses.set('/submissions/detail/k3J9xQ/v2/check/', { state: 'SUCCESS', status_code: 10, status_msg: 'Accepted' });
await win.fetch('/submissions/detail/k3J9xQ/v2/check/');
await settle();
assert.strictEqual(posted.length, 3);
assert.deepStrictEqual([lastPosted().submissionId, lastPosted().lang, lastPosted().status], ['k3J9xQ', 'java', 'Accepted']);

// 4. a failed restriction check or AI judge is not Accepted, whatever status_msg says
for (const [id, verdict, status] of [
  [501, { status_code: 50, status_msg: 'Accepted', ai_state: 'SUCCESS' }, 'Restrictions Failed'],
  [502, { status_code: 10, status_msg: 'Accepted', ai_state: 'FAILURE' }, 'Internal Error'],
]) {
  responses.set('/problems/two-sum/submit/', { submission_id: id });
  await win.fetch('/problems/two-sum/submit/', { method: 'POST', body: submitBody('python3', '1', `# ${id}`) });
  await settle();
  responses.set(`/submissions/detail/${id}/v2/check/`, { state: 'SUCCESS', ...verdict });
  await win.fetch(`/submissions/detail/${id}/v2/check/`);
  await settle();
  assert.strictEqual(lastPosted().submissionId, String(id));
  assert.strictEqual(lastPosted().status, status);
}

console.log('all hook tests passed');
