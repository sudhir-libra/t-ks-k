/**
 * Simple HTTP Streaming Bridge
 * Receives frames from browser via HTTP POST and streams to YouTube RTMP
 * 
 * Setup:
 * 1. npm install express
 * 2. Set YOUTUBE_STREAM_KEY below
 * 3. Run: node streaming-bridge.js
 * 4. In streaming app: Use endpoint http://localhost:8889/stream
 */

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();

// Simple CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Stream-Fps, X-Stream-Width, X-Stream-Height, X-Stream-Id, X-Stream-Label, X-Stream-Frame-Id, X-Stream-Timestamp, X-Stream-Bitrate-Kbps, X-Stream-Maxrate-Kbps, X-Stream-Bufsize-Kbps'
    );
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ============= CONFIGURATION =============
const PORT = 8889;
const RESTART_DELAY_MS = 3000; // Wait 3 seconds before restarting FFmpeg
const MAX_RESTART_ATTEMPTS = 5; // Max restarts before giving up
const NO_FRAME_TIMEOUT_MS = 12_000; // Restart if no frames for this long

const DEFAULT_STREAM_CONFIG = {
    fps: clampInt(process.env.STREAM_FPS, 5, 60, 30),
    width: clampInt(process.env.STREAM_WIDTH, 320, 3840, 1280),
    height: clampInt(process.env.STREAM_HEIGHT, 240, 2160, 720),
    videoKbps: clampInt(process.env.STREAM_VIDEO_KBPS, 800, 20000, 4500),
    maxKbps: clampInt(process.env.STREAM_MAX_KBPS, 800, 30000, 6000),
    bufKbps: clampInt(process.env.STREAM_BUF_KBPS, 800, 40000, 9000)
};

const STREAM_AUTH = {
    youtubeStreamKey: String(process.env.YOUTUBE_STREAM_KEY || '54c1-px3r-qyp0-sbhv-7bzb'),
    rtmpUrlOverride: String(process.env.YOUTUBE_RTMP_URL || '')
};

const FFMPEG_BIN =
    process.env.FFMPEG_PATH ||
    (fs.existsSync(path.join(__dirname, 'ffmpeg.exe')) ? path.join(__dirname, 'ffmpeg.exe') : 'ffmpeg');
// =========================================

app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: 'image/*', limit: '50mb' }));

let ffmpegProcess = null;
let isStreaming = false;
let frameCount = 0;
let restartAttempts = 0;
let restartTimeout = null;
let lastFrameAt = 0;
let currentConfig = { ...DEFAULT_STREAM_CONFIG };
let ffmpegBackpressure = false;

function getYouTubeURL() {
    if (STREAM_AUTH.rtmpUrlOverride) return STREAM_AUTH.rtmpUrlOverride;
    if (!STREAM_AUTH.youtubeStreamKey) return null;
    return `rtmp://a.rtmp.youtube.com/live2/${STREAM_AUTH.youtubeStreamKey}`;
}

