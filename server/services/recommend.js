/**
 * Per-user recommendations from what each user actually watches.
 *
 * TMDB is the source of truth for "a title": every table here is keyed by
 * (kind, tmdb_id) -> tmdb_meta. The playlist's copies of a title (17 copies
 * of Inception in different categories) are links to it, not separate titles.
 *
 *   media_links  the library's copies -> their title (services/media.js, the
 *                Fleurbox media id). Rebuilt at startup and after each sync;
 *                only copies whose title has a TMDB id are used here.
 *   tmdb_recs    TMDB's own "recommendations" per title (filled by tmdbSync).
 *   user_media   per user and title: watch signal from watch_history, plus
 *                feedback (-1 = "Not for me": hidden, and counts against).
 *   user_recs    the rows last computed for a user (what Home shows).
 *
 * Method (content-based, as Jellyfin's LocalRecs; signals as Netflix
 * describes them):
 *  - Each title is a sparse vector: TMDB keywords weighted by IDF (rare
 *    keywords like "adult animation" say more than "drama"), genres, creators/
 *    directors, top cast, decade. L2-normalised.
 *  - A user's profile = sum over watched titles of signal x vector. Signal: a
 *    finished movie 1; a series log2(1 + finished episodes); a quick abandon
 *    -0.3; halved every 60 days since last watched; "Not for me" -2. The taste
 *    quiz adds a prior that fades as history grows.
 *  - Score = cosine(profile, title) x quality (fame, enough votes). Watched
 *    and "Not for me" titles are left out; so are kids titles (maturity <= 1)
 *    for someone who doesn't watch any, and anything above a kids account's
 *    limit (services/maturity.js - TMDB data only).
 *  - "Because you watched X": TMDB's recommendations for X blended with the
 *    titles closest to X's own vector.
 *
 * Search is not involved: nothing here reads or writes the search index.
 */
const { getDb } = require('../db/sqlite');
const maturity = require('./maturity');

const HALF_LIFE_DAYS = 60;
const ROW_SIZE = 20;
const BECAUSE_ROWS = 3;
const ABANDON_SECONDS = 600;
const W = { keyword: 1.0, genre: 0.4, creator: 0.6, cast: 0.3, decade: 0.2 };
const CAST_TERMS = 5;
const PER_FRANCHISE = 2;

/** Best-first picks, at most PER_FRANCHISE of one franchise */
function diverse(picks, byKey, limit) {
    const count = new Map();
    const out = [];
    for (const p of picks) {
        const f = byKey.get(keyOf(p.kind, p.id))?.franchise || `${p.kind}:${p.id}`;
        if ((count.get(f) || 0) >= PER_FRANCHISE) continue;
        count.set(f, (count.get(f) || 0) + 1);
        out.push(p);
        if (out.length >= limit) break;
    }
    return out;
}

const list = text => String(text || '').split(/\s*,\s*/).map(s => s.trim().toLowerCase()).filter(Boolean);
const keyOf = (kind, id) => `${kind}:${id}`;

// ===================== Tables =====================

let tablesReady = false;
function ensureTables() {
    if (tablesReady) return;
    require('./media').ensureTables(); // media, media_links (and tmdb_meta)
    getDb().exec(`
        CREATE TABLE IF NOT EXISTS user_media (
            user_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            tmdb_id TEXT NOT NULL,
            signal REAL NOT NULL DEFAULT 0,     -- from watch history (see header)
            watched INTEGER NOT NULL DEFAULT 0, -- finished a movie / any episode of a series
            last_watched INTEGER,               -- ms
            feedback INTEGER NOT NULL DEFAULT 0,-- -1 = "Not for me"
            feedback_at INTEGER,
            PRIMARY KEY (user_id, kind, tmdb_id)
        );
        CREATE TABLE IF NOT EXISTS user_recs (
            user_id INTEGER NOT NULL,
            row_id TEXT NOT NULL,               -- 'top' | 'because:<kind>:<id>'
            position INTEGER NOT NULL,
            kind TEXT NOT NULL,
            tmdb_id TEXT NOT NULL,
            score REAL NOT NULL,
            computed_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, row_id, position)
        );
    `);
    tablesReady = true;
}

