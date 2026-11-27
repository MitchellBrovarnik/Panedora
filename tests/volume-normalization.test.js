const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const worklet = fs.readFileSync(path.join(__dirname, '..', 'loudness-worklet.js'), 'utf8');
const visualizer = fs.readFileSync(path.join(__dirname, '..', 'visualizer.js'), 'utf8');

function meterAt(rate) {
    let Processor;
    class Worklet {
        constructor() {
            this.messages = [];
            this.port = { postMessage: value => this.messages.push(value) };
        }
    }
    vm.runInNewContext(worklet, { AudioWorkletProcessor: Worklet, sampleRate: rate,
        registerProcessor: (_name, ctor) => { Processor = ctor; } });
    const meter = new Processor();
    meter.port.onmessage({ data: { type: 'reset', epoch: 1 } });
    return meter;
}

function feed(meter, rate, seconds, amplitude, from = 0) {
    const samples = new Float32Array(128);
    const silentOutput = new Float32Array(128);
    for (let i = 0; i < rate * seconds; i += samples.length) {
        for (let j = 0; j < samples.length; j++) {
            const time = from + (i + j) / rate;
            samples[j] = (typeof amplitude === 'function' ? amplitude(time) : amplitude) * Math.sin(2 * Math.PI * 997 * time);
        }
        meter.process([[samples, samples]], [[silentOutput]]);
    }
    assert.ok(silentOutput.every(value => value === 0), 'meter sidechain is silent');
}

for (const rate of [44100, 48000]) {
    test('K-weighted loudness and bounded attenuation at ' + rate + ' Hz', () => {
        const loud = meterAt(rate);
        feed(loud, rate, 21, 0.5);
        const last = loud.messages.at(-1);
        // 997 Hz dual-mono tone: BS.1770 calibration; FFmpeg ebur128 reports -6.0 LUFS.
        assert.ok(Math.abs(last.measured - (-6.0206)) < 0.05);
        assert.ok(Math.abs(last.measured + 20 * Math.log10(last.gain) - (-16)) < 0.05);
        assert.ok(loud.messages.every(message => message.gain <= 1 && message.gain >= 10 ** (-18 / 20)));
        feed(loud, rate, 5, 1);
        assert.ok(loud.messages.at(-1).gain < last.gain, 'meter still responds to louder audio later in the song');

        const quiet = meterAt(rate);
        feed(quiet, rate, 21, 0.1);
        assert.ok(Math.abs(quiet.messages.at(-1).measured - (-20)) < 0.05);
        assert.ok(quiet.messages.every(message => message.gain === 1), 'never boosts a quiet master');
    });
}

test('a sustained loud opening gets a bounded correction in about 800 ms on each track', () => {
    const rate = 48000, meter = meterAt(rate);
    for (const epoch of [1, 2]) {
        meter.port.onmessage({ data: { type: 'reset', epoch } });
        meter.messages.length = 0;
        feed(meter, rate, 0.75, 0.5);
        assert.equal(meter.messages.length, 0);
        feed(meter, rate, 0.1, 0.5, 0.75);
        assert.equal(meter.messages.length, 1);
        assert.equal(meter.messages[0].epoch, epoch);
        assert.equal(meter.messages[0].provisional, true);
        assert.ok(Math.abs(20 * Math.log10(meter.messages[0].gain) + 6) < 0.01);
        feed(meter, rate, 2.25, 0.5, 0.85);
        const full = meter.messages.at(-1);
        assert.equal(meter.messages.filter(message => message.provisional).length, 1);
        assert.ok(Math.abs(full.measured + 20 * Math.log10(full.gain) - (-16)) < 0.05);
    }
});

test('a quiet opening and a short loud burst leave the early gain untouched', () => {
    const rate = 48000;
    for (const amplitude of [0.1, t => t >= 0.34 && t < 0.46 ? 0.9 : 0.1]) {
        const meter = meterAt(rate);
        feed(meter, rate, 2, amplitude);
        assert.equal(meter.messages.length, 0);
    }
});

