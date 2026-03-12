// src/nodes/InputNode.js

import { BaseNode } from './BaseNode.js';
import { ChromaFilter } from './filters/ChromaFilter.js';
import { AdvancedChromaFilter } from './filters/AdvancedChromaFilter.js';
import { EnterpriseChromaFilter } from './filters/EnterpriseChromaFilter.js';
import { TrueEnterpriseChromaFilter } from './filters/TrueEnterpriseChromaFilter.js';
import { BroadcastChromaFilter } from './filters/BroadcastChromaFilter.js';
import { CinematicChromaFilter } from './filters/CinematicChromaFilter.js';

export class InputNode extends BaseNode {

    constructor(id, videoElement, backgroundElement = null) {
        super(id);

        this.video = videoElement;
        this.backgroundVideo = backgroundElement;
        this.chromaEnabled = false;

        this.filters = [];
        this.filters.push(new ChromaFilter());
    }

    isReadySource(element) {
        if (!element) return false;

        if (element instanceof HTMLVideoElement) {
            return element.readyState >= 2;
        }

        if (element instanceof HTMLImageElement) {
            return element.complete;
        }

        if (element instanceof HTMLCanvasElement) {
            return true;
        }

        return false;
    }

    process(frameContext) {
        const backend = frameContext.backend;

        if (!this.isReadySource(this.video)) return;

        if (!backend.supportsShaders) {
            backend.drawVideo(this.video, null);
            return;
        }

        let currentTarget = backend.drawVideo(this.video, backend.renderTarget);
        if (!currentTarget) return;

        let bgTarget = currentTarget;

        if (this.backgroundVideo && this.isReadySource(this.backgroundVideo)) {
            bgTarget = backend.drawVideo(this.backgroundVideo, backend.renderTargetB);
        }

        if (this.chromaEnabled) {
            for (const filter of this.filters) {
                if (!filter.program) {
                    filter.init(backend);
                }

                currentTarget = filter.apply(backend, currentTarget, bgTarget);
            }
        }

        backend.blitToScreen(currentTarget);
    }

    setChromaType(type) {
        this.filters = [];

        if (type === 'basic') {
            this.filters.push(new ChromaFilter());
        }

        if (type === 'advanced') {
            this.filters.push(new AdvancedChromaFilter());
        }

        if (type === 'enterprise') {
            this.filters.push(new EnterpriseChromaFilter());
        }

        if (type === 'trueenterprise') {
            this.filters.push(new TrueEnterpriseChromaFilter());
        }

        if (type === 'broadcast') {
            this.filters.push(new BroadcastChromaFilter());
        }

        if (type === 'cinematic') {
            this.filters.push(new CinematicChromaFilter());
        }

        this.filters.forEach(filter => {
            filter.program = null;
        });
    }

    onBackendChanged() {
        this.filters.forEach(filter => {
            filter.program = null;
        });
    }
}
