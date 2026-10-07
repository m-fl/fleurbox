/**
 * Taste quiz: a three-step modal (genres, motifs, format/era/mood) whose
 * answers are saved per user (PUT /api/home/taste) and drive Home's
 * "For You" rows. The choices come from the server (services/taste.js
 * CATALOG), so the quiz itself holds no lists.
 *
 * Usage: TasteQuiz.open({ catalog, profile, onSaved(profile) })
 */
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
            mood: profile?.mood || 'popular'
        };
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
        if (step < 0 || step > 2) return;
        const forward = step > this.step;
        this.step = step;
        this.render(forward ? 'from-right' : 'from-left');
    }

    next() {
        if (this.step < 2) return this.go(this.step + 1);
        this.save();
    }

    render(direction = 'from-right') {
        const body = this.el.querySelector('.quiz-body');
        const { limits } = this.catalog;
        const steps = [
            () => `
                <p class="quiz-kicker">Step 1 of 3</p>
                <h2 id="quiz-title">What are you in the mood for?</h2>
                <p class="quiz-sub">Pick up to ${limits.genres}. Your rows are built from these.</p>
                <div class="quiz-tiles">
                    ${this.catalog.genres.map(g => `
                        <button class="quiz-tile" data-kind="genres" data-id="${g.id}">
                            <span class="quiz-tile-emoji">${g.emoji || ''}</span>
                            <span class="quiz-tile-label">${TasteQuiz.escape(g.label)}</span>
                            <span class="quiz-tile-order"></span>
                        </button>`).join('')}
                </div>`,
            () => `
                <p class="quiz-kicker">Step 2 of 3</p>
                <h2 id="quiz-title">Any stories you can't resist?</h2>
                <p class="quiz-sub">Optional &middot; up to ${limits.motifs}. Each becomes a "Because you're into..." row.</p>
                <div class="quiz-chips">
                    ${this.catalog.motifs.map(m => `
                        <button class="quiz-chip" data-kind="motifs" data-id="${m.id}">${TasteQuiz.escape(m.label)}</button>`).join('')}
                </div>`,
            () => `
                <p class="quiz-kicker">Step 3 of 3</p>
                <h2 id="quiz-title">Fine-tune it</h2>
                <p class="quiz-sub">Shapes every row. You can change these later.</p>
                ${this.segmented('Movies or series?', 'format', this.catalog.formats)}
                ${this.segmented('From which era?', 'era', this.catalog.eras)}
                ${this.segmented('Popular or acclaimed?', 'mood', this.catalog.moods)}`
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
        this.refresh();
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
        else if (list.length < this.catalog.limits[kind]) list.push(id);
        else {
            // Full: nudge the counter instead of silently ignoring the tap
            const count = this.el.querySelector('.quiz-count');
            count.classList.remove('shake');
            void count.offsetWidth;
            count.classList.add('shake');
            return;
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

        const kind = ['genres', 'motifs', null][this.step];
        this.el.querySelector('.quiz-count').textContent = kind
            ? `${this.answers[kind].length} / ${this.catalog.limits[kind]} picked` : '';
        this.el.querySelector('.quiz-progress-bar').style.width = `${((this.step + 1) / 3) * 100}%`;
        this.el.querySelector('.quiz-back').style.visibility = this.step === 0 ? 'hidden' : 'visible';

        const next = this.el.querySelector('.quiz-next');
        next.disabled = this.step === 0 && this.answers.genres.length === 0;
        next.textContent = this.step === 2 ? 'Build my rows'
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
