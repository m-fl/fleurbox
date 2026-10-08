/**
 * Event page: one live event (a Home "Live Events" card) with the channels
 * showing it. The same channel is often filed in several categories, so
 * channels with the same name are one row; a row with copies gets a picker
 * for which one to play. Rows are grouped by the country/language prefix
 * of the channel name ("US", "UK", "DE"...), in the server's order, which
 * puts the Language Priority channels first.
 *
 * URL: #event/<event id>. Opened directly (reload, pasted link) the event is
 * looked up in GET /api/live/events; one that is over or unknown goes Home.
 */
class EventPage {
    constructor(app) {
        this.app = app;
        this.event = null;
        this.from = 'home';  // page the Back button returns to
        this.rows = [];      // [{ name, copies: [channel], picked }]
        this.gen = 0;        // bumped per render; stale "now playing" replies are dropped
    }

    get routeHash() {
        return this.event ? `event/${encodeURIComponent(this.event.id)}` : 'event';
    }

    /** Open an event object as GET /api/live/events returns it */
    open(event, from = this.app.currentPage) {
        this.event = event;
        this.from = from && from !== 'event' ? from : 'home';
        if (this.app.currentPage === 'event') {
            history.replaceState({ page: 'event' }, '', `#${this.routeHash}`);
            this.render();
        } else {
            this.app.navigateTo('event');
        }
    }

    /** #event/<id> typed, reloaded or reached with Back/Forward. Resolves false if not found. */
    async openFromRoute(route) {
        const id = decodeURIComponent(route.join('/'));
        if (this.event?.id === id) {
            this.app.navigateTo('event', true);
            return true;
        }
        let events = [];
        try {
            events = await API.live.events(60);
        } catch (err) {
            console.warn('[Event] Events unavailable:', err);
        }
        const event = events.find(e => e.id === id);
        if (!event) return false;
        this.event = event;
        this.from = 'home';
        this.app.navigateTo('event', true);
        return true;
    }

    show() {
        if (!this.event) {
            this.app.navigateTo('home', true);
            return;
        }
        this.render();
    }

    hide() {
        this.gen++;
    }

    static esc(text) {
        return ContentDetails.escape(text);
    }

    /**
     * Same channel, other copy: "ESPN 2 HD" / "ESPN 2" and "BEIN SPORTS 2
     * ENGLISH ᴿᴬᵂ" / "... SD" differ only in punctuation and quality tags
     * (NFKC turns the superscript tags into plain letters)
     */
    static channelKey(name) {
        return String(name || '').normalize('NFKC').toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .split(' ')
            .filter(w => w && !EventPage.QUALITY.has(w))
            .join(' ');
    }

    /** "US: ESPN 2 HD", "CA EN: CTV" -> "ESPN 2 HD", "CTV" (the group heading names the country) */
    static cleanName(name) {
        return String(name || 'Unknown').replace(/^[A-Z0-9]{2,4}(?:[- ][A-Z]{2,3})?\s*[:|-]\s*/, '');
    }

    /**
     * Country heading for a channel: the category's prefix ("UK| SPORT"), else
     * the name's ("SI: ARENA SPORT"). The category wins because some names
     * carry a tier instead ("VIP: SKY SPORTS ACTION" in "UK| SPORT VIP").
     */
    static country(ch) {
        return LanguagePriority.prefixCode(ch.groupTitle) || LanguagePriority.prefixCode(ch.name) || 'Other';
    }

