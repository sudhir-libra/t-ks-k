// src/nodes/filters/BaseFilter.js

/*
    BaseFilter

    This class defines the contract that ALL filters must follow.

    A filter:
    - Receives an input texture
    - Writes to an output render target
    - Uses a shader program
    - Has adjustable parameters

    This makes filters modular and sellable.
*/

export class BaseFilter {

    constructor() {
        this.program = null;       // GPU shader program
        this.params = {};          // Parameter dictionary
    }

    /*
        init(backend)

        Called once when filter is added.
        Compiles shader and stores GPU resources.
    */
    init(backend) {
        // Override in subclass
    }

    /*
        apply(backend, inputTarget, outputTarget)

        Runs shader:
        inputTarget.texture → outputTarget
    */
    apply(backend, inputTarget, outputTarget) {
        // Override in subclass
    }

    /*
        destroy()

        Cleanup GPU resources
    */
    destroy(gl) {
        if (this.program) {
            gl.deleteProgram(this.program);
        }
    }
}