/**
 * Disk cache for images served by GET /api/proxy/image (posters, channel logos)
 *
 * Every image is downloaded once and then served from data/cache/images/:
 *  - TMDB images (image.tmdb.org, www.themoviedb.org) never change at a given URL, so they are
 *    kept forever and browsers may keep them a year.
 *  - Other images (provider channel logos) are re-checked after REVALIDATE_MS;
 *    if the source is down, the stored copy is served anyway.
 * Concurrent requests for the same URL share one download. Only image/*
 * responses up to MAX_BYTES are stored.
 */

const { guardedFetch } = require('./urlGuard');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const tmdbStats = require('./tmdbStats');

const DIR = path.join(__dirname, '..', '..', 'data', 'cache', 'images');
const REVALIDATE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;

const inFlight = new Map(); // url -> Promise<entry>

function isTmdb(url) {
    try {
        return ['image.tmdb.org', 'www.themoviedb.org'].includes(new URL(url).hostname);
    } catch {
        return false;
    }
}

function filesFor(url) {
    const hash = crypto.createHash('sha256').update(url).digest('hex');
    const dir = path.join(DIR, hash.slice(0, 2));
    return { dir, data: path.join(dir, `${hash}.bin`), meta: path.join(dir, `${hash}.json`) };
}

async function readEntry(url) {
    const files = filesFor(url);
    try {
        const meta = JSON.parse(await fsp.readFile(files.meta, 'utf8'));
        await fsp.access(files.data);
        return { ...meta, file: files.data };
    } catch {
        return null;
    }
}

async function download(url) {
    if (isTmdb(url)) tmdbStats.record('images');
    const res = await guardedFetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/*,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const declared = (res.headers.get('content-type') || '').split(';')[0].trim();
    const body = Buffer.from(await res.arrayBuffer());
    // Some logo hosts send images as octet-stream or with no type at all
    const type = declared.toLowerCase().startsWith('image/') ? declared : (sniff(body) || declared);
    return { type, body };
}

/** Image type from the file's first bytes, or null */
function sniff(body) {
    const hex = body.subarray(0, 12).toString('hex');
    if (hex.startsWith('89504e47')) return 'image/png';
    if (hex.startsWith('ffd8ff')) return 'image/jpeg';
    if (hex.startsWith('47494638')) return 'image/gif';
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'image/webp';
    if (hex.startsWith('00000100')) return 'image/x-icon';
    if (hex.startsWith('424d')) return 'image/bmp';
    return null;
}

async function store(url, type, body) {
    const files = filesFor(url);
    await fsp.mkdir(files.dir, { recursive: true });
    // Write to temp names then rename, so a reader never sees half a file
    const tmp = `${files.data}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, files.data);
    const meta = { url, type, size: body.length, fetchedAt: Date.now() };
    await fsp.writeFile(`${files.meta}.tmp`, JSON.stringify(meta));
    await fsp.rename(`${files.meta}.tmp`, files.meta);
    return { ...meta, file: files.data };
}

/**
 * The image for `url`: { type, file } from disk (stored now if it wasn't),
 * or { type, body } when it could not be stored (not an image, too big).
 * Throws { status } when the source fails and nothing is stored.
 */
async function get(url) {
    const cached = await readEntry(url);
    const fresh = cached && (isTmdb(url) || Date.now() - cached.fetchedAt < REVALIDATE_MS);
    if (fresh) return cached;

    if (inFlight.has(url)) return inFlight.get(url);
    const job = (async () => {
        try {
            const { type, body } = await download(url);
            if (!type.startsWith('image/') || body.length > MAX_BYTES) return { type: type || 'application/octet-stream', body };
            return await store(url, type, body);
        } catch (err) {
            if (cached) return cached; // source down: the old copy beats nothing
            throw err;
        } finally {
            inFlight.delete(url);
        }
    })();
    inFlight.set(url, job);
    return job;
}

/** Browser cache lifetime for this URL (seconds) */
function maxAge(url) {
    return isTmdb(url) ? 365 * 24 * 60 * 60 : 7 * 24 * 60 * 60;
}

/** Files and bytes stored, for status */
async function stats() {
    let files = 0;
    let bytes = 0;
    try {
        for (const sub of await fsp.readdir(DIR)) {
            for (const name of await fsp.readdir(path.join(DIR, sub))) {
                if (!name.endsWith('.bin')) continue;
                files++;
                bytes += (await fsp.stat(path.join(DIR, sub, name))).size;
            }
        }
    } catch { /* nothing cached yet */ }
    return { files, bytes };
}

module.exports = { get, maxAge, stats, isTmdb, createReadStream: file => fs.createReadStream(file) };
