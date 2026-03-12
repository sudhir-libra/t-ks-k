/**
 * Golden Layout Bridge - Main Entry Point
 * Initializes Golden Layout with all the components
 */

import { eventBus, Events } from './EventBus.js';
import { stateStore } from './StateStore.js';
import { PanelController } from './PanelController.js';
import { VirtualPanelRenderer, LazyPanelLoader } from './VirtualPanelRenderer.js';
import { LayoutManager } from './LayoutManager.js';

// GoldenLayout is loaded via script tag, access from window
let GoldenLayout;

export class GoldenLayoutBridge {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        
        if (!this.container) {
            throw new Error(`Container element '${containerId}' not found`);
        }
        
        // Components
        this.gl = null;
        this.panelController = null;
        this.virtualRenderer = null;
        this.lazyLoader = null;
        this.layoutManager = null;
        
        // State
        this.isInitialized = false;
        this.componentRegistry = new Map();
    }

    /**
     * Initialize Golden Layout
     * @param {Object} config - Layout configuration
     */
    async init(config = null) {
        try {
            // Get GoldenLayout from global (loaded via script tag)
            GoldenLayout = window.GoldenLayout;
            if (!GoldenLayout) {
                throw new Error('GoldenLayout not found. Make sure goldenlayout.min.js is loaded.');
            }
            
            // Create Golden Layout instance
            this.gl = new GoldenLayout({
                ...this.getDefaultConfig(),
                ...config
            }, this.container);
            
            // Initialize components
            this.initComponents();
            
            // Initialize virtual renderer
            this.virtualRenderer = new VirtualPanelRenderer({
                maxVisiblePanels: 20,
                renderBatchSize: 5,
                lazyLoadThreshold: 200
            });
            
            // Initialize lazy loader
            this.lazyLoader = new LazyPanelLoader();
            
            // Initialize layout manager
            this.layoutManager = new LayoutManager(this.gl);
            
            // Register default components
            this.registerDefaultComponents();
            
            // Bind Golden Layout events
            this.bindGLEvents();
            
            // Initialize
            await new Promise((resolve, reject) => {
                this.gl.init();
                
                this.gl.on('initialised', () => {
                    this.isInitialized = true;
                    resolve();
                });
                
                this.gl.on('initialise-failed', (err) => {
                    reject(err);
                });
            });
            
            // Emit initialized event
            eventBus.emit(Events.INITIALIZED, { version: '2.0' }, 'GoldenLayoutBridge');
            
            return true;
        } catch (error) {
            console.error('Failed to initialize Golden Layout:', error);
            eventBus.emit(Events.ERROR, { error: error.message }, 'GoldenLayoutBridge');
            throw error;
        }
    }

    /**
     * Get default configuration
     * @returns {Object} Default config
     */
    getDefaultConfig() {
        return {
            settings: {
                showCloseIcon: true,
                showMaximiseIcon: true,
                showMinimizeIcon: true,
                showPopoutIcon: true,
                reorderEnabled: true,
                selectionEnabled: true,
                createNewOnDrag: false,
                dragProxyEnabled: true,
                tabOverflow: 'scroll',
                tabControlOffset: 0,
                closeMethod: 'default',
                maximiseOnDoubleClick: true,
                preventClose: false,
                headerHeight: 34,
                tabHeight: 34,
                minTabWidth: 50,
                maxTabWidth: 200,
                tabOverlap: 0,
                tabScrolling: 'scroll',
                tabPosition: 'top',
                hasHeaders: true,
                constrainDragToContainer: true,
                followTransform: false,
                isAutoWeight: true,
                fractionalUnits: false,
                physics: {
                    enabled: true,
                    stiffness: 0.1,
                    damping: 0.1
                },
                borderWidth: 4,
                splitterGrabArea: 8,
                maximisedStack: null,
                layoutOnStartup: true,
                responsiveMode: 'onresize',
                responsiveDelay: 100,
                tabAllowDrag: true,
                tabAllowDrop: true,
                headerShowTab: 'show',
                headerShowClose: 'show',
                headerShowPopout: 'show',
                popInWholeStack: false,
                closePopoutsOnStacks: true,
                reorderOnStackDrag: true,
                destroyPopoutsOnClose: false,
                blockedActions: {
                    drag: false,
                    drop: false,
                    resize: false,
                    close: false,
                    maximise: false,
                    minimise: false,
                    popout: false
                }
            },
            dimensions: {
                borderWidth: 4,
                headerHeight: 34,
                minItemHeight: 34,
                minItemWidth: 100,
                tabStartSize: 50,
                tabEndSize: 50,
                splitterHandleSize: 4,
                dragHandleSize: 4,
                elementBoundError: 5,
                minimumDefinedElementSize: 20,
                headerWidth: 50,
                defaultDragSize: 50,
                tabScrollingThreshold: 30,
                transitionDuration: 250,
                layoutNoSlidingResize: 20
            },
            labels: {
                close: 'Close',
                maximise: 'Maximize',
                minimise: 'Minimize',
                popout: 'Pop Out',
                popin: 'Pop In',
                tabDropdown: 'Additional tabs',
                maximiseWindow: 'Maximize Window',
                restoreWindow: 'Restore Window',
                sidePanelClose: 'Close Side Panel',
                settings: 'Settings',
                undo: 'Undo',
                redo: 'Redo'
            },
            styles: {
                backgroundColor: '#1e1e1e',
                borderColor: '#454545',
                headerBackgroundColor: '#333333',
                headerTextColor: '#cccccc',
                headerEmTextColor: '#ffffff',
                tabBackgroundColor: '#252526',
                tabTextColor: '#999999',
                tabEmTextColor: '#ffffff',
                activeTabBackgroundColor: '#1e1e1e',
                activeTabTextColor: '#ffffff',
                minimisedItemBackgroundColor: '#111111',
                minimisedItemTextColor: '#999999',
                hoverTabBackgroundColor: '#2a2d2e',
                hoverTabTextColor: '#cccccc',
                dividerBackgroundColor: '#333333',
                dividerHoverBackgroundColor: '#454545',
                splitterColor: '#333333',
                splitterHoverColor: '#454545',
                dragItemTextColor: '#ffffff',
                dragItemBackgroundColor: '#007acc',
                dropTargetActiveColor: 'rgba(0, 122, 204, 0.4)',
                dropTargetHoverColor: 'rgba(0, 122, 204, 0.6)',
                splashScreenBackgroundColor: '#1e1e1e',
                modalBackgroundColor: '#1e1e1e',
                modalBorderColor: '#454545',
                modalTextColor: '#cccccc',
                popinBackgroundColor: '#252526',
                popinTextColor: '#999999',
                popinHoverBackgroundColor: '#2a2d2e',
                popinHoverTextColor: '#cccccc',
                popupToolbarBackgroundColor: '#333333',
                popupToolbarTextColor: '#cccccc',
                popupMenuBackgroundColor: '#252526',
                popupMenuTextColor: '#cccccc',
                popupMenuHoverBackgroundColor: '#007acc',
                popupMenuHoverTextColor: '#ffffff'
            }
        };
    }

    /**
     * Initialize internal components
     */
    initComponents() {
        this.panelController = new PanelController(this.gl);
    }

    /**
     * Register default components
     */
    registerDefaultComponents() {
        // Program Output Panel
        this.registerComponent('program', {
            title: 'Program',
            showHeader: true,
            renderContent: (container, state) => {
                this.renderProgramPanel(container, state);
            }
        });
        
        // Preview Panel
        this.registerComponent('preview', {
            title: 'Preview',
            showHeader: true,
            renderContent: (container, state) => {
                this.renderPreviewPanel(container, state);
            }
        });
        
        // Switcher Controls Panel
        this.registerComponent('controls', {
            title: 'Controls',
            showHeader: true,
            renderContent: (container, state) => {
                this.renderControlsPanel(container, state);
            }
        });
        
        // Inputs Panel
        this.registerComponent('inputs', {
            title: 'Inputs',
            showHeader: true,
            renderContent: (container, state) => {
                this.renderInputsPanel(container, state);
            }
        });
        
        // AUX Router Panel
        this.registerComponent('aux', {
            title: 'AUX Outputs',
            showHeader: true,
            renderContent: (container, state) => {
                this.renderAuxPanel(container, state);
            }
        });
        
        // Overlays Panel
        this.registerComponent('overlays', {
            title: 'Overlays',
            showHeader: true,
            renderContent: (container, state) => {
                this.renderOverlaysPanel(container, state);
            }
        });
        
        // Recording Panel
        this.registerComponent('recording', {
            title: 'Recording',
            showHeader: true,
            lazy: true,
            renderContent: (container, state) => {
                this.renderRecordingPanel(container, state);
            }
        });
        
        // Streaming Panel
        this.registerComponent('streaming', {
            title: 'Streaming',
            showHeader: true,
            lazy: true,
            renderContent: (container, state) => {
                this.renderStreamingPanel(container, state);
            }
        });
        
        // Settings Panel
        this.registerComponent('settings', {
            title: 'Settings',
            showHeader: true,
            lazy: true,
            renderContent: (container, state) => {
                this.renderSettingsPanel(container, state);
            }
        });
        
        // Assets Panel
        this.registerComponent('assets', {
            title: 'Media Assets',
            showHeader: true,
            lazy: true,
            renderContent: (container, state) => {
                this.renderAssetsPanel(container, state);
            }
        });
    }

    /**
     * Register a custom component
     * @param {string} name - Component name
     * @param {Object} config - Component configuration
     */
    registerComponent(name, config) {
        this.componentRegistry.set(name, config);
        
        if (this.gl) {
            this.gl.registerComponent(name, (container, state) => {
                this.panelController?.createPanelInstance(name, container, state);
                
                // Render content
                if (config.renderContent) {
                    const content = document.createElement('div');
                    content.style.cssText = 'height: 100%; overflow: auto;';
                    config.renderContent(content, state);
                    container.element.appendChild(content);
                }
            });
        }
    }

    /**
     * Bind Golden Layout events
     */
    bindGLEvents() {
        // Stack events
        this.gl.on('stack:created', (stack) => {
            eventBus.emit('layout:stackCreated', { stack }, 'GoldenLayoutBridge');
        });
        
        // Component events
        this.gl.on('component:created', (component) => {
            eventBus.emit('layout:componentCreated', { component }, 'GoldenLayoutBridge');
        });
        
        // Popout events
        this.gl.on('window:opened', (window) => {
            eventBus.emit(Events.PANEL_POPOUT, { window }, 'GoldenLayoutBridge');
        });
        
        this.gl.on('window:closed', (window) => {
            eventBus.emit(Events.PANEL_CLOSE, { window }, 'GoldenLayoutBridge');
        });
        
        // Item events
        this.gl.on('item:added', (item) => {
            eventBus.emit('layout:itemAdded', { item }, 'GoldenLayoutBridge');
        });
        
        this.gl.on('item:removed', (item) => {
            eventBus.emit('layout:itemRemoved', { item }, 'GoldenLayoutBridge');
        });
        
        // Layout events
        this.gl.on('layout:destroy', () => {
            eventBus.emit('layout:destroyed', {}, 'GoldenLayoutBridge');
        });
    }

    /**
     * Render Program Panel
     * @param {HTMLElement} container - Container element
     * @param {Object} state - Panel state
     */
    renderProgramPanel(container, state) {
        const wrapper = document.createElement('div');
        wrapper.className = 'program-panel';
        wrapper.style.cssText = 'height: 100%; display: flex; flex-direction: column; background: #000;';
        
        const canvas = document.createElement('canvas');
        canvas.id = 'programDisplayCanvas';
        canvas.style.cssText = 'width: 100%; flex: 1; object-fit: contain;';
        
        const overlay = document.createElement('div');
        overlay.id = 'programOverlayLayer';
        overlay.className = 'overlay-layer';
        overlay.style.cssText = 'position: absolute; inset: 0; pointer-events: none;';
        
        const audioMeter = document.createElement('div');
        audioMeter.id = 'programAudioMeter';
        audioMeter.className = 'audio-meter';
        audioMeter.innerHTML = '<div class="bar"></div><div class="bar"></div>';
        audioMeter.style.cssText = 'position: absolute; right: 8px; top: 8px; bottom: 8px; width: 12px;';
        
        wrapper.appendChild(canvas);
        wrapper.appendChild(overlay);
        wrapper.appendChild(audioMeter);
        container.appendChild(wrapper);
    }

    /**
     * Render Preview Panel
     * @param {HTMLElement} container - Container element
     * @param {Object} state - Panel state
     */
    renderPreviewPanel(container, state) {
        const wrapper = document.createElement('div');
        wrapper.className = 'preview-panel';
        wrapper.style.cssText = 'height: 100%; display: flex; flex-direction: column; background: #000;';
        
        const canvas = document.createElement('canvas');
        canvas.id = 'previewDisplayCanvas';
        canvas.style.cssText = 'width: 100%; flex: 1; object-fit: contain;';
        
        const overlay = document.createElement('div');
        overlay.id = 'previewOverlayLayer';
        overlay.className = 'overlay-layer';
        overlay.style.cssText = 'position: absolute; inset: 0; pointer-events: none;';
        
        wrapper.appendChild(canvas);
        wrapper.appendChild(overlay);
        container.appendChild(wrapper);
    }

    /**
     * Render Controls Panel
     * @param {HTMLElement} container - Container element
     * @param {Object} state - Panel state
     */
    renderControlsPanel(container, state) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'height: 100%; padding: 12px; display: flex; flex-direction: column; gap: 12px;';
        
        // Transition controls
        const controlsDiv = document.createElement('div');
        controlsDiv.style.cssText = 'display: flex; gap: 8px; align-items: center;';
        
        const cutBtn = document.createElement('button');
        cutBtn.id = 'cutBtn';
        cutBtn.textContent = 'CUT';
        cutBtn.style.cssText = 'flex: 1; padding: 12px; background: rgba(34, 197, 94, 0.2); border: 1px solid #22c55e; color: #d1fae5; border-radius: 4px; cursor: pointer; font-weight: 600;';
        
        const autoBtn = document.createElement('button');
        autoBtn.id = 'autoBtn';
        autoBtn.textContent = 'AUTO';
        autoBtn.style.cssText = 'flex: 1; padding: 12px; background: rgba(245, 158, 11, 0.2); border: 1px solid #f59e0b; color: #fef3c7; border-radius: 4px; cursor: pointer; font-weight: 600;';
        
        controlsDiv.appendChild(cutBtn);
        controlsDiv.appendChild(autoBtn);
        wrapper.appendChild(controlsDiv);
        
        // Transition settings
        const settingsDiv = document.createElement('div');
        settingsDiv.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';
        
        const animSelect = document.createElement('select');
        animSelect.id = 'transitionAnimation';
        animSelect.innerHTML = '<option value="fade">Fade</option><option value="wipe">Wipe</option><option value="zoom">Zoom</option>';
        animSelect.style.cssText = 'padding: 6px; background: #3c3c3c; border: 1px solid #454545; color: #ccc; border-radius: 4px;';
        
        const durationInput = document.createElement('input');
        durationInput.id = 'transitionDuration';
        durationInput.type = 'number';
        durationInput.value = '800';
        durationInput.min = '100';
        durationInput.step = '100';
        durationInput.style.cssText = 'padding: 6px; background: #3c3c3c; border: 1px solid #454545; color: #ccc; border-radius: 4px;';
        
        settingsDiv.appendChild(animSelect);
        settingsDiv.appendChild(durationInput);
        wrapper.appendChild(settingsDiv);
        
        container.appendChild(wrapper);
    }

    /**
     * Render Inputs Panel
     * @param {HTMLElement} container - Container element
     * @param {Object} state - Panel state
     */
    renderInputsPanel(container, state) {
        const wrapper = document.createElement('div');
        wrapper.id = 'inputBus';
        wrapper.className = 'input-grid';
        wrapper.style.cssText = 'height: 100%; padding: 8px; display: flex; flex-wrap: wrap; gap: 8px; align-content: flex-start; overflow: auto;';
        
        container.appendChild(wrapper);
    }

    /**
     * Render AUX Panel
     * @param {HTMLElement} container - Container element
     * @param {Object} state - Panel state
     */
    renderAuxPanel(container, state) {
        const wrapper = document.createElement('div');
        wrapper.id = 'auxRouter';
        wrapper.className = 'router-grid';
        wrapper.style.cssText = 'height: 100%; padding: 8px; display: flex; flex-wrap: wrap; gap: 8px; align-content: flex-start; overflow: auto;';
        
        container.appendChild(wrapper);
    }

    /**
     * Render Overlays Panel
     * @param {HTMLElement} container - Container element
     * @param {Object} state - Panel state
     */
    renderOverlaysPanel(container, state) {
        const wrapper = document.createElement('div');
        wrapper.id = 'overlayBus';
        wrapper.className = 'overlay-grid';
        wrapper.style.cssText = 'height: 100%; padding: 8px; display: flex; flex-wrap: wrap; gap: 8px; align-content: flex-start; overflow: auto;';
        
        container.appendChild(wrapper);
    }

    /**
     * Render Recording Panel
     * @param {HTMLElement} container - Container element
     * @param {Object} state - Panel state
     */
    renderRecordingPanel(container, state) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'height: 100%; padding: 12px; overflow: auto;';
        
        wrapper.innerHTML = `
            <div style="margin-bottom: 12px;">
                <div style="font-size: 11px; color: #999; margin-bottom: 8px;">Recording Status</div>
                <div id="recordingStatus" style="font-size: 14px; color: #fff;">Idle</div>
            </div>
            <div style="display: flex; gap: 8px;">
                <button id="recordStartBtn" style="flex: 1; padding: 8px; background: #3c3c3c; border: 1px solid #454545; color: #ccc; border-radius: 4px; cursor: pointer;">Start</button>
                <button id="recordStopBtn" style="flex: 1; padding: 8px; background: #3c3c3c; border: 1px solid #454545; color: #ccc; border-radius: 4px; cursor: pointer;">Stop</button>
            </div>
            <div id="recordingStats" style="margin-top: 12px; font-family: monospace; font-size: 11px; color: #999;">fps: -, late: -, lag: -ms</div>
        `;
        
        container.appendChild(wrapper);
    }

    /**
     * Render Streaming Panel
     * @param {HTMLElement} container - Container element
     * @param {Object} state - Panel state
     */
    renderStreamingPanel(container, state) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'height: 100%; padding: 12px; overflow: auto;';
        
        wrapper.innerHTML = `
            <div style="margin-bottom: 12px;">
                <div style="font-size: 11px; color: #999; margin-bottom: 8px;">Streaming Status</div>
                <div id="streamingStatus" style="font-size: 14px; color: #fff;">Idle</div>
            </div>
            <div style="margin-bottom: 12px;">
                <label style="font-size: 11px; color: #999; display: block; margin-bottom: 4px;">Endpoint URL</label>
                <input id="streamEndpoint" type="text" placeholder="http://localhost:8889/stream" style="width: 100%; padding: 6px; background: #3c3c3c; border: 1px solid #454545; color: #ccc; border-radius: 4px; box-sizing: border-box;">
            </div>
            <div style="display: flex; gap: 8px;">
                <button id="streamStartBtn" style="flex: 1; padding: 8px; background: #3c3c3c; border: 1px solid #454545; color: #ccc; border-radius: 4px; cursor: pointer;">Start</button>
                <button id="streamStopBtn" style="flex: 1; padding: 8px; background: #3c3c3c; border: 1px solid #454545; color: #ccc; border-radius: 4px; cursor: pointer;">Stop</button>
            </div>
            <div id="streamingStats" style="margin-top: 12px; font-family: monospace; font-size: 11px; color: #999;">bitrate: -, rtt: -, jitter: -</div>
        `;
        
        container.appendChild(wrapper);
    }

    /**
     * Render Settings Panel
     * @param {HTMLElement} container - Container element
     * @param {Object} state - Panel state
     */
    renderSettingsPanel(container, state) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'height: 100%; padding: 12px; overflow: auto;';
        
        wrapper.innerHTML = `
            <div style="margin-bottom: 12px;">
                <h3 style="font-size: 11px; color: #999; margin: 0 0 8px 0; text-transform: uppercase;">Theme</h3>
                <select id="uiTheme" style="width: 100%; padding: 6px; background: #3c3c3c; border: 1px solid #454545; color: #ccc; border-radius: 4px;">
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                    <option value="cyber">Cyber</option>
                </select>
            </div>
            <div style="margin-bottom: 12px;">
                <h3 style="font-size: 11px; color: #999; margin: 0 0 8px 0; text-transform: uppercase;">Panel Position</h3>
                <select id="uiPanelPosition" style="width: 100%; padding: 6px; background: #3c3c3c; border: 1px solid #454545; color: #ccc; border-radius: 4px;">
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                </select>
            </div>
        `;
        
        container.appendChild(wrapper);
    }

    /**
     * Render Assets Panel
     * @param {HTMLElement} container - Container element
     * @param {Object} state - Panel state
     */
    renderAssetsPanel(container, state) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'height: 100%; padding: 12px; overflow: auto;';
        
        wrapper.innerHTML = `
            <button id="addAssetFolderBtn" style="width: 100%; padding: 8px; background: #3c3c3c; border: 1px solid #454545; color: #ccc; border-radius: 4px; cursor: pointer; margin-bottom: 12px;">
                + Add Media Folder
            </button>
            <div id="assetTreeContainer" style="font-size: 11px; color: #999;">
                No folders added
            </div>
        `;
        
        container.appendChild(wrapper);
    }

    /**
     * Load a layout
     * @param {string} name - Layout name
     */
    loadLayout(name) {
        this.layoutManager?.loadLayout(name);
    }

    /**
     * Save current layout
     * @param {string} name - Layout name
     */
    saveLayout(name) {
        this.layoutManager?.saveLayout(name);
    }

    /**
     * Add a component
     * @param {string} type - Component type
     * @param {Object} state - Component state
     * @param {string} position - Position (left, right, etc.)
     */
    addComponent(type, state = {}, position = null) {
        const config = {
            type: 'component',
            componentType: type,
            componentState: state,
            title: this.componentRegistry.get(type)?.title || type
        };
        
        this.gl.addComponent(config);
    }

    /**
     * Get Golden Layout instance
     * @returns {GoldenLayout} Golden Layout instance
     */
    getGL() {
        return this.gl;
    }

    /**
     * Get panel controller
     * @returns {PanelController} Panel controller
     */
    getPanelController() {
        return this.panelController;
    }

    /**
     * Get virtual renderer
     * @returns {VirtualPanelRenderer} Virtual renderer
     */
    getVirtualRenderer() {
        return this.virtualRenderer;
    }

    /**
     * Get layout manager
     * @returns {LayoutManager} Layout manager
     */
    getLayoutManager() {
        return this.layoutManager;
    }

    /**
     * Destroy the layout
     */
    destroy() {
        this.layoutManager?.destroy();
        this.virtualRenderer?.destroy();
        this.panelController?.destroy();
        
        if (this.gl) {
            this.gl.destroy();
        }
        
        this.isInitialized = false;
    }
}

export default GoldenLayoutBridge;

