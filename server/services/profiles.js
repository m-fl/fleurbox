/**
 * Profiles: one login (the account) with up to MAX_PROFILES people on it,
 * Netflix style. A profile is a user row with parentId = the account's id and
 * no password of its own, so it can never log in by itself; the account's own
 * row is its main profile. History, favourites, taste and appearance stay per
 * profile because they are keyed on the user id. The provider login
 * (services/directPlay.js) belongs to the account and every profile plays on it.
 *
 * Only the main profile manages profiles (add / edit / remove, kids limits,
 * PINs). A PIN locks a profile: switching to it asks for the 4 digits.
 * Profiles are 'viewer' role whatever the account is (admin stays on the main
 * profile), but an admin account's profiles may use the server's own sources.
 */
const crypto = require('crypto');

const MAX_PROFILES = 5; // the main profile included
const AVATARS = 8;      // colours, public/js/components/Profiles.js
const PIN_MAX_FAILURES = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000;
const pinFailures = new Map(); // accountId -> [timestamps]

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * What the server knows about the signed-in user on each request (req.user),
 * from the user row and, for a profile, its account's row.
 */
function sessionUser(user, parent = null) {
    return {
        id: user.id,
        username: user.username,
        name: user.profileName || user.username,
        role: user.role,
        // signs stream links (services/streamRef.js), so they end with the logins
        tokenVersion: user.tokenVersion || 0,
        // kids profiles (services/maturity.js)
        kids: !!user.kids,
        maxMaturity: user.maxMaturity ?? null,
        allowedChannels: user.allowedChannels || [],
        parentId: user.parentId || null,
        accountId: user.parentId || user.id,
        accountRole: parent ? parent.role : user.role,
        isOwner: !user.parentId
    };
}

function avatarOf(user) {
    return Number.isInteger(user.avatar) && user.avatar >= 0 && user.avatar < AVATARS ? user.avatar : user.id % AVATARS;
}

function publicProfile(user, viewer) {
    return {
        id: user.id,
        name: user.profileName || user.username,
        avatar: avatarOf(user),
        main: !user.parentId,
        current: user.id === viewer.id,
        kids: !!user.kids,
        maxMaturity: user.kids ? (user.maxMaturity ?? null) : null,
        locked: !!user.pinHash,
        // the whitelist is the main profile's to see and change
        ...(viewer.isOwner && user.kids ? { allowedChannels: user.allowedChannels || [] } : {})
    };
}

/** The account's rows: [main, ...profiles] */
async function accountRows(accountId) {
    const { users } = require('../db');
    const all = await users.getAll();
    const main = all.find(u => u.id === accountId && !u.parentId);
    if (!main) throw fail(404, 'Account not found');
    return [main, ...all.filter(u => u.parentId === accountId).sort((a, b) => a.id - b.id)];
}

async function list(viewer) {
    const rows = await accountRows(viewer.accountId);
    return {
        isOwner: viewer.isOwner,
        max: MAX_PROFILES,
        avatars: AVATARS,
        profiles: rows.map(u => publicProfile(u, viewer))
    };
}

function assertOwner(viewer) {
    if (!viewer.isOwner || viewer.kids) throw fail(403, 'Only the main profile can change profiles');
}

/** Row fields from a create / update body (only the ones it has) */
async function fields(body, row, rows) {
    const main = row ? !row.parentId : false;
    const out = {};
    if (body.name !== undefined || !row) {
        const name = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
        if (!name) throw fail(400, 'Enter a name');
        if (rows.some(u => u.id !== row?.id && (u.profileName || u.username).toLowerCase() === name.toLowerCase())) {
            throw fail(400, 'Another profile already has that name');
        }
        out.profileName = name;
    }
    if (body.avatar !== undefined) {
        const avatar = parseInt(body.avatar, 10);
        if (!(avatar >= 0 && avatar < AVATARS)) throw fail(400, 'Invalid picture');
        out.avatar = avatar;
    }
    if (body.kids !== undefined || body.maxMaturity !== undefined) {
        if (main) {
            if (body.kids) throw fail(400, 'The main profile cannot be a kids profile');
        } else {
            const maturity = require('./maturity');
            const kids = body.kids !== undefined ? !!body.kids : !!row?.kids;
            const level = parseInt(body.maxMaturity ?? row?.maxMaturity, 10);
            out.kids = kids;
            out.maxMaturity = kids ? (maturity.LEVELS.some(l => l.id === level) ? level : maturity.DEFAULT_KIDS_LEVEL) : null;
        }
    }
    // Kids profiles' Live TV whitelist: "sourceId:itemId" channel keys
    if (Array.isArray(body.allowedChannels) && !main) {
        out.allowedChannels = [...new Set(body.allowedChannels.map(String)
            .filter(k => /^\d+:[A-Za-z0-9_.:-]{1,64}$/.test(k)))].slice(0, 2000);
    }
    if (body.pin !== undefined) {
        if (body.pin === null || body.pin === '') {
            out.pinHash = null;
        } else {
            if (!/^\d{4}$/.test(String(body.pin))) throw fail(400, 'The PIN is 4 digits');
            out.pinHash = await require('../auth').hashPassword(String(body.pin));
        }
    }
    return out;
}

