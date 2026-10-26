/**
 * Direct playback on the user's own provider login (server: services/directPlay.js).
 *
 * The stream goes provider -> this browser; the server only tells us which of
 * the user's streams matches the title or channel being opened (GET
 * /api/direct/resolve) and gets back what it needs for that matching: the
 * provider's catalogue (Profile > Your provider > Sync), a series' episode
 * list the first time it is played, and what the player saw (probe).
 *
 * Direct play is only tried when this browser can actually do it: no http
 * stream on the https page (mixed content), a container <video> plays (mp4,
 * webm...) or HLS, and no earlier failed attempt on that stream. Otherwise -
 * and when a direct attempt fails - the players use `direct.ref`, the same
 * stream through the server on the user's own login.
 *
 * The login lives only in memory here (fetched per use, never stored).
 */
const DirectPlay = {
    FILE_CONTAINERS: ['mp4', 'm4v', 'mov', 'webm'],
    PROBE_RETRY_MS: 7 * 24 * 3600 * 1000, // a failed stream is tried directly again after a week
    CHUNK: 5000,

    hasProviders: null, // null = not checked yet

    async providers() {
        const list = await API.request('GET', '/direct/providers');
        this.hasProviders = list.length > 0;
        return list;
    },

    async connection(providerId) {
        return API.request('GET', `/direct/providers/${providerId}/connection`);
    },

    /** Read one player_api.php action straight from the provider */
    async providerApi(conn, action, extra = {}) {
        if (API.isMixedContent(conn.url)) {
            throw new Error('Your provider uses http://, which this https page cannot read. Open Fleurbox over http on the LAN to sync.');
        }
        const params = new URLSearchParams({ username: conn.username, password: conn.password, action, ...extra });
        let res;
        try {
            res = await fetch(`${conn.url}/player_api.php?${params}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        } catch {
            throw new Error('The browser could not read your provider (offline, or it does not allow other sites to read it - CORS).');
        }
        if (!res.ok) throw new Error(`Your provider answered ${res.status}`);
        return res.json();
    },

    /**
     * The user's own stream for what is being opened, or null.
     * q: { type: 'movie'|'episode'|'live', sourceId, itemId, seriesId?, season?, episode?, container? }
     */
    async resolve(q) {
        if (this.hasProviders === false) return null;
        try {
            const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== ''));
            let { direct } = await API.request('GET', `/direct/resolve?${params}`);
            if (direct?.needsEpisodes) {
                // First play of this series on the user's provider: read and report its episodes
                await this.reportEpisodes(direct.needsEpisodes.providerId, direct.needsEpisodes.seriesId);
                ({ direct } = await API.request('GET', `/direct/resolve?${params}`));
                if (direct?.needsEpisodes) return null;
            }
            if (direct === null && this.hasProviders === null) {
                this.hasProviders = (await this.providers().catch(() => [])).length > 0;
            }
            return direct || null;
        } catch (err) {
            console.warn('[DirectPlay] Resolve failed:', err.message);
            return null;
        }
    },

    /**
     * How this browser would play `direct` straight from the provider:
     * 'file' (<video src>), 'hls' (hls.js), 'native' (Safari HLS) - or null.
     */
    mode(direct, video) {
        if (!direct?.url) return null;
        if (API.isMixedContent(direct.url)) return null;
        if (direct.probe && !direct.probe.ok && Date.now() - direct.probe.at < this.PROBE_RETRY_MS) return null;
        const ext = String(direct.container || '').toLowerCase();
        if (ext === 'm3u8') {
            if (window.Hls?.isSupported()) return 'hls';
            return video?.canPlayType('application/vnd.apple.mpegurl') ? 'native' : null;
        }
        return this.FILE_CONTAINERS.includes(ext) ? 'file' : null;
    },

    /** What the player saw (server: user_probes). Fire and forget. */
    reportProbe(direct, ok, info = {}) {
        if (!direct?.providerId) return;
        API.request('POST', `/direct/providers/${direct.providerId}/probe`, {
            kind: direct.type, itemId: direct.streamId, ok, info: { container: direct.container, ...info }
        }).catch(err => console.warn('[DirectPlay] Probe report failed:', err.message));
    },

    async reportEpisodes(providerId, seriesId) {
        const conn = await this.connection(providerId);
        const info = await this.providerApi(conn, 'get_series_info', { series_id: seriesId });
        const episodes = Object.entries(info?.episodes || {}).flatMap(([season, list]) =>
            (Array.isArray(list) ? list : []).map(e => ({
                id: e.id, season: e.season ?? season, episode: e.episode_num, title: e.title, container: e.container_extension
            })));
        await API.request('POST', `/direct/providers/${providerId}/episodes`, { seriesId, episodes });
    },

    /**
     * Read the provider's whole catalogue in this browser and report it.
     * onProgress({ kind, done, total }) after each chunk.
     * Returns { live, movie, series } -> { stored, matched }.
     */
    async syncCatalogue(providerId, onProgress = () => {}) {
        const conn = await this.connection(providerId);
        const plans = [
            { kind: 'live', cats: 'get_live_categories', list: 'get_live_streams',
              map: (s, cat) => ({ id: s.stream_id, name: s.name, category: cat(s.category_id), tvg: s.epg_channel_id }) },
            { kind: 'movie', cats: 'get_vod_categories', list: 'get_vod_streams',
              map: (s, cat) => ({ id: s.stream_id, name: s.name, category: cat(s.category_id), container: s.container_extension,
                                  tmdb: s.tmdb ?? s.tmdb_id, year: s.year ?? s.releasedate ?? s.release_date }) },
            { kind: 'series', cats: 'get_series_categories', list: 'get_series',
              map: (s, cat) => ({ id: s.series_id, name: s.name, category: cat(s.category_id),
                                  tmdb: s.tmdb ?? s.tmdb_id, year: s.year ?? s.releaseDate ?? s.release_date }) }
        ];
        const result = {};
        for (const plan of plans) {
            const categories = await this.providerApi(conn, plan.cats).catch(() => []);
            const names = new Map((Array.isArray(categories) ? categories : []).map(c => [String(c.category_id), c.category_name]));
            const streams = await this.providerApi(conn, plan.list);
            const items = (Array.isArray(streams) ? streams : []).map(s => plan.map(s, id => names.get(String(id)) ?? null));
            const totals = { stored: 0, matched: 0 };
            // Always at least one (empty) chunk, so reset clears an emptied list
            for (let i = 0; i === 0 || i < items.length; i += this.CHUNK) {
                const chunk = items.slice(i, i + this.CHUNK);
                const r = await API.request('POST', `/direct/providers/${providerId}/catalogue`, {
                    kind: plan.kind, items: chunk, reset: i === 0,
                    done: plan.kind === 'series' && i + this.CHUNK >= items.length
                });
                totals.stored += r.stored;
                totals.matched += r.matched;
                onProgress({ kind: plan.kind, done: Math.min(i + this.CHUNK, items.length), total: items.length });
            }
            result[plan.kind] = totals;
        }
        this.hasProviders = true;
        return result;
    }
};

window.DirectPlay = DirectPlay;
