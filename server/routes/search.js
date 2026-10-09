const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../auth');
const searchIndex = require('../services/searchIndex');
const languages = require('../services/languages');
const maturity = require('../services/maturity');

/**
 * Full-text search over titles, categories and TMDB metadata.
 * Auth is enforced by the /api gate.
 *
 * GET /api/search?q=&type=live|movie|series&limit=&offset=&lang=
 * lang: language id whose titles are listed first (Settings > Language priority)
 * hard=1: also hide titles explicitly marked as another language
 * pattern: regex on the title (the active Home filter zone), case-insensitive
 */
router.get('/', (req, res) => {
    try {
        const { q, type } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        if (!['live', 'movie', 'series'].includes(type)) {
            return res.status(400).json({ error: 'Valid type (live, movie or series) is required' });
        }

        // Same validation as the zone endpoint: reject what JS can't compile
        const pattern = req.query.pattern || null;
        if (pattern) {
            try {
                new RegExp(pattern, 'i');
            } catch (e) {
                return res.status(400).json({ error: 'Invalid zone pattern', details: e.message });
            }
        }

        const result = searchIndex.search({
            q, type, limit, offset, pattern,
            lang: req.query.lang,
            hard: req.query.hard === '1'
        });
        if (!result) {
            return res.status(400).json({ error: 'Nothing to search for - enter at least one word' });
        }
        // Kids accounts: drop titles above their limit (or unrated) from the
        // results; the search itself is the same for everyone
        const kidsMax = maturity.limitFor(req.user);
        let items = result.items;
        if (kidsMax !== null) {
            const levels = maturity.levels(items.map(i => i.group_key).filter(k => /^(movie|tv):/.test(k)));
            items = items.filter(i => levels.has(i.group_key) && levels.get(i.group_key) !== null && levels.get(i.group_key) <= kidsMax);
        }
        if (type === 'live') items = maturity.filterChannels(req.user, items); // kids: whitelisted channels only
        res.json({ items, hasMore: result.hasMore, offset, limit });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error('[Search] Query failed:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// GET /api/search/languages - languages present in the playlist, for the setting
router.get('/languages', (req, res) => {
    try {
        res.json(languages.available());
    } catch (err) {
        console.error('[Search] Languages failed:', err);
        res.status(500).json({ error: 'Failed to list languages' });
    }
});

// GET /api/search/status
router.get('/status', (req, res) => {
    res.json(searchIndex.status());
});

// POST /api/search/rebuild
router.post('/rebuild', requireAdmin, (req, res) => {
    searchIndex.rebuild('manual');
    res.json({ rebuilding: true });
});

module.exports = router;
