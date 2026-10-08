/**
 * Which URLs the server may fetch (or hand to ffmpeg) on a user's behalf.
 *
 * The proxy, probe, remux, subtitle and transcode routes take a URL from the
 * browser. Without a check, any logged-in account could point them at this
 * machine or the home network (router admin page, other containers) and read
 * the answer back. Allowed: http(s) URLs whose host resolves to public
 * addresses only, plus the hosts of configured sources (a provider on the LAN
 * still works).
 *
 * Not covered: ffmpeg follows redirects and playlist entries itself, and DNS
 * can change between the check and the fetch. The proxy's own fetches follow
 * redirects through guardedFetch, which checks every hop.
 */
const dns = require('dns').promises;
const net = require('net');

const VERDICT_TTL_MS = 5 * 60 * 1000;
const verdicts = new Map(); // hostname -> { ok, at }

// [network, prefix length] of addresses that are not on the public internet
const BLOCKED_V4 = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

function v4ToInt(ip) {
    return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function isPrivateV4(ip) {
    const n = v4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        return (n & mask) === (v4ToInt(base) & mask);
    });
}

function isPrivate(ip) {
    if (net.isIPv4(ip)) return isPrivateV4(ip);
    const v6 = ip.toLowerCase();
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateV4(mapped[1]);
    return v6 === '::' || v6 === '::1'
        || /^f[cd]/.test(v6)          // fc00::/7 unique local
        || /^fe[89ab]/.test(v6)       // fe80::/10 link local
        || /^ff/.test(v6);            // multicast
}

/** Hostnames of the configured sources: always allowed, even on the LAN */
async function sourceHosts() {
    try {
        const { sources } = require('../db');
        const all = await sources.getAll();
        return new Set(all.map(s => {
            try { return new URL(s.url).hostname.toLowerCase(); } catch { return null; }
        }).filter(Boolean));
    } catch {
        return new Set();
    }
}

async function hostAllowed(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const cached = verdicts.get(host);
    if (cached && Date.now() - cached.at < VERDICT_TTL_MS) return cached.ok;

    let ok;
    if ((await sourceHosts()).has(host)) {
        ok = true;
    } else if (net.isIP(host)) {
        ok = !isPrivate(host);
    } else if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        ok = false;
    } else {
        try {
            const addrs = await dns.lookup(host, { all: true });
            ok = addrs.length > 0 && addrs.every(a => !isPrivate(a.address));
        } catch {
            ok = false;
        }
    }
    verdicts.set(host, { ok, at: Date.now() });
    return ok;
}

/**
 * Resolves the parsed URL, or throws an Error with .status 400 (not an
 * http(s) URL) / 403 (points at a private address)
 */
async function assertAllowed(url) {
    let parsed;
    try {
        parsed = new URL(String(url));
    } catch {
        throw Object.assign(new Error('Invalid URL'), { status: 400 });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw Object.assign(new Error('Only http(s) URLs are allowed'), { status: 400 });
    }
    if (!(await hostAllowed(parsed.hostname))) {
        throw Object.assign(new Error('URL points to a private address'), { status: 403 });
    }
    return parsed;
}

/**
 * fetch() that checks the URL and every redirect it follows (max 5).
 * The returned response's .url is the final URL, as with fetch.
 */
async function guardedFetch(url, options = {}) {
    let current = String(url);
    for (let hop = 0; hop <= 5; hop++) {
        await assertAllowed(current);
        const response = await fetch(current, { ...options, redirect: 'manual' });
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
            response.body?.cancel?.().catch(() => {});
            current = new URL(location, current).href;
            continue;
        }
        if (response.url !== current) {
            Object.defineProperty(response, 'url', { value: current });
        }
        return response;
    }
    throw Object.assign(new Error('Too many redirects'), { status: 502 });
}

/**
 * Express middleware for routes taking ?url= (or body.url): answers 400/403
 * itself when the URL is not allowed
 */
function requireAllowedUrl(req, res, next) {
    const url = req.query.url ?? req.body?.url;
    if (!url) return next(); // the route reports the missing parameter
    assertAllowed(url).then(() => next(), err => {
        res.status(err.status || 400).json({ error: err.message });
    });
}

// ffmpeg/ffprobe input option: only network protocols, never file:, concat:,
// pipe: and the like (an HLS playlist could otherwise name local files)
const FFMPEG_PROTOCOLS = ['-protocol_whitelist', 'http,https,tcp,tls,crypto,httpproxy'];

module.exports = { assertAllowed, guardedFetch, requireAllowedUrl, isPrivate, FFMPEG_PROTOCOLS };
