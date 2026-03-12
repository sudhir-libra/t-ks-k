/**
 * Layout Manager - Save/Restore Layouts and Presets
 * Handles layout persistence, presets, and configuration
 */

import { eventBus, Events } from './EventBus.js';
import { stateStore } from './StateStore.js';

export class LayoutManager {
    constructor(goldenLayout) {
        this.gl = goldenLayout;
        this.currentLayout = null;
        this.layouts = new Map();
        this.presets = new Map();
        this.autoSaveInterval = null;
        this.autoSaveDelay = 30000; // 30 seconds
        
        // Default presets
        this.defaultPresets = {
            'default': {
                name: 'Default',
                description: 'Standard broadcast layout',
                config: null // Will use GL default
            },
            'minimal': {
                name: 'Minimal',
                description: 'Minimal switcher view',
                config: null
            },
            'expanded': {
                name: 'Expanded',
                description: 'Expanded inputs and outputs',
                config: null
            },
            'multi-view': {
                name: 'Multi-View',
                description: 'Multiple preview monitors',
                config: null
            }
        };
        
        // Initialize
        this.init();
    }

    /**
     * Initialize layout manager
     */
    init() {
        // Load saved layouts from localStorage
        this.loadLayoutsFromStorage();
        
        // Register default presets
        Object.entries(this.defaultPresets).forEach(([key, preset]) => {
            this.registerPreset(key, preset);
        });
        
        // Bind events
        this.bindEvents();
        
        // Start auto-save
        this.startAutoSave();
    }

    /**
     * Bind to events
     */
    bindEvents() {
        eventBus.on(Events.LAYOUT_SAVE, (data) => {
            this.saveLayout(data?.name);
        }, 'LayoutManager');
        
        eventBus.on(Events.LAYOUT_LOAD, (data) => {
            this.loadLayout(data?.name);
        }, 'LayoutManager');
        
        eventBus.on(Events.LAYOUT_RESET, () => {
            this.resetToDefault();
        }, 'LayoutManager');
        
        eventBus.on(Events.LAYOUT_PRESET_APPLY, (data) => {
            this.applyPreset(data?.preset);
        }, 'LayoutManager');
    }

    /**
     * Save current layout
     * @param {string} name - Layout name
     * @returns {boolean} Success
     */
    saveLayout(name = 'current') {
        try {
            const config = this.gl.saveLayout();
            
            const layoutData = {
                name,
                config,
                timestamp: Date.now(),
                version: '2.0',
                goldenLayoutVersion: '2.6.0'
            };
            
            // Store in memory
            this.layouts.set(name, layoutData);
            
            // Store in localStorage
            this.saveLayoutsToStorage();
            
            // Update state
            stateStore.setState('layout.currentLayout', name);
            stateStore.setState('layout.isDirty', false);
            
            eventBus.emit('layout:saved', { name, config }, 'LayoutManager');
            
            return true;
        } catch (error) {
            console.error('Failed to save layout:', error);
            eventBus.emit(Events.ERROR, { error: error.message, context: 'layout:save' }, 'LayoutManager');
            return false;
        }
    }

    /**
     * Load a layout
     * @param {string} name - Layout name
     * @returns {boolean} Success
     */
    loadLayout(name = 'default') {
        try {
            // Check memory first
            let layoutData = this.layouts.get(name);
            
            // Then localStorage
            if (!layoutData) {
                const stored = localStorage.getItem(`switcher_layout_${name}`);
                if (stored) {
                    layoutData = JSON.parse(stored);
                }
            }
            
            // Then check presets
            if (!layoutData && this.presets.has(name)) {
                const preset = this.presets.get(name);
                if (preset.config) {
                    layoutData = { name, config: preset.config };
                }
            }
            
            if (!layoutData) {
                console.warn(`Layout '${name}' not found`);
                return false;
            }
            
            // Apply layout
            this.gl.loadLayout(layoutData.config);
            
            this.currentLayout = name;
            stateStore.setState('layout.currentLayout', name);
            stateStore.setState('layout.isDirty', false);
            
            eventBus.emit('layout:loaded', { name }, 'LayoutManager');
            
            return true;
        } catch (error) {
            console.error('Failed to load layout:', error);
            eventBus.emit(Events.ERROR, { error: error.message, context: 'layout:load' }, 'LayoutManager');
            return false;
        }
    }

