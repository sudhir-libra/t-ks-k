/**
 * Virtual Panel Renderer - High Performance Rendering for 30-50+ Panels
 * Implements panel virtualization, lazy loading, and render optimization
 */

import { eventBus, Events } from './EventBus.js';

export class VirtualPanelRenderer {
    constructor(options = {}) {
        this.options = {
            maxVisiblePanels: options.maxVisiblePanels || 20,
            renderBatchSize: options.renderBatchSize || 5,
            renderThrottleMs: options.renderThrottleMs || 16,
            lazyLoadThreshold: options.lazyLoadThreshold || 200, // pixels
            ...options
        };
        
        // Panel tracking
        this.panels = new Map();
        this.visiblePanels = new Set();
        this.renderQueue = [];
        this.isProcessing = false;
        
        // Performance metrics
        this.metrics = {
            totalPanels: 0,
            visiblePanels: 0,
            renderedFrames: 0,
            skippedFrames: 0,
            avgRenderTime: 0
        };
        
        // Observer for intersection detection
        this.intersectionObserver = null;
        
        // Initialize
        this.initIntersectionObserver();
    }

    /**
     * Initialize Intersection Observer for visibility detection
     */
    initIntersectionObserver() {
        if (!('IntersectionObserver' in window)) {
            console.warn('IntersectionObserver not supported, using fallback');
            this.fallbackVisibilityCheck();
            return;
        }
        
        this.intersectionObserver = new IntersectionObserver(
            (entries) => this.handleIntersection(entries),
            {
                root: null,
                rootMargin: `${this.options.lazyLoadThreshold}px`,
                threshold: 0.1
            }
        );
    }

    /**
     * Handle intersection changes
     * @param {Array} entries - Intersection observer entries
     */
    handleIntersection(entries) {
        entries.forEach(entry => {
            const panelId = entry.target.dataset.panelId;
            if (!panelId) return;
            
            const panel = this.panels.get(panelId);
            if (!panel) return;
            
            const isVisible = entry.isIntersecting;
            const wasVisible = panel.isVisible;
            
            if (isVisible && !wasVisible) {
                // Panel became visible
                this.onPanelVisible(panelId);
            } else if (!isVisible && wasVisible) {
                // Panel became hidden
                this.onPanelHidden(panelId);
            }
            
            panel.isVisible = isVisible;
            panel.intersectionRatio = entry.intersectionRatio;
        });
        
        this.updateMetrics();
    }

    /**
     * Register a panel for virtual rendering
     * @param {string} panelId - Unique panel ID
     * @param {HTMLElement} element - Panel DOM element
     * @param {Object} config - Panel configuration
     */
    registerPanel(panelId, element, config = {}) {
        const panel = {
            id: panelId,
            element,
            config,
            isVisible: false,
            isRendered: false,
            isLazy: config.lazy !== false,
            lastRenderTime: 0,
            priority: config.priority || 0,
            renderCallback: config.renderCallback || null,
            cleanupCallback: config.cleanupCallback || null,
            intersectionRatio: 0
        };
        
        this.panels.set(panelId, panel);
        this.metrics.totalPanels = this.panels.size;
        
        // Observe panel
        if (this.intersectionObserver) {
            this.intersectionObserver.observe(element);
        } else {
            // Fallback: check on scroll/resize
            element.dataset.panelId = panelId;
        }
        
        // Emit registration event
        eventBus.emit('virtual:panelRegistered', { panelId }, 'VirtualPanelRenderer');
    }

    /**
     * Unregister a panel
     * @param {string} panelId - Panel ID
     */
    unregisterPanel(panelId) {
        const panel = this.panels.get(panelId);
        if (!panel) return;
        
        // Cleanup if rendered
        if (panel.isRendered && panel.cleanupCallback) {
            panel.cleanupCallback(panel.element);
        }
        
        // Unobserve
        if (this.intersectionObserver && panel.element) {
            this.intersectionObserver.unobserve(panel.element);
        }
        
        this.panels.delete(panelId);
        this.visiblePanels.delete(panelId);
        this.metrics.totalPanels = this.panels.size;
        
        eventBus.emit('virtual:panelUnregistered', { panelId }, 'VirtualPanelRenderer');
    }

