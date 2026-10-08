/**
 * How well known each library title is, stored in tmdb_meta:
 *  - popularity: TMDB's current popularity ("buzz"), from TMDB's public daily
 *    export files - one download per kind, no API calls, no token:
 *      http://files.tmdb.org/p/exports/movie_ids_MM_DD_YYYY.json.gz
 *      http://files.tmdb.org/p/exports/tv_series_ids_MM_DD_YYYY.json.gz
 *    Each line is {"id":13,"popularity":39.1,...}; ~1.2M movies, ~200k series.
 *  - vote_count: how many people rated it ("staying power"), from TMDB's
 *    most-rated lists (discover sorted by vote count, 500 pages x 20 = the top
 *    10,000 per kind, 1,000 pages in all). A title outside those has few votes.
 *    tmdbSync also stores vote_count when it first fetches a title.
 *  - fame (0..1): 70% vote-count percentile + 30% popularity percentile, among
 *    the library's titles of the same kind. Movie and TV numbers run on
 *    different scales, so `fame` is what compares a movie with a series.
 *
 * Search uses fame so "cast:tom hanks" leads with Forrest Gump (28k votes)
 * rather than this year's sequel buzz or a little-known documentary.
 * The export files are refreshed weekly. The most-rated lists are walked as a
 * rolling crawl: a few pages a day (VOTE_PAGES_PER_DAY), one full pass every
 * ~VOTE_CYCLE_DAYS - vote counts barely move, and this keeps TMDB traffic to a
 * trickle instead of a 1,000-request burst. The crawl position is persisted,
 * so restarts neither repeat nor skip pages.
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
const KINDS = Object.keys(FILES);
const VOTE_PAGES = 500;                    // TMDB's discover page limit, per kind
const TOTAL_VOTE_PAGES = VOTE_PAGES * KINDS.length;
const VOTE_CYCLE_DAYS = 150;               // one full pass over the most-rated lists
const VOTE_PAGES_PER_DAY = Math.ceil(TOTAL_VOTE_PAGES / VOTE_CYCLE_DAYS);
const REQUEST_GAP_MS = 150;                // ~6-7 req/s, well under TMDB's ceiling
const STAYING_WEIGHT = 0.7;                // vote count vs. current popularity
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 7 * DAY_MS;             // export files (plain downloads)
const CHECK_EVERY_MS = 60 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let running = false;
let exportsRetryAt = 0;                    // after a failed export download: wait a day

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
    // Rolling crawl position: 0..TOTAL_VOTE_PAGES-1 (movie pages, then tv pages)
    if (!columns.has('votes_cursor')) {
        getDb().exec('ALTER TABLE tmdb_popularity_state ADD COLUMN votes_cursor INTEGER NOT NULL DEFAULT 0');
    }
}

/** { exports, votes, cursor }: when each part last ran (ms, 0 = never) and the crawl position */
function lastRun() {
    ensureState();
    const row = getDb().prepare('SELECT fetched_at, votes_fetched_at, votes_cursor FROM tmdb_popularity_state WHERE id = 1').get();
    return { exports: row?.fetched_at || 0, votes: row?.votes_fetched_at || 0, cursor: row?.votes_cursor || 0 };
}

function saveState({ exports, votes, cursor }) {
    getDb().prepare('INSERT OR REPLACE INTO tmdb_popularity_state (id, fetched_at, votes_fetched_at, votes_cursor) VALUES (1, ?, ?, ?)')
        .run(exports, votes, cursor);
}

/** Library TMDB ids of `kind` with a stored record */
function libraryIds(kind) {
    return new Set(getDb().prepare(`SELECT tmdb_id FROM tmdb_meta WHERE kind = ? AND status = 'ok'`)
        .all(kind).map(r => r.tmdb_id));
}

