const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../auth');
const crypto = require('crypto');
const maturity = require('../services/maturity');

/**
 * Kids account fields from a create/update body: { kids, maxMaturity } or an
 * error message. Kids accounts are never admins.
 */
function kidsFields(body, role, current = null) {
    if (body.kids === undefined && body.maxMaturity === undefined) {
        return role === 'admin' && current?.kids ? { error: 'A kids account cannot be an admin' } : {};
    }
    const kids = !!body.kids;
    if (kids && role === 'admin') return { error: 'A kids account cannot be an admin' };
    const level = parseInt(body.maxMaturity, 10);
    const maxMaturity = kids ? (maturity.LEVELS.some(l => l.id === level) ? level : maturity.DEFAULT_KIDS_LEVEL) : null;
    return { kids, maxMaturity };
}

// Configure Passport strategies
auth.configureLocalStrategy(
    async (username) => await db.users.getByUsername(username),
    async (password, hash) => await auth.verifyPassword(password, hash)
);

auth.configureJwtStrategy(
    async (id) => await db.users.getById(id),
    async (jti) => await db.revokedTokens.has(jti)
);

// Configure Passport session serialization (required for OIDC)
auth.configureSessionSerialization(
    async (id) => await db.users.getById(id)
);

// Configure OIDC Strategy
auth.configureOidcStrategy(
    async (oidcId) => await db.users.getByOidcId(oidcId),
    async (email) => await db.users.getByEmail(email),
    async (userData) => await db.users.create(userData)
);

/**
 * Start OIDC Login
 * GET /api/auth/oidc/login
 */
router.get('/oidc/login', auth.passport.authenticate('openidconnect'));

/**
 * OIDC Callback
 * GET /api/auth/oidc/callback
 */
router.get('/oidc/callback',
    auth.passport.authenticate('openidconnect', { session: false, failureRedirect: '/login.html?error=SSO+Failed' }),
    (req, res) => {
        // Successful authentication
        const token = auth.generateToken(req.user);
        auth.setAuthCookie(req, res, token);

        // The cookie carries the login; never put the token in a URL (history, logs)
        res.redirect('/');
    }
);

/**
 * Login rate limit: after LOGIN_MAX_FAILURES failed attempts within
 * LOGIN_WINDOW_MS - per client IP, and separately per username (so spreading
 * guesses over many IPs doesn't help) - further attempts get 429 until the
 * window has passed. A successful login clears that IP's and username's count.
 *
 * The per-username count would let anyone lock a user out by failing on
 * purpose, so a browser that has logged in as that user before (it holds a
 * signed "known device" cookie) is not counted with everyone else: it gets its
 * own count instead. In memory: a restart clears every count.
 */
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // 'ip:<ip>' | 'user:<name>' | 'device:<sig>' -> [timestamps]

const DEVICE_COOKIE = 'fleurbox_device';
const DEVICE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;

function deviceSignature(name, issued) {
    return crypto.createHmac('sha256', `fleurbox-device:${process.env.JWT_SECRET}`)
        .update(`${name}\n${issued}`).digest('base64url');
}

/** Remember this browser as one that logged in as `name` */
function setDeviceCookie(req, res, name) {
    const issued = Date.now();
    const value = `${Buffer.from(name).toString('base64url')}.${issued}.${deviceSignature(name, issued)}`;
    res.cookie(DEVICE_COOKIE, value, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        path: '/api/auth',
        maxAge: DEVICE_MAX_AGE
    });
}

