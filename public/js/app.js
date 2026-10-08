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

        // Now Playing indicator
        const nowPlayingBtn = document.getElementById('now-playing-indicator');
        if (nowPlayingBtn) {
            nowPlayingBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo('watch');
            });
        }

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

        console.log('Fleurbox initialized');
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

            // Add logout button to navbar
            this.addLogoutButton();

            // This user's saved appearance (Profile page); not awaited
            ProfilePage.loadAppearance();

        } catch (err) {
            console.error('Authentication error:', err);
            window.location.replace('/login.html');
        }
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
    }
}

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
