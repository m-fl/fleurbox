/**
 * Home Dashboard Page
 *
 * Left: the sidebar (search + favourite channels, components/HomeSidebar.js).
 * Main column: the taste-quiz prompt or "For You" rows built from the user's
 * quiz answers (components/TasteQuiz.js, server/services/taste.js), Continue
 * Watching, Live Events (today's fixtures on the user's channels, their teams
 * first; server/services/liveEvents.js), "filter zones" and this week's
 * trending movies/series (TMDB ranking stored daily, matched to the library
 * server-side). Filter zones
 * fetch nothing until tapped, and each pulls only a page of rows at a time to
 * keep requests small.
 *
 * To add or change a zone, edit QUICK_FILTERS below. `regex` is a JavaScript
 * regular expression (as a string) matched case-insensitively against item
 * names by the server.
 */
// Each load fills whole rows of the results grid, so the count adapts to the
// viewport instead of being a fixed number. Raise ROWS_PER_LOAD to pull more
// per tap.
const ROWS_PER_LOAD = 1;
// Used only when the grid's column count cannot be measured (e.g. hidden).
const FALLBACK_PAGE = 10;
// Matches the server's own cap on ?limit=
const MAX_PAGE = 100;
// Phones: each area is a horizontal row instead of a grid; SHELF_PAGE results
// load at a time and the next page loads when the row is scrolled to its end
const SHELF_QUERY = '(max-width: 768px)';
const SHELF_PAGE = 10;

const QUICK_FILTERS = [
    { id: 'us', label: 'US', regex: '\\b(US|USA)\\b' },
    { id: 'uk', label: 'UK', regex: '\\b(UK|GB)\\b' },
    { id: 'ca', label: 'Canada', regex: '\\b(CA|CAN)\\b' },
    { id: 'netflix', label: 'Netflix', regex: 'NETFLIX|\\bNF\\b' },
    // Apple titles are mostly prefixed "A+ - " / "4K-A+ - "; channels say "APPLE+"
    { id: 'appletv', label: 'Apple TV', regex: 'APPLE\\s*(TV|\\+)|\\bATV\\+|(^|[\\s\\-|])A\\+\\s*[-|:]' },
    // Disney titles are mostly prefixed "D+ - " / "4K-D+ - "
    { id: 'disney', label: 'Disney+', regex: 'DISNEY|(^|[\\s\\-|])D\\+\\s*[-|:]' },
    { id: 'hbo', label: 'HBO / Max', regex: '\\bHBO\\b|\\bMAX\\b' },
    // Amazon titles are mostly prefixed "AMZ - " / "4K-AMZ - "
    { id: 'prime', label: 'Prime', regex: 'PRIME\\s*VIDEO|\\bAMZN\\b|(^|[\\s\\-|])AMZ\\s*[-|:]' },
    { id: 'mlb', label: 'MLB', regex: '\\bMLB\\b' },
    { id: 'nfl', label: 'NFL', regex: '\\bNFL\\b' },
    { id: 'nba', label: 'NBA', regex: '\\bNBA\\b' },
    { id: 'nhl', label: 'NHL', regex: '\\bNHL\\b' },
    { id: 'espn', label: 'ESPN', regex: '\\bESPN\\b' },
    { id: '4k', label: '4K / UHD', regex: '\\b(4K|UHD|2160P?)\\b' }
];

// The three content areas each filter zone searches.
const FILTER_TYPES = [
    { type: 'live', label: 'Live TV' },
    { type: 'movie', label: 'Movies' },
    { type: 'series', label: 'Series' }
];

class HomePage {
    constructor(app) {
        this.app = app;
        this.container = null; // Will be set in renderLayout
        this.isLoading = false;
        this.activeFilter = null;
        this.filterItems = {};  // type -> loaded rows, for click handlers
        this.filterOffset = {}; // type -> how many rows already fetched
        this.queryGen = 0;      // bumped per zone; stale responses are dropped
        this.sidebar = new HomeSidebar(this);
        this.taste = null;      // { catalog, profile } from /api/home/taste
        this.forYouGen = 0;
        this.forYouTimer = null;
    }

    async init() {
        // Initialization if needed
    }

    async show() {
        this.renderLayout();
        this.renderFilterZones();
        this.sidebar.mount();
        await this.loadDashboardData();
    }

    hide() {
        this.sidebar.unmount();
        clearTimeout(this.forYouTimer);
        clearTimeout(this.liveEventsTimer);
        this.forYouGen++;
        document.getElementById('page-home')?.replaceChildren();
        this.container = null;
    }

