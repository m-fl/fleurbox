/**
 * Live TV, served in small pieces from the local database
 *
 * The sidebar used to download every live channel (50k+, ~25MB) and the whole
 * EPG (~60MB) up front. Instead it now asks for the category list, then one
 * category's channels when it is opened, and "what's on now" only for the
 * channels on screen.
 *
 * Channels are returned in the shape ChannelList builds client-side:
 * { id: "<type>_<sourceId>_<streamId>", streamId, name, tvgId, tvgLogo, url,
 *   groupId, groupTitle, sourceId, sourceType }
 */

const express = require('express');
const router = express.Router();
const { sources, settings: settingsDb } = require('../db');
const { getDb } = require('../db/sqlite');
const languages = require('../services/languages');
const liveEvents = require('../services/liveEvents');
const taste = require('../services/taste');

const UNCATEGORIZED = 'Uncategorized';

/**
 * Enabled live sources, optionally narrowed by the sidebar's source filter
 * ("xtream:2", "m3u:3" or "" for all). Returns Map<sourceId, sourceType>.
 */
async function liveSources(filter) {
    const all = (await sources.getAll()).filter(s => (s.type === 'xtream' || s.type === 'm3u') && s.enabled);
    const [type, id] = String(filter || '').split(':');
    const picked = filter ? all.filter(s => s.type === type && s.id === parseInt(id, 10)) : all;
    return new Map(picked.map(s => [s.id, s.type]));
}

// Rows selected for channels: playlist item plus its category name
const CHANNEL_COLUMNS = `
    p.source_id, p.item_id, p.name, p.stream_icon, p.stream_url, p.category_id, p.data,
    c.name AS group_name`;
const CATEGORY_JOIN = `
    LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id AND c.type = 'live'`;

function toChannel(row, sourceTypes) {
    const sourceType = sourceTypes.get(row.source_id) || 'xtream';
    const data = row.data ? JSON.parse(row.data) : {};
    return {
        id: `${sourceType}_${row.source_id}_${row.item_id}`,
        streamId: row.item_id,
        name: row.name,
        tvgId: data.epg_channel_id || data.tvgId || null,
        tvgLogo: row.stream_icon,
        url: sourceType === 'm3u' ? (row.stream_url || data.stream_url || data.url) : undefined,
        groupId: `${sourceType}_${row.source_id}_${row.category_id}`,
        groupTitle: row.group_name || UNCATEGORIZED,
        sourceId: row.source_id,
        sourceType
    };
}

/**
 * Hidden channels/categories are left out unless the sidebar's
 * "show hidden" box is ticked (includeHidden=1)
 */
function hiddenClause(includeHidden) {
    return includeHidden ? '' : 'AND p.is_hidden = 0 AND (c.is_hidden IS NULL OR c.is_hidden = 0)';
}

/**
 * GET /api/live/groups?source=&includeHidden=1
 * One row per source category with its channel count, in no particular order
 * (the client sorts and merges same-named groups across sources).
 */
router.get('/groups', async (req, res) => {
    try {
        const sourceTypes = await liveSources(req.query.source);
        const rows = getDb().prepare(`
            SELECT p.source_id, p.category_id, c.name AS group_name, count(*) AS count
            FROM playlist_items p
            ${CATEGORY_JOIN}
            WHERE p.type = 'live'
              AND p.source_id IN (SELECT value FROM json_each(?))
              ${hiddenClause(req.query.includeHidden === '1')}
            GROUP BY p.source_id, CASE WHEN c.id IS NULL THEN NULL ELSE p.category_id END
        `).all(JSON.stringify([...sourceTypes.keys()]));

        res.json(rows.map(r => ({
            name: r.group_name || UNCATEGORIZED,
            sourceId: r.source_id,
            sourceType: sourceTypes.get(r.source_id),
            // null = channels whose category is unknown (shown as Uncategorized)
            categoryId: r.group_name ? r.category_id : null,
            count: r.count
        })));
    } catch (err) {
        console.error('[Live] Groups failed:', err);
        res.status(500).json({ error: 'Failed to load groups' });
    }
});

/**
 * GET /api/live/channels?sourceId=&categoryId=&includeHidden=1
 * One category's channels; without categoryId, the source's uncategorized ones
 */
