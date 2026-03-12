// src/nodes/filters/AdvancedChromaFilter.js

import { BaseFilter } from './BaseFilter.js';

export class AdvancedChromaFilter extends BaseFilter {

    constructor() {
        super();

        // Professional parameters
        this.params = {
            keyColor: [0.0, 1.0, 0.0],   // default green
            similarity: 0.18,           // chroma distance threshold
            smoothness: 0.10,           // soft edge range
            spill: 0.5                  // spill reduction strength
        };
    }

    init(backend) {

        // Reuse fullscreen vertex shader from backend
        const vsSource = backend.fullscreenVS;

        // ================================
        // YCbCr BASED CHROMA KEY SHADER
        // ================================

        const fsSource = `#version 300 es
        precision highp float;

        in vec2 v_uv;

        // Foreground and background textures
        uniform sampler2D u_foreground;
        uniform sampler2D u_background;

        // Chroma parameters
        uniform vec3 u_keyColor;
        uniform float u_similarity;
        uniform float u_smoothness;
        uniform float u_spill;

        out vec4 outColor;

        // Convert RGB to YCbCr
        vec3 rgb2ycbcr(vec3 c) {

            float y  =  0.299*c.r + 0.587*c.g + 0.114*c.b;
            float cb = -0.168736*c.r - 0.331264*c.g + 0.5*c.b + 0.5;
            float cr =  0.5*c.r - 0.418688*c.g - 0.081312*c.b + 0.5;

            return vec3(y, cb, cr);
        }

        void main() {

            vec4 fg = texture(u_foreground, v_uv);
            vec4 bg = texture(u_background, v_uv);

            // Convert both to YCbCr
            vec3 fgYCbCr = rgb2ycbcr(fg.rgb);
            vec3 keyYCbCr = rgb2ycbcr(u_keyColor);

            // Compare only chroma channels (CbCr)
            float chromaDistance = distance(
                fgYCbCr.yz,
                keyYCbCr.yz
            );

            // Matte creation
            float alpha = smoothstep(
                u_similarity,
                u_similarity + u_smoothness,
                chromaDistance
            );

            // Spill suppression based on green dominance
            float spill = clamp(
                (fg.g - max(fg.r, fg.b)) * u_spill,
                0.0,
                1.0
            );

            vec3 color = fg.rgb;
            color.g -= spill * 0.5;

            // Final composite
            vec3 finalColor = mix(bg.rgb, color, alpha);

            outColor = vec4(finalColor, 1.0);
        }`;

        this.program = backend.createProgram(vsSource, fsSource);
    }

    apply(backend, inputTarget, backgroundTarget) {

        if (!inputTarget || !backgroundTarget)
            return inputTarget;

        let outputTarget = backend.filterTarget;

        if (outputTarget === inputTarget) {
            outputTarget = backend.renderTargetB;
        }

        backend.runFullscreenShader(
            this.program,
            {
                u_keyColor: this.params.keyColor,
                u_similarity: this.params.similarity,
                u_smoothness: this.params.smoothness,
                u_spill: this.params.spill
            },
            {
                u_foreground: inputTarget.texture,
                u_background: backgroundTarget.texture
            },
            outputTarget
        );

        return outputTarget;
    }
}