    renderLayout() {
        const pageHome = document.getElementById('page-home');
        if (!pageHome) return;

        const { sidebar, stage } = HomeSidebar.markup();
        pageHome.innerHTML = `
          <div class="home-shell">
            ${sidebar}
            <div class="home-main" id="home-main">
            <div class="dashboard-content" id="home-content">
                <section class="taste-cta hidden" id="taste-cta">
                    <div class="taste-cta-glow"></div>
                    <div class="taste-cta-text">
                        <span class="taste-cta-kicker">Make it yours</span>
                        <h2>What do you love to watch?</h2>
                        <p>Take a 30-second quiz and Home fills up with rows picked for you &mdash; what's trending in your genres and the stories you can't resist.</p>
                    </div>
                    <div class="taste-cta-actions">
                        <button class="btn btn-primary" id="taste-cta-start">Take the quiz</button>
                    </div>
                </section>

                <section class="dashboard-section hidden" id="continue-watching-section">
                    <div class="section-header">
                        <h2>Continue Watching</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="continue-watching-list"></div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section hidden" id="live-events-section">
                    <div class="section-header">
                        <h2>Live Events</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="live-events-list"></div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section hidden" id="team-events-section">
                    <div class="section-header">
                        <h2>Your Teams: Coming Up</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="team-events-list"></div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <div id="for-you"></div>

                <!-- Hidden for now (Live Events and For You cover it); may come back -->
                <section class="dashboard-section hidden" id="filter-zones-section">
                    <div class="section-header">
                        <h2>Filter Zones</h2>
                    </div>
                    <div class="filter-zones" id="filter-zones"></div>
                </section>

                <div id="filter-results"></div>

                <section class="dashboard-section hidden" id="trending-movies-section">
                    <div class="section-header">
                        <h2>Trending Movies</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="trending-movies-list"></div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section hidden" id="trending-series-section">
                    <div class="section-header">
                        <h2>Trending Series</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="trending-series-list"></div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>
            </div>
            </div>
            ${stage}
          </div>
        `;
        this.container = document.getElementById('home-content');
        document.getElementById('taste-cta-start')?.addEventListener('click', () => this.openQuiz());

        // Attach scroll arrow handlers
        this.initScrollArrows();
    }

