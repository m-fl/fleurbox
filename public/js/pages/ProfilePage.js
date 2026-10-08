/**
 * Profile page: the signed-in user's own corner, for every role (viewers
 * can't open Settings). Shows who they are, their taste-quiz picks with
 * Retake / Clear, and appearance preferences (GET/PUT /api/profile).
 *
 * Appearance is applied as data- attributes on <html> (styled in
 * css/main.css) and mirrored to localStorage, so index.html can set them
 * before the first paint on the next load.
 */
const APPEARANCE_KEY = 'fleurbox_appearance';
const APPEARANCE_ATTRS = { accent: 'accent', textSize: 'textSize', motion: 'motion' };

class ProfilePage {
    constructor(app) {
        this.app = app;
        this.profile = null; // { user, appearance, preferences }
        this.taste = null;   // { catalog, profile }
        this.confirmingClear = false;
    }

    /** Set the preferences on <html> and remember them for the next page load */
    static applyAppearance(preferences) {
        const root = document.documentElement;
        Object.entries(APPEARANCE_ATTRS).forEach(([key, attr]) => {
            if (preferences?.[key]) root.dataset[attr] = preferences[key];
        });
        try {
            localStorage.setItem(APPEARANCE_KEY, JSON.stringify(preferences || {}));
        } catch { /* private mode: only this load is styled */ }
    }

    /** Called once after sign-in: the saved preferences may differ from the cached ones */
    static async loadAppearance() {
        try {
            const { preferences } = await API.request('GET', '/profile');
            ProfilePage.applyAppearance(preferences);
        } catch (err) {
            console.warn('[Profile] Appearance unavailable:', err);
        }
    }

    static escape(text) {
        return escapeHtml(text);
    }

    async show() {
        const page = document.getElementById('page-profile');
        if (!page) return;
        if (!this.profile) page.innerHTML = '<div class="loading-state">Loading profile...</div>';
        try {
            [this.profile, this.taste] = await Promise.all([
                API.request('GET', '/profile'),
                API.request('GET', '/home/taste')
            ]);
        } catch (err) {
            console.error('[Profile] Load failed:', err);
            page.innerHTML = '<div class="empty-state"><p>Profile unavailable</p></div>';
            return;
        }
        this.confirmingClear = false;
        this.render();
    }

    hide() { }

    render() {
        const page = document.getElementById('page-profile');
        const { user } = this.profile;
        const esc = ProfilePage.escape;
        page.innerHTML = `
            <div class="profile-container">
                <section class="profile-hero">
                    <div class="profile-avatar" aria-hidden="true">${esc((user.username || '?').slice(0, 1).toUpperCase())}</div>
                    <div class="profile-who">
                        <h2>${esc(user.username)}</h2>
                        <span class="user-badge ${user.role === 'admin' ? 'user-badge-admin' : 'user-badge-local'}">${esc(user.role)}</span>
                    </div>
                    <button class="btn btn-ghost profile-signout" data-action="signout">Sign out</button>
                </section>

                <section class="profile-card">
                    <div class="profile-card-head">
                        <div>
                            <h3>Your taste</h3>
                            <p class="hint">Shapes the For You rows and Live Events on Home.</p>
                        </div>
                        <div class="profile-card-actions">
                            ${this.taste.profile ? `<button class="btn btn-ghost" data-action="clear">${this.confirmingClear ? 'Click again to clear' : 'Clear picks'}</button>` : ''}
                            <button class="btn btn-primary" data-action="quiz">${this.taste.profile ? 'Retake quiz' : 'Take the quiz'}</button>
                        </div>
                    </div>
                    ${this.tasteSummary()}
                </section>

                <section class="profile-card">
                    <div class="profile-card-head">
                        <div>
                            <h3>Appearance</h3>
                            <p class="hint">Saved to your account, so it follows you to other devices.</p>
                        </div>
                    </div>
                    ${this.appearanceFields()}
                </section>
            </div>`;

        page.querySelector('[data-action="quiz"]').addEventListener('click', () => this.openQuiz());
        page.querySelector('[data-action="clear"]')?.addEventListener('click', () => this.clearTaste());
        page.querySelector('[data-action="signout"]').addEventListener('click', () => {
            document.getElementById('logout-btn')?.click();
        });
        page.querySelectorAll('.profile-option').forEach(btn => {
            btn.addEventListener('click', () => this.setPreference(btn.dataset.key, btn.dataset.id));
        });
    }

