import { Engine } from '../core/Engine.js';
import { CanvasBackend } from '../render/Backends/CanvasBackend.js';
import { WebGL2Backend } from '../render/Backends/WebGL2Backend.js';
import { InputNode } from '../nodes/InputNode.js';
import { RealtimePreviewRenderer } from './RealtimePreviewRenderer.js';
import { BrowserLiveModule } from './BrowserLiveModule.js';
import { RecordingManager } from './RecordingManager.js';
import { StreamingModule } from './StreamingModule.js';

export class AppController {
    constructor() {
        this.engine = new Engine();
        this.canvas = null;
        this.layoutDirectoryHandle = null;
        this.sources = [];
        this.gridConfig = { inputs: 4, aux: 4, overlays: 4 };
        this.inputSlots = new Array(this.gridConfig.inputs).fill(null);
        this.sourceMutes = new Array(this.gridConfig.inputs).fill(false);
        this.auxSlots = new Array(this.gridConfig.aux).fill(null);
        this.overlaySlots = new Array(this.gridConfig.overlays).fill(null);
        this.overlayPreviewActive = new Array(this.gridConfig.overlays).fill(false);
        this.overlayProgramActive = new Array(this.gridConfig.overlays).fill(false);
        this.inputSlotEls = [];
        this.auxSlotEls = [];
        this.overlaySlotEls = [];
        this.inputPreviewRenderers = [];
        this.auxPreviewRenderers = [];
        this.overlayPreviewRenderers = [];
        this.previewEngine = null;
        this.previewCanvas = null;
        this.programMirrorCanvas = null;
        this.programMirrorCtx = null;
        this.programMirrorRaf = null;
        this.browserModule = null;
        this.activeProgramId = null;
        this.activePreviewId = null;
        this.selectedSourceId = null;
        this.selectedAuxIndex = null;
        this.currentInputNode = null;
        this.contextSlotIndex = null;
        this.overlayContextSlotIndex = null;
        this.selectedOverlayIndex = null;
        this.cgClipboardSettings = null;
        this.recordingManager = new RecordingManager(state => this.onRecordingStateChange(state));
        this.streamingModule = new StreamingModule(state => this.onStreamingStateChange(state));
        this.streamingDirectoryHandle = null;
        this.recordingDirectoryHandle = null;
        this.audioContext = null;
        this.sourceAudioGraphs = new Map();
        this.audioMeterRaf = null;
        this.programRecordAudioBus = null;
        this.programRecordAudioCurrentSourceId = null;
        this.sourceSeed = 1;
        this.autoTimer = null;

        // Assets state
        this.assetFolders = [];

        // Activity bar state
        this.activityBarExpanded = false;
        this.hiddenIcons = new Set();
        this.iconOrder = ['settings-source', 'settings-chroma', 'settings-cg', 'settings-recording', 'settings-streaming', 'settings-assets', 'settings-workspace', 'settings-preferences'];
        this.mediaViewMode = 'tree'; // 'tree' or 'grid'
        this.thumbnailCache = new Map(); // path -> blobUrl
        this.grid = null;

        // Load persisted state
        this.loadPersistedState();
    }

    async init() {
        this.canvas = document.getElementById('outputCanvas');
        this.initGridStack();
        this.bindGlobalUi();
        this.initMovableSidePanels();
        this.buildInputBus();
        this.buildAuxRouter();
        this.buildOverlayBus();
        this.initBrowserModule();
        this.bindAssetsControls();
        await this.initEngineWithDefaultWebGL();
        this.initProgramMirror();
        this.startAudioMeterLoop();

        this.engine.on('STATE_UPDATED', state => {
            this.activeProgramId = state.programNodeId;
            this.activePreviewId = state.previewNodeId;
            if (this.recordingManager.isRecording('program')) {
                this.setProgramRecordingAudioSource(this.activeProgramId);
            }
            this.renderProgramPreview();
            this.syncPreviewEngineSource();
            this.refreshInputBus();
            this.refreshAuxRouter();
            this.renderOverlayTargets();
        });

        this.createBootstrapSource();
    }

    async initEngineWithDefaultWebGL() {
        const selector = document.getElementById('rendererSelect');
        this.previewCanvas = document.getElementById('previewDisplayCanvas');
        this.previewEngine = new Engine();

        try {
            await this.engine.init(this.canvas, new WebGL2Backend());
            await this.previewEngine.init(this.previewCanvas, new WebGL2Backend());
            selector.value = 'webgl2';
        } catch {
            await this.engine.init(this.canvas, new CanvasBackend());
            await this.previewEngine.init(this.previewCanvas, new CanvasBackend());
            selector.value = 'canvas';
        }
        this.engine.start();
        this.previewEngine.start();
    }

    initGridStack() {
        if (!window.GridStack) return;
        this.grid = window.GridStack.init({
            float: false,
            margin: 8,
            cellHeight: 120,
            column: 12,
            disableOneColumnMode: true,
            resizable: { handles: 'all' }
        }, '#centerGrid');
    }

    bindTabs() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(x => x.classList.remove('active'));
                document.querySelectorAll('.tab-view').forEach(x => x.classList.remove('active'));
                btn.classList.add('active');
                const target = document.getElementById(btn.dataset.tab);
                if (target) target.classList.add('active');

