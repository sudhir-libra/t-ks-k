// Local WHIP-to-RTMP Bridge Server
// This creates a local WHIP endpoint that this app can stream to,
// then uses FFmpeg to convert and push to YouTube RTMP
//
// Usage:
// 1. Run: node bridge-server.js
// 2. In app: Use WHIP endpoint http://localhost:8889/whip
// 3. Configure YouTube RTMP URL and Stream Key below
// 4. Click "Start Stream" in the app
// 5. FFmpeg will automatically receive and push to YouTube

const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

// ============= CONFIGURATION =============
// YouTube RTMP Configuration
const YOUTUBE_RTMP_URL = 'rtmp://a.rtmp.youtube.com/live2';
const YOUTUBE_STREAM_KEY = ''; // Add your stream key here
// Full RTMP URL would be: rtmp://a.rtmp.youtube.com/live2/YOUR_STREAM_KEY

// Local server configuration
const WHIP_PORT = 8889;
const RTP_PORT = 8888;
// =========================================

let ffmpegProcess = null;
let currentSdpOffer = null;
let webRTCConnection = null;

// Simple HTTP server for WHIP endpoint
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${WHIP_PORT}`);
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // WHIP endpoint
    if (url.pathname === '/whip' && req.method === 'POST') {
        console.log('[WHIP] Received offer from streaming app');
        
        let body = '';
        for await (const chunk of req) {
            body += chunk;
        }
        
        currentSdpOffer = body;
        
        // Generate SDP answer (simplified - in production use a proper WebRTC stack)
        const answerSdp = generateSdpAnswer();
        
        res.writeHead(200, {
            'Content-Type': 'application/sdp',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(answerSdp);
        
        console.log('[WHIP] Sent answer, starting FFmpeg bridge...');
        startFFmpegBridge();
        return;
    }
    
    // ICE candidate endpoint
    if (url.pathname === '/whip/ice' && req.method === 'POST') {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        res.end('OK');
        return;
    }
    
    res.writeHead(404);
    res.end('Not Found');
});

function generateSdpAnswer() {
    return `v=0
o=- 0 0 IN IP4 127.0.0.1
s=Stream
c=IN IP4 127.0.0.1
t=0 0
m=video 0 RTP/AVP 96
a=rtpmap:96 VP8/90000
a=sendonly
m=audio 0 RTP/AVP 97
a=rtpmap:97 opus/48000/2
a=sendonly
`;
}

function startFFmpegBridge() {
    if (ffmpegProcess) {
        console.log('[FFmpeg] Stopping existing process...');
        ffmpegProcess.kill();
    }
    
    if (!YOUTUBE_STREAM_KEY) {
        console.log('[FFmpeg] ERROR: YouTube stream key not configured!');
        console.log('[FFmpeg] Please edit bridge-server.js and set YOUTUBE_STREAM_KEY');
        return;
    }
    
    const rtmpUrl = `${YOUTUBE_RTMP_URL}/${YOUTUBE_STREAM_KEY}`;
    console.log(`[FFmpeg] Starting bridge to: ${rtmpUrl}`);
    
    // FFmpeg command to receive WebRTC and push to RTMP
    // This receives from a simple RTP stream - in production use a proper WebRTC->RTMP converter
    const ffmpegArgs = [
        '-i', `rtp://127.0.0.1:${RTP_PORT}`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-b:v', '4000k',
        '-maxrate', '6000k',
        '-bufsize', '8000k',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
        '-f', 'flv',
        rtmpUrl
    ];
    
    ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    
    ffmpegProcess.stdout.on('data', (data) => {
        console.log('[FFmpeg] ' + data.toString().trim());
    });
    
    ffmpegProcess.stderr.on('data', (data) => {
        // FFmpeg outputs to stderr
    });
    
    ffmpegProcess.on('close', (code) => {
        console.log(`[FFmpeg] Process exited with code ${code}`);
        ffmpegProcess = null;
    });
    
    ffmpegProcess.on('error', (err) => {
        console.log('[FFmpeg] Error:', err.message);
    });
}

server.listen(WHIP_PORT, () => {
    console.log('===========================================');
    console.log('  Local WHIP-to-RTMP Bridge Server');
    console.log('===========================================');
    console.log(`WHIP Endpoint: http://localhost:${WHIP_PORT}/whip`);
    console.log('');
    console.log('SETUP INSTRUCTIONS:');
    console.log('1. In this app streaming panel:');
    console.log(`   - Endpoint URL: http://localhost:${WHIP_PORT}/whip`);
    console.log('   - Protocol: WHIP (WebRTC)');
    console.log('2. Configure your YouTube stream key in bridge-server.js');
    console.log('3. Click "Start Stream" in the app');
    console.log('4. FFmpeg will receive and push to YouTube');
    console.log('');
    console.log('Press Ctrl+C to stop');
});

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    if (ffmpegProcess) {
        ffmpegProcess.kill();
    }
    process.exit(0);
});