test('after an early seek, buffering silence holds the cut and quiet audio releases it', () => {
    const rate = 48000, meter = meterAt(rate);
    meter.port.onmessage({ data: { type: 'reset', epoch: 2, afterSeek: true } });
    feed(meter, rate, 1.2, 0);
    assert.equal(meter.messages.length, 0);
    feed(meter, rate, 0.85, 0.1, 31);
    assert.equal(meter.messages.length, 1);
    assert.equal(meter.messages[0].epoch, 2);
    assert.equal(meter.messages[0].provisional, true);
    assert.equal(meter.messages[0].gain, 1);
});

test('the full estimate can release a provisional cut when the opening settles down', () => {
    const rate = 48000, meter = meterAt(rate);
    feed(meter, rate, 3.1, t => t < 0.8 ? 0.24 : 0.14);
    assert.equal(meter.messages[0]?.provisional, true);
    assert.ok(meter.messages.at(-1).gain > meter.messages[0].gain);
});

test('a long quiet intro cannot freeze normalization before the loud section', () => {
    const rate = 48000, meter = meterAt(rate);
    feed(meter, rate, 22, 0.1);
    assert.ok(meter.messages.length > 0);
    assert.ok(meter.messages.every(message => message.gain === 1));
    feed(meter, rate, 6, 0.5, 22);
    const loud = meter.messages.at(-1);
    assert.ok(Math.abs(loud.measured + 20 * Math.log10(loud.gain) - (-16)) < 0.05);
    assert.ok(loud.gain < 0.35);
    assert.ok(meter.blocks.length <= 100, 'meter keeps a bounded measurement window');
});

test('silence does not produce a gain estimate, and quieter passages cannot pump gain up', () => {
    const rate = 48000, meter = meterAt(rate);
    feed(meter, rate, 5, 0);
    assert.equal(meter.messages.length, 0);
    feed(meter, rate, 12, t => t < 6 ? 0.5 : 0.03);
    assert.ok(meter.messages.length > 0);
    assert.ok(meter.messages.every((m, i, a) => i === 0 || m.gain <= a[i-1].gain));
    meter.port.onmessage({ data: { type: 'reset', epoch: 2 } });
    meter.messages.length = 0;
    feed(meter, rate, 4, 0.1);
    assert.ok(meter.messages.length > 0);
    assert.ok(meter.messages.every(m => m.epoch === 2 && m.gain === 1), 'new track starts with independent gain');
});

function audioHarness({ fail = false } = {}) {
    class Node {
        constructor() { this.connections = new Set(); }
        connect(node) { this.connections.add(node); }
        disconnect(node) { if (node) this.connections.delete(node); else this.connections.clear(); }
    }
    class Meter extends Node {
        constructor() { super(); this.port = { postMessage: m => { this.last = m; }, close() {} }; }
    }
    function gain() {
        const node = new Node();
        node.gain = { value: 1, cancelScheduledValues() {},
            setValueAtTime(value) { this.value = value; },
            setTargetAtTime(value, _time, timeConstant) { this.value = value; this.timeConstant = timeConstant; } };
        return node;
    }
    class AudioContext {
        constructor() {
            this.destination = new Node(); this.currentTime = 0;
            this.audioWorklet = { addModule: async () => { if (fail) throw new Error('unavailable'); } };
        }
        createAnalyser() { return new Node(); }
        createMediaElementSource() { return new Node(); }
        createGain() { return gain(); }
    }
    const window = { AudioContext, dispatchEvent() {} };
    vm.runInNewContext(visualizer, { window, AudioWorkletNode: Meter, Event: class {}, URL,
        document: { baseURI: 'file:///app/index.html' }, console: { log() {}, warn() {}, error() {} } });
    return window.visualizer;
}

