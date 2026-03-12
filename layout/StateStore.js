/**
 * Global State Store - Centralized State Management
 * Works with EventBus to provide reactive state management
 */

import { eventBus, Events } from './EventBus.js';

export class StateStore {
    constructor() {
        this.state = {
            // Switcher State
            switcher: {
                programSourceId: null,
                previewSourceId: null,
                transitionDuration: 800,
                transitionAnimation: 'fade',
                transitionEffect: 'clean',
                isTransitioning: false
            },
            
            // Sources State
            sources: {
                list: [],
                selectedId: null,
                inputSlots: [],
                auxSlots: [],
                overlaySlots: []
            },
            
            // Recording State
            recording: {
                isRecording: false,
                target: 'program',
                sessions: new Map()
            },
            
            // Streaming State
            streaming: {
                isStreaming: false,
                status: 'idle',
                endpoint: ''
            },
            
            // Layout State
            layout: {
                currentPreset: 'default',
                isDirty: false,
                panels: new Map(),
                floatingWindows: []
            },
            
            // UI State
            ui: {
                theme: 'dark',
                panelPosition: 'left',
                audioMetersVisible: true,
                previewNamesVisible: true,
                scales: {
                    output: 1.0,
                    input: 1.0,
                    router: 1.0,
                    overlay: 1.0
                }
            },
            
            // Panel Virtualization State
            virtualization: {
                visiblePanels: new Set(),
                renderQueue: [],
                maxVisiblePanels: 20,
                offscreenPanels: new Map()
            }
        };
        
        this.listeners = new Map();
        this.history = [];
        this.maxHistory = 50;
    }

    /**
     * Get current state or a specific path
     * @param {string} path - Dot-separated path (e.g., 'switcher.programSourceId')
     * @returns {*} State value
     */
    getState(path = null) {
        if (!path) return this.state;
        
        const keys = path.split('.');
        let value = this.state;
        
        for (const key of keys) {
            if (value === undefined || value === null) return undefined;
            value = value[key];
        }
        
        return value;
    }

    /**
     * Set state with validation and event emission
     * @param {string} path - Dot-separated path
     * @param {*} value - New value
     * @param {boolean} silent - If true, don't emit events
     */
    setState(path, value, silent = false) {
        const keys = path.split('.');
        const lastKey = keys.pop();
        let target = this.state;
        
        for (const key of keys) {
            if (target[key] === undefined) {
                target[key] = {};
            }
            target = target[key];
        }
        
        const oldValue = target[lastKey];
        target[lastKey] = value;
        
        // Store in history
        this.history.push({
            path,
            oldValue,
            newValue: value,
            timestamp: Date.now()
        });
        
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }
        
        // Emit change event
        if (!silent) {
            eventBus.emit(Events.SETTINGS_CHANGED, { path, value, oldValue }, 'StateStore');
        }
        
        // Notify listeners
        this.notifyListeners(path, value, oldValue);
    }

    /**
     * Subscribe to state changes
     * @param {string} path - Path to watch (or null for all)
     * @param {Function} callback - Callback function
     * @returns {Function} Unsubscribe function
     */
    subscribe(path, callback) {
        if (!this.listeners.has(path)) {
            this.listeners.set(path, new Set());
        }
        
        this.listeners.get(path).add(callback);
        
        return () => {
            const listeners = this.listeners.get(path);
            if (listeners) {
                listeners.delete(callback);
            }
        };
    }

    /**
     * Notify all relevant listeners
     * @param {string} path - Changed path
     * @param {*} newValue - New value
     * @param {*} oldValue - Old value
     */
    notifyListeners(path, newValue, oldValue) {
        // Notify exact path listeners
        if (this.listeners.has(path)) {
            this.listeners.get(path).forEach(cb => cb(newValue, oldValue, path));
        }
        
        // Notify wildcard listeners
        if (this.listeners.has('*')) {
            this.listeners.get('*').forEach(cb => cb(newValue, oldValue, path));
        }
        
        // Notify parent path listeners
        const keys = path.split('.');
        for (let i = 1; i < keys.length; i++) {
            const parentPath = keys.slice(0, i).join('.');
            if (this.listeners.has(parentPath)) {
                this.listeners.get(parentPath).forEach(cb => cb(newValue, oldValue, path));
            }
        }
    }

    /**
     * Update multiple state values at once
     * @param {Object} updates - Object with paths as keys
     * @param {boolean} silent - If true, don't emit events
     */
    batchUpdate(updates, silent = false) {
        for (const [path, value] of Object.entries(updates)) {
            this.setState(path, value, silent);
        }
    }

    /**
     * Get state history
     * @returns {Array} State history
     */
    getHistory() {
        return [...this.history];
    }

    /**
     * Reset state to initial values
     */
    reset() {
        this.state = {
            switcher: {
                programSourceId: null,
                previewSourceId: null,
                transitionDuration: 800,
                transitionAnimation: 'fade',
                transitionEffect: 'clean',
                isTransitioning: false
            },
            sources: {
                list: [],
                selectedId: null,
                inputSlots: [],
                auxSlots: [],
                overlaySlots: []
            },
            recording: {
                isRecording: false,
                target: 'program',
                sessions: new Map()
            },
            streaming: {
                isStreaming: false,
                status: 'idle',
                endpoint: ''
            },
            layout: {
                currentPreset: 'default',
                isDirty: false,
                panels: new Map(),
                floatingWindows: []
            },
            ui: {
                theme: 'dark',
                panelPosition: 'left',
                audioMetersVisible: true,
                previewNamesVisible: true,
                scales: {
                    output: 1.0,
                    input: 1.0,
                    router: 1.0,
                    overlay: 1.0
                }
            },
            virtualization: {
                visiblePanels: new Set(),
                renderQueue: [],
                maxVisiblePanels: 20,
                offscreenPanels: new Map()
            }
        };
        
        this.history = [];
        eventBus.emit(Events.SETTINGS_CHANGED, { path: 'state:reset', value: true }, 'StateStore');
    }

    /**
     * Export state for persistence
     * @returns {Object} Serializable state
     */
    exportState() {
        const serializable = JSON.parse(JSON.stringify(this.state));
        
        // Convert Maps to objects
        serializable.layout.panels = Object.fromEntries(this.state.layout.panels);
        serializable.recording.sessions = Object.fromEntries(this.state.recording.sessions);
        
        return serializable;
    }

    /**
     * Import state from persistence
     * @param {Object} data - State data to import
     */
    importState(data) {
        if (!data) return;
        
        this.batchUpdate({
            'switcher.programSourceId': data.switcher?.programSourceId,
            'switcher.previewSourceId': data.switcher?.previewSourceId,
            'switcher.transitionDuration': data.switcher?.transitionDuration,
            'switcher.transitionAnimation': data.switcher?.transitionAnimation,
            'switcher.transitionEffect': data.switcher?.transitionEffect,
            'ui.theme': data.ui?.theme,
            'ui.panelPosition': data.ui?.panelPosition,
            'ui.audioMetersVisible': data.ui?.audioMetersVisible,
            'ui.previewNamesVisible': data.ui?.previewNamesVisible,
            'ui.scales': data.ui?.scales,
            'layout.currentPreset': data.layout?.currentPreset
        });
        
        eventBus.emit(Events.LAYOUT_LOAD, data, 'StateStore');
    }
}

// Singleton instance
export const stateStore = new StateStore();

export default stateStore;