router.get('/channels', async (req, res) => {
    try {
        const sourceId = parseInt(req.query.sourceId, 10);
        const sourceTypes = await liveSources();
        if (!sourceTypes.has(sourceId)) return res.json([]);

        const hasCategory = req.query.categoryId !== undefined && req.query.categoryId !== '';
        const rows = getDb().prepare(`
            SELECT ${CHANNEL_COLUMNS}
            FROM playlist_items p
            ${CATEGORY_JOIN}
            WHERE p.type = 'live' AND p.source_id = ?
              AND ${hasCategory ? 'p.category_id = ? AND c.id IS NOT NULL' : 'c.id IS NULL'}
              ${hiddenClause(req.query.includeHidden === '1')}
            ORDER BY p.rowid
        `).all(...(hasCategory ? [sourceId, String(req.query.categoryId)] : [sourceId]));

        res.json(rows.map(r => toChannel(r, sourceTypes)));
    } catch (err) {
        console.error('[Live] Channels failed:', err);
        res.status(500).json({ error: 'Failed to load channels' });
    }
});

/**
 * GET /api/live/search?q=&source=&includeHidden=1&lang=&hard=1&limit=
 * Channels whose name or group contains q (case-insensitive), capped at
 * `limit` (default 500, max 2000). Returns { channels, truncated }.
 */
