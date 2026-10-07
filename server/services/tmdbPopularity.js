/**
 * How well known each library title is, stored in tmdb_meta:
 *  - popularity: TMDB's current popularity ("buzz"), from TMDB's public daily
 *    export files - one download per kind, no API calls, no token:
 *      http://files.tmdb.org/p/exports/movie_ids_MM_DD_YYYY.json.gz
 *      http://files.tmdb.org/p/exports/tv_series_ids_MM_DD_YYYY.json.gz
 *    Each line is {"id":13,"popularity":39.1,...}; ~1.2M movies, ~200k series.
 *  - vote_count: how many people rated it ("staying power"), from TMDB's
 *    most-rated lists (discover sorted by vote count, 500 pages x 20 = the top
 *    10,000 per kind, ~1,000 requests). A title outside those has few votes.
 *    tmdbSync also stores vote_count whenever it fetches a title.
 *  - fame (0..1): 70% vote-count percentile + 30% popularity percentile, among
 *    the library's titles of the same kind. Movie and TV numbers run on
 *    different scales, so `fame` is what compares a movie with a series.
 *
 * Search uses fame so "cast:tom hanks" leads with Forrest Gump (28k votes)
 * rather than this year's sequel buzz or a little-known documentary.
 * The export files are refreshed weekly; the most-rated lists (~1,000 API
 * calls) monthly - vote counts barely move in a week. start() runs on boot
 * only when one of them is older than that.
 */

const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');
const { getDb } = require('../db/sqlite');
const tmdbSync = require('./tmdbSync');
const tmdbStats = require('./tmdbStats');

const EXPORT_BASE = 'http://files.tmdb.org/p/exports';
const API_BASE = 'https://api.themoviedb.org/3';
const FILES = { movie: 'movie_ids', tv: 'tv_series_ids' };
const VOTE_PAGES = 500;                    // TMDB's discover page limit
const REQUEST_GAP_MS = 150;                // ~6-7 req/s, well under TMDB's ceiling
const STAYING_WEIGHT = 0.7;                // vote count vs. current popularity
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;          // export files (plain downloads)
const VOTES_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // most-rated lists (~1,000 API calls)
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let running = false;

function ensureState() {
    tmdbSync.ensureTables(); // adds the popularity/vote_count/fame columns
    getDb().exec(`
        CREATE TABLE IF NOT EXISTS tmdb_popularity_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            fetched_at INTEGER NOT NULL
        )
    `);
    const columns = new Set(getDb().prepare('PRAGMA table_info(tmdb_popularity_state)').all().map(c => c.name));
    if (!columns.has('votes_fetched_at')) {
        getDb().exec('ALTER TABLE tmdb_popularity_state ADD COLUMN votes_fetched_at INTEGER NOT NULL DEFAULT 0');
        // Before this column, every run fetched the vote lists too
        getDb().exec('UPDATE tmdb_popularity_state SET votes_fetched_at = fetched_at');
    }
}

/** { exports, votes }: when each part last ran (ms, 0 = never) */
function lastRun() {
    ensureState();
    const row = getDb().prepare('SELECT fetched_at, votes_fetched_at FROM tmdb_popularity_state WHERE id = 1').get();
    return { exports: row?.fetched_at || 0, votes: row?.votes_fetched_at || 0 };
}

