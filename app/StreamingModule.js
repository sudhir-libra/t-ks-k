// app/StreamingModule.js
//
// Browser-only streaming module (OBS-like) focused on:
// - Assignable sources (program/input/aux) -> outputs
// - WebRTC publish via WHIP (HTTP-based signaling)
// - Status monitoring, metrics, reliability (state machine, retries, watchdog)
// - No native RTMP/SRT/NDI (browser constraint)
//
// NOTE: WHIP requires a compatible ingest endpoint. This module expects the WHIP endpoint
// to accept POST of SDP offer and return SDP answer in the response body.
// Auth is typically Bearer token, optional.

export class StreamingModule {
    /**
     * @param {(state: StreamingModuleStateEvent) => void} onState
     */
    constructor(onState) {
        this.onState = typeof onState === 'function' ? onState : () => {};
        /** @type {Map<string, StreamSession>} */
        this.sessions = new Map();
        this.support = {
            webrtc: !!(window.RTCPeerConnection),
            getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
            fetch: typeof fetch === 'function'
        };
    }

    isSupported() {
        return !!this.support.webrtc && !!this.support.fetch;
    }

    /**
     * Start or replace a publish session.
     * @param {StartStreamOptions} opts
     */
    async start(opts) {
        if (!this.isSupported()) throw new Error('Streaming not supported in this browser');

        const key = String(opts.key || '').trim();
        if (!key) throw new Error('Missing stream key');

        // Replace if exists
        if (this.sessions.has(key)) {
            await this.stop(key);
        }

        const session = new StreamSession(opts, evt => this.onState(evt));
        this.sessions.set(key, session);

        try {
            await session.start();
        } catch (err) {
            // Ensure cleanup if start fails
            await session.stop('start_failed');
            this.sessions.delete(key);
            throw err;
        }

        return true;
    }

    /**
     * Stop a publish session.
     * @param {string} key
     */
    async stop(key) {
        const s = this.sessions.get(key);
        if (!s) return;
        await s.stop('user_stop');
        this.sessions.delete(key);
    }

    /**
     * @param {string} key
     */
    getStatus(key) {
        const s = this.sessions.get(key);
        return s ? s.getStatus() : null;
    }

    /**
     * Stop all sessions
     */
    async stopAll() {
        const keys = Array.from(this.sessions.keys());
        for (const key of keys) {
            await this.stop(key);
        }
    }
}

/**
 * @typedef {'idle'|'connecting'|'publishing'|'reconnecting'|'stopping'|'stopped'|'error'} StreamStatus
 */

/**
 * @typedef {Object} StreamMetrics
 * @property {number} startedAt
 * @property {number} lastStateAt
 * @property {number} reconnects
 * @property {number} bytesSent
 * @property {number} packetsSent
 * @property {number} framesEncoded
 * @property {number} framesPerSecond
 * @property {number} roundTripTimeMs
 * @property {number} jitterMs
 * @property {number} outboundBitrateBps
 */

/**
 * @typedef {Object} StreamingModuleStateEvent
 * @property {string} key
 * @property {StreamStatus} status
 * @property {string=} message
 * @property {StreamMetrics=} metrics
 * @property {any=} detail
 */

/**
 * @typedef {Object} StartStreamOptions
 * @property {string} key - unique session key, e.g. 'program' or 'aux-1'
 * @property {string} label
 * @property {'whip'|'http'} outputType - WHIP (WebRTC) or HTTP (to FFmpeg bridge)
 * @property {string} endpointUrl - WHIP endpoint or HTTP bridge endpoint
 * @property {string=} bearerToken
 * @property {HTMLCanvasElement|HTMLVideoElement|HTMLImageElement} sourceElement
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {MediaStreamTrack|null=} audioTrack
 * @property {() => Array<{element: HTMLVideoElement|HTMLImageElement, settings: any}>=} overlaysProvider
 * @property {boolean=} adaptive - if true, degrade fps on sustained pressure
 * @property {number=} maxRetries
 * @property {number=} retryBaseMs
 * @property {number=} retryMaxMs
 * @property {number=} jpegQuality - JPEG quality (0.5-1.0)
 */

/**
 * @typedef {Object} StreamSessionStatus
 * @property {StreamStatus} status
 * @property {string} key
 * @property {string} label
 * @property {string} endpointUrl
 * @property {string=} lastError
 * @property {StreamMetrics} metrics
 */

