/**
 * Fleurbox media ids: one row per movie/series title, every playlist copy
 * linked to one. Design: Claude doc "Fleurbox media identity: titles, links
 * and Live TV" (TODO #12). Live TV is deliberately not in here.
 *
 *   media            media_id (stable, never reused), kind ('movie'|'tv'),
 *                    tmdb_id (NULL for titles TMDB doesn't know), title, year,
 *                    norm (cleaned title used for matching)
 *   media_links      (source_id, item_type, item_id) -> media_id, plus kind and
 *                    tmdb_id (copies of the media row, for joins), and how the
 *                    copy was matched: 'tmdb' | 'name_year' | 'local' | 'manual'
 *   media_overrides  manual fixes from the review list (Settings > Title
 *                    matches): media_id > 0 = "this copy is that title"
 *                    (confirmed), 0 = "not the same" (never name-match it);
 *                    a rebuild applies them first and never overwrites them
 *   media_lookup     local media rows (no TMDB id) still to look up with TMDB
 *                    search by name + year, a batch at a time (scanner: TODO)
 *
 * Matching, first hit wins: a manual override; the provider's TMDB id; the
 * cleaned name + year against known titles (TMDB titles and the names of
 * copies already linked by TMDB id - a name without a year only against the
 * TMDB title itself, since a provider sometimes tags a show's copy with a
 * wrong TMDB id); else a local media row for that name + year, reused across
 * rebuilds so its id stays stable. Names carrying a full date ("WWE SmackDown
 * (20/12/2024)", "Roma - Inter 10.02.2024") never name-match.
 *
 * Movie vs TV is decided here, once: series the provider files in movie
 * categories count as TV (the category's type wins).
 */
const { getDb } = require('../db/sqlite');

// Links that mean "this copy IS that title": the provider's own TMDB id, or
// confirmed in review. Unconfirmed name + year matches stay separate titles.
const TRUSTED = `('tmdb', 'manual')`;

/**
 * SQL join from a playlist row (alias `p`) to its trusted link (alias `ml`:
 * ml.media_id, ml.kind, ml.tmdb_id). LEFT by default; inner with left=false.
 */
function linkJoin(p = 'p', ml = 'ml', left = true) {
    return `${left ? 'LEFT ' : ''}JOIN media_links ${ml} ON ${ml}.source_id = ${p}.source_id
        AND ${ml}.item_type = ${p}.type AND ${ml}.item_id = ${p}.item_id AND ${ml}.match IN ${TRUSTED}`;
}

const YEAR_SLACK = 1; // providers and TMDB disagree on release years by one
// "(20/12/2024)", "10.02.2024": a dated episode or replay, never one title
const DATED = /\b\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})\b/;

