const express = require('express');
require('dotenv').config();
const path = require('path');
const passport = require('passport');
const syncService = require('./services/syncService');

// Initialize database
require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Proxy headers (X-Forwarded-For/-Proto) are trusted only from the proxies
// named in TRUST_PROXY (Express syntax, e.g. "loopback" or "172.16.0.0/12"
// for `tailscale serve` reaching the container through the Docker bridge).
// Trusting everyone would let any client fake its IP and dodge the login
// rate limit. Unset = no proxy in front.
app.set('trust proxy', process.env.TRUST_PROXY || false);

// Middleware
app.use(express.json({ limit: '50mb' }));

// Initialize Passport
const session = require('express-session');
app.use(session({
    secret: process.env.JWT_SECRET,
    resave: false,
    // Only the OIDC login flow stores anything in a session; don't create
    // (and keep in memory forever) one for every visitor
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// Content-Security-Policy for the app's pages: scripts only from this site
// and the pinned hls.js on jsdelivr - no inline scripts or on*="" handlers -
// so text that slips into the page unescaped cannot run as code. Images,
// media and fetches may go anywhere: streams play straight from providers.
const APP_CSP = [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src * data: blob:",
    "media-src * data: blob:",
    "connect-src *",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
].join('; ');
app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) {
        res.set('Content-Security-Policy', APP_CSP);
        res.set('X-Content-Type-Options', 'nosniff');
    }
    next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// FFMPEG Configuration (optional - for transcoding support)
// Priority: 1. System FFmpeg (better Docker DNS support), 2. ffmpeg-static npm package
const { execSync } = require('child_process');

function findFFmpeg() {
    // Try system FFmpeg first (better Docker compatibility)
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        console.log('FFmpeg binary configured at: ffmpeg (system)');
        return 'ffmpeg';
    } catch (e) {
        // System FFmpeg not found, try ffmpeg-static
    }

    // Try ffmpeg-static npm package
    try {
        let ffmpegPath = require('ffmpeg-static');
        // In packaged Electron apps, ffmpeg-static returns path inside .asar archive
        // but the binary is actually unpacked to app.asar.unpacked
        if (ffmpegPath && ffmpegPath.includes('app.asar')) {
            ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
        }
        console.log('FFmpeg binary configured at:', ffmpegPath);
        return ffmpegPath;
    } catch (err) {
        console.warn('FFmpeg not available - transcoding/remuxing will be disabled.');
        console.warn('Install FFmpeg via your package manager or npm install ffmpeg-static');
        return null;
    }
}

function findFFprobe() {
    // Try system ffprobe first
    try {
        execSync('ffprobe -version', { stdio: 'ignore' });
        console.log('FFprobe binary configured at: ffprobe (system)');
        return 'ffprobe';
    } catch (e) {
        // Not found in system
    }

    // Try @ffprobe-installer/ffprobe package
    try {
        const ffprobePath = require('@ffprobe-installer/ffprobe').path;
        if (ffprobePath) {
            console.log('FFprobe binary configured at:', ffprobePath);
            return ffprobePath;
        }
    } catch (err) {
        // Package not available
    }

    console.warn('FFprobe not available - auto transcode will fallback to always transcode');
    return null;
}

app.locals.ffmpegPath = findFFmpeg();
app.locals.ffprobePath = findFFprobe();

// Dynamic services loader - collects exports from files in ./services
const fs = require('fs');
const services = {};
try {
    const servicesDir = path.join(__dirname, 'services');
    const serviceFiles = fs.readdirSync(servicesDir).filter(f => f.endsWith('.js'));
    for (const file of serviceFiles) {
        const name = file.replace(/\.js$/, '');
        try {
            services[name] = require(path.join(servicesDir, file));
        } catch (e) {
            console.warn(`Failed to load service ${file}:`, e.message);
        }
    }
} catch (e) {
    console.warn('No services directory found or failed to read services:', e.message);
}

// Freeze services object to prevent plugins from mutating shared state
Object.freeze(services);

// Plugin loader: loads any .js file inside server/plugins and calls the
// exported function with (app, services).
// Supports both function exports and object exports with lifecycle hooks.
const loadedPlugins = [];

async function loadPlugins() {
    try {
        const pluginsDir = path.join(__dirname, 'plugins');
        if (fs.existsSync(pluginsDir)) {
            // Sort plugin files alphabetically for deterministic load order
            const pluginFiles = fs.readdirSync(pluginsDir)
                .filter(f => f.endsWith('.js'))
                .sort();

            for (const file of pluginFiles) {
                const pluginPath = path.join(pluginsDir, file);
                try {
                    const plugin = require(pluginPath);

                    // Support both function exports and object exports with lifecycle hooks
                    if (typeof plugin === 'function') {
                        // Direct function export (sync or async)
                        await plugin(app, services);
                        loadedPlugins.push({ name: file, plugin: null });
                        console.log(`✓ Loaded plugin: ${file}`);
                    } else if (plugin && typeof plugin.init === 'function') {
                        // Object export with init/shutdown lifecycle
                        await plugin.init(app, services);
                        loadedPlugins.push({ name: file, plugin });
                        console.log(`✓ Loaded plugin: ${file} (with lifecycle hooks)`);
                    } else {
                        console.warn(`⚠ Plugin ${file} does not export a function or object with init(), skipping.`);
                    }
                } catch (err) {
                    console.error(`✗ Failed to load plugin ${file}:`, err);
                }
            }
        }
    } catch (err) {
        console.warn('Plugin loader failed:', err.message);
    }
}

// Graceful shutdown handler for plugins with shutdown hooks
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down plugins...');
    for (const { name, plugin } of loadedPlugins) {
        if (plugin && typeof plugin.shutdown === 'function') {
            try {
                await plugin.shutdown();
                console.log(`✓ Shutdown plugin: ${name}`);
            } catch (err) {
                console.error(`✗ Error shutting down plugin ${name}:`, err);
            }
        }
    }
    process.exit(0);
});

