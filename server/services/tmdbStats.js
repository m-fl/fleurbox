/**
 * Counts every request that actually goes out to TMDB, per source per day, so
 * "are we hitting TMDB too often?" has a measured answer. Shown by
 * GET /api/tmdb/status (requestsByDay).
 *
 * Sources: details (tmdbSync), trending, discover, keywords, popularity
 * (most-rated lists), exports (daily export files), images (image.tmdb.org
 * downloads that missed the disk cache).
 */

const { getDb } = require('../db/sqlite');

const KEEP_DAYS = 90;
let ready = false;

function ensureTable() {
    if (ready) return;
    getDb().exec(`
        CREATE TABLE IF NOT EXISTS tmdb_request_log (
            day TEXT NOT NULL,        -- YYYY-MM-DD (UTC)
            source TEXT NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY (day, source)
        )
    `);
    ready = true;
}

function today() {
    return new Date().toISOString().slice(0, 10);
}

/** One request to TMDB went out */
function record(source) {
    try {
        ensureTable();
        getDb().prepare(`
            INSERT INTO tmdb_request_log (day, source, count) VALUES (?, ?, 1)
            ON CONFLICT(day, source) DO UPDATE SET count = count + 1
        `).run(today(), source);
    } catch (err) {
        // Counting must never break a request
        console.warn('[TMDB] Could not record request:', err.message);
    }
}

/** { 'YYYY-MM-DD': { source: count, total }, ... } for the last `days` days */
function byDay(days = 14) {
    ensureTable();
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    getDb().prepare('DELETE FROM tmdb_request_log WHERE day < ?')
        .run(new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10));
    const out = {};
    for (const r of getDb().prepare('SELECT day, source, count FROM tmdb_request_log WHERE day >= ? ORDER BY day DESC').all(since)) {
        const d = out[r.day] || (out[r.day] = { total: 0 });
        d[r.source] = r.count;
        d.total += r.count;
    }
    return out;
}

module.exports = { record, byDay };
