/**
 * Profiles on one login (server/services/profiles.js), Netflix style.
 * "Who's watching?" comes up when the app opens in a new browser session on
 * a login with more than one profile, and from the navbar. Choosing a profile
 * swaps this browser's login cookie for that profile's and reloads; locked
 * profiles ask for their 4-digit PIN. Management is on the Profile page.
 */
const PROFILE_CHOSEN_KEY = 'fleurbox_profile_chosen';

const Profiles = {
    // Picture colours, by the profile's avatar index (server: AVATARS = 8)
    COLORS: ['#5f8452', '#4a7ab0', '#b0654a', '#8a5fb0', '#a8913f', '#3f9a8f', '#b04a7a', '#6b6b6b'],
    // services/maturity.js LEVELS
    LEVELS: [
        { id: 1, label: 'Young kids (TV-Y, TV-Y7, G)' },
        { id: 2, label: 'Kids (up to PG, TV-PG)' },
        { id: 3, label: 'Teens (up to PG-13, TV-14)' }
    ],
    LOCK_ICON: '<svg viewBox="0 0 24 24" fill="currentColor" class="icon" aria-label="PIN"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3H9z"/></svg>',

    load() {
        return API.request('GET', '/auth/profiles');
    },

    /** A round picture with the profile's initial */
    avatar(p, cls = '') {
        const color = Profiles.COLORS[(p.avatar || 0) % Profiles.COLORS.length];
        return `<span class="profile-face ${cls}" style="background: ${color}" aria-hidden="true">${escapeHtml((p.name || '?').slice(0, 1).toUpperCase())}</span>`;
    },

    markChosen() {
        try { sessionStorage.setItem(PROFILE_CHOSEN_KEY, '1'); } catch { /* storage blocked */ }
    },

    /** Logging out: the next login asks again */
    forget() {
        try { sessionStorage.removeItem(PROFILE_CHOSEN_KEY); } catch { /* storage blocked */ }
    },

    /** Reload into the app from the top (Home) */
    restart(hash = '') {
        history.replaceState(null, '', `/${hash}`);
        window.location.reload();
    },

    /**
     * Opening the app: a login with several profiles asks who's watching, once
     * per browser session. True = the picker is up (choosing reloads).
     */
    async pickIfNeeded(app) {
        try {
            if (sessionStorage.getItem(PROFILE_CHOSEN_KEY)) return false;
        } catch { return false; }
        let data;
        try {
            data = await Profiles.load();
        } catch (err) {
            console.warn('[Profiles] Unavailable:', err);
            return false;
        }
        if (data.profiles.length < 2) {
            Profiles.markChosen();
            return false;
        }
        Profiles.showPicker(app, data, false);
        return true;
    },

    /** From the navbar / Profile page: the picker, closable */
    async open(app) {
        Profiles.showPicker(app, await Profiles.load(), true);
    },

    showPicker(app, data, closable) {
        document.querySelector('.profile-picker')?.remove();
        const el = document.createElement('div');
        el.className = 'profile-picker';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.innerHTML = `
            <div class="profile-picker-inner">
                ${closable ? '<button class="modal-close profile-picker-close" aria-label="Close">&times;</button>' : ''}
                <h1>Who's watching?</h1>
                <div class="profile-picker-grid">
                    ${data.profiles.map(p => `
                        <button class="profile-tile ${p.current ? 'current' : ''}" data-id="${p.id}">
                            ${Profiles.avatar(p, 'profile-face-lg')}
                            <span class="profile-tile-name">${escapeHtml(p.name)}</span>
                            <span class="profile-tile-tags">${p.kids ? 'Kids' : ''} ${p.locked ? Profiles.LOCK_ICON : ''}</span>
                        </button>`).join('')}
                </div>
                <form class="profile-pin" style="display: none" autocomplete="off">
                    <p class="profile-pin-label"></p>
                    <input class="form-input" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required placeholder="PIN">
                    <p class="hint profile-pin-error"></p>
                    <div class="profile-pin-actions">
                        <button type="button" class="btn btn-ghost" data-pin-cancel>Cancel</button>
                        <button type="submit" class="btn btn-primary">OK</button>
                    </div>
                </form>
                ${data.isOwner ? '<button class="btn btn-secondary profile-picker-manage">Manage profiles</button>' : ''}
            </div>`;
        document.body.appendChild(el);

        const grid = el.querySelector('.profile-picker-grid');
        const pinForm = el.querySelector('.profile-pin');
        const pinError = el.querySelector('.profile-pin-error');
        let picked = null;

        const choose = async (p, pin) => {
            if (p.current) {
                Profiles.markChosen();
                if (closable) el.remove(); else Profiles.restart(window.location.hash);
                return;
            }
            try {
                await API.request('POST', `/auth/profiles/${p.id}/switch`, pin ? { pin } : {});
                Profiles.markChosen();
                Profiles.restart(); // a new profile starts on Home
            } catch (err) {
                pinError.textContent = err.message;
                if (!pin) alertInGrid(err.message);
            }
        };
        const alertInGrid = message => {
            pinForm.style.display = '';
            grid.style.display = 'none';
            el.querySelector('.profile-pin-label').textContent = '';
            pinError.textContent = message;
        };

        grid.querySelectorAll('.profile-tile').forEach(tile => tile.addEventListener('click', () => {
            const p = data.profiles.find(x => x.id === parseInt(tile.dataset.id, 10));
            if (p.locked && !p.current) {
                picked = p;
                grid.style.display = 'none';
                pinForm.style.display = '';
                el.querySelector('.profile-pin-label').textContent = `Enter the PIN for ${p.name}`;
                pinError.textContent = '';
                pinForm.pin.value = '';
                pinForm.pin.focus();
                return;
            }
            choose(p);
        }));
        pinForm.addEventListener('submit', e => {
            e.preventDefault();
            if (picked) choose(picked, pinForm.pin.value.trim());
        });
        el.querySelector('[data-pin-cancel]').addEventListener('click', () => {
            picked = null;
            pinForm.style.display = 'none';
            grid.style.display = '';
        });
        el.querySelector('.profile-picker-close')?.addEventListener('click', () => el.remove());
        el.querySelector('.profile-picker-manage')?.addEventListener('click', () => {
            Profiles.markChosen();
            if (!closable) return Profiles.restart('#profile');
            el.remove();
            app.navigateTo('profile');
            if (app.currentPage === 'profile') app.pages.profile.show();
        });
    }
};

window.Profiles = Profiles;