class StreamSession {
    /**
     * @param {StartStreamOptions} opts
     * @param {(evt: StreamingModuleStateEvent) => void} emit
     */
    constructor(opts, emit) {
        this.opts = normalizeOptions(opts);
        this.emit = emit;

        /** @type {RTCPeerConnection|null} */
        this.pc = null;
        /** @type {RTCRtpSender|null} */
        this.videoSender = null;
        /** @type {RTCRtpSender|null} */
        this.audioSender = null;

        this.status = 'idle';
        this.closed = false;

        this.metrics = {
            startedAt: Date.now(),
            lastStateAt: Date.now(),
            reconnects: 0,
            bytesSent: 0,
            packetsSent: 0,
            framesEncoded: 0,
            framesPerSecond: 0,
            roundTripTimeMs: 0,
            jitterMs: 0,
            outboundBitrateBps: 0
        };

        // Buffered pipeline (like recorder): ingestCanvas draws continuously, encodeCanvas samples at fps.
        this.ingestCanvas = document.createElement('canvas');
        this.encodeCanvas = document.createElement('canvas');
        this.ingestCanvas.width = this.opts.width;
        this.ingestCanvas.height = this.opts.height;
        this.encodeCanvas.width = this.opts.width;
        this.encodeCanvas.height = this.opts.height;

        this.ingestCtx = this.ingestCanvas.getContext('2d', { alpha: false });
        this.encodeCtx = this.encodeCanvas.getContext('2d', { alpha: false });

        this.ingestRaf = 0;
        this.encodeTimer = 0;

        this.statsTimer = 0;
        this.watchdogTimer = 0;

        this.lastBytesSent = 0;
        this.lastStatAt = 0;
        this.lastFramesEncoded = 0;

        this.lateFrames = 0;
        this.maxLagMs = 0;

        this.lastPcState = '';
        this.lastIceState = '';

        this.httpBusy = false;
        this.httpErrorCount = 0;
        this.httpFrameId = 0;
    }

    getStatus() {
        /** @type {StreamSessionStatus} */
        const status = {
            status: this.status,
            key: this.opts.key,
            label: this.opts.label,
            endpointUrl: this.opts.endpointUrl,
            lastError: this.lastError || '',
            metrics: { ...this.metrics }
        };
        return status;
    }

    async start() {
        this.closed = false;

        // Choose streaming method based on outputType
        if (this.opts.outputType === 'http') {
            await this.startHttpStreaming();
        } else {
            this.setStatus('connecting', 'Starting WebRTC publish');
            this.startIngestLoop();
            this.startEncodeLoop();
            await this.connectOnceWithRetries();
        }
    }

