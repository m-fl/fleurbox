/**
 * How grown-up a title is, from TMDB data only (never the playlist's category:
 * the provider files gritty anime like Bleach under "Kids"/"Animation").
 *
 * Levels: 0 little kids (TV-Y) · 1 kids (G, TV-Y7, TV-G) · 2 family (PG, TV-PG)
 *         3 teens (PG-13, TV-14) · 4 adults (R, TV-MA, UK 15/18). null = unknown.
 *
 * Source, in order: the stored age rating (tmdb_meta.certification, US else
 * GB/NL); without one, TMDB's own "Kids" TV genre (1) or adult keywords (4).
 * Animated titles TMDB tags as made for children ("kids", "children's
 * adventure", "based on toy"...) count as kids (1) even when rated PG - PAW
 * Patrol films are PG, Zootopia (no such keywords) stays family. And an
 * unrated animated film of a TMDB "Kids" series' franchise counts as kids
 * (backfill).
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

// Keywords TMDB puts on titles made for children (not just suitable for them)
const KIDS_KEYWORDS = new Set(['kids', 'children', "children's adventure", "children's cartoon", "children's film",
    "children's series", 'preschool', 'pre-school', 'toddler', 'nursery rhyme', 'based on toy', 'educational']);

const LEVELS = [
    { id: 1, label: 'Young kids (TV-Y, TV-Y7, G)' },
    { id: 2, label: 'Kids (up to PG, TV-PG)' },
    { id: 3, label: 'Teens (up to PG-13, TV-14)' }
];
const DEFAULT_KIDS_LEVEL = 2;

/** Level from a stored record ({ certification, genres, keywords }), or null */
function levelOf({ certification, genres, keywords }) {
    const rated = RATINGS[String(certification || '').trim()];
    const words = String(keywords || '').toLowerCase().split(/\s*,\s*/);
    const genreList = String(genres || '').split(/\s*,\s*/);
    // Made for children: animated + TMDB's children keywords, up to a PG rating
    const forKids = genreList.includes('Animation') && words.some(k => KIDS_KEYWORDS.has(k));
    if (rated !== undefined) return forKids && rated === 2 ? 1 : rated;
    if (words.some(k => ADULT_KEYWORDS.has(k))) return 4;
    if (genreList.includes('Kids') || forKids) return 1;
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

/**
 * (Re)compute tmdb_meta.maturity from the stored data (the rules above may
 * change; the TMDB data doesn't need re-fetching). Then: unrated animated
 * films of a TMDB "Kids" series' franchise (same first two title words, e.g.
 * "PAW Patrol: Air Rescue" -> "PAW Patrol") count as kids too.
 * Returns how many levels changed.
 */
function backfill() {
    const db = getDb();
    const rows = db.prepare(`
        SELECT kind, tmdb_id, title, certification, genres, keywords, maturity FROM tmdb_meta
        WHERE status = 'ok' AND extras_at IS NOT NULL
    `).all();
    const update = db.prepare('UPDATE tmdb_meta SET maturity = ? WHERE kind = ? AND tmdb_id = ?');
    const franchise = t => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
    const kidsSeries = new Set(rows
        .filter(r => r.kind === 'tv' && String(r.genres || '').split(/\s*,\s*/).includes('Kids'))
        .map(r => franchise(r.title)).filter(f => f.includes(' ')));
    let changed = 0;
    db.transaction(() => {
        for (const r of rows) {
            let level = levelOf(r);
            if (level === null && r.kind === 'movie' && String(r.genres || '').includes('Animation')
                && kidsSeries.has(franchise(r.title))) level = 1;
            if (level !== r.maturity) { update.run(level, r.kind, r.tmdb_id); changed++; }
        }
    })();
    return changed;
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
