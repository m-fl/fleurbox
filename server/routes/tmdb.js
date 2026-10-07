const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../auth');
const tmdbSync = require('../services/tmdbSync');
const tmdbStats = require('../services/tmdbStats');
const imageCache = require('../services/imageCache');

/**
 * TMDB metadata backfill control. Auth is enforced by the /api gate.
 */

// GET /api/tmdb/status - backfill state, requests sent to TMDB per day by
// source (last 14 days), and the image disk cache
router.get('/status', async (req, res) => {
    try {
        res.json({
            ...tmdbSync.status(),
            requestsByDay: tmdbStats.byDay(14),
            imageCache: await imageCache.stats()
        });
    } catch (err) {
        console.error('[TMDB] Status error:', err);
        res.status(500).json({ error: 'Failed to get TMDB status' });
    }
});

// POST /api/tmdb/start  { limit?: number }  - limit runs a small test batch
router.post('/start', requireAdmin, (req, res) => {
    const limit = Math.max(0, parseInt(req.body?.limit) || 0);
    res.json(tmdbSync.start({ limit, trigger: 'manual' }));
});

// POST /api/tmdb/stop
router.post('/stop', requireAdmin, (req, res) => {
    res.json({ stopping: tmdbSync.stop() });
});

module.exports = router;