    /**
     * Channels -> groups of rows. The same channel in one country becomes one
     * row (its copies); groups and rows keep the order the server sent.
     */
    group(channels) {
        const rows = new Map();
        channels.forEach(ch => {
            const country = EventPage.country(ch);
            const key = `${country} ${EventPage.channelKey(EventPage.cleanName(ch.name))}`;
            if (!rows.has(key)) rows.set(key, { name: ch.name, country, copies: [], picked: 0 });
            rows.get(key).copies.push(ch);
        });
        this.rows = [...rows.values()];

        const groups = new Map();
        this.rows.forEach((row, index) => {
            const label = row.country;
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label).push(index);
        });
        return groups;
    }

    render() {
        const page = document.getElementById('page-event');
        const event = this.event;
        if (!page || !event) return;
        const gen = ++this.gen;
        const esc = EventPage.esc;

        const logo = side => side?.logo
            ? `<img src="${esc(API.imageUrl(side.logo))}" alt="" data-fallback="hide">`
            : `<span class="event-initials">${esc((side?.short || side?.name || '?').slice(0, 3))}</span>`;
        const team = side => `
            <div class="event-team">
                ${logo(side)}
                <span class="event-team-name">${esc(side?.name || side?.short || '')}</span>
            </div>`;
        const sides = event.home && event.away
            ? `<div class="event-hero-sides">${team(event.away)}<span class="event-vs">vs</span>${team(event.home)}</div>`
            : `<div class="event-hero-sides event-sides-text">${esc(event.competition || event.title)}</div>`;
        const when = event.live
            ? '<span class="card-badge event-live">LIVE</span>'
            : `<span class="event-hero-when">${esc(HomePage.eventTime(event.start, event.timeTbd))}</span>`;
        const kicker = [event.competition, event.note].filter(Boolean).join(' · ');

        const groups = this.group(event.channels || []);
        const count = this.rows.length;
        const body = count ? [...groups.entries()].map(([label, indexes]) => `
                <section class="event-channel-group">
                    <h4 class="event-channel-group-label">${esc(label)} <span>${indexes.length}</span></h4>
                    <div class="event-channel-list">${indexes.map(i => this.rowHtml(i)).join('')}</div>
                </section>`).join('')
            : `<div class="event-empty">
                    <p>Your guide doesn't list this game yet.</p>
                    <small>Channels appear here once their programme guide covers it.</small>
               </div>`;

        page.innerHTML = `
            <div class="event-container">
                <button class="series-back-btn event-back-btn">← Back to ${esc(this.backLabel())}</button>
                <header class="event-hero ${event.live ? 'is-live' : ''}">
                    ${kicker ? `<div class="event-hero-kicker">${esc(kicker)}</div>` : ''}
                    ${sides}
                    <h2 class="event-hero-title">${esc(event.title)} ${event.favourite ? '<span class="event-hero-fav" title="Your team">&#9733;</span>' : ''}</h2>
                    <div class="event-hero-meta">
                        ${when}
                        ${event.programme ? `<span class="event-hero-programme" title="As listed in the guide">${esc(event.programme)}</span>` : ''}
                    </div>
                </header>
                <div class="event-channels">
                    <h3 class="event-channels-title">Watch on ${count ? `<span>${count} channel${count === 1 ? '' : 's'}</span>` : ''}</h3>
                    ${body}
                </div>
            </div>`;

        page.querySelector('.event-back-btn').addEventListener('click', () => this.app.navigateTo(this.from));
        page.querySelectorAll('.event-channel').forEach(el => {
            const row = this.rows[el.dataset.index];
            el.addEventListener('click', (e) => {
                if (e.target.closest('select')) return;
                this.app.pages.home.playChannel(row.copies[row.picked]);
            });
            el.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
                    e.preventDefault();
                    this.app.pages.home.playChannel(row.copies[row.picked]);
                }
            });
            el.querySelector('select')?.addEventListener('change', (e) => {
                row.picked = parseInt(e.target.value, 10) || 0;
                const ch = row.copies[row.picked];
                el.querySelector('.event-channel-name').textContent = EventPage.cleanName(ch.name);
                el.querySelector('.event-channel-logo img').src = ch.tvgLogo ? API.imageUrl(ch.tvgLogo) : '/img/placeholder.png';
                el.title = `Watch ${ch.name}`;
                this.refreshNow(gen, [el.dataset.index]);
            });
        });

        this.refreshNow(gen);
    }

    backLabel() {
        return { home: 'Home', live: 'Live TV', guide: 'Guide' }[this.from] || 'Home';
    }

    rowHtml(index) {
        const esc = EventPage.esc;
        const row = this.rows[index];
        const ch = row.copies[row.picked];
        const logo = ch.tvgLogo ? API.imageUrl(ch.tvgLogo) : '/img/placeholder.png';
        const picker = row.copies.length > 1 ? `
            <label class="event-channel-source" title="This channel is in ${row.copies.length} categories">
                <span>Source</span>
                <select class="source-select">
                    ${row.copies.map((c, i) => `<option value="${i}" ${i === row.picked ? 'selected' : ''}>${
                        esc([EventPage.cleanName(c.name), c.groupTitle].filter(Boolean).join(' · '))}</option>`).join('')}
                </select>
            </label>` : `<span class="event-channel-category">${esc(ch.groupTitle || '')}</span>`;
        return `
            <div class="event-channel" data-index="${index}" role="button" tabindex="0" title="Watch ${esc(ch.name)}">
                <span class="event-channel-logo">
                    <img src="${esc(logo)}" alt="" loading="lazy" data-fallback="/img/placeholder.png">
                </span>
                <span class="event-channel-text">
                    <span class="event-channel-name">${esc(EventPage.cleanName(ch.name))}</span>
                    <span class="event-channel-now" data-now="${index}">&nbsp;</span>
                    ${picker}
                </span>
                <span class="event-channel-play" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </span>
            </div>`;
    }

    /** What's on now, for each row's picked copy (or just `only` row indexes) */
    async refreshNow(gen, only = null) {
        const indexes = only ? only.map(Number) : this.rows.map((_, i) => i);
        if (!indexes.length) return;
        let now = [];
        try {
            now = await API.live.now(indexes.map(i => {
                const ch = this.rows[i].copies[this.rows[i].picked];
                return { tvgId: ch.tvgId, name: ch.name };
            }));
        } catch (err) {
            console.warn('[Event] Now playing unavailable:', err);
            return;
        }
        if (gen !== this.gen) return;
        indexes.forEach((rowIndex, i) => {
            const el = document.querySelector(`#page-event [data-now="${rowIndex}"]`);
            const cur = now?.[i]?.current;
            if (el) el.textContent = cur ? `Now: ${cur.title}` : '';
        });
    }
}

// Quality / feed tags left out when telling channels apart (see channelKey)
EventPage.QUALITY = new Set(['hd', 'fhd', 'uhd', 'sd', 'raw', '4k', '8k', 'hevc', 'h265', 'h264',
    '1080p', '720p', '2160p', '3840p', '50fps', '60fps', 'backup', 'alt']);

window.EventPage = EventPage;
