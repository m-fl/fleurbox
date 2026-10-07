/**
 * TMDB weekly trending, fetched at most once a day and stored in `tmdb_trending`
 *
 * Home reads the ranking from the database only; TMDB is never called while a
 * page loads. start() refreshes on boot when the stored list is over a day old,
 * then checks hourly.
 */

const { getDb } = require('../db/sqlite');
const tmdbStats = require('./tmdbStats');

const API_BASE = 'https://api.themoviedb.org/3';
const KINDS = ['movie', 'tv'];
const PAGES = 3;                           // 20 titles per page
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;

let tableReady = false;
function ensureTable() {
    if (tableReady) return;
    getDb().exec(`
        CREATE TABLE IF NOT EXISTS tmdb_trending (
            kind TEXT NOT NULL,          -- 'movie' | 'tv'
            rank INTEGER NOT NULL,       -- 1 = most trending
            tmdb_id TEXT NOT NULL,
            fetched_at INTEGER NOT NULL, -- ms
            PRIMARY KEY (kind, rank)
        )
    `);
    tableReady = true;
}

/** When `kind` was last fetched (ms), or 0 */
function fetchedAt(kind) {
    ensureTable();
    return getDb().prepare('SELECT max(fetched_at) AS at FROM tmdb_trending WHERE kind = ?').get(kind)?.at || 0;
}

/** Stored trending TMDB ids for `kind`, most trending first */
function ids(kind) {
    ensureTable();
    return getDb().prepare('SELECT tmdb_id FROM tmdb_trending WHERE kind = ? ORDER BY rank')
        .all(kind).map(r => r.tmdb_id);
}

async function refresh(kind) {
    const token = process.env.TMDB_READ_TOKEN;
    if (!token) return;

    const list = [];
    for (let page = 1; page <= PAGES; page++) {
        tmdbStats.record('trending');
        const res = await fetch(`${API_BASE}/trending/${kind}/week?language=en-US&page=${page}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(20000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        (body.results || []).forEach(r => { if (!list.includes(String(r.id))) list.push(String(r.id)); });
    }
    if (list.length === 0) return; // keep the old list rather than store an empty one

    const db = getDb();
    const now = Date.now();
    const insert = db.prepare('INSERT INTO tmdb_trending (kind, rank, tmdb_id, fetched_at) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
        db.prepare('DELETE FROM tmdb_trending WHERE kind = ?').run(kind);
        list.forEach((id, i) => insert.run(kind, i + 1, id, now));
    })();
    console.log(`[TMDB] Trending ${kind}: stored ${list.length} titles`);
}

async function refreshIfStale() {
    ensureTable();
    for (const kind of KINDS) {
        if (Date.now() - fetchedAt(kind) < MAX_AGE_MS) continue;
        try {
            await refresh(kind);
        } catch (err) {
            console.warn(`[TMDB] Trending ${kind} refresh failed:`, err.message);
        }
    }
}

function start() {
    if (!process.env.TMDB_READ_TOKEN) {
        console.log('[TMDB] TMDB_READ_TOKEN not set - trending disabled');
        return;
    }
    refreshIfStale();
    setInterval(refreshIfStale, CHECK_EVERY_MS).unref();
}

module.exports = { start, ids, fetchedAt, refreshIfStale };
