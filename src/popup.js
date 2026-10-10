const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

// popup control id -> settings key (nc2lc is a select over the boolean `enabled`)
const CONTROLS = ['nc2lc', 'lc2nc', 'allowPremium', 'notify', 'delaySec'];

// green = accepted, gold = skipped (premium), orange = needs attention, red = any failed verdict/error
function statusClass(status) {
  if (!status) return '';
  if (status === 'Accepted') return 'ok';
  if (status === 'Dry run') return 'info';
  if (/^Skipped/.test(status)) return 'gold';
  if (/^(Retry|Paused|Unmapped)/.test(status)) return 'warn';
  return 'err';
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function renderLog(log) {
  const ul = $('log');
  ul.textContent = '';
  const acc = log.filter((e) => e.status === 'Accepted').length;
  $('logCount').textContent = log.length ? `${log.length} entries · ${acc} accepted` : '';
  if (!log.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing synced yet. Get a problem accepted on either site.';
    ul.append(li);
    return;
  }
  for (const e of log) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    const dir = document.createElement('span');
    dir.className = 'dir';
    dir.textContent = e.direction === 'lc2nc' ? '←' : '→';
    t.append(dir, document.createTextNode(e.num ? ` #${e.num} ${e.title}` : ` ${e.problemId || e.status || ''}`));
    t.title = `${fmtTime(e.at)} · ${e.direction === 'lc2nc' ? 'LeetCode → NeetCode' : 'NeetCode → LeetCode'} · ${e.source || ''} · ${e.lang || ''}`;
    const s = document.createElement('span');
    s.className = `s ${statusClass(e.status)}`;
    s.textContent = e.status || '';
    li.append(t, s);
    const links = [];
    if (e.problemId) links.push(['NeetCode', e.lcOnly ? 'https://neetcode.io/practice/practice/allNC' : `https://neetcode.io/problems/${e.problemId}`]);
    if (e.url && /leetcode\.com/.test(e.url)) links.push(['LeetCode submission', e.url]);
    else if (e.slug) links.push(['LeetCode', `https://leetcode.com/problems/${e.slug}/`]);
    if (e.detail || links.length) {
      const d = document.createElement('span');
      d.className = 'd';
      d.textContent = e.detail || '';
      links.forEach(([text, href], i) => {
        const a = document.createElement('a');
        a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text;
        d.append(e.detail || i ? ' · ' : '', a);
      });
      li.append(d);
    }
    ul.append(li);
  }
}

function renderBulk(bulk) {
  const running = !!(bulk && bulk.running);
  $('bulk').disabled = running;
  $('bulkReverse').disabled = running;
  $('abortBulk').hidden = !running;
  const el = $('bulkText');
  $('dismissBulk').hidden = !bulk || running;
  if (!bulk) { el.textContent = ''; return; }
  const target = bulk.direction === 'lc2nc' ? 'NeetCode' : 'LeetCode';
  const parts = [bulk.direction === 'lc2nc' ? 'LeetCode → NeetCode:' : 'NeetCode → LeetCode:'];
  if (bulk.phase === 'starting') parts.push('starting…');
  if (bulk.phase === 'listing') parts.push('reading your completed problems…');
  if (bulk.phase === 'scanning') parts.push('completed list unavailable, scanning every problem (a few minutes)…');
  if (bulk.phase === 'collecting') parts.push(`collecting ${bulk.done}/${bulk.total} (found ${bulk.found})`);
  if (bulk.phase === 'done') parts.push(`collected ${bulk.found} from ${bulk.done} problems.`);
  if (bulk.phase === 'aborted') parts.push('stopped.');
  if (bulk.phase === 'error') parts.push(`error: ${bulk.error}`);
  if (bulk.queued) parts.push(bulk.dryRun ? `${bulk.queued} would go to ${target} (preview, see Recent).` : `${bulk.queued} queued for ${target}.`);
  el.textContent = parts.join(' ');
}