    /**
     * Called when panel becomes visible
     * @param {string} panelId - Panel ID
     */
    onPanelVisible(panelId) {
        const panel = this.panels.get(panelId);
        if (!panel) return;
        
        this.visiblePanels.add(panelId);
        panel.isVisible = true;
        
        // Check if we need to render
        if (!panel.isRendered && panel.renderCallback) {
            this.queueRender(panelId);
        }
        
        // Apply visible styles
        panel.element.style.visibility = 'visible';
        panel.element.style.opacity = '1';
        
        eventBus.emit('virtual:panelVisible', { panelId }, 'VirtualPanelRenderer');
    }

    /**
     * Called when panel becomes hidden
     * @param {string} panelId - Panel ID
     */
    onPanelHidden(panelId) {
        const panel = this.panels.get(panelId);
        if (!panel) return;
        
        this.visiblePanels.delete(panelId);
        panel.isVisible = false;
        
        // Apply hidden styles for performance
        if (!panel.config.keepAlive) {
            panel.element.style.visibility = 'hidden';
            panel.element.style.opacity = '0';
        }
        
        eventBus.emit('virtual:panelHidden', { panelId }, 'VirtualPanelRenderer');
    }

    /**
     * Queue a panel for rendering
     * @param {string} panelId - Panel ID
     * @param {number} priority - Render priority
     */
    queueRender(panelId, priority = 0) {
        const panel = this.panels.get(panelId);
        if (!panel || panel.isRendered) return;
        
        // Update priority if higher
        panel.priority = Math.max(panel.priority, priority);
        
        // Add to queue if not already
        if (!this.renderQueue.includes(panelId)) {
            this.renderQueue.push(panelId);
        }
        
        // Sort by priority
        this.renderQueue.sort((a, b) => {
            const panelA = this.panels.get(a);
            const panelB = this.panels.get(b);
            return (panelB?.priority || 0) - (panelA?.priority || 0);
        });
        
        this.processQueue();
    }

    /**
     * Process render queue
     */
    processQueue() {
        if (this.isProcessing) return;
        
        this.isProcessing = true;
        
        // Process batch
        const batch = this.renderQueue.splice(0, this.options.renderBatchSize);
        
        batch.forEach(panelId => {
            const panel = this.panels.get(panelId);
            if (!panel || !panel.isVisible || panel.isRendered) return;
            
            const startTime = performance.now();
            
            try {
                if (panel.renderCallback) {
                    panel.renderCallback(panel.element);
                    panel.isRendered = true;
                    panel.lastRenderTime = performance.now();
                    this.metrics.renderedFrames++;
                }
            } catch (error) {
                console.error(`Error rendering panel ${panelId}:`, error);
                eventBus.emit(Events.ERROR, { 
                    error: error.message, 
                    panelId 
                }, 'VirtualPanelRenderer');
            }
        });
        
        const renderTime = performance.now() - startTime;
        this.metrics.avgRenderTime = 
            (this.metrics.avgRenderTime * (this.metrics.renderedFrames - 1) + renderTime) / 
            this.metrics.renderedFrames;
        
        this.isProcessing = false;
        this.updateMetrics();
        
        // Continue if more in queue
        if (this.renderQueue.length > 0) {
            setTimeout(() => this.processQueue(), this.options.renderThrottleMs);
        }
    }

    /**
     * Force render a panel immediately
     * @param {string} panelId - Panel ID
     */
    renderNow(panelId) {
        const panel = this.panels.get(panelId);
        if (!panel || panel.isRendered) return;
        
        if (panel.renderCallback) {
            panel.renderCallback(panel.element);
            panel.isRendered = true;
            panel.lastRenderTime = performance.now();
        }
    }

    /**
     * Clear render cache for a panel
     * @param {string} panelId - Panel ID
     */
    invalidateRender(panelId) {
        const panel = this.panels.get(panelId);
        if (!panel) return;
        
        panel.isRendered = false;
        
        if (panel.isVisible) {
            this.queueRender(panelId);
        }
    }

    /**
     * Fallback visibility check (for browsers without IntersectionObserver)
     */
    fallbackVisibilityCheck() {
        const check = () => {
            this.panels.forEach((panel, panelId) => {
                if (!panel.element) return;
                
                const rect = panel.element.getBoundingClientRect();
                const isVisible = 
                    rect.top < window.innerHeight + this.options.lazyLoadThreshold &&
                    rect.left < window.innerWidth + this.options.lazyLoadThreshold &&
                    rect.bottom > -this.options.lazyLoadThreshold &&
                    rect.right > -this.options.lazyLoadThreshold;
                
                if (isVisible !== panel.isVisible) {
                    if (isVisible) {
                        this.onPanelVisible(panelId);
                    } else {
                        this.onPanelHidden(panelId);
                    }
                    panel.isVisible = isVisible;
                }
            });
            
            requestAnimationFrame(check);
        };
        
        check();
        
        // Also listen to scroll/resize
        window.addEventListener('scroll', check, { passive: true });
        window.addEventListener('resize', check, { passive: true });
    }

