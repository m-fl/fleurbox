/**
 * Direct playback on the user's own provider login (services/directPlay.js).
 * Providers belong to the login: every profile on it plays on them and reports
 * what it plays; only the main profile adds, changes, removes or syncs them
 * (services/profiles.js).
 *
 *   GET    /api/direct/providers                      the user's providers (no logins)
 *   POST   /api/direct/providers                      { name?, url, username, password }
 *   PUT    /api/direct/providers/:id                  same fields; blank password = keep
 *   DELETE /api/direct/providers/:id                  also drops its catalogue
 *   GET    /api/direct/providers/:id/connection       { url, username, password } for the
 *                                                     browser's own provider requests
 *   POST   /api/direct/providers/:id/catalogue        { kind, items, reset?, done? }
 *   POST   /api/direct/providers/:id/episodes         { seriesId, episodes }
 *   POST   /api/direct/providers/:id/probe            { kind, itemId, ok, info }
 *   GET    /api/direct/resolve?type=&sourceId=&itemId=[&seriesId=&season=&episode=&container=]
 *                                                     the user's own stream for a shared copy
 */
const express = require('express');
const router = express.Router();
const directPlay = require('../services/directPlay');

// Answers carry the provider login: never cached anywhere
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// Reports are bulk writes from the browser: a budget per user per minute
// (a full sync of a 300k catalogue is ~60 chunks)
const REPORT_BUDGET = 150;
const reportCounts = new Map(); // userId -> { count, since }
function reportLimit(req, res, next) {
    const now = Date.now();
    let entry = reportCounts.get(req.user.id);
    if (!entry || now - entry.since > 60000) {
        entry = { count: 0, since: now };
        reportCounts.set(req.user.id, entry);
    }
    if (++entry.count > REPORT_BUDGET) {
        res.set('Retry-After', String(Math.ceil((entry.since + 60000 - now) / 1000)));
        return res.status(429).json({ error: 'Too many reports - try again in a minute' });
    }
    next();
}

const handle = fn => async (req, res) => {
    try {
        const result = await fn(req, res);
        if (!res.headersSent) res.json(result ?? { success: true });
    } catch (err) {
        if (!err.status) console.error('[Direct]', err);
        res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
    }
};

const accountId = req => req.user.accountId ?? req.user.id;
/** The login, for changes: main profile only */
function owner(req) {
    if (!req.user.isOwner) throw Object.assign(new Error('Only the main profile can change the provider'), { status: 403 });
    return { id: accountId(req), kids: req.user.kids };
}

router.get('/providers', handle(req => directPlay.listProviders(accountId(req))));
router.post('/providers', handle(req => directPlay.createProvider(owner(req), req.body)));
router.put('/providers/:id', handle(req => directPlay.updateProvider(owner(req), req.params.id, req.body)));
router.delete('/providers/:id', handle(req => directPlay.deleteProvider(owner(req).id, req.params.id)));
// Episode lists are read from the provider while playing, on any profile
router.get('/providers/:id/connection', handle(req => directPlay.connection(accountId(req), req.params.id)));

router.post('/providers/:id/catalogue', reportLimit, handle(req => directPlay.storeCatalogue(owner(req).id, req.params.id, req.body)));
router.post('/providers/:id/episodes', reportLimit, handle(req => directPlay.storeEpisodes(accountId(req), req.params.id, req.body)));
router.post('/providers/:id/probe', reportLimit, handle(req => directPlay.storeProbe(accountId(req), req.params.id, req.body)));

router.get('/resolve', handle(async req => ({ direct: await directPlay.resolve(req.user, req.query) })));

module.exports = router;
