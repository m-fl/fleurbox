/**
 * Live events: today's big fixtures (ESPN's public scoreboards) matched to the
 * channels whose EPG shows them, plus live fixtures found only in the EPG.
 *
 * Fetching: start() refreshes the stored fixtures (`live_events`) every 30
 * minutes, for yesterday/today/tomorrow, but only for the leagues someone's
 * taste profile asks for plus the `top` leagues everyone sees. Pages never
 * call ESPN; they read the stored fixtures.
 *
 * Matching: a fixture is on a channel when an EPG programme covering kick-off
 * names both sides (any language/separator: "Hokej (M): Capitals - Penguins",
 * "Live NHL: Utah Mammoth @ Boston Bruins"), or for F1/UFC carries the series
 * keyword. Guide-only events are programmes marked live ("Live:", "(Direto)",
 * "Uživo:", ...) whose title looks like a fixture ("A - B", "A vs B").
 * The result is one snapshot shared by all users, rebuilt every 10 minutes.
 *
 * Teams for the quiz come from ESPN's team lists (`sports_teams`, refreshed
 * weekly, fetched when the quiz first asks for a league).
 *
 * LEAGUES is the place to add or change competitions. `regions` refer to
 * taste.CATALOG.regions; 'global' leagues ignore the user's regions. `top`
 * leagues are fetched for everyone and shown to users without sports picks.
 * `weight` ranks events for users who didn't pick that league. `teams: false`
 * keeps a league (cups, friendlies) out of the quiz's team picker. `division`
 * ('pro' | 'college') lets the quiz narrow a sport to one level; a sport whose
 * leagues carry divisions gets that follow-up question (taste.CATALOG.divisions).
 */

const { getDb } = require('../db/sqlite');
const languages = require('./languages');

const API_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const LEAGUES = [
    // Football: national teams
    { id: 'fifa.world', path: 'soccer/fifa.world', sport: 'soccer', label: 'World Cup', regions: ['international'], top: true, weight: 10 },
    { id: 'uefa.euro', path: 'soccer/uefa.euro', sport: 'soccer', label: 'EURO', regions: ['international'], top: true, weight: 10 },
    { id: 'uefa.nations', path: 'soccer/uefa.nations', sport: 'soccer', label: 'Nations League', regions: ['international'], top: true, weight: 7 },
    { id: 'fifa.worldq.uefa', path: 'soccer/fifa.worldq.uefa', sport: 'soccer', label: 'World Cup Qualifying', regions: ['international'], top: true, weight: 7 },
    { id: 'fifa.friendly', path: 'soccer/fifa.friendly', sport: 'soccer', label: 'International Friendly', regions: ['international'], weight: 3, teams: false },
    // Football: European club competitions
    { id: 'uefa.champions', path: 'soccer/uefa.champions', sport: 'soccer', label: 'Champions League', regions: ['europe'], top: true, weight: 10 },
    { id: 'uefa.europa', path: 'soccer/uefa.europa', sport: 'soccer', label: 'Europa League', regions: ['europe'], top: true, weight: 7 },
    { id: 'uefa.europa.conf', path: 'soccer/uefa.europa.conf', sport: 'soccer', label: 'Conference League', regions: ['europe'], top: true, weight: 5 },
    // Football: domestic
    { id: 'eng.1', path: 'soccer/eng.1', sport: 'soccer', label: 'Premier League', regions: ['england'], top: true, weight: 9 },
    { id: 'eng.fa', path: 'soccer/eng.fa', sport: 'soccer', label: 'FA Cup', regions: ['england'], weight: 6, teams: false },
    { id: 'eng.league_cup', path: 'soccer/eng.league_cup', sport: 'soccer', label: 'Carabao Cup', regions: ['england'], weight: 5, teams: false },
    { id: 'esp.1', path: 'soccer/esp.1', sport: 'soccer', label: 'LALIGA', regions: ['spain'], top: true, weight: 8 },
    { id: 'esp.copa_del_rey', path: 'soccer/esp.copa_del_rey', sport: 'soccer', label: 'Copa del Rey', regions: ['spain'], weight: 5, teams: false },
    { id: 'ger.1', path: 'soccer/ger.1', sport: 'soccer', label: 'Bundesliga', regions: ['germany'], top: true, weight: 8 },
    { id: 'ger.dfb_pokal', path: 'soccer/ger.dfb_pokal', sport: 'soccer', label: 'DFB-Pokal', regions: ['germany'], weight: 5, teams: false },
    { id: 'ita.1', path: 'soccer/ita.1', sport: 'soccer', label: 'Serie A', regions: ['italy'], top: true, weight: 8 },
    { id: 'ita.coppa_italia', path: 'soccer/ita.coppa_italia', sport: 'soccer', label: 'Coppa Italia', regions: ['italy'], weight: 5, teams: false },
    { id: 'fra.1', path: 'soccer/fra.1', sport: 'soccer', label: 'Ligue 1', regions: ['france'], top: true, weight: 7 },
    { id: 'fra.coupe_de_france', path: 'soccer/fra.coupe_de_france', sport: 'soccer', label: 'Coupe de France', regions: ['france'], weight: 4, teams: false },
    { id: 'bel.1', path: 'soccer/bel.1', sport: 'soccer', label: 'Pro League', regions: ['belgium'], weight: 5 },
    { id: 'ned.1', path: 'soccer/ned.1', sport: 'soccer', label: 'Eredivisie', regions: ['netherlands'], weight: 5 },
    { id: 'ned.cup', path: 'soccer/ned.cup', sport: 'soccer', label: 'KNVB Beker', regions: ['netherlands'], weight: 3, teams: false },
    { id: 'por.1', path: 'soccer/por.1', sport: 'soccer', label: 'Primeira Liga', regions: ['portugal'], weight: 5 },
    { id: 'sco.1', path: 'soccer/sco.1', sport: 'soccer', label: 'Scottish Premiership', regions: ['scotland'], weight: 4 },
    { id: 'tur.1', path: 'soccer/tur.1', sport: 'soccer', label: 'Süper Lig', regions: ['turkey'], weight: 4 },
    { id: 'usa.1', path: 'soccer/usa.1', sport: 'soccer', label: 'MLS', regions: ['north-america'], weight: 4 },
    { id: 'mex.1', path: 'soccer/mex.1', sport: 'soccer', label: 'Liga MX', regions: ['mexico'], weight: 4 },
    { id: 'bra.1', path: 'soccer/bra.1', sport: 'soccer', label: 'Brasileirão', regions: ['south-america'], weight: 4 },
    { id: 'arg.1', path: 'soccer/arg.1', sport: 'soccer', label: 'Liga Profesional', regions: ['south-america'], weight: 4 },
    { id: 'conmebol.libertadores', path: 'soccer/conmebol.libertadores', sport: 'soccer', label: 'Libertadores', regions: ['south-america'], weight: 5 },
    // US sports. Team ids are per league (an NFL id can be a college id too)
    { id: 'nfl', path: 'football/nfl', sport: 'american-football', label: 'NFL', regions: ['north-america'], top: true, weight: 8, division: 'pro' },
    { id: 'college-football', path: 'football/college-football', sport: 'american-football', label: 'College Football', regions: ['north-america'], weight: 4, division: 'college' },
    { id: 'nba', path: 'basketball/nba', sport: 'basketball', label: 'NBA', regions: ['north-america'], top: true, weight: 7, division: 'pro' },
    { id: 'wnba', path: 'basketball/wnba', sport: 'basketball', label: 'WNBA', regions: ['north-america'], weight: 4, division: 'pro' },
    { id: 'mens-college-basketball', path: 'basketball/mens-college-basketball', sport: 'basketball', label: 'College Basketball', regions: ['north-america'], weight: 3, division: 'college' },
    { id: 'nhl', path: 'hockey/nhl', sport: 'hockey', label: 'NHL', regions: ['north-america'], top: true, weight: 6 },
    { id: 'mlb', path: 'baseball/mlb', sport: 'baseball', label: 'MLB', regions: ['north-america'], top: true, weight: 6 },
    // No two sides: matched by keyword instead of team names
    { id: 'f1', path: 'racing/f1', sport: 'motorsport', label: 'Formula 1', regions: ['global'], top: true, weight: 8,
        teams: false, keywords: ['formula 1', 'formula one', 'formel 1', 'formule 1', 'f1'] },
    { id: 'ufc', path: 'mma/ufc', sport: 'mma', label: 'UFC', regions: ['global'], top: true, weight: 6,
        teams: false, keywords: ['ufc'] }
];
const leagueById = new Map(LEAGUES.map(l => [l.id, l]));

