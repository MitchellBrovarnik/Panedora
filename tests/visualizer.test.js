const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
    const frames = new Map();
    const resizeListeners = new Set();
    let nextFrame = 0;
    let clears = 0;
    const context = new Proxy({ clearRect() { clears++; } }, {
        get: (object, key) => object[key] || (() => ({ addColorStop() {} }))
    });
    const window = {
        innerWidth: 540, innerHeight: 80,
        addEventListener(name, listener) { if (name === 'resize') resizeListeners.add(listener); },
        removeEventListener(name, listener) { if (name === 'resize') resizeListeners.delete(listener); }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'visualizer.js'), 'utf8'), {
        window, document: { body: { classList: { contains: () => true } }, documentElement: {} },
        getComputedStyle: () => ({ getPropertyValue: () => '#789abc' }),
        requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
        cancelAnimationFrame: id => frames.delete(id),
        console: { log() {}, warn() {}, error() {} }
    });
    const visualizer = window.visualizer;
    visualizer.audioContext = { state: 'running' };
    visualizer.analyser = {
        fftSize: 256, get frequencyBinCount() { return this.fftSize / 2; },
        getByteFrequencyData: array => array.fill(128), getByteTimeDomainData: array => array.fill(128),
        getFloatFrequencyData: array => array.fill(-60)
    };
    return {
        visualizer, frames, resizeListeners, window,
        canvas: () => ({ width: 540, height: 80, getContext: () => context }),
        frame() {
            const callbacks = [...frames.values()];
            frames.clear();
            const before = clears;
            callbacks.forEach(callback => callback());
            return clears - before;
        }
    };
}

test('reactive backgrounds keep one animation loop and resize listener across song starts', () => {
    for (const style of ['bars', 'circle', 'wave']) {
        const s = setup();
        const canvas = s.canvas();
        // The renderer calls start after each successfully loaded song.
        for (let song = 0; song < 30; song++) s.visualizer.start(canvas, style);
        assert.equal(s.frames.size, 1, style + ' must not add rendering work with each song');
        assert.equal(s.resizeListeners.size, 1);
        assert.equal(s.frame(), 1, 'Only one draw runs per display frame');
        assert.equal(s.frames.size, 1);
        s.visualizer.stop();
        assert.equal(s.frames.size, 0);
        assert.equal(s.resizeListeners.size, 0);
        assert.equal(s.frame(), 0);
    }
});

test('restarting or changing reactive backgrounds before the next frame cannot revive old loops', () => {
    const s = setup();
    const first = s.canvas();
    const second = s.canvas();
    s.visualizer.start(first, 'bars');
    s.visualizer.start(first, 'bars');
    s.visualizer.stop();
    s.visualizer.start(second, 'wave');
    assert.equal(s.frame(), 1);
    assert.equal(s.frames.size, 1);
    assert.equal(s.resizeListeners.size, 1);
    s.window.innerWidth = 900;
    for (const resize of s.resizeListeners) resize();
    assert.equal(second.width, 900);
    assert.equal(first.width, 540);
    s.visualizer.stop();
    assert.equal(s.resizeListeners.size, 0);
    assert.equal(s.frames.size, 0);
});
