const express = require('express');
const router = express.Router();
const { favorites } = require('../db/sqlite');
const { requireAuth } = require('../auth');
const media = require('../services/media');

/** Movies/series: the title (services/media.js) the copy belongs to, or null */
function titleFor(sourceId, itemId, itemType) {
    media.ensureUserColumns();
    return ['movie', 'series'].includes(itemType) ? media.titleOf(sourceId, itemType, itemId) : null;
}

/** Channels: name and guide id, kept so a vanished channel can be found again */
function channelInfo(sourceId, itemId) {
    const { getDb } = require('../db/sqlite');
    const m = /^(?:xtream|m3u)_\d+_(.+)$/.exec(String(itemId));
    return getDb().prepare(`
        SELECT name, COALESCE(json_extract(data, '$.epg_channel_id'), json_extract(data, '$.tvgId')) AS tvgId
        FROM playlist_items WHERE source_id = ? AND type = 'live' AND item_id = ?
    `).get(parseInt(sourceId, 10), m ? m[1] : String(itemId)) || {};
}

// All favorites routes require authentication
router.use(requireAuth);

// Get all favorites for current user
router.get('/', async (req, res) => {
    try {
        const { sourceId, itemType } = req.query;
        const items = favorites.getAll(req.user.id, sourceId || null, itemType || null);
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add favorite for current user
router.post('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        media.ensureUserColumns();
        const extra = itemType === 'channel'
            ? channelInfo(sourceId, itemId)
            : { mediaId: titleFor(sourceId, itemId, itemType) };
        favorites.add(req.user.id, sourceId, itemId, itemType, extra);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove favorite for current user
router.delete('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        favorites.remove(req.user.id, sourceId, itemId, itemType, titleFor(sourceId, itemId, itemType));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check if item is favorited by current user
router.get('/check', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.query;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        const isFav = favorites.isFavorite(req.user.id, sourceId, itemId, itemType, titleFor(sourceId, itemId, itemType));
        res.json({ isFavorite: isFav });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