// How long an event runs after its start, for "live now" between fetches
const DURATION_MIN = { soccer: 120, 'american-football': 210, basketball: 150, hockey: 165, baseball: 180, motorsport: 120, mma: 300 };
const F1_SESSIONS = { FP1: ['Practice 1', 60], FP2: ['Practice 2', 60], FP3: ['Practice 3', 60], Qual: ['Qualifying', 75], SS: ['Sprint Qualifying', 60], SR: ['Sprint', 60], Race: ['Race', 120] };

const REFRESH_EVERY_MS = 30 * 60 * 1000;
const TEAMS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;
// How far ahead favourite teams' games are shown (other events: the next 24h)
const TEAM_DAYS = 8;
// ...and leagues someone follows (fetched this many days ahead)
const LEAGUE_DAYS = 5;
const HOUR = 60 * 60 * 1000;

// ===================== Storage =====================

let tablesReady = false;
function ensureTables() {
    if (tablesReady) return;
    getDb().exec(`
        CREATE TABLE IF NOT EXISTS live_events (
            id TEXT PRIMARY KEY,         -- league:espnEventId[:session]
            league TEXT NOT NULL,
            start_time INTEGER NOT NULL, -- ms
            end_time INTEGER NOT NULL,   -- ms, estimated
            state TEXT NOT NULL,         -- 'pre' | 'in' | 'post' (as of fetched_at)
            json TEXT NOT NULL,          -- { title, home, away, detail }
            fetched_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_live_events_start ON live_events(start_time);
        CREATE TABLE IF NOT EXISTS sports_teams (
            league TEXT NOT NULL,
            team_key TEXT NOT NULL,      -- <id space>:<espn team id>, as stored in taste profiles
            name TEXT NOT NULL,
            short_name TEXT,
            logo TEXT,
            fetched_at INTEGER NOT NULL,
            PRIMARY KEY (league, team_key)
        );
    `);
    tablesReady = true;
}

