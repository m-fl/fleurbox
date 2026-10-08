/**
 * Full-text search index (SQLite FTS5)
 *
 * One row per playlist item (live, movie, series), keyed by playlist_items.rowid,
 * over: title, playlist category, plot, tagline, cast, director(s), genres.
 * Plot/cast/director/genre come from tmdb_meta when present, falling back to the
 * provider's own series metadata.
 *
 * The table is contentless (content=''): it stores only the index, not a second
 * copy of the text - display fields are joined back from playlist_items.
 * Rebuilt in chunks into a side table and swapped in, so it never blocks the
 * server for long and searches keep working during a rebuild.
 */

const { getDb } = require('../db/sqlite');
const languages = require('./languages');

const TABLE = 'search_fts';
// ftype holds one token per row (typelive / typemovie / typeseries) so the
// content-type filter is part of the FTS match instead of a post-filter
const COLUMNS = ['name', 'category', 'overview', 'tagline', 'cast_names', 'directors', 'genres', 'ftype'];
// bm25 weights, in COLUMNS order: title matches rank highest, then cast/director
const WEIGHTS = [10.0, 2.0, 1.0, 1.0, 4.0, 4.0, 1.5, 0.0];
// Rank phase 1 keeps the best N matches by relevance; phase 2 reorders only those
const CANDIDATES = 3000;
// With the language hard filter on, many candidates are dropped after phase 1,
// so take a deeper slice
const CANDIDATES_FILTERED = 10000;
// How much a title's fame (0..1 percentile, services/tmdbPopularity.js) can
// lift it past more literal text matches. bm25 scores here run about -5..-20,
// so this nudges near-equal matches without burying the right one.
const FAME_WEIGHT = 3;

// year:/date:/released: filters (not FTS columns - applied to the computed year)
const YEAR_FIELDS = new Set(['year', 'date', 'released', 'release']);
// Release year: TMDB date, else the provider's date/year, else "(2010)" in the title
const YEAR_SQL = `COALESCE(
    NULLIF(CAST(substr(m.release_date, 1, 4) AS INTEGER), 0),
    NULLIF(CAST(substr(COALESCE(json_extract(p.data, '$.releaseDate'), json_extract(p.data, '$.release_date')), 1, 4) AS INTEGER), 0),
    NULLIF(CAST(p.year AS INTEGER), 0),
    title_year(p.name))`;
const CHUNK = 5000;

// field:value prefixes the search box accepts -> FTS column
const FIELDS = {
    title: 'name', name: 'name',
    category: 'category', cat: 'category',
    plot: 'overview', overview: 'overview', description: 'overview', desc: 'overview',
    tagline: 'tagline',
    cast: 'cast_names', actor: 'cast_names', actors: 'cast_names', starring: 'cast_names',
    director: 'directors', directors: 'directors', creator: 'directors', by: 'directors',
    genre: 'genres', genres: 'genres'
};

// The provider files ~10k series under type 'movie' (in series categories, with TV
// ids), so the category's type decides movie vs tv, not p.type
const TMDB_KIND = `CASE WHEN p.type = 'series' OR c.type = 'series' THEN 'tv' ELSE 'movie' END`;
const TMDB_JOIN = `LEFT JOIN tmdb_meta m ON m.status = 'ok'
      AND m.kind = ${TMDB_KIND}
      AND m.tmdb_id = CAST(json_extract(p.data, '$.tmdb') AS TEXT)`;
// categories.id is "sourceId:categoryId" (unique per source, whatever the type),
// so join on the primary key
const CATEGORY_JOIN = `LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id`;
// One search result per title: the provider files the same film/show in many
// categories (languages, 4K, Netflix, top lists...), all carrying the same TMDB
// id. Rows without one (and live channels) stay separate.
const TMDB_ID = `IFNULL(CAST(json_extract(p.data, '$.tmdb') AS TEXT), '')`;
const GROUP_KEY = `CASE WHEN p.type <> 'live' AND ${TMDB_ID} NOT IN ('', '0')
    THEN ${TMDB_KIND} || ':' || ${TMDB_ID} ELSE 'row:' || p.rowid END`;
// Over a `ranked` CTE (rows + group_key + pos = rank): each group's best-ranked
// row, in rank order, with `variants` = how many copies matched
const GROUPED_SELECT = `
    SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY pos) AS group_pos,
            COUNT(*) OVER (PARTITION BY group_key) AS variants
        FROM ranked
    )
    WHERE group_pos = 1
    ORDER BY pos
    LIMIT @limit OFFSET @offset`;

class SearchIndex {
    constructor() {
        this.building = null;
        this.rebuildQueued = false;
        this.lastBuild = null;
    }

    exists() {
        return !!getDb().prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(TABLE);
    }