/** Relink the library's copies to their titles (services/media.js) */
function rebuildLinks() {
    require('./media').rebuild();
    vectors = null; // the library changed
}

// ===================== Title vectors =====================

let vectors = null; // { byKey: Map(key -> { kind, id, terms: Map, maturity, quality }), builtAt }
const VECTOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function buildVectors() {
    ensureTables();
    const started = Date.now();
    const rows = getDb().prepare(`
        SELECT m.kind, m.tmdb_id, m.title, m.genres, m.keywords, m.directors, m.cast_names, m.release_date,
               m.maturity, m.fame, m.vote_count
        FROM tmdb_meta m
        WHERE m.status = 'ok'
          AND EXISTS (SELECT 1 FROM media_links l WHERE l.kind = m.kind AND l.tmdb_id = m.tmdb_id)
    `).all();

    // Document frequency of each keyword, for IDF
    const df = new Map();
    for (const r of rows) for (const k of new Set(list(r.keywords))) df.set(k, (df.get(k) || 0) + 1);
    const n = rows.length || 1;

    const byKey = new Map();
    for (const r of rows) {
        const terms = new Map();
        const add = (term, w) => terms.set(term, (terms.get(term) || 0) + w);
        // A keyword on almost every title (or on just one) says little
        for (const k of new Set(list(r.keywords))) {
            const f = df.get(k);
            if (f > 1) add(`k:${k}`, W.keyword * Math.log(n / f));
        }
        list(r.genres).forEach(g => add(`g:${g}`, W.genre));
        list(r.directors).forEach(p => add(`p:${p}`, W.creator));
        list(r.cast_names).slice(0, CAST_TERMS).forEach(p => add(`c:${p}`, W.cast));
        const year = parseInt(String(r.release_date || '').slice(0, 4), 10);
        if (year) add(`d:${Math.floor(year / 10) * 10}`, W.decade);

        let norm = 0;
        terms.forEach(w => { norm += w * w; });
        norm = Math.sqrt(norm) || 1;
        terms.forEach((w, t) => terms.set(t, w / norm));

        // Barely known titles rank lower; well known ones a little higher
        const quality = (r.vote_count >= 50 ? 1 : r.vote_count >= 10 ? 0.8 : 0.6) * (0.75 + 0.25 * (r.fame || 0));
        // First two words of the title: "American Pie Presents: Band Camp" and
        // "American Pie 2" are one franchise (rows show at most 2 of one)
        const franchise = String(r.title || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
        byKey.set(keyOf(r.kind, r.tmdb_id), { kind: r.kind, id: r.tmdb_id, terms, maturity: r.maturity, quality, franchise });
    }
    vectors = { byKey, builtAt: Date.now() };
    console.log(`[Recommend] ${byKey.size} title vectors, ${df.size} keywords, ${Date.now() - started}ms`);
    return vectors;
}

function getVectors() {
    if (!vectors || Date.now() - vectors.builtAt > VECTOR_MAX_AGE_MS) buildVectors();
    return vectors;
}

function dot(a, b) {
    // iterate the smaller map
    if (a.size > b.size) [a, b] = [b, a];
    let s = 0;
    a.forEach((w, t) => { const v = b.get(t); if (v) s += w * v; });
    return s;
}

// ===================== User signals =====================

/**
 * Refresh user_media signals from watch_history (feedback is kept).
 * Series episodes link to their series through history data.seriesId.
 */
function refreshUserMedia(userId) {
    ensureTables();
    const db = getDb();
    const history = db.prepare(`
        SELECT h.source_id, h.item_type, h.item_id, h.progress, h.duration, h.updated_at,
               json_extract(h.data, '$.seriesId') AS series_id
        FROM watch_history h WHERE h.user_id = ?
    `).all(userId);
    const link = db.prepare(`SELECT kind, tmdb_id FROM media_links WHERE source_id = ? AND item_id = ? AND kind = ?
        AND tmdb_id IS NOT NULL AND match IN ('tmdb', 'manual')`);

    const now = Date.now();
    const agg = new Map(); // key -> { kind, id, finished, partial, abandoned, last }
    for (const h of history) {
        const isEpisode = h.item_type === 'episode';
        const m = isEpisode
            ? h.series_id && link.get(h.source_id, String(h.series_id), 'tv')
            : link.get(h.source_id, String(h.item_id), 'movie') || link.get(h.source_id, String(h.item_id), 'tv');
        if (!m) continue;
        const key = keyOf(m.kind, m.tmdb_id);
        const a = agg.get(key) || { kind: m.kind, id: m.tmdb_id, finished: 0, partial: 0, abandoned: 0, last: 0, episodes: isEpisode };
        const done = h.duration > 0 && h.progress >= h.duration * 0.9;
        if (done) a.finished++;
        else if (h.progress < ABANDON_SECONDS && now - h.updated_at > 2 * 86400000) a.abandoned++;
        else if (h.duration > 0) a.partial = Math.max(a.partial, h.progress / h.duration);
        a.last = Math.max(a.last, h.updated_at || 0);
        agg.set(key, a);
    }

    const upsert = db.prepare(`
        INSERT INTO user_media (user_id, kind, tmdb_id, signal, watched, last_watched)
        VALUES (@user, @kind, @id, @signal, @watched, @last)
        ON CONFLICT(user_id, kind, tmdb_id) DO UPDATE SET
            signal = excluded.signal, watched = excluded.watched, last_watched = excluded.last_watched
    `);
    db.transaction(() => {
        // Titles no longer in the history keep only their feedback
        db.prepare('UPDATE user_media SET signal = 0, watched = 0 WHERE user_id = ?').run(userId);
        for (const a of agg.values()) {
            let signal;
            if (a.episodes) signal = a.finished ? Math.log2(1 + a.finished) : (a.abandoned && !a.partial ? -0.3 : 0.3 * a.partial);
            else signal = a.finished ? 1 : a.abandoned && !a.partial ? -0.3 : 0.3 * a.partial;
            const decay = Math.pow(0.5, (now - a.last) / (HALF_LIFE_DAYS * 86400000));
            upsert.run({ user: userId, kind: a.kind, id: a.id, signal: signal * decay, watched: a.finished > 0 ? 1 : 0, last: a.last });
        }
        db.prepare('DELETE FROM user_media WHERE user_id = ? AND signal = 0 AND watched = 0 AND feedback = 0').run(userId);
    })();
}

function userMedia(userId) {
    return getDb().prepare('SELECT * FROM user_media WHERE user_id = ?').all(userId);
}

/** "Not for me" (-1) or undo (0) */
function setFeedback(userId, kind, tmdbId, value) {
    ensureTables();
    const v = value === -1 ? -1 : 0;
    getDb().prepare(`
        INSERT INTO user_media (user_id, kind, tmdb_id, feedback, feedback_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, kind, tmdb_id) DO UPDATE SET feedback = excluded.feedback, feedback_at = excluded.feedback_at
    `).run(userId, kind, String(tmdbId), v, Date.now());
    getDb().prepare('DELETE FROM user_media WHERE user_id = ? AND signal = 0 AND watched = 0 AND feedback = 0').run(userId);
    invalidate(userId);
    return v;
}

function getFeedback(userId, kind, tmdbId) {
    ensureTables();
    return getDb().prepare('SELECT feedback FROM user_media WHERE user_id = ? AND kind = ? AND tmdb_id = ?')
        .get(userId, kind, String(tmdbId))?.feedback || 0;
}

// ===================== Ranking =====================

/**
 * The taste quiz as a starting point: its genres and motif keywords as profile
 * terms. Fades as real history grows.
 */
function quizTerms(quiz, catalog) {
    const terms = new Map();
    if (!quiz) return terms;
    const add = (t, w) => terms.set(t, (terms.get(t) || 0) + w);
    for (const id of quiz.genres || []) {
        const g = catalog.genres.find(x => x.id === id);
        (g?.names || []).forEach(name => add(`g:${name.toLowerCase()}`, W.genre));
        (g?.tvKeywords || []).forEach(k => add(`k:${k}`, W.keyword));
    }
    for (const id of quiz.motifs || []) {
        const m = catalog.motifs.find(x => x.id === id);
        (m?.keywords || []).forEach(k => add(`k:${k}`, W.keyword * 2));
    }
    return terms;
}

/**
 * Compute and store the user's recommendation rows. Returns
 * [{ id, title, because?: { kind, id }, picks: [{ kind, id, score }] }].
 * `quiz` / `catalog`: the taste quiz profile and CATALOG (services/taste.js).
 */
function compute(user, { quiz = null, catalog = null } = {}) {
    ensureTables();
    refreshUserMedia(user.id);
    const { byKey } = getVectors();
    const media = userMedia(user.id);
    const kidsMax = maturity.limitFor(user);

    // Profile vector
    const profile = new Map();
    const addVec = (terms, w) => terms.forEach((v, t) => profile.set(t, (profile.get(t) || 0) + v * w));
    let watchedTitles = 0;
    let watchesKids = false;
    for (const m of media) {
        const vec = byKey.get(keyOf(m.kind, m.tmdb_id));
        if (!vec) continue;
        const w = m.feedback === -1 ? -2 : m.signal;
        if (!w) continue;
        addVec(vec.terms, w);
        if (w > 0) {
            watchedTitles++;
            if (vec.maturity !== null && vec.maturity <= 1) watchesKids = true;
        }
    }
    if (catalog) {
        const prior = quizTerms(quiz, catalog);
        const fade = 10 / (10 + watchedTitles);
        addVec(prior, fade);
        if ((quiz?.genres || []).includes('family')) watchesKids = true;
    }
    if (!profile.size) return [];

    const excluded = new Set(media.filter(m => m.watched || m.feedback === -1).map(m => keyOf(m.kind, m.tmdb_id)));
    const allowed = vec => {
        if (excluded.has(keyOf(vec.kind, vec.id))) return false;
        if (kidsMax !== null) return vec.maturity !== null && vec.maturity <= kidsMax;
        // Kids titles only for someone who watches (or picked) them
        return watchesKids || vec.maturity === null || vec.maturity > 1;
    };

    // Top picks: profile against every title in the library
    const scored = [];
    for (const vec of byKey.values()) {
        if (!allowed(vec)) continue;
        const s = dot(profile, vec.terms) * vec.quality;
        if (s > 0) scored.push({ kind: vec.kind, id: vec.id, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const rows = [{ id: 'top', title: null, picks: diverse(scored, byKey, ROW_SIZE * 3) }];

    // Because you watched: the most-watched recent titles
    const seeds = media.filter(m => m.signal > 0 && byKey.has(keyOf(m.kind, m.tmdb_id)))
        .sort((a, b) => b.signal - a.signal).slice(0, BECAUSE_ROWS);
    const recsOf = getDb().prepare('SELECT rec_kind, rec_id, rank FROM tmdb_recs WHERE kind = ? AND tmdb_id = ? ORDER BY rank');
    for (const seed of seeds) {
        const seedVec = byKey.get(keyOf(seed.kind, seed.tmdb_id));
        const cand = new Map();
        // TMDB users' picks (rank 0 best)
        for (const r of recsOf.all(seed.kind, seed.tmdb_id)) {
            const vec = byKey.get(keyOf(r.rec_kind, r.rec_id));
            if (vec && allowed(vec)) cand.set(keyOf(vec.kind, vec.id), { vec, score: 0.5 * (1 - r.rank / 20) });
        }
        // Titles most like it
        for (const vec of byKey.values()) {
            if (vec === seedVec || !allowed(vec)) continue;
            const sim = dot(seedVec.terms, vec.terms);
            if (sim < 0.08) continue;
            const key = keyOf(vec.kind, vec.id);
            const c = cand.get(key) || { vec, score: 0 };
            c.score += 0.5 * sim;
            cand.set(key, c);
        }
        const picks = diverse([...cand.values()]
            .map(c => ({ kind: c.vec.kind, id: c.vec.id, score: c.score * c.vec.quality }))
            .sort((a, b) => b.score - a.score), byKey, ROW_SIZE * 3);
        if (picks.length) rows.push({ id: `because:${seed.kind}:${seed.tmdb_id}`, because: { kind: seed.kind, id: seed.tmdb_id }, picks });
    }

    // Store what was computed
    const db = getDb();
    const insert = db.prepare(`INSERT INTO user_recs (user_id, row_id, position, kind, tmdb_id, score, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const now = Date.now();
    db.transaction(() => {
        db.prepare('DELETE FROM user_recs WHERE user_id = ?').run(user.id);
        rows.forEach(row => row.picks.forEach((p, i) => insert.run(user.id, row.id, i, p.kind, p.id, p.score, now)));
    })();
    return rows;
}

// Per-user cache of computed rows (recomputed when history or feedback changes)
const cache = new Map(); // userId -> { at, key, rows }
const CACHE_MS = 30 * 60 * 1000;

function historyStamp(userId) {
    const r = getDb().prepare('SELECT COUNT(*) n, MAX(updated_at) t FROM watch_history WHERE user_id = ?').get(userId);
    return `${r.n}:${r.t}`;
}

function rowsFor(user, opts = {}) {
    ensureTables();
    const { builtAt } = getVectors();
    const key = JSON.stringify([historyStamp(user.id), opts.quiz?.updatedAt || null, !!user.kids, user.maxMaturity || null, builtAt]);
    const hit = cache.get(user.id);
    if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) return hit.rows;
    const rows = compute(user, opts);
    cache.set(user.id, { at: Date.now(), key, rows });
    return rows;
}

function invalidate(userId) {
    cache.delete(userId);
}

/** Changes whenever the user's history or feedback does (for callers' caches) */
function stamp(userId) {
    ensureTables();
    const f = getDb().prepare('SELECT COUNT(*) n, MAX(feedback_at) t FROM user_media WHERE user_id = ? AND feedback <> 0').get(userId);
    return `${historyStamp(userId)}|${f.n}:${f.t}|${vectors?.builtAt || 0}`;
}

/** Keys ('kind:id') the user has watched (finished a movie, any episode of a series) */
function watchedKeys(userId) {
    ensureTables();
    return new Set(getDb().prepare('SELECT kind, tmdb_id FROM user_media WHERE user_id = ? AND watched = 1').all(userId)
        .map(r => keyOf(r.kind, r.tmdb_id)));
}

/** Keys ('kind:id') a user marked "Not for me" */
function notForMe(userId) {
    ensureTables();
    return new Set(getDb().prepare('SELECT kind, tmdb_id FROM user_media WHERE user_id = ? AND feedback = -1').all(userId)
        .map(r => keyOf(r.kind, r.tmdb_id)));
}

function start() {
    ensureTables();
    const filled = maturity.backfill();
    if (filled) console.log(`[Recommend] maturity set for ${filled} titles`);
    rebuildLinks();
}

/** After a playlist sync: the library's copies changed */
function afterPlaylistSync() {
    rebuildLinks();
    cache.clear();
}

/** New TMDB data arrived (backfill finished): rebuild vectors on next use */
function afterTmdbSync() {
    maturity.backfill();
    vectors = null;
    cache.clear();
}

module.exports = { start, afterPlaylistSync, afterTmdbSync, rowsFor, setFeedback, getFeedback, notForMe, watchedKeys, invalidate, stamp, ensureTables };
