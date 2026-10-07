/**
 * Language priority + hard filter
 *
 * The provider marks language with a name prefix ("EN - Inception", "4K-DE - ...",
 * "US| ESPN", "MX: ESPN 2") or in the category name ("ENGLISH SERIES",
 * "GERMANY SERIE", "FR - FILMS"). detect() turns those into a language id.
 *
 * Platform prefixes (NF, AMZ, SOC, TOP, MAX, ...) say nothing about language and
 * are deliberately absent, so "NF - Inception" has no language marker. Country
 * codes used for live channels are folded into their main language
 * (US/UK/CA/AU -> English). Ambiguous ones are left out.
 *
 * The same rules run in the browser (LanguagePriority in ContentDetails.js) for
 * the Movies/Series grids - keep the two in step.
 */

const { getDb } = require('../db/sqlite');

const LANGUAGES = [
    { id: 'en', label: 'English', codes: ['EN', 'US', 'UK', 'CA', 'AU', 'IE', 'NZ'], words: ['ENGLISH'] },
    { id: 'de', label: 'German', codes: ['DE', 'AT', 'CH'], words: ['GERMAN'] },
    { id: 'fr', label: 'French', codes: ['FR', 'QC'], words: ['FRANCE', 'FRENCH'] },
    { id: 'es', label: 'Spanish', codes: ['ES', 'MX', 'LA'], words: ['SPAIN', 'SPANISH', 'ESPAÑA', 'LATINO'] },
    { id: 'pt', label: 'Portuguese', codes: ['PT', 'BR'], words: ['PORTUG', 'BRAZIL', 'BRASIL'] },
    { id: 'it', label: 'Italian', codes: ['IT'], words: ['ITALY', 'ITALIAN'] },
    { id: 'nl', label: 'Dutch', codes: ['NL'], words: ['DUTCH', 'NETHERLAND'] },
    { id: 'el', label: 'Greek', codes: ['GR', 'CY'], words: ['GREECE', 'GREEK'] },
    { id: 'tr', label: 'Turkish', codes: ['TR'], words: ['TURK'] },
    { id: 'pl', label: 'Polish', codes: ['PL'], words: ['POLSKA', 'POLISH'] },
    { id: 'ro', label: 'Romanian', codes: ['RO'], words: ['ROMANIA'] },
    { id: 'sq', label: 'Albanian', codes: ['AL'], words: ['ALBANIA'] },
    { id: 'sv', label: 'Swedish', codes: ['SE'], words: ['SVENSKA', 'SWED'] },
    { id: 'da', label: 'Danish', codes: ['DK'], words: ['DANISH', 'DANSK', 'DENMARK'] },
    { id: 'no', label: 'Norwegian', codes: ['NO'], words: ['NORW', 'NORSK'] },
    { id: 'fi', label: 'Finnish', codes: ['FI'], words: ['FINNISH', 'SUOMI'] },
    { id: 'nordic', label: 'Nordic (mixed)', codes: ['SC'], words: ['NORDIC'] },
    { id: 'cs', label: 'Czech', codes: ['CZ'], words: ['CZECH'] },
    { id: 'hr', label: 'Croatian', codes: ['HR'], words: ['CROATIA'] },
    { id: 'hi', label: 'Hindi / Indian', codes: ['IN'], words: ['HINDI', 'INDIA'] },
    { id: 'ur', label: 'Urdu / Pakistani', codes: ['PK'], words: ['PAKISTAN', 'URDU'] },
    { id: 'bn', label: 'Bengali', codes: ['BN'], words: ['BANGLA', 'BENGALI'] },
    { id: 'fa', label: 'Persian', codes: ['IR'], words: ['PERSIAN', 'IRAN'] },
    { id: 'ps', label: 'Afghan', codes: ['AF'], words: ['AFGHAN'] },
    { id: 'ku', label: 'Kurdish', codes: ['KU'], words: ['KURD'] },
    { id: 'ar', label: 'Arabic', codes: ['AR'], words: ['ARAB'] },
    { id: 'he', label: 'Hebrew', codes: ['IL'], words: ['ISRAEL', 'HEBREW'] },
    { id: 'tl', label: 'Filipino', codes: ['PH'], words: ['FILIPINO', 'PHILIPPIN'] },
    { id: 'ja', label: 'Japanese', codes: ['JP'], words: ['JAPAN'] },
    { id: 'zh', label: 'Chinese', codes: ['CN'], words: ['CHINA', 'CHINESE'] }
];