/** The signature of a valid known-device cookie for `name`, or null */
function knownDevice(req, name) {
    const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([^;]+)`));
    if (!match) return null;
    const [encName, issued, sig] = decodeURIComponent(match[1]).split('.');
    if (!sig || Buffer.from(encName || '', 'base64url').toString() !== name) return null;
    if (!(Date.now() - Number(issued) < DEVICE_MAX_AGE)) return null;
    const expected = deviceSignature(name, issued);
    return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)) ? sig : null;
}

function recentFailures(key) {
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    const times = (loginFailures.get(key) || []).filter(t => t > cutoff);
    if (times.length) loginFailures.set(key, times); else loginFailures.delete(key);
    return times;
}

function loginName(req) {
    return String(req.body?.username || '').trim().toLowerCase();
}

function loginKeys(req) {
    const name = loginName(req);
    if (!name) return [`ip:${req.ip}`];
    const device = knownDevice(req, name);
    return [`ip:${req.ip}`, device ? `device:${device}` : `user:${name}`];
}

function loginLimit(req, res, next) {
    for (const key of loginKeys(req)) {
        const times = recentFailures(key);
        if (times.length >= LOGIN_MAX_FAILURES) {
            const retryAfter = Math.ceil((times[0] + LOGIN_WINDOW_MS - Date.now()) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} min.` });
        }
    }
    next();
}

function recordLoginFailure(req) {
    for (const key of loginKeys(req)) {
        loginFailures.set(key, [...recentFailures(key), Date.now()]);
    }
}

function clearLoginFailures(req) {
    // The right password: whatever was counted against this user is moot
    loginKeys(req).forEach(key => loginFailures.delete(key));
    if (loginName(req)) loginFailures.delete(`user:${loginName(req)}`);
}

// Forget idle entries so the map can't grow without bound
setInterval(() => [...loginFailures.keys()].forEach(recentFailures), LOGIN_WINDOW_MS).unref();

/**
 * Check if initial setup is required
 * GET /api/auth/setup-required
 */
