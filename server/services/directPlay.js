/**
 * Direct playback on a user's own provider login (TODO #10).
 *
 * A user can add their own Xtream login (Profile > Your provider). Titles and
 * channels from the shared catalogue then play straight from that provider in
 * the browser (provider -> client); the server leaves the data path. The
 * browser reads the provider's lists itself and reports back only what the
 * server needs to match them to the shared catalogue:
 *
 *   user_providers  one row per login: server URL in the clear, login sealed
 *                   by providerVault (per-record salt + IV, bound to the user)
 *   user_links      the provider's catalogue: (provider, kind, item id) ->
 *                   name, category, container, TMDB id, guide id; movies and
 *                   series matched to a media row (TMDB id, else cleaned name +
 *                   year against TMDB-backed titles)
 *   user_episodes   episode lists (get_series_info), filled when a series is
 *                   first played
 *   user_probes     what the player saw on a direct play: ok / failed, size,
 *                   duration, error - a failed direct play isn't tried again
 *
 * Everything a client sends is untrusted: schema-checked, size-capped and
 * written only under that user's own provider rows. It never touches the
 * shared catalogue, tmdb_meta, the EPG or anyone else's rows, and the server
 * never fetches a URL a client sent (it only builds URLs from the stored
 * provider, whose host must pass urlGuard).
 *
 * Fallback when direct play isn't possible (http provider on the https page,
 * no CORS for HLS, MKV / codecs the browser can't play): the user-provider
 * reference /api/stream/u/<provider>/<type>/<id>.<ext> (services/streamRef.js),
 * which goes through the server's normal probe/remux/transcode path - still on
 * the user's own login.
 *
 * Same provider as an admin source (same host): stream ids are the same on
 * one panel, so shared ids play on the user's login without any catalogue.
 *
 * Kids accounts can't add a provider (it would bypass their channel whitelist).
 */
const { getDb } = require('../db/sqlite');
const vault = require('./providerVault');
const media = require('./media');

const KINDS = ['live', 'movie', 'series'];
const MAX_PROVIDERS = 3;
const MAX_LINKS_PER_KIND = 300000;
const MAX_CHUNK = 5000;
const MAX_EPISODES = 3000;
const YEAR_SLACK = 1;

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const EXT = /^[A-Za-z0-9]{1,5}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

let tablesReady = false;
function ensureTables() {
    if (tablesReady) return;
    media.ensureTables();
    getDb().exec(`
        CREATE TABLE IF NOT EXISTS user_providers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            server_url TEXT NOT NULL,
            secret TEXT NOT NULL,             -- providerVault.seal({ username, password })
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            synced_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_user_providers_user ON user_providers(user_id);
        CREATE TABLE IF NOT EXISTS user_links (
            provider_id INTEGER NOT NULL,
            kind TEXT NOT NULL,               -- 'live' | 'movie' | 'series'
            item_id TEXT NOT NULL,            -- stream_id (live/movie) or series_id
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            norm TEXT,                        -- media.cleanName(name)
            category TEXT,
            container TEXT,
            tmdb_id TEXT,
            tvg_id TEXT,
            year INTEGER,
            media_id INTEGER,                 -- movies/series: the shared title
            match TEXT,                       -- 'tmdb' | 'name_year' | NULL
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (provider_id, kind, item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_links_media ON user_links(user_id, kind, media_id);
        CREATE INDEX IF NOT EXISTS idx_user_links_tvg ON user_links(provider_id, kind, tvg_id);
        CREATE INDEX IF NOT EXISTS idx_user_links_norm ON user_links(provider_id, kind, norm);
        CREATE TABLE IF NOT EXISTS user_episodes (
            provider_id INTEGER NOT NULL,
            series_id TEXT NOT NULL,          -- user_links.item_id (kind 'series')
            season INTEGER NOT NULL,
            episode INTEGER NOT NULL,
            stream_id TEXT NOT NULL,
            container TEXT,
            title TEXT,
            user_id INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (provider_id, series_id, season, episode)
        );
        CREATE TABLE IF NOT EXISTS user_probes (
            provider_id INTEGER NOT NULL,
            kind TEXT NOT NULL,               -- 'live' | 'movie' | 'series' (episode streams)
            item_id TEXT NOT NULL,            -- the stream id that was played
            user_id INTEGER NOT NULL,
            ok INTEGER NOT NULL,
            info TEXT,                        -- JSON: width, height, duration, container, error
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (provider_id, kind, item_id)
        );
    `);
    tablesReady = true;
}

