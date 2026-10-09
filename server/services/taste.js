/**
 * Per-user taste profile (the Home quiz) and the "For You" rows built from it.
 *
 * CATALOG is the single place to edit quiz choices. The client renders the quiz
 * from GET /api/home/taste, so nothing is duplicated in the browser.
 *  - genres: TMDB genre ids for movies and for TV (TMDB's TV genre list differs:
 *    no Horror/Thriller/Romance, combined "Sci-Fi & Fantasy" etc.), with TMDB
 *    keywords standing in where TV has no such genre. `names` match the stored
 *    `tmdb_meta.genres` text for the local fallback.
 *    `icon` names a line icon in public/js/icons.js (Icons.line).
 *  - motifs: TMDB keyword names (resolved to ids by tmdbDiscover) plus plain
 *    `words` matched against stored plots for the local fallback.
 *  - sports/regions: the "Sports fan?" step. Regions add leagues (an additive
 *    list); the leagues themselves live in services/liveEvents.js LEAGUES.
 *    Teams are picked from ESPN's team lists and stored as liveEvents keys.
 *
 * Ranking: TMDB's current popularity within the genre/motif (tmdbDiscover,
 * fetched in the background), matched to titles actually in the library, then
 * topped up from the local TMDB records (newest, well rated) so a row is never
 * empty while TMDB lists are still being fetched.
 */

const { getDb } = require('../db/sqlite');
const tmdbDiscover = require('./tmdbDiscover');
const tmdbTrending = require('./tmdbTrending');
const languages = require('./languages');
const liveEvents = require('./liveEvents');
const recommend = require('./recommend');
const maturity = require('./maturity');

