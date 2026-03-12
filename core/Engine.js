// src/core/Engine.js

import { Scene } from './Scene.js';
import { FrameContext } from './FrameContext.js';

export class Engine {
    constructor() {
        this.scene = new Scene();
        this.backend = null;
        this.canvas = null;
        this.running = false;
        this.rafId = null;
        this.listeners = {};
    }

    async init(canvas, backend) {
        this.canvas = canvas;
        this.backend = backend;
        await this.backend.init(canvas);
        this.emit("ENGINE_READY");
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.loop();
    }

    stop() {
        this.running = false;
        cancelAnimationFrame(this.rafId);
    }

    loop = (time = 0) => {
        if (!this.running) return;

        const frameContext = new FrameContext(this.backend, time);
        this.scene.process(frameContext);

        this.rafId = requestAnimationFrame(this.loop);
    }

	async setBackend(newBackend) {
		this.stop();

		if (this.backend) {
			await this.backend.destroy();
		}

		// 🔥 FORCE canvas context reset
		const oldCanvas = this.canvas;
		const parent = oldCanvas.parentNode;

		const newCanvas = oldCanvas.cloneNode(true);
		parent.replaceChild(newCanvas, oldCanvas);

		this.canvas = newCanvas;

		await newBackend.init(this.canvas);
		this.backend = newBackend;
		// Notify scene that backend changed
		this.scene.onBackendChanged(this.backend);

		this.start();
	}

    addNode(node) {
        this.scene.addNode(node);
        this.emit("STATE_UPDATED", this.getState());
    }

    setProgramNode(nodeId) {
        this.scene.setProgramNode(nodeId);
        this.emit("STATE_UPDATED", this.getState());
    }

    setPreviewNode(nodeId) {
        this.scene.setPreviewNode(nodeId);
        this.emit("STATE_UPDATED", this.getState());
    }

    cut() {
        this.scene.cut();
        this.emit("STATE_UPDATED", this.getState());
    }

    getState() {
        return this.scene.getState();
    }

    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    }

    emit(event, payload) {
        (this.listeners[event] || []).forEach(cb => cb(payload));
    }
}