let tablesReady = false;
function ensureTables() {
    if (tablesReady) return;
    require('./tmdbSync').ensureTables();
    const db = getDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS media (
            media_id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            tmdb_id TEXT,
            title TEXT,
            year INTEGER,
            norm TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_media_tmdb ON media(kind, tmdb_id) WHERE tmdb_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_media_norm ON media(kind, norm);
        CREATE TABLE IF NOT EXISTS media_lookup (
            media_id INTEGER PRIMARY KEY,
            kind TEXT NOT NULL,
            query TEXT NOT NULL,              -- cleaned title to search for
            year INTEGER,
            status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'found' | 'none'
            attempts INTEGER NOT NULL DEFAULT 0,
            last_tried INTEGER,
            found_tmdb_id TEXT,
            added_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media_overrides (
            source_id INTEGER NOT NULL,
            item_type TEXT NOT NULL,
            item_id TEXT NOT NULL,
            media_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (source_id, item_type, item_id)
        );
    `);
    // media_links v1 (recommendations only) had no media_id: it is derived
    // data, so replace it
    const cols = db.prepare('PRAGMA table_info(media_links)').all().map(c => c.name);
    if (cols.length && !cols.includes('media_id')) db.exec('DROP TABLE media_links');
    db.exec(`
        CREATE TABLE IF NOT EXISTS media_links (
            source_id INTEGER NOT NULL,
            item_type TEXT NOT NULL,          -- playlist_items.type: 'movie' | 'series'
            item_id TEXT NOT NULL,
            media_id INTEGER NOT NULL,
            kind TEXT NOT NULL,               -- media.kind
            tmdb_id TEXT,                     -- media.tmdb_id
            match TEXT NOT NULL,              -- 'tmdb' | 'name_year' | 'local' | 'manual'
            PRIMARY KEY (source_id, item_type, item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_media_links_media ON media_links(media_id);
        -- media_links -> playlist row lookups (otherwise a scan of the source's
        -- whole type per link)
        CREATE INDEX IF NOT EXISTS idx_items_link ON playlist_items(source_id, type, item_id);
        CREATE INDEX IF NOT EXISTS idx_media_links_tmdb ON media_links(kind, tmdb_id);
    `);
    tablesReady = true;
}

// ===================== Names =====================

// Provider prefixes: "EN - ", "4K-D+ - ", "EN-TOP - 158. ", "IN-EN - ", "NF - "
const PREFIX = /^\s*(?:[A-Z0-9][A-Z0-9+&|]*(?:-[A-Z0-9+&|]+)*\s*[-|:]\s+)+(?:\d{1,4}\.\s+)?/;
const QUALITY = /\b(?:4k|8k|uhd|fhd|hd|sd|hevc|h\.?265|x265|h\.?264|raw|multi|vostfr|dual audio|subbed|dubbed)\b/gi;

/** Year in a provider name: the last "(2010)" */
function nameYear(name) {
    const all = [...String(name || '').matchAll(/\((19\d{2}|20\d{2})\)/g)];
    return all.length ? parseInt(all.at(-1)[1], 10) : null;
}

/** A year from a field that is sometimes a full date ("2026-08-16") */
function fieldYear(value) {
    const m = /\b(19\d{2}|20\d{2})\b/.exec(String(value || ''));
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Cleaned title for matching: provider prefix, bracketed tags ("(US)",
 * "(2010)", "[4K]"), quality words and punctuation removed, lower case,
 * accents folded. "EN - The Mandalorian and Grogu (2026)" -> "the mandalorian and grogu"
 */
function cleanName(name) {
    return String(name || '')
        .replace(PREFIX, '')
        .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
        .replace(QUALITY, ' ')
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

// ===================== Rebuild =====================

/**
 * Link every movie/series copy to a media row (creating rows as needed).
 * Media rows are never deleted, so their ids stay valid for user tables.
 * Returns counts per match type.
 */
function rebuild() {
    ensureTables();
    const db = getDb();
    const started = Date.now();

    const copies = db.prepare(`
        SELECT p.source_id, p.type AS item_type, p.item_id, p.name, p.year,
               CASE WHEN p.type = 'series' OR c.type = 'series' THEN 'tv' ELSE 'movie' END AS kind,
               CAST(json_extract(p.data, '$.tmdb') AS TEXT) AS tmdb_raw,
               json_extract(p.data, '$.releaseDate') AS release_date
        FROM playlist_items p
        LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id
        WHERE p.type IN ('movie', 'series')
    `).all();
    const tmdbTitles = new Map(db.prepare(`SELECT kind || ':' || tmdb_id AS k, title, release_date FROM tmdb_meta WHERE status = 'ok'`)
        .all().map(r => [r.k, r]));
    const overrides = new Map(db.prepare('SELECT source_id, item_type, item_id, media_id FROM media_overrides').all()
        .map(r => [`${r.source_id}|${r.item_type}|${r.item_id}`, r.media_id]));

    // Known media
    const byTmdb = new Map();   // 'kind:tmdb' -> row
    const byId = new Map();
    const localByName = new Map(); // 'kind|norm|year' -> row (tmdb_id NULL)
    for (const m of db.prepare('SELECT * FROM media').all()) {
        byId.set(m.media_id, m);
        if (m.tmdb_id) byTmdb.set(`${m.kind}:${m.tmdb_id}`, m);
        else localByName.set(`${m.kind}|${m.norm}|${m.year ?? ''}`, m);
    }
    const insertMedia = db.prepare('INSERT INTO media (kind, tmdb_id, title, year, norm, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    const create = (kind, tmdbId, title, year, norm) => {
        const info = insertMedia.run(kind, tmdbId, title, year, norm, now);
        const row = { media_id: Number(info.lastInsertRowid), kind, tmdb_id: tmdbId, title, year, norm };
        byId.set(row.media_id, row);
        if (tmdbId) byTmdb.set(`${kind}:${tmdbId}`, row);
        else localByName.set(`${kind}|${norm}|${year ?? ''}`, row);
        return row;
    };

    const links = [];
    const counts = { tmdb: 0, name_year: 0, local: 0, manual: 0 };
    db.transaction(() => {
        // Pass 1: copies with a TMDB id; their names become names TMDB titles are known by
        const names = new Map(); // 'kind|norm' -> Map(media_id -> { years: Set, official })
        const addName = (kind, norm, mediaId, year, official) => {
            if (!norm) return;
            const key = `${kind}|${norm}`;
            if (!names.has(key)) names.set(key, new Map());
            const byMedia = names.get(key);
            if (!byMedia.has(mediaId)) byMedia.set(mediaId, { years: new Set(), official: false });
            const entry = byMedia.get(mediaId);
            if (year) entry.years.add(year);
            if (official) entry.official = true;
        };
        const pending = [];
        for (const c of copies) {
            const key = `${c.source_id}|${c.item_type}|${c.item_id}`;
            const year = fieldYear(c.year) || nameYear(c.name) || fieldYear(c.release_date);
            const norm = cleanName(c.name);
            const manual = overrides.get(key);
            if (manual && byId.has(manual)) {
                links.push([c, byId.get(manual), 'manual']);
                continue;
            }
            const tmdb = /^[1-9]\d*$/.test(c.tmdb_raw || '') ? c.tmdb_raw : null;
            // Rejected in review ("not the same"): no name match, a local title
            if (!tmdb) { pending.push({ c, year, norm, noNameMatch: manual === 0 }); continue; }
            let m = byTmdb.get(`${c.kind}:${tmdb}`);
            if (!m) {
                const meta = tmdbTitles.get(`${c.kind}:${tmdb}`);
                const title = meta?.title || c.name;
                m = create(c.kind, tmdb, title, fieldYear(meta?.release_date) || year, cleanName(title) || norm);
            }
            links.push([c, m, 'tmdb']);
            addName(c.kind, norm, m.media_id, year, false);
            addName(c.kind, m.norm, m.media_id, m.year, true);
        }

        // Pass 2: the rest - cleaned name + year against known titles, else local
        for (const { c, year, norm, noNameMatch } of pending) {
            let m = null;
            const candidates = norm && !noNameMatch && !DATED.test(c.name) ? names.get(`${c.kind}|${norm}`) : null;
            if (candidates) {
                const ids = [...candidates.keys()];
                if (year) {
                    // Nearest year within the slack; a tie is ambiguous
                    const scored = ids.map(id => ({ id, d: Math.min(...[...candidates.get(id).years].map(y => Math.abs(y - year)), Infinity) }))
                        .filter(s => s.d <= YEAR_SLACK).sort((a, b) => a.d - b.d);
                    if (scored.length === 1 || (scored.length > 1 && scored[0].d < scored[1].d)) m = byId.get(scored[0].id);
                } else {
                    // No year: only the TMDB title itself, only if one title has it,
                    // and only a name specific enough ("Denial" alone is not)
                    const official = ids.filter(id => candidates.get(id).official);
                    const specific = norm.includes(' ') && norm.length >= 10;
                    if (official.length === 1 && specific) m = byId.get(official[0]);
                }
            }
            if (m) {
                links.push([c, m, 'name_year']);
                continue;
            }
            const key = `${c.kind}|${norm || `item:${c.source_id}:${c.item_id}`}|${year ?? ''}`;
            m = localByName.get(key) || create(c.kind, null, c.name, year, norm || `item:${c.source_id}:${c.item_id}`);
            links.push([c, m, 'local']);
        }

        db.exec('DELETE FROM media_links');
        const insert = db.prepare(`INSERT OR REPLACE INTO media_links (source_id, item_type, item_id, media_id, kind, tmdb_id, match)
            VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const [c, m, how] of links) {
            insert.run(c.source_id, c.item_type, String(c.item_id), m.media_id, m.kind, m.tmdb_id, how);
            counts[how]++;
        }
    })();

    // Lookup queue: local titles worth a TMDB search (not dated episodes or
    // replays, not unnamed items); rows whose title has since got an id leave
    db.transaction(() => {
        db.exec(`DELETE FROM media_lookup WHERE media_id IN (SELECT media_id FROM media WHERE tmdb_id IS NOT NULL)`);
        const queue = db.prepare(`INSERT OR IGNORE INTO media_lookup (media_id, kind, query, year, added_at) VALUES (?, ?, ?, ?, ?)`);
        for (const m of byId.values()) {
            if (m.tmdb_id || m.norm.startsWith('item:') || DATED.test(m.title || '') || m.norm.length < 3) continue;
            queue.run(m.media_id, m.kind, m.norm, m.year ?? null, now);
        }
    })();
    const queued = db.prepare(`SELECT COUNT(*) n FROM media_lookup WHERE status = 'pending'`).get().n;

    const total = db.prepare('SELECT COUNT(*) n FROM media').get().n;
    console.log(`[Media] ${links.length} copies linked (tmdb ${counts.tmdb}, name+year ${counts.name_year}, ` +
        `local ${counts.local}, manual ${counts.manual}); ${total} media rows; ${queued} queued for TMDB lookup; ${Date.now() - started}ms`);
    return counts;
}

/** The media row a copy belongs to, or null */
function forCopy(sourceId, itemType, itemId) {
    ensureTables();
    return getDb().prepare(`
        SELECT m.* FROM media_links l JOIN media m ON m.media_id = l.media_id
        WHERE l.source_id = ? AND l.item_type = ? AND l.item_id = ?
    `).get(sourceId, itemType, String(itemId)) || null;
}

/** Manual fix: link this copy to that media row from now on (null removes the fix) */
function setOverride(sourceId, itemType, itemId, mediaId) {
    ensureTables();
    const db = getDb();
    if (mediaId === null) {
        db.prepare('DELETE FROM media_overrides WHERE source_id = ? AND item_type = ? AND item_id = ?').run(sourceId, itemType, String(itemId));
    } else {
        db.prepare(`INSERT OR REPLACE INTO media_overrides (source_id, item_type, item_id, media_id, created_at) VALUES (?, ?, ?, ?, ?)`)
            .run(sourceId, itemType, String(itemId), mediaId, Date.now());
    }
}

// ===================== User rows: favourites and watch history =====================
//
// Favourites and history keep the copy they were made on (source_id, item_id:
// what gets played) and also record the title (media_id; episodes: season +
// episode). After each rebuild, rows whose copy left the playlist are pointed
// at another copy of the same title, so nothing downstream has to change.
// Only links that mean "the same title" count (TRUSTED) - and a local title's
// own link, which is its only copy.

let userColumnsReady = false;
function ensureUserColumns() {
    if (userColumnsReady) return;
    const db = getDb();
    const add = (table, name, type) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    };
    add('watch_history', 'media_id', 'INTEGER');
    add('watch_history', 'season', 'INTEGER');
    add('watch_history', 'episode', 'INTEGER');
    add('favorites', 'media_id', 'INTEGER');
    // Channels: what the favourite was, so a vanished one can be found again
    add('favorites', 'name', 'TEXT');
    add('favorites', 'tvg_id', 'TEXT');
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_history_user_media ON watch_history(user_id, media_id);
        CREATE INDEX IF NOT EXISTS idx_favorites_user_media ON favorites(user_id, media_id);
    `);
    userColumnsReady = true;
}

/** The title a copy belongs to (media_id) when that link can be trusted, else null */
function titleOf(sourceId, itemType, itemId) {
    ensureTables();
    const row = getDb().prepare(`
        SELECT media_id FROM media_links
        WHERE source_id = ? AND item_type = ? AND item_id = ? AND match IN ('tmdb', 'manual', 'local')
    `).get(parseInt(sourceId, 10), itemType, String(itemId));
    return row ? row.media_id : null;
}

/**
 * Fill media_id (and season/episode) on rows that lack them, then repoint
 * rows whose copy is gone - to a copy in `lang` (Settings > Language
 * Priority) when there is one. Returns { filled, repointed }.
 */
function syncUserRows(lang = '') {
    ensureTables();
    ensureUserColumns();
    const db = getDb();
    const languages = require('./languages');
    let filled = 0;
    let repointed = 0;

    db.transaction(() => {
        // Movies (and series favourites): through the copy itself
        filled += db.prepare(`
            UPDATE watch_history SET media_id = (
                SELECT l.media_id FROM media_links l
                WHERE l.source_id = watch_history.source_id AND l.item_type = 'movie'
                  AND l.item_id = watch_history.item_id AND l.match IN ('tmdb', 'manual', 'local'))
            WHERE media_id IS NULL AND item_type = 'movie'
        `).run().changes;
        // Episodes: through the series the history saved, plus season/episode
        filled += db.prepare(`
            UPDATE watch_history SET
                media_id = (
                    SELECT l.media_id FROM media_links l
                    WHERE l.source_id = watch_history.source_id AND l.item_type = 'series'
                      AND l.item_id = CAST(json_extract(watch_history.data, '$.seriesId') AS TEXT)
                      AND l.match IN ('tmdb', 'manual', 'local')),
                season = CAST(json_extract(data, '$.currentSeason') AS INTEGER),
                episode = CAST(json_extract(data, '$.currentEpisode') AS INTEGER)
            WHERE media_id IS NULL AND item_type = 'episode'
        `).run().changes;
        filled += db.prepare(`
            UPDATE favorites SET media_id = (
                SELECT l.media_id FROM media_links l
                WHERE l.source_id = favorites.source_id AND l.item_type = favorites.item_type
                  AND l.item_id = favorites.item_id AND l.match IN ('tmdb', 'manual', 'local'))
            WHERE media_id IS NULL AND item_type IN ('movie', 'series')
        `).run().changes;
    })();

    // Channel favourites saved before name/guide id were kept: fill them in
    // while the channel still exists (ids may be "xtream_<src>_<id>")
    const chan = db.prepare(`SELECT name, COALESCE(json_extract(data, '$.epg_channel_id'), json_extract(data, '$.tvgId')) AS tvg
        FROM playlist_items WHERE source_id = ? AND type = 'live' AND item_id = ?`);
    const setChan = db.prepare('UPDATE favorites SET name = ?, tvg_id = ? WHERE id = ?');
    db.transaction(() => {
        for (const f of db.prepare(`SELECT id, source_id, item_id FROM favorites WHERE item_type = 'channel' AND name IS NULL`).all()) {
            const m = /^(?:xtream|m3u)_\d+_(.+)$/.exec(String(f.item_id));
            const row = chan.get(f.source_id, m ? m[1] : String(f.item_id));
            if (row) { setChan.run(row.name, row.tvg || null, f.id); filled++; }
        }
    })();

    // Repoint: a row's copy is gone, its title has another copy
    const copiesOf = db.prepare(`
        SELECT l.source_id, l.item_id, p.name, c.name AS category
        FROM media_links l
        JOIN playlist_items p ON p.source_id = l.source_id AND p.type = l.item_type AND p.item_id = l.item_id
        LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id
        WHERE l.media_id = ? AND l.item_type = ? AND l.match IN ('tmdb', 'manual', 'local') AND p.is_hidden = 0
        ORDER BY p.rowid
    `);
    const best = (mediaId, itemType, preferLang) => {
        const copies = copiesOf.all(mediaId, itemType);
        return copies.find(c => preferLang && languages.matches(c.name, c.category, preferLang)) || copies[0] || null;
    };
    const exists = db.prepare('SELECT 1 FROM playlist_items WHERE source_id = ? AND type = ? AND item_id = ?');

    db.transaction(() => {
        // Favourite movies/series
        const favs = db.prepare(`SELECT id, user_id, source_id, item_id, item_type, media_id FROM favorites
            WHERE item_type IN ('movie', 'series') AND media_id IS NOT NULL`).all();
        for (const f of favs) {
            if (exists.get(f.source_id, f.item_type, String(f.item_id))) continue;
            const to = best(f.media_id, f.item_type, lang);
            if (!to) continue;
            // INSERT OR IGNORE semantics: a favourite of that copy may exist already
            const clash = db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND source_id = ? AND item_id = ? AND item_type = ?')
                .get(f.user_id, to.source_id, String(to.item_id), f.item_type);
            if (clash) db.prepare('DELETE FROM favorites WHERE id = ?').run(f.id);
            else db.prepare('UPDATE favorites SET source_id = ?, item_id = ? WHERE id = ?').run(to.source_id, String(to.item_id), f.id);
            repointed++;
        }
        // Movie history (episodes are resolved when played: their ids come
        // from the provider's episode list, see routes/home.js)
        const hist = db.prepare(`SELECT id, user_id, source_id, item_id, media_id FROM watch_history
            WHERE item_type = 'movie' AND media_id IS NOT NULL`).all();
        for (const h of hist) {
            if (exists.get(h.source_id, 'movie', String(h.item_id))) continue;
            const to = best(h.media_id, 'movie', lang);
            if (!to) continue;
            const newId = `${h.user_id}:${to.item_id}`;
            if (db.prepare('SELECT 1 FROM watch_history WHERE id = ?').get(newId)) continue; // that copy has its own row
            db.prepare('UPDATE watch_history SET id = ?, source_id = ?, item_id = ? WHERE id = ?')
                .run(newId, to.source_id, String(to.item_id), h.id);
            repointed++;
        }
        // Series in episode history: point data.seriesId at a live copy of the series
        const eps = db.prepare(`SELECT id, source_id, media_id, CAST(json_extract(data, '$.seriesId') AS TEXT) AS series_id
            FROM watch_history WHERE item_type = 'episode' AND media_id IS NOT NULL`).all();
        for (const e of eps) {
            if (!e.series_id || exists.get(e.source_id, 'series', e.series_id)) continue;
            const to = best(e.media_id, 'series', lang);
            if (!to) continue;
            // relinked: the episode id is from the old copy - Continue Watching
            // finds the same season/episode in the new copy (routes/home.js)
            db.prepare(`UPDATE watch_history SET source_id = ?, data = json_set(data, '$.seriesId', ?, '$.relinked', 1) WHERE id = ?`)
                .run(to.source_id, String(to.item_id), e.id);
            repointed++;
        }
    })();

    if (filled || repointed) console.log(`[Media] User rows: ${filled} linked to titles, ${repointed} moved to a live copy`);
    return { filled, repointed };
}

// ===================== Review (Settings > Title matches) =====================

/**
 * Name + year matches awaiting a decision: the copy and the title it was
 * matched to. Search keeps them separate until confirmed.
 */
function reviewList({ offset = 0, limit = 50 } = {}) {
    ensureTables();
    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) n FROM media_links WHERE match = 'name_year'`).get().n;
    const items = db.prepare(`
        SELECT l.source_id, l.item_type, l.item_id, p.name AS copy_name, p.stream_icon AS copy_icon,
               p.year AS copy_year, c.name AS copy_category,
               m.media_id, m.kind, m.tmdb_id, m.title, m.year,
               t.overview, t.genres,
               (SELECT p2.stream_icon FROM media_links l2
                  JOIN playlist_items p2 ON p2.source_id = l2.source_id AND p2.type = l2.item_type AND p2.item_id = l2.item_id
                  WHERE l2.media_id = l.media_id AND l2.match = 'tmdb' AND p2.stream_icon <> '' LIMIT 1) AS title_icon,
               (SELECT COUNT(*) FROM media_links l3 WHERE l3.media_id = l.media_id AND l3.match IN ('tmdb', 'manual')) AS title_copies
        FROM media_links l
        JOIN playlist_items p ON p.source_id = l.source_id AND p.type = l.item_type AND p.item_id = l.item_id
        LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id
        JOIN media m ON m.media_id = l.media_id
        LEFT JOIN tmdb_meta t ON t.kind = m.kind AND t.tmdb_id = m.tmdb_id AND t.status = 'ok'
        WHERE l.match = 'name_year'
        ORDER BY m.title, p.name
        LIMIT ? OFFSET ?
    `).all(limit, offset);
    return { total, items };
}

