# tvOS — Media & IPTV Hub (Cloudflare Workers)

This project packages the original tvOS single-page app for deployment on Cloudflare Workers with Static Assets.

## Stack

- Frontend: existing HTML, CSS, and vanilla JavaScript.
- Hosting/API: Cloudflare Workers + Workers Static Assets.
- Playlist import: same-origin `POST /api/playlist` endpoint, so importing M3U URLs does not depend on browser CORS support.
- Playback: the browser plays each stream URL directly. Stream availability, codecs, browser support, and the stream provider's CORS policy still apply (especially for HLS playback outside Safari).

The existing app stores playlists, favorites, tabs, and preferences in the browser using IndexedDB/localStorage. These remain local to each browser/profile; they are not synced to Cloudflare.

## Run locally

Requirements: Node.js 18+ recommended.

```bash
npm install
npm run typecheck
npx wrangler login
npm run dev
```

Open the local URL printed by Wrangler.

## Deploy

```bash
npx wrangler login
npm run deploy
```

Wrangler will upload the static frontend and Worker. The deployed URL is printed at the end.

## Playlist import notes

- You can import a remote M3U URL, use the built-in public playlist presets, or paste raw M3U text.
- The Worker accepts HTTP/HTTPS URLs on standard ports, blocks local/private-looking hostnames and IP-literal URLs, validates redirects, and caps downloaded playlists at 15 MB.
- Playlist URLs may contain provider-issued credentials in their path or query string. Treat those URLs as secrets; the app keeps them in your browser's local IndexedDB.
- The proxy only downloads playlist files. It does not proxy video segments or bypass stream-provider restrictions.
- Some providers block server-side requests, require browser/session headers, or return non-M3U content; those sources may not import.
- Only use streams and playlists you are authorized to access.

## Project files

- `public/index.html` — app frontend
- `src/worker.js` — playlist proxy and static asset handler
- `wrangler.jsonc` — Cloudflare deployment configuration
- `package.json` — development scripts and Wrangler dependency
