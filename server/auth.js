const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const { Strategy: LocalStrategy } = require('passport-local');
const { sessionUser } = require('./services/profiles');

/**
 * Authentication and Authorization Module
 * Handles user authentication, session management, and role-based access control
 * Using Passport.js with JWT tokens
 */

// JWT Secret: required. A built-in fallback would let anyone who has read
// this file forge a login, so the server refuses to start without one.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('JWT_SECRET is missing or shorter than 32 characters. Set it in .env, e.g.:');
    console.error('  echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env');
    process.exit(1);
}
const JWT_EXPIRY = '24h';

// The JWT is also carried in an httpOnly cookie so that requests the browser
// makes on its own (<img>, <video>, HLS segments) authenticate too - they
// cannot send an Authorization header.
const AUTH_COOKIE = 'nodecast_token';
const AUTH_COOKIE_MAX_AGE = 24 * 60 * 60 * 1000; // matches JWT_EXPIRY

// Minimum length for new passwords (setup, user create/update)
const MIN_PASSWORD_LENGTH = 10;

// Compared against when the username doesn't exist, so a wrong username takes
// as long as a wrong password and response times don't reveal valid names
const DUMMY_HASH = bcrypt.hashSync('fleurbox-no-such-user', 10);

/**
 * Hash password using bcrypt
 */
async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
}

/**
 * Verify password against hash
 */
async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

/**
 * Generate JWT token. For a profile (services/profiles.js) pass its account:
 * atv ties the token to the login, so a new password ends the profiles too.
 */
function generateToken(user, account = null) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            role: user.role,
            // jti: this token, so logout can revoke it; tv: bumped on password /
            // role change, which ends every older token of the user
            jti: crypto.randomUUID(),
            tv: user.tokenVersion || 0,
            ...(user.parentId ? { atv: account?.tokenVersion || 0 } : {})
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

/**
 * Read the JWT from the auth cookie (no cookie-parser dependency)
 */
function tokenFromCookie(req) {
    const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
    return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Set / clear the auth cookie. Scoped to /api so it is only sent where needed.
 */
function setAuthCookie(req, res, token) {
    res.cookie(AUTH_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        path: '/api',
        maxAge: AUTH_COOKIE_MAX_AGE
    });
}

/** The request's JWT (Authorization header or cookie), unverified, or null */
function tokenFromRequest(req) {
    const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    return bearer ? bearer[1] : tokenFromCookie(req);
}

function clearAuthCookie(res) {
    res.clearCookie(AUTH_COOKIE, { path: '/api' });
}

/**
 * Configure Passport Local Strategy for username/password authentication
 */
function configureLocalStrategy(getUserByUsername, verifyUserPassword) {
    passport.use(new LocalStrategy(
        async (username, password, done) => {
            try {
                const user = await getUserByUsername(username);

                // Always run bcrypt (see DUMMY_HASH); SSO users have no password
                const isValid = await verifyUserPassword(password, user?.passwordHash || DUMMY_HASH);

                if (!user || !user.passwordHash || !isValid) {
                    return done(null, false, { message: 'Invalid credentials' });
                }

                return done(null, user);
            } catch (err) {
                return done(err);
            }
        }
    ));
}

/**
 * Configure Passport JWT Strategy for token-based authentication
 */
function configureJwtStrategy(getUserById, isRevoked) {
    const options = {
        jwtFromRequest: ExtractJwt.fromExtractors([
            ExtractJwt.fromAuthHeaderAsBearerToken(),
            tokenFromCookie
        ]),
        secretOrKey: JWT_SECRET
    };

    passport.use(new JwtStrategy(options, async (payload, done) => {
        try {
            const user = await getUserById(payload.id);

            if (!user || (payload.tv || 0) !== (user.tokenVersion || 0) || await isRevoked(payload.jti)) {
                return done(null, false);
            }
            // A profile works while its login does
            const parent = user.parentId ? await getUserById(user.parentId) : null;
            if (user.parentId && (!parent || (payload.atv || 0) !== (parent.tokenVersion || 0))) {
                return done(null, false);
            }

            return done(null, sessionUser(user, parent));
        } catch (err) {
            return done(err, false);
        }
    }));
}

/**
 * Configure Passport session serialization
 * Required for OIDC flow which uses sessions
 */
function configureSessionSerialization(getUserById) {
    passport.serializeUser((user, done) => {
        done(null, user.id);
    });

    passport.deserializeUser(async (id, done) => {
        try {
            const user = await getUserById(id);
            done(null, user);
        } catch (err) {
            done(err, null);
        }
    });
}

/**
 * Configure Passport OpenID Connect Strategy
 */
