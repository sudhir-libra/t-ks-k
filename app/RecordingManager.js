export class RecordingManager {
    constructor(onStateChange = () => {}) {
        this.onStateChange = onStateChange;
        this.sessions = new Map();
    }

    isSupported() {
        return typeof MediaRecorder !== 'undefined';
    }

    isRecording(key) {
        return this.sessions.has(key);
    }

    resolveFormat(formatKey = 'auto') {
        const support = mime => MediaRecorder.isTypeSupported(mime);
        const options = {
            'webm-vp9': {
                mimeCandidates: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9'],
                ext: 'webm'
            },
            'webm-vp8': {
                mimeCandidates: ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'],
                ext: 'webm'
            },
            'mp4-h264': {
                mimeCandidates: ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'],
                ext: 'mp4'
            },
            auto: {
                mimeCandidates: [
                    'video/webm;codecs=vp9,opus',
                    'video/webm;codecs=vp8,opus',
                    'video/webm',
                    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
                    'video/mp4'
                ],
                ext: 'webm'
            }
        };
        const chosen = options[formatKey] || options.auto;
        for (const mime of chosen.mimeCandidates) {
            if (support(mime)) {
                const ext = mime.includes('mp4') ? 'mp4' : 'webm';
                return { mimeType: mime, ext };
            }
        }
        return { mimeType: '', ext: chosen.ext || 'webm' };
    }

    getQualityProfile(qualityKey = 'medium') {
        const profiles = {
            low: { videoBps: 4_000_000, audioBps: 96_000 },
            medium: { videoBps: 8_000_000, audioBps: 128_000 },
            high: { videoBps: 12_000_000, audioBps: 192_000 }
        };
        return profiles[qualityKey] || profiles.medium;
    }

    composeFileName(baseName, ext = 'webm') {
        const safeBase = (baseName || 'source').replace(/[^a-zA-Z0-9_-]+/g, '_');
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        return `${safeBase}_${stamp}.${ext}`;
    }

    isDrawable(el) {
        if (!el) return false;
        if (el instanceof HTMLVideoElement) return el.readyState >= 2;
        if (el instanceof HTMLImageElement) return el.complete;
        if (el instanceof HTMLCanvasElement) return true;
        return false;
    }

    drawOverlayLayer(ctx, canvas, layer) {
        if (!layer || !layer.element || !layer.settings) return;
        const element = layer.element;
        if (!this.isDrawable(element)) return;
        const s = layer.settings;
        if (s.visible === false) return;
        const opacity = Math.max(0, Math.min(1, Number(s.opacity ?? 1)));
        if (opacity <= 0) return;

        const w = canvas.width;
        const h = canvas.height;
        const tx = Number(s.translateX || 0);
        const ty = Number(s.translateY || 0);
        const sx = Number(s.scaleX || 1);
        const sy = Number(s.scaleY || 1);
        const rz = Number(s.rotateZ || 0) * (Math.PI / 180);

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.translate(w / 2 + tx, h / 2 + ty);
        ctx.rotate(rz);
        ctx.scale(sx, sy);
        ctx.drawImage(element, -w / 2, -h / 2, w, h);
        ctx.restore();
    }

    createBufferedDrawPipeline(source, width, height, fps, overlaysProvider = null, onStats = null) {
        const ingestCanvas = document.createElement('canvas');
        ingestCanvas.width = width;
        ingestCanvas.height = height;
        const ingestCtx = ingestCanvas.getContext('2d');

        const encodeCanvas = document.createElement('canvas');
        encodeCanvas.width = width;
        encodeCanvas.height = height;
        const encodeCtx = encodeCanvas.getContext('2d');

        let rafId = 0;
        let intervalId = 0;
        let alive = true;
        let encodeFps = Math.max(1, Math.floor(fps || 30));
        let frameMs = Math.max(8, Math.round(1000 / encodeFps));
        let expectedNextTs = performance.now() + frameMs;
        let ingestFrames = 0;
        let encodeFrames = 0;
        let lateFrames = 0;
        let maxLagMs = 0;
        let lastStatsTs = performance.now();
        let frameNotifier = null;

        const ingestFrame = () => {
            if (!alive) return;
            ingestCtx.clearRect(0, 0, width, height);
            if (this.isDrawable(source)) {
                ingestCtx.drawImage(source, 0, 0, width, height);
            }

            if (typeof overlaysProvider === 'function') {
                const layers = overlaysProvider() || [];
                for (const layer of layers) {
                    this.drawOverlayLayer(ingestCtx, ingestCanvas, layer);
                }
            }

            ingestFrames += 1;
            rafId = requestAnimationFrame(ingestFrame);
        };
        ingestFrame();

        const startEncodeLoop = () => {
            if (intervalId) clearTimeout(intervalId);
            expectedNextTs = performance.now() + frameMs;
            const schedule = () => {
                if (!alive) return;
                const now = performance.now();
                const delay = Math.max(0, expectedNextTs - now);
                intervalId = setTimeout(() => {
                    if (!alive) return;
                    const tick = performance.now();
                    const lag = Math.max(0, tick - expectedNextTs);
                    expectedNextTs += frameMs;
                    if (lag > frameMs * 0.35) lateFrames += 1;
                    if (lag > maxLagMs) maxLagMs = lag;
                    if (lag > frameMs * 2) {
                        expectedNextTs = tick + frameMs;
                    }

                    encodeCtx.clearRect(0, 0, width, height);
                    encodeCtx.drawImage(ingestCanvas, 0, 0, width, height);
                    encodeFrames += 1;

                    if (frameNotifier && typeof frameNotifier.requestFrame === 'function') {
                        try {
                            frameNotifier.requestFrame();
                        } catch { }
                    }

                    if (typeof onStats === 'function' && tick - lastStatsTs >= 1000) {
                        const elapsedSec = Math.max(0.001, (tick - lastStatsTs) / 1000);
                        onStats({
                            encodeFps: encodeFrames / elapsedSec,
                            ingestFps: ingestFrames / elapsedSec,
                            lateFrames,
                            maxLagMs
                        });
                        ingestFrames = 0;
                        encodeFrames = 0;
                        lateFrames = 0;
                        maxLagMs = 0;
                        lastStatsTs = tick;
                    }
                    schedule();
                }, delay);
            };
            schedule();
        };
        startEncodeLoop();

        return {
            outputCanvas: encodeCanvas,
            setFps: nextFps => {
                encodeFps = Math.max(1, Math.floor(nextFps || encodeFps));
                frameMs = Math.max(8, Math.round(1000 / encodeFps));
                startEncodeLoop();
                if (frameNotifier && typeof frameNotifier.applyConstraints === 'function') {
                    try { frameNotifier.applyConstraints({ frameRate: encodeFps }); } catch { }
                }
                return encodeFps;
            },
            getFps: () => encodeFps,
            setFrameNotifier: track => {
                frameNotifier = track || null;
                if (frameNotifier && typeof frameNotifier.applyConstraints === 'function') {
                    try { frameNotifier.applyConstraints({ frameRate: encodeFps }); } catch { }
                }
            },
            stop: () => {
                alive = false;
                if (rafId) cancelAnimationFrame(rafId);
                if (intervalId) clearTimeout(intervalId);
            }
        };
    }

    async start(options) {
        const {
            key,
            label,
            sourceElement,
            width,
            height,
            fps,
            directoryHandle,
            formatKey,
            audioTrack,
            overlaysProvider,
            qualityKey,
            adaptive
        } = options;

        if (!this.isSupported()) throw new Error('MediaRecorder not supported in this browser');
        if (this.sessions.has(key)) return this.sessions.get(key);
        if (!sourceElement) throw new Error('Missing recording source');

        const outW = Math.max(2, Math.floor(width));
        const outH = Math.max(2, Math.floor(height));
        const outFps = Math.max(1, Math.floor(fps || 30));

        const quality = this.getQualityProfile(qualityKey || 'medium');
        const adaptiveEnabled = adaptive !== false;
        const fpsSteps = [60, 50, 40, 30, 24, 20, 15, 12].filter(x => x <= outFps).sort((a, b) => b - a);
        let fpsStepIndex = Math.max(0, fpsSteps.findIndex(x => x === outFps));
        let badWindows = 0;

        const pipeline = this.createBufferedDrawPipeline(
            sourceElement,
            outW,
            outH,
            outFps,
            overlaysProvider,
            stats => {
                if (adaptiveEnabled) {
                    const overload = stats.lateFrames >= 6 || stats.maxLagMs > 45;
                    if (overload) badWindows += 1;
                    else badWindows = 0;

                    if (badWindows >= 2 && fpsStepIndex < fpsSteps.length - 1) {
                        fpsStepIndex += 1;
                        const nextFps = fpsSteps[fpsStepIndex];
                        pipeline.setFps(nextFps);
                        badWindows = 0;
                        this.onStateChange({ key, status: 'adaptive', nextFps });
                    }
                }
                this.onStateChange({
                    key,
                    status: 'stats',
                    stats: {
                        ...stats,
                        targetFps: pipeline.getFps()
                    }
                });
            }
        );
        const videoStream = pipeline.outputCanvas.captureStream(pipeline.getFps());
        const mergedTracks = [...videoStream.getVideoTracks()];
        const mainTrack = mergedTracks[0];
        if (mainTrack) {
            pipeline.setFrameNotifier(mainTrack);
        }
        if (audioTrack) mergedTracks.push(audioTrack);
        const stream = new MediaStream(mergedTracks);
        if (mainTrack) {
            await waitForLiveTrack(mainTrack, 500);
        }
        if (audioTrack) {
            await waitForLiveTrack(audioTrack, 800);
        }
        const format = this.resolveFormat(formatKey || 'auto');
        const recorderOptions = format.mimeType ? { mimeType: format.mimeType } : {};
        recorderOptions.videoBitsPerSecond = quality.videoBps;
        recorderOptions.audioBitsPerSecond = quality.audioBps;
        const recorder = new MediaRecorder(stream, recorderOptions);
        const chunks = [];
        const fileName = this.composeFileName(label, format.ext);
        const session = {
            key,
            label,
            fileName,
            format,
            quality: qualityKey || 'medium',
            recorder,
            stream,
            videoStream,
            stopDraw: pipeline.stop,
            chunks,
            writable: null,
            writeQueue: Promise.resolve(),
            done: null
        };

        if (directoryHandle) {
            const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
            session.writable = await fileHandle.createWritable();
        }

        recorder.ondataavailable = e => {
            if (!e.data || e.data.size === 0) return;
            if (session.writable) {
                session.writeQueue = session.writeQueue.then(() => session.writable.write(e.data)).catch(() => {});
            } else {
                chunks.push(e.data);
            }
        };

        session.done = new Promise(resolve => {
            recorder.onstop = async () => {
                try {
                    await session.writeQueue;
                    if (session.writable) {
                        await session.writable.close();
                    } else if (chunks.length > 0) {
                        const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = fileName;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 3000);
                    }
                } finally {
                    session.stopDraw();
                    stream.getTracks().forEach(t => t.stop());
                    if (session.videoStream) session.videoStream.getTracks().forEach(t => t.stop());
                    this.sessions.delete(key);
                    this.onStateChange({ key, status: 'stopped', fileName });
                    resolve();
                }
            };
        });

        recorder.start(250);
        this.sessions.set(key, session);
        this.onStateChange({
            key,
            status: 'recording',
            fileName,
            mimeType: recorder.mimeType || format.mimeType || 'default',
            quality: session.quality,
            targetFps: pipeline.getFps()
        });
        return session;
    }

    async stop(key) {
        const session = this.sessions.get(key);
        if (!session) return;
        if (session.recorder.state !== 'inactive') {
            session.recorder.stop();
        }
        await session.done;
    }
}

function waitForLiveTrack(track, timeoutMs = 500) {
    if (!track) return Promise.resolve();
    if (track.readyState === 'live' && track.enabled) return Promise.resolve();
    return new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            cleanup();
            resolve();
        };
        const cleanup = () => {
            clearTimeout(t);
            track.removeEventListener?.('unmute', onUnmute);
        };
        const onUnmute = () => finish();
        const t = setTimeout(() => finish(), timeoutMs);
        try {
            track.addEventListener('unmute', onUnmute);
        } catch {
            finish();
        }
    });
}