/**
 * Team ids are shared across football (Anderlecht is 441 in every competition)
 * but not across US leagues (NFL and college football ids overlap)
 */
function teamKey(league, teamId) {
    return `${league.sport === 'soccer' ? 'soccer' : league.id}:${teamId}`;
}

async function espn(path) {
    const res = await fetch(`${API_BASE}/${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/** Run `fn` over `items`, `limit` at a time */
async function eachLimited(items, limit, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await fn(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ===================== Profiles -> leagues =====================

function savedProfiles() {
    try {
        return getDb().prepare('SELECT json FROM taste_profiles').all().map(r => JSON.parse(r.json));
    } catch {
        return []; // no quiz taken yet
    }
}

/**
 * Leagues for a profile's sports. Divisions ("american-football:college")
 * narrow a sport to those levels first; none picked means the top league's
 * level. Regions narrow it only when one of the
 * picked regions has leagues in that sport; otherwise its top leagues are used
 * (or all of them when the chosen levels have no top league).
 */
function leaguesFor(profile) {
    const sports = profile?.sports || [];
    const regions = new Set(profile?.regions || []);
    const divisions = profile?.divisions || [];
    const out = new Set();
    for (const sport of sports) {
        let levels = divisions.filter(d => d.startsWith(`${sport}:`)).map(d => d.slice(sport.length + 1));
        const chosen = levels.length > 0;
        // No level picked: the level of the sport's top league (NFL/NBA, not college)
        if (!chosen) levels = LEAGUES.filter(l => l.sport === sport && l.top && l.division).map(l => l.division);
        const inSport = LEAGUES.filter(l => l.sport === sport && (!levels.length || !l.division || levels.includes(l.division)));
        const regional = inSport.filter(l => l.regions.some(r => regions.has(r)));
        const top = inSport.filter(l => l.top);
        // Picked levels mean every league at them ("Professional" = NBA and WNBA)
        const picked = regional.length ? regional : chosen || !top.length ? inSport : top;
        picked.forEach(l => out.add(l.id));
        inSport.filter(l => l.regions.includes('global')).forEach(l => out.add(l.id));
    }
    return out;
}

/** Leagues of a profile's teams (a team's league is in the profile even if its region isn't) */
function teamLeagues(teamKeys) {
    if (!teamKeys?.length) return new Set();
    ensureTables();
    return new Set(getDb().prepare(`SELECT DISTINCT league FROM sports_teams WHERE team_key IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(teamKeys)).map(r => r.league));
}

function wantedLeagues() {
    const ids = new Set(LEAGUES.filter(l => l.top).map(l => l.id));
    for (const profile of savedProfiles()) {
        leaguesFor(profile).forEach(id => ids.add(id));
        teamLeagues(profile.teams).forEach(id => ids.add(id));
    }
    return [...ids].map(id => leagueById.get(id)).filter(Boolean);
}

// ===================== Fixtures =====================

function side(competitor) {
    const team = competitor?.team || competitor?.athlete || {};
    return {
        id: team.id ? String(team.id) : null,
        abbr: team.abbreviation || '',
        name: team.displayName || team.name || '',
        short: team.shortDisplayName || team.displayName || '',
        nick: team.name || '',
        location: team.location || '',
        logo: team.logo || team.logos?.[0]?.href || team.flag?.href || null,
        score: competitor?.score ?? null
    };
}

/** ESPN scoreboard event -> stored rows (F1: one per session) */
function toRows(league, event) {
    const rows = [];
    const status = event.status?.type || {};
    const dead = /POSTPONED|CANCELED|CANCELLED|ABANDONED|SUSPENDED/.test(status.name || '');

    if (league.sport === 'motorsport') {
        for (const comp of event.competitions || []) {
            const [label, minutes] = F1_SESSIONS[comp.type?.abbreviation] || [comp.type?.abbreviation || 'Session', 90];
            const start = Date.parse(comp.date);
            const state = comp.status?.type?.state || 'pre';
            if (!start || /POSTPONED|CANCELED/.test(comp.status?.type?.name || '')) continue;
            rows.push({
                id: `${league.id}:${event.id}:${comp.id || label}`,
                start, end: start + minutes * 60000, state,
                json: { title: `${event.shortName || event.name} · ${label}`, detail: comp.status?.type?.shortDetail || '' }
            });
        }
        return rows;
    }

    const start = Date.parse(event.date);
    if (!start || dead) return rows;
    const comp = event.competitions?.[0] || {};
    // Not scheduled yet: ESPN puts a placeholder time (midnight US Eastern)
    const timeTbd = comp.timeValid === false || event.timeValid === false;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home') || competitors[0];
    const away = competitors.find(c => c.homeAway === 'away') || competitors[1];
    const twoSides = !league.keywords && home && away;
    rows.push({
        id: `${league.id}:${event.id}`,
        start,
        end: start + (DURATION_MIN[league.sport] || 120) * 60000,
        state: status.state || 'pre',
        json: {
            // US sports list the visitors first ("Buccaneers @ Cowboys")
            title: !twoSides ? (event.name || event.shortName || league.label)
                : league.sport === 'soccer' ? `${side(home).short} vs ${side(away).short}`
                : `${side(away).short} @ ${side(home).short}`,
            home: twoSides ? side(home) : null,
            away: twoSides ? side(away) : null,
            detail: status.shortDetail || '',
            note: comp.notes?.[0]?.headline || '',
            timeTbd
        }
    });
    return rows;
}

