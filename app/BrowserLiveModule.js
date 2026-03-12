export class BrowserLiveModule {
    constructor(frameElement, titleElement) {
        this.frameElement = frameElement;
        this.titleElement = titleElement;
        this.sourceIntervals = new Map();
    }

    createBrowserSource(url, title = 'Browser') {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');

        const draw = () => {
            const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            grad.addColorStop(0, '#0a1b2e');
            grad.addColorStop(1, '#0f3046');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.fillStyle = '#22d3ee';
            ctx.font = 'bold 64px Segoe UI';
            ctx.fillText('Browser Source', 70, 180);

            ctx.fillStyle = '#e2e8f0';
            ctx.font = '32px Segoe UI';
            ctx.fillText(title, 70, 250);
            ctx.fillText(url, 70, 300);

            ctx.fillStyle = '#94a3b8';
            ctx.font = '28px Segoe UI';
            ctx.fillText(`Live heartbeat: ${new Date().toLocaleTimeString()}`, 70, 380);
        };

        draw();
        const intervalId = setInterval(draw, 1000);
        this.sourceIntervals.set(canvas, intervalId);

        return {
            element: canvas,
            url
        };
    }

    releaseSource(canvas) {
        const intervalId = this.sourceIntervals.get(canvas);
        if (!intervalId) return;
        clearInterval(intervalId);
        this.sourceIntervals.delete(canvas);
    }

    showSource(source) {
        if (!source || source.type !== 'browser' || !source.browserUrl) {
            this.frameElement.src = 'about:blank';
            this.titleElement.textContent = 'No browser source selected';
            return;
        }

        this.frameElement.src = source.browserUrl;
        this.titleElement.textContent = source.browserUrl;
    }
}