    /**
     * Rebuild in the background. Calls while a build runs coalesce into one more build.
     */
    rebuild(reason = 'manual') {
        if (this.building) {
            this.rebuildQueued = true;
            return this.building;
        }
        this.building = this.build(reason)
            .catch(err => console.error('[Search] Index build failed:', err))
            .finally(() => {
                this.building = null;
                if (this.rebuildQueued) {
                    this.rebuildQueued = false;
                    this.rebuild('queued');
                }
            });
        return this.building;
    }

    async build(reason) {
        const db = getDb();
        require('./tmdbSync').ensureTables(); // tmdb_meta must exist for the join
        const started = Date.now();
        const next = `${TABLE}_next`;

        db.exec(`DROP TABLE IF EXISTS ${next}`);
        db.exec(`CREATE VIRTUAL TABLE ${next} USING fts5(${COLUMNS.join(', ')},
            content='', tokenize='unicode61 remove_diacritics 2', prefix='2 3')`);

        const select = db.prepare(`
            SELECT p.rowid AS rowid, p.name AS name, c.name AS category,
                COALESCE(m.overview, json_extract(p.data, '$.plot')) AS overview,
                m.tagline AS tagline,
                COALESCE(m.cast_names, json_extract(p.data, '$.cast')) AS cast_names,
                COALESCE(m.directors, json_extract(p.data, '$.director')) AS directors,
                COALESCE(m.genres, json_extract(p.data, '$.genre')) AS genres,
                'type' || p.type AS ftype
            FROM playlist_items p
            ${CATEGORY_JOIN}
            ${TMDB_JOIN}
            WHERE p.type IN ('live', 'movie', 'series') AND p.rowid > ?
            ORDER BY p.rowid
            LIMIT ?
        `);
        const insert = db.prepare(`INSERT INTO ${next} (rowid, ${COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insertChunk = db.transaction(rows => {
            for (const r of rows) {
                insert.run(r.rowid, r.name, r.category, r.overview, r.tagline, r.cast_names, r.directors, r.genres, r.ftype);
            }
        });

        let lastRowid = 0;
        let total = 0;
        while (true) {
            const rows = select.all(lastRowid, CHUNK);
            if (!rows.length) break;
            insertChunk(rows);
            total += rows.length;
            lastRowid = rows[rows.length - 1].rowid;
            // Yield between chunks so API requests and streams are not starved
            await new Promise(resolve => setImmediate(resolve));
        }

        db.exec(`INSERT INTO ${next}(${next}) VALUES ('optimize')`);
        db.transaction(() => {
            db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
            db.exec(`ALTER TABLE ${next} RENAME TO ${TABLE}`);
        })();

        // Language counts only change with the playlist, not with TMDB progress
        if (reason === "playlist-sync" || reason === "initial") languages.invalidate();
        const withMeta = db.prepare(`SELECT COUNT(*) n FROM tmdb_meta WHERE status = 'ok'`).get().n;
        this.lastBuild = { reason, rows: total, tmdbTitles: withMeta, ms: Date.now() - started, at: new Date().toISOString() };
        console.log(`[Search] Index rebuilt (${reason}): ${total} items, ${withMeta} TMDB titles, ${this.lastBuild.ms}ms`);
    }

    /**
     * Turn what the user typed into a safe FTS5 MATCH expression.
     *   words         -> every word must match (prefix match: "incep" finds Inception)
     *   "a phrase"    -> exact phrase
     *   field:value   -> restrict to a field (cast:, director:, genre:, category:, plot:, title: ...)
     *   -word         -> exclude
     *   OR            -> either side
     *   year:2007  year:>2007  year:2007>  year:2000-2010  (also date:, released:)
     * Only letters/digits ever reach the FTS parser, so input can never cause a syntax error.
     * Returns null when nothing searchable remains.
     */
    toMatchQuery(input) {
        const tokenRe = /(-)?(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi;
        const terms = [];
        let pendingOr = false;
        let m;

        let yearMin = null;
        let yearMax = null;

        while ((m = tokenRe.exec(String(input || '')))) {
            const [, neg, rawField, phrase, word] = m;
            if (rawField && YEAR_FIELDS.has(rawField.toLowerCase())) {
                const range = this.parseYearRange(phrase ?? word);
                if (range) {
                    // several year filters narrow each other
                    if (range.min !== null) yearMin = yearMin === null ? range.min : Math.max(yearMin, range.min);
                    if (range.max !== null) yearMax = yearMax === null ? range.max : Math.min(yearMax, range.max);
                }
                continue;
            }
            if (!neg && !rawField && word === 'OR') {
                pendingOr = terms.some(t => !t.neg);
                continue;
            }
            const column = rawField ? FIELDS[rawField.toLowerCase()] : null;
            // Unknown "field:" is just text (e.g. "Mission:Impossible")
            const text = rawField && !column ? `${rawField} ${phrase ?? word}` : (phrase ?? word);
            const words = (text.match(/[\p{L}\p{N}]+/gu) || []).map(w => w.toLowerCase());
            if (!words.length) continue;
            terms.push({ neg: !!neg, column, words, isPhrase: phrase !== undefined, orWithPrev: !neg && pendingOr });
            if (!neg) pendingOr = false;
        }

        // Only the word being typed (the last bare word) is prefix-matched
        const lastBare = [...terms].reverse().find(t => !t.isPhrase);
        const positives = [];
        const negatives = [];
        for (const t of terms) {
            let expr = t.isPhrase
                ? `"${t.words.join(' ')}"`
                : t.words.map((w, i) => `"${w}"${t === lastBare && i === t.words.length - 1 ? '*' : ''}`).join(' ');
            if (t.column) expr = `${t.column} : (${expr})`;

            if (t.neg) negatives.push(`(${expr})`);
            else if (t.orWithPrev) positives[positives.length - 1] = `(${positives[positives.length - 1]} OR (${expr}))`;
            else positives.push(`(${expr})`);
        }

        const hasYear = yearMin !== null || yearMax !== null;
        // FTS5 NOT is binary, so text search needs a positive term; a year filter
        // alone is a valid search too (negatives then exclude via a subquery)
        if (!positives.length && !hasYear) return null;
        let match = positives.length ? positives.join(' AND ') : null;
        if (match && negatives.length) match = `(${match}) NOT (${negatives.join(' OR ')})`;
        const exclude = !match && negatives.length ? negatives.join(' OR ') : null;

        // Unfielded positive words, used to rank "words appear in the title, in order" first
        const titlePhrase = terms.filter(t => !t.neg && !t.column).flatMap(t => t.words).join(' ');
        return { match, exclude, titlePhrase, yearMin, yearMax };
    }

    /**
     * "2007" exact; ">2007" "<2007" ">=2007" "<=2007"; "2007>" / "2007+" = 2007 or
     * later; "2007<" = 2007 or earlier; "2000-2010" / "2000..2010" inclusive.
     * Returns { min, max } (null = open) or null if it is not a year expression.
     */
    parseYearRange(value) {
        const v = String(value || '').trim();
        let m;
        if ((m = /^(\d{4})$/.exec(v))) return { min: +m[1], max: +m[1] };
        if ((m = /^(\d{4})(?:-|\.\.)(\d{4})$/.exec(v))) {
            const [a, b] = [+m[1], +m[2]].sort((x, y) => x - y);
            return { min: a, max: b };
        }
        if ((m = /^(>=|<=|>|<)(\d{4})$/.exec(v))) {
            const y = +m[2];
            return { '>': { min: y + 1, max: null }, '>=': { min: y, max: null },
                     '<': { min: null, max: y - 1 }, '<=': { min: null, max: y } }[m[1]];
        }
        if ((m = /^(\d{4})(>|\+|<)$/.exec(v))) {
            const y = +m[1];
            return m[2] === '<' ? { min: null, max: y } : { min: y, max: null };
        }
        return null;
    }

    /**
     * @returns {{items: object[], hasMore: boolean}} or null if the query is empty
     */
    /**
     * @param {string} [lang] - language id (see languages.js) whose titles sort first
     * @param {boolean} [hard] - also hide titles explicitly marked as another language
     * @param {string} [pattern] - title regex (the active Home filter zone)
     */
    search({ q, type, limit, offset, lang, hard, pattern }) {
        languages.ensureSqlFunctions();
        const language = languages.LANGUAGES.some(l => l.id === lang) ? lang : '';
        const hardFilter = !!(hard && language);
        const parsed = this.toMatchQuery(q);
        if (!parsed) return null;
        if (!this.exists()) {
            const err = new Error('Search index is still being built - try again shortly');
            err.status = 503;
            throw err;
        }
        this.ensureSqlFunctions();

        const hasYear = parsed.yearMin !== null || parsed.yearMax !== null;
        // Shared filters: hidden items/categories, language hard filter, year range
        const filterSql = `
              p.is_hidden = 0
              AND IFNULL(c.is_hidden, 0) = 0
              AND (@hard = 0 OR lang_visible(p.name, c.name, @lang) = 1)
              AND (@yearMin IS NULL OR ${YEAR_SQL} >= @yearMin)
              AND (@yearMax IS NULL OR ${YEAR_SQL} <= @yearMax)
              AND (@pattern IS NULL OR p.name REGEXP @pattern)`;
        const params = {
            hard: hardFilter ? 1 : 0,
            lang: language,
            yearMin: parsed.yearMin,
            yearMax: parsed.yearMax,
            pattern: pattern || null,
            title: parsed.titlePhrase,
            limit: limit + 1,
            offset
        };

        let rows;
        if (parsed.match) {
            // Phase 1 (FTS only, fast): best candidates of this type by relevance.
            // Phase 2: join display data, filter, and put in-order title matches,
            // then the preferred language, first - over those candidates only.
            const deep = hardFilter || hasYear || !!pattern; // many candidates dropped after phase 1
            rows = getDb().prepare(`
                WITH hits AS (
                    SELECT rowid, bm25(${TABLE}, ${WEIGHTS.join(', ')}) AS score
                    FROM ${TABLE}
                    WHERE ${TABLE} MATCH @match
                    ORDER BY score
                    LIMIT ${deep ? CANDIDATES_FILTERED : CANDIDATES}
                )
                , ranked AS (
                    SELECT p.*, c.name AS category_name,
                        COALESCE(m.overview, json_extract(p.data, '$.plot')) AS overview,
                        ${YEAR_SQL} AS release_year,
                        m.vote_average AS tmdb_rating,
                        m.fame AS tmdb_fame,
                        h.score AS score,
                        ${GROUP_KEY} AS group_key,
                        ROW_NUMBER() OVER (ORDER BY
                            CASE WHEN @title <> '' AND instr(lower(p.name), @title) > 0 THEN 0 ELSE 1 END,
                            CASE WHEN lang_match(p.name, c.name, @lang) = 1 THEN 0 ELSE 1 END,
                            -- Only fields searched (cast:, director:, genre:, ...): every hit
                            -- matches about equally, so the best-known titles lead.
                            -- With plain words, relevance leads and fame nudges.
                            CASE WHEN @title = '' THEN -IFNULL(m.fame, 0) ELSE 0 END,
                            h.score - ${FAME_WEIGHT} * IFNULL(m.fame, 0)
                        ) AS pos
                    FROM hits h
                    JOIN playlist_items p ON p.rowid = h.rowid
                    ${CATEGORY_JOIN}
                    ${TMDB_JOIN}
                    WHERE ${filterSql}
                )
                ${GROUPED_SELECT}
            `).all({ ...params, match: `(${parsed.match}) AND (ftype : "type${type}")` });
        } else {
            // Year filter only (e.g. "year:>2020", "date:2007< -horror"): no text to
            // rank by, so priority language first, then newest first
            rows = getDb().prepare(`
                WITH base AS (
                    SELECT p.*, c.name AS category_name,
                        COALESCE(m.overview, json_extract(p.data, '$.plot')) AS overview,
                        ${YEAR_SQL} AS release_year,
                        m.vote_average AS tmdb_rating,
                        m.fame AS tmdb_fame,
                        0 AS score,
                        ${GROUP_KEY} AS group_key
                    FROM playlist_items p
                    ${CATEGORY_JOIN}
                    ${TMDB_JOIN}
                    WHERE p.type = @type
                      AND ${filterSql}
                      AND (@exclude IS NULL OR p.rowid NOT IN (SELECT rowid FROM ${TABLE} WHERE ${TABLE} MATCH @exclude))
                ), ranked AS (
                    SELECT *, ROW_NUMBER() OVER (ORDER BY
                        CASE WHEN lang_match(name, category_name, @lang) = 1 THEN 0 ELSE 1 END,
                        release_year DESC,
                        name
                    ) AS pos
                    FROM base
                )
                ${GROUPED_SELECT}
            `).all({ ...params, type, exclude: parsed.exclude });
        }

        const items = rows.slice(0, limit).map(({ pos, group_pos, ...row }) => {
            const data = row.data ? JSON.parse(row.data) : {};
            const year = row.release_year ? String(row.release_year) : '';
            return {
                ...row,
                data: {
                    ...data,
                    // Home cards show data.subtitle; series details use description/year
                    subtitle: [year, row.category_name].filter(Boolean).join(' · ') || undefined,
                    description: row.overview || data.plot || '',
                    year
                }
            };
        });
        return { items, hasMore: rows.length > limit, match: parsed.match };
    }

    /**
     * title_year(name): the last "(19xx)"/"(20xx)" in a title, for rows with no date
     */
    ensureSqlFunctions() {
        if (this.sqlFunctionsReady) return;
        getDb().function('title_year', { deterministic: true }, name => {
            const all = String(name || '').match(/\((19\d{2}|20\d{2})\)/g);
            return all ? parseInt(all[all.length - 1].slice(1, 5), 10) : null;
        });
        this.sqlFunctionsReady = true;
    }

    status() {
        return {
            exists: this.exists(),
            building: !!this.building,
            lastBuild: this.lastBuild,
            rows: this.exists() ? getDb().prepare(`SELECT COUNT(*) n FROM ${TABLE}_docsize`).get()?.n ?? null : 0
        };
    }
}

module.exports = new SearchIndex();