/**
 * Favourite teams from all profiles, each with the league its schedule is
 * fetched from (a domestic league rather than a cup/European list)
 */
function favouriteTeams() {
    const keys = [...new Set(savedProfiles().flatMap(p => p.teams || []))];
    if (!keys.length) return [];
    ensureTables();
    const rows = getDb().prepare(`SELECT team_key, league FROM sports_teams WHERE team_key IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(keys));
    const out = new Map();
    for (const { team_key: key, league: id } of rows) {
        const league = leagueById.get(id);
        if (!league) continue;
        const domestic = !league.regions.some(r => r === 'europe' || r === 'international');
        if (!out.has(key) || (domestic && !out.get(key).domestic)) out.set(key, { key, league, domestic });
    }
    return [...out.values()];
}

function ymd(ms) {
    return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

let refreshing = null;
async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
        ensureTables();
        const now = Date.now();
        // ESPN's day is US time: yesterday's late games can still be on
        const days = n => Array.from({ length: n + 1 }, (_, i) => ymd(now + (i - 1) * 24 * HOUR));
        const leagues = wantedLeagues();
        const followed = new Set(savedProfiles().flatMap(p => [...leaguesFor(p), ...teamLeagues(p.teams)]));
        const db = getDb();
        const upsert = db.prepare(`
            INSERT OR REPLACE INTO live_events (id, league, start_time, end_time, state, json, fetched_at)
            VALUES (@id, @league, @start, @end, @state, @json, @fetchedAt)
        `);
        let stored = 0;
        let failed = 0;
        const store = (league, rows) => db.transaction(() => rows.forEach(r => upsert.run({
            ...r, league: league.id, json: JSON.stringify(r.json), fetchedAt: Date.now()
        })))();
        // Favourite teams: their own schedule, so games after tomorrow show too
        const teams = favouriteTeams();
        await eachLimited(teams, 4, async ({ key, league }) => {
            try {
                const teamId = key.split(':')[1];
                const fixture = league.sport === 'soccer' ? '?fixture=true' : '';
                const body = await espn(`${league.path}/teams/${teamId}/schedule${fixture}`);
                for (const e of body.events || []) {
                    const t = Date.parse(e.date);
                    if (!t || t < now - 6 * HOUR || t > now + TEAM_DAYS * 24 * HOUR) continue;
                    // A cup or European game is filed under its own competition
                    const own = leagueById.get(e.league?.slug) || league;
                    const rows = toRows(own, e);
                    store(own, rows);
                    stored += rows.length;
                }
            } catch (err) {
                failed++;
                if (failed <= 3) console.warn(`[Events] Schedule for ${key} failed:`, err.message);
            }
        });

        const jobs = leagues.flatMap(league =>
            days(followed.has(league.id) ? LEAGUE_DAYS : 2).map(day => ({ league, day })));
        await eachLimited(jobs, 4, async ({ league, day }) => {
            try {
                const body = await espn(`${league.path}/scoreboard?dates=${day}&limit=300`);
                const rows = (body.events || []).flatMap(e => toRows(league, e));
                store(league, rows);
                stored += rows.length;
            } catch (err) {
                failed++;
                if (failed <= 3) console.warn(`[Events] ${league.id} ${day} failed:`, err.message);
            }
        });
        db.prepare('DELETE FROM live_events WHERE end_time < ?').run(now - 24 * HOUR);
        snapshot = null;
        console.log(`[Events] ${stored} fixtures from ${leagues.length} leagues and ${teams.length} team schedules${failed ? ` (${failed} requests failed)` : ''}`);
    })().finally(() => { refreshing = null; });
    return refreshing;
}

// ===================== Teams (quiz) =====================

const teamLoads = new Map();
function loadTeams(league) {
    ensureTables();
    const at = getDb().prepare('SELECT max(fetched_at) AS at FROM sports_teams WHERE league = ?').get(league.id)?.at || 0;
    if (Date.now() - at < TEAMS_MAX_AGE_MS) return Promise.resolve();
    if (teamLoads.has(league.id)) return teamLoads.get(league.id);

    const promise = espn(`${league.path}/teams?limit=1000`).then(body => {
        const teams = body.sports?.[0]?.leagues?.[0]?.teams || [];
        if (!teams.length) return;
        const db = getDb();
        const insert = db.prepare(`INSERT INTO sports_teams (league, team_key, name, short_name, logo, fetched_at)
                                   VALUES (?, ?, ?, ?, ?, ?)`);
        const now = Date.now();
        db.transaction(() => {
            db.prepare('DELETE FROM sports_teams WHERE league = ?').run(league.id);
            for (const { team } of teams) {
                if (!team?.id) continue;
                insert.run(league.id, teamKey(league, team.id), team.displayName || team.name,
                    team.shortDisplayName || null, team.logos?.[0]?.href || null, now);
            }
        })();
    }).catch(err => {
        console.warn(`[Events] Teams for ${league.id} failed:`, err.message);
    }).finally(() => teamLoads.delete(league.id));
    teamLoads.set(league.id, promise);
    return promise;
}

/**
 * Teams to pick from for the given sports/regions/divisions (fetched on first use).
 * Returns [{ key, name, short, logo, league }] sorted by name, one per team.
 */
async function teams({ sports = [], regions = [], divisions = [] }) {
    const leagues = [...leaguesFor({ sports, regions, divisions })]
        .map(id => leagueById.get(id))
        .filter(l => l && l.teams !== false);
    await eachLimited(leagues, 4, loadTeams);
    const rows = getDb().prepare(`
        SELECT team_key, name, short_name, logo, league FROM sports_teams
        WHERE league IN (SELECT value FROM json_each(?))
        ORDER BY name
    `).all(JSON.stringify(leagues.map(l => l.id)));
    const seen = new Map();
    for (const r of rows) {
        if (seen.has(r.team_key)) continue;
        seen.set(r.team_key, { key: r.team_key, name: r.name, short: r.short_name, logo: r.logo, league: leagueById.get(r.league)?.label || r.league });
    }
    return [...seen.values()];
}

/** Stored teams by key (profile validation and display); unknown keys are left out */
function teamsByKey(keys) {
    if (!keys?.length) return new Map();
    ensureTables();
    const rows = getDb().prepare(`
        SELECT team_key, name, short_name, logo FROM sports_teams
        WHERE team_key IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(keys));
    return new Map(rows.map(r => [r.team_key, { key: r.team_key, name: r.name, short: r.short_name, logo: r.logo }]));
}

