'use strict';

// Stereo K-weighted, gated loudness estimate based on ITU-R BS.1770.
// https://www.itu.int/rec/R-REC-BS.1770
// The first 20 seconds of non-silent measurement are used, not the full song.
// Never amplify: without a full-track true-peak scan, future peaks are unknown.
const TARGET_LUFS = -18;
const MIN_GAIN_DB = -18;
const ABS_GATE = 10 ** ((-70 + 0.691) / 10);
const loudness = energy => -0.691 + 10 * Math.log10(energy);

function coefficients(rate) {
    let k = Math.tan(Math.PI * 1681.974450955533 / rate);
    let q = 0.7071752369554196;
    const vh = 10 ** (3.999843853973347 / 20);
    const vb = vh ** 0.4996667741545416;
    let a = 1 + k / q + k * k;
    const shelf = [(vh + vb * k / q + k * k) / a, 2 * (k * k - vh) / a,
        (vh - vb * k / q + k * k) / a, 2 * (k * k - 1) / a, (1 - k / q + k * k) / a];
    k = Math.tan(Math.PI * 38.13547087602444 / rate);
    q = 0.5003270373238773;
    a = 1 + k / q + k * k;
    return [shelf, [1, -2, 1, 2 * (k * k - 1) / a, (1 - k / q + k * k) / a]];
}

class Biquad {
    constructor(c) { this.c = c; this.z1 = 0; this.z2 = 0; }
    sample(x) {
        const c = this.c;
        const y = c[0] * x + this.z1;
        this.z1 = c[1] * x - c[3] * y + this.z2;
        this.z2 = c[2] * x - c[4] * y;
        return y;
    }
}

function gatedEnergy(blocks) {
    if (!blocks.length) return 0;
    const mean = blocks.reduce((sum, block) => sum + block, 0) / blocks.length;
    const gate = Math.max(ABS_GATE, mean * 0.1);
    let sum = 0, count = 0;
    for (const block of blocks) {
        if (block >= gate) { sum += block; count++; }
    }
    return count ? sum / count : 0;
}

class PanedoraLoudnessMeter extends AudioWorkletProcessor {
    constructor() {
        super();
        this.hop = Math.round(sampleRate / 10);
        this.coefficients = coefficients(sampleRate);
        this.reset(null);
        this.port.onmessage = ({ data }) => {
            if (data?.type === 'reset') this.reset(data.epoch);
        };
    }
    reset(epoch) {
        this.epoch = epoch;
        this.filters = Array.from({ length: 2 }, () => this.coefficients.map(c => new Biquad(c)));
        this.hops = new Float64Array(4);
        this.hopIndex = 0;
        this.hopCount = 0;
        this.frames = 0;
        this.energy = 0;
        this.blocks = [];
        this.gainDb = 0;
        this.done = epoch === null;
    }
    process(inputs) {
        // Sidechain only: the untouched, zero-filled output is never audible.
        const channels = inputs[0];
        if (this.done || !channels?.length || !channels[0]?.length) return true;
        const left = channels[0], right = channels[1] || left;
        const l = this.filters[0], r = this.filters[1];
        for (let i = 0; i < left.length; i++) {
            const a = l[1].sample(l[0].sample(left[i]));
            const b = r[1].sample(r[0].sample(right[i]));
            this.energy += a * a + b * b;
            if (++this.frames !== this.hop) continue;
            this.hops[this.hopIndex] = this.energy / this.hop;
            this.hopIndex = (this.hopIndex + 1) % 4;
            this.frames = 0;
            this.energy = 0;
            if (++this.hopCount < 4) continue;
            const block = (this.hops[0] + this.hops[1] + this.hops[2] + this.hops[3]) / 4;
            if (!Number.isFinite(block) || block < ABS_GATE) continue;
            this.blocks.push(block);
            const n = this.blocks.length;
            // Require ~3 seconds of gated audio; update once per second.
            // Only decrease gain while learning, so quiet passages cannot pump it back up.
            if (n >= 27 && (n === 27 || n % 10 === 0)) {
                const measured = loudness(gatedEnergy(this.blocks));
                this.gainDb = Math.min(this.gainDb, Math.max(MIN_GAIN_DB, Math.min(0, TARGET_LUFS - measured)));
                this.done = n >= 200;
                this.port.postMessage({ epoch: this.epoch, measured, gain: 10 ** (this.gainDb / 20), done: this.done });
                if (this.done) break;
            }
        }
        return true;
    }
}

registerProcessor('panedora-loudness-meter', PanedoraLoudnessMeter);