    async startHttpStreaming() {
        this.setStatus('connecting', 'Starting HTTP stream to bridge');

        this.startIngestLoop();
        
        // For HTTP streaming, we send JPEG frames directly
        const targetMs = Math.max(10, Math.floor(1000 / Math.max(1, this.opts.fps)));
        
        this.setStatus('publishing', 'Publishing via HTTP');
        this.startHttpStatsLoop();
        this.emitState();
        
        let nextTick = performance.now() + targetMs;
        const tick = async () => {
            if (this.closed) return;

            const now = performance.now();
            const delay = Math.max(0, nextTick - now);
            this.httpFrameTimer = window.setTimeout(async () => {
                if (this.closed) return;
                nextTick += targetMs;
                if (nextTick < performance.now() - targetMs * 2) {
                    nextTick = performance.now() + targetMs;
                }

                if (this.httpBusy) {
                    tick();
                    return;
                }
                this.httpBusy = true;

                try {
                    // Draw current frame to encode canvas
                    this.encodeCtx.drawImage(this.ingestCanvas, 0, 0, this.opts.width, this.opts.height);

                    // Convert to blob/jpeg
                    const blob = await new Promise(resolve => {
                        this.encodeCanvas.toBlob(resolve, 'image/jpeg', this.opts.jpegQuality);
                    });

                    if (blob && this.opts.endpointUrl) {
                        const response = await fetch(this.opts.endpointUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'image/jpeg',
                                'X-Stream-Fps': String(this.opts.fps),
                                'X-Stream-Width': String(this.opts.width),
                                'X-Stream-Height': String(this.opts.height),
                                'X-Stream-Id': String(this.opts.key),
                                'X-Stream-Label': String(this.opts.label || this.opts.key),
                                'X-Stream-Frame-Id': String(++this.httpFrameId),
                                'X-Stream-Timestamp': String(Date.now()),
                                ...(this.opts.bearerToken ? { Authorization: `Bearer ${this.opts.bearerToken}` } : {})
                            },
                            body: blob
                        });

                        if (response.ok) {
                            this.metrics.bytesSent += blob.size;
                            this.metrics.framesEncoded++;
                            this.httpErrorCount = 0;
                            if (this.status === 'reconnecting') {
                                this.setStatus('publishing', 'Publishing via HTTP');
                            }
                        } else {
                            this.httpErrorCount++;
                            this.lastError = `HTTP ${response.status}`;
                        }
                    }
                } catch (e) {
                    this.httpErrorCount++;
                    this.lastError = e?.message || 'HTTP error';
                } finally {
                    this.httpBusy = false;
                    if (this.httpErrorCount >= 3) {
                        this.setStatus('reconnecting', `HTTP errors: ${this.httpErrorCount}`);
                    }
                    tick();
                }
            }, delay);
        };

        tick();
    }

    startHttpStatsLoop() {
        this.stopTimers();
        
        this.lastBytesSent = 0;
        this.lastStatAt = performance.now();
        this.lastFramesEncoded = this.metrics.framesEncoded || 0;
        
        this.statsTimer = window.setInterval(() => {
            if (this.closed) return;
            
            const now = performance.now();
            const dt = Math.max(0.001, (now - this.lastStatAt) / 1000);
            this.lastStatAt = now;
            
            const bytesDelta = Math.max(0, this.metrics.bytesSent - this.lastBytesSent);
            this.lastBytesSent = this.metrics.bytesSent;
            
            this.metrics.outboundBitrateBps = Math.floor((bytesDelta * 8) / dt);
            const framesDelta = Math.max(0, (this.metrics.framesEncoded || 0) - this.lastFramesEncoded);
            this.lastFramesEncoded = this.metrics.framesEncoded || 0;
            this.metrics.framesPerSecond = Math.round(framesDelta / dt);
            this.metrics.lastStateAt = Date.now();
            
            this.emit({
                key: this.opts.key,
                status: this.status,
                metrics: { ...this.metrics }
            });
        }, 1000);
    }

    async stop(reason = 'stopped') {
        if (this.closed) return;
        this.closed = true;

        this.setStatus('stopping', `Stopping (${reason})`);
        this.stopLoops();

        if (this.pc) {
            try {
                this.pc.oniceconnectionstatechange = null;
                this.pc.onconnectionstatechange = null;
                this.pc.onicecandidate = null;
                this.pc.ontrack = null;
            } catch {}
            try {
                this.pc.close();
            } catch {}
        }
        this.pc = null;
        this.videoSender = null;
        this.audioSender = null;

        this.stopTimers();
        this.setStatus('stopped', 'Stopped');
    }

    stopTimers() {
        if (this.statsTimer) clearInterval(this.statsTimer);
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        this.statsTimer = 0;
        this.watchdogTimer = 0;
    }

    stopLoops() {
        if (this.ingestRaf) cancelAnimationFrame(this.ingestRaf);
        this.ingestRaf = 0;
        if (this.encodeTimer) clearInterval(this.encodeTimer);
        this.encodeTimer = 0;
        if (this.httpFrameTimer) clearTimeout(this.httpFrameTimer);
        this.httpFrameTimer = 0;
    }

    startIngestLoop() {
        const draw = () => {
            if (this.closed) return;
            this.drawFrame(this.ingestCtx, this.opts.sourceElement, this.opts.overlaysProvider);
            this.ingestRaf = requestAnimationFrame(draw);
        };
        draw();
    }

    startEncodeLoop() {
        const targetMs = Math.max(10, Math.floor(1000 / Math.max(1, this.opts.fps)));
        let lastTick = performance.now();

        this.encodeTimer = window.setInterval(() => {
            if (this.closed) return;

            const now = performance.now();
            const lag = now - lastTick - targetMs;
            if (lag > 8) {
                this.lateFrames++;
                this.maxLagMs = Math.max(this.maxLagMs, lag);
            }
            lastTick = now;

            // sample ingest -> encode canvas at fixed cadence
            try {
                this.encodeCtx.drawImage(this.ingestCanvas, 0, 0, this.opts.width, this.opts.height);
            } catch {}

            // adaptive: if sustained lag, reduce fps
            if (this.opts.adaptive) {
                if (this.lateFrames >= 40 && this.opts.fps > 10) {
                    const nextFps = Math.max(10, Math.floor(this.opts.fps * 0.8));
                    if (nextFps !== this.opts.fps) {
                        this.opts.fps = nextFps;
                        clearInterval(this.encodeTimer);
                        this.encodeTimer = 0;
                        this.lateFrames = 0;
                        this.maxLagMs = 0;
                        this.emit({
                            key: this.opts.key,
                            status: 'publishing',
                            message: `Adaptive downgrade: fps -> ${nextFps}`,
                            detail: { nextFps }
                        });
                        this.startEncodeLoop();
                    }
                }
            }
        }, targetMs);
    }

    drawFrame(ctx, sourceEl, overlaysProvider) {
        if (!ctx) return;
        ctx.clearRect(0, 0, this.opts.width, this.opts.height);

        // draw base
        safeDrawContain(ctx, sourceEl, this.opts.width, this.opts.height);

        // draw overlays (program overlays) if provided
        if (typeof overlaysProvider === 'function') {
            const layers = overlaysProvider() || [];
            for (const layer of layers) {
                if (!layer || !layer.element) continue;
                const s = layer.settings || {};
                const visible = s.visible !== false;
                const opacity = visible ? (typeof s.opacity === 'number' ? s.opacity : 1) : 0;
                if (opacity <= 0) continue;

                ctx.save();
                ctx.globalAlpha = Math.max(0, Math.min(1, opacity));

                // Apply similar transform model as CG layer: translate/rotate/scale about center
                const cx = this.opts.width / 2;
                const cy = this.opts.height / 2;
                const tx = Number(s.translateX || 0);
                const ty = Number(s.translateY || 0);
                const rot = (Number(s.rotateZ || 0) * Math.PI) / 180;
                const sx = Number(s.scaleX || 1);
                const sy = Number(s.scaleY || 1);

                ctx.translate(cx + tx, cy + ty);
                ctx.rotate(rot);
                ctx.scale(sx, sy);
                ctx.translate(-cx, -cy);

                safeDrawContain(ctx, layer.element, this.opts.width, this.opts.height);
                ctx.restore();
            }
        }
    }

    async connectOnceWithRetries() {
        const maxRetries = this.opts.maxRetries;
        let attempt = 0;
        let delay = this.opts.retryBaseMs;

        while (!this.closed) {
            try {
                await this.connectOnce();
                return;
            } catch (err) {
                attempt++;
                const message = err?.message || String(err);

                this.lastError = message;
                if (attempt > maxRetries) {
                    this.setStatus('error', `Publish failed: ${message}`);
                    throw err;
                }

                this.metrics.reconnects++;
                this.setStatus('reconnecting', `Retry ${attempt}/${maxRetries}: ${message}`);

                await waitMs(jitter(delay));
                delay = Math.min(this.opts.retryMaxMs, Math.floor(delay * 1.8));
            }
        }
    }

    async connectOnce() {
        // Create PeerConnection
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
        });
        this.pc = pc;

        pc.onconnectionstatechange = () => {
            const st = pc.connectionState || '';
            this.lastPcState = st;
            if (this.closed) return;

            if (st === 'failed' || st === 'disconnected') {
                // Trigger reconnect loop by throwing from watchdog soon
                this.lastError = `pc state: ${st}`;
            }
            this.emitState();
        };

        pc.oniceconnectionstatechange = () => {
            const st = pc.iceConnectionState || '';
            this.lastIceState = st;
            if (this.closed) return;

            if (st === 'failed' || st === 'disconnected') {
                this.lastError = `ice state: ${st}`;
            }
            this.emitState();
        };

        // Create media stream from encodeCanvas
        const stream = this.encodeCanvas.captureStream(this.opts.fps);
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) throw new Error('No video track from canvas');

        this.videoSender = pc.addTrack(videoTrack, stream);

        if (this.opts.audioTrack) {
            try {
                this.audioSender = pc.addTrack(this.opts.audioTrack, new MediaStream([this.opts.audioTrack]));
            } catch {
                this.audioSender = null;
            }
        }

        // Create SDP offer
        const offer = await pc.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false
        });
        await pc.setLocalDescription(offer);

        // Wait for ICE gathering to complete (simple wait)
        await waitForIceGathering(pc, 2500);

        // Send offer to WHIP endpoint
        const sdpOffer = pc.localDescription?.sdp;
        if (!sdpOffer) throw new Error('Missing local SDP');

        this.setStatus('connecting', 'Sending WHIP offer');

        const res = await fetch(this.opts.endpointUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sdp',
                ...(this.opts.bearerToken ? { Authorization: `Bearer ${this.opts.bearerToken}` } : {})
            },
            body: sdpOffer
        });

        if (!res.ok) {
            const text = await safeReadText(res);
            throw new Error(`WHIP error ${res.status}: ${text || res.statusText}`);
        }

        const answerSdp = await res.text();
        if (!answerSdp || !answerSdp.includes('v=0')) {
            throw new Error('Invalid WHIP answer SDP');
        }

        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

        // Start metrics collection + watchdog
        this.startStatsLoop();
        this.startWatchdog();

        this.setStatus('publishing', 'Publishing');
        this.emitState();
    }

    startStatsLoop() {
        this.stopTimers();

        this.lastBytesSent = 0;
        this.lastStatAt = performance.now();

        this.statsTimer = window.setInterval(async () => {
            if (this.closed || !this.pc) return;

            try {
                const report = await this.pc.getStats();
                this.updateMetricsFromStats(report);
                this.emit({
                    key: this.opts.key,
                    status: this.status,
                    metrics: { ...this.metrics }
                });
            } catch {}
        }, 1000);
    }

    startWatchdog() {
        // Watchdog tries to detect "stuck" state and provoke reconnect by throwing.
        this.watchdogTimer = window.setInterval(() => {
            if (this.closed) return;
            if (!this.pc) return;

            const st = this.pc.connectionState;
            if (st === 'failed' || st === 'disconnected') {
                // Force reconnect by closing and throwing path in retry loop:
                try {
                    this.pc.close();
                } catch {}
                this.pc = null;
                // The retry loop is outside; we simulate failure by restarting via connectOnceWithRetries:
                // But we can't throw from setInterval; instead we trigger an async reconnect:
                this.reconnectAsync(`watchdog ${st}`);
            }
        }, 1500);
    }

    reconnectAsync(reason) {
        if (this._reconnecting) return;
        this._reconnecting = true;

        (async () => {
            if (this.closed) return;
            this.setStatus('reconnecting', `Reconnecting (${reason})`);

            // Clean up pc first
            if (this.pc) {
                try { this.pc.close(); } catch {}
                this.pc = null;
            }
            this.stopTimers();

            try {
                await this.connectOnceWithRetries();
            } catch {
                // status already set to error by retry loop
            } finally {
                this._reconnecting = false;
            }
        })();
    }

    updateMetricsFromStats(report) {
        // Parse outbound-rtp video stats
        let outbound = null;
        let remote = null;

        report.forEach(stat => {
            if (stat.type === 'outbound-rtp' && stat.kind === 'video') outbound = stat;
            if (stat.type === 'remote-inbound-rtp' && stat.kind === 'video') remote = stat;
        });

        const now = performance.now();
        const dt = Math.max(0.001, (now - this.lastStatAt) / 1000);
        this.lastStatAt = now;

        if (outbound) {
            const bytes = outbound.bytesSent || 0;
            const packets = outbound.packetsSent || 0;
            const framesEncoded = outbound.framesEncoded || 0;

            const bytesDelta = Math.max(0, bytes - this.lastBytesSent);
            this.lastBytesSent = bytes;

            this.metrics.bytesSent = bytes;
            this.metrics.packetsSent = packets;
            this.metrics.framesEncoded = framesEncoded;
            this.metrics.outboundBitrateBps = Math.floor((bytesDelta * 8) / dt);

            // Some browsers expose framesPerSecond on track stats; fallback simple est.
            if (typeof outbound.framesPerSecond === 'number') {
                this.metrics.framesPerSecond = outbound.framesPerSecond;
            }
        }

        if (remote) {
            if (typeof remote.roundTripTime === 'number') {
                this.metrics.roundTripTimeMs = Math.floor(remote.roundTripTime * 1000);
            }
            if (typeof remote.jitter === 'number') {
                this.metrics.jitterMs = Math.floor(remote.jitter * 1000);
            }
        }

        this.metrics.lastStateAt = Date.now();
    }

    setStatus(status, message) {
        this.status = status;
        this.metrics.lastStateAt = Date.now();
        if (message) this.lastMessage = message;
        this.emitState(message);
    }

    emitState(message) {
        this.emit({
            key: this.opts.key,
            status: this.status,
            message: message || this.lastMessage || '',
            metrics: { ...this.metrics },
            detail: {
                pcState: this.lastPcState || (this.pc ? this.pc.connectionState : ''),
                iceState: this.lastIceState || (this.pc ? this.pc.iceConnectionState : '')
            }
        });
    }
}