const CATALOG = {
    genres: [
        { id: 'action', label: 'Action & Adventure', icon: 'zap', movie: [28, 12], tv: [10759], names: ['Action', 'Adventure'] },
        { id: 'comedy', label: 'Comedy', icon: 'laugh', movie: [35], tv: [35], names: ['Comedy'] },
        { id: 'suspense', label: 'Mystery & Suspense', icon: 'eye', movie: [9648, 53], tv: [9648], names: ['Mystery', 'Thriller'] },
        { id: 'crime', label: 'Crime', icon: 'siren', movie: [80], tv: [80], names: ['Crime'] },
        { id: 'scifi', label: 'Sci-Fi', icon: 'rocket', movie: [878], tv: [10765], names: ['Science Fiction', 'Sci-Fi'] },
        { id: 'fantasy', label: 'Fantasy', icon: 'wand-sparkles', movie: [14], tv: [10765], names: ['Fantasy'] },
        { id: 'horror', label: 'Horror', icon: 'ghost', movie: [27], tvKeywords: ['horror', 'supernatural'], names: ['Horror'] },
        { id: 'drama', label: 'Drama', icon: 'drama', movie: [18], tv: [18], names: ['Drama'] },
        { id: 'romance', label: 'Romance', icon: 'heart', movie: [10749], tvKeywords: ['romance'], names: ['Romance'] },
        { id: 'documentary', label: 'Documentary', icon: 'video', movie: [99], tv: [99], names: ['Documentary'] },
        { id: 'animation', label: 'Animation', icon: 'palette', movie: [16], tv: [16], names: ['Animation'] },
        { id: 'family', label: 'Family & Kids', icon: 'users', movie: [10751], tv: [10751, 10762], names: ['Family', 'Kids'] },
        { id: 'history', label: 'History & War', icon: 'landmark', movie: [36, 10752], tv: [10768], names: ['History', 'War'] },
        { id: 'reality', label: 'Reality', icon: 'tv', tv: [10764], names: ['Reality'] }
    ],
    motifs: [
        { id: 'heist', label: 'Heists & Cons', keywords: ['heist', 'con artist'], words: ['heist', 'robbery', 'con artist', 'con man'] },
        { id: 'timetravel', label: 'Time Travel', keywords: ['time travel'], words: ['time travel', 'time machine', 'time loop'] },
        { id: 'space', label: 'Deep Space', keywords: ['space travel', 'outer space'], words: ['spaceship', 'outer space', 'astronaut', 'galaxy'] },
        { id: 'serialkiller', label: 'Serial Killers', keywords: ['serial killer'], words: ['serial killer'] },
        { id: 'spy', label: 'Spies & Espionage', keywords: ['spy', 'espionage'], words: ['spy', 'espionage', 'secret agent', 'cia'] },
        { id: 'superhero', label: 'Superheroes', keywords: ['superhero'], words: ['superhero', 'superpowers'] },
        { id: 'dystopia', label: 'Dystopias & Apocalypse', keywords: ['dystopia', 'post-apocalyptic future'], words: ['dystopian', 'apocalypse', 'post-apocalyptic'] },
        { id: 'zombies', label: 'Zombies', keywords: ['zombie'], words: ['zombie', 'undead'] },
        { id: 'legal', label: 'Courtroom & Legal', keywords: ['courtroom', 'lawyer'], words: ['courtroom', 'lawyer', 'attorney', 'trial'] },
        { id: 'comingofage', label: 'Coming of Age', keywords: ['coming of age'], words: ['coming-of-age', 'coming of age', 'teenager'] },
        { id: 'mafia', label: 'Mob & Mafia', keywords: ['mafia', 'organized crime'], words: ['mafia', 'mob boss', 'cartel', 'gangster'] },
        { id: 'ai', label: 'AI & Robots', keywords: ['artificial intelligence (a.i.)', 'robot'], words: ['artificial intelligence', 'robot', 'android'] },
        { id: 'survival', label: 'Survival', keywords: ['survival'], words: ['survive', 'survival', 'stranded'] },
        { id: 'sports', label: 'Sports & Underdogs', keywords: ['sports', 'underdog'], words: ['underdog', 'championship', 'coach'] },
        { id: 'royals', label: 'Royals & Period Pieces', keywords: ['period drama', 'royalty'], words: ['queen', 'king', 'royal', 'aristocrat'] },
        { id: 'haunted', label: 'Hauntings', keywords: ['haunted house', 'ghost'], words: ['haunted', 'ghost', 'possessed'] },
        { id: 'smalltown', label: 'Small-Town Secrets', keywords: ['small town'], words: ['small town', 'quiet town'] },
        { id: 'truestory', label: 'Based on a True Story', keywords: ['based on true story'], words: ['true story', 'based on the true'] },
        { id: 'revenge', label: 'Revenge', keywords: ['revenge'], words: ['revenge', 'vengeance', 'avenge'] },
        { id: 'martialarts', label: 'Martial Arts', keywords: ['martial arts', 'kung fu'], words: ['martial arts', 'kung fu'] },
        { id: 'food', label: 'Food & Cooking', keywords: ['cooking', 'chef'], words: ['chef', 'restaurant', 'cooking', 'baking'] },
        { id: 'roadtrip', label: 'Road Trips', keywords: ['road trip'], words: ['road trip'] }
    ],
    formats: [
        { id: 'both', label: 'Both, mix it up' },
        { id: 'movie', label: 'Mostly movies' },
        { id: 'tv', label: 'Mostly series' }
    ],
    eras: [
        { id: 'any', label: 'Any era' },
        { id: 'new', label: 'Fresh (2015+)', min: 2015 },
        { id: 'modern', label: '2000s & early 2010s', min: 2000, max: 2014 },
        { id: 'classic', label: 'Classics (before 2000)', max: 1999 }
    ],
    moods: [
        { id: 'popular', label: "What everyone's watching" },
        { id: 'acclaimed', label: 'Critically acclaimed' }
    ],
    sports: [
        { id: 'soccer', label: 'Football' },
        { id: 'american-football', label: 'American Football' },
        { id: 'basketball', label: 'Basketball' },
        { id: 'hockey', label: 'Ice Hockey' },
        { id: 'baseball', label: 'Baseball' },
        { id: 'motorsport', label: 'Formula 1' },
        { id: 'mma', label: 'UFC / MMA' }
    ],
    regions: [
        { id: 'international', label: 'National teams' },
        { id: 'europe', label: 'European cups' },
        { id: 'england', label: 'England' },
        { id: 'spain', label: 'Spain' },
        { id: 'germany', label: 'Germany' },
        { id: 'italy', label: 'Italy' },
        { id: 'france', label: 'France' },
        { id: 'belgium', label: 'Belgium' },
        { id: 'netherlands', label: 'Netherlands' },
        { id: 'portugal', label: 'Portugal' },
        { id: 'scotland', label: 'Scotland' },
        { id: 'turkey', label: 'Turkey' },
        { id: 'north-america', label: 'USA & Canada' },
        { id: 'mexico', label: 'Mexico' },
        { id: 'south-america', label: 'South America' }
    ],
    limits: { genres: 5, motifs: 5, teams: 10 }
};
// Which regions mean something for each sport (the quiz shows only those)
CATALOG.sportRegions = Object.fromEntries(CATALOG.sports.map(s => [s.id,
    CATALOG.regions.map(r => r.id).filter(r => liveEvents.LEAGUES.some(l => l.sport === s.id && l.regions.includes(r)))]));
