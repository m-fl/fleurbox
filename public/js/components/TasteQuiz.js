/**
 * Taste quiz: a four-step modal (genres, motifs, format/era/mood, sports)
 * whose answers are saved per user (PUT /api/home/taste) and drive Home's
 * "For You" rows and the Live Events ranking. The choices come from the
 * server (services/taste.js CATALOG), so the quiz itself holds no lists;
 * teams load from GET /api/home/sports/teams for the picked sports/regions.
 *
 * Usage: TasteQuiz.open({ catalog, profile, onSaved(profile) })
 */
const QUIZ_STEPS = 4;
// Team results shown at once (type to narrow down)
const TEAM_RESULTS = 40;

class TasteQuiz {
    static open(opts) {
        new TasteQuiz(opts).show();
    }

    constructor({ catalog, profile, onSaved }) {
        this.catalog = catalog;
        this.onSaved = onSaved;
        this.step = 0;
        this.answers = {
            genres: [...(profile?.genres || [])],
            motifs: [...(profile?.motifs || [])],
            format: profile?.format || 'both',
            era: profile?.era || 'any',
            mood: profile?.mood || 'popular',
            sports: [...(profile?.sports || [])],
            regions: [...(profile?.regions || [])],
            teams: [...(profile?.teams || [])]
        };
        // key -> { key, name, short, logo } for picked teams and loaded results
        this.teamInfo = new Map((profile?.teamInfo || []).filter(Boolean).map(t => [t.key, t]));
        this.teamList = [];
        this.teamQuery = '';
        this.onKey = this.onKey.bind(this);
    }

    static escape(text) {
        const div = document.createElement('div');
        div.textContent = text ?? '';
        return div.innerHTML;
    }

    show() {
        this.el = document.createElement('div');
        this.el.className = 'quiz-backdrop';
        this.el.innerHTML = `
            <div class="quiz-modal" role="dialog" aria-modal="true" aria-labelledby="quiz-title">
                <div class="quiz-progress"><div class="quiz-progress-bar"></div></div>
                <button class="quiz-close" aria-label="Close">&times;</button>
                <div class="quiz-body"></div>
                <div class="quiz-footer">
                    <button class="btn btn-ghost quiz-back">Back</button>
                    <span class="quiz-count"></span>
                    <button class="btn btn-primary quiz-next">Next</button>
                </div>
            </div>
        `;
        document.body.appendChild(this.el);
        requestAnimationFrame(() => this.el.classList.add('open'));

        this.el.addEventListener('click', e => { if (e.target === this.el) this.close(); });
        this.el.querySelector('.quiz-close').addEventListener('click', () => this.close());
        this.el.querySelector('.quiz-back').addEventListener('click', () => this.go(this.step - 1));
        this.el.querySelector('.quiz-next').addEventListener('click', () => this.next());
        document.addEventListener('keydown', this.onKey);
        this.render();
    }

    onKey(e) {
        if (e.key === 'Escape') this.close();
    }

    close() {
        document.removeEventListener('keydown', this.onKey);
        this.el.classList.remove('open');
        setTimeout(() => this.el.remove(), 250);
    }

    go(step) {
        if (step < 0 || step >= QUIZ_STEPS) return;
        const forward = step > this.step;
        this.step = step;
        this.render(forward ? 'from-right' : 'from-left');
    }

    next() {
        if (this.step < QUIZ_STEPS - 1) return this.go(this.step + 1);
        this.save();
    }

