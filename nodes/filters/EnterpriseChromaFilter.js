import { BaseFilter } from './BaseFilter.js';

export class EnterpriseChromaFilter extends BaseFilter {

    constructor() {
        super();

			this.params = {
				keyColor: [0.0, 1.0, 0.0],
				thresholdLow: 0.55,
				thresholdHigh: 0.85,
				spill: 0.5
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

        out vec4 outColor;

        void main() {

            vec4 fg = texture(u_foreground, v_uv);
            vec4 bg = texture(u_background, v_uv);

            float diff = distance(fg.rgb, u_keyColor);

            float alpha;

            if (diff < u_thresholdLow) {
                alpha = 0.0;
            } 
            else if (diff > u_thresholdHigh) {
                alpha = 1.0;
            } 
            else {
                alpha = smoothstep(
                    u_thresholdLow,
                    u_thresholdHigh,
                    diff
                );
            }

            float spill = clamp(
                (fg.g - max(fg.r, fg.b)) * u_spill,
                0.0,
                1.0
            );

            vec3 color = fg.rgb;
            color.g -= spill * 0.5;

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