// Levels to narrow a sport to ("college vs professional"), for sports whose leagues have them
const DIVISION_LABELS = {
    'american-football': { pro: 'Professional (NFL)', college: 'College (NCAA)' },
    basketball: { pro: 'Professional (NBA, WNBA)', college: 'College (NCAA)' }
};
CATALOG.divisions = Object.fromEntries(Object.entries(DIVISION_LABELS).map(([sport, labels]) => [sport,
    [...new Set(liveEvents.LEAGUES.filter(l => l.sport === sport && l.division).map(l => l.division))]
        .map(id => ({ id: `${sport}:${id}`, label: labels[id] || id }))]));
const divisionIds = new Set(Object.values(CATALOG.divisions).flat().map(d => d.id));
const sportIds = new Set(CATALOG.sports.map(s => s.id));
const regionIds = new Set(CATALOG.regions.map(r => r.id));

const ROW_SIZE = 20;

/** tmdb_meta only exists once a TMDB sync has run (TMDB_READ_TOKEN set) */
function hasTmdbMeta() {
    return !!getDb().prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tmdb_meta'`).get();
}
const genreById = new Map(CATALOG.genres.map(g => [g.id, g]));
const motifById = new Map(CATALOG.motifs.map(m => [m.id, m]));

// ===================== Profile =====================