router.get('/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        if (!q) return res.json({ channels: [], truncated: false });
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 2000);
        const sourceTypes = await liveSources(req.query.source);

        languages.ensureSqlFunctions();
        const lang = languages.LANGUAGES.some(l => l.id === req.query.lang) ? req.query.lang : '';
        // Settings > "Hide titles in other languages" applies to Live TV search
        const languageClause = lang && req.query.hard === '1'
            ? `AND lang_visible(p.name, c.name, @lang) = 1` : '';

        const rows = getDb().prepare(`
            SELECT ${CHANNEL_COLUMNS}
            FROM playlist_items p
            ${CATEGORY_JOIN}
            WHERE p.type = 'live'
              AND p.source_id IN (SELECT value FROM json_each(@sources))
              AND (instr(lower(p.name), @q) > 0 OR instr(lower(IFNULL(c.name, '${UNCATEGORIZED}')), @q) > 0)
              ${hiddenClause(req.query.includeHidden === '1')}
              ${languageClause}
            ORDER BY p.rowid
            LIMIT @limit
        `).all({ sources: JSON.stringify([...sourceTypes.keys()]), q, lang, limit: limit + 1 });

        res.json({
            channels: rows.slice(0, limit).map(r => toChannel(r, sourceTypes)),
            truncated: rows.length > limit
        });
    } catch (err) {
        console.error('[Live] Search failed:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

/**
 * Look up channels by (sourceId, itemId). itemId may be the raw stream id or
 * the client's composite "<type>_<sourceId>_<streamId>" (favourites store that).
 */
function lookupChannels(refs, sourceTypes) {
    const stmt = getDb().prepare(`
        SELECT ${CHANNEL_COLUMNS}
        FROM playlist_items p
        ${CATEGORY_JOIN}
        WHERE p.type = 'live' AND p.source_id = ? AND p.item_id = ?
    `);
    const found = [];
    for (const { sourceId, itemId } of refs) {
        const sid = parseInt(sourceId, 10);
        if (!sourceTypes.has(sid)) continue;
        const m = /^(?:xtream|m3u)_(\d+)_(.+)$/.exec(String(itemId));
        const row = stmt.get(sid, m ? m[2] : String(itemId));
        if (row) found.push(toChannel(row, sourceTypes));
    }
    return found;
}

/**
 * GET /api/live/favorites - the current user's favourite channels, by name
 */
router.get('/favorites', async (req, res) => {
    try {
        const favorites = getDb().prepare(`
            SELECT source_id, item_id FROM favorites
            WHERE user_id = ? AND item_type = 'channel'
        `).all(req.user.id);
        const channels = lookupChannels(
            favorites.map(f => ({ sourceId: f.source_id, itemId: f.item_id })),
            await liveSources());
        channels.sort((a, b) => a.name.localeCompare(b.name));
        res.json(channels);
    } catch (err) {
        console.error('[Live] Favorites failed:', err);
        res.status(500).json({ error: 'Failed to load favorite channels' });
    }
});

/**
 * GET /api/live/channel?sourceId=&itemId= - one channel, or 404
 */
router.get('/channel', async (req, res) => {
    try {
        const [channel] = lookupChannels([{ sourceId: req.query.sourceId, itemId: req.query.itemId }],
            await liveSources());
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        res.json(channel);
    } catch (err) {
        console.error('[Live] Channel lookup failed:', err);
        res.status(500).json({ error: 'Failed to load channel' });
    }
});

/**
 * POST /api/live/now { channels: [{ tvgId, name }], full } (max 2000)
 * What's on now for each channel, from the stored EPG. Matching follows
 * EpgGuide.getCurrentProgram: an EPG channel whose id (or lower-cased name) is
 * the tvgId, otherwise one whose name matches the channel name.
 * Returns an array in request order: { current, upcoming[] } or null. Without
 * `full`, current has no description and upcoming is empty (sidebar text).
 */
router.post('/now', async (req, res) => {
    try {
        const wanted = Array.isArray(req.body?.channels) ? req.body.channels.slice(0, 2000) : [];
        const full = !!req.body?.full;
        const db = getDb();

        // EPG channel lookup: id and lower-cased name -> EPG channel id
        const epgIds = new Map();
        for (const row of db.prepare(`SELECT item_id, name FROM playlist_items WHERE type = 'epg_channel'`).iterate()) {
            epgIds.set(row.item_id, row.item_id);
            if (row.name) epgIds.set(row.name.toLowerCase(), row.item_id);
        }

        const now = Date.now();
        const programs = db.prepare(`
            SELECT start_time, end_time, title${full ? ', description' : ''}
            FROM epg_programs
            WHERE channel_id = ? AND end_time > ?
            ORDER BY start_time
            LIMIT ${full ? 6 : 1}
        `);
        const format = p => ({
            title: p.title,
            start: new Date(p.start_time).toISOString(),
            stop: new Date(p.end_time).toISOString(),
            ...(full ? { description: p.description } : {})
        });

        const results = wanted.map(ch => {
            const tvgId = ch?.tvgId ? String(ch.tvgId) : '';
            const name = ch?.name ? String(ch.name) : '';
            const epgId = tvgId && epgIds.has(tvgId) ? epgIds.get(tvgId)
                : name ? epgIds.get(name.toLowerCase()) : undefined;
            if (!epgId) return null;

            const list = programs.all(epgId, now);
            const current = list.find(p => p.start_time <= now && p.end_time > now);
            return {
                current: current ? format(current) : null,
                upcoming: list.filter(p => p.start_time > now).slice(0, 5).map(format)
            };
        });
        res.json(results);
    } catch (err) {
        console.error('[Live] Now playing failed:', err);
        res.status(500).json({ error: 'Failed to load programme info' });
    }
});

/**
 * GET /api/live/events?limit=&mine=1
 * Live and upcoming events, best first: the user's teams, their leagues and
 * sports, then other events on their channels (services/liveEvents.js).
 * mine=1 leaves the others out for users who follow something.
 * Each: { id, title, competition, sport, start, end, live, favourite, detail,
 *         home, away, programme, channels[] } - channels shaped as above.
 */
router.get('/events', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 60);
        const sourceTypes = await liveSources();
        const settings = await settingsDb.get();
        const lang = settings.languagePriority || '';
        const events = liveEvents.forUser(taste.getProfile(req.user.id), {
            sourceIds: [...sourceTypes.keys()],
            lang,
            hard: !!(settings.languageHardFilter && lang),
            limit,
            // Home: only what the user follows, once they've picked sports/teams
            mine: req.query.mine === '1'
        });
        res.json(events.map(({ channelRows, ...e }) => ({
            ...e,
            channels: channelRows.map(r => toChannel(r, sourceTypes))
        })));
    } catch (err) {
        console.error('[Live] Events failed:', err);
        res.status(500).json({ error: 'Live events unavailable' });
    }
});

module.exports = router;
