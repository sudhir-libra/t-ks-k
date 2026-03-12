/**
 * EventBus - Central Event Bus for Panel Communication
 * All panel communication MUST pass through this bus
 * Panels must NOT communicate directly with WebSocket or each other
 */

export class EventBus {
    constructor() {
        this.listeners = new Map();
        this.eventHistory = [];
        this.maxHistory = 100;
    }

    /**
     * Subscribe to an event
     * @param {string} eventName - Event name to subscribe to
     * @param {Function} callback - Callback function
     * @param {string} subscriberId - Identifier for the subscriber
     * @returns {Function} Unsubscribe function
     */
    on(eventName, callback, subscriberId = 'anonymous') {
        if (!this.listeners.has(eventName)) {
            this.listeners.set(eventName, []);
        }
        
        const listener = {
            callback,
            subscriberId,
            timestamp: Date.now()
        };
        
        this.listeners.get(eventName).push(listener);
        
        // Return unsubscribe function
        return () => {
            const listeners = this.listeners.get(eventName);
            if (listeners) {
                const index = listeners.indexOf(listener);
                if (index > -1) {
                    listeners.splice(index, 1);
                }
            }
        };
    }

    /**
     * Subscribe to an event once
     * @param {string} eventName - Event name
     * @param {Function} callback - Callback function
     * @param {string} subscriberId - Subscriber identifier
     */
    once(eventName, callback, subscriberId = 'anonymous') {
        const unsubscribe = this.on(eventName, (...args) => {
            unsubscribe();
            callback(...args);
        }, subscriberId);
        return unsubscribe;
    }

    /**
     * Emit an event to all subscribers
     * @param {string} eventName - Event name
     * @param {*} data - Data to pass to listeners
     * @param {string} sourceId - Source of the event
     */
    emit(eventName, data = null, sourceId = 'unknown') {
        // Store in history
        this.eventHistory.push({
            eventName,
            data,
            sourceId,
            timestamp: Date.now()
        });

        // Trim history
        if (this.eventHistory.length > this.maxHistory) {
            this.eventHistory.shift();
        }

        const listeners = this.listeners.get(eventName);
        if (listeners) {
            // Create a copy to avoid issues during iteration
            const listenersCopy = [...listeners];
            listenersCopy.forEach(listener => {
                try {
                    listener.callback(data, { eventName, sourceId, timestamp: Date.now() });
                } catch (error) {
                    console.error(`Error in event listener for '${eventName}' from '${listener.subscriberId}':`, error);
                }
            });
        }
    }

    /**
     * Remove all listeners for a specific subscriber
     * @param {string} subscriberId - Subscriber identifier
     */
    unsubscribeAll(subscriberId) {
        this.listeners.forEach((listeners, eventName) => {
            const toRemove = listeners.filter(l => l.subscriberId === subscriberId);
            toRemove.forEach(listener => {
                const index = listeners.indexOf(listener);
                if (index > -1) {
                    listeners.splice(index, 1);
                }
            });
        });
    }

    /**
     * Clear all listeners
     */
    clear() {
        this.listeners.clear();
        this.eventHistory = [];
    }

    /**
     * Get event history
     * @param {number} limit - Maximum number of events to return
     * @returns {Array} Event history
     */
    getHistory(limit = 50) {
        return this.eventHistory.slice(-limit);
    }
}

// Singleton instance
export const eventBus = new EventBus();

// Event name constants
export const Events = {
    // Panel Events
    PANEL_OPEN: 'panel:open',
    PANEL_CLOSE: 'panel:close',
    PANEL_FOCUS: 'panel:focus',
    PANEL_RESIZE: 'panel:resize',
    PANEL_MOVE: 'panel:move',
    PANEL_DOCK: 'panel:dock',
    PANEL_UNDOCK: 'panel:undock',
    PANEL_POPOUT: 'panel:popout',
    PANEL_STATE_CHANGED: 'panel:stateChanged',
    
    // Source Events
    SOURCE_SELECTED: 'source:selected',
    SOURCE_ASSIGNED: 'source:assigned',
    SOURCE_REMOVED: 'source:removed',
    SOURCE_UPDATED: 'source:updated',
    
    // Switcher Events
    CUT_TRIGGERED: 'switcher:cut',
    AUTO_TRIGGERED: 'switcher:auto',
    TRANSITION_START: 'switcher:transitionStart',
    TRANSITION_END: 'switcher:transitionEnd',
    PROGRAM_CHANGED: 'switcher:programChanged',
    PREVIEW_CHANGED: 'switcher:previewChanged',
    
    // Recording Events
    RECORDING_START: 'recording:start',
    RECORDING_STOP: 'recording:stop',
    RECORDING_STATE: 'recording:state',
    
    // Streaming Events
    STREAMING_START: 'streaming:start',
    STREAMING_STOP: 'streaming:stop',
    STREAMING_STATE: 'streaming:state',
    
    // Overlay Events
    OVERLAY_ASSIGNED: 'overlay:assigned',
    OVERLAY_REMOVED: 'overlay:removed',
    OVERLAY_VISIBILITY: 'overlay:visibility',
    
    // Layout Events
    LAYOUT_SAVE: 'layout:save',
    LAYOUT_LOAD: 'layout:load',
    LAYOUT_RESET: 'layout:reset',
    LAYOUT_PRESET_APPLY: 'layout:applyPreset',
    
    // Settings Events
    SETTINGS_CHANGED: 'settings:changed',
    THEME_CHANGED: 'settings:themeChanged',
    
    // System Events
    INITIALIZED: 'system:initialized',
    ERROR: 'system:error'
};

export default eventBus;