    /**
     * Delete a layout
     * @param {string} name - Layout name
     * @returns {boolean} Success
     */
    deleteLayout(name) {
        if (!this.layouts.has(name)) {
            return false;
        }
        
        this.layouts.delete(name);
        localStorage.removeItem(`switcher_layout_${name}`);
        
        eventBus.emit('layout:deleted', { name }, 'LayoutManager');
        
        return true;
    }

    /**
     * Get all saved layouts
     * @returns {Array} Layout list
     */
    getSavedLayouts() {
        const layouts = [];
        
        this.layouts.forEach((data, name) => {
            layouts.push({
                name,
                timestamp: data.timestamp,
                version: data.version
            });
        });
        
        // Also get from localStorage
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('switcher_layout_')) {
                const name = key.replace('switcher_layout_', '');
                if (!this.layouts.has(name)) {
                    try {
                        const data = JSON.parse(localStorage.getItem(key));
                        layouts.push({
                            name,
                            timestamp: data.timestamp,
                            version: data.version
                        });
                    } catch (e) {}
                }
            }
        });
        
        return layouts.sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Register a preset
     * @param {string} name - Preset name
     * @param {Object} preset - Preset configuration
     */
    registerPreset(name, preset) {
        this.presets.set(name, {
            name: preset.name || name,
            description: preset.description || '',
            config: preset.config || null
        });
    }

    /**
     * Apply a preset
     * @param {string} presetName - Preset name
     * @returns {boolean} Success
     */
    applyPreset(presetName) {
        const preset = this.presets.get(presetName);
        
        if (!preset) {
            console.warn(`Preset '${presetName}' not found`);
            return false;
        }
        
        if (preset.config) {
            this.gl.loadLayout(preset.config);
        }
        
        stateStore.setState('layout.currentPreset', presetName);
        
        eventBus.emit('layout:presetApplied', { preset: presetName }, 'LayoutManager');
        
        return true;
    }

    /**
     * Get all presets
     * @returns {Array} Preset list
     */
    getPresets() {
        const presets = [];
        
        this.presets.forEach((preset, name) => {
            presets.push({
                name,
                displayName: preset.name,
                description: preset.description
            });
        });
        
        return presets;
    }

    /**
     * Create preset from current layout
     * @param {string} name - Preset name
     * @param {string} description - Description
     * @returns {boolean} Success
     */
    createPresetFromCurrent(name, description = '') {
        try {
            const config = this.gl.saveLayout();
            
            this.registerPreset(name, {
                name,
                description,
                config
            });
            
            // Save to localStorage
            this.savePresetsToStorage();
            
            eventBus.emit('layout:presetCreated', { name }, 'LayoutManager');
            
            return true;
        } catch (error) {
            console.error('Failed to create preset:', error);
            return false;
        }
    }

    /**
     * Reset to default layout
     */
    resetToDefault() {
        this.loadLayout('default');
    }

    /**
     * Export layout to file
     * @param {string} name - Layout name
     * @returns {Blob} File blob
     */
    exportLayout(name = 'current') {
        const layout = this.layouts.get(name) || this.presets.get(name);
        
        if (!layout) {
            return null;
        }
        
        const blob = new Blob([JSON.stringify(layout, null, 2)], {
            type: 'application/json'
        });
        
        return blob;
    }

    /**
     * Import layout from file
     * @param {File} file - Layout file
     * @returns {Promise} Promise resolving with layout name
     */
    async importLayout(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (e) => {
                try {
                    const layout = JSON.parse(e.target.result);
                    
                    if (!layout.config) {
                        throw new Error('Invalid layout file');
                    }
                    
                    const name = layout.name || `imported_${Date.now()}`;
                    
                    this.layouts.set(name, {
                        ...layout,
                        timestamp: Date.now()
                    });
                    
                    this.saveLayoutsToStorage();
                    
                    resolve(name);
                } catch (error) {
                    reject(error);
                }
            };
            
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    /**
     * Save layouts to localStorage
     */
    saveLayoutsToStorage() {
        const layouts = {};
        
        this.layouts.forEach((data, name) => {
            layouts[name] = data;
        });
        
        try {
            localStorage.setItem('switcher_layouts', JSON.stringify(layouts));
        } catch (error) {
            console.warn('Failed to save layouts to localStorage:', error);
        }
    }

    /**
     * Load layouts from localStorage
     */
    loadLayoutsFromStorage() {
        try {
            const stored = localStorage.getItem('switcher_layouts');
            if (stored) {
                const layouts = JSON.parse(stored);
                Object.entries(layouts).forEach(([name, data]) => {
                    this.layouts.set(name, data);
                });
            }
        } catch (error) {
            console.warn('Failed to load layouts from localStorage:', error);
        }
    }

    /**
     * Save presets to localStorage
     */
    savePresetsToStorage() {
        const presets = {};
        
        this.presets.forEach((preset, name) => {
            presets[name] = preset;
        });
        
        try {
            localStorage.setItem('switcher_presets', JSON.stringify(presets));
        } catch (error) {
            console.warn('Failed to save presets to localStorage:', error);
        }
    }

    /**
     * Load presets from localStorage
     */
    loadPresetsFromStorage() {
        try {
            const stored = localStorage.getItem('switcher_presets');
            if (stored) {
                const presets = JSON.parse(stored);
                Object.entries(presets).forEach(([name, preset]) => {
                    this.presets.set(name, preset);
                });
            }
        } catch (error) {
            console.warn('Failed to load presets from localStorage:', error);
        }
    }

    /**
     * Start auto-save
     */
    startAutoSave() {
        this.stopAutoSave();
        
        this.autoSaveInterval = setInterval(() => {
            if (stateStore.getState('layout.isDirty')) {
                this.saveLayout('autosave');
            }
        }, this.autoSaveDelay);
    }

    /**
     * Stop auto-save
     */
    stopAutoSave() {
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
            this.autoSaveInterval = null;
        }
    }

    /**
     * Mark layout as dirty (modified)
     */
    markDirty() {
        stateStore.setState('layout.isDirty', true);
    }

    /**
     * Get current layout name
     * @returns {string} Current layout name
     */
    getCurrentLayout() {
        return this.currentLayout;
    }

    /**
     * Create broadcast-style layout configuration
     * @returns {Object} Golden Layout configuration
     */
    createBroadcastLayout() {
        return {
            root: {
                type: 'column',
                content: [
                    {
                        type: 'row',
                        height: 60,
                        content: [
                            {
                                type: 'column',
                                width: 70,
                                content: [
                                    {
                                        type: 'component',
                                        componentType: 'program',
                                        title: 'Program'
                                    },
                                    {
                                        type: 'component',
                                        componentType: 'preview',
                                        title: 'Preview'
                                    }
                                ]
                            },
                            {
                                type: 'column',
                                width: 30,
                                content: [
                                    {
                                        type: 'component',
                                        componentType: 'controls',
                                        title: 'Controls'
                                    }
                                ]
                            }
                        ]
                    },
                    {
                        type: 'row',
                        height: 40,
                        content: [
                            {
                                type: 'component',
                                componentType: 'inputs',
                                title: 'Inputs'
                            },
                            {
                                type: 'component',
                                componentType: 'aux',
                                title: 'AUX'
                            },
                            {
                                type: 'component',
                                componentType: 'overlays',
                                title: 'Overlays'
                            }
                        ]
                    }
                ]
            }
        };
    }

    /**
     * Destroy layout manager
     */
    destroy() {
        this.stopAutoSave();
        
        // Save current state before destroy
        this.saveLayout('session');
    }
}

export default LayoutManager;