function configureOidcStrategy(findUserByOidcId, findUserByEmail, createUser) {
    if (!process.env.OIDC_ISSUER_URL || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
        console.warn('OIDC configuration missing - SSO disabled');
        return;
    }

    const { Strategy: OpenIDConnectStrategy } = require('passport-openidconnect');

    passport.use(new OpenIDConnectStrategy({
        issuer: process.env.OIDC_ISSUER_URL,
        authorizationURL: process.env.OIDC_AUTH_URL || `${process.env.OIDC_ISSUER_URL}/protocol/openid-connect/auth`,
        tokenURL: process.env.OIDC_TOKEN_URL || `${process.env.OIDC_ISSUER_URL}/protocol/openid-connect/token`,
        userInfoURL: process.env.OIDC_USERINFO_URL || `${process.env.OIDC_ISSUER_URL}/protocol/openid-connect/userinfo`,
        clientID: process.env.OIDC_CLIENT_ID,
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        callbackURL: process.env.OIDC_CALLBACK_URL || '/api/auth/oidc/callback',
        scope: ['openid', 'profile', 'email']
    },
        async (...args) => {
            // The done callback is always the last argument
            const done = args[args.length - 1];

            // Map known arguments
            // Standard: issuer, sub, profile, accessToken, refreshToken, done
            // Some versions: issuer, sub, profile, accessToken, refreshToken, params, done

            let issuer, sub, profile;

            if (args.length === 3) {
                // Scenario: (issuer, profile, done)
                const arg0 = args[0];
                const arg1 = args[1];

                if (typeof arg1 === 'object' && arg1.id) {
                    issuer = arg0;
                    profile = arg1;
                    sub = profile.id;
                } else if (typeof arg0 === 'string' && typeof arg1 === 'string') {
                    issuer = arg0;
                    sub = arg1;
                    profile = { id: sub, displayName: 'Unknown' };
                }
            } else if (args.length >= 4) {
                // Assume standard: iss, sub, profile...
                issuer = args[0];
                sub = args[1];
                profile = args[2];
            }

            if (!sub && profile && profile.id) sub = profile.id;

            if (!sub) {
                return done(new Error('Could not identify OIDC Subject (sub) from arguments'));
            }

            try {
                // 1. Try to find by OIDC ID (sub)
                let user = await findUserByOidcId(sub);

                // 2. If not found, try to match by email
                // Extract email - handle both profile.emails[] (Google) and profile.email (others)
                const email = profile.emails?.[0]?.value || profile.email || profile._json?.email;
                // Only an address the identity provider has verified may log in
                // as an existing account - otherwise anyone who can register
                // that address at the provider would get the account
                const emailVerified = profile._json?.email_verified === true || profile._json?.email_verified === 'true';

                if (!user && email && emailVerified) {
                    user = await findUserByEmail(email);

                    // If found by email but no OIDC ID, link them
                    if (user && !user.oidcId) {
                        // We don't have a direct update method for specific fields without full user object in this context
                        // Ideally we'd update the user here. For now, we'll just log in.
                        // Future: Update user with oidcId
                    }
                }

                // 3. If still not found, create a viewer account - only when
                // OIDC_AUTO_CREATE_USERS=true; otherwise an admin adds users first
                if (!user && process.env.OIDC_AUTO_CREATE_USERS !== 'true') {
                    return done(null, false, { message: 'No Fleurbox account for this login' });
                }
                if (!user) {
                    const username = profile.username || profile.displayName || (email ? email.split('@')[0] : `user_${sub.substring(0, 8)}`);

                    user = await createUser({
                        username: username,
                        role: 'viewer', // Default role for SSO users
                        oidcId: sub,
                        email: email || null
                    });
                }

                return done(null, user);
            } catch (err) {
                return done(err);
            }
        }));
}

/**
 * Middleware: Require authentication using Passport JWT
 */
const requireAuth = passport.authenticate('jwt', { session: false });

/**
 * Middleware: Require admin role
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden - Admin access required' });
    }
    next();
}

/**
 * Middleware: Check for specific role
 */
function requireRole(role) {
    return (req, res, next) => {
        if (!req.user || req.user.role !== role) {
            return res.status(403).json({ error: `Forbidden - ${role} access required` });
        }
        next();
    };
}

module.exports = {
    passport,
    hashPassword,
    verifyPassword,
    generateToken,
    verifyToken,
    configureLocalStrategy,
    configureJwtStrategy,
    configureSessionSerialization,
    configureOidcStrategy,
    requireAuth,
    requireAdmin,
    setAuthCookie,
    clearAuthCookie,
    tokenFromRequest,
    MIN_PASSWORD_LENGTH,
    requireRole
};
