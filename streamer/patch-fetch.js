// Patch global.fetch with node-fetch BEFORE any other modules load.
// bittorrent-tracker uses cross-fetch-ponyfill which does:
//   export const fetch = global.fetch || node_fetch
// Node.js 22's native global.fetch breaks binary info_hash encoding in
// tracker URLs (different URL percent-encoding behavior), causing all
// HTTP tracker announces to fail with "fetch failed".
// By replacing global.fetch with node-fetch here, cross-fetch-ponyfill
// picks up node-fetch instead, which handles binary query strings correctly.
import fetch from 'node-fetch'
global.fetch = fetch
