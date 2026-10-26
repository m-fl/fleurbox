/**
 * Fleurbox Application Entry Point
 */

class App {
    constructor() {
        this.currentPage = 'home';
        this.previousPage = null; // page shown before the current one
        this.pages = {};
        this.currentUser = null;

        // Initialize components
        this.player = new VideoPlayer();
        this.channelList = new ChannelList();
        this.sourceManager = new SourceManager();
        this.epgGuide = new EpgGuide();

        // Initialize page controllers
        this.pages.home = new HomePage(this);
        this.pages.live = new LivePage(this);
        this.pages.guide = new GuidePage(this);
        this.pages.movies = new MoviesPage(this);
        this.pages.series = new SeriesPage(this);
        this.pages.settings = new SettingsPage(this);
        this.pages.watch = new WatchPage(this);
        this.pages.profile = new ProfilePage(this);
        this.pages.event = new EventPage(this);

        this.init();
    }

    async init() {
        // Check authentication first
        await this.checkAuth();

        // Several profiles on this login: "Who's watching?" once per browser session
        if (this.currentUser && await Profiles.pickIfNeeded(this)) return;

        // No provider of their own yet: only the welcome form until one is added
        if (this.currentUser?.needsProvider) {
            this.showProviderGate();
            return;
        }

        // Mobile menu toggle
        const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
        const navbarMenu = document.getElementById('navbar-menu');

        if (mobileMenuToggle && navbarMenu) {
            mobileMenuToggle.addEventListener('click', () => {
                mobileMenuToggle.classList.toggle('active');
                navbarMenu.classList.toggle('active');
            });

            // Close menu when a nav link (or the logo, which goes Home) is clicked
            document.querySelectorAll('.nav-link, #navbar-brand').forEach(link => {
                link.addEventListener('click', () => {
                    mobileMenuToggle.classList.remove('active');
                    navbarMenu.classList.remove('active');
                });
            });

            // Close menu when clicking outside
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.navbar')) {
                    mobileMenuToggle.classList.remove('active');
                    navbarMenu.classList.remove('active');
                }
            });
        }

        // Channel drawer toggle (mobile)
        const channelToggleBtn = document.getElementById('channel-toggle-btn');
        const channelSidebar = document.getElementById('channel-sidebar');
        const channelOverlay = document.getElementById('channel-sidebar-overlay');

        if (channelToggleBtn && channelSidebar && channelOverlay) {
            const toggleChannelDrawer = () => {
                channelSidebar.classList.toggle('active');
                channelOverlay.classList.toggle('active');
            };

            channelToggleBtn.addEventListener('click', toggleChannelDrawer);
            channelOverlay.addEventListener('click', toggleChannelDrawer);

            // Close drawer when a channel is selected
            channelSidebar.addEventListener('click', (e) => {
                if (e.target.closest('.channel-item')) {
                    // Small delay to let the channel selection happen
                    setTimeout(() => {
                        channelSidebar.classList.remove('active');
                        channelOverlay.classList.remove('active');
                    }, 300);
                }
            });
        }

        // Desktop sidebar collapse toggle
        const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
        const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');
        const homeLayout = document.querySelector('.home-layout');

        const toggleSidebarCollapse = () => {
            channelSidebar?.classList.toggle('collapsed');
            homeLayout?.classList.toggle('sidebar-collapsed');

            // Persist preference
            const isCollapsed = channelSidebar?.classList.contains('collapsed');
            localStorage.setItem('sidebarCollapsed', isCollapsed ? 'true' : 'false');
        };

        sidebarCollapseBtn?.addEventListener('click', toggleSidebarCollapse);
        sidebarExpandBtn?.addEventListener('click', toggleSidebarCollapse);

        // Restore sidebar state from localStorage
        if (localStorage.getItem('sidebarCollapsed') === 'true') {
            channelSidebar?.classList.add('collapsed');
            homeLayout?.classList.add('sidebar-collapsed');
        }

        // Navigation handling
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo(link.dataset.page);
            });
        });

        // The logo is the way Home (there's no Home link)
        document.getElementById('navbar-brand')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.navigateTo('home');
        });

        // Now Playing links (menu + phone bar): back to whatever plays in the background
        ['now-playing-indicator', 'now-playing-mini'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo(this.nowPlaying?.page || 'watch');
            });
        });

        // Toggle groups button
        document.getElementById('toggle-groups').addEventListener('click', () => {
            this.channelList.toggleAllGroups();
        });

        // Search clear buttons (global handler for all)
        document.querySelectorAll('.search-clear').forEach(btn => {
            btn.addEventListener('click', () => {
                const wrapper = btn.closest('.search-wrapper');
                const input = wrapper?.querySelector('.search-input');
                if (input) {
                    input.value = '';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.focus();
                }
            });
        });

        // Handle browser back/forward buttons
        // (also fires when a #watch/... link is pasted into the address bar)
        window.addEventListener('popstate', (e) => {
            const [page, ...route] = window.location.hash.slice(1).split('/');
            if (page === 'watch' && route.length) {
                this.pages.watch.playFromRoute(route).then(ok => {
                    if (!ok) this.navigateTo('home', true);
                });
                return;
            }
            if (page === 'event' && route.length) {
                this.pages.event.openFromRoute(route).then(ok => {
                    if (!ok) this.navigateTo('home', true);
                });
                return;
            }
            const target = this.pages[page] ? page : (e.state?.page || 'home');
            this.navigateTo(target, true); // replace = don't add a history entry
        });

        // Initialize home page first (it's needed for channel list)
        await this.pages.home.init();

        // No EPG preload: Live TV asks the server what's on now for the channels it
        // shows; the full guide data (~60MB) is only fetched by the Guide page

        // Navigate to the page from URL hash, or default to home
        // A #watch/<type>/<source>/<id...> link starts that video
        const [page, ...route] = window.location.hash.slice(1).split('/'); // Remove #
        // and #event/<id> opens that live event
        const playedRoute = page === 'watch' && route.length &&
            await this.pages.watch.playFromRoute(route);
        const openedRoute = !playedRoute && page === 'event' && route.length &&
            await this.pages.event.openFromRoute(route);
        if (!playedRoute && !openedRoute) {
            const initialPage = page && this.pages[page] ? page : 'home';
            this.navigateTo(initialPage, true); // true = replace history (don't add)
        }

        // First provider just added on the welcome form: Profile, and sync it there
        let syncId = null;
        try {
            syncId = sessionStorage.getItem('fleurbox_sync_provider');
            sessionStorage.removeItem('fleurbox_sync_provider');
        } catch { /* storage blocked: sync from Profile by hand */ }
        if (syncId) {
            this.pages.profile.pendingSync = parseInt(syncId, 10);
            if (this.currentPage === 'profile') this.pages.profile.show();
            else this.navigateTo('profile');
        } else if (!playedRoute && !openedRoute) {
            // Not over a shared #watch / #event link
            this.maybeWelcome();
        }

        console.log('Fleurbox initialized');
    }

    /**
     * Admins without a provider of their own: point at Profile > Your provider,
     * or keep using the default source. (Other accounts get showProviderGate.)
     * Comes back on every visit until they have a provider; closing it only
     * hides it for the rest of this tab's session.
     */
    async maybeWelcome() {
        const user = this.currentUser;
        if (!user || user.role !== 'admin') return;
        const key = `fleurbox_welcome_${user.id}`;
        try {
            if (sessionStorage.getItem(key)) return;
        } catch { /* storage blocked: shown on each load */ }
        const providers = await DirectPlay.providers().catch(() => null);
        if (!providers || providers.length) return;

        const modal = document.getElementById('modal');
        document.getElementById('modal-title').textContent = 'Welcome to Fleurbox!';
        document.getElementById('modal-body').innerHTML = `
            <p>To get started, add a new provider.</p>
            <p class="hint">As an admin you can also keep using this server's default source.
                You can add or change your provider any time on your Profile.</p>`;
        document.getElementById('modal-footer').innerHTML = `
            <button class="btn btn-secondary" id="welcome-later">Use default source</button>
            <button class="btn btn-primary" id="welcome-add">Add provider</button>`;
        const close = () => {
            try { sessionStorage.setItem(key, '1'); } catch { /* storage blocked */ }
            modal.classList.remove('active');
            modal.onclick = null;
        };
        modal.querySelector('.modal-close').onclick = close;
        modal.onclick = e => { if (e.target === modal) close(); };
        document.getElementById('welcome-later').onclick = close;
        document.getElementById('welcome-add').onclick = () => {
            close();
            const profile = this.pages.profile;
            profile.providerForm = 'new';
            profile.providerStatus.form = null;
            if (this.currentPage === 'profile') profile.show();
            else this.navigateTo('profile');
        };
        modal.classList.add('active');
    }

    /**
     * Accounts without a provider of their own (not admins or kids profiles)
     * can't use anything else - the server answers needsProvider. A welcome
     * screen with the provider form; saving reloads into the app, which opens
     * Profile and runs the first Sync.
     */
    showProviderGate() {
        const gate = document.createElement('div');
        gate.className = 'provider-gate';
        // Only the main profile adds the login's provider (server/services/profiles.js)
        if (!this.currentUser.isOwner) {
            gate.innerHTML = `
                <div class="provider-gate-card">
                    <h2>Welcome to Fleurbox!</h2>
                    <p>This login has no provider yet.</p>
                    <p class="hint">The main profile adds one: switch to it to get started.</p>
                    <div class="provider-gate-actions">
                        <button type="button" class="btn btn-ghost" data-gate-logout>Log out</button>
                        <button type="button" class="btn btn-primary" data-gate-switch>Switch profile</button>
                    </div>
                </div>`;
            document.body.appendChild(gate);
            gate.querySelector('[data-gate-switch]').addEventListener('click', () => Profiles.open(this));
            gate.querySelector('[data-gate-logout]').addEventListener('click', () => document.getElementById('logout-btn')?.click());
            return;
        }
        gate.innerHTML = `
            <form class="provider-gate-card" autocomplete="off">
                <h2>Welcome to Fleurbox!</h2>
                <p>To get started, add a new provider.</p>
                <p class="hint">Enter the Xtream login from your IPTV provider. It is stored encrypted,
                    and what you open plays straight from your provider.</p>
                <div class="form-group">
                    <label>Name</label>
                    <input class="form-input" name="name" maxlength="60" placeholder="My provider">
                </div>
                <div class="form-group">
                    <label>Server address</label>
                    <input class="form-input" name="url" required placeholder="http://example.com:8080" inputmode="url" autocapitalize="off" spellcheck="false">
                </div>
                <div class="form-group">
                    <label>Username</label>
                    <input class="form-input" name="username" required autocomplete="off" autocapitalize="off" spellcheck="false">
                </div>
                <div class="form-group">
                    <label>Password</label>
                    <input class="form-input" name="password" type="password" required autocomplete="new-password">
                </div>
                <p class="hint provider-gate-error" style="display: none"></p>
                <div class="provider-gate-actions">
                    <button type="button" class="btn btn-ghost" data-gate-logout>Log out</button>
                    <button type="submit" class="btn btn-primary">Add provider</button>
                </div>
            </form>`;
        document.body.appendChild(gate);

        const form = gate.querySelector('form');
        const error = gate.querySelector('.provider-gate-error');
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const button = form.querySelector('[type="submit"]');
            button.disabled = true;
            error.style.display = 'none';
            try {
                const saved = await API.request('POST', '/direct/providers', Object.fromEntries(new FormData(form).entries()));
                try { sessionStorage.setItem('fleurbox_sync_provider', String(saved.id)); } catch { /* storage blocked */ }
                window.location.reload();
            } catch (err) {
                error.textContent = err.message;
                error.style.display = '';
                button.disabled = false;
            }
        });
        gate.querySelector('[data-gate-logout]').addEventListener('click', async () => {
            Profiles.forget();
            await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
            window.location.replace('/login.html');
        });
    }

    async checkAuth() {
        // The login lives in an httpOnly cookie that page scripts cannot read
        // (so an XSS bug cannot steal it); older versions kept it here
        try { localStorage.removeItem('authToken'); } catch { /* storage blocked */ }

        try {
            // Verify the session with the server
            const response = await fetch('/api/auth/me');

            if (!response.ok) {
                throw new Error('Invalid token');
            }

            this.currentUser = await response.json();

            // Hide settings for viewers
            if (this.currentUser.role === 'viewer') {
                const settingsLink = document.querySelector('.nav-link[data-page="settings"]');
                if (settingsLink) {
                    settingsLink.style.display = 'none';
                }
            }

            // Switch profile + logout buttons in the navbar
            this.addProfileButton();
            this.addLogoutButton();

            // This user's saved appearance (Profile page); not awaited
            ProfilePage.loadAppearance();

        } catch (err) {
            console.error('Authentication error:', err);
            window.location.replace('/login.html');
        }
    }

    /** Navbar: "Switch profile" (components/Profiles.js), before Logout */
    addProfileButton() {
        const navbar = document.querySelector('.navbar-menu');
        if (!navbar || document.getElementById('profile-switch-btn')) return;

        const link = document.createElement('a');
        link.href = '#';
        link.className = 'nav-link';
        link.id = 'profile-switch-btn';
        link.innerHTML = `
            <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon">
                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
            </svg></span>
            <span>Switch profile</span>
        `;
        // Added before the page links are wired up: keep their navigateTo off it
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            document.getElementById('mobile-menu-toggle')?.classList.remove('active');
            document.getElementById('navbar-menu')?.classList.remove('active');
            Profiles.open(this).catch(err => console.error('[Profiles] Unavailable:', err));
        });
        navbar.appendChild(link);
    }

    addLogoutButton() {
        const navbar = document.querySelector('.navbar-menu');
        if (!navbar || document.getElementById('logout-btn')) return;

        const logoutLink = document.createElement('a');
        logoutLink.href = '#';
        logoutLink.className = 'nav-link';
        logoutLink.id = 'logout-btn';
        logoutLink.innerHTML = `
            <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon">
                <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
            </svg></span>
            <span>Logout</span>
        `;

        logoutLink.addEventListener('click', async (e) => {
            e.preventDefault();

            Profiles.forget();
            await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
            window.location.replace('/login.html');
        });

        navbar.appendChild(logoutLink);
    }

    navigateTo(pageName, replaceHistory = false) {
        // Don't navigate if already on this page
        if (this.currentPage === pageName && !replaceHistory) {
            return;
        }

        // Update browser history. The watch and event pages' URLs name what they show.
        const hash = this.pages[pageName]?.routeHash || pageName;
        if (replaceHistory) {
            // Replace current history entry (used on initial load)
            history.replaceState({ page: pageName }, '', `#${hash}`);
        } else {
            // Add new history entry
            history.pushState({ page: pageName }, '', `#${hash}`);
        }

        // Update nav
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.page === pageName);
        });

        // Update pages
        document.querySelectorAll('.page').forEach(page => {
            page.classList.toggle('active', page.id === `page-${pageName}`);
        });

        // Notify page controllers
        if (this.pages[this.currentPage]?.hide) {
            this.pages[this.currentPage].hide();
        }

        this.previousPage = this.currentPage;
        this.currentPage = pageName;

        if (this.pages[pageName]?.show) {
            this.pages[pageName].show();
        }
        this.updateNowPlaying();
    }

    /**
     * What plays in the background ('watch' = movie/series, 'live' = Live TV),
     * for the Now Playing links. Only one thing plays at a time.
     */
    setNowPlaying(title, page) {
        this.nowPlaying = { title: title || 'Now Playing', page };
        this.updateNowPlaying();
    }

    clearNowPlaying(page) {
        if (this.nowPlaying && this.nowPlaying.page !== page) return;
        this.nowPlaying = null;
        this.updateNowPlaying();
    }

    updateNowPlaying() {
        const np = this.nowPlaying;
        const menu = document.getElementById('now-playing-indicator');
        const mini = document.getElementById('now-playing-mini');
        menu?.classList.toggle('hidden', !np);
        // The phone link is only needed away from the player
        mini?.classList.toggle('hidden', !np || this.currentPage === np.page);
        for (const id of ['now-playing-text', 'now-playing-mini-text']) {
            const el = document.getElementById(id);
            if (el && np) el.textContent = np.title;
        }
    }
}

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
