export class RealtimePreviewRenderer {
    constructor(canvas, sourceGetter, options = {}) {
        this.canvas = canvas;
        this.getSource = sourceGetter;
        this.preferWebGL = options.preferWebGL !== false;

        this.gl = null;
        this.ctx2d = null;
        this.program = null;
        this.vao = null;
        this.texture = null;
        this.rafId = null;

        this.init();
        this.loop();
    }

    init() {
        if (this.preferWebGL) {
            this.tryInitWebGL();
        }

        if (!this.gl) {
            this.ctx2d = this.canvas.getContext('2d');
        }
    }

    tryInitWebGL() {
        const gl = this.canvas.getContext('webgl2');
        if (!gl) return;

        const vsSource = `#version 300 es
        in vec2 a_position;
        out vec2 v_uv;
        void main() {
            v_uv = (a_position + 1.0) * 0.5;
            gl_Position = vec4(a_position, 0.0, 1.0);
        }`;

        const fsSource = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        uniform sampler2D u_texture;
        out vec4 outColor;
        void main() {
            outColor = texture(u_texture, v_uv);
        }`;

        const program = this.createProgram(gl, vsSource, fsSource);
        if (!program) return;

        const quad = new Float32Array([
            -1, -1,
            1, -1,
            -1, 1,
            1, 1
        ]);

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

        const posLoc = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        this.gl = gl;
        this.program = program;
        this.vao = vao;
        this.texture = texture;
    }

    isDrawable(source) {
        if (!source) return false;
        if (source instanceof HTMLVideoElement) return source.readyState >= 2;
        if (source instanceof HTMLImageElement) return source.complete;
        if (source instanceof HTMLCanvasElement) return true;
        return false;
    }

    clear() {
        if (this.gl) {
            this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            this.gl.clearColor(0.02, 0.05, 0.09, 1.0);
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);
            return;
        }

        if (this.ctx2d) {
            this.ctx2d.fillStyle = '#0b1423';
            this.ctx2d.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }

    renderWebGL(source) {
        const gl = this.gl;

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

        const loc = gl.getUniformLocation(this.program, 'u_texture');
        gl.uniform1i(loc, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    render2D(source) {
        const ctx = this.ctx2d;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
    }

    loop = () => {
        const source = this.getSource ? this.getSource() : null;

        if (!this.isDrawable(source)) {
            this.clear();
        } else if (this.gl) {
            this.renderWebGL(source);
        } else if (this.ctx2d) {
            this.render2D(source);
        }

        this.rafId = requestAnimationFrame(this.loop);
    };

    createShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    createProgram(gl, vsSource, fsSource) {
        const vs = this.createShader(gl, gl.VERTEX_SHADER, vsSource);
        const fs = this.createShader(gl, gl.FRAGMENT_SHADER, fsSource);
        if (!vs || !fs) return null;

        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            gl.deleteProgram(program);
            return null;
        }

        return program;
    }

    destroy() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }
}

