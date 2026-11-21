# Privacy policy — neetbridge

neetbridge runs entirely inside your browser.

**What it processes**

- The source code of solutions you submit on neetcode.io and leetcode.com, together with the problem name, language and verdict.
- Your existing login sessions on neetcode.io (Firebase token stored by NeetCode in your browser) and leetcode.com (cookies), used only to make requests to those two sites on your behalf. When your NeetCode login token has expired, the extension renews it by sending your NeetCode refresh token to Google's token service (`securetoken.googleapis.com`), the same call NeetCode's own site makes. The renewed token is kept in memory only and is never stored or logged.
- The public list of LeetCode problems and, for problems missing from the bundled mapping, public metadata from neetcode.io and the public YouTube oEmbed endpoint (video title only).

**Where it goes**

- To neetcode.io and leetcode.com only, in the same way the sites' own Submit buttons send it. The single exception is the login-token renewal described above, which goes to Google's token service and contains no code or submission data.
- A log of recent verdicts and a cache of mappings are kept in the extension's local storage (`chrome.storage.local`) on your device.

**What it does not do**

- No data is sent to the extension author. Apart from the login-token renewal above, nothing is sent to any third-party server.
- No analytics, no tracking, no advertising.
- Nothing is sold or shared.

Uninstalling the extension deletes its local storage. Questions: open an issue on the project's GitHub repository.
