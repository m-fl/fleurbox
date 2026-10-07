/**
 * Content Details helpers
 * Shared by the movie and series details panels: playlist category lookup and
 * the metadata / credits markup built from Xtream vod_info / series_info.
 */

/**
 * Settings > Language Priority on the client (Movies / Series grids, which are
 * filtered in the browser). Mirrors server/services/languages.js: a title is in
 * the language if its name or category starts with one of the language's codes
 * ("EN - ", "4K-EN - ", "US| ") or its category starts with one of its words.
 */
const LanguagePriority = {
    languages: null, // Promise<[{id, codes, words}]>

    load() {
        if (!this.languages) {
            this.languages = API.request('GET', '/search/languages').catch(err => {
                console.warn('[LanguagePriority] Could not load languages:', err);
                this.languages = null; // retry next time
                return [];
            });
            this.languages.then(list => { this.loaded = list; this.codeMap = null; });
        }
        return this.languages;
    },

    selected(app) {
        return app?.player?.settings?.languagePriority || '';
    },

    hardFilter(app) {
        return !!(app?.player?.settings?.languageHardFilter && this.selected(app));
    },

    // "EN - x", "4K-EN - x", "EN-TOP - x", "US| x", "MX: x", "BE-NL - x" - same as languages.js
    PREFIX_RE: /^(?:4K-)?([A-Z]{2,3})(?:-([A-Z]+))?\s*[-|:]/,
    CATEGORY_SUFFIX_RE: /\(([A-Z]{2,3})\)\s*$/,

    /**
     * The raw provider code a name starts with ("US| ESPN" -> "US"), or null
     */
    prefixCode(text) {
        const m = this.PREFIX_RE.exec(text || '');
        return m ? m[1] : null;
    },

    /**
     * Language id marked on a title / category name, or null (mirrors detect() in
     * server/services/languages.js)
     */
    detect(text, isCategory = false) {
        if (!text || !this.loaded) return null;
        if (!this.codeMap) {
            this.codeMap = new Map(this.loaded.flatMap(l => l.codes.map(code => [code, l.id])));
        }
        const m = this.PREFIX_RE.exec(text);
        if (m && this.codeMap.has(m[1])) return this.codeMap.get(m[1]);
        if (m && m[2] && this.codeMap.has(m[2])) return this.codeMap.get(m[2]);
        if (isCategory) {
            const upper = text.toUpperCase();
            const lang = this.loaded.find(l => (l.words || []).some(w => upper.startsWith(w)));
            if (lang) return lang.id;
            const s = this.CATEGORY_SUFFIX_RE.exec(text);
            if (s && this.codeMap.has(s[1])) return this.codeMap.get(s[1]);
        }
        return null;
    },

    /**
     * Hard filter: false only for titles explicitly marked as another language.
     * Titles with no marker (NF/AMZ packs, unmarked channels) stay.
     */
    visible(name, categoryName, id) {
        if (!id) return true;
        const byName = this.detect(name);
        const byCategory = this.detect(categoryName, true);
        if (!byName && !byCategory) return true;
        return byName === id || byCategory === id;
    },

    /**
     * (name, categoryName) => boolean for language `id`, or null if unknown / not loaded
     */
    matcher(id) {
        if (!(this.loaded || []).some(l => l.id === id)) return null;
        return (name, categoryName) => this.detect(name) === id || this.detect(categoryName, true) === id;
    },

    /**
     * Stable partition: items in language `id` first, original order otherwise
     */
    sortFirst(items, id, describe) {
        const inLanguage = id ? this.matcher(id) : null;
        if (!inLanguage) return items;
        const first = [];
        const rest = [];
        for (const item of items) {
            const [name, category] = describe(item);
            (inLanguage(name, category) ? first : rest).push(item);
        }
        return first.concat(rest);
    }
};