    render(direction = 'from-right') {
        const body = this.el.querySelector('.quiz-body');
        const { limits } = this.catalog;
        const steps = [
            () => `
                <p class="quiz-kicker">Step 1 of ${QUIZ_STEPS}</p>
                <h2 id="quiz-title">What are you in the mood for?</h2>
                <p class="quiz-sub">Pick up to ${limits.genres}. Your rows are built from these.</p>
                <div class="quiz-tiles">
                    ${this.catalog.genres.map(g => `
                        <button class="quiz-tile" data-kind="genres" data-id="${g.id}">
                            <span class="quiz-tile-icon">${Icons.line(g.icon)}</span>
                            <span class="quiz-tile-label">${TasteQuiz.escape(g.label)}</span>
                            <span class="quiz-tile-order"></span>
                        </button>`).join('')}
                </div>`,
            () => `
                <p class="quiz-kicker">Step 2 of ${QUIZ_STEPS}</p>
                <h2 id="quiz-title">Any stories you can't resist?</h2>
                <p class="quiz-sub">Optional &middot; up to ${limits.motifs}. Each becomes a "Because you're into..." row.</p>
                <div class="quiz-chips">
                    ${this.catalog.motifs.map(m => `
                        <button class="quiz-chip" data-kind="motifs" data-id="${m.id}">${TasteQuiz.escape(m.label)}</button>`).join('')}
                </div>`,
            () => `
                <p class="quiz-kicker">Step 3 of ${QUIZ_STEPS}</p>
                <h2 id="quiz-title">Fine-tune it</h2>
                <p class="quiz-sub">Shapes every row. You can change these later.</p>
                ${this.segmented('Movies or series?', 'format', this.catalog.formats)}
                ${this.segmented('From which era?', 'era', this.catalog.eras)}
                ${this.segmented('Popular or acclaimed?', 'mood', this.catalog.moods)}`,
            () => `
                <p class="quiz-kicker">Step 4 of ${QUIZ_STEPS}</p>
                <h2 id="quiz-title">Sports fan?</h2>
                <p class="quiz-sub">Optional. Your teams and leagues lead the Live Events row on Home and in Live TV.</p>
                <div class="quiz-field">
                    <div class="quiz-field-label">Which sports?</div>
                    <div class="quiz-chips">
                        ${this.catalog.sports.map(sp => `
                            <button class="quiz-chip" data-kind="sports" data-id="${sp.id}">${TasteQuiz.escape(sp.label)}</button>`).join('')}
                    </div>
                </div>
                <div class="quiz-field quiz-sports-more">
                    <div class="quiz-field-label">Where do you follow them? <span class="quiz-field-hint">Add as many as you like &middot; none picks the biggest leagues</span></div>
                    <div class="quiz-chips quiz-regions"></div>
                </div>
                <div class="quiz-field quiz-sports-more">
                    <div class="quiz-field-label">Your teams <span class="quiz-field-hint">Up to ${limits.teams} &middot; their games always come first</span></div>
                    <div class="quiz-chips quiz-team-picked"></div>
                    <input type="search" class="quiz-team-search" placeholder="Search teams..." autocomplete="off" value="${TasteQuiz.escape(this.teamQuery)}">
                    <div class="quiz-chips quiz-team-results"></div>
                </div>`
        ];

        body.innerHTML = `<div class="quiz-step ${direction}">${steps[this.step]()}</div>`;

        body.querySelectorAll('[data-kind]').forEach(btn => {
            btn.addEventListener('click', () => this.toggle(btn.dataset.kind, btn.dataset.id));
        });
        body.querySelectorAll('.quiz-seg button').forEach(btn => {
            btn.addEventListener('click', () => {
                this.answers[btn.dataset.field] = btn.dataset.id;
                this.refresh();
            });
        });
        const search = body.querySelector('.quiz-team-search');
        if (search) {
            search.addEventListener('input', () => {
                this.teamQuery = search.value;
                this.renderTeams();
            });
            this.renderSportsMore();
            this.loadTeams();
        }
        this.refresh();
    }

    /** Regions for the picked sports; the region/team fields show once a sport is picked */
    renderSportsMore() {
        const body = this.el.querySelector('.quiz-body');
        const { sports } = this.answers;
        body.querySelectorAll('.quiz-sports-more').forEach(f => f.classList.toggle('hidden', sports.length === 0));

        const relevant = new Set(sports.flatMap(id => this.catalog.sportRegions?.[id] || []));
        // Regions no picked sport has leagues in mean nothing any more
        this.answers.regions = this.answers.regions.filter(id => relevant.has(id));
        const regions = body.querySelector('.quiz-regions');
        regions.innerHTML = this.catalog.regions.filter(r => relevant.has(r.id)).map(r => `
            <button class="quiz-chip" data-kind="regions" data-id="${r.id}">${TasteQuiz.escape(r.label)}</button>`).join('');
        regions.closest('.quiz-field').classList.toggle('hidden', sports.length === 0 || relevant.size === 0);
        regions.querySelectorAll('[data-kind]').forEach(btn => {
            btn.addEventListener('click', () => this.toggle(btn.dataset.kind, btn.dataset.id));
        });
    }

    /** Teams of the picked sports/regions (the server fetches lists it hasn't got yet) */
    async loadTeams() {
        const results = this.el.querySelector('.quiz-team-results');
        if (!results) return;
        const { sports, regions } = this.answers;
        const gen = this.teamGen = (this.teamGen || 0) + 1;
        if (!sports.length) {
            this.teamList = [];
            return this.renderTeams();
        }
        results.innerHTML = '<span class="quiz-field-hint">Loading teams...</span>';
        try {
            const query = new URLSearchParams({ sports: sports.join(','), regions: regions.join(',') });
            const list = await API.request('GET', `/home/sports/teams?${query}`);
            if (gen !== this.teamGen) return; // picks changed meanwhile
            this.teamList = list;
            list.forEach(t => { if (!this.teamInfo.has(t.key)) this.teamInfo.set(t.key, t); });
        } catch (err) {
            console.warn('[Quiz] Teams unavailable:', err);
            if (gen !== this.teamGen) return;
            this.teamList = [];
        }
        this.renderTeams();
    }