// ===================== EPG matching =====================

/** Lower-case ASCII words, space-padded so " name " finds whole words */
function norm(text) {
    const words = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return words ? ` ${words} ` : ' ';
}

// Words that name half the clubs in a league; never enough on their own
const GENERIC = new Set(['united', 'city', 'real', 'sporting', 'athletic', 'club', 'inter', 'state', 'national',
    'university', 'college', 'saint', 'st', 'san', 'los', 'new', 'north', 'south', 'east', 'west', 'central', 'team']);
// Club-type abbreviations around football names ("RSC Anderlecht", "Club Brugge KV")
const CLUB_AFFIXES = /\b(fc|cf|sc|afc|ac|as|ss|ssc|sv|vfb|vfl|tsg|rc|rcd|cd|ud|sd|kv|krc|kaa|kas|rsc|rfc|fk|sk|bk|if|ca|club|de|1)\b/g;

// Other spellings guides use for ESPN's abbreviations ("CLE vs CWS"); only
// three-letter forms, as two letters match too much
const ABBR_ALIASES = { CHW: ['CWS'], WSH: ['WSN', 'WAS'], KC: ['KCR'], SD: ['SDP'], SF: ['SFG'], TB: ['TBR'], ARI: ['AZD'] };

/** Name variants (normalized, unpadded) that identify one side in a title */
function variants(s) {
    const out = new Set();
    // "Manchester" names City and United alike: a location is only enough when
    // the rest of the name isn't a generic word
    const name = norm(s.name).trim();
    const location = norm(s.location).trim();
    const rest = location && name.startsWith(`${location} `) ? name.slice(location.length + 1) : '';
    const ambiguous = rest && rest.split(' ').every(w => GENERIC.has(w));
    // Abbreviations ("CLE vs CWS") only count with both sides named, like everything else
    for (const raw of [s.name, s.short, s.nick, s.abbr, ambiguous ? '' : s.location]) {
        const v = norm(raw).trim();
        if ((v.length >= 4 || (raw === s.abbr && v.length === 3)) && !GENERIC.has(v)) out.add(v);
        if (raw === s.abbr) (ABBR_ALIASES[s.abbr] || []).forEach(a => out.add(a.toLowerCase()));
        const bare = v.replace(CLUB_AFFIXES, ' ').replace(/\s+/g, ' ').trim();
        if (bare.length >= 4 && !GENERIC.has(bare)) out.add(bare);
    }
    return [...out];
}

/** [start, end) of each place a variant occurs in a padded, normalized title */
function spans(title, list) {
    const out = [];
    for (const v of list) {
        const needle = ` ${v} `;
        for (let at = title.indexOf(needle); at >= 0; at = title.indexOf(needle, at + 1)) {
            out.push([at, at + needle.length - 1]);
        }
    }
    return out;
}

/** Both sides named, at different places (so "Manchester" can't count for both) */
function namesBoth(title, homeVariants, awayVariants) {
    const a = spans(title, homeVariants);
    if (!a.length) return false;
    const b = spans(title, awayVariants);
    return b.some(([bs, be]) => a.some(([as, ae]) => be <= as || ae <= bs));
}

