const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../auth');
const { sources } = require('../db');
const { getDb } = require('../db/sqlite'); // Import SQLite
const xtreamApi = require('../services/xtreamApi');
const epgParser = require('../services/epgParser');
const cache = require('../services/cache');
const { redact } = require('../services/redact');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { Readable } = require('stream');
const imageCache = require('../services/imageCache');

const { proxyStream, lockDown } = require('./stream');
const streamRef = require('../services/streamRef');
const maturity = require('../services/maturity');

// Default cache max age in hours
const DEFAULT_MAX_AGE_HOURS = 24;

// Helper to get formatted category list from DB
function getCategoriesFromDb(sourceId, type, includeHidden = false) {
    const db = getDb();
    let query = `
        SELECT category_id, name as category_name, parent_id 
        FROM categories 
        WHERE source_id = ? AND type = ?
    `;
    if (!includeHidden) {
        query += ` AND is_hidden = 0`;
    }
    query += ` ORDER BY name ASC`;
    const cats = db.prepare(query).all(sourceId, type);
    return cats;
}

// Helper to get formatted streams from DB. kidsMax: a kids account's limit
// (services/maturity.js) - only titles rated within it; null = no filter
function getStreamsFromDb(sourceId, type, categoryId = null, includeHidden = false, kidsMax = null) {
    const db = getDb();
    let query = `
        SELECT item_id, name, stream_icon, added_at, rating, container_extension, year, category_id, data
        FROM playlist_items p
        WHERE source_id = ? AND type = ?
    `;
    if (!includeHidden) {
        query += ` AND is_hidden = 0`;
    }
    const params = [sourceId, type];
    if (kidsMax !== null && type !== 'live') {
        query += ` AND ${maturity.allowedSql('p', null).replace('@kidsMax', '?')}`;
        params.push(kidsMax);
    }

    if (categoryId) {
        query += ` AND category_id = ?`;
        params.push(categoryId);
    }

    // Default sorting
    // query += ` ORDER BY name ASC`; // Sorting usually handled by client

    const items = db.prepare(query).all(...params);

    // Map to Xtream format
    return items.map(item => toXtreamItem(item, type));
}

// A playlist_items row in the Xtream shape the client expects
function toXtreamItem(item, type) {
    const data = JSON.parse(item.data || '{}');
    // Override with our local fields if needed, or just return the mixed object
    // We should ensure critical fields are present
    return {
        ...data,
        stream_id: item.item_id, // ensure ID matches what client expects
        series_id: type === 'series' ? item.item_id : undefined,
        name: item.name,
        stream_icon: item.stream_icon,
        cover: item.stream_icon, // series/vod often use cover
        added: item.added_at,
        rating: item.rating,
        container_extension: item.container_extension,
        category_id: item.category_id,
        // Normalize EPG channel ID: Xtream uses epg_channel_id, M3U uses tvgId
        epg_channel_id: data.epg_channel_id || data.tvgId || null
    };
}


// --- Xtream Codes Proxy API --- //

/** An Xtream auth answer without the login it echoes back (user_info.username/password) */
function withoutLogin(data) {
    if (!data?.user_info) return data;
    const { username, password, ...userInfo } = data.user_info;
    return { ...data, user_info: userInfo };
}

