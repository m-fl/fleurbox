const express = require('express');
const router = express.Router();
const { getDb } = require('../db/sqlite');

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

        res.json({ found: true, tmdb, category: row.category_name || '', info });
    } catch (err) {
        console.error('[Details] Lookup failed:', err);
        res.status(500).json({ error: 'Details lookup failed' });
    }
});

module.exports = router;
