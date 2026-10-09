/**
 * Stream references: what the browser holds instead of a provider URL.
 *
 * Xtream stream URLs carry the provider login in their path, so the client
 * never sees one. It gets a reference to the stream and the server builds the
 * real URL when it fetches (or hands it to ffmpeg). Because every playback
 * route takes only references, the server never fetches a URL a user typed in.
 *
 *   /api/stream/x/<sourceId>/<type>/<streamId>.<ext>   Xtream stream (type live|movie|series)
 *   /api/stream/m/<sourceId>/<itemId>                  M3U playlist item
 *   /api/stream/s/<token>/<name>                       sealed link, works without a login
 *
 * A sealed link is the server's own encrypted note of a URL or reference, with
 * an expiry and the user who asked for it (it stops working when that user is
 * deleted or their logins are ended). The proxy rewrites HLS playlists with
 * sealed links, and "Copy Stream URL" hands one out for VLC and the like.
 * <name> is cosmetic: players guess the format from the file name.
 */
const crypto = require('crypto');
const { sources, users } = require('../db');

const KEY = crypto.createHash('sha256').update(`fleurbox-stream-ref:${process.env.JWT_SECRET || ''}`).digest();

const SEGMENT_TTL_MS = 12 * 60 * 60 * 1000; // links inside a proxied playlist
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;   // "Copy Stream URL"

const XTREAM_TYPES = { live: 'live', movie: 'movie', vod: 'movie', series: 'series' };
const XTREAM_REF = /^\/api\/stream\/x\/(\d+)\/(live|movie|series)\/([A-Za-z0-9_-]+)\.([A-Za-z0-9]{1,5})$/;
const M3U_REF = /^\/api\/stream\/m\/(\d+)\/([^/]+)$/;
const SEALED_REF = /^\/api\/stream\/s\/([A-Za-z0-9_-]+)(?:\/[^/]*)?$/;

const refError = (status, message) => Object.assign(new Error(message), { status });

function xtreamRef(sourceId, streamId, type = 'live', container = 'm3u8') {
    const kind = XTREAM_TYPES[type];
    const ext = String(container || '').replace(/^\./, '');
    if (!kind || !/^\d+$/.test(String(sourceId)) || !/^[A-Za-z0-9_-]+$/.test(String(streamId)) || !/^[A-Za-z0-9]{1,5}$/.test(ext)) {
        throw refError(400, 'Invalid stream');
    }
    return `/api/stream/x/${sourceId}/${kind}/${streamId}.${ext}`;
}

function m3uRef(sourceId, itemId) {
    return `/api/stream/m/${sourceId}/${encodeURIComponent(itemId)}`;
}

/** A file name for the end of a sealed link: the upstream file's, if it is plain */
function linkName(target) {
    const last = String(target).split(/[?#]/)[0].split('/').pop();
    return /^[A-Za-z0-9._-]{1,80}$/.test(last) ? last : 'stream';
}

/**
 * Seal a URL ({ u }) or a reference ({ r }) for a user. Returns the link path.
 */
function seal(target, user, ttlMs) {
    const payload = JSON.stringify({ ...target, uid: user.id, tv: user.tokenVersion || 0, exp: Date.now() + ttlMs });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const data = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const token = Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
    return `/api/stream/s/${token}/${linkName(target.u || target.r)}`;
}

const sealUrl = (url, user, ttlMs = SEGMENT_TTL_MS) => seal({ u: url }, user, ttlMs);
const sealRef = (ref, user, ttlMs = SHARE_TTL_MS) => seal({ r: ref }, user, ttlMs);

/** The sealed payload, or throws 403 when the link is forged, expired or its user is gone */
async function unseal(token) {
    let payload;
    try {
        const raw = Buffer.from(token, 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    } catch {
        throw refError(403, 'Invalid link');
    }
    if (!(payload.exp > Date.now())) throw refError(403, 'Link expired');
    const user = await users.getById(payload.uid);
    if (!user || (user.tokenVersion || 0) !== payload.tv) throw refError(403, 'Link revoked');
    return { payload, user };
}

/**
 * Resolve a reference to the upstream URL.
 * Returns { url, user } - user is the owner of a sealed link (null otherwise).
 * Throws an Error with .status 400/403/404.
 */
async function resolve(ref) {
    const path = String(ref || '').split('?')[0];
    let m;

    if ((m = path.match(XTREAM_REF))) {
        const [, sourceId, type, streamId, ext] = m;
        const source = await sources.getById(sourceId);
        if (!source || source.type !== 'xtream') throw refError(404, 'Source not found');
        const base = source.url.replace(/\/$/, '');
        // Same shape as xtreamApi.buildStreamUrl (login not URL-encoded, as before)
        return { url: `${base}/${type}/${source.username}/${source.password}/${streamId}.${ext}`, user: null };
    }

    if ((m = path.match(M3U_REF))) {
        const [, sourceId, itemId] = m;
        const { getDb } = require('../db/sqlite');
        const row = getDb().prepare(`SELECT stream_url, data FROM playlist_items WHERE source_id = ? AND item_id = ? AND type = 'live'`)
            .get(parseInt(sourceId, 10), decodeURIComponent(itemId));
        const data = row?.data ? JSON.parse(row.data) : {};
        const url = row && (row.stream_url || data.stream_url || data.url);
        if (!url) throw refError(404, 'Stream not found');
        return { url, user: null };
    }

    if ((m = path.match(SEALED_REF))) {
        const { payload, user } = await unseal(m[1]);
        if (payload.u) return { url: payload.u, user };
        if (payload.r && !SEALED_REF.test(payload.r)) return { url: (await resolve(payload.r)).url, user };
        throw refError(403, 'Invalid link');
    }

    throw refError(400, 'Not a stream reference');
}

/**
 * Express middleware for routes taking ?url= (or body.url): the value must be
 * a stream reference. Sets req.streamUrl (upstream URL) and req.streamRef.
 */
function requireStreamRef(req, res, next) {
    const ref = req.query.url ?? req.body?.url;
    if (!ref) return next(); // the route reports the missing parameter
    resolve(ref).then(({ url }) => {
        req.streamRef = String(ref);
        req.streamUrl = url;
        next();
    }, err => res.status(err.status || 400).json({ error: err.message }));
}

module.exports = { xtreamRef, m3uRef, sealUrl, sealRef, resolve, requireStreamRef, SEGMENT_TTL_MS, SHARE_TTL_MS };
