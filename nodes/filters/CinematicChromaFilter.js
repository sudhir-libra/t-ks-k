// src/nodes/filters/CinematicChromaFilter.js

import { BaseFilter } from './BaseFilter.js';

export class CinematicChromaFilter extends BaseFilter {

    constructor() {
        super();

        this.params = {
            keyColor: [0.0, 1.0, 0.0],
            thresholdLow: 0.25,
            thresholdHigh: 0.45,
            spill: 0.5,
            edgeShrink: 0.02,
            edgeBlur: 0.005,

            // Cinematic parameter
            lightWrap: 0.4
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
        uniform float u_thresholdLow;
        uniform float u_thresholdHigh;
        uniform float u_spill;
        uniform float u_edgeShrink;
        uniform float u_edgeBlur;
        uniform float u_lightWrap;

        out vec4 outColor;

        vec3 rgb2ycbcr(vec3 c) {
            float y  =  0.299*c.r + 0.587*c.g + 0.114*c.b;
            float cb = -0.168736*c.r - 0.331264*c.g + 0.5*c.b + 0.5;
            float cr =  0.5*c.r - 0.418688*c.g - 0.081312*c.b + 0.5;
            return vec3(y, cb, cr);
        }

        void main() {

            vec4 fg = texture(u_foreground, v_uv);
            vec4 bg = texture(u_background, v_uv);

            vec3 fgYCbCr = rgb2ycbcr(fg.rgb);
            vec3 keyYCbCr = rgb2ycbcr(u_keyColor);

            float chromaDistance = distance(
                fgYCbCr.yz,
                keyYCbCr.yz
            );

            float alpha;

            if (chromaDistance < u_thresholdLow)
                alpha = 0.0;
            else if (chromaDistance > u_thresholdHigh)
                alpha = 1.0;
            else
                alpha = smoothstep(
                    u_thresholdLow,
                    u_thresholdHigh,
                    chromaDistance
                );

            // Edge refinement
            alpha = clamp(alpha - u_edgeShrink, 0.0, 1.0);
            alpha = smoothstep(0.0, u_edgeBlur + 0.001, alpha);

            // Spill suppression
            float spill = clamp(
                (fg.g - max(fg.r, fg.b)) * u_spill,
                0.0,
                1.0
            );

            vec3 color = fg.rgb;
            color.g -= spill * 0.5;

            // ============================
            // LIGHT WRAP (CINEMATIC)
            // ============================

            float edgeFactor = 1.0 - alpha;

            vec3 wrapped = mix(
                color,
                bg.rgb,
                edgeFactor * u_lightWrap
            );

            vec3 finalColor = mix(bg.rgb, wrapped, alpha);

            outColor = vec4(finalColor, 1.0);
        }`;

        this.program = backend.createProgram(vsSource, fsSource);
    }

    apply(backend, inputTarget, backgroundTarget) {

        if (!inputTarget || !backgroundTarget)
            return inputTarget;

        let outputTarget = backend.filterTarget;

        backend.runFullscreenShader(
            this.program,
            {
                u_keyColor: this.params.keyColor,
                u_thresholdLow: this.params.thresholdLow,
                u_thresholdHigh: this.params.thresholdHigh,
                u_spill: this.params.spill,
                u_edgeShrink: this.params.edgeShrink,
                u_edgeBlur: this.params.edgeBlur,
                u_lightWrap: this.params.lightWrap
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