    renderTeams() {
        const picked = this.el.querySelector('.quiz-team-picked');
        const results = this.el.querySelector('.quiz-team-results');
        if (!picked || !results) return;
        const chip = (t, selected) => `
            <button class="quiz-chip quiz-team ${selected ? 'selected' : ''}" data-team="${TasteQuiz.escape(t.key)}" title="${TasteQuiz.escape(t.league || '')}">
                ${t.logo ? `<img src="${API.imageUrl(t.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
                <span>${TasteQuiz.escape(t.name)}</span>${selected ? '<span class="quiz-team-x">&times;</span>' : ''}
            </button>`;

        picked.innerHTML = this.answers.teams.map(k => this.teamInfo.get(k)).filter(Boolean).map(t => chip(t, true)).join('');

        const fold = text => (text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const q = fold(this.teamQuery.trim());
        const matches = this.teamList.filter(t => !this.answers.teams.includes(t.key) &&
            (!q || fold(t.name).includes(q) || fold(t.short).includes(q)));
        results.innerHTML = matches.slice(0, TEAM_RESULTS).map(t => chip(t, false)).join('') +
            (matches.length > TEAM_RESULTS ? `<span class="quiz-field-hint">+${matches.length - TEAM_RESULTS} more &middot; type to search</span>` : '') +
            (!matches.length && this.answers.sports.length ? `<span class="quiz-field-hint">${q ? 'No teams match' : 'No teams for these picks'}</span>` : '');

        this.el.querySelectorAll('[data-team]').forEach(btn => {
            btn.addEventListener('click', () => this.toggleTeam(btn.dataset.team));
        });
        this.refresh();
    }

    toggleTeam(key) {
        const list = this.answers.teams;
        const at = list.indexOf(key);
        if (at >= 0) list.splice(at, 1);
        else if (list.length < this.catalog.limits.teams) list.push(key);
        else return this.nudgeCount();
        this.renderTeams();
    }

    nudgeCount() {
        const count = this.el.querySelector('.quiz-count');
        count.classList.remove('shake');
        void count.offsetWidth;
        count.classList.add('shake');
    }

    segmented(title, field, options) {
        return `
            <div class="quiz-field">
                <div class="quiz-field-label">${title}</div>
                <div class="quiz-seg">
                    ${options.map(o => `<button data-field="${field}" data-id="${o.id}">${TasteQuiz.escape(o.label)}</button>`).join('')}
                </div>
            </div>`;
    }

    toggle(kind, id) {
        const list = this.answers[kind];
        const at = list.indexOf(id);
        if (at >= 0) list.splice(at, 1);
        else if (list.length < (this.catalog.limits[kind] ?? Infinity)) list.push(id);
        else return this.nudgeCount(); // full: nudge the counter instead of silently ignoring the tap
        if (kind === 'sports' || kind === 'regions') {
            if (kind === 'sports') this.renderSportsMore();
            this.loadTeams();
        }
        this.refresh();
    }

    /** Selection state, counter, progress and button labels for the current step */
    refresh() {
        const body = this.el.querySelector('.quiz-body');
        body.querySelectorAll('[data-kind]').forEach(btn => {
            const at = this.answers[btn.dataset.kind].indexOf(btn.dataset.id);
            btn.classList.toggle('selected', at >= 0);
            const order = btn.querySelector('.quiz-tile-order');
            if (order) order.textContent = at >= 0 ? at + 1 : '';
        });
        body.querySelectorAll('.quiz-seg button').forEach(btn => {
            btn.classList.toggle('selected', this.answers[btn.dataset.field] === btn.dataset.id);
        });

        const kind = ['genres', 'motifs', null, 'teams'][this.step];
        this.el.querySelector('.quiz-count').textContent = !kind ? ''
            : kind === 'teams' ? (this.answers.sports.length ? `${this.answers.teams.length} / ${this.catalog.limits.teams} teams` : '')
            : `${this.answers[kind].length} / ${this.catalog.limits[kind]} picked`;
        this.el.querySelector('.quiz-progress-bar').style.width = `${((this.step + 1) / QUIZ_STEPS) * 100}%`;
        this.el.querySelector('.quiz-back').style.visibility = this.step === 0 ? 'hidden' : 'visible';

        const next = this.el.querySelector('.quiz-next');
        next.disabled = this.step === 0 && this.answers.genres.length === 0;
        next.textContent = this.step === QUIZ_STEPS - 1 ? 'Build my rows'
            : this.step === 1 && this.answers.motifs.length === 0 ? 'Skip' : 'Next';
    }

    async save() {
        const next = this.el.querySelector('.quiz-next');
        next.disabled = true;
        next.textContent = 'Saving...';
        try {
            const { profile } = await API.request('PUT', '/home/taste', this.answers);
            this.el.querySelector('.quiz-body').innerHTML = `
                <div class="quiz-step quiz-done from-right">
                    <div class="quiz-done-mark">${Icons.check || '&#10003;'}</div>
                    <h2>Your rows are ready</h2>
                    <p class="quiz-sub">Retake the quiz any time from Home.</p>
                </div>`;
            this.el.querySelector('.quiz-footer').classList.add('hidden');
            this.onSaved?.(profile);
            setTimeout(() => this.close(), 1100);
        } catch (err) {
            console.error('[Quiz] Save failed:', err);
            next.disabled = false;
            next.textContent = 'Try again';
        }
    }
}

window.TasteQuiz = TasteQuiz;