function normalizeOptions(opts) {
    const o = { ...opts };

    o.key = String(o.key || '').trim();
    o.label = String(o.label || o.key || 'stream').trim();
    o.outputType = String(o.outputType || 'whip').toLowerCase();
    o.endpointUrl = String(o.endpointUrl || '').trim();

    if (!o.sourceElement) throw new Error('Missing sourceElement');

    // HTTP streaming doesn't require endpoint for initial setup (bridge auto-starts on first frame)
    if (o.outputType !== 'http' && !o.endpointUrl) {
        throw new Error('Missing endpointUrl');
    }

    o.width = clampInt(o.width, 16, 7680, 1280);
    o.height = clampInt(o.height, 16, 4320, 720);
    o.fps = clampInt(o.fps, 5, 120, 30);

    o.adaptive = !!o.adaptive;

    o.maxRetries = clampInt(o.maxRetries ?? 12, 0, 100, 12);
    o.retryBaseMs = clampInt(o.retryBaseMs ?? 500, 100, 60_000, 500);
    o.retryMaxMs = clampInt(o.retryMaxMs ?? 10_000, 100, 120_000, 10_000);

    o.bearerToken = o.bearerToken ? String(o.bearerToken) : '';
    o.jpegQuality = typeof o.jpegQuality === 'number' ? Math.max(0.1, Math.min(1.0, o.jpegQuality)) : 0.8;

    return o;
}

