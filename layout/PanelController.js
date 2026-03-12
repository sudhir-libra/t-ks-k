/**
 * Panel Controller - Manages Golden Layout Panels
 * Handles panel creation, virtualization, and communication with Event Bus
 */

import { eventBus, Events } from './EventBus.js';
import { stateStore } from './StateStore.js';

export class PanelController {
    constructor(goldenLayout) {
        this.gl = goldenLayout;
        this.panels = new Map();
        this.panelConfigs = new Map();
        this.virtualizedPanels = new Set();
        this.renderQueue = [];
        this.isProcessingQueue = false;
        
        // Performance settings
        this.maxVisiblePanels = 20;
        this.renderThrottleMs = 16; // ~60fps
        this.lastRenderTime = 0;
        
        // Initialize
        this.bindEvents();
    }

    /**
     * Register a panel type
     * @param {string} type - Panel type identifier
     * @param {Object} config - Panel configuration
     */
    registerPanelType(type, config) {
        this.panelConfigs.set(type, {
            ...config,
            type
        });
        
        // Register component with Golden Layout
        this.gl.registerComponent(type, (container, state) => {
            this.createPanelInstance(type, container, state);
        });
    }

    /**
     * Create a panel instance
     * @param {string} type - Panel type
     * @param {Object} container - Golden Layout container
     * @param {Object} state - Panel state
     */
    createPanelInstance(type, container, state) {
        const config = this.panelConfigs.get(type);
        if (!config) {
            console.error(`Panel type '${type}' not registered`);
            return;
        }

        // Create panel wrapper
        const panel = {
            id: container.id || `panel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type,
            container,
            element: container.element,
            state: state || {},
            isVisible: true,
            isVirtualized: false,
            lastRenderTime: 0,
            renderCount: 0,
            domElement: null
        };

        this.panels.set(panel.id, panel);

        // Create panel content
        this.renderPanel(panel, config);

        // Bind container events
        container.on('resize', () => this.onPanelResize(panel));
        container.on('show', () => this.onPanelShow(panel));
        container.on('hide', () => this.onPanelHide(panel));
        container.on('destroy', () => this.onPanelDestroy(panel));
        container.on('focus', () => this.onPanelFocus(panel));

        // Emit panel open event
        eventBus.emit(Events.PANEL_OPEN, { panelId: panel.id, type }, 'PanelController');

        return panel;
    }

    /**
     * Render panel content
     * @param {Object} panel - Panel object
     * @param {Object} config - Panel configuration
     */
    renderPanel(panel, config) {
        const container = panel.element;
        const type = panel.type.toLowerCase();
        
        // Clear existing content
        container.innerHTML = '';
        
        // Create panel structure
        const wrapper = document.createElement('div');
        wrapper.className = 'panel-wrapper';
        wrapper.style.cssText = 'height: 100%; display: flex; flex-direction: column;';
        
        // Panel header
        if (config.showHeader !== false) {
            const header = document.createElement('div');
            header.className = 'panel-header';
            header.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 12px;
                background: var(--bg-activity, #333);
                border-bottom: 1px solid var(--line, #454545);
                min-height: 36px;
            `;
            
            if (config.title) {
                const title = document.createElement('span');
                title.className = 'panel-title';
                title.textContent = config.title;
                title.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--text-light, #fff); text-transform: uppercase;';
                header.appendChild(title);
            }
            
            // Add custom controls for specific panel types
            if (['input', 'output', 'router', 'overlay'].includes(type)) {
                // Scale slider
                const scaleGroup = document.createElement('div');
                scaleGroup.className = 'panel-scale-group';
                scaleGroup.style.cssText = 'display: flex; flex-direction: column; align-items: center; gap: 2px; margin-right: 8px;';
                
                const scaleLabel = document.createElement('span');
                scaleLabel.textContent = 'Scale';
                scaleLabel.style.cssText = 'font-size: 9px; color: var(--muted); text-transform: uppercase;';
                
                const scaleSlider = document.createElement('input');
                scaleSlider.type = 'range';
                scaleSlider.min = '0.5';
                scaleSlider.max = '2.0';
                scaleSlider.step = '0.05';
                scaleSlider.className = `panel-scale-slider panel-scale-${type}`;
                scaleSlider.id = `panelScale${type.charAt(0).toUpperCase() + type.slice(1)}`;
                scaleSlider.value = '1.0';
                scaleSlider.style.cssText = 'width: 60px; height: 4px;';
                
                // Load initial value from CSS var or localStorage
                const root = document.documentElement;
                const cssVar = `--scale-${type}`;
                let scaleVal = parseFloat(root.style.getPropertyValue(cssVar)) || 1.0;
                const stored = localStorage.getItem(`switcher_scale_${type}`);
                if (stored) scaleVal = parseFloat(stored) || 1.0;
                scaleSlider.value = scaleVal.toString();
                
                // Bind slider
                scaleSlider.addEventListener('input', (e) => {
                    const app = window.app;
                    if (app && typeof app.applyGridSize === 'function') {
                        app.applyGridSize(parseFloat(e.target.value), type);
                    }
                });
                
                scaleGroup.appendChild(scaleLabel);
                scaleGroup.appendChild(scaleSlider);
                header.insertBefore(scaleGroup, header.lastElementChild);
                
                // Audio toggle for input panels only
                if (type === 'input') {
                    const audioToggle = document.createElement('span');
                    audioToggle.className = 'panel-audio-toggle codicon codicon-unmute';
                    audioToggle.title = 'Toggle Audio Mute';
                    audioToggle.style.cssText = 'font-size: 14px; cursor: pointer; opacity: 0.8;';
                    
                    audioToggle.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const app = window.app;
                        if (app && typeof app.toggleInputMute === 'function') {
                            // Will add toggleInputMute method to AppController
                            app.toggleInputMute(panel.state.slotIndex || 0);
                        }
                    });
                    
                    header.appendChild(audioToggle);
                }
            }
            