// "Live:", "LIVE ", "Uživo:", trailing "(Direto)" / "(L)" ...
const LIVE_WORDS = 'live|en direct|en vivo|ao vivo|directo|direto|diretta|uzivo|na zywo|zivo|canli|live!';
const LIVE_PREFIX = new RegExp(`^\\s*(?:${LIVE_WORDS})\\s*(?:[:\\-–|]\\s*|\\s+(?=\\S))`, 'i');
const LIVE_SUFFIX = new RegExp(`\\s*[\\(\\[](?:${LIVE_WORDS}|l)[\\)\\]]\\s*$`, 'i');
// "Competition: A - B", "A vs. B", "A @ B", "A x B", "Steaua-Rapid"
// Spaced separators first, so "Saint-Étienne vs Paris FC" splits at "vs"
const FIXTURE = /^(?:([^:]{2,60}):\s*)?([\p{Lu}0-9][^:]{1,40}?)\s*(\s[-–]\s|\svs?\.?\s|\s@\s|\sx\s)\s*([\p{Lu}0-9][^:]{1,40}?)(?:,.*)?$/u;
const FIXTURE_TIGHT = /^(?:([^:]{2,60}):\s*)?([\p{Lu}0-9][^:]{1,40}?)((?<=\p{L})-(?=\p{Lu}))([\p{Lu}0-9][^:]{1,40}?)(?:,.*)?$/u;
// A lower-case word ("Journal avec Azeb Wolde-Giorghis"): a sentence, not a club name
const LOWER_WORD = /(?:^|\s)\p{Ll}/u;
// Lower-case words club names do have ("Atlético de Madrid", "Paris Saint-Germain")
const NAME_PARTICLES = new Set(['de', 'del', 'des', 'la', 'le', 'les', 'van', 'von', 'der', 'den', 'da', 'do', 'di', 'du', 'y', 'i', 'e', 'et', '&']);
/** "CBC Newsroom with Andrew Nichols": a lower-case word that isn't a name particle */
const sentenceLike = text => text.split(/\s+/).some(w => /^\p{Ll}/u.test(w) && !NAME_PARTICLES.has(w));

// "... Etapa 9", "... Round 4" after the second side
const ROUND_SUFFIX = /\s+(?:etapa|round|rd|week|matchday|speeldag|spieltag|jornada|giornata|kolo|runda|journee|g)\s*\d+.*$/i;