/** MM_DD_YYYY for `daysAgo` days before today (UTC); exports appear ~8am UTC */
function exportDate(daysAgo) {
    const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getUTCMonth() + 1)}_${pad(d.getUTCDate())}_${d.getUTCFullYear()}`;
}

/**
 * Stream one export and collect popularity for the ids we have.
 * Returns Map(tmdb_id -> popularity), or null when no recent file exists.
 */
async function readExport(kind, wanted) {
    for (const daysAgo of [1, 2, 3]) {
        const url = `${EXPORT_BASE}/${FILES[kind]}_${exportDate(daysAgo)}.json.gz`;
        tmdbStats.record('exports');
        const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
        if (!res.ok || !res.body) continue;

        const found = new Map();
        const lines = readline.createInterface({
            input: Readable.fromWeb(res.body).pipe(zlib.createGunzip()),
            crlfDelay: Infinity
        });
        for await (const line of lines) {
            // Cheap pre-check before JSON.parse: most of ~1.2M lines aren't ours
            const m = /"id":(\d+)/.exec(line);
            if (!m || !wanted.has(m[1])) continue;
            try {
                const row = JSON.parse(line);
                if (typeof row.popularity === 'number') found.set(String(row.id), row.popularity);
            } catch { /* skip a bad line */ }
        }
        return found;
    }
    return null;
}

/**
 * Vote counts for the ids we have, from the most-rated lists.
 * Returns Map(tmdb_id -> vote_count), or null without a token / on failure.
 */
async function readVoteCounts(kind, wanted) {
    const token = process.env.TMDB_READ_TOKEN;
    if (!token) return null;

    const found = new Map();
    for (let page = 1; page <= VOTE_PAGES; page++) {
        await sleep(REQUEST_GAP_MS);
        const url = `${API_BASE}/discover/${kind}?sort_by=vote_count.desc&include_adult=false&page=${page}`;
        let res;
        for (let attempt = 0; attempt < 3; attempt++) {
            tmdbStats.record('popularity');
            res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                signal: AbortSignal.timeout(20000)
            });
            if (res.status !== 429) break;
            await sleep((parseInt(res.headers.get('retry-after'), 10) || 10) * 1000);
        }
        if (!res.ok) {
            if (page === 1) return null; // bad token or TMDB down: keep old counts
            break;                       // partial list is still useful
        }
        const body = await res.json();
        for (const r of body.results || []) {
            if (wanted.has(String(r.id))) found.set(String(r.id), r.vote_count || 0);
        }
        if (page >= (body.total_pages || 0)) break;
    }
    return found;
}

/**
 * Percentile (0..1) of each id's value among `ids`; equal values share the
 * lower rank, so the many titles with no votes all sit at 0
 */
function percentiles(ids, valueOf) {
    const sorted = ids.map(id => [id, valueOf(id)]).sort((a, b) => a[1] - b[1]);
    const out = new Map();
    let rank = 0;
    sorted.forEach(([id, value], i) => {
        if (i > 0 && value !== sorted[i - 1][1]) rank = i;
        out.set(id, sorted.length > 1 ? rank / (sorted.length - 1) : 1);
    });
    return out;
}

async function refresh({ votes: fetchVotes = true } = {}) {
    if (running) return;
    running = true;
    try {
        ensureState();
        const db = getDb();
        let imported = 0;
        let votesFetched = 0;
        for (const kind of Object.keys(FILES)) {
            const rows = db.prepare(`SELECT tmdb_id, popularity, vote_count FROM tmdb_meta WHERE kind = ? AND status = 'ok'`).all(kind);
            if (!rows.length) continue;
            const wanted = new Set(rows.map(r => r.tmdb_id));

            const popularity = await readExport(kind, wanted);
            const votes = fetchVotes ? await readVoteCounts(kind, wanted) : null;
            if (votes) votesFetched++;
            if (!popularity && !votes) {
                console.warn(`[TMDB] Popularity: nothing fetched for ${kind}`);
                continue;
            }

            // New values where fetched, otherwise what's stored
            const current = new Map(rows.map(r => [r.tmdb_id, r]));
            const popOf = id => popularity?.get(id) ?? current.get(id).popularity ?? 0;
            // On the most-rated lists = its count; not on them = fewer than the
            // last one listed, so 0 ranks it below (tmdbSync's count is kept)
            const votesOf = id => votes?.get(id) ?? current.get(id).vote_count ?? 0;
            const ids = rows.map(r => r.tmdb_id);
            const popRank = percentiles(ids, popOf);
            const voteRank = percentiles(ids, votesOf);

            const update = db.prepare('UPDATE tmdb_meta SET popularity = ?, vote_count = ?, fame = ? WHERE kind = ? AND tmdb_id = ?');
            db.transaction(() => {
                for (const id of ids) {
                    const fame = STAYING_WEIGHT * voteRank.get(id) + (1 - STAYING_WEIGHT) * popRank.get(id);
                    update.run(popOf(id), votes?.has(id) ? votes.get(id) : current.get(id).vote_count, fame, kind, id);
                }
            })();
            console.log(`[TMDB] Popularity: ${kind} - ${popularity?.size ?? 0} popularity, ${votes?.size ?? 0} vote counts, ${ids.length} titles ranked`);
            imported++;
        }
        // Nothing fetched: try again tomorrow, not next week
        if (!imported) return;
        const prev = lastRun();
        db.prepare('INSERT OR REPLACE INTO tmdb_popularity_state (id, fetched_at, votes_fetched_at) VALUES (1, ?, ?)')
            .run(Date.now(), votesFetched ? Date.now() : prev.votes);
    } catch (err) {
        console.warn('[TMDB] Popularity refresh failed:', err.message);
    } finally {
        running = false;
    }
}

function refreshIfStale() {
    const last = lastRun();
    const votesDue = Date.now() - last.votes >= VOTES_MAX_AGE_MS;
    if (votesDue || Date.now() - last.exports >= MAX_AGE_MS) return refresh({ votes: votesDue });
    return Promise.resolve();
}

function start() {
    refreshIfStale();
    setInterval(refreshIfStale, CHECK_EVERY_MS).unref();
}

module.exports = { start, refresh, refreshIfStale };
