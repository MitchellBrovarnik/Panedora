const test = require('node:test');
const assert = require('node:assert/strict');
const { KeyboardShortcuts } = require('../keyboard-shortcuts');

function setup(saved) {
    const registrations = new Map();
    const blocked = new Set();
    const actions = [];
    const writes = [];
    let diskWritable = true;
    let latest;
    const shortcuts = new KeyboardShortcuts({
        saved,
        save: settings => {
            if (!diskWritable) return false;
            writes.push(settings);
            return true;
        },
        execute: action => actions.push(action),
        update: settings => { latest = settings; },
        globalShortcut: {
            register: (accelerator, handler) => {
                if (blocked.has(accelerator)) return false;
                assert.equal(registrations.has(accelerator), false, 'Do not register a shortcut twice');
                registrations.set(accelerator, handler);
                return true;
            },
            unregister: accelerator => registrations.delete(accelerator)
        }
    });
    const input = (key, options = {}) => {
        let swallowed = false;
        shortcuts.handleInput({ preventDefault: () => { swallowed = true; } },
            { type: 'keyDown', key, code: key, ...options });
        return swallowed;
    };
    const chord = (key, modifiers = { control: true, shift: true }) => {
        input(key, modifiers);
        input(key, { type: 'keyUp' });
    };
    return { shortcuts, input, chord, registrations, blocked, actions, writes,
        failWrites: () => { diskWritable = false; }, get latest() { return latest; } };
}

test('shortcuts start blank with background scope on and record without changing playback', () => {
    const s = setup();
    assert.deepEqual(s.shortcuts.status().bindings, {});
    assert.equal(s.shortcuts.status().background, true);
    assert.equal(s.registrations.size, 0);
    assert.equal(s.input('k'), false, 'Typing is unaffected by default');

    s.shortcuts.record('thumbUp');
    assert.equal(s.input('k', { control: true, shift: true }), false, 'Chromium must receive keydown to emit keyup');
    assert.equal(s.input('k', { control: true, shift: true, isAutoRepeat: true }), false,
        'Holding the key must not prevent the recorder from receiving its release');
    assert.equal(s.registrations.size, 0, 'Wait for key release before registering');
    s.input('k', { type: 'keyUp' });
    assert.deepEqual(s.latest.bindings, { thumbUp: 'Ctrl+Shift+K' });
    assert.deepEqual(s.writes.at(-1), { background: true, bindings: { thumbUp: 'Ctrl+Shift+K' } });
    assert.deepEqual(s.actions, []);

    s.input('k', { control: true, shift: true });
    s.registrations.get('Ctrl+Shift+K')();
    assert.deepEqual(s.actions, ['thumbUp'], 'The native callback owns a registered shortcut, even when focused');
    s.shortcuts.dispose();
    assert.equal(s.registrations.size, 0);
});

test('switching scope and cancelling capture release or restore only configured shortcuts', () => {
    const s = setup({ bindings: { toggle: 'Ctrl+Shift+K' } });
    s.shortcuts.record('next');
    assert.equal(s.registrations.size, 0, 'The same chord must reach the recorder');
    s.chord('k');
    assert.match(s.latest.message, /already assigned/);
    assert.equal(s.latest.recording, 'next');
    s.input('Escape');
    assert.equal(s.latest.recording, null);
    assert.equal(s.registrations.has('Ctrl+Shift+K'), true);

    s.shortcuts.setBackground(false);
    assert.equal(s.registrations.size, 0);
    assert.equal(s.input('k', { control: true, shift: true }), true);
    s.input('k', { control: true, shift: true, isAutoRepeat: true });
    assert.deepEqual(s.actions, ['toggle'], 'Held focused keys do not repeat playback');
    s.shortcuts.record('next');
    assert.equal(s.input('Tab'), false, 'Tab retains ordinary focus navigation');
    assert.equal(s.latest.recording, null);
    s.shortcuts.clear('toggle');
    assert.equal(s.input('k', { control: true, shift: true }), false);
    assert.deepEqual(s.writes.at(-1), { background: false, bindings: {} });
});

test('a system conflict or save failure keeps the previous shortcut usable', () => {
    const s = setup({ bindings: { thumbDown: 'Ctrl+Shift+D' } });
    s.blocked.add('Ctrl+Shift+K');
    s.shortcuts.record('thumbDown');
    s.chord('k');
    assert.match(s.latest.message, /unavailable in the background/);
    assert.deepEqual(s.latest.bindings, { thumbDown: 'Ctrl+Shift+D' });
    assert.equal(s.registrations.has('Ctrl+Shift+D'), true);
    assert.equal(s.writes.length, 0);

    s.failWrites();
    s.shortcuts.clear('thumbDown');
    assert.match(s.latest.message, /Could not save/);
    s.registrations.get('Ctrl+Shift+D')();
    assert.deepEqual(s.actions, ['thumbDown']);
});

test('background registration problems remain visible and allow focused use of existing bindings', () => {
    const s = setup({ background: false, bindings: { prev: 'Alt+Left', next: 'F8', thumbUp: 'F8', toggle: 'bogus' } });
    assert.deepEqual(s.shortcuts.status().bindings, { next: 'F8', prev: 'Alt+Left' });
    s.blocked.add('Alt+Left');
    s.shortcuts.setBackground(true);
    assert.deepEqual(s.latest.unavailable, ['prev']);
    assert.equal(s.registrations.has('F8'), true);
    assert.equal(s.input('ArrowLeft', { alt: true }), true);
    assert.deepEqual(s.actions, ['prev']);

    s.shortcuts.record('thumbUp');
    s.chord('j', {});
    assert.match(s.latest.message, /function key/);
    s.chord('F9', {});
    assert.equal(s.latest.bindings.thumbUp, 'F9');
    assert.equal(s.registrations.has('F9'), true);
});
