// src/nodes/BaseNode.js

export class BaseNode {
    constructor(id) {
        this.id = id;
    }

    process(frameContext) {
        // override
    }

    destroy() {}
}