/**
 * Pandora Glass - Audio Visualizer
 * Uses Web Audio API to create a live, reactive canvas background
 */

class AudioVisualizer {
    constructor() {
        this.audioContext = null;
        this.analyser = null;
        this.source = null;
        this.canvas = null;
        this.ctx = null;
        this.gainNode = null;
        this.isVisualizing = false;
        this.animationId = null;
        this.previousWaveHeights = null; // Used for ultra-smooth lerping on the wave visualizer 

        // Use 128 bins for a clean, chunky visualizer
        this.fftSize = 256;

        this.draw = this.draw.bind(this);
    }

    /**
     * Initializes the Web Audio API context.
     * Must be called AFTER the user has interacted with the page to bypass autoplay policies,
     * and MUST only be called once per `<audio>` element.
     */
    init(audioElement) {
        if (this.audioContext) return; // Already initialized

        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = this.fftSize;
            this.analyser.smoothingTimeConstant = 0.88; // Increased smoothing for less jumpiness

            // Important: Handle cross-origin audio data
            audioElement.crossOrigin = "anonymous";

            this.source = this.audioContext.createMediaElementSource(audioElement);
            this.gainNode = this.audioContext.createGain();

            // Set the gain to whatever volume the element is currently at
            this.gainNode.gain.value = audioElement.volume;

            // Route audio: Source -> Analyser -> Gain -> Destination
            this.source.connect(this.analyser);
            this.analyser.connect(this.gainNode);
            this.gainNode.connect(this.audioContext.destination);

            // Force internal element to max volume so the analyser gets the full signal range
            audioElement.volume = 1.0;

            console.log("[Visualizer] AudioContext initialized and connected.");
        } catch (error) {
            console.error("[Visualizer] Failed to initialize AudioContext:", error);
        }
    }

    start(canvasElement, style = 'bars') {
        if (!this.audioContext) {
            console.warn("[Visualizer] Cannot start, AudioContext not initialized yet.");
            return;
        }

        this.canvas = canvasElement;
        this.ctx = this.canvas.getContext('2d');
        this.setStyle(style);
        this.isVisualizing = true;

        // Handle resizing
        this.resize();
        this._resizeHandler = () => this.resize();
        window.addEventListener('resize', this._resizeHandler);

        // Resume context if suspended (browser autoplay policy)
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        this.draw();
        console.log(`[Visualizer] Started rendering style: ${this.style}`);
    }

    setStyle(style) {
        this.style = style;

        // Optimize resolution based on style
        if (this.analyser) {
            if (style === 'wave') {
                this.analyser.fftSize = 512; // need more data points for smooth line
            } else if (style === 'circle') {
                this.analyser.fftSize = 256;
            } else {
                this.analyser.fftSize = 256; // bars
            }
        }
    }

    stop() {
        this.isVisualizing = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }

        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }
    }

    setVolume(volume) {
        if (this.gainNode) {
            // Web Audio API expects volume from 0.0 to 1.0
            this.gainNode.gain.value = volume;
        }
    }

    resize() {
        if (!this.canvas) return;
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    draw() {
        if (!this.isVisualizing || !this.analyser || !this.ctx || !this.canvas) return;

        this.animationId = requestAnimationFrame(this.draw);

        const width = this.canvas.width;
        const height = this.canvas.height;
        let bufferLength;

        // For Wave, we need Time Domain data (waveform). For others, Frequency Data (EQ).
        if (this.style === 'wave') {
            bufferLength = this.analyser.fftSize;
            this.dataArray = new Uint8Array(bufferLength);
            this.analyser.getByteTimeDomainData(this.dataArray);
        } else {
            bufferLength = this.analyser.frequencyBinCount;
            this.dataArray = new Uint8Array(bufferLength);
            this.analyser.getByteFrequencyData(this.dataArray);
        }

        // Clear the canvas cleanly
        this.ctx.clearRect(0, 0, width, height);

        const computedStyle = getComputedStyle(document.documentElement);
        const accentColor = computedStyle.getPropertyValue('--accent').trim() || '#7c5bf5';
        const glowColor = computedStyle.getPropertyValue('--accent-glow').trim() || accentColor;

        if (this.style === 'bars') {
            this.drawBars(bufferLength, width, height, accentColor);
        } else if (this.style === 'circle') {
            this.drawCircle(bufferLength, width, height, accentColor, glowColor);
        } else if (this.style === 'wave') {
            this.drawWave(bufferLength, width, height, accentColor, glowColor);
        }
    }

    drawBars(bufferLength, width, height, accentColor) {
        const barWidth = (width / bufferLength) * 2.5;
        let x = 0;

        const isMini = document.body.classList.contains('mini-mode');
        // Normal mode can use 60% canvas height, mini mode peaks shorter at 50%
        const heightMultiplier = isMini ? 0.5 : 0.6;

        for (let i = 0; i < bufferLength; i++) {
            // Normalize audio data (0.0 to 1.0)
            const normalized = this.dataArray[i] / 255;
            // Soft exponential curve for punchy but less chaotic reactivity
            const enhanced = Math.pow(normalized, 1.2);

            const barHeight = enhanced * (height * heightMultiplier);

            const gradient = this.ctx.createLinearGradient(0, height - barHeight, 0, height);
            gradient.addColorStop(0, accentColor);
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(x, height - barHeight, barWidth - 1, barHeight);

            x += barWidth;
        }
    }

    drawCircle(bufferLength, width, height, accentColor, glowColor) {
        const centerX = width / 2;
        const centerY = height / 2;

        const isMini = document.body.classList.contains('mini-mode');
        const baseRadius = isMini ? Math.min(width, height) * 0.25 : Math.min(width, height) * 0.2;

        // Calculate average bass to pulse the entire circle's size
        let bassSum = 0;
        const bassCount = Math.min(10, bufferLength);
        for (let i = 0; i < bassCount; i++) {
            bassSum += this.dataArray[i];
        }
        const bassAvg = (bassSum / bassCount) / 255.0; // 0.0 to 1.0

        // Pulse base radius slightly based on bass
        const dynamicRadius = baseRadius + (Math.pow(bassAvg, 1.5) * baseRadius * 0.4);
        const maxRipple = isMini ? dynamicRadius * 0.8 : dynamicRadius * 0.6;

        this.ctx.lineWidth = isMini ? 2 : 3;
        this.ctx.strokeStyle = accentColor;
        this.ctx.shadowBlur = isMini ? 10 : 20;
        this.ctx.shadowColor = glowColor;

        // Optionally fill it with a soft glow
        this.ctx.fillStyle = glowColor.replace('0.3', '0.1').replace('0.4', '0.1');

        this.ctx.beginPath();

        const validDataLength = Math.floor(bufferLength * 0.7); // Discard the usually empty highest frequencies

        // Draw symmetrically
        for (let i = 0; i < validDataLength; i++) {
            const normalized = this.dataArray[i] / 255;
            // Very soft curve for smooth ripples
            const ripple = Math.pow(normalized, 1.8) * maxRipple;
            const r = dynamicRadius + ripple;

            // 0 to PI (Right half)
            const angle = (i / (validDataLength - 1)) * Math.PI - (Math.PI / 2);
            const x = centerX + Math.cos(angle) * r;
            const y = centerY + Math.sin(angle) * r;

            if (i === 0) this.ctx.moveTo(x, y);
            else this.ctx.lineTo(x, y);
        }

        for (let i = validDataLength - 1; i >= 0; i--) {
            const normalized = this.dataArray[i] / 255;
            const ripple = Math.pow(normalized, 1.8) * maxRipple;
            const r = dynamicRadius + ripple;

            // PI to 2PI (Left half)
            const angle = Math.PI + ((validDataLength - 1 - i) / (validDataLength - 1)) * Math.PI - (Math.PI / 2);
            const x = centerX + Math.cos(angle) * r;
            const y = centerY + Math.sin(angle) * r;

            this.ctx.lineTo(x, y);
        }

        this.ctx.closePath();
        this.ctx.fill();
        this.ctx.stroke();
        this.ctx.shadowBlur = 0;
    }

    drawWave(bufferLength, width, height, accentColor, glowColor) {
        this.ctx.lineWidth = 4;
        this.ctx.strokeStyle = accentColor;
        this.ctx.shadowBlur = 15;
        this.ctx.shadowColor = glowColor;

        this.ctx.beginPath();

        const sliceWidth = width / (bufferLength - 1);
        let x = 0;

        const isMini = document.body.classList.contains('mini-mode');
        // Visually limit the wave bounce. Time-domain PCM data gets very loud and jarring.
        const maxSwing = height * (isMini ? 0.15 : 0.08); // Even smaller now!

        // Massive 25-point moving average to completely iron out all static noise
        const smoothedData = new Float32Array(bufferLength);
        const windowSize = 25;

        for (let i = 0; i < bufferLength; i++) {
            let sum = 0;
            let count = 0;
            let start = Math.max(0, i - Math.floor(windowSize / 2));
            let end = Math.min(bufferLength - 1, i + Math.floor(windowSize / 2));
            for (let j = start; j <= end; j++) {
                sum += this.dataArray[j];
                count++;
            }
            smoothedData[i] = sum / count;
        }

        // Initialize state tracker for lerping if it doesn't exist or dimensions changed
        if (!this.previousWaveHeights || this.previousWaveHeights.length !== bufferLength) {
            this.previousWaveHeights = new Float32Array(bufferLength);
            for (let i = 0; i < bufferLength; i++) this.previousWaveHeights[i] = height / 2;
        }

        for (let i = 0; i < bufferLength; i++) {
            // Time domain data is 0-255, centered at 128
            const rawV = (smoothedData[i] - 128) / 128.0; // -1.0 to 1.0

            // Soft curve to keep quiet parts flat, and only bounce on loud kicks
            const v = Math.sign(rawV) * Math.pow(Math.abs(rawV), 1.6);

            // Target Y on the screen
            const targetY = (height / 2) + (v * maxSwing);

            // Lerp (Linear Interpolate) from the previous frame's Y position to forcibly slow the line down
            // 0.85 means keep 85% of old position, only move 15% towards new position per frame
            const lerpedY = (this.previousWaveHeights[i] * 0.85) + (targetY * 0.15);
            this.previousWaveHeights[i] = lerpedY;

            if (i === 0) {
                this.ctx.moveTo(x, lerpedY);
            } else {
                this.ctx.lineTo(x, lerpedY);
            }

            x += sliceWidth;
        }

        this.ctx.stroke();
        this.ctx.shadowBlur = 0;
    }
}

// Export a singleton instance
window.visualizer = new AudioVisualizer();
