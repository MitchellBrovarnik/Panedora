const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(classes = ['mini-mode']) {
    const frames = new Map();
    const resizeListeners = new Set();
    let nextFrame = 0;
    let clears = 0;
    const points = [];
    const context = new Proxy({
        clearRect() { clears++; },
        moveTo(x, y) { points.push({ x, y }); },
        lineTo(x, y) { points.push({ x, y }); }
    }, {
        get: (object, key) => object[key] || (() => ({ addColorStop() {} }))
    });
    const window = {
        innerWidth: 540, innerHeight: 80,
        addEventListener(name, listener) { if (name === 'resize') resizeListeners.add(listener); },
        removeEventListener(name, listener) { if (name === 'resize') resizeListeners.delete(listener); }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'visualizer.js'), 'utf8'), {
        window, document: { body: { classList: { contains: name => classes.includes(name) } }, documentElement: {} },
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
        visualizer, frames, resizeListeners, window, context, points,
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

test('reactive circles keep loud peaks inside both mini-player layouts', () => {
    for (const [width, height, classes] of [
        [540, 72, ['mini-mode']], [900, 72, ['mini-mode']],
        [280, 500, ['mini-mode', 'classic-mini']], [1200, 800, []]
    ]) {
        const s = setup(classes);
        s.visualizer.ctx = s.context;
        for (const level of [0, 128, 255]) {
            s.points.length = 0;
            s.visualizer.dataArray = Uint8Array.from({ length: 128 }, (_, i) => i % 3 === 0 ? level : level / 2);
            s.visualizer.drawCircle(128, width, height, '#789abc', 'rgba(120,154,188,0.3)');
            const padding = s.context.lineWidth / 2 + (classes.length ? 10 : 20);
            assert.ok(s.points.length > 100, 'The circle still draws both halves');
            for (const { x, y } of s.points) {
                assert.ok(x >= padding - 0.01 && x <= width - padding + 0.01, `${width}x${height}: x=${x}`);
                assert.ok(y >= padding - 0.01 && y <= height - padding + 0.01, `${width}x${height}: y=${y}`);
            }
        }
    }
});

test('reactive waves stay proportionate in the tall mini-player and recenter after resizing', () => {
    for (const [width, height, classes, swing] of [
        [540, 72, ['mini-mode'], 10.8], [900, 72, ['mini-mode'], 10.8],
        [280, 500, ['mini-mode', 'classic-mini'], 42], [1200, 800, [], 64]
    ]) {
        const s = setup(classes);
        s.visualizer.ctx = s.context;
        s.visualizer.dataArray = new Uint8Array(512);
        for (let frame = 0; frame < 120; frame++) {
            s.points.length = 0;
            s.visualizer.drawWave(512, width, height, '#789abc', '#789abc');
        }
        assert.ok(Math.abs(s.points[0].y - (height / 2 - swing)) < 0.01, `${width}x${height}: full wave swing`);
        s.visualizer.canvas = s.canvas();
        s.window.innerWidth = width;
        s.window.innerHeight = height / 2;
        s.visualizer.resize();
        s.visualizer.dataArray.fill(128);
        s.points.length = 0;
        s.visualizer.drawWave(512, width, height / 2, '#789abc', '#789abc');
        assert.equal(s.points[0].y, height / 4, 'A silent wave starts at the new center immediately');
        assert.ok(Math.abs(s.points.at(-1).x - width) < 0.01, 'The wave still spans the full window width');
    }
});