// Login / Authenticate
router.get('/xtream/:sourceId', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') return res.status(404).send('Source not found');

        // Proxy auth check to upstream to ensure credentials are still valid

        const cached = cache.get('xtream', source.id, 'auth', 300000);
        if (cached) return res.json(cached);

        const api = xtreamApi.createFromSource(source);
        const data = withoutLogin(await api.authenticate());
        cache.set('xtream', source.id, 'auth', data);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// Live Categories
router.get('/xtream/:sourceId/live_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        let cats = getCategoriesFromDb(sourceId, 'live', includeHidden);
        // Kids accounts: only categories holding a whitelisted channel
        if (maturity.allowedChannels(req.user)) {
            const withChannels = new Set(maturity.filterChannels(req.user,
                getStreamsFromDb(sourceId, 'live', null, includeHidden), () => sourceId, s => s.stream_id).map(s => String(s.category_id)));
            cats = cats.filter(c => withChannels.has(String(c.category_id)));
        }
        res.json(cats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Live Streams
router.get('/xtream/:sourceId/live_streams', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';
        const streams = getStreamsFromDb(sourceId, 'live', categoryId, includeHidden);
        res.json(maturity.filterChannels(req.user, streams, () => sourceId, s => s.stream_id));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// VOD Categories
router.get('/xtream/:sourceId/vod_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        const cats = getCategoriesFromDb(sourceId, 'movie', includeHidden);
        res.json(cats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// VOD Streams
router.get('/xtream/:sourceId/vod_streams', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';
        const streams = getStreamsFromDb(sourceId, 'movie', categoryId, includeHidden, maturity.limitFor(req.user));
        res.json(streams);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series Categories
router.get('/xtream/:sourceId/series_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        const cats = getCategoriesFromDb(sourceId, 'series', includeHidden);
        res.json(cats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series
router.get('/xtream/:sourceId/series', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';
        const streams = getStreamsFromDb(sourceId, 'series', categoryId, includeHidden, maturity.limitFor(req.user));
        res.json(streams);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * Movies/Series grid, one page at a time. Filtering (source, category, search,
 * favourites, language hard filter) and language-first ordering run here, so
 * the browser never downloads the whole library.
 * Query: source_id, category (sourceId:categoryId), q, favorites=1, lang, hard=1,
 * offset, limit (max 200). Returns { items, hasMore }.
 */
router.get('/browse/:type', async (req, res) => {
    try {
        const type = req.params.type;
        if (!['movie', 'series'].includes(type)) {
            return res.status(400).json({ error: 'type must be movie or series' });
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        // Enabled Xtream sources, as the grids have always shown
        const enabled = (await sources.getAll())
            .filter(s => s.type === 'xtream' && s.enabled)
            .map(s => s.id);
        const sourceId = parseInt(req.query.source_id, 10);
        const sourceIds = sourceId ? enabled.filter(id => id === sourceId) : enabled;

        const languages = require('../services/languages');
        languages.ensureSqlFunctions();
        const lang = languages.LANGUAGES.some(l => l.id === req.query.lang) ? req.query.lang : '';

        const db = getDb();
        // Hidden categories up front: a per-row lookup scans categories for every title
        const hiddenCategories = db.prepare(`
            SELECT source_id || ':' || category_id AS id FROM categories
            WHERE type = ? AND is_hidden = 1
        `).all(type).map(r => r.id);

        const params = {
            type, lang, limit: limit + 1, offset,
            sources: JSON.stringify(sourceIds),
            hidden: JSON.stringify(hiddenCategories)
        };
        let where = '';
        if (req.query.category) {
            const [catSource, ...catId] = String(req.query.category).split(':');
            where += ' AND p.source_id = @catSource AND p.category_id = @catId';
            params.catSource = parseInt(catSource, 10);
            params.catId = catId.join(':');
        }
        if (req.query.q) {
            where += ' AND instr(lower(p.name), @q) > 0';
            params.q = String(req.query.q).toLowerCase();
        }
        if (req.query.favorites === '1') {
            where += ` AND EXISTS (
                SELECT 1 FROM favorites f
                WHERE f.user_id = @userId AND f.source_id = p.source_id
                  AND f.item_id = p.item_id AND f.item_type = p.type)`;
            params.userId = req.user.id;
        }
        if (lang && req.query.hard === '1') {
            where += ' AND lang_visible(p.name, c.name, @lang) = 1';
        }
        // Kids accounts: only titles rated within their limit (adults: no change)
        const kids = maturity.sqlFilter(req.user);
        where += kids.sql;
        Object.assign(params, kids.params);
        // Provider order, with the priority language first
        const order = lang
            ? 'CASE WHEN lang_match(p.name, c.name, @lang) = 1 THEN 0 ELSE 1 END, p.rowid'
            : 'p.rowid';

        // One extra row tells us whether there is another page
        const rows = db.prepare(`
            SELECT p.source_id, p.item_id, p.name, p.stream_icon, p.added_at, p.rating,
                   p.container_extension, p.year, p.category_id, p.data
            FROM playlist_items p
            LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id
            WHERE p.type = @type
              AND p.is_hidden = 0
              AND p.source_id IN (SELECT value FROM json_each(@sources))
              AND (p.source_id || ':' || IFNULL(p.category_id, '')) NOT IN (SELECT value FROM json_each(@hidden))
              ${where}
            ORDER BY ${order}
            LIMIT @limit OFFSET @offset
        `).all(params);

        const items = rows.slice(0, limit).map(row => ({
            ...toXtreamItem(row, type),
            sourceId: row.source_id,
            id: `${row.source_id}:${row.item_id}`
        }));
        res.json({ items, hasMore: rows.length > limit });
    } catch (err) {
        console.error('[Browse] Failed:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series Info (Episodes)
// Proxy series info request
router.get('/xtream/:sourceId/series_info', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source) return res.status(404).send('Source not found');

        const seriesId = req.query.series_id;
        if (!seriesId) return res.status(400).send('series_id required');

        const cacheKey = `series_info_${seriesId}`;
        const cached = cache.get('xtream', source.id, cacheKey, 3600000);
        if (cached) return res.json(cached);

        const api = xtreamApi.createFromSource(source);
        const data = await api.getSeriesInfo(seriesId);
        cache.set('xtream', source.id, cacheKey, data);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// VOD Info
router.get('/xtream/:sourceId/vod_info', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source) return res.status(404).send('Source not found');

        const vodId = req.query.vod_id;
        if (!vodId) return res.status(400).send('vod_id required');

        const cacheKey = `vod_info_${vodId}`;
        const cached = cache.get('xtream', source.id, cacheKey, 3600000);
        if (cached) return res.json(cached);

        const api = xtreamApi.createFromSource(source);
        const data = await api.getVodInfo(vodId);
        cache.set('xtream', source.id, cacheKey, data);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// Stream "URL" for playback: a reference the server resolves (services/streamRef.js),
// so the provider login in the real URL never reaches the browser
router.get('/xtream/:sourceId/stream/:streamId/:type?', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found' });
        }
        const { streamId, type = 'live' } = req.params;
        res.json({ url: streamRef.xtreamRef(source.id, streamId, type, req.query.container || 'm3u8') });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});


// --- Other Proxy Routes --- //

// M3U Playlist 
// (For M3U sources, we now have data in DB. We can reconstruct M3U or return JSON)
// Frontend ChannelList.js for M3U sources calls `API.proxy.m3u.get(sourceId)`
// which points here. It expects { channels, groups }.
router.get('/m3u/:sourceId', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';

        // Fetch from DB
        const channels = maturity.filterChannels(req.user, getStreamsFromDb(sourceId, 'live', null, includeHidden),
            () => sourceId, s => s.stream_id);
        const groups = getCategoriesFromDb(sourceId, 'live', includeHidden);

        // Format for frontend helper
        // ChannelList expects:
        // { 
        //   channels: [ { id, name, groupTitle, url, tvgLogo, ... } ], 
        //   groups: [ { id, name, channelCount } ] 
        // }
        // Note: DB `live` items from M3U sync have `category_id` as their group name usually.

        const reformattedChannels = channels.map(c => ({
            ...c,
            id: c.stream_id,
            groupTitle: c.category_id || 'Uncategorized',
            url: streamRef.m3uRef(sourceId, c.stream_id),
            stream_url: undefined, // the playlist's own URL stays on the server
            tvgLogo: c.stream_icon
        }));

        const reformattedGroups = groups.map(g => ({
            id: g.category_id,
            name: g.category_name,
            channelCount: 0 // Frontend calculates this or we can
        }));

        // Add implicit groups check?
        // The frontend M3U parser generates groups from the channels if explicit groups missing.
        // Our SyncService `saveCategories` handles explicit groups.

        res.json({ channels: reformattedChannels, groups: reformattedGroups });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// EPG
router.get('/epg/:sourceId', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const db = getDb();

        // Time window: 24 hours ago to 24 hours from now
        // This prevents returning millions of rows and crashing the server/browser
        const windowStart = Date.now() - (24 * 60 * 60 * 1000); // -24 hours
        const windowEnd = Date.now() + (24 * 60 * 60 * 1000);   // +24 hours

        // Fetch programs within the time window
        let programsQuery = `
            SELECT channel_id as channelId, start_time, end_time, title, description, data 
            FROM epg_programs 
            WHERE source_id = ? AND end_time > ? AND start_time < ?
        `;
        const params = [sourceId, windowStart, windowEnd];

        const programs = db.prepare(programsQuery).all(...params);

        const formattedPrograms = programs.map(p => ({
            channelId: p.channelId,
            start: new Date(p.start_time).toISOString(), // EpgGuide parse this back
            stop: new Date(p.end_time).toISOString(),
            title: p.title,
            description: p.description
        }));

        // Fetch EPG channels from playlist_items (type='epg_channel')


        let epgChannels = [];

        // Try getting stored channels first
        const storedChannels = db.prepare(`
            SELECT item_id as id, name, stream_icon as icon, data 
            FROM playlist_items 
            WHERE source_id = ? AND type = 'epg_channel'
        `).all(sourceId);

        if (storedChannels.length > 0) {
            epgChannels = storedChannels;
        } else {
            // Fallback: Build from unique channelIds in programmes (Legacy behavior)
            const uniqueChannelIds = [...new Set(programs.map(p => p.channelId))];
            epgChannels = uniqueChannelIds.map(id => ({
                id: id,
                name: id // Use channelId as name (fallback)
            }));
        }

        res.json({
            channels: epgChannels,
            programmes: formattedPrograms
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Clear cache (kept for compatibility)
router.delete('/cache/:sourceId', requireAdmin, (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clearSource(sourceId);
    res.json({ success: true });
});



/**
 * Proxy Xtream API calls
 * GET /api/proxy/xtream/:sourceId/:action
 */
router.get('/xtream/:sourceId/:action', async (req, res) => {
    try {
        const sourceId = req.params.sourceId;
        const source = await sources.getById(sourceId);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found' });
        }

        const { action } = req.params;
        const { category_id, stream_id, vod_id, series_id, limit, refresh, maxAge } = req.query;
        const forceRefresh = refresh === '1';
        const maxAgeHours = parseInt(maxAge) || DEFAULT_MAX_AGE_HOURS;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Actions that should be cached
        const cacheableActions = [
            'live_categories', 'live_streams',
            'vod_categories', 'vod_streams',
            'series_categories', 'series'
        ];

        // Build cache key (include category_id if present)
        const cacheKey = category_id ? `${action}_${category_id}` : action;

        // Check cache for cacheable actions
        if (!forceRefresh && cacheableActions.includes(action)) {
            const cached = cache.get('xtream', sourceId, cacheKey, maxAgeMs);
            if (cached) {
                return res.json(cached);
            }
        }

        // Fetch fresh data
        const api = xtreamApi.createFromSource(source);
        let data;
        switch (action) {
            case 'auth':
                data = withoutLogin(await api.authenticate());
                break;
            case 'live_categories':
                data = await api.getLiveCategories();
                break;
            case 'live_streams':
                data = await api.getLiveStreams(category_id);
                break;
            case 'vod_categories':
                data = await api.getVodCategories();
                break;
            case 'vod_streams':
                data = await api.getVodStreams(category_id);
                break;
            case 'vod_info':
                data = await api.getVodInfo(vod_id);
                break;
            case 'series_categories':
                data = await api.getSeriesCategories();
                break;
            case 'series':
                data = await api.getSeries(category_id);
                break;
            case 'series_info':
                data = await api.getSeriesInfo(series_id);
                break;
            case 'short_epg':
                data = await api.getShortEpg(stream_id, limit);
                break;
            default:
                return res.status(400).json({ error: 'Unknown action' });
        }

        // Cache the result for cacheable actions
        if (cacheableActions.includes(action)) {
            cache.set('xtream', sourceId, cacheKey, data);
        }

        res.json(data);
    } catch (err) {
        console.error('Xtream proxy error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Fetch and parse EPG (with file-based caching)
 * GET /api/proxy/epg/:sourceId
 * Query params:
 *   - refresh=1  Force refresh, bypass cache
 *   - maxAge=N   Max cache age in hours (default 24)
 */
router.get('/epg/:sourceId', async (req, res) => {
    try {
        const sourceId = req.params.sourceId;
        const source = await sources.getById(sourceId);
        if (!source || (source.type !== 'epg' && source.type !== 'xtream')) {
            return res.status(404).json({ error: 'Valid EPG source not found' });
        }

        const forceRefresh = req.query.refresh === '1';
        const maxAgeHours = parseInt(req.query.maxAge) || DEFAULT_MAX_AGE_HOURS;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Check file cache (unless force refresh)
        if (!forceRefresh) {
            const cached = cache.get('epg', sourceId, 'data', maxAgeMs);
            if (cached) {
                return res.json(cached);
            }
        }

        // Fetch fresh data
        let url = source.url;
        if (source.type === 'xtream') {
            const api = xtreamApi.createFromSource(source);
            url = api.getXmltvUrl();
        }

        const data = await epgParser.fetchAndParse(url);

        // Store in file cache
        cache.set('epg', sourceId, 'data', data);

        res.json(data);
    } catch (err) {
        console.error('EPG proxy error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Clear cache for a source
 * DELETE /api/proxy/cache/:sourceId
 */
router.delete('/cache/:sourceId', requireAdmin, (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clearSource(sourceId);
    res.json({ success: true });
});

/**
 * Clear EPG cache for a source (legacy endpoint, calls clearSource)
 * DELETE /api/proxy/epg/:sourceId/cache
 */
router.delete('/epg/:sourceId/cache', requireAdmin, (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clear('epg', sourceId, 'data');
    res.json({ success: true });
});

/**
 * Get EPG for specific channels
 * POST /api/proxy/epg/:sourceId/channels
 */
router.post('/epg/:sourceId/channels', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'epg') {
            return res.status(404).json({ error: 'EPG source not found' });
        }

        const { channelIds } = req.body;
        if (!channelIds || !Array.isArray(channelIds)) {
            return res.status(400).json({ error: 'channelIds array required' });
        }

        const data = await epgParser.fetchAndParse(source.url);

        // Filter programmes for requested channels
        const result = {};
        for (const channelId of channelIds) {
            result[channelId] = epgParser.getCurrentAndUpcoming(data.programmes, channelId);
        }

        res.json(result);
    } catch (err) {
        console.error('EPG channels error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Proxy a stream reference for playback (CORS, mixed content, Range for seeking)
 * GET /api/proxy/stream?url=<stream reference>  - same as GET <stream reference>
 */
router.get('/stream', lockDown, streamRef.requireStreamRef, (req, res) => {
    if (!req.streamUrl) return res.status(400).json({ error: 'URL required' });
    return proxyStream(req, res, req.streamUrl, req.user);
});

/**
 * Proxy images (posters, channel logos) through the disk cache
 * (services/imageCache.js): each image is downloaded once - TMDB's kept for
 * good, others re-checked monthly - and browsers may cache it too. Also fixes
 * mixed content (plain-http images on an HTTPS page).
 * GET /api/proxy/image?url=...
 */
router.get('/image', lockDown, async (req, res) => {
    const { url } = req.query;
    if (!url || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'http(s) URL required' });
    }
    try {
        const image = await imageCache.get(url);
        // Only images: a page or a script at the URL is refused, not served from here
        if (!/^image\//i.test(image.type || '')) {
            return res.status(415).type('text/plain').send('Not an image');
        }
        res.set('Content-Type', image.type);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', `public, max-age=${imageCache.maxAge(url)}${imageCache.isTmdb(url) ? ', immutable' : ''}`);
        if (image.file) {
            imageCache.createReadStream(image.file)
                .on('error', () => { if (!res.headersSent) res.status(500); res.end(); })
                .pipe(res);
        } else {
            res.end(image.body);
        }
    } catch (err) {
        if (err.status) return res.status(err.status).type('text/plain').send('Failed to fetch image');
        console.error('Image proxy error:', err.message);
        res.status(502).type('text/plain').send('Image proxy error');
    }
});

module.exports = router;
