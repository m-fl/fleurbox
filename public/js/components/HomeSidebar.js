/**
 * Home sidebar: search + favourite channels, and the search "stage".
 *
 * - Desktop: a rail on the left of Home (collapsible to logos only, remembered
 *   in localStorage). Phones: a drawer opened from the floating button.
 * - Favourite channels show what's on now (POST /api/live/now) with a progress
 *   bar, refreshed every minute while Home is visible.
 * - Typing in the sidebar search opens the stage over Home's main column:
 *   a "top result" spotlight, then Movies / Series rows that load more as they
 *   are scrolled, then live channels. Scope chips narrow it to a filter zone
 *   (QUICK_FILTERS in HomePage.js). "/" or Ctrl/Cmd+K focuses search, Esc
 *   closes the stage.
 *
 * Uses HomePage for navigation (navigateToMovie/Series, playChannel, ...).
 */
const STAGE_PAGE = 12;            // movie/series cards per request
const STAGE_LIVE_PAGE = 12;       // live channels per request
const RECENT_KEY = 'nodecast_tv_recent_searches';
const RECENT_MAX = 8;
const NOW_REFRESH_MS = 60 * 1000;

class HomeSidebar {
    constructor(home) {
        this.home = home;
        this.app = home.app;
        this.channels = [];
        this.scope = null;          // QUICK_FILTERS id, or null = everything
        this.gen = 0;               // bumped per search; stale responses are dropped
        this.items = { movie: [], series: [], live: [] };
        this.offset = { movie: 0, series: 0, live: 0 };
        this.searchTimer = null;
        this.nowTimer = null;
        this.onKey = this.onKey.bind(this);
    }

    escape(text) {
        return this.home.escapeHtml(text);
    }

    // ===================== Markup =====================

    /** Sidebar + stage markup, placed by HomePage.renderLayout() */
    static markup() {
        const searchIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>';
        return {
            sidebar: `
                <aside class="home-rail" id="home-rail" aria-label="Search and favourite channels">
                    <div class="rail-top">
                        <form class="rail-search" id="rail-search-form" role="search" autocomplete="off">
                            <span class="rail-search-icon">${searchIcon}</span>
                            <input type="search" id="rail-search-input" placeholder="Search everything"
                                enterkeyhint="search" aria-label="Search titles, actors, channels">
                            <kbd class="rail-kbd">/</kbd>
                        </form>
                        <button class="rail-collapse" id="rail-collapse" title="Collapse sidebar" aria-label="Collapse sidebar">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                    </div>
                    <button class="rail-search-mini" id="rail-search-mini" title="Search" aria-label="Search">${searchIcon}</button>
                    <div class="rail-section-header">
                        <span>Favorite Channels</span>
                        <a href="#live" class="rail-link" id="rail-manage">Manage</a>
                    </div>
                    <div class="rail-channels" id="rail-channels">
                        <div class="rail-skeleton"></div><div class="rail-skeleton"></div><div class="rail-skeleton"></div>
                    </div>
                </aside>
                <button class="rail-fab" id="rail-fab" aria-label="Search and channels">
                    ${searchIcon}
                </button>
                <div class="rail-scrim" id="rail-scrim"></div>`,
            stage: `
                <section class="search-stage" id="search-stage" aria-label="Search results" hidden>
                    <div class="stage-head">
                        <div class="stage-input-wrap">
                            <span class="rail-search-icon">${searchIcon}</span>
                            <input type="search" id="stage-search-input" placeholder="Search everything"
                                enterkeyhint="search" aria-label="Search">
                        </div>
                        <button class="stage-close" id="stage-close" aria-label="Close search">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                        </button>
                    </div>
                    <div class="stage-scopes" id="stage-scopes"></div>
                    <div class="stage-body" id="stage-body"></div>
                </section>`
        };
    }

    // ===================== Setup =====================

