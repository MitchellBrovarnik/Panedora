const ACTIONS = ['toggle', 'next', 'prev', 'thumbUp', 'thumbDown'];
const MODIFIERS = { control: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Super' };
const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/;
const KEY_NAMES = new Map([
    [' ', 'Space'], ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right']
]);
const SYMBOL_KEYS = new Map([
    ['Backquote', '`'], ['Minus', '-'], ['Equal', '='], ['BracketLeft', '['], ['BracketRight', ']'],
    ['Backslash', '\\'], ['Semicolon', ';'], ['Quote', "'"], ['Comma', ','], ['Period', '.'], ['Slash', '/']
]);
const KEYPAD_KEYS = new Map([
    ['NumpadDecimal', 'numdec'], ['NumpadAdd', 'numadd'], ['NumpadSubtract', 'numsub'],
    ['NumpadMultiply', 'nummult'], ['NumpadDivide', 'numdiv']
]);
const NAMED_KEYS = new Set([
    'Space', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
    'Backspace', 'Delete', 'Insert', 'Enter', 'Tab', ...SYMBOL_KEYS.values(), ...KEYPAD_KEYS.values()
]);
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph']);

function supportsKey(key) {
    return /^(?:[A-Z0-9]|num[0-9])$/.test(key) || FUNCTION_KEY.test(key) || NAMED_KEYS.has(key);
}

function acceleratorFor(key, modifiers) {
    if (!supportsKey(key)) return null;
    if (!FUNCTION_KEY.test(key) && !modifiers.some(modifier => modifier !== 'Shift')) return null;
    return [...modifiers, key].join('+');
}

function fromInput(input) {
    if (input.isComposing) return null;
    let key = KEY_NAMES.get(input.key) || input.key;
    if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
    if (/^Numpad[0-9]$/.test(input.code) && /^[0-9]$/.test(key)) {
        key = 'num' + key;
    } else if (KEYPAD_KEYS.has(input.code)) {
        key = KEYPAD_KEYS.get(input.code);
    } else if (!supportsKey(key)) {
        // Shift and Option can change the character reported for the base key.
        key = SYMBOL_KEYS.get(input.code) || /^(?:Key|Digit)([A-Z0-9])$/.exec(input.code)?.[1];
    }
    const modifiers = Object.entries(MODIFIERS).filter(([name]) => input[name]).map(([, label]) => label);
    return acceleratorFor(key, modifiers);
}

function restorePreferences(saved) {
    const bindings = {};
    const seen = new Set();
    for (const action of ACTIONS) {
        const accelerator = saved?.bindings?.[action];
        if (typeof accelerator !== 'string' || seen.has(accelerator)) continue;
        const parts = accelerator.split('+');
        const key = parts.pop();
        const modifiers = Object.values(MODIFIERS).filter(modifier => parts.includes(modifier));
        if (acceleratorFor(key, modifiers) !== accelerator) continue;
        bindings[action] = accelerator;
        seen.add(accelerator);
    }
    return { background: saved?.background !== false, bindings };
}

class KeyboardShortcuts {
    constructor({ globalShortcut, saved, save, execute, update }) {
        this.globalShortcut = globalShortcut;
        this.preferences = restorePreferences(saved);
        this.save = save;
        this.execute = execute;
        this.update = update;
        this.registered = new Map();
        this.recording = null;
        this.pendingKey = null;
        this.message = '';
        this.syncBackground();
    }

    status() {
        const { background, bindings } = this.preferences;
        const unavailable = background && !this.recording
            ? Object.keys(bindings).filter(action => !this.registered.has(action))
            : [];
        return { background, bindings: { ...bindings }, unavailable, recording: this.recording, message: this.message };
    }

    syncBackground() {
        const { background, bindings } = this.preferences;
        const wanted = background && !this.recording ? bindings : {};
        for (const [action, accelerator] of this.registered) {
            if (wanted[action] === accelerator) continue;
            this.globalShortcut.unregister(accelerator);
            this.registered.delete(action);
        }
        for (const [action, accelerator] of Object.entries(wanted)) {
            if (this.registered.has(action)) continue;
            try {
                if (this.globalShortcut.register(accelerator, () => {
                    if (this.registered.get(action) === accelerator) this.execute(action);
                })) {
                    this.registered.set(action, accelerator);
                }
            } catch {
                // An unsupported or reserved combination stays available in the app.
                // The settings show when it couldn't be registered in the background.
            }
        }
    }

    record(action) {
        if (action !== null && !ACTIONS.includes(action)) return false;
        if (action === this.recording) return true;
        this.recording = action;
        this.pendingKey = null;
        this.message = '';
        // Release only Panedora's shortcuts so their keys reach the recorder.
        this.syncBackground();
        this.update(this.status());
        return true;
    }

    setBackground(enabled) {
        if (typeof enabled !== 'boolean') return false;
        return this.applyPreferences({ ...this.preferences, background: enabled });
    }

    clear(action) {
        if (!ACTIONS.includes(action)) return false;
        const bindings = { ...this.preferences.bindings };
        delete bindings[action];
        return this.applyPreferences({ ...this.preferences, bindings });
    }

    applyPreferences(preferences, recordedAction = null) {
        const previous = this.preferences;
        this.preferences = preferences;
        this.recording = null;
        this.pendingKey = null;
        this.message = '';
        this.syncBackground();
        if (recordedAction && preferences.background && !this.registered.has(recordedAction)) {
            this.message = 'That shortcut is unavailable in the background. Try another combination or turn Work in background off.';
        } else if (!this.save(preferences)) {
            this.message = 'Could not save keyboard shortcuts. Please try again.';
        }

        if (this.message) {
            this.preferences = previous;
            this.syncBackground();
        } else if (recordedAction) {
            this.message = 'Shortcut saved.';
        }
        this.update(this.status());
        return true;
    }

    handleInput(event, input) {
        if (this.recording) {
            // Tab leaves the recorder and retains its normal focus navigation.
            if (input.type === 'keyDown' && input.key === 'Tab' && !input.control && !input.alt && !input.meta) {
                this.record(null);
                return;
            }
            event.preventDefault();
            if (input.type === 'keyDown' && !input.isAutoRepeat) {
                if (input.key === 'Escape') {
                    this.record(null);
                    return;
                }
                if (MODIFIER_KEYS.has(input.key) || input.isComposing) return;
                this.pendingKey = null;
                const accelerator = fromInput(input);
                if (!accelerator) {
                    this.message = 'Use a function key or a key combination with Ctrl, Alt, or Command.';
                } else if (Object.entries(this.preferences.bindings).some(([action, binding]) =>
                    action !== this.recording && binding === accelerator)) {
                    this.message = 'That shortcut is already assigned to another action.';
                } else {
                    // Wait for release so the recorded key doesn't trigger its new action.
                    this.pendingKey = { code: input.code || input.key, accelerator };
                    return;
                }
                this.update(this.status());
            } else if (input.type === 'keyUp' && this.pendingKey?.code === (input.code || input.key)) {
                const action = this.recording;
                const bindings = { ...this.preferences.bindings, [action]: this.pendingKey.accelerator };
                this.applyPreferences({ ...this.preferences, bindings }, action);
            }
            return;
        }

        if (input.type !== 'keyDown') return;
        const accelerator = fromInput(input);
        const action = ACTIONS.find(name => this.preferences.bindings[name] === accelerator);
        if (!action) return;
        event.preventDefault();
        // A registered global shortcut already receives the same key press.
        if (!input.isAutoRepeat && !this.registered.has(action)) this.execute(action);
    }

    dispose() {
        for (const accelerator of this.registered.values()) this.globalShortcut.unregister(accelerator);
        this.registered.clear();
        this.recording = null;
        this.pendingKey = null;
    }
}

module.exports = { KeyboardShortcuts };