async function create(viewer, body) {
    assertOwner(viewer);
    const { users } = require('../db');
    const rows = await accountRows(viewer.accountId);
    if (rows.length >= MAX_PROFILES) throw fail(400, `At most ${MAX_PROFILES} profiles per login`);
    const values = await fields(body, null, rows);
    const created = await users.create({
        // Internal and unique; people see profileName. No password: can't log in.
        username: `profile-${viewer.accountId}-${crypto.randomBytes(4).toString('hex')}`,
        role: 'viewer',
        parentId: viewer.accountId
    });
    const row = await users.update(created.id, { avatar: created.id % AVATARS, ...values });
    return publicProfile(row, viewer);
}

/** A row of the viewer's account, or 404 */
async function ownRow(viewer, id) {
    const rows = await accountRows(viewer.accountId);
    const row = rows.find(u => u.id === parseInt(id, 10));
    if (!row) throw fail(404, 'Profile not found');
    return { row, rows };
}

async function update(viewer, id, body) {
    assertOwner(viewer);
    const { users } = require('../db');
    const { row, rows } = await ownRow(viewer, id);
    const updated = await users.update(row.id, await fields(body, row, rows));
    return publicProfile(updated, viewer);
}

async function remove(viewer, id) {
    assertOwner(viewer);
    const { users } = require('../db');
    const { row } = await ownRow(viewer, id);
    if (!row.parentId) throw fail(400, 'The main profile is the login itself: it cannot be removed here');
    await users.delete(row.id);
    return { success: true };
}

/** Remove an account's profiles (the account was deleted) */
async function removeForAccount(accountId) {
    const { users } = require('../db');
    const all = await users.getAll();
    for (const row of all.filter(u => u.parentId === accountId)) await users.delete(row.id);
}

function recentPinFailures(accountId) {
    const cutoff = Date.now() - PIN_WINDOW_MS;
    const times = (pinFailures.get(accountId) || []).filter(t => t > cutoff);
    if (times.length) pinFailures.set(accountId, times); else pinFailures.delete(accountId);
    return times;
}

/**
 * May the viewer switch to profile `id`? Same login only; a locked profile
 * (other than the current one) needs its PIN. Returns { user, account } rows.
 */
async function checkSwitch(viewer, id, pin) {
    const { row, rows } = await ownRow(viewer, id);
    if (row.pinHash && row.id !== viewer.id) {
        if (recentPinFailures(viewer.accountId).length >= PIN_MAX_FAILURES) {
            throw fail(429, 'Too many wrong PINs. Try again in 15 min.');
        }
        const ok = /^\d{4}$/.test(String(pin ?? '')) && await require('../auth').verifyPassword(String(pin), row.pinHash);
        if (!ok) {
            pinFailures.set(viewer.accountId, [...recentPinFailures(viewer.accountId), Date.now()]);
            throw fail(403, 'Wrong PIN');
        }
        pinFailures.delete(viewer.accountId);
    }
    return { user: row, account: rows[0] };
}

// Forget idle entries so the map can't grow without bound
setInterval(() => [...pinFailures.keys()].forEach(recentPinFailures), PIN_WINDOW_MS).unref();

module.exports = { sessionUser, list, create, update, remove, removeForAccount, checkSwitch, MAX_PROFILES };