let rebuildTimer = null;
/**
 * Decide matches: 'confirm' (the copy is that title) or 'reject' (not the
 * same: it becomes its own title). Confirms apply at once; rejects relink on
 * a rebuild a few seconds after the last one, so a burst of clicks costs one.
 */
function review(copies, action) {
    ensureTables();
    const db = getDb();
    const linkOf = db.prepare('SELECT media_id FROM media_links WHERE source_id = ? AND item_type = ? AND item_id = ?');
    const markManual = db.prepare(`UPDATE media_links SET match = 'manual' WHERE source_id = ? AND item_type = ? AND item_id = ?`);
    let done = 0;
    db.transaction(() => {
        for (const { sourceId, itemType, itemId } of copies) {
            const link = linkOf.get(sourceId, itemType, String(itemId));
            if (!link) continue;
            if (action === 'confirm') {
                setOverride(sourceId, itemType, itemId, link.media_id);
                markManual.run(sourceId, itemType, String(itemId));
            } else {
                setOverride(sourceId, itemType, itemId, 0);
                db.prepare(`UPDATE media_links SET match = 'rejected' WHERE source_id = ? AND item_type = ? AND item_id = ?`)
                    .run(sourceId, itemType, String(itemId));
            }
            done++;
        }
    })();
    if (action === 'reject' && done) {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => {
            try { rebuild(); } catch (err) { console.error('[Media] Rebuild after review failed:', err); }
        }, 3000);
        rebuildTimer.unref?.();
    }
    return done;
}

module.exports = { ensureTables, rebuild, forCopy, setOverride, cleanName, nameYear, reviewList, review, linkJoin, TRUSTED,
    ensureUserColumns, titleOf, syncUserRows };