router.get('/setup-required', async (req, res) => {
    try {
        const userCount = await db.users.count();
        res.json({ setupRequired: userCount === 0 });
    } catch (err) {
        console.error('Error in /setup-required:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Initial setup - Create admin user
 * POST /api/auth/setup
 */
router.post('/setup', loginLimit, async (req, res) => {
    try {
        const userCount = await db.users.count();

        // Check if setup already done
        if (userCount > 0) {
            recordLoginFailure(req);
            return res.status(400).json({ error: 'Setup already completed' });
        }

        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        if (password.length < auth.MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ error: `Password must be at least ${auth.MIN_PASSWORD_LENGTH} characters` });
        }

        // Create admin user
        const passwordHash = await auth.hashPassword(password);
        const adminUser = await db.users.create({
            username,
            passwordHash,
            role: 'admin'
        });

        // Generate token for immediate login
        const token = auth.generateToken(adminUser);
        auth.setAuthCookie(req, res, token);

        res.status(201).json({
            message: 'Admin user created successfully',
            user: adminUser
        });
    } catch (err) {
        console.error('Error in /setup:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Login with Passport Local Strategy
 * POST /api/auth/login
 */
router.post('/login', loginLimit, (req, res, next) => {
    auth.passport.authenticate('local', { session: false }, (err, user, info) => {
        if (err) {
            console.error('Login error:', err);
            return res.status(500).json({ error: 'Server error' });
        }

        if (!user) {
            recordLoginFailure(req);
            return res.status(401).json({ error: info?.message || 'Invalid credentials' });
        }
        clearLoginFailures(req);
        setDeviceCookie(req, res, loginName(req));

        // Generate JWT token
        const token = auth.generateToken(user);
        auth.setAuthCookie(req, res, token);

        res.json({
            user: {
                id: user.id,
                username: user.username,
                role: user.role
            }
        });
    })(req, res, next);
});

/**
 * Logout: the token stops working here and now (not just in this browser)
 * POST /api/auth/logout
 */
router.post('/logout', async (req, res) => {
    const payload = auth.verifyToken(auth.tokenFromRequest(req));
    if (payload?.jti) {
        try {
            await db.revokedTokens.add(payload.jti, payload.exp);
        } catch (err) {
            console.error('Error revoking token:', err);
        }
    }
    auth.clearAuthCookie(res);
    res.json({ success: true, message: 'Logged out successfully' });
});

/**
 * Get current user
 * GET /api/auth/me
 */
router.get('/me', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Sessions that predate the auth cookie only hold the Bearer token -
        // mirror it into the cookie so media requests authenticate too
        const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/);
        if (bearer) auth.setAuthCookie(req, res, bearer[1]);

        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            kids: !!user.kids,
            maxMaturity: maturity.limitFor(user)
        });
    } catch (err) {
        console.error('Error in /me:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Get all users (admin only)
 * GET /api/auth/users
 */
router.get('/users', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const allUsers = await db.users.getAll();

        // Remove password hashes
        const users = allUsers.map(u => {
            const { passwordHash, ...userWithoutPassword } = u;
            return userWithoutPassword;
        });

        res.json(users);
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Create a new user (admin only)
 * POST /api/auth/users
 */
router.post('/users', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { username, password, role } = req.body;

        if (!username || !password || !role) {
            return res.status(400).json({ error: 'Username, password, and role are required' });
        }

        if (password.length < auth.MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ error: `Password must be at least ${auth.MIN_PASSWORD_LENGTH} characters` });
        }

        if (!['admin', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'Role must be either "admin" or "viewer"' });
        }

        const kids = kidsFields(req.body, role);
        if (kids.error) return res.status(400).json({ error: kids.error });

        const passwordHash = await auth.hashPassword(password);
        const newUser = await db.users.create({
            username,
            passwordHash,
            role,
            ...kids
        });

        res.status(201).json(newUser);
    } catch (err) {
        console.error('Error creating user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Update a user (admin only)
 * PUT /api/auth/users/:id
 */
router.put('/users/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { username, password, role } = req.body;

        const updates = {};

        if (username) {
            updates.username = username;
        }

        if (password) {
            if (password.length < auth.MIN_PASSWORD_LENGTH) {
                return res.status(400).json({ error: `Password must be at least ${auth.MIN_PASSWORD_LENGTH} characters` });
            }
            updates.passwordHash = await auth.hashPassword(password);
        }

        // A new password or a changed role ends the user's existing logins (the
        // edit dialog always sends the role, so only an actual change counts)
        const before = await db.users.getById(id);
        if (password || (role && role !== before?.role)) {
            updates.tokenVersion = (before?.tokenVersion || 0) + 1;
        }

        if (role) {
            if (!['admin', 'viewer'].includes(role)) {
                return res.status(400).json({ error: 'Role must be either "admin" or "viewer"' });
            }

            // Prevent removing admin role from the last admin
            const user = await db.users.getById(id);
            if (user && user.role === 'admin' && role !== 'admin') {
                const allUsers = await db.users.getAll();
                const adminCount = allUsers.filter(u => u.role === 'admin').length;
                if (adminCount <= 1) {
                    return res.status(400).json({ error: 'Cannot remove admin role from the last admin user' });
                }
            }

            updates.role = role;
        }

        const current = await db.users.getById(id);
        const kids = kidsFields(req.body, role || current?.role, current);
        if (kids.error) return res.status(400).json({ error: kids.error });
        Object.assign(updates, kids);
        // Kids accounts' Live TV whitelist: "sourceId:itemId" channel keys
        if (Array.isArray(req.body.allowedChannels)) {
            updates.allowedChannels = [...new Set(req.body.allowedChannels.map(String)
                .filter(k => /^\d+:[A-Za-z0-9_.:-]{1,64}$/.test(k)))].slice(0, 2000);
        }

        const updatedUser = await db.users.update(id, updates);
        res.json(updatedUser);
    } catch (err) {
        console.error('Error updating user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Delete a user (admin only)
 * DELETE /api/auth/users/:id
 */
router.delete('/users/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent deleting yourself
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        await db.users.delete(id);
        res.json({ success: true, message: 'User deleted successfully' });
    } catch (err) {
        console.error('Error deleting user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

module.exports = router;
