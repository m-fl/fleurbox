/**
 * Movies Page Controller
 * Handles VOD movie browsing and playback
 */

class MoviesPage {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('movies-grid');
        this.sourceSelect = document.getElementById('movies-source-select');
        this.categorySelect = document.getElementById('movies-category-select');
        this.searchInput = document.getElementById('movies-search');
        this.detailsPanel = document.getElementById('movie-details');
        this.currentMovie = null;
        this.currentMovieInfo = null;

        this.movies = []; // pages loaded so far for the current filters
        this.categories = [];
        this.sources = [];
        this.pageSize = 100;
        this.hasMore = false;
        this.isLoading = false;
        this.observer = null;
        this.favoriteIds = new Set(); // Track favorite movie IDs
        this.showFavoritesOnly = false;

        this.init();
    }

    init() {
        // Source change handler
        this.sourceSelect?.addEventListener('change', async () => {
            await this.loadCategories();
            await this.loadMovies();
        });

        // Category change handler
        // Movie details panel
        // Back button: to Home/Search when opened from there, else to the grid
        this.backBtn = this.detailsPanel?.querySelector('.movie-back-btn');
        this.backBtn?.addEventListener('click', () => {
            ContentDetails.goBack(this.app, this.detailsFrom, () => this.hideDetails());
        });
        document.getElementById('movie-play-btn')?.addEventListener('click', () => {
            if (this.currentMovie) this.playMovie(this.currentMovie, this.currentMovieInfo);
        });

        this.categorySelect?.addEventListener('change', () => {
            this.loadMovies();
        });

        // Search with debounce
        let searchTimeout;
        this.searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.filterAndRender(), 300);
        });

        // Set up IntersectionObserver for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.isLoading) {
                this.loadNextPage();
            }
        }, { rootMargin: '200px' });

        // Favorites filter toggle
        const favBtn = document.getElementById('movies-favorites-btn');
        favBtn?.addEventListener('click', () => {
            this.showFavoritesOnly = !this.showFavoritesOnly;
            favBtn.classList.toggle('active', this.showFavoritesOnly);
            this.filterAndRender();
        });
    }

    async show() {
        // Back from the player: keep the movie's details open. Otherwise the
        // page starts on the grid.
        if (!(this.app.previousPage === 'watch' && this.currentMovie)) this.hideDetails();

        // Language list for Settings > Language Priority (cached after first load)
        await LanguagePriority.load();

        // Load sources if not loaded
        if (this.sources.length === 0) {
            await this.loadSources();
        }

        // Load favorites
        await this.loadFavorites();

        // Load movies if empty
        if (this.movies.length === 0) {
            await this.loadCategories();
            await this.loadMovies();
        }

        // Settings > Language Priority / hard filter changed since the grid was drawn
        if (this.renderedLanguage !== undefined &&
            (this.renderedLanguage !== LanguagePriority.selected(this.app) ||
             this.renderedHardFilter !== LanguagePriority.hardFilter(this.app))) {
            this.renderCategoryOptions();
            this.filterAndRender();
        }
    }

    hide() {
        // Page is hidden
    }

    async loadFavorites() {
        try {
            const favs = await API.favorites.getAll(null, 'movie');
            this.favoriteIds = new Set(favs.map(f => `${f.source_id}:${f.item_id}`));
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }


    async loadSources() {
        try {
            const allSources = await API.sources.getAll();
            this.sources = allSources.filter(s => s.type === 'xtream' && s.enabled);

            this.sourceSelect.innerHTML = '<option value="">All Sources</option>';
            this.sources.forEach(s => {
                const option = document.createElement('option');
                option.value = s.id;
                option.textContent = s.name;
                this.sourceSelect.appendChild(option);
            });
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    async loadCategories() {
        try {
            this.categories = [];
            this.hiddenCategoryIds = new Set(); // Track hidden categories
            this.categorySelect.innerHTML = '<option value="">All Categories</option>';

            const sourceId = this.sourceSelect.value;
            const sourcesToLoad = sourceId
                ? this.sources.filter(s => s.id === parseInt(sourceId))
                : this.sources;

            // Fetch hidden items for each source
            for (const source of sourcesToLoad) {
                try {
                    const hiddenItems = await API.channels.getHidden(source.id);
                    hiddenItems.forEach(h => {
                        if (h.item_type === 'vod_category') {
                            this.hiddenCategoryIds.add(`${source.id}:${h.item_id}`);
                        }
                    });
                } catch (err) {
                    console.warn(`Failed to load hidden items from source ${source.id}`);
                }
            }

            for (const source of sourcesToLoad) {
                try {
                    const cats = await API.proxy.xtream.vodCategories(source.id);
                    if (cats && Array.isArray(cats)) {
                        cats.forEach(c => {
                            // Skip hidden categories
                            if (!this.hiddenCategoryIds.has(`${source.id}:${c.category_id}`)) {
                                this.categories.push({ ...c, sourceId: source.id });
                            }
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load categories from source ${source.id}:`, err.message);
                }
            }

            this.renderCategoryOptions();
        } catch (err) {
            console.error('Error loading categories:', err);
        }
    }

    loadMovies() {
        return this.filterAndRender();
    }

    /**
     * Restart the grid for the current filters. The server filters, orders and
     * pages the titles, so only one page at a time comes down to the browser.
     */
    filterAndRender() {
        // Settings > Language Priority: that language's titles first; the hard
        // filter also drops titles explicitly marked as another language
        this.renderedLanguage = LanguagePriority.selected(this.app);
        this.renderedHardFilter = LanguagePriority.hardFilter(this.app);

        this.query = {
            source_id: this.sourceSelect.value,
            category: this.categorySelect.value,
            q: this.searchInput?.value?.trim() || '',
            favorites: this.showFavoritesOnly ? 1 : '',
            lang: this.renderedLanguage,
            hard: this.renderedHardFilter ? 1 : ''
        };
        this.movies = [];
        this.hasMore = true;
        this.listToken = (this.listToken || 0) + 1;
        this.isLoading = false; // a request for the old filters no longer counts
        this.observer.disconnect();
        this.container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

        return this.loadNextPage();
    }

    async loadNextPage() {
        if (this.isLoading || !this.hasMore) return;
        this.isLoading = true;
        const token = this.listToken;
        const first = this.movies.length === 0;

        try {
            const page = await API.proxy.browse('movie', {
                ...this.query, offset: this.movies.length, limit: this.pageSize
            });
            if (token !== this.listToken) return; // filters changed meanwhile

            this.movies.push(...page.items);
            this.hasMore = page.hasMore;

            if (first) {
                this.container.innerHTML = '';
                if (page.items.length === 0) {
                    this.container.innerHTML = '<div class="empty-state"><p>No movies found</p></div>';
                    return;
                }
                const loader = document.createElement('div');
                loader.className = 'movies-loader';
                loader.innerHTML = '<div class="loading-spinner"></div>';
                this.container.appendChild(loader);
            }

            this.renderCards(page.items);

            const loader = this.container.querySelector('.movies-loader');
            if (!this.hasMore) {
                if (loader) loader.style.display = 'none';
            } else if (loader) {
                // Re-observe so a loader still on screen asks for the next page
                this.observer.unobserve(loader);
                this.observer.observe(loader);
            }
        } catch (err) {
            if (token !== this.listToken) return;
            console.error('Error loading movies:', err);
            if (first) {
                this.container.innerHTML = '<div class="empty-state"><p>Error loading movies</p></div>';
            }
        } finally {
            if (token === this.listToken) this.isLoading = false;
        }
    }

    /**
     * Category dropdown. Under the language hard filter, categories explicitly
     * in another language are left out (they would only show empty grids).
     */
    renderCategoryOptions() {
        const current = this.categorySelect.value;
        const language = LanguagePriority.selected(this.app);
        const hard = LanguagePriority.hardFilter(this.app);
        this.categorySelect.innerHTML = '<option value="">All Categories</option>';
        this.categories.forEach(c => {
            if (hard && !LanguagePriority.visible('', c.category_name, language)) return;
            const option = document.createElement('option');
            option.value = `${c.sourceId}:${c.category_id}`;
            option.textContent = c.category_name;
            this.categorySelect.appendChild(option);
        });
        // Keep the selection if it is still offered, otherwise fall back to All
        this.categorySelect.value = current;
        if (this.categorySelect.value !== current) this.categorySelect.value = '';
    }

    renderCards(batch) {
        const fragment = document.createDocumentFragment();

        batch.forEach(movie => {
            const card = document.createElement('div');
            card.className = 'movie-card';
            card.dataset.movieId = movie.stream_id;
            card.dataset.sourceId = movie.sourceId;

            const poster = API.imageUrl(movie.stream_icon || movie.cover) || '/img/placeholder.png';
            const year = movie.year || movie.releaseDate?.substring(0, 4) || '';
            const rating = movie.rating ? `${Icons.star} ${movie.rating}` : '';

            const isFav = this.favoriteIds.has(`${movie.sourceId}:${movie.stream_id}`);

            card.innerHTML = `
                <div class="movie-poster">
                    <img src="${poster}" alt="${movie.name}" 
                         onerror="this.onerror=null;this.src='/img/placeholder.png'" loading="lazy">
                    <div class="movie-play-overlay">
                        <span class="play-icon">${Icons.play}</span>
                    </div>
                    <button class="favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
                        <span class="fav-icon">${isFav ? Icons.favorite : Icons.favoriteOutline}</span>
                    </button>
                </div>
                <div class="movie-info">
                    <div class="movie-title">${movie.name}</div>
                    <div class="movie-meta">
                        ${year ? `<span>${year}</span>` : ''}
                        ${rating ? `<span>${rating}</span>` : ''}
                    </div>
                </div>
            `;

            // Card click plays movie, but not if clicking favorite button
            card.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) {
                    const btn = e.target.closest('.favorite-btn');
                    this.toggleFavorite(movie, btn);
                    e.stopPropagation();
                } else {
                    this.showMovieDetails(movie);
                }
            });
            fragment.appendChild(card);
        });

        // Insert before loader
        const loader = this.container.querySelector('.movies-loader');
        if (loader) {
            this.container.insertBefore(fragment, loader);
        } else {
            this.container.appendChild(fragment);
        }
    }

    async playMovie(movie, info = null) {
        try {
            // Get stream URL for movie using the actual container extension from API
            // Xtream API returns container_extension (e.g., 'mp4', 'mkv', 'avi')
            const container = movie.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(movie.sourceId, movie.stream_id, 'movie', container);

            if (result && result.url) {
                // Play in dedicated Watch page
                if (this.app.pages.watch) {
                    this.app.pages.watch.play({
                        type: 'movie',
                        id: movie.stream_id,
                        title: movie.name,
                        poster: movie.stream_icon || movie.cover,
                        description: info?.plot || info?.description || movie.plot || '',
                        year: info?.releasedate?.substring(0, 4) || movie.year || movie.releaseDate?.substring(0, 4),
                        rating: movie.rating,
                        sourceId: movie.sourceId,
                        categoryId: movie.category_id,
                        containerExtension: container
                    }, result.url);
                }
            }
        } catch (err) {
            console.error('Error playing movie:', err);
        }
    }
    /**
     * Details panel: shows the list data at once, then fills in vod_info
     * (plot, genre, runtime, credits) and the playlist category
     */
    /** opts.from: 'home' | 'search' when opened from Home (sets the Back target) */
    async showMovieDetails(movie, opts = {}) {
        this.currentMovie = movie;
        this.detailsFrom = opts.from || null;
        if (this.backBtn) this.backBtn.textContent = ContentDetails.backLabel(this.detailsFrom, 'Movies');
        this.currentMovieInfo = null;
        const token = this.detailsToken = (this.detailsToken || 0) + 1;

        this.container.classList.add('hidden');
        this.detailsPanel.classList.remove('hidden');
        this.detailsPanel.scrollTop = 0;

        const poster = document.getElementById('movie-poster');
        poster.onerror = () => { poster.onerror = null; poster.src = '/img/placeholder.png'; };
        poster.src = API.imageUrl(movie.stream_icon || movie.cover) || '/img/placeholder.png';
        document.getElementById('movie-title').textContent = movie.name;

        const metaEl = document.getElementById('movie-meta');
        const plotEl = document.getElementById('movie-plot');
        const creditsEl = document.getElementById('movie-credits');
        metaEl.innerHTML = ContentDetails.metaHtml({ rating: movie.rating, year: movie.year }, '');
        plotEl.textContent = movie.plot || '';
        creditsEl.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

        // Stored TMDB record first: local, no outside call
        const local = await ContentDetails.local('movie', movie.sourceId, movie.stream_id);
        if (token !== this.detailsToken) return; // another movie was opened meanwhile

        let info = local?.tmdb ? local.info : null;
        let category = local?.category || '';
        if (!info) {
            // Not in TMDB (or not fetched yet): ask the provider, as before
            const [vodInfo, providerCategory] = await Promise.all([
                API.proxy.xtream.vodInfo(movie.sourceId, movie.stream_id).catch(err => {
                    console.error('Error loading movie info:', err);
                    return null;
                }),
                category || ContentDetails.categoryName('movie', movie.sourceId, movie.category_id)
            ]);
            if (token !== this.detailsToken) return;
            // Xtream returns info: [] when it has nothing
            info = vodInfo?.info && !Array.isArray(vodInfo.info) ? vodInfo.info : {};
            category = providerCategory;
        }
        this.currentMovieInfo = info;

        metaEl.innerHTML = ContentDetails.metaHtml({ ...info, rating: info.rating || movie.rating }, category);
        plotEl.textContent = info.plot || info.description || movie.plot || '';
        creditsEl.innerHTML = ContentDetails.creditsHtml(info);
    }

    hideDetails() {
        this.detailsPanel?.classList.add('hidden');
        this.container?.classList.remove('hidden');
        this.currentMovie = null;
        this.currentMovieInfo = null;
        this.detailsFrom = null;
    }

    async toggleFavorite(movie, btn) {
        const favKey = `${movie.sourceId}:${movie.stream_id}`;
        const isFav = this.favoriteIds.has(favKey);
        const iconSpan = btn.querySelector('.fav-icon');

        try {
            // Optimistic update
            if (isFav) {
                this.favoriteIds.delete(favKey);
                btn.classList.remove('active');
                btn.title = 'Add to Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
                await API.favorites.remove(movie.sourceId, movie.stream_id, 'movie');
            } else {
                this.favoriteIds.add(favKey);
                btn.classList.add('active');
                btn.title = 'Remove from Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
                await API.favorites.add(movie.sourceId, movie.stream_id, 'movie');
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            // Revert on error
            if (isFav) {
                this.favoriteIds.add(favKey);
                btn.classList.add('active');
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
            } else {
                this.favoriteIds.delete(favKey);
                btn.classList.remove('active');
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
            }
        }
    }
}

window.MoviesPage = MoviesPage;