// API Routes
// API responses are data, never pages: stop browsers guessing a type
// ("sniffing") and treating a mislabelled response as HTML or script
app.use('/api', (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
});

// The login is a cookie, which the browser also sends when another site
// (or another port on this host) submits a form or fetch to us. Changes
// (anything but GET/HEAD/OPTIONS) must come from a page on this origin.
app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next(); // not sent by a browser page (curl, server-to-server)
    let originHost;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    const hosts = [req.get('host')];
    if (process.env.TRUST_PROXY && req.get('x-forwarded-host')) hosts.push(req.get('x-forwarded-host'));
    if (originHost && hosts.includes(originHost)) return next();
    res.status(403).json({ error: 'Cross-site request refused' });
});
app.use('/api/auth', require('./routes/auth'));

// Everything else under /api requires a valid token. /api/auth handles its own
// auth (login/setup must stay public). Mounted after /api/auth so the JWT
// strategy is configured by the time this runs.
const { requireAuth } = require('./auth');
app.use('/api', (req, res, next) => {
    if (req.path === '/version') return next();
    // Sealed stream links carry their own authorisation (services/streamRef.js)
    if (req.path.startsWith('/stream/s/')) return next();
    return requireAuth(req, res, next);
});

// Kids accounts: Live TV plays only channels a parent whitelisted for them
// (services/maturity.js allowedChannels); the lists themselves are filtered
// in routes/live.js and the proxy. Movies/series are filtered per route.
const LIVE_STREAM = [
    /^\/stream\/x\/(\d+)\/live\/([A-Za-z0-9_-]+)\./,              // stream reference
    /^\/proxy\/xtream\/(\d+)\/stream\/([A-Za-z0-9_-]+)\/live$/     // getStreamUrl
];
app.use('/api', (req, res, next) => {
    const allowed = require('./services/maturity').allowedChannels(req.user);
    if (!allowed) return next();
    for (const re of LIVE_STREAM) {
        const m = re.exec(req.path);
        if (m && !allowed.has(`${m[1]}:${m[2]}`)) {
            return res.status(403).json({ error: 'This channel is not enabled for this profile' });
        }
    }
    // Probe/remux/transcode/subtitles take a reference in ?url= / body.url
    const ref = String(req.query.url ?? req.body?.url ?? '');
    const m = LIVE_STREAM[0].exec(ref.replace(/^\/api/, ''));
    if (m && !allowed.has(`${m[1]}:${m[2]}`)) {
        return res.status(403).json({ error: 'This channel is not enabled for this profile' });
    }
    next();
});

app.use('/api/sources', require('./routes/sources'));
app.use('/api/proxy', require('./routes/proxy'));
app.use('/api/stream', require('./routes/stream'));
app.use('/api/media', require('./routes/media'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/live', require('./routes/live'));
app.use('/api/favorites', require('./routes/favorites'));
app.use('/api/transcode', require('./routes/transcode'));
app.use('/api/remux', require('./routes/remux'));
app.use('/api/probe', require('./routes/probe'));
app.use('/api/subtitle', require('./routes/subtitle'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/history', require('./routes/history'));
app.use('/api/home', require('./routes/home'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/tmdb', require('./routes/tmdb'));
app.use('/api/search', require('./routes/search'));
app.use('/api/details', require('./routes/details'));

// Version endpoint
app.get('/api/version', (req, res) => {
    const pkg = require('../package.json');
    res.json({ version: pkg.version });
});

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, async () => {
    console.log(`Fleurbox server running on http://localhost:${PORT}`);

    // Build the search index on first run (later rebuilds follow syncs / TMDB progress)
    try {
        const searchIndex = require('./services/searchIndex');
        if (!searchIndex.exists()) searchIndex.rebuild('initial');
    } catch (err) {
        console.error('[Search] Initial index check failed:', err);
    }

    // Resume a TMDB backfill that a restart interrupted
    try {
        require('./services/tmdbSync').resumeIfInterrupted();
        require('./services/tmdbTrending').start();
        require('./services/tmdbPopularity').start();
    } catch (err) {
        console.error('[TMDB] Resume check failed:', err);
    }

    // Recommendations: library links to TMDB titles, maturity levels
    try {
        require('./services/recommend').start();
    } catch (err) {
        console.error('[Recommend] Start failed:', err);
    }

    // Sports fixtures for Live Events (ESPN, no key needed)
    try {
        require('./services/liveEvents').start();
    } catch (err) {
        console.error('[Events] Start failed:', err);
    }

    // Load plugins
    await loadPlugins().catch(err => {
        console.error('Plugin initialization failed:', err);
    });

    // Trigger background sync with delay to allow server to settle
    setTimeout(async () => {
        await syncService.syncAll().catch(console.error);
        // Start the server-side sync timer after initial sync
        await syncService.startSyncTimer().catch(console.error);

        // Detect hardware acceleration capabilities
        try {
            const hwDetect = require('./services/hwDetect');
            await hwDetect.detect();
        } catch (err) {
            console.warn('Hardware detection failed:', err.message);
        }
    }, 5000);
});