function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function jitter(ms) {
    const r = 0.2 * ms;
    return ms + (Math.random() * 2 - 1) * r;
}

function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForIceGathering(pc, timeoutMs) {
    if (!pc) return;
    if (pc.iceGatheringState === 'complete') return;

    await new Promise(resolve => {
        const t = setTimeout(() => {
            cleanup();
            resolve();
        }, timeoutMs);

        const onChange = () => {
            if (pc.iceGatheringState === 'complete') {
                cleanup();
                resolve();
            }
        };

        const cleanup = () => {
            clearTimeout(t);
            try {
                pc.removeEventListener('icegatheringstatechange', onChange);
            } catch {}
        };

        try {
            pc.addEventListener('icegatheringstatechange', onChange);
        } catch {
            clearTimeout(t);
            resolve();
        }
    });
}

async function safeReadText(res) {
    try {
        return await res.text();
    } catch {
        return '';
    }
}

function safeDrawContain(ctx, el, width, height) {
    if (!ctx || !el) return;
    const srcW = getElW(el);
    const srcH = getElH(el);
    if (!srcW || !srcH) return;

    const scale = Math.min(width / srcW, height / srcH);
    const dw = Math.floor(srcW * scale);
    const dh = Math.floor(srcH * scale);
    const dx = Math.floor((width - dw) / 2);
    const dy = Math.floor((height - dh) / 2);

    try {
        ctx.drawImage(el, dx, dy, dw, dh);
    } catch {}
}

function getElW(el) {
    if (el instanceof HTMLVideoElement) return el.videoWidth || 0;
    if (el instanceof HTMLImageElement) return el.naturalWidth || 0;
    if (el instanceof HTMLCanvasElement) return el.width || 0;
    return 0;
}

function getElH(el) {
    if (el instanceof HTMLVideoElement) return el.videoHeight || 0;
    if (el instanceof HTMLImageElement) return el.naturalHeight || 0;
    if (el instanceof HTMLCanvasElement) return el.height || 0;
    return 0;
}
