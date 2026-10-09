const express = require('express');
const router = express.Router();
const { getDb } = require('../db/sqlite');
const { requireAuth } = require('../auth');
const media = require('../services/media');

// Resume only between these: a few seconds in is a start, near the end is done
const RESUME_MIN_S = 30;
const RESUME_MAX_RATIO = 0.95;

// Middleware to ensure authentication
router.use(requireAuth);

/**
 * GET /api/history
 * Returns the watch history for the authenticated user
 */
router.get('/', (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 20;

        const rows = db.prepare(`
            SELECT * FROM watch_history 
            WHERE user_id = ? 
            ORDER BY updated_at DESC 
            LIMIT ?
        `).all(userId, limit);

        const history = rows.map(row => ({
            ...row,
            data: JSON.parse(row.data || '{}')
        }));

        res.json(history);
    } catch (err) {
        console.error('[History] Error fetching history:', err);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

/**
 * POST /api/history
 * Saves/updates watch progress for an item
 */
router.post('/', (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const { id, type, parentId, progress, duration, data, sourceId } = req.body;

        if (!id || !type) {
            return res.status(400).json({ error: 'Missing required fields (id, type)' });
        }

        const compositeId = `${userId}:${id}`;
        const timestamp = Date.now();

        // The title this is a copy of (services/media.js), so progress follows
        // the title across copies; episodes by their series + season/episode
        media.ensureUserColumns();
        const isEpisode = type === 'episode';
        const mediaId = sourceId
            ? media.titleOf(sourceId, isEpisode ? 'series' : 'movie', isEpisode ? (data?.seriesId || '') : id)
            : null;
        const season = isEpisode ? parseInt(data?.currentSeason, 10) || null : null;
        const episode = isEpisode ? parseInt(data?.currentEpisode, 10) || null : null;

        const stmt = db.prepare(`
            INSERT INTO watch_history (id, user_id, source_id, item_type, item_id, parent_id, progress, duration, updated_at, data,
                                       media_id, season, episode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source_id = excluded.source_id,
                progress = excluded.progress,
                duration = excluded.duration,
                updated_at = excluded.updated_at,
                data = excluded.data,
                media_id = excluded.media_id,
                season = excluded.season,
                episode = excluded.episode
        `);

        stmt.run(
            compositeId,
            userId,
            sourceId || null,
            type,
            id.toString(),
            parentId ? parentId.toString() : null,
            progress || 0,
            duration || 0,
            timestamp,
            JSON.stringify(data || {}),
            mediaId,
            season,
            episode
        );

        res.json({ success: true, timestamp });
    } catch (err) {
        console.error('[History] Error saving progress:', err);
        res.status(500).json({ error: 'Failed to save progress' });
    }
});

/**
 * GET /api/history/resume?type=movie|episode&sourceId=&itemId=&seriesId=&season=&episode=
 * Where to resume this copy, in seconds: the user's latest position in ANY
 * copy of the same title (same season + episode for an episode). 0 = start.
 */
router.get('/resume', (req, res) => {
    try {
        media.ensureUserColumns();
        const db = getDb();
        const { type, sourceId, itemId, seriesId } = req.query;
        const isEpisode = type === 'episode';
        const mediaId = sourceId
            ? media.titleOf(sourceId, isEpisode ? 'series' : 'movie', isEpisode ? (seriesId || '') : (itemId || ''))
            : null;
        const season = parseInt(req.query.season, 10) || null;
        const episode = parseInt(req.query.episode, 10) || null;

        let row = null;
        if (mediaId && (!isEpisode || (season && episode))) {
            row = db.prepare(`
                SELECT progress, duration FROM watch_history
                WHERE user_id = ? AND media_id = ? AND item_type = ?
                  ${isEpisode ? 'AND season = ? AND episode = ?' : ''}
                ORDER BY updated_at DESC LIMIT 1
            `).get(req.user.id, mediaId, isEpisode ? 'episode' : 'movie', ...(isEpisode ? [season, episode] : []));
        }
        // No title link (or not saved with one yet): this exact copy
        if (!row && itemId) {
            row = db.prepare('SELECT progress, duration FROM watch_history WHERE id = ?').get(`${req.user.id}:${itemId}`);
        }
        const ok = row && row.duration > 0 && row.progress >= RESUME_MIN_S && row.progress < row.duration * RESUME_MAX_RATIO;
        res.json({ position: ok ? row.progress : 0, duration: row?.duration || 0 });
    } catch (err) {
        console.error('[History] Resume lookup failed:', err);
        res.status(500).json({ error: 'Resume lookup failed' });
    }
});

/**
 * DELETE /api/history/:itemId
 * Removes an item from the user's watch history
 */
router.delete('/:itemId', (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const itemId = req.params.itemId;

        const compositeId = `${userId}:${itemId}`;

        const stmt = db.prepare('DELETE FROM watch_history WHERE id = ? AND user_id = ?');
        const result = stmt.run(compositeId, userId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Item not found in history' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[History] Error deleting history item:', err);
        res.status(500).json({ error: 'Failed to delete history item' });
    }
});

module.exports = router;
