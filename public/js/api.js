/**
 * API Client - Frontend API wrapper for Fleurbox
 */

const API = {
    /**
     * True when this HTTPS page would have to load a plain-http URL, which
     * browsers block or break as mixed content (e.g. over tailscale serve)
     */
    isMixedContent(url) {
        return window.location.protocol === 'https:' && typeof url === 'string' && url.startsWith('http://');
    },

    /**
     * Image URL for this page: every external image (TMDB posters, provider
     * logos) goes through the server's image proxy, which keeps it on disk -
     * so each one is downloaded from its source once, not on every view or
     * device. Also avoids mixed content on HTTPS pages.
     */
    imageUrl(url) {
        return typeof url === 'string' && /^https?:\/\//i.test(url)
            ? `/api/proxy/image?url=${encodeURIComponent(url)}`
            : url;
    },

    /**
     * Make API request
     */
    async request(method, endpoint, data = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        // Add authentication token if available
        const token = localStorage.getItem('authToken');
        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }

        if (data) {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(`/api${endpoint}`, options);

        let result;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            result = await response.json();
        } else {
            const text = await response.text();
            result = { error: text || 'API request failed' };
        }

        if (!response.ok) {
            // If unauthorized, redirect to login
            if (response.status === 401) {
                localStorage.removeItem('authToken');
                window.location.href = '/login.html';
                return;
            }
            throw new Error(result.error || `Server responded with ${response.status}`);
        }

        return result;
    },

    // Sources
    sources: {
        getAll: () => API.request('GET', '/sources'),
        getByType: (type) => API.request('GET', `/sources/type/${type}`),
        getById: (id) => API.request('GET', `/sources/${id}`),
        create: (data) => API.request('POST', '/sources', data),
        update: (id, data) => API.request('PUT', `/sources/${id}`, data),
        delete: (id) => API.request('DELETE', `/sources/${id}`),
        toggle: (id) => API.request('POST', `/sources/${id}/toggle`),
        test: (id) => API.request('POST', `/sources/${id}/test`),
        sync: (id) => API.request('POST', `/sources/${id}/sync`), // Manual sync
        getStatus: () => API.request('GET', '/sources/status'), // Get all statuses
        estimate: (id) => API.request('GET', `/sources/${id}/estimate`), // Estimate M3U size
        estimateByUrl: (url, type) => API.request('POST', '/sources/estimate', { url, type }), // Estimate by URL (before creation)
    },

    // Channels (hidden items)
    channels: {
        getHidden: (sourceId = null) => API.request('GET', `/channels/hidden${sourceId ? `?sourceId=${sourceId}` : ''}`),
        hide: (sourceId, itemType, itemId) => API.request('POST', '/channels/hide', { sourceId, itemType, itemId }),
        show: (sourceId, itemType, itemId) => API.request('POST', '/channels/show', { sourceId, itemType, itemId }),
        isHidden: (sourceId, itemType, itemId) => API.request('GET', `/channels/hidden/check?sourceId=${sourceId}&itemType=${itemType}&itemId=${itemId}`),
        bulkHide: (items) => API.request('POST', '/channels/hide/bulk', { items }),
        bulkShow: (items) => API.request('POST', '/channels/show/bulk', { items }),
        // Fast bulk operations - single SQL statement
        showAll: (sourceId, contentType) => API.request('POST', '/channels/show/all', { sourceId, contentType }),
        hideAll: (sourceId, contentType) => API.request('POST', '/channels/hide/all', { sourceId, contentType })
    },

    // Live TV, served a group at a time (server/routes/live.js)
    live: {
        groups: (source = '', includeHidden = false) =>
            API.request('GET', `/live/groups?${new URLSearchParams({ source, includeHidden: includeHidden ? 1 : '' })}`),
        channels: (sourceId, categoryId, includeHidden = false) =>
            API.request('GET', `/live/channels?${new URLSearchParams({
                sourceId, categoryId: categoryId ?? '', includeHidden: includeHidden ? 1 : ''
            })}`),
        search: (q, params = {}) =>
            API.request('GET', `/live/search?${new URLSearchParams({ q, ...params })}`),
        favorites: () => API.request('GET', '/live/favorites'),
        channel: (sourceId, itemId) =>
            API.request('GET', `/live/channel?${new URLSearchParams({ sourceId, itemId })}`),
        // [{ tvgId, name }] -> [{ current, upcoming } | null]
        now: (channels, full = false) => API.request('POST', '/live/now', { channels, full })
    },

    // Favorites
    favorites: {
        getAll: (sourceId = null, itemType = null) => {
            let url = '/favorites';
            const params = [];
            if (sourceId) params.push(`sourceId=${sourceId}`);
            if (itemType) params.push(`itemType=${itemType}`);
            if (params.length) url += '?' + params.join('&');
            return API.request('GET', url);
        },
        add: (sourceId, itemId, itemType = 'channel') =>
            API.request('POST', '/favorites', { sourceId, itemId, itemType }),
        remove: (sourceId, itemId, itemType = 'channel') =>
            API.request('DELETE', '/favorites', { sourceId, itemId, itemType }),
        check: (sourceId, itemId, itemType = 'channel') =>
            API.request('GET', `/favorites/check?sourceId=${sourceId}&itemId=${itemId}&itemType=${itemType}`)
    },

    // Proxy
    proxy: {
        // Movies/Series grid page: { items, hasMore }
        browse: (type, params = {}) => {
            const query = new URLSearchParams(
                Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined));
            return API.request('GET', `/proxy/browse/${type}?${query}`);
        },

        // Xtream
        xtream: {
            auth: (sourceId) => API.request('GET', `/proxy/xtream/${sourceId}/auth`),
            liveCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/live_categories${params}`);
            },
            liveStreams: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/live_streams${query}`);
            },
            vodCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/vod_categories${params}`);
            },
            vodStreams: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/vod_streams${query}`);
            },
            seriesCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/series_categories${params}`);
            },
            series: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/series${query}`);
            },
            seriesInfo: (sourceId, seriesId) =>
                API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${seriesId}`),
            vodInfo: (sourceId, vodId) =>
                API.request('GET', `/proxy/xtream/${sourceId}/vod_info?vod_id=${vodId}`),
            shortEpg: (sourceId, streamId) => API.request('GET', `/proxy/xtream/${sourceId}/short_epg?stream_id=${streamId}`),
            getStreamUrl: (sourceId, streamId, type = 'live', container = 'm3u8') =>
                API.request('GET', `/proxy/xtream/${sourceId}/stream/${streamId}/${type}?container=${container}`)
        },

        // EPG
        epg: {
            get: (sourceId) => API.request('GET', `/proxy/epg/${sourceId}`),
            getForChannels: (sourceId, channelIds) => API.request('POST', `/proxy/epg/${sourceId}/channels`, { channelIds })
        },

        // Cache management
        cache: {
            clear: (sourceId) => API.request('DELETE', `/proxy/cache/${sourceId}`)
        }
    },

    // Settings
    settings: {
        get: () => API.request('GET', '/settings'),
        update: (data) => API.request('PUT', '/settings', data),
        reset: () => API.request('DELETE', '/settings'),
        getDefaults: () => API.request('GET', '/settings/defaults')
    },

    // Users (admin only)
    users: {
        getAll: () => API.request('GET', '/auth/users'),
        create: (data) => API.request('POST', '/auth/users', data),
        update: (id, data) => API.request('PUT', `/auth/users/${id}`, data),
        delete: (id) => API.request('DELETE', `/auth/users/${id}`)
    }
};

// Make API available globally
window.API = API;
