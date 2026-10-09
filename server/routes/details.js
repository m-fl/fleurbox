const express = require('express');
const router = express.Router();
const { getDb } = require('../db/sqlite');
const { settings: settingsDb } = require('../db');
const languages = require('../services/languages');
const maturity = require('../services/maturity');
const recommend = require('../services/recommend');

// Movie vs tv comes from the category: the provider files ~10k series under
// type 'movie' (see searchIndex.js)
const TMDB_KIND = `CASE WHEN p.type = 'series' OR c.type = 'series' THEN 'tv' ELSE 'movie' END`;
const CATEGORY_JOIN = `LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id`;

/**
 * Local details for the movie / series panels - no TMDB or provider call.
 * Auth is enforced by the /api gate.
 *
 * GET /api/details?type=movie|series&sourceId=&itemId=
 *
 * Returns { found, tmdb, category, info }. `info` uses the Xtream vod_info /
 * series_info field names the panels already render (plot, cast, director,
 * genre, releasedate, rating, duration_secs / episode_run_time) plus tagline.
 * tmdb=false means no stored TMDB record yet: info then holds whatever the
 * provider's own playlist data has (series carry plot/cast; movies carry none),
 * and the client falls back to the provider lookup.
 */
router.get('/', (req, res) => {
    try {
        const { type, sourceId, itemId } = req.query;
        if (!['movie', 'series'].includes(type) || !sourceId || !itemId) {
            return res.status(400).json({ error: 'type (movie|series), sourceId and itemId are required' });
        }

        require('../services/tmdbSync').ensureTables();
        // Movie vs tv comes from the category: the provider files ~10k series
        // under type 'movie' (see searchIndex.js)
        const row = getDb().prepare(`
            SELECT p.data, c.name AS category_name, m.*
            FROM playlist_items p
            LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id
            LEFT JOIN tmdb_meta m ON m.status = 'ok'
                AND m.kind = CASE WHEN p.type = 'series' OR c.type = 'series' THEN 'tv' ELSE 'movie' END
                AND m.tmdb_id = CAST(json_extract(p.data, '$.tmdb') AS TEXT)
            WHERE p.source_id = ? AND p.item_id = ?
            ORDER BY (p.type = ?) DESC
            LIMIT 1
        `).get(sourceId, String(itemId), type);

        if (!row) return res.json({ found: false, tmdb: false, category: '', info: {} });

        // Kids accounts: a title above their limit (or unrated) doesn't open
        const kidsMax = maturity.limitFor(req.user);
        if (kidsMax !== null && !(row.tmdb_id && row.maturity !== null && row.maturity <= kidsMax)) {
            return res.status(403).json({ error: 'Not available on this profile' });
        }

        const data = row.data ? JSON.parse(row.data) : {};
        const tmdb = !!row.tmdb_id;
        const info = tmdb
            ? {
                name: row.title,
                plot: row.overview || data.plot || '',
                tagline: row.tagline || '',
                genre: row.genres || data.genre || '',
                director: row.directors || data.director || '',
                cast: row.cast_names || data.cast || '',
                keywords: row.keywords || '',
                certification: row.certification || '',
                releasedate: row.release_date || data.releaseDate || '',
                rating: row.vote_average ? Math.round(row.vote_average * 10) / 10 : (data.rating || ''),
                // formatRuntime() reads movie seconds / series minutes per episode
                duration_secs: row.kind === 'movie' && row.runtime ? row.runtime * 60 : undefined,
                episode_run_time: row.kind === 'tv' && row.runtime ? row.runtime : undefined
            }
            : {
                plot: data.plot || '',
                genre: data.genre || '',
                director: data.director || '',
                cast: data.cast || '',
                releasedate: data.releaseDate || data.release_date || '',
                rating: data.rating || '',
                episode_run_time: data.episode_run_time
            };

        // The TMDB title this copy belongs to, and the user's "Not for me" on it
        const media = tmdb ? { kind: row.kind, tmdbId: row.tmdb_id, feedback: recommend.getFeedback(req.user.id, row.kind, row.tmdb_id) } : null;
        res.json({ found: true, tmdb, category: row.category_name || '', info, media });
    } catch (err) {
        console.error('[Details] Lookup failed:', err);
        res.status(500).json({ error: 'Details lookup failed' });
    }
});

/**
 * GET /api/details/variants?type=movie|series&sourceId=&itemId=
 *
 * Every copy of a title in the playlist: the same TMDB id filed under other
 * categories (languages, 4K, Netflix, top lists...). Search shows one result
 * per title; the details panels list these so another copy can be picked.
 * Language Priority copies come first; with the hard filter on, copies marked
 * as another language are left out (as in search). The opened item is always
 * included. Returns [] when the title has no TMDB id (nothing to group by).
 * Each: { sourceId, itemId, name, categoryId, category, streamIcon,
 *         containerExtension, year, rating }
 */
router.get('/variants', async (req, res) => {
    try {
        const { type, sourceId, itemId } = req.query;
        if (!['movie', 'series'].includes(type) || !sourceId || !itemId) {
            return res.status(400).json({ error: 'type (movie|series), sourceId and itemId are required' });
        }

        const db = getDb();
        const self = db.prepare(`
            SELECT p.type, ${TMDB_KIND} AS kind,
                IFNULL(CAST(json_extract(p.data, '$.tmdb') AS TEXT), '') AS tmdb
            FROM playlist_items p
            ${CATEGORY_JOIN}
            WHERE p.source_id = ? AND p.item_id = ?
            ORDER BY (p.type = ?) DESC
            LIMIT 1
        `).get(sourceId, String(itemId), type);
        if (!self || !self.tmdb || self.tmdb === '0') return res.json([]);

        const settings = await settingsDb.get();
        languages.ensureSqlFunctions();
        const lang = languages.LANGUAGES.some(l => l.id === settings.languagePriority) ? settings.languagePriority : '';
        const hard = settings.languageHardFilter && lang ? 1 : 0;

        // Same playlist type as the opened item, so every copy opens the same way
        const rows = db.prepare(`
            SELECT p.source_id, p.item_id, p.name, p.category_id, p.stream_icon,
                p.container_extension, p.year, p.rating, c.name AS category_name
            FROM playlist_items p
            ${CATEGORY_JOIN}
            WHERE p.type = @type
              AND CAST(json_extract(p.data, '$.tmdb') AS TEXT) = @tmdb
              AND ${TMDB_KIND} = @kind
              AND (
                (p.source_id = @sourceId AND p.item_id = @itemId)
                OR (p.is_hidden = 0 AND IFNULL(c.is_hidden, 0) = 0
                    AND (@hard = 0 OR lang_visible(p.name, c.name, @lang) = 1))
              )
            ORDER BY
                CASE WHEN lang_match(p.name, c.name, @lang) = 1 THEN 0 ELSE 1 END,
                c.name, p.name
            LIMIT 200
        `).all({ type: self.type, tmdb: self.tmdb, kind: self.kind, sourceId, itemId: String(itemId), lang, hard });

        res.json(rows.map(r => ({
            sourceId: r.source_id,
            itemId: r.item_id,
            name: r.name,
            categoryId: r.category_id,
            category: r.category_name || '',
            streamIcon: r.stream_icon,
            containerExtension: r.container_extension,
            year: r.year,
            rating: r.rating
        })));
    } catch (err) {
        console.error('[Details] Variants failed:', err);
        res.status(500).json({ error: 'Variants lookup failed' });
    }
});

module.exports = router;
