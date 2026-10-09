/**
 * Regional TV: Live TV channels of one country, found by regex - not linked to
 * anything (Live TV stays outside the media model; see the design doc
 * "Fleurbox media identity"). TODO #11.
 *
 * A channel is in a region when any of these says so:
 *   name prefix   "UK: BBC ONE", "BE-VIP: VTM", "CA EN: CTV"
 *   group prefix  "UK| SPORT", "BE| BELGIUM VIP"
 *   guide id      "bbcone.uk", "vtm.be" (the EPG channel's country)
 * so channels filed in mixed groups ("8K| SPORT ON AIR") still land in their
 * country. REGIONS is the one place to edit: `codes` are the provider's
 * prefixes, `guide` the guide id endings.
 */
const { getDb } = require('../db/sqlite');

const REGIONS = [
    { id: 'us', label: 'United States', codes: ['US', 'USA'], guide: ['us'] },
    { id: 'uk', label: 'United Kingdom', codes: ['UK', 'GB'], guide: ['uk', 'gb'] },
    { id: 'ie', label: 'Ireland', codes: ['IE'], guide: ['ie'] },
    { id: 'ca', label: 'Canada', codes: ['CA'], guide: ['ca'] },
    { id: 'be', label: 'Belgium', codes: ['BE'], guide: ['be'] },
    { id: 'nl', label: 'Netherlands', codes: ['NL'], guide: ['nl'] },
    { id: 'fr', label: 'France', codes: ['FR'], guide: ['fr'] },
    { id: 'de', label: 'Germany', codes: ['DE'], guide: ['de'] },
    { id: 'at', label: 'Austria', codes: ['AT'], guide: ['at'] },
    { id: 'ch', label: 'Switzerland', codes: ['CH'], guide: ['ch'] },
    { id: 'es', label: 'Spain', codes: ['ES'], guide: ['es'] },
    { id: 'pt', label: 'Portugal', codes: ['PT'], guide: ['pt'] },
    { id: 'it', label: 'Italy', codes: ['IT'], guide: ['it'] },
    { id: 'se', label: 'Sweden', codes: ['SE'], guide: ['se'] },
    { id: 'no', label: 'Norway', codes: ['NO'], guide: ['no'] },
    { id: 'dk', label: 'Denmark', codes: ['DK'], guide: ['dk'] },
    { id: 'fi', label: 'Finland', codes: ['FI'], guide: ['fi'] },
    { id: 'is', label: 'Iceland', codes: ['IS'], guide: ['is'] },
    { id: 'pl', label: 'Poland', codes: ['PL'], guide: ['pl'] },
    { id: 'cz', label: 'Czechia', codes: ['CZ'], guide: ['cz'] },
    { id: 'ro', label: 'Romania', codes: ['RO'], guide: ['ro'] },
    { id: 'gr', label: 'Greece', codes: ['GR'], guide: ['gr'] },
    { id: 'cy', label: 'Cyprus', codes: ['CY'], guide: ['cy'] },
    { id: 'tr', label: 'Turkey', codes: ['TR'], guide: ['tr'] },
    { id: 'al', label: 'Albania', codes: ['AL'], guide: ['al'] },
    { id: 'hr', label: 'Croatia / ex-Yugoslavia', codes: ['HR', 'EXYU'], guide: ['hr', 'rs', 'si', 'ba'] },
    { id: 'il', label: 'Israel', codes: ['IL'], guide: ['il'] },
    { id: 'ir', label: 'Iran', codes: ['IR'], guide: ['ir'] },
    { id: 'in', label: 'India / South Asia', codes: ['IN', 'PK'], guide: ['in', 'pk'] },
    { id: 'au', label: 'Australia', codes: ['AU'], guide: ['au'] },
    { id: 'nz', label: 'New Zealand', codes: ['NZ'], guide: ['nz'] },
    { id: 'mx', label: 'Mexico', codes: ['MX'], guide: ['mx'] },
    { id: 'br', label: 'Brazil', codes: ['BR'], guide: ['br'] },
    { id: 'ar', label: 'Argentina', codes: ['AR'], guide: ['ar'] },
    { id: 'ph', label: 'Philippines', codes: ['PH'], guide: ['ph'] },
    { id: 'af', label: 'Africa', codes: ['AFR'], guide: ['za', 'ng', 'ke'] }
];

const byId = new Map(REGIONS.map(r => [r.id, r]));

/** Regex strings for a region (case-insensitive, run by SQLite's REGEXP) */
function patterns(region) {
    const codes = region.codes.join('|');
    return {
        // "UK: ", "BE-VIP: ", "CA EN: ", "UK | "
        name: `^\\s*(?:${codes})(?:[-\\s][A-Z0-9+]{2,5})?\\s*[:|]`,
        group: `^\\s*(?:${codes})\\s*[|:]`,
        guide: `\\.(?:${region.guide.join('|')})$`
    };
}

/**
 * SQL condition for live rows `p` (category `c`) in the region, or null for
 * an unknown id. Binds @regionName, @regionGroup, @regionGuide.
 */
function sqlFor(id) {
    const region = byId.get(id);
    if (!region) return null;
    const p = patterns(region);
    return {
        sql: `(p.name REGEXP @regionName OR IFNULL(c.name, '') REGEXP @regionGroup
               OR IFNULL(COALESCE(json_extract(p.data, '$.epg_channel_id'), json_extract(p.data, '$.tvgId')), '') REGEXP @regionGuide)`,
        params: { regionName: p.name, regionGroup: p.group, regionGuide: p.guide }
    };
}

// Channel counts per region: one pass over the live list, kept until the next sync
let counts = null; // { at, sources, byRegion: Map }
const COUNTS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Regions that have channels in the given sources: [{ id, label, count }] */
function list(sourceIds) {
    const key = JSON.stringify(sourceIds);
    if (!counts || counts.sources !== key || Date.now() - counts.at > COUNTS_MAX_AGE_MS) {
        const rows = getDb().prepare(`
            SELECT p.name, c.name AS grp,
                   COALESCE(json_extract(p.data, '$.epg_channel_id'), json_extract(p.data, '$.tvgId')) AS guide
            FROM playlist_items p
            LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id
            WHERE p.type = 'live' AND p.is_hidden = 0 AND (c.is_hidden IS NULL OR c.is_hidden = 0)
              AND p.source_id IN (SELECT value FROM json_each(?))
        `).all(key);
        const compiled = REGIONS.map(r => {
            const p = patterns(r);
            return { id: r.id, name: new RegExp(p.name, 'i'), group: new RegExp(p.group, 'i'), guide: new RegExp(p.guide, 'i') };
        });
        const byRegion = new Map();
        for (const row of rows) {
            for (const re of compiled) {
                if (re.name.test(row.name || '') || re.group.test(row.grp || '') || re.guide.test(row.guide || '')) {
                    byRegion.set(re.id, (byRegion.get(re.id) || 0) + 1);
                }
            }
        }
        counts = { at: Date.now(), sources: key, byRegion };
    }
    return REGIONS.filter(r => counts.byRegion.get(r.id))
        .map(r => ({ id: r.id, label: r.label, count: counts.byRegion.get(r.id) }));
}

/** After a playlist sync: recount on next use */
function invalidate() {
    counts = null;
}

module.exports = { REGIONS, sqlFor, list, invalidate };