    initScrollArrows(root = this.container) {
        root?.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            if (wrapper._updateArrows) return; // already bound
            const scrollContainer = wrapper.querySelector('.horizontal-scroll');
            const leftBtn = wrapper.querySelector('.scroll-left');
            const rightBtn = wrapper.querySelector('.scroll-right');

            if (!scrollContainer || !leftBtn || !rightBtn) return;

            const scrollAmount = 300; // pixels to scroll per click

            leftBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
            });

            rightBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: scrollAmount, behavior: 'smooth' });
            });

            // Update arrow visibility based on scroll position
            const updateArrows = () => {
                const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
                leftBtn.classList.toggle('hidden', scrollLeft <= 0);
                rightBtn.classList.toggle('hidden', scrollLeft + clientWidth >= scrollWidth - 5);
            };

            // Store reference for later updates
            wrapper._updateArrows = updateArrows;

            scrollContainer.addEventListener('scroll', updateArrows);
            // Initial check after content loads
            setTimeout(updateArrows, 100);
        });
    }

    /**
     * Re-check scroll arrow visibility for all sections
     * Call this after dynamically loading content
     */
    updateScrollArrows() {
        this.container?.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            if (wrapper._updateArrows) {
                wrapper._updateArrows();
            }
        });
    }

    async loadDashboardData() {
        if (this.isLoading) return;
        this.isLoading = true;

        try {
            // Small requests, in parallel: the user's history, their For You
            // rows and the stored trending lists (favourite channels load in the
            // sidebar). Filter zones still fetch only when tapped.
            await Promise.all([
                this.renderContinueWatching(),
                this.renderLiveEvents(),
                this.renderForYou(),
                this.renderTrending('movie', 'trending-movies'),
                this.renderTrending('tv', 'trending-series')
            ]);

        } catch (err) {
            console.error('[Dashboard] Error loading data:', err);
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Play a live channel ({ id, sourceId, ... } as ChannelList uses) on Live TV.
     * The channel is passed along, so its group needn't be loaded first.
     */
    playChannel(channel) {
        this.app.navigateTo('live');
        this.app.channelList?.selectChannel({
            channelId: channel.id,
            sourceId: channel.sourceId,
            sourceType: channel.sourceType,
            streamId: channel.streamId || '',
            url: channel.url || '',
            channel
        });
    }

    /**
     * Continue Watching: this user's in-progress movies and one entry per series
     * (resume where they stopped, or the next episode once one is finished)
     */
    async renderContinueWatching() {
        const list = document.getElementById('continue-watching-list');
        const section = document.getElementById('continue-watching-section');
        if (!list || !section) return;

        let items = [];
        try {
            items = await window.API.request('GET', '/home/continue?limit=20');
        } catch (err) {
            console.warn('[Dashboard] Continue watching unavailable:', err);
        }
        if (!list.isConnected) return; // left Home meanwhile
        if (!items.length) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        list.innerHTML = items.map(item => this.createCard(item)).join('');

        list.querySelectorAll('.dashboard-card').forEach(card => {
            const item = items.find(i => i.key === card.dataset.key);
            if (!item) return;
            card.addEventListener('click', (e) => {
                if (e.target.closest('.card-remove')) return;
                // Up-next episodes start from the beginning; others resume
                this.playItem(item, !item.upNext);
            });
            card.querySelector('.card-remove')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                const query = item.item_type === 'movie'
                    ? `itemId=${encodeURIComponent(item.item_id)}`
                    : `seriesId=${encodeURIComponent(item.data.seriesId || '')}`;
                try {
                    await window.API.request('DELETE', `/home/continue?${query}`);
                    card.remove();
                    if (!list.querySelector('.dashboard-card')) section.classList.add('hidden');
                    this.updateScrollArrows();
                } catch (err) {
                    console.error('[Dashboard] Could not remove from continue watching:', err);
                }
            });
        });

        this.updateScrollArrows();
    }

    /**
     * Live Events: the user's teams, then their leagues/sports, in date order
     * (only those, once they've picked sports in the quiz); otherwise the big
     * events on their channels. A card opens the event's page (EventPage.js),
     * which lists the channels showing it; a followed game the guide doesn't
     * list yet opens it too, without channels. Live TV lists them as well.
     */
    async renderLiveEvents() {
        const list = document.getElementById('live-events-list');
        const section = document.getElementById('live-events-section');
        if (!list || !section) return;

        // First load: show the row with a spinner (the server may be re-matching
        // fixtures to the guide). Background refreshes keep the cards meanwhile.
        if (!list.querySelector('.event-card')) {
            section.classList.remove('hidden');
            list.innerHTML = `
                <div class="events-loading" role="status">
                    <span class="events-spinner" aria-hidden="true"></span>
                    <span>Finding today's games…</span>
                </div>`;
        }

        let events = [];
        try {
            events = await window.API.live.events(30, true);
        } catch (err) {
            console.warn('[Dashboard] Live events unavailable:', err);
        }
        if (!list.isConnected) return;

        // Your teams' games that haven't started get their own row; a live one
        // leads the Live Events row
        const upcomingTeams = events.filter(e => e.favourite && !e.live);
        const rest = events.filter(e => !(e.favourite && !e.live));
        const liveTeams = rest.filter(e => e.favourite);
        this.fillEventRow(section, list, [...liveTeams, ...rest.filter(e => !e.favourite)]);
        const teamSection = document.getElementById('team-events-section');
        const teamList = document.getElementById('team-events-list');
        if (teamSection && teamList) this.fillEventRow(teamSection, teamList, upcomingTeams);
        this.updateScrollArrows();
    }

    /** Render event cards into one row (hidden when there are none) */
    fillEventRow(section, list, events) {
        if (!events.length) {
            section.classList.add('hidden');
            list.innerHTML = '';
            return;
        }
        section.classList.remove('hidden');
        list.innerHTML = events.map(e => this.createEventCard(e)).join('');
        list.querySelectorAll('.event-card').forEach((card, i) => {
            const open = () => this.app.pages.event?.open(events[i], 'home');
            card.addEventListener('click', open);
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open();
                }
            });
        });
    }

    /**
     * "20:30", "Tomorrow 20:30", "Sat 20:30" or "Sat 12 Oct" in local time;
     * a game without a set time shows its date and "TBA". ESPN's placeholder
     * for that is midnight US Eastern, so the date is read in that zone.
     */
    static eventTime(iso, timeTbd = false) {
        const date = new Date(iso);
        const day = timeTbd
            ? new Date(date.toLocaleDateString('en-US', { timeZone: 'America/New_York' }))
            : new Date(date);
        const days = Math.round((new Date(day).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
        const when = days === 0 ? 'Today' : days === 1 ? 'Tomorrow'
            : days < 7 ? day.toLocaleDateString([], { weekday: 'short' })
            : day.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
        if (timeTbd) return `${when} · TBA`;
        const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return days === 0 ? time : `${when} ${time}`;
    }

    createEventCard(event) {
        const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        const logo = side => side?.logo
            ? `<img src="${esc(API.imageUrl(side.logo))}" alt="${esc(side.short || side.name)}" loading="lazy" data-fallback="hide">`
            : `<span class="event-initials">${esc((side?.short || side?.name || '?').slice(0, 3))}</span>`;
        const art = event.home && event.away
            ? `<div class="event-sides">${logo(event.home)}<span class="event-vs">vs</span>${logo(event.away)}</div>`
            : `<div class="event-sides event-sides-text">${esc(event.competition || event.title)}</div>`;
        const count = event.channels.length;
        const reach = count ? `${count} channel${count === 1 ? '' : 's'}` : 'Not in guide yet';
        const meta = [event.note || event.competition, reach].filter(Boolean).join(' · ');

        return `
            <div class="dashboard-card event-card ${event.live ? 'is-live' : ''} ${count ? '' : 'no-channels'}"
                 title="${esc(count ? (event.programme || event.title) : 'Your guide does not list this game yet')}"
                 role="button" tabindex="0">
                <div class="event-art">
                    ${art}
                    ${event.live ? '<span class="card-badge event-live">LIVE</span>'
                        : `<span class="card-badge event-when">${esc(HomePage.eventTime(event.start, event.timeTbd))}</span>`}
                    ${event.favourite ? '<span class="event-fav" title="Your team">&#9733;</span>' : ''}
                    ${count ? `<div class="play-icon-overlay">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </div>` : ''}
                </div>
                <div class="card-info">
                    <div class="card-title">${esc(event.title)}</div>
                    <div class="card-subtitle">${esc(meta)}</div>
                </div>
            </div>`;
    }

    /**
     * Trending row (kind 'movie' | 'tv'): titles from this week's TMDB ranking
     * that are in the library, opening the same details panel as search results
     */
    async renderTrending(kind, prefix) {
        const list = document.getElementById(`${prefix}-list`);
        const section = document.getElementById(`${prefix}-section`);
        if (!list || !section) return;

        let items = [];
        try {
            items = await window.API.request('GET', `/home/trending?kind=${kind}&limit=20`);
        } catch (err) {
            console.warn(`[Dashboard] Trending ${kind} unavailable:`, err);
        }
        if (!list.isConnected) return;
        if (!items.length) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        list.innerHTML = items.map(item => this.createRecentCard(item, item.rank)).join('');
        list.querySelectorAll('.dashboard-card').forEach((card, i) => {
            const item = items[i];
            card.addEventListener('click', () => {
                if (kind === 'tv') this.navigateToSeries(item);
                else this.navigateToMovie(item);
            });
        });

        this.updateScrollArrows();
    }

    /**
     * Open a series' details. `from` names where Back should return to
     * ('home', or 'search' to reopen the search stage), so the details panel
     * offers "Back to Home"/"Back to Search" instead of the Series grid.
     */
    navigateToSeries(item, from = 'home') {
        if (!this.app.pages.series) return;

        // Prepare the series object as expected by SeriesPage.showSeriesDetails
        const series = {
            series_id: item.item_id,
            sourceId: item.source_id,
            category_id: item.category_id,
            name: item.name || (item.data ? item.data.title : 'Series'),
            cover: item.stream_icon || (item.data ? item.data.poster : null),
            plot: item.data ? item.data.description : '',
            year: item.data ? item.data.year : ''
        };

        // Switch page
        this.app.navigateTo('series');

        // Show details (delay slightly to ensure page is visible)
        setTimeout(() => {
            this.app.pages.series.showSeriesDetails(series, { from });
        }, 100);
    }

    navigateToMovie(item, from = 'home') {
        if (!this.app.pages.movies) return;

        // Shape the search row like a vod_streams entry, as MoviesPage expects
        const movie = {
            stream_id: item.item_id,
            sourceId: item.source_id,
            name: item.name,
            stream_icon: item.stream_icon,
            rating: item.rating,
            year: item.year,
            category_id: item.category_id,
            container_extension: item.container_extension
        };

        // Switch page, then open details (show() hides the panel on entry)
        this.app.navigateTo('movies');
        setTimeout(() => {
            this.app.pages.movies.showMovieDetails(movie, { from });
        }, 100);
    }

    createCard(item) {
        const { data, progress, duration, item_id } = item;
        const type = item.item_type || item.type;
        const percent = duration > 0 ? Math.min(100, Math.round((progress / duration) * 100)) : 0;

        // Proxy the poster if it's an external URL
        const poster = data.poster || '/img/poster-placeholder.jpg';
        const posterUrl = API.imageUrl(poster);

        return `
            <div class="dashboard-card" data-id="${this.escapeHtml(item_id)}" data-key="${this.escapeHtml(item.key)}" data-type="${this.escapeHtml(type)}">
                <div class="card-image">
                    <img src="${this.escapeHtml(posterUrl)}" alt="${this.escapeHtml(data.title || item.name)}" loading="lazy" data-fallback="/img/poster-placeholder.jpg">
                    <button class="card-remove" title="Remove from Continue Watching" aria-label="Remove">&times;</button>
                    ${item.upNext ? '<span class="card-badge">Up next</span>' : ''}
                    <div class="progress-bar-container">
                        <div class="progress-bar" style="width: ${percent}%"></div>
                    </div>
                    <div class="play-icon-overlay">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                </div>
                <div class="card-info">
                    <div class="card-title" title="${this.escapeHtml(item.name || data.title)}">${this.escapeHtml(item.name || data.title || 'Unknown Title')}</div>
                    <div class="card-subtitle">${this.escapeHtml(data.subtitle || (type === 'movie' ? 'Movie' : 'Series'))}</div>
                </div>
            </div>
        `;
    }

    createRecentCard(item, rank = null) {
        const { data, item_id } = item;
        const type = item.type || item.item_type;
        const poster = item.stream_icon || data.poster || '/img/poster-placeholder.jpg';
        const posterUrl = API.imageUrl(poster);

        return `
            <div class="dashboard-card" data-id="${this.escapeHtml(item_id)}" data-type="${this.escapeHtml(type)}">
                <div class="card-image">
                    <img src="${this.escapeHtml(posterUrl)}" alt="${this.escapeHtml(item.name)}" loading="lazy" data-fallback="/img/poster-placeholder.jpg">
                    ${rank ? `<span class="card-rank">${rank}</span>` : ''}
                    ${item.overview ? `<div class="card-peek"><p>${this.escapeHtml(item.overview)}</p></div>` : ''}
                    <div class="play-icon-overlay">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                </div>
                <div class="card-info">
                    <div class="card-title" title="${this.escapeHtml(item.name || (data && data.title))}">${this.escapeHtml(item.name || (data && data.title) || 'Unknown Title')}</div>
                    <div class="card-subtitle">${this.escapeHtml((data && data.subtitle) || (type === 'movie' ? 'Movie' : (type === 'live' ? 'Live TV' : 'Series')))}</div>
                </div>
            </div>
        `;
    }

    async playItem(item, isResume = false) {
        if (!this.app.pages.watch) return;

        try {
            const type = item.item_type || item.type;
            const streamType = type === 'movie' ? 'movie' : 'series';
            const sourceId = item.source_id || (item.data && item.data.sourceId);
            const streamId = item.item_id;
            const container = item.container_extension || (item.data && item.data.containerExtension) || 'mp4';

            const result = await window.API.request('GET', `/proxy/xtream/${sourceId}/stream/${streamId}/${streamType}?container=${container}`);

            if (result && result.url) {
                const content = {
                    id: item.item_id,
                    type: type,
                    title: item.name || item.data.title,
                    subtitle: item.data.subtitle || (type === 'movie' ? 'Movie' : 'Series'),
                    poster: item.stream_icon || item.data.poster,
                    sourceId: sourceId,
                    resumeTime: isResume ? item.progress : 0,
                    containerExtension: container
                };

                // For episodes, try to restore series data for next episode functionality
                if (type === 'episode' && item.data) {
                    content.seriesId = item.data.seriesId || null;
                    content.currentSeason = item.data.currentSeason || null;
                    content.currentEpisode = item.data.currentEpisode || null;

                    // Fetch seriesInfo if we have a seriesId
                    if (content.seriesId && sourceId) {
                        try {
                            const seriesInfo = await window.API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${content.seriesId}`);
                            if (seriesInfo) {
                                content.seriesInfo = seriesInfo;
                            }
                        } catch (e) {
                            console.warn('[Dashboard] Could not fetch seriesInfo for next episode:', e);
                        }
                    }
                }

                // Switch to watch page
                this.app.navigateTo('watch');

                this.app.pages.watch.play(content, result.url);
            }
        } catch (err) {
            console.error('[Dashboard] Playback failed:', err);
        }
    }
    // ===================== For You =====================

    /**
     * The quiz prompt (no profile yet) or the user's rows. While the server is
     * still fetching TMDB popularity lists (`pending`), ask again a few times
     * so the rows sharpen without a reload.
     */
    async renderForYou(attempt = 0) {
        const wrap = document.getElementById('for-you');
        const cta = document.getElementById('taste-cta');
        if (!wrap || !cta) return;
        if (attempt === 0) {
            clearTimeout(this.forYouTimer);
            this.forYouGen++;
        }
        const gen = this.forYouGen;

        let res;
        try {
            res = await window.API.request('GET', '/home/for-you');
        } catch (err) {
            console.warn('[Dashboard] For You unavailable:', err);
            return;
        }
        if (gen !== this.forYouGen || !wrap.isConnected) return;

        cta.classList.toggle('hidden', !!res.profile);
        // Rows from watch history show with or without the quiz
        this.hasTasteProfile = !!res.profile;
        if (!res.profile && !res.rows.length) {
            wrap.innerHTML = '';
            return;
        }

        // Re-render only when something changed (keeps scroll positions on polls)
        const signature = JSON.stringify(res.rows.map(r => [r.id, r.items.map(i => i.item_id)]));
        if (signature !== this.forYouSignature || !wrap.childElementCount) {
            this.forYouSignature = signature;
            this.drawForYouRows(wrap, res.rows);
        }

        if (res.pending && attempt < 6) {
            this.forYouTimer = setTimeout(() => this.renderForYou(attempt + 1), 5000);
        }
    }

    drawForYouRows(wrap, rows) {
        if (!rows.length) {
            wrap.innerHTML = `
                <section class="dashboard-section">
                    <div class="section-header">
                        <h2>Made for you</h2>
                        <button class="taste-edit" data-action="quiz">Retake quiz</button>
                    </div>
                    <div class="empty-state hint">Nothing in your library matches those picks yet &mdash; try a few more genres.</div>
                </section>`;
        } else {
            wrap.innerHTML = rows.map((row, r) => `
                <section class="dashboard-section for-you-row" style="--r:${r}">
                    <div class="section-header">
                        <h2>${this.escapeHtml(row.title)}</h2>
                        ${r === 0 && this.hasTasteProfile ? '<button class="taste-edit" data-action="quiz">Retake quiz</button>' : ''}
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" data-row="${r}">
                            ${row.items.map(item => this.createRecentCard({
                                ...item,
                                data: { subtitle: this.forYouSubtitle(item) }
                            })).join('')}
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>`).join('');

            wrap.querySelectorAll('.horizontal-scroll[data-row]').forEach(list => {
                const items = rows[list.dataset.row].items;
                list.querySelectorAll('.dashboard-card').forEach((card, i) => {
                    card.addEventListener('click', () => {
                        if (items[i].type === 'series') this.navigateToSeries(items[i]);
                        else this.navigateToMovie(items[i]);
                    });
                });
            });
            this.initScrollArrows(wrap);
        }
        wrap.querySelectorAll('[data-action="quiz"]').forEach(btn =>
            btn.addEventListener('click', () => this.openQuiz()));
    }

    /** "2024 · Series · Sci-Fi & Fantasy" */
    forYouSubtitle(item) {
        const genre = (item.genres || '').split(',')[0].trim();
        return [item.year, item.type === 'series' ? 'Series' : 'Movie', genre].filter(Boolean).join(' · ');
    }

    async openQuiz() {
        try {
            // Catalog and current answers (pre-filled when retaking)
            this.taste = await window.API.request('GET', '/home/taste');
        } catch (err) {
            console.error('[Dashboard] Quiz unavailable:', err);
            return;
        }
        TasteQuiz.open({
            catalog: this.taste.catalog,
            profile: this.taste.profile,
            onSaved: () => {
                this.forYouSignature = null;
                this.renderForYou();
                // New sports' fixtures are fetched in the background
                this.renderLiveEvents();
                clearTimeout(this.liveEventsTimer);
                this.liveEventsTimer = setTimeout(() => this.renderLiveEvents(), 20000);
            }
        });
    }

    // ===================== Filter Zones =====================

    renderFilterZones() {
        const wrap = document.getElementById('filter-zones');
        if (!wrap) return;

        wrap.innerHTML = QUICK_FILTERS.map(f =>
            `<button class="filter-chip" data-filter="${f.id}">${f.label}</button>`
        ).join('');

        wrap.querySelectorAll('.filter-chip').forEach(btn => {
            btn.addEventListener('click', () => this.selectFilter(btn.dataset.filter));
        });
    }

    updateFilterChips() {
        document.querySelectorAll('#filter-zones .filter-chip').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === this.activeFilter);
        });
    }

    /**
     * Tap a zone: run one small query per content area. Tapping the active zone
     * again clears the results.
     */
    async selectFilter(id) {
        if (!QUICK_FILTERS.some(f => f.id === id)) return;
        // Tap toggles the zone
        this.activeFilter = this.activeFilter === id ? null : id;
        this.updateFilterChips();
        await this.refreshResults();
    }

    /**
     * The active zone's results; no zone clears them. (Text search lives in the
     * sidebar, where zones are offered as scopes.)
     */
    async refreshResults() {
        const results = document.getElementById('filter-results');
        if (!results) return;

        const zone = QUICK_FILTERS.find(f => f.id === this.activeFilter);
        if (zone) {
            await this.runQuery({ ...zone }); // copy: runQuery tags it with a generation
        } else {
            this.queryGen++;
            this.filterItems = {};
            this.filterOffset = {};
            results.innerHTML = '';
        }
    }

    escapeHtml(text) {
        return escapeHtml(text);
    }

    /**
     * Run a zone or a search: one small query per content area, sequentially.
     * filter: { label, regex } for zones or { label, query } for search
     */
    async runQuery(filter) {
        const results = document.getElementById('filter-results');
        if (!results) return;

        filter.gen = ++this.queryGen;
        this.filterItems = {};
        this.filterOffset = {};

        results.innerHTML = FILTER_TYPES.map(t => `
            <section class="dashboard-section filter-results-section" id="fr-${t.type}">
                <div class="section-header">
                    <h2>${this.escapeHtml(filter.label)} &middot; ${t.label}</h2>
                </div>
                <div class="filter-grid" id="fr-list-${t.type}">
                    <div class="loading-state">
                        <div class="loading"></div>
                        <span>Searching...</span>
                    </div>
                </div>
                <div class="filter-more-wrapper hidden" id="fr-more-${t.type}">
                    <button class="filter-more-btn">Show more</button>
                </div>
            </section>
        `).join('');

        // Sequential, not parallel: three staggered small queries are gentler on
        // the box than three concurrent regex scans over 200k+ rows.
        for (const t of FILTER_TYPES) {
            if (filter.gen !== this.queryGen) return; // superseded
            this.filterOffset[t.type] = 0;
            await this.loadFilterResults(filter, t, false);
        }

        // Every area came back empty: say so instead of showing nothing
        if (filter.gen === this.queryGen &&
            FILTER_TYPES.every(t => !(this.filterItems[t.type] || []).length) &&
            !results.querySelector('.filter-error')) {
            results.innerHTML = `<div class="empty-state hint">No results for ${this.escapeHtml(filter.label)}</div>`;
        }
    }

    /**
     * How many cards fit across one row of a .filter-grid.
     *
     * The grid uses `auto-fill`, which keeps empty tracks, so the resolved
     * `grid-template-columns` is an accurate column count even before any cards
     * have been inserted.
     */
    gridColumns(el) {
        if (!el) return FALLBACK_PAGE;
        const tpl = getComputedStyle(el).gridTemplateColumns;
        if (!tpl || tpl === 'none') return FALLBACK_PAGE;
        const n = tpl.split(' ').filter(Boolean).length;
        return n > 0 ? Math.min(n, MAX_PAGE) : FALLBACK_PAGE;
    }

    /**
     * Fetch one page of results. A page is ROWS_PER_LOAD complete grid rows,
     * measured at call time, so rows always come out full and the count follows
     * the window size.
     */
    async loadFilterResults(filter, t, append) {
        const list = document.getElementById(`fr-list-${t.type}`);
        const section = document.getElementById(`fr-${t.type}`);
        const moreWrap = document.getElementById(`fr-more-${t.type}`);
        if (!list) return;

        const offset = append ? (this.filterOffset[t.type] || 0) : 0;
        const shelf = this.isShelfLayout();
        const pageSize = shelf ? SHELF_PAGE : this.gridColumns(list) * ROWS_PER_LOAD;

        try {
            const endpoint = filter.query
                ? `/search?q=${encodeURIComponent(filter.query)}` +
                  (filter.regex ? `&pattern=${encodeURIComponent(filter.regex)}` : '')
                : `/channels/search?pattern=${encodeURIComponent(filter.regex)}`;
            const settings = this.app.player?.settings || {};
            const lang = encodeURIComponent(settings.languagePriority || '');
            const hard = settings.languageHardFilter ? 1 : 0;
            const res = await window.API.request('GET',
                `${endpoint}&type=${t.type}&limit=${pageSize}&offset=${offset}&lang=${lang}&hard=${hard}`);

            // A newer zone/search replaced this one while the request was out
            if (filter.gen !== this.queryGen) return;

            const items = (res && res.items) || [];
            this.filterItems[t.type] = append
                ? (this.filterItems[t.type] || []).concat(items)
                : items;
            this.filterOffset[t.type] = offset + items.length;

            if (!append) list.innerHTML = '';

            if (items.length === 0 && !append) {
                // Hide the zone entirely when this area has no matches, rather
                // than leaving an empty shelf behind.
                section?.classList.add('hidden');
                moreWrap?.classList.add('hidden');
                return;
            }

            section?.classList.remove('hidden');
            list.insertAdjacentHTML('beforeend',
                items.map(item => this.createRecentCard(item)).join(''));
            this.attachFilterCardHandlers(list, t.type);

            if (shelf) {
                // Phones: no button - the end of the row loads the next page
                moreWrap?.classList.add('hidden');
                this.updateShelfSentinel(list, filter, t, !!(res && res.hasMore));
            } else if (res && res.hasMore) {
                moreWrap?.classList.remove('hidden');
                const btn = moreWrap?.querySelector('.filter-more-btn');
                if (btn) {
                    // Label reflects the next row's width, recomputed now that
                    // cards are in place.
                    const next = this.gridColumns(list) * ROWS_PER_LOAD;
                    btn.textContent = `Show ${next} more`;
                    btn.onclick = () => {
                        btn.disabled = true;
                        btn.textContent = 'Loading...';
                        this.loadFilterResults(filter, t, true)
                            .finally(() => { btn.disabled = false; });
                    };
                }
            } else {
                moreWrap?.classList.add('hidden');
            }
        } catch (err) {
            console.error('[Dashboard] Filter search failed:', err);
            if (filter.gen !== this.queryGen) return;
            // Phones: drop the spinner so a failed page doesn't look like it's still loading
            list.querySelector('.filter-shelf-sentinel')?.remove();
            if (!append) {
                list.innerHTML = `<div class="empty-state hint filter-error">${this.escapeHtml(err.message || 'Search failed')}</div>`;
            }
        }
    }

    isShelfLayout() {
        return !!window.matchMedia?.(SHELF_QUERY).matches;
    }

    /**
     * Phones: a marker (with a spinner) at the end of the row loads the next
     * page when it scrolls into view - slightly early, so it is usually ready
     * by the time the row actually ends
     */
    updateShelfSentinel(list, filter, t, hasMore) {
        list.querySelector('.filter-shelf-sentinel')?.remove();
        if (!hasMore) return;

        const sentinel = document.createElement('div');
        sentinel.className = 'filter-shelf-sentinel';
        sentinel.innerHTML = '<div class="loading-spinner"></div>';
        list.appendChild(sentinel);

        const observer = new IntersectionObserver(entries => {
            if (!entries.some(e => e.isIntersecting)) return;
            observer.disconnect();
            if (filter.gen !== this.queryGen) return; // a newer zone/search replaced this
            this.loadFilterResults(filter, t, true);
        }, { root: list, rootMargin: '0px 300px 0px 0px' });
        observer.observe(sentinel);
    }

    attachFilterCardHandlers(list, type) {
        list.querySelectorAll('.dashboard-card').forEach(card => {
            if (card.dataset.bound) return;
            card.dataset.bound = '1';
            card.addEventListener('click', () => {
                const item = (this.filterItems[type] || [])
                    .find(i => String(i.item_id) === String(card.dataset.id));
                if (!item) return;
                if (type === 'series') this.navigateToSeries(item);
                else if (type === 'movie') this.navigateToMovie(item);
                else this.playLiveItem(item);
            });
        });
    }

    /**
     * Play a live channel from a filter result. The search API returns the raw
     * `playlist_items.item_id` (e.g. "1904231"); the server resolves it to the
     * channel ChannelList expects (id "xtream_2_1904231"), so the channel list
     * doesn't have to be loaded first.
     */
    async playLiveItem(item) {
        let channel;
        try {
            channel = await window.API.live.channel(item.source_id, item.item_id);
        } catch (err) {
            console.warn('[Dashboard] Live channel not found:', item.source_id, item.item_id, item.name, err);
            return;
        }
        this.playChannel(channel);
    }
}
