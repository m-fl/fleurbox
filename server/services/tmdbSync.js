/**
 * TMDB metadata backfill
 *
 * Fetches overview, tagline, genres, runtime, rating, director(s) and cast from
 * TMDB for every distinct TMDB id in the synced playlist (movies + series) and
 * stores them in the local `tmdb_meta` table, so details and search never call
 * TMDB (or the IPTV provider) at view time.
 *
 * Politeness (TMDB: ~40 req/s ceiling, "respect the 429"):
 *  - CONCURRENCY requests in flight, but request *starts* are spaced by a shared
 *    limiter to at most REQUESTS_PER_SECOND (a quarter of TMDB's ceiling)
 *  - 429 -> every worker pauses for Retry-After; MAX_RATE_LIMIT_RETRIES 429s in a
 *    row (across all workers) -> stop ('rate_limited')
 *  - 401 -> stop ('auth_failed'); MAX_CONSECUTIVE_ERRORS network/5xx in a row -> stop ('errors')
 * TMDB terms: cached data may be kept at most 6 months, so rows older than
 * REFRESH_AFTER_DAYS are re-fetched on the next run.
 *
 * State is persisted in `tmdb_sync_state`, so progress survives restarts and a
 * run interrupted by a restart resumes on startup.
 */

const { getDb } = require('../db/sqlite');

