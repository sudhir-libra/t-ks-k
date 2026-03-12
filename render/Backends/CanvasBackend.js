// src/render/backends/CanvasBackend.js

import { RenderBackend } from '../RenderBackend.js';

export class CanvasBackend extends RenderBackend {
    async init(canvas) {
        this.canvas = canvas;
		this.supportsShaders = false;
        this.ctx = canvas.getContext('2d');
    }

    isDrawable(source) {
        if (!source) return false;
        if (source instanceof HTMLVideoElement) return source.readyState >= 2;
        if (source instanceof HTMLImageElement) return source.complete;
        if (source instanceof HTMLCanvasElement) return true;
        return false;
    }

    drawVideo(source) {
        if (!this.isDrawable(source)) return;

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
    }

    async destroy() {
        this.ctx = null;
    }
}