function startFFmpeg(config) {
    // Too many restarts - stop trying
    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
        console.log('[FFmpeg] Too many restart attempts. Stopping. Please check:');
        console.log('[FFmpeg] 1. Is YouTube stream key valid?');
        console.log('[FFmpeg] 2. Is port 1935 (RTMP) open in firewall?');
        console.log('[FFmpeg] 3. Did you enable the stream in YouTube Studio?');
        return false;
    }
    
    const rtmpUrl = getYouTubeURL();
    
    if (!rtmpUrl) {
        console.log('ERROR: YouTube stream key not configured!');
        console.log('Set YOUTUBE_STREAM_KEY environment variable');
        return false;
    }
    
    const cfg = normalizeConfig(config);
    currentConfig = { ...cfg };
    console.log(`[FFmpeg] Starting stream to: ${rtmpUrl} (attempt ${restartAttempts + 1})`);
    console.log(`[FFmpeg] Input: ${cfg.width}x${cfg.height} @ ${cfg.fps} fps, ${cfg.videoKbps} kbps`);
    
    // FFmpeg command to receive JPEG frames and stream to RTMP
    const gop = Math.max(2, Math.floor(cfg.fps * 2));
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-fflags', '+genpts',
        '-use_wallclock_as_timestamps', '1',
        '-f', 'mjpeg',                 // Input format: MJPEG (JPEG frames)
        '-framerate', String(cfg.fps),
        '-i', '-',                     // Read video from stdin
        '-f', 'lavfi',                 // Add a silent audio source
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-vf', `scale=${cfg.width}:${cfg.height}:flags=bicubic,format=yuv420p`,
        '-c:v', 'libx264',            // H.264 video codec
        '-preset', 'veryfast',        // Fast encoding preset
        '-tune', 'zerolatency',       // Low latency tuning
        '-b:v', `${cfg.videoKbps}k`,  // Video bitrate
        '-maxrate', `${cfg.maxKbps}k`, // Max bitrate
        '-bufsize', `${cfg.bufKbps}k`, // Buffer size
        '-g', String(gop),            // Keyframe interval
        '-keyint_min', String(gop),
        '-r', String(cfg.fps),
        '-c:a', 'aac',                // AAC audio codec
        '-b:a', '128k',              // Audio bitrate
        '-ar', '48000',              // Audio sample rate
        '-ac', '2',
        '-flvflags', 'no_duration_filesize',
        '-f', 'flv',                 // Output format
        rtmpUrl                       // YouTube RTMP URL
    ];
    
    ffmpegProcess = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    
    ffmpegProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        // Only log errors and important messages
        if (msg.includes('error') || msg.includes('Error') || msg.includes('rtmp') || msg.includes('connection') || msg.includes('failed')) {
            console.log('[FFmpeg] ' + msg.trim());
        }
        if (msg.includes('frame=') || msg.includes('speed=')) {
            process.stdout.write('\r[FFmpeg] ' + msg.substring(0, 80));
        }
    });
    
    ffmpegProcess.on('close', (code) => {
        console.log(`\n[FFmpeg] Process exited with code ${code}`);
        ffmpegProcess = null;
        
        // Only auto-restart if we were streaming and lost connection
        if (isStreaming && code !== 0) {
            restartAttempts++;
            console.log(`[FFmpeg] Will retry in ${RESTART_DELAY_MS}ms...`);
            restartTimeout = setTimeout(() => {
                console.log('[FFmpeg] Attempting to restart...');
                startFFmpeg();
            }, RESTART_DELAY_MS);
        } else {
            isStreaming = false;
        }
    });
    
    ffmpegProcess.on('error', (err) => {
        console.log('[FFmpeg] Error:', err.message);
    });
    
    // Handle stdin errors gracefully
    if (ffmpegProcess.stdin) {
        ffmpegProcess.stdin.on('error', (err) => {
            // Ignore EPIPE - happens when FFmpeg closes but we still try to write
            if (err.code !== 'EPIPE') {
                console.log('[FFmpeg stdin] Error:', err.message);
            }
        });
        ffmpegProcess.stdin.on('drain', () => {
            ffmpegBackpressure = false;
        });
    }
    
    return true;
}

function stopFFmpeg(resetAttempts = false) {
    // Clear any pending restart
    if (restartTimeout) {
        clearTimeout(restartTimeout);
        restartTimeout = null;
    }
    if (resetAttempts) restartAttempts = 0;
    
    if (ffmpegProcess) {
        console.log('\n[FFmpeg] Stopping...');
        try {
            if (ffmpegProcess.stdin) {
                ffmpegProcess.stdin.end();
            }
        } catch (e) {}
        try {
            ffmpegProcess.kill();
        } catch (e) {}
        ffmpegProcess = null;
        isStreaming = false;
    }
}

function normalizeConfig(partial) {
    const cfg = { ...DEFAULT_STREAM_CONFIG, ...(partial || {}) };
    cfg.fps = clampInt(cfg.fps, 5, 60, DEFAULT_STREAM_CONFIG.fps);
    cfg.width = clampInt(cfg.width, 320, 3840, DEFAULT_STREAM_CONFIG.width);
    cfg.height = clampInt(cfg.height, 240, 2160, DEFAULT_STREAM_CONFIG.height);
    cfg.videoKbps = clampInt(cfg.videoKbps, 800, 20000, DEFAULT_STREAM_CONFIG.videoKbps);
    cfg.maxKbps = clampInt(cfg.maxKbps, 800, 30000, DEFAULT_STREAM_CONFIG.maxKbps);
    cfg.bufKbps = clampInt(cfg.bufKbps, 800, 40000, DEFAULT_STREAM_CONFIG.bufKbps);
    return cfg;
}