const API_BASE = 'https://api.themoviedb.org/3';
const REQUESTS_PER_SECOND = 10;           // cap on request starts (TMDB ceiling ~40)
const CONCURRENCY = 8;                    // in flight at once; TMDB latency ~0.5-0.8s, so 8 are needed to reach the cap
const MAX_RATE_LIMIT_RETRIES = 3;         // consecutive 429s before stopping
const DEFAULT_RETRY_AFTER_S = 10;
const MAX_CONSECUTIVE_ERRORS = 20;
const MAX_ERROR_RETRIES = 3;              // per item, for network/5xx
const REFRESH_AFTER_DAYS = 150;           // < TMDB's 6-month cache limit
const CAST_LIMIT = 15;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class TmdbSync {
    constructor() {
        this.running = false;
        this.stopRequested = false;
        this.tablesReady = false;
        this.nextSlotAt = 0;         // rate limiter: earliest next request start
        this.pausedUntil = 0;        // set by a 429: every worker waits until then
        this.pauseStartedAt = 0;     // when the current 429 episode began
        this.consecutive429 = 0;     // 429 *episodes* in a row (see fetchOne)
    }

    /**
     * Wait for this worker's turn: starts are spaced 1000/REQUESTS_PER_SECOND ms
     * apart across all workers, and nobody starts during a 429 pause
     */
    async acquireSlot() {
        while (true) {
            const now = Date.now();
            const at = Math.max(now, this.nextSlotAt, this.pausedUntil);
            if (at <= now) {
                this.nextSlotAt = now + 1000 / REQUESTS_PER_SECOND;
                return;
            }
            await sleep(at - now);
        }
    }

    get token() {
        return process.env.TMDB_READ_TOKEN || '';
    }

    ensureTables() {
        if (this.tablesReady) return;
        getDb().exec(`
            CREATE TABLE IF NOT EXISTS tmdb_meta (
                kind TEXT NOT NULL,            -- 'movie' | 'tv'
                tmdb_id TEXT NOT NULL,
                status TEXT NOT NULL,          -- 'ok' | 'not_found'
                title TEXT,
                overview TEXT,
                tagline TEXT,
                genres TEXT,                   -- comma separated
                runtime INTEGER,               -- minutes (tv: typical episode)
                release_date TEXT,
                vote_average REAL,
                directors TEXT,                -- tv: creators
                cast_names TEXT,               -- top-billed, comma separated ('cast' is an SQL keyword)
                fetched_at INTEGER NOT NULL,   -- unix seconds
                PRIMARY KEY (kind, tmdb_id)
            );
            CREATE TABLE IF NOT EXISTS tmdb_sync_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                json TEXT NOT NULL
            );
        `);
        this.tablesReady = true;
    }

    // === persisted state ===

    getState() {
        this.ensureTables();
        const row = getDb().prepare('SELECT json FROM tmdb_sync_state WHERE id = 1').get();
        return row ? JSON.parse(row.json) : { state: 'idle' };
    }

    saveState(state) {
        getDb().prepare('INSERT INTO tmdb_sync_state (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
            .run(JSON.stringify(state));
    }

    /**
     * Distinct (kind, tmdb_id) pairs in the playlist that are missing from
     * tmdb_meta or older than the refresh window
     */
    pendingWork() {
        this.ensureTables();
        const staleBefore = Math.floor(Date.now() / 1000) - REFRESH_AFTER_DAYS * 86400;
        return getDb().prepare(`
            WITH wanted AS (
                -- The provider files ~10k series under type 'movie' (in series
                -- categories, with TV ids): the category's type decides the kind
                SELECT DISTINCT
                    CASE WHEN p.type = 'series' OR c.type = 'series' THEN 'tv' ELSE 'movie' END AS kind,
                    CAST(json_extract(p.data, '$.tmdb') AS TEXT) AS tmdb_id
                FROM playlist_items p
                LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id
                WHERE p.type IN ('movie', 'series')
                  AND CAST(json_extract(p.data, '$.tmdb') AS TEXT) GLOB '[1-9]*'
                  AND CAST(json_extract(p.data, '$.tmdb') AS TEXT) NOT GLOB '*[^0-9]*'
            )
            SELECT w.kind, w.tmdb_id FROM wanted w
            LEFT JOIN tmdb_meta m ON m.kind = w.kind AND m.tmdb_id = w.tmdb_id
            WHERE m.tmdb_id IS NULL OR m.fetched_at < ?
            ORDER BY w.kind, CAST(w.tmdb_id AS INTEGER)
        `).all(staleBefore);
    }

    status() {
        const state = this.getState();
        const counts = getDb().prepare(`SELECT kind, status, COUNT(*) n FROM tmdb_meta GROUP BY kind, status`).all();
        return { ...state, running: this.running, stored: counts, configured: !!this.token };
    }

    // === run control ===

    /**
     * Start (or resume) the backfill in the background.
     * @param {{limit?: number, trigger?: string}} opts - limit: only fetch N items (test runs)
     */
    start({ limit = 0, trigger = 'manual' } = {}) {
        if (!this.token) {
            console.log('[TMDB] TMDB_READ_TOKEN not set - backfill disabled');
            return { started: false, reason: 'not_configured' };
        }
        if (this.running) return { started: false, reason: 'already_running' };

        const work = this.pendingWork();
        if (!work.length) {
            console.log('[TMDB] Nothing to fetch - metadata is up to date');
            return { started: false, reason: 'up_to_date' };
        }

        const items = limit > 0 ? work.slice(0, limit) : work;
        // Post-sync top-ups are only allowed once a full run was started by hand
        const autoEnabled = !!this.getState().autoEnabled || (trigger === 'manual' && !limit);
        this.running = true;
        this.stopRequested = false;
        this.run(items, trigger, work.length, autoEnabled).catch(err => {
            console.error('[TMDB] Backfill crashed:', err);
            this.finish(this.getState(), 'stopped', 'crashed', err.message);
        });
        return { started: true, items: items.length, pending: work.length };
    }

    stop() {
        if (!this.running) return false;
        this.stopRequested = true;
        return true;
    }

    /**
     * On startup: a run that was 'running' when the process died is resumed
     */
    resumeIfInterrupted() {
        const state = this.getState();
        if (state.state === 'running') {
            console.log('[TMDB] Previous backfill was interrupted by a restart - resuming');
            state.resumedAfterRestart = (state.resumedAfterRestart || 0) + 1;
            this.saveState(state);
            this.start({ trigger: 'resume', limit: state.limit || 0 });
        }
    }

    finish(state, finalState, reason, detail) {
        Object.assign(state, {
            state: finalState,
            reason,
            detail: detail || null,
            finishedAt: new Date().toISOString()
        });
        this.saveState(state);
        this.running = false;
        if (state.ok > 0) require('./searchIndex').rebuild(`tmdb-${finalState}`);
        console.log(`[TMDB] Backfill ${finalState}${reason ? ` (${reason})` : ''}: ` +
            `${state.done}/${state.total} done, ${state.ok} ok, ${state.notFound} not found, ` +
            `${state.errors} errors, ${state.rateLimitHits} rate-limit waits`);
    }

    /**
     * After a playlist sync: fetch any new titles, but only once the user has
     * started a full run by hand (so a restart never kicks off a surprise bulk run)
     */
    afterPlaylistSync() {
        if (!this.getState().autoEnabled) return;
        this.start({ trigger: 'post-sync' });
    }

    async run(items, trigger, pendingTotal, autoEnabled) {
        const state = {
            state: 'running',
            reason: null,
            trigger,
            autoEnabled,
            limit: items.length < pendingTotal ? items.length : 0,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            total: items.length,
            done: 0,
            ok: 0,
            notFound: 0,
            errors: 0,
            rateLimitHits: 0,
            lastError: null
        };
        this.saveState(state);
        console.log(`[TMDB] Backfill started (${trigger}): ${items.length} items` +
            (items.length < pendingTotal ? ` of ${pendingTotal} pending` : ''));

        let consecutiveErrors = 0;
        let next = 0;
        let halt = null; // { reason, detail } - first terminal condition wins
        this.consecutive429 = 0;
        this.pausedUntil = 0;
        this.pauseStartedAt = 0;

        const worker = async () => {
            while (!halt && next < items.length) {
                if (this.stopRequested) {
                    halt = { reason: 'requested' };
                    break;
                }
                const { kind, tmdb_id } = items[next++];
                const result = await this.fetchOne(kind, tmdb_id, state);

                if (result === 'auth_failed') {
                    halt = halt || { reason: 'auth_failed', detail: 'TMDB rejected the token (401)' };
                    break;
                }
                if (result === 'rate_limited') {
                    halt = halt || { reason: 'rate_limited', detail: `TMDB returned 429 ${MAX_RATE_LIMIT_RETRIES} times in a row` };
                    break;
                }
                if (result === 'error') {
                    state.errors++;
                    if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        halt = halt || { reason: 'errors', detail: `${consecutiveErrors} consecutive errors: ${state.lastError}` };
                        break;
                    }
                } else {
                    consecutiveErrors = 0;
                    if (result === 'ok') state.ok++;
                    if (result === 'not_found') state.notFound++;
                }

                state.done++;
                if (state.done % 25 === 0) this.saveState(state);
                // Make new metadata searchable as it arrives
                if (state.done % 5000 === 0) require('./searchIndex').rebuild('tmdb-progress');
                if (state.done % 1000 === 0) {
                    console.log(`[TMDB] Progress: ${state.done}/${state.total} (${state.rateLimitHits} rate-limit waits)`);
                }
            }
        };

        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
        if (halt) return this.finish(state, 'stopped', halt.reason, halt.detail);

        return this.finish(state, 'completed', null);
    }

    /**
     * Fetch + store one item. Returns 'ok' | 'not_found' | 'error' | 'auth_failed' | 'rate_limited'
     */
    async fetchOne(kind, tmdbId, state) {
        const url = `${API_BASE}/${kind}/${tmdbId}?language=en-US&append_to_response=credits`;
        let errorRetries = 0;

        while (true) {
            await this.acquireSlot();
            const sentAt = Date.now();
            let res;
            try {
                res = await fetch(url, {
                    headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
                    signal: AbortSignal.timeout(20000)
                });
            } catch (err) {
                state.lastError = `${kind}/${tmdbId}: ${err.message}`;
                if (++errorRetries > MAX_ERROR_RETRIES) return 'error';
                await sleep(2000 * errorRetries);
                continue;
            }

            // Only a response to a request sent after the last pause says anything
            // about whether TMDB has recovered
            if (res.status !== 429 && sentAt >= this.pauseStartedAt) this.consecutive429 = 0;
            if (res.status === 200) {
                this.store(kind, tmdbId, await res.json());
                return 'ok';
            }
            if (res.status === 404) {
                this.storeNotFound(kind, tmdbId);
                return 'not_found';
            }
            if (res.status === 401) return 'auth_failed';
            if (res.status === 429) {
                state.rateLimitHits++;
                // Requests already in flight when a pause began get 429s too: same
                // episode, so they just wait and retry without counting again
                if (sentAt < this.pauseStartedAt) continue;
                if (++this.consecutive429 > MAX_RATE_LIMIT_RETRIES) return 'rate_limited';
                const retryAfter = parseInt(res.headers.get('retry-after')) || DEFAULT_RETRY_AFTER_S;
                // back off harder on each consecutive 429; every worker waits (acquireSlot)
                const waitS = retryAfter * this.consecutive429;
                this.pauseStartedAt = Date.now();
                this.pausedUntil = Math.max(this.pausedUntil, Date.now() + waitS * 1000);
                console.warn(`[TMDB] 429 rate limited - all requests paused ${waitS}s ` +
                    `(${this.consecutive429}/${MAX_RATE_LIMIT_RETRIES} in a row)`);
                state.lastRateLimitAt = new Date().toISOString();
                this.saveState(state);
                continue;
            }

            // 5xx or anything unexpected
            state.lastError = `${kind}/${tmdbId}: HTTP ${res.status}`;
            if (++errorRetries > MAX_ERROR_RETRIES) return 'error';
            await sleep(2000 * errorRetries);
        }
    }

    store(kind, tmdbId, d) {
        const credits = d.credits || {};
        const directors = kind === 'movie'
            ? (credits.crew || []).filter(p => p.job === 'Director').map(p => p.name)
            : (d.created_by || []).map(p => p.name);
        const cast = (credits.cast || [])
            .slice()
            .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
            .slice(0, CAST_LIMIT)
            .map(p => p.name);
        const runtime = kind === 'movie' ? d.runtime : (d.episode_run_time || [])[0];

        getDb().prepare(`
            INSERT INTO tmdb_meta (kind, tmdb_id, status, title, overview, tagline, genres, runtime,
                                   release_date, vote_average, directors, cast_names, fetched_at)
            VALUES (?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(kind, tmdb_id) DO UPDATE SET
                status = 'ok', title = excluded.title, overview = excluded.overview,
                tagline = excluded.tagline, genres = excluded.genres, runtime = excluded.runtime,
                release_date = excluded.release_date, vote_average = excluded.vote_average,
                directors = excluded.directors, cast_names = excluded.cast_names, fetched_at = excluded.fetched_at
        `).run(
            kind, String(tmdbId),
            d.title || d.name || null,
            d.overview || null,
            d.tagline || null,
            (d.genres || []).map(g => g.name).join(', ') || null,
            runtime || null,
            d.release_date || d.first_air_date || null,
            typeof d.vote_average === 'number' ? d.vote_average : null,
            directors.join(', ') || null,
            cast.join(', ') || null,
            Math.floor(Date.now() / 1000)
        );
    }

    storeNotFound(kind, tmdbId) {
        getDb().prepare(`
            INSERT INTO tmdb_meta (kind, tmdb_id, status, fetched_at) VALUES (?, ?, 'not_found', ?)
            ON CONFLICT(kind, tmdb_id) DO UPDATE SET status = 'not_found', fetched_at = excluded.fetched_at
        `).run(kind, String(tmdbId), Math.floor(Date.now() / 1000));
    }
}

module.exports = new TmdbSync();
