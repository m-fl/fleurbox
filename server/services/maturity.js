/**
 * How grown-up a title is, from TMDB data only (never the playlist's category:
 * the provider files gritty anime like Bleach under "Kids"/"Animation").
 *
 * Levels: 0 little kids (TV-Y) · 1 kids (G, TV-Y7, TV-G) · 2 family (PG, TV-PG)
 *         3 teens (PG-13, TV-14) · 4 adults (R, TV-MA, UK 15/18). null = unknown.
 *
 * Source, in order: the stored age rating (tmdb_meta.certification, US else
 * GB/NL); without one, TMDB's own "Kids" TV genre (1) or adult keywords (4).
 *
 * Kids accounts (user.kids, user.maxMaturity) only see titles with a known
 * level at or below their maximum.
 */
const { getDb } = require('../db/sqlite');

const RATINGS = {
    'TV-Y': 0,
    'G': 1, 'TV-Y7': 1, 'TV-Y7-FV': 1, 'TV-G': 1,
    'PG': 2, 'TV-PG': 2,
    'PG-13': 3, 'TV-14': 3,
    'R': 4, 'NC-17': 4, 'TV-MA': 4,
    'GB U': 1, 'GB PG': 2, 'GB 12': 3, 'GB 12A': 3, 'GB 15': 4, 'GB 18': 4, 'GB R18': 4,
    'NL AL': 1, 'NL 6': 1, 'NL 9': 2, 'NL 12': 3, 'NL 14': 3, 'NL 16': 4, 'NL 18': 4
};

// Keywords that make an unrated title adult whatever its genres say
const ADULT_KEYWORDS = new Set(['adult animation', 'erotic', 'erotica', 'softcore', 'sex scene', 'nudity',
    'explicit sex', 'gore', 'splatter', 'torture', 'extreme violence', 'pornography']);

const LEVELS = [
    { id: 1, label: 'Young kids (TV-Y, TV-Y7, G)' },
    { id: 2, label: 'Kids (up to PG, TV-PG)' },
    { id: 3, label: 'Teens (up to PG-13, TV-14)' }
];
const DEFAULT_KIDS_LEVEL = 2;

/** Level from a stored record ({ certification, genres, keywords }), or null */
function levelOf({ certification, genres, keywords }) {
    const rated = RATINGS[String(certification || '').trim()];
    if (rated !== undefined) return rated;
    const words = String(keywords || '').toLowerCase().split(/\s*,\s*/);
    if (words.some(k => ADULT_KEYWORDS.has(k))) return 4;
    if (String(genres || '').split(/\s*,\s*/).includes('Kids')) return 1;
    return null;
}

/** The highest level a user may see: null = no limit (not a kids account) */
function limitFor(user) {
    if (!user?.kids) return null;
    const max = parseInt(user.maxMaturity, 10);
    return LEVELS.some(l => l.id === max) ? max : DEFAULT_KIDS_LEVEL;
}

/**
 * SQL condition: the playlist row `p` is a copy of a title (media_links,
 * trusted links only) with a known level <= @kidsMax.
 * Bind kidsMax: limitFor(user).
 */
// (the second argument, a category alias, is no longer needed: the link knows the kind)
function allowedSql(p = 'p') {
    return `EXISTS (SELECT 1 FROM media_links kl
        JOIN tmdb_meta km ON km.kind = kl.kind AND km.tmdb_id = kl.tmdb_id
        WHERE kl.source_id = ${p}.source_id AND kl.item_type = ${p}.type AND kl.item_id = ${p}.item_id
          AND kl.match IN ('tmdb', 'manual')
          AND km.status = 'ok' AND km.maturity IS NOT NULL AND km.maturity <= @kidsMax)`;
}

/**
 * For a route's SQL: { sql: ' AND <condition>' | '', params: { kidsMax } | {} }.
 * Adults get nothing - their queries stay exactly as they were.
 */
function sqlFilter(user, p = 'p', c = 'c') {
    const max = limitFor(user);
    return max === null ? { sql: '', params: {} } : { sql: ` AND ${allowedSql(p, c)}`, params: { kidsMax: max } };
}

/** Levels of many titles at once: Map('kind:tmdb_id' -> level|null) */
function levels(keys) {
    const out = new Map();
    if (!keys.length) return out;
    const rows = getDb().prepare(`
        SELECT kind, tmdb_id, maturity FROM tmdb_meta
        WHERE kind || ':' || tmdb_id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify([...new Set(keys)]));
    rows.forEach(r => out.set(`${r.kind}:${r.tmdb_id}`, r.maturity));
    return out;
}

/** Fill tmdb_meta.maturity for records fetched before it existed */
function backfill() {
    const db = getDb();
    const rows = db.prepare(`
        SELECT kind, tmdb_id, certification, genres, keywords FROM tmdb_meta
        WHERE status = 'ok' AND extras_at IS NOT NULL AND maturity IS NULL
    `).all();
    const update = db.prepare('UPDATE tmdb_meta SET maturity = ? WHERE kind = ? AND tmdb_id = ?');
    let set = 0;
    db.transaction(() => {
        for (const r of rows) {
            const level = levelOf(r);
            if (level !== null) { update.run(level, r.kind, r.tmdb_id); set++; }
        }
    })();
    return set;
}

module.exports = { LEVELS, DEFAULT_KIDS_LEVEL, levelOf, limitFor, allowedSql, sqlFilter, levels, backfill };

/**
 * Kids accounts and Live TV: channels carry no age rating, so a parent (an
 * admin) whitelists channels per kids account (user.allowedChannels,
 * "sourceId:itemId"). Returns null for everyone else (no filtering), else the
 * Set - empty until channels are added.
 */
function allowedChannels(user) {
    if (!user?.kids) return null;
    return new Set((user.allowedChannels || []).map(String));
}

/** Keep rows whose (source, item) is whitelisted; everything for non-kids */
function filterChannels(user, rows, source = r => r.source_id, item = r => r.item_id) {
    const allowed = allowedChannels(user);
    if (!allowed) return rows;
    return rows.filter(r => allowed.has(`${source(r)}:${item(r)}`));
}

module.exports.allowedChannels = allowedChannels;
module.exports.filterChannels = filterChannels;