function clampInt(val, min, max, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function extractConfigFromHeaders(headers) {
    return {
        fps: Number(headers['x-stream-fps'] || headers['x-stream-fps'.toLowerCase()]),
        width: Number(headers['x-stream-width'] || headers['x-stream-width'.toLowerCase()]),
        height: Number(headers['x-stream-height'] || headers['x-stream-height'.toLowerCase()]),
        videoKbps: Number(headers['x-stream-bitrate-kbps'] || headers['x-stream-bitrate-kbps'.toLowerCase()]),
        maxKbps: Number(headers['x-stream-maxrate-kbps'] || headers['x-stream-maxrate-kbps'.toLowerCase()]),
        bufKbps: Number(headers['x-stream-bufsize-kbps'] || headers['x-stream-bufsize-kbps'.toLowerCase()])
    };
}

function configChanged(a, b) {
    return a.fps !== b.fps ||
        a.width !== b.width ||
        a.height !== b.height ||
        a.videoKbps !== b.videoKbps ||
        a.maxKbps !== b.maxKbps ||
        a.bufKbps !== b.bufKbps;
}

// Route: Receive frame from browser
app.post('/stream', (req, res) => {
    // Get frame data first
    let frameData;
    if (req.is('image/*')) {
        frameData = req.body;
    } else if (req.body && req.body.image) {
        // Base64 encoded
        const buffer = Buffer.from(req.body.image, 'base64');
        frameData = buffer;
    }
    
    if (!frameData) {
        return res.status(400).json({ error: 'No image data' });
    }

    const incomingCfg = normalizeConfig(extractConfigFromHeaders(req.headers));
    if (configChanged(currentConfig, incomingCfg) && isStreaming) {
        console.log('[FFmpeg] Config change detected. Restarting FFmpeg...');
        restartAttempts = 0;
        stopFFmpeg();
    }
    
    // Start FFmpeg on first frame if not already running
    if (!isStreaming || !ffmpegProcess) {
        if (!startFFmpeg(incomingCfg)) {
            return res.status(500).json({ error: 'FFmpeg not configured' });
        }
        isStreaming = true;
    }
    
    // Try to write frame
    if (ffmpegProcess && ffmpegProcess.stdin) {
        try {
            if (!ffmpegBackpressure) {
                const ok = ffmpegProcess.stdin.write(frameData);
                if (!ok) ffmpegBackpressure = true;
                frameCount++;
                lastFrameAt = Date.now();
            }
        } catch (e) {
            console.log('[Error] Writing frame:', e.message);
            // Don't auto-restart here - let the close handler deal with it
        }
    }
    
    res.json({ status: 'ok', frames: frameCount });
});

// Route: Get status
app.get('/status', (req, res) => {
    res.json({
        streaming: isStreaming,
        framesReceived: frameCount,
        youtubeConfigured: !!STREAM_AUTH.youtubeStreamKey || !!STREAM_AUTH.rtmpUrlOverride,
        ffmpegRunning: ffmpegProcess !== null,
        restartAttempts: restartAttempts,
        lastFrameAgeMs: lastFrameAt ? Date.now() - lastFrameAt : null,
        currentConfig
    });
});

// Route: Stop stream
app.post('/stop', (req, res) => {
    stopFFmpeg(true);
    frameCount = 0;
    res.json({ status: 'stopped' });
});

// Route: Configure YouTube (alternative to editing file)
app.post('/config', (req, res) => {
    const { streamKey } = req.body;
    if (streamKey) {
        STREAM_AUTH.youtubeStreamKey = String(streamKey);
        console.log('[Config] Stream key received (not persisted)');
        res.json({ status: 'ok' });
    } else {
        res.status(400).json({ error: 'Missing streamKey' });
    }
});

// Main
console.log('=' .repeat(50));
console.log('  Simple HTTP Streaming Bridge');
console.log('=' .repeat(50));
console.log(`Server running on: http://localhost:${PORT}`);
console.log('');
console.log('CONFIGURATION:');
console.log(`- YouTube configured: ${!!STREAM_AUTH.youtubeStreamKey || !!STREAM_AUTH.rtmpUrlOverride}`);
if (!STREAM_AUTH.youtubeStreamKey && !STREAM_AUTH.rtmpUrlOverride) {
    console.log('- WARNING: Set YOUTUBE_STREAM_KEY env var or YOUTUBE_RTMP_URL!');
}
console.log('');
console.log('USAGE:');
console.log(`1. In streaming app, set endpoint: http://localhost:${PORT}/stream`);
console.log('2. Set protocol to: HTTP (FFmpeg Bridge)');
console.log('3. Click Start Stream');
console.log('');
console.log('IMPORTANT:');
console.log('- Make sure to enable your stream in YouTube Studio FIRST');
console.log('- Wait for YouTube to show "Starting" or "Ready" status');
console.log('- Then click Start Stream in this app');
console.log('');
console.log('Press Ctrl+C to stop');
console.log('=' .repeat(50));

app.listen(PORT, () => {
    console.log(`Server ready at http://localhost:${PORT}`);
});

setInterval(() => {
    if (!isStreaming || !ffmpegProcess) return;
    if (lastFrameAt && Date.now() - lastFrameAt > NO_FRAME_TIMEOUT_MS) {
        console.log('[Watchdog] No frames received. Restarting FFmpeg...');
        restartAttempts++;
        stopFFmpeg();
        startFFmpeg(currentConfig);
    }
}, 2000);

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    stopFFmpeg(true);
    process.exit(0);
});
