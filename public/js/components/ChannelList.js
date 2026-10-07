/**
 * Channel List Component
 * Handles the sidebar channel list
 */

class ChannelList {
    constructor() {
        this.container = document.getElementById('channel-list');
        this.searchInput = document.getElementById('channel-search');
        this.sourceSelect = document.getElementById('source-select');
        this.showHiddenCheckbox = document.getElementById('show-hidden');
        this.toggleGroupsBtn = document.getElementById('toggle-groups');
        this.contextMenu = document.getElementById('context-menu');

        // Channels are fetched a group at a time (see loadChannels/loadGroup):
        // `channels` holds every channel fetched so far, whatever group it came from
        this.channels = [];
        this.channelIndex = new Map(); // id -> channel
        this.groupParts = new Map(); // group name -> [{ sourceId, categoryId, count }]
        this.groupChannelCache = new Map(); // group name -> its channels, once fetched
        this.groupLoads = new Map(); // group name -> in-flight Promise
        this.favoriteChannels = []; // favourite channels with full details
        this.searchResults = null; // { term, channels, truncated } while searching
        this.allChannels = null; // every channel, only loaded for the TV Guide grid
        this.loaded = false;
        this.hiddenItems = new Set(); // Set<"type:sourceId:itemId">
        this.collapsedGroups = new Set(); // Track collapsed groups
        this._userExpandedGroups = new Set(); // Track groups user has explicitly expanded
        this.favorites = []; // Array of favorite objects
        this.visibleFavorites = new Set(); // Set<"sourceId:channelId">
        this.currentChannel = null;
        this.sources = [];
        this.isLoading = false;
        this.renderedChannels = [];

        this.loadCollapsedState();
        this.init();
    }

    /**
     * Get proxied image URL to avoid mixed content errors on HTTPS
     * Only proxies HTTP URLs when on HTTPS page
     */
    getProxiedImageUrl(url) {
        if (!url || url.length === 0) return '/img/placeholder.png';
        // Only proxy if we're on HTTPS and the image is HTTP
        if (window.location.protocol === 'https:' && url.startsWith('http://')) {
            return `/api/proxy/image?url=${encodeURIComponent(url)}`;
        }
        return url;
    }

    /**
     * Load collapsed state from localStorage
     */
    loadCollapsedState() {
        try {
            const saved = localStorage.getItem('nodecast_tv_collapsed_groups');
            if (saved) {
                this.collapsedGroups = new Set(JSON.parse(saved));
                this._hasCollapsedState = true;
            } else {
                this._hasCollapsedState = false; // First load - will collapse all by default
            }
        } catch (err) {
            console.error('Error loading collapsed state:', err);
            this._hasCollapsedState = false;
        }
    }

    /**
     * Save collapsed state to localStorage
     */
    saveCollapsedState() {
        try {
            localStorage.setItem('nodecast_tv_collapsed_groups', JSON.stringify([...this.collapsedGroups]));
        } catch (err) {
            console.error('Error saving collapsed state:', err);
        }
    }

    /**
     * Toggle group collapsed state
     */
    toggleGroup(groupName) {
        if (this.collapsedGroups.has(groupName)) {
            this.collapsedGroups.delete(groupName);
            // Track that user explicitly expanded this group
            this._userExpandedGroups.add(groupName);
        } else {
            this.collapsedGroups.add(groupName);
            // User collapsed it, remove from expanded tracking
            this._userExpandedGroups.delete(groupName);
        }
        this.saveCollapsedState();
    }

    /**
     * Expand all groups
     */
    expandAll() {
        this.collapsedGroups.clear();
        this.saveCollapsedState();

        // Expand all and render channels for empty containers
        this.container.querySelectorAll('.group-header.collapsed').forEach(h => {
            h.classList.remove('collapsed');
            const groupName = h.dataset.group;
            const groupEl = h.closest('.channel-group');
            const channelsContainer = groupEl?.querySelector('.group-channels');
            if (channelsContainer && channelsContainer.children.length === 0) {
                this.renderGroupChannels(groupName, channelsContainer);
            }
        });

        // Update toggle button
        if (this.toggleGroupsBtn) {
            this.toggleGroupsBtn.innerHTML = Icons.collapseAll;
            this.toggleGroupsBtn.title = 'Collapse All';
        }
    }

    /**
     * Collapse all groups
     */
    collapseAll() {
        this.container.querySelectorAll('.group-header').forEach(h => {
            const groupName = h.dataset.group;
            this.collapsedGroups.add(groupName);
            h.classList.add('collapsed');
        });
        this.saveCollapsedState();

        // Update toggle button
        if (this.toggleGroupsBtn) {
            this.toggleGroupsBtn.innerHTML = Icons.expandAll;
            this.toggleGroupsBtn.title = 'Expand All';
        }
    }

    /**
     * Toggle between expand/collapse all
     */
    toggleAllGroups() {
        const allHeaders = this.container.querySelectorAll('.group-header');
        const allCollapsed = [...allHeaders].every(h => h.classList.contains('collapsed'));

        if (allCollapsed) {
            this.expandAll();
        } else {
            this.collapseAll();
        }
    }