                // Golden Layout needs a resize pass when its container is shown again.
                if (btn.dataset.tab === 'switcherTab') {
                    const gl = window.goldenLayout;
                    if (gl && typeof gl.updateRootSize === 'function') {
                        requestAnimationFrame(() => gl.updateRootSize(true));
                    }
                }
            });
        });
    }

    initProgramMirror() {
        this.programMirrorCanvas = document.getElementById('programDisplayCanvas');
        this.programMirrorCtx = this.programMirrorCanvas.getContext('2d');

        const draw = () => {
            if (
                this.programMirrorCtx &&
                this.canvas &&
                this.programMirrorCanvas.style.display !== 'none' &&
                this.canvas.style.display !== 'none'
            ) {
                this.programMirrorCtx.clearRect(0, 0, this.programMirrorCanvas.width, this.programMirrorCanvas.height);
                this.programMirrorCtx.drawImage(
                    this.canvas,
                    0,
                    0,
                    this.programMirrorCanvas.width,
                    this.programMirrorCanvas.height
                );
            }

            this.programMirrorRaf = requestAnimationFrame(draw);
        };

        draw();
    }

    buildPreviewNodeFromSource(source) {
        const node = new InputNode(`pvw-${source.id}-${Date.now()}`, source.mediaElement, source.node.backgroundVideo || null);
        node.chromaEnabled = !!source.node.chromaEnabled;
        node.setChromaType(source.chromaType || 'basic');

        const srcFilter = source.node.filters && source.node.filters[0];
        const dstFilter = node.filters && node.filters[0];

        if (srcFilter && dstFilter && srcFilter.params && dstFilter.params) {
            dstFilter.params = { ...dstFilter.params, ...JSON.parse(JSON.stringify(srcFilter.params)) };
        }

        return node;
    }

    syncPreviewEngineSource() {
        if (!this.previewEngine || !this.previewEngine.scene) return;

        const source = this.getSource(this.activePreviewId);
        if (!source) {
            this.previewEngine.scene.nodes = [];
            this.previewEngine.scene.programNodeId = null;
            this.previewEngine.scene.previewNodeId = null;
            return;
        }

        const node = this.buildPreviewNodeFromSource(source);
        this.previewEngine.scene.nodes = [node];
        this.previewEngine.scene.programNodeId = node.id;
        this.previewEngine.scene.previewNodeId = node.id;
    }

    initBrowserModule() {
        this.browserModule = new BrowserLiveModule(
            document.getElementById('browserLiveFrame'),
            document.getElementById('browserLiveTitle')
        );
    }

    getRenderableElement(sourceId) {
        const source = this.getSource(sourceId);
        return source ? source.mediaElement : null;
    }

    truncateName(text) {
        if (!text) return '';
        if (text.length <= 10) return text;
        return `${text.slice(0, 10)}...`;
    }

    bindGlobalUi() {
        this.bindTabs();
        this.bindPanelControls();
        this.bindSettingsActivityBar();
        this.bindCgControls();
        this.bindRecordingControls();
        this.bindStreamingControls();
        this.bindUiCustomizationControls();
        this.bindWorkspaceControls();
        this.bindPreferencesControls();
        this.setupCanvasObservers();
        this.bindKeyboardShortcuts();
        this.initDragAndDrop();
        this.bindDockControls();
        this.initLayoutDocking();
        this.bindActivityBarContextMenu();

        document.getElementById('rendererSelect').addEventListener('change', async e => {
            const useCanvas = e.target.value === 'canvas';
            await this.engine.setBackend(useCanvas ? new CanvasBackend() : new WebGL2Backend());
            await this.previewEngine.setBackend(useCanvas ? new CanvasBackend() : new WebGL2Backend());
            this.canvas = document.getElementById('outputCanvas');
            this.previewCanvas = document.getElementById('previewDisplayCanvas');
            this.syncPreviewEngineSource();
        });

        document.getElementById('cutBtn').addEventListener('click', () => this.doCut());
        document.getElementById('autoBtn').addEventListener('click', () => this.doAutoTransition());

        // Source widget (in left panel or settings)
        const sourceWidget = document.getElementById('sourceWidget');
        if (sourceWidget) {
            sourceWidget.addEventListener('dragstart', e => {
                e.dataTransfer.setData('application/x-switcher-action', 'create-source');
            });
        }

        // Source widget in settings panel
        const sourceWidgetSettings = document.getElementById('sourceWidgetSettings');
        if (sourceWidgetSettings) {
            sourceWidgetSettings.addEventListener('dragstart', e => {
                e.dataTransfer.setData('application/x-switcher-action', 'create-source');
            });
        }

        // Add plugin button (in settings panel)
        const addPluginBtn = document.getElementById('addPluginBtn');
        if (addPluginBtn) {
            addPluginBtn.addEventListener('click', () => {
                const list = document.getElementById('pluginList');
                if (!list) return;
                const item = document.createElement('div');
                item.className = 'plugin-item';
                item.textContent = `Plugin Module ${list.children.length + 1}`;
                list.appendChild(item);
            });
        }

        ['programDrop', 'previewDrop'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('dragover', e => e.preventDefault());
            }
        });

        const btnAddInputs = document.querySelectorAll('.add-slot-btn');
        btnAddInputs.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = btn.dataset.target;
                if (target === 'input') {
                    this.gridConfig.inputs++;
                    const inInput = document.getElementById('workspaceInputCount');
                    if (inInput) inInput.value = this.gridConfig.inputs;
                    document.getElementById('workspaceApplyGridBtn')?.click();
                } else if (target === 'aux') {
                    this.gridConfig.aux++;
                    const inAux = document.getElementById('workspaceAuxCount');
                    if (inAux) inAux.value = this.gridConfig.aux;
                    document.getElementById('workspaceApplyGridBtn')?.click();
                } else if (target === 'overlay') {
                    this.gridConfig.overlays++;
                    const inOvl = document.getElementById('workspaceOverlayCount');
                    if (inOvl) inOvl.value = this.gridConfig.overlays;
                    document.getElementById('workspaceApplyGridBtn')?.click();
                }
            });
        });

        document.getElementById('programDrop')?.addEventListener('click', () => {
            if (this.activeProgramId) this.selectSource(this.activeProgramId);
        });

        document.getElementById('previewDrop').addEventListener('click', () => {
            if (this.activePreviewId) this.selectSource(this.activePreviewId);
        });

        document.getElementById('programDrop').addEventListener('drop', e => {
            e.preventDefault();
            const sourceId = this.extractSourceFromDrop(e);
            if (sourceId) this.setProgramSource(sourceId);
        });

        document.getElementById('previewDrop').addEventListener('drop', e => {
            e.preventDefault();
            const sourceId = this.extractSourceFromDrop(e);
            if (sourceId) this.setPreviewSource(sourceId);
        });

        document.getElementById('chromaType').addEventListener('change', async e => {
            if (!this.currentInputNode || !this.selectedSourceId) return;
            const source = this.getSource(this.selectedSourceId);
            const oldType = source.chromaType;
            source.chromaType = e.target.value;
            this.saveChromaParams(oldType);
            this.currentInputNode.setChromaType(source.chromaType);
            this.loadChromaParams(source.chromaType);
            if (source.chromaEnabled) await this.ensureWebGLForChroma();
            this.updateChromaUI(source.chromaType);
            this.setupChromaControls();
            this.syncPreviewEngineSource();
        });

        document.getElementById('chromaEnable').addEventListener('change', async e => {
            if (!this.selectedSourceId) return;
            const source = this.getSource(this.selectedSourceId);
            source.chromaEnabled = e.target.checked;
            await this.applySourceChromaState(source, true);
            this.setChromaControlsDisabled(!source.chromaEnabled);
            this.refreshInputBus();
            this.syncPreviewEngineSource();
            this.refreshInputBus();
        });

        document.getElementById('sourceMute').addEventListener('change', e => {
            if (!this.selectedSourceId) return;
            const source = this.getSource(this.selectedSourceId);
            if (!source) return;
            source.audioMuted = !!e.target.checked;
            this.applySourceMuteState(source);
            this.refreshInputBus();
        });

        document.getElementById('assignBackgroundBtn').addEventListener('click', () => {
            if (!this.selectedSourceId) return;
            this.openFilePicker('video/*,image/*', file => {
                const source = this.getSource(this.selectedSourceId);
                if (!source) return;
                this.createMediaFromFile(file).then(media => {
                    if (media) source.node.backgroundVideo = media.element;
                    this.syncPreviewEngineSource();
                });
            });
        });

        document.addEventListener('click', () => {
            this.hideContextMenu();
            this.hideOverlayContextMenu();
        });
        document.querySelectorAll('#inputContextMenu button').forEach(btn => {
            btn.addEventListener('click', () => this.handleContextAction(btn.dataset.action));
        });
        document.querySelectorAll('#overlayContextMenu button').forEach(btn => {
            btn.addEventListener('click', () => this.handleOverlayContextAction(btn.dataset.action));
        });

        document.addEventListener('pointerdown', () => this.ensureAudioContext(true), { passive: true });
    }

    getDefaultOverlaySettings() {
        return {
            visible: true,
            opacity: 1,
            fadeInMs: 350,
            fadeOutMs: 350,
            scaleX: 1,
            scaleY: 1,
            scaleZ: 1,
            rotateX: 0,
            rotateY: 0,
            rotateZ: 0,
            translateX: 0,
            translateY: 0,
            translateZ: 0
        };
    }

    ensureOverlaySettings(overlay) {
        if (!overlay) return null;
        overlay.settings = { ...this.getDefaultOverlaySettings(), ...(overlay.settings || {}) };
        return overlay.settings;
    }

    bindCgControls() {
        const bindInput = (id, handler, eventName = 'input') => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener(eventName, handler);
        };

        bindInput('cgVisible', e => {
            const overlay = this.overlaySlots[this.selectedOverlayIndex];
            if (!overlay) return;
            const s = this.ensureOverlaySettings(overlay);
            s.visible = !!e.target.checked;
            this.renderOverlayTargets();
        }, 'change');

        bindInput('cgOpacity', e => {
            const overlay = this.overlaySlots[this.selectedOverlayIndex];
            if (!overlay) return;
            const s = this.ensureOverlaySettings(overlay);
            s.opacity = Math.max(0, Math.min(1, Number(e.target.value || 1)));
            document.getElementById('cgOpacityValue').textContent = s.opacity.toFixed(2);
            this.renderOverlayTargets();
        });

        bindInput('cgFadeInMs', e => this.updateSelectedOverlayNumeric('fadeInMs', e.target.value), 'change');
        bindInput('cgFadeOutMs', e => this.updateSelectedOverlayNumeric('fadeOutMs', e.target.value), 'change');
        bindInput('cgScaleX', e => this.updateSelectedOverlayNumeric('scaleX', e.target.value));
        bindInput('cgScaleY', e => this.updateSelectedOverlayNumeric('scaleY', e.target.value));
        bindInput('cgScaleZ', e => this.updateSelectedOverlayNumeric('scaleZ', e.target.value));
        bindInput('cgRotateX', e => this.updateSelectedOverlayNumeric('rotateX', e.target.value));
        bindInput('cgRotateY', e => this.updateSelectedOverlayNumeric('rotateY', e.target.value));
        bindInput('cgRotateZ', e => this.updateSelectedOverlayNumeric('rotateZ', e.target.value));
        bindInput('cgTranslateX', e => this.updateSelectedOverlayNumeric('translateX', e.target.value));
        bindInput('cgTranslateY', e => this.updateSelectedOverlayNumeric('translateY', e.target.value));
        bindInput('cgTranslateZ', e => this.updateSelectedOverlayNumeric('translateZ', e.target.value));

        const fadeInBtn = document.getElementById('cgFadeInBtn');
        if (fadeInBtn) {
            fadeInBtn.addEventListener('click', () => {
                const overlay = this.overlaySlots[this.selectedOverlayIndex];
                if (!overlay) return;
                const s = this.ensureOverlaySettings(overlay);
                s.visible = true;
                this.renderOverlayTargets();
                this.updateCgSettingsPanel();
            });
        }

        const fadeOutBtn = document.getElementById('cgFadeOutBtn');
        if (fadeOutBtn) {
            fadeOutBtn.addEventListener('click', () => {
                const overlay = this.overlaySlots[this.selectedOverlayIndex];
                if (!overlay) return;
                const s = this.ensureOverlaySettings(overlay);
                s.visible = false;
                this.renderOverlayTargets();
                this.updateCgSettingsPanel();
            });
        }

        const resetBtn = document.getElementById('cgResetBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => this.resetSelectedOverlaySrt());
        }

        const copyBtn = document.getElementById('cgCopyBtn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => this.copySelectedOverlaySettings());
        }

        const pasteBtn = document.getElementById('cgPasteBtn');
        if (pasteBtn) {
            pasteBtn.addEventListener('click', () => this.pasteToSelectedOverlaySettings());
        }

        this.bindCgDragAdjust();
        this.updateCgSettingsPanel();
    }

    updateSelectedOverlayNumeric(key, rawValue) {
        const overlay = this.overlaySlots[this.selectedOverlayIndex];
        if (!overlay) return;
        const s = this.ensureOverlaySettings(overlay);
        const nextVal = Number(rawValue);
        if (Number.isNaN(nextVal)) return;
        s[key] = nextVal;
        this.renderOverlayTargets();
    }

    setCgControlsDisabled(disabled) {
        [
            'cgVisible', 'cgOpacity', 'cgFadeInMs', 'cgFadeOutMs', 'cgFadeInBtn', 'cgFadeOutBtn',
            'cgResetBtn', 'cgCopyBtn', 'cgPasteBtn',
            'cgScaleX', 'cgScaleY', 'cgScaleZ',
            'cgRotateX', 'cgRotateY', 'cgRotateZ',
            'cgTranslateX', 'cgTranslateY', 'cgTranslateZ'
        ].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = disabled;
        });
    }

    bindCgDragAdjust() {
        const ids = [
            'cgScaleX', 'cgScaleY', 'cgScaleZ',
            'cgRotateX', 'cgRotateY', 'cgRotateZ',
            'cgTranslateX', 'cgTranslateY', 'cgTranslateZ'
        ];

        ids.forEach(id => {
            const input = document.getElementById(id);
            if (!input) return;

            input.style.cursor = 'ew-resize';
            input.title = 'Drag left/right for fast update';

            input.addEventListener('pointerdown', ev => {
                if (ev.button !== 0) return;
                const startX = ev.clientX;
                const startValue = Number(input.value || 0);
                const step = Number(input.step || 1);
                const baseFactor = id.startsWith('cgTranslate') ? 1 : 0.05;

                input.setPointerCapture(ev.pointerId);

                const onMove = moveEv => {
                    const dx = moveEv.clientX - startX;
                    const speed = moveEv.shiftKey ? 0.2 : (moveEv.ctrlKey ? 5 : 1);
                    const delta = dx * step * baseFactor * speed;
                    const next = startValue + delta;
                    input.value = String(next);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                };

                const onUp = upEv => {
                    input.releasePointerCapture(upEv.pointerId);
                    input.removeEventListener('pointermove', onMove);
                    input.removeEventListener('pointerup', onUp);
                    input.removeEventListener('pointercancel', onUp);
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                };

                input.addEventListener('pointermove', onMove);
                input.addEventListener('pointerup', onUp);
                input.addEventListener('pointercancel', onUp);
            });
        });
    }

    resetSelectedOverlaySrt() {
        const overlay = this.overlaySlots[this.selectedOverlayIndex];
        if (!overlay) return;
        const s = this.ensureOverlaySettings(overlay);
        s.scaleX = 1;
        s.scaleY = 1;
        s.scaleZ = 1;
        s.rotateX = 0;
        s.rotateY = 0;
        s.rotateZ = 0;
        s.translateX = 0;
        s.translateY = 0;
        s.translateZ = 0;
        this.updateCgSettingsPanel();
        this.renderOverlayTargets();
    }

    copySelectedOverlaySettings() {
        const overlay = this.overlaySlots[this.selectedOverlayIndex];
        if (!overlay) return;
        this.cgClipboardSettings = JSON.parse(JSON.stringify(this.ensureOverlaySettings(overlay)));
    }

    pasteToSelectedOverlaySettings() {
        const overlay = this.overlaySlots[this.selectedOverlayIndex];
        if (!overlay || !this.cgClipboardSettings) return;
        overlay.settings = {
            ...this.getDefaultOverlaySettings(),
            ...JSON.parse(JSON.stringify(this.cgClipboardSettings))
        };
        this.updateCgSettingsPanel();
        this.renderOverlayTargets();
    }

    selectOverlaySlot(slotIndex) {
        this.selectedOverlayIndex = slotIndex;
        this.refreshOverlayBus();
        this.updateCgSettingsPanel();
    }

    updateCgSettingsPanel() {
        const overlay = this.selectedOverlayIndex !== null ? this.overlaySlots[this.selectedOverlayIndex] : null;
        const name = document.getElementById('cgLayerName');
        if (!name) return;

        if (!overlay) {
            name.textContent = 'No overlay selected';
            this.setCgControlsDisabled(true);
            document.getElementById('cgOpacityValue').textContent = '0.00';
            return;
        }

        const s = this.ensureOverlaySettings(overlay);
        name.textContent = `OVL ${this.selectedOverlayIndex + 1} · ${overlay.label || 'Layer'}`;
        this.setCgControlsDisabled(false);

        document.getElementById('cgVisible').checked = !!s.visible;
        document.getElementById('cgOpacity').value = String(s.opacity);
        document.getElementById('cgOpacityValue').textContent = Number(s.opacity).toFixed(2);
        document.getElementById('cgFadeInMs').value = String(s.fadeInMs);
        document.getElementById('cgFadeOutMs').value = String(s.fadeOutMs);
        document.getElementById('cgScaleX').value = String(s.scaleX);
        document.getElementById('cgScaleY').value = String(s.scaleY);
        document.getElementById('cgScaleZ').value = String(s.scaleZ);
        document.getElementById('cgRotateX').value = String(s.rotateX);
        document.getElementById('cgRotateY').value = String(s.rotateY);
        document.getElementById('cgRotateZ').value = String(s.rotateZ);
        document.getElementById('cgTranslateX').value = String(s.translateX);
        document.getElementById('cgTranslateY').value = String(s.translateY);
        document.getElementById('cgTranslateZ').value = String(s.translateZ);
    }

    ensureAudioContext(resume = false) {
        if (!window.AudioContext && !window.webkitAudioContext) return null;
        if (!this.audioContext) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            try {
                this.audioContext = new Ctx({ latencyHint: 'interactive', sampleRate: 48000 });
            } catch {
                this.audioContext = new Ctx();
            }
        }
        if (resume && this.audioContext.state === 'suspended') {
            this.audioContext.resume().catch(() => { });
        }
        return this.audioContext;
    }

    ensureSourceAudioGraph(source) {
        if (!source) return null;
        const media = source.audioElement || source.mediaElement;
        if (!(media instanceof HTMLMediaElement)) return null;
        const ctx = this.ensureAudioContext();
        if (!ctx) return null;
        media.playsInline = true;
        media.muted = !!source.audioMuted;
        if (typeof media.volume === 'number') media.volume = source.audioMuted ? 0 : 1;
        if (media.paused) media.play().catch(() => { });

        if (this.sourceAudioGraphs.has(source.id)) {
            const existing = this.sourceAudioGraphs.get(source.id);
            if (existing.media === media) return existing;
        }

        try {
            const mediaSource = ctx.createMediaElementSource(media);
            const gain = ctx.createGain();
            const splitter = ctx.createChannelSplitter(2);
            const analyserL = ctx.createAnalyser();
            const analyserR = ctx.createAnalyser();
            const destination = ctx.createMediaStreamDestination();
            const monitorTap = ctx.createGain();
            analyserL.fftSize = 256;
            analyserR.fftSize = 256;
            monitorTap.gain.value = 0.0001;

            mediaSource.connect(gain);
            gain.connect(splitter);
            splitter.connect(analyserL, 0);
            splitter.connect(analyserR, 1);
            gain.connect(destination);
            gain.connect(monitorTap);
            monitorTap.connect(ctx.destination);

            const graph = { media, mode: 'element', gain, analyserL, analyserR, destination, monitorTap };
            this.sourceAudioGraphs.set(source.id, graph);
            this.applySourceMuteState(source);
            return graph;
        } catch {
            try {
                const capture = media.captureStream || media.mozCaptureStream;
                if (typeof capture !== 'function') return null;
                const mediaStream = capture.call(media);
                const audioTracks = mediaStream.getAudioTracks();
                if (!audioTracks.length) return null;

                const streamSource = ctx.createMediaStreamSource(mediaStream);
                const gain = ctx.createGain();
                const splitter = ctx.createChannelSplitter(2);
                const analyserL = ctx.createAnalyser();
                const analyserR = ctx.createAnalyser();
                const destination = ctx.createMediaStreamDestination();
                const monitorTap = ctx.createGain();
                analyserL.fftSize = 256;
                analyserR.fftSize = 256;
                monitorTap.gain.value = 0.0001;

                streamSource.connect(gain);
                gain.connect(splitter);
                splitter.connect(analyserL, 0);
                splitter.connect(analyserR, 1);
                gain.connect(destination);
                gain.connect(monitorTap);
                monitorTap.connect(ctx.destination);

                const graph = {
                    media,
                    mode: 'stream',
                    sourceStream: mediaStream,
                    gain,
                    analyserL,
                    analyserR,
                    destination,
                    monitorTap
                };
                this.sourceAudioGraphs.set(source.id, graph);
                this.applySourceMuteState(source);
                return graph;
            } catch {
                return null;
            }
        }
    }

    applySourceMuteState(source) {
        const graph = this.ensureSourceAudioGraph(source);
        if (!graph) return;
        graph.gain.gain.value = source.audioMuted ? 0 : 1;
        const media = graph.media;
        if (media instanceof HTMLMediaElement) {
            media.muted = !!source.audioMuted;
            if (typeof media.volume === 'number') media.volume = source.audioMuted ? 0 : 1;
            if (media.paused) media.play().catch(() => { });
        }
        if (this.programRecordAudioCurrentSourceId === source.id) {
            this.setProgramRecordingAudioSource(this.programRecordAudioCurrentSourceId);
        }
    }

    getSourceMeterLevels(sourceId) {
        const source = this.getSource(sourceId);
        if (!source) return { left: 0, right: 0, muted: true };
        const graph = this.ensureSourceAudioGraph(source);
        if (!graph) return { left: 0, right: 0, muted: !!source.audioMuted };

        const bufL = new Uint8Array(graph.analyserL.frequencyBinCount);
        const bufR = new Uint8Array(graph.analyserR.frequencyBinCount);
        graph.analyserL.getByteFrequencyData(bufL);
        graph.analyserR.getByteFrequencyData(bufR);

        const avg = arr => (arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : 0);
        const left = avg(bufL) / 255;
        const right = avg(bufR) / 255;
        return { left, right, muted: !!source.audioMuted };
    }

    setAudioMeterLevel(meterEl, left, right, muted) {
        if (!meterEl) return;
        const bars = meterEl.querySelectorAll('.bar');
        if (bars.length < 2) return;
        meterEl.classList.toggle('is-muted', !!muted);
        const clamp = v => Math.max(0, Math.min(100, Math.round(v * 100)));
        bars[0].style.height = muted ? '2px' : `${clamp(left)}%`;
        bars[1].style.height = muted ? '2px' : `${clamp(right)}%`;
    }

    updateAudioMeters() {
        this.inputSlotEls.forEach((entry, i) => {
            const sourceId = this.inputSlots[i];
            const lv = sourceId ? this.getSourceMeterLevels(sourceId) : { left: 0, right: 0, muted: true };
            this.setAudioMeterLevel(entry.audioMeter, lv.left, lv.right, lv.muted);
        });

        this.auxSlotEls.forEach((entry, i) => {
            const sourceId = this.auxSlots[i];
            const lv = sourceId ? this.getSourceMeterLevels(sourceId) : { left: 0, right: 0, muted: true };
            this.setAudioMeterLevel(entry.audioMeter, lv.left, lv.right, lv.muted);
        });

        this.overlaySlotEls.forEach((entry, i) => {
            const overlay = this.overlaySlots[i];
            // If overlay is active or has media, try to get levels? 
            // Most overlays might not have audio, but some might.
            const lv = (overlay && overlay.id) ? this.getSourceMeterLevels(overlay.id) : { left: 0, right: 0, muted: true };
            this.setAudioMeterLevel(entry.audioMeter, lv.left, lv.right, lv.muted);
        });

        const pvwLv = this.activePreviewId ? this.getSourceMeterLevels(this.activePreviewId) : { left: 0, right: 0, muted: true };
        this.setAudioMeterLevel(document.getElementById('previewAudioMeter'), pvwLv.left, pvwLv.right, pvwLv.muted);

        const pgmLv = this.activeProgramId ? this.getSourceMeterLevels(this.activeProgramId) : { left: 0, right: 0, muted: true };
        this.setAudioMeterLevel(document.getElementById('programAudioMeter'), pgmLv.left, pgmLv.right, pgmLv.muted);
        this.setAudioMeterLevel(document.getElementById('masterAudioMeter'), pgmLv.left, pgmLv.right, pgmLv.muted);
    }

    startAudioMeterLoop() {
        const tick = () => {
            this.updateAudioMeters();
            this.audioMeterRaf = requestAnimationFrame(tick);
        };
        tick();
    }

    getSourceAudioTrackForRecording(source, preferDirect = true) {
        if (!source || source.audioMuted) return null;
        let directTrack = null;
        if (source.mediaStream instanceof MediaStream) {
            const t = source.mediaStream.getAudioTracks()[0];
            if (t) directTrack = t;
        }
        const media = source.audioElement || source.mediaElement;
        if (!directTrack && media instanceof HTMLMediaElement) {
            const capture = media.captureStream || media.mozCaptureStream;
            if (typeof capture === 'function') {
                try {
                    const track = capture.call(media).getAudioTracks()[0];
                    if (track) directTrack = track;
                } catch { }
            }
        }
        if (directTrack) return directTrack.clone();
        const graph = this.ensureSourceAudioGraph(source);
        if (graph) {
            const t = graph.destination.stream.getAudioTracks()[0];
            if (t) return t.clone();
        }
        return null;
    }

    ensureProgramRecordAudioBus() {
        const ctx = this.ensureAudioContext(true);
        if (!ctx) return null;
        if (this.programRecordAudioBus) return this.programRecordAudioBus;
        const destination = ctx.createMediaStreamDestination();
        const inputGain = ctx.createGain();
        inputGain.gain.value = 1;
        inputGain.connect(destination);
        this.programRecordAudioBus = {
            destination,
            inputGain,
            currentNode: null
        };
        return this.programRecordAudioBus;
    }

    setProgramRecordingAudioSource(sourceId) {
        const bus = this.ensureProgramRecordAudioBus();
        if (!bus) return;

        if (bus.currentNode) {
            try { bus.currentNode.disconnect(bus.inputGain); } catch { }
            bus.currentNode = null;
        }

        this.programRecordAudioCurrentSourceId = sourceId || null;
        if (!sourceId) return;
        const source = this.getSource(sourceId);
        if (!source || source.audioMuted) return;
        const graph = this.ensureSourceAudioGraph(source);
        if (!graph) return;

        const ctx = this.ensureAudioContext(true);
        if (!ctx) return;
        if (!graph.recordBusNode) {
            try {
                graph.recordBusNode = ctx.createMediaStreamSource(graph.destination.stream);
            } catch {
                graph.recordBusNode = null;
            }
        }
        if (!graph.recordBusNode) return;
        graph.recordBusNode.connect(bus.inputGain);
        bus.currentNode = graph.recordBusNode;
    }

    getProgramRecordingAudioTrack() {
        const source = this.getSource(this.activeProgramId);
        if (source) {
            const direct = this.getSourceAudioTrackForRecording(source, true);
            if (direct) return direct;
        }
        const bus = this.ensureProgramRecordAudioBus();
        if (!bus) return null;
        this.setProgramRecordingAudioSource(this.activeProgramId);
        const track = bus.destination.stream.getAudioTracks()[0];
        return track ? track.clone() : null;
    }

    bindRecordingControls() {
        const pickBtn = document.getElementById('recordPickPathBtn');
        if (pickBtn) pickBtn.addEventListener('click', () => this.pickRecordingPath());

        const targetSelect = document.getElementById('recordTarget');
        if (targetSelect) targetSelect.addEventListener('change', () => this.updateRecordingTargetUi());

        const startBtn = document.getElementById('recordStartBtn');
        if (startBtn) {
            startBtn.addEventListener('click', async () => {
                const { targetType, index } = this.getRecordingTargetFromUi();
                await this.startRecordingForTarget(targetType, index);
            });
        }

        const stopBtn = document.getElementById('recordStopBtn');
        if (stopBtn) {
            stopBtn.addEventListener('click', async () => {
                const { targetType, index } = this.getRecordingTargetFromUi();
                await this.stopRecordingForTarget(targetType, index);
            });
        }

        const stopAllBtn = document.getElementById('recordStopAllBtn');
        if (stopAllBtn) {
            stopAllBtn.addEventListener('click', async () => {
                const keys = Array.from(this.recordingManager.sessions.keys());
                for (const key of keys) {
                    await this.recordingManager.stop(key);
                }
                this.updateRecordingStatus('All recordings stopped');
                this.updatePgmRecordButton();
                this.updateRecordingIndicators();
            });
        }

        const pgmBtn = document.getElementById('pgmRecordBtn');
        if (pgmBtn) {
            pgmBtn.addEventListener('click', async () => {
                await this.toggleProgramRecording();
            });
        }

        this.updateRecordingTargetUi();
        this.syncRecordingIndexesFromSelection();
        this.updatePgmRecordButton();
        this.updateRecordingIndicators();
        this.updateRecordingStats('fps: -, late: -, lag: -ms');
    }

    updateRecordingTargetUi() {
        const target = document.getElementById('recordTarget')?.value || 'program';
        const inputEl = document.getElementById('recordInputIndex');
        const auxEl = document.getElementById('recordAuxIndex');
        if (inputEl) inputEl.disabled = target !== 'input';
        if (auxEl) auxEl.disabled = target !== 'aux';
    }

    syncRecordingIndexesFromSelection() {
        const selectedInputIndex = this.inputSlots.findIndex(id => id && id === this.selectedSourceId);
        if (selectedInputIndex >= 0) {
            const inputEl = document.getElementById('recordInputIndex');
            if (inputEl) inputEl.value = String(selectedInputIndex + 1);
        }

        if (this.selectedAuxIndex !== null && this.selectedAuxIndex >= 0) {
            const auxEl = document.getElementById('recordAuxIndex');
            if (auxEl) auxEl.value = String(this.selectedAuxIndex + 1);
        }
    }

    async pickRecordingPath() {
        if (!window.showDirectoryPicker) {
            this.updateRecordingStatus('Folder picker not supported. Using browser download fallback.');
            return;
        }
        try {
            this.recordingDirectoryHandle = await window.showDirectoryPicker();
            const label = document.getElementById('recordPathLabel');
            if (label) label.textContent = `Folder selected: ${this.recordingDirectoryHandle.name || 'chosen-folder'}`;
            this.updateRecordingStatus('Recording folder selected');
        } catch {
            this.updateRecordingStatus('Folder selection canceled');
        }
    }

    getRecordingTargetFromUi() {
        const targetType = document.getElementById('recordTarget')?.value || 'program';
        const inputIndex = Math.max(0, Math.min(9, Number(document.getElementById('recordInputIndex')?.value || 1) - 1));
        const auxIndex = Math.max(0, Math.min(9, Number(document.getElementById('recordAuxIndex')?.value || 1) - 1));
        if (targetType === 'input') return { targetType, index: inputIndex };
        if (targetType === 'aux') return { targetType, index: auxIndex };
        return { targetType: 'program', index: 0 };
    }

    getElementNativeSize(el) {
        if (!el) return { width: 1280, height: 720 };
        if (el instanceof HTMLCanvasElement) return { width: el.width || 1280, height: el.height || 720 };
        if (el instanceof HTMLVideoElement) return { width: el.videoWidth || 1280, height: el.videoHeight || 720 };
        if (el instanceof HTMLImageElement) return { width: el.naturalWidth || 1280, height: el.naturalHeight || 720 };
        return { width: 1280, height: 720 };
    }

    getRecordingResolution(baseWidth, baseHeight) {
        const value = document.getElementById('recordResolution')?.value || 'original';
        if (value === 'original') return { width: baseWidth, height: baseHeight };
        const match = /^(\d+)x(\d+)$/.exec(value);
        if (match) return { width: Number(match[1]), height: Number(match[2]) };
        return { width: baseWidth, height: baseHeight };
    }

    buildRecordingKey(targetType, index) {
        if (targetType === 'input') return `input-${index + 1}`;
        if (targetType === 'aux') return `aux-${index + 1}`;
        return 'program';
    }

    getRecordingSourceForTarget(targetType, index) {
        if (targetType === 'program') {
            const source = this.getSource(this.activeProgramId);
            if (!source) throw new Error('No Program source selected');
            return {
                key: this.buildRecordingKey(targetType, index),
                label: source.label || 'program',
                element: document.getElementById('outputCanvas'),
                audioTrack: this.getProgramRecordingAudioTrack(),
                overlaysProvider: () => this.getProgramRecordingOverlays()
            };
        }

        if (targetType === 'input') {
            const sourceId = this.inputSlots[index];
            const source = sourceId ? this.getSource(sourceId) : null;
            if (!source) throw new Error(`Input ${index + 1} is empty`);
            return {
                key: this.buildRecordingKey(targetType, index),
                label: source.label || `IN_${index + 1}`,
                element: source.mediaElement,
                audioTrack: this.getSourceAudioTrackForRecording(source)
            };
        }

        const sourceId = this.auxSlots[index];
        const source = sourceId ? this.getSource(sourceId) : null;
        if (!source) throw new Error(`AUX ${index + 1} is empty`);
        return {
            key: this.buildRecordingKey(targetType, index),
            label: source.label || `AUX_${index + 1}`,
            element: source.mediaElement,
            audioTrack: this.getSourceAudioTrackForRecording(source)
        };
    }

    getProgramRecordingOverlays() {
        const layers = [];
        for (let i = 0; i < this.overlaySlots.length; i++) {
            if (!this.overlayProgramActive[i]) continue;
            const overlay = this.overlaySlots[i];
            if (!overlay || !overlay.mediaElement) continue;
            const settings = this.ensureOverlaySettings(overlay);
            layers.push({ element: overlay.mediaElement, settings });
        }
        return layers;
    }

    async startRecordingForTarget(targetType, index) {
        if (!this.recordingManager.isSupported()) {
            this.updateRecordingStatus('Recording is not supported in this browser');
            return;
        }
        this.ensureAudioContext(true);
        try {
            const src = this.getRecordingSourceForTarget(targetType, index);
            if (!src.element) throw new Error('Recording source is not available');
            const base = this.getElementNativeSize(src.element);
            const out = this.getRecordingResolution(base.width, base.height);
            const fps = Number(document.getElementById('recordFps')?.value || 30);
            const formatKey = document.getElementById('recordFormat')?.value || 'auto';
            const qualityKey = document.getElementById('recordQuality')?.value || 'medium';
            const adaptive = (document.getElementById('recordAdaptive')?.value || 'on') === 'on';
            await this.recordingManager.start({
                key: src.key,
                label: src.label,
                sourceElement: src.element,
                width: out.width,
                height: out.height,
                fps,
                directoryHandle: this.recordingDirectoryHandle,
                formatKey,
                qualityKey,
                adaptive,
                audioTrack: src.audioTrack || null,
                overlaysProvider: src.overlaysProvider || null
            });
            this.updateRecordingStatus(`Recording started: ${src.key}`);
            this.updatePgmRecordButton();
            this.updateRecordingIndicators();
        } catch (err) {
            this.updateRecordingStatus(`Record start failed: ${err.message || err}`);
        }
    }

    async stopRecordingForTarget(targetType, index) {
        const key = this.buildRecordingKey(targetType, index);
        await this.recordingManager.stop(key);
        this.updateRecordingStatus(`Recording stopped: ${key}`);
        this.updatePgmRecordButton();
        this.updateRecordingIndicators();
    }

    async toggleProgramRecording() {
        const key = this.buildRecordingKey('program', 0);
        if (this.recordingManager.isRecording(key)) {
            await this.stopRecordingForTarget('program', 0);
        } else {
            await this.startRecordingForTarget('program', 0);
        }
    }

    updateRecordingStatus(text) {
        const el = document.getElementById('recordingStatus');
        if (el) el.textContent = text || 'Idle';
    }

    updateRecordingStats(text) {
        const el = document.getElementById('recordingStats');
        if (el) el.textContent = text || 'fps: -, late: -, lag: -ms';
    }

    updatePgmRecordButton() {
        const btn = document.getElementById('pgmRecordBtn');
        if (!btn) return;
        const rec = this.recordingManager.isRecording('program');
        btn.classList.toggle('is-recording', rec);
        btn.title = rec ? 'Stop Program Recording' : 'Record Program';
    }

    updateRecordingIndicators() {
        const pgmDrop = document.getElementById('programDrop');
        if (pgmDrop) pgmDrop.classList.toggle('is-recording', this.recordingManager.isRecording('program'));

        this.inputSlotEls.forEach((entry, index) => {
            const rec = this.recordingManager.isRecording(`input-${index + 1}`);
            entry.slot.classList.toggle('is-recording', rec);
        });

        this.auxSlotEls.forEach((entry, index) => {
            const rec = this.recordingManager.isRecording(`aux-${index + 1}`);
            entry.aux.classList.toggle('is-recording', rec);
        });
    }

    // -------------------------
    // Streaming (WHIP WebRTC)
    // -------------------------

    bindStreamingControls() {
        const startBtn = document.getElementById('streamStartBtn');
        if (startBtn) {
            startBtn.addEventListener('click', async () => {
                const { targetType, index } = this.getStreamingTargetFromUi();
                await this.startStreamingForTarget(targetType, index);
            });
        }

        const stopBtn = document.getElementById('streamStopBtn');
        if (stopBtn) {
            stopBtn.addEventListener('click', async () => {
                const { targetType, index } = this.getStreamingTargetFromUi();
                await this.stopStreamingForTarget(targetType, index);
            });
        }

        const stopAllBtn = document.getElementById('streamStopAllBtn');
        if (stopAllBtn) {
            stopAllBtn.addEventListener('click', async () => {
                await this.streamingModule.stopAll();
                this.updateStreamingStatus('All streams stopped');
            });
        }

        const targetSelect = document.getElementById('streamTarget');
        if (targetSelect) targetSelect.addEventListener('change', () => this.updateStreamingTargetUi());

        const protocolSelect = document.getElementById('streamProtocol');
        if (protocolSelect) {
            protocolSelect.addEventListener('change', () => this.updateStreamingProtocolUi());
        }

        this.updateStreamingTargetUi();
        this.updateStreamingProtocolUi();
        this.updateStreamingStatus('Idle');
        this.updateStreamingStats('bitrate: -, rtt: -, jitter: -');
    }

    updateStreamingTargetUi() {
        const target = document.getElementById('streamTarget')?.value || 'program';
        const inputEl = document.getElementById('streamInputIndex');
        const auxEl = document.getElementById('streamAuxIndex');
        if (inputEl) inputEl.disabled = target !== 'input';
        if (auxEl) auxEl.disabled = target !== 'aux';
    }

    // -------------------------
    // UI Customization Controls
    // -------------------------

    bindUiCustomizationControls() {
        // Theme control
        const themeSelect = document.getElementById('uiTheme');
        this.populateCustomThemesDropdown(themeSelect);
        if (themeSelect) {
            themeSelect.addEventListener('change', () => {
                this.applyTheme(themeSelect.value);
            });
        }

        // Panel position control
        const panelPositionSelect = document.getElementById('uiPanelPosition');
        if (panelPositionSelect) {
            panelPositionSelect.addEventListener('change', () => {
                this.applyPanelPosition(panelPositionSelect.value);
            });
        }

        // Redirection for dock actions
        const handleDockRedirect = (action) => {
            if (action === 'workspace') {
                this.showSettingsSection('settings-workspace');
            } else if (action === 'settings') {
                this.showSettingsSection('settings-preferences');
            }
        };

        // Re-bind dock icons if they were dynamically updated in HTML
        document.querySelectorAll('[data-dock-action]').forEach(btn => {
            btn.addEventListener('click', () => handleDockRedirect(btn.dataset.dockAction));
        });

        // Audio meters toggle
        const audioMetersCheckbox = document.getElementById('uiShowAudioMeters');
        if (audioMetersCheckbox) {
            audioMetersCheckbox.addEventListener('change', () => {
                this.applyShowAudioMeters(audioMetersCheckbox.checked);
            });
        }

        // Preview names toggle
        const previewNamesCheckbox = document.getElementById('uiShowPreviewNames');
        if (previewNamesCheckbox) {
            previewNamesCheckbox.addEventListener('change', () => {
                this.applyShowPreviewNames(previewNamesCheckbox.checked);
            });
        }

        // Auto-hide panels toggle
        const autoHideCheckbox = document.getElementById('uiAutoHidePanels');
        if (autoHideCheckbox) {
            autoHideCheckbox.addEventListener('change', () => {
                this.applyAutoHidePanels(autoHideCheckbox.checked);
            });
        }

        // Animation speed control
        const animationSpeedSelect = document.getElementById('uiAnimationSpeed');
        if (animationSpeedSelect) {
            animationSpeedSelect.addEventListener('change', () => {
                this.applyAnimationSpeed(animationSpeedSelect.value);
            });
        }

        // Custom Theme bindings
        const customThemeBuilder = document.getElementById('themeParameterBuilder');

        const colorsToBind = [
            { id: 'customColorBg', var: '--bg' },
            { id: 'customColorPanelBg', var: '--bg-panel' },
            { id: 'customColorCanvasBg', var: '--bg-canvas' },
            { id: 'customColorActivityBg', var: '--bg-activity' },
            { id: 'customColorCyan', var: '--cyan' },
            { id: 'customColorInputBg', var: '--bg-input' },
            { id: 'customColorLine', var: '--line' },
            { id: 'customColorText', var: '--text' },
            { id: 'customColorTextLight', var: '--text-light' },
            { id: 'customColorMuted', var: '--muted' }
        ];

        colorsToBind.forEach(item => {
            const el = document.getElementById(item.id);
            if (el) {
                el.addEventListener('input', (e) => {
                    document.documentElement.style.setProperty(item.var, e.target.value);
                    if (item.var === '--bg') {
                        const metaThemeColor = document.querySelector('meta[name="theme-color"]');
                        if (metaThemeColor) metaThemeColor.setAttribute('content', e.target.value);
                    }
                });
            }
        });

        const saveCustomThemeBtn = document.getElementById('saveCustomThemeBtn');
        if (saveCustomThemeBtn) {
            saveCustomThemeBtn.addEventListener('click', () => {
                const themeNameInput = document.getElementById('customThemeName');
                const themeName = themeNameInput ? themeNameInput.value.trim() : 'Custom Theme';

                if (!themeName) {
                    alert('Please enter a name for your custom theme.');
                    return;
                }

                const themeData = {};
                colorsToBind.forEach(item => {
                    const el = document.getElementById(item.id);
                    if (el) themeData[item.var] = el.value;
                });

                let savedThemes = {};
                try {
                    const stored = localStorage.getItem('switcher_custom_themes');
                    if (stored) savedThemes = JSON.parse(stored);
                } catch (e) { }

                const themeId = 'custom_' + themeName.toLowerCase().replace(/[^a-z0-9]/g, '_');
                savedThemes[themeId] = { name: themeName, colors: themeData };

                localStorage.setItem('switcher_custom_themes', JSON.stringify(savedThemes));

                this.populateCustomThemesDropdown(document.getElementById('uiTheme'));
                document.getElementById('uiTheme').value = themeId;

                alert(`Custom theme '${themeName}' saved!`);
            });
        }

        // Reset to defaults
        const resetBtn = document.getElementById('uiResetDefaults');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.resetUiDefaults();
            });
        }
    }

    applyTheme(theme) {
        const root = document.documentElement;
        if (theme === 'light') {
            root.style.setProperty('--bg', '#ffffff');
            root.style.setProperty('--bg-panel', '#f3f3f3');
            root.style.setProperty('--bg-activity', '#2c2c2c');
            root.style.setProperty('--bg-canvas', '#000000');
            root.style.setProperty('--bg-input', '#ffffff');
            root.style.setProperty('--line', '#cccccc');
            root.style.setProperty('--text', '#3b3b3b');
            root.style.setProperty('--text-light', '#000000');
            root.style.setProperty('--muted', '#767676');
            root.style.setProperty('--cyan', '#007acc');
            root.style.setProperty('--red', '#f14c4c');
            root.style.setProperty('--blue', '#3794ff');
        } else if (theme === 'cyber') {
            root.style.setProperty('--bg', '#0a0a0a');
            root.style.setProperty('--bg-panel', '#050505');
            root.style.setProperty('--bg-activity', '#001100');
            root.style.setProperty('--bg-canvas', '#000000');
            root.style.setProperty('--bg-input', '#0d0d0d');
            root.style.setProperty('--line', '#00ff00');
            root.style.setProperty('--text', '#00ff00');
            root.style.setProperty('--text-light', '#ffffff');
            root.style.setProperty('--muted', '#00aa00');
            root.style.setProperty('--cyan', '#00ff00');
            root.style.setProperty('--red', '#ff0000');
            root.style.setProperty('--blue', '#00ffff');
        } else if (theme.startsWith('custom_')) {
            let customTheme = {
                '--bg': '#1e1e1e',
                '--bg-panel': '#252526',
                '--bg-canvas': '#000000',
                '--bg-input': '#3c3c3c',
                '--bg-activity': '#333333',
                '--cyan': '#007acc',
                '--line': '#454545',
                '--text': '#cccccc',
                '--text-light': '#ffffff',
                '--muted': '#999999',
                '--red': '#f14c4c',
                '--blue': '#3794ff'
            };

            try {
                const stored = localStorage.getItem('switcher_custom_themes');
                if (stored) {
                    const savedThemes = JSON.parse(stored);
                    if (savedThemes[theme] && savedThemes[theme].colors) {
                        customTheme = { ...customTheme, ...savedThemes[theme].colors };
                    }
                }
            } catch (e) { }

            Object.entries(customTheme).forEach(([variable, value]) => {
                root.style.setProperty(variable, value);
            });
        } else {
            // Dark (default VS Code)
            root.style.setProperty('--bg', '#1e1e1e');
            root.style.setProperty('--bg-panel', '#252526');
            root.style.setProperty('--bg-activity', '#333333');
            root.style.setProperty('--bg-canvas', '#000000');
            root.style.setProperty('--bg-input', '#3c3c3c');
            root.style.setProperty('--line', '#454545');
            root.style.setProperty('--text', '#cccccc');
            root.style.setProperty('--text-light', '#ffffff');
            root.style.setProperty('--muted', '#999999');
            root.style.setProperty('--cyan', '#007acc');
            root.style.setProperty('--red', '#f14c4c');
            root.style.setProperty('--blue', '#3794ff');
        }

        // Always Sync UI Pickers to computed styles
        setTimeout(() => {
            const styles = getComputedStyle(root);
            const map = {
                '#customColorBg': '--bg',
                '#customColorPanelBg': '--bg-panel',
                '#customColorCanvasBg': '--bg-canvas',
                '#customColorInputBg': '--bg-input',
                '#customColorActivityBg': '--bg-activity',
                '#customColorCyan': '--cyan',
                '#customColorLine': '--line',
                '#customColorText': '--text',
                '#customColorTextLight': '--text-light',
                '#customColorMuted': '--muted'
            };
            Object.entries(map).forEach(([sel, variable]) => {
                const el = document.querySelector(sel);
                if (el) {
                    let val = styles.getPropertyValue(variable).trim();
                    if (val.length === 4) {
                        // Expand #abc to #aabbcc
                        val = '#' + val[1] + val[1] + val[2] + val[2] + val[3] + val[3];
                    }
                    if (val) {
                        el.value = val;
                        // Synchronize the browser meta theme-color with the main background
                        if (variable === '--bg') {
                            const metaThemeColor = document.querySelector('meta[name="theme-color"]');
                            if (metaThemeColor) metaThemeColor.setAttribute('content', val);
                        }
                    }
                }
            });
        }, 10);
    }

    populateCustomThemesDropdown(selectEl) {
        if (!selectEl) return;

        // Remove existing custom options
        const options = Array.from(selectEl.options);
        for (let i = options.length - 1; i >= 0; i--) {
            if (options[i].value === 'custom' || options[i].value.startsWith('custom_')) {
                selectEl.remove(i);
            }
        }

        try {
            const stored = localStorage.getItem('switcher_custom_themes');
            if (stored) {
                const savedThemes = JSON.parse(stored);
                Object.keys(savedThemes).forEach(themeId => {
                    const opt = document.createElement('option');
                    opt.value = themeId;
                    opt.text = savedThemes[themeId].name;
                    selectEl.add(opt);
                });
            }
        } catch (e) { }
    }

    applyPanelPosition(position) {
        const activityBar = document.querySelector('.settings-activity-bar');
        const contentArea = document.querySelector('.settings-content-area');
        const shell = document.getElementById('appShell');

        const isExpanded = this.activityBarExpanded;

        if (position === 'right') {
            // Move to right side
            if (activityBar) {
                activityBar.style.left = 'auto';
                activityBar.style.right = '0';
                activityBar.classList.add('on-right');
                activityBar.classList.remove('on-left');
                const docSide = document.querySelector('.settings-bar-icons');
                if (docSide) {
                    docSide.style.borderRight = 'none';
                    docSide.style.borderLeft = '1px solid var(--line)';
                }
            }
            if (contentArea) {
                contentArea.style.left = 'auto';
                const barWidth = activityBar ? activityBar.offsetWidth : 36;
                contentArea.style.right = `${barWidth}px`;
                contentArea.style.borderLeft = '1px solid var(--line)';
                contentArea.style.borderRight = 'none';
                contentArea.style.borderRadius = '12px 0 0 12px';
                if (!isExpanded) {
                    contentArea.style.transform = 'translateX(100%)';
                }
            }
            if (shell) {
                shell.style.paddingLeft = '6px';
                shell.style.paddingRight = '52px';
            }
        } else {
            // Left side (default)
            if (activityBar) {
                activityBar.style.left = '0';
                activityBar.style.right = 'auto';
                activityBar.classList.add('on-left');
                activityBar.classList.remove('on-right');
                const docSide = document.querySelector('.settings-bar-icons');
                if (docSide) {
                    docSide.style.borderLeft = 'none';
                    docSide.style.borderRight = '1px solid var(--line)';
                }
            }
            if (contentArea) {
                contentArea.style.right = 'auto';
                const barWidth = activityBar ? activityBar.offsetWidth : 36;
                contentArea.style.left = `${barWidth}px`;
                contentArea.style.borderRight = '1px solid var(--line)';
                contentArea.style.borderLeft = 'none';
                contentArea.style.borderRadius = '0 12px 12px 0';
                if (!isExpanded) {
                    contentArea.style.transform = 'translateX(-100%)';
                }
            }
            if (shell) {
                shell.style.paddingLeft = '52px';
                shell.style.paddingRight = '6px';
            }
        }

        if (isExpanded && contentArea) {
            contentArea.style.transform = 'translateX(0)';
        }
    }

    applyGridSize(size, section = 'all') {
        const root = document.documentElement;
        const scale = typeof size === 'number' ? size : 1.0;

        const sections = {
            'output': '--scale-output',
            'input': '--scale-input',
            'router': '--scale-router',
            'overlay': '--scale-overlay'
        };

        if (section === 'all') {
            Object.values(sections).forEach(variable => root.style.setProperty(variable, scale.toFixed(2)));
        } else if (sections[section]) {
            root.style.setProperty(sections[section], scale.toFixed(2));
        }

        // Update UI labels and sliders
        const updateUI = (s, v) => {
            const label = document.getElementById(`uiScale${s.charAt(0).toUpperCase() + s.slice(1)}Value`);
            if (label) label.textContent = v.toFixed(1);
            const slider = document.getElementById(`uiScale${s.charAt(0).toUpperCase() + s.slice(1)}`);
            if (slider) slider.value = v;
        };

        if (section === 'all') {
            ['output', 'input', 'router', 'overlay'].forEach(s => updateUI(s, scale));
        } else {
            updateUI(section, scale);
        }

        // Force a UI refresh of slots
        this.refreshInputBus();
        this.refreshAuxRouter();
        this.refreshOverlayBus();

        // Dynamically adjust GridStack item heights to remove dead space
        if (window.GridStack) {
            setTimeout(() => {
                const grid = this.grid || (document.querySelector('#centerGrid')?.gridstack);
                if (grid) {
                    const items = document.querySelectorAll('.grid-stack-item');
                    items.forEach(item => {
                        const content = item.querySelector('.grid-stack-item-content');
                        if (content) {
                            const contentHeight = content.scrollHeight;
                            const cellHeight = grid.opts.cellHeight || 116;
                            const margin = grid.opts.margin || 8;
                            const neededH = Math.ceil((contentHeight + margin) / (cellHeight + margin));
                            grid.update(item, { h: neededH });
                        }
                    });
                }
            }, 50);
        }
    }

    bindPanelScaleControls() {
        document.querySelectorAll('.panel-scale-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const section = e.target.closest('[data-section]').dataset.section;
                app.applyGridSize(parseFloat(e.target.value), section);
            });
        });

        document.querySelectorAll('.scale-value').forEach(valueEl => {
            const slider = valueEl.previousElementSibling;
            if (slider) {
                slider.addEventListener('input', (e) => {
                    valueEl.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
                });
            }
        });
    }

    bindPreferencesControls() {
        ['output', 'input', 'router', 'overlay'].forEach(section => {
            const slider = document.getElementById(`uiScale${section.charAt(0).toUpperCase() + section.slice(1)}`);
            if (slider) {
                slider.addEventListener('input', (e) => {
                    this.applyGridSize(parseFloat(e.target.value), section);
                    // Sync panel sliders
                    const panelSlider = document.querySelector(`[data-section="${section}"] .panel-scale-slider`);
                    if (panelSlider) {
                        panelSlider.value = e.target.value;
                        const valueEl = panelSlider.nextElementSibling;
                        if (valueEl) valueEl.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
                    }
                });
                slider.addEventListener('change', () => {
                    this.savePersistedState();
                });
            }
        });

        // Bind panel sliders
        this.bindPanelScaleControls();

        // GUI Reset Bindings
        const resetBtn = document.getElementById('uiResetDefaults');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (confirm('Are you sure you want to reset all GUI settings to defaults?')) {
                    this.resetUiDefaults();
                }
            });
        }

        const workspaceResetBtn = document.getElementById('workspaceResetBtn');
        if (workspaceResetBtn) {
            workspaceResetBtn.addEventListener('click', () => {
                if (confirm('Reset workspace layout to default?')) {
                    this.resetWorkspaceDefaults();
                }
            });
        }
    }

    resetUiDefaults() {
        // Factory Defaults for CSS variables
        const defaults = {
            '--bg': '#1e1e1e',
            '--bg-panel': '#252526',
            '--bg-canvas': '#000000',
            '--bg-input': '#3c3c3c',
            '--bg-activity': '#333333',
            '--cyan': '#007acc',
            '--line': '#454545',
            '--text': '#cccccc',
            '--text-light': '#ffffff',
            '--muted': '#999999'
        };

        const root = document.documentElement;
        Object.entries(defaults).forEach(([variable, value]) => {
            root.style.setProperty(variable, value);
        });

        // Reset scale sliders
        ['output', 'input', 'router', 'overlay'].forEach(section => {
            const slider = document.getElementById(`uiScale${section.charAt(0).toUpperCase() + section.slice(1)}`);
            if (slider) {
                slider.value = 1.0;
                this.applyGridSize(1.0, section);
            }
        });

        // Reset toggles (checkboxes)
        const toggles = {
            'uiShowAudioMeters': true,
            'uiShowPreviewNames': true,
            'uiAutoHidePanels': false
        };
        Object.entries(toggles).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el) {
                el.checked = val;
                if (id === 'uiShowAudioMeters') this.applyShowAudioMeters(val);
                if (id === 'uiShowPreviewNames') this.applyShowPreviewNames(val);
                if (id === 'uiAutoHidePanels') this.applyAutoHidePanels(val);
            }
        });

        // Reset theme
        const themeSelect = document.getElementById('uiTheme');
        if (themeSelect) {
            themeSelect.value = 'dark';
            this.applyTheme('dark');
        }

        // Reset panel position
        const panelPos = document.getElementById('uiPanelPosition');
        if (panelPos) {
            panelPos.value = 'left';
            this.applyPanelPosition('left');
        }

        // Reset icon order
        this.iconOrder = ['settings-source', 'settings-chroma', 'settings-cg', 'settings-recording', 'settings-streaming', 'settings-assets', 'settings-workspace', 'settings-preferences'];
        localStorage.setItem('switcher_icon_order', JSON.stringify(this.iconOrder));
        this.applyIconOrder();

        // Dock all widgets back (pop-outs)
        document.querySelectorAll('.settings-widget-dock-btn').forEach(btn => btn.click());

        // Restore layout panels
        document.querySelectorAll('.layout-dock-icon').forEach(icon => {
            if (icon.style.display !== 'none') icon.click();
        });

        this.savePersistedState();
        alert('GUI settings have been reset to defaults.');
    }

    resetWorkspaceDefaults() {
        // Reset grid counts
        const gridCounts = {
            'workspaceInputCount': 10,
            'workspaceAuxCount': 10,
            'workspaceOverlayCount': 10
        };
        Object.entries(gridCounts).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el) el.value = val;
        });

        this.applyGridConfig();
        this.savePersistedState();
        alert('Workspace counts have been reset.');
    }

    applyShowAudioMeters(show) {
        const meters = document.querySelectorAll('.audio-meter');
        meters.forEach(meter => {
            meter.style.display = show ? 'grid' : 'none';
        });
    }

    applyShowPreviewNames(show) {
        const names = document.querySelectorAll('.drop-box .name, .slot-head, .aux-head, .overlay-head');
        names.forEach(name => {
            name.style.display = show ? 'block' : 'none';
        });
    }

    applyAutoHidePanels(autoHide) {
        // This would require more complex implementation
        console.log('Auto-hide panels:', autoHide ? 'enabled' : 'disabled');
    }

    applyAnimationSpeed(speed) {
        const style = document.createElement('style');
        style.id = 'animation-speed-style';

        const duration = speed === 'none' ? '0s' : (speed === 'fast' ? '0.1s' : '0.2s');
        style.textContent = `
            * { transition: all ${duration} ease !important; }
        `;

        const existing = document.getElementById('animation-speed-style');
        if (existing) existing.remove();
        document.head.appendChild(style);
    }



    updateStreamingProtocolUi() {
        const protocol = document.getElementById('streamProtocol')?.value || 'whip';
        const endpointField = document.getElementById('streamEndpoint');

        if (endpointField) {
            if (protocol === 'http') {
                endpointField.placeholder = 'http://localhost:8889/stream';
            } else {
                endpointField.placeholder = 'https://your-whip-server.com/ingest';
            }
        }
    }

    getStreamingTargetFromUi() {
        const targetType = document.getElementById('streamTarget')?.value || 'program';
        const inputIndex = Math.max(0, Math.min(9, Number(document.getElementById('streamInputIndex')?.value || 1) - 1));
        const auxIndex = Math.max(0, Math.min(9, Number(document.getElementById('streamAuxIndex')?.value || 1) - 1));
        if (targetType === 'input') return { targetType, index: inputIndex };
        if (targetType === 'aux') return { targetType, index: auxIndex };
        return { targetType: 'program', index: 0 };
    }

    buildStreamingKey(targetType, index) {
        if (targetType === 'input') return `stream-input-${index + 1}`;
        if (targetType === 'aux') return `stream-aux-${index + 1}`;
        return 'stream-program';
    }

    // -------------------------
    // Workspace & Layout
    // -------------------------
    setupCanvasObservers() {
        const resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                const target = entry.target;
                const canvas = target.querySelector('canvas');
                if (canvas && target.clientWidth > 0 && target.clientHeight > 0) {
                    const dpr = window.devicePixelRatio || 1;
                    canvas.width = target.clientWidth * dpr;
                    canvas.height = target.clientHeight * dpr;
                }
            }
        });

        const previewWrap = document.querySelector('#previewDrop .surface-wrap');
        const programWrap = document.querySelector('#programDrop .surface-wrap');
        const masterWrap = document.querySelector('.master-surface')?.parentElement;
        if (previewWrap) resizeObserver.observe(previewWrap);
        if (programWrap) resizeObserver.observe(programWrap);
        if (masterWrap) resizeObserver.observe(masterWrap);
    }

    async bindWorkspaceControls() {
        // Load initial values into inputs
        const inInput = document.getElementById('workspaceInputCount');
        const outAux = document.getElementById('workspaceAuxCount');
        const outOvl = document.getElementById('workspaceOverlayCount');
        if (inInput) inInput.value = this.gridConfig.inputs;
        if (outAux) outAux.value = this.gridConfig.aux;
        if (outOvl) outOvl.value = this.gridConfig.overlays;

        document.getElementById('workspaceApplyGridBtn')?.addEventListener('click', () => {
            this.gridConfig.inputs = parseInt(document.getElementById('workspaceInputCount').value) || 10;
            this.gridConfig.aux = parseInt(document.getElementById('workspaceAuxCount').value) || 10;
            this.gridConfig.overlays = parseInt(document.getElementById('workspaceOverlayCount').value) || 10;

            // Re-allocate arrays (preserve existing)
            const oldInput = this.inputSlots;
            const oldSourceMutes = this.sourceMutes;
            this.inputSlots = new Array(this.gridConfig.inputs).fill(null);
            this.sourceMutes = new Array(this.gridConfig.inputs).fill(false);
            for (let i = 0; i < Math.min(oldInput.length, this.inputSlots.length); i++) this.inputSlots[i] = oldInput[i];
            for (let i = 0; i < Math.min(oldSourceMutes.length, this.sourceMutes.length); i++) this.sourceMutes[i] = !!oldSourceMutes[i];

            const oldAux = this.auxSlots;
            this.auxSlots = new Array(this.gridConfig.aux).fill(null);
            for (let i = 0; i < Math.min(oldAux.length, this.auxSlots.length); i++) this.auxSlots[i] = oldAux[i];

            const oldOvl = this.overlaySlots;
            const oldPrevOvl = this.overlayPreviewActive;
            const oldProgOvl = this.overlayProgramActive;
            this.overlaySlots = new Array(this.gridConfig.overlays).fill(null);
            this.overlayPreviewActive = new Array(this.gridConfig.overlays).fill(false);
            this.overlayProgramActive = new Array(this.gridConfig.overlays).fill(false);
            for (let i = 0; i < Math.min(oldOvl.length, this.overlaySlots.length); i++) {
                this.overlaySlots[i] = oldOvl[i];
                this.overlayPreviewActive[i] = oldPrevOvl[i];
                this.overlayProgramActive[i] = oldProgOvl[i];
            }

            this.savePersistedState();

            // Rebuild buses
            this.buildInputBus();
            this.buildAuxRouter();
            this.buildOverlayBus();
            // alert('Grid updated successfully!');
        });

        // Layout Directory Picker
        document.getElementById('workspacePickFolderBtn')?.addEventListener('click', async () => {
            try {
                this.layoutDirectoryHandle = await window.showDirectoryPicker();
                document.getElementById('workspacePathLabel').textContent = this.layoutDirectoryHandle.name;
                await this.refreshLayoutList();
            } catch (err) {
                console.warn('User cancelled folder selection or error:', err);
            }
        });

        // Save Layout
        document.getElementById('workspaceSaveBtn')?.addEventListener('click', async () => {
            if (!this.layoutDirectoryHandle) {
                alert('Please select a Layout folder first.');
                return;
            }
            const name = prompt('Enter layout name:', 'MyLayout');
            if (!name) return;

            const layoutData = this.getLayoutData();
            try {
                const fileHandle = await this.layoutDirectoryHandle.getFileHandle(`${name}.json`, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(JSON.stringify(layoutData, null, 2));
                await writable.close();
                alert(`Layout ${name} saved successfully!`);
                await this.refreshLayoutList();
                document.getElementById('workspaceLayoutSelect').value = `${name}.json`;
            } catch (err) {
                alert('Error saving layout: ' + err.message);
            }
        });

        // Load Layout
        document.getElementById('workspaceLoadBtn')?.addEventListener('click', async () => {
            if (!this.layoutDirectoryHandle) {
                alert('Please select a Layout folder first.');
                return;
            }
            const select = document.getElementById('workspaceLayoutSelect');
            const fileName = select?.value;
            if (fileName === 'default') {
                this.loadDefaultLayout();
                return;
            }
            try {
                const fileHandle = await this.layoutDirectoryHandle.getFileHandle(fileName);
                const file = await fileHandle.getFile();
                const contents = await file.text();
                const layoutData = JSON.parse(contents);
                this.applyLayoutData(layoutData);
                alert(`Layout loaded from ${fileName}`);
            } catch (err) {
                alert('Error loading layout: ' + err.message);
            }
        });

        // Make Default
        document.getElementById('workspaceMakeDefaultBtn')?.addEventListener('click', () => {
            const layoutData = this.getLayoutData();
            localStorage.setItem('switcher_default_layout', JSON.stringify(layoutData));
            alert('Current layout made default! It will load automatically on refresh.');
        });

        // Reset
        document.getElementById('workspaceResetBtn')?.addEventListener('click', () => {
            if (confirm('Are you sure you want to revert to the default layout?')) {
                this.loadDefaultLayout();
            }
        });

        // Automatically apply default layout if exists
        setTimeout(() => {
            const defaultStr = localStorage.getItem('switcher_default_layout');
            if (defaultStr) {
                try {
                    const defaultLayout = JSON.parse(defaultStr);
                    this.applyLayoutData(defaultLayout);
                } catch (e) { }
            }
        }, 500);
    }

    async refreshLayoutList() {
        if (!this.layoutDirectoryHandle) return;
        const select = document.getElementById('workspaceLayoutSelect');
        if (!select) return;
        select.innerHTML = '<option value="default">Default</option>';
        for await (const entry of this.layoutDirectoryHandle.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.json')) {
                const opt = document.createElement('option');
                opt.value = entry.name;
                opt.textContent = entry.name.replace('.json', '');
                select.appendChild(opt);
            }
        }
    }

    getLayoutData() {
        const gridData = [];
        if (window.GridStack) {
            const grid = document.getElementById('centerGrid')?.gridstack;
            if (grid) {
                grid.engine.nodes.forEach(node => {
                    gridData.push({
                        id: node.el.querySelector('.panel-shell')?.id,
                        x: node.x, y: node.y, w: node.w, h: node.h
                    });
                });
            }
        }
        return {
            gridConfig: this.gridConfig,
            gridstack: gridData,
            uiPanelPosition: document.getElementById('uiPanelPosition')?.value || 'left'
        };
    }

    applyLayoutData(data) {
        if (!data) return;

        if (data.gridConfig) {
            this.gridConfig = { ...this.gridConfig, ...data.gridConfig };
            // Similar re-allocation logic as apply grid
            const oldInput = this.inputSlots;
            const oldSourceMutes = this.sourceMutes;
            this.inputSlots = new Array(this.gridConfig.inputs).fill(null);
            this.sourceMutes = new Array(this.gridConfig.inputs).fill(false);
            for (let i = 0; i < Math.min(oldInput.length, this.inputSlots.length); i++) this.inputSlots[i] = oldInput[i];
            for (let i = 0; i < Math.min(oldSourceMutes.length, this.sourceMutes.length); i++) this.sourceMutes[i] = !!oldSourceMutes[i];

            const oldAux = this.auxSlots;
            this.auxSlots = new Array(this.gridConfig.aux).fill(null);
            for (let i = 0; i < Math.min(oldAux.length, this.auxSlots.length); i++) this.auxSlots[i] = oldAux[i];

            const oldOvl = this.overlaySlots;
            const oldPrevOvl = this.overlayPreviewActive;
            const oldProgOvl = this.overlayProgramActive;
            this.overlaySlots = new Array(this.gridConfig.overlays).fill(null);
            this.overlayPreviewActive = new Array(this.gridConfig.overlays).fill(false);
            this.overlayProgramActive = new Array(this.gridConfig.overlays).fill(false);
            for (let i = 0; i < Math.min(oldOvl.length, this.overlaySlots.length); i++) {
                this.overlaySlots[i] = oldOvl[i];
                this.overlayPreviewActive[i] = oldPrevOvl[i];
                this.overlayProgramActive[i] = oldProgOvl[i];
            }
            this.buildInputBus();
            this.buildAuxRouter();
            this.buildOverlayBus();

            const inInput = document.getElementById('workspaceInputCount');
            const outAux = document.getElementById('workspaceAuxCount');
            const outOvl = document.getElementById('workspaceOverlayCount');
            if (inInput) inInput.value = this.gridConfig.inputs;
            if (outAux) outAux.value = this.gridConfig.aux;
            if (outOvl) outOvl.value = this.gridConfig.overlays;
        }

        if (data.gridstack && window.GridStack) {
            const grid = document.getElementById('centerGrid')?.gridstack;
            if (grid) {
                grid.batchUpdate();
                data.gridstack.forEach(nodeData => {
                    if (!nodeData.id) return;
                    const el = document.getElementById(nodeData.id)?.closest('.grid-stack-item');
                    if (el) {
                        grid.update(el, { x: nodeData.x, y: nodeData.y, w: nodeData.w, h: nodeData.h });
                    }
                });
                grid.commit();
            }
        }

        if (data.uiPanelPosition) {
            const panelPositionSelect = document.getElementById('uiPanelPosition');
            if (panelPositionSelect) panelPositionSelect.value = data.uiPanelPosition;
            this.applyPanelPosition(data.uiPanelPosition);
        }
    }

    loadDefaultLayout() {
        const defaultStr = localStorage.getItem('switcher_default_layout');
        if (defaultStr) {
            try { this.applyLayoutData(JSON.parse(defaultStr)); } catch (e) { }
        } else {
            alert('No default layout found!');
        }
    }


    getStreamingSourceForTarget(targetType, index) {
        // Streaming can only use canvases/video/image; browser iframe cannot be captured directly.
        if (targetType === 'program') {
            const source = this.getSource(this.activeProgramId);
            if (!source) throw new Error('No Program source selected');
            return {
                key: this.buildStreamingKey(targetType, index),
                label: source.label || 'program',
                element: document.getElementById('outputCanvas'),
                audioTrack: this.getProgramRecordingAudioTrack(),
                overlaysProvider: () => this.getProgramRecordingOverlays()
            };
        }

        if (targetType === 'input') {
            const sourceId = this.inputSlots[index];
            const source = sourceId ? this.getSource(sourceId) : null;
            if (!source) throw new Error(`Input ${index + 1} is empty`);
            return {
                key: this.buildStreamingKey(targetType, index),
                label: source.label || `IN_${index + 1}`,
                element: source.mediaElement,
                audioTrack: this.getSourceAudioTrackForRecording(source)
            };
        }

        const sourceId = this.auxSlots[index];
        const source = sourceId ? this.getSource(sourceId) : null;
        if (!source) throw new Error(`AUX ${index + 1} is empty`);
        return {
            key: this.buildStreamingKey(targetType, index),
            label: source.label || `AUX_${index + 1}`,
            element: source.mediaElement,
            audioTrack: this.getSourceAudioTrackForRecording(source)
        };
    }

    getStreamingResolution(baseWidth, baseHeight) {
        const value = document.getElementById('streamResolution')?.value || 'original';
        if (value === 'original') return { width: baseWidth, height: baseHeight };
        const match = /^(\d+)x(\d+)$/.exec(value);
        if (match) return { width: Number(match[1]), height: Number(match[2]) };
        return { width: baseWidth, height: baseHeight };
    }

    async startStreamingForTarget(targetType, index) {
        if (!this.streamingModule.isSupported()) {
            this.updateStreamingStatus('Streaming is not supported in this browser');
            return;
        }

        this.ensureAudioContext(true);

        try {
            const endpointUrl = String(document.getElementById('streamEndpoint')?.value || '').trim();
            const protocol = document.getElementById('streamProtocol')?.value || 'whip';
            const token = String(document.getElementById('streamToken')?.value || '').trim();
            if (!endpointUrl) throw new Error('Missing endpoint URL');

            const src = this.getStreamingSourceForTarget(targetType, index);
            const base = this.getElementNativeSize(src.element);
            const out = this.getStreamingResolution(base.width, base.height);
            const fps = Number(document.getElementById('streamFps')?.value || 30);
            const adaptive = (document.getElementById('streamAdaptive')?.value || 'on') === 'on';

            await this.streamingModule.start({
                key: src.key,
                label: src.label,
                outputType: document.getElementById('streamProtocol')?.value || 'whip',
                endpointUrl,
                bearerToken: token || '',
                sourceElement: src.element,
                width: out.width,
                height: out.height,
                fps,
                audioTrack: src.audioTrack || null,
                overlaysProvider: src.overlaysProvider || null,
                adaptive
            });

            this.updateStreamingStatus(`Streaming started: ${src.key}`);
        } catch (err) {
            this.updateStreamingStatus(`Stream start failed: ${err.message || err}`);
        }
    }

    async stopStreamingForTarget(targetType, index) {
        const key = this.buildStreamingKey(targetType, index);
        await this.streamingModule.stop(key);
        this.updateStreamingStatus(`Streaming stopped: ${key}`);
        this.updateStreamingStats('bitrate: -, rtt: -, jitter: -');
    }

    updateStreamingStatus(text) {
        const el = document.getElementById('streamingStatus');
        if (el) el.textContent = text || 'Idle';
    }

    updateStreamingStats(text) {
        const el = document.getElementById('streamingStats');
        if (el) el.textContent = text || 'bitrate: -, rtt: -, jitter: -';
    }

    onStreamingStateChange(state) {
        if (!state) return;

        if (state.metrics) {
            const m = state.metrics;
            const kbps = m.outboundBitrateBps ? (m.outboundBitrateBps / 1000).toFixed(0) : '-';
            const rtt = Number.isFinite(m.roundTripTimeMs) ? `${m.roundTripTimeMs}ms` : '-';
            const jit = Number.isFinite(m.jitterMs) ? `${m.jitterMs}ms` : '-';
            this.updateStreamingStats(`bitrate: ${kbps} kbps, rtt: ${rtt}, jitter: ${jit}`);
        }

        const msg = state.message ? ` · ${state.message}` : '';
        this.updateStreamingStatus(`${state.status.toUpperCase()}: ${state.key}${msg}`);

        // Update streaming badge
        if (state.status === 'connected' || state.status === 'streaming') {
            this.setStreamingBadge(1);
        } else if (state.status === 'closed' || state.status === 'stopped' || state.status === 'failed') {
            this.setStreamingBadge(0);
        }
    }

    onRecordingStateChange(state) {
        if (state.status === 'recording') {
            const mime = state.mimeType ? ` (${state.mimeType})` : '';
            const q = state.quality ? ` ${state.quality}` : '';
            this.updateRecordingStatus(`Recording: ${state.key} -> ${state.fileName}${mime}${q}`);
            this.setRecordingBadge(1);
        } else if (state.status === 'stats') {
            const s = state.stats || {};
            const text =
                `enc fps: ${(s.encodeFps || 0).toFixed(1)} / target ${s.targetFps || '-'}\n` +
                `ingest fps: ${(s.ingestFps || 0).toFixed(1)}\n` +
                `late: ${s.lateFrames || 0}, lag: ${(s.maxLagMs || 0).toFixed(1)}ms`;
            this.updateRecordingStats(text);
            return;
        } else if (state.status === 'adaptive') {
            this.updateRecordingStatus(`Adaptive downgrade applied: target fps -> ${state.nextFps}`);
            return;
        } else {
            this.updateRecordingStatus(`Stopped: ${state.key}`);
            this.updateRecordingStats('fps: -, late: -, lag: -ms');
            this.setRecordingBadge(0);
        }
        this.updatePgmRecordButton();
        this.updateRecordingIndicators();
    }

    bindPanelControls() {
        document.querySelectorAll('[data-panel-target]').forEach(btn => {
            btn.addEventListener('click', () => {
                const panel = document.getElementById(btn.dataset.panelTarget);
                if (!panel) return;
                const collapsed = panel.classList.toggle('is-collapsed');
                btn.classList.toggle('is-active', !collapsed);

                // When expanding right panel, show Source section by default
                if (btn.dataset.panelTarget === 'rightPanel' && !collapsed) {
                    this.showSettingsSection('settings-source');
                }

                this.updateShellLayout();
            });
        });

        // Initialize shell layout on load
        this.updateShellLayout();
    }

    loadPersistedState() {
        try {
            const savedGridConfig = localStorage.getItem('switcher_grid_config');
            if (savedGridConfig) {
                this.gridConfig = { ...this.gridConfig, ...JSON.parse(savedGridConfig) };
                this.inputSlots = new Array(this.gridConfig.inputs).fill(null);
                this.sourceMutes = new Array(this.gridConfig.inputs).fill(false);
                this.auxSlots = new Array(this.gridConfig.aux).fill(null);
                this.overlaySlots = new Array(this.gridConfig.overlays).fill(null);
                this.overlayPreviewActive = new Array(this.gridConfig.overlays).fill(false);
                this.overlayProgramActive = new Array(this.gridConfig.overlays).fill(false);
            }

            const savedOrder = localStorage.getItem('switcher_icon_order');
            if (savedOrder) {
                this.iconOrder = JSON.parse(savedOrder);
            }

            const savedHidden = localStorage.getItem('switcher_hidden_icons');
            if (savedHidden) {
                this.hiddenIcons = new Set(JSON.parse(savedHidden));
            }

            const savedPanelPos = localStorage.getItem('switcher_panel_position') || 'right';
            const panelPosSelect = document.getElementById('uiPanelPosition');
            if (panelPosSelect) {
                panelPosSelect.value = savedPanelPos;
                this.applyPanelPosition(savedPanelPos);
            }

            const savedGridScale = localStorage.getItem('switcher_grid_scale');
            if (savedGridScale !== null) {
                const scale = parseFloat(savedGridScale);
                if (!isNaN(scale)) {
                    this.applyGridSize(scale, 'all');
                }
            }

            // Load independent scales
            ['output', 'input', 'router', 'overlay'].forEach(s => {
                const val = localStorage.getItem(`switcher_scale_${s}`);
                if (val !== null) this.applyGridSize(parseFloat(val), s);
            });

            const savedLastSection = localStorage.getItem('switcher_last_section');
            if (savedLastSection) {
                this.lastActiveSection = savedLastSection;
            }
        } catch (e) {
            console.warn('Failed to load persisted state:', e);
        }
    }

    savePersistedState() {
        // Debounce: prevent hammering localStorage on rapid UI events
        if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer);
        this._saveDebounceTimer = setTimeout(() => {
            try {
                localStorage.setItem('switcher_grid_config', JSON.stringify(this.gridConfig));
                localStorage.setItem('switcher_icon_order', JSON.stringify(this.iconOrder));
                localStorage.setItem('switcher_hidden_icons', JSON.stringify([...this.hiddenIcons]));

                ['output', 'input', 'router', 'overlay'].forEach(s => {
                    const slider = document.getElementById(`uiScale${s.charAt(0).toUpperCase() + s.slice(1)}`);
                    if (slider) localStorage.setItem(`switcher_scale_${s}`, slider.value);
                });
            } catch (e) {
                console.warn('Failed to save persisted state:', e);
            }
        }, 300);
    }

    applyIconOrder() {
        const container = document.getElementById('activityBarIcons');
        if (!container) return;

        const icons = Array.from(container.querySelectorAll('.settings-bar-icon'));
        icons.forEach(icon => {
            const section = icon.dataset.settingsSection;
            const index = this.iconOrder.indexOf(section);
            if (index >= 0) {
                icon.style.order = index;
            } else if (icon.classList.contains('layout-dock-icon')) {
                icon.style.order = 1000; // Layout dock icons always at the end
            }
        });

        // Hide icons based on hidden set
        this.hiddenIcons.forEach(section => {
            const icon = container.querySelector(`.settings-bar-icon[data-settings-section="${section}"]`);
            if (icon) {
                icon.style.display = 'none';
            }
        });
    }

    // Badge Management
    updateBadge(section, count, type = 'info') {
        const badge = document.getElementById(`badge-${section.replace('settings-', '')}`);
        if (!badge) return;

        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.className = `badge visible ${type}`;
        } else {
            badge.className = 'badge';
            badge.textContent = '';
        }
    }

    setRecordingBadge(count) {
        this.updateBadge('settings-recording', count, 'recording');
    }

    setStreamingBadge(count) {
        this.updateBadge('settings-streaming', count, 'streaming');
    }

    setErrorBadge(section, count) {
        this.updateBadge(section, count, 'error');
    }

    // Keyboard Shortcuts
    bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl+1-6 for sections
            if (e.ctrlKey && !e.altKey && !e.shiftKey) {
                const sectionMap = {
                    '1': 'settings-source',
                    '2': 'settings-chroma',
                    '3': 'settings-cg',
                    '4': 'settings-recording',
                    '5': 'settings-streaming',
                    '6': 'settings-ui'
                };

                if (sectionMap[e.key]) {
                    e.preventDefault();
                    this.showSettingsSection(sectionMap[e.key]);
                    this.expandActivityBar();
                }

                // Ctrl+, for settings/preferences
                if (e.key === ',' || e.key === 'Comma') {
                    e.preventDefault();
                    this.showSettingsSection('settings-ui');
                    this.expandActivityBar();
                }
            }

            // Ctrl+Alt+A for accounts
            if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                this.handleDockAction('account');
            }

            // Escape to collapse panel
            if (e.key === 'Escape') {
                if (this.activityBarExpanded) {
                    this.collapseActivityBar();
                }
                this.hideActivityBarContextMenu();
            }
        });
    }

    expandActivityBar() {
        const contentArea = document.querySelector('.settings-content-area');
        const activityBar = document.querySelector('.settings-activity-bar');

        if (contentArea) {
            contentArea.style.transform = 'translateX(0)';
            contentArea.style.opacity = '1';
        }
        if (activityBar) {
            activityBar.classList.add('expanded');
        }
        this.activityBarExpanded = true;
    }

    collapseActivityBar() {
        const contentArea = document.querySelector('.settings-content-area');
        const activityBar = document.querySelector('.settings-activity-bar');

        if (contentArea) {
            const isRight = document.getElementById('uiPanelPosition')?.value === 'right';
            contentArea.style.transform = isRight ? 'translateX(100%)' : 'translateX(-100%)';
            contentArea.style.opacity = '0';
        }
        if (activityBar) {
            activityBar.classList.remove('expanded');
        }
        this.activityBarExpanded = false;

        // Remove active state from all icons when collapsing
        document.querySelectorAll('.settings-bar-icon').forEach(b => b.classList.remove('active'));
    }

    // Context Menu
    showActivityBarContextMenu(x, y) {
        const menu = document.getElementById('activityBarContextMenu');
        if (!menu) return;

        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.classList.add('visible');

        // Update checkmarks based on hidden state
        menu.querySelectorAll('.menu-item').forEach(item => {
            const action = item.dataset.action;
            if (action && action.startsWith('hide-')) {
                const section = 'settings-' + action.replace('hide-', '');
                if (this.hiddenIcons.has(section)) {
                    item.classList.add('checked');
                } else {
                    item.classList.remove('checked');
                }
            }
        });
    }

    hideActivityBarContextMenu() {
        const menu = document.getElementById('activityBarContextMenu');
        if (menu) {
            menu.classList.remove('visible');
        }
    }

    handleContextMenuAction(action) {
        this.hideActivityBarContextMenu();

        if (action === 'reset-order') {
            this.iconOrder = ['settings-source', 'settings-chroma', 'settings-cg', 'settings-recording', 'settings-streaming', 'settings-ui'];
            this.hiddenIcons.clear();
            this.applyIconOrder();
            this.savePersistedState();
            return;
        }

        if (action.startsWith('hide-')) {
            const section = 'settings-' + action.replace('hide-', '');
            if (this.hiddenIcons.has(section)) {
                this.hiddenIcons.delete(section);
            } else {
                this.hiddenIcons.add(section);
            }
            this.applyIconOrder();
            this.savePersistedState();
        }
    }

    // Drag and Drop Reordering
    initDragAndDrop() {
        const container = document.getElementById('activityBarIcons');
        if (!container) return;

        let draggedIcon = null;

        container.querySelectorAll('.settings-bar-icon').forEach(icon => {
            icon.draggable = true;

            icon.addEventListener('dragstart', (e) => {
                draggedIcon = icon;
                icon.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            icon.addEventListener('dragend', () => {
                icon.classList.remove('dragging');
                container.querySelectorAll('.settings-bar-icon').forEach(i => {
                    i.classList.remove('drag-over');
                });
                draggedIcon = null;
                this.savePersistedState();
            });

            icon.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (draggedIcon && draggedIcon !== icon) {
                    icon.classList.add('drag-over');
                }
            });

            icon.addEventListener('dragleave', () => {
                icon.classList.remove('drag-over');
            });

            icon.addEventListener('drop', (e) => {
                e.preventDefault();
                if (draggedIcon && draggedIcon !== icon) {
                    const draggedSection = draggedIcon.dataset.settingsSection;
                    const targetSection = icon.dataset.settingsSection;

                    const draggedIndex = this.iconOrder.indexOf(draggedSection);
                    const targetIndex = this.iconOrder.indexOf(targetSection);

                    if (draggedIndex >= 0 && targetIndex >= 0) {
                        // Reorder
                        this.iconOrder.splice(draggedIndex, 1);
                        this.iconOrder.splice(targetIndex, 0, draggedSection);

                        // Apply visually
                        this.applyIconOrder();
                    }
                }
                icon.classList.remove('drag-over');
            });
        });
    }

    // Dock Actions
    handleDockAction(action) {
        if (action === 'settings') {
            this.showSettingsSection('settings-preferences');
            this.expandActivityBar();
        } else if (action === 'account') {
            // For now, show a simple alert - could be expanded to account management
            alert('Account management - Sign in to sync settings across devices');
        }
    }

    bindDockControls() {
        document.querySelectorAll('.dock-icon').forEach(dockBtn => {
            dockBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = dockBtn.dataset.dockAction;
                if (action) {
                    this.handleDockAction(action);
                }
            });
        });
    }

    bindActivityBarContextMenu() {
        const activityBar = document.getElementById('activityBarIcons');
        const contextMenu = document.getElementById('activityBarContextMenu');

        if (!activityBar || !contextMenu) return;

        // Right-click on activity bar to show context menu
        activityBar.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showActivityBarContextMenu(e.pageX, e.pageY);
        });

        // Handle context menu item clicks
        contextMenu.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;
                if (action) {
                    this.handleContextMenuAction(action);
                }
            });
        });

        // Click elsewhere to close context menu
        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) {
                this.hideActivityBarContextMenu();
            }
        });
    }

    showSettingsSection(sectionId) {
        const iconButtons = document.querySelectorAll('.settings-bar-icon');
        const sections = document.querySelectorAll('.settings-section');

        iconButtons.forEach(b => b.classList.remove('active'));
        sections.forEach(section => {
            if (section.id === sectionId) {
                section.classList.add('active');
            } else {
                section.classList.remove('active');
            }
        });

        // Activate the corresponding icon
        const targetIcon = document.querySelector(`.settings-bar-icon[data-settings-section="${sectionId}"]`);
        if (targetIcon) targetIcon.classList.add('active');

        // Expand sidebar if it was collapsed
        if (!this.activityBarExpanded) {
            this.expandActivityBar();
        }

        // Save last active section (if not a dock section)
        if (!sectionId.includes('-dock-')) {
            localStorage.setItem('switcher_last_section', sectionId);
        }
    }

    bindSettingsActivityBar() {
        const iconButtons = document.querySelectorAll('.settings-bar-icon');
        const sections = document.querySelectorAll('.settings-section');
        const contentArea = document.querySelector('.settings-content-area');
        const closeBtn = document.querySelector('.settings-close-btn');
        const activityBar = document.querySelector('.settings-activity-bar');
        const shell = document.getElementById('appShell');

        // Handle icon button clicks
        iconButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetSection = btn.dataset.settingsSection;

                // Toggle behavior: if it's already expanded and the same icon is clicked, collapse
                if (this.activityBarExpanded && btn.classList.contains('active')) {
                    this.collapseActivityBar();
                    return;
                }

                if (!this.activityBarExpanded) {
                    // Expand panel
                    this.expandActivityBar();
                }

                // Update icon buttons
                iconButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Show/hide sections
                sections.forEach(section => {
                    if (section.id === targetSection) {
                        section.classList.add('active');
                    } else {
                        section.classList.remove('active');
                    }
                });

                // Save last active section
                localStorage.setItem('switcher_last_section', targetSection);
            });
        });

        // Handle close button
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.collapseActivityBar();
            });
        }

        // Click outside to collapse
        document.addEventListener('click', (e) => {
            // we use composedPath to see if the click originated from inside the panel or activity bar
            const path = e.composedPath();
            const clickedInsideBar = activityBar && path.includes(activityBar);
            const clickedInsidePanel = contentArea && path.includes(contentArea);

            if (this.activityBarExpanded && !clickedInsideBar && !clickedInsidePanel) {
                // If it's a context menu click, don't collapse
                if (document.getElementById('inputContextMenu')?.contains(e.target) ||
                    document.getElementById('overlayContextMenu')?.contains(e.target)) {
                    return;
                }
                this.collapseActivityBar();
            }
        });

        // Initialize collapsed state
        if (contentArea) {
            contentArea.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease';
            const isRight = document.getElementById('uiPanelPosition')?.value === 'right';
            contentArea.style.transform = isRight ? 'translateX(100%)' : 'translateX(-100%)';
            contentArea.style.opacity = '0';
        }


        // Apply saved icon order
        this.applyIconOrder();

        // Initialize DnD features
        this.initActivityBarDnD();
        this.initSourceToSettingsDnD();

        // Restore last active section
        const lastSection = localStorage.getItem('switcher_last_section');
        if (lastSection) {
            const lastIcon = document.querySelector(`.settings-bar-icon[data-settings-section="${lastSection}"]`);
            if (lastIcon) {
                // Click to restore state
                lastIcon.click();
            }
        }
    }

    initActivityBarDnD() {
        const container = document.getElementById('activityBarIcons');
        if (!container) return;

        let draggedBtn = null;

        container.addEventListener('dragstart', (e) => {
            if (!e.target.classList.contains('settings-bar-icon')) return;
            draggedBtn = e.target;
            e.target.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', e.target.dataset.settingsSection);
            e.dataTransfer.setData('application/x-switcher-settings-id', e.target.dataset.settingsSection);
        });

        container.addEventListener('dragend', (e) => {
            if (!e.target.classList.contains('settings-bar-icon')) return;
            e.target.classList.remove('dragging');

            // Persist order (only for settings icons, skip dock icons)
            const currentOrder = Array.from(container.children)
                .filter(btn => btn.dataset.settingsSection)
                .map(btn => btn.dataset.settingsSection);
            localStorage.setItem('switcher_icon_order', JSON.stringify(currentOrder));
        });

        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            const afterElement = getDragAfterElement(container, e.clientY);
            const draggable = document.querySelector('.dragging');
            if (draggable && draggable.parentElement === container) {
                if (afterElement == null) {
                    container.appendChild(draggable);
                } else {
                    container.insertBefore(draggable, afterElement);
                }
            }
        });

        function getDragAfterElement(container, y) {
            const draggableElements = [...container.querySelectorAll('.settings-bar-icon:not(.dragging)')];
            return draggableElements.reduce((closest, child) => {
                const box = child.getBoundingClientRect();
                const offset = y - box.top - box.height / 2;
                if (offset < 0 && offset > closest.offset) {
                    return { offset: offset, element: child };
                } else {
                    return closest;
                }
            }, { offset: Number.NEGATIVE_INFINITY }).element;
        }

        // Logic for dragging TO grid
        const centerGrid = document.getElementById('centerGrid');
        if (centerGrid) {
            centerGrid.addEventListener('dragover', e => e.preventDefault());
            centerGrid.addEventListener('drop', e => {
                const settingsId = e.dataTransfer.getData('application/x-switcher-settings-id');
                if (settingsId) {
                    e.preventDefault();
                    // Determine drop position relative to grid
                    const rect = centerGrid.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    this.popSettingsToGrid(settingsId, x, y);
                }
            });
        }
    }

    initSourceToSettingsDnD() {
        const icons = document.querySelectorAll('.settings-bar-icon');
        icons.forEach(icon => {
            icon.addEventListener('contextmenu', e => {
                e.preventDefault();
                const sectionId = icon.dataset.settingsSection;
                if (sectionId) {
                    this.popSettingsToGrid(sectionId);
                }
            });
            icon.addEventListener('dragover', e => {
                e.preventDefault();
                icon.classList.add('drag-over');
            });
            icon.addEventListener('dragleave', () => icon.classList.remove('drag-over'));
            icon.addEventListener('drop', e => {
                icon.classList.remove('drag-over');

                // Case 1: Dragging a source (Input 1, etc.) to a sidebar icon
                const sourceId = e.dataTransfer.getData('application/x-source-id');
                if (sourceId) {
                    e.preventDefault();
                    this.selectSource(sourceId);
                    icon.click();
                    return;
                }

                // Case 1.1: Dragging an Overlay slot to a sidebar icon
                const overlayIndex = e.dataTransfer.getData('application/x-overlay-index');
                if (overlayIndex !== "") {
                    e.preventDefault();
                    this.selectOverlaySlot(parseInt(overlayIndex));
                    icon.click();
                    return;
                }

                // Case 2: Dragging a popped-out widget back to its icon to dock
                const widgetDockId = e.dataTransfer.getData('application/x-switcher-widget-dock-id');
                if (widgetDockId && icon.dataset.settingsSection === widgetDockId) {
                    e.preventDefault();
                    this.dockSettings(widgetDockId, `#widget-${widgetDockId}`);
                }
            });
        });
    }

    popSettingsToGrid(sectionId, dropX = null, dropY = null) {
        const section = document.getElementById(sectionId);
        if (!section || section.classList.contains('in-workspace')) return;

        const grid = this.grid || (document.querySelector('#centerGrid')?.gridstack);
        if (!grid) return;

        // Capture children BEFORE hiding the section
        const title = section.querySelector('h3')?.textContent?.trim() || sectionId.replace('settings-', '').replace(/-/g, ' ');
        const widgetId = `widget-${sectionId}`;

        // Collect content children first (before section becomes display:none)
        const contentChildren = Array.from(section.children).filter(child =>
            child.tagName !== 'H3' &&
            !child.classList.contains('settings-header') &&
            !child.classList.contains('workspace-placeholder-msg')
        );

        const widgetContent = `
        <div class="grid-stack-item-content panel-shell settings-widget" id="${widgetId}-container">
            <div class="panel-tools">
                <button class="panel-btn" onclick="app.dockSettings('${sectionId}', '${widgetId}')" title="Dock back to sidebar">
                    <span class="codicon codicon-link-external" style="transform: rotate(180deg); font-size: 10px;"></span>
                </button>
            </div>
            <div class="row-head">
                <div class="row-title">${title}</div>
            </div>
            <div class="settings-widget-body" id="${widgetId}-body" style="height: calc(100% - 30px); overflow-y: auto; padding: 8px;"></div>
        </div>
    `;

        let cell = null;
        if (typeof dropX === 'number' && typeof dropY === 'number' && typeof grid.getCellFromPixel === 'function') {
            try {
                cell = grid.getCellFromPixel({ left: dropX, top: dropY }, true);
            } catch { }
        }

        const widget = grid.addWidget({
            w: 4,
            h: 8,
            x: cell?.x,
            y: cell?.y,
            content: '',
            autoPosition: !cell
        });

        const contentEl = widget?.el?.querySelector('.grid-stack-item-content');
        if (contentEl) {
            contentEl.innerHTML = widgetContent;
        }

        // Mark as in workspace AFTER getting the children reference
        section.classList.add('in-workspace');

        // Add a placeholder to the sidebar immediately
        const placeholder = document.createElement('div');
        placeholder.className = 'workspace-placeholder-msg';
        placeholder.id = `${sectionId}-placeholder`;
        placeholder.innerHTML = `
        <span class="codicon codicon-info"></span>
        <p>Panel is active in workspace grid.</p>
        <button style="margin-top:10px; width:100%; border: 1px solid var(--cyan); background: rgba(0, 122, 204, 0.1); color: var(--text-light); padding: 8px; border-radius: 4px; cursor: pointer;" onclick="app.dockSettings('${sectionId}', '${widgetId}')">
            <span class="codicon codicon-link-external"></span> Restore to Sidebar
        </button>
    `;
        section.appendChild(placeholder);

        // Migrate content after DOM is ready
        const migrate = () => {
            const body = document.getElementById(`${widgetId}-body`) ||
                widget.el?.querySelector('.settings-widget-body');
            if (body) {
                contentChildren.forEach(child => body.appendChild(child));
                return true;
            }
            return false;
        };

        requestAnimationFrame(() => {
            if (!migrate()) setTimeout(migrate, 100);
        });

        this.showSettingsSection(sectionId);
        this.savePersistedState();
    }

    dockSettings(sectionId, widgetElOrId) {
        const section = document.getElementById(sectionId);
        const widgetId = `widget-${sectionId}`;

        // Resolve the widget grid-stack-item element
        let widgetGridItem = document.getElementById(widgetElOrId) ||
            document.querySelector(`[id="${widgetElOrId}"]`);
        if (!widgetGridItem) {
            // Try finding by the container inside
            const container = document.getElementById(`${widgetId}-container`);
            widgetGridItem = container?.closest('.grid-stack-item');
        }

        if (!section) return;

        // Body element where content lives
        const widgetBody = document.getElementById(`${widgetId}-body`) ||
            widgetGridItem?.querySelector('.settings-widget-body');
        const placeholder = document.getElementById(`${sectionId}-placeholder`);

        if (widgetBody) {
            // Move children back to sidebar section (before header if present)
            Array.from(widgetBody.children).forEach(child => {
                section.appendChild(child);
            });
        }

        // Remove placeholder
        placeholder?.remove();
        section.classList.remove('in-workspace');

        // Remove widget from grid
        const grid = this.grid || (document.querySelector('#centerGrid')?.gridstack);
        if (grid && widgetGridItem) {
            grid.removeWidget(widgetGridItem);
        }

        // Show this section in sidebar
        this.showSettingsSection(sectionId);

        // Save state
        this.savePersistedState();
    }

    dockLayoutToSidebar(panelId) {
        const panelEl = document.getElementById(panelId);
        if (!panelEl) return;

        const grid = this.grid || (document.querySelector('#centerGrid')?.gridstack);
        if (!grid) return;

        const gridItem = panelEl.closest('.grid-stack-item');
        if (!gridItem) return;

        panelEl.style.display = 'none';
        gridItem.style.display = 'none';

        // Show the corresponding icon in the sidebar
        const dockIcon = document.querySelector(`.layout-dock-icon[data-layout-panel="${panelId}"]`);
        if (dockIcon) {
            dockIcon.style.display = 'flex';
            dockIcon.classList.add('dock-pulsing');
            setTimeout(() => dockIcon.classList.remove('dock-pulsing'), 1000);

            // Start live preview: draw a downscaled snapshot of the panel into the canvas thumbnail
            const previewKey = panelId.replace('PanelContent', '');
            const previewCanvas = document.getElementById(`preview-dock-${previewKey}`);
            if (previewCanvas) {
                const ctx = previewCanvas.getContext('2d');
                // Find any canvas inside the panel to mirror, or draw placeholder
                const sourceCanvas = panelEl.querySelector('canvas');
                let frameSince = 0;
                const FPS_INTERVAL = 1000 / 5; // 5fps
                const drawPreview = (ts) => {
                    // Only draw if icon is still visible
                    if (dockIcon.style.display === 'none') return;
                    if (!this._previewRAF) return;
                    if (ts - frameSince >= FPS_INTERVAL) {
                        frameSince = ts;
                        ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
                        if (sourceCanvas && sourceCanvas.width > 0) {
                            try { ctx.drawImage(sourceCanvas, 0, 0, previewCanvas.width, previewCanvas.height); } catch (e) { }
                        } else {
                            // Draw placeholder grid lines
                            ctx.fillStyle = '#0a1520';
                            ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
                            ctx.strokeStyle = 'rgba(0,122,204,0.25)';
                            ctx.lineWidth = 1;
                            for (let i = 0; i < previewCanvas.width; i += 14) {
                                ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, previewCanvas.height); ctx.stroke();
                            }
                            for (let j = 0; j < previewCanvas.height; j += 14) {
                                ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(previewCanvas.width, j); ctx.stroke();
                            }
                            ctx.fillStyle = 'rgba(0,122,204,0.6)';
                            ctx.font = '7px monospace';
                            ctx.fillText(previewKey.toUpperCase(), 4, previewCanvas.height - 4);
                        }
                    }
                    this._previewRAFHandles = this._previewRAFHandles || {};
                    this._previewRAFHandles[panelId] = requestAnimationFrame(drawPreview);
                };
                this._previewRAF = true;
                this._previewRAFHandles = this._previewRAFHandles || {};
                this._previewRAFHandles[panelId] = requestAnimationFrame(drawPreview);
            }
        }
    }

    restoreLayoutFromSidebar(panelId) {
        const panelEl = document.getElementById(panelId);
        const grid = this.grid || (document.querySelector('#centerGrid')?.gridstack);
        if (!panelEl || !grid) return;

        const gridItem = panelEl.closest('.grid-stack-item');
        if (!gridItem) return;

        // Show it back
        panelEl.style.display = '';
        gridItem.style.display = '';

        // Gridstack might need an update to realize it's back if we just hid it
        grid.makeWidget(gridItem);

        // Stop preview RAF loop
        if (this._previewRAFHandles?.[panelId]) {
            cancelAnimationFrame(this._previewRAFHandles[panelId]);
            delete this._previewRAFHandles[panelId];
        }

        // Clear preview canvas
        const previewKey = panelId.replace('PanelContent', '');
        const previewCanvas = document.getElementById(`preview-dock-${previewKey}`);
        if (previewCanvas) {
            previewCanvas.getContext('2d').clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        }

        // Hide the icon
        const dockIcon = document.querySelector(`.layout-dock-icon[data-layout-panel="${panelId}"]`);
        if (dockIcon) dockIcon.style.display = 'none';
    }

    initLayoutDocking() {
        // Listeners for layout dock icons in the activity bar
        document.querySelectorAll('.layout-dock-icon').forEach(icon => {
            icon.addEventListener('click', () => {
                const sectionId = icon.dataset.settingsSection;
                if (sectionId) this.showSettingsSection(sectionId);
            });
        });
    }

    bindDockControls() {
        // This was previously empty or missing, now consolidated with settings docking
        // and layout docking. Any global docking event listeners go here.
    }

    updateShellLayout() {
        const shell = document.getElementById('appShell');
        if (shell) {
            shell.classList.remove('left-hidden', 'right-hidden');
        }
    }

    initMovableSidePanels() {
        // Only right panel is movable now (left panel removed)
        const panelId = 'rightPanel';
        const panel = document.getElementById(panelId);
        if (!panel) return;

        let startX = 0;
        let startY = 0;
        let tx = 0;
        let ty = 0;
        let dragging = false;
        panel.dataset.tx = '0';
        panel.dataset.ty = '0';

        panel.addEventListener('pointerdown', e => {
            const isHeader = e.target.closest('h3');
            if (!isHeader || panel.classList.contains('is-collapsed')) return;
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            tx = Number(panel.dataset.tx || 0);
            ty = Number(panel.dataset.ty || 0);
            panel.setPointerCapture(e.pointerId);
        });

        panel.addEventListener('pointermove', e => {
            if (!dragging) return;
            const nextX = tx + (e.clientX - startX);
            const nextY = ty + (e.clientY - startY);
            panel.style.transform = `translate(${nextX}px, ${nextY}px)`;
            panel.dataset.tx = String(nextX);
            panel.dataset.ty = String(nextY);
        });

        panel.addEventListener('pointerup', e => {
            dragging = false;
            panel.releasePointerCapture(e.pointerId);
        });
    }

    async ensureWebGLForChroma() {
        const selector = document.getElementById('rendererSelect');
        if (selector.value === 'webgl2') return;
        try {
            await this.engine.setBackend(new WebGL2Backend());
            await this.previewEngine.setBackend(new WebGL2Backend());
            selector.value = 'webgl2';
        } catch {
            await this.engine.setBackend(new CanvasBackend());
            await this.previewEngine.setBackend(new CanvasBackend());
            selector.value = 'canvas';
        }
        this.canvas = document.getElementById('outputCanvas');
        this.previewCanvas = document.getElementById('previewDisplayCanvas');
        this.syncPreviewEngineSource();
    }

    async applySourceChromaState(source, autoWebGL) {
        source.node.chromaEnabled = !!source.chromaEnabled;
        if (source.node.chromaEnabled) {
            source.node.setChromaType(source.chromaType || 'basic');
            if (autoWebGL) await this.ensureWebGLForChroma();
        }
    }

    setChromaControlsDisabled(disabled) {
        [
            'similarity', 'smoothness', 'spill', 'thresholdLow', 'thresholdHigh',
            'edgeShrink', 'edgeBlur', 'lightWrap', 'keyColor', 'chromaType'
        ].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = disabled;
        });
    }

    createBootstrapSource() {
        const media = this.createPlaceholderCanvas('Source 1', 'Right click input to assign media');
        const source = this.createSource('Source 1', media, 'placeholder');
        source.chromaType = 'basic';
        source.chromaEnabled = true;
        source.chromaParams = {
          basic: {
            keyColor: [0.0, 1.0, 0.0],
            similarity: 0.35,
            smoothness: 0.15,
            spill: 0.6,
            thresholdLow: 0.0,
            thresholdHigh: 1.0,
            edgeShrink: 0.0,
            edgeBlur: 0.0,
            lightWrap: 0.0
          }
        };
        this.assignSourceToInputSlot(source.id, 0);
        this.setPreviewSource(source.id);
        this.setProgramSource(source.id);
        this.selectSource(source.id);
    }

    createSource(label, mediaElement, type) {
        const id = `src-${Date.now()}-${this.sourceSeed++}`;
        const node = new InputNode(id, mediaElement, null);
        this.engine.addNode(node);
        const source = {
            id,
            label,
            type,
            mediaElement,
            audioElement: mediaElement instanceof HTMLMediaElement ? mediaElement : null,
            mediaStream: null,
            node,
            chromaType: 'basic',
            chromaEnabled: false,
            browserUrl: '',
            audioMuted: false,
            chromaParams: {
              basic: {
                keyColor: [0.0, 1.0, 0.0],
                similarity: 0.35,
                smoothness: 0.15,
                spill: 0.6,
                thresholdLow: 0.0,
                thresholdHigh: 1.0,
                edgeShrink: 0.0,
                edgeBlur: 0.0,
                lightWrap: 0.0
              },
              advanced: {
                keyColor: [0.0, 1.0, 0.0],
                similarity: 0.35,
                smoothness: 0.15,
                spill: 0.6,
                thresholdLow: 0.0,
                thresholdHigh: 1.0,
                edgeShrink: 0.0,
                edgeBlur: 0.0,
                lightWrap: 0.0
              },
              enterprise: {
                keyColor: [0.0, 1.0, 0.0],
                similarity: 0.35,
                smoothness: 0.15,
                spill: 0.6,
                thresholdLow: 0.0,
                thresholdHigh: 1.0,
                edgeShrink: 0.0,
                edgeBlur: 0.0,
                lightWrap: 0.0
              },
              trueenterprise: {
                keyColor: [0.0, 1.0, 0.0],
                similarity: 0.35,
                smoothness: 0.15,
                spill: 0.6,
                thresholdLow: 0.0,
                thresholdHigh: 1.0,
                edgeShrink: 0.0,
                edgeBlur: 0.0,
                lightWrap: 0.0
              },
              broadcast: {
                keyColor: [0.0, 1.0, 0.0],
                similarity: 0.35,
                smoothness: 0.15,
                spill: 0.6,
                thresholdLow: 0.0,
                thresholdHigh: 1.0,
                edgeShrink: 0.0,
                edgeBlur: 0.0,
                lightWrap: 0.0
              },
              cinematic: {
                keyColor: [0.0, 1.0, 0.0],
                similarity: 0.35,
                smoothness: 0.15,
                spill: 0.6,
                thresholdLow: 0.0,
                thresholdHigh: 1.0,
                edgeShrink: 0.0,
                edgeBlur: 0.0,
                lightWrap: 0.0
              }
            }
        };
        this.sources.push(source);
        return source;
    }

    getSource(sourceId) {
        return this.sources.find(s => s.id === sourceId) || null;
    }

    ensureSourceForSlot(slotIndex) {
        const existing = this.inputSlots[slotIndex];
        if (existing) return this.getSource(existing);
        const idx = this.sources.length + 1;
        const media = this.createPlaceholderCanvas(`Source ${idx}`, 'Awaiting media assignment');
        const source = this.createSource(`Source ${idx}`, media, 'placeholder');
        this.assignSourceToInputSlot(source.id, slotIndex);
        return source;
    }

    assignSourceToInputSlot(sourceId, slotIndex) {
        this.inputSlots[slotIndex] = sourceId;
        if (!this.selectedSourceId) this.selectSource(sourceId);
        this.refreshInputBus();
    }

    buildInputBus() {
        // Destroy existing renderers
        this.inputPreviewRenderers.forEach(r => { if (r) r.destroy(); });
        this.inputPreviewRenderers = [];

        const container = document.getElementById('inputBus');
        if (!container) return;
        container.innerHTML = '';
        this.inputSlotEls = [];

        for (let i = 0; i < this.inputSlots.length; i++) {
            const slot = document.createElement('div');
            slot.className = 'input-slot';
            slot.dataset.slot = String(i);
            slot.draggable = true;

            const head = document.createElement('div');
            head.className = 'slot-head';
            
            const titleSpan = document.createElement('span');
            titleSpan.className = 'slot-title';
            titleSpan.textContent = `IN ${i + 1}`;
            
            head.appendChild(titleSpan);

            const chromaToggle = document.createElement('span');
            chromaToggle.className = 'chroma-toggle-btn codicon codicon-color-mode';
            chromaToggle.title = 'Toggle Chroma Key';

            chromaToggle.addEventListener('click', async (e) => {
                e.stopPropagation();
                const sourceId = this.inputSlots[i];
                if (!sourceId) return;
                const source = this.getSource(sourceId);
                if (!source) return;
                
                source.chromaEnabled = !source.chromaEnabled;
                await this.applySourceChromaState(source, true);
                
                // Sync settings panel if this is the currently selected source
                if (this.selectedSourceId === source.id) {
                    const cb = document.getElementById('chromaEnable');
                    if (cb) cb.checked = source.chromaEnabled;
                    this.setChromaControlsDisabled(!source.chromaEnabled);
                }
                
                this.refreshInputBus();
                this.syncPreviewEngineSource();
            });

            const muteToggle = document.createElement('span');
            muteToggle.className = 'audio-toggle-btn codicon codicon-unmute';
            muteToggle.title = 'Toggle Audio Mute';

            muteToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const sourceId = this.inputSlots[i];
                if (!sourceId) return;

                const source = this.getSource(sourceId);
                if (!source) return;

                source.audioMuted = !source.audioMuted;
                this.sourceMutes[i] = !!source.audioMuted;
                this.applySourceMuteState(source);

                if (this.selectedSourceId === sourceId) {
                    const cb = document.getElementById('sourceMute');
                    if (cb) cb.checked = !!source.audioMuted;
                }

                this.refreshInputBus();
            });

            const previewCanvas = document.createElement('canvas');
            previewCanvas.className = 'slot-preview-canvas';
            previewCanvas.width = 320;
            previewCanvas.height = 180;

            const browserFrame = document.createElement('iframe');
            browserFrame.className = 'slot-browser';
            browserFrame.src = 'about:blank';

            const audioMeter = document.createElement('div');
            audioMeter.className = 'audio-meter';
            audioMeter.innerHTML = '<div class="bar"></div><div class="bar"></div>';

            const badge = document.createElement('div');
            badge.className = 'slot-index';
            badge.textContent = String(i + 1);

            slot.appendChild(head);
            slot.appendChild(previewCanvas);
            slot.appendChild(browserFrame);
            slot.appendChild(audioMeter);
            slot.appendChild(badge);
            slot.appendChild(chromaToggle);
            slot.appendChild(muteToggle);

            slot.addEventListener('dragstart', e => {
                const sourceId = this.inputSlots[i];
                if (!sourceId) {
                    e.preventDefault();
                    return;
                }
                e.dataTransfer.setData('application/x-source-id', sourceId);
            });

            slot.addEventListener('dragover', e => e.preventDefault());
            slot.addEventListener('drop', e => this.onInputDrop(e, i));
            slot.addEventListener('click', () => this.onInputSingleClick(i));
            slot.addEventListener('dblclick', () => this.onInputDoubleClick(i));
            slot.addEventListener('contextmenu', e => this.openContextMenu(e, i));

            container.appendChild(slot);
            this.inputSlotEls.push({ slot, head, titleSpan, chromaToggle, muteToggle, previewCanvas, browserFrame, audioMeter });

            this.inputPreviewRenderers[i] = new RealtimePreviewRenderer(
                previewCanvas,
                () => this.getRenderableElement(this.inputSlots[i]),
                { preferWebGL: false }
            );
        }

        this.refreshInputBus();
    }

    refreshInputBus() {
        this.inputSlotEls.forEach((entry, index) => {
            const sourceId = this.inputSlots[index];
            if (!sourceId) {
                entry.titleSpan.textContent = `IN ${index + 1}`;
                entry.head.title = `IN ${index + 1}`;
                entry.chromaToggle.style.display = 'none';
                entry.muteToggle.style.display = 'none';
                entry.slot.classList.remove('is-program', 'is-preview', 'is-selected');
                this.setIframeSource(entry.browserFrame, '');
                entry.browserFrame.style.display = 'none';
                entry.previewCanvas.style.display = 'block';
                return;
            }

            const source = this.getSource(sourceId);
            if (!source) return;

            entry.titleSpan.textContent = `IN ${index + 1} · ${this.truncateName(source.label)}`;
            entry.head.title = source.label;
            
            entry.chromaToggle.style.display = 'block';
            entry.chromaToggle.classList.toggle('is-active', !!source.chromaEnabled);

            entry.muteToggle.style.display = 'block';
            const isMuted = !!source.audioMuted;
            this.sourceMutes[index] = isMuted;
            entry.muteToggle.classList.toggle('is-muted', isMuted);
            entry.muteToggle.classList.toggle('is-unmuted', !isMuted);
            entry.muteToggle.classList.toggle('codicon-mute', isMuted);
            entry.muteToggle.classList.toggle('codicon-unmute', !isMuted);

            const showBrowser = source.type === 'browser' && !!source.browserUrl;
            if (showBrowser) {
                this.setIframeSource(entry.browserFrame, source.browserUrl);
                entry.browserFrame.style.display = 'block';
                entry.previewCanvas.style.display = 'none';
            } else {
                this.setIframeSource(entry.browserFrame, '');
                entry.browserFrame.style.display = 'none';
                entry.previewCanvas.style.display = 'block';
            }

            entry.slot.classList.toggle('is-program', source.id === this.activeProgramId);
            entry.slot.classList.toggle('is-preview', source.id === this.activePreviewId);
            entry.slot.classList.toggle('is-selected', source.id === this.selectedSourceId);
        });
    }

    onInputDrop(event, slotIndex) {
        event.preventDefault();
        const action = event.dataTransfer.getData('application/x-switcher-action');
        if (action === 'create-source') {
            const idx = this.sources.length + 1;
            const media = this.createPlaceholderCanvas(`Source ${idx}`, 'New source');
            const source = this.createSource(`Source ${idx}`, media, 'placeholder');
            this.assignSourceToInputSlot(source.id, slotIndex);
            return;
        }

        const assetFileHandle = this.extractAssetFromDrop(event);
        if (assetFileHandle) {
            this.createSourceFromAsset(assetFileHandle).then(source => {
                this.assignSourceToInputSlot(source.id, slotIndex);
            });
            return;
        }

        const sourceId = this.extractSourceFromDrop(event);
        if (sourceId) this.assignSourceToInputSlot(sourceId, slotIndex);
    }

    onInputSingleClick(slotIndex) {
        const sourceId = this.inputSlots[slotIndex];
        if (!sourceId) return;
        this.ensureAudioContext(true);
        this.setPreviewSource(sourceId);
        this.selectSource(sourceId);
        this.syncRecordingIndexesFromSelection();
        if (this.selectedAuxIndex !== null) this.assignAuxSource(this.selectedAuxIndex, sourceId);
    }

    onInputDoubleClick(slotIndex) {
        const sourceId = this.inputSlots[slotIndex];
        if (!sourceId) return;
        this.ensureAudioContext(true);
        this.setProgramSource(sourceId);
        this.selectSource(sourceId);
        this.syncRecordingIndexesFromSelection();
    }

    buildAuxRouter() {
        // Destroy existing renderers
        this.auxPreviewRenderers.forEach(r => { if (r) r.destroy(); });
        this.auxPreviewRenderers = [];

        const container = document.getElementById('auxRouter');
        if (!container) return;
        container.innerHTML = '';
        this.auxSlotEls = [];

        for (let i = 0; i < this.auxSlots.length; i++) {
            const aux = document.createElement('div');
            aux.className = 'aux-slot';
            aux.dataset.aux = String(i);

            const head = document.createElement('div');
            head.className = 'aux-head';
            head.textContent = `AUX ${i + 1}`;

            const previewCanvas = document.createElement('canvas');
            previewCanvas.className = 'aux-preview-canvas';
            previewCanvas.width = 320;
            previewCanvas.height = 180;

            const browserFrame = document.createElement('iframe');
            browserFrame.className = 'aux-browser';
            browserFrame.src = 'about:blank';

            const audioMeter = document.createElement('div');
            audioMeter.className = 'audio-meter';
            audioMeter.innerHTML = '<div class="bar"></div><div class="bar"></div>';

            aux.appendChild(head);
            aux.appendChild(previewCanvas);
            aux.appendChild(browserFrame);
            aux.appendChild(audioMeter);

            aux.addEventListener('click', () => {
                this.selectedAuxIndex = i;
                const sourceId = this.auxSlots[i];
                if (sourceId) this.selectSource(sourceId);
                this.syncRecordingIndexesFromSelection();
                this.refreshAuxRouter();
            });

            aux.addEventListener('dragover', e => e.preventDefault());
            aux.addEventListener('drop', e => {
                e.preventDefault();
                const sourceId = this.extractSourceFromDrop(e);
                if (sourceId) this.assignAuxSource(i, sourceId);
            });

            container.appendChild(aux);
            this.auxSlotEls.push({ aux, head, previewCanvas, browserFrame, audioMeter });

            this.auxPreviewRenderers[i] = new RealtimePreviewRenderer(
                previewCanvas,
                () => this.getRenderableElement(this.auxSlots[i]),
                { preferWebGL: false }
            );
        }

        this.refreshAuxRouter();
    }

    buildOverlayBus() {
        // Destroy existing renderers
        this.overlayPreviewRenderers.forEach(r => { if (r) r.destroy(); });
        this.overlayPreviewRenderers = [];

        const container = document.getElementById('overlayBus');
        if (!container) return;
        container.innerHTML = '';
        this.overlaySlotEls = [];

        for (let i = 0; i < this.overlaySlots.length; i++) {
            const slot = document.createElement('div');
            slot.className = 'overlay-slot';
            slot.dataset.overlay = String(i);

            const head = document.createElement('div');
            head.className = 'overlay-head';
            
            const titleSpan = document.createElement('span');
            titleSpan.className = 'overlay-title';
            titleSpan.textContent = `OVL ${i + 1}`;
            
            head.appendChild(titleSpan);

            const engineToggle = document.createElement('span');
            engineToggle.className = 'overlay-engine-switch';
            engineToggle.textContent = 'PRW';
            engineToggle.title = 'Switch Target Engine (PGM/PRW)';

            const pgmToggle = document.createElement('span');
            pgmToggle.className = 'overlay-toggle-pgm codicon codicon-collection';
            pgmToggle.title = 'Toggle PGM Overlay';

            engineToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!this.overlaySlots[i]) return;
                
                const isPgm = this.overlayProgramActive[i];
                const isPrw = this.overlayPreviewActive[i];
                
                if (isPgm || isPrw) {
                    this.overlayProgramActive[i] = isPrw;
                    this.overlayPreviewActive[i] = isPgm;
                } else {
                    // Just toggle preference if neither active
                }
                
                this.refreshOverlayBus();
                this.renderOverlayTargets();
            });

            pgmToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.onOverlayDoubleClick(i);
            });

            const previewCanvas = document.createElement('canvas');
            previewCanvas.className = 'overlay-preview-canvas';
            previewCanvas.width = 320;
            previewCanvas.height = 180;

            const badge = document.createElement('div');
            badge.className = 'slot-index';
            badge.textContent = String(i + 1);

            const audioMeter = document.createElement('div');
            audioMeter.className = 'audio-meter';
            audioMeter.innerHTML = '<div class="bar"></div><div class="bar"></div>';

            slot.appendChild(head);
            slot.appendChild(previewCanvas);
            slot.appendChild(badge);
            slot.appendChild(audioMeter);
            slot.appendChild(engineToggle);
            slot.appendChild(pgmToggle);

            slot.addEventListener('click', () => this.onOverlaySingleClick(i));
            slot.addEventListener('dblclick', () => this.onOverlayDoubleClick(i));
            slot.addEventListener('contextmenu', e => this.openOverlayContextMenu(e, i));

            container.appendChild(slot);
            this.overlaySlotEls.push({ slot, head, titleSpan, engineToggle, pgmToggle, previewCanvas, audioMeter });

            slot.addEventListener('dragover', e => e.preventDefault());
            slot.addEventListener('drop', e => this.onOverlayDrop(e, i));

            this.overlayPreviewRenderers[i] = new RealtimePreviewRenderer(
                previewCanvas,
                () => {
                    const overlay = this.overlaySlots[i];
                    return overlay ? overlay.mediaElement : null;
                },
                { preferWebGL: false }
            );
        }

        this.refreshOverlayBus();
        this.renderOverlayTargets();
    }

    refreshOverlayBus() {
        this.overlaySlotEls.forEach((entry, index) => {
            const overlay = this.overlaySlots[index];

            if (overlay) {
                entry.titleSpan.textContent = `OVL ${index + 1} · ${this.truncateName(overlay.label)}`;
                entry.head.title = overlay.label;
                entry.engineToggle.style.display = 'block';
                entry.pgmToggle.style.display = 'block';
            } else {
                entry.titleSpan.textContent = `OVL ${index + 1}`;
                entry.head.title = `OVL ${index + 1}`;
                entry.engineToggle.style.display = 'none';
                entry.pgmToggle.style.display = 'none';
            }

            const isPgm = !!this.overlayProgramActive[index];
            const isPrw = !!this.overlayPreviewActive[index];

            entry.slot.classList.toggle('is-preview', isPrw);
            entry.slot.classList.toggle('is-program', isPgm);
            entry.slot.classList.toggle('is-selected', this.selectedOverlayIndex === index);

            entry.pgmToggle.classList.toggle('is-active', isPgm);
            
            entry.engineToggle.textContent = isPgm ? 'PGM' : (isPrw ? 'PRW' : 'PRW');
            entry.engineToggle.classList.toggle('is-pgm', isPgm);
            entry.engineToggle.classList.toggle('is-prw', isPrw && !isPgm);
        });
    }

    onOverlaySingleClick(slotIndex) {
        if (!this.overlaySlots[slotIndex]) return;
        this.selectOverlaySlot(slotIndex);
        this.overlayPreviewActive[slotIndex] = !this.overlayPreviewActive[slotIndex];
        this.refreshOverlayBus();
        this.renderOverlayTargets();
    }

    onOverlayDoubleClick(slotIndex) {
        if (!this.overlaySlots[slotIndex]) return;
        this.selectOverlaySlot(slotIndex);
        this.overlayProgramActive[slotIndex] = !this.overlayProgramActive[slotIndex];
        this.refreshOverlayBus();
        this.renderOverlayTargets();
    }

    openOverlayContextMenu(event, slotIndex) {
        event.preventDefault();
        this.hideContextMenu();
        this.overlayContextSlotIndex = slotIndex;
        const menu = document.getElementById('overlayContextMenu');
        if (!menu) return;
        menu.style.left = `${event.pageX}px`;
        menu.style.top = `${event.pageY}px`;
        menu.style.display = 'block';
    }

    hideOverlayContextMenu() {
        const menu = document.getElementById('overlayContextMenu');
        if (menu) menu.style.display = 'none';
    }

    handleOverlayContextAction(action) {
        this.hideOverlayContextMenu();
        if (this.overlayContextSlotIndex === null) return;
        const slotIndex = this.overlayContextSlotIndex;

        if (action === 'overlay-clear') {
            this.overlaySlots[slotIndex] = null;
            this.overlayPreviewActive[slotIndex] = false;
            this.overlayProgramActive[slotIndex] = false;
            if (this.selectedOverlayIndex === slotIndex) this.selectedOverlayIndex = null;
            this.refreshOverlayBus();
            this.updateCgSettingsPanel();
            this.renderOverlayTargets();
            return;
        }

        if (action === 'overlay-video') {
            this.openFilePicker('.mov,.webm,video/quicktime,video/webm', file => {
                this.createMediaFromFile(file).then(media => {
                    if (!media) return;
                    this.overlaySlots[slotIndex] = {
                        id: `ovl-${Date.now()}-${slotIndex}`,
                        label: file.name.replace(/\.[^.]+$/, ''),
                        type: 'video',
                        mediaElement: media.element,
                        settings: this.getDefaultOverlaySettings()
                    };
                    this.selectOverlaySlot(slotIndex);
                    this.refreshOverlayBus();
                    this.updateCgSettingsPanel();
                    this.renderOverlayTargets();
                });
            });
        }

        if (action === 'overlay-image') {
            this.openFilePicker('.png,.webp,.gif,image/png,image/webp,image/gif', file => {
                this.createMediaFromFile(file).then(media => {
                    if (!media) return;
                    this.overlaySlots[slotIndex] = {
                        id: `ovl-${Date.now()}-${slotIndex}`,
                        label: file.name.replace(/\.[^.]+$/, ''),
                        type: 'image',
                        mediaElement: media.element,
                        settings: this.getDefaultOverlaySettings()
                    };
                    this.selectOverlaySlot(slotIndex);
                    this.refreshOverlayBus();
                    this.updateCgSettingsPanel();
                    this.renderOverlayTargets();
                });
            });
        }
    }

    buildOverlayMediaNode(overlay, index) {
        if (!overlay || !overlay.mediaElement) return null;
        const settings = this.ensureOverlaySettings(overlay);
        const media = overlay.mediaElement;

        if (overlay.type === 'image') {
            const img = document.createElement('img');
            img.className = 'overlay-item';
            img.dataset.slot = String(index);
            img.dataset.source = media.src || '';
            img.src = media.src;
            img.alt = overlay.label || `Overlay ${index + 1}`;
            img.style.zIndex = String(index + 1);
            img.title = overlay.label || `OVL ${index + 1}`;
            this.applyOverlayItemStyle(img, settings, true);
            return img;
        }

        if (overlay.type === 'video') {
            const video = document.createElement('video');
            video.className = 'overlay-item';
            video.dataset.slot = String(index);
            video.dataset.source = media.src || '';
            video.src = media.src;
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.autoplay = true;
            video.style.zIndex = String(index + 1);
            video.title = overlay.label || `OVL ${index + 1}`;
            this.applyOverlayItemStyle(video, settings, true);
            video.play().catch(() => { });
            return video;
        }

        return null;
    }

    renderOverlayLayer(containerId, activeMask) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const activeSlots = new Set();

        for (let i = 0; i < this.overlaySlots.length; i++) {
            if (!activeMask[i]) continue;
            const overlay = this.overlaySlots[i];
            if (!overlay) continue;

            activeSlots.add(String(i));
            const settings = this.ensureOverlaySettings(overlay);
            let item = container.querySelector(`.overlay-item[data-slot="${i}"]`);
            const src = overlay.mediaElement?.src || '';

            if (!item || item.dataset.source !== src || item.tagName.toLowerCase() !== (overlay.type === 'video' ? 'video' : 'img')) {
                if (item) item.remove();
                item = this.buildOverlayMediaNode(overlay, i);
                if (item) container.appendChild(item);
            }

            if (item) this.applyOverlayItemStyle(item, settings);
        }

        Array.from(container.querySelectorAll('.overlay-item')).forEach(item => {
            if (!activeSlots.has(item.dataset.slot || '')) item.remove();
        });
    }

    renderOverlayTargets() {
        this.renderOverlayLayer('previewOverlayLayer', this.overlayPreviewActive);
        this.renderOverlayLayer('programOverlayLayer', this.overlayProgramActive);
        this.renderOverlayLayer('masterOverlayLayer', this.overlayProgramActive);
    }

    applyOverlayItemStyle(item, settings, isFirstPaint = false) {
        const opacity = settings.visible ? settings.opacity : 0;
        const fadeMs = settings.visible ? settings.fadeInMs : settings.fadeOutMs;
        item.style.opacity = String(opacity);
        item.style.transform =
            `translate3d(${settings.translateX}px, ${settings.translateY}px, ${settings.translateZ}px) ` +
            `rotateX(${settings.rotateX}deg) rotateY(${settings.rotateY}deg) rotateZ(${settings.rotateZ}deg) ` +
            `scale3d(${settings.scaleX}, ${settings.scaleY}, ${settings.scaleZ})`;
        item.style.transformOrigin = 'center center';
        item.style.transition = `opacity ${Math.max(0, fadeMs)}ms ease, transform 120ms linear`;
        if (isFirstPaint && settings.visible) {
            item.style.opacity = '0';
            requestAnimationFrame(() => {
                item.style.opacity = String(settings.opacity);
            });
        }
    }

    refreshAuxRouter() {
        this.auxSlotEls.forEach((entry, index) => {
            const sourceId = this.auxSlots[index];
            const source = sourceId ? this.getSource(sourceId) : null;

            if (source) {
                entry.head.textContent = `AUX ${index + 1} · ${this.truncateName(source.label)}`;
                entry.head.title = source.label;
            } else {
                entry.head.textContent = `AUX ${index + 1}`;
                entry.head.title = `AUX ${index + 1}`;
            }

            const showBrowser = source && source.type === 'browser' && !!source.browserUrl;
            if (showBrowser) {
                this.setIframeSource(entry.browserFrame, source.browserUrl);
                entry.browserFrame.style.display = 'block';
                entry.previewCanvas.style.display = 'none';
            } else {
                this.setIframeSource(entry.browserFrame, '');
                entry.browserFrame.style.display = 'none';
                entry.previewCanvas.style.display = 'block';
            }

            entry.aux.classList.toggle('is-active', this.selectedAuxIndex === index);
            entry.aux.classList.toggle('is-program', sourceId && sourceId === this.activeProgramId);
            entry.aux.classList.toggle('is-preview', sourceId && sourceId === this.activePreviewId);
        });
    }

    assignAuxSource(auxIndex, sourceId) {
        this.auxSlots[auxIndex] = sourceId;
        this.selectedAuxIndex = auxIndex;
        this.selectSource(sourceId);
        this.syncRecordingIndexesFromSelection();
        this.refreshAuxRouter();
    }

    setProgramSource(sourceId) {
        const source = this.getSource(sourceId);
        if (!source) return;
        this.activeProgramId = sourceId;
        this.currentInputNode = source.node;
        this.engine.setProgramNode(sourceId);
        this.renderProgramPreview();
        this.setupChromaControls();
        this.refreshInputBus();
        this.renderOverlayTargets();
    }

    setPreviewSource(sourceId) {
        const source = this.getSource(sourceId);
        if (!source) return;
        this.activePreviewId = sourceId;
        this.currentInputNode = source.node;
        this.engine.setPreviewNode(sourceId);
        this.syncPreviewEngineSource();
        this.renderProgramPreview();
        this.setupChromaControls();
        this.refreshInputBus();
        this.renderOverlayTargets();
    }

    doCut() {
        this.engine.cut();
        this.syncPreviewEngineSource();
        this.renderOverlayTargets();
    }

    doAutoTransition() {
        if (!this.activePreviewId) return;
        const duration = Number(document.getElementById('transitionDuration').value || 500);
        const animation = document.getElementById('transitionAnimation').value;
        const effect = document.getElementById('transitionEffect').value;
        const status = document.getElementById('transitionStatus');
        status.textContent = `AUTO ${animation} / ${effect} (${duration}ms)`;
        const outputPanel = document.getElementById('outputPanelContent');
        outputPanel.classList.add('auto-active');
        clearTimeout(this.autoTimer);
        this.autoTimer = setTimeout(() => {
            this.doCut();
            outputPanel.classList.remove('auto-active');
            status.textContent = 'Idle';
        }, duration);
    }

    setIframeSource(iframe, url) {
        let target = url || 'about:blank';
        if (target && target !== 'about:blank' && !/^https?:\/\//i.test(target)) {
            target = `https://${target}`;
        }
        if (iframe.dataset.url === target) return;
        iframe.src = target;
        iframe.dataset.url = target;
    }

    updateProgramPreviewBrowserSurfaces() {
        const pvwSource = this.getSource(this.activePreviewId);
        const pgmSource = this.getSource(this.activeProgramId);
        const pvwCanvas = document.getElementById('previewDisplayCanvas');
        const pvwFrame = document.getElementById('previewBrowserFrame');
        const pgmCanvas = document.getElementById('programDisplayCanvas');
        const pgmFrame = document.getElementById('programBrowserFrame');
        const pvwBrowser = pvwSource && pvwSource.type === 'browser' && pvwSource.browserUrl;
        const pgmBrowser = pgmSource && pgmSource.type === 'browser' && pgmSource.browserUrl;

        if (pvwBrowser) {
            this.setIframeSource(pvwFrame, pvwSource.browserUrl);
            pvwFrame.style.display = 'block';
            pvwCanvas.style.display = 'none';
        } else {
            this.setIframeSource(pvwFrame, '');
            pvwFrame.style.display = 'none';
            pvwCanvas.style.display = 'block';
        }

        if (pgmBrowser) {
            this.setIframeSource(pgmFrame, pgmSource.browserUrl);
            pgmFrame.style.display = 'block';
            pgmCanvas.style.display = 'none';
        } else {
            this.setIframeSource(pgmFrame, '');
            pgmFrame.style.display = 'none';
            pgmCanvas.style.display = 'block';
        }

        const masterCanvas = document.getElementById('outputCanvas');
        const masterFrame = document.getElementById('masterBrowserFrame');

        if (pgmBrowser) {
            this.setIframeSource(masterFrame, pgmSource.browserUrl);
            masterFrame.style.display = 'block';
            masterCanvas.style.display = 'none';
        } else {
            this.setIframeSource(masterFrame, '');
            masterFrame.style.display = 'none';
            masterCanvas.style.display = 'block';
        }
    }

    renderProgramPreview() {
        const pgmName = this.activeProgramId ? this.getSource(this.activeProgramId)?.label : 'None';
        const pvwName = this.activePreviewId ? this.getSource(this.activePreviewId)?.label : 'None';
        document.getElementById('programName').textContent = this.truncateName(pgmName || 'None');
        document.getElementById('programName').title = pgmName || 'None';
        document.getElementById('previewName').textContent = this.truncateName(pvwName || 'None');
        document.getElementById('previewName').title = pvwName || 'None';
        document.getElementById('programDrop').dataset.sourceId = this.activeProgramId || '';
        document.getElementById('previewDrop').dataset.sourceId = this.activePreviewId || '';
        this.updateProgramPreviewBrowserSurfaces();
        this.renderOverlayTargets();
    }

    selectSource(sourceId) {
        const source = this.getSource(sourceId);
        if (!source) return;
        this.selectedSourceId = sourceId;
        this.currentInputNode = source.node;
        this.currentInputNode.chromaEnabled = !!source.chromaEnabled;
        document.getElementById('settingsSourceName').textContent = `${source.label} (${source.type})`;
        document.getElementById('chromaType').value = source.chromaType || 'basic';
        document.getElementById('chromaEnable').checked = !!source.chromaEnabled;
        document.getElementById('sourceMute').checked = !!source.audioMuted;
        this.setChromaControlsDisabled(!source.chromaEnabled);
        this.updateChromaUI(source.chromaType || 'basic');
        
        // Load params for current type
        const type = source.chromaType || 'basic';
        this.loadChromaParams(type);
        
        this.setupChromaControls();
        this.refreshInputBus();
        this.browserModule.showSource(source);
        this.applySourceMuteState(source);
        this.syncRecordingIndexesFromSelection();
    }

    openContextMenu(event, slotIndex) {
        event.preventDefault();
        this.hideOverlayContextMenu();
        this.contextSlotIndex = slotIndex;
        const menu = document.getElementById('inputContextMenu');
        
        // Only show "Assign Background" if a source is already assigned to this slot
        const sourceId = this.inputSlots[slotIndex];
        const bgBtn = menu.querySelector('[data-action="assign-background"]');
        if (bgBtn) bgBtn.style.display = sourceId ? 'flex' : 'none';

        menu.style.left = `${event.pageX}px`;
        menu.style.top = `${event.pageY}px`;
        menu.style.display = 'block';
    }

    hideContextMenu() {
        document.getElementById('inputContextMenu').style.display = 'none';
    }

    async handleContextAction(action) {
        this.hideContextMenu();
        if (this.contextSlotIndex === null) return;

        if (action === 'clear') {
            const sourceId = this.inputSlots[this.contextSlotIndex];
            const wasProgram = sourceId === this.activeProgramId;
            const wasPreview = sourceId === this.activePreviewId;
            this.inputSlots[this.contextSlotIndex] = null;
            const nextSourceId = this.inputSlots.find(Boolean) || null;
            if (wasProgram && nextSourceId) this.setProgramSource(nextSourceId);
            if (wasPreview && nextSourceId) this.setPreviewSource(nextSourceId);
            if (wasProgram && !nextSourceId) this.activeProgramId = null;
            if (wasPreview && !nextSourceId) this.activePreviewId = null;
            this.refreshInputBus();
            this.renderProgramPreview();
            return;
        }

        const source = this.ensureSourceForSlot(this.contextSlotIndex);
        this.selectSource(source.id);

        if (action === 'video') {
            this.openFilePicker('video/*', file => {
                this.createMediaFromFile(file).then(media => {
                    if (media) this.applyMediaToSource(source.id, media.element, 'video', file.name);
                });
            });
        }

        if (action === 'image') {
            this.openFilePicker('image/*', file => {
                this.createMediaFromFile(file).then(media => {
                    if (media) this.applyMediaToSource(source.id, media.element, 'image', file.name);
                });
            });
        }

        if (action === 'audio') {
            this.openFilePicker('audio/*', file => {
                this.createMediaFromFile(file).then(media => {
                    if (!media) return;
                    const canvas = this.createPlaceholderCanvas(source.label, `Audio: ${file.name}`);
                    const src = this.getSource(source.id);
                    if (!src) return;
                    src.audioElement = media.element;
                    this.applyMediaToSource(source.id, canvas, 'audio', file.name);
                    this.applySourceMuteState(src);
                });
            });
        }

        if (action === 'browser') {
            const url = prompt('Browser source URL', 'https://example.com');
            if (!url) return;
            const browserFeed = this.browserModule.createBrowserSource(url, source.label);
            this.applyMediaToSource(source.id, browserFeed.element, 'browser', url);
            const src = this.getSource(source.id);
            src.browserUrl = url;
            this.browserModule.showSource(src);
            this.refreshInputBus();
            this.refreshAuxRouter();
            this.renderProgramPreview();
        }

        if (action === 'webcam') {
            try {
                const { element, stream } = await this.createWebcamMedia();
                this.applyMediaToSource(source.id, element, 'webcam', 'Webcam', stream);
                const src = this.getSource(source.id);
                if (src) {
                    src.audioMuted = true;
                    this.applySourceMuteState(src);
                }
                this.refreshInputBus();
                this.refreshAuxRouter();
                this.renderProgramPreview();
            } catch (err) {
                alert(err?.message || 'Unable to access webcam.');
            }
        }

        if (action === 'assign-background') {
            this.openFilePicker('video/*,image/*', file => {
                this.createMediaFromFile(file).then(media => {
                    if (media) {
                        source.node.backgroundVideo = media.element;
                        this.syncPreviewEngineSource();
                    }
                });
            });
        }
    }

    applyMediaToSource(sourceId, mediaElement, type, labelSeed, mediaStream = null) {
        const source = this.getSource(sourceId);
        if (!source) return;
        this.releaseSourceMedia(source);
        source.mediaElement = mediaElement;
        source.type = type;
        source.label = labelSeed ? labelSeed.replace(/\.[^.]+$/, '') : source.label;
        source.browserUrl = type === 'browser' ? labelSeed : '';
        if (type !== 'audio') {
            source.audioElement = mediaElement instanceof HTMLMediaElement ? mediaElement : null;
        }
        source.mediaStream = mediaStream || null;
        source.node.video = mediaElement;
        this.selectSource(sourceId);
        this.syncPreviewEngineSource();
        this.refreshInputBus();
        this.refreshAuxRouter();
        this.renderProgramPreview();
        this.applySourceMuteState(source);
    }

    releaseSourceMedia(source) {
        if (!source) return;
        if (source.type === 'browser' && this.browserModule && source.mediaElement instanceof HTMLCanvasElement) {
            this.browserModule.releaseSource(source.mediaElement);
        }
        const stream = source.mediaStream ||
            (source.mediaElement instanceof HTMLMediaElement ? source.mediaElement.srcObject : null);
        if (stream instanceof MediaStream) {
            stream.getTracks().forEach(t => {
                try { t.stop(); } catch { }
            });
        }
        source.mediaStream = null;
    }

    async createWebcamMedia() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Webcam not supported in this browser');
        }
        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        const video = document.createElement('video');
        video.srcObject = stream;
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', 'true');
        await video.play().catch(() => { });
        return { element: video, stream };
    }

    openFilePicker(accept, onPick) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.onchange = () => {
            const file = input.files?.[0];
            if (file) onPick(file);
        };
        input.click();
    }

    async createMediaFromFile(file) {
        if (!file) return null;
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const isVideo = file.type.startsWith('video') || ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpg', 'mpeg'].includes(ext);
        const isImage = file.type.startsWith('image') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif'].includes(ext);
        const isAudio = file.type.startsWith('audio') || ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac'].includes(ext);

        if (isVideo) {
            const video = document.createElement('video');
            video.src = URL.createObjectURL(file);
            video.loop = true;
            video.muted = true;
            video.volume = 0;
            video.playsInline = true;
            await new Promise(resolve => { video.onloadedmetadata = () => resolve(); });
            video.play().catch(() => { });
            return { element: video, type: 'video' };
        }
        if (isImage) {
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            await new Promise(resolve => { img.onload = () => resolve(); });
            return { element: img, type: 'image' };
        }
        if (isAudio) {
            const audio = document.createElement('audio');
            audio.src = URL.createObjectURL(file);
            audio.loop = true;
            audio.muted = true;
            audio.volume = 0;
            audio.preload = 'auto';
            await new Promise(resolve => { audio.onloadedmetadata = () => resolve(); });
            audio.play().catch(() => { });
            return { element: audio, type: 'audio' };
        }
        return null;
    }

    extractSourceFromDrop(event) {
        return event.dataTransfer.getData('application/x-source-id') || null;
    }

    createPlaceholderCanvas(title, subtitle) {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        grad.addColorStop(0, '#0b1020');
        grad.addColorStop(1, '#14334a');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#22d3ee';
        ctx.font = 'bold 72px Segoe UI';
        ctx.fillText(title, 80, 250);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '36px Segoe UI';
        ctx.fillText(subtitle, 80, 330);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '28px Segoe UI';
        ctx.fillText('Right click input box to assign media', 80, 400);
        return canvas;
    }

    updateChromaUI(type) {
        const basic = document.getElementById('basicControls');
        const enterprise = document.getElementById('enterpriseControls');
        const broadcast = document.getElementById('broadcastControls');
        const cinematic = document.getElementById('cinematicControls');
        basic.style.display = 'none';
        enterprise.style.display = 'none';
        broadcast.style.display = 'none';
        cinematic.style.display = 'none';
        if (type === 'basic' || type === 'advanced') basic.style.display = 'block';
        if (type === 'enterprise' || type === 'trueenterprise') enterprise.style.display = 'block';
        if (type === 'broadcast') {
            enterprise.style.display = 'block';
            broadcast.style.display = 'block';
        }
        if (type === 'cinematic') {
            enterprise.style.display = 'block';
            broadcast.style.display = 'block';
            cinematic.style.display = 'block';
        }
    }

    loadChromaParams(type) {
        if (!this.currentInputNode || !this.selectedSourceId) return;
        const source = this.getSource(this.selectedSourceId);
        if (!source || !source.chromaParams || !source.chromaParams[type]) return;

        const chromaFilter = this.currentInputNode.filters[0];
        if (!chromaFilter) return;

        const savedParams = source.chromaParams[type];
        Object.assign(chromaFilter.params, savedParams);
    }

    saveChromaParams(type) {
        if (!this.currentInputNode || !this.selectedSourceId) return;
        const source = this.getSource(this.selectedSourceId);
        if (!source || !source.chromaParams) return;

        const chromaFilter = this.currentInputNode.filters[0];
        if (!chromaFilter) return;

        source.chromaParams[type] = { ...chromaFilter.params };
    }

    setupChromaControls() {
        if (!this.currentInputNode) return;
        const source = this.getSource(this.selectedSourceId);
        const type = source ? source.chromaType : 'basic';
        this.loadChromaParams(type);

        const chromaFilter = this.currentInputNode.filters[0];
        if (!chromaFilter) return;

        const bindSlider = (id, valueId, param, digits = 2) => {
            const slider = document.getElementById(id);
            const text = document.getElementById(valueId);
            if (!slider || !text || chromaFilter.params[param] === undefined) return;
            slider.value = chromaFilter.params[param];
            text.textContent = Number(chromaFilter.params[param]).toFixed(digits);
            slider.oninput = () => {
                const val = parseFloat(slider.value);
                chromaFilter.params[param] = val;
                text.textContent = val.toFixed(digits);
                this.saveChromaParams(type);
                this.syncPreviewEngineSource();
            };
        };

        bindSlider('similarity', 'similarityValue', 'similarity', 2);
        bindSlider('smoothness', 'smoothnessValue', 'smoothness', 2);
        bindSlider('spill', 'spillValue', 'spill', 2);
        bindSlider('thresholdLow', 'thresholdLowValue', 'thresholdLow', 2);
        bindSlider('thresholdHigh', 'thresholdHighValue', 'thresholdHigh', 2);
        bindSlider('edgeShrink', 'edgeShrinkValue', 'edgeShrink', 3);
        bindSlider('edgeBlur', 'edgeBlurValue', 'edgeBlur', 3);
        bindSlider('lightWrap', 'lightWrapValue', 'lightWrap', 2);

        const keyColorPicker = document.getElementById('keyColor');
        if (keyColorPicker && chromaFilter.params.keyColor !== undefined) {
            const [r, g, b] = chromaFilter.params.keyColor;
            keyColorPicker.value = `#${[r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
            keyColorPicker.oninput = () => {
                const hex = keyColorPicker.value;
                chromaFilter.params.keyColor = [
                    parseInt(hex.substring(1, 3), 16) / 255,
                    parseInt(hex.substring(3, 5), 16) / 255,
                    parseInt(hex.substring(5, 7), 16) / 255
                ];
                this.saveChromaParams(type);
                this.syncPreviewEngineSource();
            };
        }
    }

    onOverlayDrop(event, slotIndex) {
        event.preventDefault();
        const assetFileHandle = this.extractAssetFromDrop(event);
        if (assetFileHandle) {
            this.createSourceFromAsset(assetFileHandle).then(source => {
                this.assignOverlaySource(slotIndex, source.id);
            });
            return;
        }

        const sourceId = this.extractSourceFromDrop(event);
        if (sourceId) this.assignOverlaySource(slotIndex, sourceId);
    }

    assignOverlaySource(slotIndex, sourceId) {
        const source = this.getSource(sourceId);
        if (source) {
            this.overlaySlots[slotIndex] = source;
            this.refreshOverlayBus();
            this.renderOverlayTargets();
        }
    }

    // --- Assets & Media Browser ---
    bindAssetsControls() {
        const addBtn = document.getElementById('addAssetFolderBtn');
        if (addBtn) {
            addBtn.addEventListener('click', () => this.addAssetFolder());
        }

        const btnTree = document.getElementById('btnAssetViewTree');
        const btnGrid = document.getElementById('btnAssetViewGrid');
        if (btnTree && btnGrid) {
            btnTree.onclick = () => {
                this.mediaViewMode = 'tree';
                btnTree.classList.add('active');
                btnGrid.classList.remove('active');
                this.renderAssetTree();
            };
            btnGrid.onclick = () => {
                this.mediaViewMode = 'grid';
                btnGrid.classList.add('active');
                btnTree.classList.remove('active');
                this.renderAssetTree();
            };
        }
    }

    async addAssetFolder() {
        try {
            const handle = await window.showDirectoryPicker();
            this.assetFolders.push(handle);
            this.renderAssetTree();
        } catch (e) {
            console.warn('Folder access cancelled or failed:', e);
        }
    }

    async renderAssetTree() {
        const container = document.getElementById('assetTreeContainer');
        if (!container) return;
        container.innerHTML = '';

        if (this.mediaViewMode === 'grid') {
            container.classList.add('grid-view');
        } else {
            container.classList.remove('grid-view');
        }

        if (this.assetFolders.length === 0) {
            container.innerHTML = '<div class="asset-empty-state">No folders added. Click "Add Local Media Folder" to browse your assets.</div>';
            return;
        }

        for (const handle of this.assetFolders) {
            const rootNode = document.createElement('div');
            rootNode.className = 'asset-node';
            container.appendChild(rootNode);
            await this.scanDirectoryRecursive(handle, rootNode);
        }
    }

    async scanDirectoryRecursive(handle, parentElement) {
        const item = document.createElement('div');
        item.className = `asset-item ${handle.kind}`;

        const icon = document.createElement('span');
        icon.className = `codicon codicon-${handle.kind === 'directory' ? 'folder' : 'file-media'}`;

        const label = document.createElement('span');
        label.textContent = handle.name;

        item.appendChild(icon);
        item.appendChild(label);
        parentElement.appendChild(item);

        if (handle.kind === 'directory') {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'asset-children';
            parentElement.appendChild(childrenContainer);

            item.addEventListener('click', (e) => {
                e.stopPropagation();
                childrenContainer.classList.toggle('expanded');
                icon.className = `codicon codicon-${childrenContainer.classList.contains('expanded') ? 'folder-opened' : 'folder'}`;
            });

            // In grid view, we don't necessarily want to list all sub-children immediately if they are deep
            // but for simplicity we continue to scan.
            for await (const entry of handle.values()) {
                await this.scanDirectoryRecursive(entry, childrenContainer);
            }
        } else {
            // It's a file - only allow media types
            const name = handle.name.toLowerCase();
            const isVideo = name.endsWith('.mp4') || name.endsWith('.webm') || name.endsWith('.mov');
            const isImage = name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.gif');
            const isMedia = isVideo || isImage;

            if (!isMedia) {
                icon.className = 'codicon codicon-file';
                return; // Optionally skip non-media files
            }

            // Thumbnail Handling
            if (this.mediaViewMode === 'grid') {
                const placeholder = document.createElement('div');
                placeholder.className = 'asset-placeholder';
                placeholder.innerHTML = `<span class="codicon codicon-loading codicon-modifier-spin"></span>`;
                item.prepend(placeholder);

                // Start thumbnail generation
                this.getThumbnail(handle, isVideo).then(thumbUrl => {
                    if (thumbUrl) {
                        placeholder.remove();
                        const img = document.createElement('img');
                        img.src = thumbUrl;
                        img.className = 'asset-thumbnail';
                        item.prepend(img);
                    } else {
                        placeholder.innerHTML = `<span class="codicon codicon-file-media"></span>`;
                    }
                });
            }

            item.draggable = true;
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/x-asset-name', handle.name);
                if (!window._assetHandles) window._assetHandles = new Map();
                const id = `asset-${Date.now()}`;
                window._assetHandles.set(id, handle);
                e.dataTransfer.setData('application/x-asset-id', id);
                item.classList.add('dragging');
            });
            item.addEventListener('dragend', () => item.classList.remove('dragging'));
        }
    }

    extractAssetFromDrop(event) {
        const id = event.dataTransfer.getData('application/x-asset-id');
        if (id && window._assetHandles && window._assetHandles.has(id)) {
            return window._assetHandles.get(id);
        }
        return null;
    }

    async createSourceFromAsset(fileHandle) {
        const file = await fileHandle.getFile();
        const url = URL.createObjectURL(file);

        const isImage = file.type.startsWith('image/');
        const isVideo = file.type.startsWith('video/');

        let media;
        if (isImage) {
            media = document.createElement('img');
            media.src = url;
            await new Promise(r => media.onload = r);
        } else {
            media = document.createElement('video');
            media.src = url;
            media.loop = true;
            media.muted = true;
            media.autoplay = true;
            media.playsInline = true;
            await new Promise(r => {
                media.oncanplay = r;
                media.onerror = () => r(); // Fallback
            });
            media.play().catch(() => { });
        }

        return this.createSource(file.name, media, isImage ? 'image' : 'video');
    }

    async getThumbnail(handle, isVideo) {
        if (this.thumbnailCache.has(handle.name)) {
            return this.thumbnailCache.get(handle.name);
        }

        try {
            const file = await handle.getFile();
            const url = URL.createObjectURL(file);
            let thumbUrl = null;

            if (isVideo) {
                thumbUrl = await this.generateVideoThumbnail(url);
            } else {
                thumbUrl = url; // Images act as their own thumbnails
            }

            if (thumbUrl) {
                this.thumbnailCache.set(handle.name, thumbUrl);
            }
            return thumbUrl;
        } catch (e) {
            console.error('Thumbnail error:', e);
            return null;
        }
    }

    generateVideoThumbnail(videoUrl) {
        return new Promise((resolve) => {
            const video = document.createElement('video');
            video.src = videoUrl;
            video.preload = 'metadata';
            video.muted = true;
            video.currentTime = 1; // Seek to 1s for a better frame

            video.onloadeddata = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 160;
                canvas.height = 90;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.7));
                video.remove();
            };

            video.onerror = () => resolve(null);

            // Timeout safety
            setTimeout(() => resolve(null), 3000);
        });
    }

    toggleMasterEngine() {
        const select = document.getElementById('rendererSelect');
        const btn = document.getElementById('engineToggleBtn');
        if (!select || !btn) return;

        const current = select.value;
        const next = current === 'webgl2' ? 'canvas' : 'webgl2';
        select.value = next;

        const label = btn.querySelector('span:last-child');
        if (label) {
            label.textContent = next === 'webgl2' ? '3D' : '2D';
        }
        
        // Trigger the change event so the engine actually switches
        select.dispatchEvent(new Event('change'));
    }
}
