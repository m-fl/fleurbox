/**
 * Series Page Controller
 * Handles TV series browsing and playback
 */

class SeriesPage {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('series-grid');
        this.sourceSelect = document.getElementById('series-source-select');
        this.categorySelect = document.getElementById('series-category-select');
        this.searchInput = document.getElementById('series-search');
        this.detailsPanel = document.getElementById('series-details');
        this.seasonsContainer = document.getElementById('series-seasons');

        this.seriesList = []; // pages loaded so far for the current filters
        this.categories = [];
        this.sources = [];
        this.pageSize = 100;
        this.hasMore = false;
        this.isLoading = false;
        this.observer = null;
        this.hiddenCategoryIds = new Set();
        this.currentSeries = null;
        this.favoriteIds = new Set(); // Track favorite series IDs
        this.showFavoritesOnly = false;

        this.init();
    }

    init() {
        // Source change handler
        this.sourceSelect?.addEventListener('change', async () => {
            await this.loadCategories();
            await this.loadSeries();
        });

        // Category change handler
        this.categorySelect?.addEventListener('change', () => {
            this.loadSeries();
        });

        // Search with debounce
        let searchTimeout;
        this.searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.filterAndRender(), 300);
        });

        // Back button: to Home/Search when opened from there, else to the grid
        this.backBtn = this.detailsPanel?.querySelector('.series-back-btn');
        this.backBtn?.addEventListener('click', () => {
            ContentDetails.goBack(this.app, this.detailsFrom, () => this.hideDetails());
        });

        // Set up IntersectionObserver for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.isLoading) {
                this.loadNextPage();
            }
        }, { rootMargin: '200px' });

        // Favorites filter toggle
        const favBtn = document.getElementById('series-favorites-btn');
        favBtn?.addEventListener('click', () => {
            this.showFavoritesOnly = !this.showFavoritesOnly;
            favBtn.classList.toggle('active', this.showFavoritesOnly);
            this.filterAndRender();
        });
    }

    async show() {
        // Back from the player: keep the series' episode list open. Otherwise
        // the page starts on the grid.
        if (!(this.app.previousPage === 'watch' && this.currentSeries)) this.hideDetails();

        // Language list for Settings > Language Priority (cached after first load)
        await LanguagePriority.load();

        // Load sources if not loaded
        // Load sources if not loaded
        if (this.sources.length === 0) {
            await this.loadSources();
        }

        // Load favorites
        await this.loadFavorites();

        // Load series if empty
        if (this.seriesList.length === 0) {
            await this.loadCategories();
            await this.loadSeries();
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
            const favs = await API.favorites.getAll(null, 'series');
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
            this.hiddenCategoryIds = new Set();
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
                        if (h.item_type === 'series_category') {
                            this.hiddenCategoryIds.add(`${source.id}:${h.item_id}`);
                        }
                    });
                } catch (err) {
                    console.warn(`Failed to load hidden items from source ${source.id}`);
                }
            }

            for (const source of sourcesToLoad) {
                try {
                    const cats = await API.proxy.xtream.seriesCategories(source.id);
                    if (cats && Array.isArray(cats)) {
                        cats.forEach(c => {
                            // Skip hidden categories
                            if (!this.hiddenCategoryIds.has(`${source.id}:${c.category_id}`)) {
                                this.categories.push({ ...c, sourceId: source.id });
                            }
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load series categories from source ${source.id}:`, err.message);
                }
            }

            this.renderCategoryOptions();
        } catch (err) {
            console.error('Error loading categories:', err);
        }
    }

    loadSeries() {
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
        this.seriesList = [];
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
        const first = this.seriesList.length === 0;

        try {
            const page = await API.proxy.browse('series', {
                ...this.query, offset: this.seriesList.length, limit: this.pageSize
            });
            if (token !== this.listToken) return; // filters changed meanwhile

            this.seriesList.push(...page.items);
            this.hasMore = page.hasMore;

            if (first) {
                this.container.innerHTML = '';
                if (page.items.length === 0) {
                    this.container.innerHTML = '<div class="empty-state"><p>No series found</p></div>';
                    return;
                }
                const loader = document.createElement('div');
                loader.className = 'series-loader';
                loader.innerHTML = '<div class="loading-spinner"></div>';
                this.container.appendChild(loader);
            }

            this.renderCards(page.items);

            const loader = this.container.querySelector('.series-loader');
            if (!this.hasMore) {
                if (loader) loader.style.display = 'none';
            } else if (loader) {
                // Re-observe so a loader still on screen asks for the next page
                this.observer.unobserve(loader);
                this.observer.observe(loader);
            }
        } catch (err) {
            if (token !== this.listToken) return;
            console.error('Error loading series:', err);
            if (first) {
                this.container.innerHTML = '<div class="empty-state"><p>Error loading series</p></div>';
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

        batch.forEach(series => {
            const card = document.createElement('div');
            card.className = 'series-card';
            card.dataset.seriesId = series.series_id;
            card.dataset.sourceId = series.sourceId;

            const poster = API.imageUrl(series.cover) || '/img/placeholder.png';
            const year = series.year || series.releaseDate?.substring(0, 4) || '';
            const rating = series.rating ? `${Icons.star} ${series.rating}` : '';

            const isFav = this.favoriteIds.has(`${series.sourceId}:${series.series_id}`);

            card.innerHTML = `
                <div class="series-poster">
                    <img src="${poster}" alt="${series.name}" 
                         onerror="this.onerror=null;this.src='/img/placeholder.png'" loading="lazy">
                    <div class="series-play-overlay">
                        <span class="play-icon">${Icons.play}</span>
                    </div>
                    <button class="favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
                        <span class="fav-icon">${isFav ? Icons.favorite : Icons.favoriteOutline}</span>
                    </button>
                </div>
                <div class="series-card-info">
                    <div class="series-title">${series.name}</div>
                    <div class="series-meta">
                        ${year ? `<span>${year}</span>` : ''}
                        ${rating ? `<span>${rating}</span>` : ''}
                    </div>
                </div>
            `;

            card.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) {
                    const btn = e.target.closest('.favorite-btn');
                    this.toggleFavorite(series, btn);
                    e.stopPropagation();
                } else {
                    this.showSeriesDetails(series);
                }
            });
            fragment.appendChild(card);
        });

        // Insert before loader
        const loader = this.container.querySelector('.series-loader');
        if (loader) {
            this.container.insertBefore(fragment, loader);
        } else {
            this.container.appendChild(fragment);
        }
    }

    /** opts.from: 'home' | 'search' when opened from Home (sets the Back target) */
    async showSeriesDetails(series, opts = {}) {
        this.currentSeries = series;
        this.detailsFrom = opts.from || null;
        if (this.backBtn) this.backBtn.textContent = ContentDetails.backLabel(this.detailsFrom, 'Series');

        // Show details panel
        this.container.classList.add('hidden');
        this.detailsPanel.classList.remove('hidden');

        // Set header info
        document.getElementById('series-poster').src = API.imageUrl(series.cover) || '/img/placeholder.png';
        document.getElementById('series-title').textContent = series.name;
        document.getElementById('series-plot').textContent = series.plot || '';
        document.getElementById('series-meta').innerHTML =
            ContentDetails.metaHtml({ rating: series.rating, year: series.year || series.releaseDate }, '');
        document.getElementById('series-credits').innerHTML = '';
        this.detailsPanel.scrollTop = 0;
        const token = this.detailsToken = (this.detailsToken || 0) + 1;
        // Header from the stored TMDB record now; re-run with series_info below
        this.renderSeriesMeta(series, {}, token);

        // Show loading
        this.seasonsContainer.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

        try {
            // Fetch series info (seasons/episodes)
            const info = await API.proxy.xtream.seriesInfo(series.sourceId, series.series_id);
            if (token !== this.detailsToken) return; // another series was opened meanwhile

            if (!info || !info.episodes) {
                this.seasonsContainer.innerHTML = '<p class="hint">No episodes found</p>';
                return;
            }

            // Store series info for WatchPage
            this.currentSeriesInfo = info;

            // Header details (not awaited - episodes render meanwhile)
            this.renderSeriesMeta(series, info, token);

            // Render seasons and episodes. Seasons start collapsed unless this
            // series had them open before (remembered in localStorage).
            let html = '';
            const seasons = Object.keys(info.episodes).sort((a, b) => parseInt(a) - parseInt(b));
            const seriesKey = `${series.sourceId}:${series.series_id}`;
            const expanded = this.expandedSeasons(seriesKey);

            seasons.forEach(seasonNum => {
                const episodes = info.episodes[seasonNum];
                html += `
                <div class="season-group ${expanded.has(String(seasonNum)) ? '' : 'collapsed'}" data-season="${seasonNum}">
                    <div class="season-header">
                        <span class="season-expander">${Icons.chevronDown}</span>
                        <span class="season-name">Season ${seasonNum} (${episodes.length} episodes)</span>
                    </div>
                    <div class="episode-list">
                        ${episodes.map(ep => `
                            <div class="episode-item" data-episode-id="${ep.id}" data-source-id="${series.sourceId}" data-container="${ep.container_extension || 'mp4'}">
                                <span class="episode-number">E${ep.episode_num}</span>
                                <span class="episode-title">${ep.title || `Episode ${ep.episode_num}`}</span>
                                <span class="episode-duration">${ep.duration || ''}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>`;
            });

            this.seasonsContainer.innerHTML = html;

            // Add click handlers
            this.seasonsContainer.querySelectorAll('.season-header').forEach(header => {
                header.addEventListener('click', () => {
                    const group = header.closest('.season-group');
                    const collapsed = group.classList.toggle('collapsed');
                    this.setSeasonExpanded(seriesKey, group.dataset.season, !collapsed);
                });
            });

            this.seasonsContainer.querySelectorAll('.episode-item').forEach(ep => {
                ep.addEventListener('click', () => this.playEpisode(ep));
            });

        } catch (err) {
            console.error('Error loading series info:', err);
            this.seasonsContainer.innerHTML = '<p class="hint" style="color: var(--color-error);">Error loading episodes</p>';
        }
    }

    /**
     * Seasons the user opened, per series ("sourceId:seriesId" -> [season, ...])
     */
    expandedSeasons(seriesKey) {
        try {
            const all = JSON.parse(localStorage.getItem('nodecast_tv_expanded_seasons') || '{}');
            return new Set(all[seriesKey] || []);
        } catch {
            return new Set();
        }
    }

    setSeasonExpanded(seriesKey, season, isExpanded) {
        try {
            const all = JSON.parse(localStorage.getItem('nodecast_tv_expanded_seasons') || '{}');
            const seasons = new Set(all[seriesKey] || []);
            if (isExpanded) seasons.add(String(season));
            else seasons.delete(String(season));
            if (seasons.size) all[seriesKey] = [...seasons];
            else delete all[seriesKey];
            localStorage.setItem('nodecast_tv_expanded_seasons', JSON.stringify(all));
        } catch (err) {
            console.warn('[Series] Could not save season state:', err);
        }
    }

    /**
     * Year/runtime/rating, playlist category, genre and credits from series_info
     */
    async renderSeriesMeta(series, info, token) {
        // Only the latest call for the latest series may write
        const seq = this.seriesMetaSeq = (this.seriesMetaSeq || 0) + 1;
        const providerMeta = info.info && !Array.isArray(info.info) ? info.info : {};

        // Stored TMDB record (local, no outside call) wins; provider data fills gaps
        const local = await ContentDetails.local('series', series.sourceId, series.series_id);
        const localInfo = Object.fromEntries(Object.entries(local?.info || {})
            .filter(([, value]) => value !== '' && value !== null && value !== undefined));
        const meta = { ...providerMeta, ...localInfo };
        const category = local?.category ||
            await ContentDetails.categoryName('series', series.sourceId, series.category_id || providerMeta.category_id);
        if (token !== this.detailsToken || seq !== this.seriesMetaSeq) return;

        document.getElementById('series-meta').innerHTML =
            ContentDetails.metaHtml({ ...meta, rating: meta.rating || series.rating }, category);
        const plotEl = document.getElementById('series-plot');
        // TMDB's overview replaces the list's plot; otherwise only fill a blank
        if (meta.plot && (local?.tmdb || !plotEl.textContent)) plotEl.textContent = meta.plot;
        document.getElementById('series-credits').innerHTML = ContentDetails.creditsHtml(meta);
    }

    hideDetails() {
        this.detailsPanel.classList.add('hidden');
        this.container.classList.remove('hidden');
        this.currentSeries = null;
        this.detailsFrom = null;
    }

    async playEpisode(episodeEl) {
        const episodeId = episodeEl.dataset.episodeId;
        const sourceId = parseInt(episodeEl.dataset.sourceId);
        const container = episodeEl.dataset.container || 'mp4';

        // Get season and episode number from the episode element context
        const seasonGroup = episodeEl.closest('.season-group');
        const seasonHeader = seasonGroup?.querySelector('.season-name')?.textContent || '';
        const seasonMatch = seasonHeader.match(/Season (\d+)/);
        const seasonNum = seasonMatch ? seasonMatch[1] : '1';
        const episodeNum = episodeEl.querySelector('.episode-number')?.textContent?.replace('E', '') || '1';

        try {
            // Get stream URL for episode (use 'series' type)
            const result = await API.proxy.xtream.getStreamUrl(sourceId, episodeId, 'series', container);

            if (result && result.url) {
                // Play in dedicated Watch page
                if (this.app.pages.watch) {
                    const episodeTitle = episodeEl.querySelector('.episode-title')?.textContent || `Episode ${episodeNum}`;

                    this.app.pages.watch.play({
                        type: 'series',
                        id: episodeId,
                        title: this.currentSeries?.name || 'Series',
                        subtitle: `S${seasonNum} E${episodeNum} - ${episodeTitle}`,
                        poster: this.currentSeries?.cover,
                        description: this.currentSeries?.plot || '',
                        year: this.currentSeries?.year,
                        rating: this.currentSeries?.rating,
                        sourceId: sourceId,
                        seriesId: this.currentSeries?.series_id,
                        seriesInfo: this.currentSeriesInfo,
                        currentSeason: seasonNum,
                        currentEpisode: episodeNum,
                        containerExtension: container
                    }, result.url);
                }
            }
        } catch (err) {
            console.error('Error playing episode:', err);
        }
    }

    async toggleFavorite(series, btn) {
        const favKey = `${series.sourceId}:${series.series_id}`;
        const isFav = this.favoriteIds.has(favKey);
        const iconSpan = btn.querySelector('.fav-icon');

        try {
            // Optimistic update
            if (isFav) {
                this.favoriteIds.delete(favKey);
                btn.classList.remove('active');
                btn.title = 'Add to Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
                await API.favorites.remove(series.sourceId, series.series_id, 'series');
            } else {
                this.favoriteIds.add(favKey);
                btn.classList.add('active');
                btn.title = 'Remove from Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
                await API.favorites.add(series.sourceId, series.series_id, 'series');
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

window.SeriesPage = SeriesPage;