// ===================== Providers =====================

/** A provider server URL: http(s), no login or query in it, trailing slash dropped */
function cleanServerUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw fail(400, 'Enter the provider address, e.g. http://example.com:8080'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail(400, 'The provider address must start with http:// or https://');
    if (url.username || url.password || url.search || url.hash) throw fail(400, 'Enter only the provider address - the login goes in its own fields');
    return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/player_api\.php$/, '');
}

function cleanText(value, max, label) {
    const text = String(value ?? '').trim();
    if (!text) throw fail(400, `${label} is required`);
    if (text.length > max || /[\u0000-\u001f]/.test(text)) throw fail(400, `${label} is not valid`);
    return text;
}

/** What the browser may see of a provider: never the login */
function publicRow(row) {
    const db = getDb();
    const counts = Object.fromEntries(KINDS.map(k => [k, { total: 0, matched: 0 }]));
    for (const c of db.prepare(`SELECT kind, COUNT(*) AS total, COUNT(media_id) AS matched FROM user_links WHERE provider_id = ? GROUP BY kind`).all(row.id)) {
        counts[c.kind] = { total: c.total, matched: c.kind === 'live' ? c.total : c.matched };
    }
    return { id: row.id, name: row.name, url: row.server_url, createdAt: row.created_at, syncedAt: row.synced_at, counts };
}

function listProviders(userId) {
    ensureTables();
    return getDb().prepare('SELECT * FROM user_providers WHERE user_id = ? ORDER BY id').all(userId).map(publicRow);
}

/** The user's provider row, or throws 404 (also for someone else's) */
function ownProvider(userId, providerId) {
    ensureTables();
    const row = getDb().prepare('SELECT * FROM user_providers WHERE id = ? AND user_id = ?').get(parseInt(providerId, 10) || 0, userId);
    if (!row) throw fail(404, 'Provider not found');
    return row;
}

/** { url, username, password } of the user's provider (throws 404/409) */
function connection(userId, providerId) {
    const row = ownProvider(userId, providerId);
    const login = vault.open(row.secret, userId);
    if (!login) throw fail(409, 'This login can no longer be read - enter the password again');
    return { url: row.server_url, username: login.username, password: login.password };
}

/**
 * May this user browse and play the server's own sources? Admin logins may,
 * with every profile on them (services/profiles.js), and kids logins made in
 * Settings (they can't add a provider). Everyone else only once their login
 * has a provider - providers belong to the login, not the profile.
 */
function mayUseServerSources(user) {
    if (!user) return false;
    if (user.role === 'admin' || user.accountRole === 'admin') return true;
    if (user.kids && !user.parentId) return true;
    ensureTables();
    return !!getDb().prepare('SELECT 1 FROM user_providers WHERE user_id = ? LIMIT 1').get(user.accountId ?? user.id);
}

function assertNotKids(user) {
    if (user.kids) throw fail(403, 'Kids profiles cannot add a provider');
}