const ContentDetails = {
    /**
     * Stored details for a title (server-side TMDB record, no outside call).
     * Resolves to { found, tmdb, category, info } or null on failure.
     */
    local(type, sourceId, itemId) {
        return API.request('GET', `/details?type=${type}` +
            `&sourceId=${encodeURIComponent(sourceId)}&itemId=${encodeURIComponent(itemId)}`)
            .catch(err => {
                console.warn('[ContentDetails] Local details failed:', err);
                return null;
            });
    },

    // `${type}:${sourceId}` -> Promise<Map<categoryId, categoryName>>
    categoryCache: {},

    /**
     * Playlist category name for an item, or '' if unknown.
     * Fetched once per source/type, so it also works when a title is opened
     * from Home before the Movies/Series page has loaded its categories.
     * @param {'movie'|'series'} type
     */
    async categoryName(type, sourceId, categoryId) {
        if (!sourceId || categoryId === undefined || categoryId === null || categoryId === '') return '';

        const key = `${type}:${sourceId}`;
        if (!this.categoryCache[key]) {
            const request = type === 'movie'
                ? API.proxy.xtream.vodCategories(sourceId, { includeHidden: true })
                : API.proxy.xtream.seriesCategories(sourceId, { includeHidden: true });

            this.categoryCache[key] = request
                .then(categories => new Map((categories || []).map(c => [String(c.category_id), c.category_name])))
                .catch(err => {
                    delete this.categoryCache[key]; // retry on next open
                    console.warn('[ContentDetails] Could not load categories:', err);
                    return new Map();
                });
        }

        return (await this.categoryCache[key]).get(String(categoryId)) || '';
    },

    escape(text) {
        const div = document.createElement('div');
        div.textContent = text ?? '';
        return div.innerHTML;
    },

    /**
     * "2h 28m" from vod_info (duration_secs / "HH:MM:SS"), or "45m / episode"
     * from series_info (episode_run_time, minutes)
     */
    formatRuntime(info) {
        let minutes = 0;
        if (parseInt(info.duration_secs) > 0) {
            minutes = Math.round(parseInt(info.duration_secs) / 60);
        } else if (/^\d+:\d{2}:\d{2}$/.test(info.duration || '')) {
            const [h, m] = info.duration.split(':').map(Number);
            minutes = h * 60 + m;
        }

        if (minutes > 0) {
            return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
        }
        if (parseInt(info.episode_run_time) > 0) {
            return `${parseInt(info.episode_run_time)}m / episode`;
        }
        return '';
    },

    /**
     * Year · runtime · rating row, then the playlist category and genre chips
     */
    metaHtml(info, category) {
        const date = info.releasedate || info.releaseDate || info.release_date || info.year || '';
        const year = String(date).substring(0, 4);
        const rating = parseFloat(info.rating);
        const parts = [year, this.formatRuntime(info), rating > 0 ? `★ ${rating}` : ''].filter(Boolean);
        const genres = (info.genre || '').split(',').map(g => g.trim()).filter(Boolean);

        const metaRow = parts.length
            ? `<div class="details-meta">${parts.map(p => `<span>${this.escape(p)}</span>`).join('')}</div>`
            : '';
        const categoryChip = category
            ? `<span class="details-chip details-category" title="Playlist category"><span class="details-chip-label">Category</span>${this.escape(category)}</span>`
            : '';
        const genreChips = genres.map(g => `<span class="details-chip">${this.escape(g)}</span>`).join('');

        const tagline = info.tagline ? `<div class="details-tagline">${this.escape(info.tagline)}</div>` : '';
        return tagline + metaRow +
            (categoryChip || genreChips ? `<div class="details-chips">${categoryChip}${genreChips}</div>` : '');
    },

    /**
     * Director / cast rows; rows the provider left empty are omitted
     */
    creditsHtml(info) {
        const rows = [['Director', info.director], ['Cast', info.cast || info.actors]]
            .filter(([, value]) => value && String(value).trim());
        if (!rows.length) return '';

        return `<dl class="details-credits">${rows.map(([label, value]) =>
            `<dt>${label}</dt><dd>${this.escape(String(value).trim())}</dd>`).join('')}</dl>`;
    },

    /**
     * Details panels' Back button, context dependent: opened from Home (or from
     * Home's search) it goes back there; opened from the page's own grid it
     * closes the panel. `from` is 'home' | 'search' | null.
     */
    backLabel(from, pageLabel) {
        return `← Back to ${from === 'search' ? 'Search' : from === 'home' ? 'Home' : pageLabel}`;
    },

    goBack(app, from, closePanel) {
        if (from === 'home' || from === 'search') {
            if (from === 'search') app.pages.home?.sidebar?.requestRestore();
            app.navigateTo('home');
        } else {
            closePanel();
        }
    }
};