function asciiFold(text) {
    return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** { title, competition } for a live-marked fixture title, else null */
function guideFixture(title) {
    const folded = asciiFold(title);
    let rest = null;
    if (LIVE_PREFIX.test(folded)) rest = title.slice(folded.match(LIVE_PREFIX)[0].length);
    else if (LIVE_SUFFIX.test(folded)) rest = title.slice(0, folded.length - folded.match(LIVE_SUFFIX)[0].length);
    if (!rest) return null;
    const m = FIXTURE.exec(rest.trim()) || FIXTURE_TIGHT.exec(rest.trim());
    if (!m) return null;
    let [, competition = '', home, sep, away] = m;
    // "NHL - Capitals x Penguins": the part before the first separator was the competition
    const inner = !m[1] && (FIXTURE.exec(away.trim()) || FIXTURE_TIGHT.exec(away.trim()));
    if (inner && !inner[1]) [competition, home, sep, away] = [home, inner[2], inner[3], inner[4]];
    home = home.trim();
    away = away.replace(ROUND_SUFFIX, '').trim();
    // An unspaced hyphen is also a double-barrelled surname; trust it only between names
    if (sep === '-' && (LOWER_WORD.test(home) || LOWER_WORD.test(away))) return null;
    // Any separator: a sentence on either side is a show title ("... with X - Live from Toronto")
    if (sentenceLike(home) || sentenceLike(away)) return null;
    return { title: `${home} vs ${away}`, competition: competition.trim(), sides: [home, away] };
}

/** Programmes covering [from, to), sorted by start, with normalized titles */
function loadProgrammes(from, to) {
    const norms = new Map();
    return getDb().prepare(`
        SELECT channel_id, start_time, end_time, title FROM epg_programs
        WHERE end_time > ? AND start_time < ? AND title IS NOT NULL
        ORDER BY start_time
    `).all(from, to).map(p => {
        let n = norms.get(p.title);
        if (n === undefined) norms.set(p.title, n = norm(p.title));
        return { ...p, norm: n };
    });
}

/** First index with start_time >= t */
function lowerBound(programmes, t) {
    let lo = 0;
    let hi = programmes.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (programmes[mid].start_time < t) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/**
 * EPG channel id -> live playlist channels on it (enabled sources, not hidden).
 * Same rule as POST /api/live/now: tvg id, else the EPG channel's name.
 */
function channelsByEpgId(enabledSourceIds) {
    const db = getDb();
    const epgIds = new Map();
    for (const row of db.prepare(`SELECT item_id, name FROM playlist_items WHERE type = 'epg_channel'`).iterate()) {
        epgIds.set(row.item_id, row.item_id);
        if (row.name && !epgIds.has(row.name.toLowerCase())) epgIds.set(row.name.toLowerCase(), row.item_id);
    }
    const out = new Map();
    const rows = db.prepare(`
        SELECT p.source_id, p.item_id, p.name, p.stream_icon, p.stream_url, p.category_id, p.data,
               c.name AS group_name,
               COALESCE(json_extract(p.data, '$.epg_channel_id'), json_extract(p.data, '$.tvgId')) AS tvg_id
        FROM playlist_items p
        LEFT JOIN categories c ON c.id = p.source_id || ':' || p.category_id AND c.type = 'live'
        WHERE p.type = 'live'
          AND p.is_hidden = 0 AND (c.is_hidden IS NULL OR c.is_hidden = 0)
          AND p.source_id IN (SELECT value FROM json_each(?))
    `).iterate(JSON.stringify(enabledSourceIds));
    for (const row of rows) {
        const epgId = (row.tvg_id && epgIds.get(String(row.tvg_id))) || (row.name && epgIds.get(row.name.toLowerCase()));
        if (!epgId) continue;
        if (!out.has(epgId)) out.set(epgId, []);
        out.get(epgId).push(row);
    }
    return out;
}

// ===================== Snapshot =====================

let snapshot = null; // { at, sources, lastSync, events, channels }

/**
 * All current/upcoming events (next 24h) that are on at least one channel.
 * Each: { id, league, sport, title, competition, start, end, state, detail,
 *         home, away, guideOnly, epgIds[], programme }
 */
function buildSnapshot(enabledSourceIds) {
    ensureTables();
    const now = Date.now();
    const horizon = now + 24 * HOUR;
    const programmes = loadProgrammes(now - 6 * HOUR, horizon + 3 * HOUR);
    const channels = channelsByEpgId(enabledSourceIds);
    const onChannels = list => [...new Set(list.map(p => p.channel_id))].filter(id => channels.has(id));

    const stored = getDb().prepare(`
        SELECT * FROM live_events WHERE end_time > ? AND start_time < ? ORDER BY start_time
    `).all(now - 2 * HOUR, now + TEAM_DAYS * 24 * HOUR);

    const events = [];
    const claimed = new Set(); // programmes already used by an ESPN event
    for (const row of stored) {
        const league = leagueById.get(row.league);
        if (!league) continue;
        const data = JSON.parse(row.json);
        // ESPN said it's over, or it ran past its estimated end without a newer "in"
        const staleIn = row.state === 'in' && now - row.fetched_at > 45 * 60000 && now > row.end_time;
        if (row.state === 'post' || staleIn || (row.state === 'pre' && now > row.end_time)) continue;

        // Programmes on air at kick-off that began at most 2h before it
        const t = row.start_time;
        const hits = [];
        const homeV = data.home ? variants(data.home) : null;
        const awayV = data.away ? variants(data.away) : null;
        const keywords = (league.keywords || []).map(k => norm(k));
        // A placeholder time says nothing about when it airs
        for (let i = data.timeTbd ? programmes.length : lowerBound(programmes, t - 2 * HOUR); i < programmes.length; i++) {
            const p = programmes[i];
            if (p.start_time > t + 30 * 60000) break;
            if (p.end_time <= t + 15 * 60000) continue;
            const match = homeV
                ? namesBoth(p.norm, homeV, awayV)
                : keywords.some(k => p.norm.includes(k)) && p.start_time >= t - 45 * 60000;
            if (match) hits.push(p);
        }
        // Kept without channels too: a followed team's game shows before the guide lists it
        const epgIds = onChannels(hits);
        hits.forEach(p => claimed.add(p));
        events.push({
            id: row.id,
            league: league.id,
            sport: league.sport,
            competition: league.label,
            title: data.title,
            start: row.start_time,
            end: row.end_time,
            state: row.state,
            detail: data.detail,
            home: data.home,
            away: data.away,
            note: data.note || '',
            timeTbd: !!data.timeTbd,
            guideOnly: false,
            epgIds,
            programme: hits[0]?.title || ''
        });
    }

    // Guide-only: live-marked fixtures not already covered. Channels spell the
    // same game differently ("Fenerbaçe Istanbul" / "Fenerbahce") and start it
    // a few minutes apart, so group by each side's first 5 letters within 45 min.
    const groups = new Map(); // sides key -> [group]
    for (let i = lowerBound(programmes, now - 3 * HOUR); i < programmes.length; i++) {
        const p = programmes[i];
        if (p.start_time > horizon) break;
        if (p.end_time <= now || claimed.has(p) || !channels.has(p.channel_id)) continue;
        const fixture = guideFixture(p.title);
        if (!fixture) continue;
        const sides = fixture.sides.map(s => norm(s).trim().replace(CLUB_AFFIXES, ' ').trim().slice(0, 5)).join('|');
        if (!groups.has(sides)) groups.set(sides, []);
        let g = groups.get(sides).find(g => Math.abs(g.start - p.start_time) <= 45 * 60000);
        if (!g) groups.get(sides).push(g = { key: `${sides}|${p.start_time}`, fixture, start: p.start_time, end: p.end_time, programmes: [] });
        g.programmes.push(p);
    }
    for (const g of [...groups.values()].flat()) {
        const key = g.key;
        events.push({
            id: `guide:${key}`,
            league: null,
            sport: null,
            competition: g.fixture.competition,
            title: g.fixture.title,
            start: g.start,
            end: g.end,
            state: g.start <= now ? 'in' : 'pre',
            detail: '',
            home: null,
            away: null,
            guideOnly: true,
            epgIds: onChannels(g.programmes),
            programme: g.programmes[0].title
        });
    }
    return { events, channels };
}

/**
 * Source syncs as { syncing, lastSync }. A sync deletes a source's channels
 * and EPG programmes and re-imports them, so matching meanwhile finds little.
 */
function syncState() {
    try {
        const rows = getDb().prepare('SELECT status, last_sync FROM sync_status').all();
        return { syncing: rows.some(r => r.status === 'syncing'), lastSync: Math.max(0, ...rows.map(r => r.last_sync)) };
    } catch {
        return { syncing: false, lastSync: 0 }; // no sync has run yet
    }
}

function getSnapshot(enabledSourceIds) {
    const sync = syncState();
    const sources = JSON.stringify(enabledSourceIds);
    // Mid-sync: keep the last good snapshot rather than one built from a half-imported EPG
    if (snapshot && sync.syncing && snapshot.sources === sources) return snapshot;
    if (!snapshot || snapshot.sources !== sources || snapshot.lastSync !== sync.lastSync
        || Date.now() - snapshot.at > SNAPSHOT_MAX_AGE_MS) {
        const started = Date.now();
        const built = { at: Date.now(), sources, lastSync: sync.lastSync, ...buildSnapshot(enabledSourceIds) };
        console.log(`[Events] Matched ${built.events.length} events to channels in ${Date.now() - started}ms${sync.syncing ? ' (sync running, not cached)' : ''}`);
        if (sync.syncing) return built;
        snapshot = built;
    }
    return snapshot;
}

// ===================== Per user =====================

/**
 * Events for one user. Tiers, in order: their teams' games (next TEAM_DAYS
 * days), games in their leagues/sports (next LEAGUE_DAYS days), then
 * everything else on now or in the next 24h. Followed tiers run in date
 * order, so what's next comes first; the rest leads with what's live and
 * relevant. With `mine` (Home), a user who picked sports or teams only gets
 * their tiers. Followed games without channels are kept (`channelRows` empty,
 * not in the guide yet); other events need a channel.
 * Channel rows are raw playlist rows (routes/live.js shapes them), the
 * Language Priority copies first; the hard filter drops other languages.
 */
function forUser(profile, { sourceIds, lang = '', hard = false, limit = 30, mine = false }) {
    const { events, channels } = getSnapshot(sourceIds);
    const now = Date.now();
    const myLeagues = leaguesFor(profile);
    teamLeagues(profile?.teams).forEach(id => myLeagues.add(id));
    const mySports = new Set(profile?.sports || []);
    const teamKeys = new Set(profile?.teams || []);
    const focused = mySports.size > 0 || teamKeys.size > 0;
    const myTeams = [...teamsByKey(profile?.teams).values()];
    const teamVariants = myTeams.map(t => variants({ name: t.name, short: t.short }));
    const isTeam = (s, league) => s?.id && teamKeys.has(teamKey(leagueById.get(league) || {}, s.id));

    const picked = [];
    for (const e of events) {
        const seen = new Set();
        let rows = e.epgIds.flatMap(id => channels.get(id) || []).filter(r => {
            const key = `${r.source_id}:${r.item_id}`;
            return !seen.has(key) && seen.add(key);
        });
        if (hard) rows = rows.filter(r => languages.visible(r.name, r.group_name, lang));
        if (lang) {
            rows = [...rows.filter(r => languages.matches(r.name, r.group_name, lang)),
                ...rows.filter(r => !languages.matches(r.name, r.group_name, lang))];
        }

        const favourite = e.guideOnly
            ? teamVariants.some(v => spans(norm(e.title), v).length > 0)
            : [e.home, e.away].some(s => isTeam(s, e.league));
        // The leagues the picks resolve to (sport, level, region), not the whole sport:
        // "Professional" football must not pull in college games
        const followed = !e.guideOnly && myLeagues.has(e.league);
        const tier = favourite ? 0 : followed ? 1 : 2;
        if (mine && focused && tier === 2) continue;

        const ahead = e.start - now;
        if (ahead > (tier === 0 ? TEAM_DAYS : tier === 1 ? LEAGUE_DAYS : 1) * 24 * HOUR) continue;
        // Unfollowed events need a channel to be worth a slot; guide-only ones two
        if (tier === 2 && rows.length < (e.guideOnly ? 2 : 1)) continue;
        if (tier === 2 && !e.guideOnly && !leagueById.get(e.league).top) continue;

        const live = e.state === 'in' || (!e.timeTbd && e.start <= now && now < e.end);
        const score = e.guideOnly ? 2 + Math.min(rows.length, 8)
            : leagueById.get(e.league).weight + Math.min(rows.length, 8) / 2;
        picked.push({ e, rows, favourite, live, tier, score });
    }

    picked.sort((a, b) => (a.tier - b.tier)
        || (a.tier < 2 ? a.e.start - b.e.start : (b.live - a.live) || (b.score - a.score) || (a.e.start - b.e.start)));
    return picked.slice(0, limit).map(({ e, rows, favourite, live, tier }) => ({
        id: e.id,
        title: e.title,
        competition: e.competition,
        sport: e.sport,
        start: new Date(e.start).toISOString(),
        end: new Date(e.end).toISOString(),
        timeTbd: !!e.timeTbd,
        live,
        favourite,
        followed: tier < 2,
        note: e.note || '',
        detail: e.detail,
        home: e.home && { name: e.home.name, short: e.home.short, logo: e.home.logo },
        away: e.away && { name: e.away.name, short: e.away.short, logo: e.away.logo },
        programme: e.programme,
        channelRows: rows
    }));
}

// ===================== Lifecycle =====================

function start() {
    ensureTables();
    refresh().catch(err => console.warn('[Events] Refresh failed:', err.message));
    setInterval(() => refresh().catch(err => console.warn('[Events] Refresh failed:', err.message)), REFRESH_EVERY_MS).unref();
}

/** A profile's sports changed: fetch its leagues now rather than at the next refresh */
function profileChanged() {
    refresh().catch(err => console.warn('[Events] Refresh failed:', err.message));
}

module.exports = {
    LEAGUES, start, refresh, profileChanged, teams, teamsByKey, forUser,
    // for tests
    _internal: { norm, variants, namesBoth, guideFixture, leaguesFor }
};
