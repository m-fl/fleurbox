/**
 * Home page rows: per-user Continue Watching, and Trending (TMDB) matched to
 * the titles actually in the library.
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { getDb } = require('../db/sqlite');
const xtreamApi = require('../services/xtreamApi');
const tmdbTrending = require('../services/tmdbTrending');
const cache = require('../services/cache');
const languages = require('../services/languages');
const taste = require('../services/taste');

// Finished = watched to within the last 5% (credits)
const FINISHED_RATIO = 0.95;
// Less progress than this doesn't count as started (also skips playback that
// failed right away); for a series an earlier, really-watched episode shows instead
const MIN_MOVIE_PROGRESS_S = 60;
const MIN_EPISODE_PROGRESS_S = 30;

// ===================== Continue Watching =====================

/**
 * Episodes of a series in watch order (season, then episode number), from the
 * provider's series_info (cached 1h, same cache key as the proxy route)
 */
async function seriesEpisodes(sourceId, seriesId) {
    const source = await db.sources.getById(sourceId);
    if (!source) return [];
    const cacheKey = `series_info_${seriesId}`;
    let info = cache.get('xtream', source.id, cacheKey, 3600000);
    if (!info) {
        info = await xtreamApi.createFromSource(source).getSeriesInfo(seriesId);
        cache.set('xtream', source.id, cacheKey, info);
    }
    return Object.entries(info?.episodes || {})
        .sort(([a], [b]) => parseInt(a) - parseInt(b))
        .flatMap(([season, eps]) => (eps || [])
            .slice()
            .sort((a, b) => parseInt(a.episode_num) - parseInt(b.episode_num))
            .map(ep => ({ ...ep, season: parseInt(ep.season || season) })));
}

/**
 * GET /api/home/continue?limit=
 * The user's in-progress movies and series: one entry per series (its most
 * recently watched episode, or the next episode when that one was finished).
 */
router.get('/continue', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
        const rows = getDb().prepare(`
            SELECT * FROM watch_history WHERE user_id = ?
            ORDER BY updated_at DESC LIMIT 400
        `).all(req.user.id);

        const picked = [];
        const seenSeries = new Set();
        for (const row of rows) {
            if (picked.length >= limit) break;
            const data = JSON.parse(row.data || '{}');
            const finished = row.duration > 0 && row.progress >= row.duration * FINISHED_RATIO;

            if (row.item_type === 'movie') {
                if (!finished && row.progress >= MIN_MOVIE_PROGRESS_S) picked.push({ row, data });
                continue;
            }
            // Episodes: only the latest one per series counts
            const seriesKey = data.seriesId ? `${row.source_id}:${data.seriesId}` : `ep:${row.item_id}`;
            if (seenSeries.has(seriesKey)) continue;
            if (!finished && row.progress < MIN_EPISODE_PROGRESS_S) continue;
            seenSeries.add(seriesKey);
            picked.push({ row, data, finished });
        }

        // Finished episodes become "up next" (series info fetched in parallel)
        const items = await Promise.all(picked.map(async ({ row, data, finished }) => {
            const base = {
                key: row.item_type === 'movie' ? `movie:${row.item_id}` : `series:${data.seriesId || ''}:${row.item_id}`,
                item_id: row.item_id,
                item_type: row.item_type,
                source_id: row.source_id,
                progress: row.progress,
                duration: row.duration,
                updated_at: row.updated_at,
                data
            };
            if (!finished) return base;
            if (!data.seriesId || !row.source_id) return null;

            try {
                const episodes = await seriesEpisodes(row.source_id, data.seriesId);
                const at = episodes.findIndex(ep => String(ep.id) === String(row.item_id));
                const next = at >= 0 ? episodes[at + 1] : null;
                if (!next) return null; // caught up with the series
                return {
                    ...base,
                    item_id: String(next.id),
                    progress: 0,
                    duration: 0,
                    upNext: true,
                    data: {
                        ...data,
                        subtitle: `S${next.season} E${next.episode_num} - ${next.title || `Episode ${next.episode_num}`}`,
                        containerExtension: next.container_extension || data.containerExtension,
                        currentSeason: next.season,
                        currentEpisode: parseInt(next.episode_num)
                    }
                };
            } catch (err) {
                console.warn(`[Home] Up-next lookup failed for series ${data.seriesId}:`, err.message);
                return null;
            }
        }));

        res.json(items.filter(Boolean));
    } catch (err) {
        console.error('[Home] Continue watching failed:', err);
        res.status(500).json({ error: 'Failed to load continue watching' });
    }
});

/**
 * DELETE /api/home/continue?seriesId=&itemId=
 * Hide an entry from Continue Watching: a series' history entries, or one movie
 */
router.delete('/continue', (req, res) => {
    try {
        const sqlite = getDb();
        const { seriesId, itemId } = req.query;
        let result;
        if (seriesId) {
            result = sqlite.prepare(`
                DELETE FROM watch_history
                WHERE user_id = ? AND CAST(json_extract(data, '$.seriesId') AS TEXT) = ?
            `).run(req.user.id, String(seriesId));
        } else if (itemId) {
            result = sqlite.prepare('DELETE FROM watch_history WHERE user_id = ? AND item_id = ?')
                .run(req.user.id, String(itemId));
        } else {
            return res.status(400).json({ error: 'seriesId or itemId required' });
        }
        res.json({ removed: result.changes });
    } catch (err) {
        console.error('[Home] Remove from continue watching failed:', err);
        res.status(500).json({ error: 'Failed to remove' });
    }
});

// ===================== Trending =====================