test('gain stages are independent, off is unity, and stale track messages are ignored', async () => {
    const v = audioHarness();
    const audio = { volume: 0.4 };
    v.init(audio);
    assert.equal(v.gainNode.gain.value, 0.4);
    assert.equal(audio.volume, 1);
    assert.equal(v.normalizationGain.gain.value, 1);
    assert.equal(v.normalizationMeter, null);
    v.setNormalizationTrack('a');
    v.setNormalizationEnabled(true);
    await v.normalizationModule;
    // The VM continuation runs after the host-realm module promise settles.
    await new Promise(setImmediate);
    const meter = v.normalizationMeter;
    assert.ok(meter);
    assert.ok(v.source.connections.has(meter));
    meter.port.onmessage({ data: { epoch: v.normalizationEpoch, gain: 0.25 } });
    assert.equal(v.normalizationGain.gain.value, 0.25);
    assert.equal(v.normalizationGain.gain.timeConstant, 0.6);
    v.setVolume(0);
    assert.equal(v.gainNode.gain.value, 0, 'mute remains mute');
    assert.equal(v.normalizationGain.gain.value, 0.25);
    const epoch = v.normalizationEpoch;
    v.setNormalizationTrack('a');
    assert.equal(v.normalizationGain.gain.value, 0.25, 'same-track recovery retains gain');
    v.setNormalizationTrack('b');
    assert.equal(v.normalizationGain.gain.value, 1);
    meter.port.onmessage({ data: { epoch, gain: 0.5, provisional: true } });
    assert.equal(v.normalizationGain.gain.value, 1);
    meter.port.onmessage({ data: { epoch: v.normalizationEpoch, gain: 2 } });
    assert.equal(v.normalizationGain.gain.value, 1, 'reject amplification');
    meter.port.onmessage({ data: { epoch: v.normalizationEpoch, gain: 0.5, provisional: true } });
    assert.equal(v.normalizationGain.gain.value, 0.5);
    assert.equal(v.normalizationGain.gain.timeConstant, 0.15);
    v.setNormalizationEnabled(false);
    assert.equal(v.normalizationGain.gain.value, 1);
    assert.equal(v.gainNode.gain.value, 0);
    assert.equal(v.normalizationMeter, null);
    assert.equal(v.source.connections.has(meter), false);
});

test('worklet load failure fails open without disturbing original volume', async () => {
    const v = audioHarness({ fail: true });
    v.init({ volume: 0.3 });
    v.setNormalizationTrack('a');
    v.setNormalizationEnabled(true);
    await v.normalizationModule.catch(() => {});
    await new Promise(setImmediate);
    assert.match(v.normalizationError, /unavailable/);
    assert.equal(v.normalizationGain.gain.value, 1);
    assert.equal(v.gainNode.gain.value, 0.3);
});

test('a seek before the full estimate applies temporary attenuation and restarts measurement', async () => {
    const v = audioHarness();
    v.setNormalizationTrack('track');
    v.setNormalizationEnabled(true);
    v.init({ volume: 0.3 });
    await v.normalizationModule;
    await new Promise(setImmediate);
    const meter = v.normalizationMeter;
    const previousEpoch = v.normalizationEpoch;

    v.beginNormalizationSeek();
    assert.ok(Math.abs(20 * Math.log10(v.normalizationGain.gain.value) + 6) < 0.01);
    assert.equal(meter.last.epoch, null, 'pre-seek audio is no longer measured');
    meter.port.onmessage({ data: { epoch: previousEpoch, gain: 1 } });
    assert.ok(v.normalizationGain.gain.value < 0.51, 'an in-flight estimate cannot cancel the cut');
    v.finishNormalizationSeek();
    const seekEpoch = v.normalizationEpoch;
    assert.equal(meter.last.epoch, seekEpoch);
    assert.equal(meter.last.afterSeek, true);
    meter.port.onmessage({ data: { epoch: seekEpoch, gain: 1, provisional: true } });
    assert.equal(v.normalizationGain.gain.value, 1, 'quiet audio lifts the temporary attenuation');
    meter.port.onmessage({ data: { epoch: seekEpoch, gain: 0.8 } });
    v.beginNormalizationSeek();
    v.finishNormalizationSeek();
    assert.equal(v.normalizationEpoch, seekEpoch);
    assert.equal(v.normalizationGain.gain.value, 0.8, 'an established gain is retained across a seek');
    assert.equal(v.gainNode.gain.value, 0.3);
});
