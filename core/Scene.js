// src/core/Scene.js

export class Scene {
    constructor() {
        this.nodes = [];
        this.programNodeId = null;
        this.previewNodeId = null;
    }

    addNode(node) {
        this.nodes.push(node);

        // First added node becomes active program by default.
        if (!this.programNodeId) {
            this.programNodeId = node.id;
        }

        // Keep preview pointed at most recently added node
        // unless preview has already been explicitly selected.
        if (!this.previewNodeId) {
            this.previewNodeId = node.id;
        }
    }

    process(frameContext) {
        if (this.nodes.length === 0) return;

        const programNode =
            this.nodes.find(node => node.id === this.programNodeId) ||
            this.nodes[this.nodes.length - 1];

        if (programNode) {
            programNode.process(frameContext);
        }
    }

    getState() {
        return {
            nodeCount: this.nodes.length,
            programNodeId: this.programNodeId,
            previewNodeId: this.previewNodeId,
            nodes: this.nodes.map(node => ({ id: node.id }))
        };
    }
	onBackendChanged(backend) {

    this.nodes.forEach(node => {
        if (node.onBackendChanged) {
            node.onBackendChanged(backend);
        }
    });
}

    setProgramNode(nodeId) {
        if (this.nodes.some(node => node.id === nodeId)) {
            this.programNodeId = nodeId;
        }
    }

    setPreviewNode(nodeId) {
        if (this.nodes.some(node => node.id === nodeId)) {
            this.previewNodeId = nodeId;
        }
    }

    cut() {
        if (!this.programNodeId || !this.previewNodeId) return;
        const currentProgram = this.programNodeId;
        this.programNodeId = this.previewNodeId;
        this.previewNodeId = currentProgram;
    }
}
