const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../auth');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const db = require('../db');
const transcodeSession = require('../services/transcodeSession');
const { redact } = require('../services/redact');
const { FFMPEG_PROTOCOLS } = require('../services/urlGuard');
const { requireStreamRef } = require('../services/streamRef');

/**
 * Transcode Routes
 * 
 * Direct streaming (backward compatible):
 *   GET /api/transcode?url=...
 * 
 * HLS session-based (new, supports seeking):
 *   POST /api/transcode/session        - Create new session
 *   GET  /api/transcode/:id/stream.m3u8 - Get HLS playlist
 *   GET  /api/transcode/:id/:segment.ts - Get segment file
 *   DELETE /api/transcode/:id          - Stop and cleanup session
 *   GET /api/transcode/sessions        - List all sessions (debug)
 */

// Start session cleanup interval
transcodeSession.startCleanupInterval();

/**
 * Create a new transcode session
 * POST /api/transcode/session
 * Body: { url: string, seekOffset?: number }
 */
router.post('/session', requireStreamRef, async (req, res) => {
    const url = req.streamUrl; // body.url is a stream reference (services/streamRef.js)
    const { seekOffset, videoMode, videoCodec, audioCodec, audioChannels, audioTrack } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    const sessionOptions = {
            ffmpegPath,
            userAgent,
            seekOffset: seekOffset || 0,
            hwEncoder: settings.hwEncoder || 'software',
            maxResolution: settings.maxResolution || '1080p',
            quality: settings.quality || 'medium',
            audioMixPreset: settings.audioMixPreset || 'auto', // Audio downmix preset
            // Upscaling options
            upscaleEnabled: settings.upscaleEnabled || false,
            upscaleMethod: settings.upscaleMethod || 'hardware',
            upscaleTarget: settings.upscaleTarget || '1080p',
            videoMode: videoMode, // 'copy' or 'encode'
            videoCodec: videoCodec, // 'h264', 'hevc', etc.
            audioCodec: audioCodec, // 'aac', 'ac3', etc.
            audioChannels: audioChannels, // number of channels (2=stereo)
            audioTrack: Number.isInteger(audioTrack) ? audioTrack : 0, // which audio stream to use
            ownerId: req.user.id // only this account (or an admin) may use or stop it
    };

    try {
        // Xtream providers often allow a single connection and release the
        // slot a few seconds after the previous stream closes (e.g. auto-play
        // of the next episode). FFmpeg then gets an empty/cut-off response and
        // exits at once, so retry that case after a pause. A session that is
        // merely slow to produce its first segment is not retried.
        const MAX_ATTEMPTS = 3;
        let session = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            session = await transcodeSession.createSession(url, sessionOptions);
            await session.start();

            // Wait for playlist to be ready (first segments generated)
            if (await session.waitForPlaylist(30000)) break;

            const exitedEarly = !session.process;
            await transcodeSession.removeSession(session.id);
            session = null;
            if (!exitedEarly || attempt === MAX_ATTEMPTS) break;
            console.warn(`[Transcode] FFmpeg exited before first segment (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in 3s`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        if (!session) {
            return res.status(500).json({ error: 'Transcoding failed to start', reason: 'Playlist not generated in time' });
        }

        res.json({
            sessionId: session.id,
            playlistUrl: `/api/transcode/${session.id}/stream.m3u8`,
            status: session.status
        });

    } catch (err) {
        console.error('[Transcode] Session creation failed:', err);
        res.status(500).json({ error: 'Failed to create session', details: err.message });
    }
});

/**
 * The session, if it exists and belongs to the requesting account (admins may
 * use any). Someone else's session answers 404, like a missing one.
 */
function ownSession(req) {
    const session = transcodeSession.getSession(req.params.sessionId);
    if (!session) return null;
    if (req.user?.role === 'admin' || session.options.ownerId === req.user?.id) return session;
    return null;
}

/**
 * Get HLS playlist for a session
 * GET /api/transcode/:sessionId/stream.m3u8
 */
router.get('/:sessionId/stream.m3u8', async (req, res) => {
    const session = ownSession(req);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const playlist = await session.getPlaylist();
    if (!playlist) {
        return res.status(404).json({ error: 'Playlist not ready' });
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(playlist);
});

/**
 * Get a segment file for a session
 * GET /api/transcode/:sessionId/:segment.ts
 */
router.get('/:sessionId/:segment', async (req, res) => {
    const { segment } = req.params;

    // Only handle .ts files
    if (!segment.endsWith('.ts')) {
        return res.status(404).json({ error: 'Invalid segment' });
    }

    const session = ownSession(req);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const segmentPath = await session.getSegment(segment);
    if (!segmentPath) {
        return res.status(404).json({ error: 'Segment not found' });
    }

    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache forever (immutable)
    res.sendFile(segmentPath);
});

/**
 * Stop and cleanup a session
 * DELETE /api/transcode/:sessionId
 */
router.delete('/:sessionId', async (req, res) => {
    const session = ownSession(req);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await transcodeSession.removeSession(session.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove session', details: err.message });
    }
});

/**
 * List all active sessions (for debugging)
 * GET /api/transcode/sessions
 */
// Admin only: the session list shows source URLs, which carry provider logins
router.get('/sessions', requireAdmin, (req, res) => {
    res.json(transcodeSession.getAllSessions());
});

/**
 * Direct transcode stream (backward compatible, no seeking)
 * GET /api/transcode?url=...
 * 
 * Transcodes audio to AAC for browser compatibility while passing video through.
 * This fixes playback issues with Dolby/AC3/EAC3 audio that browsers can't decode.
 */
router.get('/', requireStreamRef, async (req, res) => {
    const { audioTrack } = req.query;
    const url = req.streamUrl; // ?url= is a stream reference (services/streamRef.js)
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Which audio stream to keep (audio-relative index, as given by /api/probe)
    const audioTrackIdx = Number.isInteger(parseInt(audioTrack, 10)) ? parseInt(audioTrack, 10) : 0;

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';

    // Get User-Agent from settings
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    console.log(`[Transcode] Starting transcoding for: ${redact(url)}`);
    console.log(`[Transcode] Using User-Agent: ${settings.userAgentPreset}`);
    console.log(`[Transcode] Using binary: ${ffmpegPath}`);

    // FFmpeg arguments for transcoding
    // Optimized for VOD content with incompatible audio (Dolby/AC3/EAC3)
    // Also works for live streams with ad stitching (Pluto TV, etc.)
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', userAgent,
        // Faster startup - reduced probe/analyze for quicker first bytes
        '-probesize', '2000000', // 2MB (reduced from 5MB)
        '-analyzeduration', '3000000', // 3 seconds (reduced from 10s)
        // Error resilience: generate timestamps, discard corrupt packets
        '-fflags', '+genpts+discardcorrupt+nobuffer',
        // Ignore errors in stream and continue
        '-err_detect', 'ignore_err',
        // Limit max demux delay to prevent buffering issues
        '-max_delay', '2000000',
        // Reconnect settings for network drops (useful for live streams)
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '3',
        // Prevent Range/HEAD requests that some providers reject with 405
        '-seekable', '0',
        ...FFMPEG_PROTOCOLS,
        '-i', url,
        // Map only first video and audio stream (avoid subtitle streams causing issues)
        '-map', '0:v:0',
        '-map', `0:a:${audioTrackIdx}?`, // ? makes audio optional if not present
        // Video: passthrough (no re-encoding = fast!)
        '-c:v', 'copy',
        // Audio: Transcode to browser-compatible AAC
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
        // Handle async audio/video using async filter
        '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
        // Timestamp handling
        '-fps_mode', 'passthrough',
        '-async', '1',
        '-max_muxing_queue_size', '2048',
        // Fragmented MP4 for streaming (browser-compatible)
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
        '-flush_packets', '1', // Send data immediately
        '-' // Output to stdout
    ];

    console.log(`[Transcode] Full command: ${ffmpegPath} ${redact(args.join(' '))}`);

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Transcode] Failed to spawn FFmpeg:', spawnErr);
        return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
    }

    // Collect stderr for error reporting
    let stderrBuffer = '';

    // Set headers for fragmented MP4
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    // Log stderr (useful for debugging transcoding failures)
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        stderrBuffer += msg;
        console.log(`[FFmpeg] ${msg}`);
    });

    // Cleanup on client disconnect
    req.on('close', () => {
        console.log('[Transcode] Client disconnected, killing FFmpeg process');
        ffmpeg.kill('SIGKILL');
    });

    // Handle process exit
    ffmpeg.on('exit', (code) => {
        if (code !== null && code !== 0 && code !== 255) { // 255 is often returned on kill
            console.error(`[Transcode] FFmpeg exited with code ${code}`);
        }
    });

    // Handle spawn errors
    ffmpeg.on('error', (err) => {
        console.error('[Transcode] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Transcoding failed to start' });
        }
    });
});

module.exports = router;

