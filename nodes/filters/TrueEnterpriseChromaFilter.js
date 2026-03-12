// src/nodes/filters/TrueEnterpriseChromaFilter.js

import { BaseFilter } from './BaseFilter.js';

export class TrueEnterpriseChromaFilter extends BaseFilter {

    constructor() {
        super();

        // Broadcast-style professional parameters
        this.params = {

            // Key color (default green)
            keyColor: [0.0, 1.0, 0.0],

            // Dual threshold
            thresholdLow: 0.25,
            thresholdHigh: 0.45,

            // Spill suppression
            spill: 0.5
        };
    }

    init(backend) {

        const vsSource = backend.fullscreenVS;

        // =========================================
        // TRUE ENTERPRISE SHADER
        // YCbCr + Dual Threshold
        // =========================================

        const fsSource = `#version 300 es
        precision highp float;

        in vec2 v_uv;

        uniform sampler2D u_foreground;
        uniform sampler2D u_background;

        uniform vec3 u_keyColor;
        uniform float u_thresholdLow;
        uniform float u_thresholdHigh;
        uniform float u_spill;

        out vec4 outColor;

        // Convert RGB to YCbCr (broadcast color space)
        vec3 rgb2ycbcr(vec3 c) {

            float y  =  0.299*c.r + 0.587*c.g + 0.114*c.b;
            float cb = -0.168736*c.r - 0.331264*c.g + 0.5*c.b + 0.5;
            float cr =  0.5*c.r - 0.418688*c.g - 0.081312*c.b + 0.5;

            return vec3(y, cb, cr);
        }

        void main() {

            vec4 fg = texture(u_foreground, v_uv);
            vec4 bg = texture(u_background, v_uv);

            // Convert both colors to YCbCr
            vec3 fgYCbCr = rgb2ycbcr(fg.rgb);
            vec3 keyYCbCr = rgb2ycbcr(u_keyColor);

            // Measure chroma difference only (CbCr channels)
            float chromaDistance = distance(
                fgYCbCr.yz,
                keyYCbCr.yz
            );

            // Dual threshold matte
            float alpha;

            if (chromaDistance < u_thresholdLow) {
                alpha = 0.0;     // Fully transparent
            }
            else if (chromaDistance > u_thresholdHigh) {
                alpha = 1.0;     // Fully opaque
            }
            else {
                alpha = smoothstep(
                    u_thresholdLow,
                    u_thresholdHigh,
                    chromaDistance
                );
            }

            // Spill suppression (reduce green contamination)
            float spillAmount = clamp(
                (fg.g - max(fg.r, fg.b)) * u_spill,
                0.0,
                1.0
            );

            vec3 color = fg.rgb;
            color.g -= spillAmount * 0.5;

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
                u_thresholdLow: this.params.thresholdLow,
                u_thresholdHigh: this.params.thresholdHigh,
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