    mount() {
        this.rail = document.getElementById('home-rail');
        this.stage = document.getElementById('search-stage');
        this.input = document.getElementById('rail-search-input');
        this.stageInput = document.getElementById('stage-search-input');
        if (!this.rail || !this.stage) return;

        try {
            this.rail.classList.toggle('collapsed', localStorage.getItem('nodecast_tv_rail_collapsed') === '1');
        } catch { /* storage unavailable */ }

        document.getElementById('rail-collapse')?.addEventListener('click', () => this.setCollapsed(true));
        document.getElementById('rail-search-mini')?.addEventListener('click', () => {
            this.setCollapsed(false);
            this.input.focus();
        });
        document.getElementById('rail-fab')?.addEventListener('click', () => this.setDrawer(true));
        document.getElementById('rail-scrim')?.addEventListener('click', () => this.setDrawer(false));
        document.getElementById('rail-manage')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.app.navigateTo('live');
        });
        document.getElementById('stage-close')?.addEventListener('click', () => this.closeStage());

        // Both inputs drive the same search; the stage one is for phones,
        // where the sidebar drawer closes once results show
        const bind = (input) => {
            input.closest('form')?.addEventListener('submit', (e) => {
                e.preventDefault();
                clearTimeout(this.searchTimer);
                this.remember(input.value);
                this.run();
                input.blur();
            });
            input.addEventListener('input', () => {
                this.syncInputs(input);
                clearTimeout(this.searchTimer);
                this.searchTimer = setTimeout(() => this.run(), 300);
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !input.closest('form')) {
                    e.preventDefault();
                    clearTimeout(this.searchTimer);
                    this.remember(input.value);
                    this.run();
                }
            });
            input.addEventListener('focus', () => {
                // Phones: the drawer's box hands over to the full-screen stage's
                if (input === this.input && this.isPhone()) {
                    this.setDrawer(false);
                    this.openStage();
                    this.stageInput.focus();
                    return;
                }
                this.openStage();
            });
        };
        bind(this.input);
        bind(this.stageInput);

        document.addEventListener('keydown', this.onKey);
        this.loadChannels();

        // Back from a result's details: same query, same scope, stage open
        if (this.restorePending && this.restore) {
            this.restorePending = false;
            this.scope = this.restore.scope;
            this.input.value = this.stageInput.value = this.restore.q;
            this.renderScopes();
            this.run();
        } else {
            this.scope = null;
            this.renderScopes();
        }
    }

    unmount() {
        document.removeEventListener('keydown', this.onKey);
        clearInterval(this.nowTimer);
        clearTimeout(this.searchTimer);
        this.gen++;
    }

    setCollapsed(collapsed) {
        this.rail.classList.toggle('collapsed', collapsed);
        try { localStorage.setItem('nodecast_tv_rail_collapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
    }

    setDrawer(open) {
        this.rail.classList.toggle('open', open);
        document.getElementById('rail-scrim')?.classList.toggle('active', open);
        if (open) this.rail.classList.remove('collapsed');
    }

    isPhone() {
        return !!window.matchMedia?.('(max-width: 900px)').matches;
    }

    onKey(e) {
        if (this.app.currentPage !== 'home') return;
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
        if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
            if (document.querySelector('.quiz-backdrop')) return;
            e.preventDefault();
            this.focusSearch();
        } else if (e.key === 'Escape' && !this.stage.hidden) {
            this.closeStage();
        }
    }

    focusSearch() {
        if (this.isPhone()) {
            this.openStage();
            this.stageInput.focus();
        } else {
            this.setCollapsed(false);
            this.input.focus();
            this.input.select();
        }
    }

    syncInputs(from) {
        const other = from === this.input ? this.stageInput : this.input;
        if (other.value !== from.value) other.value = from.value;
    }

    // ===================== Favourite channels =====================

    async loadChannels() {
        const list = document.getElementById('rail-channels');
        if (!list) return;
        try {
            this.channels = await window.API.live.favorites() || [];
        } catch (err) {
            console.error('[Sidebar] Favourite channels failed:', err);
            list.innerHTML = '<div class="rail-empty">Couldn\'t load favourites</div>';
            return;
        }
        if (!list.isConnected) return;

        if (!this.channels.length) {
            list.innerHTML = `
                <div class="rail-empty">
                    <span>No favourites yet</span>
                    <small>Tap the heart on any channel in Live TV</small>
                </div>`;
            return;
        }

        list.innerHTML = this.channels.map((ch, i) => {
            const logo = ch.tvgLogo ? API.imageUrl(ch.tvgLogo) : '/img/placeholder.png';
            return `
                <button class="rail-channel" data-index="${i}" style="--i:${i}" title="${this.escape(ch.name)}">
                    <span class="rail-logo">
                        <img src="${this.escape(logo)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/img/placeholder.png'">
                        <span class="rail-live-dot"></span>
                    </span>
                    <span class="rail-channel-text">
                        <span class="rail-channel-name">${this.escape(this.cleanName(ch.name))}</span>
                        <span class="rail-now" data-now="${i}">&nbsp;</span>
                        <span class="rail-progress"><span data-progress="${i}"></span></span>
                    </span>
                </button>`;
        }).join('');

        list.querySelectorAll('.rail-channel').forEach(btn => {
            btn.addEventListener('click', () => {
                const ch = this.channels[btn.dataset.index];
                this.setDrawer(false);
                if (ch) this.home.playChannel(ch);
            });
        });

        this.refreshNow();
        clearInterval(this.nowTimer);
        this.nowTimer = setInterval(() => {
            if (!list.isConnected) return clearInterval(this.nowTimer);
            if (this.app.currentPage === 'home' && !document.hidden) this.refreshNow();
        }, NOW_REFRESH_MS);
    }

    /** "US: FOX (KMPH) FRESNO HD" -> "FOX (KMPH) FRESNO HD": the prefix is noise in a narrow list */
    cleanName(name) {
        return String(name || 'Unknown').replace(/^[A-Z0-9]{2,4}\s*[:|]\s*/, '');
    }

    async refreshNow() {
        let now = [];
        try {
            now = await window.API.live.now(this.channels.map(ch => ({ tvgId: ch.tvgId, name: ch.name })));
        } catch (err) {
            console.warn('[Sidebar] Now playing unavailable:', err);
            return;
        }
        const t = Date.now();
        this.channels.forEach((ch, i) => {
            const label = this.rail?.querySelector(`[data-now="${i}"]`);
            const bar = this.rail?.querySelector(`[data-progress="${i}"]`);
            if (!label || !bar) return;
            const cur = now?.[i]?.current;
            if (cur) {
                const start = new Date(cur.start).getTime();
                const stop = new Date(cur.stop).getTime();
                const pct = Math.max(0, Math.min(100, ((t - start) / (stop - start)) * 100));
                label.textContent = cur.title;
                label.title = `${cur.title} · until ${new Date(stop).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
                bar.style.width = `${pct}%`;
                bar.parentElement.classList.add('visible');
            } else {
                label.textContent = ch.groupTitle ? this.cleanName(ch.groupTitle) : 'Live';
                bar.parentElement.classList.remove('visible');
            }
        });
    }

    // ===================== Stage =====================

    openStage() {
        if (!this.stage.hidden) return;
        this.stage.hidden = false;
        requestAnimationFrame(() => this.stage.classList.add('open'));
        document.getElementById('home-main')?.classList.add('stage-open');
        if (!this.query()) this.renderIdle();
    }

    closeStage() {
        this.stage.classList.remove('open');
        document.getElementById('home-main')?.classList.remove('stage-open');
        this.gen++;
        setTimeout(() => { if (!this.stage.classList.contains('open')) this.stage.hidden = true; }, 220);
        document.activeElement?.blur?.();
    }

    query() {
        return (this.input.value || '').trim();
    }

    renderScopes() {
        const wrap = document.getElementById('stage-scopes');
        if (!wrap) return;
        const scopes = [{ id: '', label: 'Everything' }, ...QUICK_FILTERS];
        wrap.innerHTML = scopes.map(s =>
            `<button class="stage-scope ${(this.scope || '') === s.id ? 'active' : ''}" data-scope="${s.id}">${this.escape(s.label)}</button>`
        ).join('');
        wrap.querySelectorAll('.stage-scope').forEach(btn => {
            btn.addEventListener('click', () => {
                this.scope = btn.dataset.scope || null;
                wrap.querySelectorAll('.stage-scope').forEach(b => b.classList.toggle('active', b === btn));
                if (this.query().length >= 2) this.run();
            });
        });
    }

    /** Empty box: recent searches, ideas, and the query syntax */
    renderIdle() {
        const body = document.getElementById('stage-body');
        if (!body) return;
        const recent = this.recent();
        const ideas = ['genre:comedy year:2020+', 'cast:"tom hanks"', 'director:nolan', 'plot:heist', 'genre:documentary -crime', 'year:1990-1999 genre:action'];
        body.innerHTML = `
            ${recent.length ? `
                <div class="stage-block">
                    <div class="stage-label">Recent <button class="stage-clear-recent" id="stage-clear-recent">Clear</button></div>
                    <div class="stage-pills">${recent.map(q => `<button class="stage-pill" data-q="${this.escape(q)}">${this.escape(q)}</button>`).join('')}</div>
                </div>` : ''}
            <div class="stage-block">
                <div class="stage-label">Try</div>
                <div class="stage-pills">${ideas.map(q => `<button class="stage-pill ghost" data-q="${this.escape(q)}">${this.escape(q)}</button>`).join('')}</div>
            </div>
            <div class="stage-block stage-tips">
                <div class="stage-label">Search syntax</div>
                <ul>
                    <li><code>tom hanks</code> every word must match; the last can be partial</li>
                    <li><code>"the dark knight"</code> exact phrase &middot; <code>-horror</code> exclude</li>
                    <li><code>cast:</code> <code>director:</code> <code>genre:</code> <code>category:</code> <code>plot:</code> <code>title:</code> &middot; <code>OR</code> for either</li>
                    <li><code>year:2007</code> <code>year:2007&gt;</code> <code>year:2007&lt;</code> <code>year:2000-2010</code></li>
                    <li>Pick a scope above to search only within it (e.g. Netflix)</li>
                </ul>
                <p class="search-attribution">
                    <img src="/img/tmdb-logo.svg" alt="TMDB" class="tmdb-logo tmdb-logo-sm">
                    Descriptions, cast and crew from TMDB. Not endorsed or certified by TMDB.
                </p>
            </div>`;
        body.querySelectorAll('.stage-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                this.input.value = this.stageInput.value = btn.dataset.q;
                this.remember(btn.dataset.q);
                this.run();
            });
        });
        document.getElementById('stage-clear-recent')?.addEventListener('click', () => {
            try { localStorage.removeItem(this.recentKey()); } catch { /* ignore */ }
            this.renderIdle();
        });
    }

    recentKey() {
        return `${RECENT_KEY}_${this.app.currentUser?.id || 0}`;
    }

    recent() {
        try {
            return JSON.parse(localStorage.getItem(this.recentKey()) || '[]');
        } catch {
            return [];
        }
    }

    remember(q) {
        q = (q || '').trim();
        if (q.length < 2) return;
        const list = [q, ...this.recent().filter(r => r.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_MAX);
        try { localStorage.setItem(this.recentKey(), JSON.stringify(list)); } catch { /* ignore */ }
    }

    /**
     * Search all three areas. Movies and series go first (they feed the
     * spotlight), live channels last; one request at a time, like the zones.
     */
    async run() {
        this.openStage();
        const q = this.query();
        const body = document.getElementById('stage-body');
        if (q.length < 2) {
            this.gen++;
            this.renderIdle();
            return;
        }
        if (this.isPhone()) this.setDrawer(false);

        const gen = ++this.gen;
        this.items = { movie: [], series: [], live: [] };
        this.offset = { movie: 0, series: 0, live: 0 };
        body.innerHTML = `
            <div class="stage-spotlight-slot" id="stage-spotlight">
                <div class="spotlight-skeleton"></div>
            </div>
            ${[['movie', 'Movies'], ['series', 'Series']].map(([type, label]) => `
                <div class="stage-row" id="stage-row-${type}">
                    <div class="stage-label">${label} <span class="stage-count" id="stage-count-${type}"></span></div>
                    <div class="stage-shelf" id="stage-shelf-${type}">
                        ${'<div class="stage-card skeleton"></div>'.repeat(6)}
                    </div>
                </div>`).join('')}
            <div class="stage-row" id="stage-row-live">
                <div class="stage-label">Live channels <span class="stage-count" id="stage-count-live"></span></div>
                <div class="stage-live" id="stage-live">${'<div class="stage-live-pill skeleton"></div>'.repeat(4)}</div>
            </div>`;

        for (const type of ['movie', 'series', 'live']) {
            if (gen !== this.gen) return;
            await this.load(type, gen);
        }
        if (gen !== this.gen) return;
        this.renderSpotlight(q);

        if (!this.items.movie.length && !this.items.series.length && !this.items.live.length) {
            body.innerHTML = `
                <div class="stage-empty">
                    <div class="stage-empty-title">Nothing for "${this.escape(q)}"${this.scope ? ` in ${this.escape(this.scopeLabel())}` : ''}</div>
                    <div class="stage-empty-hint">${this.scope ? 'Try searching Everything, or ' : ''}check the spelling or use fewer words.</div>
                </div>`;
        }
    }

    scopeLabel() {
        return QUICK_FILTERS.find(f => f.id === this.scope)?.label || '';
    }

    async load(type, gen) {
        const q = this.query();
        const zone = QUICK_FILTERS.find(f => f.id === this.scope);
        const settings = this.app.player?.settings || {};
        const params = new URLSearchParams({
            q, type,
            limit: type === 'live' ? STAGE_LIVE_PAGE : STAGE_PAGE,
            offset: this.offset[type],
            lang: settings.languagePriority || '',
            hard: settings.languageHardFilter ? 1 : 0
        });
        if (zone) params.set('pattern', zone.regex);

        let res;
        try {
            res = await window.API.request('GET', `/search?${params}`);
        } catch (err) {
            if (gen !== this.gen) return;
            console.error('[Sidebar] Search failed:', err);
            this.renderSection(type, [], false, err.message || 'Search failed');
            return;
        }
        if (gen !== this.gen) return;

        const items = res?.items || [];
        const append = this.offset[type] > 0;
        this.items[type] = this.items[type].concat(items);
        this.offset[type] += items.length;
        this.renderSection(type, items, !!res?.hasMore, null, append);
    }

    renderSection(type, items, hasMore, error, append = false) {
        const row = document.getElementById(`stage-row-${type}`);
        if (!row) return;
        const count = document.getElementById(`stage-count-${type}`);
        if (count) count.textContent = this.items[type].length ? `${this.items[type].length}${hasMore ? '+' : ''}` : '';

        if (type === 'live') {
            const wrap = document.getElementById('stage-live');
            if (!append) wrap.innerHTML = '';
            wrap.querySelector('.stage-more')?.remove();
            if (error) { wrap.innerHTML = `<div class="stage-error">${this.escape(error)}</div>`; return; }
            if (!this.items.live.length) { row.classList.add('hidden'); return; }
            const start = this.items.live.length - items.length;
            wrap.insertAdjacentHTML('beforeend', items.map((ch, i) => this.livePill(ch, start + i)).join(''));
            wrap.querySelectorAll('.stage-live-pill:not([data-bound])').forEach(pill => {
                pill.dataset.bound = '1';
                pill.addEventListener('click', () => this.home.playLiveItem(this.items.live[pill.dataset.index]));
            });
            if (hasMore) {
                wrap.insertAdjacentHTML('beforeend', '<button class="stage-more">More channels</button>');
                wrap.querySelector('.stage-more').addEventListener('click', (e) => {
                    e.currentTarget.disabled = true;
                    this.load('live', this.gen);
                });
            }
            return;
        }

        const shelf = document.getElementById(`stage-shelf-${type}`);
        if (!append) shelf.innerHTML = '';
        shelf.querySelector('.stage-sentinel')?.remove();
        if (error) { shelf.innerHTML = `<div class="stage-error">${this.escape(error)}</div>`; return; }
        if (!this.items[type].length) { row.classList.add('hidden'); return; }

        const start = this.items[type].length - items.length;
        shelf.insertAdjacentHTML('beforeend', items.map((item, i) => this.card(item, type, start + i, i)).join(''));
        shelf.querySelectorAll('.stage-card:not([data-bound])').forEach(card => {
            card.dataset.bound = '1';
            card.addEventListener('click', () => this.open(type, this.items[type][card.dataset.index]));
        });

        if (hasMore) {
            // The end of the row loads the next page, a little early
            const sentinel = document.createElement('div');
            sentinel.className = 'stage-sentinel';
            sentinel.innerHTML = '<div class="loading-spinner"></div>';
            shelf.appendChild(sentinel);
            const gen = this.gen;
            const observer = new IntersectionObserver(entries => {
                if (!entries.some(e => e.isIntersecting)) return;
                observer.disconnect();
                if (gen === this.gen) this.load(type, gen);
            }, { root: shelf, rootMargin: '0px 400px 0px 0px' });
            observer.observe(sentinel);
        }
    }

    /** Wrap the query's words in <mark> inside already-escaped text */
    highlight(text) {
        const html = this.escape(text);
        const words = this.query()
            .replace(/\b\w+:/g, ' ')
            .split(/[\s"]+/)
            .map(w => w.replace(/^-.*/, '').replace(/[^\p{L}\p{N}]/gu, ''))
            .filter(w => w.length >= 2 && w.toUpperCase() !== 'OR');
        if (!words.length) return html;
        const re = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
        return html.replace(re, '<mark>$1</mark>');
    }

    meta(item) {
        const year = item.release_year || item.year || '';
        const rating = item.tmdb_rating ? `★ ${Number(item.tmdb_rating).toFixed(1)}` : '';
        return [year, rating].filter(Boolean).join(' · ');
    }

    card(item, type, index, i) {
        const poster = item.stream_icon ? API.imageUrl(item.stream_icon) : '/img/poster-placeholder.jpg';
        return `
            <button class="stage-card" data-index="${index}" style="--i:${i}">
                <span class="stage-poster">
                    <img src="${this.escape(poster)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/img/poster-placeholder.jpg'">
                    <span class="stage-card-type">${type === 'movie' ? 'Movie' : 'Series'}</span>
                </span>
                <span class="stage-card-title">${this.highlight(item.name)}</span>
                <span class="stage-card-meta">${this.escape(this.meta(item) || item.category_name || '')}</span>
            </button>`;
    }

    livePill(ch, index) {
        const logo = ch.stream_icon ? API.imageUrl(ch.stream_icon) : '/img/placeholder.png';
        return `
            <button class="stage-live-pill" data-index="${index}" style="--i:${index % STAGE_LIVE_PAGE}">
                <img src="${this.escape(logo)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/img/placeholder.png'">
                <span class="stage-live-text">
                    <span class="stage-live-name">${this.highlight(ch.name)}</span>
                    <span class="stage-live-cat">${this.escape(ch.category_name || '')}</span>
                </span>
                <span class="stage-live-badge">LIVE</span>
            </button>`;
    }

    /**
     * A title as people would type it: provider prefixes ("4K-EN - ",
     * "EN-TOP - 19. "), trailing "(2022)" / "(US)" and punctuation removed
     */
    plainTitle(name) {
        return String(name || '')
            .replace(/^(?:[A-Z0-9+]{1,6}(?:-[A-Z0-9+]{1,6})*\s*[-|:]\s*)+/, '')
            .replace(/^\d+\.\s*/, '')
            .replace(/(\s*\([^)]*\))+\s*$/, '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
    }

    /**
     * How well a result's title matches the typed words: exact title >
     * starts with them > contains them. TMDB rating breaks ties, so the
     * series "South Park" (8.3) beats the movie special "South Park: The
     * Streaming Wars", and Fargo the series beats Fargo the movie.
     */
    titleScore(item, words) {
        const title = this.plainTitle(item.name);
        const rating = Number(item.tmdb_rating) || 0;
        let score = 0;
        if (words) {
            if (title === words) score = 100;
            else if (title.startsWith(words)) score = 60;
            else if (title.includes(words)) score = 30;
        }
        return score + rating;
    }

    /**
     * Spotlight: the best title match across movies and series (see
     * titleScore), else the first channel - with backdrop, plot and actions.
     * The winning type's row is moved to the top.
     */
    renderSpotlight(q) {
        const slot = document.getElementById('stage-spotlight');
        if (!slot) return;
        const words = this.plainTitle(q.replace(/\b\w+:("[^"]*"|\S*)/g, ' ').replace(/(^|\s)-\S+/g, ' '));
        const pool = [
            ...this.items.movie.slice(0, 6).map(item => ({ item, type: 'movie' })),
            ...this.items.series.slice(0, 6).map(item => ({ item, type: 'series' }))
        ].map(p => ({ ...p, score: this.titleScore(p.item, words) }));
        // A tie goes to the series: the provider also files some shows as
        // "movies" under the same name and rating (e.g. Breaking Bad)
        const best = pool.reduce((a, b) =>
            (b.score > a.score || (b.score === a.score && b.type === 'series') ? b : a), pool[0]);
        const pick = best || (this.items.live[0] && { item: this.items.live[0], type: 'live' });
        if (!pick) { slot.remove(); return; }

        // Series won: show its row above Movies
        if (pick.type === 'series') {
            const seriesRow = document.getElementById('stage-row-series');
            const movieRow = document.getElementById('stage-row-movie');
            if (seriesRow && movieRow) movieRow.before(seriesRow);
        }

        const { item, type } = pick;
        const poster = item.stream_icon ? API.imageUrl(item.stream_icon)
            : (type === 'live' ? '/img/placeholder.png' : '/img/poster-placeholder.jpg');
        const kind = { movie: 'Movie', series: 'Series', live: 'Live channel' }[type];
        const meta = [kind, this.meta(item), item.category_name].filter(Boolean).map(m => this.escape(m)).join(' &middot; ');
        const plot = item.overview || item.data?.description || item.data?.plot || '';

        slot.innerHTML = `
            <div class="spotlight ${type === 'live' ? 'is-live' : ''}">
                <div class="spotlight-backdrop" style="background-image:url('${this.escape(poster)}')"></div>
                <img class="spotlight-poster" src="${this.escape(poster)}" alt="" onerror="this.onerror=null;this.src='/img/poster-placeholder.jpg'">
                <div class="spotlight-info">
                    <span class="spotlight-kicker">Top result</span>
                    <h3 class="spotlight-title">${this.highlight(item.name)}</h3>
                    <div class="spotlight-meta">${meta}</div>
                    ${plot ? `<p class="spotlight-plot">${this.escape(plot)}</p>` : ''}
                    <div class="spotlight-actions">
                        <button class="btn btn-primary spotlight-go">
                            <svg viewBox="0 0 24 24" fill="currentColor" class="icon"><path d="M8 5v14l11-7z"/></svg>
                            ${type === 'live' ? 'Watch live' : type === 'series' ? 'Episodes' : 'Details'}
                        </button>
                    </div>
                </div>
            </div>`;
        slot.querySelector('.spotlight-go').addEventListener('click', () => this.open(type, item));
        slot.querySelector('.spotlight').addEventListener('click', (e) => {
            if (!e.target.closest('button')) this.open(type, item);
        });
    }

    /**
     * Open a result. Movies/series remember the search, so "Back to Search"
     * on their details panel brings Home back with the stage reopened.
     */
    open(type, item) {
        if (!item) return;
        this.remember(this.query());
        if (type === 'live') return this.home.playLiveItem(item);
        this.restore = { q: this.query(), scope: this.scope };
        if (type === 'series') this.home.navigateToSeries(item, 'search');
        else this.home.navigateToMovie(item, 'search');
    }

    /** Called by the details panels' "Back to Search" */
    requestRestore() {
        this.restorePending = !!this.restore;
    }
}

window.HomeSidebar = HomeSidebar;