async function refresh() {
  const st = await send({ type: 'getState' });
  if (!st || st.error) return;
  $('nc2lc').value = st.settings.enabled ? 'submit' : 'off';
  $('lc2nc').value = st.settings.lc2nc || 'off';
  $('allowPremium').checked = !!st.settings.allowPremium;
  $('notify').checked = !!st.settings.notify;
  $('delaySec').value = st.settings.delaySec;

  $('pausedRow').hidden = !st.paused;
  $('pausedText').textContent = st.paused || '';
  const q = st.queueCount;
  const head = st.queueHead[0];
  $('queueText').textContent = q
    ? `${q} in queue · next: #${head.num} ${head.title} ${head.direction === 'lc2nc' ? '→ NeetCode' : '→ LeetCode'}`
    : 'Queue empty';
  $('queueDot').className = `dot ${q ? (st.paused ? 'warn' : 'busy') : 'idle'}`;
  $('clearQueue').hidden = !q;
  renderLog(st.log || []);
  renderBulk(st.bulk);
}

async function checkSessions() {
  send({ type: 'checkLeetCode' }).then((r) => {
    if (r && r.loggedIn) { $('lcDot').className = 'dot ok'; $('lcStatus').textContent = `${r.userName} · ${r.numSolved} solved`; $('lcPill').title = 'LeetCode: logged in'; }
    else { $('lcDot').className = 'dot err'; $('lcStatus').textContent = 'LeetCode: log in'; $('lcPill').title = (r && r.error) || 'Not logged in on leetcode.com'; }
  }).catch(() => {});
  send({ type: 'checkNeetCode' }).then((r) => {
    if (r && r.loggedIn) { $('ncDot').className = 'dot ok'; $('ncStatus').textContent = 'NeetCode'; $('ncPill').title = 'NeetCode: logged in'; }
    else if (r && r.noTab) { $('ncDot').className = 'dot idle'; $('ncStatus').textContent = 'NeetCode: no tab'; $('ncPill').title = 'Open neetcode.io in a tab to check the session'; }
    else if (r && r.stale) { $('ncDot').className = 'dot warn'; $('ncStatus').textContent = 'NeetCode: reload tab'; $('ncPill').title = 'The neetcode.io tab still runs an older version of the extension - reload it (F5)'; }
    else { $('ncDot').className = 'dot err'; $('ncStatus').textContent = 'NeetCode: log in'; $('ncPill').title = (r && r.error) || 'Not logged in on neetcode.io'; }
  }).catch(() => {});
}

for (const id of CONTROLS) {
  $(id).addEventListener('change', async () => {
    const el = $(id);
    let settings;
    if (id === 'nc2lc') settings = { enabled: el.value === 'submit' };
    else if (el.type === 'checkbox') settings = { [id]: el.checked };
    else if (el.type === 'number') settings = { [id]: Number(el.value) };
    else settings = { [id]: el.value };
    await send({ type: 'setSettings', settings });
    refresh();
  });
}

$('lcPill').addEventListener('click', () => chrome.tabs.create({ url: 'https://leetcode.com/' }));
$('ncPill').addEventListener('click', () => chrome.tabs.create({ url: 'https://neetcode.io/practice' }));
$('resume').addEventListener('click', async () => { await send({ type: 'resume' }); refresh(); checkSessions(); });
$('clearQueue').addEventListener('click', async () => { await send({ type: 'clearQueue' }); refresh(); });
$('clearLog').addEventListener('click', async () => { await send({ type: 'clearLog' }); refresh(); });
$('bulk').addEventListener('click', async () => {
  $('bulk').disabled = true;
  await send({ type: 'startBulk', options: { dryRun: $('dryRun').checked } });
  refresh();
});
$('bulkReverse').addEventListener('click', async () => {
  $('bulkReverse').disabled = true;
  await send({ type: 'startReverseBulk', options: { dryRun: $('dryRun').checked } });
  refresh();
});
$('abortBulk').addEventListener('click', async () => { await send({ type: 'abortBulk' }); refresh(); });
$('dismissBulk').addEventListener('click', async () => { await send({ type: 'clearBulk' }); refresh(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.queue || changes.log || changes.bulk || changes.paused)) refresh();
});

refresh();
checkSessions();