let tableReady = false;
function ensureTable() {
    if (tableReady) return;
    getDb().exec(`
        CREATE TABLE IF NOT EXISTS taste_profiles (
            user_id INTEGER PRIMARY KEY,
            json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
    tableReady = true;
}

/** Keep only known choices, in the user's order, within the limits */
function sanitize(input) {
    const pick = (list, known, max) => [...new Set(Array.isArray(list) ? list.map(String) : [])]
        .filter(id => known.has(id)).slice(0, max);
    const oneOf = (value, options, fallback) => options.some(o => o.id === value) ? value : fallback;
    const sports = pick(input?.sports, sportIds, sportIds.size);
    // Only teams the server knows (their lists are fetched for the quiz)
    const known = liveEvents.teamsByKey(pick(input?.teams, { has: k => /^[a-z0-9.-]+:\d+$/.test(k) }, CATALOG.limits.teams));
    return {
        genres: pick(input?.genres, genreById, CATALOG.limits.genres),
        motifs: pick(input?.motifs, motifById, CATALOG.limits.motifs),
        format: oneOf(input?.format, CATALOG.formats, 'both'),
        era: oneOf(input?.era, CATALOG.eras, 'any'),
        mood: oneOf(input?.mood, CATALOG.moods, 'popular'),
        sports,
        regions: sports.length ? pick(input?.regions, regionIds, regionIds.size) : [],
        // Only for picked sports
        divisions: pick(input?.divisions, divisionIds, divisionIds.size).filter(d => sports.includes(d.split(':')[0])),
        teams: sports.length ? [...known.keys()] : []
    };
}

function getProfile(userId) {
    ensureTable();
    const row = getDb().prepare('SELECT json, updated_at FROM taste_profiles WHERE user_id = ?').get(userId);
    if (!row) return null;
    const profile = sanitize(JSON.parse(row.json));
    // Names/logos for the picked teams, so the quiz can show them again
    const teams = liveEvents.teamsByKey(profile.teams);
    return { ...profile, teamInfo: profile.teams.map(k => teams.get(k)), updatedAt: row.updated_at };
}

function saveProfile(userId, input) {
    ensureTable();
    const profile = sanitize(input);
    const now = Date.now();
    getDb().prepare('INSERT OR REPLACE INTO taste_profiles (user_id, json, updated_at) VALUES (?, ?, ?)')
        .run(userId, JSON.stringify(profile), now);
    forYouCache.delete(userId);
    if (profile.sports.length) liveEvents.profileChanged();
    return getProfile(userId);
}

function deleteProfile(userId) {
    ensureTable();
    getDb().prepare('DELETE FROM taste_profiles WHERE user_id = ?').run(userId);
    forYouCache.delete(userId);
}

// ===================== Library matching =====================

function yearOf(value) {
    const m = /\b(19|20)\d{2}\b/.exec(String(value || ''));
    return m ? parseInt(m[0], 10) : null;
}

/**
 * TMDB ids -> the library's best playlist copy of each (priority language
 * first; hard filter drops other-language copies), with its stored TMDB
 * record. One scan for any number of ids. Returns Map(tmdb_id -> item).
 *
 * Series are only offered as p.type='series' (the provider also files some
 * under 'movie' in series categories; those can't open as a series).
 */
function matchLibrary(kind, ids, sourceIds, { lang = '', hard = false } = {}) {
    const out = new Map();
    if (!ids.length || !sourceIds.length) return out;

    const typeClause = kind === 'tv'
        ? `p.type = 'series'`
        : `p.type = 'movie' AND (c.type IS NULL OR c.type <> 'series')`;
    const meta = hasTmdbMeta();
    const rows = getDb().prepare(`
        SELECT p.source_id, p.item_id, p.name, p.stream_icon, p.rating, p.year, p.category_id,
               p.container_extension, c.name AS category,
               CAST(json_extract(p.data, '$.tmdb') AS TEXT) AS tmdb_id,
               ${meta ? 'm.overview, m.genres, m.release_date, m.vote_average'
                      : 'NULL AS overview, NULL AS genres, NULL AS release_date, NULL AS vote_average'}
        FROM playlist_items p
        LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id
        ${meta ? `LEFT JOIN tmdb_meta m ON m.kind = @kind AND m.tmdb_id = CAST(json_extract(p.data, '$.tmdb') AS TEXT)` : ''}
        WHERE ${typeClause}
          AND p.is_hidden = 0 AND (c.is_hidden IS NULL OR c.is_hidden = 0)
          AND p.source_id IN (SELECT value FROM json_each(@sources))
          AND CAST(json_extract(p.data, '$.tmdb') AS TEXT) IN (SELECT value FROM json_each(@ids))
        ORDER BY p.rowid
    `).all({ ...(meta ? { kind } : {}), sources: JSON.stringify(sourceIds), ids: JSON.stringify([...new Set(ids)]) });

    const best = new Map();
    for (const row of rows) {
        if (hard && lang && !languages.visible(row.name, row.category, lang)) continue;
        const score = lang && languages.matches(row.name, row.category, lang) ? 1 : 0;
        const current = best.get(row.tmdb_id);
        if (!current || score > current.score) best.set(row.tmdb_id, { row, score });
    }
    for (const [id, { row }] of best) {
        out.set(id, {
            tmdb_id: id,
            item_id: row.item_id,
            source_id: row.source_id,
            type: kind === 'tv' ? 'series' : 'movie',
            name: row.name,
            stream_icon: row.stream_icon,
            rating: row.rating,
            // The provider's year is sometimes a full date ("2026-08-16")
            year: yearOf(row.year) || yearOf(row.release_date),
            category_id: row.category_id,
            category_name: row.category,
            container_extension: row.container_extension,
            overview: row.overview || '',
            genres: row.genres || '',
            tmdb_rating: row.vote_average,
            data: {}
        });
    }
    return out;
}

// ===================== Local fallback =====================

function eraOf(profile) {
    return CATALOG.eras.find(e => e.id === profile.era) || CATALOG.eras[0];
}

/**
 * Library titles (by stored TMDB record) for a genre or motif, newest and
 * well-rated first. Only titles already in tmdb_meta, i.e. in the library.
 */
function localIds(kind, { names = [], words = [] }, profile, limit = 60) {
    const clauses = [];
    const params = { kind, limit, minVote: profile.mood === 'acclaimed' ? 7.2 : 6 };
    names.forEach((n, i) => { clauses.push(`genres LIKE @g${i}`); params[`g${i}`] = `%${n}%`; });
    words.forEach((w, i) => { clauses.push(`overview LIKE @w${i}`); params[`w${i}`] = `%${w}%`; });
    if (!clauses.length || !hasTmdbMeta()) return [];

    const era = eraOf(profile);
    let eraSql = '';
    if (era.min) { eraSql += ` AND release_date >= @eraMin`; params.eraMin = `${era.min}-01-01`; }
    if (era.max) { eraSql += ` AND release_date <= @eraMax`; params.eraMax = `${era.max}-12-31`; }

    return getDb().prepare(`
        SELECT tmdb_id FROM tmdb_meta
        WHERE kind = @kind AND status = 'ok' AND (${clauses.join(' OR ')})
          AND vote_average >= @minVote ${eraSql}
        ORDER BY release_date DESC
        LIMIT @limit
    `).all(params).map(r => r.tmdb_id);
}

// ===================== For You =====================

// userId -> { at, key, rows }: rebuilt when the profile or a TMDB list changes
const forYouCache = new Map();

/** The kinds a profile asks for, in display order */
function kindsOf(profile) {
    return profile.format === 'movie' ? ['movie'] : profile.format === 'tv' ? ['tv'] : ['movie', 'tv'];
}

/** TMDB discover requests for one row source (a genre or motif), per kind */
function discoverRequests(source, isMotif, profile) {
    const era = eraOf(profile);
    const base = {
        era: era.min || era.max ? { min: era.min, max: era.max } : null,
        acclaimed: profile.mood === 'acclaimed'
    };
    const out = {};
    for (const kind of kindsOf(profile)) {
        if (isMotif) {
            out[kind] = { ...base, kind, keywords: source.keywords };
        } else if (source[kind]?.length) {
            out[kind] = { ...base, kind, genres: source[kind] };
        } else if (kind === 'tv' && source.tvKeywords?.length) {
            out[kind] = { ...base, kind, keywords: source.tvKeywords };
        }
    }
    return out;
}

/** Interleave lists: a1 b1 a2 b2 ... */
function interleave(lists) {
    const out = [];
    for (let i = 0; lists.some(l => i < l.length); i++) {
        lists.forEach(l => { if (i < l.length) out.push(l[i]); });
    }
    return out;
}

/**
 * Build the user's rows: from their watch history first (services/recommend.js:
 * "Top picks", "Because you watched X"), then the quiz rows - "Popular in your
 * genres" (this week's trending), then genres and motifs alternating. A title
 * appears in one row only; "Not for me" titles in none; maturity rules
 * (services/maturity.js, TMDB data only) apply to every row.
 * Returns { profile, rows: [{ id, title, items }], pending }.
 */
async function forYou(user, { settings, sourceIds }) {
    const profile = getProfile(user.id);
    const lang = settings.languagePriority || '';
    const hard = !!(settings.languageHardFilter && lang);

    const seen = new Set();
    const rows = historyRows(user, profile, sourceIds, { lang, hard }, seen);
    if (!profile) return { profile: null, rows, pending: false };

    const kinds = kindsOf(profile);

    // Plan every row first, so the library is scanned once per kind
    let pending = false;
    const plans = [];
    const genres = profile.genres.map(id => genreById.get(id)).filter(Boolean);
    const motifs = profile.motifs.map(id => motifById.get(id)).filter(Boolean);
    const sources = interleave([
        genres.map(g => ({ src: g, motif: false })),
        motifs.map(m => ({ src: m, motif: true }))
    ]);
    for (const { src, motif } of sources) {
        const reqs = discoverRequests(src, motif, profile);
        const perKind = {};
        for (const kind of kinds) {
            let ranked = [];
            if (reqs[kind]) {
                const res = tmdbDiscover.get(reqs[kind]);
                ranked = res.ids;
                pending = pending || res.pending;
            }
            const local = localIds(kind, motif ? { words: src.words } : { names: src.names }, profile);
            perKind[kind] = [...new Set([...ranked, ...local])];
        }
        plans.push({
            id: `${motif ? 'motif' : 'genre'}-${src.id}`,
            title: motif ? `Because you're into ${src.label}` : `Trending in ${src.label}`,
            perKind
        });
    }

    // Top picks: this week's trending, kept only when it shares a genre with the
    // profile (TMDB genre names from the stored records)
    const wantedNames = genres.flatMap(g => g.names.map(n => n.toLowerCase()));
    const topIds = {};
    kinds.forEach(kind => { topIds[kind] = tmdbTrending.ids(kind); });

    // One library scan per kind covering every id any row wants
    const library = {};
    for (const kind of kinds) {
        const all = new Set(topIds[kind]);
        plans.forEach(p => p.perKind[kind].forEach(id => all.add(id)));
        library[kind] = matchLibrary(kind, [...all], sourceIds, { lang, hard });
    }

    const watched = finishedItems(user.id);
    const ok = maturityGate(user, profile, kinds.flatMap(kind => [...library[kind].keys()].map(id => `${kind}:${id}`)));
    const take = (kind, ids, filter = () => true) => {
        const out = [];
        for (const id of ids) {
            if (out.length >= ROW_SIZE) break;
            const item = library[kind].get(id);
            if (!item || !filter(item) || !ok(kind, id)) continue;
            const key = `${item.type}:${item.source_id}:${item.item_id}`;
            if (seen.has(key) || watched.has(`${item.source_id}:${item.item_id}`)) continue;
            seen.add(key);
            out.push(item);
        }
        return out;
    };

    const sharesGenre = item => !wantedNames.length ||
        item.genres.toLowerCase().split(/\s*,\s*/).some(g => wantedNames.some(w => g.includes(w)));
    const top = interleave(kinds.map(kind => take(kind, topIds[kind], sharesGenre))).slice(0, ROW_SIZE);
    if (top.length >= 4) {
        // With history rows above, the history's own "Top picks" leads
        const title = rows.length ? 'Popular this week in your genres' : `Top picks for ${user.username || 'you'}`;
        rows.push({ id: 'top-picks', title, items: top });
    }
    for (const plan of plans) {
        const items = interleave(kinds.map(kind => take(kind, plan.perKind[kind]))).slice(0, ROW_SIZE);
        if (items.length >= 3) rows.push({ id: plan.id, title: plan.title, items });
    }

    return { profile, rows, pending: pending || tmdbDiscover.busy() };
}

