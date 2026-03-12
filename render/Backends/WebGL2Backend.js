import { RenderBackend } from '../RenderBackend.js';

export class WebGL2Backend extends RenderBackend {

    async init(canvas) {

        this.canvas = canvas;
        this.gl = canvas.getContext("webgl2");

        if (!this.gl) {
            throw new Error("WebGL2 not supported");
        }

        const gl = this.gl;

        this.type = "webgl2";
        this.supportsShaders = true;

        // =====================================================
        // FULLSCREEN QUAD SHADER
        // =====================================================

        const vsSource = `#version 300 es
        in vec2 a_position;
        out vec2 v_uv;
        void main() {
            v_uv = (a_position + 1.0) * 0.5;
            gl_Position = vec4(a_position, 0.0, 1.0);
        }`;

        this.fullscreenVS = vsSource;

        const fsSource = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        uniform sampler2D u_texture;
        out vec4 outColor;
        void main() {
            outColor = texture(u_texture, v_uv);
        }`;

        this.copyProgram = this.createProgram(vsSource, fsSource);

        // =====================================================
        // FULLSCREEN QUAD GEOMETRY
        // =====================================================

        const quad = new Float32Array([
            -1, -1,
             1, -1,
            -1,  1,
             1,  1
        ]);

        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);

        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

        const posLoc = gl.getAttribLocation(this.copyProgram, "a_position");
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        // =====================================================
        // RENDER TARGETS
        // =====================================================

        this.renderTarget   = this.createRenderTarget(canvas.width, canvas.height);
        this.renderTargetB  = this.createRenderTarget(canvas.width, canvas.height);
        this.filterTarget   = this.createRenderTarget(canvas.width, canvas.height);

        gl.clearColor(0, 0, 0, 1);
    }

    // =====================================================
    // CREATE FRAMEBUFFER + TEXTURE
    // =====================================================

    createRenderTarget(width, height) {

        const gl = this.gl;

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);

        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            width,
            height,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            null
        );

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

        gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            texture,
            0
        );

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        return { texture, framebuffer, width, height };
    }

    // =====================================================
    // UPLOAD VIDEO INTO RENDER TARGET
    // =====================================================

    isDrawable(source) {
        if (!source) return false;
        if (source instanceof HTMLVideoElement) return source.readyState >= 2;
        if (source instanceof HTMLImageElement) return source.complete;
        if (source instanceof HTMLCanvasElement) return true;
        return false;
    }

    drawVideo(source, target) {

        const gl = this.gl;
        if (!this.isDrawable(source)) return null;

        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.viewport(0, 0, target.width, target.height);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // Create upload texture if needed
        if (!target.uploadTexture) {

            target.uploadTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, target.uploadTexture);

            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        } else {

            gl.bindTexture(gl.TEXTURE_2D, target.uploadTexture);
        }

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            source
        );

        gl.useProgram(this.copyProgram);
        gl.bindVertexArray(this.vao);

        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(
            gl.getUniformLocation(this.copyProgram, "u_texture"),
            0
        );

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        return target;
    }

    // =====================================================
    // DRAW TARGET TO SCREEN
    // =====================================================

    blitToScreen(target) {

        const gl = this.gl;

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);

        this.runFullscreenShader(
            this.copyProgram,
            {},
            { u_texture: target.texture },
            null
        );
    }

    // =====================================================
    // GENERIC FULLSCREEN PASS
    // =====================================================

    runFullscreenShader(program, uniforms, textures, target) {

        const gl = this.gl;

        if (target) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
            gl.viewport(0, 0, target.width, target.height);
        } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        }

        gl.useProgram(program);
        gl.bindVertexArray(this.vao);

        let textureUnit = 0;

        for (const name in textures) {
            const location = gl.getUniformLocation(program, name);
            gl.activeTexture(gl.TEXTURE0 + textureUnit);
            gl.bindTexture(gl.TEXTURE_2D, textures[name]);
            gl.uniform1i(location, textureUnit);
            textureUnit++;
        }

        for (const name in uniforms) {
            const location = gl.getUniformLocation(program, name);
            const value = uniforms[name];

            if (typeof value === "number") {
                gl.uniform1f(location, value);
            } else if (value.length === 3) {
                gl.uniform3fv(location, value);
            }
        }

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // =====================================================
    // SHADER UTILITIES
    // =====================================================

    createShader(type, source) {

        const gl = this.gl;
        const shader = gl.createShader(type);

        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    createProgram(vsSource, fsSource) {

        const gl = this.gl;

        const vs = this.createShader(gl.VERTEX_SHADER, vsSource);
        const fs = this.createShader(gl.FRAGMENT_SHADER, fsSource);

        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error(gl.getProgramInfoLog(program));
            return null;
        }

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        return program;
    }

    async destroy() {
        if (!this.gl) return;

        const gl = this.gl;

        if (this.copyProgram) gl.deleteProgram(this.copyProgram);
        if (this.vao) gl.deleteVertexArray(this.vao);

        const releaseTarget = target => {
            if (!target) return;
            if (target.texture) gl.deleteTexture(target.texture);
            if (target.uploadTexture) gl.deleteTexture(target.uploadTexture);
            if (target.framebuffer) gl.deleteFramebuffer(target.framebuffer);
        };

        releaseTarget(this.renderTarget);
        releaseTarget(this.renderTargetB);
        releaseTarget(this.filterTarget);

        this.gl = null;
    }
}
