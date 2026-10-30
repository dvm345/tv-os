const MAX_PLAYLIST_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ALLOWED_PORTS = new Set(["", "80", "443"]);

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      host.endsWith(".test") || host.endsWith(".invalid") ||
      host === "metadata.google.internal" || host === "metadata") return true;

  // Block IP literals rather than risking access to private, loopback, or link-local addresses.
  // Playlist URLs should normally use a public hostname.
  if (host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
      /^[0-9a-f:]+$/i.test(host) && host.includes(":")) return true;

  // Block common non-public / special-use suffixes.
  if (!host.includes(".") || host.endsWith(".arpa")) return true;
  return false;
}

function validatePlaylistUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Enter a valid playlist URL."); }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS playlist URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("Put playlist credentials in the URL query/path, not in the username or password field.");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new Error("Playlist URLs must use the standard HTTP or HTTPS port.");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error("That hostname is not allowed. Use a public playlist URL.");
  }
  url.hash = "";
  return url;
}

async function readTextLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Playlist exceeds size limit");
        throw new Error("Playlist is too large (15 MB maximum).");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

async function fetchPlaylist(rawUrl) {
  let url = validatePlaylistUrl(rawUrl);
  let response;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    response = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        "Accept": "audio/x-mpegurl, application/vnd.apple.mpegurl, text/plain, */*",
        "User-Agent": "tvOS-Playlist-Importer/1.0",
      },
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("Location");
    if (!location || redirects === MAX_REDIRECTS) {
      throw new Error("Playlist redirect limit reached.");
    }
    url = validatePlaylistUrl(new URL(location, url).toString());
  }

  if (!response || !response.ok) {
    const status = response?.status || 502;
    throw new Error(`Playlist source returned HTTP ${status}.`);
  }

  const declaredLength = Number(response.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_PLAYLIST_BYTES) {
    throw new Error("Playlist is too large (15 MB maximum).");
  }

  const text = await readTextLimited(response, MAX_PLAYLIST_BYTES);
  if (!text.trim()) throw new Error("The playlist source returned an empty response.");
  if (!text.includes("#EXTINF") && !text.trimStart().startsWith("#EXTM3U")) {
    throw new Error("The URL did not return a recognizable M3U playlist.");
  }
  return text;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "tvos-media-hub" });
    }

    if (url.pathname === "/api/playlist") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, 405, { allow: "POST" });
      }

      let payload;
      try { payload = await request.json(); } catch {
        return json({ error: "Expected a JSON body containing a playlist URL." }, 400);
      }
      const sourceUrl = typeof payload?.url === "string" ? payload.url : "";
      if (!sourceUrl) return json({ error: "Missing playlist URL." }, 400);

      try {
        const text = await fetchPlaylist(sourceUrl);
        return new Response(text, {
          status: 200,
          headers: {
            "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-disposition": "inline",
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to fetch playlist.";
        const status = /valid playlist URL|Only HTTP|username or password|standard HTTP|hostname is not allowed/i.test(message) ? 400
          : /too large/i.test(message) ? 413
          : /redirect limit/i.test(message) ? 502
          : 502;
        return json({ error: message }, status);
      }
    }

    // Static assets and all other app routes are served by Cloudflare Assets.
    return env.ASSETS.fetch(request);
  },
};
