/**
 * Encrypted storage for users' own provider logins (direct playback, TODO #10).
 *
 * A provider login has to be read back (it goes into every stream URL), so it
 * is encrypted, not hashed. Each record gets its own random salt and IV:
 *
 *   key  = scrypt(secret, "fleurbox-provider-login:" + salt)   per record
 *   data = AES-256-GCM(key, iv, JSON login), authenticated with the owner's
 *          user id (AAD) - a record copied onto another user doesn't open
 *
 * secret = PROVIDER_SECRET from .env, else JWT_SECRET. Changing that secret
 * makes every stored login unreadable (users re-enter theirs); nothing else.
 *
 * Stored form: "v1.<salt>.<iv>.<tag>.<ciphertext>" (base64url parts).
 */
const crypto = require('crypto');

const LABEL = 'fleurbox-provider-login:';
const SCRYPT = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Derived keys by salt: scrypt is slow on purpose, and the same record is
// opened on every play
const keyCache = new Map();
const KEY_CACHE_MAX = 200;

function secret() {
    const s = process.env.PROVIDER_SECRET || process.env.JWT_SECRET;
    if (!s) throw new Error('No PROVIDER_SECRET or JWT_SECRET to encrypt provider logins with');
    return s;
}

function keyFor(salt) {
    const id = salt.toString('base64url');
    let key = keyCache.get(id);
    if (!key) {
        key = crypto.scryptSync(secret(), Buffer.concat([Buffer.from(LABEL), salt]), 32, SCRYPT);
        if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value);
        keyCache.set(id, key);
    }
    return key;
}

/** Encrypt a login object ({ username, password }) for one user */
function seal(login, userId) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(salt), iv);
    cipher.setAAD(Buffer.from(`user:${userId}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(login), 'utf8'), cipher.final()]);
    return ['v1', salt, iv, cipher.getAuthTag(), data].map(p => typeof p === 'string' ? p : p.toString('base64url')).join('.');
}

/** The login object, or null when the record is damaged, not this user's, or the secret changed */
function open(sealed, userId) {
    try {
        const [version, ...parts] = String(sealed).split('.');
        if (version !== 'v1' || parts.length !== 4) return null;
        const [salt, iv, tag, data] = parts.map(p => Buffer.from(p, 'base64url'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(salt), iv);
        decipher.setAAD(Buffer.from(`user:${userId}`));
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
    } catch {
        return null;
    }
}

module.exports = { seal, open };
