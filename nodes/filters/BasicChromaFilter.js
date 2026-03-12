// src/nodes/filters/ChromaFilter.js

import { BaseFilter } from './BaseFilter.js';

export class ChromaFilter extends BaseFilter {

    constructor() {
        super();

        this.params = {
            keyColor: [0.0, 1.0, 0.0],
            similarity: 0.35,
            smoothness: 0.15,
            spill: 0.6
        };
    }

    init(backend) {

        const vsSource = backend.fullscreenVS;

        const fsSource = `#version 300 es
precision highp float;

in vec2 v_uv;

uniform sampler2D u_foreground;
uniform sampler2D u_background;

uniform vec3 u_keyColor;
uniform float u_similarity;
uniform float u_smoothness;
uniform float u_spill;

out vec4 outColor;

void main() {

    vec4 fg = texture(u_foreground, v_uv);
    vec4 bg = texture(u_background, v_uv);

    // Distance from key color
    float diff = distance(fg.rgb, u_keyColor);

    // GREEN AREA (close to key) → alpha = 0
    // SUBJECT (far from key) → alpha = 1
    float alpha = smoothstep(
        u_similarity,
        u_similarity + u_smoothness,
        diff
    );

    // Spill suppression
    float spill = clamp(
        (fg.g - max(fg.r, fg.b)) * u_spill,
        0.0,
        1.0
    );

    vec3 color = fg.rgb;
    color.g -= spill * 0.5;

    // Composite
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
            this.program, {
            u_keyColor: this.params.keyColor,
            u_similarity: this.params.similarity,
            u_smoothness: this.params.smoothness,
            u_spill: this.params.spill
        }, {
            u_foreground: inputTarget.texture,
            u_background: backgroundTarget.texture
        },
            outputTarget);

        return outputTarget;
    }
}