/** MM_DD_YYYY for `daysAgo` days before today (UTC); exports appear ~8am UTC */
function exportDate(daysAgo) {
    const d = new Date(Date.now() - daysAgo * DAY_MS);
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

/** One most-rated page: the parsed body, or null on failure (429s retried) */
async function fetchVotePage(kind, page, token) {
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
    return res.ok ? res.json() : null;
}

/**
 * Today's slice of the rolling most-rated crawl, from `cursor`.
 * Returns { found: { kind: Map(tmdb_id -> vote_count) }, cursor, pages },
 * or null without a token. A failed page ends the slice there, so it is
 * retried on the next run.
 */
async function readVoteSlice(cursor) {
    const token = process.env.TMDB_READ_TOKEN;
    if (!token) return null;

    const wanted = Object.fromEntries(KINDS.map(kind => [kind, libraryIds(kind)]));
    const found = Object.fromEntries(KINDS.map(kind => [kind, new Map()]));
    let pages = 0;
    while (pages < VOTE_PAGES_PER_DAY) {
        const kindIndex = Math.floor(cursor / VOTE_PAGES);
        const kind = KINDS[kindIndex];
        const page = cursor % VOTE_PAGES + 1;
        let body;
        try {
            body = await fetchVotePage(kind, page, token);
        } catch (err) {
            console.warn(`[TMDB] Popularity: most-rated ${kind} page ${page} failed:`, err.message);
            break;
        }
        if (!body) break;
        pages++;
        for (const r of body.results || []) {
            if (wanted[kind].has(String(r.id))) found[kind].set(String(r.id), r.vote_count || 0);
        }
        // Past this kind's last page: go on with the next kind
        const lastPage = Math.min(VOTE_PAGES, body.total_pages || 0);
        cursor = page >= lastPage ? (kindIndex + 1) * VOTE_PAGES : cursor + 1;
        if (cursor >= TOTAL_VOTE_PAGES) cursor = 0; // pass complete: start over
    }
    return { found, cursor, pages };
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

/** Recompute fame for `kind` from the stored popularity and vote counts */
function rerank(kind) {
    const db = getDb();
    const rows = db.prepare(`SELECT tmdb_id, popularity, vote_count FROM tmdb_meta WHERE kind = ? AND status = 'ok'`).all(kind);
    if (!rows.length) return;
    const current = new Map(rows.map(r => [r.tmdb_id, r]));
    const ids = rows.map(r => r.tmdb_id);
    const popRank = percentiles(ids, id => current.get(id).popularity ?? 0);
    const voteRank = percentiles(ids, id => current.get(id).vote_count ?? 0);
    const update = db.prepare('UPDATE tmdb_meta SET fame = ? WHERE kind = ? AND tmdb_id = ?');
    db.transaction(() => {
        for (const id of ids) {
            update.run(STAYING_WEIGHT * voteRank.get(id) + (1 - STAYING_WEIGHT) * popRank.get(id), kind, id);
        }
    })();
}

/** Store `column` values from Map(tmdb_id -> value) for `kind` */
function storeColumn(kind, column, values) {
    const db = getDb();
    const update = db.prepare(`UPDATE tmdb_meta SET ${column} = ? WHERE kind = ? AND tmdb_id = ?`);
    db.transaction(() => {
        for (const [id, value] of values) update.run(value, kind, id);
    })();
}

async function refresh({ exports: fetchExports = true, votes: fetchVotes = true } = {}) {
    if (running) return;
    running = true;
    try {
        const state = lastRun();
        const changed = new Set();

        if (fetchExports) {
            let imported = 0;
            for (const kind of KINDS) {
                const wanted = libraryIds(kind);
                if (!wanted.size) continue;
                const popularity = await readExport(kind, wanted);
                if (!popularity) {
                    console.warn(`[TMDB] Popularity: no recent export for ${kind}`);
                    continue;
                }
                storeColumn(kind, 'popularity', popularity);
                changed.add(kind);
                imported++;
                console.log(`[TMDB] Popularity: ${kind} - ${popularity.size} popularity values`);
            }
            // Nothing fetched: try again tomorrow, not next week
            if (imported) state.exports = Date.now();
            else exportsRetryAt = Date.now() + DAY_MS;
        }

        if (fetchVotes) {
            const slice = await readVoteSlice(state.cursor);
            if (slice) {
                for (const kind of KINDS) {
                    if (!slice.found[kind].size) continue;
                    storeColumn(kind, 'vote_count', slice.found[kind]);
                    changed.add(kind);
                }
                const counts = KINDS.map(kind => `${slice.found[kind].size} ${kind}`).join(', ');
                console.log(`[TMDB] Popularity: most-rated crawl ${slice.pages} pages ` +
                    `(position ${state.cursor} -> ${slice.cursor} of ${TOTAL_VOTE_PAGES}), vote counts for ${counts}`);
                state.cursor = slice.cursor;
            }
            // Even a failed slice waits a day, so a bad token isn't retried hourly
            state.votes = Date.now();
        }

        changed.forEach(rerank);
        saveState(state);
    } catch (err) {
        console.warn('[TMDB] Popularity refresh failed:', err.message);
    } finally {
        running = false;
    }
}

function refreshIfStale() {
    const last = lastRun();
    const exportsDue = Date.now() - last.exports >= MAX_AGE_MS && Date.now() >= exportsRetryAt;
    const votesDue = Date.now() - last.votes >= DAY_MS;
    if (exportsDue || votesDue) return refresh({ exports: exportsDue, votes: votesDue });
    return Promise.resolve();
}

function start() {
    refreshIfStale();
    setInterval(refreshIfStale, CHECK_EVERY_MS).unref();
}

module.exports = { start, refresh, refreshIfStale };
