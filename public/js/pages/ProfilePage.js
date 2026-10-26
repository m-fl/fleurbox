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
        this.providers = [];   // GET /api/direct/providers
        this.providerForm = null; // null | 'new' | provider id being edited
        this.providerStatus = {}; // provider id -> { text, error }
        this.confirmingRemove = null;
        this.account = null;       // GET /api/auth/profiles
        this.profileForm = null;   // null | 'new' | profile id being edited
        this.personChannels = [];  // kids whitelist being edited ("sourceId:itemId")
        this.channelNames = new Map();
        this.confirmingPerson = null;
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
            [this.profile, this.taste, this.notForMe, this.providers, this.account] = await Promise.all([
                API.request('GET', '/profile'),
                API.request('GET', '/home/taste'),
                API.request('GET', '/home/feedback').catch(() => []),
                DirectPlay.providers().catch(() => []),
                Profiles.load().catch(() => null)
            ]);
        } catch (err) {
            console.error('[Profile] Load failed:', err);
            page.innerHTML = '<div class="empty-state"><p>Profile unavailable</p></div>';
            return;
        }
        this.confirmingClear = false;
        this.render();
        // Opened from the welcome modal: bring the new-provider form into view
        page.querySelector('[data-provider-form="new"]')?.scrollIntoView({ block: 'center' });
        // First provider added on the welcome screen (app.js): sync it now
        if (this.pendingSync) {
            const id = this.pendingSync;
            this.pendingSync = null;
            this.syncProvider(id);
        }
    }

    hide() { }

    render() {
        const page = document.getElementById('page-profile');
        const { user } = this.profile;
        const esc = ProfilePage.escape;
        page.innerHTML = `
            <div class="profile-container">
                <section class="profile-hero">
                    <div class="profile-avatar" aria-hidden="true">${esc((user.name || user.username || '?').slice(0, 1).toUpperCase())}</div>
                    <div class="profile-who">
                        <h2>${esc(user.name || user.username)}</h2>
                        <span class="user-badge ${user.role === 'admin' ? 'user-badge-admin' : 'user-badge-local'}">${esc(user.isOwner === false ? (user.kids ? 'kids' : 'profile') : user.role)}</span>
                    </div>
                    <button class="btn btn-ghost profile-signout" data-action="switch-profile">Switch profile</button>
                    <button class="btn btn-ghost" data-action="signout">Sign out</button>
                </section>

                ${this.profilesCard()}

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

                ${user.kids || user.isOwner === false ? '' : `
                <section class="profile-card">
                    <div class="profile-card-head">
                        <div>
                            <h3>Your provider</h3>
                            <p class="hint">Add your own provider login and what you open plays straight from your provider
                                on your account, instead of through this server. Sync reads your provider's lists in this
                                browser so Fleurbox can find the same titles and channels. The login is stored encrypted.</p>
                        </div>
                        <div class="profile-card-actions">
                            ${this.providerForm === null && this.providers.length < 3 ? '<button class="btn btn-primary" data-action="add-provider">Add provider</button>' : ''}
                        </div>
                    </div>
                    ${this.providerList()}
                    ${this.providerForm === 'new' ? this.providerFormHtml(null) : ''}
                </section>`}

                <section class="profile-card">
                    <div class="profile-card-head">
                        <div>
                            <h3>Not for me</h3>
                            <p class="hint">Titles you hid from your recommendations. Undo one to see it (and similar titles) again.</p>
                        </div>
                    </div>
                    ${this.notForMeList()}
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
        page.querySelector('[data-action="switch-profile"]').addEventListener('click', () => {
            Profiles.open(this.app).catch(err => console.error('[Profile] Profiles unavailable:', err));
        });
        page.querySelectorAll('.profile-option').forEach(btn => {
            btn.addEventListener('click', () => this.setPreference(btn.dataset.key, btn.dataset.id));
        });
        page.querySelectorAll('[data-undo]').forEach(btn => {
            btn.addEventListener('click', () => this.undoNotForMe(this.notForMe[btn.dataset.undo]));
        });
        this.bindProviders(page);
        this.bindPeople(page);
    }

    // ===================== Profiles on this login (components/Profiles.js) =====================

    profilesCard() {
        const a = this.account;
        if (!a?.isOwner) return '';
        const esc = ProfilePage.escape;
        const level = id => (Profiles.LEVELS.find(l => l.id === id)?.label || '').replace(/ \(.*/, '');
        return `
            <section class="profile-card" id="profile-people">
                <div class="profile-card-head">
                    <div>
                        <h3>Profiles</h3>
                        <p class="hint">Everyone on this login gets their own history, favourites and taste, and plays on
                            this login's provider. Up to ${a.max} profiles. A PIN stops others (kids too) from opening a profile.</p>
                    </div>
                    <div class="profile-card-actions">
                        ${this.profileForm === null && a.profiles.length < a.max ? '<button class="btn btn-primary" data-action="add-person">Add profile</button>' : ''}
                    </div>
                </div>
                <div class="profile-people">
                    ${a.profiles.map(p => this.profileForm === p.id ? this.personFormHtml(p) : `
                        <div class="profile-person" data-person="${p.id}">
                            ${Profiles.avatar(p)}
                            <div class="profile-hidden-text">
                                <span class="profile-hidden-title">${esc(p.name)}</span>
                                <span class="hint">${[p.main ? 'Main profile' : '', p.kids ? `Kids · ${esc(level(p.maxMaturity))}` : '', p.locked ? 'PIN' : ''].filter(Boolean).join(' · ') || 'Profile'}</span>
                            </div>
                            <div class="profile-card-actions">
                                <button class="btn btn-ghost btn-sm" data-person-action="edit">Edit</button>
                                ${p.main ? '' : `<button class="btn btn-ghost btn-sm" data-person-action="remove">${this.confirmingPerson === p.id ? 'Click again to remove' : 'Remove'}</button>`}
                            </div>
                        </div>`).join('')}
                    ${this.profileForm === 'new' ? this.personFormHtml(null) : ''}
                </div>
            </section>`;
    }

    personFormHtml(p) {
        const esc = ProfilePage.escape;
        const avatar = p ? p.avatar : this.account.profiles.length % Profiles.COLORS.length;
        const maxLevel = p?.maxMaturity ?? 2;
        return `
            <form class="profile-person-form" data-person-form="${p ? p.id : 'new'}" autocomplete="off">
                <div class="form-group">
                    <label>Name</label>
                    <input class="form-input" name="name" maxlength="30" required value="${esc(p?.name || '')}">
                </div>
                <div class="form-group">
                    <label>Colour</label>
                    <div class="profile-swatches">
                        ${Profiles.COLORS.map((c, i) => `
                            <label class="profile-swatch" style="background: ${c}">
                                <input type="radio" name="avatar" value="${i}" ${i === avatar ? 'checked' : ''} aria-label="Colour ${i + 1}">
                            </label>`).join('')}
                    </div>
                </div>
                ${p?.main ? '' : `
                <label class="profile-check"><input type="checkbox" name="kids" ${p?.kids ? 'checked' : ''}> Kids profile</label>
                <div class="profile-kids-fields" ${p?.kids ? '' : 'style="display: none"'}>
                    <div class="form-group">
                        <label>Allowed ratings</label>
                        <select class="form-input" name="maxMaturity">
                            ${Profiles.LEVELS.map(l => `<option value="${l.id}" ${maxLevel === l.id ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Live TV channels</label>
                        <p class="hint">Only these channels show and play for this profile.</p>
                        <div class="kids-channels" data-kids-channels></div>
                        <input type="search" class="form-input" data-kids-search placeholder="Search channels to add…" autocomplete="off">
                        <div class="kids-channel-results" data-kids-results></div>
                    </div>
                </div>`}
                <div class="form-group">
                    <label>PIN</label>
                    <input class="form-input" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password"
                        placeholder="${p?.locked ? '4 digits (blank keeps the PIN)' : '4 digits (optional)'}">
                    ${p?.locked ? '<label class="profile-check"><input type="checkbox" name="removePin"> Remove the PIN</label>' : ''}
                </div>
                <p class="hint profile-provider-error" data-person-error style="display: none"></p>
                <div class="profile-card-actions">
                    <button type="button" class="btn btn-ghost" data-person-cancel>Cancel</button>
                    <button type="submit" class="btn btn-primary">Save</button>
                </div>
            </form>`;
    }

    bindPeople(page) {
        page.querySelector('[data-action="add-person"]')?.addEventListener('click', () => this.editPerson('new'));
        page.querySelectorAll('[data-person-action]').forEach(btn => {
            const id = parseInt(btn.closest('[data-person]').dataset.person, 10);
            btn.addEventListener('click', () => {
                if (btn.dataset.personAction === 'edit') this.editPerson(id);
                else this.removePerson(id);
            });
        });
        const form = page.querySelector('[data-person-form]');
        if (!form) return;
        form.querySelector('[data-person-cancel]').addEventListener('click', () => {
            this.profileForm = null;
            this.render();
        });
        form.querySelector('[name="kids"]')?.addEventListener('change', e => {
            form.querySelector('.profile-kids-fields').style.display = e.target.checked ? '' : 'none';
        });
        form.addEventListener('submit', e => {
            e.preventDefault();
            this.savePerson(form);
        });
        if (form.querySelector('[data-kids-search]')) {
            this.bindChannelSearch(form);
            this.renderPersonChannels(form);
        }
    }

    editPerson(id) {
        this.profileForm = id;
        const p = this.account.profiles.find(x => x.id === id);
        this.personChannels = [...(p?.allowedChannels || [])];
        this.render();
        document.querySelector('[data-person-form]')?.scrollIntoView({ block: 'center' });
    }

    async savePerson(form) {
        const id = form.dataset.personForm;
        const data = new FormData(form);
        const body = { name: data.get('name'), avatar: parseInt(data.get('avatar'), 10) };
        if (form.querySelector('[name="kids"]')) {
            body.kids = data.get('kids') === 'on';
            if (body.kids) {
                body.maxMaturity = parseInt(data.get('maxMaturity'), 10);
                body.allowedChannels = this.personChannels;
            }
        }
        const pin = String(data.get('pin') || '').trim();
        if (data.get('removePin') === 'on') body.pin = null;
        else if (pin) body.pin = pin;
        try {
            if (id === 'new') await API.request('POST', '/auth/profiles', body);
            else await API.request('PUT', `/auth/profiles/${id}`, body);
            this.profileForm = null;
            this.account = await Profiles.load();
            if (parseInt(id, 10) === this.profile.user.id) this.profile.user.name = body.name;
            this.render();
        } catch (err) {
            const error = form.querySelector('[data-person-error]');
            error.textContent = err.message;
            error.style.display = '';
        }
    }

    async removePerson(id) {
        if (this.confirmingPerson !== id) {
            this.confirmingPerson = id;
            this.render();
            return;
        }
        this.confirmingPerson = null;
        try {
            await API.request('DELETE', `/auth/profiles/${id}`);
            this.account = await Profiles.load();
        } catch (err) {
            console.error('[Profile] Remove profile failed:', err);
        }
        this.render();
    }

    /** Kids profile's Live TV whitelist: search channels and add them (until Save) */
    bindChannelSearch(form) {
        const input = form.querySelector('[data-kids-search]');
        const results = form.querySelector('[data-kids-results]');
        let timer = null;
        input.addEventListener('input', () => {
            clearTimeout(timer);
            const q = input.value.trim();
            if (q.length < 2) { results.innerHTML = ''; return; }
            timer = setTimeout(async () => {
                let found = [];
                try {
                    found = (await API.live.search(q, { limit: 40 })).channels || [];
                } catch (err) {
                    console.error('[Profile] Channel search failed:', err);
                }
                if (input.value.trim() !== q) return;
                results.innerHTML = found.length ? found.map(ch => {
                    const key = `${ch.sourceId}:${ch.streamId}`;
                    this.channelNames.set(key, ch.name);
                    const added = this.personChannels.includes(key);
                    return `<div class="kids-channel-row">
                        <span class="kids-channel-name">${escapeHtml(ch.name)}<span class="hint"> · ${escapeHtml(ch.groupTitle || '')}</span></span>
                        <button type="button" class="btn btn-sm ${added ? 'btn-ghost' : 'btn-secondary'}" data-add="${escapeHtml(key)}" ${added ? 'disabled' : ''}>${added ? 'Added' : 'Add'}</button>
                    </div>`;
                }).join('') : '<p class="hint">No channels found</p>';
                results.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', () => {
                    if (!this.personChannels.includes(btn.dataset.add)) this.personChannels.push(btn.dataset.add);
                    btn.textContent = 'Added';
                    btn.disabled = true;
                    this.renderPersonChannels(form);
                }));
            }, 250);
        });
    }

    async renderPersonChannels(form) {
        const box = form.querySelector('[data-kids-channels]');
        const keys = this.personChannels;
        if (!keys.length) {
            box.innerHTML = '<p class="hint">No channels yet: Live TV is empty for this profile.</p>';
            return;
        }
        // Names of channels added before: look them up
        await Promise.all(keys.filter(k => !this.channelNames.has(k)).map(async key => {
            const [sourceId, ...rest] = key.split(':');
            try {
                this.channelNames.set(key, (await API.live.channel(sourceId, rest.join(':'))).name);
            } catch {
                this.channelNames.set(key, `Channel ${rest.join(':')} (not in the playlist any more)`);
            }
        }));
        box.innerHTML = keys.map(key => `
            <span class="kids-channel-chip">${escapeHtml(this.channelNames.get(key) || key)}
                <button type="button" aria-label="Remove" data-remove="${escapeHtml(key)}">&times;</button>
            </span>`).join('');
        box.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => {
            this.personChannels = this.personChannels.filter(k => k !== btn.dataset.remove);
            this.renderPersonChannels(form);
        }));
    }

    // ===================== Your provider (js/directPlay.js) =====================

    providerList() {
        if (!this.providers.length) {
            return this.providerForm === 'new' ? '' : '<p class="profile-empty">No provider yet. Everything plays through this server.</p>';
        }
        const esc = ProfilePage.escape;
        const n = v => Number(v || 0).toLocaleString();
        return `<div class="profile-provider-list">${this.providers.map(p => {
            const c = p.counts;
            const status = this.providerStatus[p.id];
            const synced = p.syncedAt
                ? `${n(c.live.total)} channels · ${n(c.movie.matched)}/${n(c.movie.total)} movies · ${n(c.series.matched)}/${n(c.series.total)} series matched · synced ${esc(new Date(p.syncedAt).toLocaleString())}`
                : 'Not synced yet - titles only play directly once their lists are synced (or when this is the same provider as the server\'s)';
            if (this.providerForm === p.id) return this.providerFormHtml(p);
            return `
                <div class="profile-provider" data-provider="${p.id}">
                    <div class="profile-hidden-text">
                        <span class="profile-hidden-title">${esc(p.name)}</span>
                        <span class="hint">${esc(p.url)}</span>
                        <span class="hint">${synced}</span>
                        ${status ? `<span class="hint ${status.error ? 'profile-provider-error' : ''}">${esc(status.text)}</span>` : ''}
                    </div>
                    <div class="profile-card-actions">
                        <button class="btn btn-primary btn-sm" data-provider-action="sync" ${status?.busy ? 'disabled' : ''}>Sync</button>
                        <button class="btn btn-ghost btn-sm" data-provider-action="edit">Edit</button>
                        <button class="btn btn-ghost btn-sm" data-provider-action="remove">${this.confirmingRemove === p.id ? 'Click again to remove' : 'Remove'}</button>
                    </div>
                </div>`;
        }).join('')}</div>`;
    }

    providerFormHtml(p) {
        const esc = ProfilePage.escape;
        const error = this.providerStatus.form?.text;
        return `
            <form class="profile-provider-form" data-provider-form="${p ? p.id : 'new'}" autocomplete="off">
                <div class="form-group">
                    <label>Name</label>
                    <input class="form-input" name="name" maxlength="60" placeholder="My provider" value="${esc(p?.name || '')}">
                </div>
                <div class="form-group">
                    <label>Server address</label>
                    <input class="form-input" name="url" required placeholder="http://example.com:8080" value="${esc(p?.url || '')}">
                </div>
                <div class="form-group">
                    <label>Username</label>
                    <input class="form-input" name="username" ${p ? 'placeholder="(unchanged)"' : 'required'} autocomplete="off">
                </div>
                <div class="form-group">
                    <label>Password</label>
                    <input class="form-input" name="password" type="password" ${p ? 'placeholder="(unchanged)"' : 'required'} autocomplete="new-password">
                </div>
                ${error ? `<p class="hint profile-provider-error">${esc(error)}</p>` : ''}
                <div class="profile-card-actions">
                    <button type="button" class="btn btn-ghost" data-provider-cancel>Cancel</button>
                    <button type="submit" class="btn btn-primary">Save</button>
                </div>
            </form>`;
    }

    bindProviders(page) {
        page.querySelector('[data-action="add-provider"]')?.addEventListener('click', () => {
            this.providerForm = 'new';
            this.providerStatus.form = null;
            this.render();
        });
        page.querySelector('[data-provider-cancel]')?.addEventListener('click', () => {
            this.providerForm = null;
            this.render();
        });
        page.querySelector('[data-provider-form]')?.addEventListener('submit', e => {
            e.preventDefault();
            this.saveProvider(e.target);
        });
        page.querySelectorAll('[data-provider-action]').forEach(btn => {
            const id = parseInt(btn.closest('[data-provider]').dataset.provider, 10);
            btn.addEventListener('click', () => {
                const action = btn.dataset.providerAction;
                if (action === 'sync') this.syncProvider(id);
                if (action === 'edit') { this.providerForm = id; this.providerStatus.form = null; this.render(); }
                if (action === 'remove') this.removeProvider(id);
            });
        });
    }

    async saveProvider(form) {
        const id = form.dataset.providerForm;
        const body = Object.fromEntries(new FormData(form).entries());
        if (id !== 'new') {
            // Blank login fields keep the stored login
            if (!body.username) delete body.username;
            if (!body.password) delete body.password;
        }
        try {
            const saved = id === 'new'
                ? await API.request('POST', '/direct/providers', body)
                : await API.request('PUT', `/direct/providers/${id}`, body);
            this.providerForm = null;
            this.providers = await DirectPlay.providers();
            this.render();
            if (id === 'new') this.syncProvider(saved.id);
        } catch (err) {
            this.providerStatus.form = { text: err.message, error: true };
            this.render();
        }
    }

    async syncProvider(id) {
        const label = { live: 'channels', movie: 'movies', series: 'series' };
        const set = status => { this.providerStatus[id] = status; this.render(); };
        set({ text: 'Reading your provider...', busy: true });
        try {
            const r = await DirectPlay.syncCatalogue(id, ({ kind, done, total }) =>
                set({ text: `Sending ${label[kind]}: ${done.toLocaleString()} of ${total.toLocaleString()}`, busy: true }));
            this.providers = await DirectPlay.providers();
            set({ text: `Done: ${r.movie.matched.toLocaleString()} movies and ${r.series.matched.toLocaleString()} series matched to the library` });
        } catch (err) {
            console.error('[Profile] Provider sync failed:', err);
            set({ text: err.message, error: true });
        }
    }

    async removeProvider(id) {
        if (this.confirmingRemove !== id) {
            this.confirmingRemove = id;
            this.render();
            return;
        }
        this.confirmingRemove = null;
        try {
            await API.request('DELETE', `/direct/providers/${id}`);
            this.providers = await DirectPlay.providers();
            // Last one gone: this account is back to the welcome screen
            const user = this.app.currentUser;
            if (!this.providers.length && user && user.role !== 'admin' && !user.kids) return window.location.reload();
        } catch (err) {
            this.providerStatus[id] = { text: err.message, error: true };
        }
        this.render();
    }

    /** The "Not for me" titles, each with Undo */
    notForMeList() {
        const items = this.notForMe || [];
        if (!items.length) {
            return '<p class="profile-empty">Nothing hidden. Use "Not for me" on a movie or series to hide it.</p>';
        }
        const esc = ProfilePage.escape;
        return `<div class="profile-hidden-list">${items.map((t, i) => `
            <div class="profile-hidden-item">
                <img src="${esc(t.poster ? API.imageUrl(t.poster) : '/img/poster-placeholder.jpg')}" alt="" loading="lazy" data-fallback="/img/poster-placeholder.jpg">
                <div class="profile-hidden-text">
                    <span class="profile-hidden-title">${esc(t.title)}</span>
                    <span class="hint">${t.kind === 'tv' ? 'Series' : 'Movie'}${t.year ? ` · ${esc(t.year)}` : ''}</span>
                </div>
                <button class="btn btn-ghost btn-sm" data-undo="${i}">Undo</button>
            </div>`).join('')}</div>`;
    }

    async undoNotForMe(title) {
        if (!title) return;
        try {
            await API.request('POST', '/home/feedback', { kind: title.kind, tmdbId: title.tmdbId, value: 0 });
        } catch (err) {
            console.error('[Profile] Undo failed:', err);
            return;
        }
        this.notForMe = this.notForMe.filter(t => t !== title);
        if (this.app?.pages?.home) this.app.pages.home.forYouSignature = null;
        this.render();
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
