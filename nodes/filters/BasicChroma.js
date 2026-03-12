export class BaseChroma {
    constructor(name) {
        this.name = name;
        this.params = {};
        this.program = null;
    }

    init(backend) {}
    apply(backend, inputTarget, backgroundTarget) {}
}