// Matching the stored TMDB ranking to the library is one scan; reuse it until
// the ranking is refreshed (daily) or 30 minutes pass
const matchCache = new Map(); // kind|lang|hard -> { at, fetchedAt, items }

/**
 * GET /api/home/trending?kind=movie|tv&limit=
 * This week's TMDB trending titles (stored daily by services/tmdbTrending; no
 * TMDB call here) that are in the library, one playlist copy
 * each (preferring Settings > Language Priority), in trending order. Rows are
 * shaped like search results so the Home cards/handlers can use them.
 */
router.get('/trending', async (req, res) => {
    try {
        const kind = req.query.kind === 'tv' ? 'tv' : 'movie';
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 60);
        const settings = await db.settings.get();
        const lang = settings.languagePriority || '';
        const hard = !!(settings.languageHardFilter && lang);

        const cacheKey = `${kind}|${lang}|${hard}`;
        const fetchedAt = tmdbTrending.fetchedAt(kind);
        const cached = matchCache.get(cacheKey);
        if (cached && cached.fetchedAt === fetchedAt && Date.now() - cached.at < 30 * 60 * 1000) {
            return res.json(cached.items.slice(0, limit));
        }

        const ids = tmdbTrending.ids(kind);
        if (ids.length === 0) return res.json([]);
        const sourceIds = (await db.sources.getAll()).filter(s => s.enabled).map(s => s.id);

        // Series are only offered as p.type='series' (the provider also files
        // some under 'movie' in series categories; those can't open as a series)
        const typeClause = kind === 'tv'
            ? `p.type = 'series'`
            : `p.type = 'movie' AND (c.type IS NULL OR c.type <> 'series')`;
        const rows = getDb().prepare(`
            SELECT p.source_id, p.item_id, p.name, p.stream_icon, p.rating, p.year, p.category_id,
                   p.container_extension, p.type, p.data, c.name AS category,
                   CAST(json_extract(p.data, '$.tmdb') AS TEXT) AS tmdb_id
            FROM playlist_items p
            LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id
            WHERE ${typeClause}
              AND p.is_hidden = 0 AND (c.is_hidden IS NULL OR c.is_hidden = 0)
              AND p.source_id IN (SELECT value FROM json_each(@sources))
              AND CAST(json_extract(p.data, '$.tmdb') AS TEXT) IN (SELECT value FROM json_each(@ids))
            ORDER BY p.rowid
        `).all({ sources: JSON.stringify(sourceIds), ids: JSON.stringify(ids) });

        // Best copy per title: the priority language if there is one
        const best = new Map();
        for (const row of rows) {
            if (hard && !languages.visible(row.name, row.category, lang)) continue;
            const score = lang && languages.matches(row.name, row.category, lang) ? 1 : 0;
            const current = best.get(row.tmdb_id);
            if (!current || score > current.score) best.set(row.tmdb_id, { row, score });
        }

        const items = ids.filter(id => best.has(id)).map((id, i) => {
            const { row } = best.get(id);
            return {
                rank: i + 1,
                tmdb_id: id,
                item_id: row.item_id,
                source_id: row.source_id,
                type: kind === 'tv' ? 'series' : 'movie',
                name: row.name,
                stream_icon: row.stream_icon,
                rating: row.rating,
                year: row.year,
                category_id: row.category_id,
                container_extension: row.container_extension,
                data: {}
            };
        });
        matchCache.set(cacheKey, { at: Date.now(), fetchedAt, items });
        res.json(items.slice(0, limit));
    } catch (err) {
        console.error('[Home] Trending failed:', err);
        res.status(500).json({ error: 'Trending unavailable' });
    }
});

// ===================== Taste quiz + For You =====================

/**
 * GET /api/home/taste -> { catalog, profile } (profile null until the quiz is taken)
 * The quiz is rendered from `catalog`; services/taste.js is the place to edit it.
 */
router.get('/taste', (req, res) => {
    try {
        res.json({ catalog: taste.CATALOG, profile: taste.getProfile(req.user.id) });
    } catch (err) {
        console.error('[Home] Taste profile failed:', err);
        res.status(500).json({ error: 'Failed to load taste profile' });
    }
});

/** PUT /api/home/taste { genres[], motifs[], format, era, mood } - unknown choices are dropped */
router.put('/taste', (req, res) => {
    try {
        res.json({ profile: taste.saveProfile(req.user.id, req.body || {}) });
    } catch (err) {
        console.error('[Home] Saving taste profile failed:', err);
        res.status(500).json({ error: 'Failed to save taste profile' });
    }
});

/** DELETE /api/home/taste - forget the quiz answers */
router.delete('/taste', (req, res) => {
    try {
        taste.deleteProfile(req.user.id);
        res.json({ removed: true });
    } catch (err) {
        console.error('[Home] Removing taste profile failed:', err);
        res.status(500).json({ error: 'Failed to remove taste profile' });
    }
});

/**
 * GET /api/home/for-you -> { profile, rows: [{ id, title, emoji, items }], pending }
 * pending: TMDB popularity lists are still being fetched in the background;
 * ask again shortly for better-ranked rows.
 */
router.get('/for-you', async (req, res) => {
    try {
        const settings = await db.settings.get();
        const sourceIds = (await db.sources.getAll()).filter(s => s.enabled).map(s => s.id);
        res.json(await taste.forYou(req.user, { settings, sourceIds }));
    } catch (err) {
        console.error('[Home] For You failed:', err);
        res.status(500).json({ error: 'Recommendations unavailable' });
    }
});

module.exports = router;