    init() {
        // Search handler (debounced)
        let searchTimeout;
        this.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.render();
            }, 300);
        });

        // Source filter handler
        this.sourceSelect.addEventListener('change', () => this.loadChannels());

        // Show hidden toggle (hidden channels are filtered server-side, so refetch)
        if (this.showHiddenCheckbox) {
            this.showHiddenCheckbox.addEventListener('change', () => this.loadChannels());
        }

        // Context menu handlers
        document.addEventListener('click', (e) => {
            // Don't close if clicking inside context menu
            if (!this.contextMenu.contains(e.target)) {
                this.hideContextMenu();
            }
        });

        this.contextMenu.querySelectorAll('.context-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent document click from firing
                this.handleContextAction(e);
            });
        });

        // Intersection Observer for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                this.renderNextBatch();
            }
        }, { rootMargin: '100px' });

        // Expanded groups whose channels aren't fetched yet load when scrolled near
        // (so "Expand all" doesn't fetch hundreds of groups at once)
        this.groupObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                this.groupObserver.unobserve(entry.target);
                this.fillGroup(entry.target);
            });
        }, { rootMargin: '200px' });

        // Start EPG refresh timer (updates visible program info every 60 seconds)
        this.startEpgRefreshTimer();
    }

    /**
     * Start timer to refresh EPG info in visible channel items
     * Updates every 60 seconds to keep "Now Playing" program info current
     */
    startEpgRefreshTimer() {
        // Clear any existing timer
        if (this._epgRefreshTimer) {
            clearInterval(this._epgRefreshTimer);
        }

        // Refresh every 60 seconds
        this._epgRefreshTimer = setInterval(() => {
            this.updateVisibleEpgInfo();
        }, 60000);
    }

    /**
     * Update EPG info for visible channel items without full re-render
     * Only updates the program text, not the entire channel item
     */
    updateVisibleEpgInfo() {
        if (!window.app || !window.app.epgGuide) return;

        // Fetch fresh "now" info for the channels currently in the list
        const channels = [];
        this.container.querySelectorAll('.channel-item').forEach(item => {
            const channel = this.channelIndex.get(item.dataset.channelId);
            if (channel) channels.push(channel);
        });
        this.refreshNowPlaying(channels, true);
    }

    /**
     * Ask the server what's on now for these channels (the full EPG is only
     * downloaded by the TV Guide page), then update their program lines
     */
    async refreshNowPlaying(channels, force = false) {
        const epgGuide = window.app?.epgGuide;
        if (!epgGuide?.fetchNow || channels.length === 0) return;
        try {
            await epgGuide.fetchNow(channels, { force });
        } catch (err) {
            console.warn('[ChannelList] Now-playing fetch failed:', err);
            return;
        }
        this.clearProgramInfoCache();
        this.container.querySelectorAll('.channel-item').forEach(item => {
            const channel = this.channelIndex.get(item.dataset.channelId);
            const programElement = item.querySelector('.channel-program');
            if (channel && programElement) {
                programElement.textContent = this.getProgramInfo(channel) || '';
            }
        });
    }


    /**
     * Get current program info string - cached for performance
     */
    getProgramInfo(channel) {
        try {
            if (!window.app || !window.app.epgGuide) return null;

            // Cache key: channel_id + current_minute (invalidate every minute)
            const currentMinute = Math.floor(Date.now() / 60000);
            const cacheKey = `${channel.tvgId || channel.name}:${currentMinute}`;

            if (this._programInfoCache && this._programInfoCache.has(cacheKey)) {
                return this._programInfoCache.get(cacheKey);
            }

            // Clear old cache entries if minute changed
            if (!this._lastCacheMinute || this._lastCacheMinute !== currentMinute) {
                this._programInfoCache = new Map();
                this._lastCacheMinute = currentMinute;
            }

            const program = window.app.epgGuide.getCurrentProgram(channel.tvgId, channel.name);
            const result = program ? program.title : null;

            this._programInfoCache.set(cacheKey, result);
            return result;
        } catch (e) {
            console.warn("Error in getProgramInfo", e);
            return null;
        }
    }

    /**
     * Clear program info cache
     * Useful when EPG data has been updated
     */
    clearProgramInfoCache() {
        if (this._programInfoCache) {
            this._programInfoCache.clear();
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * Group order from Settings > Language Priority (settings live on the app,
     * which this component isn't given). Returns group -> rank (lower first) or
     * null for plain alphabetical:
     *  - "Hide titles in other languages" on + English: US groups ("US| ...")
     *    first, always - not just while searching
     *  - while searching: then the other groups in the priority language
     */
    groupRanker(searching) {
        if (typeof LanguagePriority === 'undefined') return null;
        const language = LanguagePriority.selected(window.app);
        const usFirst = LanguagePriority.hardFilter(window.app) && language === 'en';
        const inLanguage = searching && language ? LanguagePriority.matcher(language) : null;
        if (!usFirst && !inLanguage) return null;
        return group => {
            if (usFirst && LanguagePriority.prefixCode(group) === 'US') return 0;
            if (inLanguage && inLanguage('', group)) return 1;
            return 2;
        };
    }

    /**
     * "Hide titles in other languages": drop channels whose name or group is
     * explicitly another language; unmarked channels stay (same rules as search)
     */
    applyLanguageFilter(channels) {
        if (typeof LanguagePriority === 'undefined' || !LanguagePriority.hardFilter(window.app)) {
            return channels;
        }
        if (!LanguagePriority.loaded) {
            // Rules not fetched yet: fetch once, then redo this render
            if (!this._languageLoadStarted) {
                this._languageLoadStarted = true;
                LanguagePriority.load().then(() => this.render());
            }
            return channels;
        }
        const language = LanguagePriority.selected(window.app);
        return channels.filter(ch => LanguagePriority.visible(ch.name, ch.groupTitle, language));
    }

    /**
     * Render channel list. While searching, the matching channels come from the
     * server; otherwise groups render from the group list and a group's channels
     * are fetched when it is expanded.
     */
    render() {
        const searchTerm = this.searchInput.value.trim();
        if (searchTerm && this.searchResults?.term !== searchTerm) {
            this.runSearch(searchTerm);
            return;
        }
        if (!searchTerm) {
            this.searchResults = null;
            this._searchToken = (this._searchToken || 0) + 1; // drop any search in flight
        }
        this.renderGroups();
    }

    async runSearch(term) {
        const token = this._searchToken = (this._searchToken || 0) + 1;
        this.container.innerHTML = '<div class="loading"></div>';
        try {
            const hasLanguage = typeof LanguagePriority !== 'undefined';
            const result = await API.live.search(term, {
                source: this.sourceSelect.value,
                includeHidden: this.includeHidden() ? 1 : '',
                // Settings > "Hide titles in other languages" applies to Live TV search
                lang: hasLanguage ? LanguagePriority.selected(window.app) : '',
                hard: hasLanguage && LanguagePriority.hardFilter(window.app) ? 1 : ''
            });
            if (token !== this._searchToken) return; // a newer search (or none) since
            this.searchResults = { term, channels: this.rememberChannels(result.channels), truncated: result.truncated };
        } catch (err) {
            if (token !== this._searchToken) return;
            console.error('Channel search failed:', err);
            this.searchResults = { term, channels: [], truncated: false };
        }
        this.renderGroups();
    }

    includeHidden() {
        return !!this.showHiddenCheckbox?.checked;
    }

    isChannelVisible(channel, showHidden) {
        const rawChannelId = channel.streamId || channel.id;
        return showHidden || !this.isHidden('channel', channel.sourceId, rawChannelId);
    }

    matchesSourceFilter(channel) {
        const value = this.sourceSelect.value;
        return !value || value === `${channel.sourceType}:${channel.sourceId}`;
    }

    renderIdFor(groupName, channel) {
        return `${groupName}|${channel.id}`;
    }

    renderGroups() {
        const searching = !!this.searchResults;
        const showHidden = this.includeHidden();

        // Reset batching
        this.currentBatch = 0;
        this.batchSize = 100; // Number of groups to render per batch
        this.container.innerHTML = ''; // Clear container

        // Group name -> channels (null = not fetched yet), and channel counts
        const groupedChannels = {};
        const groupCounts = {};
        if (searching) {
            this.searchResults.channels.forEach(ch => {
                const groupKey = ch.groupTitle || 'Uncategorized';
                (groupedChannels[groupKey] = groupedChannels[groupKey] || []).push(ch);
            });
            Object.keys(groupedChannels).forEach(g => { groupCounts[g] = groupedChannels[g].length; });
        } else {
            this.groupParts.forEach((parts, groupName) => {
                groupedChannels[groupName] = this.groupChannelCache.get(groupName) || null;
                groupCounts[groupName] = parts.reduce((n, p) => n + p.count, 0);
            });
        }

        // Favorites (those from the selected source)
        const favoritedChannels = this.favoriteChannels.filter(ch =>
            this.isFavorite(ch.sourceId, ch.id) && this.matchesSourceFilter(ch));
        if (favoritedChannels.length > 0) {
            favoritedChannels.sort((a, b) => a.name.localeCompare(b.name));
            groupedChannels['Favorites'] = favoritedChannels;
            groupCounts['Favorites'] = favoritedChannels.length;
        }

        // Sort Groups and filter to only those with visible channels.
        // Language Priority may lead with some groups (see groupRanker).
        const rank = this.groupRanker(searching);
        const allGroups = Object.keys(groupedChannels).sort((a, b) => {
            if (a === 'Favorites') return -1;
            if (b === 'Favorites') return 1;
            if (rank && rank(a) !== rank(b)) return rank(a) - rank(b);
            return a.localeCompare(b);
        });

        // Groups not fetched yet count as visible when the server counted channels
        // in them (it already leaves hidden ones out unless "show hidden" is on)
        this.sortedGroups = allGroups.filter(groupName => {
            const channels = groupedChannels[groupName];
            if (!channels) return groupCounts[groupName] > 0;
            if (groupName === 'Favorites') return true;
            return channels.some(channel => this.isChannelVisible(channel, showHidden));
        });

        this.groupedChannels = groupedChannels;
        this.groupCounts = groupCounts;
        this.showHidden = showHidden;

        // Collapse all groups by default on first load (for large playlists)
        if (!this._hasCollapsedState && this.sortedGroups.length > 0) {
            this.sortedGroups.forEach(groupName => {
                if (groupName !== 'Favorites') {
                    this.collapsedGroups.add(groupName);
                }
            });
            this._hasCollapsedState = true;
            this.saveCollapsedState();
        }

        this.buildRenderedChannels();

        // Empty State
        if (this.sortedGroups.length === 0) {
            this.container.innerHTML = `
        <div class="empty-state">
          <p>${searching ? 'No channels match your search' : 'No channels loaded'}</p>
          <p class="hint">${searching ? 'Try a different search term' : 'Add a source in Settings to get started'}</p>
        </div>
      `;
            return;
        }

        // Wrap container content in a specific list div to append to
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'channel-list-content';
        this.container.appendChild(this.listContainer);

        if (searching && this.searchResults.truncated) {
            const note = document.createElement('div');
            note.className = 'empty-state hint';
            note.textContent = `Showing the first ${this.searchResults.channels.length} matches - type more to narrow it down`;
            this.listContainer.appendChild(note);
        }

        // Add loader element at bottom
        this.loader = document.createElement('div');
        this.loader.className = 'batch-loader';
        this.loader.innerHTML = '<div class="loading-spinner"></div>';
        this.loader.style.opacity = '0'; // Hide initially
        this.container.appendChild(this.loader);

        // Render initial batches - load just enough to fill visible area + buffer
        const maxInitialBatches = 2;
        for (let i = 0; i < maxInitialBatches; i++) {
            if (this.currentBatch * this.batchSize >= this.sortedGroups.length) break;
            this.renderNextBatch();
        }

        // Start observing loader for additional batches
        this.observer.observe(this.loader);
    }

    /**
     * Channels in display order, for prev/next. Only groups whose channels have
     * been fetched take part.
     */
    buildRenderedChannels() {
        this.renderedChannels = [];
        (this.sortedGroups || []).forEach(groupName => {
            const channels = this.groupedChannels[groupName];
            if (!channels) return;
            const isFavoritesGroup = groupName === 'Favorites';
            channels.forEach(ch => {
                if (!isFavoritesGroup && !this.isChannelVisible(ch, this.showHidden)) return;
                this.renderedChannels.push({
                    ...ch,
                    _renderId: this.renderIdFor(groupName, ch),
                    _renderGroup: groupName // Track visual group for navigation
                });
            });
        });
    }

    /**
     * Render next batch of groups
     */
    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const groupsToRender = this.sortedGroups.slice(start, end);

        if (groupsToRender.length === 0) {
            // No more groups
            this.loader.style.display = 'none';
            return;
        }

        this.loader.style.opacity = '1';
        let html = '';
        const shownChannels = [];

        for (const groupName of groupsToRender) {
            const channels = this.groupedChannels[groupName];
            const isFavoritesGroup = groupName === 'Favorites';

            // Visible channels, when the group's channels are fetched
            const visibleChannels = channels
                ? channels.filter(ch => isFavoritesGroup || this.isChannelVisible(ch, this.showHidden))
                : null;
            if (visibleChannels && visibleChannels.length === 0) continue;
            const count = visibleChannels ? visibleChannels.length : this.groupCounts[groupName];

            // Default new groups to collapsed (except Favorites)
            if (!isFavoritesGroup && !this.collapsedGroups.has(groupName) && !this._userExpandedGroups?.has(groupName)) {
                this.collapsedGroups.add(groupName);
            }
            const collapsed = this.collapsedGroups.has(groupName);
            const safeName = this.escapeHtml(groupName);

            html += `
        <div class="channel-group">
          <div class="group-header ${collapsed ? 'collapsed' : ''} ${isFavoritesGroup ? 'favorites-group' : ''}" data-group="${safeName}">
            <span class="group-toggle">${Icons.chevronDown}</span>
            <span class="group-name">${safeName}</span>
            <span class="group-count">${count}</span>
          </div>
          <div class="group-channels" data-group="${safeName}">`;

            // Collapsed groups render their channels when expanded
            if (!collapsed && visibleChannels) {
                html += this.channelItemsHtml(groupName, visibleChannels);
                shownChannels.push(...visibleChannels);
            }
            html += '</div></div>';
        }

        // Append to list container
        // Use temp div to parse HTML string
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        while (tempDiv.firstElementChild) {
            const groupEl = tempDiv.firstElementChild;
            this.attachGroupListeners(groupEl);
            this.listContainer.appendChild(groupEl);

            // Expanded group whose channels aren't fetched yet
            const header = groupEl.querySelector('.group-header');
            const channelsContainer = groupEl.querySelector('.group-channels');
            if (header && !header.classList.contains('collapsed') && channelsContainer.children.length === 0) {
                this.renderGroupChannels(header.dataset.group, channelsContainer);
            }
        }

        this.currentBatch++;

        // Hide loader if we might be done (next batch check will confirm)
        if (end >= this.sortedGroups.length) {
            this.loader.style.display = 'none';
        }

        this.refreshNowPlaying(shownChannels);
    }

    /**
     * Channel rows for a group
     */
    channelItemsHtml(groupName, channels) {
        const isFavoritesGroup = groupName === 'Favorites';
        return channels.map(channel => {
            // Check hidden again for styling (showHidden mode)
            const channelHidden = !isFavoritesGroup && !this.isChannelVisible(channel, false);
            const isActive = this.currentChannel?.id === channel.id;
            const renderId = this.renderIdFor(groupName, channel);
            const isRenderActive = this.currentRenderId === renderId;
            const isFavorite = this.isFavorite(channel.sourceId, channel.id);

            return `
          <div class="channel-item ${isActive ? 'active' : ''} ${isRenderActive ? 'nav-active' : ''} ${channelHidden ? 'hidden' : ''}"
               data-channel-id="${channel.id}"
               data-source-id="${channel.sourceId}"
               data-source-type="${channel.sourceType}"
               data-stream-id="${channel.streamId || ''}"
               data-url="${this.escapeHtml(channel.url || '')}"
               data-render-id="${this.escapeHtml(renderId)}"
               data-render-group="${this.escapeHtml(groupName)}">
            <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}"
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.escapeHtml(this.getProgramInfo(channel) || '')}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
          </div>
        `;
        }).join('');
    }

    attachGroupListeners(groupEl) {
        const header = groupEl.querySelector('.group-header');
        if (header) {
            header.addEventListener('click', () => {
                const groupName = header.dataset.group;
                const isCollapsed = header.classList.contains('collapsed');

                header.classList.toggle('collapsed');
                this.toggleGroup(groupName);

                // If expanding, render channels if they weren't rendered initially
                if (isCollapsed) {
                    const channelsContainer = groupEl.querySelector('.group-channels');
                    if (channelsContainer && channelsContainer.children.length === 0) {
                        // Channels weren't rendered - render them now
                        this.renderGroupChannels(groupName, channelsContainer);
                    }
                }
            });
            header.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'group', header.dataset));
        }

        this.attachItemListeners(groupEl);
    }

    attachItemListeners(el) {
        el.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) return;
                this.selectChannel(item.dataset);
            });
            item.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', item.dataset));

            const favBtn = item.querySelector('.favorite-btn');
            if (favBtn) {
                favBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.channelId);
                });
            }
        });
    }

    /**
     * Render channels for a specific group (called when expanding a collapsed
     * group). Channels not fetched yet load once the group is near the viewport.
     */
    renderGroupChannels(groupName, container) {
        container.dataset.group = groupName;
        if (this.groupedChannels?.[groupName]) {
            this.fillGroup(container);
        } else {
            container.innerHTML = '<div class="loading-spinner"></div>';
            this.groupObserver.observe(container);
        }
    }

    /**
     * Fill a group's container with its channels, fetching them first if needed
     */
    async fillGroup(container) {
        const groupName = container.dataset.group;
        let channels = this.groupedChannels?.[groupName];
        if (!channels) {
            try {
                channels = await this.loadGroup(groupName);
            } catch (err) {
                console.error(`Error loading channels for ${groupName}:`, err);
                container.innerHTML = '<div class="empty-state hint">Error loading channels</div>';
                return;
            }
            if (!container.isConnected) return; // the list was re-rendered meanwhile
        }

        const isFavoritesGroup = groupName === 'Favorites';
        const visibleChannels = channels.filter(ch => isFavoritesGroup || this.isChannelVisible(ch, this.showHidden));
        container.innerHTML = this.channelItemsHtml(groupName, visibleChannels);
        this.attachItemListeners(container);

        const countSpan = container.previousElementSibling?.querySelector('.group-count');
        if (countSpan) countSpan.textContent = visibleChannels.length;

        this.refreshNowPlaying(visibleChannels);
    }

    /**
     * Fetch one group's channels (all its source categories). Shared while in flight.
     */
    loadGroup(groupName) {
        if (this.groupLoads.has(groupName)) return this.groupLoads.get(groupName);

        const parts = this.groupParts.get(groupName) || [];
        const includeHidden = this.includeHidden();
        const generation = this.loadGeneration;
        const promise = Promise.all(parts.map(p => API.live.channels(p.sourceId, p.categoryId, includeHidden)))
            .then(results => {
                const channels = this.rememberChannels(results.flat());
                if (generation === this.loadGeneration) {
                    this.groupChannelCache.set(groupName, channels);
                    if (this.groupedChannels && !this.searchResults) {
                        this.groupedChannels[groupName] = channels;
                        this.buildRenderedChannels();
                    }
                }
                return channels;
            })
            .finally(() => {
                if (this.groupLoads.get(groupName) === promise) this.groupLoads.delete(groupName);
            });
        this.groupLoads.set(groupName, promise);
        return promise;
    }

    /**
     * Add channels to the known set; returns the canonical objects
     */
    rememberChannels(list) {
        return (list || []).map(ch => {
            const known = this.channelIndex.get(ch.id);
            if (known) return known;
            this.channelIndex.set(ch.id, ch);
            this.channels.push(ch);
            return ch;
        });
    }

    /**
     * Load sources into dropdown
     */
    async loadSources() {
        try {
            this.sources = await API.sources.getAll();
            console.log('[ChannelList] loadSources: Got', this.sources?.length || 0, 'sources');
            this.sourceSelect.innerHTML = '<option value="">All Sources</option>';

            const xtreamSources = this.sources.filter(s => s.type === 'xtream' && s.enabled);
            const m3uSources = this.sources.filter(s => s.type === 'm3u' && s.enabled);

            if (xtreamSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'Xtream';
                xtreamSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `xtream:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }

            if (m3uSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'M3U';
                m3uSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `m3u:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    /**
     * Load the group list (with channel counts) and the favourite channels for
     * the selected source. A group's channels are fetched when it is expanded
     * (loadGroup), so the full channel list never has to come down.
     */
    loadChannels() {
        if (this._loadPromise) return this._loadPromise;
        this._loadPromise = this.loadGroups().finally(() => { this._loadPromise = null; });
        return this._loadPromise;
    }

    async loadGroups() {
        this.isLoading = true;
        this.currentRenderId = null; // Reset render tracking
        this.loadGeneration = (this.loadGeneration || 0) + 1;
        this.container.innerHTML = '<div class="loading"></div>';

        try {
            const [groups, favorites] = await Promise.all([
                API.live.groups(this.sourceSelect.value, this.includeHidden()),
                API.live.favorites(),
                this.loadHiddenItems(),
                this.loadFavorites()
            ]);

            // Same-named categories from different sources show as one group
            this.groupParts = new Map();
            groups.forEach(g => {
                if (!this.groupParts.has(g.name)) this.groupParts.set(g.name, []);
                this.groupParts.get(g.name).push({ sourceId: g.sourceId, categoryId: g.categoryId, count: g.count });
            });
            this.groupChannelCache = new Map();
            this.groupLoads = new Map();
            this.allChannels = null; // sources may have changed
            this.favoriteChannels = this.rememberChannels(favorites);
            this.searchResults = null; // re-run any search for the new source/filters
            this.loaded = true;

            this.render();
        } catch (err) {
            console.error('Error loading channels:', err);
            this.container.innerHTML = `<div class="empty-state"><p>Error loading channels</p><p class="hint">${this.escapeHtml(err.message)}</p></div>`;
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Every channel of every enabled source - only the TV Guide grid needs this
     */
    async loadAllChannelsForGuide() {
        if (this.allChannels) return this.allChannels;
        if (this.sources.length === 0) await this.loadSources();

        const all = [];
        for (const source of this.sources.filter(s => (s.type === 'xtream' || s.type === 'm3u') && s.enabled)) {
            all.push(...await this.fetchSourceChannels(source.id, source.type));
        }
        this.allChannels = this.rememberChannels(all);
        return this.allChannels;
    }

    /**
     * All live channels of one source (Xtream-style endpoints serve M3U too)
     */
    async fetchSourceChannels(sourceId, sourceType) {
        const [categories, streams] = await Promise.all([
            API.proxy.xtream.liveCategories(sourceId),
            API.proxy.xtream.liveStreams(sourceId)
        ]);
        // Use string keys to handle type mismatches (number vs string category_id)
        const categoryNames = new Map(categories.map(c => [String(c.category_id), c.category_name]));

        return streams.map(stream => ({
            id: `${sourceType}_${sourceId}_${stream.stream_id}`,
            streamId: stream.stream_id,
            name: stream.name,
            tvgId: stream.epg_channel_id,
            tvgLogo: stream.stream_icon,
            url: sourceType === 'm3u' ? stream.stream_url : undefined, // M3U has direct URLs
            groupId: `${sourceType}_${sourceId}_${stream.category_id}`,
            groupTitle: categoryNames.get(String(stream.category_id)) || 'Uncategorized',
            sourceId,
            sourceType
        }));
    }

    /**
     * Load hidden items
     */
    async loadHiddenItems() {
        try {
            const items = await API.channels.getHidden();
            this.hiddenItems = new Set(items.map(i => `${i.item_type}:${i.source_id}:${i.item_id}`));
        } catch (err) {
            console.error('Error loading hidden items:', err);
        }
    }

    /**
     * Check if item is hidden
     */
    isHidden(type, sourceId, itemId) {
        return this.hiddenItems.has(`${type}:${sourceId}:${itemId}`);
    }

    /**
     * Load favorites
     */
    async loadFavorites() {
        try {
            // Get all favorites (filtered for channels or legacy items without type)
            const allFavs = await API.favorites.getAll();
            const channelFavs = allFavs.filter(f => !f.item_type || f.item_type === 'channel');

            this.visibleFavorites = new Set(
                channelFavs.map(f => `${f.source_id}:${f.item_id || f.channel_id}`)
            );
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    /**
     * Check if channel is favorite
     */
    isFavorite(sourceId, channelId) {
        return this.visibleFavorites.has(`${sourceId}:${channelId}`);
    }

    /**
     * Toggle favorite status
     */
    async toggleFavorite(sourceId, channelId) {
        const key = `${sourceId}:${channelId}`;
        const wasFavorite = this.visibleFavorites.has(key);

        // Find all buttons for this channel in the DOM (it may appear in multiple groups)
        const btns = document.querySelectorAll(`.channel-item[data-channel-id="${channelId}"][data-source-id="${sourceId}"] .favorite-btn`);

        try {
            // Optimistic update
            if (wasFavorite) {
                this.visibleFavorites.delete(key);
                btns.forEach(btn => {
                    btn.classList.remove('active');
                    btn.innerHTML = Icons.favoriteOutline;
                    btn.title = 'Add to Favorites';
                });
            } else {
                this.visibleFavorites.add(key);
                btns.forEach(btn => {
                    btn.classList.add('active');
                    btn.innerHTML = Icons.favorite;
                    btn.title = 'Remove from Favorites';
                });
            }

            // Updates Favorites Group DOM
            const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
            if (channel) {
                this.updateFavoritesGroup(channel, !wasFavorite);
            }
            // Do NOT call this.render() - it causes lag

            // Perform API call
            if (wasFavorite) {
                await API.favorites.remove(sourceId, channelId, 'channel');
            } else {
                await API.favorites.add(sourceId, channelId, 'channel');
            }

            // Sync to EPG Guide
            if (window.app?.epgGuide) {
                window.app.epgGuide.syncFavorite(sourceId, channelId, !wasFavorite);
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            // Revert on error
            if (wasFavorite) {
                this.visibleFavorites.add(key);
                btns.forEach(btn => {
                    btn.classList.add('active');
                    btn.innerHTML = Icons.favorite;
                });
                // Revert group update
                const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
                if (channel) this.updateFavoritesGroup(channel, true);
            } else {
                this.visibleFavorites.delete(key);
                btns.forEach(btn => {
                    btn.classList.remove('active');
                    btn.innerHTML = Icons.favoriteOutline;
                });
                // Revert group update
                const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
                if (channel) this.updateFavoritesGroup(channel, false);
            }
        }
    }

    /**
     * Update Favorites group in DOM and data
     */
    updateFavoritesGroup(channel, isAdded) {
        // 1. Update Data (favoriteChannels feeds the Favorites group on each render)
        if (isAdded && !this.favoriteChannels.some(c => c.id === channel.id)) {
            this.favoriteChannels.push(channel);
        }
        if (!this.groupedChannels || !this.listContainer) return; // list not rendered yet
        if (!this.groupedChannels['Favorites']) {
            this.groupedChannels['Favorites'] = [];
        }

        const favArray = this.groupedChannels['Favorites'];
        const existingIdx = favArray.findIndex(c => c.id === channel.id && c.sourceId === channel.sourceId);

        if (isAdded) {
            if (existingIdx === -1) favArray.push(channel);
        } else {
            if (existingIdx !== -1) favArray.splice(existingIdx, 1);
        }

        // 2. Update DOM
        const groupHeader = this.listContainer.querySelector('.group-header[data-group="Favorites"]');

        if (!groupHeader) {
            // If group doesn't exist and we're adding, we ideally should create it
            // For now, simpler to just return. User will see it on next refresh.
            // Or we could force a re-render if it's the first favorite? 
            if (isAdded && favArray.length === 1) {
                this.render(); // This is the one case where full render is worth it
            }
            return;
        }

        const groupChannels = groupHeader.nextElementSibling; // .group-channels
        const countSpan = groupHeader.querySelector('.group-count');

        if (isAdded) {
            // Check if already in DOM (to avoid dupes)
            const existingEl = groupChannels.querySelector(`.channel-item[data-channel-id="${channel.id}"][data-source-id="${channel.sourceId}"]`);
            if (!existingEl) {
                const newEl = this.createChannelElement(channel);
                groupChannels.appendChild(newEl);
            }
        } else {
            const existingEl = groupChannels.querySelector(`.channel-item[data-channel-id="${channel.id}"][data-source-id="${channel.sourceId}"]`);
            if (existingEl) {
                existingEl.remove();
            }
        }

        // Update count
        if (countSpan) countSpan.textContent = favArray.length;

        // Hide/Show group if empty?
        if (favArray.length === 0) {
            groupHeader.classList.add('hidden'); // Or remove
            groupHeader.style.display = 'none';
        } else {
            groupHeader.classList.remove('hidden');
            groupHeader.style.display = '';
        }
    }

    createChannelElement(channel) {
        const div = document.createElement('div');
        const isActive = this.currentChannel?.id === channel.id;
        // In Favorites group, it IS a favorite
        const isFavorite = true;

        div.className = `channel-item ${isActive ? 'active' : ''}`;
        div.dataset.channelId = channel.id;
        div.dataset.sourceId = channel.sourceId;
        div.dataset.sourceType = channel.sourceType;
        div.dataset.streamId = channel.streamId || '';
        div.dataset.url = channel.url || '';
        div.dataset.renderId = this.renderIdFor('Favorites', channel);
        div.dataset.renderGroup = 'Favorites';

        div.innerHTML = `
            <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.getProgramInfo(channel) || ''}</div>
            </div>
            <button class="favorite-btn active" title="Remove from Favorites">
              ❤️
            </button>
        `;

        // Attach listeners
        div.addEventListener('click', (e) => {
            if (e.target.closest('.favorite-btn')) return;
            // Pass the render ID from the dataset
            this.selectChannel({ ...div.dataset, renderId: div.dataset.renderId });
        });
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', div.dataset));

        const favBtn = div.querySelector('.favorite-btn');
        if (favBtn) {
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFavorite(parseInt(div.dataset.sourceId), div.dataset.channelId);
            });
        }

        return div;
    }

    /**
     * Select and play a channel. `dataset.channel` may carry the channel itself
     * (e.g. from Home) when its group hasn't been fetched.
     */
    async selectChannel(dataset) {
        let channel = this.channelIndex.get(dataset.channelId);
        if (!channel && dataset.channel) channel = this.rememberChannels([dataset.channel])[0];
        if (!channel) return;

        this.currentChannel = channel;
        this.currentRenderId = dataset.renderId; // Track which visual instance is active
        this.currentRenderGroup = dataset.renderGroup; // Track which group the selection came from

        // Mark it in the list (may fetch its group) while the stream starts
        this.highlightChannel(channel);

        // Get stream URL
        let streamUrl;
        if (channel.sourceType === 'xtream') {
            // Get stream format from player settings (server-side) or fallback
            const streamFormat = window.app?.player?.settings?.streamFormat || 'm3u8';
            const result = await API.proxy.xtream.getStreamUrl(channel.sourceId, channel.streamId, 'live', streamFormat);
            streamUrl = result.url;
        } else {
            streamUrl = channel.url;
        }

        // Play channel
        if (window.app?.player) {
            window.app.player.play(channel, streamUrl);
        }
    }

    /**
     * Mark the channel active in the list, opening (and fetching) its group if
     * it isn't on screen, then scroll to it
     */
    async highlightChannel(channel) {
        // The group list may still be loading (e.g. arriving from Home)
        if (this._loadPromise) await this._loadPromise;
        if (this.currentChannel !== channel) return; // another channel was picked meanwhile

        // Update active state in DOM
        this.container.querySelectorAll('.channel-item.active').forEach(el => {
            el.classList.remove('active');
            el.classList.remove('nav-active');
        });

        // Try to find specific render instance first, then any row for the channel
        let activeItem = this.currentRenderId
            ? this.container.querySelector(`.channel-item[data-render-id="${CSS.escape(this.currentRenderId)}"]`)
            : null;
        if (!activeItem) {
            activeItem = this.container.querySelector(`.channel-item[data-channel-id="${CSS.escape(channel.id)}"]`);
        }

        // Not on screen: open the channel's own group
        if (!activeItem && !this.searchResults) {
            const groupName = channel.groupTitle || 'Uncategorized';
            const groupHeader = this.findGroupHeader(groupName);
            const channelsContainer = groupHeader?.nextElementSibling;
            if (channelsContainer) {
                groupHeader.classList.remove('collapsed');
                this.collapsedGroups.delete(groupName);
                this._userExpandedGroups.add(groupName);
                if (!channelsContainer.querySelector('.channel-item')) {
                    this.groupObserver.unobserve(channelsContainer);
                    channelsContainer.dataset.group = groupName;
                    await this.fillGroup(channelsContainer);
                    if (this.currentChannel !== channel) return;
                }
                activeItem = channelsContainer.querySelector(`.channel-item[data-channel-id="${CSS.escape(channel.id)}"]`);
            }
        }

        if (!activeItem) return;
        this.currentRenderId = activeItem.dataset.renderId;
        this.currentRenderGroup = activeItem.dataset.renderGroup;
        activeItem.classList.add('active');
        activeItem.classList.add('nav-active'); // Add specific class for navigation tracking

        // Handle Group Expansion & Scrolling (Focus Mode)
        const groupHeader = activeItem.closest('.channel-group')?.querySelector('.group-header');
        if (groupHeader) {
            const groupName = groupHeader.dataset.group;

            // 1. Expand current group if needed
            if (this.collapsedGroups.has(groupName)) {
                this.collapsedGroups.delete(groupName);
                // Update DOM directly for immediate feedback
                groupHeader.classList.remove('collapsed');
            }

            // 2. Collapse ALL other groups (Focus Mode)
            document.querySelectorAll('.group-header').forEach(header => {
                if (header !== groupHeader && !header.classList.contains('collapsed')) {
                    const otherGroup = header.dataset.group;
                    this.collapsedGroups.add(otherGroup);
                    header.classList.add('collapsed');
                }
            });
            this.saveCollapsedState();

            // 3. Scroll Group to Top
            // Use a small timeout to allow layout updates (e.g. collapse animations) to start
            setTimeout(() => {
                groupHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
                // Ensure active item is visible within the group
                setTimeout(() => {
                    activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }, 50);
            }, 50);
        } else {
            // Fallback for non-grouped items or flat list
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    /**
     * A group's header, rendering further batches of groups if needed
     */
    findGroupHeader(groupName) {
        if (!this.listContainer?.isConnected) return null;
        const find = () => this.container.querySelector(`.group-header[data-group="${CSS.escape(groupName)}"]`);
        let header = find();
        while (!header && this.currentBatch * this.batchSize < this.sortedGroups.length) {
            this.renderNextBatch();
            header = find();
        }
        return header;
    }

    /**
     * Show context menu
     */
    showContextMenu(e, type, data) {
        e.preventDefault();
        this.contextMenu.dataset.type = type;
        this.contextMenu.dataset.sourceId = data.sourceId;
        this.contextMenu.dataset.itemId = type === 'group' ? data.group : data.channelId;
        this.contextMenu.dataset.streamId = data.streamId || '';

        this.contextMenu.style.left = `${e.clientX}px`;
        this.contextMenu.style.top = `${e.clientY}px`;
        this.contextMenu.classList.add('active');
    }

    /**
     * Hide context menu
     */
    hideContextMenu() {
        this.contextMenu.classList.remove('active');
    }

    /**
     * Handle context menu action
     */
    async handleContextAction(e) {
        const action = e.target.dataset.action;
        const { type, sourceId, itemId, streamId } = this.contextMenu.dataset;

        switch (action) {
            case 'play':
                if (type === 'channel') {
                    const channel = this.channels.find(c => c.id === itemId);
                    if (channel) {
                        await this.selectChannel({ channelId: channel.id });
                    }
                }
                break;
            case 'hide':
                // Use streamId for hiding Xtream channels (raw ID, not composite)
                // Server expects 'channel' type, not 'live'
                const hideId = streamId || itemId;
                await API.channels.hide(parseInt(sourceId), 'channel', hideId);
                this.hiddenItems.add(`channel:${sourceId}:${hideId}`);
                this.render();
                break;
            case 'epg':
                // Show EPG info modal
                this.showEpgInfo(sourceId, itemId, streamId);
                break;
        }

        this.hideContextMenu();
    }

    /**
     * Show EPG info for a channel
     */
    showEpgInfo(sourceId, channelId, streamId) {
        const channel = this.channels.find(c => c.id === channelId);
        if (!channel) {
            alert('Channel not found');
            return;
        }

        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modal-title');
        const modalBody = document.getElementById('modal-body');

        if (!modal || !modalTitle || !modalBody) return;

        modalTitle.textContent = `📋 ${channel.name} - EPG Info`;

        // Get current and upcoming programs
        let programsHtml = '<p class="no-programs">No EPG data available for this channel.</p>';

        if (window.app?.epgGuide) {
            const tvgKey = channel.tvgId || channel.name;
            const currentProgram = window.app.epgGuide.getCurrentProgram(channel.tvgId, channel.name);
            const programs = window.app.epgGuide.getChannelPrograms?.(tvgKey) || [];

            if (currentProgram || programs.length > 0) {
                programsHtml = '<div class="epg-program-list">';

                // Show current program
                if (currentProgram) {
                    const startTime = new Date(currentProgram.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const endTime = new Date(currentProgram.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    programsHtml += `
                        <div class="epg-program current">
                            <div class="epg-program-time">${startTime} - ${endTime}</div>
                            <div class="epg-program-title">▶ ${this.escapeHtml(currentProgram.title)}</div>
                            ${currentProgram.description ? `<div class="epg-program-desc">${this.escapeHtml(currentProgram.description)}</div>` : ''}
                        </div>
                    `;
                }

                // Show upcoming programs (next 5)
                const now = Date.now();
                const upcoming = programs
                    .filter(p => new Date(p.start).getTime() > now)
                    .slice(0, 5);

                upcoming.forEach(prog => {
                    const startTime = new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const endTime = new Date(prog.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    programsHtml += `
                        <div class="epg-program">
                            <div class="epg-program-time">${startTime} - ${endTime}</div>
                            <div class="epg-program-title">${this.escapeHtml(prog.title)}</div>
                        </div>
                    `;
                });

                programsHtml += '</div>';
            }
        }

        modalBody.innerHTML = `
            <div class="epg-info-modal">
                <div class="channel-details">
                    <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                         onerror="this.onerror=null;this.src='/img/placeholder.png'" />
                    <div class="channel-meta">
                        <p><strong>Group:</strong> ${this.escapeHtml(channel.groupTitle || 'Uncategorized')}</p>
                        <p><strong>Source:</strong> ${channel.sourceType}</p>
                        ${channel.tvgId ? `<p><strong>TVG ID:</strong> ${this.escapeHtml(channel.tvgId)}</p>` : ''}
                    </div>
                </div>
                <h4>Program Schedule</h4>
                ${programsHtml}
            </div>
        `;

        modal.classList.add('active');
    }

    /**
     * Sync favorite status from external source (e.g. EPG) without API call
     */
    syncFavorite(sourceId, channelId, isFavorite) {
        const key = `${sourceId}:${channelId}`;
        const currentlyFav = this.visibleFavorites.has(key);

        if (currentlyFav === isFavorite) return; // No change needed

        // Update State
        if (isFavorite) {
            this.visibleFavorites.add(key);
        } else {
            this.visibleFavorites.delete(key);
        }

        // Update DOM (All instances)
        const btns = document.querySelectorAll(`.channel-item[data-channel-id="${channelId}"][data-source-id="${sourceId}"] .favorite-btn`);

        btns.forEach(btn => {
            if (isFavorite) {
                btn.classList.add('active');
                btn.innerHTML = '❤️';
                btn.title = 'Remove from Favorites';
            } else {
                btn.classList.remove('active');
                btn.innerHTML = '♡';
                btn.title = 'Add to Favorites';
            }
        });

        // Update Favorites Group
        const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
        if (channel) {
            this.updateFavoritesGroup(channel, isFavorite);
        }
    }

    /**
     * Select next channel in the current list
     */
    selectNextChannel() {
        if (!this.currentChannel || !this.renderedChannels || this.renderedChannels.length === 0) return;

        let currentIndex = -1;

        // Try to find by render ID first (strict visual order)
        if (this.currentRenderId) {
            currentIndex = this.renderedChannels.findIndex(c => c._renderId === this.currentRenderId);
        }

        // Fallback: Find matching channel ID, prioritizing same render group
        if (currentIndex === -1) {
            // First try to find in same group (for Favorites containing duplicates)
            if (this.currentRenderGroup) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId && c._renderGroup === this.currentRenderGroup
                );
            }
            // Final fallback: any matching channel
            if (currentIndex === -1) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId
                );
            }
        }

        if (currentIndex === -1) return;

        const nextIndex = (currentIndex + 1) % this.renderedChannels.length;
        const nextChannel = this.renderedChannels[nextIndex];

        this.selectChannel({
            channelId: nextChannel.id,
            sourceId: nextChannel.sourceId,
            sourceType: nextChannel.sourceType,
            streamId: nextChannel.streamId,
            url: nextChannel.url,
            renderId: nextChannel._renderId // Pass the unique render ID
        });
    }

    /**
     * Select previous channel in the current list
     */
    selectPrevChannel() {
        if (!this.currentChannel || !this.renderedChannels || this.renderedChannels.length === 0) return;

        let currentIndex = -1;

        if (this.currentRenderId) {
            currentIndex = this.renderedChannels.findIndex(c => c._renderId === this.currentRenderId);
        }

        // Fallback: Find matching channel ID, prioritizing same render group
        if (currentIndex === -1) {
            // First try to find in same group (for Favorites containing duplicates)
            if (this.currentRenderGroup) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId && c._renderGroup === this.currentRenderGroup
                );
            }
            // Final fallback: any matching channel
            if (currentIndex === -1) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId
                );
            }
        }

        if (currentIndex === -1) return;

        const prevIndex = (currentIndex - 1 + this.renderedChannels.length) % this.renderedChannels.length;
        const prevChannel = this.renderedChannels[prevIndex];

        this.selectChannel({
            channelId: prevChannel.id,
            sourceId: prevChannel.sourceId,
            sourceType: prevChannel.sourceType,
            streamId: prevChannel.streamId,
            url: prevChannel.url,
            renderId: prevChannel._renderId
        });
    }

    /**
     * Show EPG info for channel
     */
    async showEpgInfo(channelId) {
        const channel = this.channels.find(c => c.id === channelId);
        if (!channel) return;

        // This would show a modal with EPG info
        console.log('Show EPG for:', channel);
    }

    /**
     * Get list of visible (non-hidden) channels in display order
     */
    getVisibleChannels() {
        // The list's order, without the second copy of favourites
        const seen = new Set();
        return (this.renderedChannels || []).filter(ch => !seen.has(ch.id) && seen.add(ch.id));
    }
}

// Export
window.ChannelList = ChannelList;
