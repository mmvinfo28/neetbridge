# Chrome Web Store listing — copy/paste material

## Product details

**Title:** neetbridge

**Summary (≤ 132 chars):**
Two-way sync between NeetCode and LeetCode: accepted solutions are submitted to the other site, the NeetCode roadmap gets ticked.

**Category:** Developer Tools · **Language:** English

**Description:**

Solve on NeetCode or LeetCode — both stay in sync.

NeetCode → LeetCode: get a problem accepted on neetcode.io and the same code is submitted to the matching LeetCode problem. The LeetCode verdict shows up right on the NeetCode page.

LeetCode → NeetCode: get a problem accepted on leetcode.com and it is ticked in your NeetCode roadmap (NeetCode 150 / 250 / Blind 75 / NeetCode All). Optionally the code is submitted to NeetCode as well, so it appears in your NeetCode submission history.

Backfill: one click syncs everything you already solved, in either direction. A "Preview only" mode lists what would happen before anything is sent.

How it works
• The extension watches the site's own Submit button — nothing to copy, nothing to configure.
• All 973 NeetCode All problems are mapped to their LeetCode counterparts, including renamed problems (two-integer-sum → two-sum) and renamed methods (hasDuplicate → containsDuplicate). JavaScript/TypeScript solutions are adapted between NeetCode's class Solution and LeetCode's plain functions automatically.
• Submissions use the sessions you are already logged in with and are spaced out to respect both sites' rate limits.
• Every verdict is shown as a toast on the page and, optionally, as a desktop notification.

Privacy
Everything runs inside your browser. Your code goes only to neetcode.io and leetcode.com, exactly as the sites' own Submit buttons send it. Nothing is sent to the developer or to any third party; no analytics, no tracking.

Limitations
• Only the problems listed on NeetCode can be synced (973 at the time of writing). The 385 that NeetCode only links to LeetCode have no NeetCode editor, so they are ticked but never submitted to NeetCode.
• LeetCode Premium problems are skipped unless you enable them and have Premium.
• Unofficial; not affiliated with NeetCode or LeetCode.

Open source (MIT): https://github.com/mmvinfo28/neetbridge

## Graphic assets

- Store icon 128×128: `icons/icon128.png`
- Screenshots 1280×800: `assets/store/screenshot-1.png`, `assets/store/screenshot-2.png`
- Small promo tile 440×280: `assets/store/promo-small-440x280.png`
- Marquee 1400×560: `assets/store/promo-marquee-1400x560.png`

Regenerate: `python tools/store/render.py`, open the printed URL, click *Render + save*.

## Privacy tab

**Single purpose:**
Synchronise accepted coding-problem solutions between neetcode.io and leetcode.com (submit the code to the other site and tick the NeetCode roadmap).

**Permission justifications:**

- `storage` — keeps the submission queue, the log of recent verdicts, settings and a cache of problem mappings on the user's device.
- `scripting` — runs the submit / verdict-check requests inside the user's own leetcode.com tab so they carry the user's session and origin.
- `alarms` — schedules the next queued submission when the configured gap between submissions is longer than the service worker's lifetime.
- `notifications` — optional desktop notification with the verdict of a synced submission.
- Host permission `https://neetcode.io/*` — observe the user's own submissions on NeetCode, read the user's completed problems and starter code, submit code / tick the roadmap on the user's behalf.
- Host permission `https://leetcode.com/*` — observe the user's own submissions on LeetCode, read the user's problem list and code snippets, submit code on the user's behalf.
- Host permission `https://www.youtube.com/*` — only the public oEmbed endpoint, to read the title of a NeetCode explanation video when a new problem is not in the bundled mapping (the title carries the LeetCode problem number).

**Remote code:** No, I am not using remote code.

**Data usage:** the extension handles *Website content* (the code the user submits) and *Authentication information* (the user's existing sessions on the two sites) locally, to perform the sync between the two sites the user is logged in to. Nothing is transmitted to the developer. Tick every certification shown (the dashboard has shown two or three over time: not sold, not used for unrelated purposes, not used for creditworthiness) - all of them hold.

**Privacy policy URL:** https://github.com/mmvinfo28/neetbridge/blob/master/PRIVACY.md

## Distribution

Visibility: Public (or Unlisted to share the link first). Regions: all.
