/**
 * Settings Page Controller
 */

class SettingsPage {
    constructor(app) {
        this.app = app;
        this.tabs = document.querySelectorAll('.tabs .tab');
        this.tabContents = document.querySelectorAll('.tab-content');

        this.init();
    }

    init() {
        // Tab switching
        this.tabs.forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // Player settings
        this.initPlayerSettings();

        // Transcoding settings
        this.initTranscodingSettings();

        // User management (admin only)
        this.initUserManagement();
    }

    initPlayerSettings() {
        const arrowKeysToggle = document.getElementById('setting-arrow-keys');
        const overlayDurationInput = document.getElementById('setting-overlay-duration');
        const defaultVolumeSlider = document.getElementById('setting-default-volume');
        const volumeValueDisplay = document.getElementById('volume-value');
        const rememberVolumeToggle = document.getElementById('setting-remember-volume');
        const autoPlayNextToggle = document.getElementById('setting-autoplay-next');

        // Load current settings
        if (this.app.player?.settings) {
            arrowKeysToggle.checked = this.app.player.settings.arrowKeysChangeChannel;
            overlayDurationInput.value = this.app.player.settings.overlayDuration;
            defaultVolumeSlider.value = this.app.player.settings.defaultVolume;
            volumeValueDisplay.textContent = this.app.player.settings.defaultVolume + '%';
            rememberVolumeToggle.checked = this.app.player.settings.rememberVolume;
            autoPlayNextToggle.checked = this.app.player.settings.autoPlayNextEpisode;
        }

        // Arrow keys toggle
        arrowKeysToggle.addEventListener('change', () => {
            this.app.player.settings.arrowKeysChangeChannel = arrowKeysToggle.checked;
            this.app.player.saveSettings();
        });

        // Overlay duration
        overlayDurationInput.addEventListener('change', () => {
            this.app.player.settings.overlayDuration = parseInt(overlayDurationInput.value) || 5;
            this.app.player.saveSettings();
        });

        // Default volume slider
        defaultVolumeSlider.addEventListener('input', () => {
            const value = defaultVolumeSlider.value;
            volumeValueDisplay.textContent = value + '%';
            this.app.player.settings.defaultVolume = parseInt(value);
            this.app.player.saveSettings();
        });

        // Remember volume toggle
        rememberVolumeToggle.addEventListener('change', () => {
            this.app.player.settings.rememberVolume = rememberVolumeToggle.checked;
            this.app.player.saveSettings();
        });

        // Language priority (search + filter zones ordering)
        document.getElementById('setting-language-priority')?.addEventListener('change', (e) => {
            this.app.player.settings.languagePriority = e.target.value;
            this.app.player.saveSettings();
            this.updateHardFilterState();
        });
        // Hard filter: hide titles explicitly marked as another language
        document.getElementById('setting-language-hard-filter')?.addEventListener('change', (e) => {
            this.app.player.settings.languageHardFilter = e.target.checked;
            this.app.player.saveSettings();
        });

        // Auto-play next episode toggle
        autoPlayNextToggle.addEventListener('change', () => {
            this.app.player.settings.autoPlayNextEpisode = autoPlayNextToggle.checked;
            this.app.player.saveSettings();
        });

        // EPG refresh interval
        const epgRefreshSelect = document.getElementById('epg-refresh-interval');
        if (epgRefreshSelect && this.app.player?.settings) {
            // Load saved value from player settings
            epgRefreshSelect.value = this.app.player.settings.epgRefreshInterval || '24';

            // Save on change - server will restart its sync timer via PUT /api/settings
            epgRefreshSelect.addEventListener('change', () => {
                this.app.player.settings.epgRefreshInterval = epgRefreshSelect.value;
                this.app.player.saveSettings();
            });
        }

        // Update last refreshed display
        this.updateEpgLastRefreshed();
    }