            // Panel tools
            const tools = document.createElement('div');
            tools.className = 'panel-tools';
            tools.style.cssText = 'display: flex; gap: 4px;';
            
            // Close button
            const closeBtn = document.createElement('button');
            closeBtn.className = 'panel-btn';
            closeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
            closeBtn.title = 'Close Panel';
            closeBtn.onclick = () => this.closePanel(panel.id);
            tools.appendChild(closeBtn);
            
            header.appendChild(tools);
            wrapper.appendChild(header);
        }
        
        // Panel content
        const content = document.createElement('div');
        content.className = 'panel-content';
        content.style.cssText = 'flex: 1; overflow: auto; padding: 8px;';
        
        // Render custom content if provided
        if (config.renderContent) {
            config.renderContent(content, panel.state);
        } else {
            this.renderDefaultContent(content, panel.type);
        }
        
        wrapper.appendChild(content);
        container.appendChild(wrapper);
        
        panel.domElement = wrapper;
    }

    /**
     * Render default panel content
     * @param {HTMLElement} container - Content container
     * @param {string} type - Panel type
     */
    renderDefaultContent(container, type) {
        const message = document.createElement('div');
        message.style.cssText = 'color: var(--muted, #999); text-align: center; padding: 20px;';
        message.textContent = `Panel: ${type}`;
        container.appendChild(message);
    }

    /**
     * Handle panel resize
     * @param {Object} panel - Panel object
     */
    onPanelResize(panel) {
        if (!panel.isVisible) return;
        
        eventBus.emit(Events.PANEL_RESIZE, { 
            panelId: panel.id, 
            width: panel.element.clientWidth,
            height: panel.element.clientHeight
        }, 'PanelController');
        
        // Re-render if needed
        if (panel.type === 'preview' || panel.type === 'program') {
            this.queueRender(panel);
        }
    }

    /**
     * Handle panel show
     * @param {Object} panel - Panel object
     */
    onPanelShow(panel) {
        panel.isVisible = true;
        this.virtualizedPanels.delete(panel.id);
        
        eventBus.emit(Events.PANEL_STATE_CHANGED, { 
            panelId: panel.id, 
            visible: true 
        }, 'PanelController');
        
        // Render if queued
        if (panel.renderCount === 0) {
            this.queueRender(panel);
        }
    }

    /**
     * Handle panel hide
     * @param {Object} panel - Panel object
     */
    onPanelHide(panel) {
        panel.isVisible = false;
        
        eventBus.emit(Events.PANEL_STATE_CHANGED, { 
            panelId: panel.id, 
            visible: false 
        }, 'PanelController');
    }

    /**
     * Handle panel destroy
     * @param {Object} panel - Panel object
     */
    onPanelDestroy(panel) {
        this.panels.delete(panel.id);
        this.virtualizedPanels.delete(panel.id);
        
        eventBus.emit(Events.PANEL_CLOSE, { panelId: panel.id }, 'PanelController');
    }

    /**
     * Handle panel focus
     * @param {Object} panel - Panel object
     */
    onPanelFocus(panel) {
        eventBus.emit(Events.PANEL_FOCUS, { panelId: panel.id }, 'PanelController');
        
        // Update selected source in state
        if (panel.state?.sourceId) {
            stateStore.setState('sources.selectedId', panel.state.sourceId);
        }
    }

    /**
     * Close a panel
     * @param {string} panelId - Panel ID
     */
    closePanel(panelId) {
        const panel = this.panels.get(panelId);
        if (panel && panel.container) {
            panel.container.close();
        }
    }

    /**
     * Queue a panel for rendering (throttled)
     * @param {Object} panel - Panel object
     */
    queueRender(panel) {
        if (!this.renderQueue.includes(panel.id)) {
            this.renderQueue.push(panel.id);
        }
        
        this.processRenderQueue();
    }

    /**
     * Process render queue with throttling
     */
    processRenderQueue() {
        if (this.isProcessingQueue) return;
        
        const now = Date.now();
        if (now - this.lastRenderTime < this.renderThrottleMs) {
            requestAnimationFrame(() => this.processRenderQueue());
            return;
        }
        
        this.isProcessingQueue = true;
        
        const panelId = this.renderQueue.shift();
        if (panelId) {
            const panel = this.panels.get(panelId);
            if (panel && panel.isVisible) {
                panel.lastRenderTime = now;
                panel.renderCount++;
                
                // Trigger re-render for specific panel types
                const config = this.panelConfigs.get(panel.type);
                if (config?.onRender) {
                    config.onRender(panel);
                }
            }
        }
        
        this.lastRenderTime = Date.now();
        this.isProcessingQueue = false;
        
        // Process more if queued
        if (this.renderQueue.length > 0) {
            requestAnimationFrame(() => this.processRenderQueue());
        }
    }

    /**
     * Bind to Event Bus events
     */
    bindEvents() {
        // Source selection
        eventBus.on(Events.SOURCE_SELECTED, (data) => {
            this.updatePanelsWithSource(data.sourceId);
        }, 'PanelController');
        
        // Switcher events
        eventBus.on(Events.PROGRAM_CHANGED, (data) => {
            this.updateProgramPanel(data.sourceId);
        }, 'PanelController');
        
        eventBus.on(Events.PREVIEW_CHANGED, (data) => {
            this.updatePreviewPanel(data.sourceId);
        }, 'PanelController');
        
        // Layout events
        eventBus.on(Events.LAYOUT_SAVE, () => {
            this.savePanelStates();
        }, 'PanelController');
        
        eventBus.on(Events.LAYOUT_LOAD, () => {
            this.restorePanelStates();
        }, 'PanelController');
    }

    /**
     * Update all panels with a source
     * @param {string} sourceId - Source ID
     */
    updatePanelsWithSource(sourceId) {
        this.panels.forEach(panel => {
            if (panel.state.sourceId !== undefined) {
                panel.state.sourceId = sourceId;
                this.queueRender(panel);
            }
        });
    }

    /**
     * Update program panel
     * @param {string} sourceId - Source ID
     */
    updateProgramPanel(sourceId) {
        this.panels.forEach(panel => {
            if (panel.type === 'program') {
                panel.state.sourceId = sourceId;
                this.queueRender(panel);
            }
        });
    }

    /**
     * Update preview panel
     * @param {string} sourceId - Source ID
     */
    updatePreviewPanel(sourceId) {
        this.panels.forEach(panel => {
            if (panel.type === 'preview') {
                panel.state.sourceId = sourceId;
                this.queueRender(panel);
            }
        });
    }

    /**
     * Save panel states for layout persistence
     */
    savePanelStates() {
        const states = {};
        this.panels.forEach((panel, id) => {
            states[id] = {
                type: panel.type,
                state: panel.state
            };
        });
        stateStore.setState('layout.panels', states);
    }

    /**
     * Restore panel states from layout
     */
    restorePanelStates() {
        const states = stateStore.getState('layout.panels');
        if (!states) return;
        
        Object.entries(states).forEach(([id, data]) => {
            const panel = this.panels.get(id);
            if (panel) {
                panel.state = { ...panel.state, ...data.state };
                this.queueRender(panel);
            }
        });
    }

    /**
     * Get all panels
     * @returns {Map} Panels map
     */
    getPanels() {
        return this.panels;
    }

    /**
     * Get a specific panel
     * @param {string} panelId - Panel ID
     * @returns {Object} Panel object
     */
    getPanel(panelId) {
        return this.panels.get(panelId);
    }

    /**
     * Get panels by type
     * @param {string} type - Panel type
     * @returns {Array} Array of panels
     */
    getPanelsByType(type) {
        return Array.from(this.panels.values()).filter(p => p.type === type);
    }

    /**
     * Create a new panel
     * @param {string} type - Panel type
     * @param {Object} state - Initial state
     * @param {string} position - Position hint (e.g., 'left', 'right', 'bottom')
     * @returns {Object} Created panel
     */
    createPanel(type, state = {}, position = null) {
        const config = {
            type,
            state,
            width: 400,
            height: 300
        };

        // Add to Golden Layout
        const itemConfig = {
            type: 'component',
            componentType: type,
            componentState: state,
            title: this.panelConfigs.get(type)?.title || type
        };

        // Find root or use specific position
        const root = this.gl.root;
        if (root && position) {
            // Add to appropriate stack based on position
            // This is simplified - actual implementation would depend on layout config
        }

        this.gl.addComponent(itemConfig);

        return itemConfig;
    }

    /**
     * Apply layout configuration
     * @param {Object} layoutConfig - Golden Layout configuration
     */
    applyLayout(layoutConfig) {
        this.gl.loadLayout(layoutConfig);
    }

    /**
     * Get current layout configuration
     * @returns {Object} Layout configuration
     */
    getLayout() {
        return this.gl.saveLayout();
    }

    /**
     * Destroy all panels
     */
    destroy() {
        this.panels.forEach((panel, id) => {
            if (panel.container) {
                panel.container.close();
            }
        });
        
        this.panels.clear();
        this.virtualizedPanels.clear();
        this.renderQueue = [];
    }
}

export default PanelController;