    /**
     * Update performance metrics
     */
    updateMetrics() {
        this.metrics.visiblePanels = this.visiblePanels.size;
        
        // Emit metrics event
        eventBus.emit('virtual:metrics', this.metrics, 'VirtualPanelRenderer');
    }

    /**
     * Get performance metrics
     * @returns {Object} Metrics object
     */
    getMetrics() {
        return { ...this.metrics };
    }

    /**
     * Force render all visible panels
     */
    renderAllVisible() {
        this.visiblePanels.forEach(panelId => {
            const panel = this.panels.get(panelId);
            if (panel && !panel.isRendered) {
                this.renderNow(panelId);
            }
        });
    }

    /**
     * Pause virtual rendering
     */
    pause() {
        this.isProcessing = false;
    }

    /**
     * Resume virtual rendering
     */
    resume() {
        if (this.renderQueue.length > 0) {
            this.processQueue();
        }
    }

    /**
     * Destroy and cleanup
     */
    destroy() {
        // Unobserve all panels
        this.panels.forEach((panel, panelId) => {
            if (this.intersectionObserver && panel.element) {
                this.intersectionObserver.unobserve(panel.element);
            }
        });
        
        this.panels.clear();
        this.visiblePanels.clear();
        this.renderQueue = [];
        
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
        }
    }
}

// Lazy Panel Loader - Dynamic panel loading
export class LazyPanelLoader {
    constructor() {
        this.loadedPanels = new Map();
        this.loadingPanels = new Set();
        this.loadCallbacks = new Map();
    }

    /**
     * Load a panel module dynamically
     * @param {string} panelType - Panel type identifier
     * @param {string} modulePath - Path to panel module
     * @returns {Promise} Promise that resolves with panel module
     */
    async loadPanel(panelType, modulePath) {
        // Return cached
        if (this.loadedPanels.has(panelType)) {
            return this.loadedPanels.get(panelType);
        }
        
        // Return existing promise if loading
        if (this.loadingPanels.has(panelType)) {
            return new Promise((resolve, reject) => {
                const callbacks = this.loadCallbacks.get(panelType) || { resolve: [], reject: [] };
                callbacks.resolve.push(resolve);
                callbacks.reject.push(reject);
                this.loadCallbacks.set(panelType, callbacks);
            });
        }
        
        this.loadingPanels.add(panelType);
        
        try {
            const module = await import(/* @vite-ignore */ modulePath);
            this.loadedPanels.set(panelType, module);
            
            // Resolve waiting promises
            const callbacks = this.loadCallbacks.get(panelType);
            if (callbacks) {
                callbacks.resolve.forEach(cb => cb(module));
                this.loadCallbacks.delete(panelType);
            }
            
            eventBus.emit('virtual:panelLoaded', { panelType }, 'LazyPanelLoader');
            
            return module;
        } catch (error) {
            // Reject waiting promises
            const callbacks = this.loadCallbacks.get(panelType);
            if (callbacks) {
                callbacks.reject.forEach(cb => cb(error));
                this.loadCallbacks.delete(panelType);
            }
            
            throw error;
        } finally {
            this.loadingPanels.delete(panelType);
        }
    }

    /**
     * Preload panels
     * @param {Array} panelTypes - Array of panel types to preload
     * @param {Object} paths - Map of panel type to module path
     */
    async preloadPanels(panelTypes, paths) {
        await Promise.all(
            panelTypes.map(type => {
                const path = paths[type];
                if (path) {
                    return this.loadPanel(type, path).catch(err => {
                        console.warn(`Failed to preload panel ${type}:`, err);
                    });
                }
            })
        );
    }

    /**
     * Check if panel is loaded
     * @param {string} panelType - Panel type
     * @returns {boolean} True if loaded
     */
    isLoaded(panelType) {
        return this.loadedPanels.has(panelType);
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.loadedPanels.clear();
    }
}

export default VirtualPanelRenderer;