/**
 * (kind, id) -> may this row show it? "Not for me" never; a kids account only
 * known levels up to its limit; everyone else no kids titles (level <= 1)
 * unless they picked Family & Kids. Levels come from TMDB data only.
 */
function maturityGate(user, profile, keys) {
    const levels = maturity.levels(keys);
    // "Not for me", and anything already watched (series too, not just movies)
    const hidden = new Set([...recommend.notForMe(user.id), ...recommend.watchedKeys(user.id)]);
    const limit = maturity.limitFor(user);
    const kidsOk = (profile?.genres || []).includes('family');
    return (kind, id) => {
        const key = `${kind}:${id}`;
        if (hidden.has(key)) return false;
        const level = levels.has(key) ? levels.get(key) : null;
        if (limit !== null) return level !== null && level <= limit;
        return kidsOk || level === null || level > 1;
    };
}

/** Rows from watch history (services/recommend.js) as library items */
function historyRows(user, profile, sourceIds, { lang, hard }, seen) {
    let computed;
    try {
        computed = recommend.rowsFor(user, { quiz: profile, catalog: CATALOG });
    } catch (err) {
        console.error('[ForYou] Recommendations failed:', err);
        return [];
    }
    if (!computed.length) return [];

    // One library lookup per kind for every pick
    const library = {};
    for (const kind of ['movie', 'tv']) {
        const ids = computed.flatMap(r => r.picks.filter(p => p.kind === kind).map(p => p.id));
        library[kind] = matchLibrary(kind, ids, sourceIds, { lang, hard });
    }
    const titleOf = getDb().prepare('SELECT title FROM tmdb_meta WHERE kind = ? AND tmdb_id = ?');

    const out = [];
    for (const row of computed) {
        const items = [];
        for (const p of row.picks) {
            if (items.length >= ROW_SIZE) break;
            const item = library[p.kind].get(p.id);
            if (!item) continue;
            const key = `${item.type}:${item.source_id}:${item.item_id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push(item);
        }
        if (items.length < 4) continue;
        const title = row.because
            ? `Because you watched ${titleOf.get(row.because.kind, row.because.id)?.title || 'this'}`
            : `Top picks for ${user.username || 'you'}`;
        out.push({ id: row.id, title, items });
    }
    return out;
}

/** "source:item" of movies this user finished, so they aren't recommended */
function finishedItems(userId) {
    const rows = getDb().prepare(`
        SELECT source_id, item_id FROM watch_history
        WHERE user_id = ? AND item_type = 'movie' AND duration > 0 AND progress >= duration * 0.95
    `).all(userId);
    return new Set(rows.map(r => `${r.source_id}:${r.item_id}`));
}

/** forYou() with a per-user cache (30 min, or until TMDB lists change) */
async function forYouCached(user, ctx) {
    const profile = getProfile(user.id);
    const key = JSON.stringify([profile?.updatedAt, ctx.settings.languagePriority, ctx.settings.languageHardFilter,
        tmdbTrending.fetchedAt('movie'), tmdbTrending.fetchedAt('tv'), recommend.stamp(user.id),
        !!user.kids, user.maxMaturity || null]);
    const cached = forYouCache.get(user.id);
    if (cached && cached.key === key && Date.now() - cached.at < 30 * 60 * 1000) return cached.result;

    const result = await forYou(user, ctx);
    // Don't keep a result built while TMDB lists were still arriving
    if (!result.pending) forYouCache.set(user.id, { at: Date.now(), key, result });
    else forYouCache.delete(user.id);
    return result;
}

module.exports = { CATALOG, getProfile, saveProfile, deleteProfile, forYou: forYouCached, matchLibrary };