function createProvider(user, body) {
    ensureTables();
    assertNotKids(user);
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) AS n FROM user_providers WHERE user_id = ?').get(user.id).n;
    if (count >= MAX_PROVIDERS) throw fail(400, `At most ${MAX_PROVIDERS} providers per account`);
    const url = cleanServerUrl(body?.url);
    const name = String(body?.name ?? '').trim().slice(0, 60) || new URL(url).hostname;
    const login = { username: cleanText(body?.username, 200, 'Username'), password: cleanText(body?.password, 200, 'Password') };
    const now = Date.now();
    const { lastInsertRowid } = db.prepare(`INSERT INTO user_providers (user_id, name, server_url, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(user.id, name, url, vault.seal(login, user.id), now, now);
    return publicRow(ownProvider(user.id, lastInsertRowid));
}

/** Change name / address / login. A blank password keeps the stored one. */
function updateProvider(user, providerId, body) {
    assertNotKids(user);
    const row = ownProvider(user.id, providerId);
    const url = body?.url !== undefined ? cleanServerUrl(body.url) : row.server_url;
    const name = body?.name !== undefined ? (String(body.name).trim().slice(0, 60) || new URL(url).hostname) : row.name;
    let secret = row.secret;
    if (body?.username !== undefined || body?.password) {
        const old = vault.open(row.secret, user.id) || {};
        const login = {
            username: body.username !== undefined ? cleanText(body.username, 200, 'Username') : old.username,
            password: body.password ? cleanText(body.password, 200, 'Password') : old.password
        };
        if (!login.username || !login.password) throw fail(400, 'Enter the username and password again');
        secret = vault.seal(login, user.id);
    }
    const db = getDb();
    db.transaction(() => {
        db.prepare('UPDATE user_providers SET name = ?, server_url = ?, secret = ?, updated_at = ? WHERE id = ?')
            .run(name, url, secret, Date.now(), row.id);
        // Another server is another catalogue
        if (url !== row.server_url) clearCatalogue(row.id);
    })();
    return publicRow(ownProvider(user.id, row.id));
}

function clearCatalogue(providerId) {
    const db = getDb();
    for (const table of ['user_links', 'user_episodes', 'user_probes']) {
        db.prepare(`DELETE FROM ${table} WHERE provider_id = ?`).run(providerId);
    }
    db.prepare('UPDATE user_providers SET synced_at = NULL WHERE id = ?').run(providerId);
}

function deleteProvider(userId, providerId) {
    const row = ownProvider(userId, providerId);
    const db = getDb();
    db.transaction(() => {
        clearCatalogue(row.id);
        db.prepare('DELETE FROM user_providers WHERE id = ?').run(row.id);
    })();
}

/** Delete all of a user's provider data (the user was deleted) */
function deleteForUser(userId) {
    ensureTables();
    for (const row of getDb().prepare('SELECT id FROM user_providers WHERE user_id = ?').all(userId)) {
        deleteProvider(userId, row.id);
    }
}

// ===================== Reports from the client =====================

const str = (value, max) => {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/[\u0000-\u001f]/g, ' ').trim();
    return text ? text.slice(0, max) : null;
};
const year = value => {
    const m = /\b(19\d{2}|20\d{2})\b/.exec(String(value ?? ''));
    return m ? parseInt(m[1], 10) : null;
};
const tmdb = value => /^\d{1,10}$/.test(String(value ?? '').trim()) && String(value).trim() !== '0' ? String(value).trim() : null;

/** One catalogue entry as the client sends it -> a clean row, or null */
function cleanItem(kind, item) {
    if (!item || typeof item !== 'object') return null;
    const id = String(item.id ?? '');
    const name = str(item.name, 300);
    if (!ID.test(id) || !name) return null;
    const container = EXT.test(String(item.container ?? '')) ? String(item.container).toLowerCase() : null;
    return {
        id, name,
        norm: media.cleanName(name) || null,
        category: str(item.category, 200),
        container: kind === 'movie' ? container : null,
        tmdb: kind === 'live' ? null : tmdb(item.tmdb),
        tvg: kind === 'live' ? str(item.tvg, 200) : null,
        year: kind === 'live' ? null : (year(item.year) ?? media.nameYear(name))
    };
}

/**
 * Match movie/series rows to a media row: the provider's TMDB id, else the
 * cleaned name + year against TMDB-backed titles (only when exactly one fits).
 */
function matchRows(rows, kind) {
    const db = getDb();
    const kinds = kind === 'series' ? ['tv'] : ['movie', 'tv']; // providers file some series as VOD
    const byTmdb = db.prepare('SELECT media_id FROM media WHERE kind = ? AND tmdb_id = ?');
    const byName = db.prepare('SELECT media_id, year FROM media WHERE kind = ? AND norm = ? AND tmdb_id IS NOT NULL');
    for (const row of rows) {
        row.media_id = null;
        row.match = null;
        if (row.tmdb) {
            for (const k of kinds) {
                const hit = byTmdb.get(k, row.tmdb);
                if (hit) { row.media_id = hit.media_id; row.match = 'tmdb'; break; }
            }
        }
        if (!row.media_id && row.norm && row.year) {
            for (const k of kinds) {
                const hits = byName.all(k, row.norm).filter(m => m.year && Math.abs(m.year - row.year) <= YEAR_SLACK);
                if (hits.length === 1) { row.media_id = hits[0].media_id; row.match = 'name_year'; break; }
            }
        }
    }
}

/**
 * Store one chunk of the provider's catalogue for a kind.
 * reset: first chunk of a full sync (drops that kind's old rows); done: last
 * chunk (marks the provider synced). Returns { stored, matched, skipped }.
 */
function storeCatalogue(userId, providerId, { kind, items, reset, done } = {}) {
    const provider = ownProvider(userId, providerId);
    if (!KINDS.includes(kind)) throw fail(400, 'kind must be live, movie or series');
    if (!Array.isArray(items) || items.length > MAX_CHUNK) throw fail(400, `items must be a list of at most ${MAX_CHUNK}`);
    const db = getDb();

    const rows = items.map(item => cleanItem(kind, item)).filter(Boolean);
    if (kind !== 'live') matchRows(rows, kind);

    const insert = db.prepare(`
        INSERT OR REPLACE INTO user_links (provider_id, kind, item_id, user_id, name, norm, category, container, tmdb_id, tvg_id, year, media_id, match, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = Date.now();
    db.transaction(() => {
        if (reset) db.prepare('DELETE FROM user_links WHERE provider_id = ? AND kind = ?').run(provider.id, kind);
        const have = db.prepare('SELECT COUNT(*) AS n FROM user_links WHERE provider_id = ? AND kind = ?').get(provider.id, kind).n;
        if (have + rows.length > MAX_LINKS_PER_KIND) throw fail(413, `More than ${MAX_LINKS_PER_KIND} ${kind} entries`);
        for (const r of rows) {
            insert.run(provider.id, kind, r.id, userId, r.name, r.norm, r.category, r.container, r.tmdb, r.tvg, r.year, r.media_id ?? null, r.match ?? null, now);
        }
        if (done) db.prepare('UPDATE user_providers SET synced_at = ? WHERE id = ?').run(now, provider.id);
    })();
    return { stored: rows.length, matched: rows.filter(r => r.media_id).length, skipped: items.length - rows.length };
}

/** Store a series' episode list (from get_series_info). Returns { stored } */
function storeEpisodes(userId, providerId, { seriesId, episodes } = {}) {
    const provider = ownProvider(userId, providerId);
    if (!ID.test(String(seriesId ?? ''))) throw fail(400, 'Invalid seriesId');
    if (!Array.isArray(episodes) || episodes.length > MAX_EPISODES) throw fail(400, `episodes must be a list of at most ${MAX_EPISODES}`);
    const db = getDb();
    const rows = episodes.map(e => {
        const season = parseInt(e?.season, 10);
        const episode = parseInt(e?.episode, 10);
        const id = String(e?.id ?? '');
        if (!ID.test(id) || !(season >= 0 && season < 1000) || !(episode >= 0 && episode < 10000)) return null;
        return { id, season, episode, container: EXT.test(String(e.container ?? '')) ? String(e.container).toLowerCase() : null, title: str(e.title, 300) };
    }).filter(Boolean);
    const insert = db.prepare(`
        INSERT OR REPLACE INTO user_episodes (provider_id, series_id, season, episode, stream_id, container, title, user_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = Date.now();
    db.transaction(() => {
        db.prepare('DELETE FROM user_episodes WHERE provider_id = ? AND series_id = ?').run(provider.id, String(seriesId));
        for (const r of rows) insert.run(provider.id, String(seriesId), r.season, r.episode, r.id, r.container, r.title, userId, now);
    })();
    return { stored: rows.length };
}

/** What the player saw on a direct play */
function storeProbe(userId, providerId, { kind, itemId, ok, info } = {}) {
    const provider = ownProvider(userId, providerId);
    if (!KINDS.includes(kind) || !ID.test(String(itemId ?? ''))) throw fail(400, 'Invalid probe');
    const num = (v, max) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max) ? Math.round(Number(v)) : null;
    const clean = {
        width: num(info?.width, 16384),
        height: num(info?.height, 16384),
        duration: num(info?.duration, 7 * 24 * 3600),
        container: EXT.test(String(info?.container ?? '')) ? String(info.container).toLowerCase() : null,
        mode: ['file', 'hls', 'native'].includes(info?.mode) ? info.mode : null,
        error: str(info?.error, 200)
    };
    getDb().prepare(`
        INSERT OR REPLACE INTO user_probes (provider_id, kind, item_id, user_id, ok, info, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(provider.id, kind, String(itemId), userId, ok ? 1 : 0, JSON.stringify(clean), Date.now());
}

// ===================== Resolve: shared copy -> the user's own stream =====================

/** Admin sources by host, for the same-panel shortcut */
async function sourceHosts() {
    const { sources } = require('../db');
    const map = new Map();
    for (const s of await sources.getAll()) {
        if (s.type !== 'xtream') continue;
        try { map.set(String(s.id), new URL(s.url).host.toLowerCase()); } catch { /* skip */ }
    }
    return map;
}

function streamUrl(conn, type, streamId, ext) {
    // Same shape as streamRef / xtreamApi.buildStreamUrl
    return `${conn.url}/${type}/${conn.username}/${conn.password}/${streamId}.${ext}`;
}

/**
 * The user's own stream for a shared copy, or null.
 *   q.type: 'movie' | 'episode' | 'live'
 *   q.sourceId + q.itemId (movie: vod id, live: stream id, episode: episode id)
 *   episodes also: q.seriesId, q.season, q.episode
 * Returns
 *   { url, ref, providerId, type, streamId, container, match, probe }   play this
 *   { needsEpisodes: { providerId, seriesId } }                          report the episode list, then ask again
 */
async function resolve(user, q) {
    ensureTables();
    // The login's providers, for every profile on it
    const accountId = user.accountId ?? user.id;
    const db = getDb();
    const providers = db.prepare('SELECT * FROM user_providers WHERE user_id = ? ORDER BY id').all(accountId);
    if (!providers.length) return null;

    const sourceId = parseInt(q.sourceId, 10);
    const itemId = String(q.itemId ?? '');
    if (!sourceId || !ID.test(itemId)) throw fail(400, 'Invalid item');
    // Kids profiles: only the channels a parent whitelisted (services/maturity.js)
    const kidsChannels = require('./maturity').allowedChannels(user);
    if (q.type === 'live' && kidsChannels && !kidsChannels.has(`${sourceId}:${itemId}`)) return null;
    const hosts = await sourceHosts();
    const samePanel = p => { try { return hosts.get(String(sourceId)) === new URL(p.server_url).host.toLowerCase(); } catch { return false; } };

    let hit = null; // { provider, type, streamId, container, match }

    if (q.type === 'movie') {
        const mediaId = media.titleOf(sourceId, 'movie', itemId);
        for (const p of providers) {
            const link = mediaId && db.prepare(`SELECT item_id, container, match FROM user_links WHERE provider_id = ? AND kind = 'movie' AND media_id = ?
                ORDER BY match = 'tmdb' DESC LIMIT 1`).get(p.id, mediaId);
            if (link) { hit = { provider: p, type: 'movie', streamId: link.item_id, container: link.container, match: link.match }; break; }
            if (samePanel(p)) { hit = { provider: p, type: 'movie', streamId: itemId, container: null, match: 'same_panel' }; break; }
        }
        if (hit && !hit.container) {
            const row = db.prepare(`SELECT container_extension FROM playlist_items WHERE source_id = ? AND item_id = ? AND type = 'movie'`).get(sourceId, itemId);
            hit.container = row?.container_extension || 'mp4';
        }
    } else if (q.type === 'episode') {
        const seriesId = String(q.seriesId ?? '');
        const season = parseInt(q.season, 10);
        const episode = parseInt(q.episode, 10);
        if (!ID.test(seriesId) || !(season >= 0) || !(episode >= 0)) throw fail(400, 'Invalid episode');
        const mediaId = media.titleOf(sourceId, 'series', seriesId);
        for (const p of providers) {
            const link = mediaId && db.prepare(`SELECT item_id, match FROM user_links WHERE provider_id = ? AND kind = 'series' AND media_id = ?
                ORDER BY match = 'tmdb' DESC LIMIT 1`).get(p.id, mediaId);
            if (link) {
                const ep = db.prepare('SELECT stream_id, container FROM user_episodes WHERE provider_id = ? AND series_id = ? AND season = ? AND episode = ?')
                    .get(p.id, link.item_id, season, episode);
                if (ep) { hit = { provider: p, type: 'series', streamId: ep.stream_id, container: ep.container || 'mp4', match: link.match }; break; }
                const known = db.prepare('SELECT 1 FROM user_episodes WHERE provider_id = ? AND series_id = ? LIMIT 1').get(p.id, link.item_id);
                if (!known) return { needsEpisodes: { providerId: p.id, seriesId: link.item_id } };
                continue; // their copy lacks this episode
            }
            if (samePanel(p)) { hit = { provider: p, type: 'series', streamId: itemId, container: q.container, match: 'same_panel' }; break; }
        }
        if (hit && !EXT.test(String(hit.container || ''))) hit.container = 'mp4';
    } else if (q.type === 'live') {
        const row = db.prepare(`SELECT name, data FROM playlist_items WHERE source_id = ? AND item_id = ? AND type = 'live'`).get(sourceId, itemId);
        if (!row) return null;
        const tvg = (() => { try { return JSON.parse(row.data || '{}').epg_channel_id || null; } catch { return null; } })();
        const norm = media.cleanName(row.name);
        for (const p of providers) {
            let link = null;
            if (tvg) {
                // Same guide id, and the same name when several channels share it
                const byTvg = db.prepare(`SELECT item_id, norm FROM user_links WHERE provider_id = ? AND kind = 'live' AND tvg_id = ?`).all(p.id, tvg);
                link = byTvg.find(l => l.norm === norm) || (byTvg.length === 1 ? byTvg[0] : null);
                if (link) link.match = 'tvg_id';
            }
            if (!link && norm) {
                const byName = db.prepare(`SELECT item_id FROM user_links WHERE provider_id = ? AND kind = 'live' AND norm = ? LIMIT 2`).all(p.id, norm);
                if (byName.length === 1) link = { ...byName[0], match: 'name' };
            }
            if (link) { hit = { provider: p, type: 'live', streamId: link.item_id, container: 'm3u8', match: link.match }; break; }
            if (samePanel(p)) { hit = { provider: p, type: 'live', streamId: itemId, container: 'm3u8', match: 'same_panel' }; break; }
        }
    } else {
        throw fail(400, 'type must be movie, episode or live');
    }

    if (!hit) return null;
    const login = vault.open(hit.provider.secret, accountId);
    if (!login) return null;
    const conn = { url: hit.provider.server_url, ...login };
    const probe = db.prepare('SELECT ok, info, updated_at FROM user_probes WHERE provider_id = ? AND kind = ? AND item_id = ?')
        .get(hit.provider.id, hit.type, hit.streamId);
    return {
        url: streamUrl(conn, hit.type, hit.streamId, hit.container),
        ref: `/api/stream/u/${hit.provider.id}/${hit.type}/${hit.streamId}.${hit.container}`,
        providerId: hit.provider.id,
        type: hit.type,
        streamId: hit.streamId,
        container: hit.container,
        match: hit.match,
        probe: probe ? { ok: !!probe.ok, at: probe.updated_at, ...JSON.parse(probe.info || '{}') } : null
    };
}

/**
 * Kids profiles play only whitelisted channels: is this provider stream one of
 * them? (u references name the provider's own stream id, not the shared one)
 */
async function kidsLiveAllowed(user, providerId, streamId) {
    const allowed = require('./maturity').allowedChannels(user);
    if (!allowed) return true;
    for (const key of allowed) {
        const [sourceId, ...rest] = key.split(':');
        const hit = await resolve(user, { type: 'live', sourceId, itemId: rest.join(':') }).catch(() => null);
        if (hit?.providerId === parseInt(providerId, 10) && String(hit.streamId) === String(streamId)) return true;
    }
    return false;
}

/** Upstream URL for a user-provider reference (streamRef), or throws 404 */
function refUrl(userId, providerId, type, streamId, ext) {
    const conn = connection(userId, providerId);
    return { url: streamUrl(conn, type, streamId, ext), host: conn.url };
}

module.exports = {
    ensureTables, listProviders, createProvider, updateProvider, deleteProvider, deleteForUser, connection,
    storeCatalogue, storeEpisodes, storeProbe, resolve, refUrl, mayUseServerSources, kidsLiveAllowed, MAX_CHUNK
};
