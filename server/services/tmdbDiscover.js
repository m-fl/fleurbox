/**
 * TMDB "what's popular right now" lists per genre / keyword, for the Home
 * "For You" rows (see routes/home.js and services/taste.js)
 *
 * Like tmdbTrending, TMDB is never called while a page waits: get() answers
 * from the `tmdb_discover` table only and queues a background fetch when a
 * list is missing or over 3 days old (failed lists wait 6 hours to retry). The queue runs one request at a time,
 * spaced REQUEST_GAP_MS apart (TMDB asks for politeness).
 *
 * Keywords (motifs such as "heist") are looked up by name once and stored in
 * `tmdb_keywords`; TMDB keyword ids are stable, so they are kept 30 days.
 */

const { getDb } = require('../db/sqlite');
const tmdbStats = require('./tmdbStats');

const API_BASE = 'https://api.themoviedb.org/3';
const PAGES = 2;                               // 20 titles per page
// "Popular in a genre right now" moves slowly; refetch every 3 days
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Keyword ids never change on TMDB
const KEYWORD_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
// A list that failed isn't retried for this long (not on every Home load)
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
const MAX_429_RETRIES = 3;
const REQUEST_GAP_MS = 300;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let tablesReady = false;
function ensureTables() {
    if (tablesReady) return;
    getDb().exec(`
        CREATE TABLE IF NOT EXISTS tmdb_discover (
            key TEXT PRIMARY KEY,        -- see listKey()
            ids TEXT NOT NULL,           -- JSON array of TMDB ids, most popular first
            fetched_at INTEGER NOT NULL  -- ms
        );
        CREATE TABLE IF NOT EXISTS tmdb_keywords (
            name TEXT PRIMARY KEY,       -- lower-cased keyword name
            ids TEXT NOT NULL,           -- JSON array of TMDB keyword ids (may be empty)
            fetched_at INTEGER NOT NULL
        );
    `);
    tablesReady = true;
}

/**
 * A list request: { kind: 'movie'|'tv', genres: [tmdb genre ids],
 * keywords: [keyword names], era: { min, max } (years), acclaimed: bool }
 * The key is the request itself, so equal requests share one stored list.
 */
function listKey(req) {
    return JSON.stringify([
        req.kind,
        (req.genres || []).slice().sort((a, b) => a - b),
        (req.keywords || []).slice().sort(),
        req.era?.min || 0,
        req.era?.max || 0,
        req.acclaimed ? 1 : 0
    ]);
}

const queue = [];             // pending requests (deduplicated by key)
const queued = new Set();
const failedAt = new Map();   // key -> ms of the last failed fetch
let authFailedAt = 0;         // bad token: no requests for a while
let running = false;

function enabled() {
    return !!process.env.TMDB_READ_TOKEN;
}

/**
 * Stored ids for a list request: { ids, fetchedAt } (ids empty when not
 * fetched yet). A missing or stale list is queued for a background fetch;
 * `pending` says so.
 */
function get(req) {
    ensureTables();
    const key = listKey(req);
    const row = getDb().prepare('SELECT ids, fetched_at FROM tmdb_discover WHERE key = ?').get(key);
    const stale = !row || Date.now() - row.fetched_at > MAX_AGE_MS;
    const backingOff = Date.now() - Math.max(failedAt.get(key) || 0, authFailedAt) < RETRY_AFTER_FAILURE_MS;
    let pending = false;
    if (stale && enabled() && !backingOff) {
        enqueue(key, req);
        pending = true;
    }
    return { ids: row ? JSON.parse(row.ids) : [], fetchedAt: row?.fetched_at || 0, pending };
}

function enqueue(key, req) {
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ key, req });
    if (!running) run();
}

/** True while lists are still being fetched */
function busy() {
    return running || queue.length > 0;
}

async function run() {
    running = true;
    try {
        while (queue.length) {
            const { key, req } = queue.shift();
            try {
                await fetchList(key, req);
                failedAt.delete(key);
            } catch (err) {
                console.warn(`[TMDB] Discover ${key} failed:`, err.message);
                failedAt.set(key, Date.now());
                if (/HTTP 401/.test(err.message)) {
                    authFailedAt = Date.now();
                    queue.forEach(q => failedAt.set(q.key, Date.now()));
                    queue.length = 0;
                    queued.clear();
                    break;
                }
            } finally {
                queued.delete(key);
            }
        }
    } finally {
        running = false;
    }
}

async function tmdb(path, attempt = 0) {
    await sleep(REQUEST_GAP_MS);
    tmdbStats.record(path.startsWith('/search/keyword') ? 'keywords' : 'discover');
    const res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
    });
    if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const wait = (parseInt(res.headers.get('retry-after'), 10) || 10) * 1000;
        await sleep(wait);
        return tmdb(path, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/**
 * TMDB keyword ids for a name: exact (case-insensitive) matches; when there is
 * none, the first result whose name contains the word
 */
async function keywordIds(name) {
    const lower = name.toLowerCase();
    const db = getDb();
    const row = db.prepare('SELECT ids, fetched_at FROM tmdb_keywords WHERE name = ?').get(lower);
    if (row && Date.now() - row.fetched_at < KEYWORD_MAX_AGE_MS) return JSON.parse(row.ids);

    const body = await tmdb(`/search/keyword?query=${encodeURIComponent(name)}&page=1`);
    const results = body.results || [];
    let ids = results.filter(k => String(k.name).toLowerCase() === lower).map(k => k.id);
    if (!ids.length) {
        const loose = results.find(k => String(k.name).toLowerCase().includes(lower));
        if (loose) ids = [loose.id];
    }
    db.prepare('INSERT OR REPLACE INTO tmdb_keywords (name, ids, fetched_at) VALUES (?, ?, ?)')
        .run(lower, JSON.stringify(ids), Date.now());
    return ids;
}

async function fetchList(key, req) {
    const params = new URLSearchParams({
        language: 'en-US',
        include_adult: 'false',
        sort_by: 'popularity.desc',
        'vote_count.gte': req.acclaimed ? '300' : '20'
    });
    if (req.acclaimed) params.set('vote_average.gte', '7.2');
    // "|" = any of them (a comma would mean all of them)
    if (req.genres?.length) params.set('with_genres', req.genres.join('|'));
    if (req.keywords?.length) {
        const ids = [];
        for (const name of req.keywords) ids.push(...await keywordIds(name));
        if (!ids.length) {
            store(key, []); // no such keyword on TMDB: remember, don't retry hourly
            return;
        }
        params.set('with_keywords', [...new Set(ids)].join('|'));
    }
    const dateField = req.kind === 'tv' ? 'first_air_date' : 'primary_release_date';
    if (req.era?.min) params.set(`${dateField}.gte`, `${req.era.min}-01-01`);
    if (req.era?.max) params.set(`${dateField}.lte`, `${req.era.max}-12-31`);

    const list = [];
    for (let page = 1; page <= PAGES; page++) {
        params.set('page', String(page));
        const body = await tmdb(`/discover/${req.kind}?${params}`);
        (body.results || []).forEach(r => { if (!list.includes(String(r.id))) list.push(String(r.id)); });
        if (page >= (body.total_pages || 0)) break;
    }
    store(key, list);
}

function store(key, ids) {
    getDb().prepare('INSERT OR REPLACE INTO tmdb_discover (key, ids, fetched_at) VALUES (?, ?, ?)')
        .run(key, JSON.stringify(ids), Date.now());
}

module.exports = { get, busy, enabled, listKey };
