const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../auth');
const media = require('../services/media');

/**
 * Fleurbox media ids (services/media.js). Admin only.
 *
 * GET  /api/media/review?offset=&limit=   name + year matches awaiting a decision
 * POST /api/media/review { action: 'confirm'|'reject', copies: [{ sourceId, itemType, itemId }] }
 */
router.use(requireAdmin);

router.get('/review', (req, res) => {
    try {
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        res.json(media.reviewList({ offset, limit }));
    } catch (err) {
        console.error('[Media] Review list failed:', err);
        res.status(500).json({ error: 'Failed to load matches' });
    }
});

router.post('/review', (req, res) => {
    try {
        const { action } = req.body || {};
        const copies = Array.isArray(req.body?.copies) ? req.body.copies.slice(0, 500) : [];
        if (!['confirm', 'reject'].includes(action) || !copies.length) {
            return res.status(400).json({ error: "action ('confirm'|'reject') and copies[] are required" });
        }
        const valid = copies.filter(c => Number.isInteger(c?.sourceId) && ['movie', 'series'].includes(c?.itemType)
            && /^[A-Za-z0-9_.:-]{1,64}$/.test(String(c?.itemId ?? '')));
        res.json({ updated: media.review(valid, action) });
    } catch (err) {
        console.error('[Media] Review failed:', err);
        res.status(500).json({ error: 'Failed to save' });
    }
});

module.exports = router;
