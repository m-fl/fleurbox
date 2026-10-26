/**
 * The signed-in user's own profile, for every role (viewers can't open
 * Settings): who they are and their appearance preferences.
 *
 * APPEARANCE is the single place to edit the choices; the Profile page renders
 * from GET /api/profile. Each value becomes a data- attribute on <html>
 * (data-accent, data-text-size, data-motion) that css/main.css styles.
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/sqlite');

const APPEARANCE = {
    accent: {
        label: 'Accent colour',
        default: 'fleur',
        options: [
            { id: 'fleur', label: 'Fleur', swatch: '#5f8452' },
            { id: 'terracotta', label: 'Terracotta', swatch: '#c4704f' },
            { id: 'ocean', label: 'Ocean', swatch: '#4f7fa6' },
            { id: 'iris', label: 'Iris', swatch: '#7d66b3' },
            { id: 'amber', label: 'Amber', swatch: '#b08a3a' }
        ]
    },
    textSize: {
        label: 'Text size',
        default: 'default',
        options: [
            { id: 'small', label: 'Small' },
            { id: 'default', label: 'Default' },
            { id: 'large', label: 'Large' }
        ]
    },
    motion: {
        label: 'Animations',
        default: 'full',
        options: [
            { id: 'full', label: 'On' },
            { id: 'reduced', label: 'Reduced' }
        ]
    }
};

let tableReady = false;
function ensureTable() {
    if (tableReady) return;
    getDb().exec(`
        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id INTEGER PRIMARY KEY,
            json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
    tableReady = true;
}

/** Known keys with known values; anything else falls back to the default */
function sanitize(input) {
    return Object.fromEntries(Object.entries(APPEARANCE).map(([key, spec]) => [key,
        spec.options.some(o => o.id === input?.[key]) ? input[key] : spec.default]));
}

function getPreferences(userId) {
    ensureTable();
    const row = getDb().prepare('SELECT json FROM user_preferences WHERE user_id = ?').get(userId);
    return sanitize(row ? JSON.parse(row.json) : {});
}

/** GET /api/profile -> { user: { id, username, role }, appearance, preferences } */
router.get('/', (req, res) => {
    try {
        const { id, username, name, role, isOwner } = req.user;
        res.json({ user: { id, username, name, role, isOwner, kids: !!req.user.kids }, appearance: APPEARANCE, preferences: getPreferences(id) });
    } catch (err) {
        console.error('[Profile] Load failed:', err);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

/** PUT /api/profile/preferences { accent?, textSize?, motion? } - merged into the saved ones */
router.put('/preferences', (req, res) => {
    try {
        const preferences = sanitize({ ...getPreferences(req.user.id), ...(req.body || {}) });
        getDb().prepare('INSERT OR REPLACE INTO user_preferences (user_id, json, updated_at) VALUES (?, ?, ?)')
            .run(req.user.id, JSON.stringify(preferences), Date.now());
        res.json({ preferences });
    } catch (err) {
        console.error('[Profile] Saving preferences failed:', err);
        res.status(500).json({ error: 'Failed to save preferences' });
    }
});

module.exports = router;
