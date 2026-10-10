// Runs in the page's MAIN world on leetcode.com (see manifest "world": "MAIN").
//
// Observes LeetCode's own submission traffic for the LeetCode -> NeetCode direction:
//   * POST /problems/<slug>/submit/              body {lang, question_id, typed_code} -> {submission_id}
//   * GET  /submissions/detail/<id>/v2/check/    -> {state: "SUCCESS", status_msg: "Accepted", ai_state, ...}
//     (the problem page polls v2; the older /submissions/detail/<id>/check/ is matched as well)
// When a submission reaches a final verdict the code is handed to the content script.
//
// Only page-initiated requests are visible here. The submissions neetbridge itself sends into a
// leetcode.com tab (NeetCode -> LeetCode direction) run in the isolated world and never pass
// through these hooks, so the two directions cannot feed each other.
(() => {
  if (window.__n2lLcHooked) return;
  window.__n2lLcHooked = true;

  const SUBMIT_RE = /\/problems\/([^/?#]+)\/submit\/?(?:[?#]|$)/;
  // any id, not just digits: LeetCode's API now calls it submissionIdV2 (an ID, not an Int)
  const CHECK_RE = /\/submissions\/detail\/([^/?#]+)\/(?:v2\/)?check\/?(?:[?#]|$)/;
  const pending = new Map();   // submission_id -> {slug, lang, code, questionId}

  const post = (msg) => {
    try { window.postMessage({ __n2l: true, ...msg }, window.location.origin); } catch { /* ignore */ }
  };

  const urlOf = (input) => {
    try {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (input && typeof input.url === 'string') return input.url;
    } catch { /* ignore */ }
    return '';
  };

  const parseSubmit = (url, body) => {
    const m = SUBMIT_RE.exec(url);
    if (!m || typeof body !== 'string') return null;
    try {
      const d = JSON.parse(body);
      if (d && typeof d.typed_code === 'string' && d.lang) {
        return { slug: m[1], lang: d.lang, code: d.typed_code, questionId: d.question_id };
      }
    } catch { /* not JSON */ }
    return null;
  };

  const onSubmitResponse = (submission, json) => {
    const id = json && (json.submission_id || json.submissionId);
    if (id != null) pending.set(String(id), submission);
  };

  const onCheckResponse = (url, json) => {
    const m = CHECK_RE.exec(url);
    if (!m || !json || json.state !== 'SUCCESS') return;
    // v2 reports SUCCESS while LeetCode's AI restriction check may still run; the page keeps polling.
    if (json.ai_state === 'PENDING' || json.ai_state === 'STARTED') return;
    const submission = pending.get(m[1]);
    if (!submission) return;
    pending.delete(m[1]);
    post({
      type: 'N2L_LC_SUBMISSION',
      ...submission,
      submissionId: m[1],
      // LeetCode shows a failed AI check as a server error and status_code 50 as Restrictions Failed
      status: json.ai_state === 'FAILURE' ? 'Internal Error' : json.status_code === 50 ? 'Restrictions Failed' : json.status_msg || 'Unknown',
      totalCorrect: json.total_correct,
      totalTestcases: json.total_testcases,
      at: Date.now(),
    });
  };

  const readJson = (r) => {
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; }
  };

  // ---- XMLHttpRequest
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function n2lOpen(method, url) {
    try { this.__n2l = { url: String(url || '') }; } catch { /* ignore */ }
    return origOpen.apply(this, arguments);
  };
  XHR.send = function n2lSend(body) {
    const info = this.__n2l;
    try {
      if (info) {
        const submission = parseSubmit(info.url, body);
        if (submission) this.addEventListener('loadend', () => onSubmitResponse(submission, readJson(this.response)));
        else if (CHECK_RE.test(info.url)) this.addEventListener('loadend', () => onCheckResponse(info.url, readJson(this.response)));
      }
    } catch { /* never break the page */ }
    return origSend.apply(this, arguments);
  };

  // ---- fetch
  const origFetch = window.fetch;
  window.fetch = function n2lFetch(input, init) {
    const url = urlOf(input);
    let submission = null;
    let isCheck = false;
    try {
      submission = parseSubmit(url, init && init.body);
      isCheck = !submission && CHECK_RE.test(url);
    } catch { /* ignore */ }
    const p = origFetch.apply(this, arguments);
    if (submission || isCheck) {
      p.then((res) => {
        res.clone().json().then((json) => {
          if (submission) onSubmitResponse(submission, json);
          else onCheckResponse(url, json);
        }).catch(() => {});
      }).catch(() => {});
    }
    return p;
  };
})();