    /** The quiz answers as labelled chip groups */
    tasteSummary() {
        const { catalog, profile } = this.taste;
        if (!profile) {
            return '<p class="profile-empty">No picks yet. The quiz takes about 30 seconds.</p>';
        }
        const esc = ProfilePage.escape;
        const labels = (list, ids) => ids.map(id => list.find(o => o.id === id)?.label).filter(Boolean);
        const chips = items => items.map(t => `<span class="profile-chip">${esc(t)}</span>`).join('');
        const groups = [
            ['Genres', labels(catalog.genres, profile.genres)],
            ['Stories', labels(catalog.motifs, profile.motifs)],
            ['Fine-tuning', [
                ...labels(catalog.formats, [profile.format]),
                ...labels(catalog.eras, [profile.era]),
                ...labels(catalog.moods, [profile.mood])
            ]],
            ['Sports', labels(catalog.sports || [], profile.sports || [])],
            ['Levels', labels(Object.values(catalog.divisions || {}).flat(), profile.divisions || [])],
            ['Regions', labels(catalog.regions || [], profile.regions || [])]
        ].filter(([, items]) => items.length);

        const teams = (profile.teamInfo || []).filter(Boolean);
        const teamHtml = teams.length ? `
            <div class="profile-group">
                <div class="profile-group-label">Teams</div>
                <div class="profile-chips">${teams.map(t => `
                    <span class="profile-chip">
                        ${t.logo ? `<img src="${ProfilePage.escape(API.imageUrl(t.logo))}" alt="" loading="lazy" data-fallback="remove">` : ''}
                        ${esc(t.name)}
                    </span>`).join('')}</div>
            </div>` : '';

        return groups.map(([label, items]) => `
            <div class="profile-group">
                <div class="profile-group-label">${label}</div>
                <div class="profile-chips">${chips(items)}</div>
            </div>`).join('') + teamHtml;
    }

    appearanceFields() {
        const { appearance, preferences } = this.profile;
        const esc = ProfilePage.escape;
        return Object.entries(appearance).map(([key, spec]) => `
            <div class="profile-field">
                <div class="profile-group-label">${esc(spec.label)}</div>
                <div class="profile-options ${key === 'accent' ? 'profile-swatches' : 'quiz-seg'}" role="radiogroup" aria-label="${esc(spec.label)}">
                    ${spec.options.map(o => `
                        <button class="profile-option ${preferences[key] === o.id ? 'selected' : ''}" role="radio"
                                aria-checked="${preferences[key] === o.id}" data-key="${key}" data-id="${o.id}">
                            ${o.swatch ? `<span class="profile-swatch" style="--swatch:${o.swatch}"></span>` : ''}
                            <span>${esc(o.label)}</span>
                        </button>`).join('')}
                </div>
            </div>`).join('');
    }

    /** Apply right away, then save; a failed save is put back */
    async setPreference(key, id) {
        const before = { ...this.profile.preferences };
        if (before[key] === id) return;
        this.profile.preferences = { ...before, [key]: id };
        ProfilePage.applyAppearance(this.profile.preferences);
        this.render();
        try {
            const { preferences } = await API.request('PUT', '/profile/preferences', { [key]: id });
            this.profile.preferences = preferences;
        } catch (err) {
            console.error('[Profile] Saving preference failed:', err);
            this.profile.preferences = before;
            ProfilePage.applyAppearance(before);
            this.render();
        }
    }

    openQuiz() {
        TasteQuiz.open({
            catalog: this.taste.catalog,
            profile: this.taste.profile,
            onSaved: profile => {
                this.taste.profile = profile;
                this.render();
            }
        });
    }

    async clearTaste() {
        if (!this.confirmingClear) {
            this.confirmingClear = true;
            this.render();
            return;
        }
        try {
            await API.request('DELETE', '/home/taste');
            this.taste.profile = null;
        } catch (err) {
            console.error('[Profile] Clearing taste failed:', err);
        }
        this.confirmingClear = false;
        this.render();
    }
}

window.ProfilePage = ProfilePage;
