const express = require('express');
const router = express.Router();
const { Readable, pipeline } = require('stream');
const { redact } = require('../services/redact');
const { guardedFetch } = require('../services/urlGuard');
const streamRef = require('../services/streamRef');

/**
 * Playback through the server (see services/streamRef.js)
 *
 *   GET /api/stream/x/...  /api/stream/m/...   a stream reference (login required)
 *   GET /api/stream/s/<token>/<name>           a sealed link (public: the token is the authorisation)
 *   GET /api/stream/link?url=<ref>             a sealed link to share with an external player
 *
 * The browser never sees provider URLs: HLS playlists are rewritten so every
 * entry is a sealed link back through here.
 */

/**
 * The proxies pass on whatever a remote server sends, and serve it from this
 * site's own origin - so a link to a proxied page with a script would run that
 * script as Fleurbox. Every proxied response is therefore served sandboxed (no
 * scripts, no same-origin access even if a browser opens it as a page), and
 * only media types pass through as they are.
 */
const PROXY_CSP = "default-src 'none'; img-src data:; media-src data: blob:; style-src 'unsafe-inline'; sandbox";
function lockDown(req, res, next) {
    res.set('Content-Security-Policy', PROXY_CSP);
    res.set('X-Content-Type-Options', 'nosniff');
    next();
}

// Types a stream, playlist, segment, key or subtitle legitimately comes as
const STREAM_TYPE = /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl|octet-stream|mp4|mp2t|dash\+xml)\b|binary\/octet-stream|text\/vtt\b)/i;

/** Upstream content type, or octet-stream when it is anything else (text/html, svg...) */
function streamType(type) {
    return type && STREAM_TYPE.test(type) ? type : 'application/octet-stream';
}

/** Rewrite every URI in an HLS playlist to a sealed link back through this server */
function rewriteManifest(manifest, baseUrl, user) {
    const link = uri => streamRef.sealUrl(new URL(uri, baseUrl).href, user);
    return manifest.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed === '') return line;
        if (trimmed.startsWith('#')) {
            // Keys, maps, alternative renditions: URI="..." or URI='...'
            return line.replace(/URI=["']([^"']+)["']/g, (match, uri) => {
                try { return `URI="${link(uri)}"`; } catch { return match; }
            });
        }
        try { return link(trimmed); } catch { return '#' + line; } // never pass an upstream URL through
    }).join('\n');
}

/**
 * Fetch an upstream URL and pass it on: HLS playlists rewritten, anything else
 * streamed through as it arrives (with Range support for seeking).
 * `user` owns the sealed links minted for a playlist's entries.
 */
async function proxyStream(req, res, url, user) {
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Forward some headers to be more "transparent" back to the origin
            // Pluto TV uses multiple domains for content delivery
            const plutoDomains = ['pluto.tv', 'pluto.io', 'plutotv.net', 'siloh.pluto.tv', 'service-stitcher'];
            const isPluto = plutoDomains.some(domain => url.includes(domain));

            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': isPluto ? 'https://pluto.tv' : new URL(url).origin,
                'Referer': isPluto ? 'https://pluto.tv/' : new URL(url).origin + '/'
            };

            // Forward Range header for video seeking support
            const rangeHeader = req.get('range');
            if (rangeHeader) headers['Range'] = rangeHeader;

            const response = await guardedFetch(url, { headers });

            // Retry on 5xx errors (transient upstream issues)
            if (response.status >= 500 && attempt < maxRetries) {
                console.log(`[Stream] Upstream 5xx error (attempt ${attempt}/${maxRetries}), retrying in 500ms...`);
                response.body?.cancel?.().catch(() => {});
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            if (!response.ok) {
                console.error(`[Stream] Upstream error for ${redact(url).substring(0, 100)}: ${response.status} ${response.statusText}`);
                response.body?.cancel?.().catch(() => {});
                return res.status(response.status).type('text/plain').send(`Failed to fetch stream: ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type') || '';
            const iterator = response.body[Symbol.asyncIterator]();
            const first = await iterator.next();

            if (first.done) {
                res.status(response.status).set('Content-Type', streamType(contentType));
                return res.end();
            }
            const firstChunk = Buffer.from(first.value);

            // HLS playlist (starts with #EXTM3U): read it whole and rewrite it
            if (firstChunk.subarray(0, 7).toString('utf8') === '#EXTM3U') {
                const chunks = [firstChunk];
                for (let r = await iterator.next(); !r.done; r = await iterator.next()) {
                    chunks.push(Buffer.from(r.value));
                }
                const finalUrl = response.url || url;
                const base = new URL(finalUrl);
                const baseUrl = base.origin + base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
                const manifest = rewriteManifest(Buffer.concat(chunks).toString('utf-8'), baseUrl, user);
                res.status(200);
                res.set('Content-Type', 'application/vnd.apple.mpegurl');
                res.set('Cache-Control', 'no-cache');
                return res.send(manifest);
            }

            // Anything else (video file, segment, key): stream it through
            res.status(response.status);
            res.set('Content-Type', streamType(contentType));
            const contentLength = response.headers.get('content-length');
            const contentRange = response.headers.get('content-range');
            const acceptRanges = response.headers.get('accept-ranges');
            if (contentLength) res.set('Content-Length', contentLength);
            if (contentRange) res.set('Content-Range', contentRange);
            if (acceptRanges) {
                res.set('Accept-Ranges', acceptRanges);
            } else if (contentLength && !contentRange) {
                // Content-Length without an explicit Accept-Ranges: byte ranges
                // are almost always supported
                res.set('Accept-Ranges', 'bytes');
            }

            const body = Readable.from((async function* () {
                yield firstChunk;
                for (let r = await iterator.next(); !r.done; r = await iterator.next()) {
                    yield Buffer.from(r.value);
                }
            })());
            // Viewer gone (seek, stop): stop pulling from the provider
            pipeline(body, res, err => {
                if (err) iterator.return?.().catch(() => {});
            });
            return;
        } catch (err) {
            // A redirect to a private address: refused, not retried
            if (err.status === 403 || err.status === 400) {
                return res.status(err.status).json({ error: err.message });
            }
            lastError = err;
            console.error(`[Stream] Proxy error (attempt ${attempt}/${maxRetries}):`, redact(err.message));
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
        }
    }

    if (!res.headersSent) {
        res.status(502).json({ error: 'Stream proxy failed after retries' });
    }
}

/**
 * A sealed link for an external player (VLC...): works without a login, for
 * SHARE_TTL_MS. GET /api/stream/link?url=<stream reference>
 */
router.get('/link', async (req, res) => {
    const ref = String(req.query.url || '');
    if (!/^\/api\/stream\/[xm]\//.test(ref)) {
        return res.status(400).json({ error: 'Not a stream reference' });
    }
    try {
        await streamRef.resolve(ref);
        res.json({ url: streamRef.sealRef(ref, req.user), expiresIn: streamRef.SHARE_TTL_MS / 1000 });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
    }
});

/** Play a reference: /api/stream/x/..., /api/stream/m/..., /api/stream/s/... */
router.get(/^\/[xms]\//, lockDown, async (req, res) => {
    let resolved;
    try {
        resolved = await streamRef.resolve(req.baseUrl + req.path);
    } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
    }
    // Sealed links play for the user who was given them; references for the
    // logged-in user (the /api gate has already required a login for those)
    const user = resolved.user || req.user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    return proxyStream(req, res, resolved.url, user);
});

module.exports = router;
module.exports.proxyStream = proxyStream;
module.exports.lockDown = lockDown;
module.exports.streamType = streamType;
