/**
 * Watch Page Controller
 * Handles VOD (Movies/Series) playback with streaming service-style UI
 */

class WatchPage {
    constructor(app) {
        this.app = app;

        // Video elements
        this.video = document.getElementById('watch-video');
        this.overlay = document.getElementById('watch-overlay');

        // iOS: ensure inline playback (not fullscreen by default)
        if (this.video) {
            this.video.setAttribute('playsinline', '');
            this.video.setAttribute('webkit-playsinline', '');
        }

        // Top bar
        this.backBtn = document.getElementById('watch-back-btn');
        this.titleEl = document.getElementById('watch-title');
        this.subtitleEl = document.getElementById('watch-subtitle');

        // Controls
        this.centerPlayBtn = document.getElementById('watch-center-play');
        this.playPauseBtn = document.getElementById('watch-play-pause');
        this.skipBackBtn = document.getElementById('watch-skip-back');
        this.skipFwdBtn = document.getElementById('watch-skip-fwd');
        this.muteBtn = document.getElementById('watch-mute');
        this.volumeSlider = document.getElementById('watch-volume');
        this.fullscreenBtn = document.getElementById('watch-fullscreen');
        this.progressSlider = document.getElementById('watch-progress');
        this.timeCurrent = document.getElementById('watch-time-current');
        this.timeTotal = document.getElementById('watch-time-total');
        this.scrollHint = document.getElementById('watch-scroll-hint');
        this.loadingSpinner = document.getElementById('watch-loading');

        // Next episode
        this.nextEpisodePanel = document.getElementById('watch-next-episode');
        this.nextEpisodeTitle = document.getElementById('next-episode-title');
        this.nextCountdown = document.getElementById('next-countdown');
        this.nextPlayNowBtn = document.getElementById('next-play-now');
        this.nextCancelBtn = document.getElementById('next-cancel');

        // Episode navigation + autoplay toggle (series only)
        this.prevEpisodeBtn = document.getElementById('watch-prev-episode');
        this.nextEpisodeBtn = document.getElementById('watch-next-episode-btn');
        this.autoplayBtn = document.getElementById('watch-autoplay');

        // Details section
        this.posterEl = document.getElementById('watch-poster');
        this.contentTitleEl = document.getElementById('watch-content-title');
        this.yearEl = document.getElementById('watch-year');
        this.ratingEl = document.getElementById('watch-rating');
        this.durationEl = document.getElementById('watch-duration');
        this.descriptionEl = document.getElementById('watch-description');
        this.playBtn = document.getElementById('watch-play-btn');
        this.playBtnText = document.getElementById('watch-play-btn-text');
        this.favoriteBtn = document.getElementById('watch-favorite-btn');

        // Recommended / Episodes
        this.recommendedSection = document.getElementById('watch-recommended');
        this.recommendedGrid = document.getElementById('watch-recommended-grid');
        this.episodesSection = document.getElementById('watch-episodes');
        this.seasonsContainer = document.getElementById('watch-seasons');

        // Captions
        this.captionsBtn = document.getElementById('watch-captions-btn');
        this.captionsMenu = document.getElementById('watch-captions-menu');
        this.captionsList = document.getElementById('watch-captions-list');

        // Audio tracks
        this.audioBtn = document.getElementById('watch-audio-btn');
        this.audioMenu = document.getElementById('watch-audio-menu');
        this.audioList = document.getElementById('watch-audio-list');

        // Transcode Status
        this.transcodeStatusEx = document.getElementById('watch-transcode-status');
        this.qualityBadgeEl = document.getElementById('watch-quality-badge');

        // State
        this.hls = null;
        this.content = null;
        this.contentType = null; // 'movie' or 'series'
        this.seriesInfo = null;
        this.currentSeason = null;
        this.currentEpisode = null;
        this.isFavorite = false;
        this.returnPage = null;
        this.captionsMenuOpen = false;
        this.audioMenuOpen = false;
        this.audioTracks = [];       // audio streams reported by /api/probe
        this.selectedAudioTrack = 0; // audio-relative index passed to ffmpeg

        // Overlay timer
        this.overlayTimeout = null;
        this.overlayVisible = true;

        // Next episode
        this.nextEpisodeTimeout = null;
        this.nextEpisodeCountdown = 10;
        this.nextEpisodeInterval = null;
        this.nextEpisodeShowing = false;
        this.nextEpisodeDismissed = false;

        // Watch history
        this.historyInterval = null;

        // A transcode session started at seekOffset plays from there, so the
        // video element's clock is streamOffset behind the title's.
        // mediaDuration is the whole title's length from the probe (0 = unknown).
        this.streamOffset = 0;
        this.mediaDuration = 0;
        this.seekRestartTimer = null;

        // Playback recovery: every loadVideo()/stop() bumps loadSeq, so a load
        // that is still awaiting (probe, session start) when a newer one starts
        // gives up instead of attaching its stream on top
        this.loadSeq = 0;
        // Retries with back-off, waiting while offline/hidden (js/playbackRetry.js)
        this.retryResumeAt = 0;
        this.retry = new PlaybackRetry({
            name: 'WatchPage',
            container: document.querySelector('.watch-video-section'),
            run: () => {
                if (this.retryResumeAt > 0) this.resumeTime = this.retryResumeAt;
                this.reload();
            },
            onWait: () => this.showLoading(),
            onGiveUp: () => this.hideLoading()
        });
        // Logged out mid-title: keep the place for after the login
        window.addEventListener('fleurbox:session-expired', () => this.onSessionExpired());

        this.init();
    }

    init() {
        // iOS Safari: detect and compensate for floating bottom toolbar
        const updateIosUiBottom = () => {
            let uiBottom = 0;
            if (window.visualViewport) {
                const vv = window.visualViewport;
                uiBottom = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
            }
            document.documentElement.style.setProperty('--ios-ui-bottom', uiBottom + 'px');
        };

        updateIosUiBottom();

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', updateIosUiBottom);
            window.visualViewport.addEventListener('scroll', updateIosUiBottom);
        } else {
            window.addEventListener('resize', updateIosUiBottom);
        }

        // iOS: use custom --vh unit to avoid 100vh issues with dynamic toolbar
        const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
        const watchVideoSection = document.querySelector('.watch-video-section');
        if (isIOS && watchVideoSection) {
            const vh = window.innerHeight * 0.01;
            document.documentElement.style.setProperty('--vh', `${vh}px`);
            watchVideoSection.style.height = 'calc(var(--vh) * 100)';
        }

        // Apply safe area + iOS toolbar padding to overlay
        if (this.overlay) {
            this.overlay.style.paddingBottom = 'calc(env(safe-area-inset-bottom, 0px) + var(--ios-ui-bottom, 0px) + 12px)';
        }

        // Back button
        this.backBtn?.addEventListener('click', () => this.goBack());

        // Play/Pause
        this.centerPlayBtn?.addEventListener('click', () => this.togglePlay());
        this.playPauseBtn?.addEventListener('click', () => this.togglePlay());
        this.video?.addEventListener('click', () => this.togglePlay());

        // Skip buttons
        this.skipBackBtn?.addEventListener('click', () => this.skip(-10));
        this.skipFwdBtn?.addEventListener('click', () => this.skip(10));

        // Volume
        this.muteBtn?.addEventListener('click', () => this.toggleMute());
        this.volumeSlider?.addEventListener('input', (e) => this.setVolume(e.target.value));

        // Fullscreen
        this.fullscreenBtn?.addEventListener('click', () => this.toggleFullscreen());

        // Picture-in-Picture
        const pipBtn = document.getElementById('watch-pip');
        pipBtn?.addEventListener('click', () => this.togglePictureInPicture());

        // Overflow Menu
        const overflowBtn = document.getElementById('watch-overflow');
        const overflowMenu = document.getElementById('watch-overflow-menu');

        overflowBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            overflowMenu?.classList.toggle('hidden');
        });

        // Copy Stream URL
        const copyUrlBtn = document.getElementById('watch-copy-url');
        copyUrlBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyStreamUrl();
            overflowMenu?.classList.add('hidden');
        });

        // Close overflow menu when clicking outside
        document.addEventListener('click', (e) => {
            if (overflowMenu && !overflowMenu.classList.contains('hidden') &&
                !overflowMenu.contains(e.target) && e.target !== overflowBtn) {
                overflowMenu.classList.add('hidden');
            }
        });

        // Progress bar
        this.progressSlider?.addEventListener('input', (e) => this.seek(e.target.value));

        // Video events
        this.video?.addEventListener('timeupdate', () => this.updateProgress());
        this.video?.addEventListener('loadedmetadata', () => this.onMetadataLoaded());
        this.video?.addEventListener('play', () => this.onPlay());
        this.video?.addEventListener('pause', () => this.onPause());
        this.video?.addEventListener('ended', () => this.onEnded());
        this.video?.addEventListener('error', (e) => this.onError(e));
        // Playing steadily for a while: a later failure gets fresh retries
        this.video?.addEventListener('playing', () => this.retry.playing());
        this.video?.addEventListener('waiting', () => this.showLoading());
        this.video?.addEventListener('canplay', () => this.hideLoading());

        // Overlay auto-hide + click to toggle play
        const watchSection = document.querySelector('.watch-video-section');
        watchSection?.addEventListener('mousemove', () => this.showOverlay());
        watchSection?.addEventListener('touchstart', () => this.showOverlay());
        watchSection?.addEventListener('click', (e) => {
            this.showOverlay();
            // Only toggle play if clicking on video area (not controls)
            if (e.target === this.video || e.target === watchSection ||
                e.target.classList.contains('watch-overlay') || e.target === this.overlay) {
                this.togglePlay();
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Details section buttons
        this.playBtn?.addEventListener('click', () => this.scrollToVideo());
        this.favoriteBtn?.addEventListener('click', () => this.toggleFavorite());

        // Next episode buttons
        this.nextPlayNowBtn?.addEventListener('click', () => this.playNextEpisode());
        this.nextCancelBtn?.addEventListener('click', () => this.cancelNextEpisode());

        // Episode navigation + autoplay toggle
        this.prevEpisodeBtn?.addEventListener('click', () => this.playAdjacentEpisode(-1));
        this.nextEpisodeBtn?.addEventListener('click', () => this.playAdjacentEpisode(1));
        this.autoplayBtn?.addEventListener('click', () => this.toggleAutoplay());

        // Captions toggle
        this.captionsBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCaptionsMenu();
        });

        // Close captions menu when clicking outside
        document.addEventListener('click', (e) => {
            if (this.captionsMenuOpen && !this.captionsMenu?.contains(e.target) && e.target !== this.captionsBtn) {
                this.closeCaptionsMenu();
            }
        });

        // Audio track toggle
        this.audioBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleAudioMenu();
        });

        // Close audio menu when clicking outside
        document.addEventListener('click', (e) => {
            if (this.audioMenuOpen && !this.audioMenu?.contains(e.target) && e.target !== this.audioBtn) {
                this.closeAudioMenu();
            }
        });

        // Hide scroll hint after scrolling
        const watchPage = document.getElementById('page-watch');
        watchPage?.addEventListener('scroll', () => {
            if (watchPage.scrollTop > 50) {
                this.scrollHint?.classList.add('hidden');
            } else {
                this.scrollHint?.classList.remove('hidden');
            }
        });
    }

    /**
     * Hash route for the current content, so the URL identifies the video:
     *   watch/movie/<sourceId>/<streamId>
     *   watch/series/<sourceId>/<seriesId>/<episodeId>
     * Plain "watch" when the ids needed to rebuild it are missing.
     */
    get routeHash() {
        const c = this.content;
        if (!c?.sourceId || !c.id) return 'watch';
        if (c.type === 'movie') return `watch/movie/${c.sourceId}/${c.id}`;
        if (c.seriesId) return `watch/series/${c.sourceId}/${c.seriesId}/${c.id}`;
        return 'watch';
    }

    /**
     * Start playback from a route (the parts after "watch/"), e.g. on page
     * load, a pasted link or back/forward. Resumes from watch history.
     * @returns {Promise<boolean>} false if the route could not be resolved
     */
    async playFromRoute(route) {
        const [type, sourceParam, ...ids] = route;
        const sourceId = parseInt(sourceParam);
        if (!sourceId) return false;

        // Already playing this - just show it
        if (this.content && this.routeHash === ['watch', ...route].join('/')) {
            this.app.navigateTo('watch', true);
            return true;
        }

        try {
            // Resume point: play() asks the server (resumeTime left undefined)
            if (type === 'movie' && ids.length === 1) {
                const vodId = ids[0];
                const vod = await API.proxy.xtream.vodInfo(sourceId, vodId);
                const info = vod?.info || {};
                const movieData = vod?.movie_data || {};
                const container = movieData.container_extension || 'mp4';
                const result = await API.proxy.xtream.getStreamUrl(sourceId, vodId, 'movie', container);
                if (!result?.url) return false;

                await this.play({
                    type: 'movie',
                    id: vodId,
                    title: movieData.name || info.name || 'Movie',
                    poster: info.movie_image || info.cover_big,
                    description: info.plot || info.description || '',
                    year: info.releasedate?.substring(0, 4),
                    rating: info.rating,
                    sourceId,
                    categoryId: movieData.category_id,
                    containerExtension: container
                }, result.url);
                return true;
            }

            if (type === 'series' && ids.length === 2) {
                const [seriesId, episodeId] = ids;
                const seriesInfo = await API.proxy.xtream.seriesInfo(sourceId, seriesId);
                const ep = Object.entries(seriesInfo?.episodes || {})
                    .flatMap(([seasonNum, eps]) => (eps || []).map(e => ({ ...e, seasonNum })))
                    .find(e => String(e.id) === String(episodeId));
                if (!ep) return false;

                const info = seriesInfo.info || {};
                const container = ep.container_extension || 'mp4';
                const result = await API.proxy.xtream.getStreamUrl(sourceId, episodeId, 'series', container);
                if (!result?.url) return false;

                await this.play({
                    type: 'series',
                    id: episodeId,
                    title: info.name || 'Series',
                    subtitle: `S${ep.seasonNum} E${ep.episode_num} - ${ep.title || `Episode ${ep.episode_num}`}`,
                    poster: info.cover,
                    description: info.plot || '',
                    year: (info.releaseDate || info.release_date)?.substring(0, 4),
                    rating: info.rating,
                    sourceId,
                    seriesId,
                    seriesInfo,
                    currentSeason: ep.seasonNum,
                    currentEpisode: ep.episode_num,
                    containerExtension: container
                }, result.url);
                return true;
            }
        } catch (err) {
            console.error('[WatchPage] Could not play route:', route.join('/'), err);
        }
        return false;
    }

    /**
     * Main entry point - play content
     * @param {Object} content - Movie or episode info
     * @param {string} streamUrl - Stream URL
     */
    async play(content, streamUrl) {
        this.content = content;
        this.contentType = content.type;
        this.seriesInfo = content.seriesInfo || null;
        this.currentSeason = content.currentSeason || null;
        this.currentEpisode = content.currentEpisode || null;
        this.resumeTime = content.resumeTime || 0;
        // No resume point given (Movies/Series pages, a link): where the user
        // left off in ANY copy of this title, in seconds (GET /api/history/resume)
        if (content.resumeTime === undefined) this.resumeTime = await this.lookupResume(content);
        this.containerExtension = content.containerExtension || 'mp4';
        // New title -> go back to the stream's default audio track
        this.selectedAudioTrack = 0;
        this.audioTracks = [];
        this.returnPage = content.type === 'movie' ? 'movies' : 'series';

        // Stop any Live TV playback before starting movie/series
        this.app?.player?.stop?.();

        // Reset state
        this.cancelNextEpisode();
        this.nextEpisodeDismissed = false;
        this.updateEpisodeControls();

        // Navigate to watch page
        this.app.navigateTo('watch', true);

        // Scroll to top
        document.getElementById('page-watch')?.scrollTo(0, 0);

        // Update title bar
        this.titleEl.textContent = content.title || '';
        this.subtitleEl.textContent = content.subtitle || '';

        // Load video
        await this.loadVideo(streamUrl);

        // Show Now Playing indicator in navbar
        this.showNowPlaying(content.title);

        // Populate details section
        this.renderDetails();

        // Load recommended (movies) or episodes (series)
        if (content.type === 'movie') {
            this.episodesSection?.classList.add('hidden');
            this.recommendedSection?.classList.remove('hidden');
            await this.loadRecommended(content.sourceId, content.categoryId);
        } else {
            this.recommendedSection?.classList.add('hidden');
            this.episodesSection?.classList.remove('hidden');
            this.renderEpisodes();
        }

        // Check favorite status
        await this.checkFavorite();
        // Show overlay initially
        this.showOverlay();

        // Start watch history tracking
        this.startHistoryTracking();
    }

    /**
     * Show Now Playing indicator in navbar
     */
    showNowPlaying(title) {
        this.app?.setNowPlaying(title, 'watch');
    }

    /**
     * Hide Now Playing indicator in navbar
     */
    hideNowPlaying() {
        this.app?.clearNowPlaying('watch');
    }

    /**
     * Start a HLS transcode session
     */
    async startTranscodeSession(url, options = {}) {
        const seq = this.loadSeq;
        const seekOffset = options.seekOffset ?? this.resumeTime ?? 0;
        try {
            console.log('[WatchPage] Starting HLS transcode session...', options);
            const res = await fetch('/api/transcode/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    seekOffset: this.resumeTime, // Pass resume point to backend
                    ...options
                })
            });
            if (res.status === 401) {
                this.loadSeq++; // callers see this load as superseded and stop
                Session.expire();
                return null;
            }
            if (!res.ok) throw new Error('Failed to start session');
            const session = await res.json();
            if (seq !== this.loadSeq) {
                // A newer load or stop() came in meanwhile: nobody will play this
                fetch(`/api/transcode/${session.sessionId}`, { method: 'DELETE' }).catch(() => {});
                return null;
            }
            this.currentSessionId = session.sessionId;
            // The server already started at the resume point: don't seek again
            this.streamOffset = seekOffset > 0 ? seekOffset : 0;
            if (this.streamOffset) this.resumeTime = 0;
            return session.playlistUrl;
        } catch (err) {
            console.error('[WatchPage] Session start failed:', err);
            // Fallback to direct transcode if session fails
            return `/api/transcode?url=${encodeURIComponent(url)}`;
        }
    }

    /**
     * Stop and cleanup current transcode session
     */
    async stopTranscodeSession() {
        if (this.currentSessionId) {
            console.log('[WatchPage] Stopping transcode session:', this.currentSessionId);
            // Not awaited here (stop() is sync); loadVideo() awaits it so the
            // old FFmpeg has released the provider connection before the next
            // stream is probed.
            this.sessionStopPromise = fetch(`/api/transcode/${this.currentSessionId}`, { method: 'DELETE' })
                .catch(err => console.error('Failed to stop session:', err));
            this.currentSessionId = null;
        }
    }

    async updateTranscodeStatus(mode, text) {
        if (!this.transcodeStatusEx) return;

        this.transcodeStatusEx.className = 'transcode-status'; // Reset classes

        if (mode === 'hidden') {
            this.transcodeStatusEx.classList.add('hidden');
            return;
        }

        this.transcodeStatusEx.textContent = text || mode;
        this.transcodeStatusEx.classList.add(mode);

        // Ensure it's visible
        this.transcodeStatusEx.classList.remove('hidden');
    }

    /**
     * Get quality label from video height
     */
    getQualityLabel(height) {
        if (height >= 2160) return '4K';
        if (height >= 1440) return '1440p';
        if (height >= 1080) return '1080p';
        if (height >= 720) return '720p';
        if (height >= 480) return '480p';
        if (height > 0) return `${height}p`;
        return null;
    }

    /**
     * Update quality badge display
     */
    updateQualityBadge() {
        if (!this.qualityBadgeEl) return;

        if (this.currentStreamInfo?.height > 0) {
            this.qualityBadgeEl.textContent = this.getQualityLabel(this.currentStreamInfo.height);
            this.qualityBadgeEl.classList.remove('hidden');
        } else {
            this.qualityBadgeEl.classList.add('hidden');
        }
    }

    async loadVideo(url) {
        // Store the URL for copy functionality
        this.currentUrl = url;

        // Stop any existing playback
        this.stop({ keepRetries: true });
        const seq = this.loadSeq;
        const superseded = () => seq !== this.loadSeq;

        // Show loading spinner
        this.showLoading();

        // Wait (bounded) for the previous transcode session to be torn down
        if (this.sessionStopPromise) {
            await Promise.race([this.sessionStopPromise, new Promise(r => setTimeout(r, 5000))]);
            this.sessionStopPromise = null;
        }
        if (superseded()) return;

        // Get settings for proxy/transcode
        let settings = {};
        try {
            settings = await API.settings.get();
        } catch (e) {
            console.warn('Could not load settings');
        }
        if (superseded()) return;

        // The user's own provider (js/directPlay.js): straight to this browser
        // when it can play the stream, else the server path on their login
        const direct = await this.findDirect(url);
        if (superseded()) return;
        if (direct) {
            if (this.playDirect(direct, settings)) return;
            url = direct.ref;
            this.currentUrl = url;
        }

        // Detect stream type
        const looksLikeHls = url.includes('.m3u8') || url.includes('m3u8');
        const isRawTs = url.includes('.ts') && !url.includes('.m3u8');
        const isDirectVideo = url.includes('.mp4') || url.includes('.mkv') || url.includes('.avi');

        // Priority 0: Auto Transcode (Smart) - probe first, then decide
        if (settings.autoTranscode) {
            console.log('[WatchPage] Auto Transcode enabled. Probing stream...');
            try {
                const ua = settings.userAgentPreset === 'custom' ? settings.userAgentCustom : settings.userAgentPreset;
                const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(url)}&ua=${encodeURIComponent(ua || '')}`);
                const info = await probeRes.json();
                if (superseded()) return;
                console.log(`[WatchPage] Probe result: video=${info.video}, audio=${info.audio}, ${info.width}x${info.height}, compatible=${info.compatible}`);

                // Store early probe info for quality display
                this.currentStreamInfo = info;
                this.mediaDuration = info.duration || 0;
                this.updateQualityBadge();

                // Populate the audio track selector
                this.audioTracks = info.audioTracks || [];
                if (this.selectedAudioTrack >= this.audioTracks.length) this.selectedAudioTrack = 0;
                this.updateAudioTracks();

                if (info.needsTranscode || settings.upscaleEnabled) {
                    console.log(`[WatchPage] Auto: Using HLS transcode session (${settings.upscaleEnabled ? 'Upscaling' : 'Incompatible audio/video'})`);

                    // Heuristic: If video is h264/compat, copy video. Usage: Audio fix. 
                    // BUT: If upscaling is enabled, we MUST encode.
                    const videoMode = (info.video && info.video.includes('h264') && !settings.upscaleEnabled) ? 'copy' : 'encode';
                    const statusText = videoMode === 'copy' ? 'Transcoding (Audio)' : (settings.upscaleEnabled ? 'Upscaling' : 'Transcoding (Video)');
                    const statusMode = settings.upscaleEnabled ? 'upscaling' : 'transcoding';

                    this.updateTranscodeStatus(statusMode, statusText);
                    const playlistUrl = await this.startTranscodeSession(url, {
                        videoMode,
                        seekOffset: this.resumeTime, // Ensure seekOffset is passed
                        videoCodec: info.video,
                        audioCodec: info.audio,
                        audioChannels: info.audioChannels,
                        audioTrack: this.selectedAudioTrack
                    });
                    if (superseded()) return;
                    this.playHls(playlistUrl);
                    this.setVolumeFromStorage();
                    return;
                } else if (info.needsRemux) {
                    // Remux (container swap) currently doesn't use session logic, uses direct stream
                    // TODO: Move remux to session logic if seeking is needed for TS files
                    console.log('[WatchPage] Auto: Using remux (.ts container)');
                    this.updateTranscodeStatus('remuxing', 'Remux (Auto)');
                    const trackParam = this.selectedAudioTrack > 0 ? `&audioTrack=${this.selectedAudioTrack}` : '';
                    const finalUrl = `/api/remux?url=${encodeURIComponent(url)}${trackParam}`;
                    this.video.src = finalUrl;
                    this.video.play().catch(e => {
                        if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
                    });
                    this.setVolumeFromStorage();
                    return;
                } else if (this.selectedAudioTrack > 0) {
                    // The stream would play directly, but the viewer picked a
                    // non-default audio track. Browsers cannot reliably switch audio
                    // tracks themselves (Chrome does not expose audioTracks at all),
                    // so route through a transcode session that maps only the chosen
                    // track. videoMode 'copy' keeps this cheap: audio only.
                    console.log(`[WatchPage] Audio track ${this.selectedAudioTrack} selected, using session (copy)`);
                    this.updateTranscodeStatus('transcoding', 'Audio Track');
                    const playlistUrl = await this.startTranscodeSession(url, {
                        videoMode: 'copy',
                        videoCodec: info.video,
                        audioCodec: info.audio,
                        audioChannels: info.audioChannels,
                        seekOffset: this.resumeTime,
                        audioTrack: this.selectedAudioTrack
                    });
                    if (superseded()) return;
                    this.playHls(playlistUrl);
                    this.setVolumeFromStorage();
                    return;
                }
                // Compatible - fall through to normal playback
                console.log('[WatchPage] Auto: Using normal playback (compatible)');
            } catch (err) {
                console.warn('[WatchPage] Probe failed, using normal playback:', err.message);
                // Continue with normal playback on probe failure
            }
        }

        // Priority 1: Force Video Transcode (Full) or Upscaling
        if (settings.forceVideoTranscode || settings.upscaleEnabled) {
            const statusText = settings.upscaleEnabled ? 'Upscaling' : 'Transcoding (Video)';
            const statusMode = settings.upscaleEnabled ? 'upscaling' : 'transcoding';
            console.log(`[WatchPage] ${statusText} enabled. Starting session (encode)...`);
            this.updateTranscodeStatus(statusMode, statusText);
            const playlistUrl = await this.startTranscodeSession(url, {
                videoMode: 'encode',
                seekOffset: this.resumeTime
            });
            if (superseded()) return;
            this.playHls(playlistUrl);
            this.setVolumeFromStorage();
            return;
        }

        if (settings.forceTranscode) {
            console.log('[WatchPage] Force Audio Transcode enabled. Starting session (copy)...');
            this.updateTranscodeStatus('transcoding', 'Transcoding (Audio)');

            // Probe to get video codec for HEVC tag handling
            let videoCodec = 'unknown';
            try {
                const ua = settings.userAgentPreset === 'custom' ? settings.userAgentCustom : settings.userAgentPreset;
                const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(url)}&ua=${encodeURIComponent(ua || '')}`);
                const info = await probeRes.json();
                videoCodec = info.video;
                this.mediaDuration = info.duration || 0;
            } catch (e) { console.warn('Probe failed for force audio, assuming h264'); }
            if (superseded()) return;

            const playlistUrl = await this.startTranscodeSession(url, {
                videoMode: 'copy',
                videoCodec,
                seekOffset: this.resumeTime
            });
            if (superseded()) return;
            this.playHls(playlistUrl);
            this.setVolumeFromStorage();
            return;
        }

        // Priority 2: Force Remux for raw TS streams
        if (settings.forceRemux && isRawTs) {
            console.log('[WatchPage] Force Remux enabled');
            this.updateTranscodeStatus('remuxing', 'Remux (Force)');
            const finalUrl = `/api/remux?url=${encodeURIComponent(url)}`;
            this.video.src = finalUrl;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
            this.setVolumeFromStorage();
            return;
        }

        // Determine if proxy is needed
        const proxyRequiredDomains = ['pluto.tv'];
        // On an HTTPS page a plain-http stream is blocked as mixed content: proxy it
        const needsProxy = settings.forceProxy || API.isMixedContent(url) ||
            proxyRequiredDomains.some(domain => url.includes(domain));
        const finalUrl = needsProxy ? `/api/proxy/stream?url=${encodeURIComponent(url)}` : url;

        console.log('[WatchPage] Playing:', { url, needsProxy, looksLikeHls });

        // Use HLS.js for HLS streams
        if (looksLikeHls && Hls.isSupported()) {
            this.updateTranscodeStatus('direct', 'Direct HLS');
            this.playHls(finalUrl);
        } else {
            // Direct playback for mp4/mkv/avi
            this.updateTranscodeStatus('direct', 'Direct Play');
            this.video.src = finalUrl;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
        }

        this.setVolumeFromStorage();
    }

    /** The user's own stream for the current title (GET /api/direct/resolve), or null */
    async findDirect(url) {
        const c = this.content;
        if (!window.DirectPlay || !c?.sourceId || String(url).startsWith('/api/stream/u/')) return null;
        return DirectPlay.resolve(c.type === 'movie'
            ? { type: 'movie', sourceId: c.sourceId, itemId: c.id }
            : { type: 'episode', sourceId: c.sourceId, itemId: c.id, seriesId: c.seriesId,
                season: this.currentSeason, episode: this.currentEpisode, container: this.containerExtension });
    }

    /**
     * Play `direct` from the provider in this browser, when nothing asks for
     * the server (forced transcode/proxy, upscaling, another audio track) and
     * the browser can play it. Returns false to use the server path instead.
     */
    playDirect(direct, settings) {
        if (settings.forceVideoTranscode || settings.forceTranscode || settings.upscaleEnabled ||
            settings.forceProxy || this.selectedAudioTrack > 0) return false;
        const mode = DirectPlay.mode(direct, this.video);
        if (!mode) return false;

        console.log(`[WatchPage] Direct play from your provider (${mode}, matched by ${direct.match})`);
        this.direct = { ...direct, mode, confirmed: false };
        this.currentUrl = direct.ref; // retries, audio switch and "Copy Stream URL" use the server path
        this.updateTranscodeStatus('direct', 'Direct (your provider)');
        if (mode === 'hls') {
            this.playHls(direct.url);
        } else {
            this.video.src = direct.url;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
        }
        this.setVolumeFromStorage();
        return true;
    }

    /** Direct play is running: picture and sound arrived -> report it; none -> fall back */
    checkDirect() {
        const d = this.direct;
        if (!d || d.confirmed || d.failed) return;
        if (this.video.videoWidth === 0) return this.directFailed('no picture (video codec)');
        d.confirmed = true;
        // Sound: browsers that count decoded audio (Chrome, Firefox) - an AC3/DTS
        // track in an mp4 plays silent otherwise
        setTimeout(() => {
            if (this.direct !== d || this.video.paused || this.video.currentTime < 1) return;
            const silent = ('webkitAudioDecodedByteCount' in this.video && this.video.webkitAudioDecodedByteCount === 0) ||
                ('mozHasAudio' in this.video && this.video.mozHasAudio === false);
            if (silent) return this.directFailed('no sound (audio codec)');
            DirectPlay.reportProbe(d, true, {
                width: this.video.videoWidth, height: this.video.videoHeight, mode: d.mode,
                duration: Number.isFinite(this.video.duration) ? this.video.duration : null
            });
        }, 4000);
    }

    /** Direct play failed: remember it, then play through the server on the user's login */
    async directFailed(reason) {
        const d = this.direct;
        if (!d || d.failed) return;
        d.failed = true;
        console.warn(`[WatchPage] Direct play failed (${reason}) - using the server`);
        DirectPlay.reportProbe(d, false, { error: reason, mode: d.mode });
        const at = this.video?.currentTime || 0;
        this.direct = null;
        if (at > 0) this.resumeTime = at;
        await this.loadVideo(d.ref);
        this.showNowPlaying(this.content?.title);
        this.startHistoryTracking();
    }

    /**
     * Play HLS stream using Hls.js
     */
    playHls(url) {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }

        // startTranscodeSession() falls back to /api/transcode, which streams
        // fragmented MP4, not a playlist - hls.js would time out on it.
        if (url.startsWith('/api/transcode?')) {
            console.log('[WatchPage] Playing direct transcode stream (session fallback)');
            this.video.src = url;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
            return;
        }

        this.hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            startLevel: -1,
            enableWorker: true,
        });

        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);

        // Listen for subtitle track updates
        this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (event, data) => {
            console.log('[WatchPage] Subtitle tracks updated:', data.subtitleTracks);
            // Wait a moment for native text tracks to populate
            setTimeout(() => this.updateCaptionsTracks(), 100);
        });

        this.hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (event, data) => {
            console.log('[WatchPage] Subtitle track switched:', data);
        });

        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
        });

        this.hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                console.error('[WatchPage] HLS fatal error:', data);
                // Straight from the user's provider (no CORS, gone...): server path
                if (this.direct && this.direct.url === url) {
                    this.directFailed(`HLS ${data.details}`);
                    return;
                }
                // Try proxy on CORS error (only if not already proxied/transcoded)
                // Note: Transcoded streams are local, so no CORS issues usually
                if (!url.startsWith('/api/') && (data.type === Hls.ErrorTypes.NETWORK_ERROR)) {
                    console.log('[WatchPage] Retrying via proxy...');
                    this.playHls(`/api/proxy/stream?url=${encodeURIComponent(this.currentUrl)}`);
                } else {
                    this.hls.destroy();
                    this.hls = null;
                    this.scheduleRetry(`HLS ${data.details}`);
                }
            }
        });
    }

    setVolumeFromStorage() {
        const savedVolume = localStorage.getItem('nodecast-volume') || '80';
        this.video.volume = parseInt(savedVolume) / 100;
        if (this.volumeSlider) this.volumeSlider.value = savedVolume;
    }

    stop({ keepRetries = false } = {}) {
        this.loadSeq++;
        if (keepRetries) this.retry.cancel();
        else this.retry.reset();

        // Stop history tracking and save final progress
        this.stopHistoryTracking();
        this.saveProgress();
        this.direct = null;
        this.streamOffset = 0;
        this.mediaDuration = 0;
        clearTimeout(this.seekRestartTimer);
        this.seekRestartTimer = null;

        // Cleanup transcode session if exists
        this.stopTranscodeSession();
        this.updateTranscodeStatus('hidden');

        // Hide quality badge
        this.currentStreamInfo = null;
        if (this.qualityBadgeEl) {
            this.qualityBadgeEl.classList.add('hidden');
        }

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        if (this.video) {
            this.video.pause();
            // Not src = '': that fires "MEDIA_ELEMENT_ERROR: Empty src attribute"
            // and leaves video.src pointing at the page URL
            this.video.removeAttribute('src');
            this.video.load();
        }

        this.hideNowPlaying();
    }

    // === Playback Controls ===

    togglePlay() {
        if (this.video.paused) {
            this.video.play().catch(console.error);
        } else {
            this.video.pause();
        }
    }

    skip(seconds) {
        if (this.video) this.seekTo(this.position() + seconds);
    }

    seek(percent) {
        const total = this.totalDuration();
        if (this.video && total) this.seekTo((percent / 100) * total);
    }

    /** Position in the title, in seconds (see streamOffset) */
    position() {
        return this.streamOffset + (this.video?.currentTime || 0);
    }

    /** Length of the title, in seconds (0 = unknown) */
    totalDuration() {
        if (this.mediaDuration) return this.mediaDuration;
        const d = this.video?.duration;
        return Number.isFinite(d) && d > 0 ? this.streamOffset + d : 0;
    }

    /**
     * Seek to a time in the title. A transcode session only has what FFmpeg
     * has produced since its start, so a target outside that restarts the
     * session there (debounced: dragging the slider fires many inputs).
     */
    seekTo(t) {
        const total = this.totalDuration();
        t = Math.max(0, total ? Math.min(t, total) : t);
        const local = t - this.streamOffset;
        const available = Number.isFinite(this.video.duration) ? this.video.duration : 0;
        clearTimeout(this.seekRestartTimer);
        this.seekRestartTimer = null;
        if (!this.currentSessionId || (local >= 0 && local <= available)) {
            this.video.currentTime = Math.max(0, local);
            return;
        }
        const seq = this.loadSeq;
        this.seekRestartTimer = setTimeout(() => {
            this.seekRestartTimer = null;
            if (seq !== this.loadSeq) return;
            console.log(`[WatchPage] Seek to ${Math.round(t)}s is outside the session, restarting there`);
            this.resumeTime = t;
            this.reload();
        }, 400);
    }

    toggleMute() {
        if (this.video) {
            this.video.muted = !this.video.muted;
            this.updateVolumeUI();
        }
    }

    setVolume(value) {
        if (this.video) {
            this.video.volume = value / 100;
            this.video.muted = false;
            localStorage.setItem('nodecast-volume', value);
            this.updateVolumeUI();
        }
    }

    toggleFullscreen() {
        const container = document.querySelector('.watch-video-section');
        const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;

        if (isFullscreen) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } else {
            if (container?.requestFullscreen) {
                container.requestFullscreen();
            } else if (container?.webkitRequestFullscreen) {
                container.webkitRequestFullscreen();
            } else if (this.video?.webkitEnterFullscreen) {
                // iOS Safari: use native video fullscreen
                this.video.webkitEnterFullscreen();
            }
        }
    }

    async togglePictureInPicture() {
        try {
            // Standard PiP API (Chrome, Edge, Firefox)
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && this.video.readyState >= 2) {
                await this.video.requestPictureInPicture();
            }
            // Safari fallback using webkitPresentationMode
            else if (typeof this.video.webkitSetPresentationMode === 'function') {
                const mode = this.video.webkitPresentationMode;
                this.video.webkitSetPresentationMode(mode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
            }
        } catch (err) {
            if (err.name !== 'NotAllowedError') {
                console.error('Picture-in-Picture error:', err);
            }
        }
    }

    /**
     * Copy current stream URL to clipboard
     */
    async copyStreamUrl() {
        if (!this.currentUrl) {
            console.warn('[WatchPage] No stream URL to copy');
            return;
        }

        // The player holds a reference that needs a login; hand out a sealed
        // link instead, which VLC and the like can open on their own
        let streamUrl;
        try {
            streamUrl = await API.proxy.shareLink(this.currentUrl);
        } catch (err) {
            console.error('[WatchPage] Could not create a stream link:', err);
            alert('Could not create a stream link.');
            return;
        }

        const showPromptFallback = () => {
            prompt('Copy this URL:', streamUrl);
        };

        // navigator.clipboard is only available in secure contexts (HTTPS/localhost)
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(streamUrl).then(() => {
                // Show brief feedback
                const btn = document.getElementById('watch-copy-url');
                if (btn) {
                    btn.textContent = '✓ Copied!';
                    setTimeout(() => {
                        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy Stream URL`;
                    }, 1500);
                }
                console.log('[WatchPage] Stream URL copied:', streamUrl);
            }).catch(() => {
                showPromptFallback();
            });
        } else {
            // Fallback for insecure contexts (HTTP)
            showPromptFallback();
        }
    }

    // === UI Updates ===

    updateProgress() {
        const total = this.totalDuration();
        if (!this.video || !total) return;
        if (this.seekRestartTimer) return; // keep the slider where it was dropped

        const percent = (this.position() / total) * 100;
        this.progressSlider.value = percent;
        this.timeCurrent.textContent = this.formatTime(this.position());

        // Show "Up Next" panel early for series (like streaming services do during credits)
        // Only show if auto-play next episode is enabled
        const autoPlayEnabled = this.app?.player?.settings?.autoPlayNextEpisode;
        if (autoPlayEnabled && this.contentType === 'series' && this.seriesInfo && !this.nextEpisodeShowing && !this.nextEpisodeDismissed) {
            const duration = total;
            const currentTime = this.position();

            // Only proceed if we have reliable duration data
            if (isFinite(duration) && duration >= 180 && currentTime >= 120) {
                const timeRemaining = duration - currentTime;
                const creditsThreshold = 10; // seconds before end to show "Up Next"

                if (timeRemaining <= creditsThreshold && timeRemaining > 0) {
                    const nextEp = this.getNextEpisode();
                    if (nextEp) {
                        this.nextEpisodeShowing = true;
                        this.showNextEpisodePanel(nextEp);
                    }
                }
            }
        }
    }

    onMetadataLoaded() {
        this.checkDirect();
        // Detect resolution
        if (this.video && this.video.videoHeight > 0) {
            this.currentStreamInfo = {
                width: this.video.videoWidth,
                height: this.video.videoHeight
            };
            this.updateQualityBadge();
        }

        // Handle resumption
        if (this.resumeTime > 0 && this.video) {
            const duration = this.video.duration;
            // Only resume if not near the end (95%)
            if (!duration || this.resumeTime < duration * 0.95) {
                console.log(`[WatchPage] Resuming at ${this.resumeTime}s`);
                this.video.currentTime = this.resumeTime;
            }
            this.resumeTime = 0; // Reset after use
        }
    }

    onPlay() {
        // Update play/pause button icons
        this.playPauseBtn?.querySelector('.icon-play')?.classList.add('hidden');
        this.playPauseBtn?.querySelector('.icon-pause')?.classList.remove('hidden');
        this.centerPlayBtn?.classList.remove('show');

        // Start overlay auto-hide
        this.startOverlayTimer();
    }

    onPause() {
        this.playPauseBtn?.querySelector('.icon-play')?.classList.remove('hidden');
        this.playPauseBtn?.querySelector('.icon-pause')?.classList.add('hidden');
        this.centerPlayBtn?.classList.add('show');

        // Keep overlay visible when paused
        this.showOverlay();
        clearTimeout(this.overlayTimeout);
    }

    onEnded() {
        // For series, show next episode panel if not already showing and auto-play is enabled
        const autoPlayEnabled = this.app?.player?.settings?.autoPlayNextEpisode;
        if (autoPlayEnabled && this.contentType === 'series' && this.seriesInfo && !this.nextEpisodeShowing) {
            const nextEp = this.getNextEpisode();
            if (nextEp) {
                this.nextEpisodeShowing = true;
                this.showNextEpisodePanel(nextEp);
            }
        }
    }

    onError(e) {
        // Only log actual fatal errors, not benign stream recovery events
        const error = this.video?.error;
        if (!error || !error.code) return;
        console.error('[WatchPage] Video error:', error.code, error.message);
        // Aborted = our own teardown; while hls.js drives the element it
        // recovers (or reports fatal) itself
        if (error.code === MediaError.MEDIA_ERR_ABORTED) return;
        if (this.direct && !this.direct.failed) {
            this.directFailed(`video error ${error.code}`);
            return;
        }
        if (this.hls) return;
        this.scheduleRetry(`video error ${error.code}`);
    }

    /**
     * Reload the current stream after a playback failure, resuming where it
     * stopped: up to MAX_RETRIES times with growing delays, instead of a dead
     * player that only a page refresh brings back
     */
    scheduleRetry(reason) {
        if (!this.currentUrl) return;
        const key = this.retryKey();
        if (key !== this.retry.key) this.retryResumeAt = 0; // another title
        // Where it stopped (a failed retry has position 0: keep the first one)
        const pos = this.position();
        if (pos > 0) this.retryResumeAt = pos;
        this.retry.schedule(reason, key);
    }

    /** Retries count per title/episode */
    retryKey() {
        return this.content ? `${this.content.type}:${this.content.id}` : this.currentUrl;
    }

    /**
     * The login ended (js/api.js Session): stop retrying, pause, and keep the
     * position in localStorage - Session.flushPendingHistory() saves it to
     * watch history after the next login, and the #watch link reopens it.
     */
    onSessionExpired() {
        this.retry.cancel();
        const body = this.progressBody();
        if (body) {
            try {
                localStorage.setItem(Session.PENDING_HISTORY_KEY, JSON.stringify({
                    userId: window.app?.currentUser?.id, at: Date.now(), body
                }));
            } catch { /* storage blocked */ }
        }
        this.video?.pause();
        this.hideLoading();
    }

    /**
     * loadVideo() for the current title again (retry, audio track switch).
     * loadVideo() stops first, which also ends history tracking: restart it.
     */
    async reload() {
        await this.loadVideo(this.currentUrl);
        this.showNowPlaying(this.content?.title);
        this.startHistoryTracking();
    }

    updateVolumeUI() {
        const isMuted = this.video?.muted || this.video?.volume === 0;
        this.muteBtn?.querySelector('.icon-vol')?.classList.toggle('hidden', isMuted);
        this.muteBtn?.querySelector('.icon-muted')?.classList.toggle('hidden', !isMuted);
    }

    formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // === Loading Spinner ===

    showLoading() {
        this.loadingSpinner?.classList.add('show');
        this.centerPlayBtn?.classList.remove('show');
    }

    hideLoading() {
        this.loadingSpinner?.classList.remove('show');
    }

    // === Audio tracks ===

    /**
     * Human-readable label for one probed audio stream.
     */
    audioTrackLabel(track, i) {
        const LANGS = {
            eng: 'English', en: 'English', ger: 'German', deu: 'German', de: 'German',
            fre: 'French', fra: 'French', fr: 'French', spa: 'Spanish', es: 'Spanish',
            ita: 'Italian', it: 'Italian', dut: 'Dutch', nld: 'Dutch', nl: 'Dutch',
            por: 'Portuguese', pt: 'Portuguese', rus: 'Russian', ru: 'Russian',
            pol: 'Polish', tur: 'Turkish', ara: 'Arabic', hin: 'Hindi',
            jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese',
            swe: 'Swedish', nor: 'Norwegian', dan: 'Danish', fin: 'Finnish'
        };
        const lang = (track.language || 'und').toLowerCase();
        // Many IPTV providers ship no language metadata at all, so fall back to a
        // positional label rather than showing a useless "und".
        const base = LANGS[lang] || (lang !== 'und' && lang !== '' ? lang.toUpperCase() : `Track ${i + 1}`);
        const bits = [];
        if (track.title) bits.push(track.title);
        if (track.codec) bits.push(track.codec.toUpperCase());
        if (track.channels) {
            bits.push(track.channels === 6 ? '5.1' : (track.channels === 2 ? 'Stereo' : `${track.channels}ch`));
        }
        return bits.length ? `${base} \u00b7 ${bits.join(' ')}` : base;
    }

    toggleAudioMenu() {
        if (this.audioMenuOpen) {
            this.closeAudioMenu();
        } else {
            this.updateAudioTracks();
            this.audioMenu?.classList.remove('hidden');
            this.audioMenuOpen = true;
        }
    }

    closeAudioMenu() {
        this.audioMenu?.classList.add('hidden');
        this.audioMenuOpen = false;
    }

    updateAudioTracks() {
        // With 0 or 1 track there is nothing to choose, so hide the button rather
        // than imply an option that does not exist.
        const many = (this.audioTracks?.length || 0) > 1;
        this.audioBtn?.classList.toggle('hidden', !many);
        if (!many) {
            this.closeAudioMenu();
            return;
        }
        if (!this.audioList) return;

        this.audioList.innerHTML = this.audioTracks.map((t, i) => {
            const active = t.id === this.selectedAudioTrack ? ' active' : '';
            return `<button class="captions-option${active}" data-track="${escapeHtml(t.id)}">${escapeHtml(this.audioTrackLabel(t, i))}</button>`;
        }).join('');

        this.audioList.querySelectorAll('.captions-option').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectAudioTrack(parseInt(btn.dataset.track, 10));
            });
        });
    }

    /**
     * Switch audio track. Selection happens server-side (ffmpeg -map), so this
     * reloads the stream from the current position with the new track mapped.
     */
    async selectAudioTrack(trackId) {
        if (!Number.isInteger(trackId) || trackId === this.selectedAudioTrack) {
            this.closeAudioMenu();
            return;
        }
        const pos = this.position();
        console.log(`[WatchPage] Switching audio track ${this.selectedAudioTrack} -> ${trackId} @ ${pos}s`);
        this.selectedAudioTrack = trackId;
        this.closeAudioMenu();
        this.updateAudioTracks();

        // Resume where we left off after the reload
        this.resumeTime = pos;
        await this.reload();
    }

    // === Captions ===

    toggleCaptionsMenu() {
        if (this.captionsMenuOpen) {
            this.closeCaptionsMenu();
        } else {
            this.updateCaptionsTracks();
            this.captionsMenu?.classList.remove('hidden');
            this.captionsMenuOpen = true;
        }
    }

    closeCaptionsMenu() {
        this.captionsMenu?.classList.add('hidden');
        this.captionsMenuOpen = false;
    }

    updateCaptionsTracks() {
        if (!this.captionsList || !this.video) return;

        // Build list of available text tracks
        const tracks = this.video.textTracks;
        let html = '<button class="captions-option" data-index="-1">Off</button>';

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (track.kind === 'subtitles' || track.kind === 'captions') {
                const label = track.label || track.language || `Track ${i + 1}`;
                const isActive = track.mode === 'showing';
                html += `<button class="captions-option ${isActive ? 'active' : ''}" data-index="${i}">${escapeHtml(label)}</button>`;
            }
        }

        // Check if any track is active, if not mark "Off" as active
        let anyActive = false;
        for (let i = 0; i < tracks.length; i++) {
            if (tracks[i].mode === 'showing') anyActive = true;
        }
        if (!anyActive) {
            html = html.replace('class="captions-option"', 'class="captions-option active"');
        }

        this.captionsList.innerHTML = html;

        // Add click handlers
        this.captionsList.querySelectorAll('.captions-option').forEach(btn => {
            btn.addEventListener('click', () => this.selectCaptionTrack(parseInt(btn.dataset.index)));
        });
    }

    selectCaptionTrack(index) {
        if (!this.video) return;

        const tracks = this.video.textTracks;

        // Disable all tracks
        for (let i = 0; i < tracks.length; i++) {
            tracks[i].mode = 'hidden';
        }

        // Enable selected track
        if (index >= 0 && index < tracks.length) {
            tracks[index].mode = 'showing';
        }

        // Update UI
        this.updateCaptionsTracks();
        this.closeCaptionsMenu();
    }

    // === Overlay Auto-Hide ===

    showOverlay() {
        this.overlay?.classList.remove('hidden');
        this.overlayVisible = true;
        this.startOverlayTimer();
    }

    hideOverlay() {
        if (!this.video?.paused) {
            this.overlay?.classList.add('hidden');
            this.overlayVisible = false;
        }
    }

    startOverlayTimer() {
        clearTimeout(this.overlayTimeout);
        this.overlayTimeout = setTimeout(() => this.hideOverlay(), 3000);
    }

    // === Keyboard Shortcuts ===

    handleKeyboard(e) {
        // Only handle when watch page is active
        const watchPage = document.getElementById('page-watch');
        if (!watchPage?.classList.contains('active')) return;

        // Don't handle if typing in input
        if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                this.togglePlay();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                this.skip(-10);
                this.showOverlay();
                break;
            case 'ArrowRight':
                e.preventDefault();
                this.skip(10);
                this.showOverlay();
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.setVolume(Math.min(100, parseInt(this.volumeSlider.value) + 10));
                this.volumeSlider.value = Math.min(100, parseInt(this.volumeSlider.value) + 10);
                this.showOverlay();
                break;
            case 'ArrowDown':
                e.preventDefault();
                this.setVolume(Math.max(0, parseInt(this.volumeSlider.value) - 10));
                this.volumeSlider.value = Math.max(0, parseInt(this.volumeSlider.value) - 10);
                this.showOverlay();
                break;
            case 'N':
                if (this.contentType !== 'series') break;
                e.preventDefault();
                this.playAdjacentEpisode(1);
                break;
            case 'P':
                if (this.contentType !== 'series') break;
                e.preventDefault();
                this.playAdjacentEpisode(-1);
                break;
            case 'f':
                e.preventDefault();
                this.toggleFullscreen();
                break;
            case 'm':
                e.preventDefault();
                this.toggleMute();
                this.showOverlay();
                break;
            case 'Escape':
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    this.goBack();
                }
                break;
        }
    }

    // === Details Section ===

    renderDetails() {
        if (!this.content) return;

        const isChannel = this.content.type === 'channel' || !this.content.type; // Default to channel if unknown
        const fallback = isChannel ? '/img/placeholder.png' : '/img/poster-placeholder.jpg';

        this.posterEl.onerror = () => {
            this.posterEl.onerror = null;
            this.posterEl.src = fallback;
        };
        this.posterEl.src = API.imageUrl(this.content.poster) || fallback;
        this.posterEl.alt = this.content.title || '';
        this.contentTitleEl.textContent = this.content.title || '';
        this.yearEl.textContent = this.content.year || '';
        this.ratingEl.textContent = this.content.rating ? `★ ${this.content.rating}` : '';
        this.descriptionEl.textContent = this.content.description || '';

        // Update play button text
        if (this.playBtnText) {
            this.playBtnText.textContent = 'Play';
        }
    }

    async checkFavorite() {
        if (!this.content) return;

        try {
            const itemId = this.contentType === 'movie' ? this.content.id : this.content.seriesId;
            const itemType = this.contentType === 'movie' ? 'movie' : 'series';
            const result = await API.favorites.check(this.content.sourceId, itemId, itemType);
            this.isFavorite = result?.isFavorite || false;
            this.updateFavoriteUI();
        } catch (e) {
            console.warn('Could not check favorite status');
        }
    }

    async toggleFavorite() {
        if (!this.content) return;

        const itemId = this.contentType === 'movie' ? this.content.id : this.content.seriesId;
        const itemType = this.contentType === 'movie' ? 'movie' : 'series';

        try {
            if (this.isFavorite) {
                await API.favorites.remove(this.content.sourceId, itemId, itemType);
                this.isFavorite = false;
            } else {
                await API.favorites.add(this.content.sourceId, itemId, itemType);
                this.isFavorite = true;
            }
            this.updateFavoriteUI();
        } catch (e) {
            console.error('Error toggling favorite:', e);
        }
    }

    updateFavoriteUI() {
        const outlineIcon = this.favoriteBtn?.querySelector('.icon-fav-outline');
        const filledIcon = this.favoriteBtn?.querySelector('.icon-fav-filled');

        outlineIcon?.classList.toggle('hidden', this.isFavorite);
        filledIcon?.classList.toggle('hidden', !this.isFavorite);
    }

    scrollToVideo() {
        document.getElementById('page-watch')?.scrollTo({ top: 0, behavior: 'smooth' });
        if (this.video?.paused) {
            this.video.play().catch(console.error);
        }
    }

    // === Recommended Movies ===

    async loadRecommended(sourceId, categoryId) {
        if (!sourceId || !categoryId) {
            this.recommendedSection?.classList.add('hidden');
            return;
        }

        try {
            const movies = await API.proxy.xtream.vodStreams(sourceId, categoryId);
            if (!movies || movies.length === 0) {
                this.recommendedSection?.classList.add('hidden');
                return;
            }

            // Filter out current movie, take first 12
            const filtered = movies
                .filter(m => m.stream_id !== this.content?.id)
                .slice(0, 12);

            this.renderRecommendedGrid(filtered, sourceId);
        } catch (e) {
            console.error('Error loading recommended:', e);
            this.recommendedSection?.classList.add('hidden');
        }
    }

    renderRecommendedGrid(movies, sourceId) {
        if (!this.recommendedGrid) return;

        this.recommendedGrid.innerHTML = movies.map(movie => `
            <div class="watch-recommended-card" data-id="${escapeHtml(movie.stream_id)}" data-source="${escapeHtml(sourceId)}">
                <img src="${escapeHtml(API.imageUrl(movie.stream_icon || movie.cover) || '/img/placeholder.png')}" 
                     alt="${escapeHtml(movie.name)}" 
                     data-fallback="/img/placeholder.png" loading="lazy">
                <p>${escapeHtml(movie.name)}</p>
            </div>
        `).join('');

        // Click handlers
        this.recommendedGrid.querySelectorAll('.watch-recommended-card').forEach(card => {
            card.addEventListener('click', () => this.playRecommendedMovie(card.dataset.id, parseInt(card.dataset.source)));
        });
    }

    async playRecommendedMovie(streamId, sourceId) {
        try {
            // Fetch movie details
            const movies = await API.proxy.xtream.vodStreams(sourceId);
            const movie = movies?.find(m => m.stream_id == streamId);

            if (!movie) return;

            const container = movie.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(sourceId, streamId, 'movie', container);

            if (result?.url) {
                this.play({
                    type: 'movie',
                    id: movie.stream_id,
                    title: movie.name,
                    poster: movie.stream_icon || movie.cover,
                    description: movie.plot || '',
                    year: movie.year,
                    rating: movie.rating,
                    sourceId: sourceId,
                    categoryId: movie.category_id
                }, result.url);
            }
        } catch (e) {
            console.error('Error playing recommended movie:', e);
        }
    }

    // === Series Episodes ===

    renderEpisodes() {
        if (!this.seriesInfo?.episodes || !this.seasonsContainer) return;

        const seasons = Object.keys(this.seriesInfo.episodes).sort((a, b) => parseInt(a) - parseInt(b));

        this.seasonsContainer.innerHTML = seasons.map(seasonNum => {
            const episodes = this.seriesInfo.episodes[seasonNum];
            const isCurrentSeason = parseInt(seasonNum) === parseInt(this.currentSeason);

            return `
                <div class="watch-season-group">
                    <div class="watch-season-header ${isCurrentSeason ? '' : 'collapsed'}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon">
                            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                        </svg>
                        <span class="watch-season-name">Season ${seasonNum}</span>
                        <span class="watch-season-count">${episodes.length} episodes</span>
                    </div>
                    <div class="watch-episode-list">
                        ${episodes.map(ep => {
                const isActive = parseInt(seasonNum) === parseInt(this.currentSeason) &&
                    parseInt(ep.episode_num) === parseInt(this.currentEpisode);
                return `
                                <div class="watch-episode-item ${isActive ? 'active' : ''}" 
                                     data-episode-id="${escapeHtml(ep.id)}" 
                                     data-season="${seasonNum}"
                                     data-episode="${escapeHtml(ep.episode_num)}"
                                     data-container="${escapeHtml(ep.container_extension || 'mp4')}">
                                    <span class="watch-episode-num">E${escapeHtml(ep.episode_num)}</span>
                                    <span class="watch-episode-title">${escapeHtml(ep.title || `Episode ${ep.episode_num}`)}</span>
                                    <span class="watch-episode-duration">${escapeHtml(ep.duration)}</span>
                                </div>
                            `;
            }).join('')}
                    </div>
                </div>
            `;
        }).join('');

        // Season header toggle
        this.seasonsContainer.querySelectorAll('.watch-season-header').forEach(header => {
            header.addEventListener('click', () => {
                header.classList.toggle('collapsed');
            });
        });

        // Episode click handlers
        this.seasonsContainer.querySelectorAll('.watch-episode-item').forEach(ep => {
            ep.addEventListener('click', () => this.playEpisodeFromList(ep));
        });
    }

    async playEpisodeFromList(episodeEl) {
        const episodeId = episodeEl.dataset.episodeId;
        const seasonNum = episodeEl.dataset.season;
        const episodeNum = episodeEl.dataset.episode;
        const container = episodeEl.dataset.container || 'mp4';

        try {
            const result = await API.proxy.xtream.getStreamUrl(this.content.sourceId, episodeId, 'series', container);

            if (result?.url) {
                const episodeTitle = episodeEl.querySelector('.watch-episode-title')?.textContent || `Episode ${episodeNum}`;

                this.play({
                    type: 'series',
                    id: episodeId,
                    title: this.content.title,
                    subtitle: `S${seasonNum} E${episodeNum} - ${episodeTitle}`,
                    poster: this.content.poster,
                    description: this.content.description,
                    year: this.content.year,
                    rating: this.content.rating,
                    sourceId: this.content.sourceId,
                    seriesId: this.content.seriesId,
                    seriesInfo: this.seriesInfo,
                    currentSeason: seasonNum,
                    currentEpisode: episodeNum,
                    containerExtension: container
                }, result.url);
            }
        } catch (e) {
            console.error('Error playing episode:', e);
        }
    }

    // === Next Episode ===

    getNextEpisode() {
        return this.getAdjacentEpisode(1);
    }

    /**
     * Episode `offset` steps from the current one (-1 = previous, 1 = next),
     * crossing season boundaries. Returns the episode with its seasonNum, or null.
     */
    getAdjacentEpisode(offset) {
        if (!this.seriesInfo?.episodes || !this.currentSeason || !this.currentEpisode) return null;

        const seasons = Object.keys(this.seriesInfo.episodes).sort((a, b) => parseInt(a) - parseInt(b));
        const allEpisodes = seasons.flatMap(seasonNum =>
            (this.seriesInfo.episodes[seasonNum] || []).map(ep => ({ ...ep, seasonNum }))
        );

        const index = allEpisodes.findIndex(ep =>
            parseInt(ep.seasonNum) === parseInt(this.currentSeason) &&
            parseInt(ep.episode_num) === parseInt(this.currentEpisode)
        );
        if (index < 0) return null;

        return allEpisodes[index + offset] || null;
    }

    showNextEpisodePanel(nextEp) {
        if (!this.nextEpisodePanel) return;

        this.nextEpisodeTitle.textContent = `S${nextEp.seasonNum} E${nextEp.episode_num} - ${nextEp.title || `Episode ${nextEp.episode_num}`}`;
        this.nextEpisodePanel.classList.remove('hidden');
        this.nextEpisodePanel.nextEpisodeData = nextEp;

        // Start countdown
        this.nextEpisodeCountdown = 10;
        this.nextCountdown.textContent = this.nextEpisodeCountdown;

        this.nextEpisodeInterval = setInterval(() => {
            this.nextEpisodeCountdown--;
            this.nextCountdown.textContent = this.nextEpisodeCountdown;

            if (this.nextEpisodeCountdown <= 0) {
                this.playNextEpisode();
            }
        }, 1000);
    }

    async playNextEpisode() {
        // Save next episode data BEFORE canceling (cancel clears the data)
        const nextEp = this.nextEpisodePanel?.nextEpisodeData;

        this.cancelNextEpisode();

        if (!nextEp) return;

        await this.playEpisode(nextEp);
    }

    /**
     * Play an episode object from seriesInfo (as returned by getAdjacentEpisode)
     */
    async playEpisode(ep) {
        try {
            const container = ep.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(this.content.sourceId, ep.id, 'series', container);

            if (result?.url) {
                this.play({
                    type: 'series',
                    id: ep.id,
                    title: this.content.title,
                    subtitle: `S${ep.seasonNum} E${ep.episode_num} - ${ep.title || `Episode ${ep.episode_num}`}`,
                    poster: this.content.poster,
                    description: this.content.description,
                    year: this.content.year,
                    rating: this.content.rating,
                    sourceId: this.content.sourceId,
                    seriesId: this.content.seriesId,
                    seriesInfo: this.seriesInfo,
                    currentSeason: ep.seasonNum,
                    currentEpisode: ep.episode_num,
                    containerExtension: container
                }, result.url);
            }
        } catch (e) {
            console.error('Error playing episode:', e);
        }
    }

    cancelNextEpisode() {
        clearInterval(this.nextEpisodeInterval);
        this.nextEpisodePanel?.classList.add('hidden');
        this.nextEpisodeShowing = false;
        this.nextEpisodeDismissed = true; // Prevent re-triggering
        if (this.nextEpisodePanel) {
            this.nextEpisodePanel.nextEpisodeData = null;
        }
    }

    // === Episode navigation / autoplay ===

    updateEpisodeControls() {
        const isSeries = this.contentType === 'series' && !!this.seriesInfo;
        [this.prevEpisodeBtn, this.nextEpisodeBtn, this.autoplayBtn].forEach(btn =>
            btn?.classList.toggle('hidden', !isSeries)
        );
        if (!isSeries) return;

        if (this.prevEpisodeBtn) this.prevEpisodeBtn.disabled = !this.getAdjacentEpisode(-1);
        if (this.nextEpisodeBtn) this.nextEpisodeBtn.disabled = !this.getAdjacentEpisode(1);
        const autoplay = !!this.app?.player?.settings?.autoPlayNextEpisode;
        this.autoplayBtn?.setAttribute('aria-pressed', String(autoplay));
        if (this.autoplayBtn) this.autoplayBtn.title = `Autoplay next episode: ${autoplay ? 'on' : 'off'}`;
    }

    playAdjacentEpisode(offset) {
        const ep = this.getAdjacentEpisode(offset);
        if (!ep) return;
        this.cancelNextEpisode();
        this.playEpisode(ep);
    }

    /**
     * Same setting as Settings > "Auto-play next episode", so the two stay in sync
     */
    toggleAutoplay() {
        const settings = this.app?.player?.settings;
        if (!settings) return;

        settings.autoPlayNextEpisode = !settings.autoPlayNextEpisode;
        this.app.player.saveSettings();

        const settingsToggle = document.getElementById('setting-autoplay-next');
        if (settingsToggle) settingsToggle.checked = settings.autoPlayNextEpisode;

        if (settings.autoPlayNextEpisode) {
            // Allow "Up Next" to trigger again for the current episode
            this.nextEpisodeDismissed = false;
        } else if (this.nextEpisodeShowing) {
            this.cancelNextEpisode();
        }

        this.updateEpisodeControls();
    }

    // === Navigation ===

    goBack() {
        this.stop();
        this.cancelNextEpisode();

        // Navigate to the page we came from (stored in returnPage)
        // We don't use history.back() because we used replaceHistory when navigating here
        this.app.navigateTo(this.returnPage || 'movies');
    }

    show() {
        // Called when page becomes visible
    }

    hide() {
        // Called when page becomes hidden
        // Don't stop playback here - allow background playback
        this.cancelNextEpisode();
    }
    // ============================================================
    // Watch History Tracking
    // ============================================================

    startHistoryTracking() {
        this.stopHistoryTracking(); // Clear existing if any
        this.historyInterval = setInterval(() => this.saveProgress(), 10000); // 10s
    }

    stopHistoryTracking() {
        if (this.historyInterval) {
            clearInterval(this.historyInterval);
            this.historyInterval = null;
        }
    }

    /** Seconds to resume `content` at (any copy of the title), 0 = from the start */
    async lookupResume(content) {
        const isEpisode = content.type !== 'movie';
        const params = new URLSearchParams({
            type: isEpisode ? 'episode' : 'movie',
            sourceId: content.sourceId || '',
            itemId: content.id || '',
            ...(isEpisode ? {
                seriesId: content.seriesId || '',
                season: content.currentSeason || '',
                episode: content.currentEpisode || ''
            } : {})
        });
        try {
            const res = await API.request('GET', `/history/resume?${params}`);
            return res?.position || 0;
        } catch (err) {
            console.warn('[WatchPage] Resume lookup failed:', err);
            return 0;
        }
    }

    async saveProgress() {
        if (!this.content || !this.video || this.video.paused || Session.expired) return;
        const body = this.progressBody();
        if (!body) return;
        try {
            await window.API.request('POST', '/history', body);
        } catch (err) {
            console.warn('[History] Failed to save progress:', err);
        }
    }

    /** The POST /api/history body for where playback is now, or null */
    progressBody() {
        if (!this.content || !this.video) return null;

        // While a retry is pending the element is empty: use where it stopped
        const stoppedAt = this.retry.key === this.retryKey() ? this.retryResumeAt : 0;
        const progress = Math.floor(this.position() || stoppedAt || 0);
        const duration = Math.floor(this.totalDuration());

        if (!progress || isNaN(progress) || isNaN(duration) || duration <= 0) return null;

        const data = {
                title: this.content.title || 'Unknown Title',
                subtitle: this.content.subtitle || (this.content.type === 'movie' ? 'Movie' : 'Series'),
                poster: this.content.poster,
                sourceId: this.content.sourceId,
                containerExtension: this.containerExtension,
                // Series-specific fields for next episode functionality
                seriesId: this.content.seriesId || null,
                currentSeason: this.currentSeason || null,
                currentEpisode: this.currentEpisode || null,
                // Played straight from the user's own provider (which stream)
                direct: this.direct?.confirmed ? { providerId: this.direct.providerId, streamId: this.direct.streamId } : null
            };

        return {
            id: this.content.id,
            type: this.content.type === 'movie' ? 'movie' : 'episode',
            sourceId: this.content.sourceId,
            progress,
            duration,
            data
        };
    }
}

window.WatchPage = WatchPage;
