/**
 * Panedora - Configuration Storage
 * Simple file-based storage (no external dependencies)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { app, safeStorage } = require('electron');

// Storage file path
const getConfigPath = () => {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'panedora-config.json');
};

// Default config
const defaultConfig = {
    credentials: null,
    authToken: null,
    csrfToken: null,
    listenerId: null
};

// Read config from file
function readConfig() {
    try {
        const configPath = getConfigPath();
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            return { ...defaultConfig, ...JSON.parse(data) };
        }
    } catch (e) {
        console.error('[Config] Error reading config:', e);
    }
    return { ...defaultConfig };
}

// Write config to file
function writeConfig(config) {
    try {
        const configPath = getConfigPath();
        // Ensure the userData directory exists (may not on first launch on macOS/Linux)
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
        console.error('[Config] Error writing config:', e);
    }
}

// In-memory cache
let configCache = null;

function getConfig() {
    if (!configCache) {
        configCache = readConfig();
    }
    return configCache;
}

function setConfig(key, value) {
    const config = getConfig();
    config[key] = value;
    configCache = config;
    writeConfig(config);
}

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------
// Primary: Electron safeStorage (uses OS keychain — Keychain on macOS,
//          DPAPI on Windows, libsecret on Linux).
// Fallback: AES-256-GCM with a key derived from machine-specific values.
//           Not as strong as an OS keychain, but the password is never stored
//           in plain text — opening the config file only shows an encrypted blob.
// ---------------------------------------------------------------------------

// Derive a deterministic 256-bit key from machine-specific values.
// The same machine + OS user will always produce the same key, but copying
// the config file to another machine (or user) makes it useless.
let _appKey = null;
function getAppKey() {
    if (_appKey) return _appKey;
    const material = [
        os.hostname(),
        os.userInfo().username,
        os.homedir(),
        app.getPath('userData')
    ].join('|');
    _appKey = crypto.createHash('sha256').update(material).digest();
    return _appKey;
}

// AES-256-GCM encrypt → returns "iv:authTag:ciphertext" (all hex)
function appEncrypt(str) {
    const key = getAppKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(str, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return iv.toString('hex') + ':' + tag + ':' + encrypted;
}

// AES-256-GCM decrypt ← expects "iv:authTag:ciphertext" (all hex)
function appDecrypt(str) {
    const parts = str.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted format');
    const key = getAppKey();
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(parts[2], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// Encrypt a string — prefer OS safeStorage, fall back to app-level AES
function encryptString(str) {
    // Try Electron safeStorage first (OS keychain)
    if (safeStorage.isEncryptionAvailable()) {
        try {
            const encrypted = safeStorage.encryptString(str).toString('base64');
            return 'safe:' + encrypted;
        } catch (e) {
            console.warn('[Config] safeStorage.encryptString failed, using app encryption:', e.message);
        }
    }
    // Fallback: AES-256-GCM with machine-derived key
    return 'aes:' + appEncrypt(str);
}

// Decrypt a string — detects which method was used via prefix
function decryptString(str) {
    if (str.startsWith('safe:')) {
        // Encrypted with safeStorage
        const payload = str.slice(5);
        if (safeStorage.isEncryptionAvailable()) {
            try {
                return safeStorage.decryptString(Buffer.from(payload, 'base64'));
            } catch (e) {
                // safeStorage key changed (e.g. unsigned app rebuild) —
                // can't recover this password, user will need to re-login
                console.warn('[Config] safeStorage.decryptString failed:', e.message);
                return null;
            }
        }
        // safeStorage not available now but was before — can't decrypt
        return null;
    }

    if (str.startsWith('aes:')) {
        // Encrypted with app-level AES
        try {
            return appDecrypt(str.slice(4));
        } catch (e) {
            console.warn('[Config] App decryption failed:', e.message);
            return null;
        }
    }

    // Legacy: no prefix means plain text from an older version — migrate on read
    return str;
}

module.exports = {
    // Credentials (encrypted at rest)
    getCredentials: () => {
        const creds = getConfig().credentials;
        if (!creds) return null;

        if (creds.passwordEncrypted) {
            const password = decryptString(creds.passwordEncrypted);
            if (!password) return null; // Decryption failed — credentials are stale
            return { email: creds.email, password };
        }

        // Migrate old plain-text "password" field to encrypted format
        if (creds.password) {
            const plainPassword = creds.password;
            setConfig('credentials', {
                email: creds.email,
                passwordEncrypted: encryptString(plainPassword)
            });
            return { email: creds.email, password: plainPassword };
        }

        return { email: creds.email, password: '' };
    },
    setCredentials: (email, password) => {
        setConfig('credentials', {
            email,
            passwordEncrypted: encryptString(password)
        });
    },
    clearCredentials: () => setConfig('credentials', null),

    // Auth Token (from login response)
    getAuthToken: () => getConfig().authToken,
    setAuthToken: (token) => setConfig('authToken', token),
    clearAuthToken: () => setConfig('authToken', null),

    // CSRF Token (from cookies)
    getCsrfToken: () => getConfig().csrfToken,
    setCsrfToken: (token) => setConfig('csrfToken', token),

    // Listener ID (user ID)
    getListenerId: () => getConfig().listenerId,
    setListenerId: (id) => setConfig('listenerId', id),

    // Check if logged in
    isLoggedIn: () => {
        const token = getConfig().authToken;
        return token !== null && token !== undefined;
    },

    // Clear only session tokens (keep credentials for auto-relogin on next launch)
    clearTokens: () => {
        setConfig('authToken', null);
        setConfig('csrfToken', null);
    },

    // Clear all data (logout) — full wipe
    clearAll: () => {
        setConfig('credentials', null);
        setConfig('authToken', null);
        setConfig('csrfToken', null);
        setConfig('listenerId', null);
    }
};