const CODE_TO_LANGUAGE = new Map(LANGUAGES.flatMap(l => l.codes.map(code => [code, l.id])));
// "EN - x", "4K-EN - x", "EN-TOP - x", "US| x", "US | x", "MX: x" (upper-case code only,
// so ordinary titles like "It (2017)" or "Up: ..." never read as a code).
// Second part: "BE-NL - x" / "BE-FR - x" (bilingual country + language).
const PREFIX_RE = /^(?:4K-)?([A-Z]{2,3})(?:-([A-Z]+))?\s*[-|:]/;
// Category names ending in a language code: "BELGIUM KIDS (NL)", "VIDEOLAND SERIES (NL)"
const CATEGORY_SUFFIX_RE = /\(([A-Z]{2,3})\)\s*$/;

/**
 * Language id marked on a title or category name, or null when there is none.
 * Category names may also name the language in words ("ENGLISH SERIES").
 */
function detect(text, isCategory = false) {
    if (!text) return null;
    const m = PREFIX_RE.exec(text);
    if (m && CODE_TO_LANGUAGE.has(m[1])) return CODE_TO_LANGUAGE.get(m[1]);
    // First part isn't a language (BE = Belgium, VP = Viaplay, SO = a pack):
    // the second part may be ("BE-NL", "VP-NL", "SO-EN"). Only then - for
    // "IN-EN" / "AF-EN" the first part already decides.
    if (m && m[2] && CODE_TO_LANGUAGE.has(m[2])) return CODE_TO_LANGUAGE.get(m[2]);
    if (isCategory) {
        const upper = text.toUpperCase();
        for (const lang of LANGUAGES) {
            if (lang.words.some(w => upper.startsWith(w))) return lang.id;
        }
        const s = CATEGORY_SUFFIX_RE.exec(text);
        if (s && CODE_TO_LANGUAGE.has(s[1])) return CODE_TO_LANGUAGE.get(s[1]);
    }
    return null;
}

/** Title or its category is marked as language `id` */
function matches(name, category, id) {
    return !!id && (detect(name) === id || detect(category, true) === id);
}

/**
 * Hard filter: hide only titles explicitly marked as another language. Titles
 * with no language marker (NF/AMZ packs, unmarked live channels) stay.
 */
function visible(name, category, id) {
    if (!id) return true;
    const byName = detect(name);
    const byCategory = detect(category, true);
    if (!byName && !byCategory) return true;
    return byName === id || byCategory === id;
}

/**
 * Registers lang_match(name, category, id) and lang_visible(name, category, id)
 * on the shared connection, so ordering and filtering use exactly these rules
 * with bound parameters (no request value is ever spliced into SQL).
 */
let functionsReady = false;
function ensureSqlFunctions() {
    if (functionsReady) return;
    const db = getDb();
    db.function('lang_match', { deterministic: true }, (name, category, id) => (matches(name, category, id) ? 1 : 0));
    db.function('lang_visible', { deterministic: true }, (name, category, id) => (visible(name, category, id) ? 1 : 0));
    functionsReady = true;
}

// Counts are one full scan, so they are cached until the playlist changes
let countsCache = null;

/**
 * Languages present in the playlist, with title counts, most common first
 */
function available() {
    if (countsCache) return countsCache;

    const counts = new Map();
    const rows = getDb().prepare(`
        SELECT p.name, c.name AS category
        FROM playlist_items p
        LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id
        WHERE p.type IN ('live', 'movie', 'series')
    `).iterate();
    for (const { name, category } of rows) {
        const ids = new Set([detect(name), detect(category, true)]);
        for (const id of ids) if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }

    countsCache = LANGUAGES
        .map(l => ({ id: l.id, label: l.label, codes: l.codes, words: l.words, count: counts.get(l.id) || 0 }))
        .filter(l => l.count > 0)
        .sort((a, b) => b.count - a.count);
    return countsCache;
}

function invalidate() {
    countsCache = null;
}

module.exports = { LANGUAGES, detect, matches, visible, ensureSqlFunctions, available, invalidate };