    async initTranscodingSettings() {
        // Encoder settings
        const hwEncoderSelect = document.getElementById('setting-hw-encoder');
        const maxResolutionSelect = document.getElementById('setting-max-resolution');
        const qualitySelect = document.getElementById('setting-quality');

        // Stream processing (use -tc suffix IDs from Transcoding tab)
        const forceProxyToggle = document.getElementById('setting-force-proxy-tc');
        const autoTranscodeToggle = document.getElementById('setting-auto-transcode-tc');
        const forceTranscodeToggle = document.getElementById('setting-force-transcode-tc');
        const forceVideoTranscodeToggle = document.getElementById('setting-force-video-transcode-tc');
        const forceRemuxToggle = document.getElementById('setting-force-remux-tc');
        const streamFormatSelect = document.getElementById('setting-stream-format-tc');

        // User-Agent (Transcoding tab versions)
        const userAgentSelect = document.getElementById('setting-user-agent-tc');
        const userAgentCustomInput = document.getElementById('setting-user-agent-custom-tc');
        const customUaContainer = document.getElementById('custom-user-agent-container-tc');

        // Fetch settings directly from API to avoid race condition with VideoPlayer
        let s;
        try {
            s = await API.settings.get();
        } catch (err) {
            console.warn('[Settings] Failed to load settings from API, using player defaults:', err);
            s = this.app.player?.settings || {};
        }

        if (hwEncoderSelect) hwEncoderSelect.value = s.hwEncoder || 'auto';
        if (maxResolutionSelect) maxResolutionSelect.value = s.maxResolution || '1080p';
        if (qualitySelect) qualitySelect.value = s.quality || 'medium';
        if (forceProxyToggle) forceProxyToggle.checked = s.forceProxy === true;
        if (autoTranscodeToggle) autoTranscodeToggle.checked = s.autoTranscode !== false;
        if (forceTranscodeToggle) forceTranscodeToggle.checked = s.forceTranscode === true;
        if (forceVideoTranscodeToggle) forceVideoTranscodeToggle.checked = s.forceVideoTranscode === true;
        if (forceRemuxToggle) forceRemuxToggle.checked = s.forceRemux || false;
        if (streamFormatSelect) streamFormatSelect.value = s.streamFormat || 'm3u8';
        if (userAgentSelect) userAgentSelect.value = s.userAgentPreset || 'chrome';
        if (userAgentCustomInput) userAgentCustomInput.value = s.userAgentCustom || '';
        if (customUaContainer) {
            customUaContainer.style.display = userAgentSelect?.value === 'custom' ? 'flex' : 'none';
        }

        // Event listeners for encoder settings
        hwEncoderSelect?.addEventListener('change', () => {
            this.app.player.settings.hwEncoder = hwEncoderSelect.value;
            this.app.player.saveSettings();
        });

        maxResolutionSelect?.addEventListener('change', () => {
            this.app.player.settings.maxResolution = maxResolutionSelect.value;
            this.app.player.saveSettings();
        });

        qualitySelect?.addEventListener('change', () => {
            this.app.player.settings.quality = qualitySelect.value;
            this.app.player.saveSettings();
        });

        // Audio Mix Preset
        const audioMixSelect = document.getElementById('setting-audio-mix');
        if (audioMixSelect) {
            audioMixSelect.value = s.audioMixPreset || 'auto';
            audioMixSelect.addEventListener('change', () => {
                this.app.player.settings.audioMixPreset = audioMixSelect.value;
                this.app.player.saveSettings();
            });
        }

        // Upscaling Settings
        const upscaleEnabledToggle = document.getElementById('setting-upscale-enabled');
        const upscaleMethodSelect = document.getElementById('setting-upscale-method');
        const upscaleTargetSelect = document.getElementById('setting-upscale-target');
        const upscaleMethodContainer = document.getElementById('upscale-method-container');
        const upscaleTargetContainer = document.getElementById('upscale-target-container');

        // Helper to toggle upscale options visibility
        const toggleUpscaleOptions = (enabled) => {
            if (upscaleMethodContainer) upscaleMethodContainer.style.display = enabled ? 'flex' : 'none';
            if (upscaleTargetContainer) upscaleTargetContainer.style.display = enabled ? 'flex' : 'none';
        };

        // Load upscaling settings
        if (upscaleEnabledToggle) {
            upscaleEnabledToggle.checked = s.upscaleEnabled || false;
            toggleUpscaleOptions(upscaleEnabledToggle.checked);
        }
        if (upscaleMethodSelect) upscaleMethodSelect.value = s.upscaleMethod || 'hardware';
        if (upscaleTargetSelect) upscaleTargetSelect.value = s.upscaleTarget || '1080p';

        // Upscaling event handlers
        upscaleEnabledToggle?.addEventListener('change', () => {
            this.app.player.settings.upscaleEnabled = upscaleEnabledToggle.checked;
            this.app.player.saveSettings();
            toggleUpscaleOptions(upscaleEnabledToggle.checked);
        });

        upscaleMethodSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleMethod = upscaleMethodSelect.value;
            this.app.player.saveSettings();
        });

        upscaleTargetSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleTarget = upscaleTargetSelect.value;
            this.app.player.saveSettings();
        });

        // Stream processing toggles
        forceProxyToggle?.addEventListener('change', () => {
            this.app.player.settings.forceProxy = forceProxyToggle.checked;
            this.app.player.saveSettings();
        });

        autoTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.autoTranscode = autoTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.forceTranscode = forceTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceVideoTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.forceVideoTranscode = forceVideoTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceRemuxToggle?.addEventListener('change', () => {
            this.app.player.settings.forceRemux = forceRemuxToggle.checked;
            this.app.player.saveSettings();
        });

        streamFormatSelect?.addEventListener('change', () => {
            this.app.player.settings.streamFormat = streamFormatSelect.value;
            this.app.player.saveSettings();
        });

        // User-Agent handlers
        const toggleCustomInput = () => {
            if (customUaContainer) {
                customUaContainer.style.display = userAgentSelect?.value === 'custom' ? 'flex' : 'none';
            }
        };

        userAgentSelect?.addEventListener('change', () => {
            this.app.player.settings.userAgentPreset = userAgentSelect.value;
            this.app.player.saveSettings();
            toggleCustomInput();
        });

        userAgentCustomInput?.addEventListener('change', () => {
            this.app.player.settings.userAgentCustom = userAgentCustomInput.value;
            this.app.player.saveSettings();
        });
    }

    /**
     * Load and display hardware info in Transcoding tab
     */
    async loadHardwareInfo() {
        const container = document.getElementById('hw-info-container');
        if (!container) return;

        try {
            const response = await fetch('/api/settings/hw-info');
            if (!response.ok) throw new Error('Failed to fetch hardware info');
            const hwInfo = await response.json();

            const detected = [];

            // Only show detected hardware
            if (hwInfo.nvidia?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ NVIDIA</span>
                    <span class="hw-name">${hwInfo.nvidia.name}</span>
                </div>`);
            }

            if (hwInfo.amf?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ AMD</span>
                    <span class="hw-name">${hwInfo.amf.name || 'Available'}</span>
                </div>`);
            }

            if (hwInfo.qsv?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ Intel QSV</span>
                    <span class="hw-name">Available</span>
                </div>`);
            }

            if (hwInfo.vaapi?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ VAAPI</span>
                    <span class="hw-name">${hwInfo.vaapi.device || 'Available'}</span>
                </div>`);
            }

            let html;
            if (detected.length > 0) {
                html = `<div class="hw-info-grid">${detected.join('')}</div>`;
                html += `<p class="hint" style="margin-top: var(--space-sm);">Recommended encoder: <strong>${hwInfo.recommended}</strong></p>`;
            } else {
                html = `<p class="hint">No GPU acceleration detected. Using software encoding.</p>`;
            }

            container.innerHTML = html;
        } catch (err) {
            console.error('Error loading hardware info:', err);
            container.innerHTML = '<p class="hint error">Failed to load hardware info</p>';
        }
    }

    initUserManagement() {
        // User tab visibility is handled in show() method
        // when currentUser is available

        // "Kids" is a viewer with a rating limit (and a Live TV whitelist)
        const newRole = document.getElementById('new-role');
        newRole?.addEventListener('change', () => {
            document.getElementById('new-maturity-group')?.classList.toggle('hidden', newRole.value !== 'kids');
        });
        const editRole = document.getElementById('edit-role');
        editRole?.addEventListener('change', () => {
            document.getElementById('edit-kids-group')?.classList.toggle('hidden', editRole.value !== 'kids');
        });
        this.initKidsChannelPicker();

        // Handle add user form
        const addUserForm = document.getElementById('add-user-form');
        if (addUserForm) {
            addUserForm.addEventListener('submit', async (e) => {
                e.preventDefault();

                const username = document.getElementById('new-username').value;
                const password = document.getElementById('new-password').value;
                const role = document.getElementById('new-role').value;
                const kids = role === 'kids';

                try {
                    await API.users.create({
                        username, password,
                        role: kids ? 'viewer' : role,
                        kids,
                        maxMaturity: kids ? parseInt(document.getElementById('new-maturity').value, 10) : null
                    });
                    alert(kids
                        ? 'Kids account created. Use Edit to choose which Live TV channels it may watch.'
                        : 'User created successfully!');
                    addUserForm.reset();
                    document.getElementById('new-maturity-group')?.classList.add('hidden');
                    this.loadUsers();
                } catch (err) {
                    alert('Error creating user: ' + err.message);
                }
            });
        }
    }

    async loadUsers() {
        const userList = document.getElementById('user-list');
        if (!userList) return;

        try {
            const users = await API.users.getAll();
            // Store users in memory for easy access during edit
            this.users = users;

            if (users.length === 0) {
                userList.innerHTML = '<tr><td colspan="5" class="hint">No users found</td></tr>';
                return;
            }

            userList.innerHTML = users.map(user => {
                const isSSO = !!user.oidcId;
                const typeBadge = isSSO
                    ? '<span class="user-badge user-badge-sso">SSO</span>'
                    : '<span class="user-badge user-badge-local">Local</span>';

                const roleBadge = user.role === 'admin'
                    ? '<span class="user-badge user-badge-admin">Admin</span>'
                    : user.kids
                        ? '<span class="user-badge user-badge-kids">Kids</span>'
                        : '<span class="user-badge user-badge-viewer">Viewer</span>';

                return `
                <tr>
                    <td>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <strong>${escapeHtml(user.username)}</strong>
                            ${typeBadge}
                        </div>
                    </td>
                    <td>${user.email ? escapeHtml(user.email) : '<span class="hint">-</span>'}</td>
                    <td>${roleBadge}</td>
                    <td>${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}</td>
                    <td>
                        <button class="btn btn-sm btn-secondary" data-user-action="edit" data-user-id="${escapeHtml(user.id)}">Edit</button>
                        <button class="btn btn-sm btn-error" data-user-action="delete" data-user-id="${escapeHtml(user.id)}">Delete</button>
                    </td>
                </tr>
            `}).join('');

            userList.querySelectorAll('[data-user-action]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const user = users.find(u => String(u.id) === btn.dataset.userId);
                    if (!user) return;
                    if (btn.dataset.userAction === 'edit') this.openEditUserModal(user.id);
                    else this.deleteUser(user.id, user.username);
                });
            });
        } catch (err) {
            console.error('Error loading users:', err);
            userList.innerHTML = '<tr><td colspan="5" class="hint">Error loading users</td></tr>';
        }
    }

    openEditUserModal(userId) {
        console.log('openEditUserModal called with ID:', userId, 'Type:', typeof userId);
        console.log('Current users list:', this.users);

        const user = this.users.find(u => u.id === userId);
        if (!user) {
            console.error('User not found in this.users cache!');
            console.log('Available IDs:', this.users.map(u => u.id));
            return;
        }
        console.log('User found:', user);

        const modal = document.getElementById('edit-user-modal');
        console.log('Modal element:', modal);
        if (!modal) {
            console.error('CRITICAL: Modal element #edit-user-modal not found in DOM!');
            alert('Error: Modal not found. Please refresh the page.');
            return;
        }

        const isSSO = !!user.oidcId;
        console.log('Is SSO user:', isSSO);

        // Populate form with null checks
        try {
            const editId = document.getElementById('edit-user-id');
            const editUsername = document.getElementById('edit-username');
            const editEmail = document.getElementById('edit-email');
            const editRole = document.getElementById('edit-role');
            const editPassword = document.getElementById('edit-password');

            console.log('Form elements found:', { editId, editUsername, editEmail, editRole, editPassword });

            if (editId) editId.value = user.id;
            if (editUsername) editUsername.value = user.username;
            if (editEmail) editEmail.value = user.email || '';
            if (editRole) editRole.value = user.kids ? 'kids' : user.role;
            if (editPassword) editPassword.value = '';

            // Kids: rating limit and Live TV whitelist
            document.getElementById('edit-kids-group')?.classList.toggle('hidden', !user.kids);
            const editMaturity = document.getElementById('edit-maturity');
            if (editMaturity) editMaturity.value = String(user.maxMaturity || 2);
            this.kidsChannels = [...(user.allowedChannels || [])];
            this.renderKidsChannels();
            const pickerSearch = document.getElementById('kids-channel-search');
            if (pickerSearch) pickerSearch.value = '';
            const pickerResults = document.getElementById('kids-channel-results');
            if (pickerResults) pickerResults.innerHTML = '';

            // Handle SSO specific UI
            const passwordHint = document.getElementById('edit-password-hint');
            const oidcGroup = document.getElementById('oidc-info-group');
            const oidcIdDisplay = document.getElementById('edit-oidc-id');

            if (isSSO) {
                if (editPassword) {
                    editPassword.disabled = true;
                    editPassword.placeholder = "Managed by SSO Provider";
                }
                if (passwordHint) passwordHint.textContent = "Password cannot be changed for SSO users.";
                if (oidcGroup) oidcGroup.classList.remove('hidden');
                if (oidcIdDisplay) oidcIdDisplay.textContent = user.oidcId;
            } else {
                if (editPassword) {
                    editPassword.disabled = false;
                    editPassword.placeholder = "Leave blank to keep current";
                }
                if (passwordHint) passwordHint.textContent = "Optional. Leave blank to keep unchanged.";
                if (oidcGroup) oidcGroup.classList.add('hidden');
            }

            // Show modal
            console.log('Adding active class to modal...');
            modal.classList.add('active');
            console.log('Modal classes after add:', modal.classList.toString());

            // Setup Close/Cancel handlers (once)
            this.setupModalHandlers(modal);
            console.log('Modal should now be visible!');
        } catch (err) {
            console.error('Error populating modal:', err);
            alert('Error opening edit modal: ' + err.message);
        }
    }

    setupModalHandlers(modal) {
        if (this.modalHandlersSetup) return;

        const closeBtn = document.getElementById('edit-user-close');
        const cancelBtn = document.getElementById('edit-user-cancel');
        const saveBtn = document.getElementById('edit-user-save');

        const closeModal = () => modal.classList.remove('active');

        closeBtn.onclick = closeModal;
        cancelBtn.onclick = closeModal;

        // Click outside to close
        modal.onclick = (e) => {
            if (e.target === modal) closeModal();
        };

        // Save Handler
        saveBtn.onclick = async () => {
            const userId = document.getElementById('edit-user-id').value;
            const role = document.getElementById('edit-role').value;
            const kids = role === 'kids';
            const updates = {
                username: document.getElementById('edit-username').value,
                role: kids ? 'viewer' : role,
                kids
            };
            if (kids) {
                updates.maxMaturity = parseInt(document.getElementById('edit-maturity').value, 10);
                updates.allowedChannels = this.kidsChannels || [];
            }

            const newPassword = document.getElementById('edit-password').value;
            if (newPassword && !document.getElementById('edit-password').disabled) {
                updates.password = newPassword;
            }

            try {
                await API.users.update(userId, updates);
                // alert('User updated successfully!'); // Optional: Replace with toast?
                closeModal();
                this.loadUsers();
            } catch (err) {
                alert('Error updating user: ' + err.message);
            }
        };

        this.modalHandlersSetup = true;
    }


    /**
     * Kids accounts' Live TV whitelist: search channels, add/remove. Kept in
     * this.kidsChannels ("sourceId:streamId") until Save.
     */
    initKidsChannelPicker() {
        const input = document.getElementById('kids-channel-search');
        const results = document.getElementById('kids-channel-results');
        if (!input || !results) return;
        this.kidsChannelNames = new Map();
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
                    console.error('[Settings] Channel search failed:', err);
                }
                if (input.value.trim() !== q) return;
                results.innerHTML = found.length ? found.map(ch => {
                    const key = `${ch.sourceId}:${ch.streamId}`;
                    this.kidsChannelNames.set(key, ch.name);
                    const added = (this.kidsChannels || []).includes(key);
                    return `<div class="kids-channel-row">
                        <span class="kids-channel-name">${escapeHtml(ch.name)}<span class="hint"> · ${escapeHtml(ch.groupTitle || '')}</span></span>
                        <button type="button" class="btn btn-sm ${added ? 'btn-ghost' : 'btn-secondary'}" data-add="${escapeHtml(key)}" ${added ? 'disabled' : ''}>${added ? 'Added' : 'Add'}</button>
                    </div>`;
                }).join('') : '<p class="hint">No channels found</p>';
                results.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', () => {
                    if (!this.kidsChannels.includes(btn.dataset.add)) this.kidsChannels.push(btn.dataset.add);
                    btn.textContent = 'Added';
                    btn.disabled = true;
                    this.renderKidsChannels();
                }));
            }, 250);
        });
    }

    async renderKidsChannels() {
        const box = document.getElementById('kids-channels');
        if (!box) return;
        const keys = this.kidsChannels || [];
        if (!keys.length) {
            box.innerHTML = '<p class="hint">No channels yet: Live TV is empty for this profile.</p>';
            return;
        }
        // Names of channels added in an earlier session: look them up
        await Promise.all(keys.filter(k => !this.kidsChannelNames.has(k)).map(async key => {
            const [sourceId, ...rest] = key.split(':');
            try {
                const ch = await API.live.channel(sourceId, rest.join(':'));
                this.kidsChannelNames.set(key, ch.name);
            } catch {
                this.kidsChannelNames.set(key, `Channel ${rest.join(':')} (not in the playlist any more)`);
            }
        }));
        box.innerHTML = keys.map(key => `
            <span class="kids-channel-chip">${escapeHtml(this.kidsChannelNames.get(key) || key)}
                <button type="button" aria-label="Remove" data-remove="${escapeHtml(key)}">&times;</button>
            </span>`).join('');
        box.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => {
            this.kidsChannels = this.kidsChannels.filter(k => k !== btn.dataset.remove);
            this.renderKidsChannels();
        }));
    }

    /**
     * Settings > Title matches: name + year matches to confirm or reject
     * (server/services/media.js). `reset` starts again from the first page.
     */
    async loadMatches(reset = false) {
        const list = document.getElementById('match-list');
        const more = document.getElementById('match-more');
        const count = document.getElementById('match-count');
        if (!list) return;
        if (!this.matchesInit) {
            this.matchesInit = true;
            more?.addEventListener('click', () => this.loadMatches(false));
            document.getElementById('match-confirm-page')?.addEventListener('click', () => {
                const copies = [...list.querySelectorAll('.match-row:not(.is-decided)')].map(row => JSON.parse(row.dataset.copy));
                if (copies.length && confirm(`Confirm all ${copies.length} matches shown?`)) this.decideMatches(copies, 'confirm');
            });
        }
        if (reset) {
            this.matchOffset = 0;
            list.innerHTML = '';
        }
        let res;
        try {
            res = await API.request('GET', `/media/review?offset=${this.matchOffset}&limit=50`);
        } catch (err) {
            list.innerHTML = `<p class="hint">Could not load matches: ${escapeHtml(err.message)}</p>`;
            return;
        }
        this.matchOffset += res.items.length;
        if (count) count.textContent = `${res.total} to review`;
        more?.classList.toggle('hidden', this.matchOffset >= res.total);
        if (!res.items.length && reset) {
            list.innerHTML = '<p class="hint">Nothing to review.</p>';
            return;
        }
        const poster = url => url
            ? `<img src="${escapeHtml(API.imageUrl(url))}" alt="" loading="lazy" data-fallback="/img/poster-placeholder.jpg">`
            : '<img src="/img/poster-placeholder.jpg" alt="">';
        list.insertAdjacentHTML('beforeend', res.items.map(m => {
            const copy = { sourceId: m.source_id, itemType: m.item_type, itemId: m.item_id };
            return `<div class="match-row" data-copy="${escapeHtml(JSON.stringify(copy))}">
                <div class="match-side">${poster(m.copy_icon)}
                    <div><div class="match-name">${escapeHtml(m.copy_name)}</div>
                    <div class="hint">${escapeHtml(m.copy_category || '')}</div></div></div>
                <div class="match-arrow" aria-hidden="true">→</div>
                <div class="match-side">${poster(m.title_icon)}
                    <div><div class="match-name">${escapeHtml(m.title || '')}${m.year ? ` (${m.year})` : ''}</div>
                    <div class="hint">${m.kind === 'tv' ? 'Series' : 'Movie'} · ${escapeHtml(m.genres || 'no genres')} · ${m.title_copies} other cop${m.title_copies === 1 ? 'y' : 'ies'}</div></div></div>
                <div class="match-actions">
                    <button type="button" class="btn btn-sm btn-secondary" data-decide="confirm">Same title</button>
                    <button type="button" class="btn btn-sm btn-ghost" data-decide="reject">Not the same</button>
                </div>
            </div>`;
        }).join(''));
        list.querySelectorAll('.match-row:not([data-bound])').forEach(row => {
            row.dataset.bound = '1';
            row.querySelectorAll('[data-decide]').forEach(btn => btn.addEventListener('click', () =>
                this.decideMatches([JSON.parse(row.dataset.copy)], btn.dataset.decide)));
        });
    }

    async decideMatches(copies, action) {
        try {
            await API.request('POST', '/media/review', { action, copies });
        } catch (err) {
            alert('Could not save: ' + err.message);
            return;
        }
        const keys = new Set(copies.map(c => JSON.stringify(c)));
        document.querySelectorAll('#match-list .match-row').forEach(row => {
            if (!keys.has(row.dataset.copy)) return;
            row.classList.add('is-decided');
            row.querySelector('.match-actions').innerHTML =
                `<span class="hint">${action === 'confirm' ? '✓ Confirmed' : '✕ Kept separate'}</span>`;
        });
    }

    async deleteUser(userId, username) {
        if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
            return;
        }

        try {
            await API.users.delete(userId);
            this.loadUsers();
        } catch (err) {
            alert('Error deleting user: ' + err.message);
        }
    }

    switchTab(tabName) {
        this.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
        this.tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));

        // Load content browser when switching to that tab
        if (tabName === 'content') {
            this.app.sourceManager.loadContentSources();
        }

        // Load users when switching to users tab
        if (tabName === 'users') {
            this.loadUsers();
        }

        if (tabName === 'matches') {
            this.loadMatches(true);
        }

        // Load hardware info when switching to transcode tab
        if (tabName === 'transcode') {
            this.loadHardwareInfo();
        }
    }

    /**
     * Fill the Language Priority dropdown with the languages actually in the
     * playlist (with title counts), then select the saved one
     */
    /**
     * The hard filter needs a language to filter by
     */
    updateHardFilterState() {
        const toggle = document.getElementById('setting-language-hard-filter');
        const select = document.getElementById('setting-language-priority');
        if (!toggle || !select) return;
        toggle.disabled = !select.value;
        toggle.closest('.setting-checkbox')?.classList.toggle('disabled', !select.value);
    }

    async loadLanguageOptions(selected) {
        const select = document.getElementById('setting-language-priority');
        if (!select) return;

        if (!this.languageOptions) {
            try {
                this.languageOptions = await API.request('GET', '/search/languages');
            } catch (err) {
                console.error('Error loading languages:', err);
                this.languageOptions = [];
            }
            select.innerHTML = '<option value="">No preference</option>' +
                this.languageOptions.map(l => {
                    const label = `${l.label} (${l.codes.join(', ')}) - ${l.count.toLocaleString()} titles`;
                    return `<option value="${l.id}">${label}</option>`;
                }).join('');
        }
        select.value = selected;
        if (select.value !== selected) select.value = '';
        this.updateHardFilterState();
    }

    async show() {
        // Show users tab for admin
        if (this.app.currentUser && this.app.currentUser.role === 'admin') {
            const usersTab = document.getElementById('users-tab');
            if (usersTab) {
                usersTab.style.display = 'block';
            }
            const matchesTab = document.getElementById('matches-tab');
            if (matchesTab) matchesTab.style.display = 'block';
        }

        // Load sources when page is shown
        await this.app.sourceManager.loadSources();

        // Refresh ALL player settings from server
        if (this.app.player?.settings) {
            const s = this.app.player.settings;

            // Player settings
            const arrowKeysToggle = document.getElementById('setting-arrow-keys');
            const overlayDurationInput = document.getElementById('setting-overlay-duration');
            const defaultVolumeSlider = document.getElementById('setting-default-volume');
            const volumeValueDisplay = document.getElementById('volume-value');
            const rememberVolumeToggle = document.getElementById('setting-remember-volume');
            const autoPlayNextToggle = document.getElementById('setting-autoplay-next');
            const forceProxyToggle = document.getElementById('setting-force-proxy');
            const forceTranscodeToggle = document.getElementById('setting-force-transcode');
            const forceRemuxToggle = document.getElementById('setting-force-remux');
            const autoTranscodeToggle = document.getElementById('setting-auto-transcode');
            const epgRefreshSelect = document.getElementById('epg-refresh-interval');
            const streamFormatSelect = document.getElementById('setting-stream-format');

            if (arrowKeysToggle) arrowKeysToggle.checked = s.arrowKeysChangeChannel;
            if (overlayDurationInput) overlayDurationInput.value = s.overlayDuration;
            if (defaultVolumeSlider) defaultVolumeSlider.value = s.defaultVolume;
            if (volumeValueDisplay) volumeValueDisplay.textContent = s.defaultVolume + '%';
            if (rememberVolumeToggle) rememberVolumeToggle.checked = s.rememberVolume;
            if (autoPlayNextToggle) autoPlayNextToggle.checked = s.autoPlayNextEpisode;
            if (forceProxyToggle) forceProxyToggle.checked = s.forceProxy || false;
            if (forceTranscodeToggle) forceTranscodeToggle.checked = s.forceTranscode || false;
            if (forceRemuxToggle) forceRemuxToggle.checked = s.forceRemux || false;
            if (autoTranscodeToggle) autoTranscodeToggle.checked = s.autoTranscode || false;
            if (epgRefreshSelect) epgRefreshSelect.value = s.epgRefreshInterval || '24';
            if (streamFormatSelect) streamFormatSelect.value = s.streamFormat || 'm3u8';
            this.loadLanguageOptions(s.languagePriority ?? 'en');
            const hardFilterToggle = document.getElementById('setting-language-hard-filter');
            if (hardFilterToggle) hardFilterToggle.checked = !!s.languageHardFilter;
            this.updateHardFilterState();

            // User-Agent settings
            const userAgentSelect = document.getElementById('setting-user-agent');
            const userAgentCustomInput = document.getElementById('setting-user-agent-custom');
            const customUaContainer = document.getElementById('custom-user-agent-container');
            if (userAgentSelect) {
                userAgentSelect.value = s.userAgentPreset || 'chrome';
                if (customUaContainer) {
                    customUaContainer.style.display = userAgentSelect.value === 'custom' ? 'flex' : 'none';
                }
            }
            if (userAgentCustomInput) userAgentCustomInput.value = s.userAgentCustom || '';
        }

        // Update EPG last refreshed display
        this.updateEpgLastRefreshed();
    }

    /**
     * Update the EPG last refreshed display
     */
    async updateEpgLastRefreshed() {
        const display = document.getElementById('epg-last-refreshed');
        if (!display) return;

        try {
            // Fetch last sync time from server
            const response = await fetch('/api/settings/sync-status');
            if (!response.ok) throw new Error('Failed to fetch sync status');
            const data = await response.json();

            if (data.lastSyncTime) {
                const lastRefreshTime = new Date(data.lastSyncTime);

                // Format as relative time or absolute
                const now = new Date();
                const diffMs = now - lastRefreshTime;
                const diffMins = Math.floor(diffMs / 60000);
                const diffHours = Math.floor(diffMins / 60);

                let text;
                if (diffMins < 1) {
                    text = 'Just now';
                } else if (diffMins < 60) {
                    text = `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
                } else if (diffHours < 24) {
                    text = `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
                } else {
                    // Use absolute time for older refreshes
                    text = lastRefreshTime.toLocaleString();
                }

                display.textContent = text;
                display.title = lastRefreshTime.toLocaleString(); // Full timestamp on hover
            } else {
                display.textContent = 'Never';
                display.title = 'Sync has not run yet since server started';
            }
        } catch (err) {
            console.error('Error fetching sync status:', err);
            display.textContent = 'Unknown';
            display.title = 'Could not fetch sync status';
        }
    }

    hide() {
        // Page is hidden
    }
}

window.SettingsPage = SettingsPage;
